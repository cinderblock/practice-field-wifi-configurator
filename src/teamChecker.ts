import type { StationName, CheckResult, TeamCheckResults, DiscoveredHost } from './types.js';

const FETCH_TIMEOUT = 3000;

// ── Help URLs ───────────────────────────────────────────────────────

const HELP_URLS = {
  radioSystemCore: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/radio-programming.html',
  radioFirmware: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/radio-programming.html',
  roboRIOHostname: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/roborio2-setup.html',
  roboRIOIP: 'https://docs.wpilib.org/en/stable/docs/networking/networking-introduction/ip-configurations.html',
  roboRIOImage: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/imaging-your-roborio.html',
} as const;

// ── NI SysAPI property tags ─────────────────────────────────────────

// Tags from the system PropertyBag (//localhost/nisyscfg/system)
const TAG_HOSTNAME = '101F000';
const TAG_IMAGE_VERSION = 'D15C000';
// Tags from the eth0 PropertyBag (//localhost/nisyscfg/eth0)
const TAG_IP_ADDRESS = 'D107000';
// Tag that identifies which bag we're looking at
const TAG_ITEM_NAME = '1000000';

// ── Expected values ─────────────────────────────────────────────────

/** Expected radio firmware version prefix. Updated each season. */
const EXPECTED_RADIO_FIRMWARE_PREFIX = '2.0.1';

/** Expected roboRIO image year. Updated each season. */
const EXPECTED_IMAGE_YEAR = '2026';

// ── Helpers ─────────────────────────────────────────────────────────

function teamSubnet(team: number): string {
  const high = Math.floor(team / 100);
  const low = team % 100;
  return `10.${high}.${low}`;
}

function expectedHostname(team: number): string {
  return `roboRIO-${team}-FRC`;
}

function expectedIP(team: number): string {
  return `${teamSubnet(team)}.2`;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── NI SysAPI XML parsing ───────────────────────────────────────────

interface NISysAPIBag {
  itemName: string; // e.g. //localhost/nisyscfg/system
  properties: Map<string, string>; // tag → value
}

function parseNISysAPIResponse(xml: string): NISysAPIBag[] {
  const bags: NISysAPIBag[] = [];
  // Match each <PropertyBag>...</PropertyBag>
  const bagPattern = /<PropertyBag>([\s\S]*?)<\/PropertyBag>/g;
  let bagMatch: RegExpExecArray | null;
  while ((bagMatch = bagPattern.exec(xml)) !== null) {
    const properties = new Map<string, string>();
    const propPattern = /<Property\s+tag='([^']+)'\s+type='[^']*'[^>]*>([^<]*)<\/Property>/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propPattern.exec(bagMatch[1])) !== null) {
      properties.set(propMatch[1], propMatch[2]);
    }
    bags.push({
      itemName: properties.get(TAG_ITEM_NAME) ?? '',
      properties,
    });
  }
  return bags;
}

// ── TeamChecker ─────────────────────────────────────────────────────

type HostLookup = (station: StationName) => DiscoveredHost[];

export class TeamChecker {
  constructor(private readonly getAliveHosts: HostLookup) {}

  async runChecks(station: StationName, team: number): Promise<TeamCheckResults> {
    const hosts = this.getAliveHosts(station);
    const [radioChecks, rioChecks] = await Promise.all([this.checkRadio(team), this.checkRoboRIO(team, hosts)]);
    return {
      type: 'teamCheckResults',
      station,
      team,
      timestamp: Date.now(),
      checks: [...radioChecks, ...rioChecks],
    };
  }

  // ── Radio checks ────────────────────────────────────────────────

  /** Fetch radio /status once and run all radio checks against it. */
  private async checkRadio(team: number): Promise<CheckResult[]> {
    const radioIp = `${teamSubnet(team)}.1`;
    try {
      const res = await fetchWithTimeout(`http://${radioIp}/status`);
      if (!res.ok) {
        const msg = `Radio returned HTTP ${res.status}`;
        return [
          { name: 'Radio SystemCore', status: 'error', message: msg, helpUrl: HELP_URLS.radioSystemCore },
          { name: 'Radio Firmware', status: 'error', message: msg, helpUrl: HELP_URLS.radioFirmware },
        ];
      }
      const data = (await res.json()) as { systemcoreEnabled?: boolean; version?: string };
      return [this.evaluateSystemCore(data), this.evaluateRadioFirmware(data)];
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'Radio unreachable (timeout)' : String(err);
      return [
        { name: 'Radio SystemCore', status: 'error', message: msg, helpUrl: HELP_URLS.radioSystemCore },
        { name: 'Radio Firmware', status: 'error', message: msg, helpUrl: HELP_URLS.radioFirmware },
      ];
    }
  }

  private evaluateSystemCore(data: { systemcoreEnabled?: boolean }): CheckResult {
    if (data.systemcoreEnabled === false) {
      return { name: 'Radio SystemCore', status: 'pass', expected: 'disabled', actual: 'disabled' };
    }
    return {
      name: 'Radio SystemCore',
      status: 'fail',
      expected: 'disabled',
      actual: 'enabled',
      message: 'SystemCore mode must be disabled for competition use',
      helpUrl: HELP_URLS.radioSystemCore,
    };
  }

