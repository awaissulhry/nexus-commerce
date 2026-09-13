/**
 * VT.F — the screen readings the final report's section C needs and the wire cannot give.
 *
 * Run ONLY through the gate wrapper, alone:
 *   node scripts/studio-gate-session.mjs -- node scripts/_vtf-screens.mjs
 *
 * READ-ONLY on the web except ONE deliberate arm (A3's mouse re-point on the FIXTURE, restored in the same
 * pass): every PATCH/PUT/DELETE is captured and printed, so a silent write cannot hide.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = process.env.EDITOR_BASE ?? 'http://localhost:3000'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const FIXTURE = 'cmtzci5kf0000njr9f8yhrsxm'
const AMZ = 'cmothu9bo0000nz01asw6wx8j', EBY = 'cmr4aaqb00025nz016k18rup9', SHP = 'cmtugfpaa0006njhq8m2nvnxx'

/* 🔴 The studio's URL spells the scope as `?scope=<CHANNEL>`, NOT `?scope=channel&channel=<CHANNEL>` — that is
   the API's spelling. Read off `scripts/check-editor-open.mjs:1327` rather than guessed: my first run used the
   API form and every channel scope rendered NO grid at all (`ids: []`), which is the "could not measure"
   reading that looks exactly like "the column is missing on every channel scope". */
const SCOPES = [
  { key: 'master',    url: (id) => `/products/${id}/edit/studio?market=IT&locale=it` },
  { key: 'amazon·IT', url: (id) => `/products/${id}/edit/studio?scope=AMAZON&market=IT&locale=it&accountId=${AMZ}` },
  { key: 'amazon·DE', url: (id) => `/products/${id}/edit/studio?scope=AMAZON&market=DE&locale=de&accountId=${AMZ}` },
  { key: 'ebay·IT',   url: (id) => `/products/${id}/edit/studio?scope=EBAY&market=IT&locale=it&accountId=${EBY}` },
  { key: 'shopify',   url: (id) => `/products/${id}/edit/studio?scope=SHOPIFY&market=GLOBAL&locale=en&accountId=${SHP}` },
]
/** Wait for ROWS, never a fixed sleep: an empty grid and a slow grid are the same picture. */
const rowsAppeared = async (page) =>
  page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: 45000 })
    .then(() => true).catch(() => false)

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })

const errors = []
const writes = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('request', (r) => { if (['PATCH', 'PUT', 'DELETE', 'POST'].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })

/* POSITIVE CONTROL for the console listener: an error raised on purpose, so "0 errors" is a reading and not a
   dead listener (`reference_could_not_measure_vs_measured_empty`). */
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => { console.error('[VT.F positive control] the console listener is attached') })
const controlFired = errors.some((e) => e.includes('VT.F positive control'))
console.log(`CONSOLE LISTENER positive control fired: ${controlFired}`)
errors.length = 0

const chrome = async () => page.evaluate(() => {
  const h = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : null }
  return {
    appHeader: h('header, [class*="app-header"]'),
    scopeBar: h('[class*="scope"][class*="bar"], [class*="scopebar"]'),
    toolbar: h('[class*="sheet-toolbar"], [class*="SheetToolbar"], [class*="toolbar"]'),
    rowH: (() => { const r = document.querySelector('.ag-row'); return r ? Math.round(r.getBoundingClientRect().height) : null })(),
    headerH: (() => { const r = document.querySelector('.ag-header-row'); return r ? Math.round(r.getBoundingClientRect().height) : null })(),
  }
})

