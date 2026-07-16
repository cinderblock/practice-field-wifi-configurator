# Practice Field Management System

A web interface for configuring practice field access points, running self-service matches, and enabling team laptop ↔ robot routing.

## Setup

Works with [`PRACTICE` or `OFFSEASON` firmware](https://frc-radio.vivid-hosting.net/access-points/fms-ap-firmware-releases) on the VH-113 AP (or VH-109).
`PRACTICE` recommended for simplicity and programmer connectivity.

Currently, only Linux is supported due to dependencies on `iptables` and `iputils-arping` for VLAN and routing management.
The app must be run with root privileges to manage VLAN interfaces and routing rules.
Future versions may support other platforms.

1. Install system dependencies (Linux, for VLAN/routing):

```bash
sudo apt install fping iptables iputils-arping
```

- `fping` provides fast parallel pinging for the subnet scanner (device discovery on team VLANs).
- `iptables` is required for MASQUERADE rules that enable site network ↔ robot routing.
- `iputils-arping` provides `arping` for duplicate address detection (used in OFFSEASON firmware mode only).

> **OFFSEASON firmware only:** also install `dnsmasq-base` for per-VLAN DHCP serving.

2. Install Node.js dependencies:

```bash
npm install
```

## Pages

| Path                | Description                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/`                 | Home — station configuration form (assign teams to stations)                                                |
| `/<team#>[-suffix]` | Team control page — per-team view with self-service match controls                                          |
| `/overview`         | Admin station overview — status for all six stations                                                        |
| `/match`            | Match control — dedicated controller page for match lifecycle                                               |
| `/admin`            | Admin page — global/per-station e-stop, match status, force stop                                            |
| `/network`          | Network page — discovered devices, VLAN status, network stats                                               |
| `/route`            | Route page — choose which robot to talk to when a team has duplicate stations                               |
| `/logs`             | Logs page — live backend log stream                                                                         |
| `/test`             | Robot tester — plug in a robot, diagnose network config (requires `TEST_INTERFACE`)                         |
| `/scores`           | Scoreboard — full-screen TV-optimized score display for casting; 🎥 toggles a per-browser video stream view |
| `/support`          | _(redirects to `/`)_ — support is now a floating widget available on every page                             |
| `/api/score/schema` | Scoring API schema — machine-readable API docs for building scoring clients                                 |

## Features

### Match System

Matches follow the 2026 REBUILT official timing (20 s auto, 5 s pause, 110 s teleop with 30 s endgame) and are managed from the dedicated `/match` controller page:

1. **Create** — the match controller creates a match, allowing teams to join from their station pages.
2. **Join & Ready** — teams choose an alliance (Red/Blue) from their station page and mark themselves ready.
3. **Start** — the match controller starts the match once all joined teams are ready. Phases run automatically: countdown → auto → pause → teleop → endgame → post-match.
4. **Controls** — only the match controller can pause/resume/abandon. Teams can self-service disable, e-stop, or leave mid-match. During countdown and autonomous, teams also get an **A-Stop** that stops their robot for the rest of auto and automatically re-enables it for teleop.
5. **Post-match** — a short counting period runs after the buzzer (balls in flight). The match stays in post-match until the controller clears it, creates a new match, or 2 minutes pass — then it auto-clears back to free play (scoring included). Matches ended by e-stop never auto-clear; a human must clear them.

Stations that have **not** joined receive no FMS packets and operate in free-drive mode.

The auto winner (which alliance's goal goes inactive first during teleop shifts) can be set to scores-based, pre-selected (red/blue), or manually chosen during a pause between auto and teleop.

The match timeline visualises the full match structure with shift colouring: when the auto winner is known, solid red/blue sections show which alliance is active during each 25-second shift. When unknown, diagonal stripes indicate uncertainty.

The admin page provides safety overrides: global e-stop, per-station e-stop/disable, and force stop.

### Match Audio

Sound effects (charge horn, end buzzer, warning, pause/resume tones) play on phase transitions via a detected system audio player. Place `.wav` files in `sounds/`.

### Scoring System

An HTTP API for tracking scores from external goal-watching devices (sensors, cameras, referee tablets, ESP32s, etc.). Scoring detection is the responsibility of the devices — they send events, and the server translates them into points.

**Two modes:**

- **Free play (default):** 30-second sliding window — shows a rolling count of recent scores. Events age out automatically.
- **Match mode:** scores accumulate from zero with per-phase breakdowns. Automatically activates when a match starts.

**Key concepts:**

- **Elements** — configurable scoring types (e.g. "speaker", "amp", "foul") with point values, optional phase restrictions, and deduplication windows
- **Sources** — each device identifies itself; the server tracks health and event counts
- **Deduplication** — when multiple sensors watch the same goal, events within a configurable window merge into one
- **Fouls** — elements with `awardToOpponent: true` give points to the opposing alliance
- **Phase restrictions** — elements can be limited to specific match phases (e.g. auto-only bonuses)

**Quick start for a scoring device:**

```
POST /api/score?key=YOUR_KEY HTTP/1.1
Host: pfms.local:3000
Content-Type: application/json

{"source":"goal-1","alliance":"red","element":"speaker"}
```

Authentication via `X-API-Key` header or `?key=` query parameter. API keys are managed through the admin panel at `/admin`. When no keys have been created, the scoring API is open to all devices on the network. Once a key is created, authentication is required for write endpoints. Unrecognized devices appear as "pending" in the admin panel for one-click approval.

Full API documentation is served at `GET /api/score/schema` as an [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0) spec in JSON. Point any OpenAPI-compatible tool (Swagger UI, Redoc, code generators) at it, or read it directly from tiny devices.

| Endpoint             | Method | Auth     | Description                                 |
| -------------------- | ------ | -------- | ------------------------------------------- |
| `/api/score`         | POST   | Required | Submit score event(s)                       |
| `/api/score`         | GET    | None     | Get current score state                     |
| `/api/score/reset`   | POST   | Required | Reset all scores                            |
| `/api/score/config`  | GET    | None     | Get element configuration                   |
| `/api/score/config`  | PUT    | Required | Replace element configuration               |
| `/api/score/mode`    | PUT    | Required | Set scoring mode and/or sliding window size |
| `/api/score/sources` | GET    | None     | List scoring sources and their status       |
| `/api/score/schema`  | GET    | None     | Machine-readable API schema                 |

Score state is also broadcast in real time to all WebSocket clients as `scoreState` messages.

### Support System

A built-in support system available as a floating widget on every page (click the support agent icon in the status bar):

**Issue Reports** — Teams can submit structured issue reports with:

- Standard template fields: what they were trying to do, what steps they took, what they expected, and what happened
- Automatic screenshot capture of the current page content (widget hides itself during capture via html2canvas)
- Auto-included recent system logs and browser metadata (user agent, screen size, page URL)
- Issues are stored server-side and optionally forwarded to a Slack channel

**Real-Time Chat** — Teams can start a live chat session that bridges to a Slack channel:

- Each chat session becomes a single Slack thread
- Screenshots can be attached to chat messages with one click (📷 button)
- A chat can be started directly from an existing issue report
- An admin's Slack replies appear in real-time on the web chat UI
- Issues can be created from chat conversations to track them formally

The **Support** button (agent icon) in the status bar opens the widget as a floating panel in the bottom-right corner. The widget can be closed and reopened without losing the chat session, and persists state across page navigations via localStorage. An unread message badge appears on the icon when admin replies arrive while the widget is closed.

**Slack Integration** is configured on the admin page (`/admin` → Slack Integration):

- Requires a Slack App with a Bot Token (`xoxb-...`) and App-Level Token (`xapp-...`) with `connections:write` scope
- Uses Socket Mode for receiving messages (no public URL required)
- Test connection button to verify configuration

**Admin Authentication** — The `/admin` page is secured with a shared passphrase:

- First visit prompts passphrase creation (min. 4 characters)
- Subsequent visits require login; session token stored in browser
- Required for Slack configuration and other admin operations

### Duplicate Team Handling

When the same team is assigned to multiple stations (e.g., two robots from team 1234):

- **DS address resolution** uses the kernel ARP/neighbor table to identify which VLAN (station) a packet came from, instead of relying on team number alone
- **Route page** (`/route`) lets laptops choose which station's robot they connect to via per-client kernel routing rules

## Development

You'll need two terminal windows to run the development servers:

1. Start the backend API server:

```bash
npm run dev
```

2. In another terminal, start the frontend development server:

```bash
npm run dev -w frontend
```

The frontend will be available at http://localhost:5173.

The backend will be available at http://localhost:3000, however it is also proxied by the frontend dev server so no configuration should be necessary.

### Useful Scripts

```bash
npm run typecheck   # Type-check both backend and frontend
npm run format      # Format all files with Prettier
npm run build       # Compile backend + build frontend
```

## Network Architecture

The VH-113 field radio runs **`PRACTICE`** (or `OFFSEASON`) AP firmware. The AP handles DHCP on team VLANs directly; the pFMS host adds VLAN interfaces and MASQUERADE rules to route traffic between team subnets and the site network so laptops can reach robots and internet.

```mermaid
graph TD
    Internet["Internet"]
    Router["Site Router"]
    Laptops@{ shape: docs, label: "Team Laptops / Phones"}

    subgraph pFMS["pFMS Host"]
        APP["pFMS App"]
        TRUNK["Trunk Interface<br/>10.0.100.5 (management)<br/>10.TE.AM.254 (per VLAN)"]
        APP -. "configures" .-> TRUNK
    end

    AP["VH-113 AP<br/>PRACTICE firmware<br/>10.0.100.2"]
    Robots@{ shape: st-rect, label: "Robots"}
    VLANs@{ shape: st-rect, label: "VLANs 10–60<br/>10.TE.AM.0/24 each"}

    Internet --- Router
    Router -. "static route<br/>10.0.0.0/8" .-> pFMS

    APP -- "HTTP REST" --> AP
    TRUNK -- "MASQUERADE" --- VLANs --- AP
    AP -- "6 GHz Wi-Fi" --- Robots

    Laptops -. "10.TE.AM.x" .-> Router
    Router -- "guest/laptop network" --- Laptops
```

### Subnets

| Subnet        | CIDR            | Managed by    | Purpose                                               |
| ------------- | --------------- | ------------- | ----------------------------------------------------- |
| Main network  | (site-specific) | Site router   | Servers, infrastructure                               |
| Guest WiFi    | (site-specific) | Site router   | Team laptops, phones                                  |
| Field control | `10.0.100.0/24` | Static        | AP management, FMS                                    |
| Team VLANs    | `10.TE.AM.0/24` | **AP (DHCP)** | Per-team isolation (e.g. team 1234 → `10.12.34.0/24`) |

### pFMS Host Network Responsibilities

1. **VLAN interfaces** — trunk port carries VLANs 10-60 + 100; OS creates sub-interfaces (e.g. `eth0.10`, `eth0.20`)
2. **VLAN IP** — assigns itself `10.TE.AM.254` (configurable via `VLAN_HOST_OCTET`) on each active team's VLAN as a routing anchor
3. **Inter-VLAN routing** — IP forwarding + MASQUERADE rules between team subnets and the site network
4. **Per-client route preferences** — `ip rule` entries steer individual laptop IPs to specific station VLANs (for duplicate team disambiguation)
5. **Radio configuration** — HTTP REST to `10.0.100.2`
6. **FMS protocol** — TCP/1750 + UDP/1160 for DS status; UDP/1121 for robot control packets
7. **DS↔RIO DNAT** — dynamic PREROUTING rules to route asymmetric RIO→DS UDP replies back to the DS laptop
8. **Syslog** — optional syslog server for radio log collection

> **OFFSEASON firmware:** the pFMS host also runs `dnsmasq` per VLAN to serve DHCP (gateway = `10.TE.AM.254`), since the AP does not.

### Routing: Guest WiFi ↔ Team Subnets

For laptops on the site's guest/laptop network to reach robots on team subnets (`10.TE.AM.x`):

1. **Site router** needs a static route: `10.0.0.0/8` → the pFMS host's main IP (one-time config, team-agnostic)
2. **pFMS host** has direct access to team VLANs via trunk and routes between them and its main interface
3. **Teams** use hardcoded IPs (e.g. `10.12.34.2` for roboRIO) — no DNS needed

### DS ↔ RIO UDP and Dynamic DNAT

The FRC Driver Station ↔ roboRIO UDP protocol uses **asymmetric ports**: DS sends to the RIO on port 1110 (1115 when FMS-connected), but the RIO replies to the DS on port **1150** with an unrelated source port. This breaks conntrack-based NAT (MASQUERADE), which expects replies on the same port pair.

**TCP traffic (NetworkTables, AdvantageScope)** works fine through MASQUERADE because TCP's handshake creates a proper conntrack entry.

To fix DS ↔ RIO UDP, the pFMS dynamically adds PREROUTING DNAT rules when a DS connects:

```
iptables -t nat -A PREROUTING -i eth0.slot1 -p udp -d 10.TE.AM.254 \
  -j DNAT --to-destination <ds-laptop-ip>
```

This catches all UDP packets from the robot destined for the gateway IP on the station's VLAN interface and rewrites the destination to the DS laptop's guest WiFi IP. The rule is scoped to the gateway IP to avoid catching multicast/broadcast traffic. The rule is:

- **Added** when the DS announces itself via TCP 1750 and its station is resolved
- **Persistent** across DS TCP reconnects (the DS flaps every ~6s when no match is running)
- **Removed** when the station's team assignment is cleared or changed
- **Cleaned up** on hard restart via the `pfms-` comment prefix (same as all other rules)
- **Preserved** across graceful restarts (SIGHUP / `systemctl reload`); restored from kernel iptables on startup so stale rules are properly cleaned up if a DS reconnects with a different IP

### Device Discovery

The backend periodically scans each configured team's subnet using `fping`, pinging `.1–.253` every 10 seconds. Discovered devices (IPs that have responded at least once) are tracked with up/down status and first/last-seen timestamps, and broadcast to frontend clients. Results appear in the **Discovered Devices** section on the Network page and are cleared when station config is cleared.

### Robot Network Tester

A CSA diagnostic tool at `/test` for checking individual robot network configurations. Set `TEST_INTERFACE` to a dedicated network interface, plug in a cable from a robot's network, and the tool will:

1. **Detect link** — monitors carrier state at 5 Hz
2. **Obtain DHCP lease** — runs `dhcpcd` to get an IP and detect the team number from the `10.TE.AM.x` subnet
3. **Check radio** — fetches `/status` from `10.TE.AM.1`, verifies SystemCore is disabled and firmware is current
4. **Check roboRIO** — probes NI SysAPI on `10.TE.AM.2`, verifies hostname, IP, and image version

Results stream live to the frontend and re-check every 10 seconds while the cable is plugged in.

#### Radio Configuration

The test page can also **program a radio** in `TEAM_ROBOT_RADIO` mode — setting its team number, SSID, and WPA keys directly from the test interface. This is useful for configuring factory-default radios or re-programming existing ones without needing to be on the field management VLAN.

1. Connect the radio to the test interface (directly via Ethernet cable)
2. The test page will detect the radio at its factory default IP (`192.168.69.1`) or via DHCP
3. Click **Configure Radio** and enter the team number, WPA passphrase, and optional SSID suffix
4. The radio will reboot and come back on the team subnet — the tester will automatically pick it up via DHCP

#### Setting Up the Test Interface

The test interface needs to be a dedicated network path to the robot — either:

- **Dedicated NIC** — a separate physical Ethernet port (e.g., a USB Ethernet adapter). Plug the robot's radio directly into this port.
- **VLAN on the trunk** — if the robot is connected through the field AP, create a VLAN interface on the same trunk that carries the team VLANs. The VLAN ID must match the station the robot is on (10–60). For example, to test a robot on Slot 1 (VLAN 10):
  ```sh
  ip link add link eno1 name eno1.10 type vlan id 10
  ip link set eno1.10 up
  ```
  Then set `TEST_INTERFACE=eno1.10`.

The interface should **not** be managed by NetworkManager or have any existing IP configuration — the robot tester manages it entirely via `dhcpcd`.

The tester's DHCP client is isolated from the rest of the host: it runs `dhcpcd` with the `resolv.conf` and `hostname` hooks disabled, so DNS servers or hostnames offered by a robot radio's lease are never registered with the host's resolver (systemd-resolved) and cannot affect name resolution for anything else on the machine.

See [ROBOT-TESTER.md](ROBOT-TESTER.md) for full documentation of the tester's state machine, diagnostic checks, radio configuration, and firmware update flows.

See [TECHNICAL.md](TECHNICAL.md) for details on the startup sequence, configuration flow, match state machine, and dry-run mode.

## Project Structure

- `src/` - Backend TypeScript files
- `frontend/` - React frontend application
- `sounds/` - Match audio WAV files (charge horn, buzzers, etc.)
- `dist/` - Compiled backend JavaScript files (generated after build)
- `tsconfig.json` - TypeScript configuration
- `package.json` - Project dependencies and scripts

## Deployment

To deploy this in a production environment:

1. Run `npm run build`

- Backend will be compiled to JavaScript and placed in the `dist/` folder
- Frontend will be built and placed in the `frontend/dist/` folder

2. Run `npm start`

- This will start the backend server using the compiled JavaScript files in `dist/`
- Alternatively, you can run `node dist` directly to start the backend server.

3. Configure a web server to serve static files and proxy WebSocket connections to the backend.

### Update Script

An update script is provided to pull, build, deploy static assets, and reload the service:

```bash
./update.sh
```

### Systemd Service

```service
[Unit]
Description=Practice Field Management System Backend
After=network.target

[Service]
EnvironmentFile=/etc/pfms/environment
WorkingDirectory=/path/to/practice-field-configurator
ExecStart=/usr/bin/node dist
# Graceful reload: preserve network rules across restarts
ExecReload=/bin/sh -c 'touch /run/pfms-keep-network && kill -HUP $MAINPID'
Restart=always

[Install]
WantedBy=multi-user.target
```

Environment variables are stored in `/etc/pfms/environment` (one `KEY=value` per line). Changes take effect on service restart without requiring `systemctl daemon-reload`.

`systemctl reload` preserves iptables rules, route tables, and route preferences across restarts — robots stay connected and laptops keep their routing preferences. In-memory state (DNAT rules, previous station config, routing preferences) is restored from the kernel on startup. `systemctl restart` performs a full cleanup (flushes iptables rules, per-station route tables, and ip rule preferences).

### Caddy Example Config

```Caddyfile
practice.example.com {
    @stations {
        path_regexp ^/slot[1-6]$
    }
    rewrite @stations /station

    reverse_proxy /ws localhost:9001
    reverse_proxy /api/* localhost:9001

    root /path/to/frontend/dist
    try_files {path} {path}.html
    file_server
}
```

### Nginx Example Config

```conf
server {
    listen 80;
    server_name practice.example.com;
    root /path/to/frontend/dist;

    # Clean URLs: /admin → /admin.html, /scores → /scores.html, etc.
    location / {
        try_files $uri $uri.html $uri/ =404;
    }

    # Station pages: /slot1, /slot6, etc. → /station.html
    location ~^/slot[1-6]$ {
        rewrite ^ /station.html break;
    }

    location /api/ {
        proxy_pass http://localhost:9001;
        proxy_set_header Host $host;
        client_max_body_size 100m;  # firmware uploads
    }

    location /ws {
        proxy_pass http://localhost:9001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Environment Variables

| Variable                      | Default                 | Description                                                                                                                                                                                |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WEBSOCKET_PORT`              | `3000`                  | Port for the WebSocket server                                                                                                                                                              |
| `RADIO_URL`                   | `http://10.0.100.2`     | URL for the radio management API                                                                                                                                                           |
| `VLAN_INTERFACE`              | _(none)_                | Physical network interface for VLAN configuration (e.g., `eno1`). Required for routing.                                                                                                    |
| `FMS_ENDPOINT`                | `false`                 | Set to `true` to enable the FMS server (TCP/1750 + UDP/1160)                                                                                                                               |
| `FMS_TCP_REPLY_STATIONS`      | _(none)_                | Experimental: stations whose DS gets the FMS TCP station-assignment reply outside a match (`slot1,slot2` or `all`). For testing whether a TCP-only reply locks the DS out of local enable. |
| `DEPLOY_ANNOUNCE_FILE`        | `deploy-announced.json` | Path to the JSON file tracking the last version announced to Slack. On startup with a new git version, commit subjects since the last announced version are posted to the support channel. |
| `SYSLOG_ENDPOINT`             | `false`                 | Set to `true` to enable the syslog server                                                                                                                                                  |
| `RADIO_CLEAR_SCHEDULE`        | _(none)_                | Cron expression for scheduled configuration clearing (e.g., `0 6 * * *`)                                                                                                                   |
| `RADIO_CLEAR_TIMEZONE`        | _(none)_                | Timezone for scheduled clearing (e.g., `America/Los_Angeles`)                                                                                                                              |
| `VLAN_HOST_OCTET`             | `254`                   | Host octet for the pFMS host's IP on each team VLAN (range: 220–254)                                                                                                                       |
| `TRUSTED_PROXIES`             | _(none)_                | Comma-separated trusted proxy IPs/CIDRs for real client IP detection                                                                                                                       |
| `IPTABLES_COMMENT_PREFIX`     | `pfms-`                 | Prefix for iptables rule comments (used to identify and flush rules)                                                                                                                       |
| `MDNS_REFLECTOR`              | `false`                 | Set to `true` to enable the mDNS reflector (bridges `.local` queries between main network and team VLANs). Requires `VLAN_INTERFACE`.                                                      |
| `TEST_INTERFACE`              | _(none)_                | Network interface for the robot tester CSA tool (e.g., `eth1`). See [Robot Network Tester](#robot-network-tester) below.                                                                   |
| `FIELD_PORTS`                 | _(none)_                | Physical port bridging config: `VLANID:Name,...` (e.g., `201:Port A,202:Port B`). Requires `VLAN_INTERFACE`.                                                                               |
| `DRY_RUN`                     | _(none)_                | Set to any value to disable network operations (log-only mode for development)                                                                                                             |
| `API_KEYS_FILE`               | `api-keys.json`         | Path to the JSON file for API key persistence.                                                                                                                                             |
| `SCORING_AUTO_REGISTER_LIMIT` | `1`                     | Max scoring elements auto-registered from incoming events. Set to `0` to require explicit configuration via the API.                                                                       |
| `ADMIN_AUTH_FILE`             | `admin-auth.json`       | Path to the JSON file for admin authentication persistence.                                                                                                                                |
| `SUPPORT_ISSUES_FILE`         | `support-issues.json`   | Path to the JSON file for support issue persistence.                                                                                                                                       |
| `SUPPORT_CHATS_FILE`          | `support-chats.json`    | Path to the JSON file for support chat session persistence.                                                                                                                                |
| `SLACK_CONFIG_FILE`           | `slack-config.json`     | Path to the JSON file for Slack integration configuration.                                                                                                                                 |
| `EXTERNAL_ACCESS_FILE`        | `external-access.json`  | Path to the JSON file for external access token persistence.                                                                                                                               |

### External Access

External access tokens grant trusted users access to the full internal UI from outside the local network. Tokens are managed from the admin page — create, view, and revoke tokens as needed.

When an admin logs in, a token is automatically created and the browser cookie is set. Tokens can also be created manually and shared as URLs (`/admin/auth/<token>`). Visiting the URL sets an `HttpOnly` cookie (365 days, refreshed on every page load). On subsequent requests from external IPs, Caddy uses `forward_auth` to ask the backend whether the cookie is valid — the backend returns `200` (serve internal UI) or `401` (serve public page). Revoking a token in the admin UI invalidates it immediately.

### Trusted Proxies Configuration

When running behind a reverse proxy (like Caddy), set `TRUSTED_PROXIES` to enable real client IP detection:

```bash
# For Caddy running on localhost
TRUSTED_PROXIES=127.0.0.1,::1

# For Caddy on a specific network
TRUSTED_PROXIES=10.0.0.0/8

# Multiple proxies
TRUSTED_PROXIES=127.0.0.1,::1,10.0.0.0/8,192.168.1.0/24
```

This allows the application to read the `X-Forwarded-For` header from trusted proxies to log the real client IP instead of the proxy's IP (127.0.0.1).

## Resources

- [FRCture](https://frcture.readthedocs.io/en/latest/) — reverse-engineered documentation of FRC network protocols, including:
  - [DS → RIO protocol](https://frcture.readthedocs.io/en/latest/driverstation/ds_to_rio.html) — Driver Station to roboRIO packet format
  - [RIO → DS protocol](https://frcture.readthedocs.io/en/latest/driverstation/rio_to_ds.html) — roboRIO to Driver Station packet format
