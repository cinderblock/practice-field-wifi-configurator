# TODO

- [ ] Allow teams to enable their QoS bandwidth limit (enforced on the robot radio, not in pFMS — need to configure via radio API)
- [ ] Allow teams to enable firewall rules that match the real field (restricting traffic the same way FMS does on competition fields)
- [x] mDNS reflector should show resolved IPs on the webpage, and the requester, and be grouped with their VLAN
- [x] Show pFMS uptime in the status bar so crashes/restarts are clearly visible
- [x] Network status: combine Discovered Devices, Forwarding Counters, and mDNS activity into a single panel per station (e.g. one "Red1" panel with all networking data, not separate panels)
- [x] Version check: frontend should detect version mismatch on WebSocket connect and auto-refresh if it's running stale code
- [x] "Radio SystemCore" check isn't valid until the radio is on the latest firmware — skip or caveat it for older versions
- [x] Remind teams that their SSID is their robot broadcast name minus the leading `FRC-` (e.g. `FRC-123-Comp` → `123-Comp`, case-sensitive)
- [x] Guest network host detection: any IP on the guest network seen talking to a `10.TE.AM.x` address should appear in the alive hosts list for that station
- [x] Move the GitHub link from the corner ribbon into the status banner — the ribbon doesn't fit the rest of the UI
- [ ] Browser/OS notifications to teams when a radio reconfiguration starts on their station (so they know to expect a brief disconnect)
- [ ] Convert radio connection strength text (`Excellent`/`Good`/`Caution`/`Warning`/etc.) to a numeric value (4/3/2/1, 0 for not connected) for easier display and comparison
- [ ] Alert on admin page when a single IP is accessing multiple `10.TE.AM.x` ranges (indicates misconfigured or roaming device)
- [x] ~~DS switcher~~ — removed; teams should only run one DS at a time. Duplicate DSes are now blocked with a warning message sent to the DS and displayed on the station page
- [x] Use disable instead of e-stop in control packets. E-stop is backend-only (prevents re-enabling). Consolidated admin UI with disable as primary action
- [ ] New home/landing page for first-time users: walk them through picking a station (with links to each station page) or link to the network tester (`/test`). Move the current overview/index view to a new path (e.g. `/overview` or `/dashboard`)
- [ ] Hide the "Join match" button on station pages unless the station is configured
- [ ] Match start modal: when all joined stations are ready, show a modal with a big "Start Match" button that triggers a 5-second countdown with audio ("starting match in 3, 2, 1" + trumpet start) played on every pFMS window joined to the match
- [ ] "Switch driver stations" button: let a team easily move to a different station or swap with another team
- [ ] Support more than 6 robots in a day without forcing clearing old ones first (e.g. queue/rotate teams through stations without manually wiping previous configurations)
- [x] Syslog server should bind to the FMS IP (10.0.100.5) instead of 0.0.0.0
- [x] Configure modal is too wide on mobile — full-screen dialog on mobile, responsive sizing

### Robot Network Tester (CSA Tool)

- [x] New feature: dedicated robot network diagnostic tool at `/test`
  - Enabled via env var that selects an unused interface for direct robot connection
  - Plug into a robot's network, receive DHCP, detect the `10.TE.AM.x` range
  - Connect to `10.TE.AM.1` (radio) and `10.TE.AM.2` (roboRIO) to check settings and firmware versions
  - Report what's wrong/misconfigured in a clear diagnostic UI
  - Dedicated frontend page served at `/test`
  - Future: extract into a standalone module