const themeCell = async () => page.evaluate(() => {
  const head = document.querySelector('.ag-header-cell[col-id="variation_theme"]')
  const cell = document.querySelector('.ag-row[row-index="0"] .ag-cell[col-id="variation_theme"]')
  const child = [...document.querySelectorAll('.ag-row')].map((r) => r.querySelector('.ag-cell[col-id="variation_theme"]')).filter(Boolean)[1]
  const ids = [...document.querySelectorAll('.ag-header-cell[col-id]')].map((x) => x.getAttribute('col-id'))
  if (!head || !cell) return { rendered: false, ids: ids.slice(0, 6) }
  const marks = [...cell.querySelectorAll('[class*="provenance"], .nds-tag, svg')].map((n) => (n.className || '').toString().split(' ')[0] || n.tagName)
  return {
    rendered: true,
    header: head.querySelector('.ag-header-cell-text')?.textContent?.trim() ?? null,
    width: Math.round(head.getBoundingClientRect().width),
    position: ids.filter((k) => !k.startsWith('ag-Grid-') && !['productMedia', '__productRole', '__parentSku'].includes(k))[0],
    text: cell.innerText.replace(/\s+/g, ' ').trim(),
    childText: child ? child.innerText.replace(/\s+/g, ' ').trim() : null,
    childTitle: child ? (child.querySelector('[title]')?.getAttribute('title') ?? child.getAttribute('title')) : null,
    usesEngineCell: !!cell.querySelector('.nds-axes-cell'),
    fillHandleSuppressed: !cell.querySelector('.ag-fill-handle'),
    marks: [...new Set(marks)].join(' '),
  }
})

const ONLY = process.env.VTF_ONLY ?? ''
for (const [label, id] of ONLY && ONLY !== 'scopes' ? [] : [['GALE', GALE], ['VX-TEST-3AX', FIXTURE]]) {
  for (const sc of SCOPES) {
    await page.goto(`${BASE}${sc.url(id)}`, { waitUntil: 'domcontentloaded' })
    const ok = await rowsAppeared(page)
    console.log(`\n── ${label} · ${sc.key}${ok ? '' : '  🔴 NOT MEASURED — no rows rendered in 45s'}`)
    if (!ok) continue
    await page.waitForTimeout(2500)
    const c = await chrome(); const t = await themeCell()
    console.log(`   chrome ${JSON.stringify(c)}`)
    console.log(`   cell   ${JSON.stringify(t)}`)
  }
}

/* ── The EDITOR, opened on the real sheet: anatomy + A3's mouse re-point ──────────────────── */
console.log('\n── EDITOR anatomy + A3 mouse re-point, on GALE eBay·IT (READ ONLY: Esc discards)')
await page.goto(`${BASE}${SCOPES[3].url(GALE)}`, { waitUntil: 'domcontentloaded' })
const editorRows = await rowsAppeared(page)
if (!editorRows) console.log('   🔴 NOT MEASURED — eBay·IT rendered no rows')
await page.waitForTimeout(2500)
const cellBox = editorRows ? await page.locator('.ag-row[row-index="0"] .ag-cell[col-id="variation_theme"]').boundingBox().catch(() => null) : null
if (!cellBox) console.log('   NOT MEASURED — no variation_theme cell on this scope')
else {
  /* 🔴 DBLCLICK, at 40% of the cell's width — NOT a single click and NOT the corner. The shared open
     gesture is AG's `dblclick` (`openGesture.ts`), and the corner is the fill handle, which swallows it
     (`reference_ag_fill_handle_swallows_dblclick`). My first run single-clicked and read `panel: {open:false}`,
     which looks exactly like "the editor does not open on this scope" — the wrong-gesture flavour of
     `reference_could_not_measure_vs_measured_empty`. */
  await page.mouse.dblclick(cellBox.x + Math.min(cellBox.width * 0.4, 40), cellBox.y + cellBox.height / 2)
  await page.waitForTimeout(1800)
  const panel = await page.evaluate(() => {
    const p = document.querySelector('.nds-axes-editor')
    if (!p) return { open: false }
    const r = p.getBoundingClientRect()
    const inPopup = !!p.closest('.ag-popup-editor, .ag-popup')
    return {
      open: true, width: Math.round(r.width), height: Math.round(r.height), inPopup,
      lines: p.innerText.split('\n').map((l) => l.trim()).filter(Boolean),
      listboxes: p.querySelectorAll('.nds-listbox').length,
      rows: p.querySelectorAll('.nds-axes-row').length,
    }
  })
  console.log(`   panel ${JSON.stringify(panel)}`)
  /* 🔴 A3's mouse re-point needs an ENABLED Listbox. On this catalogue every eBay·IT axis is PUBLISHED, so
     every Listbox is correctly disabled with the lock's own sentence — which is A5 working, and is reported as
     the reading it is rather than skipped silently. */
  const listboxState = panel.open ? await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.nds-axes-editor .nds-listbox .nds-listbox-btn')]
    return btns.map((b) => ({ disabled: b.hasAttribute('disabled'), aria: (b.getAttribute('aria-label') ?? '').slice(0, 180) }))
  }) : []
  console.log(`   A3 target Listboxes: ${JSON.stringify(listboxState)}`)
  const enabled = listboxState.findIndex((l) => !l.disabled)
  if (enabled === -1 && listboxState.length > 0) {
    console.log('   A3 mouse re-point: 🔴 NOT MEASURED — every target Listbox on this coordinate is DISABLED by the lock (see the aria above). That is A5 working; the re-point needs an unlocked eBay coordinate and this catalogue has none.')
  }
  if (panel.open && enabled >= 0) {
    /* A3: click the first target Listbox's trigger, then click an OPTION with the mouse. The edit must
       SURVIVE — before the portal fix the option panel was a child of <body>, so the click was outside the
       AG popup and the editor closed. */
    await page.locator('.nds-axes-editor .nds-listbox .nds-listbox-btn').nth(enabled).click()
    await page.waitForTimeout(700)
    const openedWhere = await page.evaluate(() => {
      const p = document.querySelector('.nds-listbox-panel, [class*="listbox-panel"], [role="listbox"]')
      if (!p) return { panel: false }
      return { panel: true, inAgPopup: !!p.closest('.ag-popup-editor, .ag-popup'), parent: p.parentElement?.className ?? null, options: p.querySelectorAll('[role="option"], li, button').length }
    })
    console.log(`   A3 option panel ${JSON.stringify(openedWhere)}`)
    const opts = page.locator('.nds-listbox-panel [role="option"], [role="listbox"] [role="option"]')
    const n = await opts.count()
    if (n > 1) {
      await opts.nth(1).click()
      await page.waitForTimeout(900)
      const after = await page.evaluate(() => {
        const p = document.querySelector('.nds-axes-editor')
        return { editorStillOpen: !!p, text: p ? p.innerText.replace(/\s+/g, ' ').slice(0, 200) : null }
      })
      console.log(`   A3 AFTER a mouse re-point: ${JSON.stringify(after)}`)
    } else console.log(`   A3 NOT MEASURED — the option panel rendered ${n} option(s)`)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  console.log(`   editor after Esc: ${await page.evaluate(() => !!document.querySelector('.nds-axes-editor'))} (false = discarded)`)
}

