import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Button from '@mui/material/Button';
import GitHubIcon from '@mui/icons-material/GitHub';
import ScoreboardIcon from '@mui/icons-material/Scoreboard';
import { useConnectivity, ConnectivityState } from '../hooks/useConnectivity';
import { usePendingCommit, sendApplyConfig, useServerStartTime, serverToBrowserTime } from '../hooks/useBackend';

type DotColor = 'success.main' | 'error.main' | 'warning.main' | 'text.disabled';

function StatusDot({ color, label, tooltip }: { color: DotColor; label: string; tooltip: string }) {
  return (
    <Tooltip title={tooltip} arrow>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mx: 1, cursor: 'default' }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
          }}
        />
        <Typography variant="caption" sx={{ fontSize: '0.7rem', color: 'text.secondary', userSelect: 'none' }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function UptimeDisplay({ serverStartTime }: { serverStartTime: number }) {
  const [uptime, setUptime] = useState(() => Date.now() - serverToBrowserTime(serverStartTime));

  useEffect(() => {
    setUptime(Date.now() - serverToBrowserTime(serverStartTime));
    const interval = setInterval(() => {
      setUptime(Date.now() - serverToBrowserTime(serverStartTime));
    }, 1000);
    return () => clearInterval(interval);
  }, [serverStartTime]);

  // Hide after 1 hour — uptime is only interesting shortly after a restart
  if (uptime >= 3_600_000) return null;

  return (
    <Tooltip title="Backend uptime" arrow>
      <Typography
        variant="caption"
        sx={{ fontSize: '0.7rem', color: 'text.secondary', userSelect: 'none', mx: 1, cursor: 'default' }}
      >
        {formatUptime(uptime)}
      </Typography>
    </Tooltip>
  );
}

function getInternetIndicator(state: ConnectivityState) {
  if (state.internet === 'checking') return { color: 'text.disabled' as DotColor, tooltip: 'Checking internet...' };
  if (state.internet === 'ok') return { color: 'success.main' as DotColor, tooltip: 'Internet reachable' };
  return { color: 'error.main' as DotColor, tooltip: 'Internet unreachable' };
}

function getPfmsIndicator(state: ConnectivityState) {
  if (state.wsConnected) return { color: 'success.main' as DotColor, tooltip: 'PFMS connected' };
  return { color: 'error.main' as DotColor, tooltip: 'PFMS disconnected' };
}

export function StatusBar() {
  const connectivity = useConnectivity();
  const internet = getInternetIndicator(connectivity);
  const pfms = getPfmsIndicator(connectivity);
  const pendingCommit = usePendingCommit();
  const serverStartTime = useServerStartTime();

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        px: 1,
        backgroundColor: pendingCommit ? 'warning.dark' : 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
        transition: 'background-color 0.3s',
      }}
    >
      <StatusDot color={internet.color} label="Internet" tooltip={internet.tooltip} />
      <StatusDot color={pfms.color} label="PFMS" tooltip={pfms.tooltip} />
      {serverStartTime != null && <UptimeDisplay serverStartTime={serverStartTime} />}
      {pendingCommit && (
        <Tooltip
          title="Configuration changes are saved but not yet applied to the radio. Click to apply now, or they will be applied with the next Save."
          arrow
        >
          <Button
            size="small"
            variant="contained"
            color="warning"
            onClick={sendApplyConfig}
            sx={{
              ml: 1,
              py: 0,
              px: 1,
              minHeight: 18,
              fontSize: '0.65rem',
              lineHeight: 1.2,
              textTransform: 'none',
            }}
          >
            Apply pending changes
          </Button>
        </Tooltip>
      )}
      <Box sx={{ position: 'absolute', right: 4, display: 'flex', gap: 0.5, alignItems: 'center' }}>
        <Tooltip title="Scoreboard" arrow>
          <IconButton component="a" href="/scores" target="_blank" size="small" sx={{ p: 0, color: 'text.secondary' }}>
            <ScoreboardIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="View source on GitHub" arrow>
          <IconButton
            component="a"
            href="https://github.com/cinderblock/practice-field-wifi-configurator"
            target="_blank"
            rel="noopener"
            size="small"
            sx={{ p: 0, color: 'text.secondary' }}
          >
            <GitHubIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
