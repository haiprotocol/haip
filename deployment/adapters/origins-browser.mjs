import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { getDomain } from 'tldts';
import { validHostSessionCookie } from './origins-tls.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fixtureMarker = 'origins_tls';
const sessionName = '__Host-haip';
const timeout = 8_000;

async function signIn(page, trusted, review, fixture) {
  const login = new URL('/auth/login', trusted);
  login.searchParams.set('return_to', review.pathname);
  const wait = fixture ? timeout : 120_000;
  const callback = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return url.origin === trusted.origin && url.pathname === '/auth/callback';
      },
      { timeout: wait },
    )
    .catch(() => undefined);
  const loaded = page
    .waitForResponse(
      (response) => response.url() === review.href && response.request().isNavigationRequest(),
      { timeout: wait },
    )
    .catch(() => undefined);
  await page.goto(login.href, { waitUntil: 'domcontentloaded', timeout });
  if (fixture) {
    const origin = new URL(page.url());
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.pathname !== '/authorize'
    )
      throw new Error('unexpected_fixture_login');
    await page.getByRole('textbox', { name: 'User', exact: true }).fill('reviewer');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  const [response, reviewResponse] = await Promise.all([callback, loaded]);
  await page.waitForURL(review.href, { waitUntil: 'domcontentloaded', timeout });
  return { callback: response, reviewResponse };
}

