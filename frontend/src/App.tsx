import { useState, useEffect } from 'react';
import { StatusView } from './components/StatusView';
import { Station } from './types';
import './App.css';

function App() {
  const [stations, setStations] = useState<Station[]>([]);
  const [systemStatus, setSystemStatus] = useState('Loading...');
  const [firmwareVersion, setFirmwareVersion] = useState('Unknown');
  const [channel, setChannel] = useState(0);
  const [channelBandwidth, setChannelBandwidth] = useState('Unknown');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/status');
        if (!response.ok) {
          throw new Error('Failed to fetch status');
        }
        const data = await response.json();

        // Transform the data into our station format
        const stationStatuses = data.stationStatuses || {};
        const stations: Station[] = [
          {
            id: 'blue1',
            name: 'Blue 1',
            color: 'blue',
            linked: stationStatuses.blue1?.isLinked || false,
            ssid: stationStatuses.blue1?.ssid || '',
            macAddress: stationStatuses.blue1?.macAddress || '',
            receiveRate: stationStatuses.blue1?.rxRateMbps || 0,
            bandwidthUsed: stationStatuses.blue1?.bandwidthUsedMbps || 0,
            quality: stationStatuses.blue1?.connectionQuality || '',
          },
          {
            id: 'blue2',
            name: 'Blue 2',
            color: 'blue',
            linked: stationStatuses.blue2?.isLinked || false,
            ssid: stationStatuses.blue2?.ssid || '',
            macAddress: stationStatuses.blue2?.macAddress || '',
            receiveRate: stationStatuses.blue2?.rxRateMbps || 0,
            bandwidthUsed: stationStatuses.blue2?.bandwidthUsedMbps || 0,
            quality: stationStatuses.blue2?.connectionQuality || '',
          },
          {
            id: 'blue3',
            name: 'Blue 3',
            color: 'blue',
            linked: stationStatuses.blue3?.isLinked || false,
            ssid: stationStatuses.blue3?.ssid || '',
            macAddress: stationStatuses.blue3?.macAddress || '',
            receiveRate: stationStatuses.blue3?.rxRateMbps || 0,
            bandwidthUsed: stationStatuses.blue3?.bandwidthUsedMbps || 0,
            quality: stationStatuses.blue3?.connectionQuality || '',
          },
          {
            id: 'red1',
            name: 'Red 1',
            color: 'red',
            linked: stationStatuses.red1?.isLinked || false,
            ssid: stationStatuses.red1?.ssid || '',
            macAddress: stationStatuses.red1?.macAddress || '',
            receiveRate: stationStatuses.red1?.rxRateMbps || 0,
            bandwidthUsed: stationStatuses.red1?.bandwidthUsedMbps || 0,
            quality: stationStatuses.red1?.connectionQuality || '',
          },
          {
            id: 'red2',
            name: 'Red 2',
            color: 'red',
            linked: stationStatuses.red2?.isLinked || false,
            ssid: stationStatuses.red2?.ssid || '',
            macAddress: stationStatuses.red2?.macAddress || '',
            receiveRate: stationStatuses.red2?.rxRateMbps || 0,
            bandwidthUsed: stationStatuses.red2?.bandwidthUsedMbps || 0,
            quality: stationStatuses.red2?.connectionQuality || '',
          },
          {
            id: 'red3',
            name: 'Red 3',
            color: 'red',
            linked: stationStatuses.red3?.isLinked || false,
            ssid: stationStatuses.red3?.ssid || '',
            macAddress: stationStatuses.red3?.macAddress || '',
            receiveRate: stationStatuses.red3?.rxRateMbps || 0,
            bandwidthUsed: stationStatuses.red3?.bandwidthUsedMbps || 0,
            quality: stationStatuses.red3?.connectionQuality || '',
          },
        ];

        setStations(stations);
        setSystemStatus(data.status || 'Unknown');
        setFirmwareVersion(data.version || 'Unknown');
        setChannel(data.channel || 0);
        setChannelBandwidth(data.channelBandwidth || 'Unknown');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        setSystemStatus('Error');
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 500); // Refresh every half second

    return () => clearInterval(interval);
  }, []);

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <div className="app">
      <main>
        <StatusView
          stations={stations}
          systemStatus={systemStatus}
          firmwareVersion={firmwareVersion}
          channel={channel}
          channelBandwidth={channelBandwidth}
        />
      </main>
    </div>
  );
}

export default App;
