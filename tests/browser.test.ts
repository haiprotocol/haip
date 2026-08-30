import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
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
  await page.getByRole('button', { name: 'Confirm this exact response' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('confirmed'),
  );
  assert.equal(
    (await env.api('/v2/requests/' + created.body.request.id)).body.receipt.payload.decision,
    'answer',
  );
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/trusted-review.png', fullPage: true });
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
