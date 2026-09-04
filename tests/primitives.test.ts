import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from 'node:crypto';
import { canonicalise, digest, parseJson, signRecord, verifyRecord } from '@haip/protocol/crypto';
import { PROTOCOL_REVISION } from '@haip/protocol';
test('RFC 8785 property ordering, UTF-16 and number serialisation', () => {
  assert.equal(canonicalise({ b: 1, a: [4.5, 2e-3, 1e-27] }), '{"a":[4.5,0.002,1e-27],"b":1}');
  assert.equal(canonicalise({ '\uE000': 1, '😀': 2, a: 3 }), '{"a":3,"😀":2,"":1}');
  assert.equal(canonicalise(-0), '0');
  assert.equal(canonicalise(333333333.33333329), '333333333.3333333');
});

test('rotation preserves original signatures and enforces exclusive key-validity and revocation boundaries', () => {
  const old = generateKeyPairSync('ed25519'),
    next = generateKeyPairSync('ed25519');
  const issuer = 'https://trusted.example',
    at = '2026-08-30T12:00:00.000Z';
  const key = (pair: typeof old, key_id: string) => ({
    key_id,
    algorithm: 'Ed25519' as const,
    public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    not_before: '2026-01-01T00:00:00.000Z',
    not_after: '2026-09-01T00:00:00.000Z',
  });
  const trust = {
    issuer,
    protocol_revision: PROTOCOL_REVISION,
    keys: [key(old, 'old'), key(next, 'new')],
  };
  const header = {
    issuer,
    protocol_revision: PROTOCOL_REVISION,
    audience: 'producer',
    tenant: 'tenant',
    type: 'DecisionReceipt',
    purpose: 'review' as const,
    profiles: {},
    key_id: 'old',
    issued_at: at,
  };
  const record = signRecord(
    { response_digest: digest({ choice: 'accept' }) },
    header,
    old.privateKey,
  );
  const expected = {
    issuer,
    audience: 'producer',
    type: 'DecisionReceipt',
    tenant: 'tenant',
    purpose: 'review',
  };
  const original = canonicalise(record);
  verifyRecord(record, trust, expected, new Date('2027-01-01'));
  verifyRecord(
    signRecord(record.payload, { ...header, key_id: 'new' }, next.privateKey),
    trust,
    expected,
  );
  assert.equal(canonicalise(record), original);
  assert.throws(() => verifyRecord(record, { ...trust, keys: [trust.keys[1]!] }, expected));
  assert.throws(() =>
    verifyRecord(record, { ...trust, keys: [{ ...trust.keys[0]!, not_after: at }] }, expected),
  );
  assert.throws(() =>
    verifyRecord(record, { ...trust, keys: [{ ...trust.keys[0]!, revoked_at: at }] }, expected),
  );
  verifyRecord(
    record,
    { ...trust, keys: [{ ...trust.keys[0]!, revoked_at: '2026-08-30T12:00:00.001Z' }] },
    expected,
  );
  assert.throws(() =>
    verifyRecord(record, trust, { ...expected, issuer: 'https://untrusted.example' }),
  );
});
test('RFC 8032 test vector 1 uses the authoritative empty-message signature', () => {
  const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  const key = createPrivateKey({
    key: Buffer.from('302e020100300506032b657004220420' + seed, 'hex'),
    format: 'der',
    type: 'pkcs8',
  });
  const expected =
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
  assert.equal(sign(null, Buffer.alloc(0), key).toString('hex'), expected);
  assert.equal(
    createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  );
  assert(verify(null, Buffer.alloc(0), createPublicKey(key), Buffer.from(expected, 'hex')));
});
test('unambiguous parser rejects lossy and executable JSON edge cases', () => {
  for (const input of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '"\\ud800"',
    '1e400',
    '9007199254740993',
    '0.100000000000000001',
    '[1,]',
    '{"a":1,}',
    'true false',
    '\u00a0null',
    '1e-400',
  ])
    assert.throws(() => parseJson(input), input);
  for (const input of ['1.5', '0.1', '1e-7', '2.0', '-0'])
    assert.equal(canonicalise(parseJson(input)), canonicalise(JSON.parse(input)));
  assert.throws(() => canonicalise(NaN));
  assert.throws(() => canonicalise('\udfff'));
  assert.equal(
    digest(parseJson('{"__proto__":{"x":1}}')),
    digest(JSON.parse('{"__proto__":{"x":1}}')),
  );
});
