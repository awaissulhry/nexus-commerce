/**
 * VT.F2 — the FOUR readings VT.F handed over unwitnessed, on screen, at 1440×900, through the R-GATE-1 wrapper:
 *
 *   node scripts/studio-gate-session.mjs -- node scripts/_vtf2-screens.mjs
 *
 *   (a) `Set axes…`        — a family with children and NO axes, on MASTER            (VTF2-TEST-NOAX)
 *   (b) `Choose a theme`   — an Amazon coordinate whose PT enum matches no axis set   (VTF2-TEST-3AX AMAZON·DE)
 *   (c) `⚠ 1 dropped`      — the 3-axis family under a 2-segment Amazon theme         (VTF2-TEST-3AX AMAZON·IT)
 *   (d) R-VT-8             — a REAL MOUSE re-point on a target Listbox INSIDE the AG popup (EBAY·IT, unlocked)
 *
 * (a)–(c) are READ-ONLY. (d) is a deliberate write on my own disposable fixture, captured and read back.
 * Every number is a DOM / computed-style measurement, compared against the canvas `CellStates` artboard.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = 'http://localhost:3000'
const F3 = 'cmtzoenko0000nju8dbbrx22h'
const FN = 'cmtzoenm10013nju88dyn57yq'
const AMZ = 'cmothu9bo0000nz01asw6wx8j'
const EBAY = 'cmr4aaqb00025nz016k18rup9'
const out = (o) => console.log(JSON.stringify(o, null, 1))
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })
const errors = []
const mutations = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(clean(m.text()).slice(0, 220)) })
page.on('request', (r) => { if (['PATCH', 'PUT', 'POST', 'DELETE'].includes(r.method())) mutations.push(`${r.method()} ${new URL(r.url()).pathname}`) })

const goto = async (id, params) => {
  await page.goto(`${BASE}/products/${id}/edit/studio?${params}`, { waitUntil: 'domcontentloaded' })
  try { await page.waitForSelector('[col-id="variation_theme"]', { timeout: 45_000 }) } catch { return false }
  await page.waitForTimeout(1200)
  return true
}

/** The cell's own numbers, taken from the FIRST body row, plus a positive control that the grid is real. */
const readCell = async () => await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const cs = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : null)
  const cell = document.querySelector('.ag-row[row-index="0"] [col-id="variation_theme"]')
  if (!cell) return { measured: false, reason: 'no variation_theme cell in row 0' }
  const box = cell.getBoundingClientRect()
  const tag = cell.querySelector('.nds-tag, [class*="tag"]')
  const svg = cell.querySelector('svg')
  const textSpans = [...cell.querySelectorAll('span')].filter((s) => t(s).length > 0 && !s.querySelector('span'))
  return {
    measured: true,
    text: t(cell),
    width: Math.round(box.width), height: Math.round(box.height),
    cellFont: `${cs(cell, 'font-size')} ${cs(cell, 'font-weight')}`,
    cellPad: `${cs(cell, 'padding-left')}/${cs(cell, 'padding-right')}`,
    spans: textSpans.slice(0, 4).map((s) => ({ text: t(s), color: cs(s, 'color'), weight: cs(s, 'font-weight'), size: cs(s, 'font-size') })),
    tag: tag ? { text: t(tag), size: cs(tag, 'font-size'), weight: cs(tag, 'font-weight'), radius: cs(tag, 'border-radius'), pad: `${cs(tag, 'padding-top')} ${cs(tag, 'padding-left')}`, bg: cs(tag, 'background-color'), color: cs(tag, 'color') } : null,
    glyph: svg ? { w: svg.getAttribute('width'), h: svg.getAttribute('height'), stroke: svg.getAttribute('stroke'), color: cs(svg, 'color') } : null,
    title: (cell.getAttribute('title') ?? cell.querySelector('[title]')?.getAttribute('title') ?? '').slice(0, 160),
    rowsInGrid: document.querySelectorAll('.ag-row[row-id]').length,          // positive control: the grid has rows
    headerText: (document.querySelector('.ag-header-cell[col-id="variation_theme"]')?.textContent ?? '').trim(),
  }
})

// ── (a) `Set axes…` on master ────────────────────────────────────────────────────────────────────
if (await goto(FN, 'tab=sheet&scope=master&market=IT&locale=it')) out({ reading: 'a · Set axes… · VTF2-TEST-NOAX master', ...(await readCell()) })
else out({ reading: 'a', measured: false, reason: 'sheet did not render a variation_theme column' })

// ── (b) `Choose a theme` on Amazon·DE ───────────────────────────────────────────────────────────
if (await goto(F3, `tab=sheet&scope=AMAZON&market=DE&locale=de&account=${AMZ}`)) out({ reading: 'b · Choose a theme · VTF2-TEST-3AX AMAZON·DE', ...(await readCell()) })
else out({ reading: 'b', measured: false, reason: 'sheet did not render' })

// ── (c) `⚠ 1 dropped` on Amazon·IT ──────────────────────────────────────────────────────────────
if (await goto(F3, `tab=sheet&scope=AMAZON&market=IT&locale=it&account=${AMZ}`)) out({ reading: 'c · ⚠ 1 dropped · VTF2-TEST-3AX AMAZON·IT', ...(await readCell()) })
else out({ reading: 'c', measured: false, reason: 'sheet did not render' })

