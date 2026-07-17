import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(450)

// (1) top of Step 3 — automation mode + bid strategy + target acos
await p.screenshot({ path: '/tmp/spw/s3_top.png' })

// detect sections present
const present = await p.evaluate(() => ({
  autom: !!document.querySelector('.h10-spw-autom'),
  bidstrat: document.querySelectorAll('.h10-spw-bidcard').length,
  targetAcos: !!document.querySelector('.h10-spw-bidnum'),
  rec: !!document.querySelector('.h10-spw-bc-t .rec'),
}))

// (2) switch to AI Control → bid strategy should disappear, AI note appear
await p.locator('.h10-spw-autom .h10-ds-radiocard', { hasText: 'AI Control' }).click()
await p.waitForTimeout(300)
await p.screenshot({ path: '/tmp/spw/s3_ai.png' })
const aiState = await p.evaluate(() => ({ ainote: !!document.querySelector('.h10-spw-ainote'), bidstratGone: document.querySelectorAll('.h10-spw-bidcard').length === 0 }))

console.log(JSON.stringify({ present, aiState }))
await b.close()
for (const f of ['s3_top', 's3_ai']) execSync(`sips -Z 1400 /tmp/spw/${f}.png --out /tmp/spw/${f}_v.png 2>/dev/null`, { stdio: 'ignore' })
console.log('scaled')
