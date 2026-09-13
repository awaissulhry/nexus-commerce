#!/usr/bin/env node
/**
 * CLOSE.1 — R-VT-15 (a refused commit SAYS the server's sentence) and R-VT-16 (the warning cell's
 * text colour and its triangle) witnessed on the real studio sheet.
 *
 *   node scripts/studio-gate-session.mjs -- node scripts/_close1-refusal.mjs
 *
 * ## R-VT-15 — how the refusal is made to happen, and why it is honest
 *
 * The refusal is injected AT THE NETWORK LAYER: `PATCH /api/products/bulk` is fulfilled by the probe
 * with `400 {"error": "<a distinctive sentence>"}`, so **nothing is written to any database** and the
 * sentence the UI must show is known exactly, character for character. That is the claim under test —
 * *"the server said no and its sentence reaches the operator"* — and stubbing the server is the only
 * way to state the expected string in advance (`reference_predict_before_you_write`).
 *
 * The arm that must NOT fire is in the same run: the same edit with the same route fulfilled
 * `200 {"updated":1}` must produce NO new toast. Without it, "the sentence appeared" is consistent
 * with a toast that appears on every commit.
 *
 * Then the route is UNROUTED and no further edit is made, so the page is left with nothing pending.
 *
 * ## R-VT-16 — a CSS-resolution reading, said plainly
 *
 * A live `Set axes…` / `Choose a theme` cell needs a family with no axes or a coordinate with no
 * theme; VT.F2's disposable families that had them are deleted, so rather than claim a sighting the
 * probe INJECTS the renderer's exact markup into the real sheet, reads the computed colour through the
 * page's real token cascade in both themes, removes it, and reports it as what it is. The renderer's
 * own output (an `<svg>`, never the `⚠` glyph) is asserted by `variationTheme.vitest.test.ts` (21
 * tests) and, when the page happens to hold a real instance, read from that instance too.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = process.env.CENSUS_BASE ?? process.env.EDITOR_BASE ?? 'http://localhost:3000'
const PRODUCT = process.env.CLOSE1_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const SENTENCE = 'CLOSE.1 probe: this cell was refused by the server, with this sentence.'

const toastsInPage = () => [...document.querySelectorAll('.nds-toast')].map((el) => ({
  text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  cls: el.className,
}))

/** The DS's own proof that the provider is live: it portals this host into `document.body`. */
const providerInPage = () => ({
  dsProvider: !!document.querySelector('.nds-toasts'),
  fallbackHost: !!document.querySelector('.nds-toast-fallback, .nds-toasts-fallback'),
})

let exit = 0
const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 906 } })
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })

/*
 * Every write except the one this probe stubs is blocked, and counted.
 *
 * 🔴 ONE exception, measured the hard way: `POST /api/pim/formulas/batch` is a READ wearing POST's
 * clothes (`cell-formula.routes.ts:164` — it validates `productIds` and `reply.send`s
 * `cellFormulasForProducts`, writing nothing). Aborting it made `useCellFormulas` never become ready,
 * and EVERY cell editor on the sheet then rendered `FormulaUnavailableEditor` — a popup with `Retry`
 * and `Close`, no input, and `isCancelAfterEnd: () => true`. Two runs of this probe reported
 * "editor opened: true, 0 write requests" and the editor that opened was the probe's own doing
 * (`reference_probe_safety_is_not_a_loan_from_the_page`: ask what the probe DOES). The read is allowed
 * through by PATH, and the allowance is stated here rather than widened to "POSTs are fine".
 */
const READ_SHAPED_POSTS = new Set(['/api/pim/formulas/batch'])
const blocked = []
const allowed = []
await page.route('**/*', (route) => {
  const request = route.request()
  const method = request.method()
  const path = new URL(request.url()).pathname
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue()
  if (path === '/api/products/bulk') return route.fallback()
  if (method === 'POST' && READ_SHAPED_POSTS.has(path)) { allowed.push(`${method} ${path}`); return route.continue() }
  blocked.push(`${method} ${path}`)
  return route.abort()
})

