/**
 * VT.2c — the three screen readings this lane owes, in ONE signed-in pass.
 *
 * (a) `GALE-JACKET` · eBay·IT · the mapping dock, section 1 measured against spec §4.4 line by line.
 *     READ-ONLY: item 257584954808 is LIVE. The before/after row geometry is recovered IN THE BROWSER
 *     (VP.4's own `.nds-vp-dock-*` rules are still in the stylesheet, so the pre-swap row can be
 *     rendered beside the new one and measured) — never by reverting a shared file (AAA bar #11,
 *     `reference_recover_the_arm_you_cannot_observe`).
 * (b) `VX-TEST-3AX` · Amazon·IT (DRAFT) · a WITNESSED reorder through the dock: the captured PATCH,
 *     an 8 s read-back, then the restore. This is the only write this lane makes.
 * (c) `GALE-JACKET` · eBay·IT · the SHEET cell's locked commit → VT.4's `ThemeChangePlanModal`,
 *     measured against canvas artboard 7. The plan is a dry RUN: the route refuses `dryRun: false`.
 *
 * Every step prints its own positive control, and every PATCH/PUT/DELETE the page issues is captured,
 * so "0 writes" is a reading rather than an assurance.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = 'http://localhost:3000'
const API = process.env.STUDIO_API_BASE ?? 'http://localhost:8091'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const VX = 'cmtzci5kf0000njr9f8yhrsxm'
const EBAY_ACC = 'cmr4aaqb00025nz016k18rup9'
const AMZ_ACC = 'cmothu9bo0000nz01asw6wx8j'
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const want = (step) => ONLY.length === 0 || ONLY.includes(step)

const out = (o) => console.log(JSON.stringify(o, null, 1))
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })
const errors = []
const mutations = []
const posts = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(clean(m.text()).slice(0, 220)) })
page.on('request', (r) => {
  const p = new URL(r.url()).pathname
  if (['PATCH', 'PUT', 'DELETE'].includes(r.method())) mutations.push({ m: r.method(), p, body: (r.postData() ?? '').slice(0, 400) })
  if (r.method() === 'POST') posts.push({ p, body: (r.postData() ?? '').slice(0, 300) })
})
const responses = []
page.on('response', async (r) => {
  const p = new URL(r.url()).pathname
  if (['PATCH', 'PUT', 'POST'].includes(r.request().method()) && p.includes('/studio/')) {
    responses.push({ p, status: r.status(), body: clean(await r.text().catch(() => '')).slice(0, 300) })
  }
})

const goto = async (id, params) => {
  await page.goto(`${BASE}/products/${id}/edit/studio?${params}`, { waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(() => !!document.querySelector('.ag-root, [data-studio-dock]'), { timeout: 120000, polling: 500 })
  } catch {
    out({ step: 'COULD NOT MEASURE', url: page.url(), title: await page.title(), body: (await page.evaluate(() => document.body.innerText)).slice(0, 400), errors: errors.slice(-4) })
    return false
  }
  await page.waitForTimeout(4500)
  /* Hydration first, always: a server-rendered page answers every geometry question wrongly and
     silently (`reference_dev_app_not_hydrating_2026_09_13`). */
  const hydrated = await page.evaluate(() => {
    const el = document.querySelector('.ag-root-wrapper, [data-studio-dock]')
    return !!el && Object.keys(el).some((k) => k.startsWith('__react'))
  })
  out({ step: 'hydration', url: page.url().replace(BASE, ''), hydrated, grids: await page.evaluate(() => document.querySelectorAll('.ag-root-wrapper').length) })
  return hydrated
}

const openDock = async () => {
  const opener = await page.$('button:has-text("Edit mapping")')
  if (!opener) return false
  await opener.click()
  await page.waitForTimeout(2500)
  return !!(await page.$('.nds-vp-dock'))
}

