import { describe, expect, it } from 'vitest'
import type { PartCoverage } from '../../compliance/certificates-depth/bought-in'
import { lineText } from '../document'
import { SEND_CHECK_CODES } from '../orders'
import { certificateWords, defaultCertificateOf, endsBefore, isPpeLine, lineCertificateCheck, receiptHoldWords } from './certificates'
import { lineKindChecks, lineKindWords, type KindCheckLine } from './checks'
import { LINE_KIND_SEND_CHECK_CODES } from './codes'
import { buysByRolls, materialWidthOf, normalRolls, rollsMatch, rollsOf, rollsProblems, rollsQuantity, rollsWords, widthNote } from './rolls'
import { keepsVariantsApart, lineVariantProblem, normalVariant, variantCodeOf, variantProblems, variantsForSize } from './variants'

const fabric = { code: 'TX-01', kind: 'TEXTILE' }

describe('rolls (SCM-076)', () => {
  it('only fabrics and trims are bought by rolls, whole rolls with lengths and widths above 0', () => {
    expect(buysByRolls('TRIM') && buysByRolls('LINING') && !buysByRolls('LEATHER') && !buysByRolls('PROTECTOR')).toBe(true)
    expect(rollsProblems({ count: 2, lengthM: '50', widthCm: '150' }, fabric)).toEqual([])
    expect(rollsProblems({ count: 2 }, { code: 'L-1', kind: 'LEATHER' })[0]!.message).toMatch(/only fabrics .* and trims/)
    expect(rollsProblems({ count: 0, lengthM: '-1', widthCm: '1.555' }, fabric).map((issue) => issue.path)).toEqual(['body/rolls/count', 'body/rolls/lengthM', 'body/rolls/widthCm'])
    expect(rollsProblems({ count: 10000 }, fabric)[0]!.path).toBe('body/rolls/count')
    expect(rollsProblems({ count: 1, lengthM: '10000.01' }, fabric)[0]!.path).toBe('body/rolls/lengthM')
    expect(normalRolls({ count: 3, lengthM: ' 50.50 ', widthCm: '' })).toEqual({ count: 3, lengthM: '50.5', widthCm: null })
    expect(rollsOf({ rolls: 2, rollLengthM: '50.00', rollWidthCm: '150.00' })).toEqual({ count: 2, lengthM: '50', widthCm: '150' })
    expect(rollsOf({ rolls: null, rollLengthM: null, rollWidthCm: null })).toBeNull()
  })

  it('the rolls make the quantity in the line unit when it can say it (hand-computed)', () => {
    const rolls = { count: 2, lengthM: '50', widthCm: '150' }
    expect(rollsQuantity(rolls, 'ROLL')).toBe('2.0000')
    expect(rollsQuantity(rolls, 'M')).toBe('100.0000') // 2 × 50 m
    expect(rollsQuantity(rolls, 'CM')).toBe('10000.0000') // 2 × 5000 cm
    expect(rollsQuantity(rolls, 'M2')).toBe('150.0000') // 2 × 50 m × 1.5 m
    expect(rollsQuantity(rolls, 'FT2')).toBe('1614.5866') // 150 m² ÷ 0.09290304 = 1614.58656…
    expect(rollsQuantity(rolls, 'KG')).toBeNull()
    expect(rollsQuantity({ count: 2, lengthM: '50', widthCm: null }, 'M2')).toBeNull()
    expect(rollsQuantity({ count: 2, lengthM: null, widthCm: null }, 'M')).toBeNull()
    expect(rollsMatch(rolls, { quantity: '100.0000', uom: 'M' })).toBe(true)
    expect(rollsMatch(rolls, { quantity: '90', uom: 'M' })).toBe(false)
    expect(rollsMatch(rolls, { quantity: '12', uom: 'KG' })).toBe(true)
  })

  it('words, and the width against the material', () => {
    expect(rollsWords({ count: 2, lengthM: '50.5', widthCm: '150' })).toBe('2 rolls × 50.5 m × 150 cm')
    expect(rollsWords({ count: 1, lengthM: '50.5', widthCm: null }, 'it')).toBe('1 rotolo × 50,5 m')
    expect(materialWidthOf({ weightGsm: '320', widthCm: '145' })).toBe('145')
    expect(materialWidthOf(null)).toBeNull()
    expect(widthNote({ count: 1, lengthM: '50', widthCm: '150' }, '145')).toMatch(/150 cm wide; the material is 145 cm/)
    expect(widthNote({ count: 1, lengthM: '50', widthCm: '145.0' }, '145')).toBeNull()
  })
})

const DAY = '2026-11-12'
const cert = (id: string, status: PartCoverage['certificate']['status'], validTo: string) => ({ id, number: `N-${id}`, standard: 'EN 1621-1:2012', ppeClass: '2', status, validFrom: '2025-01-01', validTo })
const coverage = (coverageId: string, certificate: PartCoverage['certificate'], supplierPartyId: string | null = null, status: PartCoverage['status'] = 'ACTIVE'): PartCoverage => ({ coverageId, supplierPartyId, supplierArticleCode: null, status, certificate })

