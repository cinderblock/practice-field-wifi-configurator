# Configuration Reference

All configuration is via environment variables. In production they live in
`/etc/pfms/environment` (one `KEY=value` per line) and take effect on
service restart — no `systemctl daemon-reload` needed. For local secrets
(the FIRST API credentials), a `.env` file in the repo root also works.

## Core

| Variable         | Default             | Description                                                                    |
| ---------------- | ------------------- | ------------------------------------------------------------------------------ |
| `WEBSOCKET_PORT` | `3000`              | Port for the WebSocket + HTTP server. The reference deployment runs on `9005`. |
| `RADIO_URL`      | `http://10.0.100.2` | URL for the radio management API                                               |
| `DRY_RUN`        | _(unset)_           | Set to any value to disable network operations (log-only mode for development) |

## Networking

| Variable                  | Default  | Description                                                                                                                           |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VLAN_INTERFACE`          | _(none)_ | Physical network interface for VLAN configuration (e.g., `eno1`). Required for routing.                                               |
| `VLAN_HOST_OCTET`         | `254`    | Host octet for the pFMS host's IP on each team VLAN (range: 220–254)                                                                  |
| `FIELD_PORTS`             | _(none)_ | Physical port bridging config: `VLANID:Name,...` (e.g., `201:Port A,202:Port B`). Requires `VLAN_INTERFACE`.                          |
| `IPTABLES_COMMENT_PREFIX` | `pfms-`  | Prefix for iptables rule comments (used to identify and flush rules)                                                                  |
| `KEEP_NETWORK`            | `false`  | Set to `true` to skip the startup network flush (same effect as the `/run/pfms-keep-network` flag file written by `systemctl reload`) |
| `MDNS_REFLECTOR`          | `false`  | Set to `true` to enable the mDNS reflector (bridges `.local` queries between main network and team VLANs). Requires `VLAN_INTERFACE`. |
| `MDNS_EXCLUDE_REQUESTERS` | _(none)_ | Requester IPs excluded from mDNS reflection                                                                                           |
| `MDNS_LISTEN_INTERFACES`  | _(none)_ | Extra interfaces the mDNS reflector listens on (comma/space separated)                                                                |
| `TRUSTED_PROXIES`         | _(none)_ | Comma-separated trusted proxy IPs/CIDRs for real client IP detection (see below)                                                      |

## FMS Protocol

| Variable                 | Default   | Description                                                                                                                                                                      |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FMS_ENDPOINT`           | `false`   | Set to `true` to enable the FMS server (TCP/1750 + UDP/1160)                                                                                                                     |
| `FMS_TCP_REPLY_STATIONS` | _(none)_  | Experimental: stations whose DS gets the FMS TCP station-assignment reply outside a match (`slot1,slot2` or `all`). For testing whether a TCP-only reply locks out local enable. |
| `FMS_LOG_DS_MESSAGES`    | _(unset)_ | Set to log verbose per-message DS TCP/UDP hex dumps (debugging)                                                                                                                  |
| `SYSLOG_ENDPOINT`        | `false`   | Set to `true` to enable the syslog server (radio log collection)                                                                                                                 |

## Robot Tester

| Variable         | Default  | Description                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `TEST_INTERFACE` | _(none)_ | Network interface for the robot tester CSA tool (e.g., `eth1`). See [robot-tester.md](robot-tester.md). |

## Scheduling

| Variable               | Default  | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `RADIO_CLEAR_SCHEDULE` | _(none)_ | Cron expression for scheduled configuration clearing (e.g., `0 6 * * *`) |
| `RADIO_CLEAR_TIMEZONE` | _(none)_ | Timezone for scheduled clearing (e.g., `America/Los_Angeles`)            |

## Scoring & Scoreboard

| Variable                      | Default  | Description                                                                                                                                                                                                                                            |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCORING_AUTO_REGISTER_LIMIT` | `1`      | Max scoring elements auto-registered from incoming events. Set to `0` to require explicit configuration via the API.                                                                                                                                   |
| `VIDEO_PROXY_TARGET`          | _(none)_ | Base URL of a WHEP/WebRTC stream server (e.g. MediaMTX, `http://10.255.0.20:8889`). Enables `/api/video-proxy/*` so the scoreboard's video view can play `whep:<stream>` sources over HTTPS. Only signaling is proxied; media flows directly over UDP. |

## Integrations

| Variable               | Default  | Description                                                                   |
| ---------------------- | -------- | ----------------------------------------------------------------------------- |
| `FIRST_API_USERNAME`   | _(none)_ | FIRST Events API username, for fetching team avatars (usually set via `.env`) |
| `FIRST_API_AUTH_TOKEN` | _(none)_ | FIRST Events API auth token                                                   |

Slack integration is configured through the admin UI, not environment
variables — see [support.md](support.md#slack-integration).

## Persistence Files

State files are JSON, written to the working directory by default:

| Variable               | Default                 | Holds                                                                                                                             |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE_CONFIG_FILE`   | `active-config.json`    | Active radio/station configuration                                                                                                |
| `STAGED_CONFIG_FILE`   | `staged-config.json`    | Staged (not yet committed) station configuration                                                                                  |
| `SAVED_TEAMS_FILE`     | `saved-teams.json`      | Saved team WiFi configs (auto-saved on configure)                                                                                 |
| `API_KEYS_FILE`        | `api-keys.json`         | Scoring API keys                                                                                                                  |
| `ADMIN_AUTH_FILE`      | `admin-auth.json`       | Admin passphrase hash + session tokens                                                                                            |
| `EXTERNAL_ACCESS_FILE` | `external-access.json`  | External access tokens                                                                                                            |
| `SUPPORT_ISSUES_FILE`  | `support-issues.json`   | Support issue reports                                                                                                             |
| `SUPPORT_CHATS_FILE`   | `support-chats.json`    | Support chat sessions                                                                                                             |
| `SLACK_CONFIG_FILE`    | `slack-config.json`     | Slack integration configuration                                                                                                   |
| `DEPLOY_ANNOUNCE_FILE` | `deploy-announced.json` | Last version announced to Slack. On startup with a new git version, commit subjects since then are posted to the support channel. |

Not configurable: `match-history.json`, `usage-data.json`,
`audio-config.json` (fixed names in the working directory).

## Misc / Debug

| Variable                    | Default | Description                                |
| --------------------------- | ------- | ------------------------------------------ |
| `RADIO_HISTORY_DURATION_MS` | `60000` | Radio status history retention window (ms) |

## Trusted Proxies

When running behind a reverse proxy (like Caddy), set `TRUSTED_PROXIES`
to enable real client IP detection:

```bash
# For Caddy running on localhost
TRUSTED_PROXIES=127.0.0.1,::1

# For Caddy on a specific network
TRUSTED_PROXIES=10.0.0.0/8

# Multiple proxies
TRUSTED_PROXIES=127.0.0.1,::1,10.0.0.0/8,192.168.1.0/24
```

This allows the application to read the `X-Forwarded-For` header from
trusted proxies to log the real client IP instead of the proxy's IP.
