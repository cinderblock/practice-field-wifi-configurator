# Practice Field Management System

A web interface for configuring practice field access points, running
self-service matches, and enabling team laptop ↔ robot routing.

pFMS drives a VH-113 (or VH-109) field AP running
[`PRACTICE` or `OFFSEASON` firmware](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases),
and provides:

- **Station configuration** — assign teams to the six field stations;
  the AP and host networking (VLANs, routing, NAT) follow automatically
- **Self-service matches** — teams join, ready up, and run official-timing
  matches with field-staff ready checks, hold-to-start, E-Stop/A-Stop, and
  match audio ([details](docs/match-system.md))
- **Scoring** — an HTTP API for goal sensors and referee tablets, a
  TV-ready scoreboard with optional live video, and post-match review
  ([details](docs/scoring.md))
- **Laptop ↔ robot routing** — laptops on the site network reach robots on
  their team VLANs, including duplicate-team disambiguation
  ([details](docs/network.md))
- **Diagnostics & support** — a robot network tester for CSAs
  ([details](docs/robot-tester.md)), live logs, device discovery, robot
  telemetry, and a built-in support widget bridged to Slack
  ([details](docs/support.md))

## Quick Start

Network management requires Linux and root (see
[setup](docs/setup.md) — development works anywhere with
[`DRY_RUN`](docs/internals.md#dry-run-mode)):

```bash
sudo apt install fping iptables iputils-arping   # Linux system deps
bun install
```

Run the development servers in two terminals:

```bash
bun run dev                    # backend (http://localhost:3000)
cd frontend && bun run dev     # frontend (http://localhost:5173, proxies the backend)
```

Useful scripts:

```bash
bun run typecheck   # Type-check both backend and frontend
bun run format      # Format all files with Prettier
bun run build       # Compile backend + build frontend
```

## Pages

| Path                | Description                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/`                 | Home — station configuration form (assign teams to stations)                                                                        |
| `/<team#>[-suffix]` | Team control page — per-team view with self-service match controls                                                                  |
| `/overview`         | Admin station overview — status for all six stations                                                                                |
| `/match`            | Match control — dedicated controller page for match lifecycle and history                                                           |
| `/staff?role=…`     | Field-staff ready-up — a referee / scorekeeper / safety monitor marks ready before a match                                          |
| `/admin`            | Admin page — global/per-station e-stop, match status, force stop, API keys, Slack, external access                                  |
| `/network`          | Network page — discovered devices, VLAN status, network stats                                                                       |
| `/route`            | Route page — choose which robot to talk to when a team has duplicate stations                                                       |
| `/logs`             | Logs page — live backend log stream                                                                                                 |
| `/test`             | Robot tester — plug in a robot, diagnose network config (requires `TEST_INTERFACE`)                                                 |
| `/scores`           | Scoreboard — full-screen TV-optimized score display for casting; 🎥 toggles a per-browser video stream view (wide or square layout) |
| `/usage`            | Usage page — per-station link session history (which teams used the field, when)                                                    |
| `/support`          | _(redirects to `/`)_ — support is a floating widget available on every page                                                         |
| `/api/score/schema` | Scoring API schema — machine-readable API docs for building scoring clients                                                         |

## Documentation

The [`docs/`](docs/README.md) directory has the full documentation:

- [Setup & deployment](docs/setup.md) — install, systemd, update script,
  reverse proxy, external access
- [Configuration reference](docs/configuration.md) — all environment
  variables
- [Match system](docs/match-system.md) — lifecycle, ready check,
  E-Stop/A-Stop, audio, history
- [Scoring](docs/scoring.md) — scoring API and match review
- [Support system](docs/support.md) — issue reports, chat, Slack, admin
  auth
- [Network architecture](docs/network.md) — VLANs, routing, DNAT,
  discovery
- [Robot network tester](docs/robot-tester.md) — the `/test` CSA tool
- [Backend internals](docs/internals.md) — startup, config flow, graceful
  reload, telemetry

Known technical debt lives in [ISSUES.md](ISSUES.md); in-flight task notes
live in [`plans/`](plans/).

## Project Structure

- `src/` — backend (TypeScript, Node.js)
- `frontend/` — React frontend (Vite multi-page app)
- `docs/` — documentation
- `sounds/` — match audio WAV files (charge horn, buzzers, countdowns)
- `scripts/` — development and test harness scripts
- `firmware/` — cached radio firmware binaries
- `dist/`, `frontend/dist/` — build output

## Resources

- [FRCture](https://frcture.readthedocs.io/en/latest/) —
  reverse-engineered documentation of FRC network protocols, including:
  - [DS → RIO protocol](https://frcture.readthedocs.io/en/latest/driverstation/ds_to_rio.html)
  - [RIO → DS protocol](https://frcture.readthedocs.io/en/latest/driverstation/rio_to_ds.html)
