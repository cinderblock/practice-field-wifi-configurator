# Per-Display Audio Mute from Admin Console

## Goal

Let the admin console disable match audio on specific score displays (cast
receiver TVs), mirroring the existing per-display red/blue swap control. Local
mute chip on the scoreboard itself too (covers non-cast browser tabs, which
don't register with the server and can't be targeted remotely — same
limitation the swap has).

## Status

Implemented, verified (typecheck + live UI drive against vite dev with a stub
ws backend: chip toggles, persists across reload, unmute restores). Committed
as `db43f6f` on local master, not yet deployed. User is fine with the commit
riding along in any thread's push; deploy timing is the user's call — no hold.

To deploy: `git push origin master` (if not already pushed), then
`ssh steamboat "cd practice-field-management-system && ./update.sh"`.

## Decisions already made (don't re-ask)

- Model everything on the swap pattern exactly (user: "similar to the swap").
- Remote mute applies via localStorage + reload, same as remote swap.
- Voice/countdown work from earlier today is separate and already deployed.

## How the swap pattern works (reference)

- Scoreboard on a Chromecast (`window.__isCastReceiver`) sends
  `castReceiverRegister {name, swapped}` on ws (re)connect (ScoreboardPage).
- Server keeps `castReceivers: Map<ws, {id, name, swapped}>` and broadcasts
  `castReceiverList` (websocketServer.ts; register handled in TWO places —
  early scores-socket handler ~line 404 and main handler ~line 715).
- Admin chip click sends `castReceiverSwap {receiverId, swapped}`; server
  updates its record, forwards the message to that receiver's ws, re-broadcasts
  the list.
- Receiver applies it in useBackend `handleCastReceiverSwap`: set
  `scoreboard-swap` in localStorage and reload.
- Cast sender page also pushes state via cast channel (`scores.html`,
  `__castSendSwap`, namespace urn:x-cast:com.tomsawyerlabs.pfms).

## Changes (all mirroring swap)

- `src/types.ts` — `muted` on CastReceiverRegister + CastReceiverList entries;
  new `CastReceiverMute {receiverId, muted}` + guard.
- `src/websocketServer.ts` — map entry gains `muted`; both register sites store
  `!!data.muted`; `castReceiverMute` handler forwards + rebroadcasts.
- `frontend/src/hooks/useBackend.ts` — `handleCastReceiverMute` (localStorage
  `scoreboard-muted` + reload on receiver), router dispatch,
  `sendCastReceiverMute`, register signature gains `muted`.
- `frontend/src/hooks/useMatchAudio.ts` — export `stopAllSounds()`.
- `frontend/src/components/ScoreboardPage.tsx` — `muted` state (URL `?muted=1`
  or localStorage), 🔇 control chip, registers muted state, mounts
  `<MatchAudioBridge />` only when un-muted (moved here from roots/scores.tsx),
  `stopAllSounds()` on mute.
- `frontend/scores.html` — cast channel carries `mute` alongside `swap`
  (`__castSendMute`, session-start push, receiver listener).
- `frontend/src/components/AdminPage.tsx` — per-display 🔊/🔇 chip next to the
  swap chip; removed the `title=` attr (user rule: no title tooltips).

## Gotchas / findings

- Non-cast scoreboard tabs never register, so the admin list can only control
  Chromecast displays — pre-existing swap limitation, unchanged.
- The admin "Displays" chip had a `title=` tooltip; user's global rules say
  remove those on touch. State is shown inline in labels instead.
- Server plays field-speaker audio independently (matchAudio.ts) — display
  mute intentionally does not affect the field speaker.

## To-do

- [x] Types, server, useBackend, ScoreboardPage, scores.html, AdminPage
- [x] Typecheck
- [ ] User go-ahead → push + deploy (`ssh steamboat "cd practice-field-management-system && ./update.sh"`)
- [ ] Field-verify: admin chip mutes a casting TV, survives its reconnect