let mode = 'refuse'
const seen = []
await page.route('**/api/products/bulk', async (route) => {
  seen.push({ mode, body: route.request().postData()?.slice(0, 300) ?? null })
  if (mode === 'refuse') {
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: SENTENCE }) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ updated: 1, errors: [] }) })
})

await page.goto(`${BASE}/products/${PRODUCT}/edit/studio`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.nds-grid-sheet .ag-row', { timeout: 45000 })
await page.waitForFunction(() => {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  return !!bar && !/Loading information/.test(bar.textContent ?? '')
}, undefined, { timeout: 45000 }).catch(() => {})
await page.evaluate(() => new Promise((r) => setTimeout(r, 600)))
console.log(`toast provider: ${JSON.stringify(await page.evaluate(providerInPage))}`)

/**
 * Commit ONE cell and say exactly what happened.
 *
 * 🔴 The first version of this probe reported `editor opened: true` and **0 write requests**, which is
 * a "could not measure", not a "measured empty" (`reference_could_not_measure_vs_measured_empty`). An
 * editor opening is not a commit: a long-text cell opens a POPUP whose textarea takes Enter as a
 * newline, and AG discards an edit it judges untouched. So this now names the editing cell, the editor
 * element, the value before and after, and whether a request actually left — and it tries candidate
 * columns until one of them really commits, reporting every attempt either way.
 */
const commitOne = async (colId, text) => {
  // Leave whatever the previous attempt opened, and land the focus somewhere neutral first: the
  // second attempt of run 2 opened no editor at all because a popup from the first was still owning
  // the keyboard (`reference_ag_popup_editor_owns_keys`).
  await page.keyboard.press('Escape').catch(() => {})
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)))
  const cell = page.locator(`.nds-grid-sheet .ag-row[row-index="0"] [col-id="${colId}"]`).first()
  const box = await cell.boundingBox().catch(() => null)
  if (!box || box.width < 8) return { colId, opened: false, why: 'no visible cell' }
  const wasRequests = seen.length
  await page.mouse.click(box.x + Math.min(box.width * 0.4, 40), box.y + box.height * 0.5)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 120)))
  await page.mouse.dblclick(box.x + Math.min(box.width * 0.4, 40), box.y + box.height * 0.5)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 350)))
  /* WHAT opened, and what it offers — an inline editor takes Enter, a popup does not
     (`reference_ag_popup_editor_owns_keys`: AG owns Enter/Tab/Esc inside a popup), so the affordances
     are read rather than assumed. */
  const editor = await page.evaluate(() => {
    const popup = document.querySelector('.ag-popup-editor')
    const inline = document.querySelector('.ag-cell-inline-editing')
    const host = popup ?? inline
    if (!host) return { open: false, focus: document.activeElement?.tagName.toLowerCase() ?? null }
    return {
      open: true,
      kind: popup ? 'popup' : 'inline',
      fields: [...host.querySelectorAll('input,textarea')].map((f) => `${f.tagName.toLowerCase()}[${f.type ?? ''}]`),
      buttons: [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() || (b.getAttribute('aria-label') ?? '?')).slice(0, 8),
      focus: document.activeElement?.tagName.toLowerCase() ?? null,
    }
  })
  if (!editor.open) return { colId, opened: false, why: 'the editor did not open', editor }
  /* Type INTO the field, not at whatever has focus: run 2 measured `activeElement` = `div.ag-cell`
     with a popup open, so every keystroke went to the grid and the edit never changed a value. */
  const field = page.locator('.ag-popup-editor textarea, .ag-popup-editor input, .ag-cell-inline-editing textarea, .ag-cell-inline-editing input').first()
  const filled = await field.fill(text, { timeout: 4000 }).then(() => true).catch(() => false)
  const value = await field.inputValue().catch(() => null)
  /* Commit by the affordance this editor actually has, in order: its own save verb, then Enter for an
     inline editor, then a click on a NEIGHBOURING cell (blur) — which is itself a write path
     (`reference_endpoint_safety_is_not_interaction_safety`). */
  const saveVerb = page.locator('.ag-popup-editor button', { hasText: /^(save|apply|done|ok|update)$/i }).first()
  let how = 'none'
  if (await saveVerb.count().then((n) => n > 0).catch(() => false)) { await saveVerb.click().catch(() => {}); how = 'save button' }
  else if (editor.kind === 'inline') { await page.keyboard.press('Enter'); how = 'Enter (inline)' }
  else { await page.keyboard.press('Tab'); how = 'Tab (popup)' }
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1400)))
  if (seen.length === wasRequests) {
    // Still nothing: blur by clicking a different cell in the same row.
    const other = page.locator('.nds-grid-sheet .ag-row[row-index="0"] .ag-cell').nth(1)
    const ob = await other.boundingBox().catch(() => null)
    if (ob) { await page.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2); how += ' + blur click' }
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1800)))
  }
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)))
  return { colId, opened: true, editor, filled, value, how, requests: seen.length - wasRequests }
}

