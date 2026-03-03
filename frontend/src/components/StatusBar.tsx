import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import { useConnectivity, ConnectivityState } from '../hooks/useConnectivity';

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

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        px: 1,
        backgroundColor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <StatusDot color={internet.color} label="Internet" tooltip={internet.tooltip} />
      <StatusDot color={pfms.color} label="PFMS" tooltip={pfms.tooltip} />
    </Box>
  );
}
