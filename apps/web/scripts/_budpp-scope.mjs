import { chromium } from '@playwright/test'
const OUT = process.env.BUDP_OUT
const B = 'http://localhost:3002/marketing/ads/rules-automation/builder/budget'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
const errs = []; p.on('pageerror', e => errs.push(String(e)))
const say = m => console.log(`[scope] ${m}`)

const setup = async (starterIdx) => {
  await p.goto(B, { waitUntil: 'networkidle', timeout: 60000 })
  await p.locator('input[placeholder="Enter a rule name"]').fill('scope check')
  await p.locator('button:has-text("Add All")').first().click(); await p.waitForTimeout(600)
  await p.locator('.h10-rb-tmpl').first().click(); await p.waitForSelector('.h10-rb-tmpl-modal')
  await p.locator('.h10-rb-tmpl-modal .tmrow button').nth(starterIdx).click(); await p.waitForTimeout(400)
}
const openPreview = async () => {
  await p.locator('button:has-text("Preview")').first().click()
  await p.waitForSelector('.h10-rb-prev', { timeout: 20000 }); await p.waitForTimeout(2500)
}
const readModal = async () => ({
  sub: (await p.locator('.h10-rb-prev .psub').textContent())?.replace(/\s+/g,' ').trim(),
  rows: await p.locator('.h10-rb-prev .ptr').count(),
  foot: (await p.locator('.h10-rb-prev .pfoot').textContent().catch(()=>null))?.replace(/\s+/g,' ').trim() ?? null,
  msg: (await p.locator('.h10-rb-prev .pmsg').textContent().catch(()=>null))?.replace(/\s+/g,' ').trim() ?? null,
})

// ── A: DE scope on the idle starter ──
await setup(2)
await p.locator('[aria-label="Marketplace scope"]').first().click(); await p.waitForTimeout(400)
await p.locator('.h10-dd-pop .h10-dd-opt', { hasText: 'Germany (DE)' }).first().click(); await p.waitForTimeout(300)
await openPreview()
let m = await readModal(); say(`A) DE scope  rows=${m.rows}  foot="${m.foot}"`)
await p.locator('.h10-rb-prev').screenshot({ path: `${OUT}/budpp-de.png` })
await p.keyboard.press('Escape')

// ── B: FR scope — no DE campaign can match, so the modal must SAY why, not just be empty ──
await p.locator('[aria-label="Marketplace scope"]').first().click(); await p.waitForTimeout(400)
await p.locator('.h10-dd-pop .h10-dd-opt', { hasText: 'France (FR)' }).first().click(); await p.waitForTimeout(300)
await openPreview()
m = await readModal(); say(`B) FR scope  rows=${m.rows}  msg="${m.msg}"`)
await p.locator('.h10-rb-prev').screenshot({ path: `${OUT}/budpp-empty.png` })
say(`pageerrors: ${errs.length} ${errs.join(' ;; ')}`)
await b.close()
