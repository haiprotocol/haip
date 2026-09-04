import * as oidc from 'openid-client';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, Express } from 'express';
import { digestBytes } from '@haip/protocol/crypto';
import type { ReviewService } from './service.js';
import type { Principal } from './config.js';
import { requireThat } from './errors.js';
import { principalRateKey, requestRateLimit } from './rate-limit.js';
export interface HumanSession {
  tenant: string;
  id: string;
  csrf: string;
  authenticated_at: string;
}
declare global {
  namespace Express {
    interface Request {
      principal: Principal;
      humanSession?: HumanSession;
    }
  }
}
const random = () => randomBytes(32).toString('base64url');
const cookie = (req: Request, name: string) =>
  req.headers.cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + '='))
    ?.slice(name.length + 1);
export function installAuth(app: Express, service: ReviewService) {
  const { store, config } = service;
  const loginAdmission = requestRateLimit({
    limit: 120,
    identifier: 'login-service',
  });
  // Caddy is the direct peer, so requests without an authenticated principal share this service bucket.
  const credentialAdmission = requestRateLimit({
    limit: 12000,
    identifier: 'credential-service',
  });
  const humanAdmission = requestRateLimit({
    limit: 1200,
    identifier: 'human',
    key: principalRateKey,
  });
  const callback = config.origin + '/auth/callback';
  let discovered: Promise<oidc.Configuration> | undefined;
  const client = () =>
    (discovered ??= oidc
      .discovery(
        new URL(config.oidc.issuer),
        config.oidc.clientId,
        config.oidc.clientSecret,
        config.oidc.clientAuth === 'client_secret_basic'
          ? oidc.ClientSecretBasic(config.oidc.clientSecret)
          : undefined,
        {
          algorithm: config.oidc.discovery ?? 'oidc',
          ...(config.oidc.allowLocalHttp && config.mode === 'development'
            ? { execute: [oidc.allowInsecureRequests] }
            : {}),
        },
      )
      .catch((e) => {
        discovered = undefined;
        throw e;
      }));
  app.get('/auth/login', loginAdmission, async (req, res) => {
    const c = await client(),
      state = random(),
      nonce = oidc.randomNonce(),
      verifier = oidc.randomPKCECodeVerifier();
    const old = cookie(req, '__Host-haip');
    const previousSessionHash = old ? digestBytes(old) : null;
    const previousSessionActive =
      previousSessionHash !== null &&
      (
        await store.pool.query(
          "SELECT 1 FROM haip_sessions WHERE token_hash=$1 AND data ? 'id' AND data ? 'tenant' AND expires_at>clock_timestamp()",
          [previousSessionHash],
        )
      ).rowCount === 1;
    const returnTo =
      typeof req.query.return_to === 'string' &&
      /^\/review\/[a-f0-9-]{36}$/.test(req.query.return_to)
        ? req.query.return_to
        : '/inbox';
    const data = JSON.stringify({
      login: {
        state,
        nonce,
        verifier,
        returnTo,
        previousSessionHash,
        previousSessionActive,
      },
    });
    // A pending login cookie is a browser-local flow handle. Replacing its generation
    // also invalidates a callback already exchanging a code, including anonymous starts.
    // Never adopt a supplied handle unless it identifies our own unexpired login record.
    const pending = cookie(req, '__Host-haip-login');
    const renewed = pending
      ? await store.pool.query(
          `UPDATE haip_sessions SET data=$2,expires_at=clock_timestamp()+interval '10 minutes'
           WHERE token_hash=$1 AND data ? 'login' AND expires_at>clock_timestamp()`,
          [digestBytes(pending), data],
        )
      : undefined;
    const session = renewed?.rowCount === 1 ? pending! : random();
    if (renewed?.rowCount !== 1)
      await store.pool.query(
        "INSERT INTO haip_sessions(token_hash,data,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')",
        [digestBytes(session), data],
      );
    res.cookie('__Host-haip-login', session, {
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600000,
    });
    res.redirect(
      oidc.buildAuthorizationUrl(c, {
        redirect_uri: callback,
        scope: 'openid',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }).href,
    );
  });
  app.get('/auth/callback', loginAdmission, async (req, res) => {
    const token = cookie(req, '__Host-haip-login');
    requireThat(token, 401, 'invalid_login');
    requireThat(typeof req.query.state === 'string', 401, 'invalid_login');
    // Claim once before token exchange, retaining the generation until finalisation.
    // Network I/O holds no database lock. A new login can replace this generation.
    const { rows } = await store.pool.query(
      `UPDATE haip_sessions SET data=jsonb_set(data,'{login,claimed}','true'::jsonb)
       WHERE token_hash=$1 AND data ? 'login' AND NOT (data->'login' ? 'claimed')
         AND data->'login'->>'state'=$2 AND expires_at>clock_timestamp() RETURNING data`,
      [digestBytes(token), req.query.state],
    );
    const login = rows[0]?.data.login;
    requireThat(login, 401, 'invalid_login');
    // The login cookie binds the browser; also bind its authenticated/anonymous state.
    // Keep Lax cookies so a legitimate top-level OIDC redirect can supply both cookies.
    const current = cookie(req, '__Host-haip');
    requireThat(
      (login.previousSessionHash ?? null) === (current ? digestBytes(current) : null),
      401,
      'login_session_changed',
    );
    const tokens = await oidc.authorizationCodeGrant(
      await client(),
      new URL(req.originalUrl, config.origin),
      {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    requireThat(claims?.sub && claims.iss === config.oidc.issuer, 401, 'invalid_identity');
    const users = (
      await store.pool.query(
        "SELECT * FROM haip_principals WHERE kind='human' AND config->>'oidc_subject'=$1 AND config->>'oidc_issuer'=$2 AND config->>'enabled'='true'",
        [claims.sub, claims.iss],
      )
    ).rows;
    requireThat(users.length === 1, 403, 'directory_identity_unavailable');
    const user = users[0] as Principal;
    requireThat(user.config.identity_certain !== false, 503, 'identity_uncertain');
    const session = random(),
      data: HumanSession = {
        tenant: user.tenant,
        id: user.id,
        csrf: random(),
        authenticated_at: new Date().toISOString(),
      };
    // Finalise only the claimed generation and, when present at login start, a still
    // active initiating session. A failed insert rolls back both deletions, while the
    // earlier claim remains consumed. Newer login state is never deleted by this callback.
    const replacement = await store.pool.query(
      `WITH current_login AS (
        DELETE FROM haip_sessions
        WHERE token_hash=$5 AND data->'login'->>'state'=$6
          AND data->'login'->>'claimed'='true' AND expires_at>clock_timestamp()
        RETURNING token_hash
      ), previous_session AS (
        DELETE FROM haip_sessions
        WHERE token_hash=$1 AND data ? 'id' AND data ? 'tenant'
          AND (NOT $4::boolean OR expires_at>clock_timestamp())
          AND EXISTS (SELECT 1 FROM current_login)
        RETURNING token_hash
      )
      INSERT INTO haip_sessions(token_hash,data,expires_at)
      SELECT $2,$3,clock_timestamp()+interval '8 hours'
      WHERE EXISTS (SELECT 1 FROM current_login)
        AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM previous_session))`,
      [
        login.previousSessionHash ?? null,
        digestBytes(session),
        JSON.stringify(data),
        login.previousSessionActive ?? login.previousSessionHash != null,
        digestBytes(token),
        login.state,
      ],
    );
    requireThat(replacement.rowCount === 1, 401, 'login_session_changed');
    res.clearCookie('__Host-haip-login', {
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    res.cookie('__Host-haip', session, {
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 8 * 3600000,
    });
    res.redirect(login.returnTo);
  });
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization) {
      const token = req.headers.authorization.match(/^Bearer ([A-Za-z0-9_-]{32,200})$/)?.[1];
      requireThat(token, 401, 'unauthenticated');
      const { rows } = await store.pool.query(
        "SELECT * FROM haip_principals WHERE token_hash=$1 AND kind!='human'",
        [digestBytes(token)],
      );
      requireThat(rows[0]?.config.enabled, 401, 'unauthenticated');
      req.principal = rows[0];
    } else {
      const pagePath = new URL(req.originalUrl, config.origin).pathname;
      const token = cookie(req, '__Host-haip');
      if (
        !token &&
        req.method === 'GET' &&
        (/^\/review\/[a-f0-9-]{36}$/.test(pagePath) || pagePath === '/inbox')
      ) {
        res.redirect('/auth/login?return_to=' + encodeURIComponent(pagePath));
        return;
      }
      requireThat(token, 401, 'unauthenticated');
      const { rows } = await store.pool.query(
        'SELECT data FROM haip_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()',
        [digestBytes(token)],
      );
      const data = rows[0]?.data;
      requireThat(data?.id && data.tenant, 401, 'unauthenticated');
      const user = (
        await store.pool.query(
          "SELECT * FROM haip_principals WHERE tenant=$1 AND id=$2 AND kind='human'",
          [data.tenant, data.id],
        )
      ).rows[0];
      requireThat(user?.config.enabled, 401, 'unauthenticated');
      req.principal = user;
      req.humanSession = data;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const csrf = req.headers['x-csrf-token'],
          supplied = typeof csrf === 'string' ? Buffer.from(csrf, 'utf8') : Buffer.alloc(0),
          expected =
            typeof data.csrf === 'string' ? Buffer.from(data.csrf, 'utf8') : Buffer.alloc(0);
        requireThat(
          req.headers.origin === config.origin &&
            supplied.length > 0 &&
            supplied.length === expected.length &&
            timingSafeEqual(supplied, expected),
          403,
          'csrf',
        );
      }
    }
    next();
  };
  app.use(
    ['/v2', '/review', '/inbox', '/auth/session', '/auth/logout'],
    credentialAdmission,
    authenticate,
  );
  app.use(['/review', '/inbox', '/auth/session', '/auth/logout'], humanAdmission);
  app.get('/auth/session', humanAdmission, (req, res) => {
    requireThat(req.humanSession, 403, 'human_required');
    res.json({ subject: req.principal.id, csrf: req.humanSession.csrf });
  });
  app.post('/auth/logout', humanAdmission, async (req, res) => {
    const token = cookie(req, '__Host-haip');
    if (token)
      await store.pool.query('DELETE FROM haip_sessions WHERE token_hash=$1', [digestBytes(token)]);
    res.clearCookie('__Host-haip', { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });
}
