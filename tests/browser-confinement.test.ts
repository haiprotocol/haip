import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type CDPSession } from '@playwright/test';
import { build } from 'esbuild';
import { environment } from './environment.js';
import { freePort } from './fixtures/postgres.js';
import { createApp, createSandboxApp } from '../haip-server/src/server.js';

let env: Awaited<ReturnType<typeof environment>>, browser: Browser, bundleId: string;
let trusted: ReturnType<typeof createTlsServer>,
  sandbox: ReturnType<typeof createTlsServer>,
  certificateDirectory: string,
  reviewOrigin: string;
before(async () => {
  env = await environment();
  certificateDirectory = await mkdtemp(join(tmpdir(), 'haip-confinement-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=haip-host.test',
      '-addext',
      'subjectAltName=DNS:haip-host.test,DNS:*.haip-view.test',
      '-keyout',
      join(certificateDirectory, 'key.pem'),
      '-out',
      join(certificateDirectory, 'cert.pem'),
    ],
    { stdio: 'pipe' },
  );
  const trustedPort = await freePort(),
    sandboxPort = await freePort();
  reviewOrigin = `https://haip-host.test:${trustedPort}`;
  env.service.config.origin = reviewOrigin;
  env.service.config.sandboxOrigin = (scope) =>
    `https://${BigInt('0x' + scope).toString(36)}.haip-view.test:${sandboxPort}`;
  const tls = {
    key: await readFile(join(certificateDirectory, 'key.pem')),
    cert: await readFile(join(certificateDirectory, 'cert.pem')),
  };
  trusted = createTlsServer(tls, createApp(env.service));
  sandbox = createTlsServer(tls, createSandboxApp(env.service));
  await Promise.all([
    new Promise<void>((resolve) => trusted.listen(trustedPort, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => sandbox.listen(sandboxPort, '127.0.0.1', resolve)),
  ]);
  browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--host-resolver-rules=MAP haip-host.test 127.0.0.1, MAP *.haip-view.test 127.0.0.1'],
    ...(process.env.HAIP_TEST_CHROMIUM ? { executablePath: process.env.HAIP_TEST_CHROMIUM } : {}),
  });
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
  const registered = await env.api(
    '/v2/bundles',
    {
      html:
        '<!doctype html><body><script>console.log("haip-confinement-producer-ran");</script><script type="module">' +
        built.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
        '</script></body>',
      compatibility: { agent_ui: '2' },
      author: 'Network confinement fixture',
      licence: 'MIT',
    },
    env.credentials.publisher,
  );
  assert.equal(registered.status, 201);
  bundleId = registered.body.id;
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    if (trusted) await new Promise<void>((resolve) => trusted.close(() => resolve()));
    if (sandbox) await new Promise<void>((resolve) => sandbox.close(() => resolve()));
    await env?.close();
    if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
  }
});
async function request() {
  const created = await env.api(
    '/v2/requests',
    env.request(false, {
      bundle_id: bundleId,
      profiles: { 'haip.agent-ui': '2' },
      response_schema: JSON.parse(
        await readFile(new URL('../examples/http/review.json', import.meta.url), 'utf8'),
      ).response_schema,
    }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.request.id as string;
}
async function signIn(page: any, id: string) {
  await page.goto(`${reviewOrigin}/review/${id}`);
  await page.getByRole('textbox', { name: 'User' }).fill('reviewer');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${reviewOrigin}/review/${id}`);
  await page.getByText('Producer review app (isolated)', { exact: true }).click();
}
async function assertNativeFallback(session: CDPSession) {
  // Chromium may report an inner process crash through Playwright's Page even when the separate trusted Host remains alive. Inspect that Host directly.
  const deadline = performance.now() + 10_000;
  let state: any;
  do {
    const result = await session.send('Runtime.evaluate', {
      expression: `({ app: document.querySelector('#app-state').textContent, frames: document.querySelectorAll('#app > iframe').length, nativeEnabled: !document.querySelector('#response').disabled, confirmationHidden: document.querySelector('#confirmation').hidden, exact: document.querySelector('#exact').textContent, digest: document.querySelector('#candidate-digest').textContent })`,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    state = result.result.value;
    if (state.frames === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  assert.match(state.app, /renderer stopped responding|renderer navigated or reloaded/);
  assert.equal(state.frames, 0);
  assert.equal(state.nativeEnabled, true);
  assert.equal(state.confirmationHidden, true);
  assert.equal(state.exact, '');
  assert.equal(state.digest, '');
}

test('scripted Views block RTC and revoke app proposals after renderer loss', async () => {
  const udp = createSocket('udp4');
  let packets = 0,
    httpRequests = 0;
  udp.on('message', (packet) => {
    if (packet.readUInt16BE(0) === 1) packets++;
  });
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const udpPort = udp.address().port;
  const sink = createServer((_req, res) => {
    httpRequests++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Synthetic connection fixture</title>');
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const address = sink.address();
  assert(address && typeof address === 'object');
  const sinkOrigin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  try {
    // The unrestricted control proves that the local UDP sink observes real ICE traffic from this browser.
    await page.goto(sinkOrigin);
    await page.evaluate(async (port) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      pc.createDataChannel('synthetic-control');
      await pc.setLocalDescription();
      await new Promise((resolve) => setTimeout(resolve, 750));
      pc.close();
    }, udpPort);
    assert(packets > 0, 'the control must send a STUN request to the local sink');
    packets = 0;
    httpRequests = 0;
    const id = await request();
    await signIn(page, id);
    const inner = page.frameLocator('#app > iframe').frameLocator('iframe');
    await inner.getByRole('button', { name: 'Propose choice' }).waitFor();
    const frame = page.frames().find((frame) => frame.url() === 'about:srcdoc')!;
    assert.equal(await frame.evaluate(() => self.origin), 'null');
    const report = await frame.parentFrame()!.evaluate(() => {
      const observer = new ReportingObserver(() => {}, {
        types: ['connection-allowlist'],
        buffered: false,
      });
      observer.observe();
      const pc = new RTCPeerConnection({ iceServers: [] });
      const reports = observer.takeRecords().map((report) => ({
        type: report.type,
        ...report.body!.toJSON(),
      }));
      pc.close();
      observer.disconnect();
      return reports;
    });
    assert(
      report.some(
        (item) =>
          item.type === 'connection-allowlist' &&
          item.connection === 'webrtc' &&
          item.disposition === 'enforce' &&
          Array.isArray(item.allowlist) &&
          item.allowlist.length === 0,
      ),
    );
    assert.equal(
      await frame.evaluate(async (origin) => {
        try {
          await fetch(origin + '/synthetic-fetch');
          return true;
        } catch {
          return false;
        }
      }, sinkOrigin),
      false,
    );
    await inner.getByLabel('Your choice').selectOption('accept');
    await inner.getByRole('button', { name: 'Propose choice' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
    const hostSession = await context.newCDPSession(page);
    const blocked = await frame
      .evaluate(
        async ({ udpPort, sinkOrigin }) => {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${udpPort}` }] });
          pc.createDataChannel('synthetic-confined');
          await pc.setLocalDescription();
          let fetched = false;
          try {
            await fetch(sinkOrigin + '/synthetic-fetch');
            fetched = true;
          } catch {}
          const result = { fetched, state: pc.iceConnectionState };
          pc.close();
          return result;
        },
        { udpPort, sinkOrigin },
      )
      .catch((error) => {
        // These Chromium versions may terminate the confined renderer when it requests an mDNS interface. The trusted Host must survive and discard its app proposal.
        assert.match(
          error.message,
          /Target crashed|Execution context was destroyed|Frame was detached/,
        );
        return null;
      });
    if (blocked) assert.deepEqual(blocked, { fetched: false, state: 'failed' });
    assert.equal(packets, 0, 'the producer realm may not send STUN traffic');
    assert.equal(httpRequests, 0, 'fetch must not reach the local sink');
    if (blocked)
      await frame
        .evaluate((origin) => location.assign(origin + '/synthetic-navigation'), sinkOrigin)
        .catch((error) =>
          assert.match(
            error.message,
            /Target crashed|Execution context was destroyed|Frame was detached/,
          ),
        );
    await assertNativeFallback(hostSession);
    assert.equal(packets, 0);
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
  } finally {
    await context.close();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await new Promise<void>((resolve) => udp.close(resolve));
  }
});

