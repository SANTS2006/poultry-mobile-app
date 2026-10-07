import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Network from 'expo-network';
import * as SecureStorage from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { SqliteOutboxStorage, type NetworkMonitor, type SqlDriver } from '../sync';
import type { SecureStore } from './token-manager';

/** Keychain (iOS) / Keystore-backed storage (Android). Items are readable only while the device is unlocked and never leave this device. */
export class ExpoSecureStore implements SecureStore {
  private readonly opts = { keychainAccessible: SecureStorage.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  get(key: string) { return SecureStorage.getItemAsync(key, this.opts); }
  set(key: string, value: string) { return SecureStorage.setItemAsync(key, value, this.opts); }
  delete(key: string) { return SecureStorage.deleteItemAsync(key, this.opts); }
}

export const newId = (): string => Crypto.randomUUID();

export function deviceHeaders(): Record<string, string> {
  return { 'x-device-name': (Device.deviceName ?? Device.modelName ?? 'unknown device').slice(0, 80), 'x-platform': Platform.OS };
}

export interface OpenedDatabase { driver: SqlDriver; encrypted: boolean }

/**
 * Opens the local database. In a development/store build the file is encrypted with SQLCipher; the random key is generated on first run and
 * kept only in the secure store. Plain SQLite (e.g. Expo Go) silently ignores `PRAGMA key`, so we ASK the engine whether SQLCipher is present
 * (`PRAGMA cipher_version` answers only under SQLCipher) and report it instead of assuming.
 */
export async function openEncryptedDatabase(secure: SecureStore, name = 'makarifor.db'): Promise<OpenedDatabase> {
  let key = await secure.get('db.key');
  if (!key) {
    key = Array.from(Crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    await secure.set('db.key', key);
  }
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync(`PRAGMA key = "x'${key}'"`);
  const version = await db.getAllAsync<Record<string, unknown>>('PRAGMA cipher_version').catch(() => []);
  await db.execAsync('PRAGMA journal_mode = WAL');
  const params = (p?: (string | number | null)[]) => p ?? [];
  return {
    encrypted: version.length > 0,
    driver: {
      async run(sql, p) { await db.runAsync(sql, params(p)); },
      all<T>(sql: string, p?: (string | number | null)[]) { return db.getAllAsync<T & object>(sql, params(p)) as Promise<T[]>; },
    },
  };
}

export async function openOutbox(secure: SecureStore, requireEncryption: boolean): Promise<{ storage: SqliteOutboxStorage; encrypted: boolean }> {
  const { driver, encrypted } = await openEncryptedDatabase(secure);
  // Real builds must never silently fall back to a plain-text database holding financial records.
  if (requireEncryption && !encrypted) throw new Error('This build cannot encrypt the local database (SQLCipher is missing). Refusing to store business data unencrypted.');
  const storage = new SqliteOutboxStorage(driver);
  await storage.init();
  return { storage, encrypted };
}

/** Online/offline from the OS network state. "Online" only means a network exists; the sync engine still handles failures. */
export class ExpoNetworkMonitor implements NetworkMonitor {
  private online = true;
  private listeners = new Set<(o: boolean) => void>();
  private started = false;

  isOnline() { return this.online; }

  subscribe(l: (o: boolean) => void) {
    this.start();
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private set(o: boolean) {
    if (o === this.online) return;
    this.online = o;
    this.listeners.forEach((l) => l(o));
  }

  start() {
    if (this.started) return;
    this.started = true;
    void Network.getNetworkStateAsync().then((s) => this.set(Boolean(s.isConnected && s.isInternetReachable !== false))).catch(() => undefined);
    Network.addNetworkStateListener((s) => this.set(Boolean(s.isConnected && s.isInternetReachable !== false)));
  }
}
