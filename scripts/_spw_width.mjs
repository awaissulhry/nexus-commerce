import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(2)')
await p.waitForTimeout(400)
await p.screenshot({ path: '/tmp/spw/width.png' })
// measure: right edge of the table card vs the content area
const m = await p.evaluate(() => {
  const card = document.querySelector('.h10-spw-cset-card')
  const main = document.querySelector('.h10-main') || document.body
  const cr = card.getBoundingClientRect(), mr = main.getBoundingClientRect()
  return { cardRight: Math.round(cr.right), cardWidth: Math.round(cr.width), mainRight: Math.round(mr.right), gap: Math.round(mr.right - cr.right) }
})
console.log(JSON.stringify(m))
await b.close()
