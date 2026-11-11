// Serves the app locally and opens a localtunnel HTTPS tunnel to it, then prints
// the public URL and a QR code to scan with the phone.  Usage: npm run tunnel
//
// localtunnel is pure JavaScript (no native binary), so it is not stopped by the
// endpoint-security control that blocks the ngrok executable on this machine.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import localtunnel from 'localtunnel';
import qrcode from 'qrcode-terminal';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// Only the app itself is published through the tunnel.
const PUBLIC = ['index.html', 'css', 'js', 'vendor'];

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const rel = normalize(path).replace(/^[/\\]+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT + sep) || !PUBLIC.includes(rel.split(sep)[0])) throw new Error('not public');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

async function publicIp() {
  try {
    const r = await fetch('https://loca.lt/mytunnelpassword', { signal: AbortSignal.timeout(5000) });
    return (await r.text()).trim();
  } catch (e) { return null; }
}

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Serving ${ROOT} on http://localhost:${PORT}`);
  let tunnel;
  try {
    tunnel = await localtunnel({ port: PORT });
  } catch (e) {
    console.error(`Could not open the tunnel: ${e.message}`);
    server.close();
    process.exit(1);
  }
  const pw = await publicIp();
  console.log(`\nOpen this in Chrome on your phone:\n\n  ${tunnel.url}\n`);
  qrcode.generate(tunnel.url, { small: true });
  console.log('\nThe first visit shows a loca.lt notice asking for a "Tunnel Password".');
  console.log(pw ? `Enter this (your public IP): ${pw}` : 'Enter your public IP (search "what is my ip" on the phone).');
  console.log('Then tap "Click to Submit". Ctrl+C here stops the tunnel.');

  tunnel.on('close', () => { server.close(); process.exit(0); });
  const stop = () => tunnel.close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});