// ── (d) R-VT-8 · a real mouse re-point INSIDE the AG popup, on eBay·IT ──────────────────────────
if (await goto(F3, `tab=sheet&scope=EBAY&market=IT&locale=it&account=${EBAY}`)) {
  out({ reading: 'd · the cell before the edit', ...(await readCell()) })
  const cell = await page.$('.ag-row[row-index="0"] [col-id="variation_theme"]')
  await cell.dblclick()
  await page.waitForTimeout(900)
  const editorOpen = async () => await page.evaluate(() => !!document.querySelector('.nds-axes-editor'))
  out({ reading: 'd · editor opened', open: await editorOpen(), anatomy: await page.evaluate(() => {
    const el = document.querySelector('.nds-axes-editor')
    if (!el) return null
    const t = (n) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim()
    return {
      box: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(el.getBoundingClientRect()),
      head: t(el.querySelector('.nds-axes-head')).slice(0, 80),
      source: t(el.querySelector('.nds-axes-source')).slice(0, 90),
      rows: [...el.querySelectorAll('.nds-axes-row')].map((r) => t(r).slice(0, 60)),
      listboxes: [...el.querySelectorAll('.nds-listbox-btn')].map((b) => ({ text: t(b), disabled: b.disabled, aria: (b.getAttribute('aria-label') ?? '').slice(0, 90) })),
      insideAgPopup: !!document.querySelector('.ag-popup-editor .nds-axes-editor, .ag-popup .nds-axes-editor'),
    }
  }) })

  // The FIRST enabled target Listbox in the panel. Enabled is the whole point: VT.F could not find one.
  const trigger = await page.$('.nds-axes-editor .nds-listbox-btn:not([disabled])')
  if (!trigger) out({ reading: 'd', measured: false, reason: 'no ENABLED target Listbox in the panel — the arm cannot run' })
  else {
    const before = await page.evaluate(() => (document.querySelector('.nds-axes-editor .nds-listbox-btn:not([disabled])')?.textContent ?? '').trim())
    await trigger.click()                       // a real mouse click on the trigger
    await page.waitForTimeout(500)
    const panel = await page.evaluate(() => {
      const pop = document.querySelector('.nds-listbox-pop')
      if (!pop) return { open: false }
      const inEditor = !!document.querySelector('.nds-axes-editor .nds-listbox-pop')
      const inAg = !!pop.closest('.ag-popup-editor, .ag-popup')
      return { open: true, inEditor, inAg, parent: pop.parentElement?.className ?? null,
        options: [...pop.querySelectorAll('[role="option"]')].map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 10) }
    })
    out({ reading: 'd · the option panel', triggerTextBefore: before, ...panel })

    // 🔴 THE ARM: a REAL MOUSE CLICK on an option that is NOT the current value. Before R-VT-8's portal
    // this click landed outside the AG popup, AG ended the edit, and `onValueChange` never reported.
    /**
     * 🔴 My first run picked the first option whose text differed from the current value, and that was the
     * Listbox's own CLEAR row (`Choose a specific`): the re-point became a CLEAR, the commit carried
     * `target: null` for two axes and the route refused it with 400 — which measured the portal property
     * correctly but is not a re-POINT. The option is now chosen by exclusion: not the clear row, not a target
     * already taken by another axis (`reference_control_must_target_the_branch`).
     */
    const target = await page.evaluateHandle(({ currentText, taken }) => {
      const pop = document.querySelector('.nds-listbox-pop')
      const opts = [...(pop?.querySelectorAll('[role="option"]') ?? [])]
      const label = (o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim()
      return opts.find((o) => label(o) && label(o) !== currentText && !/^Choose /.test(label(o)) && !taken.includes(label(o))) ?? null
    }, { currentText: before, taken: await page.evaluate(() => [...document.querySelectorAll('.nds-axes-editor .nds-listbox-btn')].map((b) => (b.textContent ?? '').trim())) })
    const el = target.asElement()
    const chosen = el ? clean(await el.textContent()) : null
    const boxBefore = el ? await el.boundingBox() : null
    if (el && boxBefore) await page.mouse.click(boxBefore.x + boxBefore.width / 2, boxBefore.y + boxBefore.height / 2)
    await page.waitForTimeout(700)
    out({ reading: 'd · AFTER the mouse click on the option', chosen, clickedAt: boxBefore ? { x: Math.round(boxBefore.x), y: Math.round(boxBefore.y) } : null,
      editorStillOpen: await editorOpen(),
      triggerTextAfter: await page.evaluate(() => (document.querySelector('.nds-axes-editor .nds-listbox-btn')?.textContent ?? '').trim()),
      rows: await page.evaluate(() => [...document.querySelectorAll('.nds-axes-editor .nds-axes-row')].map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60))),
      foot: await page.evaluate(() => (document.querySelector('.nds-axes-foot')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)),
      mutationsSoFar: [...mutations] })

    // Enter commits what the editor last reported. The PATCH is the witness.
    const patched = []
    page.on('request', (r) => { if (r.method() === 'PATCH') patched.push({ path: new URL(r.url()).pathname, body: (r.postData() ?? '').slice(0, 400) }) })
    page.on('response', async (r) => { if (r.request().method() === 'PATCH') patched.push({ status: r.status(), body: (await r.text().catch(() => '')).slice(0, 260) }) })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)
    out({ reading: 'd · AFTER Enter', editorStillOpen: await editorOpen(), cell: await readCell(), patched,
      // A refused write must SAY so on screen, not only in the console: capture whatever the page shows.
      onScreen: await page.evaluate(() => [...document.querySelectorAll('.nds-toast, [role="status"], [role="alert"], .nds-banner')].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)) })
    await page.waitForTimeout(8000)
    out({ reading: 'd · the cell 8s after the commit (the read-back)', cell: await readCell() })
  }
}

out({ consoleErrors: errors.length, errors: errors.slice(0, 6), allMutations: mutations })
await browser.close()
