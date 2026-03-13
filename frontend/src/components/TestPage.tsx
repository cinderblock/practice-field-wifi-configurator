import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import GlobalStyles from '@mui/material/GlobalStyles';
import Link from '@mui/material/Link';
import Step from '@mui/material/Step';
import StepContent from '@mui/material/StepContent';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import Typography from '@mui/material/Typography';

import type { CheckResult, RobotTestPhase } from '../../../src/types';
import { useRobotTestState } from '../hooks/useBackend';
import { StatusIcon } from './TeamChecksPanel';

const PULSE_STYLES = {
  '@keyframes test-pulse': {
    '0%': { transform: 'scale(1.8)', opacity: 1 },
    '100%': { transform: 'scale(1)', opacity: 0.4 },
  },
} as const;

/** Map phase to which stepper step is active (0-indexed). */
function activeStep(phase: RobotTestPhase): number {
  switch (phase) {
    case 'disabled':
    case 'link_down':
      return 0;
    case 'link_up':
    case 'dhcp_requesting':
      return 1;
    case 'ready':
    case 'checking':
    case 'complete':
      return 2;
  }
}

function PulseDot({ lastUpdate }: { lastUpdate: number }) {
  return (
    <Box
      key={lastUpdate}
      component="span"
      sx={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: 'success.main',
        animation: 'test-pulse 2s ease-out forwards',
        verticalAlign: 'middle',
        mr: 1,
      }}
    />
  );
}

function CheckResultRow({ check }: { check: CheckResult }) {
  const failed = check.status === 'fail' || check.status === 'error' || check.status === 'warn';
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.25 }}>
      <StatusIcon status={check.status} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontSize: '0.85rem', fontWeight: 500 }}>
          {check.name}
        </Typography>
        {check.status === 'pass' && (check.actual || check.message) && (
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', fontFamily: check.actual ? 'monospace' : undefined, fontSize: '0.75rem' }}
          >
            {check.actual ?? check.message}
          </Typography>
        )}
        {failed && (
          <Box>
            {check.expected && check.actual && (
              <Typography variant="caption" sx={{ fontSize: '0.75rem', display: 'block' }}>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  expected{' '}
                </Box>
                <Box component="span" sx={{ fontFamily: 'monospace' }}>
                  {check.expected}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  , got{' '}
                </Box>
                <Box component="span" sx={{ fontFamily: 'monospace', color: 'error.main' }}>
                  {check.actual}
                </Box>
              </Typography>
            )}
            {check.message && !check.expected && (
              <Typography variant="caption" sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                {check.message}
              </Typography>
            )}
            {check.helpUrl && (
              <Link href={check.helpUrl} target="_blank" rel="noopener" sx={{ fontSize: '0.75rem', display: 'block' }}>
                How to fix
              </Link>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function TestPage() {
  const state = useRobotTestState();

  if (!state || state.phase === 'disabled') {
    return (
      <Container maxWidth="sm" sx={{ py: 4 }}>
        <Typography variant="h4" gutterBottom>
          Robot Network Tester
        </Typography>
        <Alert severity="info">
          <Typography variant="body2">
            The robot network tester is not configured. Set the <code>TEST_INTERFACE</code> environment variable to a
            dedicated network interface (e.g., <code>eth1</code>) and restart the backend.
          </Typography>
        </Alert>
      </Container>
    );
  }

  const step = activeStep(state.phase);
  const radioChecks = state.checks.filter(c => c.name.startsWith('Radio'));
  const rioChecks = state.checks.filter(c => !c.name.startsWith('Radio'));

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <GlobalStyles styles={PULSE_STYLES} />
      <Typography variant="h4" gutterBottom>
        Robot Network Tester
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Interface: <code>{state.interfaceName}</code>
        {state.macAddress && (
          <>
            {' — '}
            <code>{state.macAddress}</code>
          </>
        )}
      </Typography>

      <Stepper activeStep={step} orientation="vertical">
        {/* Step 0: Link */}
        <Step completed={state.linkUp}>
          <StepLabel
            error={!state.linkUp}
            optional={
              !state.linkUp ? (
                <Typography variant="caption" color="text.secondary">
                  No cable detected
                </Typography>
              ) : undefined
            }
          >
            {state.linkUp ? (
              <>
                <PulseDot lastUpdate={state.lastUpdate} />
                Link Connected
              </>
            ) : (
              'Link Status'
            )}
          </StepLabel>
        </Step>

        {/* Step 1: DHCP */}
        <Step completed={!!state.teamNumber}>
          <StepLabel
            optional={
              state.phase === 'dhcp_requesting' ? (
                <Typography variant="caption" color="text.secondary">
                  Requesting DHCP lease...
                </Typography>
              ) : state.teamNumber ? (
                <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                  Team {state.teamNumber} — {state.leasedIp}
                </Typography>
              ) : undefined
            }
          >
            DHCP Discovery
          </StepLabel>
        </Step>

        {/* Step 2: Checks */}
        <Step completed={state.phase === 'complete'}>
          <StepLabel
            optional={
              state.phase === 'checking' ? (
                <Typography variant="caption" color="text.secondary">
                  Running checks...
                </Typography>
              ) : undefined
            }
          >
            Robot Checks
          </StepLabel>
          {state.checks.length > 0 && (
            <StepContent>
              {radioChecks.length > 0 && (
                <Box sx={{ mb: 1 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontWeight: 600, mb: 0.5, display: 'block' }}
                  >
                    Radio (
                    {state.teamNumber ? `10.${Math.floor(state.teamNumber / 100)}.${state.teamNumber % 100}.1` : '—'})
                  </Typography>
                  {radioChecks.map((c, i) => (
                    <CheckResultRow key={i} check={c} />
                  ))}
                </Box>
              )}
              {rioChecks.length > 0 && (
                <Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontWeight: 600, mb: 0.5, display: 'block' }}
                  >
                    roboRIO
                  </Typography>
                  {rioChecks.map((c, i) => (
                    <CheckResultRow key={i} check={c} />
                  ))}
                </Box>
              )}
            </StepContent>
          )}
        </Step>
      </Stepper>
    </Container>
  );
}