/** Spec §4.4 + §4.4.1, one reading per line of the spec. */
const readDock = async () =>
  await page.evaluate(() => {
    const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const px = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null)
    const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
    const cs = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop) : null)
    const dock = document.querySelector('.nds-vp-dock')
    if (!dock) return { present: false }
    const section = [...dock.querySelectorAll('.nds-vp-dock-section')].find((s) => s.querySelector('#vp-dock-specifics'))
    const panel = section?.querySelector('.nds-axes-editor')
    const rows = [...(panel?.querySelectorAll('.nds-axes-row-dock') ?? [])].map((row) => {
      const li = row.closest('li')
      const listbox = row.querySelector('.nds-listbox button')
      return {
        grip: !!li?.querySelector('.nds-ordered-list-grip'),
        gripDisabled: li?.querySelector('.nds-ordered-list-grip')?.disabled ?? null,
        nameWidth: px(row.querySelector('.nds-axes-dockname')),
        nameText: t(row.querySelector('.nds-axes-dockname')),
        nameFont: cs(row.querySelector('.nds-axes-dockname'), 'font-size'),
        arrow: t(row.querySelector('.nds-axes-arrow')),
        targetWidth: px(row.querySelector('.nds-axes-docktarget')),
        listboxText: t(listbox),
        listboxHeight: h(listbox),
        listboxDisabled: listbox?.disabled ?? null,
        lockTitleOnControl: (row.querySelector('.nds-axes-docktarget')?.getAttribute('title') ?? '').slice(0, 120),
        listboxAria: (listbox?.getAttribute('aria-label') ?? '').slice(0, 140),
      }
    })
    const addBtn = panel?.querySelector('.nds-axes-add button')
    const footer = dock.querySelector('.nds-vp-dock-footer')
    const banner = [...dock.querySelectorAll('.nds-banner')].map((b) => ({ text: t(b).slice(0, 190), tone: b.className }))
    return {
      present: true,
      dockWidth: px(dock),
      trackWidth: px(document.querySelector('[data-studio-dock]')),
      headerHeight: h(dock.querySelector('.nds-vp-dock-header')),
      headerTitle: t(dock.querySelector('.nds-vp-dock-name')),
      headerTitleFont: `${cs(dock.querySelector('.nds-vp-dock-name'), 'font-size')}/${cs(dock.querySelector('.nds-vp-dock-name'), 'font-weight')}`,
      headerSub: t(dock.querySelector('.nds-vp-dock-sub')),
      headerSubFont: cs(dock.querySelector('.nds-vp-dock-sub'), 'font-size'),
      closeBox: (() => { const b = dock.querySelector('.nds-vp-dock-header button'); return b ? `${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}` : null })(),
      sectionTitle: t(section?.querySelector('#vp-dock-specifics')),
      sectionTag: t(section?.querySelector('#vp-dock-specifics .nds-tag')),
      sectionHint: t(section?.querySelector('.nds-vp-dock-hint')),
      sectionHeight: h(section),
      panelPresent: !!panel,
      panelClasses: panel?.className ?? null,
      panelBackground: cs(panel, 'background-color'),
      oldRowsStillRendered: (section?.querySelectorAll('.nds-vp-dock-specific') ?? []).length,
      rows,
      orderNote: t(panel?.querySelector('.nds-axes-ordernote')).slice(0, 190),
      addLabel: t(addBtn),
      addDisabled: addBtn?.disabled ?? null,
      addTitle: (addBtn?.getAttribute('title') ?? '').slice(0, 120),
      addVariant: addBtn?.className ?? null,
      addHint: t(panel?.querySelector('.nds-axes-add .nds-axes-filterhint')).slice(0, 120),
      banner,
      footerButtons: [...(footer?.querySelectorAll('button') ?? [])].map((b) => ({ label: t(b), disabled: b.disabled, variant: b.className })),
      footerState: t(footer?.querySelector('.nds-vp-dock-state')),
      /* The panel must NOT bring the popup's own chrome into a dock section. */
      cellChrome: ['nds-axes-head', 'nds-axes-source', 'nds-axes-foot'].filter((c) => !!panel?.querySelector(`.${c}`)),
      themePickerPresent: !!panel?.querySelector('.nds-axes-group'),
      sections: [...dock.querySelectorAll('.nds-vp-dock-title')].map(t),
    }
  })

