import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(450)

// Harvest tab: set a rule name + tick a create-target cell
await p.locator('.h10-spw-rules-rn input').fill('Harvest A')
const harvestCols = await p.locator('.h10-spw-mx .badges > span').count()

// Switch to Negative Targeting → separate rule (own empty name), narrower matrix
await p.locator('.h10-spw-rules-tabs button', { hasText: 'Negative Targeting' }).click()
await p.waitForTimeout(250)
const negName = await p.locator('.h10-spw-rules-rn input').inputValue()
const negCols = await p.locator('.h10-spw-mx .badges > span').count()
const hasCreateHeader = await p.locator('.h10-spw-mx .sub .c-t').count()
await p.locator('.h10-spw-mx').scrollIntoViewIfNeeded()
await p.locator('.h10-spw-mx').screenshot({ path: '/tmp/spw/s34_neg.png' })
await p.locator('.h10-spw-rules-rn input').fill('Neg B')

// Back to Harvest → name preserved (separate rules)
await p.locator('.h10-spw-rules-tabs button', { hasText: 'Keyword Harvesting' }).click()
await p.waitForTimeout(200)
const backName = await p.locator('.h10-spw-rules-rn input').inputValue()

console.log(JSON.stringify({ harvestBadges: harvestCols, negBadges: negCols, hasCreateHeaderOnNeg: hasCreateHeader, negNameWhenSwitched: negName, harvestNameAfterRoundtrip: backName }))
await b.close()
execSync('sips -Z 1300 /tmp/spw/s34_neg.png --out /tmp/spw/s34_neg_v.png 2>/dev/null', { stdio: 'ignore' })
console.log('scaled')
