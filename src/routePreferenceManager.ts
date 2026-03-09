import { createBackend, createDryRunBackend } from './node-ip/index.js';
import { StationName, StationNameList } from './types.js';
import { vlanMap } from './networkManager.js';

const net = process.env.DRY_RUN ? createDryRunBackend() : createBackend();

type Preference = {
  station: StationName;
  team: number;
  subnet: string;
};

/** In-memory map of laptopIP → active routing preference */
const preferences = new Map<string, Preference>();

function teamSubnet(team: number): string {
  const high = Math.floor(team / 100);
  const low = team % 100;
  return `10.${high}.${low}.0/24`;
}

export async function setRoutePreference(laptopIp: string, station: StationName, team: number): Promise<void> {
  const subnet = teamSubnet(team);
  const old = preferences.get(laptopIp);

  // Clear map entry first so a partial failure doesn't leave stale data
  preferences.delete(laptopIp);
  if (old) {
    await net.removeIpRule({ from: laptopIp, to: old.subnet, table: vlanMap[old.station] });
  }

  await net.addIpRule({ from: laptopIp, to: subnet, table: vlanMap[station] });
  preferences.set(laptopIp, { station, team, subnet });
}

export async function clearRoutePreference(laptopIp: string): Promise<void> {
  const old = preferences.get(laptopIp);
  if (!old) return;
  await net.removeIpRule({ from: laptopIp, to: old.subnet, table: vlanMap[old.station] });
  preferences.delete(laptopIp);
}

export function getPreference(laptopIp: string): StationName | null {
  return preferences.get(laptopIp)?.station ?? null;
}

/**
 * Called when station configuration changes. Clears preferences for any station
 * whose team has changed (including cleared), since the routing table entries
 * for those stations are being torn down.
 */
export async function onConfigChange(getTeamForStation: (s: StationName) => number | null): Promise<void> {
  for (const [ip, pref] of [...preferences]) {
    const currentTeam = getTeamForStation(pref.station);
    if (currentTeam !== pref.team) {
      await clearRoutePreference(ip);
    }
  }
}

/**
 * Computes which teams are assigned to more than one station.
 * Returns a map of teamNumber → [station1, station2, ...].
 */
export function getConflictingTeams(getTeamForStation: (s: StationName) => number | null): Record<string, StationName[]> {
  const teamToStations = new Map<number, StationName[]>();
  for (const station of StationNameList) {
    const team = getTeamForStation(station);
    if (team === null) continue;
    const existing = teamToStations.get(team) ?? [];
    existing.push(station);
    teamToStations.set(team, existing);
  }

  const result: Record<string, StationName[]> = {};
  for (const [team, stations] of teamToStations) {
    if (stations.length >= 2) result[String(team)] = stations;
  }
  return result;
}

/** Remove all active ip rules (for graceful shutdown). */
export async function cleanupAllPreferences(): Promise<void> {
  for (const ip of [...preferences.keys()]) {
    await clearRoutePreference(ip);
  }
}
