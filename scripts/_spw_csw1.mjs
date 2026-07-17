import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 } })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)

// select Custom Scheme
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)')
await p.waitForTimeout(300)

const countAt = async () => (await p.locator('.h10-spw-cset-top .cnt').innerText()).trim()
const names = async () => p.$$eval('.h10-spw-cset-row .ag .agb input', (els) => els.slice(0, 8).map((e) => e.value))

await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(350)
const defCount = await countAt()
const defNames = await names()

// back to step 1, tick Brand → Phrase + Exact (2 more campaigns)
await p.click('.h10-spw-steps button:nth-of-type(1)'); await p.waitForTimeout(300)
await p.locator('#spw-structure').scrollIntoViewIfNeeded(); await p.waitForTimeout(150)
await p.locator('.h10-spw-cs-ktrow').first().locator('.mts label').nth(1).locator('input').check()
await p.locator('.h10-spw-cs-ktrow').first().locator('.mts label').nth(2).locator('input').check()
await p.waitForTimeout(200)
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(350)
const afterCount = await countAt()
const afterNames = await names()

console.log(JSON.stringify({ defCount, defNames, afterCount, afterNames }, null, 0))
await b.close()
