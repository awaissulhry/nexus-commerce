#!/usr/bin/env node
/**
 * LX.F2 · R-LX-18 — MEASURE the sheet toolbar's children before inventing any collapse rule.
 *
 * LX.F refused to write the rule blind ("inventing a layout rule blind is exactly what the bar
 * forbids") and it was right: the ruling says the measured child widths at 1280 / 1440 / 1728 / 2048
 * DECIDE the rule. This prints, per width and per coordinate, every direct child of the sheet
 * toolbar with its own width, so the fold order is arithmetic and not taste.
 *
 * READ ONLY on the web: every non-GET to the API is aborted at the network layer, and the list of
 * aborted requests is printed so "no write" is a measurement rather than a promise.
 *
 * Run through the session wrapper, alone:
 *   node scripts/studio-gate-session.mjs -- node scripts/_lxf2-toolbar.mjs
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = process.env.CENSUS_BASE ?? process.env.EDITOR_BASE ?? 'http://localhost:3000'
const PRODUCT = process.env.CENSUS_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const STUDIO = `${BASE}/products/${PRODUCT}/edit/studio`
const WIDTHS = (process.env.LXF2_WIDTHS ?? '1280,1440,1728,2048').split(',').map(Number)
const ALL_COORDS = [
  { key: 'master', url: STUDIO },
  { key: 'amazon·DE', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de` },
  { key: 'ebay·IT', url: `${STUDIO}?scope=EBAY&market=IT&locale=it` },
]
const COORDS = process.env.LXF2_COORDS
  ? ALL_COORDS.filter((c) => process.env.LXF2_COORDS.split(',').includes(c.key))
  : ALL_COORDS.filter((c) => c.key !== 'master')

function measureInPage() {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  if (!bar) return { error: 'Sheet toolbar not found' }
  const box = bar.getBoundingClientRect()
  const css = getComputedStyle(bar)
  const padL = parseFloat(css.paddingLeft), padR = parseFloat(css.paddingRight)
  const inner = box.width - padL - padR
  const label = (el) => {
    const cls = [...el.classList].filter((c) => c.startsWith('nds-') || c === 'cnt' || c === 'grow').join('.')
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`
  }
  const children = [...bar.children].map((el) => {
    const r = el.getBoundingClientRect()
    return { label: label(el), w: Math.round(r.width * 10) / 10, visible: r.width > 0 && r.height > 0, scrollW: el.scrollWidth, clientW: el.clientWidth }
  })
  // Every leaf control, so the fold candidates can be named individually.
  const controls = [...bar.querySelectorAll('button,input,[role="note"],.nds-chip,.nds-filterchip')].map((el) => {
    const r = el.getBoundingClientRect()
    return { label: label(el), w: Math.round(r.width * 10) / 10,
      clippedLeft: r.left < box.left + padL - 1, clippedRight: r.right > Math.min(innerWidth, box.right - padR) + 1,
      clippedTop: r.top < box.top, clippedBottom: r.bottom > box.bottom }
  }).filter((c) => c.w > 0)
  const sum = children.reduce((n, c) => n + c.w, 0)
  return {
    viewport: innerWidth, barW: Math.round(box.width * 10) / 10, innerW: Math.round(inner * 10) / 10,
    barH: Math.round(box.height * 10) / 10, scrollW: bar.scrollWidth, clientW: bar.clientWidth,
    overflows: bar.scrollWidth > bar.clientWidth + 1,
    childSum: Math.round(sum * 10) / 10, over: Math.round((sum - inner) * 10) / 10,
    children, clipped: controls.filter((c) => c.clippedLeft || c.clippedRight || c.clippedTop || c.clippedBottom),
    controlCount: controls.length,
  }
}

const browser = await chromium.launch()
const aborted = []
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 906 } })
await page.route('**/*', (route) => {
  const m = route.request().method()
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { aborted.push(`${m} ${new URL(route.request().url()).pathname}`); return route.abort() }
  return route.continue()
})

const out = []
for (const coord of COORDS) {
  await page.goto(coord.url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.nds-grid-sheet .nds-toolbar', { timeout: 30000 }).catch(() => {})
  /**
   * 🔴 WAIT FOR THE LOADED STATE. The first run of this probe measured the count reading
   * "Loading information…" (128.8px) and every chip "Not counted yet" — the LOADING widths, which are
   * NARROWER than the real ones, so "nothing clips" would have been a measurement of the wrong page
   * (`reference_could_not_measure_vs_measured_empty`). `settled` is reported per reading so a
   * timed-out wait can never pass as a measurement.
   */
  const settled = await page.waitForFunction(() => {
    const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
    if (!bar) return false
    const text = bar.textContent ?? ''
    return !/Loading information|Not counted yet/.test(text) && !!document.querySelector('.ag-row')
  }, undefined, { timeout: 45000 }).then(() => true).catch(() => false)
  // Hydration is the precondition for every reading here (the 09-13 02:00 incident).
  const hydrated = await page.evaluate(() => !!document.querySelector('.nds-grid-sheet') &&
    Object.keys(document.querySelector('.nds-grid-sheet') ?? {}).some((k) => k.startsWith('__reactFiber')))
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 906 })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const m = await page.evaluate(measureInPage)
    out.push({ coord: coord.key, hydrated, settled, ...m })
  }
}
await browser.close()

for (const r of out) {
  console.log(`\n── ${r.coord} @ ${r.viewport}px · hydrated ${r.hydrated} · settled ${r.settled ? 'YES' : '🔴 NO (reading is the LOADING state, not evidence)'} · bar ${r.barW}×${r.barH} inner ${r.innerW} · children sum ${r.childSum} (${r.over > 0 ? `OVER by ${r.over}` : `${-r.over} spare`}) · scrollW ${r.scrollW} vs clientW ${r.clientW}${r.overflows ? ' · 🔴 OVERFLOWS' : ''}`)
  if (r.error) { console.log(`   ${r.error}`); continue }
  for (const c of r.children) console.log(`   ${String(c.w).padStart(7)}  ${c.label}${c.scrollW > c.clientW + 1 ? `  🔴 inner overflow ${c.scrollW}>${c.clientW}` : ''}`)
  console.log(`   ${r.controlCount} leaf controls · ${r.clipped.length} clipped`)
  for (const c of r.clipped) console.log(`   🔴 CLIPPED ${c.w}  ${c.label}  ${[c.clippedLeft && 'left', c.clippedRight && 'right', c.clippedTop && 'top', c.clippedBottom && 'bottom'].filter(Boolean).join('+')}`)
}
console.log(`\nnon-GET requests aborted at the network layer: ${aborted.length}${aborted.length ? ` — ${[...new Set(aborted)].join(', ')}` : ' (read-only, measured)'}`)
