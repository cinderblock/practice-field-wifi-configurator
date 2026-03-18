import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import type { ScoreState } from '../../../src/types';
import { useScoreState } from '../hooks/useBackend';

/**
 * Full-screen scoreboard designed for casting to a TV on the LAN.
 * Dark background, large numbers, auto-updating via WebSocket.
 * Access at /scores
 */
export function ScoreboardPage() {
  const score = useScoreState();
  const [, setTick] = useState(0);

  // Re-render every second for sliding window countdown
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!score) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', bgcolor: '#000' }}>
        <Typography variant="h4" color="text.secondary">
          Connecting...
        </Typography>
      </Box>
    );
  }

  const elements = Object.values(score.elements);
  const hasBreakdown = elements.length > 1;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        bgcolor: '#000',
        color: '#fff',
        userSelect: 'none',
      }}
    >
      {/* Main score display */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <AllianceScore alliance="red" total={score.red.total} />
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <Typography
            variant="h6"
            sx={{ color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: 4 }}
          >
            {score.mode === 'match' ? (score.matchPhase ?? 'Match') : 'Free Play'}
          </Typography>
          <Typography sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '1.5rem', fontFamily: 'monospace' }}>
            —
          </Typography>
        </Box>
        <AllianceScore alliance="blue" total={score.blue.total} />
      </Box>

      {/* Element breakdown bar */}
      {hasBreakdown && (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            gap: 4,
            pb: 3,
            px: 4,
          }}
        >
          {elements.map(el => {
            const red = score.red.elements[el.id];
            const blue = score.blue.elements[el.id];
            if (!red && !blue) return null;
            return (
              <Box key={el.id} sx={{ textAlign: 'center' }}>
                <Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', mb: 0.5 }}>{el.name}</Typography>
                <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                  <Typography sx={{ color: '#ef5350', fontFamily: 'monospace', fontSize: '1.3rem', fontWeight: 700 }}>
                    {red?.count ?? 0}
                  </Typography>
                  <Typography sx={{ color: '#42a5f5', fontFamily: 'monospace', fontSize: '1.3rem', fontWeight: 700 }}>
                    {blue?.count ?? 0}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Phase breakdown (match mode) */}
      {score.mode === 'match' && score.phaseBreakdown && Object.keys(score.phaseBreakdown).length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 4, pb: 2 }}>
          {Object.entries(score.phaseBreakdown).map(([phase, scores]) => (
            <Box key={phase} sx={{ textAlign: 'center' }}>
              <Typography sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                {phase}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1.5, justifyContent: 'center' }}>
                <Typography sx={{ color: '#ef5350', fontFamily: 'monospace', fontSize: '1rem' }}>
                  {scores.red.total}
                </Typography>
                <Typography sx={{ color: '#42a5f5', fontFamily: 'monospace', fontSize: '1rem' }}>
                  {scores.blue.total}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function AllianceScore({ alliance, total }: { alliance: 'red' | 'blue'; total: number }) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  const bgColor = alliance === 'red' ? 'rgba(239,83,80,0.08)' : 'rgba(66,165,245,0.08)';

  return (
    <Box
      sx={{
        textAlign: 'center',
        px: 6,
        py: 3,
        borderRadius: 2,
        border: `3px solid ${color}`,
        backgroundColor: bgColor,
        minWidth: 200,
      }}
    >
      <Typography
        sx={{
          fontSize: 'clamp(4rem, 15vw, 12rem)',
          fontWeight: 800,
          fontFamily: 'monospace',
          color,
          lineHeight: 1,
        }}
      >
        {total}
      </Typography>
      <Typography
        sx={{
          color,
          textTransform: 'uppercase',
          letterSpacing: 6,
          fontWeight: 700,
          fontSize: '1.2rem',
          mt: 1,
        }}
      >
        {alliance}
      </Typography>
    </Box>
  );
}
