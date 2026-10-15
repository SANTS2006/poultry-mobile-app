import { relatedRoute, routeForNotification } from './push';

describe('where a tapped notification goes', () => {
  it('opens the notification’s own detail screen when the push carries its id', () => {
    expect(routeForNotification({ notificationId: 'n1', entityType: 'sale', entityId: 's1' })).toBe('/notifications/n1');
  });
  it('falls back to the related record, then to the list', () => {
    expect(routeForNotification({ entityType: 'sale', entityId: 's1' })).toBe('/sales/s1');
    expect(routeForNotification({ entityType: 'unknown' })).toBe('/notifications');
    expect(routeForNotification(null)).toBe('/notifications');
  });
  it('offers a related-record button only for records the app can open', () => {
    expect(relatedRoute({ entityType: 'production_record', entityId: 'p1' })).toEqual({ path: '/production/p1', label: 'Open the production record' });
    expect(relatedRoute({ entityType: 'sync' })?.path).toBe('/sync');
    expect(relatedRoute({ entityType: 'user', entityId: 'u1' })).toBeNull();
    expect(relatedRoute({ entityType: null })).toBeNull();
  });

  it('opens the conversation for a chat push, the call list for a missed call, and never trusts anything but ids', () => {
    expect(routeForNotification({ type: 'chat', conversationId: 'c1' })).toBe('/messages/c1');
    expect(routeForNotification({ type: 'missed_call' })).toBe('/calls');
    expect(routeForNotification({ type: 'call', callId: 'x' })).toBe('/messages');
    expect(routeForNotification({ type: 'chat' })).toBe('/notifications'); // no id: fall back safely
  });
});
