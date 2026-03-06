import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { MatchEngine } from './matchEngine.js';

const execFileAsync = promisify(execFile);

const SOUNDS_DIR = resolve(__dirname, '..', 'sounds');

type SoundName = 'start' | 'end' | 'resume' | 'warning' | 'abort';

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

export class MatchAudio {
  private player: string | null = null;
  private availableSounds = new Set<SoundName>();

  async init(): Promise<void> {
    this.player = await detectPlayer();

    if (!this.player) {
      console.log('Match audio: no playback binary found, sounds disabled');
      return;
    }

    // Cache which sound files exist
    const allSounds: SoundName[] = ['start', 'end', 'resume', 'warning', 'abort'];
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

    console.log(`Match audio: using ${this.player}`);
  }

  play(sound: SoundName): void {
    if (!this.player) return;
    if (!this.availableSounds.has(sound)) return;

    const file = resolve(SOUNDS_DIR, `${sound}.wav`);

    const args = this.player === 'ffplay' ? ['-nodisp', '-autoexit', file] : [file];

    const child = spawn(this.player, args, {
      stdio: 'ignore',
      detached: true,
    });

    child.unref();
    child.on('error', () => {}); // silently ignore
  }

  attachToEngine(engine: MatchEngine): void {
    let lastPhase = 'idle';

    engine.addStateListener(state => {
      if (state.phase === lastPhase) return;
      lastPhase = state.phase;

      switch (state.phase) {
        case 'auto':
          // countdown → auto: charge horn
          this.play('start');
          break;

        case 'pause':
          // auto → pause: end-of-auto buzzer
          this.play('end');
          break;

        case 'teleop':
          // pause → teleop: resume horn
          this.play('resume');
          break;

        case 'endgame':
          // teleop → endgame: warning
          this.play('warning');
          break;

        case 'postMatch':
          if (state.endReason === 'stopped' || state.endReason === 'estop') {
            this.play('abort');
          } else {
            this.play('end');
          }
          break;
      }
    });
  }
}
