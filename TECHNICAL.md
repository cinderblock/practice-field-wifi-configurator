# Technical: Startup & Configuration Sequence

## Startup

1. **Wait for radio** — fetch `GET /status` from the radio at `10.0.100.2`, retrying every 10s until it responds. Nothing else starts until the radio is reachable.
2. **Detect firmware mode** — parse the version string (e.g. `VH-109_AP_PRACTICE_1.2.9-02102025`) for `PRACTICE`, `OFFSEASON`, or `FRC`. Log a warning if not PRACTICE.
3. **Check interface IPs** — if `VLAN_INTERFACE` is set, verify the physical interface has the expected IPs (`10.0.100.5` for FMS and syslog). Log OK or MISSING for each.
4. **Check system tools** — verifies `iptables`, `arping`, and `fping` are available. `arping` and `dnsmasq` checks are skipped in PRACTICE firmware mode.
5. **Enable IP forwarding** — `sysctl -w net.ipv4.ip_forward=1` so the kernel routes packets between interfaces (required for inter-VLAN routing).
6. **Start RadioManager** — begins polling `GET /status` every 100ms to track radio state and station connections.
7. **Start WebSocket server** — listens on `WEBSOCKET_PORT` (default 3000), broadcasts radio status to connected frontend clients.
8. **Start optional services** — syslog server, FMS server, scheduled configuration clearing (cron).
9. **Start routing health check** (OFFSEASON only) — pings the router (`10.0.100.1`) from the host native interface every 2s to verify the static route (`10.0.0.0/8 → pFMS Host`) is configured on the gateway.
10. **Start subnet scanner** — periodically runs `fping` on each configured team's subnet (`.1–.253`) every 10 seconds to discover devices. Results are broadcast via WebSocket and displayed on the Network page.

## When a Team is Configured

A frontend client sends a WebSocket message with `{ station, ssid, wpaKey }`. Here's what happens:

1. **WebSocket receives message** — `websocketServer.ts` validates the message and calls `radioManager.configure(station, { ssid, wpaKey })`.

2. **Stage or commit** — if `stage: true`, the config is saved in memory for later batch commit. Otherwise, `commitConfiguration()` fires immediately.

3. **Parse team number** — the team number is extracted from the SSID (format: `1234-...`), used to compute the team subnet `10.TE.AM.0/24`.

4. **Network config and radio config run in parallel** (`Promise.all`):

   **a. Network configuration** (`networkManager.ts` — only if `VLAN_INTERFACE` is set):

   Only stations whose configuration has changed are torn down and recreated (differential updates). For each of the 6 stations (red1–3, blue1–3):
   - **Create VLAN sub-interface** — `ip link add link eth0 name eth0.red1 type vlan id 10` (idempotent, skips if already exists with matching config)
   - **Flush addresses** — `ip addr flush dev eth0.red1` (clean slate)
   - If team is assigned:
     - **Add IP** — `ip addr add 10.TE.AM.254/24 dev eth0.red1` (pFMS Host is `.254` by default, configurable via `VLAN_HOST_OCTET`)
     - **Bring up** — `ip link set eth0.red1 up`
     - **Add MASQUERADE** — `iptables -t nat -A POSTROUTING -o eth0.red1 -j MASQUERADE` so guest WiFi traffic is NATed to the team VLAN
   - If no team:
     - **Bring down** — `ip link set eth0.red1 down`
   - **Start DHCP server** _(OFFSEASON only)_ — serves `10.TE.AM.100–199`, gateway `10.TE.AM.254` (configurable). Skipped in PRACTICE mode since the AP handles DHCP (gateway = `10.TE.AM.4`).

   **b. Radio configuration** (`radioManager.ts`):
   - **POST /configuration** — sends `{ stationConfigurations: { red1: { ssid, wpaKey }, ... } }` to the radio
   - **Wait for CONFIGURING** — polls in-memory status until radio enters `CONFIGURING` state (2s timeout)
   - **Wait for ACTIVE** — polls until radio exits `CONFIGURING` (45s timeout), verifies final status is `ACTIVE`

5. **Result** — the robot connects to its team's SSID on the radio, gets a DHCP lease from the AP (PRACTICE mode) or the pFMS host (OFFSEASON mode), and is reachable at `10.TE.AM.x` from laptops on the site network (via the static route on the site router).

## Clearing All Configurations

When the cron schedule fires (or manually triggered):

1. All entries in `activeConfig` are deleted
2. `commitConfiguration()` runs with empty config
3. Radio bug workaround: since the radio rejects empty `stationConfigurations`, the code sends a syslog IP update instead, which has the side effect of clearing all station configs
4. Network side: all VLAN interfaces are brought down, addresses flushed

## Dry-Run Mode

With the `DRY_RUN` environment variable set:

- Network operations log what they would do but make no OS changes (dry-run backend)
- DHCP servers are not started _(OFFSEASON mode only — PRACTICE mode relies on the AP for DHCP regardless)_
- The routing health check is skipped
- Radio communication still works normally (it's always live)

This allows development and testing on any OS without root access or a real network stack.
