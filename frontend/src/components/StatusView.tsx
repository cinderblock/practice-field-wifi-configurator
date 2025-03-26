import React from 'react';
import { Station } from '../types';

interface StatusViewProps {
  stations: Station[];
  systemStatus: string;
  firmwareVersion: string;
  channel: number;
  channelBandwidth: string;
}

export const StatusView: React.FC<StatusViewProps> = ({
  stations,
  systemStatus,
  firmwareVersion,
  channel,
  channelBandwidth,
}) => {
  // Group stations by color
  const blueStations = stations.filter(station => station.color === 'blue');
  const redStations = stations.filter(station => station.color === 'red');

  const StationCard = ({ station }: { station: Station }) => (
    <div key={station.id} className="station-card">
      <h3>{station.name}</h3>
      <p className="status">Linked: {station.linked ? 'true' : 'false'}</p>
      <p className="detail">SSID: {station.ssid || 'None'}</p>
      {station.linked && (
        <>
          <p className="detail">MAC Address: {station.macAddress || 'None'}</p>
          <p className="detail">Receive Rate: {station.receiveRate} Mbps</p>
          <p className="detail">Bandwidth Used: {station.bandwidthUsed} Mbps</p>
          <p className="detail">Quality: {station.quality || 'N/A'}</p>
        </>
      )}
    </div>
  );

  return (
    <div className="status-view">
      {systemStatus !== 'CONFIGURING' && (
        <div className="station-grid">
          <div className="station-group blue">
            <h2>Blue Alliance Stations</h2>
            <div className="station-group-content">
              {blueStations.map(station => (
                <StationCard key={station.id} station={station} />
              ))}
            </div>
          </div>

          <div className="station-group red">
            <h2>Red Alliance Stations</h2>
            <div className="station-group-content">
              {redStations.map(station => (
                <StationCard key={station.id} station={station} />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="system-info">
        <h2>System Information</h2>
        <p>Status: {systemStatus}</p>
        <p>Version: {firmwareVersion}</p>
        <p>Channel: {channel}</p>
        <p>Bandwidth: {channelBandwidth}</p>
      </div>
    </div>
  );
};
