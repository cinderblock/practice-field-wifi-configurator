# Setup Wizard & Standalone Deployment

## Goal

Let a new group go from "downloaded a thing" to "field works" without
reading docs or editing files by hand. A guided, live-checking setup UI
that gates each step on the previous one actually working.

User's framing (2026-07-27):

> Some will want a binary/zip with entry point, that can just be run. It
> should basically start a quick simple UI for walking through the network
> setup/decisions and checks… the initial dynamic /admin page that walks
> through all the config, initial network/vlan setup (local host and
> network), vh-113 (or alternate radio) setup, and visually shows nice
> onboarding checks live etc. Like, as soon as the main radio vlan is
> configured, try connecting to the VH-113, getting firmware numbers,
> existing configs, etc. But before that, offer options for configuring
> the local vlans… and before that, for instance, are we running as root,
> or on an OS with a networking layer we support…

## Design

### Shape: a progressive gate, not a form

Steps unlock in order; each shows **live** status and refuses to advance
until its checks pass (with an explicit "skip anyway" escape hatch, since
fields are weird).

| #   | Step          | Gate on                                                      | Actions offered                                      |
| --- | ------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| 0   | Host          | OS is Linux, running as root, required tools present         | Show exact `apt install` line; re-check button       |
| 1   | Interfaces    | A NIC exists that can carry a VLAN trunk                     | Pick the trunk NIC; name, link state, current IPs    |
| 2   | Field control | `10.0.100.5/24` present on the bare NIC; native-VLAN warning | Add the address; edit the subnet                     |
| 3   | Radio         | `GET <RADIO_URL>/status` answers                             | Edit radio URL; show firmware, mode, existing config |
| 4   | Team VLANs    | VLAN sub-interfaces + bridges create cleanly                 | Create them; show per-slot state                     |
| 5   | Site routing  | Static route advice; internet reachability from a team VLAN  | Show the exact route the site router needs           |
| 6   | Finish        | Admin passphrase set                                         | Set passphrase; write env file; hand off to `/`      |

Each step's check result is the same shape, so the UI is one component
repeated: `{ id, label, status: 'pass'|'fail'|'warn'|'checking'|'skipped',
detail, fix? }`.

### Live, not request/response

The probe runs server-side on an interval while any client is watching
`/setup`, and broadcasts. That gives the "as soon as the VLAN is
configured, it starts finding the radio" feel for free, and it's the same
mechanism that fixes the long-standing "startup failures are invisible"
problem (`appLogger`'s broadcast isn't wired until after startup checks
run, so nothing they log ever reaches a client).

### Two things this replaces

- The tribal knowledge currently living only in `.claude/skills/` (the
  real systemd unit, Caddyfile, env seed).
- `docs/getting-started.md` steps 4–8, which stay as the manual fallback.

### Standalone binary

`bun build --compile` produces a single executable with the frontend
assets embedded. Target: download one file, `sudo ./pfms`, browser opens
on `:9005` at `/setup`.

Open problems to solve when we get there:

- Static assets: currently served by an external web server. The binary
  needs to serve `frontend/dist` itself (there's already a static-file
  path for `/sounds`, so extend that rather than requiring Caddy).
- `sounds/` must be embedded too, or match audio breaks in the binary.
- `dist/` vs `bun build --compile` — the service runs `/usr/bin/node dist`
  today; the binary path is a second, parallel packaging, not a
  replacement.
- Self-update: `update.sh` assumes a git checkout. A binary needs a
  different update story (download + replace + restart).

## Added requirements (user, 2026-07-27)

- The wizard must let you **test audio/sounds**, not just detect a player.
- It should keep going past "the field works" into a **walkthrough of the
  related features** — notably casting the scoreboard to a networked TV,
  with an optional video stream.
- **The web UI must set settings permanently.** Today almost everything is
  env-only, which means editing a root-owned file and restarting.
- **A `--clear-config` CLI option** that wipes existing config and exits,
  after checking the backend isn't running.
- **Setup must be resumable.** Start it, answer a couple of questions,
  realise the hardware needs changing, kill it, come back — and either get
  your previous answers as defaults or land straight on the next step.

### Resulting design

**Persistence + precedence.** `setup-config.json` (path overridable via
`SETUP_CONFIG_FILE`) holds per-step progress and the settings the wizard
manages. A value set in the UI **wins over its environment variable**;
env remains the seed for a fresh install and still owns everything the
wizard doesn't manage. So an existing deployment behaves identically until
someone actually uses the wizard, and `resolveSetting()` reports which
source won so the UI can show "set here" vs "from /etc/pfms/environment".

**Resumability.** Each step records `pending | done | skipped`
independently; `nextStep()` returns the first that isn't finished. Skipping
counts as finished (fields are odd — a stuck wizard is worse than a
warning), and re-opening any step re-opens the wizard as a whole.

**Human-confirmed checks.** Some things no probe can prove: that the field
speaker was audible, that casting actually worked on the TV. These are
stored as explicit operator confirmations (`audioVerified`, `castVerified`)
and surface as warnings until someone confirms them.

**Secure-origin check belongs in the browser.** Google Cast needs a secure
origin, which the server can't determine reliably. The wizard checks
`window.isSecureContext` client-side; the probe covers the server-side half
(video proxy reachability).

