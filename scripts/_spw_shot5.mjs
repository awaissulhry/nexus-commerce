import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.click('.h10-spw-steps button:nth-of-type(2)') // step 2
await p.waitForTimeout(400)

// keyword campaign (row index 1 = Brand) → Targeting Edit
await p.locator('.h10-spw-cset-row').nth(1).locator('.tgt').first().locator('.edit').click()
await p.waitForTimeout(300)
let el = await p.$('.h10-modal'); if (el) await el.screenshot({ path: '/tmp/spw/tgt_kw.png' })
console.log('kw')
await p.click('.h10-modal-x')
await p.waitForTimeout(250)

// PAT campaign (row index 4) → Targeting Edit (ProductSelection)
await p.locator('.h10-spw-cset-row').nth(4).locator('.tgt').first().locator('.edit').click()
await p.waitForSelector('.h10-modal .h10-spw-ps-list .row:not(.sk)', { timeout: 12000 }).catch(() => {})
await p.waitForTimeout(400)
el = await p.$('.h10-modal'); if (el) await el.screenshot({ path: '/tmp/spw/tgt_prod.png' })
console.log('prod')
await b.close()
console.log('done')
