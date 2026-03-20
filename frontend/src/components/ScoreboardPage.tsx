import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { useScoreState, sendCastReceiverRegister } from '../hooks/useBackend';
import type { ScoreBatch } from '../../../src/types';

// Cast initialization happens in scores.html before this module loads.
declare global {
  interface Window {
    __castReady?: boolean;
    __castSendSwap?: (swap: boolean) => void;
    __isCastReceiver?: boolean;
  }
}

function getInitialSwap(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('swap');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-swap') === '1';
}

export function ScoreboardPage() {
  const score = useScoreState();
  const [, setTick] = useState(0);
  const [swapped, setSwapped] = useState(getInitialSwap);

  const toggleSwap = () => {
    setSwapped(s => {
      const next = !s;
      localStorage.setItem('scoreboard-swap', next ? '1' : '0');
      window.__castSendSwap?.(next);
      return next;
    });
  };

  const left: 'red' | 'blue' = swapped ? 'blue' : 'red';
  const right: 'red' | 'blue' = swapped ? 'red' : 'blue';

  // Register as a cast receiver if running on Chromecast
  useEffect(() => {
    if (window.__isCastReceiver) {
      // Small delay to ensure WebSocket is connected
      const timer = setTimeout(() => {
        sendCastReceiverRegister(document.title || 'Cast Display', swapped);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render every second for time-ago displays
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Prevent screen from sleeping (TV screensaver)
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const acquire = () =>
      navigator.wakeLock
        ?.request('screen')
        .then(wl => {
          wakeLock = wl;
        })
        .catch(() => {});
    acquire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      wakeLock?.release();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!score) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', bgcolor: '#000' }}>
        <Typography variant="h4" color="text.secondary">
          Connecting...
        </Typography>
      </Box>
    );
  }

  const elements = Object.values(score.elements);
  const hasBreakdown = elements.length > 1;
  const isFreePlay = score.mode === 'freePlay';

  const leftActive = left === 'red' ? score.redBatchActive : score.blueBatchActive;
  const rightActive = right === 'red' ? score.redBatchActive : score.blueBatchActive;

  const leftBatches = score.recentBatches?.[left] ?? [];
  const rightBatches = score.recentBatches?.[right] ?? [];
  const hasRecentBatches = leftBatches.length > 0 || rightBatches.length > 0;

  const leftWindow = score.slidingWindow?.[left];
  const rightWindow = score.slidingWindow?.[right];
  const hasWindow = isFreePlay && ((leftWindow?.total ?? 0) > 0 || (rightWindow?.total ?? 0) > 0);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        bgcolor: '#000',
        color: '#fff',
        userSelect: 'none',
      }}
    >
      {/* Controls — top right (hidden on Chromecast receiver) */}
      {!window.__isCastReceiver && (
        <Box sx={{ position: 'absolute', top: 12, right: 16, display: 'flex', gap: 1, alignItems: 'center' }}>
          <Typography
            onClick={toggleSwap}
            sx={{ cursor: 'pointer', opacity: 0.3, fontSize: '0.7rem', '&:hover': { opacity: 0.7 } }}
          >
            ⇄
          </Typography>
          {window.__castReady && (
            <google-cast-launcher style={{ width: 24, height: 24, cursor: 'pointer', opacity: 0.5 }} />
          )}
        </Box>
      )}

      {/* Main score display */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <AllianceScoreBox alliance={left} total={score[left].total} active={isFreePlay ? leftActive : true} />
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <Typography
            variant="h6"
            sx={{ color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: 4, textAlign: 'center' }}
          >
            {score.mode === 'match' ? (score.matchPhase ?? 'Match') : 'Free Play'}
          </Typography>
          {isFreePlay && hasWindow && (
            <Typography sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '0.85rem', fontFamily: 'monospace' }}>
              {leftWindow?.total ?? 0} / {rightWindow?.total ?? 0} in last {score.windowSeconds}s
            </Typography>
          )}
          {!hasWindow && (
            <Typography sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '1.5rem', fontFamily: 'monospace' }}>
              —
            </Typography>
          )}
        </Box>
        <AllianceScoreBox alliance={right} total={score[right].total} active={isFreePlay ? rightActive : true} />
      </Box>

      {/* Element breakdown bar */}
      {hasBreakdown && (
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 4, pb: 3, px: 4 }}>
          {elements.map(el => {
            const leftEl = score[left].elements[el.id];
            const rightEl = score[right].elements[el.id];
            if (!leftEl && !rightEl) return null;
            const leftColor = left === 'red' ? '#ef5350' : '#42a5f5';
            const rightColor = right === 'red' ? '#ef5350' : '#42a5f5';
            return (
              <Box key={el.id} sx={{ textAlign: 'center' }}>
                <Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', mb: 0.5 }}>{el.name}</Typography>
                <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                  <Typography sx={{ color: leftColor, fontFamily: 'monospace', fontSize: '1.3rem', fontWeight: 700 }}>
                    {leftEl?.count ?? 0}
                  </Typography>
                  <Typography sx={{ color: rightColor, fontFamily: 'monospace', fontSize: '1.3rem', fontWeight: 700 }}>
                    {rightEl?.count ?? 0}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Recent batches (free play) */}
      {isFreePlay && hasRecentBatches && (
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 6, pb: 2 }}>
          <BatchList batches={leftBatches} color={left === 'red' ? '#ef5350' : '#42a5f5'} />
          <BatchList batches={rightBatches} color={right === 'red' ? '#ef5350' : '#42a5f5'} />
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
                <Typography
                  sx={{ color: left === 'red' ? '#ef5350' : '#42a5f5', fontFamily: 'monospace', fontSize: '1rem' }}
                >
                  {scores[left].total}
                </Typography>
                <Typography
                  sx={{ color: right === 'red' ? '#ef5350' : '#42a5f5', fontFamily: 'monospace', fontSize: '1rem' }}
                >
                  {scores[right].total}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function AllianceScoreBox({ alliance, total, active }: { alliance: 'red' | 'blue'; total: number; active?: boolean }) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  const bgColor = alliance === 'red' ? 'rgba(239,83,80,0.08)' : 'rgba(66,165,245,0.08)';
  const desaturated = active === false;

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
        opacity: desaturated ? 0.3 : 1,
        filter: desaturated ? 'saturate(0.3)' : 'none',
        transition: 'opacity 2s ease, filter 2s ease',
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

function formatTimeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function BatchList({ batches, color }: { batches: ScoreBatch[]; color: string }) {
  if (batches.length === 0) return null;
  return (
    <Box>
      <Typography
        sx={{
          color: 'rgba(255,255,255,0.3)',
          fontSize: '0.7rem',
          textTransform: 'uppercase',
          mb: 0.5,
          textAlign: 'center',
        }}
      >
        Previous
      </Typography>
      {batches.map((b, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 1.5, justifyContent: 'center', opacity: 1 - i * 0.15 }}>
          <Typography sx={{ color, fontFamily: 'monospace', fontSize: '0.9rem', fontWeight: 700 }}>
            {b.total}
          </Typography>
          <Typography sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.9rem' }}>
            {formatTimeAgo(b.endedAt)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