  private evaluateRadioFirmware(data: { version?: string }): CheckResult {
    if (!data.version) {
      return {
        name: 'Radio Firmware',
        status: 'error',
        message: 'Version field missing from radio status',
        helpUrl: HELP_URLS.radioFirmware,
      };
    }
    // Version format: "VH-109_2.0.1-02062026"
    // Extract the version part after the underscore
    const versionPart = data.version.includes('_') ? data.version.split('_')[1] : data.version;
    if (versionPart.startsWith(EXPECTED_RADIO_FIRMWARE_PREFIX)) {
      return { name: 'Radio Firmware', status: 'pass', actual: data.version };
    }
    return {
      name: 'Radio Firmware',
      status: 'fail',
      expected: `Version ${EXPECTED_RADIO_FIRMWARE_PREFIX}+`,
      actual: data.version,
      message: 'Radio firmware is outdated',
      helpUrl: HELP_URLS.radioFirmware,
    };
  }

  // ── roboRIO checks ──────────────────────────────────────────────

  /**
   * Find the roboRIO on the team's subnet by probing the NI SysAPI endpoint.
   * Try the standard .2 address first, then any other alive hosts.
   */
  private async findRoboRIO(
    team: number,
    hosts: DiscoveredHost[],
  ): Promise<{ ip: string; bags: NISysAPIBag[] } | null> {
    const standardIp = expectedIP(team);
    const ipsToTry = [standardIp];
    // Add other alive hosts, skipping .1 (radio) and .254 (gateway) and the standard IP
    for (const host of hosts) {
      if (host.alive && host.ip !== standardIp && !host.ip.endsWith('.1') && !host.ip.endsWith('.254')) {
        ipsToTry.push(host.ip);
      }
    }

    for (const ip of ipsToTry) {
      try {
        const res = await fetchWithTimeout(`http://${ip}/nisysapi/server`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/xml',
          },
          body: 'Function=SearchForItemsAndProperties&Version=00010001&response_encoding=UTF-8&Plugins=nisyscfg&FilterMode=00000002',
        });
        if (!res.ok) continue;
        const xml = await res.text();
        if (!xml.includes('NISysAPI_Results')) continue;
        // Check for success (hr='0')
        const hrMatch = xml.match(/hr='([^']+)'/);
        if (hrMatch && hrMatch[1] !== '0') continue;
        const bags = parseNISysAPIResponse(xml);
        if (bags.length > 0) return { ip, bags };
      } catch {
        // Not a RIO, try next
      }
    }
    return null;
  }

  private async checkRoboRIO(team: number, hosts: DiscoveredHost[]): Promise<CheckResult[]> {
    const result = await this.findRoboRIO(team, hosts);
    if (!result) {
      return [
        {
          name: 'roboRIO',
          status: 'error',
          message: 'roboRIO not found on team subnet',
          helpUrl: HELP_URLS.roboRIOIP,
        },
      ];
    }

    const { ip, bags } = result;
    const systemBag = bags.find(b => b.itemName.endsWith('/system'));
    const eth0Bag = bags.find(b => b.itemName.endsWith('/eth0'));

    const checks: CheckResult[] = [];

    // Hostname check
    const hostname = systemBag?.properties.get(TAG_HOSTNAME);
    const expectedName = expectedHostname(team);
    if (hostname) {
      checks.push({
        name: 'roboRIO Hostname',
        status: hostname === expectedName ? 'pass' : 'fail',
        expected: expectedName,
        actual: hostname,
        ...(hostname !== expectedName && {
          message: 'Hostname does not match expected FRC format',
          helpUrl: HELP_URLS.roboRIOHostname,
        }),
      });
    } else {
      checks.push({
        name: 'roboRIO Hostname',
        status: 'error',
        message: 'Could not read hostname from roboRIO',
        helpUrl: HELP_URLS.roboRIOHostname,
      });
    }

    // IP check
    const rioIp = eth0Bag?.properties.get(TAG_IP_ADDRESS) ?? ip;
    const expectedIp = expectedIP(team);
    checks.push({
      name: 'roboRIO IP',
      status: rioIp === expectedIp ? 'pass' : 'fail',
      expected: expectedIp,
      actual: rioIp,
      ...(rioIp !== expectedIp && {
        message: `roboRIO is at non-standard IP (found via ${ip})`,
        helpUrl: HELP_URLS.roboRIOIP,
      }),
    });

    // Image version check
    const imageVersion = systemBag?.properties.get(TAG_IMAGE_VERSION);
    if (imageVersion) {
      const hasCurrentYear = imageVersion.includes(EXPECTED_IMAGE_YEAR);
      checks.push({
        name: 'roboRIO Image',
        status: hasCurrentYear ? 'pass' : 'fail',
        expected: `${EXPECTED_IMAGE_YEAR} image`,
        actual: imageVersion,
        ...(!hasCurrentYear && {
          message: 'roboRIO image is outdated',
          helpUrl: HELP_URLS.roboRIOImage,
        }),
      });
    } else {
      checks.push({
        name: 'roboRIO Image',
        status: 'error',
        message: 'Could not read image version from roboRIO',
        helpUrl: HELP_URLS.roboRIOImage,
      });
    }

    return checks;
  }
}
