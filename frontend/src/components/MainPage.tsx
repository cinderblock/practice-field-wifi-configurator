import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ScoreboardIcon from '@mui/icons-material/Scoreboard';
import SettingsIcon from '@mui/icons-material/Settings';
import Tooltip from '@mui/material/Tooltip';
import { useSavedTeams, sendRemoveSavedTeam } from '../hooks/useBackend';
import { formatAge } from '../../../src/utils';
import type { SavedTeamConfig } from '../../../src/types';

const TEAM_NUMBER_KEY = 'saved-team-number';
const TEAM_SUFFIX_KEY = 'saved-team-suffix';

function getSavedTeam(): { teamNumber: string; suffix: string } | null {
  const num = localStorage.getItem(TEAM_NUMBER_KEY);
  if (!num) return null;
  return { teamNumber: num, suffix: localStorage.getItem(TEAM_SUFFIX_KEY) ?? '' };
}

function saveTeamToStorage(teamNumber: string, suffix: string) {
  localStorage.setItem(TEAM_NUMBER_KEY, teamNumber);
  localStorage.setItem(TEAM_SUFFIX_KEY, suffix);
}

function navigateToControl(teamNumber: string, suffix: string) {
  const ssid = suffix ? `${teamNumber}-${suffix}` : teamNumber;
  window.location.href = `/control/${encodeURIComponent(ssid)}`;
}

/**
 * Main landing page — team number entry + saved configs.
 *
 * If a team number was previously saved in localStorage, we redirect
 * immediately to the control page. Otherwise, show the entry dialog.
 */
export function MainPage() {
  const saved = getSavedTeam();

  // If a team number was previously saved, redirect immediately
  useEffect(() => {
    if (saved) {
      navigateToControl(saved.teamNumber, saved.suffix);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // While redirecting, show the admin overview as fallback
  if (saved) {
    return (
      <Container>
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 4 }}>
          Redirecting to team {saved.suffix ? `${saved.teamNumber}-${saved.suffix}` : saved.teamNumber}...
        </Typography>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <TeamEntryDialog />
    </Container>
  );
}

/**
 * Simple dialog for entering a team number.
 * Shows:
 * 1. Team number input
 * 2. Optional suffix (collapsed by default)
 * 3. Server-side saved team configs as quick-launch buttons
 * 4. Links to /scores and /admin
 */
function TeamEntryDialog() {
  const [teamNumber, setTeamNumber] = useState('');
  const [suffix, setSuffix] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const savedTeams = useSavedTeams();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isValid = /^\d{1,6}$/.test(teamNumber);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isValid) return;
    saveTeamToStorage(teamNumber, suffix);
    navigateToControl(teamNumber, suffix);
  };

  const handleSavedTeamClick = (config: SavedTeamConfig) => {
    // Parse team number and suffix from SSID
    const parts = config.ssid.split('-');
    const num = parts[0];
    const suf = parts.slice(1).join('-');
    saveTeamToStorage(num, suf);
    navigateToControl(num, suf);
  };

  return (
    <Card>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h4" sx={{ textAlign: 'center', mb: 3, fontWeight: 700 }}>
          Practice Field
        </Typography>

        <form onSubmit={handleSubmit}>
          <TextField
            label="Team Number"
            value={teamNumber}
            onChange={e => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setTeamNumber(v);
            }}
            fullWidth
            autoFocus
            inputRef={inputRef}
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                pattern: '[0-9]*',
                autoComplete: 'off',
              },
            }}
            sx={{ mb: 2 }}
          />

          {/* Advanced: suffix input */}
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
            <Button
              size="small"
              onClick={() => setShowAdvanced(!showAdvanced)}
              endIcon={
                <ExpandMoreIcon
                  sx={{
                    transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}
                />
              }
              sx={{ color: 'text.secondary', textTransform: 'none' }}
            >
              Advanced
            </Button>
          </Box>
          <Collapse in={showAdvanced}>
            <TextField
              label="Suffix (optional)"
              value={suffix}
              onChange={e => setSuffix(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 10))}
              fullWidth
              size="small"
              helperText={`SSID will be: FRC-${teamNumber || '???'}${suffix ? `-${suffix}` : ''}`}
              sx={{ mb: 2 }}
            />
          </Collapse>

          <Button
            type="submit"
            variant="contained"
            color="primary"
            fullWidth
            size="large"
            disabled={!isValid}
            sx={{ fontWeight: 'bold', py: 1.5 }}
          >
            Go
          </Button>
        </form>

        {/* Server-side saved team configs */}
        {savedTeams && savedTeams.teams.length > 0 && (
          <Box sx={{ mt: 3 }}>
            <Divider sx={{ mb: 2 }} />
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              Previously Used Teams
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {savedTeams.teams.map(config => (
                <SavedTeamRow key={config.ssid} config={config} onClick={() => handleSavedTeamClick(config)} />
              ))}
            </Box>
          </Box>
        )}

        {/* Quick links */}
        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center', gap: 3 }}>
          <Link href="/scores" underline="hover" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ScoreboardIcon fontSize="small" />
            Scoreboard
          </Link>
          <Link href="/admin" underline="hover" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SettingsIcon fontSize="small" />
            Admin
          </Link>
        </Box>
      </CardContent>
    </Card>
  );
}

function SavedTeamRow({ config, onClick }: { config: SavedTeamConfig; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 2,
        py: 1,
        borderRadius: 1,
        cursor: 'pointer',
        '&:hover': { backgroundColor: 'action.hover' },
        transition: 'background-color 0.15s',
      }}
    >
      <Box>
        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
          {config.ssid}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Last used {formatAge(config.lastUsedAt)}
        </Typography>
      </Box>
      <Tooltip title="Remove saved team">
        <IconButton
          size="small"
          onClick={e => {
            e.stopPropagation();
            sendRemoveSavedTeam(config.ssid);
          }}
          sx={{
            opacity: 0,
            '.MuiBox-root:hover > &': { opacity: 1 },
            color: 'text.secondary',
            '&:hover': { color: 'error.main' },
          }}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
