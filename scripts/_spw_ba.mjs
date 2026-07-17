import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)') // Step 2
await p.waitForTimeout(400)

// (a) default — checkbox column + Select dropdown
await p.screenshot({ path: '/tmp/spw/ba_default.png' })

// (b) Select dropdown open
await p.click('.h10-spw-cset-select > button')
await p.waitForTimeout(200)
await p.screenshot({ path: '/tmp/spw/ba_selectmenu.png' })

// pick "Keyword campaigns" → bulk bar appears
await p.locator('.h10-spw-cset-select .menu button', { hasText: 'Keyword campaigns' }).click()
await p.waitForTimeout(250)
await p.screenshot({ path: '/tmp/spw/ba_bulkbar.png' })
const selText = (await p.locator('.h10-spw-cset-top .cnt.sel').innerText()).trim()

// (c) bulk add keywords modal
await p.locator('.h10-spw-bulk-btn', { hasText: 'Keywords' }).click()
await p.waitForTimeout(250)
await p.screenshot({ path: '/tmp/spw/ba_kwmodal.png' })
await p.fill('.h10-spw-bulk-ta', 'alpha\nbeta\nalpha')
await p.locator('.h10-modal.bulk .h10-am-btn.primary').click()
await p.waitForTimeout(300)

// functional check: keyword rows now show "Keyword : 2"; Auto row unaffected
const counts = await p.$$eval('.h10-spw-cset-row', (rows) => rows.map((r) => {
  const name = r.querySelector('.ag .agb input')?.value || ''
  const tgt = r.querySelector('.tgt .ct')?.textContent?.trim() || ''
  return `${name} → ${tgt}`
}))
console.log(JSON.stringify({ selText, counts }, null, 2))
await b.close()
for (const f of ['ba_default', 'ba_selectmenu', 'ba_bulkbar', 'ba_kwmodal']) execSync(`sips -Z 1500 /tmp/spw/${f}.png --out /tmp/spw/${f}_v.png`, { stdio: 'ignore' })
console.log('scaled')