## Further requirements (user, 2026-07-27, second pass)

- The wizard should offer **Docker or systemd** as deployment paths, and
  walk through whichever is chosen.
- **Error early on Windows** until a Windows networking layer exists.

### Resulting design

**Platform guard.** `src/platformGuard.ts` is imported _first_ by
`index.ts` — before `networkManager` builds a platform backend at module
load — and exits 78 with an actionable message on a non-Linux host. It
deliberately does not fire for `DRY_RUN` (development on any OS keeps
working) or for CLI commands like `--clear-config`, which never touch the
network. Before this, Windows produced a raw
`node-ip: platform "win32" is not supported` stack trace from deep inside
an import, with no hint that DRY_RUN existed.

**Deployment step** (last in the order — you make it permanent once it
works). Detects whether it's running in a container (`/.dockerenv`,
`$container`, `/proc/1/cgroup`) and whether systemd is present, then
checks the chosen mode is actually set up: unit installed _and enabled_
for systemd, container running for Docker. A container cannot read its own
restart policy, so that's surfaced as a reminder with the
`docker inspect` command rather than a guess.

**Both modes need host networking and NET_ADMIN**, since pFMS configures
the host's VLANs, bridges, iptables and routes. There is no useful
isolated-network deployment, and the docs say so plainly rather than
letting someone discover it with robots on the field.

## Decisions

1. **New `/setup` page, not a rewrite of `/admin`.** `/admin` is 54 KB of
   operational controls for a _running_ field; setup is a different job
   with a different audience. `/setup` can redirect to `/` once complete.
2. **Read-only probing first, mutations second.** The probe module only
   observes. Anything that changes the host (adding an IP, creating VLANs,
   writing the env file) is an explicit, separately-authorized action with
   a visible preview of the exact command. This keeps the risky half
   reviewable and lets the read-only half ship immediately.
3. **No auth gate on `/setup` while unconfigured**, matching the existing
   admin-passphrase TOFU. Once a passphrase exists, `/setup` requires it.
4. **The probe is useful beyond setup** — the same broadcast backs the
   "System Status" panel from `plans/multi-site-adoption.md` Stage 1.

## Increments

- **A. Probe backend** — ✅ `src/setupProbe.ts` + `scripts/probe-setup.ts`.
  Structured read-only checks for all five steps, each failure carrying its
  fix command. Verified by running it on this Windows dev box: correctly
  reports the unsupported OS and missing tools, degrades the network steps
  to warnings instead of crashing, and still reached the live radio over
  HTTP (PRACTICE 1.2.9, no stations configured).
  - Bug found by running it: `createBackend()` throws outside Linux, so the
    probe crashed on exactly the case its first step exists to report. Now
    only constructs a backend when it can use one.
  - **Not yet wired to the WebSocket** — no broadcast, no interval. That's
    the first task of increment B.
- **A2. Persistence, resumability, CLI** — ✅ `src/setupConfigStore.ts`,
  `src/cli.ts`, `scripts/test-setup-config.ts`. Probe extended with the
  `audio` and `scoreboard` steps. Verified: resume lands on the next
  unfinished step with earlier answers intact, stored settings beat env,
  skipping doesn't block completion, re-opening a step re-opens the wizard,
  and `--clear-config` refuses (exit 1, file untouched) while a backend
  answers `/health`, then clears cleanly (exit 0) once it's stopped.
  - **Gotcha found while verifying:** `networkManager.ts:10` builds a
    platform network backend at _module load_, so importing the app throws
    outright on a non-Linux host — which meant `node dist --clear-config`
    couldn't run on a dev machine. `src/cli.ts` is therefore directly
    runnable (`node dist/cli.js --clear-config`) and imports almost
    nothing. Making that backend lazy is a worthwhile follow-up: it would
    also make the app importable for testing off-Linux.
- **A3. Platform guard + deployment step** — ✅ `src/platformGuard.ts`,
  `probeDeployment()`, `Dockerfile`, `docker-compose.yml`,
  `.dockerignore`, `docs/deployment.md`. Verified: Windows now exits 78
  with a readable message instead of an import stack trace, and
  `DRY_RUN=1` still boots and serves `/health` on Windows.
  - **Docker is unverified** — no Docker on the authoring machine, so the
    image has never been built. Static review caught one real bug that
    would have broken it (`COPY . .` copying the host's Windows-built
    `node_modules` over the installed one — fixed with `.dockerignore`).
    The first real `docker compose up` should be treated as debugging.
  - Still worth doing: make `networkManager`'s backend lazy so the app is
    importable off-Linux for tests.
- **B. `/setup` page** — renders A's output as live step cards, with the
  per-step actions: pick a NIC, play a test sound, confirm the cast worked,
  choose systemd vs Docker. Still needs the WS broadcast wiring from A.
- **C. Mutations** — apply-from-UI for field-control IP, VLAN creation,
  radio config, env file write.
- **D. Standalone binary** — embed assets, serve statics, `bun build
--compile`, update story.

## Things not to do

- Don't let the wizard silently run privileged commands. Show the command,
  then run it on an explicit click.
- Don't gate hard on checks that are advisory — fields have odd topologies
  and a stuck wizard is worse than a warning.
- Don't duplicate `startupChecks.ts` logic; the probe should share it.
