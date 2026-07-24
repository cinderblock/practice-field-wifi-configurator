# VLAN Decoupling Design: Two Distinct Problems

This document describes two related but independent decoupling problems for the practice FMS. They can be solved separately and in any order.

---

## Problem 1: Rename Physical Station Identifiers

### What

The 6 radio slots on the VH-113 are currently named `red1`, `red2`, `red3`, `blue1`, `blue2`, `blue3` throughout the entire codebase. These names carry alliance-colored semantics, but recent architecture work (the `portToSlot` mapping in `matchEngine.ts`) decoupled alliance selection from physical station at the FMS protocol level. A team on physical slot `blue3` (VLAN 60) can now join the Red alliance and their DS receives `allianceStation: red1`.

The names `red1`/`blue3` are now misleading — they imply an alliance that no longer applies.

### Goal

Rename the 6 physical station identifiers to something neutral:

| Current | Implemented | VLAN ID |
| ------- | ----------- | ------- |
| `red1`  | `slot1`     | 10      |
| `red2`  | `slot2`     | 20      |
| `red3`  | `slot3`     | 30      |
| `blue1` | `slot4`     | 40      |
| `blue2` | `slot5`     | 50      |
| `blue3` | `slot6`     | 60      |

**Status: Implemented** — using `slot1`–`slot6`. A translation layer at the radio boundary maps between internal slot names and the VH-113's native `red1`–`blue3` names.

### What Changes

**Core types (`src/types.ts`):**

```typescript
// Before
export type StationName = `${Alliance}${StationNumber}`;
export const StationNameList = ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'] as const;

// After
export type StationLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
export type StationName = StationLetter;
export const StationNameList = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export const StationNameRegex = /^[a-f]$/;
```

**`MatchSlot` stays alliance-colored** — it represents the position a DS sees in the FMS protocol (`red1`, `blue2`, etc.). Robot code expects these values. Only `StationName` (the physical slot) changes.

**VLAN map (`src/networkManager.ts`):**

```typescript
export const vlanMap: Record<StationName, number> = {
  a: 10,
  b: 20,
  c: 30,
  d: 40,
  e: 50,
  f: 60,
};
```

**Linux interface names** change from `eno1.red1` → `eno1.a`.

**Display names** (`prettyStationName()` in `src/utils.ts`): `"Red 1"` → `"Station A"`.

### What Doesn't Change

- VLAN IDs (10–60) stay the same
- The VH-113 radio's internal VLAN assignment is unchanged
- The FMS protocol wire format is unchanged (`MatchSlot` values in DS packets)
- Network topology and iptables rules are functionally identical

### Scope

282 occurrences of `StationName` across 28 files. Best done as a single focused commit — change the type, let TypeScript errors guide the rest.

### VH-113 Radio Compatibility

The radio API accepts per-station configuration keyed by station name. **Need to verify** whether the API is hardcoded to expect `red1`/`blue3` or if it uses positional indexing. If the API requires the old names, add a translation layer at the `radioManager.ts` boundary (internal: `a`–`f`, radio API: `red1`–`blue3`).

### Files Affected

| File                                         | What Changes                                                       |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `src/types.ts`                               | Core type definition (start here)                                  |
| `src/networkManager.ts`                      | VLAN map, interface names, iptables rules                          |
| `src/matchEngine.ts`                         | Station states map, portToSlot                                     |
| `src/radioManager.ts`                        | Config keyed by station, radio API calls                           |
| `src/websocketServer.ts`                     | Message routing per station                                        |
| `src/fmsEndpoint.ts`                         | TCP/UDP port-to-station mapping                                    |
| `src/routePreferenceManager.ts`              | Per-station routing tables                                         |
| `src/subnetScanner.ts`                       | Per-station subnet scanning                                        |
| `src/networkStats.ts`                        | Per-station iptables counters                                      |
| `src/utils.ts`                               | `prettyStationName()` display formatting                           |
| `src/index.ts`                               | Startup wiring, station iteration                                  |
| `frontend/src/hooks/useBackend.ts`           | Station-keyed state                                                |
| `frontend/src/components/ControlPage.tsx`    | Station lookup hooks                                               |
| `frontend/src/components/MatchPanel.tsx`     | Station chips and labels                                           |
| `frontend/src/components/StationStatus.tsx`  | Admin station cards                                                |
| `frontend/src/components/ScoreboardPage.tsx` | Team display per station                                           |
| `frontend/src/roots/station.tsx`             | Legacy station page (deprecated)                                   |
| `frontend/vite.config.ts`                    | Routing middleware                                                 |
| Config files on disk                         | `active-config.json`, `staged-config.json` — keyed by station name |

---

## Problem 2: Decouple Physical Ethernet Ports from Radio Slots/VLANs

### What

This is the **network-level** decoupling problem. Currently, each physical Ethernet port at the field is hardwired (via switch VLAN assignment) to a specific VH-113 radio slot. If a team's Driver Station laptop is plugged into the "Red 1" Ethernet jack, it's on VLAN 10, which corresponds to radio slot `red1`. The team **must** use that specific radio slot — they can't be on a different VLAN without physically moving their Ethernet cable or reconfiguring the switch.

