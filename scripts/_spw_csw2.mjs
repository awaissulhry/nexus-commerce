import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(300)

// open Brand's keyword editor + enter 3 keywords
await p.locator('.h10-spw-cs-ktrow').first().locator('.kwbtn').click()
await p.waitForTimeout(200)
await p.fill('.h10-spw-cs-pop textarea', 'moto jacket\nbrand alpha\nbrand beta')
const cardEl = await p.$('.h10-spw-st-card'); if (cardEl) await cardEl.screenshot({ path: '/tmp/spw/csw2_pop.png' })
await p.click('.h10-spw-cs-pop .apply')
await p.waitForTimeout(250)
const btnText = (await p.locator('.h10-spw-cs-ktrow').first().locator('.kwbtn').innerText()).trim()
// rename test
await p.locator('.h10-spw-cs-ktrow').first().locator('.chipname').fill('My Brand')
await p.waitForTimeout(150)

// step 2 → Brand-Broad campaign targeting count
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(350)
const row1 = p.locator('.h10-spw-cset-row').nth(1)
const row1Name = await row1.locator('.ag .agb input').inputValue()
const row1Tgt = (await row1.locator('.tgt').first().locator('.ct').innerText().catch(() => '?')).trim()
const guard = await p.evaluate(() => {
  const btn = document.querySelector('.h10-spw-next')
  return btn ? btn.textContent : ''
})
console.log(JSON.stringify({ btnText, row1Name, row1Tgt }))
await b.close()
