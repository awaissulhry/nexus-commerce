/**
 * BP — local E2E of the Bid builder/grid WRITE sequences, against the _bp-verify-stub (8099)
 * and the isolated dev server (3001). Chrome-in-hand verification hit Chrome's Local Network
 * Access policy (cross-port POSTs to loopback are blocked before the wire), so this drives the
 * SAME flow in Playwright Chromium with LNA checks disabled. Read the stub log afterwards for
 * the CREATE/LEVEL/PATCH sequence — that log is the assertion.
 *
 * Run: node scripts/_bp-e2e-local.mjs
 */
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:3001/marketing/ads/rules-automation'

const browser = await chromium.launch()
const page = await browser.newPage()
// Chrome's Local Network Access policy blocks cross-port loopback writes regardless of the
// stub's (correct) CORS headers, and does so flakily in headless too. Route every stub request
// through Playwright's Node-side fetch and fulfill it with permissive CORS — the page then never
// hits the browser network stack for :8099 at all.
await page.route('http://localhost:8099/**', async (route) => {
  if (route.request().method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': 'http://localhost:3001', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' } })
  }
  const response = await route.fetch()
  const headers = { ...response.headers(), 'access-control-allow-origin': 'http://localhost:3001', 'access-control-allow-credentials': 'true' }
  // The body is re-served decoded; stale encoding/length headers would corrupt it.
  delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding']
  return route.fulfill({ status: response.status(), headers, body: await response.body() })
})
const logs = []
const say = (m) => { logs.push(m); console.log(`[bp-e2e] ${m}`) }

// ── 1 · create an AUTOMATE rule with two blocks ─────────────────────────────
await page.goto(`${BASE}/builder/bid`, { waitUntil: 'networkidle' })
await page.fill('.h10-rb-input.rn', 'BP e2e — automate cut')
await page.waitForSelector('.cp-row .cp-add:not([disabled])', { timeout: 30_000 })
await page.click('.cp-row .cp-add:not([disabled])')
await page.fill('.h10-rb-conds .cond input[aria-label="Value"]', '40')
// THEN → Decrease Bid by(%)
await page.click('button[aria-label="Bid action"]')
await page.click('text="Decrease Bid by(%)"')
await page.fill('.h10-rb-conds .cond.then input', '15')
// second block
await page.click('.h10-rb-btn.addcrit')
const cards = page.locator('.h10-rb-card.crit')
await cards.nth(1).locator('input[aria-label="Value"]').first().fill('15')
await cards.nth(1).locator('button[aria-label="Bid action"]').click()
await page.click('text="Increase Bid by(%)"')
await cards.nth(1).locator('.cond.then input').fill('10')
say(`block note: ${await page.locator('.h10-rb-blocknote').textContent()}`)
// lookback 30
await page.click('button[aria-label="Lookback period"]')
await page.click('text="Last 30 Days"')
// Automate + create
await page.click('label.h10-rb-ctrl:has-text("Automate") input')
await page.click('.h10-rb-top .h10-rb-create')
await page.waitForURL('**/rules-automation/bid', { timeout: 15_000 })
say('created automate rule; landed on the Bid tab')

// ── 2 · the grid row state ──────────────────────────────────────────────────
await page.waitForSelector('.h10-nt-name', { timeout: 15_000 })
const row = {
  name: await page.locator('.h10-nt-name').first().textContent(),
  criteria: await page.locator('.h10-nt-crit').first().textContent(),
  lookback: await page.locator('.h10-rg-look').first().textContent(),
  freq: await page.locator('.h10-nt-freq').first().textContent(),
  toggleOn: await page.locator('.h10-bktoggle').first().evaluate((el) => el.classList.contains('on')),
  offChip: await page.locator('.h10-bd7-posture.off').count(),
  filtersCard: await page.locator('text="Show Filters"').count(),
}
say(`grid row: ${JSON.stringify(row)}`)

// ── 3 · toggle OFF (level PROPOSE + belt manual), then ON again ─────────────
await page.click('.h10-bktoggle')
await page.waitForTimeout(1200)
say(`toggle after OFF click: on=${await page.locator('.h10-bktoggle').first().evaluate((el) => el.classList.contains('on'))}`)

// ── 4 · a PAUSE rule at Automate → ceiling 409 → falls back to PROPOSE ──────
await page.goto(`${BASE}/builder/bid`, { waitUntil: 'networkidle' })
await page.fill('.h10-rb-input.rn', 'BP e2e — pause rule')
await page.waitForSelector('.cp-row .cp-add:not([disabled])', { timeout: 30_000 })
await page.click('.cp-row .cp-add:not([disabled])')
await page.fill('.h10-rb-conds .cond input[aria-label="Value"]', '80')
await page.click('button[aria-label="Bid action"]')
await page.click('text="Pause Target"')
await page.click('label.h10-rb-ctrl:has-text("Automate") input')
await page.click('.h10-rb-top .h10-rb-create')
await page.waitForURL('**/rules-automation/bid', { timeout: 15_000 })
await page.waitForTimeout(1500)
const rows2 = await page.locator('.h10-am-grid tbody tr').count()
const pauseRow = page.locator('tr', { has: page.locator('text="BP e2e — pause rule"') })
say(`rows: ${rows2}; pause rule toggle on=${await pauseRow.locator('.h10-bktoggle').evaluate((el) => el.classList.contains('on')).catch(() => 'n/a')}`)
const pauseTip = await pauseRow.locator('.h10-bktoggle').getAttribute('title').catch(() => null)
say(`pause rule toggle tooltip: ${pauseTip?.slice(0, 140)}`)

// ── 5 · templates: starter list present, apply one ──────────────────────────
await page.goto(`${BASE}/builder/bid`, { waitUntil: 'networkidle' })
await page.click('.h10-rb-tmpl')
await page.waitForSelector('.h10-rb-tmpl-modal')
const starters = await page.locator('.h10-rb-tmpl-modal .tmrow .tmn').allTextContents()
say(`starter templates: ${starters.length} — ${starters.map((s) => s.split('\n')[0]).join(' · ').slice(0, 160)}`)
await page.locator('.h10-rb-tmpl-modal .tmrow button').first().click()
await page.waitForTimeout(400)
const appliedCond = await page.locator('.h10-rb-conds .cond input[aria-label="Value"]').first().inputValue()
say(`applied starter → first IF value: ${appliedCond}`)

await browser.close()
console.log('\n[bp-e2e] DONE — now read the stub log for the CREATE / LEVEL / PATCH sequence.')