/**
 * The pre-swap row, RECONSTRUCTED in the live dock from VP.4's own classes (still in
 * `variants-channel.css`), so the before/after Δ is two measurements in one paint rather than a
 * remembered number. It is removed again immediately; nothing is written anywhere.
 */
const measureOldRow = async () =>
  await page.evaluate(() => {
    const section = [...document.querySelectorAll('.nds-vp-dock-section')].find((s) => s.querySelector('#vp-dock-specifics'))
    if (!section) return null
    const host = section.querySelector('.nds-ordered-list-content') ?? section
    const probe = document.createElement('span')
    probe.className = 'nds-vp-dock-specific'
    probe.innerHTML = '<span class="nds-vp-dock-axis" title="Colore">Colore</span><span class="nds-vp-dock-arrow">→</span><span class="nds-vp-dock-target"><span style="display:block">x</span></span>'
    host.appendChild(probe)
    const r = (sel) => { const el = probe.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : null }
    const cs = (sel, prop) => { const el = probe.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(prop) : null }
    const read = {
      rowWidth: Math.round(probe.getBoundingClientRect().width),
      nameWidth: r('.nds-vp-dock-axis'),
      nameFont: cs('.nds-vp-dock-axis', 'font-size'),
      arrowFont: cs('.nds-vp-dock-arrow', 'font-size'),
      arrowColor: cs('.nds-vp-dock-arrow', 'color'),
      targetWidth: r('.nds-vp-dock-target'),
      gap: getComputedStyle(probe).getPropertyValue('column-gap'),
    }
    probe.remove()
    return read
  })

/** The projection wire for one coordinate, read through the signed-in page. */
const wire = async (id, channel, market, acc) => await page.evaluate(async ({ api, id, channel, market, acc }) => {
  const r = await fetch(`${api}/api/products/${id}/studio/projection?channel=${channel}&market=${market}&accountId=${acc}`, { credentials: 'include' })
  const b = await r.json().catch(() => null)
  return {
    status: r.status,
    version: b?.version ?? null,
    mapping: (b?.mapping ?? []).map((m) => `${m.axisKey}#${m.order}:${m.target ?? '—'}`),
    locked: b?.locked ? { lockedAxisKeys: b.locked.lockedAxisKeys, setChangeIs: b.locked.setChangeIs, orderChangeAllowed: b.locked.orderChangeAllowed, externalId: b.locked.externalId } : null,
    order: b?.order ? { writableHere: b.order.writableHere, hasToken: !!b.order.token, reason: (b.order.reason ?? '').slice(0, 90) } : null,
    axes: (b?.axes ?? []).map((a) => a.key),
    limitAxes: b?.limits?.axes ?? null,
  }
}, { api: API, id, channel, market, acc })

/* ── (a) GALE-JACKET · eBay·IT · the dock ──────────────────────────────────────────────────── */
if (want('a') && (await goto(GALE, `tab=variants&scope=EBAY&market=IT&account=${EBAY_ACC}`))) {
  out({ step: 'a · the WIRE this dock renders', ...(await wire(GALE, 'EBAY', 'IT', EBAY_ACC)) })
  const opened = await openDock()
  out({ step: 'a · GALE eBay·IT dock', opened, ...(await readDock()) })
  out({ step: 'a · the PRE-SWAP row, reconstructed in the browser', before: await measureOldRow() })
  out({ step: 'a · new row, computed style of the shared classes', after: await page.evaluate(() => {
    const row = document.querySelector('.nds-axes-row-dock')
    if (!row) return null
    const cs = (sel, prop) => { const el = row.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue(prop) : null }
    return {
      rowWidth: Math.round(row.getBoundingClientRect().width),
      nameWidth: Math.round(row.querySelector('.nds-axes-dockname')?.getBoundingClientRect().width ?? 0),
      nameFont: cs('.nds-axes-dockname', 'font-size'),
      arrowFont: cs('.nds-axes-arrow', 'font-size'),
      arrowColor: cs('.nds-axes-arrow', 'color'),
      targetWidth: Math.round(row.querySelector('.nds-axes-docktarget')?.getBoundingClientRect().width ?? 0),
      gap: getComputedStyle(row).getPropertyValue('column-gap'),
    }
  }) })
  out({ step: 'a · mutations (must be empty — GALE is read-only)', mutations })
}

