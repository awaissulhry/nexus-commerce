/**
 * AR.5 — auth-gated specs for the Global Snapshot's real-time pipeline.
 *
 * Smoke specs (unauth) cover route liveness — those live in the
 * existing global-snapshot.spec.ts file. This file documents the
 * coverage that lands once an auth fixture is wired.
 */

import { test, expect } from '@playwright/test'

test.describe('Global Snapshot real-time (auth-gated TODO)', () => {
  test.fixme('marketplace dropdown re-scopes every tile + sparkline', async ({ page }) => {
    await page.goto('/dashboard/overview')
    await expect(page.getByText('Global snapshot')).toBeVisible()
    // Pick IT — sales total should be ≤ the previous All total.
    const allTotal = await page
      .locator('text=/€[0-9,.]+/')
      .first()
      .textContent()
    await page.getByRole('combobox', { name: /filter every tile by marketplace/i }).selectOption('IT')
    await page.waitForResponse((r) => r.url().includes('marketplace=IT'))
    const itTotal = await page
      .locator('text=/€[0-9,.]+/')
      .first()
      .textContent()
    expect(itTotal).not.toBe(allTotal)
  })

  test.fixme('AR.2 — SSE handler stays correctly scoped after marketplace switch', async ({ page }) => {
    // Reproduces the closure bug: select IT, fire a synthetic SSE event,
    // assert the tile total remained IT-scoped (didn't revert to ALL).
    await page.goto('/dashboard/overview')
    await page.getByRole('combobox').first().selectOption('IT')
    await page.waitForResponse((r) => r.url().includes('marketplace=IT'))
    // Hard part: simulate an order.created event without auth fixture.
    // Will be enabled once we have a test order seeder.
  })

  test.fixme('AR.3 — pulse animation fires on tile total change', async ({ page }) => {
    await page.goto('/dashboard/overview')
    // Capture initial total, trigger a refresh, expect ring class on the
    // value's wrapper for at least 300ms.
  })

  test.fixme('AR.4 — optimistic UI: tile bumps on order.created before fetch settles', async ({ page }) => {
    // Inject a fake order.created event into the SSE stream and assert
    // the tile total increased by the payload's totalPriceCents within
    // 100ms (well before any server fetch could complete).
    await page.goto('/dashboard/overview')
  })

  test.fixme('Pending +N annotation appears when payload reports pending.count > 0', async ({ page }) => {
    await page.goto('/dashboard/overview')
    await expect(page.locator('text=/\\+ \\d+ pending verification/')).toBeVisible()
  })

  test.fixme('Reconciliation banner shows green ✓ on match', async ({ page }) => {
    await page.goto('/dashboard/overview')
    await page.getByRole('button', { name: /Sales/ }).click()
    await expect(page.locator('text=/Reconciled with Amazon T\\+1 report/')).toBeVisible()
  })

  test.fixme('Click country row in Sales panel re-scopes the snapshot', async ({ page }) => {
    await page.goto('/dashboard/overview')
    await page.getByRole('button', { name: /Sales/ }).click()
    await page.getByText('Italy').first().click()
    await page.waitForResponse((r) => r.url().includes('marketplace=IT'))
  })
})
