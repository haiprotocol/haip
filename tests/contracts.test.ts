import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { environment } from './environment.js';
import { digest } from '@haip/protocol/crypto';

test('public discovery, directory, review, assignment, events and metrics match the published schema', async () => {
  const env = await environment();
  try {
    const schema = JSON.parse(await readFile('protocol/draft-2.0.0-1/schema.json', 'utf8'));
    const ajv = new Ajv2020({ strict: true });
    (addFormats as any)(ajv);
    ajv.addSchema(schema);
    const check = (name: string, body: unknown) => {
      const validate = ajv.getSchema(schema.$id + '#/$defs/' + name)!;
      assert.ok(validate(body), name + ': ' + JSON.stringify(validate.errors));
    };
    check('Discovery', await (await fetch(env.origin + '/.well-known/haip')).json());
    check('TrustManifest', env.trust);
    const created = await env.api(
      '/v2/requests',
      env.request(false, { metadata: { arbitrary_non_authorising: 'retained' } }),
    );
    check('RequestStatus', created.body);
    const id = created.body.request.id;
    check('Material', (await env.api(`/v2/requests/${id}/material`)).body);
    check('RequestList', (await env.api('/v2/requests')).body);
    const human = await env.login();
    check('Assignment', (await human.call(`/v2/requests/${id}/assignment`, {})).body);
    const proposal = await human.call(`/v2/requests/${id}/candidates`, {
      decision: 'answer',
      response: { choice: 'accept', score: 0.1 },
    });
    check('DecisionCandidate', proposal.body);
    check(
      'SignedRecord',
      (
        await human.call(`/v2/requests/${id}/confirm`, {
          candidate_id: proposal.body.id,
          candidate_digest: digest(proposal.body),
        })
      ).body,
    );
    await env.flush();
    check('RequestStatus', (await env.api(`/v2/requests/${id}`)).body);
    check('EventPage', (await env.api('/v2/events')).body);
    check(
      'MetricsSnapshot',
      (await env.api('/v2/admin/metrics', undefined, env.credentials.operator)).body,
    );
    check(
      'LedgerPage',
      (await env.api('/v2/admin/ledger', undefined, env.credentials.operator)).body,
    );
    check('HitlPoll', (await env.api(`/v2/hitl/${id}/poll`)).body);
    const spec = JSON.parse(await readFile('protocol/draft-2.0.0-1/openapi.json', 'utf8'));
    for (const path of Object.values(spec.paths) as any[])
      for (const operation of Object.values(path) as any[]) {
        assert.ok(operation.responses['200']?.content || operation.responses['201']?.content);
      }
  } finally {
    await env.close();
  }
});

test('the public schema binds execution purpose to the execution profile and receipt semantics', async () => {
  const env = await environment();
  try {
    const schema = JSON.parse(await readFile('protocol/draft-2.0.0-1/schema.json', 'utf8'));
    const ajv = new Ajv2020({ strict: true });
    (addFormats as any)(ajv);
    ajv.addSchema(schema);
    const conforms = (name: string, value: unknown) =>
      ajv.getSchema(schema.$id + '#/$defs/' + name)!(value);
    const reviewer = await env.login();
    const execution = env.request(true).execution;
    for (const executable of [false, true]) {
      const input = env.request(executable);
      assert.equal(conforms('RequestInput', input), true);
      const created = await env.api('/v2/requests', input);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const request = created.body.request;
      assert.equal(conforms('DecisionRequest', request), true);
      for (const [name, value] of [
        ['RequestInput', input],
        ['DecisionRequest', request],
      ] as const) {
        const invalid = structuredClone(value) as any;
        if (executable) {
          delete invalid.execution;
          assert.equal(conforms(name, invalid), false, 'execution purpose requires a binding');
          invalid.execution = execution;
          invalid.profiles = {};
          assert.equal(
            conforms(name, invalid),
            false,
            'execution purpose requires the execution profile',
          );
          invalid.profiles = { 'haip.execution': 'future-version' };
          assert.equal(
            conforms(name, invalid),
            false,
            'unknown execution version is not this draft',
          );
        } else {
          invalid.execution = execution;
          assert.equal(conforms(name, invalid), false, 'review cannot carry execution authority');
        }
      }
      const candidate = await reviewer.call(`/v2/requests/${request.id}/candidates`, {
        decision: executable ? 'authorise' : 'answer',
        response: { choice: 'accept' },
      });
      assert.equal(candidate.status, 201);
      const confirmed = await reviewer.call(`/v2/requests/${request.id}/confirm`, {
        candidate_id: candidate.body.id,
        candidate_digest: digest(candidate.body),
      });
      assert.equal(confirmed.status, 200);
      const receipt = confirmed.body.payload;
      assert.equal(receipt.purpose, request.purpose);
      assert.equal(conforms('DecisionReceipt', receipt), true);
      const missing = structuredClone(receipt);
      delete missing.purpose;
      assert.equal(conforms('DecisionReceipt', missing), false, 'receipt purpose is mandatory');
      assert.equal(
        conforms('DecisionReceipt', {
          ...receipt,
          purpose: executable ? 'review' : 'authorise_execution',
        }),
        false,
        'receipt purpose must match its decision and deadline',
      );
      const deadline = structuredClone(receipt);
      if (executable) delete deadline.grant_deadline;
      else deadline.grant_deadline = '2026-09-01T00:00:00Z';
      assert.equal(conforms('DecisionReceipt', deadline), false);
    }
  } finally {
    await env.close();
  }
});
