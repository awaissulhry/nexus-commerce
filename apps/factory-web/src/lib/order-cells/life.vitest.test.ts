import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ORDER_LIFE, LIFE_NOTE_KINDS, type LifeNote } from '@nexus/factory-domain/sales/order-life'
import { SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { REQUEST_STATUSES } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { CUSTOMER_ORDER_STATUSES } from '@nexus/factory-domain/sales/portal-orders/status'
import { LOCALES, type Locale } from '../i18n/locales'
import { CATALOGUE, catalogueFor, createTranslator } from '../i18n/messages'
import { I18nProvider, ReaderProvider } from '../i18n/provider'
import { LIFE_ICON, LIFE_LINE, LIFE_TONE, lifeChipOf, lifeNotePhrase, lifeOfStatus, NOTE_FORM, type OrderStatusCode } from './model'
import { StateChip } from './view/StateChip'
import { ORDER_LIFE_NS } from './words'

/**
 * owb-b4 w4.1 (design word table "The states of an order, in every door"; R-base A; owb-b23 "Shapes" OrderLife / LifeNote) — the nine
 * life words: every life → its word key, icon and tone; every note → the word or the tail; every status code of today (the office's,
 * the customer's, a portal request's) → the right life through the domain's `orderLifeOf`; the chip drawn from `life`, from
 * `status`, and today's `chip` model unchanged; the customer reads "At the factory’s warehouse". Made-up data only.
 */

const draw = (element: ReactElement, reader: 'office' | 'outside' = 'office', locale: Locale = 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, createElement(ReaderProvider, { reader }, element)))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const life = (locale: Locale, reader: 'office' | 'outside' = 'office') => createTranslator(locale, catalogueFor(locale, ORDER_LIFE_NS, reader))

describe('the chip model: every life → its word, icon and tone', () => {
  it('nine lives, each with a word key, one icon, one of the five semantic tones; outlined before the work and when gone', () => {
    expect(ORDER_LIFE.map((each) => lifeChipOf({ life: each }).word.key)).toEqual(ORDER_LIFE.map((each) => `life.${each}`))
    expect(LIFE_TONE).toEqual({ DRAFT: 'neutral', SENT: 'info', CONFIRMED: 'success', IN_PRODUCTION: 'info', READY_TO_SHIP: 'success', SHIPPED: 'success', AT_OUR_WAREHOUSE: 'neutral', DELIVERED: 'success', WITHDRAWN: 'danger' })
    expect(new Set(ORDER_LIFE.map((each) => LIFE_ICON[each])).size).toBe(9) // one icon each: never colour alone
    expect([...LIFE_LINE].sort()).toEqual(['CONFIRMED', 'DRAFT', 'SENT', 'WITHDRAWN'])
    for (const each of ORDER_LIFE) expect(lifeChipOf({ life: each, note: null }), each).toMatchObject({ life: each, tone: LIFE_TONE[each], mark: LIFE_ICON[each], line: LIFE_LINE.has(each) })
  })

  it('a note is the word (Cancelled, Refused, Confirmed: waits for the print, Printed) or a tail after a dot (40 of 114, A quote, Waits for approval)', () => {
    expect(Object.keys(NOTE_FORM).sort()).toEqual([...LIFE_NOTE_KINDS].sort())
    expect(lifeChipOf({ life: 'WITHDRAWN', note: { kind: 'CANCELLED' } })).toMatchObject({ life: 'WITHDRAWN', word: { key: 'note.CANCELLED' }, tone: 'danger' })
    expect(lifeChipOf({ life: 'WITHDRAWN', note: { kind: 'REFUSED' } }).word).toEqual({ key: 'note.REFUSED' })
    expect(lifeChipOf({ life: 'CONFIRMED', note: { kind: 'WAITS_FOR_PRINT' } }).word).toEqual({ key: 'note.WAITS_FOR_PRINT' })
    expect(lifeChipOf({ life: 'CONFIRMED', note: { kind: 'PRINTED' } }).word).toEqual({ key: 'note.PRINTED' })
    const partly = lifeChipOf({ life: 'SHIPPED', note: { kind: 'PARTLY_SHIPPED', shipped: 40, total: 114 } })
    expect(partly).toMatchObject({ word: { key: 'life.SHIPPED' }, tail: { key: 'tail.PARTLY_SHIPPED', params: { shipped: 40, total: 114 } } })
    expect(lifeChipOf({ life: 'SENT', note: { kind: 'QUOTE' } }).tail).toEqual({ key: 'note.QUOTE' })
    expect(lifeChipOf({ life: 'SENT', note: { kind: 'WAITS_FOR_APPROVAL' } }).tail).toEqual({ key: 'note.WAITS_FOR_APPROVAL' })
    expect(lifeNotePhrase({ kind: 'PARTLY_SHIPPED', shipped: 40, total: 114 })).toEqual({ key: 'note.PARTLY_SHIPPED', params: { shipped: 40, total: 114 } })
  })
})

