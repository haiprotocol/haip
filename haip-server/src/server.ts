import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';
import { readFileSync } from 'node:fs';
import { digest, parseJson } from '@haip/protocol/crypto';
import type { ReviewService } from './service.js';
import { hitlStatus, hitlPoll } from './hitl.js';
import { installAuth } from './auth.js';
import { registerPrincipal, registerRoute } from './admin.js';
import { ProtocolError, requireThat } from './errors.js';
import { Metrics, prometheus } from './metrics.js';
import { validate } from './validation.js';
import { requireBoundBundle } from './bundle.js';
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = (name: string) =>
  readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const hostPolicy = (frameOrigin = "'none'") =>
  `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src ${frameOrigin}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
const bundleScope = (tenant: string, bundle: { publisher: string; digest: string }) =>
  digest({ tenant, publisher: bundle.publisher, digest: bundle.digest }).slice(7);
function jsonBody(limit: number): RequestHandler[] {
  return [
    (req, _res, next) => {
      requireThat(req.is('application/json'), 415, 'json_required');
      requireThat(
        !req.get('Content-Encoding') || req.get('Content-Encoding') === 'identity',
        415,
        'unsupported_encoding',
      );
      const charset = req.get('Content-Type')?.match(/;\s*charset\s*=\s*"?([^;"\s]+)/i)?.[1];
      requireThat(!charset || charset.toLowerCase() === 'utf-8', 415, 'utf8_required');
      next();
    },
    express.raw({ type: 'application/json', limit, inflate: false }),
    (req, _res, next) => {
      requireThat(Buffer.isBuffer(req.body), 400, 'invalid_json');
      try {
        req.body = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(req.body));
      } catch {
        throw new ProtocolError(400, 'invalid_json');
      }
      next();
    },
  ];
}
export function createApp(service: ReviewService) {
  const app = express();
  const metrics = new Metrics();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.once('finish', () => {
      if (req.principal?.tenant) metrics.observe(req.principal.tenant, res.statusCode);
    });
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
      'Content-Security-Policy': hostPolicy(),
    });
    if (service.config.mode === 'production')
      res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.get('/.well-known/haip', (_req, res) => res.json(service.discovery()));
  app.get('/.well-known/haip-trust', (_req, res) => res.json(service.config.trust));
  app.get('/health', async (_req, res) => {
    await service.store.pool.query('SELECT 1');
    res.json({ status: 'ok', release: 'draft', notifications: service.discovery().notifications });
  });
  app.get('/assets/host.js', (_req, res) =>
    res
      .set('Cache-Control', 'public, max-age=0, must-revalidate')
      .type('js')
      .send(script('host.js')),
  );
  app.get('/assets/style.css', (_req, res) =>
    res
      .set('Cache-Control', 'public, max-age=0, must-revalidate')
      .type('css')
      .send(script('style.css')),
  );
  app.get('/', (_req, res) => res.redirect('/inbox'));
  installAuth(app, service);
  app.get(['/inbox', '/review/:id'], async (req, res) => {
    requireThat(req.principal.kind === 'human', 403, 'human_required');
    if (typeof req.params.id === 'string') {
      const data = await service.status(req.principal, req.params.id);
      const bundle = data.request.review.bundle;
      if (bundle)
        res.set(
          'Content-Security-Policy',
          hostPolicy(
            new URL(service.config.sandboxOrigin(bundleScope(req.principal.tenant, bundle))).origin,
          ),
        );
    }
    res.type('html').send(page);
  });
  const key = (req: Request) => req.header('Idempotency-Key');
  const human = (req: Request) =>
    requireThat(req.humanSession && req.principal.kind === 'human', 403, 'human_required');
  const role =
    (...kinds: string[]): RequestHandler =>
    (req, _res, next) => {
      requireThat(kinds.includes(req.principal.kind), 403, 'forbidden');
      if (kinds.length === 1 && kinds[0] === 'human') human(req);
      next();
    };
  // Only known routes parse bodies, after authentication, CSRF and cheap admission checks.
  app.post(
    '/v2/bundles',
    async (req, _res, next) => {
      await service.preflightBundle(req.principal, key(req));
      next();
    },
    ...jsonBody(22 * 1024 ** 2),
  );
  app.post(
    ['/v2/requests', '/v2/requests/:id/supersede'],
    async (req, _res, next) => {
      await service.preflightCreate(
        req.principal,
        key(req),
        typeof req.params.id === 'string' ? req.params.id : undefined,
      );
      next();
    },
    ...jsonBody(22 * 1024 ** 2),
  );
  app.post(
    ['/v2/requests/:id/assignment', '/v2/requests/:id/confirm'],
    role('human'),
    ...jsonBody(64 * 1024),
  );
  app.post('/v2/requests/:id/candidates', role('human'), ...jsonBody(2 * 1024 ** 2));
  app.post(
    [
      '/v2/requests/:id/cancel',
      '/v2/requests/:id/revoke',
      '/v2/requests/:id/remind',
      '/v2/requests/:id/discard',
    ],
    role('producer', 'operator'),
    ...jsonBody(64 * 1024),
  );
  app.post(
    ['/v2/requests/:id/claims', '/v2/requests/:id/admission'],
    role('producer'),
    ...jsonBody(64 * 1024),
  );
  app.post('/v2/requests/:id/outcomes', role('producer'), ...jsonBody(1024 ** 2));
  app.post('/v2/requests/:id/reconcile', role('operator'), ...jsonBody(1024 ** 2));
  app.put(
    ['/v2/admin/principals/:id', '/v2/admin/routes/:id'],
    role('operator'),
    ...jsonBody(64 * 1024),
  );
  app.get('/v2/requests', async (req, res) =>
    res.json(
      await service.list(
        req.principal,
        typeof req.query.state === 'string' ? req.query.state : undefined,
        offset(req.query.offset),
      ),
    ),
  );
  app.post('/v2/bundles', async (req, res) =>
    res.status(201).json(await service.registerBundle(req.principal, req.body, key(req))),
  );
  app.post('/v2/requests', async (req, res) =>
    res.status(201).json(await service.create(req.principal, req.body, key(req))),
  );
  app.get('/v2/requests/:id', async (req, res) =>
    res.json(await service.status(req.principal, req.params.id!)),
  );
  app.get('/v2/requests/:id/material', async (req, res) =>
    res.json(await service.material(req.principal, req.params.id!)),
  );
  app.get('/v2/requests/:id/app', async (req, res) => {
    human(req);
    const data = await service.material(req.principal, req.params.id!);
    const bundle = data.request.review.bundle;
    requireThat(bundle, 404, 'not_found');
    const found = (
      await service.store.pool.query(
        'SELECT html,manifest FROM haip_bundles WHERE tenant=$1 AND id=$2 AND publisher=$3',
        [req.principal.tenant, bundle.id, bundle.publisher],
      )
    ).rows[0];
    requireBoundBundle(found, req.principal.tenant, bundle);
    const scope = bundleScope(req.principal.tenant, bundle);
    requireThat(
      Buffer.byteLength(JSON.stringify(data.payload)) <= data.request.limits.inline_result_bytes,
      413,
      'app_snapshot_too_large',
    );
    const origin = service.config.sandboxOrigin(scope);
    const input = { request_id: data.request.id, purpose: data.request.purpose };
    const result = {
      content: [{ type: 'text', text: 'Stored review payload' }],
      structuredContent: { payload: data.payload },
    };
    // The identity below is what the host verifies and the View is shown. Every value is
    // bound by binding_digest; the snapshots are committed by their own digests.
    const identity = {
      profile: 'org.haiprotocol.agent-ui/1',
      protocol_revision: data.request.protocol_revision,
      request: {
        id: data.request.id,
        digest: data.request_digest,
        purpose: data.request.purpose,
        authorisation_revision: data.request.authorisation_revision,
        supersedes: data.request.supersedes ?? null,
      },
      bundle: {
        id: found.manifest.id,
        publisher: found.manifest.publisher,
        digest: found.manifest.digest,
        created_at: found.manifest.created_at,
      },
      source: {
        tenant: req.principal.tenant,
        producer: data.request.producer,
        requester: data.request.requester,
        origin: new URL(origin).origin,
      },
      snapshots: { input_digest: digest(input), result_digest: digest(result) },
    };
    res.json({
      ...identity,
      binding_digest: digest(identity),
      html: found.html,
      origin,
      scope,
      input,
      result,
    });
  });
  app.post('/v2/requests/:id/assignment', async (req, res) => {
    human(req);
    res.json(await service.assign(req.principal, req.params.id!, key(req)));
  });
  app.post('/v2/requests/:id/candidates', async (req, res) => {
    human(req);
    res.status(201).json(await service.propose(req.principal, req.params.id!, req.body, key(req)));
  });
  app.post('/v2/requests/:id/confirm', async (req, res) => {
    human(req);
    validate('Confirmation', req.body);
    requireThat(
      typeof req.body?.candidate_id === 'string' && typeof req.body?.candidate_digest === 'string',
      400,
      'candidate_required',
    );
    res.json(
      await service.confirm(
        req.principal,
        req.params.id!,
        req.body.candidate_id,
        req.body.candidate_digest,
        key(req),
      ),
    );
  });
  app.post('/v2/requests/:id/cancel', async (req, res) =>
    res.json(await service.invalidate(req.principal, req.params.id!, 'cancelled', key(req))),
  );
  app.post('/v2/requests/:id/revoke', async (req, res) =>
    res.json(await service.invalidate(req.principal, req.params.id!, 'revoked', key(req))),
  );
  app.post('/v2/requests/:id/remind', async (req, res) =>
    res.json(await service.remind(req.principal, req.params.id!, key(req))),
  );
  app.post('/v2/requests/:id/discard', async (req, res) =>
    res.json(await service.discard(req.principal, req.params.id!, key(req))),
  );
  app.post('/v2/requests/:id/supersede', async (req, res) =>
    res
      .status(201)
      .json(await service.supersede(req.principal, req.params.id!, req.body, key(req))),
  );
  app.post('/v2/requests/:id/claims', async (req, res) =>
    res.status(201).json(await service.claim(req.principal, req.params.id!, req.body, key(req))),
  );
  app.post('/v2/requests/:id/admission', async (req, res) =>
    res.json(await service.admission(req.principal, req.params.id!, req.body)),
  );
  app.post('/v2/requests/:id/outcomes', async (req, res) =>
    res.json(await service.outcome(req.principal, req.params.id!, req.body, key(req))),
  );
  app.post('/v2/requests/:id/reconcile', async (req, res) =>
    res.json(await service.outcome(req.principal, req.params.id!, req.body, key(req), true)),
  );
  app.get('/v2/requests/:id/export', async (req, res) =>
    res.json(await service.export(req.principal, req.params.id!)),
  );
  app.get('/v2/hitl/:id', async (req, res) => {
    const result = await hitlStatus(service, req.principal, req.params.id!);
    res.status(result.httpStatus).json(result.body);
  });
  app.get('/v2/hitl/:id/poll', async (req, res) =>
    res.json(await hitlPoll(service, req.principal, req.params.id!)),
  );
  app.get('/v2/events', async (req, res) =>
    res.json(await service.events(req.principal, offset(req.query.after))),
  );
  app.put('/v2/admin/principals/:id', async (req, res) => {
    requireThat(req.params.id === req.body.id, 400, 'identity_mismatch');
    res.json(await registerPrincipal(service, req.principal, req.body));
  });
  app.put('/v2/admin/routes/:id', async (req, res) =>
    res.json(await registerRoute(service, req.principal, req.params.id!, req.body)),
  );
  app.get('/v2/admin/ledger', async (req, res) => {
    requireThat(req.principal.kind === 'operator', 403, 'operator_required');
    res.json(
      (
        await service.store.pool.query(
          'SELECT * FROM haip_audit WHERE tenant=$1 AND sequence>$2 ORDER BY sequence LIMIT 100',
          [req.principal.tenant, offset(req.query.after)],
        )
      ).rows,
    );
  });
  app.get('/v2/admin/metrics', async (req, res) =>
    res.json(await metrics.snapshot(service, req.principal)),
  );
  app.get('/v2/admin/metrics.prom', async (req, res) =>
    res.type('text/plain').send(prometheus(await metrics.snapshot(service, req.principal))),
  );
  app.use((_req, _res, next) => next(new ProtocolError(404, 'not_found')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ProtocolError) res.status(error.status).json({ error: error.code });
    else if ((error as { type?: string })?.type === 'entity.too.large')
      res.status(413).json({ error: 'body_too_large' });
    else if ((error as { code?: string })?.code === '23505')
      res.status(409).json({ error: 'identity_conflict' });
    else res.status(503).json({ error: 'service_unavailable' });
  });
  return app;
}
function offset(v: unknown): number {
  if (v === undefined) return 0;
  requireThat(typeof v === 'string' && /^\d{1,8}$/.test(v), 400, 'invalid_offset');
  return Number(v);
}
export function createSandboxApp(service: ReviewService) {
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
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), clipboard-read=(), clipboard-write=()',
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src data:; frame-src about:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors ${service.config.origin}`,
    });
    if (service.config.mode === 'production')
      res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.get('/sandbox/:scope', (req, res) => {
    requireThat(/^[a-f0-9]{64}$/.test(req.params.scope!), 404, 'not_found');
    const expected = new URL(service.config.sandboxOrigin(req.params.scope!));
    requireThat(req.get('host') === expected.host, 404, 'not_found');
    const source = script('sandbox.js').replaceAll(
      '__HAIP_HOST_ORIGIN__',
      JSON.stringify(service.config.origin).slice(1, -1),
    );
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
