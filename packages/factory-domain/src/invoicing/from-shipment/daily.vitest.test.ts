import { describe, expect, it } from 'vitest'
import { invoiceTypePreset } from '../../sales/terms/terms'
import { chooseInvoiceType, draftDeadline, presetDeadline } from './deadlines'
import { orderSettlement, type SettlementFacts } from './settlement'
import { notInvoiced, pickPart, type InvoicedQuantity, type ShippedQuantity } from './shipped'

// B-W2a-54: invoicing every day — the customer's preset (FIN-065), a part of a shipment (FIN-058), closed-short lines.
// Every DDT, order and amount here is made up.

const D1 = '019a0000-0000-7000-8000-0000000000d1'
const D2 = '019a0000-0000-7000-8000-0000000000d2'
const L1 = '019a0000-0000-7000-8000-0000000000a1'
const L2 = '019a0000-0000-7000-8000-0000000000a2'

describe("the customer's preset: TD01 per shipment, TD24 monthly (FIN-065; DPR 633/1972 art. 21 c.4)", () => {
  const one = [{ number: '12/2026', date: '2026-10-25' }]

  it('monthly: a single DDT in its 12 days gets the deferred invoice, said so; per shipment keeps the W1 rule', () => {
    expect(invoiceTypePreset('MONTHLY')).toBe('TD24')
    const monthly = chooseInvoiceType(one, '2026-10-29', undefined, 'body/docType', 'TD24')
    expect(monthly).toMatchObject({ docType: 'TD24', suggested: 'TD24', allowed: ['TD01', 'TD24'], deadline: { docType: 'TD24', dueBy: '2026-11-15' } })
    expect(monthly.words).toBe(
      'The customer is invoiced once a month: one deferred invoice (TD24) for the DDTs of 2026-10. Deferred invoice (TD24) for the DDTs of 2026-10 by 15/11/2026, the 15th of the next month (DPR 633/1972 art. 21 c.4 lett. a): 17 days left.',
    )
    expect(chooseInvoiceType(one, '2026-10-29', undefined, 'body/docType', 'TD01')).toMatchObject({ docType: 'TD01', suggested: 'TD01' })
    // The office may still pick the other while it is in time.
    expect(chooseInvoiceType(one, '2026-10-29', 'TD01', 'body/docType', 'TD24')).toMatchObject({ docType: 'TD01', suggested: 'TD24' })
  })

  it('a preset the law does not allow is not suggested: several DDTs are a TD24, a late month is a TD01', () => {
    const two = [...one, { number: '13/2026', date: '2026-10-27' }]
    expect(chooseInvoiceType(two, '2026-10-29', undefined, 'body/docType', 'TD01')).toMatchObject({ docType: 'TD24', suggested: 'TD24', allowed: ['TD24'] })
    expect(chooseInvoiceType(one, '2026-11-20', undefined, 'body/docType', 'TD24')).toMatchObject({ docType: 'TD01', suggested: 'TD01', allowed: ['TD01'] })
  })

  it("each DDT's own deadline by the preset: monthly the 15th; per shipment its 12 days, then the 15th, then late", () => {
    expect(presetDeadline(one[0]!, 'TD24', '2026-10-29')).toMatchObject({ docType: 'TD24', dueBy: '2026-11-15', daysLeft: 17, state: 'OPEN' })
    expect(presetDeadline(one[0]!, 'TD01', '2026-10-29')).toMatchObject({ docType: 'TD01', dueBy: '2026-11-06', daysLeft: 8, state: 'OPEN' })
    expect(presetDeadline(one[0]!, 'TD01', '2026-11-04')).toMatchObject({ docType: 'TD01', state: 'DUE_SOON', daysLeft: 2 })
    expect(presetDeadline(one[0]!, 'TD01', '2026-11-09')).toMatchObject({ docType: 'TD24', dueBy: '2026-11-15', daysLeft: 6, state: 'OPEN' })
    expect(presetDeadline(one[0]!, 'TD01', '2026-11-20')).toMatchObject({ docType: 'TD01', dueBy: '2026-11-06', state: 'LATE' })
    expect(presetDeadline(one[0]!, 'TD24', '2026-11-20')).toMatchObject({ docType: 'TD24', state: 'LATE', words: expect.stringContaining('late by 5 days') })
  })

  it("a draft's countdown: a TD01 by its DDT's 12 days, a TD24 by the 15th; none without a DDT", () => {
    const ddts = [{ number: '13/2026', date: '2026-10-27' }, ...one]
    expect(draftDeadline('TD01', ddts, '2026-10-29')).toMatchObject({ docType: 'TD01', dueBy: '2026-11-06' })
    expect(draftDeadline('TD24', ddts, '2026-10-29')).toMatchObject({ docType: 'TD24', dueBy: '2026-11-15' })
    expect(draftDeadline('TD24', [], '2026-10-29')).toBeNull()
  })
})