describe('every status code of today → the right life (the domain\'s orderLifeOf)', () => {
  it('the office\'s SalesOrderStatus', () => {
    const lives = Object.fromEntries(SALES_ORDER_STATUSES.map((code) => [code, lifeOfStatus(code, code === 'PARTLY_SHIPPED' ? { shipped: 40, total: 114 } : null)]))
    expect(lives).toEqual({
      CONFIRMED: { life: 'CONFIRMED', note: null },
      IN_PRODUCTION: { life: 'IN_PRODUCTION', note: null },
      READY: { life: 'READY_TO_SHIP', note: null },
      PARTLY_SHIPPED: { life: 'SHIPPED', note: { kind: 'PARTLY_SHIPPED', shipped: 40, total: 114 } },
      SHIPPED: { life: 'SHIPPED', note: null },
      CLOSED: { life: 'SHIPPED', note: null }, // no shipment facts: as the customer's status says today
      CANCELLED: { life: 'WITHDRAWN', note: { kind: 'CANCELLED' } },
      PENDING_APPROVAL: { life: 'SENT', note: { kind: 'WAITS_FOR_APPROVAL' } },
      DELIVERED: { life: 'DELIVERED', note: null },
    })
  })

  it('the customer\'s status (REQUESTED is Sent) and a portal request\'s', () => {
    expect(CUSTOMER_ORDER_STATUSES.map((code) => lifeOfStatus(code).life)).toEqual(['SENT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'SHIPPED', 'DELIVERED', 'WITHDRAWN'])
    expect(Object.fromEntries(REQUEST_STATUSES.map((code) => [code, lifeOfStatus(code)]))).toEqual({
      DRAFT: { life: 'DRAFT', note: null },
      SENT: { life: 'SENT', note: null },
      ACCEPTED: { life: 'CONFIRMED', note: null },
      REFUSED: { life: 'WITHDRAWN', note: { kind: 'REFUSED' } },
      WITHDRAWN: { life: 'WITHDRAWN', note: null },
    })
  })

  it('a partly shipped code with no pieces says 0 of 0, never a crash', () => {
    expect(lifeOfStatus('PARTLY_SHIPPED' as OrderStatusCode)).toEqual({ life: 'SHIPPED', note: { kind: 'PARTLY_SHIPPED', shipped: 0, total: 0 } })
  })
})

describe('the chip drawn', () => {
  it('from a life: the Pill with the life\'s mark, tone and word; outlined before the work', () => {
    const sent = draw(createElement(StateChip, { life: 'SENT' }))
    expect(sent).toContain('nds-pill info fw-sheet-st is-line')
    expect(sent).toContain('data-life="SENT"')
    expect(sent).toContain('lucide-mail')
    expect(text(sent)).toBe('Sent')
    const partly = draw(createElement(StateChip, { life: 'SHIPPED', note: { kind: 'PARTLY_SHIPPED', shipped: 40, total: 114 } as LifeNote }))
    expect(partly).toContain('nds-pill success fw-sheet-st"')
    expect(text(partly)).toBe('Shipped · 40 of 114')
    expect(text(draw(createElement(StateChip, { life: 'CONFIRMED', note: { kind: 'WAITS_FOR_PRINT' } })))).toBe('Confirmed: waits for the print')
    expect(text(draw(createElement(StateChip, { life: 'WITHDRAWN', note: { kind: 'CANCELLED' } }), 'office', 'it'))).toBe('Annullato')
  })

  it('from today\'s code: mapped through orderLifeOf — no caller edit needed', () => {
    expect(text(draw(createElement(StateChip, { status: 'READY' })))).toBe('Ready to ship')
    expect(text(draw(createElement(StateChip, { status: 'PENDING_APPROVAL' })))).toBe('Sent · Waits for approval')
    expect(text(draw(createElement(StateChip, { status: 'PARTLY_SHIPPED', pieces: { shipped: 40, total: 114 } })))).toBe('Shipped · 40 of 114')
    expect(text(draw(createElement(StateChip, { status: 'REQUESTED' }), 'outside', 'it'))).toBe('Inviato')
  })

  it('today\'s chip model draws as before (the office\'s sheet and the portal\'s list until S2 / S1 pass life)', () => {
    const before = draw(createElement(StateChip, { chip: { words: 'Ready', tone: 'info', mark: LIFE_ICON.READY_TO_SHIP } }))
    expect(before).toContain('nds-pill info fw-sheet-st')
    expect(before).not.toContain('data-life')
    expect(text(before)).toBe('Ready')
  })

  it('the customer reads "At the factory’s warehouse"; the office "At our warehouse"', () => {
    expect(text(draw(createElement(StateChip, { life: 'AT_OUR_WAREHOUSE' })))).toBe('At our warehouse')
    expect(text(draw(createElement(StateChip, { life: 'AT_OUR_WAREHOUSE' }), 'outside'))).toBe('At the factory’s warehouse')
    expect(text(draw(createElement(StateChip, { life: 'AT_OUR_WAREHOUSE' }), 'outside', 'it'))).toBe('Nel magazzino della fabbrica')
  })
})

describe('the words', () => {
  it('order-life.json: the nine words, every note and the tail in it and en, the same keys and placeholders', () => {
    const keys = (locale: Locale) => Object.keys(CATALOGUE[locale][ORDER_LIFE_NS] ?? {}).sort()
    expect(keys('it')).toEqual(keys('en'))
    for (const locale of LOCALES) {
      const t = life(locale)
      for (const each of ORDER_LIFE) expect(t(`life.${each}`), `${locale} ${each}`).not.toBe(`life.${each}`)
      for (const kind of LIFE_NOTE_KINDS) expect(t(`note.${kind}`, { shipped: 1, total: 2 }), `${locale} ${kind}`).not.toBe(`note.${kind}`)
      expect(t('tail.PARTLY_SHIPPED', { shipped: 40, total: 114 })).toMatch(/^40 \S+ 114$/)
    }
    expect(ORDER_LIFE.map((each) => life('en')(`life.${each}`))).toEqual(['Draft', 'Sent', 'Confirmed', 'In production', 'Ready to ship', 'Shipped', 'At our warehouse', 'Delivered', 'Withdrawn'])
    expect(life('en')('note.PARTLY_SHIPPED', { shipped: 40, total: 114 })).toBe('40 of 114 shipped')
  })
})
