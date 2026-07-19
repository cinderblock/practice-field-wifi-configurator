# Get-Ready Announcement + Team Countdown Cancel

## Goal

Two /match-adjacent field-UX features, batched for the next deploy:

1. A "📢 Get Ready" button on the /match page (setup phase, next to Start
   Countdown) that plays an attention clip — chime + "Teams, get ready!"
   (`sounds/getready.wav`, user-approved) — on the field speaker and every
   un-muted display.
2. Teams can cancel the 3-2-1 countdown from their control page: a
   "Not Ready — Cancel Countdown" button (in SelfServiceControls) un-readies
   them, which aborts the countdown back to setup. The /match page's existing
   "Abort Countdown" button already covered the operator side (it only renders
   during the countdown phase, i.e. before the match starts).

## Status

Implemented, verified, committed locally. **NOT deployed** — user said "don't
deploy yet." Fine for any thread to push; deploy timing is the user's call.
Pending deploy alongside `db43f6f`-lineage (per-display mute, see
[[scoreboard-display-mute]] plan).

## How it works

- `playGetReady` ws message (ungated, like match controls): server plays
  `getready` on the field speaker and re-broadcasts to all clients.
  `playGetReady` was added to `PUBLIC_SAFE_TYPES` so scoreboards on the
  public socket receive it. Browsers play it via a subscription inside
  `useMatchAudio` — mounted only when un-muted, so display mute is honored.
- Un-ready-during-countdown lives in `MatchEngine.setReady`: countdown +
  `ready === false` + joined → `abortCountdown()` + mark that station
  un-ready. Ready-up during countdown remains rejected.

## Verified

- Engine harness: un-ready during countdown → phase `created`, backing-out
  team un-ready, other teams still ready, countdown announcer killed; ready
  re-arm + restart works; ready-up during countdown rejected.
- Typecheck both projects.
- Not exercised end-to-end in a browser (needs deploy or full dev stack);
  message plumbing mirrors existing patterns line-for-line.

## Gotchas

- getready.wav loudness: peak −3 dB, chime at −8 dB relative. If it's too
  quiet over the field speaker, regenerate with more gain (ffmpeg compose in
  temp `pfms-countdown/`, see git history of this file's era).
