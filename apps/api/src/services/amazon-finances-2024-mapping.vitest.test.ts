/**
 * CX A1 — exact Finances 2024-06-19 money mapping. Fixtures: the official model's own examples,
 * verbatim (test-support/amazon-finances-2024-model-examples.json), and schema-shaped variants of
 * them. Every refusal is asserted by NAME: a mapping that refuses for the wrong reason has not been
 * shown to check the thing the test is about.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CURRENCY_MINOR_UNITS, exactDecimal, mapFinances2024, minorToDecimal, statusTransition, toHundredths, toMinorUnits,
} from './amazon-finances-2024-mapping.js'

const model = JSON.parse(readFileSync(new URL('../test-support/amazon-finances-2024-model-examples.json', import.meta.url), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const money = (currencyAmount: unknown, currencyCode = 'EUR') => ({ currencyAmount, currencyCode })
const node = (breakdownType: string, amount: unknown, breakdowns: unknown[] = [], currency = 'EUR') =>
  ({ breakdownType, breakdownAmount: money(amount, currency), breakdowns })

/** A schema-shaped Shipment: Sales > Product Charges > Principle, as the model's examples nest it. */
function shipment(over: Record<string, unknown> = {}) {
  return {
    transactionId: 'tx-1', transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: '2026-09-20T10:00:00.000Z',
    totalAmount: money(15.99),
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: '404-1111111-2222222' }],
    breakdowns: [node('Sales', 15.99, [node('Product Charges', 15.99, [node('Principle', 7.99), node('Principle', 8)])])],
    ...over,
  }
}
const refusal = (tx: unknown) => { const r = mapFinances2024(tx); return r.kind === 'refused' ? r.reason : r.kind }
const row = (tx: unknown) => { const r = mapFinances2024(tx); if (r.kind !== 'row') throw new Error(`expected a row, got ${r.kind}:${'reason' in r ? r.reason : ''}`); return r.row }

describe('the official model examples, verbatim', () => {
  it('refuses the Transaction definition example as published: its status "Released" is not a documented value', () => {
    expect(model.transactionDefinitionExample.transactionStatus).toBe('Released')
    expect(refusal(model.transactionDefinitionExample)).toBe('unknown_status')
  })

  it('with the documented status, refuses its breakdowns: the example nests them in an object, the schema says array', () => {
    const tx = { ...clone(model.transactionDefinitionExample), transactionStatus: 'RELEASED' }
    expect(Array.isArray(tx.breakdowns)).toBe(false)
    expect(refusal(tx)).toBe('malformed_breakdowns')
  })

  it('with both corrected to the schema, maps to one Order row in exact minor units, items validated not added', () => {
    const tx = { ...clone(model.transactionDefinitionExample), transactionStatus: 'RELEASED' }
    tx.breakdowns = tx.breakdowns.breakdowns
    const r = mapFinances2024(tx)
    expect(r.kind).toBe('row')
    const mapped = row(tx)
    expect(mapped).toMatchObject({
      providerTransactionId: 'b1qD0oAliFkLiqRyGbmeT0DoS2Z2kHzi7TZ92z-vARI', providerType: 'Shipment', transactionType: 'Order',
      transactionStatus: 'RELEASED', status: 'Completed', amazonOrderId: '8129762527551', currencyCode: 'USD', minorUnits: 2,
      marketplaceId: 'ATVPDKIKX0DER',
    })
    expect(mapped.postedAt.toISOString()).toBe('2020-07-14T03:35:13.214Z')
    // $10 once — the item's own "Product Charges > Principle" is the same money, not a second $10.
    expect(mapped.money).toEqual({ amount: 1000n, grossRevenue: 1000n, netRevenue: 1000n, amazonFee: 0n, fbaFee: 0n, otherFees: 0n, paymentServicesFee: 0n, total: 1000n })
    expect(r.paths).toEqual(['Sales', 'Sales > Product Charges', 'item: Product Charges', 'item: Product Charges > Principle'])
  })

  it('refuses the sandbox listTransactions transaction: it carries no transactionId', () => {
    const [tx] = model.sandboxListTransactions200.payload.transactions
    expect(tx.transactionId).toBeUndefined()
    expect(refusal(tx)).toBe('missing_transaction_id')
    // Given an id and a status it still cannot be mapped: it has no breakdowns to classify.
    expect(refusal({ ...tx, transactionId: 'sandbox-1', transactionStatus: 'RELEASED' })).toBe('missing_breakdowns')
  })

  it('the model documents exactly three statuses and the deferral identifiers this mapping reads', () => {
    for (const status of ['DEFERRED', 'RELEASED', 'DEFERRED_RELEASED']) expect(model.statusEnumDescription).toContain(`\`${status}\``)
    expect(model.relatedIdentifierNames).toEqual(expect.arrayContaining(['ORDER_ID', 'DEFERRED_TRANSACTION_ID', 'RELEASE_TRANSACTION_ID']))
  })
})