describe('a protector line names its certificate (SCM-077)', () => {
  const c1 = cert('c1', 'VALID', '2030-05-31')
  const c2 = cert('c2', 'VALID', '2027-01-01')
  const expired = cert('c3', 'EXPIRED', '2026-10-02')
  it('a PPE line is a protector or a PPE component', () => {
    expect(isPpeLine({ kind: 'PROTECTOR', isPpeComponent: false }) && isPpeLine({ kind: 'TRIM', isPpeComponent: true }) && !isPpeLine({ kind: 'TRIM', isPpeComponent: false })).toBe(true)
  })
  it('the default is the incoming check’s pick: the supplier’s own coverage first, then any supplier’s', () => {
    expect(defaultCertificateOf([coverage('a', c1), coverage('b', c2, 'P2')], 'P2', DAY)).toBe('c2')
    expect(defaultCertificateOf([coverage('a', c1), coverage('b', c2, 'P2')], 'P1', DAY)).toBe('c1')
    expect(defaultCertificateOf([coverage('b', c2, 'P2')], 'P1', DAY)).toBeNull()
    expect(defaultCertificateOf([coverage('c', expired)], 'P1', DAY)).toBeNull()
  })
  it('the named one holds, no longer holds, covers another supplier only, or does not cover the material', () => {
    expect(lineCertificateCheck([coverage('a', c1)], 'c1', 'P1', DAY)).toEqual({ state: 'HOLDS', why: null, coverageId: 'a' })
    const gone = lineCertificateCheck([coverage('c', expired)], 'c3', 'P1', DAY)
    expect(gone).toEqual({ state: 'NOT_VALID', why: 'EXPIRED', coverageId: 'c' })
    expect(certificateWords(gone, expired, 'PRO-1')).toBe('Certificate N-c3 (EN 1621-1:2012) expired (valid to 2026-10-02).')
    expect(lineCertificateCheck([coverage('b', c2, 'P2')], 'c2', 'P1', DAY).state).toBe('OTHER_SUPPLIER')
    expect(lineCertificateCheck([coverage('a', c1, null, 'ARCHIVED')], 'c1', 'P1', DAY).state).toBe('NOT_COVERING')
    expect(lineCertificateCheck([coverage('a', c1)], 'c2', 'P1', DAY).state).toBe('NOT_COVERING')
    expect(receiptHoldWords(gone, expired, 'PRO-1')).toMatch(/expired .* check them against a certificate that holds/)
    expect(receiptHoldWords({ state: 'HOLDS', why: null, coverageId: 'a' }, c1, 'PRO-1')).toBeNull()
    expect(endsBefore(c2, '2027-01-02') && !endsBefore(c2, '2027-01-01')).toBe(true)
  })
})

describe('variants of one material (SCM-186)', () => {
  it('a code by default, a colour or a size, no spaces in the code', () => {
    expect(variantCodeOf('ZIP 60', 'blk', '60 cm')).toBe('ZIP60-BLK-60CM')
    const variant = normalVariant({ size: '  60   cm ', itemColourId: 'col' }, { code: 'ZIP' }, 'BLK')
    expect(variant).toEqual({ itemColourId: 'col', size: '60 cm', code: 'ZIP-BLK-60CM', supplierCode: null })
    expect(variantProblems(variant)).toEqual([])
    expect(variantProblems(normalVariant({}, { code: 'ZIP' }, null)).map((issue) => issue.path)).toEqual(['body/size'])
    expect(variantProblems(normalVariant({ size: 'M', code: 'A B' }, { code: 'ZIP' }, null)).map((issue) => issue.path)).toEqual(['body/code'])
    expect(variantProblems(normalVariant({ size: 'x'.repeat(41), supplierCode: 'y'.repeat(61) }, { code: 'Z' }, null)).map((issue) => issue.path)).toEqual(['body/size', 'body/supplierCode'])
    expect(keepsVariantsApart('LOT') && !keepsVariantsApart('NONE')).toBe(true)
  })
  it('a line names an ACTIVE variant of its colour (a variant without a colour fits every colour)', () => {
    const m = { code: 'PRO-M', itemColourId: null, size: 'M', status: 'ACTIVE' }
    expect(lineVariantProblem(m, 'PRO-M', 'PRO', 'any')).toBeNull()
    expect(lineVariantProblem(null, 'PRO-Q', 'PRO', null)).toBe('PRO has no variant PRO-Q.')
    expect(lineVariantProblem({ ...m, status: 'ARCHIVED' }, 'PRO-M', 'PRO', null)).toMatch(/archived/)
    expect(lineVariantProblem({ ...m, itemColourId: 'blk' }, 'PRO-M', 'PRO', 'gry')).toMatch(/another colour/)
  })
  it('a BOM size line uses the variant of its size and colour', () => {
    const variants = [
      { code: 'Z-BLK-M', itemColourId: 'blk', size: 'M', status: 'ACTIVE' },
      { code: 'Z-GRY-M', itemColourId: 'gry', size: 'm', status: 'ACTIVE' },
      { code: 'Z-L', itemColourId: null, size: 'L', status: 'ACTIVE' },
      { code: 'Z-XL', itemColourId: null, size: 'XL', status: 'ARCHIVED' },
    ]
    expect(variantsForSize(variants, 'M', ['blk'])).toMatchObject({ match: 'ONE', variants: [{ code: 'Z-BLK-M' }] })
    expect(variantsForSize(variants, 'M', null).match).toBe('SEVERAL')
    expect(variantsForSize(variants, 'L', ['blk'])).toMatchObject({ match: 'ONE', variants: [{ code: 'Z-L' }] })
    expect(variantsForSize(variants, 'XL', null).match).toBe('NONE')
  })
})

