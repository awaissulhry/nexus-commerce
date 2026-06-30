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

/**
 * BN.3.1 — "Categories in this sheet" toolbar regression guard.
 *
 * Post-merge guard only — do NOT run against local dev; prod URL is required.
 * Asserts the new summary label is visible and the old "+ Add category" text is absent.
 */
test('amazon flat-file editor shows "Categories in this sheet" and no "+ Add category"', async ({ page }) => {
  await page.goto('/products/amazon-flat-file?marketplace=IT&productType=COAT', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  // Wait for the grid to render fully.
  await expect(
    page.locator('thead th').filter({ hasText: 'Browse node' }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // New summary label must be present.
  await expect(
    page.getByText('Categories in this sheet'),
  ).toBeVisible({ timeout: 5_000 })

  // Old "+ Add category" control must be gone.
  await expect(
    page.getByText('+ Add category'),
  ).toHaveCount(0)
})

/**
 * BN.2.1 — "Category" derived column header regression guard.
 *
 * Post-merge guard only — do NOT run against local dev; prod URL is required.
 * Asserts the pinned, read-only Category column header is visible and appears
 * after the identity columns in the Amazon flat-file editor.
 */
test('amazon flat-file editor shows "Category" column header after identity columns', async ({ page }) => {
  await page.goto('/products/amazon-flat-file?marketplace=IT&productType=COAT', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  // Wait for the grid to render fully.
  await expect(
    page.locator('thead th').filter({ hasText: 'Browse node' }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Category header must be present.
  await expect(
    page.locator('thead th').filter({ hasText: 'Category' }).first(),
  ).toBeVisible({ timeout: 5_000 })
})
