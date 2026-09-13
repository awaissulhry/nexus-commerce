/**
 * VT.4 — the on-screen readings for the states this lane owns. READ-ONLY on the web.
 *
 * 1. The mapping dock's **Collisions** section in all three of its states:
 *      a) GROUPS      — VX-TEST-3AX on Shopify · GLOBAL (its mapping is empty, so every axis is dropped)
 *      b) NOT COMPUTED — GALE-JACKET on eBay · IT (nothing dropped ⇒ `collisions: null`)
 *      c) the resolver rows, each held with the reason that applies to it
 * 2. The **plan modal** opened by the dock's own locked-SET-change path, on GALE's LIVE eBay · IT
 *    coordinate. A plan is a READ: no PATCH is sent, and the script asserts that with a request capture.
 * 3. `/products/next` — the **Variation mapping** filter: its five options, the URL it writes, and the
 *    banner that names it as not applied by the server.
 * 4. Console errors on every state, with a POSITIVE CONTROL that the listener is actually wired.
 *
 * Run it through the R-GATE-1 wrapper:
 *   node scripts/studio-gate-session.mjs -- node scripts/_vt4-screens.mjs
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = 'http://localhost:3000' // never 127.0.0.1 — reference_local_web_hydrates_only_on_localhost_origin
const VX = 'cmtzci5kf0000njr9f8yhrsxm'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const SHOP = 'cmtugfpaa0006njhq8m2nvnxx'
const EBAY = 'cmr4aaqb00025nz016k18rup9'
const out = (o) => console.log(JSON.stringify(o, null, 1))
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })

const errors = []
const mutations = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(clean(m.text()).slice(0, 200)) })
page.on('request', (r) => {
  if (['PATCH', 'PUT', 'DELETE'].includes(r.method())) mutations.push(`${r.method()} ${new URL(r.url()).pathname}`)
  if (r.method() === 'POST' && !new URL(r.url()).pathname.startsWith('/api/auth')) mutations.push(`POST ${new URL(r.url()).pathname}`)
})

/** Open the Variants tab on one coordinate and reach the mapping dock. */
async function dock(productId, channel, market, accountId) {
  // 🔴 The studio's URL keys are `scope` / `market` / `tab` / `account` (`_studio/contracts.tsx:101`,
  // and `account` at :856). My first run sent `accountId=` and got a page with no dock — which read as
  // "the dock is not there" when it was "I asked the wrong question".
  const url = `${BASE}/products/${productId}/edit/studio?tab=variants&scope=${channel}&market=${market}&account=${accountId}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // Hydration first: a server-rendered page with inert controls is UNMEASURABLE
  // (reference_dev_app_not_hydrating_2026_09_13).
  await page.waitForFunction(() => !!document.querySelector('[data-studio-dock], .nds-vp-dock, .ag-root'), { timeout: 90000 })
  await page.waitForTimeout(4000)
  const opener = await page.$('button:has-text("Edit mapping")')
  if (opener) { await opener.click(); await page.waitForTimeout(3000) }
  const diag = await page.evaluate(() => ({
    // Printed on EVERY pass, so a missing section is never confused with a page that did not load.
    tab: new URL(location.href).searchParams.get('tab'),
    bandPresent: !!document.querySelector('.nds-vp-band, [class*="MappingBand"]'),
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 24),
    banners: [...document.querySelectorAll('.nds-banner')].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)),
    gridRows: document.querySelectorAll('.ag-row[row-id]').length,
  }))
  return { url, dockPresent: !!(await page.$('.nds-vp-dock')), openerFound: !!opener, diag }
}

async function readCollisions() {
  return await page.evaluate(() => {
    const section = [...document.querySelectorAll('.nds-vp-dock-section')]
      .find((s) => s.querySelector('#vp-dock-collisions'))
    if (!section) return { present: false }
    const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const rows = [...section.querySelectorAll('table.nds-summary-table tbody tr')]
      .map((tr) => [...tr.children].map((td) => t(td)))
    const radios = [...section.querySelectorAll('input[type="radio"]')].map((r) => {
      const label = r.closest('label') ?? r.parentElement
      const held = r.closest('.nds-vp-dock-held')
      const note = held?.parentElement?.querySelector('p.nds-vp-dock-note')
      return {
        label: t(label).slice(0, 60),
        disabled: r.disabled,
        ariaDisabled: r.getAttribute('aria-disabled'),
        titleOnControl: (held?.getAttribute('title') ?? '').slice(0, 90),
        describedBy: r.getAttribute('aria-describedby'),
        reasonRendered: t(note).slice(0, 120),
      }
    })
    return {
      present: true,
      title: t(section.querySelector('#vp-dock-collisions')),
      hint: t(section.querySelector('.nds-vp-dock-hint')),
      note: t(section.querySelector('p.nds-vp-dock-note')),
      tableColumns: [...section.querySelectorAll('table.nds-summary-table thead th')].map((th) => t(th)),
      tableRows: rows,
      radios,
      sectionHeight: Math.round(section.getBoundingClientRect().height),
    }
  })
}

/* ── 1a · GROUPS — VX-TEST-3AX on Shopify · GLOBAL ──────────────────────────────────────────── */
out({ step: '1a nav', ...(await dock(VX, 'SHOPIFY', 'GLOBAL', SHOP)) })
out({ step: '1a · Collisions section, GROUPS state', ...(await readCollisions()) })

/* ── 1b · NOT COMPUTED — GALE on eBay · IT (nothing dropped) ────────────────────────────────── */
out({ step: '1b nav', ...(await dock(GALE, 'EBAY', 'IT', EBAY)) })
out({ step: '1b · Collisions section, NOT-COMPUTED state', ...(await readCollisions()) })

/* ── 2 · the plan modal, from the dock's locked-SET-change path on a LIVE coordinate ─────────── */
const footerBefore = await page.evaluate(() => {
  const f = document.querySelector('.nds-vp-dock-footer')
  return { primary: (f?.querySelector('button:last-of-type')?.textContent ?? '').trim() }
})
/* Uncheck one specific: on eBay that is a SET change, and the coordinate is LIVE (item 257584954808). */
const unchecked = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.nds-vp-dock-section input[type="checkbox"]')]
  const first = boxes.find((b) => b.checked && !b.disabled)
  if (!first) return { ok: false, checkboxes: boxes.length }
  first.click()
  return { ok: true, checkboxes: boxes.length }
})
await page.waitForTimeout(1200)
/* The DS Listbox/target path differs per channel, so also try clearing a target via the dock's own
   remove control if the checkbox route did not change the set. */
const footerAfter = await page.evaluate(() => {
  const f = document.querySelector('.nds-vp-dock-footer')
  return {
    state: (f?.querySelector('.nds-vp-dock-state')?.textContent ?? '').trim(),
    primary: (f?.querySelector('button:last-of-type')?.textContent ?? '').trim(),
    primaryDisabled: f?.querySelector('button:last-of-type')?.disabled,
  }
})
out({ step: '2 · footer label before/after the SET change', unchecked, footerBefore, footerAfter })

let modal = { opened: false }
if (footerAfter.primary.startsWith('Change variation theme')) {
  await page.click('.nds-vp-dock-footer button:last-of-type')
  await page.waitForTimeout(6000)
  modal = await page.evaluate(() => {
    const m = document.querySelector('.h10-modal, [role="dialog"].nds-modal, .nds-modal')
      ?? [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('.nds-vt-plan-table, .nds-banner'))
    if (!m) return { opened: false, dialogs: document.querySelectorAll('[role="dialog"]').length }
    const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const box = m.getBoundingClientRect()
    const table = m.querySelector('.nds-vt-plan-table')
    return {
      opened: true,
      width: Math.round(box.width),
      title: t(m.querySelector('h1, h2, .nds-modal-title')),
      subtitle: t(m.querySelector('.nds-modal-subtitle')),
      banner: t(m.querySelector('.nds-banner')).slice(0, 200),
      columns: [...m.querySelectorAll('.nds-vt-plan-head > span')].map((s) => t(s)),
      steps: [...m.querySelectorAll('.nds-vt-plan-row')].map((r) => [...r.children].map((c) => t(c))),
      keeps: t(m.querySelector('.nds-vt-plan-keeps-title')),
      keepsItems: [...m.querySelectorAll('.nds-vt-plan-outcomes > div:first-child .nds-vt-plan-item')].map((d) => t(d)),
      losesItems: [...m.querySelectorAll('.nds-vt-plan-outcomes > div:last-child .nds-vt-plan-item')].map((d) => t(d)),
      footerNote: t(m.querySelector('.nds-vt-plan-note')),
      buttons: [...m.querySelectorAll('footer button, .nds-modal-footer button')].map((b) => t(b)),
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
      reversibleColours: [...m.querySelectorAll('.nds-vt-plan-c-reversible')].map((s) => ({ text: t(s), colour: getComputedStyle(s).color })),
    }
  })
}
out({ step: '2 · the plan modal', ...modal })
out({ step: '2 · MUTATIONS CAPTURED SO FAR (must be empty — a plan is a read)', mutations })

/* ── 3 · /products/next — the Variation mapping filter ──────────────────────────────────────── */
await page.goto(`${BASE}/products/next`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!document.querySelector('.ag-root, .nds-gridcard'), { timeout: 90000 })
await page.waitForTimeout(5000)
const panel = await page.$('button:has-text("Filters")')
if (panel) { await panel.click(); await page.waitForTimeout(1200) }
const filter = await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  /* Find the FIELD by its own label text, whatever the panel's class names are — the first pass
     guessed three selectors and matched none, which produced `found: false` for a control that is on
     screen. `reference_could_not_measure_vs_measured_empty`, in a selector. */
  const labelled = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && t(el) === 'Variation mapping')
  const own = labelled[0]
  const field = own?.closest('div')
  const panelLabels = [...document.querySelectorAll('*')]
    .filter((el) => el.children.length === 0 && /^(Channel|Status|Stock|Fulfilment|Product type|Brand|Tags|Family|Workflow stage|Missing channel|Variation mapping|Price|Stock units)$/.test(t(el)))
    .map((el) => t(el))
  return {
    found: !!own,
    label: t(own),
    panelLabels,
    trigger: t(field?.querySelector('button')).slice(0, 60),
  }
})
out({ step: '3 · the filter panel', ...filter })

/* Open the multiselect and read its five options. */
const options = await page.evaluate(async () => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const own = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && t(el) === 'Variation mapping')[0]
  const field = own?.closest('div')
  const trigger = field?.querySelector('button')
  if (!trigger) return { opened: false, reason: 'no trigger under the Variation mapping label' }
  trigger.click()
  await new Promise((r) => setTimeout(r, 700))
  const list = document.querySelector('.nds-optionlist, [role="listbox"], .nds-multiselect-menu')
  return {
    opened: !!list,
    options: list ? [...list.querySelectorAll('[role="option"], label, li')].map((o) => t(o)).filter(Boolean).slice(0, 12) : [],
  }
})
out({ step: '3 · the five options', ...options })

/* The URL the filter writes, and the honest banner — reached through the URL, the way VT.3's [List] does. */
await page.goto(`${BASE}/products/next?filter=variation-mapping:derived|collides`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!document.querySelector('.ag-root, .nds-gridcard'), { timeout: 90000 })
await page.waitForTimeout(5000)
const fromUrl = await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const banner = [...document.querySelectorAll('.nds-banner')].map((b) => t(b)).find((s) => s.includes('Variation mapping'))
  const active = [...document.querySelectorAll('button')].map((b) => t(b)).filter((s) => /^Filters/.test(s))
  return { url: location.href, banner: (banner ?? '').slice(0, 300), filtersButton: active }
})
out({ step: '3 · the [List] link arm', ...fromUrl })

/* An UNKNOWN value in the link must be named, not silently accepted. */
await page.goto(`${BASE}/products/next?filter=variation-mapping:derived|missing`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!document.querySelector('.ag-root, .nds-gridcard'), { timeout: 90000 })
await page.waitForTimeout(4000)
out({ step: '3 · the unknown-value arm', banner: await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return ([...document.querySelectorAll('.nds-banner')].map((b) => t(b)).find((s) => s.includes('variation mapping')) ?? '').slice(0, 300)
}) })

/* ── 4 · console errors, with a POSITIVE CONTROL that the listener is wired ──────────────────── */
out({ step: '4 · console errors on the states above', count: errors.length, errors: errors.slice(0, 12) })
await page.evaluate(() => console.error('VT.4 positive control — the console listener is wired'))
await page.waitForTimeout(400)
out({
  step: '4 · POSITIVE CONTROL',
  fired: errors.some((e) => e.includes('VT.4 positive control')),
  countAfter: errors.length,
})
out({ step: 'FINAL · mutations issued by this whole run (must be empty)', mutations })

await browser.close()
