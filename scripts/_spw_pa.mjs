import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })).newPage()
let captured = null
await p.route('**/advertising/portfolios?**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ portfolios: [{ portfolioId: 'PF-A', name: 'Brand — Core' }, { portfolioId: 'PF-B', name: 'Seasonal' }] }) })
})
await p.route('**/advertising/portfolios', async (route) => {
  if (route.request().method() === 'POST') await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, portfolio: { portfolioId: 'PF-NEW', name: 'Spring Launch' }, mode: 'local' }) })
  else await route.continue()
})
await p.route('**/sp-super-wizard/launch', async (route) => { captured = route.request().postData(); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: [], totalCampaigns: 0 }) }) })

await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(450)
await p.locator('.h10-spw-pgd-port').click(); await p.waitForTimeout(300)
const triggerBefore = (await p.locator('.h10-spw-pf button[aria-haspopup]').innerText()).trim()
// create a portfolio
await p.locator('.h10-spw-pf-new').click(); await p.waitForTimeout(250)
await p.fill('.h10-ds-modal input', 'Spring Launch')
await p.locator('.h10-ds-modal .h10-ds-btn.primary').click(); await p.waitForTimeout(350)
const triggerAfter = (await p.locator('.h10-spw-pf button[aria-haspopup]').innerText()).trim()
await p.locator('.h10-spw-pgd').screenshot({ path: '/tmp/spw/pa.png' })
// launch → assert portfolioId in payload
await p.locator('.h10-spw-next').click(); await p.waitForTimeout(500)
let payloadPf = null; try { payloadPf = JSON.parse(captured).portfolioId } catch {}
console.log(JSON.stringify({ triggerBefore, triggerAfter, payloadPortfolioId: payloadPf }))
await b.close()
execSync('sips -Z 1200 /tmp/spw/pa.png --out /tmp/spw/pa_v.png 2>/dev/null', { stdio: 'ignore' })