describe('nested breakdowns sum exactly', () => {
  it('maps a three-level tree; children sum to parents and the top level to totalAmount', () => {
    expect(row(shipment()).money).toMatchObject({ amount: 1599n, grossRevenue: 1599n, total: 1599n })
  })

  it('🔴 refuses children that do not sum to their parent', () => {
    const tx = shipment({ breakdowns: [node('Sales', 15.99, [node('Product Charges', 16, [node('Principle', 7.99), node('Principle', 8)])])], totalAmount: money(15.99) })
    expect(refusal(tx)).toBe('child_sum_mismatch')
  })

  it('🔴 refuses top-level breakdowns that do not sum to totalAmount', () => {
    expect(refusal(shipment({ totalAmount: money(16.99) }))).toBe('total_sum_mismatch')
  })

  it('refuses item breakdowns that do not sum to the item total', () => {
    const items = [{ totalAmount: money(15.99), breakdowns: [node('Product Charges', 15.98, [node('Principle', 15.98)])] }]
    expect(refusal(shipment({ items }))).toBe('item_sum_mismatch')
  })

  it('🔴 is exact where floats are not: 0.1 + 0.2 is 0.3', () => {
    expect(0.1 + 0.2).not.toBe(0.3) // the float arithmetic this mapping must not use
    const tx = shipment({ totalAmount: money(0.3), breakdowns: [node('Sales', 0.3, [node('Product Charges', 0.3, [node('Principle', 0.1), node('Principle', 0.2)])])] })
    expect(row(tx).money.amount).toBe(30n)
  })

  it('refuses a malformed tree rather than reading it as empty', () => {
    expect(refusal(shipment({ breakdowns: [{ breakdownType: 'Sales' }] }))).toBe('malformed_breakdowns')
    expect(refusal(shipment({ breakdowns: [{ breakdownType: 'Sales', breakdownAmount: money(15.99), breakdowns: {} }] }))).toBe('malformed_breakdowns')
    expect(refusal(shipment({ breakdowns: [node('  ', 15.99)] }))).toBe('malformed_breakdowns')
  })

  it('refuses a written type with no breakdowns: nothing says what the total is made of', () => {
    expect(refusal(shipment({ breakdowns: [] }))).toBe('missing_breakdowns')
    expect(refusal(shipment({ breakdowns: undefined }))).toBe('missing_breakdowns')
  })
})

describe('🔴 unknown breakdown types are refused, never folded into a column', () => {
  it.each([
    ['Sales > Product Charges > Tax', [node('Sales', 15.99, [node('Product Charges', 15.99, [node('Principle', 12.99), node('Tax', 3)])])]],
    ['Expenses > Amazon Fees > Commission', [node('Sales', 15.99, [node('Product Charges', 15.99)]), node('Expenses', -2, [node('Amazon Fees', -2, [node('Commission', -2)])])]],
    ['Principal (not the evidenced spelling)', [node('Sales', 15.99, [node('Product Charges', 15.99, [node('Principal', 15.99)])])]],
  ])('%s', (_label, breakdowns) => {
    const total = (breakdowns as Array<{ breakdownAmount: { currencyAmount: number } }>).reduce((sum, b) => sum + Math.round(b.breakdownAmount.currencyAmount * 100), 0) / 100
    expect(refusal(shipment({ breakdowns, totalAmount: money(total) }))).toBe('unknown_breakdown')
  })

  it('an unknown item breakdown is refused too', () => {
    const items = [{ totalAmount: money(15.99), breakdowns: [node('Mystery', 15.99)] }]
    expect(refusal(shipment({ items }))).toBe('unknown_breakdown')
  })

  it('a known group used as a leaf with money is refused (it does not say what the money is)', () => {
    expect(refusal(shipment({ breakdowns: [node('Sales', 15.99)] }))).toBe('unknown_breakdown')
  })
})

