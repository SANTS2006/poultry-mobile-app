import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';

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

export interface ToolResult { code: number | null; stderr: string }

/** Keeps only the last few KB of stderr and removes anything that looks like a credential. */
const scrub = (s: string): string => s.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgresql://[redacted]').replace(/password[=:]\s*\S+/gi, 'password=[redacted]').slice(-1500);

export function startTool(bin: string, args: string[], env: Record<string, string>, binDir = ''): { child: ChildProcess; done: Promise<ToolResult> } {
  const cmd = binDir ? join(binDir, bin) : bin;
  const child = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-6000); });
  const done = new Promise<ToolResult>((resolve) => {
    child.on('error', (e) => resolve({ code: -1, stderr: scrub(`${bin}: ${e.message}`) }));
    child.on('close', (code) => resolve({ code, stderr: scrub(stderr) }));
  });
  return { child, done };
}

export async function runTool(bin: string, args: string[], env: Record<string, string>, binDir = '', timeoutMs = 3_600_000): Promise<ToolResult> {
  const { child, done } = startTool(bin, args, env, binDir);
  child.stdout?.resume();
  const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try { return await done; } finally { clearTimeout(t); }
}
