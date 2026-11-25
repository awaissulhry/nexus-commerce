import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Hourglass, Reply, Scissors } from 'lucide-react'
import { CUSTOMER_ORDER_STATUSES } from '@nexus/factory-domain/sales/portal-orders/status'
import { LOCALES } from '../i18n/locales'
import { createTranslator, messagesFor } from '../i18n/messages'
import { I18nProvider, ReaderProvider } from '../i18n/provider'
import { CUSTOMER_GROUP_ICON } from '../order-groups/groups'
import { customerGroupOf, customerStateChipOf, customerStatusTone, ORDER_STATUS_TONE, shippedPercentOf, type Door } from './model'
import { tailWhole } from './tail-whole'
import { DoorCell } from './view/DoorCell'
import { MarkChip } from './view/MarkChip'
import { PromiseCell } from './view/PromiseCell'
import { ShippedCell } from './view/ShippedCell'
import { StateChip } from './view/StateChip'

/**
 * pg-w1 (portal grid plan § 2, § 5 pg-1.3; 18-lead-settles Z1, Z4, Z16 P4) — the shared order cells: the office's markup as the Orders
 * sheet drew it before the move (the same Pill, Tag, door and bar), and the customer face's own words ("was …", "date asked",
 * "wanted", the next parcel as Shipped's tip). One tone for one status on every page. Made-up data only.
 */

const sheet = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
const draw = (element: ReactElement, reader: 'office' | 'outside' = 'office', locale: (typeof LOCALES)[number] = 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, createElement(ReaderProvider, { reader }, element)))
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const door: Door = { href: '/w/DEMO/sales/orders/o-1?tab=lines', tip: { key: 'door.promise', params: { number: 'SO-0001' } } }

