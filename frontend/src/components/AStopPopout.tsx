import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { MatchPhase, StationName } from '../../../src/types';
import { sendStationSelfAStop } from '../hooks/useBackend';

/**
 * The match pop-out window. One named browser window with two lives:
 *
 * 1. **Match guide** — opened by the Join button click (a user gesture, so it
 *    is never pop-up-blocked). Explains that the robot is now field-controlled
 *    and what happens when the match starts.
 * 2. **A-Stop** — at the countdown the same window is rewritten into one giant
 *    A-Stop button for the autonomous period. Reusing the already-open named
 *    window needs no pop-up permission; opening it fresh at countdown does.
 *
 * It closes itself when auto ends (surviving a pause taken during auto), when
 * the station leaves the match, and when the page goes away.
 *
 * The window content is plain DOM built by hand (not a React portal): MUI's
 * styles live in the opener's document, and React event delegation does not
 * cross into another window's document.
 *
 * Module-level state so the window survives React re-renders and can be opened
 * from the Join button's own click handler.
 */
type PopupMode = 'explainer' | 'astop';

let popupWin: Window | null = null;
let popupMode: PopupMode | null = null;
let astopBtn: HTMLButtonElement | null = null;
let popupOpenedAt = 0;

function popupIsOpen(): boolean {
  return !!popupWin && !popupWin.closed;
}

function ensureWindow(): Window | null {
  if (popupWin && !popupWin.closed) return popupWin;
  const w = window.open('', 'pfms-astop', 'popup=yes,width=540,height=480');
  if (!w) return null;
  popupWin = w;
  popupMode = null;
  astopBtn = null;
  popupOpenedAt = Date.now();
  return w;
}

function closePopup() {
  if (popupWin && !popupWin.closed) popupWin.close();
  popupWin = null;
  popupMode = null;
  astopBtn = null;
}

function baseDoc(w: Window, title: string) {
  const doc = w.document;
  doc.title = title;
  doc.body.innerHTML = ''; // a reused named window may hold stale content
  doc.body.style.cssText = 'margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif;';
  return doc;
}

/** Static markup only — no user data goes through innerHTML. */
function renderExplainer(w: Window) {
  if (popupMode === 'explainer') return;
  const doc = baseDoc(w, 'Match Guide');
  const div = doc.createElement('div');
  div.style.cssText = 'padding:20px 24px;font-size:15px;line-height:1.55;max-width:640px;';
  div.innerHTML =
    '<h2 style="margin:0 0 12px;color:#ffb300;">You&rsquo;re in the match!</h2>' +
    '<ul style="margin:0;padding-left:20px;">' +
    '<li style="margin-bottom:10px;"><b>Your robot is now controlled by the field</b> and stays ' +
    '<b>disabled</b> until the match starts. Want to keep driving instead? Leave the match on your ' +
    'station page.</li>' +
    '<li style="margin-bottom:10px;">Once everyone is <b>Ready</b>, the match can start: a ' +
    '<b>3&#8209;second countdown</b>, then <b>autonomous</b> &mdash; your robot enables and runs its ' +
    'auto on its own.</li>' +
    '<li style="margin-bottom:10px;">At the countdown, <b>this window turns into a giant A&#8209;STOP ' +
    'button</b>. Press it if your robot misbehaves during auto &mdash; it stops the robot for the rest ' +
    'of auto and re&#8209;enables it automatically for teleop. (E&#8209;Stop stays on the station ' +
    'page.)</li>' +
    '<li style="margin-bottom:10px;">After auto: a short pause, then <b>teleop</b> &mdash; drive!</li>' +
    '</ul>' +
    '<p style="color:#999;margin:14px 0 0;">Keep this window open &mdash; it closes itself when auto ends.</p>';
  doc.body.appendChild(div);
  popupMode = 'explainer';
  astopBtn = null;
}

