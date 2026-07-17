import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('.h10-spw-ps-list .row:not(.sk)', { timeout: 15000 }).catch(() => {})
await p.waitForTimeout(500)

// Bid Multiplier (shared PlacementBidMultiplier)
await p.locator('#spw-bid-multiplier').scrollIntoViewIfNeeded()
await p.waitForTimeout(300)
let el = await p.$('#spw-bid-multiplier'); if (el) await el.screenshot({ path: '/tmp/spw/bm_shared.png' })
console.log('bm')

// Custom Scheme tab
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.waitForTimeout(300)
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(300)
el = await p.$('.h10-spw-st-card'); if (el) await el.screenshot({ path: '/tmp/spw/cs_built.png' })
console.log('cs')

await b.close()
console.log('done')
