import { isValidRadioUpdate, RadioUpdate, StationName, StatusEntry } from '../src/types';

type StatusListener = (entry: StatusEntry) => void;

class RadioManager {
  private updateInterval: NodeJS.Timeout | null = null;
  private connected: boolean = false;
  private configuring = false;
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
}

export default RadioManager;
