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
const charts = page.locator('[data-cat="charts"]')
if (await charts.count()) { await page.waitForTimeout(500); await charts.screenshot({ path: `${OUT}/charts.png` }); console.log('ok charts') }
const grid = page.locator('[data-cat="datagrid"]')
if (await grid.count()) { await grid.screenshot({ path: `${OUT}/datagrid.png` }); console.log('ok datagrid') }
const patterns = page.locator('[data-cat="patterns"]')
if (await patterns.count()) { await patterns.screenshot({ path: `${OUT}/patterns.png` }); console.log('ok patterns') }
const filters = page.locator('[data-cat="filters"]')
if (await filters.count()) { await filters.screenshot({ path: `${OUT}/filters.png` }); console.log('ok filters') }

// overlays — open each, screenshot the portaled element, close
const shotOverlay = async (btnName, sel, name) => {
  const btn = page.getByRole('button', { name: btnName })
  if (!(await btn.count())) return
  await btn.first().click(); await page.waitForTimeout(300)
  const el = page.locator(sel).first()
  if (await el.count()) { await el.screenshot({ path: `${OUT}/${name}.png` }); console.log('ok ' + name) }
  await page.keyboard.press('Escape'); await page.waitForTimeout(200)
}
await shotOverlay('Open modal', '.h10-ds-modal', 'modal')
await shotOverlay('Open drawer', '.h10-ds-drawer', 'drawer')
const menuBtn = page.getByRole('button', { name: 'Actions' })
if (await menuBtn.count()) {
  await menuBtn.first().click(); await page.waitForTimeout(200)
  const menu = page.locator('.h10-ds-menu').first()
  if (await menu.count()) { await menu.screenshot({ path: `${OUT}/menu.png` }); console.log('ok menu') }
  await menuBtn.first().click(); await page.waitForTimeout(150)
}

// dropdowns
const msb = page.locator('.h10-ds-ms-btn').first()
if (await msb.count()) {
  await msb.click(); await page.waitForTimeout(200)
  const pop = page.locator('.h10-ds-ms-pop').first()
  if (await pop.count()) { await pop.screenshot({ path: `${OUT}/multiselect.png` }); console.log('ok multiselect') }
  await msb.click(); await page.waitForTimeout(150) // close before next interaction
}
const cin = page.locator('.h10-ds-combo-in').first()
if (await cin.count()) {
  await cin.click(); await page.waitForTimeout(200)
  const cp = page.locator('.h10-ds-combo-pop').first()
  if (await cp.count()) { await cp.screenshot({ path: `${OUT}/combobox.png` }); console.log('ok combobox') }
  await page.mouse.click(5, 5); await page.waitForTimeout(150) // outside-click to close
}
// toast
const tb = page.getByRole('button', { name: 'Show toast' })
if (await tb.count()) {
  await tb.first().click(); await page.waitForTimeout(300)
  const toastEl = page.locator('.h10-ds-toast').first()
  if (await toastEl.count()) { await toastEl.screenshot({ path: `${OUT}/toast.png` }); console.log('ok toast') }
}
// date range picker
const dp = page.locator('.h10-ds-dp button').first()
if (await dp.count()) {
  await dp.click(); await page.waitForTimeout(250)
  const pop = page.locator('.h10-ds-dp-pop').first()
  if (await pop.count()) { await pop.screenshot({ path: `${OUT}/daterange.png` }); console.log('ok daterange') }
  await page.mouse.click(5, 5); await page.waitForTimeout(150)
}
// hover card
const hc = page.locator('.h10-ds-hovercard').first()
if (await hc.count()) {
  await hc.hover(); await page.waitForTimeout(250)
  const card = page.locator('.h10-ds-hovercard .hc').first()
  if (await card.count()) { await card.screenshot({ path: `${OUT}/hovercard.png` }); console.log('ok hovercard') }
}

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
