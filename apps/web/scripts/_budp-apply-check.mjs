import { chromium } from '@playwright/test'
const OUT = process.env.BUDP_OUT
const B = 'http://localhost:3002/marketing/ads/rules-automation/builder'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
const errs = []; p.on('pageerror', (e) => errs.push(String(e)))
const say = (m) => console.log(`[apply] ${m}`)

const readConds = async () => {
  const rows = await p.locator('.h10-rb-conds .cond:not(.then)').all()
  const out = []
  for (const r of rows) {
    const metric = await r.locator('[aria-label="Metric"]').first().textContent().catch(() => '?')
    const op = await r.locator('[aria-label="Operator"]').first().textContent().catch(() => '?')
    const val = await r.locator('input[aria-label="Value"]').first().inputValue().catch(() => '?')
    out.push(`${metric?.trim()} ${op?.trim()} ${val}`)
  }
  return out
}

await p.goto(`${B}/budget`, { waitUntil: 'networkidle', timeout: 60000 })
for (const [i, name] of [[0, 'Feed capped winners'], [2, 'Reclaim idle budget']]) {
  await p.locator('.h10-rb-tmpl').first().click()
  await p.waitForSelector('.h10-rb-tmpl-modal', { timeout: 10000 })
  await p.locator('.h10-rb-tmpl-modal .tmrow button').nth(i).click()
  await p.waitForTimeout(500)
  say(`"${name}" → ${JSON.stringify(await readConds())}`)
  const thenOp = await p.locator('.h10-rb-conds .cond.then [aria-label]').first().textContent().catch(() => '?')
  const thenVal = await p.locator('.h10-rb-conds .cond.then input').first().inputValue().catch(() => '?')
  say(`   THEN: ${thenOp?.trim()} = ${thenVal}`)
}
await p.locator('.h10-rb-conds').first().screenshot({ path: `${OUT}/budp-applied.png` })

// The shared CSS fix must help the other tabs, not harm them.
for (const slug of ['negative-targeting', 'keyword-harvesting']) {
  await p.goto(`${B}/${slug}`, { waitUntil: 'networkidle', timeout: 60000 })
  await p.locator('.h10-rb-tmpl').first().click()
  await p.waitForSelector('.h10-rb-tmpl-modal', { timeout: 10000 })
  const clipped = await p.locator('.h10-rb-tmpl-modal .tmdesc').evaluateAll((els) =>
    els.map((e) => ({ text: e.textContent.slice(0, 28), clipped: e.scrollWidth > e.clientWidth + 1 })))
  say(`${slug} descs clipped: ${JSON.stringify(clipped)}`)
  await p.locator('.h10-rb-tmpl-modal').screenshot({ path: `${OUT}/budp-${slug}-starters.png` })
  await p.keyboard.press('Escape')
}
say(`pageerrors: ${errs.length} ${errs.join(' ;; ')}`)
await b.close()
