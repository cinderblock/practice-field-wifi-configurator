import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkBackend } from './backend.js';
import type {
  InterfaceInfo,
  InterfaceAddress,
  VlanOptions,
  AddAddressOptions,
  SysctlOptions,
  IptablesOptions,
} from './types.js';

const execFile = promisify(execFileCb);

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(command, args);
  return stdout;
}

async function ip(...args: string[]): Promise<string> {
  return run('ip', args);
}

async function ipJson<T>(...args: string[]): Promise<T> {
  const out = await ip('-j', ...args);
  return JSON.parse(out || '[]');
}

interface IpAddrEntry {
  ifname: string;
  operstate: string;
  mtu: number;
  address?: string;
  link?: string;
  linkinfo?: {
    info_kind?: string;
    info_data?: { id?: number };
  };
  addr_info: Array<{
    family: string;
    local: string;
    prefixlen: number;
    broadcast?: string;
    scope?: string;
  }>;
}

function parseInterfaceInfo(entry: IpAddrEntry): InterfaceInfo {
  return {
    name: entry.ifname,
    state: entry.operstate ?? 'UNKNOWN',
    mtu: entry.mtu,
    mac: entry.address,
    addresses: (entry.addr_info ?? []).map(
      (a): InterfaceAddress => ({
        family: a.family as 'inet' | 'inet6',
        address: a.local,
        prefixLength: a.prefixlen,
        broadcast: a.broadcast,
        scope: a.scope,
      }),
    ),
    link:
      entry.linkinfo?.info_kind || entry.link
        ? {
            kind: entry.linkinfo?.info_kind,
            parent: entry.link,
            vlanId: entry.linkinfo?.info_data?.id,
          }
        : undefined,
  };
}

function isExecError(err: unknown): err is Error & { stderr: string } {
  return err instanceof Error && 'stderr' in err;
}

export function createLinuxBackend(): NetworkBackend {
  const backend: NetworkBackend = {
    async createVlan(opts: VlanOptions): Promise<void> {
      if (opts.name.length > 15) {
        throw new Error(`Interface name "${opts.name}" exceeds 15 character Linux limit`);
      }

      if (await backend.interfaceExists(opts.name)) {
        const [info] = await backend.listInterfaces(opts.name);
        if (info?.link?.kind === 'vlan' && info?.link?.parent === opts.parent && info?.link?.vlanId === opts.vlanId) {
          return;
        }
        await backend.deleteInterface(opts.name);
      }

      await ip('link', 'add', 'link', opts.parent, 'name', opts.name, 'type', 'vlan', 'id', String(opts.vlanId));
    },

    async deleteInterface(name: string): Promise<void> {
      if (!(await backend.interfaceExists(name))) return;
      await ip('link', 'delete', name);
    },

    async setInterfaceUp(name: string): Promise<void> {
      await ip('link', 'set', name, 'up');
    },

    async setInterfaceDown(name: string): Promise<void> {
      await ip('link', 'set', name, 'down');
    },

    async addAddress(opts: AddAddressOptions): Promise<void> {
      try {
        const cidr = `${opts.address}/${opts.prefixLength}`;
        const args = ['addr', 'add', cidr, 'dev', opts.interfaceName];
        if (opts.broadcast) args.push('broadcast', opts.broadcast);
        await ip(...args);
      } catch (err: unknown) {
        if (isExecError(err) && err.stderr.includes('File exists')) return;
        throw err;
      }
    },

    async removeAddress(opts: AddAddressOptions): Promise<void> {
      try {
        const cidr = `${opts.address}/${opts.prefixLength}`;
        await ip('addr', 'del', cidr, 'dev', opts.interfaceName);
      } catch (err: unknown) {
        if (isExecError(err) && err.stderr.includes('Cannot assign requested address')) return;
        if (isExecError(err) && err.stderr.includes('does not exist')) return;
        throw err;
      }
    },

    async flushAddresses(interfaceName: string): Promise<void> {
      await ip('addr', 'flush', 'dev', interfaceName);
    },

    async listInterfaces(name?: string): Promise<InterfaceInfo[]> {
      const args = ['-d', 'addr', 'show'];
      if (name) args.push('dev', name);
      const entries = await ipJson<IpAddrEntry[]>(...args);
      return entries.map(parseInterfaceInfo);
    },

    async interfaceExists(name: string): Promise<boolean> {
      try {
        await ip('link', 'show', name);
        return true;
      } catch {
        return false;
      }
    },

    async setSysctl(opts: SysctlOptions): Promise<void> {
      await run('sysctl', ['-w', `${opts.key}=${opts.value}`]);
    },

    async getSysctl(key: string): Promise<string> {
      const out = await run('sysctl', ['-n', key]);
      return out.trim();
    },

    async iptables(opts: IptablesOptions): Promise<void> {
      function buildArgs(action: string): string[] {
        const args = ['-t', opts.table ?? 'filter', action, opts.chain];
        if (opts.source) args.push('-s', opts.source);
        if (opts.notDestination) args.push('!', '-d', opts.notDestination);
        if (opts.outInterface) args.push('-o', opts.outInterface);
        args.push('-j', opts.jump);
        if (opts.comment) args.push('-m', 'comment', '--comment', opts.comment);
        return args;
      }

      if (opts.action === '-A' || opts.action === '-I') {
        // Idempotent: check first, skip if already exists
        try {
          await run('iptables', buildArgs('-C'));
          return; // Rule already exists
        } catch {
          // Rule doesn't exist, proceed to add
        }
      }

      if (opts.action === '-D') {
        // Idempotent: check first, skip if doesn't exist
        try {
          await run('iptables', buildArgs('-C'));
        } catch {
          return; // Rule doesn't exist, nothing to delete
        }
      }

      await run('iptables', buildArgs(opts.action));
    },
  };

  return backend;
}
