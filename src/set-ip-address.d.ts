declare module 'set-ip-address' {
  /**
   * Configures network interfaces based on the provided configurations.
   * @param configs - A single configuration object or an array of configurations.
   * @returns A promise that resolves when the configuration is complete.
   */
  export function configure(configs: NetworkConfig | NetworkConfig[]): Promise<void>;

  /**
   * Restarts the networking service.
   * @returns A promise that resolves when the service is successfully restarted.
   */
  export function restartService(): Promise<void>;

  /**
   * Represents a network configuration.
   */
  export interface NetworkConfig {
    interface: string;
    vlanid?: number;
    bridge_ports?: string[];
    ifname?: string;
    ip_address?: string;
    prefix?: number;
    gateway?: string;
    nameservers?: string[] | string;
    optional?: boolean;
    manual?: boolean;
    bridge_opts?: {
      stp?: boolean;
    };
    provider?: string;
    physical_interface?: string;
  }
}
