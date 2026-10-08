import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import {
  HAIPClient,
  HAIPError,
  canonicalise,
  digest,
  digestBytes,
  verifyRecord,
  type DecisionReceipt,
  type ExecutionClaim,
  type ExecutionOutcome,
  type SignedRecord,
} from '@haip/sdk';
import { runCounter } from '../examples/http/counter.js';
import { environment } from './environment.js';

test(
  'browser refusal prevents execution and explicit authorisation permits one bounded counter effect',
  { timeout: 90000 },
  async () => {
    const env = await environment(),
      root = await mkdtemp(join(tmpdir(), 'haip-browser-execution-'));
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...(process.env.HAIP_TEST_CHROMIUM
          ? { executablePath: process.env.HAIP_TEST_CHROMIUM }
          : {}),
      });
      const context = await browser.newContext(),
        page = await context.newPage(),
        client = new HAIPClient(env.origin, env.credentials.producer, true);
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      await page.goto(env.origin + '/auth/login');
      await page.getByRole('textbox', { name: 'User' }).fill('reviewer');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(env.origin + '/inbox');
      await page.waitForFunction(
        () => document.querySelector('#identity')?.textContent === 'reviewer',
      );
      assert.equal(await page.locator('#identity').textContent(), 'reviewer');
      const session = (await context.cookies()).find((cookie) => cookie.name === '__Host-haip')!;
      assert(session.secure && session.httpOnly && session.sameSite === 'Lax');

      for (const decision of ['refuse', 'authorise'] as const) {
        const response = { choice: decision === 'authorise' ? 'accept' : 'decline' },
          created = await env.api(
            '/v2/requests',
            env.request(true, {
              summary: 'Authorise one local counter increment',
              payload: { action: 'counter.increment', amount: 1, counter: 'test' },
              review_document:
                'This fixed local demonstration increments the test counter once. Refusal permits no execution.',
            }),
          );
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.request.id,
          directory = join(root, decision),
          options = {
            client,
            requestId: id,
            directory,
            trust: env.trust,
            tenant: 'test-tenant',
            producer: 'producer',
            verifyAnchor: async (checkpoint: SignedRecord, acceptance: any) => {
              assert.equal(acceptance.backend, 'test_filesystem');
              const anchored = await readFile(acceptance.key, 'utf8');
              assert.equal(anchored, canonicalise(checkpoint));
              assert.equal(acceptance.digest, digestBytes(anchored));
            },
          };
        const noEffect = async () => {
          for (const file of ['counter.json', id + '.fence', id + '.result.json'])
            await assert.rejects(stat(join(directory, file)), { code: 'ENOENT' });
          const status = await client.status(id);
          assert.equal(status.execution_state, 'unclaimed');
          assert.equal(status.claim, null);
          assert.equal(status.outcome, null);
        };

        await page.goto(env.origin + '/review/' + id);
        await page.waitForFunction(
          () => document.querySelector<HTMLSelectElement>('#decision')?.options.length === 2,
        );
        assert.deepEqual(
          await page
            .locator('#decision option')
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
          ['refuse', 'authorise'],
        );
        assert.equal(await page.locator('#decision').inputValue(), 'refuse');
        const binding = JSON.parse((await page.locator('#binding').textContent())!);
        assert.equal(binding.purpose, 'authorise_execution');
        assert.deepEqual(binding.execution, created.body.request.execution);
        await page.locator('#decision').selectOption(decision);
        await page.getByLabel('Response (JSON)').fill(JSON.stringify(response));
        await page.getByRole('button', { name: 'Review this response', exact: true }).click();
        await page.getByRole('heading', { name: 'Trusted confirmation', exact: true }).waitFor();
        const candidate = JSON.parse((await page.locator('#exact').textContent())!);
        assert.equal(candidate.decision, decision);
        assert.deepEqual(candidate.response, response);
        assert.equal(candidate.request_id, id);
        assert.equal(candidate.reviewer, 'reviewer');
        assert.equal(await page.locator('#candidate-digest').textContent(), digest(candidate));
        assert.equal(
          await page.locator('#proposal-source').textContent(),
          'Source: trusted host response form.',
        );
        assert.deepEqual((await env.api(`/v2/requests/${id}/material`)).body.candidate, candidate);
        assert.equal((await client.status(id)).decision_state, 'pending');
        await assert.rejects(
          runCounter(options),
          (error: unknown) =>
            error instanceof HAIPError &&
            error.status === 409 &&
            error.code === 'authority_revoked',
        );
        await noEffect();

        const evidence = join(
          process.env.HAIP_VALIDATION_DIR ?? '.local/validation/current',
          'playwright',
        );
        await mkdir(evidence, { recursive: true });
        await page
          .locator('#confirmation')
          .screenshot({ path: join(evidence, 'execution-' + decision + '-confirmation.png') });
        const confirmation = page.waitForResponse(
          (result) =>
            result.url() === `${env.origin}/v2/requests/${id}/confirm` &&
            result.request().method() === 'POST',
        );
        await page
          .getByRole('button', { name: 'Confirm this exact response', exact: true })
          .click();
        assert.equal((await confirmation).status(), 200);
        await page.waitForFunction(() =>
          document.querySelector('#status')?.textContent?.includes('confirmed'),
        );
        const confirmed = await client.status(id);
        verifyRecord(confirmed.receipt!, env.trust, {
          issuer: env.origin,
          audience: 'producer',
          tenant: 'test-tenant',
          type: 'DecisionReceipt',
          purpose: 'authorise_execution',
        });
        const receipt = confirmed.receipt!.payload as DecisionReceipt;
        assert.equal(receipt.decision, decision);
        assert.equal(receipt.candidate_digest, digest(candidate));
        assert.equal(receipt.request_digest, created.body.request_digest);
        await noEffect();
        await env.flush();

        if (decision === 'refuse') {
          assert.equal((await client.status(id)).grant_state, 'none');
          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(
              runCounter(options),
              (error: unknown) =>
                error instanceof HAIPError &&
                error.status === 409 &&
                error.code === 'authority_revoked',
            );
            await noEffect();
          }
        } else {
          assert.equal((await client.status(id)).grant_state, 'available');
          const result = await runCounter(options),
            completed = await client.status(id),
            fence = await readFile(join(directory, id + '.fence'), 'utf8');
          assert.deepEqual(result, {
            request_id: id,
            execution_identity: 'counter:' + id,
            count: 1,
          });
          assert.equal(completed.execution_state, 'completed');
          assert.equal(completed.grant_state, 'consumed');
          assert.equal(
            (completed.claim!.payload as ExecutionClaim).execution_identity,
            result.execution_identity,
          );
          verifyRecord(completed.outcome!, env.trust, {
            issuer: env.origin,
            audience: 'producer',
            tenant: 'test-tenant',
            type: 'ExecutionOutcome',
            purpose: 'authorise_execution',
          });
          assert.equal(
            canonicalise((completed.outcome!.payload as { outcome: ExecutionOutcome }).outcome),
            canonicalise({
              execution_identity: result.execution_identity,
              status: 'completed',
              details: { counter: 1 },
            }),
          );
          assert.deepEqual(await runCounter(options), result);
          assert.deepEqual(JSON.parse(await readFile(join(directory, 'counter.json'), 'utf8')), {
            count: 1,
          });
          assert.equal(await readFile(join(directory, id + '.fence'), 'utf8'), fence);
          const replayed = await client.status(id);
          assert.deepEqual(replayed.claim, completed.claim);
          assert.deepEqual(replayed.outcome, completed.outcome);
        }
      }
      assert.deepEqual(browserErrors, []);
    } finally {
      try {
        await browser?.close();
      } finally {
        await env.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
