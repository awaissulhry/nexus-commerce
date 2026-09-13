import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from '@playwright/test'
import { authenticatedStudioPage } from '../../../../scripts/studio-browser-auth.mjs'

const phase = process.argv[2]
assert.ok(['before','after'].includes(phase))
const productId = 'cmokmy3a40078pm0p1fvnu523'
const browser = await chromium.launch({ headless: true })
try {
  const page = await authenticatedStudioPage(browser, { base: 'http://localhost:3000', viewport: { width: 1440, height: 1000 } })
  // A stable same-origin document, without a studio readiness request warming this measurement.
  await page.goto('http://localhost:3000/design/language-axis', { waitUntil: 'domcontentloaded' })
  const measured = []
  const read = async query => page.evaluate(async ({productId, query}) => {
    const start = performance.now()
    const response = await fetch(`http://localhost:8091/api/products/${productId}/readiness?${query}`, { credentials: 'include', cache: 'no-store' })
    const body = await response.json()
    return { at: new Date().toISOString(), status: response.status, wallMs: performance.now() - start, serverTiming: response.headers.get('server-timing'), body }
  }, {productId,query})
  for (let run = 1; run <= 3; run++) {
    const result = await read('market=DE&locale=de')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.ok(result.body.scopes.some(scope => scope.id === 'master'))
    measured.push({run,...result})
    console.log(JSON.stringify({run,status:result.status,wallMs:result.wallMs,serverTiming:result.serverTiming,scopes:result.body.scopes.map(({id,pct,state,required})=>({id,pct,state,required}))}))
  }
  const shared = []
  for (const market of ['DE','IT']) {
    const result = await read(`market=${market}&locale=de&workspace=1`)
    assert.equal(result.status, 200)
    shared.push({market, ...result})
  }
  fs.writeFileSync(new URL(`${phase}-measurements.json`,import.meta.url), JSON.stringify({at:new Date().toISOString(),productId,phase,cache:'existing process and schema caches; no restart',measured,shared},null,2)+'\n')
} finally { await browser.close() }
