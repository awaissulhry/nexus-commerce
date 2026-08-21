/**
 * HP — local E2E of the Keyword Harvest page + builder (HP1–HP4), against `_bp-verify-stub.mts`
 * (8099, harvest reads added) through the dev server's same-origin proxy (3001). The stub log is
 * the write-side assertion. Run: node scripts/_hp-e2e-local.mjs
 */
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:3001/marketing/ads/rules-automation'
const say = (m) => console.log(`[hp-e2e] ${m}`)

const browser = await chromium.launch()
const page = await browser.newPage()

// ── 1 · the page: DS pill + cohort strip ────────────────────────────────────
await page.goto(`${BASE}/keyword-harvest`, { waitUntil: 'networkidle' })
const pillRole = await page.locator('.h10-hv-viewseg [role="radiogroup"]').count()
const strip = await page.locator('.h10-hv-cohortline').textContent().catch(() => null)
say(`pill is DS SegmentedControl (radiogroup found: ${pillRole}) · cohort strip: ${strip?.slice(0, 140) ?? 'ABSENT'}`)

// ── 2 · the builder: starters, bid modes, floor default, ceiling copy ───────
await page.goto(`${BASE}/builder/keyword-harvesting`, { waitUntil: 'networkidle' })
await page.click('.h10-rb-tmpl')
await page.waitForSelector('.h10-rb-tmpl-modal')
const starters = await page.locator('.h10-rb-tmpl-modal .tmrow .tmn').allTextContents()
say(`harvest starters: ${starters.length}`)
await page.locator('.h10-rb-tmpl-modal .tmrow button').first().click() // Harvest proven winners
await page.waitForTimeout(400)
const conds = await page.locator('.h10-rb-conds .cond:not(.then)').allTextContents()
say(`applied starter criteria rows: ${conds.length} (expect 2: orders ≥2 + ACoS ≤30)`)
const defOrders = await page.locator('.h10-rb-conds .cond input[aria-label="Value"]').first().inputValue()
say(`first IF value after starter: ${defOrders}`)
const floorNote = await page.locator('.h10-pc-winnote').first().textContent()
say(`floor note present: ${floorNote?.includes('at least 2 orders')}`)
await page.click('button[aria-label="New target bid mode"]')
await page.waitForTimeout(300)
const bidModes = (await page.locator('[role="option"], [class*="opt"]').allTextContents()).filter((t) => /CPC|bid/i.test(t))
say(`bid modes offered: ${bidModes.join(' · ')}`)
await page.locator('.h10-dd-back').click().catch(() => {})
const ctrlCopy = await page.locator('#rb-control .h10-rb-desc').textContent()
say(`ceiling sentence on Control: ${ctrlCopy?.includes('held below full automation')}`)

// ── 3 · the popover's Products tab is real ──────────────────────────────────
await page.click('text="Add Group"')
await page.waitForSelector('.h10-rb-agpop')
await page.locator('.h10-rb-agpop .tabs button', { hasText: 'Products' }).click()
await page.waitForSelector('.h10-rb-agpop .grp', { timeout: 45_000 }).catch(() => {})
const prodGroups = await page.locator('.h10-rb-agpop .grp').count()
const stubMsg = await page.locator('.h10-rb-agpop .agpop-msg').textContent().catch(() => null)
say(`popover Products tab: ${prodGroups} product groups (stub message: ${stubMsg ?? 'none'})`)
// add the first product's ad groups via the group Add
if (prodGroups > 0) await page.locator('.h10-rb-agpop .grp .grph .add').first().click()
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const mapped = await page.locator('.h10-rb-agrows .agrow').count()
say(`mapped ad groups after product add: ${mapped}`)

// ── 4 · create at Manual → stored payload carries the WHOLE form ────────────
await page.fill('.h10-rb-input.rn', 'HP e2e — mapped harvest')
await page.click('.h10-rb-top .h10-rb-create')
await page.waitForURL('**/rules-automation/keyword-harvest', { timeout: 15_000 })
say('created; landed on the Keyword Harvest tab')
const stored = await page.evaluate(async () => {
  const j = await fetch('/api/advertising/automation-rules').then((r) => r.json())
  const r = (j.rules ?? []).find((x) => String(x.name).startsWith('HP e2e'))
  const a0 = r?.actions?.[0] ?? {}
  return r ? {
    enabled: r.enabled, level: r.autonomyLevel,
    mappingGroups: (a0.mappings ?? []).flatMap((m) => m.groups ?? []).length,
    bid: a0.bid, dedupe: a0.dedupe,
    condGroups: (r.conditions ?? []).length,
  } : 'NOT FOUND'
})
say(`stored: ${JSON.stringify(stored)}`)

// ── 5 · Ad Group View: assign · pause · detach ──────────────────────────────
await page.goto(`${BASE}/keyword-harvest?view=ad-groups`, { waitUntil: 'networkidle' })
await page.waitForSelector('.h10-am-grid tbody tr', { timeout: 30_000 })
const assignBtn = page.locator('button[aria-label^="Assign a harvest rule"]').first()
await assignBtn.click()
await page.waitForTimeout(300)
await page.locator('[role="option"], [class*="opt"]', { hasText: 'HP e2e — mapped harvest' }).first().click()
await page.waitForTimeout(1500)
const chip = await page.locator('.h10-hv-pathway').first().textContent().catch(() => null)
say(`after assign, first pathway chip: ${chip?.slice(0, 60) ?? 'ABSENT'}`)
const toggle = page.locator('.h10-hv-pathway .h10-bktoggle').first()
await toggle.click()
await page.waitForTimeout(1500)
const pausedNow = await page.locator('.h10-hv-pathway.paused').count()
say(`after pause click, paused chips: ${pausedNow}`)
await page.locator('.h10-hv-detach').first().click()
await page.waitForTimeout(1500)
const chipsLeft = await page.locator('.h10-hv-pathway').count()
say(`after detach, pathway chips: ${chipsLeft}`)

await browser.close()
console.log('\n[hp-e2e] DONE — read the stub log for CREATE/LEVEL/PATCH sequence.')
