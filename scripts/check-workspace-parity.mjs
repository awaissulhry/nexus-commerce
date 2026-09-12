#!/usr/bin/env node
/**
 * AGL — grid parity, MEASURED in a real browser (design §8 step 2).
 *
 * Opens /design/grid-lab?tab=workspace and ?tab=datagrid (frozen fixtures, no API), waits for both
 * sides of every scenario to render rows, calls the page's `window.__parityProbe()` and prints, per
 * scenario, a table of property · legacy · AG · verdict. Then, with a REAL pointer, hovers the first row
 * of each side and reads the hover reveal (the Open pill, the edit pencil, the row paint), and on the
 * base scenario of each contract clicks the ACoS header three times per side to hold the sort orders
 * against each other (workspace: blanks must sink in BOTH directions; DataGrid: parity with the legacy).
 *
 * VERDICTS — colours, fonts and texts exact; geometry (px) within 1px; `header.*` reported, never judged
 * (the Owner's exemption); a scenario's own exemptions (`data-parity-exempt`, e.g. chromeless has no
 * toolbar) reported, never judged. A value one side measured and the other could not is a difference.
 *
 * EXIT CODES — 0 every judged property equal · 1 differences · 2 nothing could be judged (the AG side
 * has not landed, or a page never rendered). 2 is deliberate: a "pending" run must not read as green.
 *
 * Needs a dev server on :3000 (the probe is dev-only). Run by hand; NOT wired into pre-push.
 *
 *   npm run grid:parity                        # both tabs, full tables
 *   node scripts/check-workspace-parity.mjs --diff           # only the differing rows
 *   node scripts/check-workspace-parity.mjs --kind workspace --only metrics
 *   node scripts/check-workspace-parity.mjs --json out.json  # the whole result, raw + judged
 *   GDS_BASE=https://… PARITY_VIEWPORT=1440x900 npm run grid:parity
 *   node scripts/check-workspace-parity.mjs --strict         # a missing server is a FAILURE
 */
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE = process.env.GDS_BASE ?? 'http://localhost:3000'
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const STRICT = flag('--strict')
const DIFF_ONLY = flag('--diff')
const JSON_AT = opt('--json')
const KINDS = opt('--kind') ? [opt('--kind')] : ['workspace', 'datagrid']
const ONLY = opt('--only')
const [VW, VH] = (process.env.PARITY_VIEWPORT ?? '1728x962').split('x').map(Number)
const SORT_BASE = { workspace: 'metrics', datagrid: 'dg-base' }
/** `--no-selection` skips the header-checkbox round trip (the step that can freeze a looping engine). */
const SKIP_SELECTION = flag('--no-selection')

/**
 * Race a renderer-side call against a DRIVER-side clock. `page.waitForTimeout` is answered by the
 * driver, so it still fires when the renderer is frozen — a plain `page.evaluate` on a frozen page
 * hangs until the protocol gives up. Returns null on timeout.
 */
async function guarded(page, run, ms, what) {
  let timer
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  try {
    const r = await Promise.race([run().then((v) => (v === undefined ? {} : v)), clock])
    if (r === null) console.error(`   ⏱ ${what}: no answer within ${ms / 1000}s — the renderer is frozen`)
    return r
  } catch (e) {
    console.error(`   ⏱ ${what}: ${String(e).split('\n')[0].slice(0, 120)}`)
    return null
  } finally { clearTimeout(timer) }
}

// 🔴 60s, not 8s (hub #522, copied from check-grid-chrome.mjs): a cold Turbopack route under load is a
// COMPILE WAIT, not a down server. And `domcontentloaded` + explicit waits, never `networkidle` — the app
// holds SSE connections open and a page with a stream never goes idle.
const alive = await fetch(`${BASE}/design/grid-lab`, { signal: AbortSignal.timeout(60000) }).then((r) => r.ok).catch(() => false)
if (!alive) {
  const msg = `grid parity: no dev server at ${BASE} — NOT MEASURED. Start the web dev server and run \`npm run grid:parity\`.`
  if (STRICT) { console.error(`❌ ${msg}`); process.exit(1) }
  console.warn(`⚠️  SKIPPED — ${msg}`)
  process.exit(0)
}

/* ── judging ─────────────────────────────────────────────────────────────────────────────────── */

const NOPE = /^could not measure/
const isNum = (s) => typeof s === 'number'
const pxOf = (t) => (typeof t === 'string' && /^-?\d+(\.\d+)?px$/.test(t) ? parseFloat(t) : null)
const EPS = 1

