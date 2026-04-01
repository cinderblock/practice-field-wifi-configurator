import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DEFAULT_FILE = 'admin-auth.json';

interface StoredAuth {
  /** SHA-256 hash of the passphrase + salt. */
  passphraseHash: string;
  /** Random salt used for hashing. */
  salt: string;
  /** Valid session tokens (hashed). Each login creates one; we keep the last N. */
  tokenHashes: string[];
}

const MAX_TOKENS = 20;

/**
 * Manages admin authentication via a single shared passphrase.
 * Passphrase hash and salt are persisted to a JSON file.
 * Session tokens are generated on successful login and stored as hashes.
 */
export class AdminAuth {
  private passphraseHash: string | null = null;
  private salt: string | null = null;
  private tokenHashes = new Set<string>();
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.ADMIN_AUTH_FILE ?? DEFAULT_FILE;
    this.load();
  }

  /** Whether a passphrase has been configured. */
  isConfigured(): boolean {
    return this.passphraseHash !== null;
  }

  /**
   * Set the admin passphrase. Only works if no passphrase is currently set,
   * or if `force` is true (for changing the passphrase while authenticated).
   */
  setPassphrase(passphrase: string, force = false): boolean {
    if (this.passphraseHash && !force) return false;
    if (!passphrase || passphrase.length < 4) return false;

    this.salt = randomBytes(16).toString('hex');
    this.passphraseHash = this.hashPassphrase(passphrase, this.salt);
    // Invalidate all existing tokens when passphrase changes
    this.tokenHashes.clear();
    this.persist();
    return true;
  }

  /**
   * Validate a passphrase and return a session token on success.
   */
  login(passphrase: string): string | null {
    if (!this.passphraseHash || !this.salt) return null;

    const hash = this.hashPassphrase(passphrase, this.salt);
    if (hash !== this.passphraseHash) return null;

    // Generate a session token
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    this.tokenHashes.add(tokenHash);

    // Prune old tokens if we have too many
    if (this.tokenHashes.size > MAX_TOKENS) {
      const arr = [...this.tokenHashes];
      this.tokenHashes = new Set(arr.slice(arr.length - MAX_TOKENS));
    }

    this.persist();
    return token;
  }

  /**
   * Validate a session token.
   */
  validateToken(token: string): boolean {
    if (!token) return false;
    const tokenHash = this.hashToken(token);
    return this.tokenHashes.has(tokenHash);
  }

  private hashPassphrase(passphrase: string, salt: string): string {
    return createHash('sha256')
      .update(passphrase + salt)
      .digest('hex');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed: StoredAuth = JSON.parse(raw);
      if (parsed.passphraseHash && parsed.salt) {
        this.passphraseHash = parsed.passphraseHash;
        this.salt = parsed.salt;
        this.tokenHashes = new Set(parsed.tokenHashes ?? []);
        console.log(`Loaded admin auth from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load admin auth from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const data: StoredAuth = {
        passphraseHash: this.passphraseHash ?? '',
        salt: this.salt ?? '',
        tokenHashes: [...this.tokenHashes],
      };
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save admin auth to ${this.filePath}:`, (err as Error).message);
    }
  }
}
