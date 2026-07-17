import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
let captured = null
await p.route('**/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: [], totalCampaigns: 0, rules: [] }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(450)

// Target ACoS → 25
await p.locator('.h10-spw-bidnum input').first().fill('25')
// a harvest rule name + a negative rule name (separate rules)
await p.locator('.h10-spw-rules-rn input').fill('HarvestRule')
await p.locator('.h10-spw-rules-tabs button', { hasText: 'Negative Targeting' }).click(); await p.waitForTimeout(200)
await p.locator('.h10-spw-rules-rn input').fill('NegRule')

// Launch
await p.locator('.h10-spw-next').click(); await p.waitForTimeout(600)

let out = {}
try {
  const j = JSON.parse(captured)
  out = {
    automationMode: j.automationMode,
    bidConfig: j.bidConfig,
    harvestRule: j.rules?.harvest?.ruleName ?? null,
    negativeRule: j.rules?.negative?.ruleName ?? null,
  }
} catch (e) { out = { err: String(e), posted: !!captured } }
console.log(JSON.stringify(out, null, 2))
await b.close()
