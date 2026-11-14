import { describe, expect, it } from 'vitest'
import { invoicedBaseQuantity, orderPaidPerBase, paidPerBase, ppvDifference, ppvKeys, ppvWords } from './rules'
import { ACCOUNTANT_WAITS, settingsWords } from './settings'

/**
 * Purchase price variance (B-W2b-407; FIN-031): quantity × (paid − standard) in minor units with one rounding, the paid
 * price per base unit at the receipt (the order's) and at the invoice (its net amount), the keys and the words. Every
 * figure is made up and worked out by hand.
 */

describe('the difference', () => {
  it('is the quantity × (paid − standard) in cents, one half-up rounding', () => {
    // 105 ft² paid 4.30 against 4.20: 10.50 EUR.
    expect(ppvDifference('105', '4.3', '4.2', 'EUR')).toBe(1050)
    // Paid less: favourable, below 0.
    expect(ppvDifference('53.2', '4.10', '4.20', 'EUR')).toBe(-532)
    // 3 × 0.001675 = 0.005025 → 0.01 (half up once, never per unit).
    expect(ppvDifference('3', '1.001675', '1', 'EUR')).toBe(1)
    expect(ppvDifference('10', '2', '2', 'EUR')).toBe(0)
  })

  it('uses the currency minor unit (yen: none)', () => {
    expect(ppvDifference('2', '150.6', '150', 'JPY')).toBe(1)
  })
})

describe('what was paid per base unit', () => {
  it('at the receipt is the order line price × ordered ÷ ordered base (inventory receipts rule)', () => {
    // 10 hides ordered at 44.10 each, 105 ft² base: 4.20 per ft².
    expect(orderPaidPerBase('44.10', '10', '105')).toBe('4.200000')
    expect(orderPaidPerBase('1', '1', '0')).toBeNull()
  })

  it('at the invoice is the net amount ÷ the base quantity invoiced', () => {
    // 10 hides invoiced, the order line 10 hides = 105 ft²: 105 ft²; net 451.50 → 4.30 per ft².
    expect(invoicedBaseQuantity('10', '10', '105')).toBe('105.0000')
    expect(paidPerBase(45_150, 'EUR', '105.0000')).toBe('4.300000')
    expect(invoicedBaseQuantity('5', '0', '10')).toBeNull()
    expect(paidPerBase(100, 'EUR', '0')).toBeNull()
  })
})

describe('keys and words', () => {
  it('one variance per line, :<n> after a reversal, a reversal its own key', () => {
    expect(ppvKeys.receiptLine('l1')).toBe('ppv:receipt-line:l1')
    expect(ppvKeys.invoiceLine('l2', 2)).toBe('ppv:invoice-line:l2:2')
    expect(ppvKeys.reversal('v1')).toBe('ppv:reversal:v1')
  })

  it('says what was paid against the standard, and what a reversal takes back', () => {
    expect(ppvWords({ quantity: '105.0000', paidUnitCost: '4.300000', standardUnitCost: '4.200000', currency: 'EUR', differenceAmount: 1050, reversal: false })).toBe(
      '105 at 4.3 against 4.2 EUR: paid more than the standard (10.50 EUR).',
    )
    expect(ppvWords({ quantity: '-105.0000', paidUnitCost: '4.300000', standardUnitCost: '4.200000', currency: 'EUR', differenceAmount: -1050, reversal: true })).toBe('Takes back a variance of 10.50 EUR.')
  })

  it('the settings say the figures wait for the accountant while off', () => {
    expect(settingsWords({ ppvAt: 'RECEIPT', postingsOn: false, postingsOnDay: null })).toContain(ACCOUNTANT_WAITS)
    expect(settingsWords({ ppvAt: 'INVOICE', postingsOn: true, postingsOnDay: '2026-11-02' })).toBe(
      "The figures for the accountant are on since 2026-11-02. Purchase price variance: at the supplier's invoice, at the invoiced price, once the invoice is approved.",
    )
  })
})
