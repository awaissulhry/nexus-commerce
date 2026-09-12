/**
 * `unknown` verification, take 2. Detector fires ONLY on a connection-level refusal.
 * A timeout is explicitly NOT down — that conflation is what missed the last window.
 */
import { chromium } from '@playwright/test'
const API = 'http://127.0.0.1:8091/api/products/cmokmy3a40078pm0p1fvnu523/studio/sheet?market=DE&locale=de'
const HEALTH = 'http://127.0.0.1:8091/api/products/search?limit=1'
const ROW = 'cmokmy3a40078pm0p1fvnu523'
const SHOT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/03a6ad28-dfaa-48c2-9d93-fa7c1b40bb83/scratchpad/unknown-mark.png'
const sel = `.ag-row[row-id="${ROW}"] .ag-cell[col-id="weave_type"]`
const clock = () => new Date().toTimeString().slice(0, 8)
const say = (m) => console.log(`${clock()}  ${m}`)
const db = async (l) => {
  try {
    const r = await fetch(API).then((x) => x.json())
    const p = (r.rows || []).find((x) => !x.parentId)
    say(`[DB] ${l}: ${JSON.stringify(p?.values?.weave_type?.value)} v${p?.version}`)
    return p?.values?.weave_type?.value
  } catch { say(`[DB] ${l}: unreachable`); return null }
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1728, height: 906 } })
page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(90000)
page.on('request', (r) => { if (r.method() === 'PATCH') say('→ PATCH sent') })
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
await page.locator(sel).scrollIntoViewIfNeeded(); await page.locator(sel).click()
await page.keyboard.press('Enter'); await page.waitForTimeout(700)
await page.keyboard.press('Meta+a'); await page.keyboard.type('PES2-UNKNOWN', { delay: 12 })
say('ARMED — editor open, value typed, watching for ECONNREFUSED only')

let fired = false
const deadline = Date.now() + 420000
while (Date.now() < deadline && !fired) {
  // NO timeout signal. A slow answer is an answer; only a refused connection is "down".
  const down = await fetch(HEALTH).then(() => false).catch((e) => {
    const code = e?.cause?.code ?? ''
    const connLevel = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(code + ' ' + (e?.cause?.message ?? '') + ' ' + (e?.message ?? ''))
    if (connLevel) say(`detector: connection-level failure — ${code || e?.message}`)
    else say(`detector: NOT down, some other error — ${e?.message} (ignored)`)
    return connLevel
  })
  if (down) { say('COMMITTING the keystroke into the outage'); await page.keyboard.press('Enter'); fired = true; break }
  await new Promise((r) => setTimeout(r, 150))
}
if (!fired) { say('no connection-level outage seen — nothing fabricated'); await page.keyboard.press('Escape') }
else {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const st = await page.evaluate((q) => {
      const c = document.querySelector(q); if (!c) return '(gone)'
      return { cls: [...c.classList].filter((x) => x.startsWith('nds-cell-is-')).sort().join(','), text: c.textContent?.trim() }
    }, sel).catch(() => null)
    if (st?.cls?.includes('unknown')) {
      say(`[paint] ${st.cls}  ← UNKNOWN, cell reads ${JSON.stringify(st.text)}`)
      await page.screenshot({ path: SHOT }); say(`[shot] ${SHOT}`)
      const tip = await page.evaluate((q) => document.querySelector(q)?.getAttribute('title') ?? null, sel).catch(() => null)
      say(`[tooltip] ${JSON.stringify(tip)}`)
      break
    }
    if (i % 5 === 0) say(`[paint] ${st?.cls ?? '?'}`)
  }
}
await new Promise((r) => setTimeout(r, 10000))
await db('after (post-reconcile)')
await browser.close()