/** Candidate columns, DERIVED from the row on screen — never a remembered list of column keys. */
const candidates = await page.evaluate(() => [...document.querySelectorAll('.nds-grid-sheet .ag-row[row-index="0"] .ag-cell')]
  .map((c) => c.getAttribute('col-id'))
  .filter((id) => id && !['ag-Grid-AutoColumn', 'ag-Grid-SelectionColumn', 'sku', 'select', 'actions', 'variation_theme', 'productMedia'].includes(id)
    && !id.startsWith('__')))
console.log(`candidate columns on row 0: ${candidates.join(', ')}`)

const editCell = async (_colId, text) => {
  const attempts = []
  for (const candidate of candidates.slice(0, 8)) {
    const attempt = await commitOne(candidate, text)
    attempts.push(attempt)
    if (attempt.requests > 0) return { opened: true, attempts, colId: candidate }
  }
  return { opened: false, attempts, why: 'no candidate column produced a write request' }
}

/* ── ARM 1: the server refuses ─────────────────────────────────────────────────────────────── */
const before = await page.evaluate(toastsInPage)
const edit1 = await editCell('name', `CLOSE1 ${Date.now()}`)
const after1 = await page.evaluate(toastsInPage)
const fresh1 = after1.filter((t) => !before.some((b) => b.text === t.text && b.cls === t.cls))
console.log(`\n── ARM 1 (route fulfilled 400): editor ${JSON.stringify(edit1)} · requests to /api/products/bulk ${seen.length}`)
console.log(`   toasts before ${before.length} → after ${after1.length}; new: ${JSON.stringify(fresh1)}`)
const verbatim = fresh1.some((t) => t.text === SENTENCE)
const tone = fresh1.find((t) => t.text === SENTENCE)?.cls ?? '(none)'
console.log(`   the server's sentence, VERBATIM, on screen: ${verbatim} · tone class: ${tone}`)
if (!verbatim) exit = 1

/* ── ARM 2: the same edit, accepted — nothing new may appear ───────────────────────────────── */
mode = 'accept'
/* 🔴 The toasts are NOT cleared by hand. Removing a node the DS ToastProvider RENDERED made React's
   own later removal throw `NotFoundError: Failed to execute 'removeChild'` twice per run — the probe
   manufacturing two of the console errors whose count it reports. ARM 1's toast has a 4 s life and
   this arm takes longer than that; either way the comparison is a DIFF against the snapshot, which is
   what ARM 1 already does. */
