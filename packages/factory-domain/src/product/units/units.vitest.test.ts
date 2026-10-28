import { describe, expect, it } from 'vitest'
import {
  baseFactor,
  carriedCost,
  carriedFactor,
  convert,
  convertibleUnits,
  decimalText,
  dimensionOf,
  fixedRatio,
  fromBase,
  resolveItemUnits,
  roundTo,
  toBase,
  unconvertibleUnits,
  unitCostIn,
  UNITS,
  UOMS,
  type ItemUnits,
} from './units'

const text = (value: Parameters<typeof decimalText>[0]) => decimalText(value)
const Q = { scale: 4, rounding: 'HALF_UP' } as const

/** A made-up leather article: stocked in ft², bought by the hide (52.5 ft² on average), cut in dm². */
const leather: ItemUnits = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', consumptionFactor: '0.10763910' }
/** A made-up lining: stocked in m², bought by the running metre of a 1.5 m wide roll. */
const lining: ItemUnits = { baseUom: 'M2', purchaseUom: 'M', purchaseFactor: '1.5', consumptionUom: 'M2', consumptionFactor: '1' }

describe('the units (PRD-030)', () => {
  it('lists every unit once, each with a dimension, a symbol and an Italian and English name', () => {
    expect(new Set(UOMS).size).toBe(UOMS.length)
    for (const uom of UOMS) {
      expect(UNITS[uom].uom).toBe(uom)
      expect(UNITS[uom].name.it.length).toBeGreaterThan(0)
      expect(UNITS[uom].name.en.length).toBeGreaterThan(0)
    }
    expect(dimensionOf('FT2')).toBe('AREA')
    expect(dimensionOf('HIDE')).toBe('ITEM')
  })

  it('has the fixed factors inside a dimension: 1 ft² = 0.09290304 m², 1 dm² = 0.01 m², 1 pair = 2 pieces', () => {
    expect(text(fixedRatio('FT2', 'M2')!)).toBe('0.09290304')
    expect(text(fixedRatio('DM2', 'M2')!)).toBe('0.01')
    expect(text(fixedRatio('FT2', 'DM2')!)).toBe('9.290304')
    expect(text(fixedRatio('M2', 'DM2')!)).toBe('100')
    expect(text(fixedRatio('PAIR', 'PCS')!)).toBe('2')
    expect(text(fixedRatio('G', 'KG')!)).toBe('0.001')
    expect(text(fixedRatio('MM', 'M')!)).toBe('0.001')
    expect(text(fixedRatio('HIDE', 'HIDE')!)).toBe('1')
  })

  it('has no fixed factor across dimensions or for a unit whose size its item says', () => {
    expect(fixedRatio('M2', 'M')).toBeNull()
    expect(fixedRatio('HIDE', 'FT2')).toBeNull()
    expect(fixedRatio('SET', 'PCS')).toBeNull()
    expect(fixedRatio('ROLL', 'M')).toBeNull()
  })

  it('converts exactly inside a dimension and rounds once, as the caller says', () => {
    // 1 m² = 10.76391041670972… ft²: the exact ratio, not a stored factor.
    expect(text(fixedRatio('M2', 'FT2')!).startsWith('10.7639104167097')).toBe(true)
    const square = { baseUom: 'FT2', purchaseUom: 'M2', purchaseFactor: '10.76391042', consumptionUom: 'FT2', consumptionFactor: '1' } as const
    expect(text(toBase('1', 'M2', square, Q))).toBe('10.7639')
    expect(text(toBase('1', 'M2', square, { scale: 4, rounding: 'UP' }))).toBe('10.764')
    expect(text(toBase('1', 'M2', square, { scale: 4, rounding: 'DOWN' }))).toBe('10.7639')
    expect(text(toBase('100', 'M2', square, Q))).toBe('1076.391')
    expect(text(toBase('100', 'FT2', { ...square, baseUom: 'M2', purchaseUom: 'FT2', purchaseFactor: '0.09290304' }, Q))).toBe('9.2903')
  })

  it('converts a leather article between hides, square feet and square decimetres', () => {
    expect(text(toBase('3', 'HIDE', leather, Q))).toBe('157.5')
    expect(text(toBase('250', 'DM2', leather, Q))).toBe('26.9098')
    // A need of 100 ft² bought in whole-ish hides: never less than the need.
    expect(text(fromBase('100', 'HIDE', leather, { scale: 4, rounding: 'UP' }))).toBe('1.9048')
    expect(text(fromBase('100', 'HIDE', leather, { scale: 0, rounding: 'UP' }))).toBe('2')
    expect(text(fromBase('100', 'HIDE', leather, { scale: 0, rounding: 'DOWN' }))).toBe('1')
    // Two hides as dm² for the cutting table, through the base unit exactly: 105 ft² = 975.48192 dm².
    expect(text(convert('2', 'HIDE', 'DM2', leather, Q))).toBe('975.4819')
    expect(text(convert('975.48192', 'DM2', 'HIDE', leather, Q))).toBe('2')
    expect(text(convert('1', 'M2', 'FT2', leather, Q))).toBe('10.7639')
  })

  it('converts a lining bought by the running metre of its roll', () => {
    expect(text(toBase('40', 'M', lining, Q))).toBe('60')
    expect(text(fromBase('61', 'M', lining, { scale: 2, rounding: 'UP' }))).toBe('40.67')
    expect(text(convert('150', 'DM2', 'M', lining, Q))).toBe('1')
  })

  it('rounds half away from zero, up away from zero and down towards zero', () => {
    expect(text(roundTo('0.00005', { scale: 4, rounding: 'HALF_UP' }))).toBe('0.0001')
    expect(text(roundTo('0.00004', { scale: 4, rounding: 'HALF_UP' }))).toBe('0')
    expect(text(roundTo('0.00001', { scale: 4, rounding: 'UP' }))).toBe('0.0001')
    expect(text(roundTo('0.00009', { scale: 4, rounding: 'DOWN' }))).toBe('0')
    expect(text(roundTo('-1.00005', { scale: 4, rounding: 'HALF_UP' }))).toBe('-1.0001')
    expect(() => roundTo('1', { scale: 4, rounding: 'NEAREST' as 'UP' })).toThrow(RangeError)
  })

  it('refuses a unit the item cannot convert, and a value that is not a plain decimal', () => {
    expect(() => toBase('1', 'KG', leather, Q)).toThrow(/does not convert KG/)
    expect(() => toBase('1,5', 'HIDE', leather, Q)).toThrow(/not valid/)
    expect(() => toBase('1e3', 'HIDE', leather, Q)).toThrow(/not valid/)
    expect(convertibleUnits(leather)).toEqual(['M2', 'DM2', 'FT2', 'HIDE'])
    expect(unconvertibleUnits(['DM2', 'SIDE', 'HIDE', 'SIDE'], leather)).toEqual(['SIDE'])
    expect(baseFactor('SIDE', leather)).toBeNull()
  })

  it('prices one purchase or consumption unit from the standard cost per base unit', () => {
    expect(text(unitCostIn('2.4', 'HIDE', leather, { scale: 6, rounding: 'HALF_UP' }))).toBe('126')
    expect(text(unitCostIn('2.4', 'DM2', leather, { scale: 6, rounding: 'HALF_UP' }))).toBe('0.258334')
    expect(text(unitCostIn('8', 'M', lining, { scale: 6, rounding: 'HALF_UP' }))).toBe('12')
  })
})

