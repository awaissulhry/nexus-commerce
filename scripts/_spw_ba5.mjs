import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(400)

// select all → screenshot the (busier) bulk bar
await p.click('.h10-spw-cset-head .ck input'); await p.waitForTimeout(150)
await p.screenshot({ path: '/tmp/spw/ba5_bar.png' })

// Clear dropdown open → screenshot
await p.locator('.h10-spw-bulk-clearwrap > button').click(); await p.waitForTimeout(150)
await p.screenshot({ path: '/tmp/spw/ba5_clearmenu.png' })
await p.keyboard.press('Escape'); await p.locator('.h10-spw-bulk-clearwrap > button').click({ force: true }).catch(() => {}) // close
await p.waitForTimeout(100)

// Adjust bid +20% (defaults 0.75 → 0.90)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Adjust bid %' }).click(); await p.waitForTimeout(150)
await p.screenshot({ path: '/tmp/spw/ba5_adjust.png' })
await p.fill('.h10-modal.bulk input', '20'); await p.locator('.h10-modal.bulk .h10-am-btn.primary').click(); await p.waitForTimeout(250)
const bids = await p.$$eval('.h10-spw-cset-row .bid input', (els) => els.filter((_, i) => i % 2 === 0).map((e) => e.value))

// Rename prefix "Q1-" (selection persists)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Rename' }).click(); await p.waitForTimeout(150)
await p.screenshot({ path: '/tmp/spw/ba5_rename.png' })
await p.locator('.h10-spw-bulk-val input.txt').first().fill('Q1-'); await p.locator('.h10-modal.bulk .h10-am-btn.primary').click(); await p.waitForTimeout(250)
const names = await p.$$eval('.h10-spw-cset-row .ag .agb input', (els) => els.map((e) => e.value))

// Clear keywords: deselect, select keyword campaigns, add kw, clear keywords
await p.locator('.h10-spw-bulk-clear').click(); await p.waitForTimeout(120)
await p.click('.h10-spw-cset-select > button'); await p.waitForTimeout(120)
await p.locator('.h10-spw-cset-select .menu button', { hasText: 'Keyword campaigns' }).click(); await p.waitForTimeout(150)
await p.locator('.h10-spw-bulk-btn', { hasText: 'Keywords' }).click(); await p.waitForTimeout(150)
await p.fill('.h10-spw-bulk-ta', 'temp1\ntemp2'); await p.locator('.h10-modal.bulk .h10-am-btn.primary').click(); await p.waitForTimeout(200)
const beforeClear = await p.locator('.h10-spw-cset-row').nth(1).locator('.tgt .ct').first().innerText()
await p.locator('.h10-spw-bulk-clearwrap > button').click(); await p.waitForTimeout(120)
await p.locator('.h10-spw-bulk-clearwrap .menu button', { hasText: 'Keywords' }).click(); await p.waitForTimeout(200)
const afterClear = await p.locator('.h10-spw-cset-row').nth(1).locator('.tgt .ct').first().innerText()

console.log(JSON.stringify({ bids, names, beforeClear: beforeClear.trim(), afterClear: afterClear.trim() }, null, 2))
await b.close()
for (const f of ['ba5_bar', 'ba5_clearmenu', 'ba5_adjust', 'ba5_rename']) execSync(`sips -Z 1500 /tmp/spw/${f}.png --out /tmp/spw/${f}_v.png`, { stdio: 'ignore' })
console.log('scaled')
