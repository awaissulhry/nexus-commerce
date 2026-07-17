import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('.h10-spw-ps-list .row:not(.sk)', { timeout: 15000 }).catch(() => {})
await p.waitForTimeout(600)
await p.locator('#spw-product-selection').scrollIntoViewIfNeeded()
// expand the first family parent
const exp = await p.$('.h10-spw-ps-list .row .exp')
if (exp) { await exp.click(); await p.waitForSelector('.h10-spw-ps-list .row.kid', { timeout: 8000 }).catch(() => {}) }
await p.waitForTimeout(400)
// add one variation + the whole-family "Add all" state
const kidAdd = await p.$('.h10-spw-ps-list .row.kid .addbtn')
if (kidAdd) await kidAdd.click()
await p.waitForTimeout(300)
const el = await p.$('.h10-spw-ps'); if (el) await el.screenshot({ path: '/tmp/spw/ps_variations.png' })
const kids = await p.locator('.h10-spw-ps-list .row.kid').count()
const added = await p.locator('.h10-spw-ps-rlist .row').count()
console.log(JSON.stringify({ childRowsShown: kids, addedCount: added }))
await b.close()
