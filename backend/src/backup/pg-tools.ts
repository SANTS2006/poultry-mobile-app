import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { delimiter, join } from 'path';

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

const exe = (bin: string): string => (process.platform === 'win32' ? `${bin}.exe` : bin);
const versionOf = (d: string): number => Number((/(\d+)(?:\.\d+)*$/.exec(d.replace(/\/bin$/i, '')) ?? [])[1] ?? 0);

/** Folders where PostgreSQL's installers put the client tools (used when they are installed but not on the PATH, the usual state on Windows). */
function installedToolDirs(): string[] {
  const roots = process.platform === 'win32'
    ? [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'].map((r) => join(r, 'PostgreSQL'))
    : ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt', '/Library/PostgreSQL', '/Applications/Postgres.app/Contents/Versions'];
  const out: string[] = [];
  for (const root of roots) {
    try {
      for (const v of readdirSync(root)) out.push(join(root, v, 'bin'));
    } catch { /* not installed here */ }
  }
  return out.sort((a, b) => versionOf(b) - versionOf(a)); // newest first: pg_dump must not be older than the server
}

const located = new Map<string, string>();
/** Where to run `bin` from: the configured folder, else the PATH, else a standard install folder (newest version). '' means "let the system find it". */
export function locateTool(bin: string, configured = ''): string {
  if (configured) return configured;
  const hit = located.get(bin);
  if (hit !== undefined) return hit;
  const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, exe(bin))));
  const dir = onPath ? '' : installedToolDirs().find((d) => existsSync(join(d, exe(bin)))) ?? '';
  located.set(bin, dir);
  return dir;
}

export function startTool(bin: string, args: string[], env: Record<string, string>, binDir = ''): { child: ChildProcess; done: Promise<ToolResult> } {
  const dir = locateTool(bin, binDir);
  const cmd = dir ? join(dir, bin) : bin;
  const child = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-6000); });
  const done = new Promise<ToolResult>((resolve) => {
    child.on('error', (e: NodeJS.ErrnoException) => resolve({
      code: -1,
      stderr: e.code === 'ENOENT'
        ? `${bin} was not found. Install the PostgreSQL client tools (version ${'>='} your database's) and make sure "${bin}" is on the PATH, or set BACKUP_PG_BIN_DIR to the folder that contains it (on Windows usually C:\\Program Files\\PostgreSQL\\17\\bin).`
        : scrub(`${bin}: ${e.message}`),
    }));
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

/** True when `pg_dump` can be started (used to warn on the Backups screen before a backup fails). */
export async function toolAvailable(bin: string, binDir = ''): Promise<boolean> {
  return (await runTool(bin, ['--version'], {}, binDir, 15_000)).code === 0;
}
