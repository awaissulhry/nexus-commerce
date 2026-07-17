import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(350)

const ph = async () => (await p.locator('.h10-spw-cs-preview .ph').innerText()).replace(/\s+/g, ' ').trim()
const names = async () => p.$$eval('.h10-spw-cs-preview li:not(.more)', (els) => els.map((e) => e.textContent))

const count1 = await ph()
const names1 = await names()
const cardEl = await p.$('.h10-spw-st-card'); if (cardEl) await cardEl.screenshot({ path: '/tmp/spw/csw3.png' })

// remove the 4th Campaign-Name token (Keyword Type) → keyword names should drop the keyword-type segment
await p.locator('.h10-spw-cs-tokens .h10-spw-cs-token').nth(3).locator('.x').click()
await p.waitForTimeout(250)
const names2 = await names()

console.log(JSON.stringify({ count1, names1: names1.slice(0, 4), afterRemovingKeywordTypeToken: names2.slice(0, 4) }))
await b.close()
