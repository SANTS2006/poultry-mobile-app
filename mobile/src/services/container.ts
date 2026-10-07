import { API_URL, APP_ENV } from '../config';
import { IS_EXPO_GO } from '../lib/runtime';
import { businessToday } from '../lib/format';
import { HttpSyncTransport, ReferenceCache, SyncEngine, type CachedReference, type OutboxStorage } from '../sync';
import { ApiClient } from './api-client';
import { StorageOutboxGate } from './outbox-gate';
import { deviceHeaders, ExpoNetworkMonitor, ExpoSecureStore, newId, openOutbox } from './platform';
import { PublicApi } from './public-api';
import { SessionManager } from './session-manager';
import { TokenManager } from './token-manager';

export interface Services {
  secure: ExpoSecureStore;
  network: ExpoNetworkMonitor;
  tokens: TokenManager;
  api: ApiClient;
  pub: PublicApi;
  storage: OutboxStorage;
  engine: SyncEngine;
  reference: ReferenceCache;
  /** latest reference data in memory (for offline forms); refreshed by `refreshReference` */
  refData: { current: CachedReference | null };
  session: SessionManager;
  /** false in Expo Go: the on-phone database is plain SQLite */
  dbEncrypted: boolean;
}

let instance: Promise<Services> | null = null;

/** Builds the app's long-lived services once (encrypted database, token store, sync engine). */
export function getServices(): Promise<Services> {
  instance ??= build();
  return instance;
}

/** Loads the cached copy first (instant, works offline), then tries to update it. Never throws for network problems. */
export async function refreshReference(s: Pick<Services, 'reference' | 'refData'>): Promise<CachedReference | null> {
  if (!s.refData.current) s.refData.current = await s.reference.load();
  try {
    s.refData.current = await s.reference.refresh();
  } catch { /* offline or signed out: keep the cached copy */ }
  return s.refData.current;
}

async function build(): Promise<Services> {
  const secure = new ExpoSecureStore();
  const network = new ExpoNetworkMonitor();
  network.start();
  const headers = deviceHeaders();
  const fetchImpl = fetch as unknown as ConstructorParameters<typeof TokenManager>[2];
  const tokens = new TokenManager(secure, API_URL, fetchImpl, headers);
  const api = new ApiClient(API_URL, tokens, fetchImpl, headers);
  const pub = new PublicApi(API_URL, fetchImpl, headers);
  // Production builds refuse to run without SQLCipher; development/staging and Expo Go may, and the UI says so.
  const { storage, encrypted: dbEncrypted } = await openOutbox(secure, APP_ENV === 'production' && !IS_EXPO_GO);
  const transport = new HttpSyncTransport(api);
  const reference = new ReferenceCache(storage, transport);
  const refData: Services['refData'] = { current: await reference.load() };

  const engine = new SyncEngine({
    storage, transport, network, newId,
    // Validation mirrors the server using the last reference data; the server re-validates everything when the record arrives.
    validationContext: () => {
      const r = refData.current;
      const units = Object.fromEntries((r?.units ?? []).map((u) => [u.code, u.eggsPerUnit]));
      const max = r?.settings?.['production.maxEggsPerRecord'];
      return {
        today: businessToday(r?.settings?.['business.timezone'] as string | undefined),
        maxEggsPerRecord: typeof max === 'number' ? max : undefined,
        unitEggs: Object.keys(units).length ? units : undefined,
      };
    },
  });
  const gate = new StorageOutboxGate(storage, engine);
  const session = new SessionManager(secure, tokens, api, pub, gate);
  return { secure, network, tokens, api, pub, storage, engine, reference, refData, session, dbEncrypted };
}
