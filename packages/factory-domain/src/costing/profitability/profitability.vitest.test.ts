import { describe, expect, it } from 'vitest'
import { alertPhrase, phraseText } from '../../alerts/rules'
import { KINDS } from '../../alerts/kinds'
import { templateOf } from '../../auth/roles/templates'
import { forOrderOf, invoiceKindOf, paidOf, sharedInvoice, totalsOf } from './documents'
import { belowCount, floorFlagOf, underFloor, watched } from './floor'

/**
 * Margins in depth (B-W2b-416; FIN-050, FIN-053): the floor flag reads the final margin once final and the estimate
 * before, with the quote's own rule at the boundary; the low-margin alert's words carry no figure; an invoice of several
 * orders counts only this order's lines; a reversal takes a payment's placement back; the totals add only what is in the
 * order's currency. Every figure is made up and worked out by hand (cents).
 */

describe('the floor flag', () => {
  it('is the quote rule: margin × 100 < floor × value, so exactly on the floor is not below', () => {
    // 25.00 % of 1,000.00 = 250.00: a margin of 250.00 is on the floor, 249.99 below it.
    expect(underFloor(25_000, 100_000, '25')).toBe(false)
    expect(underFloor(24_999, 100_000, '25')).toBe(true)
    expect(underFloor(24_999, 100_000, '24.999')).toBe(false)
    // Nothing to sell: below only at a loss.
    expect(underFloor(0, 0, '25')).toBe(false)
    expect(underFloor(-1, 0, '25')).toBe(true)
  })

  it('reads the estimate while the order is open and the final margin once it is final; unknown is never "fine"', () => {
    const open = { final: false, value: 120_000, estimateMargin: 26_400, actualMargin: 60_000 }
    // 22 % estimated now against a 25 % floor: below — the actual so far (50 %) reads high and is never the basis.
    expect(floorFlagOf(open, '25')).toEqual({ below: true, basis: 'ESTIMATE' })
    expect(floorFlagOf({ ...open, final: true, actualMargin: 31_200 }, '25')).toEqual({ below: false, basis: 'FINAL' })
    expect(floorFlagOf({ ...open, estimateMargin: null }, '25')).toEqual({ below: null, basis: null })
    expect(floorFlagOf({ ...open, final: true, actualMargin: null }, '25')).toEqual({ below: null, basis: null })
    expect(floorFlagOf(open, null)).toEqual({ below: null, basis: null })
    expect(belowCount([{ below: true, basis: 'ESTIMATE' }, { below: null, basis: null }, { below: false, basis: 'FINAL' }, { below: true, basis: 'FINAL' }])).toBe(2)
  })

  it('watches orders made, being made or on their way — not one waiting for its yes, closed or cancelled', () => {
    expect(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED'].every(watched)).toBe(true)
    expect(['PENDING_APPROVAL', 'CLOSED', 'CANCELLED'].some(watched)).toBe(false)
  })
})

describe('the low-margin alert', () => {
  it('tells finance, is seen with the margin grain, and says no figure', () => {
    const spec = KINDS.MARGIN_BELOW_FLOOR
    expect(spec).toMatchObject({ trigger: 'CONDITION', recordType: 'SalesOrder', view: 'money.margin', builtIn: { recipientRole: 'finance', threshold: {} } })
    expect(templateOf('finance')!.grains).toContain('margin')
    // Production managers and buyers read margins without the margin grain: they never see the alert.
    expect(templateOf('production_manager')!.grains).not.toContain('margin')
    expect(templateOf('buyer')!.grains).not.toContain('margin')
    const estimate = alertPhrase('MARGIN_BELOW_FLOOR', 'SO-2026-1043', { basis: 'ESTIMATE', quotedBelow: false, status: 'IN_PRODUCTION' })
    expect(phraseText(estimate, 'SO-2026-1043')).toBe('The margin of order SO-2026-1043, as estimated now, is below its margin floor.')
    expect(phraseText(alertPhrase('MARGIN_BELOW_FLOOR', 'SO-2026-1043', { basis: 'FINAL', quotedBelow: true }), 'SO-2026-1043', 'it')).toBe("Il margine finale dell'ordine SO-2026-1043 è sotto il suo margine minimo.")
    expect(alertPhrase('MARGIN_BELOW_FLOOR', 'SO-2026-1043', { basis: 'ESTIMATE', quotedBelow: true })!.key).toBe('alerts.MARGIN_BELOW_FLOOR.QUOTED')
    expect(estimate!.params).toEqual({ label: 'SO-2026-1043' })
  })
})

describe('the documents', () => {
  const ORDER = '0190f0e2-0000-7000-8000-000000000001'

  it('name each invoice by its kind', () => {
    expect(['TD01', 'TD24', 'TD02', 'TD05', 'TD04', 'TD17'].map(invoiceKindOf)).toEqual(['INVOICE', 'DEFERRED_INVOICE', 'DEPOSIT_INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'OTHER'])
  })

  it("count this order's lines of an invoice of several orders, else the whole invoice when it names the order", () => {
    const lines = [
      { netAmount: 84_000, mine: true, ofAnOrder: true },
      { netAmount: 42_000, mine: false, ofAnOrder: true },
      { netAmount: 1_500, mine: false, ofAnOrder: false },
    ]
    expect(forOrderOf({ salesOrderId: null, netTotal: 127_500 }, ORDER, lines)).toBe(84_000)
    expect(sharedInvoice(lines)).toBe(true)
    // A deposit invoice names the order and none of its lines.
    expect(forOrderOf({ salesOrderId: ORDER, netTotal: 36_000 }, ORDER, [{ netAmount: 36_000, mine: false }])).toBe(36_000)
    expect(forOrderOf({ salesOrderId: null, netTotal: 36_000 }, ORDER, [{ netAmount: 36_000, mine: false }])).toBe(0)
    expect(sharedInvoice([{ mine: true, ofAnOrder: true }, { mine: false, ofAnOrder: false }])).toBe(false)
  })

  it("add a payment's placements, a reversal taking one back", () => {
    expect(paidOf([{ amount: 50_000 }, { amount: 20_000 }, { amount: -20_000 }])).toBe(50_000)
  })

  it("total only what is issued and in the order's currency; a deposit invoice is listed, not added", () => {
    const totals = totalsOf({
      currency: 'EUR',
      invoices: [
        { kind: 'DEPOSIT_INVOICE', status: 'DELIVERED', currency: 'EUR', forOrder: 36_000 },
        { kind: 'INVOICE', status: 'SENT', currency: 'EUR', forOrder: 120_000 },
        { kind: 'DEBIT_NOTE', status: 'ISSUED', currency: 'EUR', forOrder: 2_000 },
        { kind: 'CREDIT_NOTE', status: 'ISSUED', currency: 'EUR', forOrder: 6_000 },
        { kind: 'INVOICE', status: 'DRAFT', currency: 'EUR', forOrder: 9_999 },
        { kind: 'INVOICE', status: 'REJECTED', currency: 'EUR', forOrder: 8_888 },
        { kind: 'INVOICE', status: 'ISSUED', currency: 'USD', forOrder: 7_777 },
      ],
      payments: [
        { currency: 'EUR', paid: 36_000 },
        { currency: 'EUR', paid: 80_000 },
        { currency: 'CHF', paid: 1_000 },
      ],
      freight: [
        { chargeCurrency: 'EUR', charge: 2_500, costCurrency: 'EUR', cost: 1_800 },
        { chargeCurrency: 'EUR', charge: null, costCurrency: 'USD', cost: 2_000 },
        { chargeCurrency: 'EUR', charge: 1_000, costCurrency: null, cost: null },
      ],
    })
    // Invoiced 120,000 + 2,000 = 122,000; credited 6,000; net 116,000; three documents in another currency left out.
    expect(totals).toEqual({ invoiced: 122_000, credited: 6_000, net: 116_000, deposits: 36_000, paid: 116_000, freightCharged: 3_500, freightCost: 1_800, otherCurrency: 3 })
  })
})
