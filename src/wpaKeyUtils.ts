import { createHash } from 'node:crypto';

/** The radio hashes WPA keys as SHA-256(passphrase + salt). */
export function hashWpaKey(passphrase: string, salt: string): string {
  return createHash('sha256')
    .update(passphrase + salt)
    .digest('hex');
}
