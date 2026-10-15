import type { CallEndReason, CallStatus } from '@prisma/client';

/**
 * The call life-cycle as a pure function, so every transition rule is in one tested place.
 *   RINGING  --accept (callee)-->            ACCEPTED
 *   RINGING  --reject (callee)-->            ENDED / REJECTED
 *   RINGING  --cancel (caller)-->            ENDED / CANCELLED
 *   RINGING  --timeout-->                    ENDED / MISSED
 *   ACCEPTED --end (caller or callee)-->     ENDED / COMPLETED
 *   ACCEPTED --connection lost / failure-->  ENDED / FAILED
 * Anything else is refused. ENDED is final.
 */
export type CallAction = 'accept' | 'reject' | 'cancel' | 'end' | 'timeout' | 'fail';
export type Role = 'caller' | 'callee';

export interface Transition { to: CallStatus; reason: CallEndReason | null }

export function transition(status: CallStatus, action: CallAction, role: Role | 'system'): Transition | null {
  if (status === 'ENDED') return null;
  if (status === 'RINGING') {
    if (action === 'accept' && role === 'callee') return { to: 'ACCEPTED', reason: null };
    if (action === 'reject' && role === 'callee') return { to: 'ENDED', reason: 'REJECTED' };
    if ((action === 'cancel' || action === 'end') && role === 'caller') return { to: 'ENDED', reason: 'CANCELLED' };
    if (action === 'timeout' && role === 'system') return { to: 'ENDED', reason: 'MISSED' };
    if (action === 'fail') return { to: 'ENDED', reason: 'FAILED' };
    return null;
  }
  // ACCEPTED
  if (action === 'end' && (role === 'caller' || role === 'callee')) return { to: 'ENDED', reason: 'COMPLETED' };
  if (action === 'fail') return { to: 'ENDED', reason: 'FAILED' };
  return null;
}
