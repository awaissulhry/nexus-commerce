import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES, type Locale } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { canOf, order } from '../_demo/fixtures'
import { PRICE_CHECK } from '../price-check/fixtures'
import { designScreen } from './fixtures'
import { asksPriceCheck, BRAND_PRICE_EVENT, customerUnitOf, editHeldOf, HISTORY_TYPE, historyHref, isEmptyCheck, seqList, sourceLinesOf, takeOverRefusalOf, totalPiecesOf, type PriceCheckRead } from './price-check-card'
import type { OrderRecordModel } from './record-model'
import { PriceCheckSection } from './view/PriceCheckSection'

/**
 * F-CP-142 (customer page plan C2d, C3; design 11-money §3.3, picture 21; review A3) — the order page's Money › "Price check" card:
 * its rules (who reads it, the empty and closed states, the sources, History's address, a refused take-over), the card drawn in each
 * state in both languages, and the money wall: as Sales worker / as Production manager ONE line of words, no table, no figure, and
 * nothing asked of the API. Every name and number is made up.
 */

const ORDER = order('CONFIRMED')
const ready = (extra: Partial<Extract<PriceCheckRead, { state: 'ready' }>> = {}): PriceCheckRead => ({ state: 'ready', check: PRICE_CHECK, stale: false, taking: false, problem: null, ...extra })
const record = (price: boolean, read: PriceCheckRead | null, over: Partial<OrderRecordModel> = {}) =>
  ({ prefix: '/w/DEMO', can: { ...canOf('owner'), price }, priceCheck: read ? { read, canHistory: true } : null, ...over }) as unknown as OrderRecordModel
const draw = (model: OrderRecordModel, locale: Locale = 'en') =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['orders', 'shell']) }, createElement(PriceCheckSection, { record: model, order: ORDER })))