/* ── A12: the URL-layer filter must NARROW, with the banner ───────────────────────────────── */
console.log('\n── A12 · /products/next?filter=variation-mapping:<word>')
const rowsAndBanner = async () => page.evaluate(() => {
  const rows = document.querySelectorAll('.ag-center-cols-container .ag-row').length
  const body = document.body.innerText
  /* BOTH sentences: R-VT-11 replaced the "wider than the filters you set" clause with "No rows can match"
     for an unknown word, and a probe still looking only for the old string reads `banner: null` — a false
     negative from my own instrument, caught by re-running after the copy change. */
  const m = /(No rows can match:[^\n]*)|(Not applied by the server:[^\n]*)/.exec(body)
  const count = /Showing[^\n]*|(\d+)\s+products?/.exec(body)
  return { renderedRows: rows, banner: m ? m[0].slice(0, 240) : null, countLine: count ? count[0].slice(0, 80) : null }
})
for (const f of ONLY === 'editor' ? [] : ['', 'variation-mapping:derived', 'variation-mapping:teleport', 'variation-mapping:collides']) {
  const before = writes.length
  await page.goto(`${BASE}/products/next${f ? `?filter=${encodeURIComponent(f)}` : ''}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  const r = await rowsAndBanner()
  console.log(`   ${(f || '(no filter)').padEnd(34)} ${JSON.stringify(r)}  writes+${writes.length - before}`)
}

console.log(`\nCONSOLE ERRORS (${errors.length}):`)
for (const e of [...new Set(errors)].slice(0, 25)) console.log(`   ${e.slice(0, 220)}`)
console.log(`\nMUTATING REQUESTS CAPTURED (${writes.length}):`)
for (const w of [...new Set(writes)]) console.log(`   ${w}`)
await browser.close()
