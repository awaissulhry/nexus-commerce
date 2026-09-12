import { chromium } from '@playwright/test'
const API = 'http://127.0.0.1:8091/api/products/cmokmy3a40078pm0p1fvnu523/studio/sheet?market=DE&locale=de'
const HEALTH = 'http://127.0.0.1:8091/api/products/search?limit=1'
const ROW = 'cmokmy3a40078pm0p1fvnu523'
const SHOT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/03a6ad28-dfaa-48c2-9d93-fa7c1b40bb83/scratchpad/unknown-mark.png'
const sel = `.ag-row[row-id="${ROW}"] .ag-cell[col-id="weave_type"]`
const clock = () => new Date().toTimeString().slice(0, 8)
const say = (m) => console.log(`${clock()}  ${m}`)
const db = async (l) => {
  try { const r = await fetch(API).then((x) => x.json()); const p = (r.rows || []).find((x) => !x.parentId)
    say(`[DB] ${l}: ${JSON.stringify(p?.values?.weave_type?.value)} v${p?.version}`); return p?.values?.weave_type?.value
  } catch { say(`[DB] ${l}: unreachable`); return null }
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1728, height: 906 } })
page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(90000)
let sheetReads = 0
page.on('request', (r) => {
  if (r.method() === 'PATCH') say('→ PATCH sent')
  if (/studio\/sheet/.test(r.url())) { sheetReads++; say(`↻ sheet read #${sheetReads} (reconcile shows up here)`) }
})
page.on('response', (r) => { if (r.request().method() === 'PATCH') say(`← PATCH ${r.status()}`) })
page.on('requestfailed', (r) => { if (r.method() === 'PATCH') say(`✗ PATCH REJECTED — ${r.failure()?.errorText}`) })
await page.goto('http://localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio?market=DE&locale=de', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ag-row', { timeout: 90000 }); await page.waitForTimeout(3000)
await page.click('button:has-text("Customise")'); await page.waitForTimeout(1500)
await page.evaluate(() => {
  const l = [...document.querySelectorAll('.nds-modal label.nds-check')].find((x) => x.textContent.trim() === 'Weave Type')
  if (l && !l.querySelector('input').checked) l.querySelector('input').click()
})
await page.click('.nds-modal button:has-text("Save")'); await page.waitForTimeout(3000)
await db('before')
const readsBeforeEdit = sheetReads
await page.locator(sel).scrollIntoViewIfNeeded(); await page.locator(sel).click()
await page.keyboard.press('Enter'); await page.waitForTimeout(700)
await page.keyboard.press('Meta+a'); await page.keyboard.type('PES2-UNKNOWN', { delay: 12 })
say('ARMED — ECONNREFUSED only, no timeout signal')

let fired = false
const deadline = Date.now() + 480000
while (Date.now() < deadline && !fired) {
  const down = await fetch(HEALTH).then(() => false).catch((e) => {
    const blob = `${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''} ${e?.message ?? ''}`
    const conn = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|socket hang up|fetch failed/i.test(blob)
    if (conn) say(`detector: connection-level failure — ${blob.trim().slice(0, 60)}`)
    else say(`detector: other error, IGNORED — ${blob.trim().slice(0, 60)}`)
    return conn
  })
  if (down) { say('COMMITTING the keystroke into the outage'); await page.keyboard.press('Enter'); fired = true; break }
  await new Promise((r) => setTimeout(r, 150))
}
if (!fired) { say('no connection-level outage in the window — nothing fabricated'); await page.keyboard.press('Escape') }
else {
  let sawUnknown = false
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const st = await page.evaluate((q) => {
      const c = document.querySelector(q); if (!c) return null
      return { cls: [...c.classList].filter((x) => x.startsWith('nds-cell-is-')).sort().join(','),
               title: c.getAttribute('title'), text: c.textContent?.trim() }
    }, sel).catch(() => null)
    if (st?.cls?.includes('unknown') && !sawUnknown) {
      sawUnknown = true
      say(`[paint] ${st.cls}`)
      say(`[sentence on screen] title=${JSON.stringify(st.title)}  cell=${JSON.stringify(st.text)}`)
      await page.screenshot({ path: SHOT }); say(`[shot] ${SHOT}`)
    }
    if (i % 8 === 0) say(`[paint] ${st?.cls ?? '?'}`)
  }
  say(`sheet reads since the edit: ${sheetReads - readsBeforeEdit}  (>0 = onReconcile → reload fired)`)
}
await db('after')
await browser.close()
