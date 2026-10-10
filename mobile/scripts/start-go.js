#!/usr/bin/env node
/* One command for trying the app in Expo Go:  npm run go
   - finds this computer's LAN address and points the app at the API on port 3000 (override: API_URL=http://host:port npm run go)
   - checks the API answers before starting, so "no connection" problems show up here instead of on the phone
   - starts Expo in LAN mode (phone and computer must be on the same Wi-Fi). Use  npm run go -- --tunnel  if your network blocks LAN traffic. */
const os = require('os');
const { spawn } = require('child_process');

function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && !/^(br-|veth|vmnet|vboxnet|utun|lo)/i.test(name)) candidates.push(i.address);
    }
  }
  // prefer typical home/office ranges
  return candidates.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) ?? candidates[0];
}

async function main() {
  const api = process.env.API_URL ?? process.env.EXPO_PUBLIC_API_URL ?? `http://${lanAddress() ?? 'localhost'}:3000`;
  console.log(`\nApp will talk to the API at: ${api}`);
  try {
    const r = await fetch(`${api}/health/ready`, { signal: AbortSignal.timeout(4000) });
    console.log(r.ok ? 'API check: OK' : `API check: server answered HTTP ${r.status} (is the database up?)`);
  } catch {
    console.log('API check: NOT reachable. Start the API first (cd ../backend && npm run start:dev) and allow port 3000 in your firewall. Continuing anyway.');
  }
  const args = ['expo', 'start', ...process.argv.slice(2)];
  if (!args.includes('--tunnel') && !args.includes('--lan')) args.push('--lan');
  console.log('Scan the QR code with the Expo Go app (Android) or the Camera app (iPhone).\n');
  const child = spawn('npx', args, { stdio: 'inherit', env: { ...process.env, EXPO_PUBLIC_API_URL: api, EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV ?? 'development' }, shell: process.platform === 'win32' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
main();
