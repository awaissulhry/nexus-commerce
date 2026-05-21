/**
 * GS.8 — smoke + auth-gated coverage for the Global Snapshot widget.
 *
 * The widget mounts on /orders (top) and /dashboard/overview. Both
 * are behind a login wall on prod, so without an auth fixture the
 * spec can only prove the routes still respond. Once the fixture
 * lands, the fixme'd specs below cover the tile + panel behavior.
 */

import { test, expect } from '@playwright/test'

test.describe('Global Snapshot — smoke (unauth)', () => {
  test('/dashboard/overview responds', async ({ page }) => {
    const res = await page.goto('/dashboard/overview', { waitUntil: 'domcontentloaded' })
    expect(res).toBeTruthy()
    expect(res!.status()).toBeLessThan(500)
  })

  test('/orders responds (snapshot mounts at top)', async ({ page }) => {
    const res = await page.goto('/orders', { waitUntil: 'domcontentloaded' })
    expect(res).toBeTruthy()
    expect(res!.status()).toBeLessThan(500)
  })
})

test.describe('Global Snapshot — auth-gated (TODO)', () => {
  test.fixme('strip renders three tiles with chevrons', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByText('Global snapshot')).toBeVisible()
    await expect(page.getByText('Sales')).toBeVisible()
    await expect(page.getByText('Open Orders')).toBeVisible()
    await expect(page.getByText('Buyer Messages')).toBeVisible()
  })

  test.fixme('Sales tile shows today total + 7-day sparkline', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByText('Today so far')).toBeVisible()
    await expect(page.getByLabel('7-day sales sparkline')).toBeVisible()
  })

  test.fixme('Open Orders tile shows FBM unshipped / FBM pending / FBA pending', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByText('FBM unshipped')).toBeVisible()
    await expect(page.getByText('FBM pending')).toBeVisible()
    await expect(page.getByText('FBA pending')).toBeVisible()
  })

  test.fixme('clicking Sales tile expands the panel', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: /Sales/ }).click()
    await expect(page.getByLabel('Sales sparkline').or(page.getByText('Ordered product sales'))).toBeVisible()
  })

  test.fixme('Sales period dropdown re-fetches with the chosen window', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: /Sales/ }).click()
    await page.selectOption('select', '7d')
    await expect(page.getByText('Last 7 days')).toBeVisible()
  })

  test.fixme('Open Orders cell deep-links to /orders with filters', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: /Open Orders/ }).click()
    const cell = page.locator('a').filter({ hasText: /^[1-9]/ }).first()
    await cell.click()
    await expect(page).toHaveURL(/marketplace=.+&fulfillment=.+&status=.+/)
  })

  test.fixme('localStorage remembers the last expanded tile', async ({ page, context }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: /Sales/ }).click()
    const newPage = await context.newPage()
    await newPage.goto('/orders')
    // Sales panel content should be visible immediately, no click needed
    await expect(newPage.getByText('Ordered product sales')).toBeVisible()
  })

  test.fixme('Sales delta arrow renders for single-day periods', async ({ page }) => {
    await page.goto('/orders')
    // Either ▲ or ▼ should appear next to Today's total when prev > 0
    const delta = page.locator('text=/[▲▼]/')
    await expect(delta.first()).toBeVisible()
  })
})
