import express, { type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import type { ServiceConfig } from './config.js';
import { requireThat } from './errors.js';

export function createViewBootstrap(
  config: Pick<ServiceConfig, 'origin' | 'sandboxOrigin' | 'mode'>,
) {
  const source = readFileSync(new URL('../public/sandbox.js', import.meta.url), 'utf8').replaceAll(
    '__HAIP_HOST_ORIGIN__',
    JSON.stringify(config.origin).slice(1, -1),
  );
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Connection-Allowlist': '(); webrtc=block; redirects=block; report-to=haip-view-policy',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), clipboard-read=(), clipboard-write=()',
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src data:; frame-src about:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors ${config.origin}`,
    });
    if (config.mode === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.get('/sandbox/:scope', (req, res) => {
    requireThat(/^[a-f0-9]{64}$/.test(req.params.scope!), 404, 'not_found');
    const expected = new URL(config.sandboxOrigin(req.params.scope!));
    requireThat(req.get('host') === expected.host, 404, 'not_found');
    res
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Isolated review app</title><style>html,body,iframe{height:100%;width:100%;border:0;margin:0}</style><script>${source.replaceAll('</script', '<\\/script')}</script>`,
      );
  });
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(404).json({ error: 'not_found' });
  });
  return app;
}