describe('currency and precision', () => {
  it('uses the per-currency decimal places table (JPY has none)', () => {
    expect(CURRENCY_MINOR_UNITS.JPY).toBe(0)
    const tx = shipment({ totalAmount: money(1500, 'JPY'), breakdowns: [node('Sales', 1500, [node('Product Charges', 1500, [], 'JPY')], 'JPY')] })
    const mapped = row(tx)
    expect([mapped.currencyCode, mapped.minorUnits, mapped.money.amount]).toEqual(['JPY', 0, 1500n])
    expect(toHundredths(mapped.money.amount, mapped.minorUnits)).toBe(150000n)
    expect(refusal(shipment({ totalAmount: money(1500.5, 'JPY'), breakdowns: [node('Sales', 1500.5, [node('Product Charges', 1500.5, [], 'JPY')], 'JPY')] }))).toBe('sub_minor_unit')
  })

  it('refuses a currency outside the table instead of assuming two decimals', () => {
    for (const code of ['KWD', 'XXX', 'eur', 'EURO', undefined]) {
      expect(refusal(shipment({ totalAmount: { currencyAmount: 15.99, currencyCode: code } })), String(code)).toBe('unknown_currency')
    }
  })

  it('refuses more than one currency in one transaction', () => {
    expect(refusal(shipment({ breakdowns: [node('Sales', 15.99, [node('Product Charges', 15.99)], 'GBP')] }))).toBe('mixed_currency')
    const items = [{ totalAmount: money(15.99, 'USD') }]
    expect(refusal(shipment({ items }))).toBe('mixed_currency')
  })

  it('🔴 refuses sub-cent precision', () => {
    expect(refusal(shipment({ totalAmount: money(10.005), breakdowns: [node('Sales', 10.005, [node('Product Charges', 10.005)])] }))).toBe('sub_minor_unit')
    expect(() => toMinorUnits('1.001', 2)).toThrow('sub_minor_unit')
    expect(toMinorUnits('1.000', 2)).toBe(100n)
  })

  it('refuses a JSON number whose digits JSON.parse may already have rounded', () => {
    expect(() => exactDecimal(1234567890123.456)).toThrow('precision_unverifiable')
    expect(exactDecimal(123456789012.34)).toEqual({ digits: 12345678901234n, scale: 2 })
    expect(exactDecimal('1234567890123.456')).toEqual({ digits: 1234567890123456n, scale: 3 })
  })

  it('reads exponent notation exactly and refuses non-numbers', () => {
    expect(exactDecimal(1e21)).toEqual({ digits: 10n ** 21n, scale: 0 })
    expect(exactDecimal(-0)).toEqual({ digits: 0n, scale: 0 })
    for (const bad of [NaN, Infinity, '1e3', '+1', '1.', '', null, undefined, {}, true]) expect(() => exactDecimal(bad), String(bad)).toThrow('invalid_amount')
  })

  it('refuses an amount the numeric(12,2) column cannot hold', () => {
    const big = '12345678901.00'
    expect(refusal(shipment({ totalAmount: money(big), breakdowns: [node('Sales', big, [node('Product Charges', big)])] }))).toBe('amount_out_of_range')
  })

  it('renders minor units as the exact decimal a column stores', () => {
    expect([minorToDecimal(-1234n, 2), minorToDecimal(5n, 2), minorToDecimal(-5n, 2), minorToDecimal(1000n, 0), minorToDecimal(0n, 2)]).toEqual(['-12.34', '0.05', '-0.05', '1000', '0.00'])
  })
})

