import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 } })).newPage()
let captured = null
await p.route('**/campaign-builder/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, totalCampaigns: 6, created: [] }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(300)
// Brand keywords
await p.locator('.h10-spw-cs-ktrow').first().locator('.kwbtn').click()
await p.waitForTimeout(150)
await p.fill('.h10-spw-cs-pop textarea', 'alpha\nbeta')
await p.click('.h10-spw-cs-pop .apply')
await p.waitForTimeout(200)
// step 3 → Launch
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(300)
await p.click('.h10-spw-next')
await p.waitForURL('**/marketing/ads/campaigns', { timeout: 8000 }).catch(() => {})
let out = { posted: !!captured }
try {
  const j = JSON.parse(captured)
  const brand = (j.campaigns || []).find((c) => /Brand/.test(c.name))
  out = { posted: true, campaignCount: j.campaigns.length, names: j.campaigns.map((c) => c.name), brandKeywords: brand ? brand.keywords : null }
} catch { out.err = 'no/invalid payload' }
console.log(JSON.stringify(out))
await b.close()
