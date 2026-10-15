import type { CallStatus } from '@prisma/client';
import { transition, type CallAction, type Role } from './call-state';
import { ALLOWED_ATTACHMENT_TYPES, directKey, safeFileName } from './chat.constants';
import { callText, dataUrlToBuffer } from './chat.service';
import { parseIceServers } from './ice.service';

describe('call state machine', () => {
  const t = (s: CallStatus, a: CallAction, r: Role | 'system') => transition(s, a, r);
  it('allows exactly the documented transitions', () => {
    expect(t('RINGING', 'accept', 'callee')).toEqual({ to: 'ACCEPTED', reason: null });
    expect(t('RINGING', 'reject', 'callee')).toEqual({ to: 'ENDED', reason: 'REJECTED' });
    expect(t('RINGING', 'cancel', 'caller')).toEqual({ to: 'ENDED', reason: 'CANCELLED' });
    expect(t('RINGING', 'end', 'caller')).toEqual({ to: 'ENDED', reason: 'CANCELLED' });
    expect(t('RINGING', 'timeout', 'system')).toEqual({ to: 'ENDED', reason: 'MISSED' });
    expect(t('ACCEPTED', 'end', 'caller')).toEqual({ to: 'ENDED', reason: 'COMPLETED' });
    expect(t('ACCEPTED', 'end', 'callee')).toEqual({ to: 'ENDED', reason: 'COMPLETED' });
    expect(t('ACCEPTED', 'fail', 'system')).toEqual({ to: 'ENDED', reason: 'FAILED' });
  });
  it('refuses everything else: wrong role, wrong state, and anything after the end', () => {
    expect(t('RINGING', 'accept', 'caller')).toBeNull();
    expect(t('RINGING', 'reject', 'caller')).toBeNull();
    expect(t('RINGING', 'cancel', 'callee')).toBeNull();
    expect(t('RINGING', 'timeout', 'caller')).toBeNull();
    expect(t('ACCEPTED', 'accept', 'callee')).toBeNull();
    expect(t('ACCEPTED', 'cancel', 'caller')).toBeNull();
    expect(t('ACCEPTED', 'reject', 'callee')).toBeNull();
    expect(t('ACCEPTED', 'end', 'system')).toBeNull();
    for (const a of ['accept', 'reject', 'cancel', 'end', 'timeout', 'fail'] as CallAction[]) for (const r of ['caller', 'callee', 'system'] as const) expect(t('ENDED', a, r)).toBeNull();
  });
});

describe('chat helpers', () => {
  it('builds the same direct key whichever side opens the conversation', () => {
    expect(directKey('b', 'a')).toBe('a:b'); expect(directKey('a', 'b')).toBe('a:b');
  });
  it('cleans file names so they are safe to store, display and put in a header', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''));
    expect(safeFileName('my "report".pdf\r\nX-Evil: 1')).not.toMatch(/["\r\n]/);
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('a'.repeat(300)).length).toBe(120);
    expect(safeFileName('.hidden')).toBe('hidden');
  });
  it('only allows documents and pictures people legitimately share (no executables, scripts, archives, html, svg)', () => {
    for (const bad of ['application/x-msdownload', 'text/html', 'image/svg+xml', 'application/zip', 'application/javascript', 'application/x-sh']) expect(ALLOWED_ATTACHMENT_TYPES[bad]).toBeUndefined();
    expect(ALLOWED_ATTACHMENT_TYPES['image/png']).toBe('IMAGE'); expect(ALLOWED_ATTACHMENT_TYPES['application/pdf']).toBe('FILE');
  });
  it('words call entries for the conversation', () => {
    expect(callText('AUDIO|COMPLETED|93')).toBe('Voice call · 1:33');
    expect(callText('VIDEO|MISSED|0')).toBe('Missed video call');
    expect(callText('AUDIO|REJECTED|0')).toBe('Voice call declined');
    expect(callText('VIDEO|BUSY|0')).toContain('busy');
  });
  it('only turns well-formed image data URLs into bytes', () => {
    expect(dataUrlToBuffer('data:image/png;base64,AAAA')?.length).toBe(3);
    expect(dataUrlToBuffer('data:text/html;base64,AAAA')).toBeNull();
    expect(dataUrlToBuffer(null)).toBeNull();
  });
  it('keeps only valid ICE server entries', () => {
    expect(parseIceServers({ iceServers: [{ urls: 'stun:a:1' }, { urls: ['turn:b:2'], username: 'u', credential: 'c' }, { urls: ['http://x'] }, { urls: [] }, null] })).toEqual([{ urls: ['stun:a:1'] }, { urls: ['turn:b:2'], username: 'u', credential: 'c' }]);
    expect(parseIceServers({ iceServers: { urls: ['turns:z:3'], username: 'u', credential: 'c' } })).toHaveLength(1);
    expect(parseIceServers(null)).toEqual([]); expect(parseIceServers({ iceServers: 'x' })).toEqual([]);
  });
});
