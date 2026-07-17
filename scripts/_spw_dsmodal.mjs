import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(400)
await p.click('.h10-spw-cset-select > button'); await p.waitForTimeout(150)
await p.locator('.h10-spw-cset-select .menu button', { hasText: 'Keyword campaigns' }).click(); await p.waitForTimeout(200)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Negatives' }).click(); await p.waitForTimeout(300)

// measure padding: textarea left/right vs modal body left/right
const m = await p.evaluate(() => {
  const modal = document.querySelector('.h10-ds-modal')
  const body = document.querySelector('.h10-ds-modal-b')
  const ta = document.querySelector('.h10-ds-textarea')
  const r = (el) => el ? (({ left, right, width }) => ({ left: Math.round(left), right: Math.round(right), w: Math.round(width) }))(el.getBoundingClientRect()) : null
  const br = body?.getBoundingClientRect(), tr = ta?.getBoundingClientRect()
  return { modal: r(modal), body: r(body), textarea: r(ta), leftInset: br && tr ? Math.round(tr.left - br.left) : null, rightInset: br && tr ? Math.round(br.right - tr.right) : null, usesDsModal: !!modal, usesDsTextarea: !!ta }
})
await p.locator('.h10-ds-modal').screenshot({ path: '/tmp/spw/dsmodal.png' })
console.log(JSON.stringify(m, null, 2))
await b.close()
execSync('sips -Z 1200 /tmp/spw/dsmodal.png --out /tmp/spw/dsmodal_v.png', { stdio: 'ignore' })
console.log('scaled')
