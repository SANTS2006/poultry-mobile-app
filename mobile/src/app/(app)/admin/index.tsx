import { useCan } from '../../../state/store';
import { NavRow, Screen } from '../../../ui/components';

export default function AdminHome() {
  const users = useCan('users.manage');
  const audit = useCan('audit.read');
  const prices = useCan('prices.manage');
  const notif = useCan('notifications.manage');
  const farm = useCan('farms.manage');
  return (
    <Screen padded={false}>
      {users ? <NavRow title="Users" subtitle="Invite staff, change roles, disable accounts" to="/admin/users" /> : null}
      {farm ? <NavRow title="Coops" subtitle="Add coops as your flock grows" to="/admin/coops" /> : null}
      {prices ? <NavRow title="Prices" subtitle="Carton, crate and egg prices" to="/admin/prices" /> : null}
      {notif ? <NavRow title="Notification rules" subtitle="Daily summary, reminders, thresholds" to="/admin/notification-settings" /> : null}
      {audit ? <NavRow title="Audit log" subtitle="Who changed what, and when" to="/admin/audit" /> : null}
    </Screen>
  );
}
