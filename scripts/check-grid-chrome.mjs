#!/usr/bin/env node
/**
 * GDS §8.2 — grid chrome conformance, MEASURED in a real browser.
 *
 * Opens /design/grid-lab?tab=gds (every scenario, frozen fixtures, no API), calls the page's
 * `window.__gdsProbe()` at each density, in both themes, at a laptop and a monitor width, and holds
 * what the grids actually computed against `apps/web/src/design-system/grid/spec.json`:
 * row / header / strip / totals heights, partition width and height, selection column, thumbnail,
 * header/cell colours, row rule, hover/selected variables. The spec is the same table `GRID.md`
 * prints, so a number in the doc is a number a browser has confirmed.
 *
 * Needs a dev server on :3000. Pre-push runs it ONLY when one answers and says loudly when it
 * skips — a silent pass with no server is the empty-assertion trap this repo has met before.
 * Run it by hand before showing any grid work:
 *
 *   npm run grid:conformance            # against http://localhost:3000
 *   GDS_BASE=https://… npm run grid:conformance
 *   node scripts/check-grid-chrome.mjs --strict     # a missing server is a FAILURE
 */
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.GDS_BASE ?? 'http://localhost:3000'
const STRICT = process.argv.includes('--strict')
const spec = JSON.parse(readFileSync('apps/web/src/design-system/grid/spec.json', 'utf8'))

const alive = await fetch(`${BASE}/design/grid-lab`, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false)
if (!alive) {
  const msg = `grid chrome conformance: no dev server at ${BASE} — NOT MEASURED. Run \`npm run grid:conformance\` with the dev server up before showing grid work.`
  if (STRICT) { console.error(`❌ ${msg}`); process.exit(1) }
  console.warn(`⚠️  SKIPPED — ${msg}`)
  process.exit(0)
}

const DENSITIES = ['compact', 'cozy', 'spacious']
const VIEWPORTS = [{ w: 1440, h: 900, name: 'monitor' }, { w: 1280, h: 962, name: 'laptop' }]
// Scenarios whose grid pins its own density (the spec still applies at that tier).
const FIXED = { roundtrip: 'cozy', 'actions-right': 'cozy', detail: 'cozy', drawer: 'cozy', keyboard: 'cozy', big: 'compact', sheet: 'compact' }
const MEDIA = new Set(['catalogue', 'family', 'editor', 'loading'])
const EPS = 0.06

const failures = []
const check = (where, what, got, want) => {
  if (got == null) { failures.push(`${where} ${what}: not measured (null)`); return }
  const ok = typeof want === 'number' ? Math.abs(got - want) <= EPS : String(got).toLowerCase() === String(want).toLowerCase()
  if (!ok) failures.push(`${where} ${what}: got ${got}, spec ${want}`)
}

const browser = await chromium.launch()
const page = await browser.newPage()
let probes = 0
try {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h })
    await page.goto(`${BASE}/design/grid-lab?tab=gds`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.__gdsProbe === 'function' && document.querySelectorAll('[data-gds-scenario] .ag-row').length > 5, null, { timeout: 60000 })
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') { await page.getByRole('button', { name: 'Light', exact: true }).click(); await page.waitForTimeout(400) }
      for (const density of DENSITIES) {
        // the DS SegmentedControl is a radiogroup, not buttons — find the option by its label
        await page.getByText(density[0].toUpperCase() + density.slice(1), { exact: true }).first().click()
        await page.waitForTimeout(700)
        const r = await page.evaluate(() => window.__gdsProbe())
        probes++
        const want = spec.theme[theme]
        for (const [id, m] of Object.entries(r.scenarios)) {
          const tier = FIXED[id] ?? density
          const t = spec.density[tier]
          const where = `[${vp.name} ${theme} ${density}] #${id}`
          if (m.rowH != null) check(where, 'row', m.rowH, MEDIA.has(id) ? t.rowMedia : t.rowText)
          check(where, 'header', m.headerH, t.header)
          if (m.stripH != null) check(where, 'strip', m.stripH, spec.geometry.stripH)
          if (m.totalsH != null) check(where, 'totals (= header)', m.totalsH, t.header)
          check(where, 'partition w', m.partitionW, spec.geometry.partitionW)
          check(where, 'partition h (30% of header)', m.partitionH, Math.round(t.header * spec.geometry.partitionRatio * 100) / 100)
          if (m.thumbW != null) check(where, 'thumb', m.thumbW, t.thumb)
          if (m.selColW != null) check(where, 'selection col', m.selColW, spec.geometry.selectColW)
          if (m.cellPadL != null) check(where, 'cell pad (AG −1)', parseFloat(m.cellPadL), t.cellPadX - 1)
          check(where, 'header fg', m.headerFg, want.headerFg)
          if (m.cellFg != null) check(where, 'cell fg', m.cellFg, want.cellFg)
          if (m.rowRule != null) check(where, 'row rule', m.rowRule, want.rowRule)
          check(where, 'bg', m.bg, want.bg)
          check(where, 'header bg var', m.vars.headerBg, want.headerBg)
          check(where, 'hover var', m.vars.hover, want.hover)
          check(where, 'selected var', m.vars.selected, want.selected)
          check(where, 'totals bg var', m.vars.totalsBg, want.totalsBg)
          check(where, 'header fs', m.headerFs, spec.type.headerSize)
          if (m.cellFs != null) check(where, 'cell fs', m.cellFs, spec.type.cellSize)
          if (m.stripBg != null) check(where, 'strip bg', m.stripBg, want.stripBg)
          if (m.stripFg != null) check(where, 'strip fg', m.stripFg, want.stripFg)
        }
      }
      if (theme === 'dark') { await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.waitForTimeout(300) }
    }
  }
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\n❌ grid chrome conformance: ${failures.length} mismatch(es) across ${probes} probes:\n`)
  for (const f of failures.slice(0, 60)) console.error(`   ${f}`)
  if (failures.length > 60) console.error(`   … ${failures.length - 60} more`)
  process.exit(1)
}
console.log(`✓ grid chrome conformance: every scenario matches spec.json at 3 densities × 2 themes × 2 viewports (${probes} probes)`)