/* ── (d) GALE-JACKET · Amazon·IT · a LIVE coordinate whose order cannot be revised ─────────── */
if (want('d') && (await goto(GALE, `tab=variants&scope=AMAZON&market=IT&account=${AMZ_ACC}`))) {
  out({ step: 'd · the WIRE', ...(await wire(GALE, 'AMAZON', 'IT', AMZ_ACC)) })
  const opened = await openDock()
  const r = await readDock()
  out({ step: 'd · GALE Amazon·IT dock (READ-ONLY)', opened, sectionTitle: r.sectionTitle, sectionTag: r.sectionTag, orderNote: r.orderNote, rows: r.rows, addLabel: r.addLabel, addDisabled: r.addDisabled, addTitle: r.addTitle, banner: r.banner, cellChrome: r.cellChrome, themePickerPresent: r.themePickerPresent, footerButtons: r.footerButtons })
  out({ step: 'd · mutations (must be empty)', mutations })
}

/* ── (b) VX-TEST-3AX · Amazon·IT · the witnessed reorder ───────────────────────────────────── */
if (want('b')) {
  const apiRead = async () => await page.evaluate(async ({ api, id, acc }) => {
    const r = await fetch(`${api}/api/products/${id}/studio/projection?channel=AMAZON&market=IT&accountId=${acc}`, { credentials: 'include' })
    const b = await r.json().catch(() => null)
    return { status: r.status, version: b?.version ?? null, mapping: (b?.mapping ?? []).map((m) => `${m.axisKey}#${m.order}:${m.target ?? '—'}`), locked: b?.locked ?? null, order: b?.order ? { writableHere: b.order.writableHere, reason: (b.order.reason ?? '').slice(0, 80) } : null }
  }, { api: API, id: VX, acc: AMZ_ACC })

  if (await goto(VX, `tab=variants&scope=AMAZON&market=IT&account=${AMZ_ACC}`)) {
    out({ step: 'b · BEFORE, through the API', ...(await apiRead()) })
    const opened = await openDock()
    const before = await readDock()
    out({ step: 'b · VX Amazon·IT dock', opened, rows: before.rows, sectionTag: before.sectionTag, orderNote: before.orderNote, themePickerPresent: before.themePickerPresent, addLabel: before.addLabel, addDisabled: before.addDisabled, footerButtons: before.footerButtons })
    /* A real gesture: focus the FIRST row's grip and press ArrowDown — the DS `OrderedList`'s own
       keyboard reorder, the same code path a pointer drag runs. */
    const grip = await page.$('.nds-axes-row-dock >> xpath=ancestor::li >> .nds-ordered-list-grip')
      ?? await page.$('.nds-ordered-list-grip')
    if (!grip) { out({ step: 'b · NO GRIP — could not measure', rows: before.rows.length }) } else {
      await grip.focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(600)
      const after = await readDock()
      out({ step: 'b · after the gesture', order: after.rows.map((r) => r.nameText), footerState: after.footerState, footerButtons: after.footerButtons })
      const save = await page.$('.nds-vp-dock-footer button:has-text("Save mapping")')
      if (!save) { out({ step: 'b · NO SAVE BUTTON — could not measure', footerButtons: after.footerButtons }) } else {
        mutations.length = 0
        responses.length = 0
        await save.click()
        await page.waitForTimeout(2500)
        out({ step: 'b · the WITNESSED write', request: mutations, response: responses })
        await page.waitForTimeout(8000)
        out({ step: 'b · READ-BACK at 8s+', ...(await apiRead()) })
      }
    }
  }
}

