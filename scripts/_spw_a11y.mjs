import { chromium } from 'playwright'

const URL = 'http://localhost:3000/marketing/ads/campaign-builder/sp-super-wizard'
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1676, height: 1044 } })).newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(700)

const audit = async (label) => {
  const bad = await p.evaluate(() => {
    const els = [...document.querySelectorAll('button, input, select, textarea, [role=tab], [role=checkbox]')]
    const name = (el) => {
      const al = el.getAttribute('aria-label'); if (al && al.trim()) return al
      const t = (el.textContent || '').trim(); if (t) return t
      const title = el.getAttribute('title'); if (title) return title
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        const ph = el.getAttribute('placeholder'); if (ph) return ph
        const wrap = el.closest('label'); if (wrap && (wrap.textContent || '').trim()) return wrap.textContent.trim()
      }
      return ''
    }
    return els.filter((el) => el.offsetParent !== null && !name(el)).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', cls: (el.className || '').toString().slice(0, 36) }))
  })
  console.log(label, '→ unlabeled:', bad.length, JSON.stringify(bad.slice(0, 14)))
}

try { await audit('step1') } catch (e) { console.log('step1 err', e.message) }
try { await p.click('.h10-spw-steps button:nth-of-type(2)'); await p.waitForTimeout(400); await audit('step2') } catch (e) { console.log('step2 err', e.message) }
try {
  await p.locator('.h10-spw-cset-row').nth(1).locator('button.edit').first().click({ timeout: 4000 })
  await p.waitForTimeout(300); await audit('targeting-modal')
  await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  console.log('esc-closes-modal:', (await p.$('.h10-modal')) === null)
} catch (e) { console.log('modal step err:', e.message.split('\n')[0]) }
try { await p.click('.h10-spw-steps button:nth-of-type(3)'); await p.waitForTimeout(400); await audit('step3') } catch (e) { console.log('step3 err', e.message) }
await b.close()
