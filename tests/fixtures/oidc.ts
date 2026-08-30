import express from 'express';
import { generateKeyPairSync, randomUUID, sign, createHash } from 'node:crypto';
export async function identityProvider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const codes = new Map<string, any>();
  let origin = '';
  app.get(
    ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server'],
    (_req, res) =>
      res.json({
        issuer: origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        jwks_uri: origin + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      }),
  );
  app.get('/jwks', (_req, res) =>
    res.json({
      keys: [
        { ...publicKey.export({ format: 'jwk' }), kid: 'test-oidc', use: 'sig', alg: 'RS256' },
      ],
    }),
  );
  const escape = (v: string) =>
    v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  app.get('/authorize', (req, res) => {
    const query = new URLSearchParams(req.query as Record<string, string>);
    res
      .type('html')
      .send(
        `<!doctype html><title>Test identity provider</title><h1>Isolated test sign-in</h1><form method="post" action="/authorize"><input type="hidden" name="query" value="${escape(query.toString())}"><label>User <input name="subject" value="reviewer"></label><button type="submit">Sign in</button></form>`,
      );
  });
  app.post('/authorize', (req, res) => {
    const q = new URLSearchParams(req.body.query);
    const code = randomUUID();
    codes.set(code, {
      subject: req.body.subject,
      nonce: q.get('nonce'),
      challenge: q.get('code_challenge'),
      redirect: q.get('redirect_uri'),
    });
    const redirect = new URL(q.get('redirect_uri')!);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', q.get('state')!);
    res.redirect(redirect.href);
  });
  app.post('/token', (req, res) => {
    const c = codes.get(req.body.code);
    codes.delete(req.body.code);
    const auth = req.headers.authorization;
    const secret = auth?.startsWith('Basic ')
      ? decodeURIComponent(
          Buffer.from(auth.slice(6), 'base64').toString().split(':')[1].replaceAll('+', ' '),
        )
      : req.body.client_secret;
    if (
      !c ||
      secret !== 'test-secret' ||
      req.body.redirect_uri !== c.redirect ||
      createHash('sha256')
        .update(req.body.code_verifier ?? '')
        .digest('base64url') !== c.challenge
    ) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const at = Math.floor(Date.now() / 1000);
    const message =
      encode({ alg: 'RS256', kid: 'test-oidc' }) +
      '.' +
      encode({
        iss: origin,
        sub: c.subject,
        aud: 'haip-test',
        iat: at,
        exp: at + 300,
        nonce: c.nonce,
      });
    res.json({
      token_type: 'Bearer',
      access_token: randomUUID(),
      expires_in: 300,
      id_token:
        message + '.' + sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url'),
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>((r) => server.close(() => r())) };
}
