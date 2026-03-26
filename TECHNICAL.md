# Technical: Startup & Configuration Sequence

## Startup

1. **Check system tools** — if `VLAN_INTERFACE` is set, verifies `iptables`, `arping`, `fping`, and `dnsmasq` are available. `arping` and `dnsmasq` checks are skipped in PRACTICE firmware mode.
2. **Check interface IPs** — if `VLAN_INTERFACE` is set, verify the physical interface has the expected IPs (`10.0.100.5` for FMS and syslog). Log OK or MISSING for each.
3. **Flush or preserve network rules** — on a fresh start, flush stale iptables rules and per-station route tables from a previous run. On a graceful reload (`KeepNetwork`), skip the flush to preserve existing rules (see _Graceful Reload_ below).
4. **Enable IP forwarding** — `sysctl -w net.ipv4.ip_forward=1` so the kernel routes packets between interfaces (required for inter-VLAN routing).
5. **Connect to radio (background)** — fetch `GET /status` from the radio at `10.0.100.2`, retrying every 10s. Runs in the background — does **not** block startup. When the radio responds, firmware mode is detected and set on the RadioManager.
6. **Start RadioManager** — begins polling `GET /status` every 100ms to track radio state and station connections.
7. **Start match engine** — initializes match state machine with a 200ms heartbeat for joined stations (see _Self-Service Match System_ below).
8. **Start match audio** — detects an available audio player (aplay, paplay, ffplay, mpv, play, afplay) and loads sound files from `sounds/` for phase transition feedback.
9. **Start WebSocket server** — listens on `WEBSOCKET_PORT` (default 3000), broadcasts radio status to connected frontend clients.
10. **Start subnet scanner** — periodically runs `fping` on each configured team's subnet (`.1–.253`) every 10 seconds to discover devices. Results are broadcast via WebSocket and displayed on the Network page.
11. **Start optional services** — syslog server, FMS server, scheduled configuration clearing (cron).
12. **Restore in-memory state** — on graceful reload, restores DNAT rules from kernel iptables, previous station config from the radio manager, and route preferences from kernel `ip rule` entries.

## When a Team is Configured

A frontend client sends a WebSocket message with `{ station, ssid, wpaKey }`. Here's what happens:

1. **WebSocket receives message** — `websocketServer.ts` validates the message and calls `radioManager.configure(station, { ssid, wpaKey })`.

2. **Stage or commit** — if `stage: true`, the config is saved in memory for later batch commit. Otherwise, `commitConfiguration()` fires immediately.

3. **Parse team number** — the team number is extracted from the SSID (format: `1234-...`), used to compute the team subnet `10.TE.AM.0/24`.

4. **Network config and radio config run in parallel** (`Promise.all`):

   **a. Network configuration** (`networkManager.ts` — only if `VLAN_INTERFACE` is set):

   Only stations whose configuration has changed are torn down and recreated (differential updates). For each of the 6 stations (slot1–slot6):
   - **Create VLAN sub-interface** — `ip link add link eno1 name eno1.slot1 type vlan id 10` (idempotent, skips if already exists with matching config)
   - **Create bridge** — `ip link add name br-slot1 type bridge` (the bridge is the L2 anchor — all IP/iptables/routes reference it)
   - **Enslave VLAN to bridge** — `ip link set eno1.slot1 master br-slot1`
   - If team is assigned:
     - **Remove stale addresses** — removes only IPv4 addresses that don't belong to the new team (preserves IPv6 link-local)
     - **Check for conflicts** — `arping` to detect if the IP is already in use (OFFSEASON mode only)
     - **Add IP** — `ip addr add 10.TE.AM.254/24 dev br-slot1` (pFMS Host is `.254` by default, configurable via `VLAN_HOST_OCTET`)
     - **Bring up** — `ip link set eno1.slot1 up && ip link set br-slot1 up`
     - **Add forwarding rules** — `iptables -A FORWARD -i/-o br-slot1 -j ACCEPT`
     - **Add MASQUERADE** — `iptables -t nat -A POSTROUTING -o br-slot1 -j MASQUERADE` so guest WiFi traffic is NATed to the team VLAN
     - **Add routing table entry** — per-station route for laptop route preferences
   - If no team:
     - **Bring down** — `ip link set br-slot1 down`
   - **Start DHCP server** _(OFFSEASON only)_ — serves `10.TE.AM.100–199`, gateway `10.TE.AM.254` (configurable). Skipped in PRACTICE mode since the AP handles DHCP (gateway = `10.TE.AM.4`).

   **Physical port bridging** (if `FIELD_PORTS` is configured):
   When a team requests a physical Ethernet port (e.g., "Port A", VLAN 201), the port's VLAN sub-interface (`eno1.p201`) is created and added as a second member of the station's bridge. A laptop plugged into that switch port is then on the same L2 segment as the radio VLAN — it can reach the robot directly. Ports are managed at runtime via the team control page UI.

   **b. Radio configuration** (`radioManager.ts`):
   - **POST /configuration** — sends `{ stationConfigurations: { red1: { ssid, wpaKey }, ... } }` to the radio (internal slot names are translated to radio-native `red1`–`blue3` at the boundary)
   - **Wait for CONFIGURING** — polls in-memory status until radio enters `CONFIGURING` state (2s timeout)
   - **Wait for ACTIVE** — polls until radio exits `CONFIGURING` (45s timeout), verifies final status is `ACTIVE`

