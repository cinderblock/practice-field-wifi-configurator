import { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';

import { MatchPhase, StationName } from '../../../src/types';
import { allianceColor, prettyStationName } from '../../../src/utils';
import {
  useMatchState,
  useLatest,
  sendAdminStopMatch,
  sendAdminGlobalEStop,
  sendAdminStationEStop,
  sendAdminStationDisable,
  sendAdminClearEStop,
} from '../hooks/useBackend';

const phaseColors: Record<MatchPhase, string> = {
  idle: 'text.secondary',
  countdown: 'warning.main',
  auto: 'info.main',
  autoPause: 'text.disabled',
  paused: 'warning.main',
  teleop: 'success.main',
  endgame: 'warning.main',
  postMatch: 'text.secondary',
};

const phaseLabels: Record<MatchPhase, string> = {
  idle: 'Idle',
  countdown: 'Countdown',
  auto: 'Autonomous',
  autoPause: 'Pause',
  paused: 'Paused',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
  postMatch: 'Post-Match',
};

// ── Global E-Stop ───────────────────────────────────────────────────

function GlobalEStopSection() {
  return (
    <Button
      variant="contained"
      color="error"
      fullWidth
      sx={{ fontSize: '1.5rem', py: 2.5, mb: 3, fontWeight: 'bold' }}
      onClick={() => sendAdminGlobalEStop()}
    >
      EMERGENCY STOP ALL
    </Button>
  );
}

// ── Per-Station Controls ────────────────────────────────────────────

function StationControlCard({ station }: { station: StationName }) {
  const matchState = useMatchState();
  const latest = useLatest();
  const stationState = matchState?.stationStates[station];
  const teamNumber = stationState?.teamNumber ?? null;
  const isRobotLinked = latest?.radioUpdate?.stationStatuses[station]?.isLinked ?? false;

  const title = teamNumber ? `Team ${teamNumber}` : prettyStationName(station);
  const subtitle = teamNumber ? prettyStationName(station) : null;

  return (
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="subtitle1" fontWeight="bold">
              {title}
              {subtitle && (
                <Typography component="span" variant="body2" sx={{ ml: 1, color: 'text.secondary' }}>
                  {subtitle}
                </Typography>
              )}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
              {isRobotLinked ? (
                <Chip label="Robot Linked" size="small" color="success" variant="outlined" />
              ) : teamNumber ? (
                <Chip label="No Robot" size="small" variant="outlined" color="warning" />
              ) : (
                <Chip label="No Team" size="small" variant="outlined" />
              )}
              {stationState?.joined && <Chip label="Joined" size="small" color="primary" variant="outlined" />}
              {stationState?.eStop && <Chip label="E-STOP" size="small" color="error" />}
              {stationState?.enabled && <Chip label="Enabled" size="small" color="success" />}
              {!stationState?.enabled && !stationState?.eStop && (
                <Chip label="Disabled" size="small" variant="outlined" />
              )}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            {stationState?.eStop ? (
              <Button size="small" variant="outlined" onClick={() => sendAdminClearEStop(station)}>
                Clear E-Stop
              </Button>
            ) : (
              <>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  onClick={() => sendAdminStationDisable(station)}
                  disabled={!stationState?.enabled}
                >
                  Disable
                </Button>
                <Button size="small" variant="contained" color="error" onClick={() => sendAdminStationEStop(station)}>
                  E-Stop
                </Button>
              </>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

function StationControlSection() {
  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          Teams & Controls
        </Typography>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            {(['red1', 'red2', 'red3'] as StationName[]).map(s => (
              <StationControlCard key={s} station={s} />
            ))}
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            {(['blue1', 'blue2', 'blue3'] as StationName[]).map(s => (
              <StationControlCard key={s} station={s} />
            ))}
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
}

// ── Match Timer ─────────────────────────────────────────────────────

function MatchTimer({ remainingTime, phase }: { remainingTime: number; phase: MatchPhase }) {
  const clamped = Math.max(0, remainingTime);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  const display = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <Typography
      variant="h1"
      sx={{
        fontFamily: 'monospace',
        fontSize: '6rem',
        textAlign: 'center',
        color: phaseColors[phase],
        lineHeight: 1,
      }}
    >
      {display}
    </Typography>
  );
}

// ── Match Status (read-only, admin can force-stop) ───────────────────

function MatchStatusSection() {
  const matchState = useMatchState();
  if (!matchState) return null;

  const { phase, remainingTime, totalMatchTime, config } = matchState;
  const isActive = phase !== 'idle' && phase !== 'postMatch';

  const countdownDuration = 3;
  const totalDuration = countdownDuration + config.autoDuration + config.pauseDuration + config.teleopDuration;
  const progress = Math.min(100, (totalMatchTime / totalDuration) * 100);

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Box sx={{ textAlign: 'center', mb: 2 }}>
          <Chip
            label={phaseLabels[phase]}
            sx={{
              fontSize: '1.2rem',
              py: 2.5,
              px: 2,
              fontWeight: 'bold',
              color: phaseColors[phase],
              borderColor: phaseColors[phase],
            }}
            variant="outlined"
          />
        </Box>

        <MatchTimer remainingTime={remainingTime} phase={phase} />

        <LinearProgress variant="determinate" value={progress} sx={{ my: 2, height: 8, borderRadius: 4 }} />

        {isActive && (
          <Button
            variant="contained"
            color="error"
            size="large"
            fullWidth
            sx={{ fontWeight: 'bold', fontSize: '1.1rem' }}
            onClick={sendAdminStopMatch}
          >
            Force Stop Match
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Admin Page ──────────────────────────────────────────────────────

export function AdminPage() {
  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Field Admin
      </Typography>

      <GlobalEStopSection />
      <MatchStatusSection />
      <StationControlSection />
      <FirmwareSection />
    </Container>
  );
}

// ── Firmware Management ─────────────────────────────────────────────

interface FirmwareEntry {
  version: string;
  checksum: string;
  filePath?: string;
  downloadUrl?: string;
  upgradeFrom: string;
  downloading?: boolean;
}

function FirmwareSection() {
  const [entries, setEntries] = useState<FirmwareEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadChecksum, setUploadChecksum] = useState('');
  const [uploadType, setUploadType] = useState<'from12x' | 'pre12x'>('from12x');
  const [message, setMessage] = useState('');

  const refreshEntries = useCallback(() => {
    fetch('/api/firmware')
      .then(r => r.json())
      .then(data => setEntries(data.entries ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshEntries();
    const interval = setInterval(refreshEntries, 10_000);
    return () => clearInterval(interval);
  }, [refreshEntries]);

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file || !uploadVersion || !uploadChecksum) return;

    setUploading(true);
    setMessage('');
    try {
      const data = await file.arrayBuffer();
      const params = new URLSearchParams({ checksum: uploadChecksum, version: uploadVersion, upgradeFrom: uploadType });
      const res = await fetch(`/api/firmware/upload?${params}`, {
        method: 'POST',
        body: data,
      });
      const json = await res.json();
      if (res.ok) {
        setMessage(`Uploaded: ${json.entry?.version ?? 'ok'}`);
        refreshEntries();
      } else {
        setMessage(`Error: ${json.error}`);
      }
    } catch (err) {
      setMessage(`Upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
    }
  };

  const triggerDownload = () => {
    fetch('/api/firmware/download', { method: 'POST' }).then(() => {
      setMessage('Background download started');
      setTimeout(refreshEntries, 3000);
    });
  };

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          Radio Firmware
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Firmware files are downloaded automatically when internet is available. Upload manually if the server is
          offline.
        </Typography>

        {entries.length > 0 && (
          <Box sx={{ mb: 2 }}>
            {entries.map((entry, i) => (
              <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Chip
                  label={entry.filePath ? 'Cached' : entry.downloading ? 'Downloading' : 'Missing'}
                  size="small"
                  color={entry.filePath ? 'success' : entry.downloading ? 'info' : 'warning'}
                  variant={entry.filePath ? 'filled' : 'outlined'}
                />
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                  v{entry.version} ({entry.upgradeFrom === 'from12x' ? '1.2.x+' : 'pre-1.2'})
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  {entry.checksum.slice(0, 12)}...
                </Typography>
              </Box>
            ))}
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <Button size="small" variant="outlined" onClick={triggerDownload}>
            Download from Internet
          </Button>
        </Box>

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Manual Upload
        </Typography>
        <form onSubmit={handleUpload}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <input type="file" accept=".enc,.bin,.img" required disabled={uploading} />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <input
                type="text"
                placeholder="Version (e.g. 2.0.1)"
                value={uploadVersion}
                onChange={e => setUploadVersion(e.target.value)}
                required
                style={{ flex: 1, padding: '4px 8px' }}
              />
              <input
                type="text"
                placeholder="SHA-256 checksum"
                value={uploadChecksum}
                onChange={e => setUploadChecksum(e.target.value)}
                required
                style={{ flex: 2, padding: '4px 8px', fontFamily: 'monospace' }}
              />
              <select value={uploadType} onChange={e => setUploadType(e.target.value as 'from12x' | 'pre12x')}>
                <option value="from12x">From 1.2.x+</option>
                <option value="pre12x">Pre-1.2</option>
              </select>
            </Box>
            <Button type="submit" size="small" variant="contained" disabled={uploading}>
              {uploading ? 'Uploading...' : 'Upload Firmware'}
            </Button>
          </Box>
        </form>
        {message && (
          <Typography
            variant="body2"
            sx={{ mt: 1, color: message.startsWith('Error') ? 'error.main' : 'success.main' }}
          >
            {message}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
