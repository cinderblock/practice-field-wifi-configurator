# Known Issues & Technical Debt

## `setupWebSocket` parameter sprawl

The `setupWebSocket()` function in `src/websocketServer.ts` now has **21 positional parameters**. The call site in `src/index.ts` is nearly impossible to read — you have to count commas to understand which argument maps to which parameter. Adjacent optional callbacks of compatible types make it easy to accidentally swap arguments.

**Fix:** Refactor to accept an options object:

```ts
interface SetupWebSocketOptions {
  radioManager: RadioManager;
  matchEngine: MatchEngine;
  port: number;
  trustedProxyMatcher?: CIDRMatcher;
  // ...
}
```

Every new feature that adds another callback makes this worse. This is the single highest-impact refactor for maintainability of the WebSocket server wiring.

## `teamSubnet` duplication across files

The `teamSubnet()` function (converting a team number to `"10.TE.AM"` subnet prefix) is exported from `src/teamChecker.ts` but has private copies in:

- `src/robotTestMonitor.ts:693` — `teamSubnetStr()`, identical logic
- `src/subnetScanner.ts:312` — `SubnetScanner.teamSubnet()`, identical logic
- `src/routePreferenceManager.ts:16` — `teamSubnet()`, slight variant (appends `.0/24`)

**Fix:** Consolidate all to use the export from `teamChecker.ts`. The route preference variant could call the shared one and append the CIDR suffix.

## Global hook redundancy in StationStatus

`StationStatus` renders 6 times (once per station). Each instance subscribes to several global hooks (`useLastLinked`, `usePortBridgeState`, `useLatest`, `useMatchState`, `useNetworkStats`, `useSubnetScan`, `useMdnsActivity`, etc.). Any update to these global states causes all 6 instances to re-render and diff their entire subtree, even if only one station's data changed.

This is the established pattern throughout the codebase and isn't a bottleneck at 6 stations with infrequent updates. But if performance ever becomes a concern, the proper fix would be a React context with per-station selectors — a broader refactor, not a one-off fix.

## Per-station firmware/radio configure progress not surfaced in UI

When a firmware update or radio reconfiguration runs through station test port mode, the `StationTestManager` receives per-station progress callbacks from the `RobotTestMonitor`. These are currently no-ops — the inline test port mode UI only shows settling banners (derived from `StationTestState.testState.reconfiguredAt`), not step-by-step progress (e.g., "Uploading firmware... 30%").

To add detailed progress UI to the inline view, we'd need:

1. A per-station progress message type (e.g., `StationFirmwareUpdateProgress`) or embed progress in `StationTestState`
2. Corresponding frontend hooks and UI components
3. Care to avoid conflating with the global test monitor's progress handlers
