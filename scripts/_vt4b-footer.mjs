/** VT.4b — the FamilyFooter's variation-mapping counts on screen. Expands one family and reads the footer row. */
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

await page.goto(`${BASE}/products/next`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!document.querySelector('.ag-root'), null, { timeout: 60000, polling: 500 })
await page.waitForTimeout(4000)

/* Find the expander by INSPECTING the identity cell rather than guessing three class names. */
out({ step: 'anatomy', ...(await page.evaluate(() => {
  const cell = document.querySelector('.ag-row[row-id] [col-id="ag-Grid-AutoColumn"]')
  return {
    cellClasses: cell?.className ?? null,
    innerTags: [...(cell?.querySelectorAll('*') ?? [])].slice(0, 10).map((e) => `${e.tagName.toLowerCase()}.${e.className}`.slice(0, 70)),
  }
})) })

const expanded = await page.evaluate(async () => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const rows = [...document.querySelectorAll('.ag-row[row-id]')]
  const target = rows.find((r) => t(r.querySelector('[col-id="ag-Grid-AutoColumn"]')).includes('GALE-JACKETOUTERWEAR'))
    ?? rows.find((r) => t(r.querySelector('[col-id="ag-Grid-AutoColumn"]')).includes('VX-TEST-3AX'))
  if (!target) return { ok: false, reason: 'no GALE/VX row', rows: rows.length }
  const cell = target.querySelector('[col-id="ag-Grid-AutoColumn"]')
  const opener = cell?.querySelector('.ag-group-contracted, [class*="group-contracted"], .ag-group-expanded, button, [role="button"]')
  if (!opener) return { ok: false, reason: 'no opener', cellHtml: (cell?.innerHTML ?? '').slice(0, 400) }
  opener.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 3000))
  return { ok: true, clicked: `${opener.tagName.toLowerCase()}.${opener.className}`.slice(0, 60), row: t(cell).slice(0, 60) }
})
out({ step: 'expand', ...expanded })
await page.waitForTimeout(8000)
out({ step: 'the footer', ...(await page.evaluate(() => {
  const t = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const sentences = [...document.querySelectorAll('[class*="famFootCount"]')].map((c) => ({ text: t(c), title: c.getAttribute('title') }))
  return {
    footerCells: document.querySelectorAll('[class*="famFoot"]').length,
    all: sentences,
    mapping: sentences.filter((x) => x.text.startsWith('Variation mapping')),
  }
})) })
out({ step: 'console errors', count: errors.length, errors: errors.slice(0, 6) })
await page.evaluate(() => console.error('VT.4b footer positive control'))
await page.waitForTimeout(300)
out({ step: 'POSITIVE CONTROL', fired: errors.some((e) => e.includes('footer positive control')) })
out({ step: 'mutations (must be empty)', mutations })
await browser.close()
