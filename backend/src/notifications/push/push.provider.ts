export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** deep-link facts only (ids/types): never amounts, names or other business data */
  data: Record<string, string>;
  channelId: string;
  priority: 'default' | 'high';
}

export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; error: string; message?: string };
export type PushReceipt = { status: 'ok' } | { status: 'error'; error: string; message?: string };

/** Raised when the provider itself could not be reached (network/5xx). The in-app notification still exists. */
export class PushTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'PushTransportError'; }
}

export interface PushProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
}

/** Expo push tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[xxxx]). */
export const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,60}\]$/;
