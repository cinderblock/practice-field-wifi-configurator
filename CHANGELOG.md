# Changelog

## 1.0.0 — first public release

pFMS was built for one practice field and has been running matches there
for a while. This release is the work of making it something another FRC
team can actually stand up: a guided setup system, packaging that doesn't
assume our infrastructure, and documentation written for someone who has
never seen it.

If you are setting up a field, start with
**[docs/getting-started.md](docs/getting-started.md)** or just run pFMS
and open `/setup`.

### New: guided setup

**A `/setup` screen that checks the host as you go.** Eight steps — host,
trunk NIC, field control, radio, team VLANs, match audio, scoreboard,
deployment — each showing live status, the exact command to fix anything
broken, and that step's controls. Checks re-run every few seconds, so a
step turns green the moment you fix it.

- **Your answers are saved.** Stop partway through, discover the switch is
  wired wrong, come back tomorrow — it resumes at the next unfinished step
  with your earlier answers filled in. Skipping a step counts as finishing
  it; a stuck wizard is worse than a warning.
- **Settings persist from the UI.** The trunk interface, radio URL and
  video stream server can be set in the browser instead of editing a
  root-owned file. A saved value wins over the matching environment
  variable, which stays the seed for a fresh install. The trunk interface
  and radio URL are read at startup, so the screen tells you when a
  restart is needed rather than pretending.
- **It tests things you can't check from code.** Play a test sound and
  confirm you heard it; confirm casting actually appeared on the TV. Those
  stay warnings until a human says otherwise, because a passing check that
  proves nothing is worse than no check.
- **It reports rather than duplicates.** pFMS already assigns the
  field-control address at startup and creates every VLAN sub-interface
  and bridge itself. Setup tells you what it's working with; it doesn't
  run a second copy of that logic.
- **`--clear-config`** starts setup over: `node dist/cli.js --clear-config`.
  It refuses while anything is answering `/health`, so it can't pull
  configuration out from under a running field. `--all` also clears admin,
  API key and Slack config.

### New: running it anywhere

- **pFMS serves its own web interface.** Browsing to the backend port is
  now a complete field — no Caddy or nginx required. Add a reverse proxy
  when you want HTTPS (casting needs it) or a friendly hostname. This
  removes the most common way an install used to half-work: a proxy
  pointed at a stale directory, or missing `sounds/` so browsers were
  silent while the field speaker worked fine.
- **Standalone binary.** `bun run package` produces a directory with one
  executable plus `web/` and `sounds/`. Zip it, copy it to the field host,
  unzip, run — no node, no bun, no install. The system packages are still
  needed; setup tells you which are missing.
- **Docker.** A `Dockerfile` and `docker-compose.yml` ship in the repo.
  See [docs/deployment.md](docs/deployment.md) for the systemd-vs-Docker
  trade-offs. **The image has not been built or run yet** — treat your
  first `docker compose up` as a debugging session.
- **Clear failure on unsupported platforms.** Starting on Windows or macOS
  now exits with an explanation instead of a stack trace from deep inside
  an import. `DRY_RUN=1` still runs the whole app anywhere for development.

### Changed — behaviour you should know about

- **Resuming a paused match now counts down 3‑2‑1 before robots move.**
  Robots stay disabled for the full three seconds, the field keeps
  actively streaming that disable, and the "live" tone lands exactly when
  they re-enable. Pressing Pause again during the countdown cancels it.
  Previously robots re-enabled the instant Resume was clicked, with no
  warning to drive teams.
- **Pausing a match makes a sound.** It was silent before — the sound was
  declared but never shipped. `pause.wav` and `resume321.wav` are
  synthesized tones; regenerate or replace them with
  `bun scripts/generate-sounds.ts`.
- **Setup closes once you claim the field.** `/setup` is writable by
  anyone while no admin passphrase exists — that's how a fresh install
  gets configured. Once a passphrase is set, changing setup settings
  requires admin.
- **`update.sh` reads `WEBSOCKET_PORT`** from the service environment file
  instead of assuming a port. Previously, on a field using a different
  port, the match-in-progress guard silently never engaged and a deploy
  could reload straight through a live match.

### Fixed

- The setup screen could be used by anyone on the network to point the
  radio manager at another host. Station configurations contain every
  team's plaintext WPA key, so that was credential exfiltration. Settings
  are now validated per key, URLs must be private or loopback literals
  (hostnames are refused — DNS can be repointed after a check), and writes
  close once the field is claimed.
- A video stream server set in the setup screen was written to disk and
  showed a passing check, but the proxy only ever read the environment
  variable — so playback failed while everything on screen said otherwise.
- The documented package list was missing `dnsmasq-base`, `conntrack` and
  `tcpdump`, all of which are required whenever `VLAN_INTERFACE` is set.
  A fresh install following the docs exited with code 78.
- `.env` was documented as working in production. It never did — the
  systemd unit runs `node`, which doesn't read it — so team avatars were
  silently disabled on real deployments.

### Security notes for anyone adopting this

pFMS assumes **everyone who can reach it on the network is trusted**. It
is built for a field LAN, not the public internet. Three specifics:

- **Claim the field before guests arrive.** The admin passphrase is
  trust-on-first-use; the first person to reach `/admin` sets it, and
  doing so also mints an external-access token.
- **The scoring API is open until you create a key**, so a new sensor
  works with no setup. Create a key in `/admin`, or set
  `SCORING_REQUIRE_KEY=true` to refuse unauthenticated writes outright —
  including before any key exists. The setup screen reports which mode
  you're in.
- Full detail in
  [docs/support.md](docs/support.md#security-model--read-this-before-opening-a-field).

### Notes for adopters

- **Casting needs your own Cast receiver.** Google registers a receiver
  app against one specific HTTPS URL, so the built-in ID serves _this_
  project's scoreboard and won't work for you. Register your own and set
  `CAST_RECEIVER_APP_ID` — or skip it entirely and open the scoreboard URL
  directly on the TV, which the setup screen shows you and which needs no
  registration or HTTPS.
- **Report bugs from the app.** The setup screen has a "Report a pFMS bug"
  link that opens a GitHub issue prefilled with version, platform and
  every failing setup check.
- **Season-coupled values** live in `src/teamChecker.ts` (expected radio
  firmware and image year) and `src/shiftState.ts` (the 2026 REBUILT
  four-shift structure). The shift model is encoded in types, not
  configuration — a different game means code changes.
- **Only the Windows binary has been run.** Linux targets cross-compile
  the same way but have not been exercised on a field host.
