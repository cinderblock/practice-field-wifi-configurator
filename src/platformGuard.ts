/**
 * Fail fast, and legibly, on a platform whose networking we haven't
 * implemented.
 *
 * Imported first by `src/index.ts` so it runs before `networkManager` builds a
 * platform backend at module load — otherwise the first thing an operator on
 * Windows sees is a raw `node-ip: platform "win32" is not supported` stack
 * trace from deep inside an import, with no hint that DRY_RUN exists.
 *
 * Development on any OS is still fine: DRY_RUN swaps in a backend that only
 * logs what it would have done.
 */
import { platform } from 'node:os';

/** Commands that never touch the network and must work anywhere. */
function isCliCommand(argv: string[]): boolean {
  return argv.some(arg => arg === '--clear-config' || arg === '--help' || arg === '-h');
}

export function assertSupportedPlatform(argv: string[] = process.argv.slice(2)): void {
  const os = platform();
  if (os === 'linux') return;
  if (isCliCommand(argv)) return;
  if (process.env.DRY_RUN) return;

  console.error(`pFMS cannot manage a field on ${os}.`);
  console.error('');
  console.error('VLAN, routing, and firewall management are implemented for Linux only.');
  console.error('A Windows networking layer has not been written yet.');
  console.error('');
  console.error('Options:');
  console.error('  • Run a field on a Linux host (see docs/getting-started.md)');
  console.error('  • Develop here with DRY_RUN=1, which logs network operations');
  console.error('    instead of performing them:');
  console.error('');
  console.error('        DRY_RUN=1 bun run dev');
  console.error('');
  process.exit(78); // EX_CONFIG, matching the missing-tools exit
}

assertSupportedPlatform();
