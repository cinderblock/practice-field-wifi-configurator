/**
 * Run the setup wizard's environment probe once and print it
 * (`bun scripts/probe-setup.ts`).
 *
 * Handy for seeing what a new deployer's wizard would show without opening a
 * browser — and for checking the probe on this machine, which is exactly the
 * "unsupported OS" case the first step is meant to catch.
 */
import { runSetupProbe } from '../src/setupProbe.js';

const state = await runSetupProbe({
  vlanInterface: process.env.VLAN_INTERFACE,
  radioUrl: process.env.RADIO_URL ?? 'http://10.0.100.2',
  fmsAddress: '10.0.100.5',
  dryRun: process.env.DRY_RUN !== undefined,
});

const icon = { pass: '✅', warn: '⚠️ ', fail: '❌' } as const;

console.log(`\nSetup probe — ${new Date(state.checkedAt).toISOString()}`);
console.log(`  trunk: ${state.vlanInterface ?? '(unset)'}   radio: ${state.radioUrl}   dryRun: ${state.dryRun}\n`);

for (const step of state.steps) {
  console.log(`${icon[step.status]} ${step.label} — ${step.blurb}`);
  for (const check of step.checks) {
    console.log(`     ${icon[check.status]} ${check.label}: ${check.detail}`);
    if (check.fix) console.log(`        fix: ${check.fix}`);
  }
  console.log();
}

const failed = state.steps.filter(s => s.status === 'fail').length;
console.log(failed === 0 ? 'No blocking problems found.' : `${failed} step(s) blocked.`);
