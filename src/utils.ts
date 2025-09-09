import { StationName } from './types.js';

export function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

export function prettyStationName(station: StationName) {
  const match = station.match(/^(?<alliance>red|blue)(?<station>\d)$/);
  if (!match?.groups) {
    throw new Error(`Invalid station name: ${station}`);
  }

  const { alliance, station: stationNumber } = match.groups;

  return `${capitalizeFirstLetter(alliance)} ${stationNumber}`;
}

export function generateFRCPrefixIP(team: number, end: number | string = '') {
  if (typeof team !== 'number' || !Number.isInteger(team) || team <= 0 || team > 25599) {
    throw new Error(`Invalid team number: ${team}. Must be a positive integer between 1 and 25599`);
  }
  if (typeof end === 'string') {
    if (!/^[0-2]?\d?\d$/.test(end)) {
      throw new Error(`Invalid end string: ${end}. Must be a positive integer between 0 and 255`);
    }
    end = Number.parseInt(end, 10);
  }

  if (typeof end !== 'number' || end < 0 || end > 255) {
    throw new Error(`Invalid end number: ${end}. Must be a positive integer between 0 and 255`);
  }

  const first = Math.floor(team / 100);
  const second = team % 100;

  if (first > 255) {
    throw new Error(`Invalid team number: ${team}. First part of team number must be less than 256`);
  }

  return `10.${first}.${second}.${end}`;
}
