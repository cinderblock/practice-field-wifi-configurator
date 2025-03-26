export interface Station {
  id: string;
  name: string;
  color: 'red' | 'blue';
  linked: boolean;
  ssid: string;
  macAddress: string;
  receiveRate: number;
  bandwidthUsed: number;
  quality: string;
}
