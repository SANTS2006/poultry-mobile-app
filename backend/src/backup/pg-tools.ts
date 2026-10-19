/** Connection settings as libpq environment variables, so passwords never appear in a process list or in logs. */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode'); if (ssl) env.PGSSLMODE = ssl;
  const cb = u.searchParams.get('channel_binding'); if (cb) env.PGCHANNELBINDING = cb;
  return env;
}

export const withDatabase = (url: string, db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
export const databaseOf = (url: string): string => decodeURIComponent(new URL(url).pathname.slice(1));
/** "host:port/db", safe to show to administrators and put in audit rows (no credentials). */
export const describeTarget = (url: string): string => { const u = new URL(url); return `${u.hostname}:${u.port || '5432'}/${databaseOf(url)}`; };
