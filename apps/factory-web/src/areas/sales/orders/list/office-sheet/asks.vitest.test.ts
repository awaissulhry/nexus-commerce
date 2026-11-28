import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createTranslator, catalogueFor, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { SheetCards } from '../../../../../lib/orders-sheet/view/SheetCards'
import { isPhoneRoom } from '../../../../../lib/orders-sheet/rows'
import type { BrandRequest } from '../../../../home/approvals/requests/api'
import { askAnswerOf, askEntriesOf } from './asks'
import { CONFIRMED_ROW, PRODUCTION_ROW, SENT_ROW, readLine, readRow } from './fixtures'
import { sheetOrderOf } from './map'

const t = createTranslator('en', catalogueFor('en', 'orders-sheet', 'office'))
const request = (id: string, over: Partial<BrandRequest> = {}): BrandRequest => ({ id, version: 4, askedBy: 'Ada Example', askedAt: '2026-11-27T09:00:00Z', answeredIn: 'SALES', ...over }) as BrandRequest

describe('owb-of3 step 4 — the window "The customer asks n changes"', () => {
  const row = readRow({ lines: [readLine(1, { asks: [{ requestId: 'ask-1', column: 'pieces', from: '5', to: '7' }] }), readLine(2, { asks: [{ requestId: 'ask-2', column: 'cancel', from: '', to: '' }] })] })

  it('lists every open ask of the order with who asked and when (today’s request read)', () => {
    const entries = askEntriesOf(row, [request('ask-1'), request('ask-2', { askedBy: null })])
    expect(entries.map((entry) => [entry.ask.requestId, entry.seq, entry.request?.askedBy ?? null])).toEqual([
      ['ask-1', 1, 'Ada Example'],
      ['ask-2', 2, null],
    ])
  })

  it('Yes calls today’s accept with the ask’s own id and version', () => {
    const [entry] = askEntriesOf(row, [request('ask-1', { version: 6 })])
    expect(askAnswerOf(entry!, true, '')).toEqual({ call: 'accept', requestId: 'ask-1', body: { version: 6, answer: null } })
  })

  it('No calls today’s refuse with the words the customer reads — never without words', () => {
    const [entry] = askEntriesOf(row, [request('ask-1')])
    expect(askAnswerOf(entry!, false, '  The leather is cut already. ')).toEqual({ call: 'refuse', request: { id: 'ask-1', answeredIn: 'SALES' }, body: { version: 4, answer: 'The leather is cut already.' } })
    expect(askAnswerOf(entry!, false, '   ')).toEqual({ call: 'none', why: 'noWords' })
  })

  it('an ask whose request is not read yet answers nothing', () => {
    const [entry] = askEntriesOf(row, [])
    expect(askAnswerOf(entry!, true, '')).toEqual({ call: 'none', why: 'notRead' })
  })

  it('the chip "n to answer" opens this window', () => {
    expect(sheetOrderOf(CONFIRMED_ROW, '/w/demo', t).chips.find((chip) => chip.words === '1 to answer')?.door).toEqual({ kind: 'window', target: 'asks:ORDER:order-1' })
  })
})

describe('owb-of3 step 4 — a phone draws cards, never the grid', () => {
  it('under 640 px the sheet is one card per order (picture, number, state, chips, act), with no grid in it', () => {
    expect(isPhoneRoom(375)).toBe(true)
    const orders = [SENT_ROW, PRODUCTION_ROW].map((entry) => sheetOrderOf(entry, '/w/demo', t))
    const html = renderToStaticMarkup(
      createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['orders-sheet', 'order-life', 'record-picture']) }, createElement(SheetCards, { orders, kind: 'office', t, locale: 'en', selected: new Set<string>(), onSelect: () => undefined, onOpen: () => undefined })),
    )
    expect(html.match(/class="fw-osh-card"/g)).toHaveLength(2)
    expect(html).toContain('RQ-0042')
    expect(html).toContain('SO-2026-0102')
    expect(html).not.toContain('ag-root')
  })
})
