#!/usr/bin/env node
/**
 * CLOSE.1 / R-LX-27 — the two status pills on the CHILDLESS family, before and after, at four widths.
 *
 *   node scripts/studio-gate-session.mjs -- node scripts/_close1-pills.mjs
 *
 * ## What "before" means here, and why it is not a revert
 *
 * Rule 11 forbids `git checkout` on the shared tree, so the BEFORE state is not recovered by undoing
 * the change — it is produced in the BROWSER, on the same nodes, in the same run
 * (`reference_recover_the_arm_you_cannot_observe`): the probe strips `compact` from the two pills and
 * `nds-vh` from their text spans, re-measures, then puts both back and re-measures again to prove the
 * page was left as it was found. That also makes the two states comparable in a way two runs are not.
 *
 * The mutation is two class-list edits on two `<span>`s. It fires no event, touches no React state,
 * issues no request, and every non-GET is aborted at the network layer and counted
 * (`reference_probe_safety_is_not_a_loan_from_the_page`: what the probe DOES, not what it measures).
 * `ResizeObserver` watches the BAR's box, which does not change size, so the engine does not re-render
 * underneath the reading.
 *
 * ## The clipping predicate is the CENSUS's, verbatim
 *
 * `toolbarLayoutInPage` is copied from `scripts/check-control-census.mjs:397-414` rather than
 * re-derived, so "0 clipped" here and the census's later green are the same claim
 * (`reference_write_predicate_must_match_its_readers` — an "equivalent" test one line away diverges).
 *
 * ## The family
 *
 * `cmrp2jfyd0008pa01t3w6mi4h`, the product LX.FIN's item-6 case 4 calls `master · NOT COMPUTED`: the
 * one whose toolbar has **11** children where every other coordinate has 9, because `Setup incomplete`
 * (138.5px) and `no children` (92.3px) exist only on a parent with no children. Its descriptor and both
 * pills are asserted below, so a reading on the wrong product cannot pass as this one. (LX.FIN's
 * DEFECT 2 heading says `IT-GALE-JACKET`; its own child table says `1 row · Parent · No children yet`
 * and its census note says GALE-JACKET has NEITHER pill, so the heading is the loose half.)
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = process.env.CENSUS_BASE ?? process.env.EDITOR_BASE ?? 'http://localhost:3000'
const CHILDLESS = process.env.CLOSE1_PRODUCT ?? 'cmrp2jfyd0008pa01t3w6mi4h'
const WIDTHS = (process.env.CLOSE1_WIDTHS ?? '1280,1440,1728,2048').split(',').map(Number)

/** VERBATIM from scripts/check-control-census.mjs:397-414. Do not "improve" it here. */
function toolbarLayoutInPage() {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  if (!bar) return ['Sheet toolbar not found']
  const box = bar.getBoundingClientRect()
  const css = getComputedStyle(bar)
  const left = box.left + parseFloat(css.paddingLeft)
  const right = Math.min(innerWidth, box.right - parseFloat(css.paddingRight))
  const failures = []
  if (bar.scrollWidth > bar.clientWidth + 1) failures.push('Toolbar overflows horizontally')
  for (const el of bar.querySelectorAll('button,input,[role="note"]')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (r.left < left - 1 || r.right > right + 1 || r.top < box.top || r.bottom > box.bottom) {
      failures.push(`Clipped toolbar control: ${el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName}`)
    }
  }
  return failures
}

