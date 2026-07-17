import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 } })).newPage()
let captured = null
await p.route('**/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: [], totalCampaigns: 0 }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(300)

// Brand (first row): tick Phrase + Exact (Broad already on)
const brandRow = p.locator('.h10-spw-cs-ktrow').first()
await brandRow.locator('.mts label').nth(1).locator('input').check() // Phrase
await brandRow.locator('.mts label').nth(2).locator('input').check() // Exact
// Brand keywords
await brandRow.locator('.kwbtn').click()
await p.waitForTimeout(150)
await p.fill('.h10-spw-cs-pop textarea', 'moto jacket')
await p.click('.h10-spw-cs-pop .apply')
await p.waitForTimeout(250)

// jump to Step 3 via stepper (bypasses the missing-targeting guard), then Launch
await p.click('.h10-spw-steps button:nth-of-type(3)')
await p.waitForTimeout(300)
await p.click('.h10-spw-next')
await p.waitForTimeout(600)

const fmt = (ns) => (ns || []).map((n) => `${n.text}:${n.matchType}`).sort().join(', ') || '(none)'
let out = { posted: !!captured }
try {
  const j = JSON.parse(captured)
  out = {
    posted: true,
    campaigns: j.campaigns.map((c) => ({ name: c.name, match: c.matchType, kind: c.kind, pos: c.keywords, neg: fmt(c.negKeywords) })),
  }
} catch (e) { out.err = String(e) }
console.log(JSON.stringify(out, null, 2))
await b.close()
