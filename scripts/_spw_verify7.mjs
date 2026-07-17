import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
let captured = null
await p.route('**/campaign-builder/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: [{ name: 'x', campaignId: 'c1', mode: 'local' }], totalCampaigns: 5 }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.click('.h10-spw-steps button:nth-of-type(3)') // step 3
await p.waitForTimeout(300)
await p.click('.h10-spw-next') // Launch
await p.waitForURL('**/marketing/ads/campaigns', { timeout: 8000 }).catch(() => {})
const finalUrl = p.url()
let payloadOk = false, summary = ''
try { const j = JSON.parse(captured); payloadOk = Array.isArray(j.campaigns) && j.campaigns.length > 0; summary = `campaigns=${j.campaigns.length} products=${(j.products || []).length} placementBids=${JSON.stringify(j.placementBids)} market=${j.market}` } catch { summary = '(no/invalid payload)' }
console.log(JSON.stringify({ posted: !!captured, payloadOk, summary, redirectedTo: finalUrl.replace('http://localhost:3000', '') }))
await b.close()
