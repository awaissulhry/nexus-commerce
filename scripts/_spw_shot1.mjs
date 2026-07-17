import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('.h10-spw-ps-list .row:not(.sk)', { timeout: 15000 }).catch(() => console.log('no rows loaded'))
await p.waitForTimeout(700)

await p.locator('#spw-product-selection').scrollIntoViewIfNeeded()
await p.waitForTimeout(300)
const ps = await p.$('.h10-spw-ps')
if (ps) await ps.screenshot({ path: '/tmp/spw/s1_ps_el.png' })
console.log('ps shot')

// add first 3 products
const adds = await p.$$('.h10-spw-ps-list .row .addbtn')
for (let i = 0; i < Math.min(3, adds.length); i++) { await adds[i].click(); await p.waitForTimeout(150) }
await p.waitForTimeout(300)
const ps2 = await p.$('.h10-spw-ps')
if (ps2) await ps2.screenshot({ path: '/tmp/spw/s1_ps_added_el.png' })
console.log('ps added shot')

// bid multiplier section
const bm = await p.$('#spw-bid-multiplier')
if (bm) await bm.screenshot({ path: '/tmp/spw/s1_bm_el.png' })
console.log('bm shot')

await b.close()
console.log('done')