/* ── (c) the plan Modal, opened from the SHEET cell's locked commit ────────────────────────── */
if (want('c') && (await goto(GALE, `tab=sheet&scope=EBAY&market=IT&account=${EBAY_ACC}`))) {
  mutations.length = 0
  posts.length = 0
  const cell = await page.$('.ag-row[row-index="0"] [col-id="variation_theme"]')
    ?? await page.$('[col-id="variation_theme"]')
  if (!cell) {
    out({ step: 'c · NO variation_theme CELL — could not measure', cols: await page.evaluate(() => [...document.querySelectorAll('.ag-header-cell')].map((h) => h.getAttribute('col-id')).slice(0, 25)) })
  } else {
    await cell.scrollIntoViewIfNeeded()
    await cell.dblclick()
    await page.waitForTimeout(1500)
    const editor = await page.evaluate(() => {
      const el = document.querySelector('.nds-axes-editor')
      if (!el) return { open: false }
      const t = (x) => (x?.textContent ?? '').replace(/\s+/g, ' ').trim()
      return {
        open: true,
        width: Math.round(el.getBoundingClientRect().width),
        host: el.className,
        rows: [...el.querySelectorAll('.nds-axes-row')].map((r) => t(r).slice(0, 60)),
        listboxes: [...el.querySelectorAll('.nds-listbox button')].map((b) => ({ text: t(b), disabled: b.disabled })),
        lockBanner: t(el.querySelector('.nds-banner')).slice(0, 150),
        foot: t(el.querySelector('.nds-axes-foot')).slice(0, 120),
      }
    })
    out({ step: 'c · the cell editor on a LIVE eBay coordinate', ...editor })
    /**
     * The SET change goes through `+ Add a specific`, whose candidate list renders INSIDE the editor.
     *
     * 🔴 Measured first, and recorded: the target `Listbox` PORTALS to `<body>` at `position: fixed`,
     * so clicking one of its options is a click OUTSIDE the AG popup — AG stops editing, the panel
     * unmounts, and the reported value is discarded. Pass 1 of this step read `foot: ""` (the editor
     * was already gone) and then Enter reached nothing. That is a real limitation of a portalled
     * popover inside an AG popup editor, it belongs to the CELL host as VT.2 shipped it, and it is in
     * the report as a finding rather than worked around silently.
     */
    const addBtn = await page.$('.nds-axes-editor .nds-axes-add button')
    out({ step: 'c · the add control', found: !!addBtn, disabled: await addBtn?.isDisabled?.(), hint: await page.evaluate(() => (document.querySelector('.nds-axes-add .nds-axes-filterhint')?.textContent ?? '').trim()) })
    if (!addBtn) { out({ step: 'c · NO add control — could not measure', editor }) } else {
      await addBtn.click()
      await page.waitForTimeout(600)
      const options = await page.evaluate(() => [...document.querySelectorAll('.nds-axes-editor .nds-axes-opt')].map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 12))
      out({ step: 'c · the candidate list, inside the editor', options })
      const pick = await page.$('.nds-axes-editor .nds-axes-opt')
      if (pick) { await pick.click(); await page.waitForTimeout(600) }
      out({ step: 'c · after the pick', foot: await page.evaluate(() => (document.querySelector('.nds-axes-foot')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)), rows: await page.evaluate(() => document.querySelectorAll('.nds-axes-editor .nds-axes-row').length) })
      /* 🔴 Enter is AG's, but only while focus is INSIDE the popup it owns. The candidate button the
         pick landed on is REMOVED by that same pick (the list empties), so focus fell to <body> and
         pass 2's Enter reached nothing — "could not measure", not "the modal does not open". The panel
         root carries `tabIndex={-1}` for exactly this, so focus goes back there first. */
      await page.evaluate(() => document.querySelector('.nds-axes-editor')?.focus())
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2500)
      if (await page.$('.nds-axes-editor')) {
        /* Still open: commit the way an operator's next click does — AG closes a popup editor on an
           outside click and keeps the reported value (`isCancelAfterEnd` is false once touched). */
        out({ step: 'c · Enter did not close the editor; committing by an outside click' })
        await page.mouse.click(700, 300)
        await page.waitForTimeout(2500)
      }
      await page.waitForTimeout(3000)
      const modal = await page.evaluate(() => {
        const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
        const table = document.querySelector('.nds-vt-plan-table')
        const el = table?.closest('.nds-modal') ?? [...document.querySelectorAll('[role="dialog"], .nds-modal')].find((d) => !d.querySelector('.nds-axes-editor') && !d.classList.contains('nds-axes-editor'))
        if (!el) return { open: false, editorStillOpen: !!document.querySelector('.nds-axes-editor'), planNote: t(document.querySelector('.nds-vt-plan-note')), bodyHas: document.body.innerText.slice(0, 160) }
        const box = el.getBoundingClientRect()
        const panel = el.querySelector('.nds-modal-panel') ?? el
        return {
          open: true,
          width: Math.round((panel.getBoundingClientRect().width) || box.width),
          height: Math.round((panel.getBoundingClientRect().height) || box.height),
          title: t(el.querySelector('.nds-modal-title, h2, [class*="title"]')),
          subtitle: t(el.querySelector('[class*="sub"]')),
          banners: [...el.querySelectorAll('.nds-banner')].map((b) => ({ tone: b.className, text: t(b).slice(0, 240) })),
          tableColumns: [...el.querySelectorAll('.nds-vt-plan-head [role="columnheader"]')].map(t),
          tableRows: [...el.querySelectorAll('.nds-vt-plan-row')].map((r) => [...r.children].map(t).map((c) => c.slice(0, 70))),
          keeps: [...el.querySelectorAll('.nds-vt-plan-keeps-title ~ .nds-vt-plan-item, .nds-vt-plan-outcomes .nds-vt-plan-item')].map(t).slice(0, 10),
          outcomes: t(el.querySelector('.nds-vt-plan-outcomes')).slice(0, 300),
          note: t(el.querySelector('.nds-vt-plan-note')).slice(0, 200),
          footerButtons: [...el.querySelectorAll('.nds-modal-foot button, footer button')].map((b) => ({ label: t(b), variant: b.className })),
          text: t(el).slice(0, 700),
        }
      })
      out({ step: 'c · the PLAN MODAL', ...modal })
      out({ step: 'c · the network (0 mutations, the plan POST only)', mutations, posts: posts.filter((p) => p.p.includes('theme-change')), responses: responses.filter((r) => r.p.includes('theme-change')) })
    }
  }
}