function renderAStop(w: Window, station: StationName) {
  if (popupMode === 'astop' && astopBtn) return;
  const doc = baseDoc(w, 'A-Stop');
  const btn = doc.createElement('button');
  btn.textContent = 'A-STOP';
  btn.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;border:none;cursor:pointer;' +
    'background:#ffb300;color:#000;font-size:18vmin;font-weight:900;font-family:inherit;letter-spacing:0.05em;';
  btn.addEventListener('click', () => sendStationSelfAStop(station));
  doc.body.appendChild(btn);
  popupMode = 'astop';
  astopBtn = btn;
}

function updateAStopLatched(aStop: boolean) {
  const btn = astopBtn;
  if (!btn || !popupIsOpen()) return;
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
}

/** Call from the Join button's own onClick — the click gesture guarantees the
 *  window opens even without pop-up permission. */
export function openMatchGuidePopup() {
  const w = ensureWindow();
  if (w) renderExplainer(w);
}

export function AStopPopout({
  station,
  phase,
  aStop,
  joined,
}: {
  station: StationName;
  phase: MatchPhase;
  aStop: boolean;
  joined: boolean;
}) {
  const [isOpen, setIsOpen] = useState(popupIsOpen);
  const [blocked, setBlocked] = useState(false);

  // Keep the A-Stop through a pause (an A-Stop during a pause taken in auto is
  // still honored); close for every phase past auto.
  const desired: 'closed' | PopupMode = !joined
    ? 'closed'
    : phase === 'created'
      ? 'explainer'
      : phase === 'countdown' || phase === 'auto' || phase === 'paused'
        ? 'astop'
        : 'closed';

  // Drive the window's lifecycle and content from match state
  useEffect(() => {
    if (desired === 'closed') {
      closePopup();
      setIsOpen(false);
      return;
    }
    let w = popupIsOpen() ? popupWin : null;
    if (!w && desired === 'astop' && phase === 'countdown') {
      // Auto-open at the countdown. Permission-free when the guide window from
      // Join is still open (named-window reuse); a fresh open needs pop-up
      // permission — when blocked, the inline button below still works.
      w = ensureWindow();
      if (!w) setBlocked(true);
    }
    if (!w) {
      setIsOpen(false);
      return;
    }
    if (desired === 'explainer') renderExplainer(w);
    else renderAStop(w, station);
    setIsOpen(true);
    setBlocked(false);
  }, [desired, phase, station]);

  // Reflect the latched state into the A-Stop button
  useEffect(() => {
    if (desired === 'astop') updateAStopLatched(aStop);
  }, [aStop, desired, isOpen]);

  // Notice manual closes; also reap a stray guide window when the join it was
  // opened for never landed (e.g. alliance full) — with a grace period so the
  // window opened by the Join click isn't closed before the join round-trips.
  useEffect(() => {
    const iv = setInterval(() => {
      if (desired === 'closed' && popupIsOpen() && Date.now() - popupOpenedAt > 5_000) closePopup();
      const open = popupIsOpen();
      setIsOpen(prev => (prev === open ? prev : open));
    }, 1000);
    return () => clearInterval(iv);
  }, [desired]);

  // Close on unmount — an orphaned window has nothing driving it
  useEffect(() => closePopup, []);

  if (isOpen || desired === 'closed') return null;

  const reopen = () => {
    const w = ensureWindow();
    if (!w) {
      setBlocked(true);
      return;
    }
    if (desired === 'explainer') renderExplainer(w);
    else {
      renderAStop(w, station);
      updateAStopLatched(aStop);
    }
    setIsOpen(true);
    setBlocked(false);
  };

  return (
    <>
      <Button variant="outlined" color={desired === 'astop' ? 'warning' : 'info'} size="small" onClick={reopen}>
        {desired === 'astop' ? 'Pop Out A-Stop' : 'Match Guide'}
      </Button>
      {blocked && (
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          <Box component="span" fontWeight={700}>
            Pop-up blocked.
          </Box>{' '}
          Keep the match guide window from Join open, or allow pop-ups for this site, and the A-Stop window will appear
          by itself when the match starts.
        </Typography>
      )}
    </>
  );
}
