/**
 * The gate session's SELF-TEST: does the disposable user actually open every page a gate visits?
 *
 *   node scripts/studio-gate-session.mjs -- node scripts/studio-gate-session.selftest.mjs
 *   node scripts/studio-gate-session.mjs --role OPS_MANAGER -- node scripts/studio-gate-session.selftest.mjs
 *
 * 🔴 Run BOTH. The second line is the discriminating control and it is the point of the file: with
 * the derived gate role `/channels/mapping` reads `denied:false`, and with `OPS_MANAGER` — the
 * widest role that already existed, which lacks exactly `pages.settings` — the SAME page reads
 * `denied:true` while every other page is identical. That isolates the permission rather than the
 * harness. VT.3 hit the refusal first, on the real page, before this existed.
 *
 * `denied` is the `PageGuard` 403 body, not an HTTP status: the guard renders in-content so the
 * chrome survives, and a probe that only checked for 200 would call it a pass.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'
const BASE = 'http://localhost:3000'
const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })
const visit = async (path, selector) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const state = await page.evaluate((sel) => ({
    denied: document.body.innerText.includes('Access denied'),
    own: !!document.querySelector(sel),
    title: document.title,
  }), selector)
  console.log(JSON.stringify({ path, selector, ...state }))
  return state
}
/* Positive arm — every page the gates visit. */
await visit('/channels/mapping', '[class*="mapping"], main')
await visit('/products/next', '.ag-root-wrapper, main')
await visit('/products/cmtzci5kf0000njr9f8yhrsxm/edit/studio?market=IT', '.ag-root-wrapper')
await visit('/listings', 'main')
await browser.close()
