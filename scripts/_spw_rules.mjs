import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 } })).newPage()
let captured = null
await p.route('**/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: [], totalCampaigns: 0, rule: { id: 'r1', name: 'x' } }) })
})
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(800)
// jump to Step 3
await p.click('.h10-spw-steps button:nth-of-type(3)')
await p.waitForTimeout(400)
// rule name
await p.fill('.h10-spw-rules-rn input', 'Harvest Test')
// harvest from the Auto row (row 0); graduate Exact on the Brand row (row 1)
await p.locator('.h10-spw-mx-grid.row').nth(0).locator('.c-st input').check()
await p.locator('.h10-spw-mx-grid.row').nth(1).locator('.b5 input').check()
// performance criteria
await p.click('.h10-spw-perf')
await p.waitForTimeout(150)
await p.fill('.h10-spw-perf-row input', '3')
// launch
await p.click('.h10-spw-next')
await p.waitForTimeout(500)

let out = {}
try {
  const j = JSON.parse(captured)
  const rows = j.rules?.rows ?? {}
  out = {
    posted: true,
    ruleName: j.rules?.ruleName,
    automate: j.rules?.automate,
    perf: j.rules?.perf,
    autoRow_st: rows['cmp-0']?.st ?? null,
    brandRow_tE: rows['cmp-1']?.tE ?? null,
    rowKeys: Object.keys(rows),
  }
} catch (e) { out = { posted: !!captured, err: String(e) } }
console.log(JSON.stringify(out, null, 2))
await b.close()
