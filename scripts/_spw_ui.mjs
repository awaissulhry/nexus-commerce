import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(900)
await p.screenshot({ path: '/tmp/spw/ui_step1.png' })

const rects = await p.evaluate(() => {
  const pick = (el) => el ? (({ x, right, bottom, width, height }) => ({ x: Math.round(x), right: Math.round(right), bottom: Math.round(bottom), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect()) : null
  // Ask AI FAB — find by text
  const all = [...document.querySelectorAll('button, a, div')]
  const fab = all.find((e) => /ask ai/i.test(e.textContent || '') && e.getBoundingClientRect().bottom > window.innerHeight - 120 && e.getBoundingClientRect().width < 260)
  return {
    next: pick(document.querySelector('.h10-spw-next')),
    foot: pick(document.querySelector('.h10-spw-foot')),
    askAI: pick(fab),
    prodPanel: pick(document.querySelector('.h10-spw-ps') || document.querySelector('[id*=product-selection]')),
    viewportW: window.innerWidth,
  }
})
console.log(JSON.stringify(rects, null, 2))
await b.close()
