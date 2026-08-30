import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '@haip/protocol/crypto';
import { environment } from './environment.js';
let env: Awaited<ReturnType<typeof environment>>, browser: Browser;
before(async () => {
  env = await environment();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.HAIP_TEST_CHROMIUM ? { executablePath: process.env.HAIP_TEST_CHROMIUM } : {}),
  });
});
after(async () => {
  await browser?.close();
  await env?.close();
});
async function signIn(page: any, url: string) {
  await page.goto(env.origin + url);
  await page.getByRole('textbox', { name: 'User' }).fill('reviewer');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(env.origin + url);
}
test('browser OIDC, app replay, restricted tool bridge, escaped text and trusted confirmation', async () => {
  const built = await build({
    stdin: {
      contents: await readFile(new URL('../examples/http/choice-app.js', import.meta.url), 'utf8'),
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const html =
    '<!doctype html><body><script>window.__HAIP_TEST_PROBE__=true;</script><script type="module">' +
    built.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
    '</script></body>';
  const bundle = await env.api(
    '/v2/bundles',
    {
      html,
      compatibility: { ext_apps: '1.7.4', mcp_sdk: '1.29.0' },
      author: 'Independent HTTP fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(bundle.status, 201);
  const created = await env.api(
    '/v2/requests',
    env.request(false, {
      bundle_id: bundle.body.id,
      profiles: { 'haip.mcp-app': '1-draft.1' },
      response_schema: JSON.parse(
        await readFile(new URL('../examples/http/review.json', import.meta.url), 'utf8'),
      ).response_schema,
      summary: '<script>window.compromised=true</script>',
      review_document: '<img src=x onerror="window.compromised=true">',
    }),
  );
  assert.equal(created.status, 201);
  const context = await browser.newContext(),
    page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(msg.text());
  });
  page.on('requestfailed', (req) =>
    console.error('Browser request failed:', req.url(), req.failure()?.errorText),
  );
  await signIn(page, '/review/' + created.body.request.id);
  await page.getByText('Producer review app (isolated)', { exact: true }).click();
  const outer = page.frameLocator('#app iframe'),
    inner = outer.frameLocator('iframe');
  try {
    await inner.getByRole('button', { name: 'Propose choice' }).waitFor({ timeout: 10000 });
  } catch (e) {
    console.error(
      'Frames',
      page.frames().map((f) => f.url()),
    );
    console.error('App state', await page.locator('#app-state').textContent());
    throw e;
  }
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
  await frame.waitForFunction(
    () =>
      window.probe?.inputs === 1 && window.probe?.results === 1 && window.probe?.forbidden === true,
  );
  const probe = await frame.evaluate(() => window.probe);
  assert.equal(probe.storage, false);
  assert.equal(probe.inputs, 1);
  assert.equal(probe.results, 1);
  // Wrong-source direct messages and repeated handshakes cannot propose or replay stored input.
  await frame.evaluate(() => {
    top!.postMessage(
      {
        jsonrpc: '2.0',
        id: 9001,
        method: 'tools/call',
        params: {
          name: 'haip_propose_decision',
          arguments: { decision: 'answer', response: { choice: 'decline' } },
        },
      },
      '*',
    );
    parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
    parent.postMessage({ jsonrpc: '2.0', id: 9002, method: 'ui/initialize', params: {} }, '*');
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(
    (await env.api(`/v2/requests/${created.body.request.id}/material`)).body.candidate,
    null,
  );
  const afterReplay = await frame.evaluate(() => window.probe);
  assert.equal(afterReplay.inputs, 1);
  assert.equal(afterReplay.results, 1);
  assert.equal(await page.evaluate(() => window.compromised), undefined);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-haip')!;
  assert(session.secure && session.httpOnly && session.sameSite === 'Lax');
  assert.equal(
    await frame.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        return 'blocked';
      }
    }),
    'blocked',
  );
  await inner.getByLabel('Your choice').selectOption('accept');
  await inner.getByRole('button', { name: 'Propose choice' }).click();
  await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
  assert.equal(
    (await env.api('/v2/requests/' + created.body.request.id)).body.decision_state,
    'pending',
  );
  await inner.getByText('Stored review payload', { exact: true }).click();
  assert.match((await inner.locator('#stored').textContent()) ?? '', /A stored support message/);
  assert.match(
    (await page.locator('#proposal-source').textContent()) ?? '',
    /Source: producer app/,
  );
  const frozen = (await env.api(`/v2/requests/${created.body.request.id}/material`)).body.candidate;
  assert.deepEqual(JSON.parse((await page.locator('#exact').textContent())!), frozen);
  assert.equal(await page.locator('#candidate-digest').textContent(), digest(frozen));
  const browserOutput = join(
    process.env.HAIP_VALIDATION_DIR ?? '.local/validation/current',
    'playwright',
  );
  await mkdir(browserOutput, { recursive: true });
  await page.screenshot({ path: join(browserOutput, 'trusted-review.png'), fullPage: true });
  await page
    .locator('#confirmation')
    .screenshot({ path: join(browserOutput, 'frozen-confirmation.png') });
  await page.getByRole('button', { name: 'Confirm this exact response' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('confirmed'),
  );
  assert.equal(
    (await env.api('/v2/requests/' + created.body.request.id)).body.receipt.payload.decision,
    'answer',
  );
  assert.deepEqual(errors, []);
  const denied = await frame.evaluate(async () => ({
    network: await fetch(location.origin + '/forbidden').then(
      () => false,
      () => true,
    ),
    popup: window.open('about:blank') === null,
    parent: (() => {
      try {
        void parent.document;
        return false;
      } catch {
        return true;
      }
    })(),
  }));
  assert.deepEqual(denied, { network: true, popup: true, parent: true });
  const { createServer } = await import('node:http');
  let outbound = 0;
  const sink = createServer((_req, res) => {
    outbound++;
    res.end('forbidden');
  });
  sink.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => sink.once('listening', resolve));
  const sinkURL = 'http://127.0.0.1:' + (sink.address() as any).port + '/leak';
  await frame.evaluate((url) => {
    location.href = url;
  }, sinkURL);
  await page.waitForTimeout(200);
  assert.equal(outbound, 0, 'Sandbox navigation must not reach a network destination');
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  await context.close();
});

async function hostileReview() {
  const built = await build({
    stdin: {
      contents: `import { App } from '@modelcontextprotocol/ext-apps';
        document.body.innerHTML = '<h1>Adversarial proposal fixture</h1><p>Stored app; proposals cannot confirm.</p>';
        const app = new App({ name: 'Adversarial proposal fixture', version: '1.0.0' }, {});
        window.attacks = { inputs: 0, results: 0, hostRequests: [] };
        window.addEventListener('message', event => {
          if (event.source === parent && event.data?.method === 'ping') {
            event.stopImmediatePropagation();
            window.attacks.hostRequests.push(event.data);
          }
        });
        app.ontoolinput = () => window.attacks.inputs++;
        app.ontoolresult = () => window.attacks.results++;
        window.attacks.propose = async score => {
          try {
            return { ok: true, result: await app.callServerTool({
              name: 'haip_propose_decision',
              arguments: { decision: 'answer', response: { choice: score % 2 ? 'accept' : 'decline', score } }
            }) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        };
        await app.connect();`,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const bundle = await env.api(
    '/v2/bundles',
    {
      html:
        '<!doctype html><body><script type="module">' +
        built.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
        '</script></body>',
      compatibility: { ext_apps: '1.7.4', mcp_sdk: '1.29.0' },
      author: 'Adversarial browser fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(bundle.status, 201);
  const created = await env.api(
    '/v2/requests',
    env.request(false, { bundle_id: bundle.body.id, profiles: { 'haip.mcp-app': '1-draft.1' } }),
  );
  assert.equal(created.status, 201);
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.addInitScript(() => {
    window.proxyMessages = [];
    window.addEventListener('message', (event) => {
      const proxy = document.querySelector<HTMLIFrameElement>('#app > iframe');
      if (proxy && event.source === proxy.contentWindow) window.proxyMessages.push(event.data);
    });
  });
  await signIn(page, '/review/' + created.body.request.id);
  await page.getByText('Producer review app (isolated)', { exact: true }).click();
  await page.frameLocator('#app > iframe').frameLocator('iframe').getByRole('heading').waitFor();
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
  await frame.waitForFunction(() => window.attacks?.inputs === 1 && window.attacks?.results === 1);
  return {
    context,
    page,
    frame,
    id: created.body.request.id,
    bundle: created.body.request.review.bundle,
  };
}

test('hostile proposals cannot overtake a pending candidate, replace frozen review or race confirmation', async () => {
  const { context, page, frame, id, bundle } = await hostileReview();
  const proposalReceived = Promise.withResolvers<void>(),
    releaseProposal = Promise.withResolvers<void>(),
    confirmationReceived = Promise.withResolvers<void>(),
    releaseConfirmation = Promise.withResolvers<void>();
  const proposals: unknown[] = [];
  let confirmBody: any;
  try {
    await page.route(`**/v2/requests/${id}/candidates`, async (route) => {
      proposals.push(route.request().postDataJSON());
      const response = await route.fetch();
      proposalReceived.resolve();
      await releaseProposal.promise;
      await route.fulfill({ response });
    });
    await frame.evaluate(() => {
      window.attacks.first = window.attacks.propose(1);
    });
    await proposalReceived.promise;
    // The first real HTTP response is deliberately withheld while a hostile app sends B.
    const duringPreparation = await frame.evaluate(() => window.attacks.propose(2));
    assert.equal(duringPreparation.ok, false);
    assert.match(duringPreparation.error, /already frozen or being prepared/);
    assert.equal(await page.getByLabel('Response (JSON)').isDisabled(), true);
    await page.evaluate(() =>
      document.querySelector('#proposal')!.dispatchEvent(new Event('submit', { cancelable: true })),
    );
    assert.equal(proposals.length, 1, 'concurrent app/form proposals must not reach the server');
    releaseProposal.resolve();
    assert.equal((await frame.evaluate(() => window.attacks.first)).ok, true);
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    const candidate = (await env.api(`/v2/requests/${id}/material`)).body.candidate;
    assert.equal(candidate.response.score, 1);
    assert.deepEqual(JSON.parse((await page.locator('#exact').textContent())!), candidate);
    assert.equal(await page.locator('#candidate-digest').textContent(), digest(candidate));
    const source = (await page.locator('#proposal-source').textContent())!;
    for (const value of [bundle.publisher, bundle.id, bundle.digest])
      assert(source.includes(value));
    assert.equal((await frame.evaluate(() => window.attacks.propose(3))).ok, false);
    assert.deepEqual(JSON.parse((await page.locator('#exact').textContent())!), candidate);
    await page.route(`**/v2/requests/${id}/confirm`, async (route) => {
      confirmBody = route.request().postDataJSON();
      confirmationReceived.resolve();
      await releaseConfirmation.promise;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Confirm this exact response' }).click();
    await confirmationReceived.promise;
    assert.equal((await frame.evaluate(() => window.attacks.propose(4))).ok, false);
    assert.equal(
      await page.getByRole('button', { name: 'Dismiss this response' }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Confirm this exact response' }).isDisabled(),
      true,
    );
    assert.deepEqual(JSON.parse((await page.locator('#exact').textContent())!), candidate);
    assert.deepEqual(confirmBody, {
      candidate_id: candidate.id,
      candidate_digest: digest(candidate),
    });
    assert.equal(
      proposals.length,
      1,
      'hostile messages must not replace the server candidate during confirmation',
    );
    assert.equal((await env.api('/v2/requests/' + id)).body.decision_state, 'pending');
    releaseConfirmation.resolve();
    await page.waitForFunction(() =>
      document.querySelector('#status')?.textContent?.includes('confirmed'),
    );
    const receipt = (await env.api('/v2/requests/' + id)).body.receipt.payload;
    assert.equal(receipt.candidate_id, candidate.id);
    assert.equal(receipt.candidate_digest, digest(candidate));
    assert.equal(receipt.response_digest, digest(candidate.response));
  } finally {
    releaseProposal.resolve();
    releaseConfirmation.resolve();
    await context.close();
  }
});

test('dismissal requires a new trusted gesture and every candidate field remains visible', async () => {
  const { context, page, frame, id } = await hostileReview();
  try {
    await page.getByLabel('Response (JSON)').fill('{"choice":"accept","score":10}');
    await page.getByRole('button', { name: 'Review this response' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    assert.equal(
      await page.locator('#proposal-source').textContent(),
      'Source: trusted host response form.',
    );
    await page.getByRole('button', { name: 'Dismiss this response' }).click();
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal((await frame.evaluate(() => window.attacks.propose(20))).ok, false);
    await page.evaluate(() =>
      (document.querySelector('#allow-app-proposal') as HTMLButtonElement).click(),
    );
    assert.equal(
      (await frame.evaluate(() => window.attacks.propose(21))).ok,
      false,
      'synthetic clicks cannot rearm app proposals',
    );
    assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate.response.score, 10);
    await page.getByLabel('Response (JSON)').fill('{"choice":"decline","score":30}');
    await page.getByRole('button', { name: 'Review this response' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate.response.score, 30);
    await page.getByRole('button', { name: 'Dismiss this response' }).click();
    await page.getByRole('button', { name: 'Allow one new app proposal' }).click();
    assert.equal((await frame.evaluate(() => window.attacks.propose(40))).ok, true);
    assert.equal(
      (await frame.evaluate(() => window.attacks.propose(41))).ok,
      false,
      'one gesture admits at most one proposal',
    );
    const candidate = (await env.api(`/v2/requests/${id}/material`)).body.candidate;
    const displayed = JSON.parse((await page.locator('#exact').textContent())!);
    assert.deepEqual(
      displayed,
      candidate,
      'full record is displayed, including IDs, reviewer, revision and canonical response',
    );
    assert.deepEqual(
      Object.keys(displayed).sort(),
      [
        'id',
        'request_id',
        'request_digest',
        'reviewer',
        'revision',
        'response',
        'response_canonical',
        'response_digest',
        'decision',
        'created_at',
      ].sort(),
    );
    assert.equal(candidate.response.score, 40);
    assert.equal(await page.locator('#candidate-digest').textContent(), digest(candidate));
    assert.match((await page.locator('#proposal-source').textContent())!, /Source: producer app/);
    await page.evaluate(() => (document.querySelector('#confirm') as HTMLButtonElement).click());
    assert.equal(
      (await env.api('/v2/requests/' + id)).body.decision_state,
      'pending',
      'synthetic confirmation cannot record a decision',
    );
    await page.getByRole('button', { name: 'Confirm this exact response' }).click();
    await page.waitForFunction(() =>
      document.querySelector('#status')?.textContent?.includes('confirmed'),
    );
    assert.equal(
      (await env.api('/v2/requests/' + id)).body.receipt.payload.candidate_id,
      candidate.id,
    );
  } finally {
    await context.close();
  }
});

test('sandbox accepts only one exact correlated response and rejects method-less spoofing', async () => {
  const { context, page, frame } = await hostileReview();
  let barrier = 0;
  const send = async (messages: unknown[]) => {
    const marker = ++barrier;
    await frame.evaluate(
      ({ messages, marker }) => {
        for (const message of messages) parent.postMessage(message, '*');
        parent.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/size-changed',
            params: { width: marker, height: 100 },
          },
          '*',
        );
      },
      { messages, marker },
    );
    await page.waitForFunction(
      (marker) =>
        window.proxyMessages.some(
          (message) =>
            message.method === 'ui/notifications/size-changed' && message.params.width === marker,
        ),
      marker,
    );
  };
  const received = (id: string | number) =>
    page.evaluate((id) => window.proxyMessages.filter((message) => message.id === id), id);
  const hostRequest = async (id: string | number) => {
    await page.evaluate((id) => {
      const proxy = document.querySelector<HTMLIFrameElement>('#app > iframe')!;
      proxy.contentWindow!.postMessage(
        { jsonrpc: '2.0', method: 'ping', id },
        new URL(proxy.src).origin,
      );
    }, id);
    await frame.waitForFunction(
      (id) => window.attacks.hostRequests.some((request) => request.id === id),
      id,
    );
  };
  try {
    await send([
      { jsonrpc: '2.0', id: 'unsolicited', result: {} },
      { jsonrpc: '2.0', id: 'unsolicited', error: { code: -32603, message: 'spoof' } },
      { jsonrpc: '2.0', id: 'empty-method', method: '', result: {} },
      { jsonrpc: '2.0', id: 'null-method', method: null, result: {} },
    ]);
    for (const id of ['unsolicited', 'empty-method', 'null-method'])
      assert.deepEqual(await received(id), []);
    await hostRequest('fixture:one');
    await send([
      { jsonrpc: '2.0', id: 'fixture:one', result: {}, error: { code: -32603, message: 'both' } },
      { jsonrpc: '2.0', id: 'fixture:one', error: { code: 'invalid', message: 'wrong type' } },
      { jsonrpc: '2.0', id: 'fixture:one', method: undefined, result: {} },
      { jsonrpc: '2.0', id: 'fixture:one', result: null },
      { jsonrpc: '2.0', id: 'fixture:one', result: {}, params: { spoof: true } },
    ]);
    assert.deepEqual(
      await received('fixture:one'),
      [],
      'invalid replies cannot consume or satisfy a pending host request',
    );
    const accepted = { jsonrpc: '2.0', id: 'fixture:one', result: { accepted: true } };
    await send([accepted, accepted]);
    assert.deepEqual(
      await received('fixture:one'),
      [accepted],
      'only the first matching response is forwarded',
    );
    await hostRequest(9007);
    await send([{ jsonrpc: '2.0', id: '9007', result: { spoof: true } }]);
    assert.deepEqual(await received('9007'), [], 'request ID types cannot be substituted');
    const error = { jsonrpc: '2.0', id: 9007, error: { code: -32603, message: 'test response' } };
    await send([error, error]);
    assert.deepEqual(await received(9007), [error]);
    assert.deepEqual(
      await frame.evaluate(() => ({
        inputs: window.attacks.inputs,
        results: window.attacks.results,
      })),
      { inputs: 1, results: 1 },
    );
  } finally {
    await context.close();
  }
});
test('near-10-MiB payload remains searchable through the last of 1,000 steps', async () => {
  const payload = {
    steps: Array.from({ length: 1000 }, (_, i) => ({
      step: i,
      detail: 'x'.repeat(10000),
      marker: i === 999 ? 'final-step-visible' : 'ordinary',
    })),
  };
  const created = await env.api('/v2/requests', env.request(false, { payload }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const context = await browser.newContext(),
    page = await context.newPage();
  await signIn(page, '/review/' + created.body.request.id);
  await page.waitForFunction(() =>
    document.querySelector('#page-state')?.textContent?.includes('3000 fields'),
  );
  await page.getByRole('searchbox').fill('final-step-visible');
  await page.waitForFunction(() =>
    document.querySelector('#payload')?.textContent?.includes('999'),
  );
  assert.match((await page.locator('#payload').textContent()) ?? '', /final-step-visible/);
  assert.match((await page.locator('#page-state').textContent()) ?? '', /1 fields/);
  await context.close();
});