/* ── (e) the plan that BUILDS: a DROP on GALE eBay·IT, and a THEME pick on GALE Amazon·IT ──── */
const planFrom = async (label, scope, acc, gesture) => {
  if (!(await goto(GALE, `tab=sheet&scope=${scope}&market=IT&account=${acc}`))) return
  mutations.length = 0
  posts.length = 0
  responses.length = 0
  /* The ROW cell, never `[col-id=…]` alone — that matches the HEADER first, and a dblclick on a header
     opens nothing at all. Pass 1 of this step read `open: false` for exactly that reason. */
  const cell = await page.$('.ag-row[row-index="0"] [col-id="variation_theme"]')
  if (!cell) { out({ step: `${label} · NO CELL`, cols: await page.evaluate(() => [...document.querySelectorAll('.ag-row[row-index="0"] [col-id]')].map((c) => c.getAttribute('col-id')).slice(0, 20)) }); return }
  await cell.scrollIntoViewIfNeeded()
  await cell.dblclick()
  await page.waitForTimeout(1500)
  out({ step: `${label} · editor`, ...(await page.evaluate(() => {
    const el = document.querySelector('.nds-axes-editor')
    if (!el) return { open: false }
    const t = (x) => (x?.textContent ?? '').replace(/\s+/g, ' ').trim()
    return {
      open: true,
      groups: [...el.querySelectorAll('.nds-axes-group')].map(t),
      options: [...el.querySelectorAll('.nds-axes-opt')].map(t).slice(0, 6),
      rows: [...el.querySelectorAll('.nds-axes-row')].map((r) => t(r).slice(0, 50)),
      checkboxes: [...el.querySelectorAll('input[type="checkbox"]')].map((c) => ({ checked: c.checked, disabled: c.disabled })),
      hint: t(el.querySelector('.nds-axes-sectionhint')),
      foot: t(el.querySelector('.nds-axes-foot')),
    }
  })) })
  await gesture()
  out({ step: `${label} · after the gesture`, foot: await page.evaluate(() => (document.querySelector('.nds-axes-foot')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)) })
  await page.evaluate(() => document.querySelector('.nds-axes-editor')?.focus())
  await page.keyboard.press('Enter')
  await page.waitForTimeout(5000)
  out({ step: `${label} · the PLAN MODAL`, ...(await page.evaluate(() => {
    const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const table = document.querySelector('.nds-vt-plan-table')
    const el = table?.closest('.nds-modal') ?? [...document.querySelectorAll('.nds-modal')].find((d) => !d.querySelector('.nds-axes-editor'))
    if (!el) return { open: false, editorStillOpen: !!document.querySelector('.nds-axes-editor'), body: document.body.innerText.slice(0, 120) }
    const panel = el.querySelector('.nds-modal-panel') ?? el
    return {
      open: true,
      width: Math.round(panel.getBoundingClientRect().width),
      height: Math.round(panel.getBoundingClientRect().height),
      headerTitle: t(el.querySelector('[class*="modal-title"], h2')),
      headerSub: t(el.querySelector('[class*="modal-sub"]')),
      banners: [...el.querySelectorAll('.nds-banner')].map((b) => ({ tone: b.className.replace('nds-banner ', ''), text: t(b).slice(0, 200) })),
      tableColumns: [...el.querySelectorAll('.nds-vt-plan-head [role="columnheader"]')].map(t),
      stepRows: [...el.querySelectorAll('.nds-vt-plan-row')].map((r) => [...r.children].map(t).map((c) => c.slice(0, 60))),
      keeps: t(el.querySelector('.nds-vt-plan-outcomes')).slice(0, 320),
      note: t(el.querySelector('.nds-vt-plan-note')).slice(0, 200),
      /* Every button in the dialog: the footer's own class differs per Modal size, and a selector that
         misses it reads as "no buttons", which is the could-not-measure/measured-empty confusion. */
      buttons: [...el.querySelectorAll('button')].map((b) => ({ label: t(b), variant: b.className })),
    }
  })) })
  out({ step: `${label} · the network`, mutations, posts: posts.filter((p) => p.p.includes('theme-change')), responses: responses.filter((r) => r.p.includes('theme-change')) })
}

