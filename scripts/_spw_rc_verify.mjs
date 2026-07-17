import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(700)

// Rule Setting is the default automation mode. Find the Control preview card (contains the canvas).
const card = p.locator('.h10-spw-card', { hasText: 'Control preview' }).last()
await card.scrollIntoViewIfNeeded(); await p.waitForTimeout(600)
const canvasPresent = await card.locator('.apc-wrap').count()
const moduleNodes = await card.locator('.apc-module').count()
const goalText = (await card.locator('.apc-goal b').first().innerText().catch(() => '')).trim()

// Toggle the "Keyword Harvest" lever and confirm its on/off class flips.
const harvest = card.locator('.apc-module', { hasText: 'Keyword Harvest' }).first()
const before = await harvest.getAttribute('class')
await harvest.click(); await p.waitForTimeout(350)
const after = await harvest.getAttribute('class')

execSync('mkdir -p /tmp/spw', { stdio: 'ignore' })
await card.screenshot({ path: '/tmp/spw/rc.png' })
console.log(JSON.stringify({ canvasPresent, moduleNodes, goalText, harvestToggled: before !== after, before: before?.includes('on') ? 'on' : 'off', after: after?.includes('on') ? 'on' : 'off' }))
await b.close()
execSync('sips -Z 1400 /tmp/spw/rc.png --out /tmp/spw/rc_v.png 2>/dev/null', { stdio: 'ignore' })
