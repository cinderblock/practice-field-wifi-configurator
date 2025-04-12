import {
  AdditionalChannelStatistic,
  AllChannels,
  ChannelScanDetails,
  isReadyScanResults,
  isValidRadioUpdate,
  RadioUpdate,
  ReadyScanResults,
  ScanResults,
  StationName,
  StatusEntry,
} from '../src/types';

type StatusListener = (entry: StatusEntry) => void;

class RadioManager {
  private updateInterval: NodeJS.Timeout | null = null;
  private connected: boolean = false;
  private configuring = false;
  private scanning: null | Promise<ReadyScanResults> = null;
  private readonly timeout = 1000;
  private readonly pollInterval = 250;
  private readonly historyDuration = Number(process.env.RADIO_HISTORY_DURATION_MS) || 30000; // 30 seconds default
  private entries: StatusEntry[] = [];
  private updateListeners: StatusListener[] = [];
  private activeConfig = {} as Record<StationName, { ssid: string; wpaKey: string }>;

  constructor(private readonly apiBaseUrl: string) {
    this.startPolling();
  }

  private updateBusy: boolean = false;

  private async updateStatus(): Promise<void> {
    if (this.updateBusy) {
      console.log('Update already in progress');
      return;
    }

    this.updateBusy = true;

    try {
      const response = await fetch(`${this.apiBaseUrl}/status`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      this.connected = true;

      const timestamp = Date.now();

      const radioUpdate: RadioUpdate = await response.json();

      if (!isValidRadioUpdate(radioUpdate)) {
        console.error('Invalid radio status:');
        console.error(radioUpdate);

        throw new Error('Invalid radio status');
      }

      // const lastStatus = this.entries[this.entries.length - 1]?.radioStatus.status;
      // if (lastStatus !== radioStatus.status) {
      //   this.lastStatusChangeTime = timestamp;
      // }

      const entry: StatusEntry = { timestamp, radioUpdate };

      // Add to history and notify listeners
      this.entries.push(entry);
      this.notifyListeners(entry);

      // Remove old entries
      while (this.entries[0]?.timestamp < timestamp - this.historyDuration) {
        this.entries.shift();
      }
    } catch (error) {
      if (this.connected) {
        console.error('Error fetching radio status:', error);
        this.connected = false;
      }
      throw error;
    } finally {
      this.updateBusy = false;
    }
  }

  private notifyListeners(entry: StatusEntry) {
    this.updateListeners.forEach(listener => {
      try {
        listener(entry);
      } catch (error) {
        console.error('Error in status listener:', error);
      }
    });
  }

  startPolling(interval = this.pollInterval) {
    this.stopPolling();

    this.updateInterval = setInterval(async () => {
      try {
        await this.updateStatus();
      } catch (error) {
        console.error('Error in polling:', error);
      }
    }, interval);
  }

  stopPolling() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
  }

