/**
 * FF-EN — eBay flat-file pick-or-type combobox regression guard.
 *
 * Locks in the FF-EN series: enum columns on /products/ebay-flat-file open
 * a searchable dropdown that accepts a typed custom value ("Use …"). Runs
 * against the live deploy (the editor is open, no auth).
 *
 *   PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app \
 *     npx playwright test ebay-flat-file-combobox --workspace=@nexus/web
 *
 * Override the family with PLAYWRIGHT_PRODUCT_ID if it's wiped/reseeded.
 */

import { test, expect } from '@playwright/test'

const FAMILY = process.env.PLAYWRIGHT_PRODUCT_ID ?? 'cmokmy3a40078pm0p1fvnu523'

test.describe('eBay flat-file — pick-or-type combobox (FF-EN)', () => {
  test('Condition cell opens a searchable dropdown that accepts a custom value', async ({ page }) => {
    await page.goto(`/products/ebay-flat-file?familyId=${FAMILY}&marketplace=IT`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    await page.waitForTimeout(7000)

    const body = (await page.locator('body').innerText()).toLowerCase()
    expect(body).not.toContain('application error')
    expect(body).not.toContain('unauthorized')

    // Condition cells render the raw enum value "NEW".
    const cell = page.getByText('NEW', { exact: true }).first()
    await expect(cell).toBeVisible()

    // Activate, then open the dropdown.
    await cell.click()
    await page.waitForTimeout(300)
    await cell.click()
    await page.waitForTimeout(400)

    // The dropdown's search box — any "Search…" placeholder except the
    // toolbar "Search rows…" — so the test survives FF-EN.6's mode-specific
    // placeholder wording.
    const search = page.locator('input[placeholder*="Search" i]:not([placeholder*="rows" i])').first()
    await expect(search).toBeVisible()

    // Typing a non-listed value surfaces the "Use …" custom path (FF-EN.0).
    await search.fill('Vintage Custom')
    await page.waitForTimeout(300)
    const ddText = await page.locator('body').innerText()
    expect(ddText).toMatch(/Use\s+/)
  })
})
