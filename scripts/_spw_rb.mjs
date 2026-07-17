import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const URL = 'http://localhost:3000/marketing/ads/rules-automation/builder/keyword-harvesting'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })).newPage()
const errs = []
p.on('pageerror', (e) => errs.push(String(e)))
const resp = await p.goto(URL, { waitUntil: 'domcontentloaded' }).catch((e) => ({ status: () => 'ERR ' + e }))
await p.waitForTimeout(1500)
// look for the criteria section + a metric token
const probe = await p.evaluate(() => {
  const txt = document.body.innerText
  return {
    hasCriteria: /Criteria/i.test(txt),
    hasMetricWord: /(PPC Orders|ACOS|Greater than)/i.test(txt),
    appError: /Application error|Internal Server Error|Unhandled/i.test(txt),
    bodyLen: txt.length,
  }
})
await p.screenshot({ path: '/tmp/spw/rb.png' })
console.log(JSON.stringify({ http: typeof resp?.status === 'function' ? resp.status() : resp, probe, pageErrors: errs.slice(0, 3) }))
await b.close()
execSync('sips -Z 1400 /tmp/spw/rb.png --out /tmp/spw/rb_v.png 2>/dev/null', { stdio: 'ignore' })
console.log('scaled')
