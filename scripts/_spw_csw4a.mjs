import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1676, height: 1044 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)
await p.locator('#spw-structure').scrollIntoViewIfNeeded()
await p.click('.h10-spw-st-tabs button:nth-child(3)') // Custom Scheme
await p.waitForTimeout(350)

// a11y: unlabeled interactive controls inside the structure card
const unlabeled = await p.$$eval('.h10-spw-st-card button, .h10-spw-st-card input, .h10-spw-st-card [role=tab], .h10-spw-st-card [role=option]', (els) => {
  const name = (el) => {
    const al = el.getAttribute('aria-label'); if (al && al.trim()) return al
    const t = (el.textContent || '').trim(); if (t) return t
    const title = el.getAttribute('title'); if (title) return title
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) { const ph = el.getAttribute('placeholder'); if (ph) return ph; const w = el.closest('label'); if (w && (w.textContent || '').trim()) return w.textContent.trim() }
    return ''
  }
  return els.filter((el) => el.offsetParent !== null && !name(el)).map((el) => ({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 30) }))
})

// validation 1: uncheck Brand's only match (Broad) → its row should warn
await p.locator('.h10-spw-cs-ktrow').first().locator('.mts label').first().locator('input').uncheck()
await p.waitForTimeout(150)
const warnRows = await p.locator('.h10-spw-cs-ktrow.warn').count()
const cardEl = await p.$('.h10-spw-st-card'); if (cardEl) await cardEl.screenshot({ path: '/tmp/spw/csw4.png' })
await p.locator('.h10-spw-cs-ktrow').first().locator('.mts label').first().locator('input').check() // restore

// validation 2: uncheck all Campaign Types → 0 campaigns + warning
for (const t of ['Auto', 'Keyword', 'Product']) await p.locator('.h10-spw-cs-targets label', { hasText: t }).locator('input').uncheck().catch(() => {})
await p.waitForTimeout(200)
const pwarn = (await p.$('.h10-spw-cs-pwarn')) !== null
const previewPh = (await p.locator('.h10-spw-cs-preview .ph').innerText()).replace(/\s+/g, ' ').trim()

console.log(JSON.stringify({ unlabeled, warnRows, pwarn, previewPh }))
await b.close()