test('absent, observational and permissive confinement policies never receive producer HTML', async () => {
  for (const policy of ['absent', 'report-only', 'permissive', 'rtc-allowed']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true }),
      page = await context.newPage();
    let producerRan = false,
      producerMaterialMessages = 0;
    page.on('console', (message) => {
      if (message.text() === 'haip-confinement-producer-ran') producerRan = true;
    });
    await page.exposeFunction('confinementMaterialReceived', () => producerMaterialMessages++);
    await page.addInitScript(() => {
      if (!location.pathname.startsWith('/sandbox/')) return;
      window.addEventListener('message', (event) => {
        if (event.data?.method === 'haip/ui.resourceReady')
          (window as any).confinementMaterialReceived();
      });
    });
    await page.route('**/sandbox/*', async (route) => {
      const url = new URL(route.request().url());
      const host = url.host;
      url.hostname = '127.0.0.1';
      const response = await route.fetch({
        url: url.href,
        headers: { ...route.request().headers(), host },
      });
      const headers = { ...response.headers() };
      delete headers['connection-allowlist'];
      if (policy === 'report-only')
        headers['connection-allowlist-report-only'] =
          '(); webrtc=block; redirects=block; report-to=haip-view-policy';
      else if (policy === 'permissive')
        headers['connection-allowlist'] =
          '(response-origin); webrtc=block; redirects=block; report-to=haip-view-policy';
      else if (policy === 'rtc-allowed')
        headers['connection-allowlist'] =
          '(); webrtc=allow; redirects=block; report-to=haip-view-policy';
      await route.fulfill({ response, headers });
    });
    try {
      const id = await request();
      await signIn(page, id);
      await page.waitForFunction(() =>
        document.querySelector('#app-state')?.textContent?.includes('App unavailable'),
      );
      assert.equal(producerRan, false, policy);
      assert.equal(producerMaterialMessages, 0, policy);
      assert.equal(await page.locator('#app > iframe').count(), 0, policy);
      assert.match(
        (await page.locator('#app-state').textContent()) ?? '',
        /browser network confinement unavailable/,
      );
      assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
      assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate, null);
    } finally {
      await context.close();
    }
  }
});

