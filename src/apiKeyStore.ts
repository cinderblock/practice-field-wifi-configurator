import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ApiKeyEntry, ApiKeySummary, ApiKeyState, PendingDevice } from './types.js';

const DEFAULT_FILE = 'api-keys.json';
const KEY_LENGTH = 32; // 32 bytes = 64 hex chars
const PENDING_DEVICE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const PENDING_DEVICE_MAX_COUNT = 50;
/** Persist usage metadata (lastUsedAt, requestCount) every N requests per key. */
const USAGE_PERSIST_INTERVAL = 10;

/**
 * Manages API keys for the scoring HTTP API.
 * Keys are stored in-memory with JSON file persistence.
 * Pending (unapproved) devices are tracked in-memory only.
 */
export class ApiKeyStore {
  /** Active keys indexed by the full key string for O(1) auth lookup. */
  private keysByValue = new Map<string, ApiKeyEntry>();
  /** Keys indexed by their short ID for admin operations. */
  private keysById = new Map<string, ApiKeyEntry>();
  /** Pending (unapproved) devices that attempted to use the scoring API. */
  private pendingDevices = new Map<string, PendingDevice>();
  private filePath: string;
  private listeners: ((state: ApiKeyState) => void)[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.API_KEYS_FILE ?? DEFAULT_FILE;
    this.load();
  }

  // ── Key Generation ──────────────────────────────────────────────────

  /** Generate a cryptographically random API key (64 hex chars). */
  private generateKey(): string {
    return randomBytes(KEY_LENGTH).toString('hex');
  }

  /** Derive the short display ID from a key (first 8 hex chars). */
  private keyToId(key: string): string {
    return key.slice(0, 8);
  }

  /** Mask a key for safe display: first 8 chars + "..." */
  private maskKey(key: string): string {
    return key.slice(0, 8) + '...';
  }

  // ── CRUD Operations ─────────────────────────────────────────────────

  /** Create a new API key with the given label. Returns the full entry (including key). */
  createKey(label: string): ApiKeyEntry {
    let key: string;
    let id: string;
    // Ensure ID uniqueness (astronomically unlikely to collide, but be safe)
    do {
      key = this.generateKey();
      id = this.keyToId(key);
    } while (this.keysById.has(id));

    const entry: ApiKeyEntry = {
      id,
      key,
      label,
      status: 'active',
      createdAt: Date.now(),
      requestCount: 0,
    };
    this.keysByValue.set(key, entry);
    this.keysById.set(id, entry);
    this.persist();
    this.notifyListeners();
    return entry;
  }

  /** Revoke an active API key. Returns true if the key was found and revoked. */
  revokeKey(id: string): boolean {
    const entry = this.keysById.get(id);
    if (!entry || entry.status !== 'active') return false;
    entry.status = 'revoked';
    this.persist();
    this.notifyListeners();
    return true;
  }

  /** Reactivate a revoked API key. Returns true if the key was found and reactivated. */
  reactivateKey(id: string): boolean {
    const entry = this.keysById.get(id);
    if (!entry || entry.status !== 'revoked') return false;
    entry.status = 'active';
    this.persist();
    this.notifyListeners();
    return true;
  }

  /** Permanently delete an API key. Returns true if the key was found and deleted. */
  deleteKey(id: string): boolean {
    const entry = this.keysById.get(id);
    if (!entry) return false;
    this.keysById.delete(id);
    this.keysByValue.delete(entry.key);
    this.persist();
    this.notifyListeners();
    return true;
  }

  // ── Auth Validation ─────────────────────────────────────────────────

  /** Whether any active keys exist (i.e. whether authentication is required). */
  hasAnyActiveKeys(): boolean {
    for (const entry of this.keysById.values()) {
      if (entry.status === 'active') return true;
    }
    return false;
  }

  /**
   * Validate a key presented in a scoring API request.
   * Returns the entry if valid, null if invalid/revoked/missing.
   * Updates usage metadata on success.
   */
  validateKey(key: string, sourceIp?: string, userAgent?: string): ApiKeyEntry | null {
    const entry = this.keysByValue.get(key);
    if (!entry || entry.status !== 'active') return null;

    // Update usage metadata
    entry.lastUsedAt = Date.now();
    entry.requestCount++;
    if (sourceIp) entry.lastSourceIp = sourceIp;
    if (userAgent) entry.lastUserAgent = userAgent;

    // Persist periodically to avoid excessive disk writes on every score event
    if (entry.requestCount % USAGE_PERSIST_INTERVAL === 0) this.persist();

    this.notifyListeners();
    return entry;
  }

