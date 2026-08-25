import { chromium } from '@playwright/test'
const OUT = process.env.BUDP_OUT
const B = 'http://localhost:3002/marketing/ads/rules-automation/builder/budget'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
const errs = []; p.on('pageerror', (e) => errs.push(String(e)))
const say = (m) => console.log(`[budpp] ${m}`)

await p.goto(B, { waitUntil: 'networkidle', timeout: 60000 })
await p.locator('input[placeholder="Enter a rule name"]').fill('Preview honesty check')
// Add ALL enabled campaigns — the old preview would have listed every one of them.
await p.locator('button:has-text("Add All")').first().click()
await p.waitForTimeout(600)
const added = await p.locator('text=/\\d+ Campaigns Added/').first().textContent()
say(`picker: ${added?.trim()}`)
// Apply the "Reclaim idle budget" starter.
await p.locator('.h10-rb-tmpl').first().click()
await p.waitForSelector('.h10-rb-tmpl-modal')
await p.locator('.h10-rb-tmpl-modal .tmrow button').nth(2).click()
await p.waitForTimeout(400)
// Scope to DE.
await p.locator('[aria-label="Market scope"], [aria-label="Marketplace"]').first().click().catch(() => {})
await p.waitForTimeout(300)
const de = p.locator('.nds-combo-pop button', { hasText: 'Germany (DE)' }).first()
if (await de.count()) { await de.click(); say('scope: Germany (DE)') } else say('scope control not found — leaving All markets')
await p.waitForTimeout(300)

await p.locator('button:has-text("Preview")').first().click()
await p.waitForSelector('.h10-rb-prev', { timeout: 20000 })
await p.waitForTimeout(2500)
say(`subtitle: ${await p.locator('.h10-rb-prev .psub').textContent()}`)
const rows = await p.locator('.h10-rb-prev .ptr').allTextContents()
say(`rows (${rows.length}): ${rows.map(r => r.replace(/\s+/g, ' ').trim()).join(' | ')}`)
say(`footer: ${(await p.locator('.h10-rb-prev .pfoot').textContent().catch(() => 'ABSENT'))?.replace(/\s+/g,' ').trim()}`)
await p.locator('.h10-rb-prev').screenshot({ path: `${OUT}/budpp-preview.png` })
say(`pageerrors: ${errs.length} ${errs.join(' ;; ')}`)
await b.close()
