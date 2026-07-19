import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MatchEngine } from './matchEngine.js';
import type { AudioDeviceInfo, AudioDeviceState } from './types.js';

const execFileAsync = promisify(execFile);

const SOUNDS_DIR = resolve(__dirname, '..', 'sounds');
const CONFIG_FILE = 'audio-config.json';

type SoundName = 'start' | 'end' | 'resume' | 'warning' | 'abort' | 'pause' | 'count3' | 'count2' | 'count1';

const PLAYERS = ['aplay', 'paplay', 'ffplay', 'mpv', 'play', 'afplay'];

async function detectPlayer(): Promise<string | null> {
  for (const player of PLAYERS) {
    try {
      await execFileAsync('which', [player]);
      return player;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/** Parse /proc/asound/cards to enumerate available audio devices. */
function enumerateDevices(): AudioDeviceInfo[] {
  try {
    const raw = readFileSync('/proc/asound/cards', 'utf-8');
    const devices: AudioDeviceInfo[] = [];
    const lines = raw.split('\n');

    for (let i = 0; i < lines.length; i += 2) {
      // Line 1:  " 1 [Audio          ]: USB-Audio - AB13X USB Audio"
      const match = lines[i]?.match(/^\s*(\d+)\s+\[(\S+)\s*\]\s*:\s*(\S+)\s*-\s*(.+)$/);
      if (match) {
        const cardIndex = parseInt(match[1], 10);
        devices.push({
          cardIndex,
          shortName: match[2],
          driver: match[3],
          name: match[4].trim(),
          alsaDevice: `plughw:${cardIndex},0`,
        });
      }
    }

    return devices;
  } catch {
    return [];
  }
}

interface SavedConfig {
  deviceName: string;
}

export class MatchAudio {
  private player: string | null = null;
  private availableSounds = new Set<SoundName>();
  private selectedDeviceName: string | null = null;
  private listeners: ((state: AudioDeviceState) => void)[] = [];

  async init(): Promise<void> {
    this.player = await detectPlayer();

    if (!this.player) {
      console.log('Match audio: no playback binary found, sounds disabled');
      return;
    }

    // Cache which sound files exist
    const allSounds: SoundName[] = [
      'start',
      'end',
      'resume',
      'warning',
      'abort',
      'pause',
      'count3',
      'count2',
      'count1',
    ];
    for (const sound of allSounds) {
      if (existsSync(resolve(SOUNDS_DIR, `${sound}.wav`))) {
        this.availableSounds.add(sound);
      }
    }

    if (this.availableSounds.size === 0) {
      console.log(`Match audio: sounds directory missing (${SOUNDS_DIR}), sounds disabled`);
      this.player = null;
      return;
    }

    // Load saved device selection
    this.loadConfig();

    const resolved = this.resolveDevice();
    if (this.selectedDeviceName) {
      if (resolved) {
        console.log(`Match audio: using ${this.player} on "${this.selectedDeviceName}" (${resolved})`);
      } else {
        console.log(`Match audio: "${this.selectedDeviceName}" not found, waiting for reconnect`);
      }
    } else {
      console.log('Match audio: no device selected, sounds disabled');
    }
  }

  /** Resolve the selected device name to a current ALSA device string, or null. */
  private resolveDevice(): string | null {
    if (!this.selectedDeviceName) return null;
    const devices = enumerateDevices();
    const match = devices.find(d => d.name === this.selectedDeviceName);
    return match?.alsaDevice ?? null;
  }

  /** Get the list of currently available audio devices. */
  getAvailableDevices(): AudioDeviceInfo[] {
    return enumerateDevices();
  }

  /** Select a device by name (null to disable). Persists the choice. */
  selectDevice(deviceName: string | null): void {
    this.selectedDeviceName = deviceName;
    this.saveConfig();
    this.broadcast();

    if (deviceName) {
      const resolved = this.resolveDevice();
      if (resolved) {
        console.log(`Match audio: selected "${deviceName}" (${resolved})`);
      } else {
        console.log(`Match audio: selected "${deviceName}" (not currently connected)`);
      }
    } else {
      console.log('Match audio: disabled');
    }
  }

  play(sound: SoundName): void {
    if (!this.player) return;
    if (!this.availableSounds.has(sound)) return;

    const device = this.resolveDevice();
    if (!device) return;

    const file = resolve(SOUNDS_DIR, `${sound}.wav`);

    const args =
      this.player === 'ffplay'
        ? ['-nodisp', '-autoexit', file]
        : this.player === 'aplay'
          ? ['-D', device, file]
          : [file];

    const child = spawn(this.player, args, {
      stdio: 'ignore',
      detached: true,
    });

    child.unref();
    child.on('error', () => {}); // silently ignore
  }

  // ── State broadcasting ──────────────────────────────────────────

  getState(): AudioDeviceState {
    const available = enumerateDevices();
    const resolved = this.selectedDeviceName
      ? (available.find(d => d.name === this.selectedDeviceName)?.alsaDevice ?? null)
      : null;

    return {
      type: 'audioDeviceState',
      available,
      selectedDeviceName: this.selectedDeviceName,
      resolvedDevice: resolved,
      status: !this.selectedDeviceName ? 'disabled' : resolved ? 'active' : 'disconnected',
    };
  }

  addStateListener(fn: (state: AudioDeviceState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private broadcast(): void {
    const state = this.getState();
    for (const fn of this.listeners) fn(state);
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadConfig(): void {
    try {
      if (!existsSync(CONFIG_FILE)) return;
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed: SavedConfig = JSON.parse(raw);
      if (typeof parsed.deviceName === 'string') {
        this.selectedDeviceName = parsed.deviceName;
      }
    } catch (err) {
      console.warn(`Failed to load audio config: ${(err as Error).message}`);
    }
  }

  private saveConfig(): void {
    try {
      if (this.selectedDeviceName) {
        const config: SavedConfig = { deviceName: this.selectedDeviceName };
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
      } else {
        // Remove config file when disabled
        if (existsSync(CONFIG_FILE)) {
          writeFileSync(CONFIG_FILE, '{}', 'utf-8');
        }
      }
    } catch (err) {
      console.error(`Failed to save audio config: ${(err as Error).message}`);
    }
  }

  // ── Match engine integration ────────────────────────────────────

  attachToEngine(engine: MatchEngine): void {
    let lastPhase = 'idle';
    let lastCountdownSecond = 0;

    engine.addStateListener(state => {
      // Announce "3… 2… 1…" as the pre-start countdown ticks. The countdown
      // enters at exactly 3s and broadcasts every tick, so each whole second
      // fires once; an aborted countdown resets for the next start.
      if (state.phase === 'countdown') {
        const second = Math.ceil(state.remainingTime);
        if (second !== lastCountdownSecond && second >= 1 && second <= 3) {
          lastCountdownSecond = second;
          this.play(`count${second}` as SoundName);
        }
      } else {
        lastCountdownSecond = 0;
      }

      if (state.phase === lastPhase) return;
      const prevPhase = lastPhase;
      lastPhase = state.phase;

      switch (state.phase) {
        case 'auto':
          if (prevPhase === 'paused') {
            // user resumed during auto
            this.play('resume');
          } else {
            // countdown → auto: charge horn
            this.play('start');
          }
          break;

        case 'autoPause':
          // auto → autoPause: end-of-auto buzzer
          this.play('end');
          break;

        case 'teleop':
          // autoPause → teleop, or user resumed during teleop: resume horn
          this.play('resume');
          break;

        case 'endgame':
          if (prevPhase === 'paused') {
            // user resumed during endgame
            this.play('resume');
          } else {
            // teleop → endgame: warning
            this.play('warning');
          }
          break;

        case 'paused':
          // user paused the match
          this.play('pause');
          break;

        case 'postMatch':
          if (state.endReason === 'stopped' || state.endReason === 'estop' || state.endReason === 'abandoned') {
            this.play('abort');
          } else {
            this.play('end');
          }
          break;
      }
    });
  }
}
