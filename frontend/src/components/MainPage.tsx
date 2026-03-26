import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ScoreboardIcon from '@mui/icons-material/Scoreboard';
import SettingsIcon from '@mui/icons-material/Settings';
import DashboardIcon from '@mui/icons-material/Dashboard';
import { getTeamNumberCookie, setTeamNumberCookie } from '../utils/cookies';

/**
 * Main landing page — team number entry.
 *
 * If a team number cookie exists, redirect immediately to the control page.
 * Otherwise, show the entry dialog.
 */
export function MainPage() {
  const savedTeam = getTeamNumberCookie();

  useEffect(() => {
    if (savedTeam) {
      window.location.href = `/control/${encodeURIComponent(savedTeam)}`;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (savedTeam) {
    return (
      <Container>
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 4 }}>
          Redirecting to team {savedTeam}...
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

function TeamEntryDialog() {
  const [teamNumber, setTeamNumber] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isValid = /^\d{1,6}$/.test(teamNumber);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isValid) return;
    setTeamNumberCookie(teamNumber);
    window.location.href = `/control/${encodeURIComponent(teamNumber)}`;
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

        {/* Quick links */}
        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center', gap: 3 }}>
          <Link href="/scores" underline="hover" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ScoreboardIcon fontSize="small" />
            Scoreboard
          </Link>
          <Link href="/overview" underline="hover" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <DashboardIcon fontSize="small" />
            Overview
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
