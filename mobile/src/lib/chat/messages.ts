import type { ChatMessage, ConversationMember, DeliveryStatus, PendingMessage } from './types';

export type TimelineItem =
  | { type: 'message'; key: string; message: ChatMessage }
  | { type: 'pending'; key: string; pending: PendingMessage }
  | { type: 'day'; key: string; label: string };

const bySeq = (a: ChatMessage, b: ChatMessage) => a.seq - b.seq;

/** Inserts or replaces a message (matched by id, or by clientId for the sender's own echo) and keeps the list in server order without duplicates. */
export function upsertMessage(list: readonly ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id || (!!m.clientId && x.clientId === m.clientId && x.senderId === m.senderId));
  if (i >= 0) { const next = list.slice(); next[i] = m; return next.sort(bySeq); }
  return [...list, m].sort(bySeq);
}

/** Server messages (oldest first) followed by anything still waiting to send, minus pending items the server already confirmed. */
export function buildTimeline(server: readonly ChatMessage[], pending: readonly PendingMessage[], now: Date = new Date()): TimelineItem[] {
  const confirmed = new Set(server.map((m) => m.clientId).filter(Boolean) as string[]);
  const waiting = pending.filter((p) => !confirmed.has(p.clientId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: TimelineItem[] = [];
  let lastDay = '';
  const push = (iso: string) => {
    const d = dayKey(iso);
    if (d !== lastDay) { lastDay = d; out.push({ type: 'day', key: `day-${d}`, label: dayLabel(iso, now) }); }
  };
  for (const m of server) { push(m.createdAt); out.push({ type: 'message', key: m.id, message: m }); }
  for (const p of waiting) { push(p.createdAt); out.push({ type: 'pending', key: `p-${p.clientId}`, pending: p }); }
  return out;
}

/** What the sender sees under their own message. "Delivered"/"read" appear only once EVERY other member's phone has actually reported it. */
export function deliveryStatus(seq: number, meId: string, members: readonly ConversationMember[]): DeliveryStatus {
  const others = members.filter((m) => m.userId !== meId);
  if (!others.length) return 'sent';
  if (others.every((m) => m.lastReadSeq >= seq)) return 'read';
  if (others.every((m) => m.lastDeliveredSeq >= seq)) return 'delivered';
  return 'sent';
}

/** Applies a `chat.receipt` event to the cached member list (markers only ever move forward). */
export function applyReceipt(members: readonly ConversationMember[], r: { userId: string; delivered?: number; read?: number }): ConversationMember[] {
  return members.map((m) => (m.userId === r.userId ? { ...m, lastDeliveredSeq: Math.max(m.lastDeliveredSeq, r.delivered ?? 0), lastReadSeq: Math.max(m.lastReadSeq, r.read ?? 0) } : m));
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const timeLabel = (iso: string): string => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Conversation-list time: today → 14:05, this week → "Mon", older → "12 Sep". */
export function listTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return timeLabel(iso);
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function typingText(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

/** "AUDIO|COMPLETED|93" → "Voice call · 1:33" (mirrors the server so history reads the same everywhere). */
export function callMessageText(body: string): string {
  const [kind, reason, secs] = body.split('|');
  const label = kind === 'VIDEO' ? 'Video call' : 'Voice call';
  if (reason === 'COMPLETED') return `${label} · ${formatDuration(Number(secs) || 0)}`;
  const lower = label.toLowerCase();
  return ({ MISSED: `Missed ${lower}`, REJECTED: `${label} declined`, CANCELLED: `Cancelled ${lower}`, BUSY: `${label} (busy)`, FAILED: `${label} failed` } as Record<string, string>)[reason ?? ''] ?? label;
}
export const formatDuration = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

export const formatFileSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Same limits and types as the server (it enforces them again); checking first saves a pointless upload. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
export function checkAttachment(mimeType: string, sizeBytes: number): string | null {
  if (!ALLOWED_TYPES.includes(mimeType)) return 'This type of file cannot be shared. Pictures, PDFs, Word, Excel, text and CSV files are allowed.';
  if (sizeBytes < 1) return 'That file is empty.';
  if (sizeBytes > MAX_ATTACHMENT_BYTES) return `Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  return null;
}