/** Exact for colours/fonts/texts; ±1px for every px token; arrays/objects by value. */
function same(a, b) {
  if (isNum(a) || isNum(b)) {
    const x = isNum(a) ? a : pxOf(a), y = isNum(b) ? b : pxOf(b)
    return x != null && y != null && Math.abs(x - y) <= EPS
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const ta = a.split(/\s+/), tb = b.split(/\s+/)
    if (ta.length === tb.length && ta.some((t) => pxOf(t) != null)) {
      return ta.every((t, i) => { const x = pxOf(t), y = pxOf(tb[i]); return x != null && y != null ? Math.abs(x - y) <= EPS : t === tb[i] })
    }
    return a === b
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Flatten a side's measurement into dotted keys; `_`-prefixed keys are diagnostics, not properties. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k.startsWith('_')) continue
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}

/**
 * One row of the table. `verdict` ∈ ✓ · ✕ · ✕ missing · n/a · exempt · pending. Only ✕ rows count.
 * `header.*` is exempt by the Owner's ruling; a scenario's own exemptions are the first key segment.
 */
function judge(key, l, a, exempt) {
  const group = key.split('.')[0]
  const top = key.split('.').at(-1)
  if (l === undefined && a === undefined) return null
  if (l === 'pending' || a === 'pending') return 'pending'
  if (group === 'header' || exempt.includes(group)) return 'exempt'
  // Diagnostic texts and sizes that legitimately differ by engine: the sort glyph inside a header text,
  // the class lists (AG adds its own), the toolbar's button LIST (measured separately below).
  // …and the SOURCE labels the probe adds beside a judged colour (which box painted it, which drew the rule or
  // the shadow): the design maps `tr.on` to `.ag-row-selected` and a td's paint to a row overlay on purpose.
  if (['classes', 'firstClass', 'firstRowClass', 'paintBy', 'ruleBy', 'shadowBy', 'layers', 'selectedPaintBy', 'selectedLayers'].includes(top)) return 'info'
  const ln = typeof l === 'string' && NOPE.test(l), an = typeof a === 'string' && NOPE.test(a)
  if (ln && an) return 'n/a'
  if (ln !== an) return '✕ missing'
  return same(l, a) ? '✓' : '✕'
}

function tableFor(scn) {
  const rows = []
  const L = scn.legacy === 'pending' ? {} : flatten(scn.legacy)
  const A = scn.ag === 'pending' ? {} : flatten(scn.ag)
  const keys = [...new Set([...Object.keys(L), ...Object.keys(A)])]
  for (const key of keys) {
    const l = scn.legacy === 'pending' ? 'pending' : L[key]
    const a = scn.ag === 'pending' ? 'pending' : A[key]
    const verdict = judge(key, l, a, scn.exempt ?? [])
    if (!verdict) continue
    rows.push({ key, legacy: l, ag: a, verdict })
  }
  return rows
}

const fmt = (v) => {
  if (v === undefined) return '—'
  if (v === 'pending') return 'AG side pending'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 46 ? s.slice(0, 43) + '…' : s
}
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

function printTable(scn, rows) {
  const bad = rows.filter((r) => r.verdict.startsWith('✕'))
  const pending = rows.some((r) => r.verdict === 'pending')
  console.log(`\n── [${scn.kind}] #${scn.id}${scn.exempt?.length ? `  (exempt: ${scn.exempt.join(', ')})` : ''}  —  ${pending ? 'AG side pending' : `${bad.length} difference(s) in ${rows.filter((r) => r.verdict === '✓' || r.verdict.startsWith('✕')).length} judged properties`}`)
  const shown = DIFF_ONLY ? rows.filter((r) => r.verdict.startsWith('✕') || r.verdict === 'pending') : rows
  if (!shown.length) return
  const w = [Math.min(44, Math.max(...shown.map((r) => r.key.length), 8)), 46, 46]
  console.log(`   ${pad('property', w[0])}  ${pad('legacy', w[1])}  ${pad('AG', w[2])}  verdict`)
  for (const r of shown) {
    console.log(`   ${pad(r.key.length > w[0] ? '…' + r.key.slice(-(w[0] - 1)) : r.key, w[0])}  ${pad(fmt(r.legacy), w[1])}  ${pad(fmt(r.ag), w[2])}  ${r.verdict}`)
  }
}

/* ── the run ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * The probe global is set by the tab's effect and DELETED by its cleanup: a Fast Refresh remount (another lane
 * saving a file mid-run — run 6 died on `Cannot read properties of undefined (reading 'markRow')` in the
 * datagrid kind) leaves a tick with no probe. Every interactive step re-waits for it.
 */
const ensureProbe = (page) => page.waitForFunction(() => typeof window.__parityProbe === 'function', null, { timeout: 30000 })

const browser = await chromium.launch()
const page = await browser.newPage()
await page.setViewportSize({ width: VW, height: VH })
const result = { base: BASE, viewport: { w: VW, h: VH }, at: new Date().toISOString(), kinds: {} }
let totalDiff = 0, judged = 0, pendingScenarios = 0, notRendered = [], frozen = []

try {
  for (const kind of KINDS) {
    await page.goto(`${BASE}/design/grid-lab?tab=${kind}`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForFunction(() => typeof window.__parityProbe === 'function', null, { timeout: 60000 })
    } catch {
      const n = await page.evaluate(() => document.querySelectorAll('[data-parity-scenario]').length).catch(() => 0)
      notRendered.push(`${kind}: ${n > 0 ? '`window.__parityProbe` is undefined although the tab rendered — a PRODUCTION build (the probe is dev-only); point GDS_BASE at a dev server' : 'no `[data-parity-scenario]` rendered and no probe — the tab is broken or the route changed'}`)
      continue
    }
    // Legacy rows first: they are a `<table>`, present on the first paint.
    await page.waitForFunction(() => document.querySelectorAll('[data-parity-side="legacy"] tbody tr').length > 5, null, { timeout: 60000 })
    const list = await page.evaluate(() => window.__parityProbe.list())
    const agLive = list.some((s) => !s.agPending)
    if (agLive) {
      try {
        await page.waitForFunction(() => document.querySelectorAll('[data-parity-side="ag"]:not([data-parity-pending]) .ag-row').length > 5, null, { timeout: 60000 })
      } catch {
        notRendered.push(`${kind}: the AG side is wired but rendered no .ag-row within 60s`)
      }
    }
    await page.waitForTimeout(400)
    // Two animation frames after the rows appear (lane owner, 23:58): AG's column fit runs in a rAF and its row
    // auto-height through a ResizeObserver; a reading taken before them is 45px rows and unfitted columns.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))

    const probe = await guarded(page, () => page.evaluate(() => window.__parityProbe()), 120000, 'the full probe')
    if (!probe) { notRendered.push(`${kind}: the full probe did not return within 120s — the renderer froze`); continue }
    console.log(`   page visibility: ${probe.visibility?.state ?? '?'} · rAF within 300ms: ${probe.visibility?.rafWithin300ms ?? '?'} — ${probe.visibility?.note ?? 'not reported'}`)
    if (probe.visibility && (probe.visibility.state !== 'visible' || !probe.visibility.rafWithin300ms)) notRendered.push(`${kind}: measured from a HIDDEN page — the AG side's fit and auto-height never ran; not a rendering`)
    const scenarios = ONLY ? probe.scenarios.filter((s) => s.id === ONLY) : probe.scenarios

    // Hover — a real pointer per side, then the in-page read.
    for (const scn of scenarios) {
      for (const side of ['legacy', 'ag']) {
        if (scn[side] === 'pending') continue
        await ensureProbe(page)
        const sel = await page.evaluate(([id, s]) => window.__parityProbe.markRow(id, s), [scn.id, side])
        if (!sel) { scn[side].hoverReveal = 'could not measure: no data row to hover'; continue }
        try {
          await page.hover(sel, { timeout: 5000 })
          await page.waitForTimeout(150)
          scn[side].hoverReveal = await page.evaluate(([id, s]) => window.__parityProbe.hover(id, s), [scn.id, side])
        } catch (e) {
          scn[side].hoverReveal = `could not measure: hover failed (${String(e).split('\n')[0].slice(0, 80)})`
        }
        await page.mouse.move(0, 0)
      }
    }

    // Selection — the header-checkbox round trip, one side at a time, each raced against a DRIVER-side
    // timeout: an engine that loops on a controlled selection freezes the renderer, and the first run
    // did exactly that. A frozen side is reported as such and the page is reloaded for what follows.
    for (const scn of scenarios) {
      for (const side of ['legacy', 'ag']) {
        if (scn[side] === 'pending' || !flag('--selection') && SKIP_SELECTION) continue
        await ensureProbe(page)
        const r = await guarded(page, () => page.evaluate(([id, s]) => window.__parityProbe.selection(id, s), [scn.id, side]), 15000, `selection on ${scn.id}/${side}`)
        if (r === null) {
          scn[side].selection = 'could not measure: the renderer FROZE inside the header-checkbox round trip (15s) — an echo loop on a controlled selection is the usual cause'
          frozen.push(`${kind} #${scn.id} ${side}`)
          await page.goto(`${BASE}/design/grid-lab?tab=${kind}`, { waitUntil: 'domcontentloaded' })
          await page.waitForFunction(() => typeof window.__parityProbe === 'function' && document.querySelectorAll('[data-parity-side="legacy"] tbody tr').length > 5, null, { timeout: 60000 })
          await page.waitForTimeout(400)
        } else {
          scn[side].selection = r
        }
      }
    }

    // Sort — three clicks on ACoS per side on the base scenario; the orders are held against each other.
    const baseId = SORT_BASE[kind]
    const base = scenarios.find((s) => s.id === baseId)
    if (base) {
      for (const side of ['legacy', 'ag']) {
        if (base[side] === 'pending') continue
        const out = {}
        for (const step of ['first', 'second', 'third']) {
          await ensureProbe(page)
          await page.evaluate(([id, s]) => window.__parityProbe.sortBy(id, s, 'ACoS'), [base.id, side])
          await page.waitForTimeout(250)
          out[step] = await page.evaluate(([id, s]) => window.__parityProbe.columnTexts(id, s, 'acos', 'ACoS'), [base.id, side])
        }
        base[side].sort = out
      }
      // Workspace contract (KT.3): a blank sinks in BOTH directions. Asserted per side, not just across sides.
      if (kind === 'workspace') {
        for (const side of ['legacy', 'ag']) {
          const s = base[side]?.sort
          if (!s || typeof s.first === 'string') continue
          const blanksLast = (col) => { const all = [...col.first, ...col.last]; const i = all.findIndex((t) => t === '—'); return i < 0 || all.slice(i).every((t) => t === '—') }
          s.blanksSinkAsc = blanksLast(s.first) ? 'yes' : 'NO — a blank sits above a measured row'
          s.blanksSinkDesc = blanksLast(s.second) ? 'yes' : 'NO — a blank sits above a measured row'
          s.thirdClickClears = s.third.sortedHeader.length === 0 ? 'yes' : `NO — still sorted by ${s.third.sortedHeader.join(', ')}`
        }
      }
    }

    // Tables.
    const tables = {}
    for (const scn of scenarios) {
      const rows = tableFor(scn)
      tables[scn.id] = rows
      printTable(scn, rows)
      if (scn.ag === 'pending') pendingScenarios++
      for (const r of rows) { if (r.verdict === '✓' || r.verdict.startsWith('✕')) judged++; if (r.verdict.startsWith('✕')) totalDiff++ }
    }
    result.kinds[kind] = { probe: { ...probe, scenarios }, tables }
  }
} finally {
  await browser.close()
}

if (JSON_AT) { writeFileSync(JSON_AT, JSON.stringify({ ...result, summary: { judged, differences: totalDiff, pendingScenarios, notRendered, frozen } }, null, 2)); console.log(`\nwrote ${JSON_AT}`) }

for (const n of notRendered) console.error(`\n❌ grid parity: ${n}`)
if (frozen.length) { console.error(`\n❌ grid parity: the renderer FROZE inside the header-checkbox round trip on ${frozen.length} side(s): ${frozen.join(' · ')}`); totalDiff += frozen.length }
if (judged === 0) {
  console.error(`\n⚠️  grid parity: NOT MEASURED — ${pendingScenarios} scenario(s) have no AG side yet${notRendered.length ? `, ${notRendered.length} tab(s) did not render` : ''}. The legacy side was measured and is in the JSON; nothing was judged.`)
  process.exit(2)
}
if (totalDiff > 0 || notRendered.length) {
  console.error(`\n❌ grid parity: ${totalDiff} difference(s) across ${judged} judged properties${pendingScenarios ? ` (${pendingScenarios} scenario(s) still pending)` : ''}.`)
  process.exit(1)
}
console.log(`\n✓ grid parity: ${judged} judged properties equal across every scenario${pendingScenarios ? ` — but ${pendingScenarios} scenario(s) are still AG-pending` : ''} (viewport ${VW}×${VH}).`)
process.exit(pendingScenarios ? 2 : 0)