describe('pg-w1: one tone for one status (Z16 P4)', () => {
  it('the office\'s table, and every customer status takes the office\'s tone for the same status', () => {
    expect(ORDER_STATUS_TONE).toEqual({ CONFIRMED: 'neutral', IN_PRODUCTION: 'info', READY: 'info', PARTLY_SHIPPED: 'warning', SHIPPED: 'success', CLOSED: 'neutral', CANCELLED: 'danger', PENDING_APPROVAL: 'warning', DELIVERED: 'success' })
    expect(CUSTOMER_ORDER_STATUSES.map((status) => customerStatusTone(status))).toEqual(['warning', 'neutral', 'info', 'info', 'warning', 'success', 'success', 'danger'])
    expect(CUSTOMER_ORDER_STATUSES.map((status) => customerGroupOf(status))).toEqual(['REQUESTS', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED'])
    expect(customerStateChipOf('PARTLY_SHIPPED', 'Partly shipped', '40 of 114')).toEqual({ words: 'Partly shipped', tone: 'warning', mark: CUSTOMER_GROUP_ICON.SHIPPED, tail: '40 of 114' })
    expect(customerStateChipOf('CONFIRMED', 'Confirmed', null)).toEqual({ words: 'Confirmed', tone: 'neutral', mark: CUSTOMER_GROUP_ICON.CONFIRMED })
    expect([shippedPercentOf(40, 114), shippedPercentOf(0, 0), shippedPercentOf(5, 5)]).toEqual([35, 0, 100])
  })
})

describe('pg-w1: the office\'s markup, as the Orders sheet drew it', () => {
  it('the status chip: the DS Pill with its group mark, the words and the shipped pieces after a dot; a closed one outlined', () => {
    const chip = draw(createElement(StateChip, { chip: { words: 'Partly shipped', tone: 'warning', mark: Scissors, tail: '40 of 114' } }))
    expect(chip).toContain('nds-pill warning fw-sheet-st')
    expect(chip).toContain('lucide-scissors')
    expect(text(chip)).toBe('Partly shipped · 40 of 114')
    expect(draw(createElement(StateChip, { chip: { words: 'Closed', tone: 'neutral', mark: Hourglass, line: true } }))).toContain('fw-sheet-st is-line')
  })

  it('the mark chip: its mark, head and tail; outlined when neutral; a real link when it has a door; dense keeps the head', () => {
    const plain = draw(createElement(MarkChip, { chip: { tone: 'warning', mark: Hourglass, head: 'Deposit open', tail: 'due 25/11/2026' } }))
    expect(plain).toContain('nds-tag warning fw-sheet-stop')
    expect(plain).toContain('title="Deposit open · due 25/11/2026"')
    expect(text(plain)).toBe('Deposit open · due 25/11/2026')
    expect(draw(createElement(MarkChip, { chip: { tone: 'neutral', mark: Hourglass, head: 'Waiting on customer', tail: '3 d' } }))).toContain('fw-sheet-stop is-dash')
    const linked = draw(createElement(MarkChip, { chip: { tone: 'warning', mark: Reply, head: 'Needs your answer', href: '/p/alpha/orders/o-1', tip: 'Open Your order 12' } }))
    for (const part of ['<a ', 'class="fw-sheet-chip-door"', 'data-door=""', 'href="/p/alpha/orders/o-1"', 'title="Open Your order 12"']) expect(linked, part).toContain(part)
    const dense = draw(createElement(MarkChip, { chip: { tone: 'warning', mark: Hourglass, head: 'Deposit open', tail: 'due 25/11/2026', dense: true } }))
    expect(text(dense)).toBe('Deposit open')
    expect(dense).not.toContain('lucide-hourglass')
  })

  it('the door cell: a link with its tip, held words with the reason, plain words', () => {
    const linked = draw(createElement(DoorCell, { door, t: sheet, children: '04/12/2026' }))
    expect(linked).toMatch(/^<a class="fw-sheet-door"[^>]*>04\/12\/2026<\/a>$/)
    for (const part of ['href="/w/DEMO/sales/orders/o-1?tab=lines"', 'data-door=""', `title="${sheet('door.promise', { number: 'SO-0001' })}"`]) expect(linked, part).toContain(part)
    expect(draw(createElement(DoorCell, { door, t: sheet, strong: true, children: 'x' }))).toContain('class="fw-sheet-door strong"')
    expect(draw(createElement(DoorCell, { door: { held: { key: 'held.shipping' } }, t: sheet, children: '2' }))).toContain('class="fw-sheet-held" tabindex="0"')
    expect(draw(createElement(DoorCell, { door: null, t: sheet, children: '—' }))).toBe('<span class="fw-sheet-plain">—</span>')
  })

  it('Promised, office: the day as its door with the Late tag beside it; "No promise" wraps quietly; Shipped: the bar and "n of m"', () => {
    const late = draw(createElement(PromiseCell, { cell: { face: 'office', day: '04/12/2026', door, lateDays: 3 }, t: sheet }))
    expect(late).toMatch(/^<span class="fw-so-inline"><a class="fw-sheet-door"/)
    expect(text(late)).toBe('04/12/2026 3 days late')
    expect(text(draw(createElement(PromiseCell, { cell: { face: 'office', day: '04/12/2026', door, lateDays: null }, t: sheet })))).toBe('04/12/2026')
    expect(draw(createElement(PromiseCell, { cell: { face: 'office', day: null, door }, t: sheet }))).toMatch(/^<span class="fw-sheet-wraps is-quiet"><a class="fw-sheet-door"[^>]*>No promise<\/a><\/span>$/)
    const shipped = draw(createElement(ShippedCell, { cell: { shipped: 40, units: 114, record: 'SO-0001', door }, t: sheet }))
    expect(shipped).toMatch(/^<span class="fw-so-progress"><span/)
    expect(shipped).toContain('aria-label="Pieces of SO-0001 shipped"')
    expect(text(shipped)).toContain('40 of 114')
    expect(shipped).not.toMatch(/^<span class="fw-so-progress" title=/)
  })

  it('a time at the end stays whole (moved unchanged)', () => {
    expect(tailWhole('Waiting on customer · 16 d', '16 d')).toBe('Waiting on customer ·\u00a016\u00a0d')
    expect(tailWhole('Asked production · now', '16 d')).toBe('Asked production · now')
  })
})

describe('pg-w1: the customer face (Z4: one fact, one place)', () => {
  it('Promised: "was …" under a day that moved, "date asked" while nothing is promised, "wanted" for a request; none: "No promise" / "—"', () => {
    const moved = draw(createElement(PromiseCell, { cell: { face: 'customer', day: '04/12/2026', door, was: '28/11/2026' }, t: sheet }), 'outside')
    expect(moved).toContain('class="fw-oc-stack"')
    expect(moved).toContain('<span class="fw-oc-sub is-warn">was 28/11/2026</span>')
    expect(text(draw(createElement(PromiseCell, { cell: { face: 'customer', day: '04/12/2026', door }, t: sheet }), 'outside'))).toBe('04/12/2026')
    expect(draw(createElement(PromiseCell, { cell: { face: 'customer', day: '01/12/2026', of: 'asked', door }, t: sheet }), 'outside')).toContain('<span class="fw-oc-sub">date asked</span>')
    expect(draw(createElement(PromiseCell, { cell: { face: 'customer', day: '01/12/2026', of: 'wanted', door }, t: sheet }), 'outside')).toContain('<span class="fw-oc-sub">wanted</span>')
    expect(text(draw(createElement(PromiseCell, { cell: { face: 'customer', day: null, door }, t: sheet }), 'outside'))).toBe('No promise')
    expect(draw(createElement(PromiseCell, { cell: { face: 'customer', day: null, of: 'wanted', door: null }, t: sheet }), 'outside')).toBe('<span class="fw-oc-sub">—</span>')
    // Italian, the customer's words.
    expect(draw(createElement(PromiseCell, { cell: { face: 'customer', day: '04/12/2026', door, was: '28/11/2026' }, t: sheet }), 'outside', 'it')).toContain('era il 28/11/2026')
  })

  it('Shipped: the next parcel, named by the order (D6), is the cell\'s tip', () => {
    const tip = 'Next parcel: Your order 12 · parcel 2 · expected 04/12/2026'
    expect(draw(createElement(ShippedCell, { cell: { shipped: 40, units: 114, record: 'Your order 12', door, tip }, t: sheet }), 'outside')).toMatch(new RegExp(`^<span class="fw-so-progress" title="${tip}">`))
  })

  it('every customer word of the cells in both languages, no raw key', () => {
    for (const locale of LOCALES) {
      const w = createTranslator(locale, messagesFor(locale, ['order-list'])['order-list']!)
      for (const key of ['mark.needsYou', 'promise.was', 'promise.asked', 'promise.wanted', 'shipped.asked', 'shipped.tip', 'shipped.parcel']) expect(w(`customer.${key}`, { date: 'd', count: 2, name: 'n', order: 12, n: 1 }), `${locale} ${key}`).not.toBe(`customer.${key}`)
    }
    const en = createTranslator('en', messagesFor('en', ['order-list'])['order-list']!)
    const it_ = createTranslator('it', messagesFor('it', ['order-list'])['order-list']!)
    expect([en('customer.shipped.parcel', { order: 12, n: 2 }), it_('customer.shipped.parcel', { order: 12, n: 2 })]).toEqual(['Your order 12 · parcel 2', 'Vostro ordine 12 · collo 2'])
    expect([en('customer.mark.needsYou'), it_('customer.mark.needsYou')]).toEqual(['Needs your answer', 'Attende la vostra risposta'])
  })
})
