import { describe, expect, it } from 'vitest'
import { bestDefault, defaultScopeProblems, markTemplateProblems, netWeightKg, overweight, packagingTypeProblems, templateFor, type LiveDefault, type PackagingTypeValues } from './rules'

const carton: PackagingTypeValues = { name: 'Carton 60x40x40', innerLengthCm: '60', innerWidthCm: '40', innerHeightCm: '40', tareKg: '0.8', maxWeightKg: '25', palletKind: null, costPerUnit: '1.25', costCurrency: 'EUR' }

describe('packaging types (LOG-008)', () => {
  it('keeps a carton with its inner size, tare, most weight and cost', () => {
    expect(packagingTypeProblems('CARTON', carton)).toEqual([])
    expect(packagingTypeProblems('PALLET', { ...carton, name: 'EUR pallet', palletKind: 'EUR', innerLengthCm: null, innerWidthCm: null, innerHeightCm: null })).toEqual([])
  })

  it('refuses each wrong value at its field, in words', () => {
    const paths = (values: Partial<PackagingTypeValues>, kind: 'CARTON' | 'PALLET' = 'CARTON') => packagingTypeProblems(kind, { ...carton, ...values }).map((issue) => issue.path)
    expect(paths({ name: ' ' })).toEqual(['body/name'])
    expect(paths({ name: 'two\nlines' })).toEqual(['body/name'])
    expect(paths({ innerHeightCm: null })).toEqual(['body/innerLengthCm'])
    expect(paths({ innerWidthCm: '0' })).toEqual(['body/innerWidthCm'])
    expect(paths({ tareKg: '-1' })).toEqual(['body/tareKg'])
    expect(paths({ maxWeightKg: '0.5' })).toEqual(['body/maxWeightKg'])
    expect(paths({ palletKind: 'EUR' })).toEqual(['body/palletKind'])
    expect(paths({}, 'PALLET')).toEqual(['body/palletKind'])
    expect(paths({ costCurrency: null })).toEqual(['body/costPerUnit'])
    expect(paths({ costCurrency: 'EURO' })).toEqual(['body/costCurrency'])
    expect(paths({ costPerUnit: '1.1234567' })).toEqual(['body/costPerUnit'])
  })

  it('weighs the goods: the gross less the tare; above the most it may hold is overweight', () => {
    expect(netWeightKg('12.4000', '0.8000')).toBe('11.6000')
    expect(netWeightKg('12.4000', null)).toBeNull()
    expect(netWeightKg('0.5000', '0.8000')).toBeNull()
    expect(overweight('26.0000', '25.0000')).toBe(true)
    expect(overweight('25.0000', '25.0000')).toBe(false)
    expect(overweight(null, '25.0000')).toBe(false)
  })
})

describe('the default packaging per style or size run (LOG-008)', () => {
  it('needs a style or a scale; a run is both sizes, with its scale', () => {
    expect(defaultScopeProblems({ styleId: 's', sizeScaleId: null, fromSize: null, toSize: null })).toEqual([])
    expect(defaultScopeProblems({ styleId: null, sizeScaleId: null, fromSize: null, toSize: null }).map((issue) => issue.path)).toEqual(['body/styleId'])
    expect(defaultScopeProblems({ styleId: 's', sizeScaleId: 'k', fromSize: '48', toSize: null }).map((issue) => issue.path)).toEqual(['body/fromSize'])
    expect(defaultScopeProblems({ styleId: 's', sizeScaleId: null, fromSize: '48', toSize: '52' }).map((issue) => issue.path)).toEqual(['body/sizeScaleId'])
  })

  it('takes the most precise live default of the kind: the style\'s run, the style, the scale\'s run, the scale', () => {
    const entry = (id: string, values: Partial<LiveDefault>): LiveDefault => ({ id, packagingTypeId: `type-${id}`, kind: 'CARTON', styleId: null, sizeScaleId: null, fromSeq: null, toSeq: null, ...values })
    const defaults = [entry('scale', { sizeScaleId: 'eu' }), entry('run', { sizeScaleId: 'eu', fromSeq: 1, toSeq: 2 }), entry('style', { styleId: 'jkt' }), entry('styleRun', { styleId: 'jkt', sizeScaleId: 'eu', fromSeq: 3, toSeq: 4 }), entry('bag', { kind: 'POLYBAG', styleId: 'jkt' })]
    const garment = (styleId: string, sizeSeq: number) => ({ styleId, sizeScaleId: 'eu', sizeSeq })
    expect(bestDefault(defaults, 'CARTON', garment('jkt', 3))?.id).toBe('styleRun')
    expect(bestDefault(defaults, 'CARTON', garment('jkt', 1))?.id).toBe('style')
    expect(bestDefault(defaults, 'CARTON', garment('pants', 2))?.id).toBe('run')
    expect(bestDefault(defaults, 'CARTON', garment('pants', 5))?.id).toBe('scale')
    expect(bestDefault(defaults, 'POLYBAG', garment('jkt', 1))?.id).toBe('bag')
    expect(bestDefault(defaults, 'PALLET', garment('jkt', 1))).toBeNull()
    expect(bestDefault(defaults, 'CARTON', { styleId: 'pants', sizeScaleId: 'us', sizeSeq: 1 })).toBeNull()
  })
})

describe('carton mark templates (LOG-013)', () => {
  it('shows 1 to 16 fields, each once, in a two-letter language', () => {
    expect(markTemplateProblems({ fields: ['SHIP_TO', 'CARTON_NUMBER'], language: 'it' })).toEqual([])
    expect(markTemplateProblems({ fields: [], language: 'it' }).map((issue) => issue.path)).toEqual(['body/fields'])
    expect(markTemplateProblems({ fields: ['SHIP_TO', 'SHIP_TO'], language: 'it' }).map((issue) => issue.path)).toEqual(['body/fields'])
    expect(markTemplateProblems({ fields: ['LOGO'], language: 'it' }).map((issue) => issue.path)).toEqual(['body/fields'])
    expect(markTemplateProblems({ fields: ['SHIP_TO'], language: 'ITA' }).map((issue) => issue.path)).toEqual(['body/language'])
  })

  it("prints a customer's own live template, else the company's live default, else none", () => {
    const templates = [
      { id: 'old', partyId: 'P1', active: false },
      { id: 'default', partyId: null, active: true },
      { id: 'brand', partyId: 'P1', active: true },
    ]
    expect(templateFor(templates, 'P1')?.id).toBe('brand')
    expect(templateFor(templates, 'P2')?.id).toBe('default')
    expect(templateFor([{ id: 'off', partyId: null, active: false }], 'P2')).toBeNull()
  })
})
