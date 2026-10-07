import type { ApiClient } from '../services/api-client';
import type { PushRequest, PushResponse, ReferenceData, SyncTransport } from './types';

export class HttpSyncTransport implements SyncTransport {
  constructor(private readonly api: ApiClient) {}
  push(req: PushRequest): Promise<PushResponse> { return this.api.request<PushResponse>('POST', '/v1/sync/push', req); }
  reference(since?: string): Promise<ReferenceData> { return this.api.request<ReferenceData>('GET', `/v1/sync/reference${since ? `?since=${encodeURIComponent(since)}` : ''}`); }
}
