# Known Bugs

## DS reconnects to FMS every ~6 seconds when idle

**Status: Resolved** (commit d860655 + self-service match redesign)

**Root cause 1 — Emergency Disable not working:** The `setDSAddress` call was gated on `'sequence' in msg.data`, which only matched UDP messages. Since the DS only sends TCP 0x18 TeamNumber messages at connect time, the DS address was never registered. Fixed by checking `'teamNumber' in msg.data` instead.

**Root cause 2 — Idle reconnect loop:** The match engine's tick only ran during an active match, so no UDP control packets were ever sent while idle. The DS would drop and reconnect every ~6 seconds.

**Resolution:** The self-service match redesign introduced a 200ms heartbeat (`sendJoinedHeartbeat`) that sends disable packets to stations that have joined the match system. Stations that have _not_ joined receive no packets — they operate in free-drive mode and still cycle, which is intentional (the DS eventually stops trying or the team ignores it).
