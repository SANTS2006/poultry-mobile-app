/* eslint-disable no-console -- an operator tool that prints its findings */
/**
 * Finds out WHY the API cannot reach the database:  npm run db:check
 * Tests, in order: the settings, DNS, a raw TCP connection to port 5432 (the usual blocker), then a real query with timing, for both the
 * pooled DATABASE_URL and the direct DIRECT_DATABASE_URL. Prints a verdict and what to do. Passwords are never printed.
 */
import { lookup } from 'dns/promises';
import { connect } from 'net';
import { PrismaClient } from '@prisma/client';
import { withConnectionDefaults } from '../src/prisma/connection';

const tcp = (host: string, port: number, ms: number): Promise<{ ok: boolean; ms: number; error?: string }> => new Promise((resolve) => {
  const t0 = Date.now();
  const s = connect({ host, port });
  const done = (ok: boolean, error?: string) => { s.destroy(); resolve({ ok, ms: Date.now() - t0, error }); };
  s.setTimeout(ms, () => done(false, `no answer within ${ms / 1000} s (blocked or dropped)`));
  s.once('connect', () => done(true));
  s.once('error', (e: NodeJS.ErrnoException) => done(false, e.code ?? e.message));
});

try { process.loadEnvFile('.env'); } catch { /* no .env file: use the environment */ }

async function check(label: string, raw: string | undefined): Promise<boolean> {
  console.log(`\n── ${label} ──`);
  if (!raw) { console.log('  ✗ not set in backend/.env'); return false; }
  let u: URL;
  try { u = new URL(raw); } catch { console.log('  ✗ is not a valid URL (a special character in the password must be percent-encoded, e.g. @ → %40)'); return false; }
  const port = Number(u.port || 5432);
  console.log(`  host ${u.hostname}  port ${port}  database ${u.pathname.slice(1)}  user ${decodeURIComponent(u.username)}  sslmode=${u.searchParams.get('sslmode') ?? '(none)'}`);
  if (!/sslmode=(require|verify)/.test(raw) && u.hostname.endsWith('neon.tech')) console.log('  ! Neon needs ?sslmode=require at the end of the URL');
  try {
    const all = await lookup(u.hostname, { all: true });
    console.log(`  ✓ DNS: ${all.map((a) => a.address).join(', ')}`);
  } catch (e) { console.log(`  ✗ DNS lookup failed (${(e as NodeJS.ErrnoException).code}). Check your internet/DNS (try 8.8.8.8 or 1.1.1.1), a VPN, or a typo in the host.`); return false; }
  const t = await tcp(u.hostname, port, 10_000);
  if (!t.ok) {
    console.log(`  ✗ TCP port ${port}: ${t.error}`);
    console.log('    → Your network is blocking the database port, OR the Neon project is suspended/deleted.');
    console.log('      1) Open the Neon console: is the project active? (free projects stop when the monthly compute hours are used up)');
    console.log('      2) Try a phone hotspot. If it works there, your Wi-Fi/ISP/VPN/antivirus/firewall blocks port 5432.');
    return false;
  }
  console.log(`  ✓ TCP port ${port} open (${t.ms} ms)`);
  const prisma = new PrismaClient({ datasourceUrl: withConnectionDefaults(raw) });
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const first = Date.now() - t0;
    const t1 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    console.log(`  ✓ query worked: first ${first} ms${first > 3000 ? ' (the database was waking up)' : ''}, next ${Date.now() - t1} ms`);
    return true;
  } catch (e) {
    const m = (e as Error).message.split('\n').filter(Boolean).slice(-2).join(' ');
    console.log(`  ✗ query failed: ${m}`);
    if (/password|authentication/i.test(m)) console.log('    → Wrong user or password in this URL (copy it again from the Neon console → Connection details).');
    return false;
  } finally { await prisma.$disconnect().catch(() => undefined); }
}

(async () => {
  const a = await check('DATABASE_URL (used by the API)', process.env.DATABASE_URL);
  const b = await check('DIRECT_DATABASE_URL (used by migrations and backups)', process.env.DIRECT_DATABASE_URL);
  console.log(`\nResult: API database ${a ? 'OK' : 'NOT reachable'} · direct database ${b ? 'OK' : 'NOT reachable'}`);
  process.exit(a && b ? 0 : 1);
})();
