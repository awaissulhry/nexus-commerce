import { describe, expect, it } from 'vitest'
import { areaCheckWords, areaClaimNote, areaLineCheck, areaUnitOf, invoicedArea } from './rules'

/** B-W2b-403 (SCM-132): invoiced square feet against the measured square feet received. Made-up figures. */
describe('the leather area check on a supplier invoice', () => {
  const hides = [
    { hideId: 'h1', code: 'H-1', received: '53.2', measured: '52.6' },
    { hideId: 'h2', code: 'H-2', received: '51.8', measured: '51.3' },
  ]

  it('reads the line in its own area unit, else in the order line\'s', () => {
    expect(areaUnitOf('MQ')).toBe('M2')
    expect(areaUnitOf('sq ft')).toBe('FT2')
    expect(areaUnitOf('PZ')).toBeNull()
    expect(areaUnitOf('SQFT')).toBe('FT2')
    expect(invoicedArea('10', 'MQ', 'FT2', 'FT2')!.toFixed(2)).toBe('107.64')
    expect(invoicedArea('105', null, 'FT2', 'FT2')!.toFixed(4)).toBe('105.0000')
    expect(invoicedArea('105', 'PCS', 'PCS', 'FT2')).toBeNull()
    expect(invoicedArea(null, 'FT2', 'FT2', 'FT2')).toBeNull()
  })

  it('within the tolerance: 105 invoiced, 103.9 measured (−1.05 %) with 2 %', () => {
    const check = areaLineCheck({ invoiced: '105', billedElsewhere: '0', hides, tolerancePercent: '2' })
    expect(check).toMatchObject({ outcome: 'WITHIN', opensClaim: false, measuredHides: 2, unmeasuredHides: 0, differencePercent: '-1.05', tolerancePercent: '2.00' })
    expect(check.shortfall.toString()).toBe('0')
    expect(areaCheckWords(check, 'ft²').en).toBe('Invoiced 105.00 ft², measured 103.90 ft² received (all 2 hides measured): within the 2.00 % tolerance.')
  })

  it('short beyond the tolerance opens a claim for what was invoiced and not measured; other invoices of the line count', () => {
    const check = areaLineCheck({ invoiced: '60', billedElsewhere: '50', hides, tolerancePercent: '2' })
    expect(check).toMatchObject({ outcome: 'SHORT', opensClaim: true, differencePercent: '-5.55' })
    expect(check.invoicedTotal.toFixed(2)).toBe('110.00')
    expect(check.shortfall.toFixed(2)).toBe('6.10')
    expect(areaClaimNote({ invoiceNumber: 'INV-1', lineSeq: 1, orderNumber: 'PO-1', orderLineSeq: 10 }, check, 'ft²')).toBe(
      'Invoice INV-1 line 1 (order PO-1 line 10): 110.00 ft² invoiced against 103.90 ft² measured on the hides received, 6.10 ft² (5.55 %) short, beyond the 2.00 % tolerance.',
    )
  })

  it('a hide not measured counts with the area it was received with; over the tolerance claims nothing', () => {
    const check = areaLineCheck({ invoiced: '90', billedElsewhere: '0', hides: [{ hideId: 'h1', code: 'H-1', received: '53.2', measured: null }, hides[1]!] })
    expect(check).toMatchObject({ outcome: 'OVER', opensClaim: false, measuredHides: 1, unmeasuredHides: 1 })
    expect(check.measured.toFixed(2)).toBe('104.50')
    expect(areaCheckWords(check, 'ft²').en).toContain('1 of 2 hides measured, the others counted with the area received')
  })

  it('nothing received yet: NOT_RECEIVED, no claim; a credit note elsewhere never makes the line negative', () => {
    const check = areaLineCheck({ invoiced: '20', billedElsewhere: '-5', hides: [] })
    expect(check).toMatchObject({ outcome: 'NOT_RECEIVED', opensClaim: false })
    expect(check.invoicedTotal.toFixed(2)).toBe('20.00')
    expect(areaCheckWords(check, 'm²').it).toBe("Nessuna pelle ricevuta su questa riga d'ordine: 20.00 m² fatturati.")
  })
})
