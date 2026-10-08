#!/usr/bin/env node
/* DEVELOPMENT TOOL. A TCP proxy that adds network delay in front of a database, to see how the API behaves when the database is far away
   (e.g. API on a laptop in Africa, Neon in the US: ~250 ms per round trip).
     node scripts/latency-proxy.js --listen 5434 --target localhost:5433 --delay 125
   --delay is milliseconds each way, so the round trip is twice that. Point DATABASE_URL at the --listen port. */
const net = require('net');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const listen = Number(arg('listen', '5434'));
const [host, port] = arg('target', 'localhost:5433').split(':');
const delay = Number(arg('delay', '125'));
const later = (fn) => (delay > 0 ? setTimeout(fn, delay) : fn());

net.createServer((client) => {
  const upstream = net.connect(Number(port), host);
  client.setNoDelay(true); upstream.setNoDelay(true);
  // each chunk is delayed by the same amount, so ordering is preserved
  client.on('data', (d) => later(() => upstream.writable && upstream.write(d)));
  upstream.on('data', (d) => later(() => client.writable && client.write(d)));
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
}).listen(listen, () => process.stdout.write(`latency proxy :${listen} -> ${host}:${port}, +${delay} ms each way\n`));
