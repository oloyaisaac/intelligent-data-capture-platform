import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Real Chromium + renderer + backend. This is not a packaged Electron test. */
test('a user can sign in, reset a password and sign in again', async ({ page, request }) => {
  const email = `e2e-${randomUUID()}@example.com`;
  const oldPassword = 'initial secure passphrase';
  const newPassword = 'another secure passphrase';
  const registration = await request.post('/api/v1/auth/register', {
    data: {
      email,
      password: oldPassword,
      displayName: 'E2E Owner',
      organisationName: 'E2E Workspace',
      acceptTerms: true,
    },
  });
  expect(registration.status()).toBe(201);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to IDCP' })).toBeVisible();
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(oldPassword);
  const login = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await login).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();

  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await page.locator('input[type=email]').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const link = page.getByTestId('dev-reset-link');
  await expect(link).toBeVisible();
  // The local-only link is returned in NODE_ENV=test; production mail never exposes it to the API caller.
  const resetUrl = await link.getAttribute('href');
  expect(resetUrl).toBeTruthy();
  await page.goto(resetUrl!);
  await page.locator('input[type=password]').fill(newPassword);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByTestId('login-notice')).toContainText('Password updated');
  expect(new URL(page.url()).hash).toBe('');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});