- [x] Verify team number consistency across all devices (radio, roboRIO, DHCP range) and flag mismatches
- [x] Factory-default radio detection: add `192.168.69.8` as a secondary IP on the test interface and probe the radio at `192.168.69.1` — if reachable there but not at `10.TE.AM.1`, the radio is unconfigured
- [x] mDNS test: verify `.local` resolution works from the test interface (separate from the main mDNS reflector)
- [ ] `/test` manual radio configuration doesn't support setting the radio's suffix/name field (VH-109 configuration option)
- [ ] Fix mDNS equipment check on station VLANs (works on `/test` interface, fails on station VLANs)
  - Root cause: `mdnsQuery()` binds to an ephemeral port (port 0), but mDNS responses are multicast to port 5353. The socket never receives responses because it's listening on the wrong port.
  - Works on `/test` because: no mDNS reflector running there, and the unicast-response bit tells the responder to reply directly to the sender's port.
  - Fails on station VLANs because: the mDNS reflector already has a socket on port 5353 with multicast membership. Multicast responses go to port 5353 where only the reflector's socket picks them up.
  - Proper fix: bind `mdnsQuery` to port 5353 (with `SO_REUSEADDR`) so it receives multicast responses alongside the reflector. Both sockets get a copy of multicast UDP.
  - Alternative: skip the raw query on station VLANs entirely and read from the reflector's already-resolved cache instead.
- [x] One-click radio firmware update from `/test` page
  - Detect when a connected robot's radio is on an old firmware version
  - Show an "Update Firmware" button (only when old version detected)
  - Confirm that the same SSID/suffix/passphrase/config will be re-applied after update
  - Use the radio's `/configuration` API endpoint to flash firmware (requires `.bin` + hash)
  - Support both current and older radio hardware (different `.bin` files per model)
  - Firmware binaries: hardcode URL + hash for current releases, reference https://frc-radio.vivid-hosting.net/overview/firmware-releases
  - Report progress and result back to the UI
  - Reference: https://frc-radio.vivid-hosting.net/overview/upgrading-firmware

### Scoring System

- [x] Score tracking endpoint: receive score events from external goal-watching systems
  - Track scores per side (red/blue), both during practice matches and free-play
  - Two modes:
    - **Free play (default):** 30-second sliding window — shows a rolling count of scores in the last 30s, subtracting/recounting as events age out
    - **Match mode:** scores start at zero; shows total scores plus breakdown by period, including would-be scores that happened while the scoring element is inactive
  - HTTP REST API with API key auth, machine-readable schema at `/api/score/schema`
  - Configurable elements, deduplication, phase restrictions, foul-to-opponent support
- [x] Frontend UI to display live scores, window/period state, and breakdowns
- [x] Scoreboard casting: dedicated display-optimized route (`/scores`) for throwing up on a TV on the LAN
- [x] Google Cast SDK integration: add a cast button to `/scores` that auto-discovers Chromecast/Google TV devices on the LAN and pushes the URL directly
- [x] Add a scores button/link on station pages so teams can easily access the scoreboard
- [x] Fix blank space at bottom of viewport on scores TV display — use 100vh on cast receivers instead of 100dvh
- [ ] Future: automatic autonomous period scoring — detect which side "won" auto to determine who gets the first 30s scoring period
- [ ] Goal light control: send messages to external systems to illuminate goals during their active scoring period

### Telemetry Gaps

We currently collect: battery voltage, brownout, enable/mode, basic DS connection info. The DS↔RIO protocol exposes much more ([DS→RIO](https://frcture.readthedocs.io/en/latest/driverstation/ds_to_rio.html), [RIO→DS](https://frcture.readthedocs.io/en/latest/driverstation/rio_to_ds.html)):

- [ ] RIO disk space, CPU utilization, free RAM
- [ ] PDP/PDH per-port current draw (16 channels)
- [ ] CAN bus utilization, bus-off count, TX full, RX/TX errors
- [ ] Robot code running / RIO present (trace byte)
- [ ] Disable faults (comms, 12V) and rail faults (6V, 5V, 3.3V)
- [ ] Device version inventory (software, CAN Talon, PDP, PCM)
- [ ] Robot code error messages and console output
- [ ] Radio event log messages
- [ ] Joystick connectivity and input state
- [ ] Host CPU usage / detection of possible overloading of network stack
