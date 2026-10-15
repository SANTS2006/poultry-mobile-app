export type MessageKind = 'TEXT' | 'IMAGE' | 'FILE' | 'SYSTEM' | 'CALL';

export interface ChatAttachment { id: string; fileName: string; mimeType: string; sizeBytes: number }
export interface ReplyRef { id: string; senderId: string | null; senderName: string | null; kind: MessageKind; preview: string; deleted: boolean }

export interface ChatMessage {
  id: string; conversationId: string; seq: number; senderId: string | null; senderName: string | null; kind: MessageKind; body: string; clientId: string | null;
  replyTo: ReplyRef | null; attachment: ChatAttachment | null; createdAt: string; editedAt: string | null; deleted: boolean;
}

export interface ConversationSummary {
  id: string; type: 'DIRECT' | 'GROUP'; title: string | null; description: string | null; hasAvatar: boolean; avatarVersion: number; peerId: string | null; peerOnline: boolean;
  memberCount: number; myRole: 'ADMIN' | 'MEMBER'; muted: boolean; unread: number; lastMessageAt: string | null; lastSeq: number; createdAt: string;
  lastMessage: { id: string; kind: MessageKind; preview: string; senderId: string | null; senderName: string | null; createdAt: string; deleted: boolean } | null;
}
export interface ConversationMember {
  userId: string; name: string; role: 'ADMIN' | 'MEMBER'; joinedAt: string; online: boolean; hasAvatar: boolean; avatarVersion: number; lastReadSeq: number; lastDeliveredSeq: number;
}
export interface ConversationDetail extends ConversationSummary { members: ConversationMember[] }

/** A message the user sent that the server has not confirmed yet (or that failed). Kept until it succeeds or the user discards it. */
export interface PendingMessage {
  clientId: string; conversationId: string; kind: 'TEXT' | 'IMAGE' | 'FILE'; body: string; replyToId?: string; createdAt: string; status: 'sending' | 'failed'; error?: string;
  /** a picked file waiting to be uploaded (local uri) or already uploaded */
  file?: { uri: string; fileName: string; mimeType: string; sizeBytes: number; attachmentId?: string };
}

export type DeliveryStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';