describe('F-CP-142: who reads the card, and when', () => {
  it('only a price holder, while Money shows: anyone else is held in words and nothing is asked', () => {
    expect(asksPriceCheck({ price: true }, 'money')).toBe(true)
    expect(asksPriceCheck({ price: true }, 'lines')).toBe(false)
    // As Sales worker (no price grain since B-CP-011) and as Production manager: no read at all.
    expect(asksPriceCheck({ price: false }, 'money')).toBe(false)
    expect(asksPriceCheck(canOf('manager'), 'money')).toBe(false)
    expect(BRAND_PRICE_EVENT).toBe('sales_order.brand_price_changed')
  })

  it('the hook asks only through asksPriceCheck and draws the held line without a price grain (the source says so)', () => {
    const hook = readFileSync(new URL('./use-price-check-card.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const asks = asksPriceCheck(can, tab)')
    expect(hook).toMatch(/if \(!asks\) \{[\s\S]*setRead\(\{ state: 'held' \}\)/)
    expect(hook).toContain("!can.price ? { state: 'held' }")
    // The live re-read listens only while the card asks.
    expect(hook).toMatch(/useLive\([\s\S]*BRAND_PRICE_EVENT[\s\S]*asks,\s*\)/)
  })
})

describe('F-CP-142: the card\'s rules', () => {
  it('empty: no line and no total stored; closed or cancelled and no right hold Customer\'s price… in words', () => {
    expect(isEmptyCheck(PRICE_CHECK)).toBe(false)
    expect(isEmptyCheck({ lines: PRICE_CHECK.lines.map((line) => ({ ...line, row: null })), total: { ...PRICE_CHECK.total, row: null } })).toBe(true)
    expect(editHeldOf(PRICE_CHECK)).toBeNull()
    expect(editHeldOf({ status: 'CLOSED', mayWrite: { allowed: false, why: null } })).toEqual({ key: 'priceCheck.closed' })
    expect(editHeldOf({ status: 'CANCELLED', mayWrite: { allowed: false, why: null } })).toEqual({ key: 'priceCheck.closed' })
    expect(editHeldOf({ status: 'IN_PRODUCTION', mayWrite: { allowed: false, why: 'x' } })).toEqual({ key: 'held.noManage' })
    // F-OL-04: "Change our price ›" lands on Lines' price box, held by the amendment's own rule (amendHeld) — no edit mode to wait for.
  })

  it('the Total row\'s pieces, a line total has no unit price, the sources grouped in the lines\' order', () => {
    expect(totalPiecesOf(PRICE_CHECK)).toBe(260)
    expect(customerUnitOf(PRICE_CHECK.lines[1]!)).toBe('95.5')
    expect(customerUnitOf({ row: { ...PRICE_CHECK.lines[1]!.row!, unitPrice: null, netAmount: 955_000 } })).toBeNull()
    const sources = sourceLinesOf(PRICE_CHECK)
    expect(sources.map((source) => [source.source, source.seqs, source.file?.name ?? null, source.by])).toEqual([
      ['PORTAL', [1], null, null],
      ['CUSTOMER_PO', [2], 'Brand Alpha PO 4471.pdf', 'Ada Demo'],
    ])
    expect(seqList([4, 1, 2, 2])).toBe('1–2, 4')
    expect(seqList([3])).toBe('3')
  })

  it('History › is the audit of this order\'s customer prices (one history per order)', () => {
    expect(HISTORY_TYPE).toBe('OrderBrandPrice')
    expect(historyHref('/w/DEMO', 'o-1')).toBe('/w/DEMO/admin/audit?type=OrderBrandPrice&record=o-1')
  })

  it('a refused take-over reads the card again and says why; a fault keeps it', () => {
    expect(takeOverRefusalOf(new ApiError('conflict', 409, 'conflict', 'Nothing to take over', 'req-1', []))).toEqual({ reread: true, words: { key: 'priceCheck.stale' } })
    expect(takeOverRefusalOf(new ApiError('invalid', 400, 'validation_failed', 'closed', 'req-1', [{ path: 'body', message: 'x' }]))).toEqual({ reread: true, words: { key: 'priceCheck.closed' } })
    expect(takeOverRefusalOf(new ApiError('invalid', 400, 'validation_failed', 'not the request', 'req-1', [{ path: 'body/requestId', message: 'x' }]))).toEqual({ reread: true, words: { key: 'priceCheck.stale' } })
    expect(takeOverRefusalOf(new Error('network')).reread).toBe(false)
  })
})

describe('F-CP-142: the card, drawn', () => {
  for (const locale of LOCALES) {
    it(`every state in ${locale} with no key left on screen`, () => {
      for (const read of [ready(), ready({ stale: true }), ready({ problem: { key: 'priceCheck.closed' } }), { state: 'loading' } as const, { state: 'failed', problem: 'problem.read.unavailable' } as const]) {
        const html = draw(record(true, read), locale)
        expect(html.match(/\bpriceCheck\.[a-zA-Z.]+/)?.[0] ?? null).toBeNull()
        expect(html.match(/\bsummary\.[a-zA-Z.]+/)?.[0] ?? null).toBeNull()
      }
    })
  }

  it('filled: the eight columns, the Total row, Not equal · 1 line, the signed difference, where it came from, the three doors', () => {
    const html = draw(record(true, ready()))
    for (const words of ['Price check', 'Line', 'Pieces', 'Our unit price', 'Customer&#x27;s unit price', 'Our amount', 'Customer&#x27;s amount', 'Check', 'Difference', 'Total', 'Not equal', '1 line', 'we ask more', 'Where the customer&#x27;s price came from', 'From the portal', 'From the customer&#x27;s PO', 'Brand Alpha PO 4471.pdf', 'Priced document', 'typed by Ada Demo', 'Customer&#x27;s price…', 'Change our price ›', 'History ›']) expect(html, words).toContain(words)
    expect(html).toContain('/w/DEMO/admin/audit?type=OrderBrandPrice&amp;record=')
    expect(html).toContain('1 of 3 lines without the customer&#x27;s price')
  })

  it('empty: "No customer price yet" (never Equal), the take-over row, Customer\'s price… the primary', () => {
    const check = { ...PRICE_CHECK, lines: PRICE_CHECK.lines.map((line) => ({ ...line, brandAmount: null, priceMatch: 'NO_BRAND_PRICE' as const, priceDiff: null, row: null })), total: { ...PRICE_CHECK.total, priceMatch: 'NO_BRAND_PRICE' as const }, fromRequest: { requestId: 'r-1', number: 'RQ-0087', lines: 2 } }
    const html = draw(record(true, ready({ check })))
    expect(html).toContain('No customer price yet')
    expect(html).toContain('Request RQ-0087 named the customer&#x27;s prices')
    expect(html).toContain('Take them over')
    expect(html).not.toContain('>Equal<')
  })

  it('stale: ONE line "Someone changed these prices meanwhile. Here they are now."; closed: held in words', () => {
    expect(draw(record(true, ready({ stale: true })))).toContain('Someone changed these prices meanwhile. Here they are now.')
    const closed = draw(record(true, ready({ check: { ...PRICE_CHECK, status: 'CLOSED', mayWrite: { allowed: false, why: null } } })))
    expect(closed).toContain('A closed or cancelled order keeps its prices.')
  })

  it('as Sales worker / as Production manager: one line, no table, no figure, no count — whatever the container holds', () => {
    for (const model of [record(false, null), record(false, ready())]) {
      for (const locale of LOCALES) {
        const html = draw(model, locale)
        expect(html).toContain(locale === 'en' ? 'Shown to people who see prices' : 'Visibili a chi vede i prezzi')
        expect(html).not.toContain('<table')
        expect(html).not.toMatch(/€|EUR|\d+[.,]\d{2}/)
        expect(html).not.toContain('Not equal')
        expect(html).not.toContain('Brand Alpha PO 4471.pdf')
      }
    }
  })

  it('a price holder without the container\'s read (a design case): nothing drawn, never the held line', () => {
    expect(draw(record(true, null))).toBe('')
  })
})

describe('F-CP-142: the design cases', () => {
  it('SCR-039 holds the card\'s states: filled, empty, stale, closed, loading, error, the window, held', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['price-check', 'price-check-empty', 'price-check-stale', 'price-check-closed', 'price-check-loading', 'price-check-error', 'price-check-dialog', 'price-check-held']) expect(ids).toContain(id)
    const held = designScreen.cases.find((item) => item.id === 'price-check-held')!.model as { role: string; record: OrderRecordModel }
    expect(held.record.can.price).toBe(false)
    expect(draw(held.record)).toContain('Shown to people who see prices')
  })

  // F-OM-101: the tab's layout moved (money/view/MoneyTab.tsx): Price check is its fourth section, after Totals, Payments and Invoices,
  // and only with the price grain (the tab's head says the money wall once; W3 moves the card itself).
  it('MoneyTab mounts the card with ONE marked line, after Totals, Payments and Invoices, with the price grain only', () => {
    const tab = readFileSync(new URL('./money/view/MoneyTab.tsx', import.meta.url), 'utf8')
    const mounts = tab.split('\n').filter((line) => line.includes('<PriceCheckSection'))
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toContain('F-CP-142')
    expect(mounts[0]).toContain('model.can.price && <PriceCheckSection record={model} order={order} actions={actions} />')
    for (const before of ['<TotalsSection', '<PaymentsSection', '<InvoicesSection']) expect(tab.indexOf('<PriceCheckSection'), before).toBeGreaterThan(tab.indexOf(before))
  })
})
