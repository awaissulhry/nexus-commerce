import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })).newPage()
// mock the AT.3 suggestions endpoint (not deployed locally yet)
await p.route('**/campaign-builder/auto-bid-suggestions*', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, baseCents: 82, accountMedianCpcCents: 82, groups: { CLOSE_MATCH: 82, LOOSE_MATCH: 53, SUBSTITUTES: 90, COMPLEMENTS: 49 } }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(400)
// open the Auto campaign's Targeting editor (row 0, first .tgt)
await p.locator('.h10-spw-cset-row').nth(0).locator('.tgt').first().locator('button.edit').click()
await p.waitForTimeout(450)
const sugCount = await p.locator('.h10-spw-auto-sug').count()
const closeBidBefore = await p.locator('.h10-spw-auto-ed .row').nth(0).locator('.money input').inputValue()
await p.locator('.h10-spw-auto-ed .row').nth(0).locator('.h10-spw-auto-sug').click()
await p.waitForTimeout(150)
const closeBidAfter = await p.locator('.h10-spw-auto-ed .row').nth(0).locator('.money input').inputValue()
await p.locator('.h10-ds-modal').screenshot({ path: '/tmp/spw/at3.png' })
console.log(JSON.stringify({ sugCount, closeBidBefore, closeBidAfter }))
await b.close()
execSync('sips -Z 1200 /tmp/spw/at3.png --out /tmp/spw/at3_v.png 2>/dev/null', { stdio: 'ignore' })
console.log('scaled')
