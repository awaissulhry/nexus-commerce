#!/usr/bin/env node
/**
 * LX.FIN item 6 — the SCREEN half LX.6 and LX.F2 both held: the `Not computed` chip, the folded toolbar
 * WITH ITS `Filters` PANEL OPEN, and the 5-column `schemaMissing` sheet — at **1440 and 1728, LIGHT and
 * DARK**, on master · Amazon·IT · Amazon·DE · Amazon·BE (nl and fr) · eBay·IT. Plus the per-coordinate
 * readiness columns this lane added (R-LX-22), which only a screen can confirm.
 *
 * Both lanes before me recorded "the instrument cannot resize or emulate the media query". It can:
 * `setViewportSize` for the width, and a context `colorScheme` for the theme — now an optional argument
 * of `scripts/studio-browser-auth.mjs`. This app's theme is a `.dark` CLASS applied by `useTheme`, whose
 * default mode is `'system'`, so `colorScheme: 'dark'` reaches it through `prefers-color-scheme`. The
 * class is ASSERTED on every reading: a dark run whose class never landed is a light screenshot with a
 * dark label on it.
 *
 * READ ONLY on the web: every non-GET to the API is aborted at the network layer and the list is printed,
 * so "no write" is a measurement rather than a promise.
 *
 * Run through the session wrapper, ALONE:
 *   node scripts/studio-gate-session.mjs -- node scripts/_lxfin-screens.mjs
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = process.env.CENSUS_BASE ?? process.env.EDITOR_BASE ?? 'http://localhost:3000'
/** GALE-JACKET — 21 products, 884-row index: the POSITIVE CONTROL for every readiness reading. */
const GALE = process.env.LXFIN_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
/** IT-GALE-JACKET — measured on the wire to have ZERO `ReadinessIndex` rows: the `Not computed` arm. */
const NOT_COMPUTED = process.env.LXFIN_NOT_COMPUTED ?? 'cmrp2jfyd0008pa01t3w6mi4h'

const url = (id, query = '') => `${BASE}/products/${id}/edit/studio${query}`
const COORDS = [
  { key: 'master', product: GALE, query: '' },
  { key: 'amazon·IT', product: GALE, query: '?scope=AMAZON&market=IT&locale=it' },
  { key: 'amazon·DE', product: GALE, query: '?scope=AMAZON&market=DE&locale=de' },
  { key: 'amazon·BE·nl', product: GALE, query: '?scope=AMAZON&market=BE&locale=nl' },
  { key: 'amazon·BE·fr', product: GALE, query: '?scope=AMAZON&market=BE&locale=fr' },
  { key: 'ebay·IT', product: GALE, query: '?scope=EBAY&market=IT&locale=it' },
  /* The no-cached-schema coordinate: Amazon·PL holds 0 `CategorySchema` rows (measured), which is the
     only way the 5-column `schemaMissing` sheet exists at all. */
  { key: 'amazon·PL (no schema)', product: GALE, query: '?scope=AMAZON&market=PL&locale=pl' },
  /* The product with no index rows — the `Not computed` chip's own arm. */
  { key: 'master · NOT COMPUTED', product: NOT_COMPUTED, query: '' },
]
const ONLY = process.env.LXFIN_ONLY ? process.env.LXFIN_ONLY.split(',') : null
const COORD_SET = ONLY ? COORDS.filter((c) => ONLY.includes(c.key)) : COORDS
const WIDTHS = (process.env.LXFIN_WIDTHS ?? '1440,1728').split(',').map(Number)
const THEMES = (process.env.LXFIN_THEMES ?? 'light,dark').split(',')