describe('the send and the PDF', () => {
  const base: KindCheckLine = { seq: 10, itemCode: 'TX-01', quantity: '100', uom: 'M', needDate: '2026-12-01', rolls: null, ppe: false, certificateId: null, certificate: null, coverable: false, variant: null }
  it('the codes are the send check codes', () => {
    for (const code of LINE_KIND_SEND_CHECK_CODES) expect(SEND_CHECK_CODES).toContain(code)
  })
  it('rolls that no longer make the quantity, a missing or failing certificate, an unusable variant', () => {
    expect(lineKindChecks([{ ...base, rolls: { count: 2, lengthM: '50', widthCm: null } }], false)).toEqual([])
    expect(lineKindChecks([{ ...base, quantity: '90', rolls: { count: 2, lengthM: '50', widthCm: null } }], false)).toEqual([
      { code: 'ROLLS_NOT_THE_QUANTITY', severity: 'BLOCKS', path: 'lines/10/rolls', message: 'Line 10 (TX-01) is 2 rolls × 50 m = 100 M, but asks for 90 M: change its rolls or clear them.' },
    ])
    const ppe = { ...base, itemCode: 'PRO-1', uom: 'PCS' as const, ppe: true }
    expect(lineKindChecks([{ ...ppe, coverable: true }], false).map((check) => [check.code, check.severity])).toEqual([['PPE_NO_CERTIFICATE', 'BLOCKS']])
    expect(lineKindChecks([{ ...ppe, coverable: true }], true).map((check) => check.severity)).toEqual(['WARNING'])
    expect(lineKindChecks([ppe], false).map((check) => check.severity)).toEqual(['WARNING'])
    const facts = { id: 'c', number: 'N-1', standard: 'EN 1621-1', status: 'VALID' as const, validFrom: '2025-01-01', validTo: '2026-11-30' }
    expect(lineKindChecks([{ ...ppe, certificateId: 'c', certificate: { check: { state: 'HOLDS', why: null, coverageId: 'a' }, facts } }], false).map((check) => [check.code, check.severity])).toEqual([['PPE_CERTIFICATE_ENDS_EARLY', 'WARNING']])
    expect(lineKindChecks([{ ...ppe, certificateId: 'c', certificate: { check: { state: 'OTHER_SUPPLIER', why: null, coverageId: null }, facts } }], false)[0]).toMatchObject({ code: 'PPE_CERTIFICATE_NOT_VALID', severity: 'BLOCKS' })
    expect(lineKindChecks([{ ...base, variant: { code: 'V', problem: 'Variant V of TX-01 is archived: choose an active one.' } }], false)[0]).toMatchObject({ code: 'VARIANT_NOT_USABLE', message: 'Line 10: Variant V of TX-01 is archived: choose an active one.' })
  })
  it('the supplier reads the variant, the rolls and the certificate', () => {
    const facts = { rolls: { count: 2, lengthM: '50', widthCm: '150' }, variant: { code: 'PRO-M', size: 'M', supplierCode: 'ART-M' }, certificate: { number: 'N-1', standard: 'EN 1621-1:2012' } }
    expect(lineKindWords(facts, 'en')).toEqual(['variant PRO-M size M (supplier code ART-M)', '2 rolls × 50 m × 150 cm', 'certified protector EN 1621-1:2012, certificate no. N-1'])
    expect(lineKindWords({ rolls: null, variant: null, certificate: null }, 'it')).toEqual([])
    expect(lineKindWords({ ...facts, rolls: null, certificate: null }, 'it')).toEqual(['variante PRO-M taglia M (cod. fornitore ART-M)'])
    const line = { seq: 10, code: 'ART-M', name: 'Shoulder protector', colour: null, description: null, quantity: '24', uom: 'PCS', unitPrice: '6.5', netAmount: 15_600, needDate: '2026-12-01', leather: null, requiresCrViTest: false, note: 'Boxes of 12' }
    expect(lineText({ ...line, kind: lineKindWords({ ...facts, rolls: null }, 'en') }, 'en')).toBe('Shoulder protector · variant PRO-M size M (supplier code ART-M) · certified protector EN 1621-1:2012, certificate no. N-1 · Boxes of 12')
    expect(lineText(line, 'en')).toBe('Shoulder protector · Boxes of 12')
  })
})
