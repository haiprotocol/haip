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
test('browser OIDC, app replay, restricted message bridge, escaped text and trusted confirmation', async () => {
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
      compatibility: { agent_ui: '2' },
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
      profiles: { 'haip.agent-ui': '2' },
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
  const proxy = frame.parentFrame()!;
  await proxy.evaluate(() => {
    window.haipTestRendererMessages = 0;
    const renderer = document.querySelector<HTMLIFrameElement>('iframe')!;
    window.addEventListener('message', (event) => {
      if (event.source === renderer.contentWindow) window.haipTestRendererMessages++;
    });
  });
  await page.evaluate(() => {
    window.haipTestDirectMessages = [];
    window.addEventListener('message', (event) => {
      if (event.data?.id === 9001) window.haipTestDirectMessages.push(event.data);
    });
  });
  await frame.evaluate(() => {
    top!.postMessage(
      {
        jsonrpc: '2.0',
        id: 9001,
        method: 'haip/ui.propose',
        params: { decision: 'answer', response: { choice: 'decline' } },
      },
      '*',
    );
    parent.postMessage({ jsonrpc: '2.0', method: 'haip/ui.initialized', params: {} }, '*');
    parent.postMessage({ jsonrpc: '2.0', id: 9002, method: 'tools/call', params: {} }, '*');
  });
  await proxy.waitForFunction(() => window.haipTestRendererMessages === 2);
  await page.waitForFunction(() => window.haipTestDirectMessages.length === 1);
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
  // Keep the isolated frame on screen during capture: a full-page image alone can
  // omit its pixels after the host scrolls to confirmation. Do not alter app content.
  const viewport = page.viewportSize()!;
  await page.setViewportSize({
    width: viewport.width,
    height: await page.evaluate(() => document.documentElement.scrollHeight),
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await inner.getByText('Stored review payload', { exact: true }).click();
  assert.equal(await inner.locator('#stored').isVisible(), true);
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
  await Promise.all(
    page
      .frames()
      .map((frame) =>
        frame.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        ),
      ),
  );
  await page.screenshot({ path: join(browserOutput, 'trusted-review.png'), fullPage: true });
  await page
    .locator('#confirmation')
    .screenshot({ path: join(browserOutput, 'frozen-confirmation.png') });
  await page.setViewportSize(viewport);
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
  await page.waitForLoadState('networkidle');
  assert.equal(outbound, 0, 'Sandbox navigation must not reach a network destination');
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  await context.close();
});

test('an envelope mismatch prevents View creation and disables further app proposals', async () => {
  const bundle = await env.api(
    '/v2/bundles',
    {
      html: '<!doctype html><body><p>Envelope fixture</p></body>',
      compatibility: { agent_ui: '2' },
      author: 'Envelope fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(bundle.status, 201);
  const created = await env.api(
    '/v2/requests',
    env.request(false, { bundle_id: bundle.body.id, profiles: { 'haip.agent-ui': '2' } }),
  );
  assert.equal(created.status, 201);
  const rebind = (body: any) => {
    body.binding_digest = digest({
      profile: body.profile,
      protocol_revision: body.protocol_revision,
      request: body.request,
      bundle: body.bundle,
      source: body.source,
      snapshots: body.snapshots,
    });
  };
  const mutations = [
    (body: any) => {
      body.request.digest = 'sha256:' + '0'.repeat(64);
    },
    (body: any) => {
      body.protocol_revision = '2.0.0-draft.2';
      rebind(body);
    },
    (body: any) => {
      body.request.purpose = 'bogus';
      body.input.purpose = 'bogus';
      body.snapshots.input_digest = digest(body.input);
      rebind(body);
    },
    (body: any) => {
      body.html += '<p>mutated</p>';
    },
    (body: any) => {
      body.origin += '/unexpected';
    },
    (body: any) => {
      body.scope = '0'.repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.route(`**/v2/requests/${created.body.request.id}/app`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        mutate(body);
        await route.fulfill({ response, json: body });
      });
      await signIn(page, '/review/' + created.body.request.id);
      await page.waitForFunction(() =>
        document.querySelector('#app-state')?.textContent?.includes('envelope binding mismatch'),
      );
      assert.equal(await page.locator('#app > iframe').count(), 0);
      assert.equal(await page.locator('#allow-app-proposal').isHidden(), true);
      assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    } finally {
      await context.close();
    }
  }
});

let hostileBundle: any;
async function hostileReview() {
  if (!hostileBundle) {
    const built = await build({
      stdin: {
        contents: `
        document.body.innerHTML = '<h1>Adversarial proposal fixture</h1><p>Stored app; proposals cannot confirm.</p>';
        window.attacks = { inputs: 0, results: 0, hostRequests: [] };
        let nextId = 1;
        const pending = new Map();
        function post(message) { parent.postMessage(message, '*'); }
        function request(method, params) {
          const id = nextId++;
          const wait = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
          post({ jsonrpc: '2.0', id, method, params });
          return wait;
        }
        window.addEventListener('message', event => {
          if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
          const message = event.data;
          if (message.jsonrpc !== '2.0') return;
          if (message.method === 'haip/ui.teardown') {
            // Record only. The correlation test supplies the response.
            event.stopImmediatePropagation();
            window.attacks.hostRequests.push(message);
            return;
          }
          if (!('method' in message) || message.method === undefined) {
            if (message.id === undefined || !pending.has(message.id)) return;
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message));
            else waiter.resolve(message.result);
            return;
          }
          if (message.method === 'haip/ui.input') window.attacks.inputs++;
          if (message.method === 'haip/ui.result') window.attacks.results++;
        });
        window.attacks.propose = async score => {
          try {
            return { ok: true, result: await request('haip/ui.propose', {
              decision: 'answer', response: { choice: score % 2 ? 'accept' : 'decline', score }
            }) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        };
        const init = await request('haip/ui.initialize', {
          protocolVersion: 'org.haiprotocol.agent-ui/2',
          capabilities: { localProposal: true },
          viewInfo: { name: 'Adversarial proposal fixture', version: '1.0.0' },
        });
        if (!init?.capabilities?.localProposal) throw new Error('missing localProposal');
        post({ jsonrpc: '2.0', method: 'haip/ui.initialized', params: {} });
      `,
        resolveDir: process.cwd(),
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    });
    const registered = await env.api(
      '/v2/bundles',
      {
        html:
          '<!doctype html><body><script type="module">' +
          built.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
          '</script></body>',
        compatibility: { agent_ui: '2' },
        author: 'Adversarial browser fixture',
        licence: 'MIT',
      },
      env.credentials.publisher,
    );
    assert.equal(registered.status, 201);
    hostileBundle = registered.body;
  }
  const created = await env.api(
    '/v2/requests',
    env.request(false, { bundle_id: hostileBundle.id, profiles: { 'haip.agent-ui': '2' } }),
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
  const proxy = frame.parentFrame()!;
  await proxy.evaluate(() => {
    window.haipTestRendererMessages = 0;
    const renderer = document.querySelector<HTMLIFrameElement>('iframe')!;
    window.addEventListener('message', (event) => {
      if (event.source === renderer.contentWindow) window.haipTestRendererMessages++;
    });
  });
  return {
    context,
    page,
    frame,
    proxy,
    id: created.body.request.id,
    bundle: created.body.request.review.bundle,
  };
}

test('the Host rejects a candidate outside the verified request binding', async () => {
  const { context, page, frame, id } = await hostileReview();
  const changedDigest = 'sha256:' + '0'.repeat(64);
  try {
    await page.route(`**/v2/requests/${id}/candidates`, async (route) => {
      const response = await route.fetch();
      const candidate = await response.json();
      candidate.request_digest = changedDigest;
      candidate.decision = 'approve';
      await route.fulfill({ response, json: candidate });
    });
    const proposed = await frame.evaluate(() => window.attacks.propose(1));
    assert.equal(proposed.ok, false);
    assert.match(proposed.error, /does not match the verified request and proposal/);
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    const material = (await env.api(`/v2/requests/${id}/material`)).body;
    assert.notEqual(material.candidate.request_digest, changedDigest);
    assert.equal(material.candidate.decision, 'answer');
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
  } finally {
    await context.close();
  }
});

test('the Host accepts a schema-valid candidate timestamp with an offset', async () => {
  const { context, page, frame, id } = await hostileReview();
  const createdAt = '2026-09-03T01:00:00+01:00';
  try {
    await page.route(`**/v2/requests/${id}/candidates`, async (route) => {
      const response = await route.fetch();
      const candidate = await response.json();
      candidate.created_at = createdAt;
      await route.fulfill({ response, json: candidate });
    });
    const proposed = await frame.evaluate(() => window.attacks.propose(1));
    assert.equal(proposed.ok, true);
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    const displayed = JSON.parse((await page.locator('#exact').textContent())!);
    assert.equal(displayed.created_at, createdAt);
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
  } finally {
    await context.close();
  }
});

test('View failure discards its frozen proposal and restores the trusted form', async () => {
  const { context, page, frame, id } = await hostileReview();
  try {
    assert.equal((await frame.evaluate(() => window.attacks.propose(1))).ok, true);
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    await frame.evaluate(() => {
      for (let index = 0; index < 32; index++)
        parent.postMessage(
          {
            jsonrpc: '2.0',
            id: 10_000 + index,
            method: 'haip/ui.propose',
            params: {
              decision: 'answer',
              response: { choice: 'accept', score: 100 + index },
            },
          },
          '*',
        );
    });
    await page.waitForFunction(() =>
      document.querySelector('#app-state')?.textContent?.includes('App unavailable'),
    );
    assert.equal(await page.locator('#app > iframe').count(), 0);
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(await page.locator('#exact').textContent(), '');
    assert.equal(await page.locator('#candidate-digest').textContent(), '');
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.match((await page.locator('#app-state').textContent()) ?? '', /App unavailable/);
    assert.equal((await env.api('/v2/requests/' + id)).body.decision_state, 'pending');
    await page.getByLabel('Response (JSON)').fill('{"choice":"decline","score":200}');
    await page.getByRole('button', { name: 'Review this response' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate.response.score, 200);
    assert.equal(
      await page.locator('#proposal-source').textContent(),
      'Source: trusted host response form.',
    );
  } finally {
    await context.close();
  }
});

test('oversized UTF-8 renderer messages revoke an in-flight app proposal', async () => {
  const { context, page, frame, id } = await hostileReview();
  const proposalReceived = Promise.withResolvers<void>();
  const releaseProposal = Promise.withResolvers<void>();
  let proposals = 0;
  try {
    await page.route(`**/v2/requests/${id}/candidates`, async (route) => {
      proposals++;
      const response = await route.fetch();
      proposalReceived.resolve();
      await releaseProposal.promise;
      await route.fulfill({ response });
    });
    await frame.evaluate(() => {
      window.attacks.first = window.attacks.propose(1);
    });
    await proposalReceived.promise;
    await frame.evaluate(() => {
      parent.postMessage(
        {
          jsonrpc: '2.0',
          id: 20_000,
          method: 'haip/ui.propose',
          params: {
            decision: 'answer',
            response: { choice: 'accept', detail: '€'.repeat(400_000) },
          },
        },
        '*',
      );
    });
    await page.locator('#app > iframe').waitFor({ state: 'detached' });
    releaseProposal.resolve();
    await page.waitForLoadState('networkidle');
    assert.equal(proposals, 1, 'oversized UTF-8 messages must not reach the candidate route');
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.equal((await env.api('/v2/requests/' + id)).body.decision_state, 'pending');
  } finally {
    releaseProposal.resolve();
    await context.close();
  }
});

test('renderer reload discards a frozen app proposal and selects native fallback', async () => {
  const { context, page, frame, id } = await hostileReview();
  try {
    assert.equal((await frame.evaluate(() => window.attacks.propose(1))).ok, true);
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    await page.evaluate(() => {
      const proxy = document.querySelector<HTMLIFrameElement>('#app > iframe')!;
      proxy.src = proxy.src;
    });
    await page.locator('#app > iframe').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(await page.locator('#exact').textContent(), '');
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.equal((await env.api('/v2/requests/' + id)).body.decision_state, 'pending');
  } finally {
    await context.close();
  }
});

test('inner opaque renderer reload destroys the View and selects native fallback', async () => {
  const { context, page, frame, proxy, id } = await hostileReview();
  try {
    assert.equal(frame.url(), 'about:srcdoc');
    assert.equal((await frame.evaluate(() => window.attacks.propose(1))).ok, true);
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    await frame.evaluate(() => location.reload());
    await page.locator('#app > iframe').waitFor({ state: 'detached' });
    assert.equal(frame.isDetached(), true);
    assert.equal(proxy.isDetached(), true);
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(await page.locator('#exact').textContent(), '');
    assert.equal(await page.locator('#candidate-digest').textContent(), '');
    assert.match(
      (await page.locator('#app-state').textContent()) ?? '',
      /App unavailable \(renderer navigated or reloaded\)/,
    );
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.equal((await env.api('/v2/requests/' + id)).body.decision_state, 'pending');
    await page.getByLabel('Response (JSON)').fill('{"choice":"decline","score":200}');
    await page.getByRole('button', { name: 'Review this response' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate.response.score, 200);
    assert.equal(
      await page.locator('#proposal-source').textContent(),
      'Source: trusted host response form.',
    );
  } finally {
    await context.close();
  }
});

test('unsupported View capabilities fail closed to the native renderer', async () => {
  const html = `<!doctype html><script>
    parent.postMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'haip/ui.initialize',
      params: {
        protocolVersion: 'org.haiprotocol.agent-ui/2',
        capabilities: { localProposal: false }
      }
    }, '*');
  </script>`;
  const bundle = await env.api(
    '/v2/bundles',
    {
      html,
      compatibility: { agent_ui: '2' },
      author: 'Invalid capability fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(bundle.status, 201);
  const created = await env.api(
    '/v2/requests',
    env.request(false, { bundle_id: bundle.body.id, profiles: { 'haip.agent-ui': '2' } }),
  );
  assert.equal(created.status, 201);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, '/review/' + created.body.request.id);
    await page.getByText('Producer review app (isolated)', { exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('#app-state')?.textContent?.includes('App unavailable'),
    );
    assert.equal(await page.locator('#app > iframe').count(), 0);
    assert.match((await page.locator('#app-state').textContent()) ?? '', /unsupported Agent UI/);
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.equal(
      (await env.api(`/v2/requests/${created.body.request.id}/material`)).body.candidate,
      null,
    );
  } finally {
    await context.close();
  }
});

test('sandbox consumes a proposal ID rejected before initialisation', async () => {
  const html = `<!doctype html><script>
    window.replies = [];
    window.addEventListener('message', event => {
      if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
      const message = event.data;
      if (message.id === 7 && message.error) window.replies.push(message.error.code);
      if (message.id === 1 && message.result)
        parent.postMessage({ jsonrpc: '2.0', method: 'haip/ui.initialized', params: {} }, '*');
      if (message.method === 'haip/ui.result')
        parent.postMessage({
          jsonrpc: '2.0',
          id: 7,
          method: 'haip/ui.propose',
          params: { decision: 'answer', response: { choice: 'accept' } },
        }, '*');
    });
    parent.postMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'haip/ui.propose',
      params: { decision: 'answer', response: { choice: 'accept' } },
    }, '*');
    parent.postMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'haip/ui.initialize',
      params: {
        protocolVersion: 'org.haiprotocol.agent-ui/2',
        capabilities: { localProposal: true },
      },
    }, '*');
  </script>`;
  const bundle = await env.api(
    '/v2/bundles',
    {
      html,
      compatibility: { agent_ui: '2' },
      author: 'Initialisation race fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(bundle.status, 201);
  const created = await env.api(
    '/v2/requests',
    env.request(false, { bundle_id: bundle.body.id, profiles: { 'haip.agent-ui': '2' } }),
  );
  assert.equal(created.status, 201);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, '/review/' + created.body.request.id);
    const inner = page.frameLocator('#app > iframe').frameLocator('iframe');
    await inner.locator('body').waitFor({ state: 'attached' });
    const frame = page.frames().find((candidate) => candidate.url() === 'about:srcdoc')!;
    await frame.waitForFunction(() => window.replies?.length === 2);
    assert.deepEqual(await frame.evaluate(() => window.replies), [-32600, -32600]);
    assert.equal(
      (await env.api(`/v2/requests/${created.body.request.id}/material`)).body.candidate,
      null,
    );
  } finally {
    await context.close();
  }
});

test('controlled Host teardown destroys the View after a malformed null result', async () => {
  const { context, page, frame } = await hostileReview();
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await frame.waitForFunction(() => window.attacks.hostRequests.length === 1);
    const teardown = await frame.evaluate(() => window.attacks.hostRequests[0]);
    assert.equal(teardown.method, 'haip/ui.teardown');
    await frame.evaluate((id) => {
      parent.postMessage({ jsonrpc: '2.0', id, result: null }, '*');
    }, teardown.id);
    await page.locator('#app > iframe').waitFor({ state: 'detached' });
  } finally {
    await context.close();
  }
});

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
  const { context, page, frame, proxy } = await hostileReview();
  const send = async (messages: unknown[]) => {
    const previous = await proxy.evaluate(() => window.haipTestRendererMessages);
    await frame.evaluate((messages) => {
      for (const message of messages) parent.postMessage(message, '*');
    }, messages);
    await proxy.waitForFunction(
      (expected) => window.haipTestRendererMessages === expected,
      previous + messages.length,
    );
  };
  const received = (id: string | number) =>
    page.evaluate((id) => window.proxyMessages.filter((message) => message.id === id), id);
  const hostRequest = async (id: string | number) => {
    await page.evaluate((id) => {
      const proxy = document.querySelector<HTMLIFrameElement>('#app > iframe')!;
      proxy.contentWindow!.postMessage(
        { jsonrpc: '2.0', id, method: 'haip/ui.teardown', params: {} },
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
    const accepted = { jsonrpc: '2.0', id: 'fixture:one', result: { closed: true } };
    await send([accepted, accepted]);
    await page.waitForFunction(
      (id) => window.proxyMessages.filter((message) => message.id === id).length === 1,
      'fixture:one',
    );
    assert.deepEqual(
      await received('fixture:one'),
      [accepted],
      'only the first matching response is forwarded',
    );
    await hostRequest(9007);
    await send([{ jsonrpc: '2.0', id: '9007', result: { spoof: true } }]);
    assert.deepEqual(await received('9007'), [], 'request ID types cannot be substituted');
    const error = { jsonrpc: '2.0', id: 9007, error: { code: -32000, message: 'test response' } };
    await send([error, error]);
    await page.waitForFunction(
      (id) => window.proxyMessages.filter((message) => message.id === id).length === 1,
      9007,
    );
    assert.deepEqual(await received(9007), [error]);
    assert.deepEqual(
      await frame.evaluate(() => ({
        inputs: window.attacks.inputs,
        results: window.attacks.results,
      })),
      { inputs: 1, results: 1 },
    );
    await hostRequest('fixture:invalid');
    await frame.evaluate(() => {
      parent.postMessage({ jsonrpc: '2.0', id: 'fixture:invalid', result: { closed: false } }, '*');
    });
    await page.locator('#app > iframe').waitFor({ state: 'detached' });
    assert.match(
      (await page.locator('#app-state').textContent()) ?? '',
      /invalid teardown acknowledgement/,
    );
  } finally {
    await context.close();
  }
});

test('sandbox consumes rejected request IDs before any valid reuse', async () => {
  const { context, page, frame, id } = await hostileReview();
  try {
    const replies = await frame.evaluate(`
      (async () => {
        const exchange = (id, first) => new Promise((resolve, reject) => {
          const responses = [];
          const timer = setTimeout(() => reject(new Error('response timeout')), 2000);
          const receive = event => {
            if (event.source !== parent || event.data?.id !== id) return;
            responses.push(event.data);
            if (responses.length === 1) {
              parent.postMessage({
                jsonrpc: '2.0',
                id,
                method: 'haip/ui.propose',
                params: { decision: 'answer', response: { choice: 'accept', score: 1 } },
              }, '*');
            } else {
              clearTimeout(timer);
              window.removeEventListener('message', receive);
              resolve(responses);
            }
          };
          window.addEventListener('message', receive);
          parent.postMessage(first, '*');
        });
        return {
          invalid: await exchange(50001, {
            jsonrpc: '2.0',
            id: 50001,
            method: 'haip/ui.propose',
            params: { decision: 'answer' },
          }),
          unknown: await exchange(50002, {
            jsonrpc: '2.0',
            id: 50002,
            method: 'haip/ui.unknown',
            params: {},
          }),
        };
      })()
    `);
    assert.deepEqual(
      replies.invalid.map((message: any) => message.error.code),
      [-32602, -32600],
    );
    assert.deepEqual(
      replies.unknown.map((message: any) => message.error.code),
      [-32601, -32600],
    );
    assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate, null);
  } finally {
    await context.close();
  }
});

test('sandbox destroys a View that sends cyclic structured-clone data', async () => {
  const { context, page, frame, id } = await hostileReview();
  try {
    await frame.evaluate(() => {
      const response: any = {};
      response.self = response;
      parent.postMessage(
        {
          jsonrpc: '2.0',
          id: 50_003,
          method: 'haip/ui.propose',
          params: { decision: 'answer', response },
        },
        '*',
      );
    });
    await page.locator('#app > iframe').waitFor({ state: 'detached' });
    assert.match(
      (await page.locator('#app-state').textContent()) ?? '',
      /invalid renderer message/,
    );
    assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate, null);
  } finally {
    await context.close();
  }
});

test('sandbox rejects values that cannot cross the strict JSON boundary', async () => {
  for (const kind of ['surrogate-value', 'surrogate-key', 'unsafe-integer', 'sparse', 'extended']) {
    const { context, page, frame, id } = await hostileReview();
    try {
      await frame.evaluate((kind) => {
        let response: any;
        if (kind === 'surrogate-value') response = String.fromCharCode(0xd800);
        else if (kind === 'surrogate-key') response = { [String.fromCharCode(0xd800)]: true };
        else if (kind === 'unsafe-integer') response = Number.MAX_SAFE_INTEGER + 1;
        else if (kind === 'sparse') {
          response = [];
          response.length = 1;
        } else {
          response = [];
          response.extra = true;
        }
        parent.postMessage(
          {
            jsonrpc: '2.0',
            id: 50_004,
            method: 'haip/ui.propose',
            params: { decision: 'answer', response },
          },
          '*',
        );
      }, kind);
      await page.locator('#app > iframe').waitFor({ state: 'detached' });
      assert.match(
        (await page.locator('#app-state').textContent()) ?? '',
        /invalid renderer message/,
      );
      assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate, null);
    } finally {
      await context.close();
    }
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
