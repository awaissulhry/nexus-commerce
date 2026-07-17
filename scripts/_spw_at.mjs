import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })).newPage()
let captured = null
await p.route('**/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: [], totalCampaigns: 0 }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)

// Step 2 (Standard default → Auto is the first campaign row)
await p.click('.h10-spw-steps button:nth-of-type(2)')
await p.waitForTimeout(350)
const autoRow = p.locator('.h10-spw-cset-row').first()
await autoRow.locator('.tgt').first().locator('button.edit').click()
await p.waitForTimeout(350)
await p.locator('.h10-modal').screenshot({ path: '/tmp/spw/at_editor.png' })

// toggle Loose match (row 2) OFF + bump Close (row 1) bid
await p.locator('.h10-spw-auto-ed .row').nth(1).locator('input[type=checkbox]').uncheck()
await p.locator('.h10-spw-auto-ed .row').nth(0).locator('.bid input').fill('1.20')
await p.click('.h10-modal-f .primary')
await p.waitForTimeout(300)
const tgtLabel = (await autoRow.locator('.tgt').first().locator('.ct').innerText()).trim()

// launch → assert payload
await p.click('.h10-spw-steps button:nth-of-type(3)')
await p.waitForTimeout(300)
await p.click('.h10-spw-next')
await p.waitForTimeout(600)

let out = { tgtLabel }
try {
  const j = JSON.parse(captured)
  const auto = j.campaigns.find((c) => c.kind === 'auto')
  out.autoGroups = auto?.autoGroups ?? null
} catch (e) { out.err = String(e) }
console.log(JSON.stringify(out, null, 2))
await b.close()
execSync('sips -Z 1300 /tmp/spw/at_editor.png --out /tmp/spw/at_editor_v.png', { stdio: 'ignore' })
console.log('scaled')