5. **Result** — the robot connects to its team's SSID on the radio, gets a DHCP lease from the AP (PRACTICE mode) or the pFMS host (OFFSEASON mode), and is reachable at `10.TE.AM.x` from laptops on the site network (via the static route on the site router).

## Self-Service Match System

The match system is self-service: stations join/leave/ready themselves, and the FMS only takes control of joined stations.

### Match Phases

| Phase       | Duration                    | Description                                                                                    |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `idle`      | —                           | No match. Stations can join/leave/ready. Joined stations receive a 200ms heartbeat (disabled). |
| `countdown` | 3s fixed                    | Pre-match countdown. All joined stations disabled.                                             |
| `auto`      | configurable (default 15s)  | Autonomous period. Joined stations enabled in auto mode.                                       |
| `autoPause` | configurable (default 3s)   | Pause between auto and teleop. Robots disabled.                                                |
| `teleop`    | configurable (default 135s) | Teleoperated period. Transitions to `endgame` when remaining time ≤ endgame duration.          |
| `endgame`   | configurable (default 30s)  | Final portion of teleop. Triggers warning sound.                                               |
| `postMatch` | 3s fixed                    | Display delay after match ends. Auto-resets to `idle`.                                         |
| `paused`    | —                           | Clock frozen, robots disabled. Can resume or abandon.                                          |

### Station Flow

1. **Join** — station sends `stationJoin`. Heartbeat begins sending disable packets (DS connects to FMS).
2. **Ready** — station sends `stationReady`. Once all joined stations are ready, any can start.
3. **Start** — station sends `stationStartMatch`. Match runs through phases automatically.
4. **Pause** — any joined station can pause during auto/teleop/endgame. Resume or abandon from paused.
5. **Leave** — after match ends (or while idle), station sends `stationLeave`. FMS stops sending packets; DS returns to free-drive mode.

### Match Audio

Sound effects play on phase transitions via a system audio player:

- **Charge horn** — countdown → auto
- **End buzzer** — auto → autoPause, and normal match end
- **Resume tone** — paused → resumed, autoPause → teleop
- **Warning buzzer** — teleop → endgame
- **Pause tone** — transition to paused
- **Abort tone** — match stopped, e-stopped, or abandoned

### Admin Controls

The admin page provides safety overrides independent of the self-service system:

- **Global E-Stop** — immediately e-stops all stations and ends the match
- **Per-station E-Stop / Disable / Clear** — individual station control
- **Force Stop Match** — ends any active match

## Duplicate Team Resolution

When the same team number is assigned to multiple stations (e.g., two robots from team 1234), DS address discovery uses the kernel ARP/neighbor table to resolve the correct station:

1. `isTeamDuplicated()` checks if the team number appears on more than one station
2. If duplicated, `resolveStationByNeighbor()` runs `ip neigh show <ip>` and matches the reported device (e.g., `br-slot1`) to a station
3. Falls back to `getStationForTeam()` if the neighbor entry isn't populated yet

For unique team numbers (the common case), the lookup is a direct synchronous map check with no subprocess overhead.

## Route Preferences

When duplicate teams are configured, laptops need a way to choose which robot they connect to. The `/route` page provides this:

1. **Detection** — the server identifies "conflicting teams" (same team on 2+ stations)
2. **Client UI** — the route page shows the user's detected IP and buttons for each station with a conflicting team
3. **Kernel routing** — selecting a station adds an `ip rule from <laptop-ip> lookup <vlan-table>` rule, directing that laptop's traffic through the chosen station's VLAN
4. **Cleanup** — preferences are cleared when station configs change (to prevent stale rules pointing to removed routing tables)

## Graceful Reload

`systemctl reload` preserves network state across restarts:

1. **ExecReload** writes `/run/pfms-keep-network` then sends `SIGHUP`
2. **SIGHUP handler** stops DHCP servers but exits **without** flushing iptables, route tables, or ip rules
3. **Systemd restarts** the process (Restart=always)
4. **Startup detects** the flag file, skips the iptables/route flush, and restores in-memory state from the kernel:
   - **DNAT rules** — parsed from `iptables -t nat -S PREROUTING` so stale rules are cleaned up if a DS reconnects with a different IP
   - **Previous station config** — initialized from the radio manager so future team changes properly tear down old routes/rules
   - **Route preferences** — rebuilt from `ip rule list` so laptop routing choices persist

This means robots stay connected and laptops keep their routing preferences during service updates.

Hard shutdown (`SIGTERM`/`SIGINT`) performs full cleanup: stops DHCP, flushes all iptables rules, per-station route tables, and ip rule preferences.

## Clearing All Configurations

When the cron schedule fires (or manually triggered):

1. All entries in `activeConfig` are deleted
2. `commitConfiguration()` runs with empty config
3. Radio bug workaround: since the radio rejects empty `stationConfigurations`, the code sends a syslog IP update instead, which has the side effect of clearing all station configs
4. Network side: all VLAN interfaces are brought down, addresses removed

## Dry-Run Mode

With the `DRY_RUN` environment variable set:

- Network operations log what they would do but make no OS changes (dry-run backend)
- DHCP servers are not started _(OFFSEASON mode only — PRACTICE mode relies on the AP for DHCP regardless)_
- Radio communication still works normally (it's always live)

This allows development and testing on any OS without root access or a real network stack.
