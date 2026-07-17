import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(450)
// expand Performance Criteria (harvest tab)
await p.locator('.h10-spw-perf').click(); await p.waitForTimeout(250)
const harvestSeed = await p.locator('.h10-pc-row').first().evaluate((el) => ({ metric: el.querySelector('select')?.value, op: [...el.querySelectorAll('select')][1]?.value, value: el.querySelector('input')?.value }))
const condCount1 = await p.locator('.h10-pc-row').count()
// add a condition
await p.locator('.h10-pc-add').click(); await p.waitForTimeout(150)
const condCount2 = await p.locator('.h10-pc-row').count()
await p.locator('.h10-spw-perf-body').scrollIntoViewIfNeeded()
await p.locator('.h10-spw-perf-body').screenshot({ path: '/tmp/spw/pc.png' })
// switch to Negative tab → its perf seed differs (Sales = 0)
await p.locator('.h10-spw-rules-tabs button', { hasText: 'Negative Targeting' }).click(); await p.waitForTimeout(200)
await p.locator('.h10-spw-perf').click().catch(() => {}); await p.waitForTimeout(200)
const negSeed = await p.locator('.h10-pc-row').first().evaluate((el) => ({ metric: el.querySelector('select')?.value, value: el.querySelector('input')?.value })).catch(() => null)
console.log(JSON.stringify({ harvestSeed, condCount1, condCount2, negSeed }))
await b.close()
execSync('sips -Z 1300 /tmp/spw/pc.png --out /tmp/spw/pc_v.png 2>/dev/null', { stdio: 'ignore' })
console.log('scaled')