describe("an item's units", () => {
  it('derives the factor of a unit of the base dimension and defaults the purchase and consumption units', () => {
    expect(resolveItemUnits({ baseUom: 'M2', purchaseUom: 'FT2', consumptionUom: 'DM2' })).toEqual({
      ok: true,
      units: { baseUom: 'M2', purchaseUom: 'FT2', purchaseFactor: '0.09290304', consumptionUom: 'DM2', consumptionFactor: '0.01' },
    })
    expect(resolveItemUnits({ baseUom: 'FT2', consumptionUom: 'DM2' })).toEqual({
      ok: true,
      units: { baseUom: 'FT2', purchaseUom: 'FT2', purchaseFactor: '1', consumptionUom: 'DM2', consumptionFactor: '0.1076391' },
    })
    expect(resolveItemUnits({ baseUom: 'PCS', purchaseUom: 'PAIR' })).toMatchObject({ ok: true, units: { purchaseFactor: '2', consumptionFactor: '1' } })
    expect(resolveItemUnits({ baseUom: 'PCS', purchaseFactor: '1' })).toMatchObject({ ok: true })
  })

  it('takes the typed factor of a unit its item sizes, and of a unit of another dimension', () => {
    expect(resolveItemUnits({ baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.50' })).toMatchObject({ ok: true, units: { purchaseFactor: '52.5' } })
    expect(resolveItemUnits({ baseUom: 'M2', purchaseUom: 'M', purchaseFactor: '1.5' })).toMatchObject({ ok: true, units: { purchaseFactor: '1.5' } })
    expect(resolveItemUnits({ baseUom: 'CONE', consumptionUom: 'M', consumptionFactor: '0.0002' })).toMatchObject({ ok: true, units: { consumptionFactor: '0.0002' } })
  })

  it('refuses a missing, wrong or out-of-range factor, saying what it should be', () => {
    expect(resolveItemUnits({ baseUom: 'FT2', purchaseUom: 'HIDE' })).toEqual({
      ok: false,
      issues: [{ path: 'purchaseFactor', message: 'Say how many ft² one pelle holds (its average area).' }],
    })
    expect(resolveItemUnits({ baseUom: 'M2', purchaseUom: 'FT2', purchaseFactor: '0.0929' })).toEqual({
      ok: false,
      issues: [{ path: 'purchaseFactor', message: 'One ft² is 0.09290304 m²: the factor is fixed; leave it out.' }],
    })
    expect(resolveItemUnits({ baseUom: 'M2', purchaseFactor: '2' })).toEqual({ ok: false, issues: [{ path: 'purchaseFactor', message: 'One m² is one m²: the factor is 1.' }] })
    const bad = (factor: string) => resolveItemUnits({ baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: factor })
    expect(bad('0')).toMatchObject({ ok: false, issues: [{ message: 'The factor is above 0.' }] })
    expect(bad('-3')).toMatchObject({ ok: false, issues: [{ message: 'Expected a number above 0 written like 52.5.' }] })
    expect(bad('1.123456789')).toMatchObject({ ok: false, issues: [{ message: 'At most 8 decimals.' }] })
    expect(bad('12345678901')).toMatchObject({ ok: false, issues: [{ message: 'At most 10 digits before the decimal point.' }] })
  })

  it('gives one factor to a unit that is both the purchase and the consumption unit', () => {
    expect(resolveItemUnits({ baseUom: 'M2', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'ROLL', consumptionFactor: '45' })).toEqual({
      ok: false,
      issues: [{ path: 'consumptionFactor', message: 'The purchase and consumption units are both rotolo: they hold the same number of m².' }],
    })
  })

  it('carries a factor and a cost over when the base unit moves inside its dimension', () => {
    // A hide of 52.5 ft² is 4.8774096 m²; FT2 itself is derived from the new base.
    expect(carriedFactor('HIDE', '52.5', 'FT2', 'M2')).toBe('4.8774096')
    expect(carriedFactor('FT2', '1', 'FT2', 'M2')).toBeUndefined()
    expect(carriedFactor('HIDE', '52.5', 'FT2', 'KG')).toBeUndefined()
    // 2.40 € per ft² is 25.833385 € per m² (10.7639… ft² in one m²).
    expect(carriedCost('2.4', 'FT2', 'M2')).toBe('25.833385')
    expect(carriedCost('25.833385', 'M2', 'FT2')).toBe('2.4')
    expect(carriedCost('2.4', 'FT2', 'KG')).toBeNull()
  })
})
