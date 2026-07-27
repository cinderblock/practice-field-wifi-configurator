/**
 * Read-only environment probe for the setup wizard.
 *
 * Answers "what's wrong with this host right now" as structured data, in the
 * order a new deployer has to fix things: can we run at all → is there a NIC
 * we can trunk → is field control reachable → is the radio there → are the
 * team VLANs up. The wizard renders this directly, and it re-runs on an
 * interval so a step lights up the moment the operator fixes it.
 *
 * This module NEVER changes the host. Every failing check carries the exact
 * command that would fix it, for the UI to show (and, later, to offer to run
 * on an explicit click). Keeping observation and mutation separate is what
 * makes it safe to run this continuously.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SOUND_NAMES } from './matchAudio.js';
import { isValidRawRadioUpdate, translateRadioUpdate } from './types.js';
import { detectFirmwareMode } from './startupChecks.js';
import { createBackend, createDryRunBackend, type NetworkBackend } from './node-ip/index.js';
import type { SetupCheck, SetupProbeState, SetupStepId, SetupStep } from './types.js';

const execFileAsync = promisify(execFile);

const SOUNDS_DIR = resolve(__dirname, '..', 'sounds');
const AUDIO_CONFIG_FILE = 'audio-config.json';

/** Tools the backend hard-exits without (see checkRequiredTools in index.ts). */
const REQUIRED_TOOLS = ['iptables', 'arping', 'fping', 'dnsmasq', 'conntrack', 'tcpdump'];
/** Tools that only degrade a feature, so they're warnings rather than failures. */
const OPTIONAL_TOOLS: [tool: string, why: string][] = [
  ['aplay', 'field match audio'],
  ['dhcpcd', 'the robot tester'],
];

/** apt package names differ from binary names for a couple of these. */
const APT_PACKAGES: Record<string, string> = {
  arping: 'iputils-arping',
  dnsmasq: 'dnsmasq-base',
  dhcpcd: 'dhcpcd5',
  aplay: 'alsa-utils',
};

async function hasTool(tool: string): Promise<boolean> {
  try {
    await execFileAsync('which', [tool]);
    return true;
  } catch {
    return false;
  }
}

function pass(id: string, label: string, detail: string): SetupCheck {
  return { id, label, status: 'pass', detail };
}
function fail(id: string, label: string, detail: string, fix?: string): SetupCheck {
  return { id, label, status: 'fail', detail, fix };
}
function warn(id: string, label: string, detail: string, fix?: string): SetupCheck {
  return { id, label, status: 'warn', detail, fix };
}

// ── Step probes ─────────────────────────────────────────────────────

async function probeHost(): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  const os = platform();
  checks.push(
    os === 'linux'
      ? pass('platform', 'Operating system', 'Linux — VLAN and routing management supported')
      : fail(
          'platform',
          'Operating system',
          `${os} has no supported networking layer. pFMS can run here for development only.`,
          'Set DRY_RUN=1 to explore the UI without touching the network, or deploy on Linux.',
        ),
  );

  // getuid is undefined on Windows, hence the optional call.
  const uid = process.getuid?.();
  if (uid === undefined) {
    checks.push(warn('root', 'Privileges', 'Cannot determine user on this platform'));
  } else if (uid === 0) {
    checks.push(pass('root', 'Privileges', 'Running as root — can manage VLANs, addresses, and iptables'));
  } else {
    checks.push(
      fail(
        'root',
        'Privileges',
        `Running as uid ${uid}. Creating VLANs and iptables rules needs root.`,
        'Run the service as root (the systemd unit has no User=, so it already is).',
      ),
    );
  }

  const missingRequired: string[] = [];
  for (const tool of REQUIRED_TOOLS) {
    if (!(await hasTool(tool))) missingRequired.push(tool);
  }
  checks.push(
    missingRequired.length === 0
      ? pass('tools', 'Required tools', `All present: ${REQUIRED_TOOLS.join(', ')}`)
      : fail(
          'tools',
          'Required tools',
          `Missing: ${missingRequired.join(', ')}. The backend exits with code 78 on startup without these.`,
          `sudo apt install ${missingRequired.map(t => APT_PACKAGES[t] ?? t).join(' ')}`,
        ),
  );

  const missingOptional: [string, string][] = [];
  for (const [tool, why] of OPTIONAL_TOOLS) {
    if (!(await hasTool(tool))) missingOptional.push([tool, why]);
  }
  if (missingOptional.length > 0) {
    checks.push(
      warn(
        'optional-tools',
        'Optional tools',
        missingOptional.map(([t, why]) => `${t} missing — ${why} won't work`).join('; '),
        `sudo apt install ${missingOptional.map(([t]) => APT_PACKAGES[t] ?? t).join(' ')}`,
      ),
    );
  } else {
    checks.push(pass('optional-tools', 'Optional tools', 'Audio and robot-tester tooling present'));
  }

  return checks;
}

