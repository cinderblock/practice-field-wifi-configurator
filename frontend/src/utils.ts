import { StationName } from '../../src/types';

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
