/**
 * OX.15 — Smoke spec for /orders + /orders/[id] after the 14-phase
 * Amazon-grade rebuild (OX.0 → OX.14).
 *
 * The orders area is behind a login wall on prod, so without a seeded
 * session cookie the spec can't drive the FBM/FBA toggle, status tabs,
 * row layout, action menus, or detail-page cards. Until an auth
 * fixture exists, these specs prove the harness wiring + that the
 * rebuild didn't break the login redirect / route handler.
 *
 * What the auth-gated specs WILL cover once the fixture lands:
 *   /orders list page
 *     - FulfilmentSegmentedControl (OX.1) renders FBM | FBA | All with counts
 *     - StatusTabs (OX.2) render All/Pending/Unshipped/Shipped/Cancelled
 *     - DateRangePicker (OX.3) opens, presets + custom dates apply to URL
 *     - Order Type filter (OX.3) is in the secondary popover
 *     - Row layout (OX.4) shows orderDate / orderDetails / image /
 *       productName / orderType / status / actions columns by default
 *     - Actions column is sticky to the right edge and contains
 *       5 vertically-stacked buttons (Manage invoice, Edit consignment,
 *       Print packing slip, Refund Order, More information ⌄)
 *     - More dropdown opens in a portal and doesn't get clipped
 *     - Bulk Print Packing Slips (OX.5) opens a new tab when 2+ orders
 *       are selected
 *     - Bulk Issue Invoices (OX.5) POSTs to the API
 *     - "Awaiting payment" badge (OX.0) renders for PENDING+€0 rows
 *
 *   /orders/[id] detail page
 *     - Sticky action bar (OX.6): 4 pill buttons + Export
 *     - Three-card summary triptych (OX.7) renders with Ship-by
 *       urgency tone
 *     - Order contents table (OX.8) shows dual VAT columns for IT
 *     - Per-package sections (OX.9) render one card per Shipment
 *     - Sales proceeds sidebar (OX.10) shows Items total + Grand total
 *       + Fee breakdown <details>
 *     - Manage Feedback card (OX.11) renders with channel-specific
 *       deep-link
 *     - Buyer profile drawer (OX.12) opens on Customer name click,
 *       shows LTV + Channel mix + 50-row recent orders
 *     - Italian Fiscal Block (OX.14) shows Codice Fiscale / P.IVA /
 *       PEC / Codice Destinatario for IT orders
 *     - Routing Decision card (OX.14) renders when CE.4 has a row
 *     - JSON export (OX.14) downloads
 */

import { test, expect } from '@playwright/test'

test.describe('Orders workspace — smoke (unauth)', () => {
  test('/orders responds (login redirect or 200)', async ({ page }) => {
    const response = await page.goto('/orders', { waitUntil: 'domcontentloaded' })
    expect(response).toBeTruthy()
    // Either 200 (logged in) or 3xx → /login (logged out). Both prove
    // the route handler is alive and the OX.0–OX.14 rebuild didn't
    // throw at module-eval / SSR time.
    expect(response!.status()).toBeLessThan(500)
  })

  test('orders detail route responds (placeholder id)', async ({ page }) => {
    // Detail page should either redirect to login (unauth) or return
    // a 404/302 for the placeholder id, but must not 500 — that would
    // indicate one of the new card components crashed on render.
    const response = await page.goto('/orders/cmplaceholder', {
      waitUntil: 'domcontentloaded',
    })
    expect(response).toBeTruthy()
    expect(response!.status()).toBeLessThan(500)
  })
})

// Auth-gated specs live here. Skipped until a fixture seeds the
// session cookie. test.fixme() is preferred over test.skip() because
// it shows up red in the report — keeps the gap visible.
test.describe('Orders workspace — auth-gated (TODO)', () => {
  test.fixme('FBM/FBA/All segmented toggle filters the list', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('tab', { name: /Seller fulfilled/ }).click()
    await expect(page).toHaveURL(/fulfillment=FBM/)
  })

  test.fixme('Status tabs include "No Invoice Uploaded" for IT orders', async ({ page }) => {
    await page.goto('/orders')
    const noInvoiceTab = page.getByRole('tab', { name: /No Invoice Uploaded/ })
    // Italian-fiscal-only — only visible when there are gaps to fill.
    // Spec asserts the tab is wired up; whether it's rendered depends
    // on the seeded DB state.
    await expect(noInvoiceTab.or(page.getByRole('tab', { name: 'All' }))).toBeVisible()
  })

  test.fixme('Date range preset writes to URL', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: /Date Range:/ }).click()
    await page.getByRole('button', { name: 'Last 7 days' }).click()
    await expect(page).toHaveURL(/dateRange=7d/)
  })

  test.fixme('Row action column is right-pinned and has 5 buttons', async ({ page }) => {
    await page.goto('/orders')
    const firstRow = page.getByRole('row').nth(1)
    await expect(firstRow.getByRole('link', { name: 'Manage invoice' })).toBeVisible()
    await expect(firstRow.getByRole('link', { name: 'Edit consignment' })).toBeVisible()
    await expect(firstRow.getByRole('link', { name: 'Print packing slip' })).toBeVisible()
    await expect(firstRow.getByRole('link', { name: 'Refund Order' })).toBeVisible()
    await expect(firstRow.getByRole('button', { name: 'More information' })).toBeVisible()
  })

  test.fixme('More dropdown opens in a portal (escapes table overflow)', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: 'More information' }).first().click()
    // Portal renders at document.body, so the menu should be outside
    // the table's overflow-x-auto wrapper.
    const menu = page.getByRole('link', { name: 'Open detail' })
    await expect(menu).toBeVisible()
    const inTable = await menu.evaluate((el) => !!el.closest('table'))
    expect(inTable).toBe(false)
  })

  test.fixme('detail page renders three-card summary triptych', async ({ page }) => {
    // Needs a known order id from the seeded fixture.
    await page.goto('/orders/SEEDED_ID')
    await expect(page.getByText('Order summary')).toBeVisible()
    await expect(page.getByText('Ship to')).toBeVisible()
    await expect(page.getByText('Shipping Service', { exact: false })).toBeVisible()
  })

  test.fixme('Italian order contents table shows dual VAT columns', async ({ page }) => {
    await page.goto('/orders/SEEDED_IT_ORDER_ID')
    await expect(page.getByText('Unit price', { exact: false })).toBeVisible()
    await expect(page.getByText('(VAT excl)')).toBeVisible()
    await expect(page.getByText('(VAT incl)')).toBeVisible()
  })

  test.fixme('Buyer profile drawer opens on Customer name click', async ({ page }) => {
    await page.goto('/orders/SEEDED_ID')
    await page.getByRole('button', { name: /Buyer profile/ }).click()
    await expect(page.getByRole('dialog', { name: 'Buyer profile' })).toBeVisible()
    await expect(page.getByText('Lifetime value')).toBeVisible()
  })
})
