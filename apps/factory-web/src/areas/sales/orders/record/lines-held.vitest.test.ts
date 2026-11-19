import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { renderView } from '../../../../lib/record-thread/parts/testing'
import { AMEND_PREVIEW, forRole, order } from '../_demo/fixtures'
import type { AmendPreview } from '../api'
import { amendBodyOf, amendKeyOf, draftOf, stripHeld, stripOf, type AmendReview } from '../daily-model'
import { designScreen } from './fixtures'

/**
 * F-CP-149 (customer page plan C4, the money wall; review A8, D5: A08 shipped blanks for readers without prices) — the order page's
 * Lines edit mode as Sales worker (no price grain since B-CP-011) and as Production manager: the strip says "Net: shown to people who
 * see prices" where the net would be, the fee's place says "Shown to people who see prices", and "Apply as a priced change" is held
 * "A priced change is made by someone who sees prices." — never a blank, never a blind priced change; the amendment's body carries no
 * price key. Kept out of so/orders.vitest.test.ts (the order lane's). Every name and number is made up.
 */

const value = forRole(order('CONFIRMED'), 'manager')
const draft = { lines: draftOf(value).map((line, index) => (index === 0 ? { ...line, sizes: { ...line.sizes, '50': (line.sizes['50'] ?? 0) + 1 } } : line)), customerRef: value.customerRef ?? '', requestedDate: value.requestedDate ?? '' }
const key = amendKeyOf(draft, value)
const review = (preview: AmendPreview): AmendReview => ({ phase: 'ready', key, preview, problem: null })
const frozen = { ok: false, revision: 4, version: 7, problems: [{ path: 'body/lines/10/SIZE_QUANTITY', message: 'x' }], diff: null, workOrders: null } as unknown as AmendPreview
const label = () => 'DEMO-JKT-01 · Nero'

describe('F-CP-149: the strip as a reader without prices', () => {
  it('the net\'s place is held in words, never a blank; with the price grain the net itself', () => {
    const held = stripOf({ order: value, review: review(AMEND_PREVIEW), key, local: null, price: false, label })
    expect(held.phase).toBe('ready')
    expect(held.net).toBeNull()
    expect(held.netHeld).toBe(true)
    const owner = stripOf({ order: value, review: review(AMEND_PREVIEW), key, local: null, price: true, label })
    expect(owner.netHeld).toBe(false)
    // Nothing to say yet (reading, idle): no held line either.
    expect(stripOf({ order: value, review: null, key, local: null, price: false, label }).netHeld).toBe(false)
  })

  it('"Apply as a priced change" is held for a reader without prices — whatever the reason and the fee typed', () => {
    const strip = stripOf({ order: value, review: review(frozen), key, local: null, price: false, label })
    expect(strip.frozen.length).toBeGreaterThan(0)
    expect(stripHeld(strip, { reason: 'Una giacca in più.', busy: false, local: null, offer: 'priced', fee: '', price: false })).toEqual({ key: 'edit.pricedHeld.apply' })
    expect(stripHeld(strip, { reason: 'Una giacca in più.', busy: false, local: null, offer: 'priced', fee: '25,00', price: false })).toEqual({ key: 'edit.pricedHeld.apply' })
    // A price holder applies it (its fee checked as before).
    expect(stripHeld(strip, { reason: 'Una giacca in più.', busy: false, local: null, offer: 'priced', fee: '', price: true })).toBeNull()
    // Not a priced change: nothing new is held.
    const plain = stripOf({ order: value, review: review(AMEND_PREVIEW), key, local: null, price: false, label })
    expect(stripHeld(plain, { reason: 'Una giacca in più.', busy: false, local: null, offer: null, fee: '', price: false })).toBeNull()
  })

  it('the amendment\'s body carries no price key for a reader without prices (the API refuses one: the grain filter)', () => {
    const body = JSON.stringify(amendBodyOf(draft, value))
    expect(body).not.toMatch(/unitPrice|netAmount|fee|amount/i)
  })
})

describe('F-CP-149: the edit mode drawn', () => {
  const render = (id: string, locale: (typeof LOCALES)[number]) => {
    const screen = designScreen as DesignScreen<unknown>
    const item = screen.cases.find((entry) => entry.id === id)
    expect(item, id).toBeDefined()
    return renderView(screen.view as ComponentType<{ model: unknown }>, item!.model, locale)
  }

  it('as Sales worker without prices: "Net: shown to people who see prices" in the strip (en, it)', () => {
    expect(render('f-cp-149-strip-no-price', 'en')).toContain('Net: shown to people who see prices')
    expect(render('f-cp-149-strip-no-price', 'it')).toContain('Imponibile: visibile a chi vede i prezzi')
  })

  it('frozen: Apply as a priced change held in words, the fee\'s place held, no amount on the strip', () => {
    for (const locale of LOCALES) {
      const html = render('f-cp-149-priced-held', locale)
      expect(html).toContain(locale === 'en' ? 'A priced change is made by someone who sees prices.' : 'Una modifica con prezzi la fa chi vede i prezzi.')
      expect(html).toContain(locale === 'en' ? 'Shown to people who see prices' : 'Visibili a chi vede i prezzi')
      expect(html).not.toMatch(/\bedit\.pricedHeld\.[a-z]+/)
    }
  })

  it('LinesTab keeps the held parts in marked blocks (the order lane\'s file)', () => {
    const tab = readFileSync(new URL('./view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("!model.can.price && strip.netHeld && <span className=\"fw-so-hint\">{t('edit.pricedHeld.net')}</span>")
    expect(tab).toContain('price: model.can.price /* F-CP-149 */')
    expect(tab.match(/F-CP-149/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
