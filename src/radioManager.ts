import { configureNetwork } from './networkManager.js';
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
  Status,
  StatusEntry,
} from './types.js';

type StatusListener = (entry: StatusEntry) => void;

const ReconfigurationTimeout = 45; // seconds

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

  constructor(
    private readonly apiBaseUrl: string,
    private readonly radioManagementInterface?: string,
  ) {
    this.startPolling();
    if (this.radioManagementInterface) {
      console.log('Radio management interface:', this.radioManagementInterface);
    }
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

    console.log(`RadioManager polling started with interval: ${interval}ms`);
  }

  stopPolling() {
    if (!this.updateInterval) return;

    clearInterval(this.updateInterval);
    this.updateInterval = null;

    console.log('RadioManager polling stopped');
  }

  async configure(
    stationId: StationName,
    { ssid, wpaKey, stage }: { ssid: string; wpaKey: string; stage?: boolean },
  ): Promise<void> {
    if (this.configuring) {
      console.log('Already configuring');
      return;
    }

    const config = ssid ? { ssid, wpaKey } : null;

    // console.log('Configuring station:', stationId, config);

    if (config) this.activeConfig[stationId] = config;
    else delete this.activeConfig[stationId];

    // Bail if just staging the change
    if (!stage) await this.commitConfiguration();
  }

  async commitConfiguration(): Promise<void> {
    const config = { stationConfigurations: this.activeConfig };

    // Log the configuration to be sent for debugging
    const sanitizedConfig = JSON.parse(JSON.stringify(config)).stationConfigurations;
    for (const station in sanitizedConfig) if (sanitizedConfig[station]) sanitizedConfig[station].wpaKey &&= '***';
    console.log('Configuring stations:', sanitizedConfig);

    const teamsConfig = {} as Record<StationName, number | undefined>;

    for (const station in this.activeConfig) {
      const { ssid } = this.activeConfig[station as StationName] ?? {};
      if (ssid) teamsConfig[station as StationName] = parseInt(ssid.split('-', 2)[0]) || undefined;
    }

    const jobs: Promise<void>[] = [];

    if (this.radioManagementInterface) {
      jobs.push(configureNetwork(teamsConfig, this.radioManagementInterface));
    }

    jobs.push(this.configureRadio(config));

    await Promise.all(jobs);
  }

  private async configureRadio(config: any) {
    // Patch over a "bug" in the radio that refuses to accept an empty configuration, but will accept a configuration with only the syslog IP address that does what we want
    const PatchBug = true;
    if (
      PatchBug &&
      'stationConfigurations' in config &&
      config.stationConfigurations &&
      Object.keys(config).length === 1 &&
      Object.keys(config.stationConfigurations).length === 0
    ) {
      console.log('No configurations are active, tricking radio to clear all configurations');
      return this.setSyslogIP(this.entries[this.entries.length - 1]?.radioUpdate?.syslogIpAddress ?? '10.0.100.40');
    }

    if (this.configuring) {
      console.log('Already configuring');
      return;
    }

    try {
      this.configuring = true;

      const body = JSON.stringify(config);

      const isConfiguring = this.untilStatusIs('CONFIGURING', 2);

      const response = await fetch(`${this.apiBaseUrl}/configuration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        isConfiguring.catch(() => {});
        throw new Error(`HTTP error! status: ${response.status}. ${await response.text()}`);
      }

      await isConfiguring;

      await this.untilStatusIsNot('CONFIGURING', ReconfigurationTimeout);

      if (!this.isStatus('ACTIVE')) {
        throw new Error(`Radio status is not ACTIVE after configuration. Status: ${this.getStatus()}`);
      }
    } finally {
      this.configuring = false;
    }
  }

  async clearAllConfigurations(): Promise<void> {
    console.log(`Starting to clear all active radio configurations`);

    if (this.configuring) {
      console.log('Already configuring, skipping clear operation');
      return;
    }

    try {
      for (const stationId in this.activeConfig) delete this.activeConfig[stationId as StationName];

      await this.commitConfiguration();

      console.log(`Successfully cleared all radio configurations`);
    } catch (error) {
      console.error(`Error clearing configurations:`, error);
      // Restore the activeConfig state since the clear failed
      // Note: This is a best-effort restoration, but we can't know the exact previous state
      console.warn('Configuration clear failed, radio state may be inconsistent');
    }
  }

  getStatus(): Status | undefined {
    return this.entries[this.entries.length - 1]?.radioUpdate?.status;
  }

  isStatus(status: Status): boolean {
    return this.getStatus() === status;
  }

  async untilStatusIs(status: Status, timeout = 1): Promise<void> {
    const timeoutId = setTimeout(() => {
      throw new Error(`Timeout waiting for status to be ${status}. Is ${this.getStatus()}`);
    }, timeout * 1000);

    // TODO: don't poll our own memory, setup a notifier instead
    while (!this.isStatus(status)) await delay(100);

    clearTimeout(timeoutId);
  }

  async untilStatusIsNot(status: Status, timeout = 1): Promise<void> {
    const timeoutId = setTimeout(() => {
      throw new Error(`Timeout waiting for status to not be ${status}. Is ${this.getStatus()}`);
    }, timeout * 1000);

    // TODO: don't poll our own memory, setup a notifier instead
    while (this.isStatus(status)) await delay(100);

    clearTimeout(timeoutId);
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

  async setSyslogIP(ip: string): Promise<void> {
    return this.configureRadio({ syslogIpAddress: ip });
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