  async configure(stationId: StationName, { ssid, wpaKey }: { ssid: string; wpaKey: string }): Promise<void> {
    if (this.configuring) {
      console.log('Already configuring');
      return;
    }

    this.configuring = true;

    console.log('Configuring station:', stationId, { ssid, wpaKey });

    this.activeConfig[stationId] = { ssid, wpaKey };

    const stationConfigurations = this.activeConfig;

    const body = JSON.stringify({ stationConfigurations });
    console.log('Configuring station:', body);

    try {
      const response = await fetch(`${this.apiBaseUrl}/configuration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        // console.error('Error configuring station:', response);
        if (response.status === 400) {
          console.error('Error configuring station:', await response.text());
        } else {
          throw new Error(`HTTP error! status: ${response.status}. ${await response.text()}`);
        }
      }

      // Wait for status to become "CONFIGURING"
      while (this.entries[this.entries.length - 1]?.radioUpdate.status !== 'CONFIGURING') {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (this.entries[this.entries.length - 1]?.radioUpdate.status !== 'ACTIVE') {
        console.error('Error configuring station: Radio status is not ACTIVE after configuration');
        throw new Error('Radio status is not ACTIVE after configuration');
      }

      this.configuring = false;
    } catch (error) {
      if (this.connected) {
        this.connected = false;
      }
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatusHistory(): StatusEntry[] {
    return [...this.entries]; // Return a copy to prevent external modification
  }

  addStatusListener(listener: StatusListener): () => void {
    this.updateListeners.push(listener);
    return () => this.updateListeners.splice(this.updateListeners.indexOf(listener), 1);
  }

  private static parseScanResults(response: string): ScanResults {
    const lines = response
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const channels = {} as Record<AllChannels, ChannelScanDetails>;
    const additionalStatistics: AdditionalChannelStatistic[] = [];

    let parsingChannels = false;
    let parsingAdditionalStats = false;

    let progressDots = 0;

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('-')) continue;
      if (line.startsWith('The number of channels scanned for scan report is:')) {
        const match = line.match(/^The number of channels scanned for scan report is:\s*(\d+)$/);
        if (match) {
          const numChannels = parseInt(match[1], 10);
          if (numChannels > 0) {
            console.log(`Number of channels scanned: ${numChannels}`);
          }
        }
        continue;
      }

      if (line === '.') {
        progressDots++;
        continue;
      }

      if (line.startsWith('Channel |')) {
        parsingChannels = true;
        parsingAdditionalStats = false;
        continue;
      }

      if (line.startsWith('Index |')) {
        parsingChannels = false;
        parsingAdditionalStats = true;
        continue;
      }

      if (parsingChannels) {
        const regex =
          /^(?<channelFrequency>\d+)\(\s*(?<channel>\d+)\)\s+(?<bss>\d+)\s+(?<minRssi>\d+)\s+(?<maxRssi>\d+)\s+(?<nf>-\d+)\s+(?<chLoad>\d+)\s+(?<spectLoad>\d+)\s+(?<secChan>\d+)\s+(?<srBss>\d+)\s+(?<srLoad>\d+)\s+(?<chAvil>\d+)\s+(?<chanEff>\d+)\s+(?<nearBss>\d+)\s+(?<medBss>\d+)\s+(?<farBss>\d+)\s+(?<effBss>\d+)\s+(?<grade>\d+)\s+(?<rank>\d+)\s+\((?<unused>[^\)]*)\)\s+(?<radar>\d+)$/;

        const groups = line.match(regex)?.groups;
        if (!groups) continue;

        const channel = parseInt(groups.channel, 10) as AllChannels;

        channels[channel] = { unused: [] as string[] } as ChannelScanDetails;

        function parseShorthand(shorthand: string): string {
          const table = {
            SC: 'Secondary Channel',
            WR: 'Weather Radar',
            DFS: 'DFS Channel',
            HN: 'High Noise',
            RS: 'Low RSSI',
            CL: 'High Channel Load',
            RP: 'Regulatory Power',
            N2G: 'Not selected 2G',
            P80X: 'Primary 80X80',
            NS80X: 'Only for primary 80X80',
            NP80X: 'Only for Secondary 80X80',
            SR: 'Spacial reuse',
            NF: 'Run-time average NF_dBr',
          } as Record<string, string>;
          if (shorthand in table) {
            return shorthand + ': ' + table[shorthand];
          }

          return shorthand;
        }

        for (const key in groups) {
          const k = key as keyof ChannelScanDetails;

          if (k === 'unused') {
            channels[channel][k] = groups[key].split(' ').map(parseShorthand);
          } else {
            channels[channel][k] = parseInt(groups[key], 10);
          }
        }
      }

      if (parsingAdditionalStats) {
        const regex =
          /^(?<index>\d+)\s+(?<channel>\d+)\s+(?<nbss>\d+)\s+(?<ssid>\S.*?)\s+(?<bssid>[^\s]+)\s+(?<rssi>-?\d+)\s+(?<phyMode>\d+)$/;

        const groups = line.match(regex)?.groups;
        if (!groups) continue;

        additionalStatistics.push({
          index: parseInt(groups.index, 10),
          channel: parseInt(groups.channel, 10) as AllChannels,
          nbss: parseInt(groups.nbss, 10),
          ssid: groups.ssid,
          bssid: groups.bssid,
          rssi: parseInt(groups.rssi, 10),
          phyMode: parseInt(groups.phyMode, 10),
        });
      }
    }

    if (!channels[1]) {
      return { progressDots };
    }

    return { channels, additionalStatistics };
  }

  async scan(): Promise<ReadyScanResults> {
    return (this.scanning ??= this.doScan().finally(() => (this.scanning = null)));
  }

  private async doScan(): Promise<ReadyScanResults> {
    // Start the scan
    const startResponse = await fetch(`${this.apiBaseUrl}/scan/start`, {
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!startResponse.ok) {
      throw new Error(`Failed to start scan: ${startResponse.statusText}`);
    }

    // Poll for scan results
    while (true) {
      const resultResponse = await fetch(`${this.apiBaseUrl}/scan/result`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!resultResponse.ok) {
        throw new Error(`Failed to fetch scan results: ${resultResponse.statusText}`);
      }

      const responseText = await resultResponse.text();
      const scanResults = RadioManager.parseScanResults(responseText);

      if (isReadyScanResults(scanResults)) {
        return scanResults;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }
  }
}

export default RadioManager;
