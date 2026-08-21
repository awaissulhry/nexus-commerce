import { chromium } from '@playwright/test'
const b = await chromium.launch(); const p = await b.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(String(e)))
await p.goto('http://localhost:3001/marketing/ads/rules-automation/keyword-harvest', { waitUntil: 'networkidle', timeout: 60000 })
const body = await p.locator('body').innerText()
console.log('[hp5-smoke] page rendered, pageerrors:', errors.length)
console.log('[hp5-smoke] old ARMED-flag sentence gone:', !body.includes('NEXUS_ADS_AUTO_HARVEST_ARMED'))
console.log('[hp5-smoke] cohort strip present:', body.includes('harvested'))
await b.close()
