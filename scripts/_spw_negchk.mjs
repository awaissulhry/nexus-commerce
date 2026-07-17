import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 } })).newPage()
let captured = null
await p.route('**/sp-super-wizard/launch', async (route) => {
  captured = route.request().postData()
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
})

const run = async (ticks /* which match types to enable on Brand */) => {
  captured = null
  await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(700)
  await p.locator('#spw-structure').scrollIntoViewIfNeeded()
  await p.click('.h10-spw-st-tabs button:nth-child(3)'); await p.waitForTimeout(300)
  const brand = p.locator('.h10-spw-cs-ktrow').first()
  // match types: nth0 Broad (on by default), nth1 Phrase, nth2 Exact
  if (ticks.includes('P')) await brand.locator('.mts label').nth(1).locator('input').check()
  if (ticks.includes('E')) await brand.locator('.mts label').nth(2).locator('input').check()
  await brand.locator('.kwbtn').click(); await p.waitForTimeout(150)
  await p.fill('.h10-spw-cs-pop textarea', 'moto jacket'); await p.click('.h10-spw-cs-pop .apply'); await p.waitForTimeout(250)
  await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(300)
  await p.click('.h10-spw-next'); await p.waitForTimeout(500)
  const j = JSON.parse(captured)
  const fmt = (c) => `${c.name}: [${(c.negKeywords || []).map((n) => `${n.text}/${n.matchType}`).join(', ') || '—'}]`
  return j.campaigns.filter((c) => /Brand|Auto/.test(c.name)).map(fmt)
}

console.log('── Brand = Broad + Exact (NO Phrase) ──')
console.log((await run(['E'])).join('\n'))
console.log('\n── Brand = Broad + Phrase + Exact ──')
console.log((await run(['P', 'E'])).join('\n'))
await b.close()
