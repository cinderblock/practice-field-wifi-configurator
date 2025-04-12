import { useState } from 'react';
import { useLatest, sendNewConfig } from '../hooks/useBackend';
import { StationName, Side, StatusEntry } from '../../../src/types';
import '../styles/StationPage.css';

interface StationPageProps {
  stationId: StationName;
}

export function StationPage({ stationId }: StationPageProps) {
  const latest = useLatest();
  const [ssid, setSsid] = useState('');
  const [wpaKey, setWpaKey] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  if (!latest) {
    return <div className="loading">Loading...</div>;
  }

  const details = latest.radioStatus.stationStatuses[stationId];
  const side = stationId.slice(0, -1) as Side;
  const sidePretty = side[0].toUpperCase() + side.slice(1);
  const stationNumber = stationId.slice(-1);
  const displayName = `${sidePretty} ${stationNumber}`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setConfiguring(true);
    setConfigError(null);

    try {
      sendNewConfig(stationId, ssid, wpaKey);
    } catch (err) {
      setConfigError('Failed to configure station');
    } finally {
      setConfiguring(false);
    }
  };

  let statusContent;
  if (!details) {
    statusContent = <p>Status: Unconfigured</p>;
  } else {
    statusContent = (
      <>
        <p>Status: {details.isLinked ? 'Linked' : 'Not Linked'}</p>
        <p>SSID: {details.ssid || 'None'}</p>
        {details.isLinked && (
          <>
            <p>MAC Address: {details.macAddress}</p>
            <p>Receive Rate: {details.rxRateMbps} Mbps</p>
            <p>Bandwidth Used: {details.bandwidthUsedMbps} Mbps</p>
            <p>Quality: {details.connectionQuality}</p>
          </>
        )}
      </>
    );
  }

  return (
    <div className="station-page">
      <h1>{displayName} Status</h1>

      <div className="status-card">{statusContent}</div>

      <div className="configuration-form">
        <h2>Configure Station</h2>
        {configError && <p className="error">{configError}</p>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="ssid">SSID:</label>
            <input type="text" id="ssid" value={ssid} onChange={e => setSsid(e.target.value)} required />
          </div>

          <div className="form-group">
            <label htmlFor="wpaKey">WPA Key (optional):</label>
            <input type="text" id="wpaKey" value={wpaKey} onChange={e => setWpaKey(e.target.value)} />
          </div>

          <button type="submit" disabled={configuring}>
            {configuring ? 'Configuring...' : 'Configure Station'}
          </button>
        </form>
      </div>
    </div>
  );
}
