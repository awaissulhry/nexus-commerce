#!/usr/bin/env node
/**
 * LX.FIN item 6, second pass — two things the first pass could NOT measure, and said so.
 *
 * 1. **Are the R-LX-22 per-coordinate readiness columns THERE?** The first pass read
 *    `.ag-header-cell`, which AG virtualises, so `readiness columns 0` was a "could not measure", not a
 *    "measured empty" (`reference_could_not_measure_vs_measured_empty`). This pass reads the grid's own
 *    `aria-colcount` AND scrolls the body to its far right before reading the headers, so an absent
 *    column and an off-screen one are different answers.
 * 2. **The 2 CLIPPED controls at `master · NOT COMPUTED · 1440`** (`scrollW 1444 vs clientW 1372`,
 *    `Customise` + one unnamed button clipped, in BOTH themes) — every direct child of that toolbar with
 *    its own width, so the 72px is attributable instead of argued.
 *
 * READ ONLY: every non-GET is aborted at the network layer and the list is printed.
 *   node scripts/studio-gate-session.mjs -- node scripts/_lxfin-screens2.mjs
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = process.env.CENSUS_BASE ?? process.env.EDITOR_BASE ?? 'http://localhost:3000'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const NOT_COMPUTED = 'cmrp2jfyd0008pa01t3w6mi4h'
const url = (id, q = '') => `${BASE}/products/${id}/edit/studio${q}`

const CASES = [
  { key: 'master (GALE, it)', product: GALE, query: '', width: 1440 },
  { key: 'master (GALE, de pressed)', product: GALE, query: '?locale=de', width: 1440 },
  { key: 'amazon·IT (GALE)', product: GALE, query: '?scope=AMAZON&market=IT&locale=it', width: 1440 },
  { key: 'master · NOT COMPUTED', product: NOT_COMPUTED, query: '', width: 1440 },
]

function readColumns() {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const root = document.querySelector('.nds-grid-sheet .ag-root')
  const headers = [...document.querySelectorAll('.nds-grid-sheet .ag-header-cell')]
  return {
    ariaColCount: root?.getAttribute('aria-colcount') ?? null,
    renderedHeaders: headers.length,
    readyHeaders: headers.filter((h) => (h.getAttribute('col-id') ?? '').startsWith('ready:')).map((h) => ({ id: h.getAttribute('col-id'), name: text(h.querySelector('.ag-header-cell-text')) || text(h) })),
    lastHeaders: headers.slice(-6).map((h) => h.getAttribute('col-id')),
    /* The readiness CELLS of the first rendered row, so the pill's text is read and not assumed. */
    readyCells: [...document.querySelectorAll('.nds-grid-sheet .ag-row')].slice(0, 4).flatMap((row) =>
      [...row.querySelectorAll('.ag-cell')].filter((c) => (c.getAttribute('col-id') ?? '').startsWith('ready:'))
        .map((c) => ({ row: row.getAttribute('row-index'), col: c.getAttribute('col-id'), text: text(c), pill: text(c.querySelector('.nds-pill')) || null }))),
  }
}

function readToolbarChildren() {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  if (!bar) return { missing: true }
  const css = getComputedStyle(bar)
  const box = bar.getBoundingClientRect()
  const label = (el) => {
    const cls = [...el.classList].filter((c) => c.startsWith('nds-') || c === 'cnt' || c === 'grow').join('.')
    const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` "${t}"` : ''}`
  }
  return {
    barW: Math.round(box.width), innerW: Math.round(box.width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)),
    scrollW: bar.scrollWidth, clientW: bar.clientWidth, over: bar.scrollWidth - bar.clientWidth,
    children: [...bar.children].map((el) => ({ w: Math.round(el.getBoundingClientRect().width * 10) / 10, label: label(el) })),
  }
}

const aborted = []
const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 906 } })
await page.route('**/*', (route) => {
  const m = route.request().method()
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { aborted.push(`${m} ${new URL(route.request().url()).pathname}`); return route.abort() }
  return route.continue()
})

for (const c of CASES) {
  await page.setViewportSize({ width: c.width, height: 906 })
  await page.goto(url(c.product, c.query), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.nds-grid-sheet .ag-row', { timeout: 40000 }).catch(() => {})
  const settled = await page.waitForFunction(() => {
    const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
    return !!bar && !/Loading information|Not counted yet/.test(bar.textContent ?? '')
  }, undefined, { timeout: 45000 }).then(() => true).catch(() => false)

  const before = await page.evaluate(readColumns)
  /* Scroll the grid body to its far right — the readiness columns are appended LAST, so this is the
     difference between "no such column" and "a column an operator has to scroll to". */
  await page.evaluate(() => {
    const v = document.querySelector('.nds-grid-sheet .ag-body-horizontal-scroll-viewport')
      ?? document.querySelector('.nds-grid-sheet .ag-center-cols-viewport')
    if (v) v.scrollLeft = 1e6
  })
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)))
  const after = await page.evaluate(readColumns)
  const toolbar = await page.evaluate(readToolbarChildren)

  console.log(`\n── ${c.key} @ ${c.width}px · settled ${settled}`)
  console.log(`   aria-colcount ${before.ariaColCount} · rendered headers ${before.renderedHeaders} -> ${after.renderedHeaders} after scrolling right`)
  console.log(`   ready: headers BEFORE scroll ${before.readyHeaders.length} · AFTER scroll ${after.readyHeaders.length}${after.readyHeaders.length ? ` -> ${after.readyHeaders.map((h) => `${h.id}="${h.name}"`).join(' | ')}` : ''}`)
  console.log(`   last rendered col-ids after scroll: ${after.lastHeaders.join(', ')}`)
  if (after.readyCells.length) console.log(`   readiness CELLS: ${after.readyCells.map((x) => `row${x.row} ${x.col} = ${JSON.stringify(x.pill ?? x.text)}`).join(' | ')}`)
  console.log(`   toolbar: ${toolbar.scrollW} vs ${toolbar.clientW} (over ${toolbar.over}) · ${toolbar.children?.length} children`)
  for (const child of toolbar.children ?? []) console.log(`     ${String(child.w).padStart(7)}  ${child.label}`)
}
await browser.close()
console.log(`\nnon-GET requests aborted: ${aborted.length}${aborted.length ? ` — ${[...new Set(aborted)].join(', ')}` : ' (read-only, measured)'}`)