function readScreen() {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const out = {
    dark: document.documentElement.classList.contains('dark'),
    /* Hydration is the precondition for every reading here (the 09-13 02:00 incident: server HTML with
       no fiber reads as "every control inert"). */
    hydrated: !!document.querySelector('.nds-grid-sheet') &&
      Object.keys(document.querySelector('.nds-grid-sheet') ?? {}).some((k) => k.startsWith('__reactFiber')),
  }

  // ── the scope chips ────────────────────────────────────────────────────────────────────────────
  out.scopes = [...document.querySelectorAll('.nds-scope[data-scope-id]')].map((chip) => ({
    id: chip.getAttribute('data-scope-id'),
    label: text(chip.querySelector('.nds-scope-label')),
    state: text(chip.querySelector('.nds-scope-state')),
    pct: text(chip.querySelector('.nds-scope-pct')),
    dot: [...(chip.querySelector('.nds-scope-dot')?.classList ?? [])].filter((c) => c !== 'nds-scope-dot').join(' '),
    on: chip.classList.contains('on'),
    title: (chip.getAttribute('title') ?? '').replace(/\s+/g, ' ').slice(0, 180),
  }))

  // ── the toolbar and its fold ───────────────────────────────────────────────────────────────────
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  const fold = bar?.querySelector('.nds-toolbar-fold')
  const trigger = fold?.querySelector('.nds-toolbar-fold-trigger')
  const panel = fold?.querySelector('.nds-toolbar-fold-panel')
  const clipped = bar
    ? [...bar.querySelectorAll('button,input,[role="note"],.nds-chip,.nds-filterchip')].filter((el) => {
        const r = el.getBoundingClientRect()
        const b = bar.getBoundingClientRect()
        const css = getComputedStyle(bar)
        return r.width > 0 && (r.left < b.left + parseFloat(css.paddingLeft) - 1 ||
          r.right > Math.min(window.innerWidth, b.right - parseFloat(css.paddingRight)) + 1 || r.top < b.top || r.bottom > b.bottom)
      }).map((el) => text(el).slice(0, 30) || el.tagName.toLowerCase())
    : null
  out.toolbar = bar ? {
    settled: !/Loading information|Not counted yet/.test(text(bar)),
    scrollW: bar.scrollWidth, clientW: bar.clientWidth, overflows: bar.scrollWidth > bar.clientWidth + 1,
    clipped,
    folded: !!fold?.classList.contains('is-folded'),
    triggerLabel: trigger ? text(trigger) : null,
    triggerCount: trigger ? text(trigger.querySelector('.nds-toolbar-fold-count')) : null,
    ariaExpanded: trigger?.getAttribute('aria-expanded') ?? null,
    panelHidden: panel ? panel.hasAttribute('hidden') : null,
    panelChildren: panel ? panel.children.length : null,
  } : { missing: true }

  // ── the sheet's columns, and the readiness columns this lane added ─────────────────────────────
  const headers = [...document.querySelectorAll('.nds-grid-sheet .ag-header-cell')]
    .map((h) => ({ id: h.getAttribute('col-id'), name: text(h.querySelector('.ag-header-cell-text')) || text(h) }))
  out.columns = { total: headers.length, ids: headers.map((h) => h.id) }
  out.readinessColumns = headers.filter((h) => (h.id ?? '').startsWith('ready:')).map((h) => h.name)
  out.readinessCells = [...document.querySelectorAll('.nds-grid-sheet .ag-row')].slice(0, 3).map((row) => {
    const cells = [...row.querySelectorAll('.ag-cell')].filter((c) => (c.getAttribute('col-id') ?? '').startsWith('ready:'))
    return cells.map((c) => `${c.getAttribute('col-id')}=${text(c)}`)
  })

  // ── the schemaMissing surface ──────────────────────────────────────────────────────────────────
  out.banners = [...document.querySelectorAll('.nds-banner, [role="status"], [role="alert"]')]
    .map((b) => text(b).slice(0, 200)).filter(Boolean).slice(0, 6)

  out.consoleReady = true
  return out
}

const results = []
const aborted = []
const consoleErrors = []

