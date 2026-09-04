import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, type Browser, type Page } from '@playwright/test';
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
async function signIn(page: Page, subject: string) {
  await page.goto(env.origin + '/auth/login');
  await page.getByRole('textbox', { name: 'User' }).fill(subject);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(env.origin + '/inbox');
}

test('a real cross-site attacker callback URL cannot replace another browser session', async () => {
  const attacker = await browser.newContext(),
    victim = await browser.newContext();
  let callback = '';
  const landing = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><a href="' +
        callback.replaceAll('&', '&amp;').replaceAll('"', '&quot;') +
        '">Continue</a>',
    );
  });
  try {
    const attackerPage = await attacker.newPage(),
      victimPage = await victim.newPage();
    const authorisePath = env.service.config.oidc.issuer + '/authorize';
    // Hold the fixture provider's real redirect before the browser sends a callback.
    await attackerPage.route(authorisePath, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const grant = await route.fetch({ maxRedirects: 0 });
      assert.equal(grant.status(), 302);
      callback = grant.headers().location!;
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<p>Held attacker callback</p>',
      });
    });
    await attackerPage.goto(env.origin + '/auth/login');
    await attackerPage.getByRole('textbox', { name: 'User' }).fill('reviewer2');
    await attackerPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await attackerPage.getByText('Held attacker callback', { exact: true }).waitFor();
    assert(callback);
    assert((await attacker.cookies()).some((cookie) => cookie.name === '__Host-haip-login'));
    await signIn(victimPage, 'reviewer');
    const originalSession = (await victim.cookies()).find(
      (cookie) => cookie.name === '__Host-haip',
    )!;
    assert(!(await victim.cookies()).some((cookie) => cookie.name === '__Host-haip-login'));
    await new Promise<void>((resolve) => landing.listen(0, '127.0.0.1', resolve));
    await victimPage.goto(`http://127.0.0.1:${(landing.address() as { port: number }).port}`);
    const callbackResponse = victimPage.waitForResponse((response) => response.url() === callback);
    await victimPage.getByRole('link', { name: 'Continue', exact: true }).click();
    const rejected = await callbackResponse;
    assert.equal(rejected.status(), 401);
    const headers = await rejected.request().allHeaders();
    assert.equal(headers['sec-fetch-site'], 'cross-site');
    assert.equal(rejected.request().method(), 'GET');
    assert(headers.cookie?.includes('__Host-haip='));
    assert(!headers.cookie?.includes('__Host-haip-login='));
    const stillSignedIn = await victim.request.get(env.origin + '/auth/session');
    assert.equal(stillSignedIn.status(), 200);
    assert.equal((await stillSignedIn.json()).subject, 'reviewer');
    assert.equal(
      (await victim.cookies()).find((cookie) => cookie.name === '__Host-haip')!.value,
      originalSession.value,
    );
    // The URL was valid: only the initiating browser can complete the transaction.
    await attackerPage.unroute(authorisePath);
    await attackerPage.goto(callback);
    await attackerPage.waitForURL(env.origin + '/inbox');
    assert.equal(
      (await (await attacker.request.get(env.origin + '/auth/session')).json()).subject,
      'reviewer2',
    );
  } finally {
    await attacker.close();
    await victim.close();
    if (landing.listening) await new Promise<void>((resolve) => landing.close(() => resolve()));
  }
});

test('normal cross-site OIDC GET redirects retain Lax login and initiating-session cookies during rotation', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, 'reviewer');
    const previous = (await context.cookies()).find((cookie) => cookie.name === '__Host-haip')!;
    await page.goto(env.origin + '/auth/login');
    const login = (await context.cookies()).find((cookie) => cookie.name === '__Host-haip-login')!;
    assert(login.secure && login.httpOnly && login.sameSite === 'Lax');
    assert.equal(
      (
        await fetch(env.origin + '/auth/session', {
          headers: { Cookie: '__Host-haip=' + previous.value },
        })
      ).status,
      200,
    );
    const callbackResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/auth/callback',
    );
    await page.getByRole('textbox', { name: 'User' }).fill('reviewer2');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const response = await callbackResponse;
    assert.equal(response.status(), 302);
    const headers = await response.request().allHeaders();
    assert.equal(response.request().method(), 'GET');
    assert.equal(headers['sec-fetch-site'], 'cross-site');
    assert(headers.cookie?.includes('__Host-haip-login=' + login.value));
    assert(headers.cookie?.includes('__Host-haip=' + previous.value));
    await page.waitForURL(env.origin + '/inbox');
    const current = (await context.cookies()).find((cookie) => cookie.name === '__Host-haip')!;
    assert.notEqual(current.value, previous.value);
    assert.equal(
      (await (await context.request.get(env.origin + '/auth/session')).json()).subject,
      'reviewer2',
    );
    assert.equal(
      (
        await fetch(env.origin + '/auth/session', {
          headers: { Cookie: '__Host-haip=' + previous.value },
        })
      ).status,
      401,
    );
  } finally {
    await context.close();
  }
});
