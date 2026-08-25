import { chromium } from '@playwright/test'
const B = 'http://localhost:3002/marketing/ads/rules-automation'
const OUT = process.env.BUDP_OUT ?? '/tmp'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
const errors = []; p.on('pageerror', (e) => errors.push(String(e)))
const say = (m) => console.log(`[budp] ${m}`)

// ── P4: the strip on the Budget tab ──
await p.goto(`${B}/budget`, { waitUntil: 'networkidle', timeout: 60000 })
const strip = p.locator('.h10-hv-cohortline')
say(`strip present: ${await strip.count() === 1}`)
say(`strip text: ${await strip.textContent().catch(() => 'ABSENT')}`)
// Read the SCREEN: links must be VISIBLE, not the grid's opacity-0 hover pill (the NEG-P3 bug).
for (const name of ['Budget Manager pacing', 'Suggestions']) {
  const a = strip.locator(`a:has-text("${name}")`)
  const box = await a.boundingBox().catch(() => null)
  const st = await a.evaluate((el) => { const c = getComputedStyle(el); return { opacity: c.opacity, color: c.color, display: c.display } }).catch(() => null)
  say(`link "${name}": visible=${await a.isVisible().catch(() => false)} w=${box?.width ?? 0} ${JSON.stringify(st)}`)
}
await strip.screenshot({ path: `${OUT}/budp-strip.png` })
await p.screenshot({ path: `${OUT}/budp-budget-tab.png` })

// ── P1 + P3: the builder's budget metric list, lookback select and window note ──
await p.goto(`${B}/builder/budget`, { waitUntil: 'networkidle', timeout: 60000 })
const metrics = await p.locator('.h10-rb-conds .cond').first().locator('button[aria-label="Metric"], [aria-label="Metric"]').first()
  .evaluate((el) => el.textContent).catch(() => null)
say(`first metric control: ${metrics}`)
// Open the metric dropdown and read every option — Budget Utilization must be offered.
await p.locator('[aria-label="Metric"]').first().click()
await p.waitForTimeout(400)
const opts = await p.locator('.nds-combo-pop button').allTextContents()
say(`metric options (${opts.length}): ${opts.join(' · ')}`)
say(`Budget Utilization offered: ${opts.some((o) => o.includes('Budget Utilization'))}`)
// Screenshot the OPEN menu — a textContent hit proves the string exists, not that it is on screen.
const bu = p.locator('.nds-combo-pop button', { hasText: 'Budget Utilization' }).first()
if (await bu.count()) {
  const st = await bu.evaluate((el) => { const c = getComputedStyle(el); return { opacity: c.opacity, color: c.color, display: c.display, fontSize: c.fontSize } })
  say(`"Budget Utilization" option: visible=${await bu.isVisible()} ${JSON.stringify(st)}`)
}
await p.locator('.nds-combo-pop').first().screenshot({ path: `${OUT}/budp-metrics.png` })
await p.keyboard.press('Escape')
await p.waitForTimeout(200)

// Advanced Settings → Measurement window (lookback select + the note)
const adv = p.locator('text=/Measurement window/').first()
if (await adv.count() === 0) {
  for (const t of ['Advanced Settings', 'Advanced']) {
    const btn = p.locator(`button:has-text("${t}")`).first()
    if (await btn.count()) { await btn.click(); await p.waitForTimeout(400); break }
  }
}
const lbSel = p.locator('[aria-label="Lookback period"]')
say(`lookback select present: ${await lbSel.count()} value="${await lbSel.first().textContent().catch(() => '?')}"`)
const note = await p.locator('.h10-pc-winnote').first().textContent().catch(() => null)
say(`window note: ${note}`)
const advBlock = p.locator('.advblock').filter({ hasText: 'Measurement window' }).first()
if (await advBlock.count()) await advBlock.screenshot({ path: `${OUT}/budp-lookback.png` })

// Starters
await p.locator('.h10-rb-tmpl').first().click()
await p.waitForSelector('.h10-rb-tmpl-modal', { timeout: 10000 })
const starters = await p.locator('.h10-rb-tmpl-modal .tmrow .tmn').allTextContents()
say(`budget starters (${starters.length}): ${starters.join(' | ')}`)
await p.locator('.h10-rb-tmpl-modal').screenshot({ path: `${OUT}/budp-starters.png` })
say(`pageerrors: ${errors.length} ${errors.join(' ;; ')}`)
await b.close()
