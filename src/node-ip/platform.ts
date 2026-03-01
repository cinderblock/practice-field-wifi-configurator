import { platform } from 'node:os';
import type { NetworkBackend } from './backend.js';
import { createLinuxBackend } from './linux.js';

export function createBackend(): NetworkBackend {
  switch (platform()) {
    case 'linux':
      return createLinuxBackend();
    default:
      throw new Error(`node-ip: platform "${platform()}" is not supported. Only Linux is implemented.`);
  }
}
