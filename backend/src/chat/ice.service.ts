import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env';

export interface IceServer { urls: string[]; username?: string; credential?: string }
const STUN_ONLY: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const TTL_SECONDS = 3600;
const CACHE_MS = 10 * 60_000;

/**
 * ICE servers for WebRTC. With Cloudflare Realtime TURN configured, short-lived TURN credentials are requested from Cloudflare by the
 * SERVER (the API token never reaches a phone) and cached briefly. Without it we fall back to STUN only and say so, because STUN alone
 * does not connect calls across strict NATs or firewalls.
 */
@Injectable()
export class IceService {
  private cache?: { at: number; servers: IceServer[] };

  constructor(@Inject(ConfigService) private readonly config: ConfigService<Env, true>, private readonly logger: PinoLogger) { this.logger.setContext(IceService.name); }

  get turnConfigured(): boolean { return !!(this.config.get('CF_TURN_KEY_ID', { infer: true }) && this.config.get('CF_TURN_API_TOKEN', { infer: true })); }

  async servers(): Promise<{ iceServers: IceServer[]; turn: boolean; ttlSeconds: number }> {
    if (!this.turnConfigured) return { iceServers: STUN_ONLY, turn: false, ttlSeconds: TTL_SECONDS };
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return { iceServers: this.cache.servers, turn: true, ttlSeconds: TTL_SECONDS };
    const keyId = this.config.get('CF_TURN_KEY_ID', { infer: true });
    const token = this.config.get('CF_TURN_API_TOKEN', { infer: true });
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: TTL_SECONDS }),
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const servers = parseIceServers(await res.json());
      if (!servers.length) throw new Error('empty response');
      this.cache = { at: Date.now(), servers };
      return { iceServers: servers, turn: true, ttlSeconds: TTL_SECONDS };
    } catch (e) {
      this.logger.error({ reason: e instanceof Error ? e.message : 'unknown' }, 'Could not get TURN credentials; falling back to STUN only'); // never logs the token
      return { iceServers: STUN_ONLY, turn: false, ttlSeconds: TTL_SECONDS };
    }
  }
}

/** Accepts Cloudflare's `{ iceServers: [...] }` (or a single object) and keeps only well-formed entries. */
export function parseIceServers(body: unknown): IceServer[] {
  const raw = (body as { iceServers?: unknown } | null)?.iceServers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list as { urls?: unknown; username?: unknown; credential?: unknown }[]) {
    const urls = (Array.isArray(s?.urls) ? s.urls : typeof s?.urls === 'string' ? [s.urls] : []).filter((u): u is string => typeof u === 'string' && /^(stun|turn|turns):/.test(u));
    if (!urls.length) continue;
    out.push({ urls, ...(typeof s.username === 'string' ? { username: s.username } : {}), ...(typeof s.credential === 'string' ? { credential: s.credential } : {}) });
  }
  return out;
}