const beforeArm2 = await page.evaluate(toastsInPage)
const edit2 = await editCell('name', `CLOSE1 ${Date.now()}`)
const after2 = (await page.evaluate(toastsInPage)).filter((t) => !beforeArm2.some((b) => b.text === t.text && b.cls === t.cls))
console.log(`\n── ARM 2 (route fulfilled 200): editor ${JSON.stringify(edit2)} · requests total ${seen.length}`)
console.log(`   toasts after a SUCCESSFUL commit: ${after2.length} → ${JSON.stringify(after2)}`)
if (!edit2.opened) { console.log('   ⛔ the control could not be exercised — this arm proves nothing'); exit = 1 }
if (after2.length !== 0) { console.log('   ⛔ a successful commit said something'); exit = 1 }
await page.unroute('**/api/products/bulk')

/* ── R-VT-16: the warning colour, through the page's real cascade, in both themes ──────────── */
const readWarning = () => {
  /* `document.body`, NOT the sheet: appending into a container REACT owns made React's next
     reconciliation throw `NotFoundError: Failed to execute 'removeChild'` — twice, in a run whose
     console-error count is itself a claim. The tokens live on `:root`/`.dark`, so the cascade that
     decides this colour is identical here, and the node is positioned out of the way so it cannot
     touch layout. */
  const host = document.body
  const probe = document.createElement('span')
  probe.id = '_close1_vt16'
  probe.style.position = 'absolute'
  probe.style.left = '-9999px'
  probe.style.top = '0'
  probe.className = 'nds-cell-value nds-axes-cell'
  probe.innerHTML = '<span class="nds-axes-warn"><svg width="12" height="12"></svg></span><span class="nds-cell-value-text nds-axes-unset-required">Choose a theme</span>'
  host.appendChild(probe)
  const text = getComputedStyle(probe.querySelector('.nds-axes-unset-required')).color
  const triangle = getComputedStyle(probe.querySelector('.nds-axes-warn')).color
  probe.remove()
  const live = document.querySelector('.nds-axes-unset-required')
  return {
    text, triangle,
    removed: !document.getElementById('_close1_vt16'),
    dark: document.documentElement.classList.contains('dark'),
    liveInstance: live ? { color: getComputedStyle(live).color, svgs: live.parentElement?.querySelectorAll('svg').length ?? 0 } : null,
  }
}
const light = await page.evaluate(readWarning)
await page.emulateMedia({ colorScheme: 'dark' })
await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
const dark = await page.evaluate(readWarning)
await page.emulateMedia({ colorScheme: 'light' })
console.log(`\n── R-VT-16 · light: text ${light.text} · triangle ${light.triangle} · probe removed ${light.removed} · .dark ${light.dark} · live instance ${JSON.stringify(light.liveInstance)}`)
console.log(`   dark: text ${dark.text} · triangle ${dark.triangle} · probe removed ${dark.removed} · .dark ${dark.dark}`)
if (light.text !== 'rgb(109, 63, 16)') { console.log('   ⛔ light text is not #6d3f10 (--nds-warning-text)'); exit = 1 }
if (!light.removed || !dark.removed) { console.log('   ⛔ the probe node was left in the page'); exit = 1 }

await browser.close()
console.log(`\nnon-GET requests blocked (everything except the stubbed bulk PATCH): ${blocked.length}${blocked.length ? ` — ${[...new Set(blocked)].join(', ')}` : ''}`)
console.log(`read-shaped POSTs allowed through: ${allowed.length}${allowed.length ? ` — ${[...new Set(allowed)].join(', ')}` : ''}`)
console.log(`bulk PATCHes stubbed: ${seen.length} — ${seen.map((s) => s.mode).join(', ')}`)
console.log(`console errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${[...new Set(consoleErrors)].join('\n  ')}` : ''}`)
console.log(exit ? '❌ CLOSE.1 refusal/warning reading: an arm failed' : '✅ CLOSE.1: the refusal sentence is on screen verbatim, a success says nothing, and the warning text is #6d3f10')
process.exit(exit)
