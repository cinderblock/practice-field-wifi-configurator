import type { InterfaceInfo, VlanOptions, AddAddressOptions, ArpingOptions, SysctlOptions, IptablesOptions, ForwardCounter } from './types.js';

/** OS-agnostic network management backend */
export interface NetworkBackend {
  /** Create a VLAN sub-interface. No-op if it already exists with matching config. */
  createVlan(opts: VlanOptions): Promise<void>;

  /** Delete a network interface. No-op if it does not exist. */
  deleteInterface(name: string): Promise<void>;

  /** Set an interface administratively up. */
  setInterfaceUp(name: string): Promise<void>;

  /** Set an interface administratively down. */
  setInterfaceDown(name: string): Promise<void>;

  /** Add an IP address to an interface. No-op if already present. */
  addAddress(opts: AddAddressOptions): Promise<void>;

  /** Remove an IP address from an interface. No-op if not present. */
  removeAddress(opts: AddAddressOptions): Promise<void>;

  /** Flush all addresses from an interface. */
  flushAddresses(interfaceName: string): Promise<void>;

  /** List all interfaces, or a single interface by name. */
  listInterfaces(name?: string): Promise<InterfaceInfo[]>;

  /** Check whether an interface exists. */
  interfaceExists(name: string): Promise<boolean>;

  /** ARP-based duplicate address detection. Returns true if another host has the IP. */
  arping(opts: ArpingOptions): Promise<boolean>;

  /** Set a sysctl value. */
  setSysctl(opts: SysctlOptions): Promise<void>;

  /** Get a sysctl value. */
  getSysctl(key: string): Promise<string>;

  /** Run an iptables rule operation. Uses -C (check) for idempotent -A (append). */
  iptables(opts: IptablesOptions): Promise<void>;

  /** Delete all iptables rules whose comment contains the given prefix. */
  flushRulesByComment(commentPrefix: string): Promise<void>;

  /** Get packet/byte counters for FORWARD rules matching the comment prefix. */
  getForwardCounters(commentPrefix: string): Promise<ForwardCounter[]>;
}
