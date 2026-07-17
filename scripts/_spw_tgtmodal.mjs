import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(400)

// (1) Brand row (nth 1) → Negative Targeting Edit → two-column editor (xl)
await p.locator('.h10-spw-cset-row').nth(1).locator('.tgt').last().locator('button.edit').click()
await p.waitForTimeout(350)
const negW = await p.locator('.h10-ds-modal').evaluate((e) => Math.round(e.getBoundingClientRect().width))
await p.locator('.h10-ds-modal').screenshot({ path: '/tmp/spw/tgt_neg.png' })
await p.keyboard.press('Escape'); await p.waitForTimeout(250)

// (2) Auto row (nth 0) → Targeting Edit → auto-group editor (md)
await p.locator('.h10-spw-cset-row').nth(0).locator('.tgt').first().locator('button.edit').click()
await p.waitForTimeout(350)
const autoW = await p.locator('.h10-ds-modal').evaluate((e) => Math.round(e.getBoundingClientRect().width))
await p.locator('.h10-ds-modal').screenshot({ path: '/tmp/spw/tgt_auto.png' })
await p.keyboard.press('Escape'); await p.waitForTimeout(250)

// (3) Guard — click footer Next (keyword campaigns have no keywords → guard fires)
await p.locator('.h10-spw-next').click(); await p.waitForTimeout(350)
const guardOk = await p.locator('.h10-ds-modal').count()
await p.locator('.h10-ds-modal').screenshot({ path: '/tmp/spw/tgt_guard.png' }).catch(() => {})

console.log(JSON.stringify({ negW, autoW, guardShown: guardOk }))
await b.close()
for (const f of ['tgt_neg', 'tgt_auto', 'tgt_guard']) execSync(`sips -Z 1300 /tmp/spw/${f}.png --out /tmp/spw/${f}_v.png 2>/dev/null`, { stdio: 'ignore' })
console.log('scaled')