The FMS protocol decoupling (Problem 1's `portToSlot`) only changes what alliance the DS _thinks_ it's on. The actual network path — which VLAN carries the team's traffic between their laptop and their robot — is still dictated by which physical port they plugged into.

### Goal

Allow a team to plug their DS laptop into **any** physical Ethernet port at the field and have the system route their traffic to whatever radio slot/VLAN they've been assigned. The mapping between "physical Ethernet jack" and "radio VLAN" becomes dynamic rather than hardwired.

### Current Physical Topology

```
                     Single Trunk Cable
                     (VLANs 10-60 + 100)
                            │
┌───────────────────────────┼───────────────────────────┐
│                           │                           │
│  pFMS Host            VH-113 AP                       │
│  10.0.100.5           10.0.100.2                      │
│  (creates VLAN         (6 GHz WiFi                    │
│   sub-interfaces        to robots,                    │
│   on trunk NIC)         1 SSID per                    │
│                         team/VLAN)                    │
│                                                       │
└───────────────────────────────────────────────────────┘

Field Ethernet jacks ──► UniFi Switch ──► Trunk to pFMS Host
  (DS laptops plug        (each port        (all VLANs
   in here)                assigned to       multiplexed)
                           one VLAN)
```

Today: **Port 1 → VLAN 10, Port 2 → VLAN 20, ...** This is configured statically on the switch.

Desired: **Port 1 → whatever VLAN team X is assigned to**, dynamically.

### Why This Matters

On a practice field, teams swap in and out frequently. Having to physically move cables or manually reconfigure switch ports is friction. If a team can plug into any available port and the system assigns them a radio slot automatically, setup is much faster.

### Three Approaches

#### Approach A: UniFi API Dynamic Port VLAN Assignment

Use the UniFi controller API to dynamically change which VLAN is assigned to each physical switch port.

**How it works:**

1. Team configures their radio (assigns them to radio slot `a`, VLAN 10)
2. Team plugs DS laptop into physical port 3 on the UniFi switch
3. pFMS detects the connection (e.g., via MAC table or LLDP)
4. pFMS calls UniFi API to set port 3's native VLAN to 10
5. DS laptop is now on VLAN 10, can reach robot via radio slot `a`

**Pros:**

- Clean separation — switch handles VLAN tagging at the port level
- Standard networking, no weird bridging
- DS laptop sees a normal untagged network

**Cons:**

- Requires UniFi controller running and accessible (another dependency)
- API latency — VLAN change takes a few seconds to apply
- Need to detect which port a laptop is on (MAC table polling or 802.1X)
- UniFi API has changed across controller versions; may be fragile

**UniFi API notes:**

- The UniFi Controller REST API can set per-port VLAN profiles
- Endpoint: `PUT /api/s/{site}/rest/device/{device_id}` with port override config
- Need: controller URL, credentials, site name, device ID, port index

#### Approach B: Linux Bridge-Based VLAN Bridging

Use Linux bridges on the pFMS host to dynamically connect physical port VLANs to radio VLANs.

**How it works:**

1. Physical switch ports each carry a unique "port VLAN" (e.g., port 1 = VLAN 101, port 2 = VLAN 102, ...)
2. The pFMS host trunk receives both sets of VLANs: radio VLANs (10–60) and port VLANs (101–106)
3. When a team is assigned to radio slot `a` (VLAN 10) and plugs into port 3 (VLAN 103):
   - pFMS creates a Linux bridge: `br-team-X`
   - Adds `eno1.10` (radio VLAN) and `eno1.103` (port VLAN) to the bridge
   - Traffic flows between the two VLANs via the bridge
4. When the team leaves, the bridge is torn down

**Pros:**

- No UniFi controller dependency — pure Linux networking
- Fast — bridge creation is nearly instant
- pFMS already has full control of Linux network stack

**Cons:**

- Requires the switch trunk to carry 12+ VLANs (6 radio + 6 port + management)
- Bridge setup adds complexity to `networkManager.ts`
- Need to manage bridge lifecycle carefully (cleanup on disconnect, restart)
- ARP/DHCP behavior across bridges needs testing
- The pFMS host becomes a L2 bridge, which has different failure modes than L3 routing

**"Steamboat" variant:** If the project uses a dedicated Linux box (sometimes called "steamboat" in FRC contexts) as the network bridge between field-side ports and the radio trunk, the bridging happens on that box instead of the pFMS host. Same Linux bridge approach, different physical location.

#### Approach C: 802.1Q Trunk to DS Laptops + Software Routing

All physical ports are configured as trunks. DS laptops receive tagged VLAN traffic.

**How it works:**

1. All switch ports are configured as trunks carrying all 6 radio VLANs
2. DS laptop must be configured with the correct VLAN sub-interface (or use 802.1X for dynamic assignment)
3. pFMS tells the team which VLAN to use

**Pros:**

- No dynamic switch configuration needed
- No bridging needed

**Cons:**

- Requires VLAN configuration on every DS laptop — major user friction
- FRC teams generally don't configure VLANs on their laptops
- Breaks the "just plug in and go" experience
- **Not recommended for practice fields**

### Recommendation

**Approach A (UniFi API)** is cleanest if there's already a UniFi switch on the field (common in FRC practice setups). It keeps the network architecture simple and doesn't require bridging.

**Approach B (Linux bridge)** is the fallback if there's no UniFi controller or if the switch isn't UniFi. It's more complex but doesn't depend on vendor-specific APIs.

**Approach C** is not practical for practice fields.

### Prerequisite Work Already Done

The Phase 1–4 architecture changes prepare for this:

- `portToSlot` mapping decouples the DS's alliance view from the physical station
- `StationName` identifies a radio slot/VLAN, not a physical port
- The control page (`/control/<ssid>`) is team-centric — users never see physical station names
- `findAvailableStation()` in the radio manager already finds an unoccupied radio slot

What's missing is the **last-mile mapping**: connecting a physical Ethernet jack to the assigned radio VLAN. That's what this problem is about.

### Implementation Sketch (Approach A — UniFi API)

**New module: `src/unifiManager.ts`**

- Connect to UniFi controller via REST API
- `setPortVlan(portIndex: number, vlanId: number)` — assign a native VLAN to a switch port
- `getPortMacTable()` — poll which MAC addresses are on which ports
- `resetPort(portIndex: number)` — return port to default VLAN

**Integration with existing flow:**

1. When a team enables their config on `/control/<ssid>`:
   - `radioManager.configure()` assigns them to radio slot `a` (VLAN 10)
   - Detect which physical port the DS laptop is on (MAC table lookup)
   - Call `unifiManager.setPortVlan(port, 10)` to route that port to VLAN 10
2. When a team disconnects or changes config:
   - Call `unifiManager.resetPort(port)` to return to default

**Environment variables:**

```
UNIFI_CONTROLLER_URL=https://192.168.1.1:8443
UNIFI_USERNAME=admin
UNIFI_PASSWORD=...
UNIFI_SITE=default
UNIFI_SWITCH_MAC=aa:bb:cc:dd:ee:ff
```

### Implementation Sketch (Approach B — Linux Bridge)

**Changes to `src/networkManager.ts`:**

- New function: `bridgePortToVlan(portVlan: number, radioVlan: number)` — creates a Linux bridge connecting two VLAN sub-interfaces
- New function: `unbridgePort(portVlan: number)` — tears down the bridge
- Manage bridge lifecycle (create, monitor, cleanup)

**Switch configuration (one-time):**

- Port 1 → VLAN 101 (untagged)
- Port 2 → VLAN 102 (untagged)
- ...
- Port 6 → VLAN 106 (untagged)
- Trunk uplink → tagged VLANs 10–60, 100–106

**pFMS host trunk now carries:**

- VLANs 10–60 (radio)
- VLANs 101–106 (physical ports)
- VLAN 100 (management)

---

## Relationship Between the Two Problems

These are independent:

- **Problem 1** (rename) is a **code refactor** — changing identifiers from `red1`/`blue3` to neutral names. It's purely about developer/admin clarity. The system works identically before and after.

- **Problem 2** (port decoupling) is a **network architecture change** — making physical Ethernet jacks dynamically assignable to radio VLANs. It adds new functionality.

Problem 1 can be done without Problem 2 and vice versa. However, doing Problem 1 first makes Problem 2 conceptually cleaner — the neutral station names make it obvious that physical slots don't carry alliance meaning.

The `portToSlot` mapping (already implemented) is the **FMS protocol layer** decoupling that sits above both of these. It's already done and working.

```
Layer 3: FMS Protocol    — portToSlot mapping (DONE)
         What the DS sees (alliance position)

Layer 2: Station Naming  — Problem 1
         Internal identifiers for radio slots

Layer 1: Physical Ports  — Problem 2
         Which Ethernet jack maps to which radio VLAN
```

---

## Files to Reference

All paths relative to repo root:

**For Problem 1 (rename):**

- `src/types.ts` — Core type definitions (start here)
- `src/utils.ts` — `prettyStationName()` display formatting
- All files listed in the Problem 1 section above

**For Problem 2 (port decoupling):**

- `src/networkManager.ts` — Current VLAN setup, iptables, interface creation
- `src/radioManager.ts` — Station assignment, `findAvailableStation()`
- `src/index.ts` — Startup wiring, network initialization
- `src/node-ip/backend.ts` — Low-level Linux network operations (`ip link`, `ip addr`, `iptables`)
- `docs/network.md` — Network architecture documentation
- `docs/internals.md` — Startup sequence and network flow
- `docs/robot-tester.md` — VLAN sub-interface documentation

**For context on existing decoupling (Layer 3):**

- `src/matchEngine.ts` — `portToSlot`, `joinStationAlliance()`, `sendDSPacket()`
- `frontend/src/components/ControlPage.tsx` — Team-centric control page
- `frontend/src/components/MatchPanel.tsx` — Join Red/Join Blue UI
