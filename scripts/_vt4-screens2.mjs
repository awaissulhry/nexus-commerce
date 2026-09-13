/**
 * VT.4 pass 3 — the Collisions section's GROUPS state, on a coordinate whose scope actually loads.
 *
 * Pass 2 asked for VX-TEST-3AX on Shopify·GLOBAL and got no dock. The cause is NOT this lane and NOT
 * "the section is missing": `GET /studio/sheet?scope=channel&channel=SHOPIFY&market=GLOBAL` answers
 * **500 {"error":"studio_request_failed","message":"Shopify requirements are not cached for this account."}`
 * — the same pre-existing Shopify defect behind the 8 failing `services/shopify` suites LX recorded. The
 * same product's AMAZON·IT sheet answers **200**, and its projection carries the collision (every axis
 * dropped, 4 variants in 1 group), so that is the coordinate the GROUPS state is measured on.
 */
import { chromium } from 'playwright'
import { authenticatedStudioPage } from './studio-browser-auth.mjs'

const BASE = 'http://localhost:3000'
const out = (o) => console.log(JSON.stringify(o, null, 1))
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } })
const errors = []
const mutations = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(clean(m.text()).slice(0, 200)) })
page.on('request', (r) => { if (['PATCH', 'PUT', 'DELETE'].includes(r.method())) mutations.push(`${r.method()} ${new URL(r.url()).pathname}`) })

const read = async () => await page.evaluate(() => {
  const section = [...document.querySelectorAll('.nds-vp-dock-section')].find((s) => s.querySelector('#vp-dock-collisions'))
  if (!section) return { present: false }
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return {
    present: true,
    title: t(section.querySelector('#vp-dock-collisions')),
    hint: t(section.querySelector('.nds-vp-dock-hint')),
    tableColumns: [...section.querySelectorAll('table.nds-summary-table thead th')].map(t),
    tableRows: [...section.querySelectorAll('table.nds-summary-table tbody tr')].map((tr) => [...tr.children].map(t)),
    radios: [...section.querySelectorAll('input[type="radio"]')].map((r) => {
      const held = r.closest('.nds-vp-dock-held')
      return {
        label: t(r.closest('label') ?? r.parentElement).slice(0, 40),
        disabled: r.disabled,
        ariaDisabled: r.getAttribute('aria-disabled'),
        describedBy: r.getAttribute('aria-describedby'),
        titleOnControl: (held?.getAttribute('title') ?? '').slice(0, 110),
        reasonRendered: t(held?.parentElement?.querySelector('p.nds-vp-dock-note')).slice(0, 110),
      }
    }),
    sectionHeight: Math.round(section.getBoundingClientRect().height),
    sectionWidth: Math.round(section.getBoundingClientRect().width),
    dockWidth: Math.round((document.querySelector('.nds-vp-dock')?.getBoundingClientRect().width ?? 0)),
  }
})

for (const [label, id, channel, market, account] of [
  ['VX-TEST-3AX · Amazon · IT (every axis dropped)', 'cmtzci5kf0000njr9f8yhrsxm', 'AMAZON', 'IT', 'cmothu9bo0000nz01asw6wx8j'],
  ['GALE-JACKET · Amazon · IT (every axis dropped, 20 variants)', 'cmokmy3a40078pm0p1fvnu523', 'AMAZON', 'IT', 'cmothu9bo0000nz01asw6wx8j'],
]) {
  await page.goto(`${BASE}/products/${id}/edit/studio?tab=variants&scope=${channel}&market=${market}&account=${account}`, { waitUntil: 'domcontentloaded' })
  try {
    await page.waitForFunction(() => !!document.querySelector('.ag-root, [data-studio-dock]'), { timeout: 120000, polling: 500 })
  } catch {
    /* A timeout is "could not measure", and it must not be reported as "the section is not there".
       Print what IS on the page so the next reader can tell the two apart. */
    out({ step: `${label} · COULD NOT MEASURE`, url: page.url(), title: await page.title(), bodyStart: (await page.evaluate(() => document.body.innerText)).slice(0, 400), errors: errors.slice(0, 6) })
    continue
  }
  await page.waitForTimeout(4500)
  const opener = await page.$('button:has-text("Edit mapping")')
  if (opener) { await opener.click(); await page.waitForTimeout(3000) }
  out({ step: label, openerFound: !!opener, rows: await page.evaluate(() => document.querySelectorAll('.ag-row[row-id]').length), ...(await read()) })
}

out({ step: 'console errors', count: errors.length, errors: errors.slice(0, 8) })
await page.evaluate(() => console.error('VT.4 pass-3 positive control'))
await page.waitForTimeout(300)
out({ step: 'POSITIVE CONTROL', fired: errors.some((e) => e.includes('pass-3 positive control')) })
out({ step: 'mutations (must be empty)', mutations })
await browser.close()
