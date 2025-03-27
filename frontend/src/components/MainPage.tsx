import { useLatest } from '../hooks/useBackend';
import { StationDetails, StationName, Side } from '../../../src/types';
import '../styles/MainPage.css';

interface StationCardProps {
  name: StationName;
  details: StationDetails | undefined;
  side: Side;
}

export function MainPage() {
  const latest = useLatest();

  if (!latest) {
    return <div className="loading">Loading...</div>;
  }

  const { radioStatus } = latest;
  const { stationStatuses } = radioStatus;

  // Group stations by side
  const blueStations = (['blue1', 'blue2', 'blue3'] as const).map(name => ({
    name,
    details: stationStatuses[name] || undefined,
  }));
  const redStations = (['red1', 'red2', 'red3'] as const).map(name => ({
    name,
    details: stationStatuses[name] || undefined,
  }));

  const StationCard = ({ name, details, side }: StationCardProps) => {
    const displayName = `${side[0].toUpperCase()}${side.slice(1)} ${name.slice(-1)}`;

    let content;
    if (!details) {
      content = <p className="status">Status: Unconfigured</p>;
    } else {
      content = (
        <>
          <p className="status">Status: {details.isLinked ? 'Linked' : 'Not Linked'}</p>
          <p className="detail">SSID: {details.ssid || 'None'}</p>
          {details.isLinked && (
            <>
              <p className="detail">MAC Address: {details.macAddress || 'None'}</p>
              <p className="detail">Receive Rate: {details.rxRateMbps} Mbps</p>
              <p className="detail">Bandwidth Used: {details.bandwidthUsedMbps} Mbps</p>
              <p className="detail">Quality: {details.connectionQuality || 'N/A'}</p>
            </>
          )}
        </>
      );
    }

    return (
      <div key={name} className="station-card">
        <h3>{displayName}</h3>
        {content}
      </div>
    );
  };

  return (
    <div className="main-page">
      {radioStatus.status !== 'CONFIGURING' && (
        <div className="station-grid">
          <div className="station-group blue">
            <h2>Blue Alliance Stations</h2>
            <div className="station-group-content">
              {blueStations.map(({ name, details }) => (
                <StationCard key={name} name={name} details={details} side="blue" />
              ))}
            </div>
          </div>

          <div className="station-group red">
            <h2>Red Alliance Stations</h2>
            <div className="station-group-content">
              {redStations.map(({ name, details }) => (
                <StationCard key={name} name={name} details={details} side="red" />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="system-info">
        <h2>System Information</h2>
        <p>Status: {radioStatus.status}</p>
        <p>Version: {radioStatus.version}</p>
        <p>Channel: {radioStatus.channel}</p>
        <p>Bandwidth: {radioStatus.channelBandwidth}</p>
      </div>
    </div>
  );
}
