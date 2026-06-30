/**
 * BN.1.1 — "Browse node" column header regression guard.
 *
 * Post-merge guard only — do NOT run against local dev; prod URL is required.
 * Asserts the friendly header label is visible in the flat-file editor.
 */
import { test, expect } from '@playwright/test'

test('amazon flat-file editor shows "Browse node" column header', async ({ page }) => {
  await page.goto('/products/amazon-flat-file?marketplace=IT&productType=COAT', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  // The editor loads async; wait for the column header to appear.
  await expect(
    page.locator('thead th').filter({ hasText: 'Browse node' }).first(),
  ).toBeVisible({ timeout: 20_000 })
})
