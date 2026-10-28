import { describe, expect, it } from 'vitest'
import { Dec, roundMoney } from './decimal'
import { stampDutyFor } from './stamp-duty'
import { allocateByWeight, computeVat, lineAmount, splitGross, vatOn, type AmountLine } from './vat-summary'
import { nonTaxable, taxable } from './vat-treatment'

const d = (value: string) => new Dec(value)
const IT22 = taxable(22)
const IT10 = taxable(10)
const N32 = nonTaxable('N3.2', 'Operazione non imponibile art. 41 c.1 lett. a) DL 331/1993 - cessione intracomunitaria')

describe('rounding (FatturaPA rules: half up to cents)', () => {
  it('rounds the third decimal 5 and above up, below 5 down, negatives symmetrically', () => {
    expect(roundMoney(d('1.005')).toFixed(2)).toBe('1.01')
    expect(roundMoney(d('1.0049')).toFixed(2)).toBe('1.00')
    expect(roundMoney(d('-1.005')).toFixed(2)).toBe('-1.01')
  })

  it('Imposta is rate x taxable / 100 rounded half up (SDI 00421)', () => {
    expect(vatOn(d('10.25'), IT22).toFixed(2)).toBe('2.26') // 2.255 -> 2.26
    expect(vatOn(d('10.20'), IT22).toFixed(2)).toBe('2.24') // 2.244 -> 2.24
    expect(vatOn(d('100.00'), N32).toFixed(2)).toBe('0.00')
  })

  it('PrezzoTotale is unit price x (1 - discount) x quantity rounded half up (SDI 00423)', () => {
    expect(lineAmount(d('389.90'), d('3'), d('5')).toFixed(2)).toBe('1111.22') // 1111.215
    expect(lineAmount(d('279.333'), d('2')).toFixed(2)).toBe('558.67') // 558.666
  })

  it('never uses floating point: 0.1 + 0.2 stays 0.30', () => {
    const result = computeVat(
      [
        { treatment: IT22, quantity: d('1'), unitPrice: d('0.1') },
        { treatment: IT22, quantity: d('1'), unitPrice: d('0.2') },
      ],
      'NET',
    )
    expect(result.taxable.toFixed(2)).toBe('0.30')
  })
})

describe('splitting a VAT-inclusive amount', () => {
  it('taxable and VAT always add back to the gross, and VAT is within a cent of the rule, for every amount', () => {
    for (const treatment of [IT22, IT10, taxable(5), taxable(4)]) {
      for (let cents = 1; cents <= 20000; cents += 7) {
        const gross = new Dec(cents).dividedBy(100)
        const { taxable: base, vat } = splitGross(gross, treatment)
        expect(base.plus(vat).equals(gross)).toBe(true)
        expect(vat.minus(vatOn(base, treatment)).abs().lte(d('0.01'))).toBe(true)
      }
    }
  })

  it('a 30% deposit of 6100.00 at 22% is 1500.00 + 330.00', () => {
    const { taxable: base, vat } = splitGross(d('1830.00'), IT22)
    expect([base.toFixed(2), vat.toFixed(2)]).toEqual(['1500.00', '330.00'])
  })
})

describe('VAT summary per treatment', () => {
  it('NET basis: one row per rate and Natura, VAT on each row total, rates high to low then Natura codes', () => {
    const lines: AmountLine[] = [
      { treatment: IT10, quantity: d('3'), unitPrice: d('3.33') },
      { treatment: N32, quantity: d('1'), unitPrice: d('50') },
      { treatment: IT22, quantity: d('1'), unitPrice: d('10.01') },
      { treatment: IT22, quantity: d('1'), unitPrice: d('10.01') },
    ]
    const result = computeVat(lines, 'NET')
    expect(result.summary.map((row) => [row.treatment.kind === 'TAXABLE' ? row.treatment.rate : row.treatment.natura, row.taxable.toFixed(2), row.vat.toFixed(2)])).toEqual([
      [22, '20.02', '4.40'], // 4.4044 on the row total, not 2 x 2.20
      [10, '9.99', '1.00'],
      ['N3.2', '50.00', '0.00'],
    ])
    expect(result.total.toFixed(2)).toBe('85.41')
  })

  it('Codice del Consumo artt. 49, 51 — on the GROSS basis the total is exactly the VAT-inclusive price shown', () => {
    const lines: AmountLine[] = [
      { treatment: IT22, quantity: d('1'), unitPrice: d('1899.00') },
      { treatment: IT22, quantity: d('1'), unitPrice: d('119.99') },
      { treatment: IT22, quantity: d('3'), unitPrice: d('12.90') },
    ]
    const result = computeVat(lines, 'GROSS')
    expect(result.total.toFixed(2)).toBe('2057.69') // 1899.00 + 119.99 + 38.70
    const [row] = result.summary
    // ImponibileImporto = sum of PrezzoTotale + Arrotondamento, exactly (SDI 00422).
    const netSum = result.lines.reduce((total, line) => total.plus(line.net), new Dec(0))
    expect(row!.taxable.equals(netSum.plus(row!.rounding))).toBe(true)
  })

  it('a deposit deducted with fixed amounts reverses the deposit invoice exactly on the GROSS basis', () => {
    const result = computeVat(
      [
        { treatment: IT22, quantity: d('1'), unitPrice: d('2057.69') },
        { treatment: IT22, quantity: d('1'), unitPrice: d('-409.84'), fixed: { net: d('-409.84'), gross: d('-500.00') } },
      ],
      'GROSS',
    )
    expect(result.total.toFixed(2)).toBe('1557.69')
  })
})

describe('allocating an amount over weights', () => {
  it('the parts add up to the amount exactly', () => {
    const parts = allocateByWeight(d('100.00'), [d('1'), d('1'), d('1')])
    expect(parts.map((part) => part.toFixed(2))).toEqual(['33.34', '33.33', '33.33'])
    const deposit = allocateByWeight(d('1830.00'), [d('4880.00'), d('122.00'), d('1098.00')])
    expect(deposit.reduce((total, part) => total.plus(part), new Dec(0)).toFixed(2)).toBe('1830.00')
  })

  it('refuses no weights or a negative amount', () => {
    expect(() => allocateByWeight(d('1'), [])).toThrow()
    expect(() => allocateByWeight(d('-1'), [d('1')])).toThrow()
  })
})

describe('stamp duty (rule STAMP_DUTY, exempt Natura UNVERIFIED)', () => {
  const row = (treatment: ReturnType<typeof taxable>, amount: string) => ({ treatment, taxable: d(amount) })
  it('DPR 642/1972 — 2.00 euro when the amounts without VAT exceed 77.47, exports and intra-EU supplies exempt', () => {
    const n21 = nonTaxable('N2.1', 'Operazione non soggetta art. 7-ter DPR 633/1972')
    expect(stampDutyFor([row(n21, '77.47')]).due).toBe(false)
    expect(stampDutyFor([row(n21, '77.48')])).toMatchObject({ due: true })
    expect(stampDutyFor([row(n21, '77.48')]).amount?.toFixed(2)).toBe('2.00')
    expect(stampDutyFor([row(N32, '5000.00')]).due).toBe(false)
    expect(stampDutyFor([row(nonTaxable('N3.1', 'x'), '5000.00')]).due).toBe(false)
    expect(stampDutyFor([row(IT22, '5000.00')]).due).toBe(false)
  })
})
