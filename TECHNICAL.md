# Technical: Startup & Configuration Sequence

## Startup

1. **Wait for radio** — fetch `GET /status` from the radio at `10.0.100.2`, retrying every 10s until it responds. Nothing else starts until the radio is reachable.
2. **Detect firmware mode** — parse the version string (e.g. `VH-109_AP_OFFSEASON_1.2.9-02102025`) for `PRACTICE`, `OFFSEASON`, or `FRC`. Log a warning if not OFFSEASON.
3. **Check interface IPs** — if `VLAN_INTERFACE` is set, verify the physical interface has the expected IPs (`10.0.100.5` for FMS, `10.0.100.40` for syslog). Log OK or MISSING for each.
4. **Enable IP forwarding** — `sysctl -w net.ipv4.ip_forward=1` so the kernel routes packets between interfaces (required for inter-VLAN routing).
5. **Start RadioManager** — begins polling `GET /status` every 100ms to track radio state and station connections.
6. **Start WebSocket server** — listens on `WEBSOCKET_PORT` (default 3000), broadcasts radio status to connected frontend clients.
7. **Start optional services** — syslog server, FMS server, scheduled configuration clearing (cron).
8. **Start routing health check** (OFFSEASON only) — pings the router (`10.0.100.1`) from the host native interface every 2s to verify the static route (`10.0.0.0/8 → Steamboat`) is configured on the gateway.

## When a Team is Configured

A frontend client sends a WebSocket message with `{ station, ssid, wpaKey }`. Here's what happens:

1. **WebSocket receives message** — `websocketServer.ts` validates the message and calls `radioManager.configure(station, { ssid, wpaKey })`.

2. **Stage or commit** — if `stage: true`, the config is saved in memory for later batch commit. Otherwise, `commitConfiguration()` fires immediately.

3. **Parse team number** — the team number is extracted from the SSID (format: `1234-...`), used to compute the team subnet `10.TE.AM.0/24`.

4. **Network config and radio config run in parallel** (`Promise.all`):

   **a. Network configuration** (`networkManager.ts` — only if `VLAN_INTERFACE` is set):

   For each of the 6 stations (red1–3, blue1–3):
   - **Create VLAN sub-interface** — `ip link add link eth0 name eth0.red1 type vlan id 10` (idempotent, skips if already exists with matching config)
   - **Flush addresses** — `ip addr flush dev eth0.red1` (clean slate)
   - If team is assigned:
     - **Add IP** — `ip addr add 10.TE.AM.3/24 dev eth0.red1` (Steamboat is `.3` on each team subnet)
     - **Bring up** — `ip link set eth0.red1 up`
   - If no team:
     - **Bring down** — `ip link set eth0.red1 down`
   - **Start DHCP server** — serves `10.TE.AM.100–199`, gateway `10.TE.AM.3`

   **b. Radio configuration** (`radioManager.ts`):
   - **POST /configuration** — sends `{ stationConfigurations: { red1: { ssid, wpaKey }, ... } }` to the radio
   - **Wait for CONFIGURING** — polls in-memory status until radio enters `CONFIGURING` state (2s timeout)
   - **Wait for ACTIVE** — polls until radio exits `CONFIGURING` (45s timeout), verifies final status is `ACTIVE`

5. **Result** — the robot connects to its team's SSID on the radio, gets a DHCP lease from Steamboat on the correct VLAN, and is reachable at `10.TE.AM.x` from laptops on the guest/main network (via the static route on the UniFi Gateway).

## Clearing All Configurations

When the cron schedule fires (or manually triggered):

1. All entries in `activeConfig` are deleted
2. `commitConfiguration()` runs with empty config
3. Radio bug workaround: since the radio rejects empty `stationConfigurations`, the code sends a syslog IP update instead, which has the side effect of clearing all station configs
4. Network side: all VLAN interfaces are brought down, addresses flushed

## Dry-Run Mode

Without the `YOLO` environment variable set:

- Network operations log what they would do but make no OS changes (dry-run backend)
- DHCP servers are not started
- The routing health check is skipped
- Radio communication still works normally (it's always live)

This allows development and testing on any OS without root access or a real network stack.
