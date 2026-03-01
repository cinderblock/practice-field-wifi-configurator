/** Represents an address on an interface */
export interface InterfaceAddress {
  family: 'inet' | 'inet6';
  address: string;
  prefixLength: number;
  broadcast?: string;
  scope?: string;
}

/** Represents the state of a network interface */
export interface InterfaceInfo {
  name: string;
  state: 'UP' | 'DOWN' | 'UNKNOWN' | string;
  mtu: number;
  mac?: string;
  addresses: InterfaceAddress[];
  link?: {
    kind?: string;
    parent?: string;
    vlanId?: number;
  };
}

/** Options for creating a VLAN sub-interface */
export interface VlanOptions {
  parent: string;
  vlanId: number;
  name: string;
}

/** Options for adding/removing an IP address */
export interface AddAddressOptions {
  interfaceName: string;
  address: string;
  prefixLength: number;
  broadcast?: string;
}

/** Options for sysctl settings */
export interface SysctlOptions {
  key: string;
  value: string;
}

/** Options for iptables rule manipulation */
export interface IptablesOptions {
  action: '-A' | '-D' | '-I' | '-C';
  table?: string;
  chain: string;
  source?: string;
  notDestination?: string;
  outInterface?: string;
  jump: string;
  comment?: string;
}