for (const theme of THEMES) {
  const browser = await chromium.launch()
  const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: WIDTHS[0], height: 906 }, colorScheme: theme })
  /* The explicit belt beside `colorScheme`: `useTheme` reads `localStorage['nexus:theme']` first and
     falls back to the media query. Both point the same way, and the `.dark` class is asserted anyway. */
  await page.addInitScript((mode) => { try { window.localStorage.setItem('nexus:theme', mode) } catch { /* private mode */ } }, theme)
  await page.route('**/*', (route) => {
    const m = route.request().method()
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { aborted.push(`${m} ${new URL(route.request().url()).pathname}`); return route.abort() }
    return route.continue()
  })
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${theme}: ${message.text().slice(0, 160)}`) })

  for (const coord of COORD_SET) {
    await page.goto(url(coord.product, coord.query), { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.nds-grid-sheet', { timeout: 40000 }).catch(() => {})
    /* 🔴 Wait for the LOADED state, never the loading one: LX.F2's own first toolbar reading was
       retracted for measuring "Loading information…" widths, which are narrower than the real ones. */
    const settled = await page.waitForFunction(() => {
      const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
      const chip = document.querySelector('.nds-scope[data-scope-id] .nds-scope-state, .nds-scope-pct.loading')
      if (!bar) return false
      const barSettled = !/Loading information|Not counted yet/.test(bar.textContent ?? '')
      const chipSettled = !!chip && !chip.classList.contains('loading')
      return barSettled && chipSettled
    }, undefined, { timeout: 45000 }).then(() => true).catch(() => false)

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 906 })
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const reading = await page.evaluate(readScreen)
      /* If the toolbar folded, OPEN the panel and read it — the one thing LX.F2 said nobody had watched. */
      let panelOpen = null
      if (reading.toolbar?.folded) {
        await page.click('.nds-grid-sheet .nds-toolbar-fold-trigger')
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        panelOpen = await page.evaluate(() => {
          const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
          const panel = document.querySelector('.nds-grid-sheet .nds-toolbar-fold-panel')
          const trigger = document.querySelector('.nds-grid-sheet .nds-toolbar-fold-trigger')
          const chips = panel ? [...panel.querySelectorAll('button,.nds-filterchip,.nds-chip')] : []
          const box = panel?.getBoundingClientRect()
          return {
            ariaExpanded: trigger?.getAttribute('aria-expanded') ?? null,
            hidden: panel?.hasAttribute('hidden') ?? null,
            visible: !!box && box.width > 0 && box.height > 0,
            inViewport: !!box && box.left >= 0 && box.right <= window.innerWidth && box.top >= 0,
            box: box ? { w: Math.round(box.width), h: Math.round(box.height), left: Math.round(box.left), top: Math.round(box.top) } : null,
            chips: chips.map((c) => `${text(c).slice(0, 26)}${c.getAttribute('aria-pressed') ? `[pressed=${c.getAttribute('aria-pressed')}]` : ''}`),
            /* The panel's own background must be painted, or a dark reading is a transparent overlay. */
            background: panel ? getComputedStyle(panel).backgroundColor : null,
            colour: panel ? getComputedStyle(panel).color : null,
          }
        })
        /* Press the first chip INSIDE the panel — the assertion nobody had made: the folded host is the
           same control, not a copy, so its pressed state must actually move. */
        const first = await page.$('.nds-grid-sheet .nds-toolbar-fold-panel button[aria-pressed]')
        if (first) {
          const before = await first.getAttribute('aria-pressed')
          await first.click()
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
          const after = await first.getAttribute('aria-pressed')
          panelOpen.chipToggled = { before, after, moved: before !== after }
          if (before !== after) { await first.click(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))) }
        } else {
          panelOpen.chipToggled = { note: 'no aria-pressed control inside the panel' }
        }
        await page.keyboard.press('Escape')
      }
      results.push({ coord: coord.key, theme, width, settled, ...reading, panelOpen })
    }
  }
  await browser.close()
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
for (const r of results) {
  const themeOk = r.theme === 'dark' ? r.dark : !r.dark
  console.log(`\n── ${r.coord} · ${r.width}px · ${r.theme}${themeOk ? '' : ' 🔴 THEME CLASS DID NOT LAND'} · hydrated ${r.hydrated} · settled ${r.settled ? 'YES' : '🔴 NO'}`)
  console.log(`   scopes: ${r.scopes.map((s) => `${s.label}${s.state ? ` · ${s.state}` : ''}${s.pct ? ` ${s.pct}` : ''}${s.dot ? ` (${s.dot})` : ''}${s.on ? ' [active]' : ''}`).join(' | ') || '🔴 none'}`)
  const t = r.toolbar ?? {}
  console.log(`   toolbar: folded ${t.folded} trigger ${JSON.stringify(t.triggerLabel)} count ${JSON.stringify(t.triggerCount)} · scrollW ${t.scrollW} vs clientW ${t.clientW}${t.overflows ? ' 🔴 OVERFLOWS' : ''} · clipped ${t.clipped?.length ?? '?'}${t.clipped?.length ? ` 🔴 ${t.clipped.join(', ')}` : ''}`)
  if (r.panelOpen) console.log(`   Filters panel OPEN: aria-expanded ${r.panelOpen.ariaExpanded} hidden ${r.panelOpen.hidden} visible ${r.panelOpen.visible} inViewport ${r.panelOpen.inViewport} box ${JSON.stringify(r.panelOpen.box)} bg ${r.panelOpen.background} · ${r.panelOpen.chips.length} controls: ${r.panelOpen.chips.join(' | ')} · chip toggle ${JSON.stringify(r.panelOpen.chipToggled)}`)
  console.log(`   columns ${r.columns.total} · readiness columns ${r.readinessColumns.length}${r.readinessColumns.length ? `: ${r.readinessColumns.join(' | ')}` : ''}`)
  if (r.readinessCells.some((c) => c.length)) console.log(`   first rows' readiness cells: ${JSON.stringify(r.readinessCells)}`)
  if (r.columns.total <= 8) console.log(`   column ids: ${r.columns.ids.join(', ')}`)
  if (r.banners.length) console.log(`   banners: ${r.banners.map((b) => JSON.stringify(b)).join(' | ')}`)
}
console.log(`\nnon-GET requests aborted at the network layer: ${aborted.length}${aborted.length ? ` — ${[...new Set(aborted)].join(', ')}` : ' (read-only, measured)'}`)
console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${[...new Set(consoleErrors)].join('\n  ')}` : ''}`)
const badTheme = results.filter((r) => (r.theme === 'dark') !== r.dark)
const unhydrated = results.filter((r) => !r.hydrated)
console.log(`readings ${results.length} · theme class correct on ${results.length - badTheme.length}/${results.length} · hydrated on ${results.length - unhydrated.length}/${results.length}`)
process.exit(badTheme.length || unhydrated.length ? 1 : 0)
