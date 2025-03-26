import { useState, useEffect } from 'react';
import './App.css';

interface StationStatus {
  isLinked: boolean;
  ssid: string;
  macAddress: string;
  rxRateMbps: number;
  bandwidthUsedMbps: number;
  connectionQuality: string;
}

interface StationPageProps {
  stationId: string;
}

function StationPage({ stationId }: StationPageProps) {
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ssid, setSsid] = useState('');
  const [wpaKey, setWpaKey] = useState('');
  const [configuring, setConfiguring] = useState(false);

  const displayName = `${stationId[0].toUpperCase()}${stationId.slice(1, -1)} ${stationId.slice(-1)}`;

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/station/${stationId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        const data = await response.json();
        setStatus(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch status');
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 1000);
    return () => clearInterval(interval);
  }, [stationId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfiguring(true);
    try {
      const response = await fetch(`/api/station/${stationId}/configure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ssid,
          wpaKey: wpaKey || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to configure station');
      }

      setSsid('');
      setWpaKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to configure station');
    } finally {
      setConfiguring(false);
    }
  };

  return (
    <div className="station-page">
      <h1>{displayName} Status</h1>

      <div className="status-card">
        {status ? (
          <>
            <p>SSID: {status.ssid || 'None'}</p>
            <p>Linked: {status.isLinked ? 'Yes' : 'No'}</p>
            {status.isLinked && (
              <>
                <p>MAC Address: {status.macAddress}</p>
                <p>Receive Rate: {status.rxRateMbps} Mbps</p>
                <p>Bandwidth Used: {status.bandwidthUsedMbps} Mbps</p>
                <p>Quality: {status.connectionQuality}</p>
              </>
            )}
          </>
        ) : error ? (
          <p className="error">{error}</p>
        ) : (
          <p>Loading...</p>
        )}
      </div>

      <div className="configuration-form">
        <h2>Configure Station</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="ssid">SSID:</label>
            <input type="text" id="ssid" value={ssid} onChange={e => setSsid(e.target.value)} required />
          </div>

          <div className="form-group">
            <label htmlFor="wpaKey">WPA Key (optional):</label>
            <input type="password" id="wpaKey" value={wpaKey} onChange={e => setWpaKey(e.target.value)} />
          </div>

          <button type="submit" disabled={configuring}>
            {configuring ? 'Configuring...' : 'Configure Station'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default StationPage;
