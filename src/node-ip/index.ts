export type { NetworkBackend } from './backend.js';
export type {
  InterfaceInfo,
  InterfaceAddress,
  VlanOptions,
  AddAddressOptions,
  ArpingOptions,
  SysctlOptions,
  IptablesOptions,
  ForwardCounter,
} from './types.js';
export { createBackend } from './platform.js';
export { createLinuxBackend } from './linux.js';
export { createDryRunBackend } from './dryrun.js';