  // ── Pending Device Management ───────────────────────────────────────

  /** Record a rejected auth attempt for auto-discovery. De-duplicates by source IP. */
  recordPendingDevice(sourceIp: string, userAgent?: string, presentedKey?: string, path?: string): void {
    // Update existing entry for this IP if present
    for (const device of this.pendingDevices.values()) {
      if (device.sourceIp === sourceIp) {
        device.lastSeen = Date.now();
        device.requestCount++;
        if (path) device.lastPath = path;
        if (userAgent) device.userAgent = userAgent;
        if (presentedKey) device.presentedKey = this.maskKey(presentedKey);
        this.notifyListeners();
        return;
      }
    }

    // Prune old entries before adding a new one
    this.pruneOldPendingDevices();

    const id = `pending-${Date.now()}-${randomBytes(4).toString('hex')}`;
    this.pendingDevices.set(id, {
      id,
      sourceIp,
      userAgent,
      presentedKey: presentedKey ? this.maskKey(presentedKey) : undefined,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      requestCount: 1,
      lastPath: path,
    });
    this.notifyListeners();
  }

  /** Approve a pending device: creates a new key for it and removes from pending. */
  approveDevice(pendingId: string, label: string): ApiKeyEntry | null {
    const device = this.pendingDevices.get(pendingId);
    if (!device) return null;

    const entry = this.createKey(label); // createKey already persists + notifies
    entry.discoveredFromIp = device.sourceIp;
    this.pendingDevices.delete(pendingId);
    this.persist();
    this.notifyListeners();
    return entry;
  }

  /** Dismiss/reject a pending device. */
  dismissDevice(pendingId: string): boolean {
    const removed = this.pendingDevices.delete(pendingId);
    if (removed) this.notifyListeners();
    return removed;
  }

  // ── State & Listeners ───────────────────────────────────────────────

  /** Get the full broadcast state (safe for sending to all admin clients). */
  getState(): ApiKeyState {
    return {
      type: 'apiKeyState',
      keys: [...this.keysById.values()].map(e => this.toSummary(e)),
      pendingDevices: [...this.pendingDevices.values()],
      authRequired: this.hasAnyActiveKeys(),
    };
  }

  /** Convert an entry to a safe summary (full key never included). */
  private toSummary(entry: ApiKeyEntry): ApiKeySummary {
    return {
      id: entry.id,
      keyPreview: this.maskKey(entry.key),
      label: entry.label,
      status: entry.status,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      requestCount: entry.requestCount,
      lastSourceIp: entry.lastSourceIp,
      lastUserAgent: entry.lastUserAgent,
    };
  }

  /** Register a listener for state changes. Returns an unsubscribe function. */
  addListener(fn: (state: ApiKeyState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notifyListeners(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in ApiKeyStore listener:', err);
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry?.id === 'string' && typeof entry?.key === 'string' && typeof entry?.label === 'string') {
            const restored: ApiKeyEntry = {
              id: entry.id,
              key: entry.key,
              label: entry.label,
              status: entry.status === 'revoked' ? 'revoked' : 'active',
              createdAt: entry.createdAt ?? Date.now(),
              lastUsedAt: entry.lastUsedAt,
              requestCount: entry.requestCount ?? 0,
              lastSourceIp: entry.lastSourceIp,
              lastUserAgent: entry.lastUserAgent,
              discoveredFromIp: entry.discoveredFromIp,
            };
            this.keysById.set(restored.id, restored);
            this.keysByValue.set(restored.key, restored);
          }
        }
        console.log(`Loaded ${this.keysById.size} API key(s) from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load API keys from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      const data = JSON.stringify([...this.keysById.values()], null, 2);
      writeFileSync(this.filePath, data, 'utf-8');
    } catch (err) {
      console.error(`Failed to save API keys to ${this.filePath}:`, (err as Error).message);
    }
  }

  private pruneOldPendingDevices(): void {
    const now = Date.now();
    for (const [id, device] of this.pendingDevices) {
      if (now - device.lastSeen > PENDING_DEVICE_MAX_AGE) {
        this.pendingDevices.delete(id);
      }
    }
    // Cap at max count (remove oldest first)
    if (this.pendingDevices.size >= PENDING_DEVICE_MAX_COUNT) {
      const sorted = [...this.pendingDevices.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      while (sorted.length >= PENDING_DEVICE_MAX_COUNT) {
        const oldest = sorted.shift()!;
        this.pendingDevices.delete(oldest[0]);
      }
    }
  }
}
