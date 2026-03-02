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
  const { pfmsHttp, pfmsHttpFailReason, wsConnected } = state;

  if (pfmsHttp === 'checking') return { color: 'text.disabled' as DotColor, tooltip: 'Checking PFMS...' };

  const httpOk = pfmsHttp === 'ok';

  if (httpOk && wsConnected) return { color: 'success.main' as DotColor, tooltip: 'PFMS connected' };

  if (httpOk && !wsConnected)
    return { color: 'warning.main' as DotColor, tooltip: 'WebSocket disconnected (server reachable)' };

  if (!httpOk && wsConnected)
    return { color: 'warning.main' as DotColor, tooltip: 'HTTP health failed (WS OK — check proxy /health route)' };

  // Both down
  if (pfmsHttpFailReason === 'rejected') {
    return { color: 'error.main' as DotColor, tooltip: 'Connection rejected — possible HTTPS/cert issue' };
  }

  if (state.internet === 'ok') {
    return { color: 'error.main' as DotColor, tooltip: 'PFMS unreachable (server may be down)' };
  }

  return { color: 'error.main' as DotColor, tooltip: 'No connectivity' };
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
        justifyContent: 'flex-end',
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