if (want('e')) {
  /* A DROP is a SET change with no new axis key: uncheck the SECOND row's checkbox, inside the editor. */
  await planFrom('e1 · GALE eBay·IT · drop an axis', 'EBAY', EBAY_ACC, async () => {
    const boxes = await page.$$('.nds-axes-editor input[type="checkbox"]')
    if (boxes[1]) await boxes[1].click()
    await page.waitForTimeout(600)
  })
  /* A THEME pick on a live ASIN: `amazon-new-parent`, the richest artboard-7 case. */
  await planFrom('e2 · GALE Amazon·IT · pick another theme', 'AMAZON', AMZ_ACC, async () => {
    const opt = await page.$$('.nds-axes-editor .nds-axes-opt')
    if (opt.length > 1) await opt[1].click()
    else if (opt.length === 1) await opt[0].click()
    await page.waitForTimeout(600)
  })
}

out({ step: 'console errors', count: errors.length, errors: errors.slice(0, 10) })
await page.evaluate(() => console.error('VT.2c positive control'))
await page.waitForTimeout(300)
out({ step: 'POSITIVE CONTROL (the error instrument fires)', fired: errors.some((e) => e.includes('VT.2c positive control')) })
out({ step: 'ALL mutations seen in this pass', mutations })
await browser.close()