export async function collectOriginsBrowser(plan, reviewId, { fixturePins } = {}) {
  if (!uuid.test(reviewId)) throw new Error('Expected a disposable review UUID');
  if (fixturePins && !fixturePins.length)
    throw new Error('Verified fixture certificate pins are required');
  const trusted = new URL(plan.deployment.trusted_origin);
  const sandboxPattern = plan.deployment.sandbox_origin_pattern;
  const sandbox = new RegExp(
    `^${sandboxPattern.split('{scope}').map(RegExp.escape).join('[a-z0-9]{1,63}')}$`,
  );
  const review = new URL(`/review/${reviewId}`, trusted);
  const attacker = new URL(
    `https://haip-probe-${randomUUID().slice(0, 8)}.${getDomain(trusted.hostname, { allowPrivateDomains: true })}`,
  );
  const canary = new URL('/canary', attacker);
  const material = `/v2/requests/${reviewId}/material`;
  const candidates = `/v2/requests/${reviewId}/candidates`;
  const assertions = [];
  let browser;
  let stage = 'browser_started';
  let version;
  const assert = (name, passed, detail) => {
    assertions.push({ name, passed: !!passed, detail });
    if (!passed) throw new Error(name);
  };
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      headless: !!fixturePins,
      timeout,
      ...(fixturePins
        ? {
            args: [
              '--host-resolver-rules=MAP *.test 127.0.0.1',
              `--ignore-certificate-errors-spki-list=${fixturePins.join(',')}`,
            ],
          }
        : {}),
    });
    version = browser.version();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(timeout);
    if (fixturePins) {
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === trusted.origin ||
          sandbox.test(url.origin) ||
          (url.protocol === 'http:' &&
            url.hostname === '127.0.0.1' &&
            url.pathname === '/authorize')
          ? route.continue()
          : route.abort();
      });
    }
    let canaryRequests = 0;
    await context.route(`${attacker.origin}/**`, async (route) => {
      if (route.request().url() === canary.href) {
        canaryRequests++;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>HAIP browser probe</title>',
      });
    });
    const page = await context.newPage();
    stage = 'reviewer_login';
    const { callback, reviewResponse } = await signIn(page, trusted, review, !!fixturePins);
    const headers = ((await callback?.headerValues('set-cookie')) ?? []).filter((value) =>
      value.startsWith(`${sessionName}=`),
    );
    const sessions = (await context.cookies([review.href])).filter(
      (cookie) => cookie.name === sessionName,
    );
    const session = sessions[0];
    assert(
      'browser_host_session',
      callback?.status() === 302 &&
        headers.length === 1 &&
        validHostSessionCookie(headers[0]) &&
        sessions.length === 1 &&
        session.domain === trusted.hostname &&
        session.path === '/' &&
        session.secure &&
        session.httpOnly &&
        session.sameSite === 'Lax',
      'The actual OIDC callback issues one Secure, HttpOnly, SameSite=Lax host-only session cookie.',
    );

    stage = 'disposable_review';
    const readMaterial = () =>
      page.evaluate(async (path) => {
        const result = await fetch(path, { redirect: 'error' });
        if (!result.ok) throw new Error('material_unavailable');
        const record = await result.json();
        return {
          id: record.request?.id,
          purpose: record.request?.purpose,
          marker: record.request?.metadata?.haip_acceptance_fixture,
          hasCandidate: record.candidate !== null,
        };
      }, material);
    const initial = await readMaterial();
    assert(
      'browser_test_review',
      initial.id === reviewId &&
        initial.purpose === 'review' &&
        initial.marker === fixtureMarker &&
        !initial.hasCandidate,
      'The authenticated reviewer can read the marked disposable review and it has no candidate.',
    );

    stage = 'isolated_view';
    await page.getByText('Producer review app (isolated)', { exact: true }).click();
    const wrapper = page.locator('#app > iframe');
    const wrapperUrl = new URL(await wrapper.getAttribute('src'));
    if (!sandbox.test(wrapperUrl.origin)) throw new Error('unexpected_view_origin');
    const view = wrapper.contentFrame().frameLocator('iframe');
    const propose = view.getByRole('button', { name: 'Propose choice', exact: true });
    await propose.waitFor();
    const renderer = page
      .frames()
      .find(
        (frame) => frame.url() === 'about:srcdoc' && frame.parentFrame()?.url() === wrapperUrl.href,
      );
    assert(
      'browser_opaque_renderer',
      renderer &&
        (await page.evaluate(() => crossOriginIsolated)) &&
        (await renderer.evaluate(() => {
          try {
            void parent.document;
            return false;
          } catch {
            return self.origin === 'null';
          }
        })),
      'The trusted page is cross-origin isolated and its opaque renderer has no access to the parent document.',
    );
    const otherCookies = await context.cookies([wrapperUrl.href, attacker.href]);
    assert(
      'browser_cookie_scope',
      otherCookies.every((cookie) => cookie.name !== sessionName),
      'The browser withholds the trusted session cookie from the sandbox and the sibling host.',
    );

    stage = 'hostile_framing';
    const hostile = await context.newPage();
    await hostile.goto(attacker.href);
    const policy = await reviewResponse?.headerValue('content-security-policy');
    const navigation = hostile
      .waitForEvent('request', {
        predicate: (entry) => entry.url() === review.href && entry.isNavigationRequest(),
        timeout,
      })
      .catch(() => undefined);
    const blockedFrame = hostile
      .waitForEvent('framenavigated', {
        predicate: (frame) =>
          frame.parentFrame() === hostile.mainFrame() && frame.url().startsWith('chrome-error://'),
        timeout,
      })
      .catch(() => undefined);
    await hostile.evaluate((destination) => {
      const frame = document.createElement('iframe');
      frame.name = 'haip-framing-attempt';
      frame.src = destination;
      document.body.append(frame);
    }, review.href);
    const [attempted, refused] = await Promise.all([navigation, blockedFrame]);
    assert(
      'browser_framing_refused',
      reviewResponse?.ok() &&
        /(?:^|;)\s*frame-ancestors 'none'\s*(?:;|$)/.test(policy ?? '') &&
        attempted &&
        refused,
      'The authenticated review returned a frame denial policy and Chromium refused a sibling HTTPS origin that tried to frame it.',
    );

    stage = 'renderer_network';
    const canaryStatus = await hostile.evaluate(
      async (url) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).status,
      canary.href,
    );
    assert(
      'browser_canary_control',
      canaryStatus === 204 && canaryRequests === 1,
      'The browser can reach the request observer from the probe page.',
    );
    const requestDenied = await renderer.evaluate(async (destination) => {
      try {
        await fetch(destination, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
        return false;
      } catch (error) {
        return error instanceof TypeError;
      }
    }, canary.href);
    assert(
      'browser_renderer_network_refused',
      requestDenied && canaryRequests === 1,
      'A probe fetch from the opaque renderer was refused before it reached the request observer.',
    );
    const rtcDenied = await renderer.parentFrame().evaluate(() => {
      const observer = new ReportingObserver(() => {}, { types: ['connection-allowlist'] });
      observer.observe();
      const peer = new RTCPeerConnection({ iceServers: [] });
      try {
        return observer.takeRecords().some(({ body }) => {
          const report = body.toJSON();
          return (
            report.connection === 'webrtc' &&
            report.disposition === 'enforce' &&
            Array.isArray(report.allowlist) &&
            report.allowlist.length === 0
          );
        });
      } finally {
        peer.close();
        observer.disconnect();
      }
    });
    assert(
      'browser_rtc_refused',
      rtcDenied,
      'Chromium reported WebRTC denial with an enforced empty connection allowlist on the sandbox wrapper.',
    );

    stage = 'unexpected_message_source';
    let proposals = 0;
    context.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === new URL(candidates, trusted).href)
        proposals++;
    });
    const messageId = randomUUID();
    await page.evaluate(
      ({ origin, url, id }) => {
        const original = document.querySelector('#app > iframe');
        const sibling = document.createElement('iframe');
        const listener = (event) => {
          if (
            event.data?.id !== id ||
            event.origin !== origin ||
            event.source !== sibling.contentWindow ||
            event.source === original?.contentWindow
          )
            return;
          document.documentElement.dataset.haipUnexpectedSource = id;
          window.removeEventListener('message', listener);
        };
        window.addEventListener('message', listener);
        sibling.id = 'haip-sibling-probe';
        sibling.sandbox.add('allow-scripts', 'allow-same-origin');
        sibling.src = url;
        document.body.append(sibling);
      },
      { origin: wrapperUrl.origin, url: wrapperUrl.href, id: messageId },
    );
    const sibling = page.locator('#haip-sibling-probe').contentFrame();
    await sibling.locator('body').evaluate(
      (_, { destination, id }) => {
        top.postMessage(
          {
            jsonrpc: '2.0',
            id,
            method: 'haip/ui.propose',
            params: { decision: 'answer', response: { choice: 'accept' } },
          },
          destination,
        );
      },
      { destination: trusted.origin, id: messageId },
    );
    await page.waitForFunction(
      (id) => document.documentElement.dataset.haipUnexpectedSource === id,
      messageId,
    );
    assert(
      'browser_wrong_source_refused',
      !(await readMaterial()).hasCandidate && proposals === 0,
      'The trusted page received a proposal from the correct sandbox origin in a different window and made no candidate request.',
    );

    stage = 'proposal_choice';
    await view.getByLabel('Your choice').selectOption('accept');
    stage = 'proposal_click';
    await propose.click();
    stage = 'proposal_confirmation';
    await page.getByRole('heading', { name: 'Trusted confirmation', exact: true }).waitFor();
    assert(
      'browser_proposal_control',
      proposals === 1 && (await readMaterial()).hasCandidate,
      'The same choice from the authorised renderer produced one candidate for human confirmation.',
    );
  } catch {
    if (assertions.every((entry) => entry.passed)) {
      assertions.push({
        name: stage,
        passed: false,
        detail:
          'Chromium did not complete this probe. Check the isolated review, sign-in and browser configuration.',
      });
    }
  } finally {
    await browser?.close();
  }
  return {
    version,
    assertions,
    passed: assertions.length > 0 && assertions.every((entry) => entry.passed),
  };
}
