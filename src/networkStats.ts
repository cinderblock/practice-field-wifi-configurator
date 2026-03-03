import type { NetworkBackend } from './node-ip/index.js';
import type { NetworkStats, StationName, StationNetworkStats } from './types.js';
import { StationNameList } from './types.js';

/**
 * Query iptables FORWARD counters and map them to per-station rx/tx stats.
 *
 * Comment conventions from networkManager:
 *   - `<prefix>fwd-<station>`    → inInterface = VLAN iface → packets FROM robot
 *   - `<prefix>fwd-in-<station>` → outInterface = VLAN iface → packets TO robot
 */
export async function buildNetworkStats(net: NetworkBackend, commentPrefix: string): Promise<NetworkStats> {
  const counters = await net.getForwardCounters(commentPrefix);

  const stations: Partial<Record<StationName, StationNetworkStats>> = {};

  for (const station of StationNameList) {
    const fwdOut = counters.find(c => c.comment === `${commentPrefix}fwd-${station}`);
    const fwdIn = counters.find(c => c.comment === `${commentPrefix}fwd-in-${station}`);

    if (!fwdOut && !fwdIn) continue;

    stations[station] = {
      rxPackets: fwdOut?.packets ?? 0,
      rxBytes: fwdOut?.bytes ?? 0,
      txPackets: fwdIn?.packets ?? 0,
      txBytes: fwdIn?.bytes ?? 0,
    };
  }

  return { type: 'networkStats', stations };
}
