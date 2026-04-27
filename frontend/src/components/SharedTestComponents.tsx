import { useState, useEffect } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { CheckResult } from '../../../src/types';
import { StatusIcon } from './TeamChecksPanel';

/**
 * Display a single check result with status icon and details.
 * @param compact - Use smaller typography and tighter spacing for inline views.
 */
export function CheckResultRow({ check, compact }: { check: CheckResult; compact?: boolean }) {
  const failed = check.status === 'fail' || check.status === 'error' || check.status === 'warn';
  const variant = compact ? ('caption' as const) : ('body2' as const);
  const detailSize = compact ? '0.7rem' : '0.75rem';
  const nameSize = compact ? undefined : '0.85rem';
  const gap = compact ? 0.5 : 1;
  const iconSize = compact ? 16 : undefined;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap, py: 0.25 }}>
      <StatusIcon status={check.status} size={iconSize} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant={variant} sx={{ fontSize: nameSize, fontWeight: 500 }}>
          {check.name}
        </Typography>
        {check.status === 'pass' && (check.actual || check.message) && (
          <Typography
            variant="caption"
            sx={{
              color: 'text.secondary',
              fontFamily: check.actual ? 'monospace' : undefined,
              fontSize: detailSize,
              display: compact ? 'block' : undefined,
            }}
          >
            {check.actual ?? check.message}
          </Typography>
        )}
        {failed && (
          <Box>
            {check.expected && check.actual && (
              <Typography variant="caption" sx={{ fontSize: detailSize, display: 'block' }}>
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
              <Typography variant="caption" sx={{ fontSize: detailSize, color: 'text.secondary' }}>
                {check.message}
              </Typography>
            )}
            {check.helpUrl && (
              <Link href={check.helpUrl} target="_blank" rel="noopener" sx={{ fontSize: detailSize, display: 'block' }}>
                How to fix
              </Link>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * Banner shown after radio reconfiguration or firmware update while the network settles.
 * @param compact - Use smaller typography for inline views.
 */
export function SettlingBanner({
  reconfiguredAt,
  timeoutMs,
  type,
  compact,
}: {
  reconfiguredAt: number;
  timeoutMs: number;
  type?: 'radio' | 'firmware';
  compact?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Date.now() - reconfiguredAt);
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [reconfiguredAt]);

  const label = type === 'firmware' ? 'firmware update' : 'reconfiguration';
  const expectedMs = type === 'firmware' ? 60_000 : 40_000;
  const secs = Math.round(elapsed / 1000);
  const variant = compact ? ('caption' as const) : ('body2' as const);
  const mbVal = compact ? 1 : 1.5;
  const pyVal = compact ? 0 : 0.5;
  const fontSize = compact ? undefined : '0.85rem';

  if (elapsed > timeoutMs) {
    return (
      <Alert severity="error" sx={{ mb: mbVal, py: pyVal }}>
        <Typography variant={variant} sx={{ fontSize }}>
          Network did not stabilize after {label} ({secs}s). Try power-cycling the robot.
        </Typography>
      </Alert>
    );
  }

  if (elapsed > expectedMs) {
    return (
      <Alert severity="warning" sx={{ mb: mbVal, py: pyVal }}>
        <Typography variant={variant} sx={{ fontSize }}>
          Network settling after {label} ({secs}s). Please wait...
        </Typography>
      </Alert>
    );
  }

  return (
    <Alert severity="info" sx={{ mb: mbVal, py: pyVal }}>
      <Typography variant={variant} sx={{ fontSize }}>
        Radio {type === 'firmware' ? 'updated' : 'reconfigured'}. Network settling ({secs}s)...
      </Typography>
    </Alert>
  );
}
