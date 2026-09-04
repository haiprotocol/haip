import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { HAIPClient } from '@haip/sdk';
import { digest, canonicalise } from '@haip/protocol/crypto';
import { runCounter } from '../examples/http/counter.js';
import { environment } from './environment.js';

test('counter reads consume both admission validity and the single window starting at its launch fence', async () => {
  const env = await environment(),
    root = await mkdtemp(join(tmpdir(), 'haip-counter-time-'));
  let writer: ChildProcess | undefined;
  try {
    for (const window of ['admission', 'execution']) {
      await env.put('/v2/admin/routes/review', {
        ...env.route,
        limits: {
          ...env.route.limits,
          grant_seconds: window === 'admission' ? 1 : 30,
          execution_seconds: window === 'execution' ? 1 : 30,
        },
      });
      const input = env.request(true);
      input.execution.execution_seconds = window === 'execution' ? 1 : 30;
      const created = await env.api('/v2/requests', input),
        id = created.body.request.id;
      assert.equal(created.status, 201);
      const human = await env.login();
      const c = await human.call(`/v2/requests/${id}/candidates`, {
        decision: 'authorise',
        response: { choice: 'accept' },
      });
      assert.equal(
        (
          await human.call(`/v2/requests/${id}/confirm`, {
            candidate_id: c.body.id,
            candidate_digest: digest(c.body),
          })
        ).status,
        200,
      );
      await env.flush();
      const directory = join(root, window),
        counter = join(directory, 'counter.json');
      await mkdir(directory);
      execFileSync('mkfifo', [counter]);
      // A real blocked file read: the delay starts only once the counter has opened its reader.
      writer = spawn(
        'python3',
        [
          '-c',
          'import sys,time\nwith open(sys.argv[1],"w") as f:\n time.sleep(1.2)\n f.write("{\\"count\\":0}")',
          counter,
        ],
        { stdio: 'ignore' },
      );
      const client = new HAIPClient(env.origin, env.credentials.producer, true);
      const options = {
        client,
        requestId: id,
        directory,
        trust: env.trust,
        tenant: 'test-tenant',
        producer: 'producer',
        verifyAnchor: async (checkpoint: any, acceptance: any) => {
          assert.equal(await readFile(acceptance.key, 'utf8'), canonicalise(checkpoint));
        },
      };
      await assert.rejects(
        runCounter(options),
        window === 'admission' ? /Admission expired/ : /Execution window expired/,
      );
      assert.equal(
        (await stat(counter)).isFIFO(),
        true,
        'expired execution must not replace the counter',
      );
      await assert.rejects(stat(join(directory, id + '.result.json')), { code: 'ENOENT' });
      assert.ok(await stat(join(directory, id + '.fence')));
      await assert.rejects(runCounter(options), /uncertain/);
      assert.equal((await client.status(id)).execution_state, 'uncertain');
      assert.equal((await stat(counter)).isFIFO(), true, 'reinvocation must not launch again');
      writer = undefined;
    }
  } finally {
    writer?.kill('SIGTERM');
    await env.close();
    await rm(root, { recursive: true, force: true });
  }
});
