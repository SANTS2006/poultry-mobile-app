import { useEffect } from 'react';
import { useLiveNotice } from '../state/live-notice';
import { useToast } from './toast';

/** Shows a short banner when a notification arrives while the app is open (this also works in Expo Go, where push messages cannot). Renders nothing itself. */
export function LiveNoticeToaster(): null {
  const latest = useLiveNotice((s) => s.latest);
  const toast = useToast();
  useEffect(() => { if (latest) toast.show(`New notification: ${latest.title}`, 'info'); }, [latest, toast]);
  return null;
}
