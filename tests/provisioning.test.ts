import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { bootstrapTenant } from '../haip-server/src/admin.js';
import { environment } from './environment.js';

test('bootstrap refuses short or repeated credentials before writing and accepts generated 32-byte credentials', async () => {
  const env = await environment();
  try {
    for (const token of [
      'a'.repeat(32),
      randomBytes(24).toString('base64url'),
      'a'.repeat(64),
      Buffer.alloc(32).toString('base64url'),
      Buffer.from('0123456789abcdef'.repeat(2)).toString('base64url'),
    ])
      await assert.rejects(
        () => bootstrapTenant(env.service, 'weak-bootstrap', 'operator', token),
        /invalid_bootstrap/,
      );
    assert.equal(
      (await env.store.pool.query("SELECT 1 FROM haip_tenants WHERE id='weak-bootstrap'")).rowCount,
      0,
    );
    for (const encoding of ['base64url', 'hex'] as const) {
      const token = randomBytes(32).toString(encoding);
      await bootstrapTenant(env.service, `bootstrap-${encoding}`, 'operator', token);
      const authenticated = await env.api('/v2/admin/metrics', undefined, token);
      assert.equal(authenticated.status, 200);
    }
  } finally {
    await env.close();
  }
});
