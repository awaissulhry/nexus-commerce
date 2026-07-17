import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(900)

const measure = async () => p.evaluate(() => {
  const r = (el) => el ? (({ x, right, width }) => ({ x: Math.round(x), right: Math.round(right), w: Math.round(width) }))(el.getBoundingClientRect()) : null
  const all = [...document.querySelectorAll('button, a, div')]
  const fab = all.find((e) => /ask ai/i.test(e.textContent || '') && e.getBoundingClientRect().bottom > window.innerHeight - 120 && e.getBoundingClientRect().width < 260)
  const next = document.querySelector('.h10-spw-next')
  const spw = document.querySelector('.h10-spw')
  const nr = next?.getBoundingClientRect(), fr = fab?.getBoundingClientRect()
  return { spw: r(spw), next: r(next), fab: r(fab), nextClearsFab: nr && fr ? Math.round(fr.left - nr.right) : null }
})

const step1 = await measure()
// go to step 2
await p.click('.h10-spw-steps button:nth-of-type(2)')
await p.waitForTimeout(400)
await p.screenshot({ path: '/tmp/spw/scope_step2.png' })
const step2 = await measure()
// back to step 1, screenshot
await p.click('.h10-spw-steps button:nth-of-type(1)')
await p.waitForTimeout(400)
await p.screenshot({ path: '/tmp/spw/scope_step1.png' })

console.log(JSON.stringify({ step1, step2 }, null, 2))
await b.close()
