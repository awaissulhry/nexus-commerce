import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('.h10-spw-ps-list .row:not(.sk)', { timeout: 15000 }).catch(() => {})
await p.waitForTimeout(500)
// add the first product so the ASIN box shows a real image
const add0 = await p.$('.h10-spw-ps-list .row .addbtn')
if (add0) { await add0.click(); await p.waitForTimeout(150) }

await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.waitForTimeout(400)
let el = await p.$('.h10-spw-st-card'); if (el) await el.screenshot({ path: '/tmp/spw/st_standard.png' })
console.log('standard')

await p.click('.h10-spw-st-tabs button:nth-child(2)') // Advanced
await p.waitForTimeout(300)
el = await p.$('.h10-spw-st-card'); if (el) await el.screenshot({ path: '/tmp/spw/st_advanced.png' })
console.log('advanced')

await p.click('.h10-spw-st-toggle button.ai') // AI Control
await p.waitForTimeout(200)
el = await p.$('.h10-spw-st-card'); if (el) await el.screenshot({ path: '/tmp/spw/st_advanced_ai.png' })
console.log('ai')

await b.close()
console.log('done')
