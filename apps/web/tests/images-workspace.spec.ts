/**
 * IR.16 — Smoke spec for /products/[id]/edit?tab=images.
 *
 * Currently covers only what's reachable without auth — the workspace
 * is behind a login wall on prod, so without a seeded session cookie
 * the spec can't drive the lightbox + editor + DAM picker the IR
 * series shipped.
 *
 * What this spec WILL assert once auth is wired:
 *   - Master gallery renders all images in workspace.master
 *   - Channel tabs (Master / Amazon / eBay / Shopify) switch panels
 *   - Lightbox opens on master-image click, drawer shows metadata
 *   - "Crop & rotate" opens the editor; aspect-ratio toggles work
 *   - "From library" opens the DAM picker; folder + tag filters apply
 *   - Apply-to-children button shows on parent products
 *   - Publish-history section expands + shows job rows with retry
 *
 * Until then, these specs prove the harness wiring + lockfile.
 */

import { test, expect } from '@playwright/test'

test.describe('Images workspace — smoke (unauth)', () => {
  test('app responds at the configured base URL', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Either 200 (logged in) or 3xx → /login (logged out). Both prove
    // the dev server / Vercel deploy is alive.
    expect(response).toBeTruthy()
    expect(response!.status()).toBeLessThan(500)
  })

  test('title contains the Nexus brand', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveTitle(/Nexus/i)
  })
})

// Auth-gated specs live here. Skipped until a fixture seeds the
// session cookie. test.fixme() is preferred over test.skip() because
// it shows up red in the report — keeps the gap visible.
test.describe('Images workspace — auth-gated (TODO)', () => {
  test.fixme('lightbox opens on master thumbnail click', async ({ page }) => {
    // 1. Sign in via cookie fixture (TODO)
    // 2. Navigate to /products/<seeded-xavia-parent>/edit?tab=images
    // 3. Click first master-grid thumbnail
    // 4. await expect(page.getByRole('dialog', { name: /Image preview/i })).toBeVisible()
    await page.goto('/products/seeded/edit?tab=images')
  })

  test.fixme('apply-to-children button shows on parent products', async ({ page }) => {
    await page.goto('/products/seeded-parent/edit?tab=images')
    // await expect(page.getByRole('button', { name: /Apply to children|Applica ai figli/i })).toBeVisible()
  })

  test.fixme('Amazon panel shows marketplace guidance card on IT tab', async ({ page }) => {
    await page.goto('/products/seeded/edit?tab=images')
    // await page.getByRole('button', { name: /Amazon IT/i }).click()
    // await expect(page.getByText(/lifestyle MAIN images|lifestyle MAIN/i)).toBeVisible()
  })
})
