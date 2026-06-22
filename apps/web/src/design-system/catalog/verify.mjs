/**
 * Catalog screenshot harness — the Phase 2 verify tool.
 *
 * Captures /design-system at @2x (light + dark, full page) for self-review and
 * as the baseline the later component/migration phases screenshot-diff against.
 * Reuses the established H10 pattern (Playwright, deviceScaleFactor: 2). This
 * file is ignored by the Next build + tsc (loose .mjs, not imported).
 *
 *   1. npm run dev            # web on http://localhost:3000
 *   2. node apps/web/src/design-system/catalog/verify.mjs   # from repo root
 *
 * Override the target with WEB=… (e.g. the live Vercel URL).
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = `${process.cwd()}/.analysis/dsshot`
mkdirSync(OUT, { recursive: true })
const WEB = process.env.WEB || 'http://localhost:3000'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

// dev mode keeps HMR/SSE sockets open, so 'networkidle' never fires — wait for
// the DOM + the catalog heading. Retry through transient dev-server errors (a
// parallel session's broken file can flap the whole server 500↔200).
let ready = false
for (let i = 0; i < 10 && !ready; i++) {
  try {
    await page.goto(`${WEB}/design-system`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('h1', { timeout: 6000 })
    const heading = await page.locator('h1').first().textContent()
    if (heading && heading.includes('Token Catalog')) { ready = true; break }
  } catch { /* fall through to retry */ }
  console.log(`  …catalog not ready yet (attempt ${i + 1}), dev server may be flapping`)
  await page.waitForTimeout(2500)
}
if (!ready) { console.log('catalog never rendered cleanly — aborting'); await browser.close(); process.exit(1) }
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/catalog-light.png`, fullPage: true })
console.log('ok catalog-light')

const prim = page.locator('[data-cat="primitives"]')
if (await prim.count()) { await prim.screenshot({ path: `${OUT}/primitives.png` }); console.log('ok primitives') }
const comp = page.locator('[data-cat="components"]')
if (await comp.count()) { await comp.screenshot({ path: `${OUT}/components.png` }); console.log('ok components') }

const darkBtn = page.getByRole('button', { name: /Dark/ })
if (await darkBtn.count()) {
  await darkBtn.click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/catalog-dark.png`, fullPage: true })
  console.log('ok catalog-dark')
}

if (errs.length) console.log('CONSOLE ERRORS:\n' + errs.slice(0, 8).join('\n'))
else console.log('no console errors')
await browser.close()
