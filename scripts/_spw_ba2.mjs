import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(400)

// BULK SET BID — select all, set 1.50
await p.click('.h10-spw-cset-head .ck input'); await p.waitForTimeout(150)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Set bid' }).click(); await p.waitForTimeout(150)
await p.fill('.h10-modal.bulk.sm input', '1.50')
await p.locator('.h10-modal.bulk .h10-am-btn.primary').click(); await p.waitForTimeout(250)
const bids = await p.$$eval('.h10-spw-cset-row .bid input', (els) => els.filter((_, i) => i % 2 === 0).map((e) => e.value))
await p.locator('.h10-spw-bulk-clear').click(); await p.waitForTimeout(150)

// BULK NEGATIVES — select keyword campaigns, add "junk" neg-exact
await p.click('.h10-spw-cset-select > button'); await p.waitForTimeout(150)
await p.locator('.h10-spw-cset-select .menu button', { hasText: 'Keyword campaigns' }).click(); await p.waitForTimeout(200)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Negatives' }).click(); await p.waitForTimeout(200)
await p.fill('.h10-spw-bulk-ta', 'junk'); await p.locator('.h10-modal.bulk .h10-am-btn.primary').click(); await p.waitForTimeout(250)
const negCounts = await p.$$eval('.h10-spw-cset-row', (rows) => rows.map((r) => `${r.querySelector('.ag .agb input')?.value}: ${[...r.querySelectorAll('.tgt')].pop()?.querySelector('.ct')?.textContent?.trim()}`))
await p.locator('.h10-spw-bulk-clear').click(); await p.waitForTimeout(150)

// BULK DELETE — select PAT, delete
await p.click('.h10-spw-cset-select > button'); await p.waitForTimeout(150)
await p.locator('.h10-spw-cset-select .menu button', { hasText: 'Product (PAT)' }).click(); await p.waitForTimeout(200)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Delete' }).click(); await p.waitForTimeout(250)
const afterDelete = await p.locator('.h10-spw-cset-top .cnt').innerText()
const names = await p.$$eval('.h10-spw-cset-row .ag .agb input', (els) => els.map((e) => e.value))

console.log(JSON.stringify({ bids, negCounts, afterDelete: afterDelete.trim(), names }, null, 2))
await b.close()
