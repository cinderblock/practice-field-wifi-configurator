import { useState, useEffect } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import GlobalStyles from '@mui/material/GlobalStyles';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Step from '@mui/material/Step';
import StepContent from '@mui/material/StepContent';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import type { CheckResult, RobotTestPhase } from '../../../src/types';
import { useRobotTestState, useFirmwareUpdateProgress, sendFirmwareUpdateRequest } from '../hooks/useBackend';
import { StatusIcon } from './TeamChecksPanel';

const PULSE_STYLES = {
  '@keyframes test-pulse': {
    '0%': { transform: 'scale(1.8)', opacity: 1 },
    '100%': { transform: 'scale(1)', opacity: 0.4 },
  },
} as const;

/** Map phase to which stepper step is active (0-indexed). */
function activeStep(phase: RobotTestPhase, isVlan: boolean): number {
  const offset = isVlan ? -1 : 0; // VLAN hides the link step
  switch (phase) {
    case 'disabled':
    case 'link_down':
      return 0;
    case 'link_up':
    case 'dhcp_requesting':
      return 1 + offset;
    case 'ready':
    case 'checking':
    case 'complete':
      return 2 + offset;
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

  const step = activeStep(state.phase, !!state.isVlan);
  const factoryChecks = state.checks.filter(c => c.name === 'Radio Not Configured');
  const radioChecks = state.checks.filter(c => c.name.startsWith('Radio'));
  const rioChecks = state.checks.filter(c => c.name.startsWith('roboRIO'));
  const mdnsChecks = state.checks.filter(c => c.name === 'mDNS');
  const consistencyChecks = state.checks.filter(c => c.name === 'Team Consistency');
  const firmwareOutdated = radioChecks.some(c => c.name === 'Radio Firmware' && c.status === 'fail');
  const teamSubnet = state.teamNumber ? `10.${Math.floor(state.teamNumber / 100)}.${state.teamNumber % 100}` : null;

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <GlobalStyles styles={PULSE_STYLES} />
      <Typography variant="h4" gutterBottom>
        Robot Network Tester
      </Typography>
      {/* Only show interface details for dedicated NICs, not VLANs */}
      {!state.isVlan && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Interface: <code>{state.interfaceName}</code>
          {state.macAddress && (
            <>
              {' — '}
              <code>{state.macAddress}</code>
            </>
          )}
        </Typography>
      )}

      <Stepper activeStep={step} orientation="vertical">
        {/* Step 0: Link — skip entirely for VLANs */}
        {!state.isVlan && (
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
        )}

        {/* Step 1: DHCP */}
        <Step completed={!!state.teamNumber}>
          <StepLabel
            optional={
              state.phase === 'dhcp_requesting' ? (
                <Typography variant="caption" color="text.secondary">
                  Waiting for robot...
                </Typography>
              ) : state.teamNumber ? (
                <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                  Team {state.teamNumber} — {state.leasedIp}
                </Typography>
              ) : undefined
            }
          >
            {state.teamNumber ? 'Robot Detected' : 'Waiting for Robot'}
          </StepLabel>
        </Step>

        {/* Step 2: Checks — always render content area to prevent layout shift */}
        <Step completed={state.phase === 'complete'}>
          <StepLabel>
            Robot Checks
            {state.phase === 'checking' && (
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                checking...
              </Typography>
            )}
          </StepLabel>
          <StepContent sx={{ minHeight: state.checks.length > 0 ? undefined : 24 }}>
            {/* Factory default warning */}
            {factoryChecks.map((c, i) => (
              <CheckResultRow key={`factory-${i}`} check={c} />
            ))}

            {/* Radio checks — firmware first, then SystemCore */}
            {radioChecks.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontWeight: 600, mb: 0.5, display: 'block' }}
                >
                  Radio {teamSubnet && `(${teamSubnet}.1)`}
                </Typography>
                {radioChecks.map((c, i) => (
                  <CheckResultRow key={`radio-${i}`} check={c} />
                ))}
                {firmwareOutdated && <FirmwareUpdateSection />}
              </Box>
            )}

            {/* roboRIO checks */}
            {rioChecks.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontWeight: 600, mb: 0.5, display: 'block' }}
                >
                  roboRIO {teamSubnet && `(${teamSubnet}.2)`}
                </Typography>
                {rioChecks.map((c, i) => (
                  <CheckResultRow key={`rio-${i}`} check={c} />
                ))}
              </Box>
            )}

            {/* mDNS */}
            {mdnsChecks.map((c, i) => (
              <Box key={`mdns-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                <StatusIcon status={c.status} />
                <Typography variant="caption" sx={{ color: c.status === 'pass' ? 'text.secondary' : undefined }}>
                  {c.actual ?? c.message}
                </Typography>
              </Box>
            ))}

            {/* Team consistency — compact inline display */}
            {consistencyChecks.length > 0 && (
              <Box sx={{ mt: 0.5 }}>
                {consistencyChecks.map((c, i) => (
                  <Box key={`cons-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <StatusIcon status={c.status} />
                    <Typography variant="caption" sx={{ color: c.status === 'pass' ? 'text.secondary' : undefined }}>
                      {c.status === 'pass' ? `Team ${state.teamNumber} consistent` : c.message}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
          </StepContent>
        </Step>
      </Stepper>

      <FirmwareStatus />
    </Container>
  );
}

function FirmwareUpdateSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wpaKey, setWpaKey] = useState('');
  const [wpaKey24, setWpaKey24] = useState('');
  const [skipReconfigure, setSkipReconfigure] = useState(false);
  const progress = useFirmwareUpdateProgress();
  const updating = progress && progress.step !== 'complete' && progress.step !== 'error';

  const handleSubmit = () => {
    sendFirmwareUpdateRequest(wpaKey || undefined, wpaKey24 || undefined, skipReconfigure);
    setDialogOpen(false);
  };

  return (
    <Box sx={{ mt: 1 }}>
      {progress && (
        <Box sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <Typography variant="caption" sx={{ fontSize: '0.75rem' }}>
              {progress.message}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {Math.round(progress.elapsedMs / 1000)}s
            </Typography>
          </Box>
          <LinearProgress
            variant={updating ? 'determinate' : undefined}
            value={progress.progress}
            color={progress.step === 'error' ? 'error' : progress.step === 'complete' ? 'success' : 'primary'}
            sx={{ height: 6, borderRadius: 3 }}
          />
          {progress.step === 'error' && (
            <Alert severity="error" sx={{ mt: 1, py: 0, fontSize: '0.8rem' }}>
              {progress.error}
            </Alert>
          )}
          {progress.step === 'complete' && (
            <Alert severity="success" sx={{ mt: 1, py: 0, fontSize: '0.8rem' }}>
              {progress.message}
            </Alert>
          )}
        </Box>
      )}
      <Button
        size="small"
        variant="outlined"
        color="warning"
        disabled={!!updating}
        onClick={() => setDialogOpen(true)}
        sx={{ textTransform: 'none', fontSize: '0.8rem' }}
      >
        Update Firmware
      </Button>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <form
          onSubmit={e => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <DialogTitle>Update Radio Firmware</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ mb: 2 }}>
              This will flash the latest firmware to the robot radio. The radio will reboot during the process (2-3
              minutes).
            </Typography>
            {!skipReconfigure && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  The current configuration (team number, SSID suffix) will be re-applied after the update. Enter the
                  WPA passphrase below, or leave blank to auto-detect from the station config.
                </Typography>
                <TextField
                  label="6 GHz WPA Passphrase (optional)"
                  value={wpaKey}
                  onChange={e => setWpaKey(e.target.value)}
                  fullWidth
                  autoFocus
                  helperText="Leave blank to auto-detect from station config"
                  margin="dense"
                />
                <TextField
                  label="2.4 GHz WPA Passphrase (optional)"
                  value={wpaKey24}
                  onChange={e => setWpaKey24(e.target.value)}
                  fullWidth
                  helperText="Leave blank to use the same key as 6 GHz"
                  margin="dense"
                />
              </>
            )}
            <FormControlLabel
              control={
                <Checkbox checked={skipReconfigure} onChange={e => setSkipReconfigure(e.target.checked)} size="small" />
              }
              label={
                <Typography variant="body2" color="text.secondary">
                  Flash firmware only — skip reconfiguration
                </Typography>
              }
              sx={{ mt: 1 }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button type="submit" variant="contained" color="warning">
              {skipReconfigure ? 'Flash Firmware' : 'Update & Reconfigure'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Box>
  );
}