/** Interfaces that could plausibly carry the VLAN trunk. */
function trunkCandidates(interfaces: InterfaceLike[]): InterfaceLike[] {
  return interfaces.filter(
    i =>
      i.name !== 'lo' &&
      // Sub-interfaces and bridges are things we create, not things to trunk on
      i.link?.vlanId === undefined &&
      i.link?.kind !== 'bridge' &&
      !i.name.startsWith('br-') &&
      !i.name.includes('.'),
  );
}

type InterfaceLike = Awaited<ReturnType<NetworkBackend['listInterfaces']>>[number];

async function probeInterfaces(net: NetworkBackend, vlanInterface: string | undefined): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  let interfaces: InterfaceLike[];
  try {
    interfaces = await net.listInterfaces();
  } catch (err) {
    return [
      fail('list', 'Network interfaces', `Could not list interfaces: ${err instanceof Error ? err.message : err}`),
    ];
  }

  const candidates = trunkCandidates(interfaces);
  checks.push(
    candidates.length > 0
      ? pass('candidates', 'Available interfaces', candidates.map(i => `${i.name} (${i.state})`).join(', '))
      : fail('candidates', 'Available interfaces', 'No physical interface found to carry the VLAN trunk'),
  );

  if (!vlanInterface) {
    checks.push(
      fail(
        'selected',
        'Trunk interface',
        'VLAN_INTERFACE is not set, so no VLAN or routing management happens at all.',
        candidates.length > 0
          ? `Add VLAN_INTERFACE=${candidates[0].name} to /etc/pfms/environment`
          : 'Add VLAN_INTERFACE=<nic> to /etc/pfms/environment',
      ),
    );
    return checks;
  }

  const selected = interfaces.find(i => i.name === vlanInterface);
  if (!selected) {
    checks.push(
      fail(
        'selected',
        'Trunk interface',
        `VLAN_INTERFACE is "${vlanInterface}" but no such interface exists.`,
        `Set VLAN_INTERFACE to one of: ${candidates.map(i => i.name).join(', ')}`,
      ),
    );
    return checks;
  }

  checks.push(
    selected.state === 'UP'
      ? pass('selected', 'Trunk interface', `${selected.name} is up`)
      : warn(
          'selected',
          'Trunk interface',
          `${selected.name} is ${selected.state} — nothing will reach the radio while it's down`,
          `ip link set ${selected.name} up`,
        ),
  );

  return checks;
}

async function probeFieldControl(
  net: NetworkBackend,
  vlanInterface: string | undefined,
  fmsAddress: string,
): Promise<SetupCheck[]> {
  if (!vlanInterface) {
    return [warn('address', 'Field control address', 'Waiting on a trunk interface selection')];
  }

  let interfaces: InterfaceLike[];
  try {
    interfaces = await net.listInterfaces();
  } catch (err) {
    return [
      fail('address', 'Field control address', `Could not read addresses: ${err instanceof Error ? err.message : err}`),
    ];
  }

  const bare = interfaces.find(i => i.name === vlanInterface);
  const onBare = bare?.addresses.some(a => a.address === fmsAddress) ?? false;
  if (onBare) {
    return [pass('address', 'Field control address', `${fmsAddress} is on ${vlanInterface}`)];
  }

  // The address landing on a tagged sub-interface is the classic misconfig:
  // startup adds it to the bare NIC, so field control has to be the native VLAN.
  const elsewhere = interfaces.find(i => i.name !== vlanInterface && i.addresses.some(a => a.address === fmsAddress));
  if (elsewhere) {
    return [
      fail(
        'address',
        'Field control address',
        `${fmsAddress} is on ${elsewhere.name}, not on ${vlanInterface}. pFMS puts it on the bare trunk interface, so field control must be the native (untagged) VLAN on that switch port.`,
        `Make field control the native VLAN on the ${vlanInterface} switch port`,
      ),
    ];
  }

  return [
    fail(
      'address',
      'Field control address',
      `${fmsAddress} is not configured on ${vlanInterface}. The backend adds it at startup; if it's still missing, startup hasn't got that far or the interface is wrong.`,
      `ip addr add ${fmsAddress}/24 dev ${vlanInterface}`,
    ),
  ];
}