describe('partial invoicing per shipment (FIN-058): a part of what is left, never more', () => {
  const shipped: ShippedQuantity[] = [
    { ddtId: D1, salesOrderLineId: L1, size: '52', quantity: 3 },
    { ddtId: D1, salesOrderLineId: L2, size: '50', quantity: 2 },
  ]
  const invoiced: InvoicedQuantity[] = [{ invoiceId: 'inv-1', number: 'FT-2026-00005', draft: false, ddtId: D1, salesOrderLineId: L1, size: '52', quantity: '1.0000' }]
  const rows = notInvoiced(shipped, invoiced)
  const numbers = new Map([[D1, '144/2026'], [D2, '145/2026']])

  it('picks only the garments asked, each at most what neither an issued invoice nor a draft holds', () => {
    const part = pickPart(rows, [{ ddtId: D1, salesOrderLineId: L1, size: '52', quantity: 2 }], numbers)
    expect(part.problems).toEqual([])
    expect(part.rows).toHaveLength(1)
    expect(part.rows[0]).toMatchObject({ ddtId: D1, salesOrderLineId: L1, size: '52' })
    expect(part.rows[0]!.toInvoice.toString()).toBe('2')
  })

  it('refuses in words: above what is left, a part the DDT did not carry, the same part twice, no garment', () => {
    const part = pickPart(
      rows,
      [
        { ddtId: D1, salesOrderLineId: L1, size: '52', quantity: 3 },
        { ddtId: D2, salesOrderLineId: L1, size: '52', quantity: 1 },
        { ddtId: D1, salesOrderLineId: L2, size: '50', quantity: 1 },
        { ddtId: D1, salesOrderLineId: L2, size: '50', quantity: 1 },
        { ddtId: D1, salesOrderLineId: L2, size: '48', quantity: 0 },
      ],
      numbers,
    )
    expect(part.problems).toEqual([
      { path: 'body/lines/0/quantity', message: 'DDT 144/2026 size 52: 2 left to invoice (shipped 3, invoiced 1, in drafts 0); asked 3.' },
      { path: 'body/lines/1', message: 'DDT 145/2026 size 52: the DDTs chosen did not carry this order line and size.' },
      { path: 'body/lines/3', message: 'DDT 144/2026 size 50 of this order line is asked twice: ask it once, with the garments to invoice.' },
      { path: 'body/lines/4/quantity', message: 'Whole garments, 1 or more.' },
    ])
    expect(part.rows.map((row) => row.size)).toEqual(['50'])
  })
})

describe('a line closed short settles on what shipped (B-W2a-30 SAL-210)', () => {
  const facts = (closedShort: boolean): SettlementFacts => ({
    order: { id: 'o1', number: 'SO-0007', status: 'PARTLY_SHIPPED', currency: 'EUR' },
    lines: [{ salesOrderLineId: L1, seq: 10, description: 'Giacca', sizes: [{ size: '52', ordered: 3 }, { size: '54', ordered: 1 }], closedShort }],
    shipped: [{ salesOrderLineId: L1, size: '52', quantity: 2 }],
    invoiced: [{ salesOrderLineId: L1, size: '52', quantity: '2.0000' }],
    invoices: [{ id: 'inv-1', docType: 'TD01', number: 'FT-2026-00006', status: 'DELIVERED', grossTotal: 102_480, creditedGross: 0, paid: 102_480 }],
    depositRequests: [],
    depositInvoices: [],
    creditNotes: [],
  })

  it('open: the pieces never shipped are owed; closed short: they are done, and the order settles', () => {
    expect(orderSettlement(facts(false)).missing.map((gap) => gap.code)).toEqual(['NOT_SHIPPED'])
    const closed = orderSettlement(facts(true))
    expect(closed).toMatchObject({ settled: true, fullyShipped: true, fullyInvoiced: true })
    expect(closed.lines.map((line) => [line.size, line.toShip, line.closedShort])).toEqual([
      ['52', 0, 1],
      ['54', 0, 1],
    ])
  })
})