describe('identity, dates and status', () => {
  it('🔴 refuses a missing postedDate instead of stamping "now"', () => {
    expect(refusal(shipment({ postedDate: undefined }))).toBe('missing_posted_date')
    expect(refusal(shipment({ postedDate: '' }))).toBe('missing_posted_date')
  })

  it('refuses a postedDate without an explicit zone or with unrepresentable precision', () => {
    for (const bad of ['2026-09-20T10:00:00', '2026-09-20', '20/09/2026', '2026-09-20T10:00:00.1234Z', 1758362400000]) {
      expect(refusal(shipment({ postedDate: bad })), String(bad)).toBe('invalid_posted_date')
    }
    expect(row(shipment({ postedDate: '2026-09-20T12:00:00+02:00' })).postedAt.toISOString()).toBe('2026-09-20T10:00:00.000Z')
  })

  it.each([['DEFERRED', 'Pending'], ['RELEASED', 'Completed'], ['DEFERRED_RELEASED', 'Completed']])('%s maps to status %s', (status, stored) => {
    expect(row(shipment({ transactionStatus: status })).status).toBe(stored)
  })

  it('refuses an undocumented or missing status', () => {
    for (const status of ['Released', 'released', 'PENDING', undefined, 3]) expect(refusal(shipment({ transactionStatus: status })), String(status)).toBe('unknown_status')
  })

  it('keys by transactionId regardless of status: the deferred and released forms are one identity with one amount', () => {
    const deferred = row(shipment({ transactionStatus: 'DEFERRED' }))
    const released = row(shipment({ transactionStatus: 'DEFERRED_RELEASED' }))
    expect(released.providerTransactionId).toBe(deferred.providerTransactionId)
    expect(released.money).toEqual(deferred.money)
    expect(statusTransition('DEFERRED', 'DEFERRED_RELEASED')).toBe('advance')
    expect(statusTransition('DEFERRED', 'RELEASED')).toBe('advance')
    expect(statusTransition('DEFERRED_RELEASED', 'DEFERRED')).toBe('regression')
    expect(statusTransition('RELEASED', 'DEFERRED_RELEASED')).toBe('regression')
    expect(statusTransition('RELEASED', 'RELEASED')).toBe('same')
  })

  it('🔴 a release record (DEFERRED_TRANSACTION_ID) is counted, never written: its money is the deferred original', () => {
    const ids = [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'o-1' }, { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'tx-deferred' }]
    expect(mapFinances2024(shipment({ transactionId: 'tx-release', relatedIdentifiers: ids }))).toMatchObject({ kind: 'counted', reason: 'deferral_release_record' })
  })

  it('the deferred original (RELEASE_TRANSACTION_ID) is written and keeps the link', () => {
    const ids = [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'o-1' }, { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'tx-release' }]
    expect(row(shipment({ transactionStatus: 'DEFERRED_RELEASED', relatedIdentifiers: ids })).releaseTransactionId).toBe('tx-release')
  })

  it('refuses contradictory deferral links', () => {
    const both = [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'o-1' }, { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'a' }, { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'b' }]
    expect(refusal(shipment({ relatedIdentifiers: both }))).toBe('ambiguous_deferral_links')
    const two = [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'o-1' }, { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'a' }, { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'b' }]
    expect(refusal(shipment({ relatedIdentifiers: two }))).toBe('ambiguous_deferral_links')
  })

  it('requires exactly one ORDER_ID for a written type (a repeated identical one is one)', () => {
    expect(refusal(shipment({ relatedIdentifiers: [] }))).toBe('missing_order_id')
    expect(refusal(shipment({ relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'a' }, { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'b' }] }))).toBe('ambiguous_order_id')
    expect(row(shipment({ relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'a' }, { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'a' }] })).amazonOrderId).toBe('a')
    expect(refusal(shipment({ relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: ' a' }] }))).toBe('malformed_related_identifiers')
    expect(refusal(shipment({ relatedIdentifiers: 'ORDER_ID' }))).toBe('malformed_related_identifiers')
  })

  it('refuses unidentifiable input', () => {
    for (const bad of [null, 42, 'tx', [], {}, { transactionId: '' }]) expect(refusal(bad)).toBe('missing_transaction_id')
    expect(refusal(shipment({ transactionType: undefined }))).toBe('missing_transaction_type')
  })
})

describe('only Shipment and Refund are written; everything else is counted', () => {
  it('counts another type without mapping its vocabulary', () => {
    const fee = shipment({ transactionType: 'ServiceFee', relatedIdentifiers: [], totalAmount: money(-39), breakdowns: [node('Expenses', -39, [node('Subscription', -39)])] })
    expect(mapFinances2024(fee)).toMatchObject({ kind: 'counted', reason: 'unmapped_type', transactionType: 'ServiceFee', paths: ['Expenses', 'Expenses > Subscription'] })
  })

  it('still refuses a counted type whose money is inconsistent (a census invariant failure)', () => {
    const fee = shipment({ transactionType: 'ServiceFee', totalAmount: money(-39), breakdowns: [node('Expenses', -39, [node('Subscription', -38)])] })
    expect(refusal(fee)).toBe('child_sum_mismatch')
  })

  it('maps a Refund to a Refund row with its negative principal', () => {
    const refund = shipment({ transactionType: 'Refund', totalAmount: money(-15.99), breakdowns: [node('Sales', -15.99, [node('Product Charges', -15.99)])] })
    expect(row(refund)).toMatchObject({ transactionType: 'Refund', providerType: 'Refund' })
    expect(row(refund).money).toMatchObject({ amount: -1599n, grossRevenue: -1599n, netRevenue: -1599n })
  })

  it('refuses a sign it does not understand instead of flipping it', () => {
    const refund = shipment({ transactionType: 'Refund' })
    expect(refusal(refund)).toBe('unexpected_sign')
    const negativeSale = shipment({ totalAmount: money(-15.99), breakdowns: [node('Sales', -15.99, [node('Product Charges', -15.99)])] })
    expect(refusal(negativeSale)).toBe('unexpected_sign')
  })
})