async function probeRadio(radioUrl: string): Promise<SetupCheck[]> {
  try {
    const response = await fetch(`${radioUrl}/status`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const raw: unknown = await response.json();
    if (!isValidRawRadioUpdate(raw)) {
      return [warn('reachable', 'Radio', `${radioUrl} answered, but not with a radio status payload`)];
    }
    const data = translateRadioUpdate(raw);

    const mode = detectFirmwareMode(data.version);
    const checks: SetupCheck[] = [pass('reachable', 'Radio', `Reachable at ${radioUrl} — ${data.version}`)];

    checks.push(
      mode === 'PRACTICE' || mode === 'OFFSEASON'
        ? pass('firmware', 'Firmware mode', `${mode}${mode === 'OFFSEASON' ? ' — pFMS serves DHCP per VLAN' : ''}`)
        : warn(
            'firmware',
            'Firmware mode',
            `${mode} firmware. pFMS supports PRACTICE (recommended) and OFFSEASON.`,
            'Flash PRACTICE or OFFSEASON firmware from frc-radio.vivid-hosting.net',
          ),
    );

    const configured = Object.entries(data.stationStatuses ?? {})
      .filter(([, s]) => s && typeof s === 'object' && 'ssid' in s && s.ssid)
      .map(([station]) => station);
    checks.push(
      pass(
        'existing-config',
        'Existing configuration',
        configured.length > 0 ? `Stations already configured: ${configured.join(', ')}` : 'No stations configured yet',
      ),
    );

    return checks;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      fail(
        'reachable',
        'Radio',
        `No answer from ${radioUrl} (${msg}). Field control has to be reachable before the radio can be configured.`,
        `curl -v ${radioUrl}/status`,
      ),
    ];
  }
}

async function probeTeamVlans(net: NetworkBackend, vlanInterface: string | undefined): Promise<SetupCheck[]> {
  if (!vlanInterface) {
    return [warn('vlans', 'Team VLANs', 'Waiting on a trunk interface selection')];
  }

  try {
    const interfaces = await net.listInterfaces();
    const subs = interfaces.filter(i => i.link?.parent === vlanInterface && i.link?.vlanId !== undefined);
    const bridges = interfaces.filter(i => i.name.startsWith('br-slot'));

    if (subs.length === 0 && bridges.length === 0) {
      return [
        warn(
          'vlans',
          'Team VLANs',
          'No team VLAN interfaces yet — these are created automatically when a team is assigned to a station.',
        ),
      ];
    }

    return [
      pass(
        'vlans',
        'Team VLANs',
        `${subs.length} VLAN sub-interface(s), ${bridges.length} bridge(s): ${[...subs, ...bridges].map(i => i.name).join(', ')}`,
      ),
    ];
  } catch (err) {
    return [fail('vlans', 'Team VLANs', `Could not inspect: ${err instanceof Error ? err.message : err}`)];
  }
}

/** Audio readiness. The wizard pairs this with a "play a test sound" button —
 *  a check can prove a player exists, but only a human can confirm the field
 *  speaker actually made a noise. */
async function probeAudio(audioVerified: boolean): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  const players = ['aplay', 'paplay', 'ffplay', 'mpv', 'play'];
  const found: string[] = [];
  for (const player of players) {
    if (await hasTool(player)) found.push(player);
  }
  checks.push(
    found.length > 0
      ? pass('player', 'Audio player', `Available: ${found.join(', ')}`)
      : fail(
          'player',
          'Audio player',
          'No audio player found, so the field speaker will stay silent for every match cue.',
          'sudo apt install alsa-utils',
        ),
  );

  const missingSounds = SOUND_NAMES.filter(name => !existsSync(resolve(SOUNDS_DIR, `${name}.wav`)));
  checks.push(
    missingSounds.length === 0
      ? pass('files', 'Sound files', `All ${SOUND_NAMES.length} clips present`)
      : warn(
          'files',
          'Sound files',
          `Missing: ${missingSounds.join(', ')}. Those transitions are silent (everything else still plays).`,
          'bun scripts/generate-sounds.ts',
        ),
  );

  // The device picker writes this; without a selection the server plays nothing.
  const deviceConfigured = existsSync(AUDIO_CONFIG_FILE);
  checks.push(
    deviceConfigured
      ? pass('device', 'Output device', 'An output device has been selected')
      : warn(
          'device',
          'Output device',
          'No output device selected yet — sounds stay off until one is chosen.',
          'Pick a device in this step, then play a test sound',
        ),
  );

  checks.push(
    audioVerified
      ? pass('verified', 'Speaker check', 'Someone confirmed the test sound was audible at the field')
      : warn(
          'verified',
          'Speaker check',
          'Nobody has confirmed a test sound was actually heard. Volume, amp power, and wiring can all fail silently.',
          'Play a test sound and confirm you heard it',
        ),
  );

  return checks;
}

/** Scoreboard and casting. The secure-origin half can only be checked in the
 *  browser (`window.isSecureContext`), so the wizard does that client-side and
 *  this covers the server-side half. */
