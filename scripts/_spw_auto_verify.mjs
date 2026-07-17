import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(900)
await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(500)

// 1) Automate default-on?
const autoChecked = await p.locator('.h10-spw-rules-auto input.h10-spw-sw').first().isChecked().catch(() => null)

// 2) open Performance Criteria → white container?
await p.locator('.h10-spw-perf').click(); await p.waitForTimeout(300)
const perf = p.locator('.h10-spw-perf-body')
const styles = await perf.evaluate((el) => {
  const s = getComputedStyle(el)
  return { background: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopColor, radius: s.borderTopLeftRadius, padding: s.paddingTop + ' ' + s.paddingLeft }
}).catch(() => null)

execSync('mkdir -p /tmp/spw', { stdio: 'ignore' })
await p.locator('.h10-spw-rules').screenshot({ path: '/tmp/spw/auto.png' }).catch(async () => { await p.screenshot({ path: '/tmp/spw/auto.png', fullPage: true }) })
console.log(JSON.stringify({ autoChecked, perfStyles: styles }, null, 2))
await b.close()
execSync('sips -Z 1400 /tmp/spw/auto.png --out /tmp/spw/auto_v.png 2>/dev/null', { stdio: 'ignore' })
