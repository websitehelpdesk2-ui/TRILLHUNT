import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { config, ROOT } from './config.ts';
import { migrate } from './lib/db.ts';
import { loadCtx, assertCsrf, type Ctx } from './lib/auth.ts';
import { rateLimit } from './lib/guard.ts';
import { json, HttpError, notFound } from './lib/util.ts';
import { registerRoutes, type Route } from './routes/index.ts';

migrate();

const routes: Route[] = registerRoutes();

// Compiled matcher: /api/locations/:slug -> params
function match(route: Route, method: string, path: string) {
  if (route.method !== method) return null;
  const a = route.path.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, 'public', rel);
  if (!file.startsWith(join(ROOT, 'public'))) return false;
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const ext = extname(file);
  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
  return true;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const started = Date.now();
  // A client that hangs up mid-upload (or that we cut off for exceeding a
  // limit) must never take the process down.
  req.on('error', () => { /* client aborted */ });
  res.on('error', () => { /* client aborted */ });
  const url = new URL(req.url ?? '/', config.publicUrl);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Baseline security headers. CSP is strict: no inline event handlers, no
  // third-party script hosts, and API keys never reach the client anyway.
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'geolocation=(self), camera=(), microphone=()');
  if (!path.startsWith('/api/')) {
    res.setHeader('content-security-policy',
      // Widened only for the map: unpkg serves the Leaflet library (no build
      // step in this app, so no way to bundle it locally without one), and
      // the two tile hosts serve map imagery. Nothing else is allowed in —
      // API keys are never sent to the client regardless, so there is
      // nothing for a compromised CDN script to steal here.
      "default-src 'self'; " +
      "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.tile.opentopomap.org; " +
      "style-src 'self' 'unsafe-inline' https://unpkg.com; " +
      "script-src 'self' https://unpkg.com; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }

  let ctx: Ctx | undefined;
  try {
    if (path.startsWith('/api/')) {
      ctx = loadCtx(req);
      rateLimit(`ip:${ctx.ipHash}`, 600, 60);
      assertCsrf(req, ctx);
      for (const r of routes) {
        const params = match(r, method, path);
        if (params) {
          const out = await r.handler({ req, res, ctx, params, query: url.searchParams, url });
          if (!res.writableEnded) json(res, r.status ?? 200, out ?? { ok: true });
          return;
        }
      }
      throw notFound('Unknown endpoint.');
    }

    if (serveStatic(res, path)) return;
    // SPA fallbacks
    if (path.startsWith('/app')) { serveStatic(res, '/app.html'); return; }
    if (path.startsWith('/admin')) { serveStatic(res, '/admin.html'); return; }
    if (path.startsWith('/checkout')) { serveStatic(res, '/checkout.html'); return; }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p><a href="/">THRILLHUNT</a></p>');
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[${method} ${path}]`, err);
    if (!res.writableEnded) {
      // If we rejected before draining the request body (e.g. an oversized
      // upload), the socket still has bytes in flight — close it rather than
      // letting a keep-alive connection be reused mid-stream.
      if (!req.readableEnded) { res.setHeader('connection', 'close'); req.pause(); }
      json(res, status, {
        error: status >= 500 ? 'Something went wrong on our end.' : err.message,
        code: err.code ?? 'server_error',
        ...(err.extra ?? {}),
      });
    }
  } finally {
    if (process.env.LOG_REQUESTS === 'true') {
      console.log(`${method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

server.listen(config.port, config.host, () => {
  console.log(`\n  🔥 THRILLHUNT running`);
  console.log(`     Landing : ${config.publicUrl}/`);
  console.log(`     App     : ${config.publicUrl}/app`);
  console.log(`     Admin   : ${config.publicUrl}/admin`);
  console.log(`     payments=${config.providers.payments}  moderation=${config.providers.imageModeration}  llm=${config.providers.llm}\n`);
});

export { server };