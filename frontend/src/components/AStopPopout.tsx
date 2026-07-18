import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { MatchPhase, StationName } from '../../../src/types';
import { sendStationSelfAStop } from '../hooks/useBackend';

/**
 * Pop-out A-Stop window: a separate browser window holding one giant A-Stop
 * button, so the driver always has it on screen during the countdown and
 * autonomous period. Self-closes when auto ends.
 *
 * The window is opened automatically when the countdown starts. Browsers only
 * allow that if the site has pop-up permission (it's a non-gesture open) —
 * when blocked, an inline "Pop Out A-Stop" button is shown instead, which
 * always works because it's a direct user gesture.
 *
 * The window content is plain DOM built by hand (not a React portal): MUI's
 * styles live in the opener's document, and React event delegation does not
 * cross into another window's document.
 */
export function AStopPopout({ station, phase, aStop }: { station: StationName; phase: MatchPhase; aStop: boolean }) {
  const winRef = useRef<Window | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);

  // Keep the window alive through a pause (an A-Stop during a pause taken in
  // auto is still honored); close it for every phase past auto.
  const keepOpen = phase === 'countdown' || phase === 'auto' || phase === 'paused';

  const openPopup = useCallback(() => {
    const existing = winRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const w = window.open('', 'pfms-astop', 'popup=yes,width=480,height=340');
    if (!w) {
      setBlocked(true);
      return;
    }
    const doc = w.document;
    doc.title = 'A-Stop';
    doc.body.innerHTML = ''; // a reused named window may hold stale content
    doc.body.style.cssText = 'margin:0;background:#111;font-family:system-ui,sans-serif;';
    const btn = doc.createElement('button');
    btn.textContent = 'A-STOP';
    btn.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;border:none;cursor:pointer;' +
      'background:#ffb300;color:#000;font-size:18vmin;font-weight:900;font-family:inherit;letter-spacing:0.05em;';
    btn.addEventListener('click', () => sendStationSelfAStop(station));
    doc.body.appendChild(btn);
    winRef.current = w;
    btnRef.current = btn;
    setBlocked(false);
    setIsOpen(true);
  }, [station]);

  // Auto-open at countdown (needs pop-up permission; blocked → inline button)
  useEffect(() => {
    if (phase === 'countdown') openPopup();
  }, [phase, openPopup]);

  // Self-close when auto is over
  useEffect(() => {
    if (!keepOpen && winRef.current && !winRef.current.closed) {
      winRef.current.close();
      winRef.current = null;
      btnRef.current = null;
      setIsOpen(false);
    }
  }, [keepOpen]);

  // Reflect the latched state into the window
  useEffect(() => {
    const btn = btnRef.current;
    if (!btn || (winRef.current?.closed ?? true)) return;
    if (aStop) {
      btn.textContent = 'A-STOPPED — until teleop';
      btn.disabled = true;
      btn.style.background = '#555';
      btn.style.color = '#ffb300';
      btn.style.fontSize = '8vmin';
      btn.style.cursor = 'default';
    } else {
      btn.textContent = 'A-STOP';
      btn.disabled = false;
      btn.style.background = '#ffb300';
      btn.style.color = '#000';
      btn.style.fontSize = '18vmin';
      btn.style.cursor = 'pointer';
    }
  }, [aStop, isOpen]);

  // Notice manual closes; close on unmount
  useEffect(() => {
    const iv = setInterval(() => {
      if (winRef.current?.closed) {
        winRef.current = null;
        btnRef.current = null;
        setIsOpen(false);
      }
    }, 1000);
    return () => {
      clearInterval(iv);
      if (winRef.current && !winRef.current.closed) winRef.current.close();
    };
  }, []);

  if (!keepOpen || isOpen) return null;

  return (
    <>
      <Button variant="outlined" color="warning" size="small" onClick={openPopup}>
        Pop Out A-Stop
      </Button>
      {blocked && (
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          <Box component="span" fontWeight={700}>
            Pop-up blocked.
          </Box>{' '}
          Allow pop-ups for this site and the A-Stop window will open by itself when the match starts.
        </Typography>
      )}
    </>
  );
}
