// Serves a built app the way Tauri does: the production CSP (from src-tauri/tauri.conf.json) is a
// response header on the HTML document only; JS/CSS/font assets get no CSP header.
// Usage: node e2e/csp-server.mjs <dir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [dir = 'dist-e2e', port = '1431'] = process.argv.slice(2);
const conf = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const csp = conf.app.security.csp;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(dir, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    const type = types[extname(file)] ?? 'application/octet-stream';
    const headers = { 'content-type': type };
    if (type.startsWith('text/html')) headers['content-security-policy'] = csp;
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(Number(port), () => console.log(`csp-server: ${dir} on http://localhost:${port}`));