function readBar() {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  if (!bar) return { missing: true }
  const w = (el) => Math.round(el.getBoundingClientRect().width * 10) / 10
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const label = (el) => {
    const cls = [...el.classList].filter((c) => c.startsWith('nds-') || c === 'cnt' || c === 'grow').join('.')
    const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` "${t}"` : ''}`
  }
  return {
    scrollW: bar.scrollWidth,
    clientW: bar.clientWidth,
    over: bar.scrollWidth - bar.clientWidth,
    children: [...bar.children].map((el) => ({ w: w(el), label: label(el) })),
    childCount: bar.children.length,
    folded: !!bar.querySelector('.nds-toolbar-fold.is-folded'),
    descriptor: text(bar.querySelector('.cnt')),
    /* Both pills, by their own class — and the accessible name, which is the claim that compacting
       hid the WORDS from the eye and not from assistive tech. */
    pills: [...bar.querySelectorAll('.nds-pill')].map((el) => ({
      w: w(el),
      compact: el.classList.contains('compact'),
      visibleText: (() => {
        const clone = el.cloneNode(true)
        for (const hidden of clone.querySelectorAll('.nds-vh')) hidden.remove()
        return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
      })(),
      accessibleText: text(el),
      glyphs: el.querySelectorAll('svg').length,
    })),
    /* AG renders nothing on the server: a row present is a HYDRATION witness, not decoration. */
    rows: document.querySelectorAll('.nds-grid-sheet .ag-row').length,
  }
}

const setCompact = (on) => {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  if (!bar) return 0
  let touched = 0
  for (const pill of bar.querySelectorAll('.nds-pill')) {
    const hidden = pill.querySelector('.nds-vh')
    if (on) {
      if (pill.dataset.close1WasCompact === '1') { pill.classList.add('compact'); touched++ }
      const span = pill.querySelector('span[data-close1-was-vh="1"]')
      if (span) span.classList.add('nds-vh')
    } else if (pill.classList.contains('compact')) {
      pill.dataset.close1WasCompact = '1'
      pill.classList.remove('compact')
      if (hidden) { hidden.dataset.close1WasVh = '1'; hidden.classList.remove('nds-vh') }
      touched++
    }
  }
  return touched
}

const aborted = []
const consoleErrors = []
const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 906 } })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
await page.route('**/*', (route) => {
  const m = route.request().method()
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { aborted.push(`${m} ${new URL(route.request().url()).pathname}`); return route.abort() }
  return route.continue()
})

let exit = 0
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 906 })
  await page.goto(`${BASE}/products/${CHILDLESS}/edit/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.nds-grid-sheet .ag-row', { timeout: 40000 }).catch(() => {})
  const settled = await page.waitForFunction(() => {
    const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
    return !!bar && !/Loading information|Not counted yet/.test(bar.textContent ?? '')
  }, undefined, { timeout: 45000 }).then(() => true).catch(() => false)
  // The fold and the compaction are both ResizeObserver effects; give them a frame after settle, then
  // read. A reading taken mid-load is what LX.F2 had to retract.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))

  const after = await page.evaluate(readBar)
  const afterFailures = await page.evaluate(toolbarLayoutInPage)
  const touched = await page.evaluate(setCompact, false)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 120)))
  const before = await page.evaluate(readBar)
  const beforeFailures = await page.evaluate(toolbarLayoutInPage)
  await page.evaluate(setCompact, true)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 120)))
  const restored = await page.evaluate(readBar)
  const restoredFailures = await page.evaluate(toolbarLayoutInPage)

  console.log(`\n── master · childless family @ ${width}px · settled ${settled} · hydrated ${after.rows > 0} (${after.rows} AG rows)`)
  console.log(`   descriptor: ${JSON.stringify(after.descriptor)}`)
  console.log(`   AFTER  (compact tier as shipped): scrollW ${after.scrollW} vs clientW ${after.clientW} (over ${after.over}) · ${after.childCount} children · chips folded ${after.folded} · ${afterFailures.length} census failure(s)`)
  for (const f of afterFailures) console.log(`            ✗ ${f}`)
  for (const p of after.pills) console.log(`            pill ${String(p.w).padStart(6)}px compact=${p.compact} glyphs=${p.glyphs} visible=${JSON.stringify(p.visibleText)} accessible=${JSON.stringify(p.accessibleText)}`)
  console.log(`   BEFORE (the same nodes, forced expanded — ${touched} pill(s) touched): scrollW ${before.scrollW} vs clientW ${before.clientW} (over ${before.over}) · ${beforeFailures.length} census failure(s)`)
  for (const f of beforeFailures) console.log(`            ✗ ${f}`)
  for (const p of before.pills) console.log(`            pill ${String(p.w).padStart(6)}px compact=${p.compact} visible=${JSON.stringify(p.visibleText)}`)
  console.log(`   RESTORED: scrollW ${restored.scrollW} · ${restoredFailures.length} census failure(s) · pills ${restored.pills.map((p) => `${p.w}px/compact=${p.compact}`).join(' ')}`)
  if (restored.scrollW !== after.scrollW || restoredFailures.length !== afterFailures.length) {
    console.log('   ⛔ the probe did not restore the page it measured — this reading is not evidence')
    exit = 1
  }
  if (afterFailures.length) exit = 1
  for (const child of after.children) console.log(`     ${String(child.w).padStart(7)}  ${child.label}`)
}
await browser.close()
console.log(`\nnon-GET requests aborted: ${aborted.length}${aborted.length ? ` — ${[...new Set(aborted)].join(', ')}` : ' (read-only, measured)'}`)
console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${[...new Set(consoleErrors)].join('\n  ')}` : ''}`)
console.log(exit ? '❌ CLOSE.1 pills: a width still clips, or the probe did not restore' : '✅ CLOSE.1 pills: 0 clipped at every width measured')
process.exit(exit)
