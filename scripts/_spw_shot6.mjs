import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.click('.h10-spw-steps button:nth-of-type(3)') // step 3
await p.waitForTimeout(500)
for (const [sel, name] of [['.h10-spw-pgd', 'pgd'], ['.h10-spw-sum', 'sum'], ['.h10-spw-rules', 'rules']]) {
  const el = await p.$(sel)
  if (el) { await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(150); await el.screenshot({ path: `/tmp/spw/s3_${name}.png` }); console.log(name) }
}
await b.close()
console.log('done')
