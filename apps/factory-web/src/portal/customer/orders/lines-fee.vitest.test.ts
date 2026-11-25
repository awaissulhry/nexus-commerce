import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { SALES_LINE_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { changeRequestSchema, orderRecordSchema, rulesSchema, type OrderLine, type OrderRecord } from './api'
import { orderBandOf, orderTabsOf, type OrderBandFacts } from './band'
import { documentsRead, orderRecord, orderWords, PREFIX, progressRead, requestsOf, rulesOf, shellOf, shipmentsRead } from './design-data'
import { RECORD_TABS, shownLinesOf, type RecordTab } from './model'
import { CustomerCase, type CustomerCaseModel } from './view/CustomerCase'
import type { OrderRecordViewModel } from './view/OrderRecordView'

/**
 * pp-w1 (w1.4; lane pp-, round 1) — PW-O03 (O3-B1): an order with a charge line (FEE) loads. The API sends every line kind
 * (SALES_LINE_KINDS); the web's line schema took only sizes and made to measure, so ONE charge failed the whole page. Now it parses,
 * every tab draws, Lines and the tab strip skip it (round 1 draws no charge line; the order's totals count it), and the Change dialog
 * offers no charge line (it draws the change rules, which never list one). And the web half of 13-backend C-1 / C-1b: the order,
 * its requests and its change rules are read without the office's shared series. Made-up data only.
 */

const FEE_ID = '0190f0e2-1910-7000-8000-000000000299'
const FEE_WORDS = 'Sample making charge'
const feeLine = (base: OrderLine): OrderLine => ({
  ...base,
  id: FEE_ID,
  seq: 3,
  kind: 'FEE',
  style: null,
  colourway: null,
  description: FEE_WORDS,
  measurement: null,
  baseSize: null,
  quantity: 1,
  unitPrice: '150.00',
  netAmount: 15000,
  vatAmount: 3300,
  requestedDate: null,
  promiseDate: null,
  closedShort: null,
  sizes: [],
  pieces: { ordered: 1, shipped: 0, open: 1 },
})
const withFee = (): OrderRecord => {
  const record = orderRecord()
  return { ...record, lines: [...record.lines, feeLine(record.lines[0]!)] }
}
const FACTS: OrderBandFacts = { ask: { held: null }, cancelHeld: null, reconfirm: null, confirmation: true, pay: null }

function modelOf(record: OrderRecord, tab: RecordTab): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    tab,
    prefix: PREFIX,
    offlineSince: null,
    notice: null,
    revision: { state: 'ready', page: null },
    reconfirmHeld: null,
    progress: { state: 'ready', read: progressRead() },
    requests: { state: 'ready', items: requestsOf() },
    withdrawHeld: null,
    changeHeld: null,
    pay: {},
    shipments: { state: 'ready', read: shipmentsRead() },
    documents: { state: 'ready', read: documentsRead() },
    fileHeld: null,
    openLine: null,
    copied: null,
    dialog: null,
    frame: { mode: 'docked' },
  }
}
const draw = (record: OrderRecord, tab: RecordTab, locale: Locale) =>
  render(createElement(CustomerCase, { model: (at: Locale): CustomerCaseModel => ({ shell: shellOf(at, orderBandOf({ words: orderWords(at), record, prefix: PREFIX, facts: FACTS })), body: { kind: 'record', model: modelOf(record, tab), thread: null } }) }), locale)

describe('PW-O03 — an order with a charge line (FEE) loads', () => {
  it('the line schema takes every kind the API sends; a FEE line parses and stays a FEE line', () => {
    const parsed = orderRecordSchema.parse(withFee())
    expect(parsed.lines.map((line) => line.kind)).toEqual(['SIZE_GRID', 'SIZE_GRID', 'FEE'])
    expect([...SALES_LINE_KINDS]).toContain('FEE')
    for (const kind of SALES_LINE_KINDS) expect(orderRecordSchema.safeParse({ ...withFee(), lines: [{ ...feeLine(orderRecord().lines[0]!), kind }] }).success, kind).toBe(true)
  })

  it('every tab draws, in both languages; Lines and the tab strip skip the charge, the totals keep counting it', () => {
    const record = withFee()
    for (const locale of ['en', 'it'] as const) {
      for (const tab of RECORD_TABS) {
        const html = draw(record, tab, locale)
        expect(html, `${tab} ${locale}`).toContain('main-content')
        expect(html, `${tab} ${locale}`).not.toContain(`line-${FEE_ID}`)
        expect(textOf(html), `${tab} ${locale}`).not.toContain(FEE_WORDS)
      }
    }
    expect(shownLinesOf(record.lines).map((line) => line.id)).toEqual(orderRecord().lines.map((line) => line.id))
    expect(orderTabsOf({ words: orderWords('en'), record, prefix: PREFIX, toConfirm: false, files: null }).find((tab) => tab.id === 'lines')?.count).toBe(orderRecord().lines.length)
    // The order's own amounts (net, VAT, total) are the server's: a charge is in them, not added again here.
    expect(record.order.netAmount).toBe(orderRecord().order.netAmount)
  })

  // The dialogs open in the DS Modal, which draws only in a browser (nothing in a server render): the rule is held by their source
  // and the rules' contract.
  it('the Change dialog offers no charge line: it draws the change rules, which never list one (the API leaves charges out)', () => {
    const dialogs = readFileSync(new URL('./view/Dialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain('{rules.lines.map((line) => (')
    expect(dialogs).not.toMatch(/record\.lines|order\.lines\b/)
    expect(rulesOf().lines.some((line) => (line.kind as string) === 'FEE')).toBe(false)
    expect(rulesSchema.safeParse({ ...rulesOf(), lines: [{ ...rulesOf().lines[0]!, kind: 'FEE' }] }).success).toBe(false)
  })
})

describe('13-backend C-1 / C-1b (web half) — the office’s shared series is never read', () => {
  it('the order, its requests and its change rules drop `number` / `orderNumber` even when an older answer still sends them', () => {
    const order = orderRecordSchema.parse({ ...orderRecord(), order: { ...orderRecord().order, number: 'SO-2026-0141' } })
    expect(Object.keys(order.order)).not.toContain('number')
    const request = changeRequestSchema.parse({ ...requestsOf()[0]!, orderNumber: 'SO-2026-0141' })
    expect(Object.keys(request)).not.toContain('orderNumber')
    const rules = rulesSchema.parse({ ...rulesOf(), order: { ...rulesOf().order, number: 'SO-2026-0141' } })
    expect(Object.keys(rules.order)).not.toContain('number')
    expect(JSON.stringify([order, request, rules])).not.toMatch(/\bSO-\d{4}-\d+/)
  })
})