// ── Firmware Status ─────────────────────────────────────────────────

interface FwEntry {
  version: string;
  checksum: string;
  filePath?: string;
  downloadUrl?: string;
  upgradeFrom: string;
  downloading?: boolean;
}

function FirmwareStatus() {
  const [entries, setEntries] = useState<FwEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadVersion, setUploadVersion] = useState('');
  const [uploadChecksum, setUploadChecksum] = useState('');
  const [uploadType, setUploadType] = useState<'from12x' | 'pre12x'>('from12x');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const refresh = () =>
      fetch('/api/firmware')
        .then(r => r.json())
        .then(data => setEntries(data.entries ?? []))
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

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
      const res = await fetch(`/api/firmware/upload?${params}`, { method: 'POST', body: data });
      const json = await res.json();
      setMessage(res.ok ? `Uploaded v${json.entry?.version ?? uploadVersion}` : `Error: ${json.error}`);
    } catch (err) {
      setMessage(`Upload failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setUploading(false);
    }
  };

  // Group entries by version, with columns for pre-1.2 and 1.2.x+
  const versions = new Map<string, { pre12x?: FwEntry; from12x?: FwEntry }>();
  for (const e of entries) {
    const row = versions.get(e.version) ?? {};
    if (e.upgradeFrom === 'pre12x') row.pre12x = e;
    else row.from12x = e;
    versions.set(e.version, row);
  }
  const allCached = entries.length > 0 && entries.every(e => e.filePath);

  const statusDot = (entry?: FwEntry) => {
    if (!entry)
      return (
        <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.7rem' }}>
          —
        </Typography>
      );
    const color = entry.filePath ? 'success.main' : entry.downloading ? 'info.main' : 'warning.main';
    const label = entry.filePath ? 'cached' : entry.downloading ? 'downloading' : 'missing';
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box
          component="span"
          sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem' }}>
          {label}
        </Typography>
      </Box>
    );
  };

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
        Firmware Store
      </Typography>
      {versions.size > 0 && (
        <Box
          sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '2px 12px', alignItems: 'center', mb: 0.5 }}
        >
          <Box />
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem', fontWeight: 600 }}>
            From 1.2.x+
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.65rem', fontWeight: 600 }}>
            Pre-1.2
          </Typography>
          {[...versions].map(([ver, row]) => (
            <Box key={ver} sx={{ display: 'contents' }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                v{ver}
              </Typography>
              {statusDot(row.from12x)}
              {statusDot(row.pre12x)}
            </Box>
          ))}
        </Box>
      )}
      {!allCached && (
        <Button
          size="small"
          onClick={() => setShowUpload(v => !v)}
          sx={{ mt: 0.5, textTransform: 'none', fontSize: '0.75rem', p: 0 }}
        >
          {showUpload ? 'Hide upload' : 'Upload firmware manually'}
        </Button>
      )}
      {showUpload && (
        <Box
          component="form"
          onSubmit={handleUpload}
          sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}
        >
          <input type="file" accept=".enc,.bin,.img" required disabled={uploading} style={{ fontSize: '0.8rem' }} />
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
            <TextField
              size="small"
              label="Version"
              value={uploadVersion}
              onChange={e => setUploadVersion(e.target.value)}
              required
              sx={{ flex: 1 }}
              slotProps={{ htmlInput: { style: { fontSize: '0.8rem' } } }}
            />
            <TextField
              size="small"
              label="SHA-256"
              value={uploadChecksum}
              onChange={e => setUploadChecksum(e.target.value)}
              required
              sx={{ flex: 2 }}
              slotProps={{ htmlInput: { style: { fontSize: '0.8rem', fontFamily: 'monospace' } } }}
            />
            <select
              value={uploadType}
              onChange={e => setUploadType(e.target.value as 'from12x' | 'pre12x')}
              style={{ fontSize: '0.8rem', padding: '6px' }}
            >
              <option value="from12x">1.2.x+</option>
              <option value="pre12x">Pre-1.2</option>
            </select>
          </Box>
          <Button
            type="submit"
            size="small"
            variant="outlined"
            disabled={uploading}
            sx={{ textTransform: 'none', alignSelf: 'flex-start' }}
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </Button>
        </Box>
      )}
      {message && (
        <Typography
          variant="caption"
          sx={{ mt: 0.5, display: 'block', color: message.startsWith('Error') ? 'error.main' : 'success.main' }}
        >
          {message}
        </Typography>
      )}
    </Box>
  );
}