test('missing confinement APIs select native rendering before producer HTML', async () => {
  for (const api of ['ReportingObserver', 'RTCPeerConnection']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true }),
      page = await context.newPage();
    let producerRan = false;
    page.on('console', (message) => {
      if (message.text() === 'haip-confinement-producer-ran') producerRan = true;
    });
    await page.addInitScript((api) => {
      if (location.pathname.startsWith('/sandbox/'))
        Object.defineProperty(window, api, { value: undefined });
    }, api);
    try {
      const id = await request();
      await signIn(page, id);
      await page.waitForFunction(() =>
        document.querySelector('#app-state')?.textContent?.includes('App unavailable'),
      );
      assert.equal(producerRan, false, api);
      assert.equal(await page.locator('#app > iframe').count(), 0, api);
      assert.match(
        (await page.locator('#app-state').textContent()) ?? '',
        /browser network confinement unavailable/,
      );
      assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
      assert.equal((await env.api(`/v2/requests/${id}/material`)).body.candidate, null);
    } finally {
      await context.close();
    }
  }
});

test('producer heartbeat forgeries cannot preserve a proposal after the trusted Proxy stops', async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  await page.addInitScript(() => {
    if (!location.pathname.startsWith('/sandbox/')) return;
    window.setInterval = new Proxy(window.setInterval, {
      apply(target, thisArg, args) {
        if (args[1] === 1000) return Reflect.apply(target, thisArg, [() => {}, 1000]);
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  try {
    const id = await request();
    await signIn(page, id);
    const inner = page.frameLocator('#app > iframe').frameLocator('iframe');
    await inner.getByRole('button', { name: 'Propose choice' }).waitFor();
    await inner.getByLabel('Your choice').selectOption('accept');
    await inner.getByRole('button', { name: 'Propose choice' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    const frame = page.frames().find((frame) => frame.url() === 'about:srcdoc')!;
    await frame.evaluate(() => {
      setInterval(() => {
        const forged = { jsonrpc: '2.0', method: 'haip/ui.proxyAlive', params: {} };
        parent.postMessage(forged, '*');
        top!.postMessage(forged, '*');
      }, 50);
    });
    await page.locator('#app > iframe').waitFor({ state: 'detached', timeout: 10_000 });
    assert.match(
      (await page.locator('#app-state').textContent()) ?? '',
      /renderer stopped responding/,
    );
    assert.equal(await page.locator('#confirmation').isVisible(), false);
    assert.equal(await page.locator('#exact').textContent(), '');
    assert.equal(await page.locator('#candidate-digest').textContent(), '');
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
    await page.getByLabel('Response (JSON)').fill('{"choice":"decline"}');
    await page.getByRole('button', { name: 'Review this response' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    assert.equal(
      await page.locator('#proposal-source').textContent(),
      'Source: trusted host response form.',
    );
  } finally {
    await context.close();
  }
});

test('producer navigation is blocked before sending an HTTP request', async () => {
  let requests = 0;
  const sink = createServer((_req, res) => {
    requests++;
    res.end('Synthetic navigation fixture');
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const address = sink.address();
  assert(address && typeof address === 'object');
  const context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  try {
    const id = await request();
    await signIn(page, id);
    await page
      .frameLocator('#app > iframe')
      .frameLocator('iframe')
      .getByRole('button', { name: 'Propose choice' })
      .waitFor();
    const frame = page.frames().find((frame) => frame.url() === 'about:srcdoc')!;
    await frame.evaluate(
      (url) => location.assign(url),
      `http://127.0.0.1:${address.port}/synthetic-navigation`,
    );
    await page.locator('#app > iframe').waitFor({ state: 'detached', timeout: 10_000 });
    assert.equal(requests, 0);
    assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
  } finally {
    await context.close();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
});

test('a fresh descendant realm inherits RTC denial and cannot preserve its app proposal', async () => {
  const udp = createSocket('udp4');
  let packets = 0;
  udp.on('message', () => packets++);
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  try {
    const id = await request();
    await signIn(page, id);
    const inner = page.frameLocator('#app > iframe').frameLocator('iframe');
    await inner.getByRole('button', { name: 'Propose choice' }).waitFor();
    await inner.getByLabel('Your choice').selectOption('accept');
    await inner.getByRole('button', { name: 'Propose choice' }).click();
    await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
    const frame = page.frames().find((frame) => frame.url() === 'about:srcdoc')!;
    const descendantStarted = page.waitForEvent('console', {
      predicate: (message) => message.text() === 'haip-confinement-descendant-rtc-started',
      timeout: 3000,
    });
    const hostSession = await context.newCDPSession(page);
    await frame.evaluate((port) => {
      const child = document.createElement('iframe');
      child.srcdoc = `<script>
        console.log('haip-confinement-descendant-rtc-started');
        const pc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});
        pc.createDataChannel('synthetic-descendant');
        pc.setLocalDescription().then(() => setTimeout(() => pc.close(),500));
      <\/script>`;
      document.body.appendChild(child);
    }, udp.address().port);
    await descendantStarted;
    await assertNativeFallback(hostSession);
    assert.equal(packets, 0);
    assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
  } finally {
    await context.close();
    await new Promise<void>((resolve) => udp.close(resolve));
  }
});

test('stale and descendant liveness proofs cannot preserve a View', async () => {
  for (const proof of ['stale', 'descendant']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true }),
      page = await context.newPage();
    try {
      const id = await request();
      await signIn(page, id);
      const inner = page.frameLocator('#app > iframe').frameLocator('iframe');
      await inner.getByRole('button', { name: 'Propose choice' }).waitFor();
      await inner.getByLabel('Your choice').selectOption('accept');
      await inner.getByRole('button', { name: 'Propose choice' }).click();
      await page.getByRole('heading', { name: 'Trusted confirmation' }).waitFor();
      const frame = page.frames().find((frame) => frame.url() === 'about:srcdoc')!;
      await frame.evaluate((proof) => {
        let first: string | undefined;
        window.addEventListener('message', (event) => {
          if (event.source !== parent || event.data?.method !== 'haip/ui.proxyProbe') return;
          const challenge = event.data.params.challenge;
          if (!first) {
            first = challenge;
            parent.postMessage(
              { jsonrpc: '2.0', method: 'haip/ui.proxyProof', params: { challenge } },
              '*',
            );
          } else if (proof === 'stale') {
            parent.postMessage(
              { jsonrpc: '2.0', method: 'haip/ui.proxyProof', params: { challenge: first } },
              '*',
            );
          } else {
            const child = document.createElement('iframe');
            child.srcdoc = `<script>parent.parent.postMessage({jsonrpc:'2.0',method:'haip/ui.proxyProof',params:{challenge:${JSON.stringify(challenge)}}}, '*');<\/script>`;
            document.body.appendChild(child);
          }
        });
      }, proof);
      const session = await context.newCDPSession(frame);
      const removed = await session.send('Runtime.evaluate', {
        expression: `(() => { const listeners = getEventListeners(window).message.filter(item => item.useCapture); for (const item of listeners) window.removeEventListener('message', item.listener, true); return listeners.length; })()`,
        includeCommandLineAPI: true,
        returnByValue: true,
      });
      assert.equal(removed.exceptionDetails, undefined);
      assert.equal(removed.result.value, 1, 'the fixture must remove the trusted capture listener');
      await page.locator('#app > iframe').waitFor({ state: 'detached', timeout: 10_000 });
      assert.match(
        (await page.locator('#app-state').textContent()) ?? '',
        /renderer stopped responding/,
      );
      assert.equal(await page.getByLabel('Response (JSON)').isEnabled(), true);
      assert.equal(await page.locator('#confirmation').isVisible(), false);
      assert.equal(await page.locator('#exact').textContent(), '');
      assert.equal(await page.locator('#candidate-digest').textContent(), '');
      assert.equal((await env.api(`/v2/requests/${id}`)).body.decision_state, 'pending');
    } finally {
      await context.close();
    }
  }
});
