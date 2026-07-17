import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(300)
const brandRow = p.locator('.h10-spw-cs-ktrow').first()
await brandRow.locator('.mts label').nth(1).locator('input').check()
await brandRow.locator('.mts label').nth(2).locator('input').check()
await brandRow.locator('.kwbtn').click()
await p.waitForTimeout(150)
await p.fill('.h10-spw-cs-pop textarea', 'moto jacket')
await p.click('.h10-spw-cs-pop .apply')
await p.waitForTimeout(250)

// (1) structure card incl. the auto-negate toggle
await p.locator('.h10-spw-st-card').screenshot({ path: '/tmp/spw/nt_toggle.png' })

// (2) Step 2 → Brand-Broad negative drawer (shows auto badges)
await p.click('.h10-spw-steps button:nth-of-type(2)')
await p.waitForTimeout(350)
const broadRow = p.locator('.h10-spw-cset-row').nth(1) // Auto=0, Brand-Broad=1
await broadRow.locator('.tgt').last().locator('button.edit').click()
await p.waitForTimeout(350)
await p.locator('.h10-modal').screenshot({ path: '/tmp/spw/nt_drawer.png' })
console.log('shot')
await b.close()

for (const f of ['nt_toggle', 'nt_drawer']) {
  execSync(`sips -Z 1400 /tmp/spw/${f}.png --out /tmp/spw/${f}_v.png`, { stdio: 'ignore' })
}
console.log('scaled')
