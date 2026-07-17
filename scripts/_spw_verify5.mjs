import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.click('.h10-spw-steps button:nth-of-type(2)')
await p.waitForTimeout(400)

// open keyword targeting on row index 1 (Brand)
await p.locator('.h10-spw-cset-row').nth(1).locator('.tgt').first().locator('.edit').click()
await p.waitForTimeout(250)
await p.fill('.h10-neg-ta', 'alpha\nbeta\ngamma')
await p.click('.h10-neg-add')             // stage
await p.waitForTimeout(150)
const stagedCount = await p.locator('.h10-neg-row').count()
await p.click('.h10-modal-f .h10-am-btn.primary') // Save
await p.waitForTimeout(300)
const cellText = (await p.locator('.h10-spw-cset-row').nth(1).locator('.tgt').first().locator('.ct').innerText()).trim()

// now hit Next — guard should still appear but with a count reduced by 1 (4 -> 3)
await p.click('.h10-spw-next')
await p.waitForTimeout(250)
const guard = await p.$('.h10-spw-guard p')
const guardText = guard ? (await guard.innerText()).trim() : '(no guard)'

console.log(JSON.stringify({ staged: stagedCount, targetingCell: cellText, guard: guardText }))
await b.close()
