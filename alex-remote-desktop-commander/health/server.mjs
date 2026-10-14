import http from 'node:http';
import { readFile } from 'node:fs/promises';

export async function createServer(health) {
  const files = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ].map(async ([route, file, type]) => [route, { type, body: await readFile(new URL(file, import.meta.url)) }])));
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'GET' && req.url === '/api/health') return send(200, health.snapshot());
      if (req.method === 'POST' && req.url === '/api/check') {
        // The custom header and JSON type require a browser CORS preflight.
        // No CORS permission is granted; Umbrel's app proxy handles login.
        if (req.headers['x-journal-health'] !== '1' || req.headers['content-type'] !== 'application/json' ||
            req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Forbidden' });
        return send(200, await health.check());
      }
      const file = files.get(req.url);
      if (req.method === 'GET' && file) {
        res.writeHead(200, { 'Content-Type': file.type });
        return res.end(file.body);
      }
      send(404, { error: 'Not found' });
    } catch { send(503, { error: 'Health check unavailable' }); }
  });
}
