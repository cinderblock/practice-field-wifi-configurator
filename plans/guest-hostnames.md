# Guest-network hostnames — show device names instead of bare IPs

## Goal

Everywhere the UI shows a guest-network host (DS laptops, phones), show its
hostname instead of the raw IP, falling back to the IP when no name is known,
with the IP revealed on hover/tap (MUI Tooltip — works on touch via long-press;
never HTML `title=`). Motivation: "Multiple DSes detected" warnings should name
the offending laptop, not just print an IP nobody recognizes.

## Environment / context

- pFMS does NOT run DHCP for the guest network — the site router does
  (site-specific, per TECHNICAL.md). So hostnames must be discovered, not read
  from a lease file.
- Guest hosts reach team subnets via NAT; backend learns their IPs from:
  conntrack scans (`src/subnetScanner.ts`, `source: 'conntrack'`), accepted /
  blocked DS maps (`src/index.ts` `broadcastDriveSessionState`, every 5 s),
  mDNS reflector requesters, and websocket client IPs.
- DS laptops are Windows → NetBIOS node-status (UDP 137) and mDNS both work;
  macs/phones answer mDNS; router PTR may work if the site router registers
  DHCP names.

## Decisions already made (don't re-ask)

- Resolution strategies, all unicast to the target host (no multicast-interface
  headaches): DNS PTR via system resolver, legacy-unicast mDNS reverse PTR
  (port 5353), NetBIOS node status (port 137). Run in parallel; prefer
  mDNS > NetBIOS > PTR. 2 s timeout each.
- Display short name (strip domain: `DESKTOP-ABC.local` → `DESKTOP-ABC`).
- Transport: new `hostnames` websocket message `{ type, hostnames: {ip: name} }`,
  broadcast on cache change + sent on client connect. Team-subnet IPs are not
  tracked — only guest hosts.
- Tooltip = MUI `<Tooltip>` (codebase standard, touch-friendly). Global rule:
  no HTML `title=` attributes.

## Plan / steps

1. [x] Survey display sites + data flow.
2. [x] `src/types.ts`: `HostnamesState` + guard.
3. [x] `src/hostnameResolver.ts`: cache + 3 resolvers + broadcast-on-change.
4. [x] `src/websocketServer.ts`: optional resolver param — track client IPs,
       send initial state on connect.
5. [x] `src/index.ts`: instantiate; track conntrack guests, accepted/blocked DS
       IPs, mDNS requesters.
6. [x] Frontend: `useHostnames()` hook, `HostDisplay` component.
7. [x] Update display sites:
   - `StationStatus.tsx` — blocked-DS banner, multiple-DS list, DS chip
   - `ControlPage.tsx` — multiple-DS warning, discovered-devices guest rows
   - `NetworkPage.tsx` — DS chip, blocked alert, guest rows, mDNS requester
   - `RoutePage.tsx` — "Your IP" line gains device name
8. [x] Typecheck, README, commit.

## Findings / gotchas

- `git status` at session start was stale — peer committed 19f2ee6; only
  AStopPopout.tsx + MatchPanel.tsx (+2 plan files) remain dirty, and this task
  touches none of them.
- driveSessionState is re-broadcast every 5 s (index.ts ~line 1100) — cheap
  place to keep DS IPs tracked.
- websocketServer's `setupWebSocket` takes ~24 positional params; resolver
  appended at the end as optional.
- `parseDnsName` needs compression-pointer support: Windows mDNS PTR responses
  compress the owner name; NetBIOS answers echo the 34-byte encoded name.

## Progress log

- [x] Backend: types, resolver, wiring (index.ts, websocketServer.ts)
- [x] Frontend: hook, HostDisplay, 4 pages updated
- [x] bun run typecheck passes (frontend + backend)
- [x] README updated (Device Discovery section)
- [x] Resolver smoke-tested against live LAN hosts
      (`bunx tsx scripts/test-hostname-resolver.ts <ip>...` — resolved this
      PC "Noook" on two IPs and the gateway "setup")
- [x] Committed on master as 0fd6a16 (subject: "Laptops on the guest network
      now show up by name instead of IP address")
- [x] Pushed + deployed to steamboat 2026-07-19 15:07 PDT (update.sh; clean
      start, DNAT/state preserved, deploy announcement posted)
- [x] Verified live post-deploy via `scripts/peek-hostnames.ts` (89476ac):
      12 guest hosts resolved, incl. every connected DS laptop
      (FunkyMonkey846, dstation-comp-1, team6036-0, 6962Drive4,
      CUSD-PF52PE2G); the duplicate DS blocked on slot4 at startup
      (10.55.29.164) resolves to DESKTOP-C8V99IA — the motivating scenario
      works end-to-end. TASK COMPLETE.

## Things not to do

- Don't use HTML `title=` for the IP reveal (global UI rule).
- Don't touch AStopPopout.tsx / MatchPanel.tsx — peer session's uncommitted
  work lives there.
- Don't try to read DHCP leases — guest DHCP belongs to the site router.
