import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { environment } from './environment.js';

test('trusted pages enter browser isolation and sever a cross-origin opener', async () => {
  const env = await environment();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.HAIP_TEST_CHROMIUM ? { executablePath: process.env.HAIP_TEST_CHROMIUM } : {}),
  });
  try {
    const context = await browser.newContext();
    const signedIn = await context.newPage();
    await signedIn.goto(env.origin + '/inbox');
    await signedIn.getByRole('textbox', { name: 'User' }).fill('reviewer');
    await signedIn.getByRole('button', { name: 'Sign in', exact: true }).click();
    await signedIn.waitForURL(env.origin + '/inbox');
    const opener = await context.newPage();
    await opener.goto(env.origin.replace('localhost', '127.0.0.1') + '/health');
    const opened = context.waitForEvent('page');
    await opener.evaluate((url) => {
      window.open(url, 'haip-review');
    }, env.origin + '/inbox');
    const review = await opened;
    await review.waitForURL(env.origin + '/inbox');
    await review.locator('#identity').getByText('reviewer', { exact: true }).waitFor();
    assert.equal(await review.evaluate(() => window.opener === null), true);
    assert.equal(await review.evaluate(() => window.crossOriginIsolated), true);
    await context.close();
  } finally {
    await browser.close();
    await env.close();
  }
});
