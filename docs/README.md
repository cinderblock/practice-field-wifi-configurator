# pFMS Documentation

Start with the [project README](../README.md) for an overview and quick
start. These guides go deeper:

## Guides

| Doc                                  | Covers                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                 | Installation, production deployment, systemd, update script, reverse proxy, external access |
| [configuration.md](configuration.md) | Environment variable reference, persistence files, trusted proxies                          |
| [match-system.md](match-system.md)   | Match lifecycle, ready check, E-Stop/A-Stop, match window, audio, history                   |
| [scoring.md](scoring.md)             | Scoring HTTP API, elements/sources/dedup, match review API                                  |
| [support.md](support.md)             | Support widget, issue reports, chat, Slack integration, admin auth                          |
| [network.md](network.md)             | Network architecture, VLANs, routing, DNAT, device discovery, mDNS                          |
| [robot-tester.md](robot-tester.md)   | The `/test` CSA diagnostic tool, radio programming, firmware updates                        |
| [internals.md](internals.md)         | Startup sequence, configuration flow, graceful reload, telemetry, dry-run mode              |

## Design Documents

| Doc                                                    | Covers                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| [design/vlan-decoupling.md](design/vlan-decoupling.md) | Station naming and alliance/VLAN decoupling design |

Working notes for in-flight tasks live in [`plans/`](../plans/) (not user
documentation). Known technical debt is tracked in
[`ISSUES.md`](../ISSUES.md).