async function probeScoreboard(videoProxyTarget: string | undefined, castVerified: boolean): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];

  checks.push(
    castVerified
      ? pass('cast', 'Cast to a TV', 'Casting confirmed working on a real display')
      : warn(
          'cast',
          'Cast to a TV',
          'Google Cast needs the scoreboard served over HTTPS from a real hostname — casting silently will not offer the receiver otherwise.',
          'Open /scores on the field network and cast it to your TV',
        ),
  );

  if (!videoProxyTarget) {
    checks.push(
      warn(
        'video',
        'Video stream (optional)',
        'No stream server configured. The scoreboard works fine without it; set one to overlay a live camera feed.',
        'Set a WHEP server URL (e.g. MediaMTX at http://10.0.0.5:8889)',
      ),
    );
    return checks;
  }

  try {
    const response = await fetch(videoProxyTarget, { signal: AbortSignal.timeout(2500) });
    checks.push(pass('video', 'Video stream (optional)', `${videoProxyTarget} answered (HTTP ${response.status})`));
  } catch (err) {
    checks.push(
      fail(
        'video',
        'Video stream (optional)',
        `${videoProxyTarget} did not answer (${err instanceof Error ? err.message : err}).`,
        `curl -v ${videoProxyTarget}`,
      ),
    );
  }

  return checks;
}

// ── Assembly ────────────────────────────────────────────────────────

const STEP_LABELS: Record<SetupStepId, { label: string; blurb: string }> = {
  host: { label: 'Host', blurb: 'Can this machine run a field at all?' },
  interfaces: { label: 'Interfaces', blurb: 'Which NIC carries the VLAN trunk?' },
  fieldControl: { label: 'Field control', blurb: 'Can we talk to the field-control network?' },
  radio: { label: 'Radio', blurb: 'Is the access point reachable and running supported firmware?' },
  teamVlans: { label: 'Team VLANs', blurb: 'Are the per-station networks in place?' },
  audio: { label: 'Match audio', blurb: 'Will the field speaker actually make noise?' },
  scoreboard: { label: 'Scoreboard', blurb: 'Casting scores to a TV, and an optional video feed.' },
};

/** Worst status wins, so a step reads as failed if anything in it failed. */
function rollUp(checks: SetupCheck[]): SetupStep['status'] {
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'warn')) return 'warn';
  return 'pass';
}

export interface SetupProbeOptions {
  vlanInterface?: string;
  radioUrl: string;
  fmsAddress: string;
  dryRun?: boolean;
  videoProxyTarget?: string;
  /** Human confirmations the wizard has recorded — checks can't prove these. */
  audioVerified?: boolean;
  castVerified?: boolean;
}

/** Run every probe once and return a full report. */
export async function runSetupProbe(opts: SetupProbeOptions): Promise<SetupProbeState> {
  // The whole point of the host step is to report an unsupported OS, so the
  // network probes must degrade rather than throw on one. createBackend()
  // throws outside Linux, so only reach for it when we can actually use it.
  const os = platform();
  const net: NetworkBackend | null =
    os === 'linux' && !opts.dryRun ? createBackend() : opts.dryRun ? createDryRunBackend() : null;

  const unavailable = (id: string, label: string): SetupCheck[] => [
    warn(id, label, `Not available on ${os} — pFMS manages networking on Linux only`),
  ];

  const [host, interfaces, fieldControl, radio, teamVlans, audio, scoreboard] = await Promise.all([
    probeHost(),
    net ? probeInterfaces(net, opts.vlanInterface) : unavailable('selected', 'Trunk interface'),
    net ? probeFieldControl(net, opts.vlanInterface, opts.fmsAddress) : unavailable('address', 'Field control address'),
    // Reaching the radio is plain HTTP, so it's worth trying from anywhere.
    probeRadio(opts.radioUrl),
    net ? probeTeamVlans(net, opts.vlanInterface) : unavailable('vlans', 'Team VLANs'),
    probeAudio(opts.audioVerified ?? false),
    probeScoreboard(opts.videoProxyTarget, opts.castVerified ?? false),
  ]);

  const byId: [SetupStepId, SetupCheck[]][] = [
    ['host', host],
    ['interfaces', interfaces],
    ['fieldControl', fieldControl],
    ['radio', radio],
    ['teamVlans', teamVlans],
    ['audio', audio],
    ['scoreboard', scoreboard],
  ];

  const steps: SetupStep[] = byId.map(([id, checks]) => ({
    id,
    label: STEP_LABELS[id].label,
    blurb: STEP_LABELS[id].blurb,
    status: rollUp(checks),
    checks,
  }));

  return {
    type: 'setupProbeState',
    checkedAt: Date.now(),
    vlanInterface: opts.vlanInterface,
    radioUrl: opts.radioUrl,
    dryRun: opts.dryRun ?? false,
    steps,
  };
}
