import { configureNetwork } from './networkManager';
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
} from './types';

type StatusListener = (entry: StatusEntry) => void;

class RadioManager {
  private updateInterval: NodeJS.Timeout | null = null;
  private connected: boolean = false;
  private configuring = false;
  private scanning: null | Promise<ReadyScanResults> = null;
  private readonly timeout = 1000;
  private readonly pollInterval = 250;
  private readonly historyDuration = Number(process.env.RADIO_HISTORY_DURATION_MS) || 60000; // 60 seconds default
  private entries: StatusEntry[] = [];
  private updateListeners: StatusListener[] = [];
  private activeConfig = {} as Record<StationName, { ssid: string; wpaKey: string }>;

  constructor(private readonly apiBaseUrl: string, private readonly controlNetwork?: string) {
    this.startPolling();
  }

  private updateBusy: boolean = false;

  private async updateStatus(): Promise<void> {
    if (this.updateBusy) {
      // console.log('Update already in progress');
      return;
    }

    this.updateBusy = true;
    const timestamp = Date.now();

    const submit = (radioUpdate?: RadioUpdate) => {
      const entry: StatusEntry = { timestamp, radioUpdate };

      // Add to history and notify listeners
      this.entries.push(entry);

      // Remove old entries
      while (this.entries[0]?.timestamp < timestamp - this.historyDuration) {
        this.entries.shift();
      }

      this.notifyListeners(entry);
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/status`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      this.connected = true;

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

      submit(radioUpdate);
    } catch (error) {
      if (this.connected) {
        console.error('Error fetching radio status:', error);
        this.connected = false;
        submit();
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
        // console.error('Error in polling:', error);
      }
    }, interval);
  }

  stopPolling() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  async configure(stationId: StationName, { ssid, wpaKey }: { ssid: string; wpaKey: string }): Promise<void> {
    if (this.configuring) {
      console.log('Already configuring');
      return;
    }

    this.configuring = true;

    const config = ssid ? { ssid, wpaKey } : null;

    // console.log('Configuring station:', stationId, config);

    if (config) {
      this.activeConfig[stationId] = config;
    } else {
      delete this.activeConfig[stationId];
    }

    const teamsConfig = {} as Record<StationName, number | undefined>;

    for (const station in this.activeConfig) {
      const { ssid } = this.activeConfig[station as StationName];
      if (ssid) teamsConfig[station as StationName] = parseInt(ssid.split('-', 2)[0]) || undefined;
    }

    const network = this.controlNetwork && configureNetwork(teamsConfig, this.controlNetwork);

    const body = JSON.stringify({ stationConfigurations: this.activeConfig });
    console.log('Configuring stations:', body);

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
        throw new Error(`HTTP error! status: ${response.status}. ${await response.text()}`);
      }

      await new Promise<void>(async (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Configuration timed out'));
        }, 45 * 1000);

        // Wait for status to become "CONFIGURING"
        while (this.entries[this.entries.length - 1]?.radioUpdate!.status !== 'CONFIGURING') {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Wait for status to not be "CONFIGURING"
        while (this.entries[this.entries.length - 1]?.radioUpdate?.status === 'CONFIGURING') {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (this.entries[this.entries.length - 1]?.radioUpdate?.status !== 'ACTIVE') {
          console.error('Error configuring station: Radio status is not ACTIVE after configuration');
          throw new Error('Radio status is not ACTIVE after configuration');
        }

        clearTimeout(timeout);
        resolve();
      });
    } finally {
      this.configuring = false;
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

  private static parseShorthand(shorthand: string): string {
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

  private static parseScanResults(response: string): ScanResults {
    const lines = response
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const channels: ChannelScanDetails[] = [];
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
        // cSpell:ignore avil spect
        const regex =
          /^(?<channelFrequency>\d+)\(\s*(?<channel>\d+)\)\s+(?<bss>\d+)\s+(?<minRssi>\d+)\s+(?<maxRssi>\d+)\s+(?<nf>-\d+)\s+(?<chLoad>\d+)\s+(?<spectLoad>\d+)\s+(?<secChan>\d+)\s+(?<srBss>\d+)\s+(?<srLoad>\d+)\s+(?<chAvil>\d+)\s+(?<chanEff>\d+)\s+(?<nearBss>\d+)\s+(?<medBss>\d+)\s+(?<farBss>\d+)\s+(?<effBss>\d+)\s+(?<grade>\d+)\s+(?<rank>\d+)\s+\((?<unused>[^\)]*)\)\s+(?<radar>\d+)$/;

        const groups = line.match(regex)?.groups;
        if (!groups) continue;

        channels.push({
          channel: parseInt(groups.channel, 10) as AllChannels,
          channelFrequency: parseInt(groups.channelFrequency, 10),
          bss: parseInt(groups.bss, 10),
          minRssi: parseInt(groups.minRssi, 10),
          maxRssi: parseInt(groups.maxRssi, 10),
          nf: parseInt(groups.nf, 10),
          channelLoad: parseInt(groups.chLoad, 10),
          spectralLoad: parseInt(groups.spectLoad, 10),
          secondaryChannel: parseInt(groups.secChan, 10),
          spatialReuseBss: parseInt(groups.srBss, 10),
          spatialReuseLoad: parseInt(groups.srLoad, 10),
          channelAvailability: parseInt(groups.chAvil, 10),
          channelEfficiency: parseInt(groups.chanEff, 10),
          nearBss: parseInt(groups.nearBss, 10),
          mediumBss: parseInt(groups.medBss, 10),
          farBss: parseInt(groups.farBss, 10),
          effectiveBss: parseInt(groups.effBss, 10),
          grade: parseInt(groups.grade, 10),
          rank: parseInt(groups.rank, 10),
          unused: groups.unused.split(' ').map(RadioManager.parseShorthand),
          radar: parseInt(groups.radar, 10),
        });
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

    if (!channels.length) {
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
