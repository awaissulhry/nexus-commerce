import { describe, expect, it } from 'vitest'
import { order } from '../../_demo/fixtures'
import { linkedRecordsOf } from './linked'

/** F-OO-100 (order overview lane: one file per section) — Linked records' rules, moved with linked.ts out of overview.vitest.test.ts unchanged. */

describe('Overview’s facts (F-SA-233): Linked records', () => {
  it('linked records: counts of what the reader sees, each a real link; invoices held in words without the right (no number); left-out work orders counted', () => {
    const value = order('SHIPPED')
    const work = { workOrders: [], mtm: [{ style: null, colourway: null, units: 3, workOrders: 3, byStatus: [], own: { cells: 3, pieces: 3, cut: 3, sewn: 0, checked: 0 } }], workOrdersLeftOut: 1, notInProduction: { lines: 0, pieces: 0 } }
    const full = linkedRecordsOf({ order: value, prefix: '/w/demo', can: { viewQuotes: true, viewInvoices: true }, work, complaints: 2, returns: 0, sameQuote: [{ id: 'o2', number: 'SO-2026-0151' }] })
    const byKey = (key: string) => full.records.find((entry) => entry.key === key)!
    expect(byKey('workOrders').count).toBe(3)
    expect(full.workOrdersLeftOut).toBe(1)
    expect(byKey('invoices')).toMatchObject({ count: value.chain.invoices.length, held: null })
    expect(byKey('invoices').href ?? '').toMatch(/tab=money#invoices$|^$/)
    expect(byKey('complaints')).toMatchObject({ count: 2, href: `/w/demo/sales/orders/${value.id}?tab=shipments` })
    expect(byKey('returns')).toMatchObject({ count: 0, href: null })
    expect(byKey('sameQuote')).toMatchObject({ href: '/w/demo/sales/orders/o2' })
    const held = linkedRecordsOf({ order: value, prefix: '/w/demo', can: { viewQuotes: false, viewInvoices: false }, work: null, complaints: null, returns: null, sameQuote: [] })
    expect(held.records.find((entry) => entry.key === 'invoices')).toEqual({ key: 'invoices', count: null, words: null, href: null, held: { key: 'money.noInvoiceRight' } }) // F-OP-306: the Money tab's own sentence
    expect(held.records.some((entry) => entry.key === 'complaints' || entry.key === 'returns')).toBe(false)
    expect(held.records.find((entry) => entry.key === 'quote')?.href ?? null).toBeNull()
  })
})

// ---- F-OP-104 (order page plan N1; 10-order-page §3.1, §3.3, §3.4; review N-1, R-19): Overview's doors ----------------------------
describe('F-OP-104: Overview doors — linked records keep the dock\'s scope', () => {
  it('linked records: the order\'s own tabs through tabHref — the dock\'s scope kept, the narrow view\'s terms dropped', () => {
    const value = order('SHIPPED')
    const linked = linkedRecordsOf({ order: value, prefix: '/w/demo', can: { viewQuotes: true, viewInvoices: true }, work: null, complaints: 1, returns: 0, sameQuote: [], search: 'tab=overview&thread=all&open=r1' })
    const byKey = (key: string) => linked.records.find((entry) => entry.key === key)!
    expect(byKey('complaints').href).toBe(`/w/demo/sales/orders/${value.id}?tab=shipments&thread=all`)
    expect(byKey('deposit').href).toBe(`/w/demo/sales/orders/${value.id}?tab=money&thread=all`)
    if (value.chain.invoices.length > 0) expect(byKey('invoices').href).toBe(`/w/demo/sales/orders/${value.id}?tab=money&thread=all#invoices`)
  })
})
// ---- end F-OP-104
