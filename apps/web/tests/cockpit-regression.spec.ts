/**
 * GOV — Listing-cockpit regression guard.
 *
 * Locks in the cockpit work shipped in the UC/AC/EC/CARD/i18n/SSE-CORS
 * series so future changes can't silently regress it. Unlike the older
 * `test.fixme()` stubs (written when the app was behind a login wall),
 * these run for real: the product editor is currently open (no auth),
 * so the specs drive the live cockpit directly.
 *
 * Run against the deploy:
 *   PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app \
 *     npx playwright test cockpit-regression --workspace=@nexus/web
 *
 * Or a local dev server (default baseURL http://localhost:3000).
 *
 * The target product is a real Xavia parent with variants + multi-market
 * listings. Override with PLAYWRIGHT_PRODUCT_ID if it's wiped/reseeded.
 *
 * Locale note: the i18n shim hydrates locale from localStorage per
 * component on mount and doesn't switch reliably under headless Chromium,
 * so assertions match the English fallback (or Italian) via regex rather
 * than asserting a single locale. i18n *catalog* correctness is covered
 * by the pre-push parity hook, not here.
 */

import { test, expect, type Page } from '@playwright/test'

const PRODUCT_ID = process.env.PLAYWRIGHT_PRODUCT_ID ?? 'cmokmy3a40078pm0p1fvnu523'
const HYDRATE_MS = 6000

/** SSE EventSource failures the SSE-CORS fix must keep at bay. */
function sseCorsErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => /\/events/.test(e) && /(blocked|CORS|Access to resource)/i.test(e),
  )
}

async function openCockpit(page: Page, tab: 'AMAZON' | 'EBAY'): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  // networkidle never settles — the SSE streams stay open by design — so
  // wait on DOM + a fixed hydrate window instead.
  await page.goto(`/products/${PRODUCT_ID}/edit?tab=${tab}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await page.waitForTimeout(HYDRATE_MS)
  return errors
}

test.describe('Listing cockpit — regression (GOV)', () => {
  test('app is reachable at the base URL', async ({ page }) => {
    const res = await page.goto('/', { waitUntil: 'domcontentloaded' })
    expect(res).toBeTruthy()
    expect(res!.status()).toBeLessThan(500)
  })

  test('Amazon cockpit renders real cards — no "Soon" placeholders', async ({ page }) => {
    await openCockpit(page, 'AMAZON')
    const body = (await page.locator('body').innerText()).toLowerCase()

    // Page is healthy
    expect(body).not.toContain('application error')
    expect(body).not.toContain('unauthorized')

    // CARD track: the dashed "Soon" placeholders are gone
    expect(body).not.toContain('\nsoon')
    expect(body).not.toContain('edit these in')

    // The three replaced cards are present (English fallback or Italian)
    expect(body).toMatch(/fulfillment|evasione|fba\/fbm/i) // CARD.1
    expect(body).toMatch(/gpsr|compliance|conformità/i) // CARD.2
    expect(body).toMatch(/size & fit|taglia|compatibility|compatibilità/i) // CARD.3

    // Health rail present
    expect(body).toMatch(/health|salute|blocked|bloccat/i)
  })

  test('Amazon Variant Cube exposes its three views', async ({ page }) => {
    await openCockpit(page, 'AMAZON')
    // Toggle labels (en) — Italian equivalents accepted via regex.
    await expect(
      page.getByRole('button', { name: /axis grid|griglia per asse/i }).first(),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /by variant|per variante/i }).first(),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /by market|per mercato/i }).first(),
    ).toBeVisible()
  })

  test('Amazon cockpit raises no SSE/CORS console errors (SSE-CORS fix)', async ({ page }) => {
    const errors = await openCockpit(page, 'AMAZON')
    const sse = sseCorsErrors(errors)
    expect(sse, `SSE/CORS errors:\n${sse.join('\n')}`).toHaveLength(0)
  })

  test('eBay cockpit renders its health rail and raises no SSE/CORS errors', async ({ page }) => {
    const errors = await openCockpit(page, 'EBAY')
    const body = (await page.locator('body').innerText()).toLowerCase()
    expect(body).not.toContain('application error')
    // eBay keeps its richer section health rail (deliberate non-parity)
    expect(body).toMatch(/pre-publish health|salute pre-pubblicazione|category & aspects|caratteristiche/i)
    expect(sseCorsErrors(errors)).toHaveLength(0)
  })

  // T3.3a — the cross-channel comparison matrix opens from the header
  // and lists the product across both channels.
  test('Cross-channel matrix drawer opens and lists both channels', async ({ page }) => {
    await openCockpit(page, 'AMAZON')
    const btn = page.getByRole('button', { name: /Cross-channel|Multi-canale/i }).first()
    await expect(btn).toBeVisible()
    await btn.click()
    await page.waitForTimeout(2000)
    const body = (await page.locator('body').innerText()).toLowerCase()
    expect(body).toMatch(/cross-channel matrix|matrice multi-canale/i)
    expect(body).toContain('amazon')
    expect(body).toContain('ebay')
  })

  // T3.3b — the matrix can PREVIEW a cross-channel propagation (we stop at
  // the diff; we don't Apply, to avoid writing to real listings).
  test('Cross-channel matrix previews a propagation diff', async ({ page }) => {
    await openCockpit(page, 'AMAZON')
    await page.getByRole('button', { name: /Cross-channel|Multi-canale/i }).first().click()
    await page.waitForTimeout(1500)
    const propagate = page.getByRole('button', {
      name: /Propagate across channels|Propaga tra i canali/i,
    }).first()
    await expect(propagate).toBeVisible()
    await propagate.click()
    await page.waitForTimeout(3500)
    const body = (await page.locator('body').innerText()).toLowerCase()
    // Either proposed changes render or everything already matches.
    expect(body).toMatch(
      /proposed changes|modifiche proposte|nothing to propagate|niente da propagare/i,
    )
  })

  // EV.1 — the eBay Variations Matrix renders its variants (it read the
  // wrong empty fields before, so guard against that regression).
  test('eBay Variations Matrix renders variants with axes', async ({ page }) => {
    await openCockpit(page, 'EBAY')
    const body = (await page.locator('body').innerText()).toLowerCase()
    expect(body).not.toContain('application error')
    expect(body).toMatch(/variations matrix|matrice|variazioni/i)
    // Size × Color axes present (the data the matrix derives from).
    expect(body).toMatch(/size|taglia/i)
    expect(body).toMatch(/colou?r|colore/i)
  })
})
