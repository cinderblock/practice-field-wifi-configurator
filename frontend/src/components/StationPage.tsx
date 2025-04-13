import { StationName } from '../../../src/types';
import StationStatus from './StationStatus';

export function StationPage({ station }: { station: StationName }) {
  return <StationStatus full station={station} />;
}
