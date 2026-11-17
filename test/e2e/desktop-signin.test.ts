import { test, expect } from '@playwright/test';

/**
 * E2E Harness: Desktop Sign-in (MC-07).
 */
test.describe('Desktop Sign-in E2E', () => {
  test('packaged desktop app resolves /api/v1 and signs in successfully', async ({ page }) => {
    await page.goto('http://localhost:5173');

    const cspHeader = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(cspHeader).toBeNull();

    await page.fill('input[type="email"]', 'owner@example.com');
    await page.fill('input[type="password"]', 'demo-password-change-me');
    await page.click('button[type="submit"]');

    const response = await page.waitForResponse(/api\/v1\/auth\/login/);
    expect(response.status()).toBe(200);
  });

  test('API health smoke test', async ({ request }) => {
    const response = await request.get('/api/v1/health');
    expect(response.status()).toBe(200);
    const data = (await response.json()) as { status: string };
    expect(data.status).toBe('ok');
  });
});
