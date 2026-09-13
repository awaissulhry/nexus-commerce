/**
 * VT.4b — the catalogue filter and the family footer, on screen, through the R-GATE-1 wrapper.
 *
 *   node scripts/studio-gate-session.mjs -- node scripts/_vt4b-screens.mjs
 *
 * READ-ONLY on the web. Every grid request body is captured, so the reading shows the SERVER predicate
 * (`context.filters.variationMapping`) rather than a client-side narrowing — a page that filtered rows in the
 * browser would show the same grid with an unfiltered request, and only the capture can tell them apart.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = 'http://localhost:3000'
const out = (o) => console.log(JSON.stringify(o, null, 1))
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })
const errors = []
const gridPosts = []
const mutations = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(clean(m.text()).slice(0, 200)) })
page.on('request', (r) => {
  const path = new URL(r.url()).pathname
  if (['PATCH', 'PUT', 'DELETE'].includes(r.method())) mutations.push(`${r.method()} ${path}`)
  if (r.method() === 'POST' && path === '/api/products/grid') {
    try {
      const body = JSON.parse(r.postData() ?? '{}')
      gridPosts.push({ variationMapping: body?.context?.filters?.variationMapping, startRow: body?.request?.startRow, groupKeys: body?.request?.groupKeys })
    } catch { gridPosts.push({ unparsable: true }) }
  }
})

const readGrid = async () => await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  /* 🔴 The SKU is INSIDE the tree column's cell, not in a `col-id="sku"` cell — my first pass read
     `.ag-center-cols-container` and got `rows: 0` on a grid that was showing everything, which is the
     could-not-measure shape. Rows are counted by unique `row-id` anywhere in the viewport, and the SKU is
     pulled out of the identity cell's own text. */
  const rowIds = new Set([...document.querySelectorAll('.ag-row[row-id]')].map((r) => r.getAttribute('row-id')))
  const auto = [...document.querySelectorAll('.ag-row[row-id] [col-id="ag-Grid-AutoColumn"]')].map((c) => t(c)).filter(Boolean)
  const skus = auto.map((text) => (text.match(/Open([A-Za-z0-9._-]+)/) ?? [])[1]).filter(Boolean)
  return {
    rows: rowIds.size,
    skus: [...new Set(skus)].slice(0, 14),
    identityCount: new Set(auto).size,
    countLabel: t([...document.querySelectorAll('*')].find((el) => el.children.length === 0 && /^\d[\d,]*\s+products?$/i.test(t(el)))),
    banner: [...document.querySelectorAll('.nds-banner')].map((b) => t(b)).find((s) => s.includes('Not applied')) ?? null,
    activeFilters: t([...document.querySelectorAll('button')].find((b) => /^Filters/.test(t(b)))),
  }
})

const visit = async (url, label) => {
  gridPosts.length = 0
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  /* 🔴 `waitForFunction(fn, arg, options)` — the options are the THIRD argument. My first run passed them as
     `arg`, so the default 30 s applied and a slow first compile read as "the grid is not there". */
  try {
    await page.waitForFunction(() => !!document.querySelector('.ag-root'), null, { timeout: 60000, polling: 500 })
  } catch {
    out({ step: `${label} · COULD NOT MEASURE`, url: page.url(), bodyStart: (await page.evaluate(() => document.body.innerText)).slice(0, 300), errors: errors.slice(0, 5) })
    return
  }
  await page.waitForTimeout(3500)
  out({ step: label, url: page.url(), ...(await readGrid()), gridPostsCaptured: gridPosts.slice(0, 4) })
}

await visit(`${BASE}/products/next?filter=variation-mapping:collides`, '1 · ?filter=variation-mapping:collides — must be the fixture ALONE')
await visit(`${BASE}/products/next?filter=variation-mapping:derived`, '2 · ?filter=variation-mapping:derived — GALE-JACKET must be present (positive control)')
await visit(`${BASE}/products/next?filter=variation-mapping:teleport`, '3 · an unknown word — must narrow to NOTHING and say so, never widen')
await visit(`${BASE}/products/next`, '4 · no filter — the denominator')

/* ── the family footer, under an expanded family ─────────────────────────────────────────────── */
const expanded = await page.evaluate(async () => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const toggles = [...document.querySelectorAll('.ag-row[row-id] .ag-group-contracted .ag-icon, .ag-row[row-id] span.ag-group-expanded, .ag-row[row-id] .ag-group-contracted')]
  const first = toggles.find((el) => el.offsetParent !== null)
  if (!first) return { ok: false, toggles: toggles.length }
  first.click()
  await new Promise((r) => setTimeout(r, 3000))
  return { ok: true, row: t(first.closest('.ag-row')?.querySelector('[col-id="ag-Grid-AutoColumn"]')) }
})
await page.waitForTimeout(5000)
const footer = await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const cells = [...document.querySelectorAll('.ag-row[row-id] [class*="famFoot"]')]
  return {
    footers: cells.length,
    texts: [...new Set(cells.map((c) => t(c)))].slice(0, 4),
    mappingSentences: [...document.querySelectorAll('[class*="famFootCount"]')]
      .map((c) => ({ text: t(c), title: c.getAttribute('title') }))
      .filter((x) => x.text.startsWith('Variation mapping')),
  }
})
out({ step: '5 · the FamilyFooter, under an expanded family', expanded, ...footer })

out({ step: '6 · console errors', count: errors.length, errors: errors.slice(0, 8) })
await page.evaluate(() => console.error('VT.4b positive control — the console listener is wired'))
await page.waitForTimeout(400)
out({ step: '6 · POSITIVE CONTROL', fired: errors.some((e) => e.includes('VT.4b positive control')) })
out({ step: 'FINAL · mutations (must be empty)', mutations })
await browser.close()
