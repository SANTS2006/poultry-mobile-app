import { Redirect } from 'expo-router';
import { useAppStore } from '../state/store';

/**
 * A link the signed-in area cannot show right now (typically the plain app link "makarifor:///" while signed out, or a link to a screen behind
 * the lock) is sent to the right front door instead of an "Unmatched Route" page.
 */
export default function NotFound() {
  const status = useAppStore((s) => s.status);
  const locked = useAppStore((s) => s.locked);
  if (status === 'signed_in') return <Redirect href={locked ? '/lock' : '/'} />;
  return <Redirect href="/login" />;
}
