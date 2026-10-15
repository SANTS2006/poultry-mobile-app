import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { userRoom } from './topics';

/**
 * The only way other modules (chat, calls) push events to connected phones. Events go to per-user rooms chosen by the SERVER after it has
 * checked who may receive them; clients can never join someone else's room. Also tracks who is connected (presence).
 */
@Injectable()
export class RealtimeEmitter {
  server?: Server;
  private readonly online = new Map<string, number>();

  toUsers(userIds: Iterable<string>, event: string, payload: unknown): void {
    if (!this.server) return;
    for (const id of new Set(userIds)) this.server.to(userRoom(id)).emit(event, payload);
  }

  /** Returns true when this is the user's first connection (they just came online). */
  connected(userId: string): boolean { const n = (this.online.get(userId) ?? 0) + 1; this.online.set(userId, n); return n === 1; }
  /** Returns true when this was the user's last connection (they just went offline). */
  disconnected(userId: string): boolean {
    const n = (this.online.get(userId) ?? 1) - 1;
    if (n <= 0) { this.online.delete(userId); return true; }
    this.online.set(userId, n);
    return false;
  }
  isOnline(userId: string): boolean { return (this.online.get(userId) ?? 0) > 0; }
  onlineIds(): string[] { return [...this.online.keys()]; }
}
