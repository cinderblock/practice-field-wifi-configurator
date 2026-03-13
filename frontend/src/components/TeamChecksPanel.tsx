import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Link from '@mui/material/Link';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import WarningIcon from '@mui/icons-material/Warning';
import ErrorIcon from '@mui/icons-material/Error';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import type { StationName, CheckResult, CheckStatus } from '../../../src/types';
import { useTeamCheckResults, sendRunTeamChecks } from '../hooks/useBackend';

export function StatusIcon({ status, size: fontSize = 18 }: { status: CheckStatus; size?: number }) {
  switch (status) {
    case 'pass':
      return <CheckCircleIcon sx={{ fontSize, color: 'success.main' }} />;
    case 'fail':
      return <CancelIcon sx={{ fontSize, color: 'error.main' }} />;
    case 'warn':
      return <WarningIcon sx={{ fontSize, color: 'warning.main' }} />;
    case 'error':
      return <ErrorIcon sx={{ fontSize, color: 'text.disabled' }} />;
    case 'pending':
      return <HourglassEmptyIcon sx={{ fontSize, color: 'text.disabled' }} />;
  }
}

function CheckRow({ check }: { check: CheckResult }) {
  const failed = check.status === 'fail' || check.status === 'error' || check.status === 'warn';
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.25, px: 1 }}>
      <StatusIcon status={check.status} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontSize: '0.8rem', fontWeight: 500 }}>
          {check.name}
        </Typography>
        {check.status === 'pass' && (check.actual || check.message) && (
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', fontFamily: check.actual ? 'monospace' : undefined, fontSize: '0.7rem' }}
          >
            {check.actual ?? check.message}
          </Typography>
        )}
        {failed && (
          <Box>
            {check.expected && check.actual && (
              <Typography variant="caption" sx={{ fontSize: '0.7rem', display: 'block' }}>
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
              <Typography variant="caption" sx={{ fontSize: '0.7rem', color: 'text.secondary' }}>
                {check.message}
              </Typography>
            )}
            {check.helpUrl && (
              <Link href={check.helpUrl} target="_blank" rel="noopener" sx={{ fontSize: '0.7rem', display: 'block' }}>
                How to fix
              </Link>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function TeamChecksPanel({ station }: { station: StationName }) {
  const results = useTeamCheckResults(station);
  if (!results) return null;

  const allPassed = results.checks.every(c => c.status === 'pass');
  const hasFailures = results.checks.some(c => c.status === 'fail');

  return (
    <Box sx={{ mt: 0.5 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1, mb: 0.25 }}>
        <Typography
          variant="caption"
          sx={{
            color: allPassed ? 'success.main' : hasFailures ? 'error.main' : 'text.secondary',
            fontWeight: 500,
          }}
        >
          Team Checks
          {allPassed && ' — All Passed'}
        </Typography>
        <Tooltip title="Re-run checks">
          <IconButton size="small" onClick={() => sendRunTeamChecks(station)} sx={{ p: 0.25 }}>
            <RefreshIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
      {results.checks.map((check, i) => (
        <CheckRow key={i} check={check} />
      ))}
    </Box>
  );
}
