/**
 * A5 — pre-flight validators. Pure functions, so the GTIN check-digit math + the
 * schema-required + GTIN + image checks are fully unit-testable.
 */
import { describe, it, expect } from 'vitest'
import { validateGtin, findMissingRequired, preflightRow, buildPerTypeValidation, validateImportRows, utf8ByteLength, checkLengthLimits } from './listing-preflight.service.js'

describe('validateGtin (mod-10 check digit)', () => {
  it('valid EAN-13', () => expect(validateGtin('4006381333931').valid).toBe(true))
  it('valid UPC-12', () => expect(validateGtin('036000291452').valid).toBe(true))
  it('tolerates spaces/dashes', () => expect(validateGtin('4006381-333931').valid).toBe(true))
  it('bad check digit → invalid', () => {
    const r = validateGtin('4006381333932')
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('check digit mismatch')
  })
  it('non-numeric → invalid', () => expect(validateGtin('40063813ABCD').valid).toBe(false))
  it('wrong length → invalid', () => expect(validateGtin('12345').valid).toBe(false))
  it('empty → invalid', () => expect(validateGtin('').valid).toBe(false))
})

describe('findMissingRequired (schema-driven)', () => {
  const req = [{ id: 'item_name', label: 'Title' }, { id: 'brand', label: 'Brand' }]
  it('flags only the blank required column', () => {
    expect(findMissingRequired({ item_name: 'X', brand: '  ' }, req).map((x) => x.id)).toEqual(['brand'])
  })
  it('all filled → none missing', () => {
    expect(findMissingRequired({ item_name: 'X', brand: 'Y' }, req)).toEqual([])
  })
})

describe('preflightRow', () => {
  const req = [{ id: 'item_name', label: 'Title' }]
  it('missing required → error', () => {
    expect(preflightRow({ item_name: '', main_product_image_locator: 'u' }, req)
      .some((i) => i.field === 'item_name' && i.severity === 'error')).toBe(true)
  })
  it('invalid GTIN → error', () => {
    expect(preflightRow({ item_name: 'X', ean: '4006381333932', main_product_image_locator: 'u' }, req)
      .some((i) => i.severity === 'error' && /Invalid product identifier/.test(i.message))).toBe(true)
  })
  it('valid row → no errors', () => {
    expect(preflightRow({ item_name: 'X', ean: '4006381333931', main_product_image_locator: 'u' }, req)
      .filter((i) => i.severity === 'error')).toEqual([])
  })
  it('missing image → warning, not error', () => {
    const issues = preflightRow({ item_name: 'X', ean: '4006381333931' }, req)
    expect(issues.some((i) => i.field === 'main_product_image_locator' && i.severity === 'warning')).toBe(true)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('P0 — utf8ByteLength', () => {
  it('ASCII: bytes == chars', () => expect(utf8ByteLength('Jacket')).toBe(6))
  it('accented Latin counts as 2 bytes/char', () => {
    expect('àà'.length).toBe(2)         // 2 characters
    expect(utf8ByteLength('àà')).toBe(4) // but 4 UTF-8 bytes
  })
  it('emoji counts as 4 bytes', () => expect(utf8ByteLength('🏍')).toBe(4))
  it('empty → 0', () => expect(utf8ByteLength('')).toBe(0))
})

describe('P0 — checkLengthLimits (byte limit wins)', () => {
  it('the core bug: value within CHAR limit but over BYTE limit → error', () => {
    // 'àà' = 2 chars (passes maxLength 5) but 4 bytes (fails maxUtf8ByteLength 3)
    const issues = checkLengthLimits({ item_name: 'àà' }, [{ id: 'item_name', label: 'Title', maxLength: 5, maxUtf8ByteLength: 3 }])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ field: 'item_name', severity: 'error' })
    expect(issues[0].message).toMatch(/4 bytes/)
  })
  it('within byte limit → no issue', () => {
    expect(checkLengthLimits({ item_name: 'àà' }, [{ id: 'item_name', label: 'Title', maxUtf8ByteLength: 10 }])).toEqual([])
  })
  it('blank value is skipped (required-ness is checked elsewhere)', () => {
    expect(checkLengthLimits({ item_name: '   ' }, [{ id: 'item_name', label: 'Title', maxUtf8ByteLength: 1 }])).toEqual([])
  })
  it('falls back to char limit when no byte limit is present', () => {
    const issues = checkLengthLimits({ brand: 'abcdef' }, [{ id: 'brand', label: 'Brand', maxLength: 3 }])
    expect(issues[0]).toMatchObject({ field: 'brand', severity: 'error' })
    expect(issues[0].message).toMatch(/characters/)
  })
  it('one length error per field (byte beats char, no double-flag)', () => {
    const issues = checkLengthLimits({ item_name: 'àààà' }, [{ id: 'item_name', label: 'Title', maxLength: 1, maxUtf8ByteLength: 2 }])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/bytes/)
  })
})

describe('preflightRow — byte-length integration', () => {
  const req = [{ id: 'item_name', label: 'Title' }]
  it('over-byte title surfaces as an error alongside required checks', () => {
    const issues = preflightRow(
      { item_name: 'àà', ean: '4006381333931', main_product_image_locator: 'u' },
      req,
      [{ id: 'item_name', label: 'Title', maxUtf8ByteLength: 3 }],
    )
    expect(issues.some((i) => i.field === 'item_name' && i.severity === 'error' && /bytes/.test(i.message))).toBe(true)
  })
  it('no lengthColumns arg → behaves exactly as before (backward compatible)', () => {
    const issues = preflightRow({ item_name: 'àà', ean: '4006381333931', main_product_image_locator: 'u' }, req)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('MT.2 — buildPerTypeValidation (per-row validation for mixed sheets)', () => {
  const union = {
    productTypes: ['JACKET', 'PANTS'],
    groups: [{ columns: [
      { id: 'item_sku', labelEn: 'SKU', applicableProductTypes: ['JACKET', 'PANTS'], requiredForProductTypes: ['JACKET', 'PANTS'] },
      { id: 'material', labelEn: 'Material', applicableProductTypes: ['JACKET', 'PANTS'], requiredForProductTypes: ['JACKET'] },
      { id: 'inseam', labelEn: 'Inseam', applicableProductTypes: ['PANTS'], requiredForProductTypes: ['PANTS'] },
    ] }],
  }
  const { requiredByType, applicableByType } = buildPerTypeValidation(union)

  it('required is per-type (material required for Jacket only; inseam for Pants only)', () => {
    expect(requiredByType.get('JACKET')!.map((c) => c.id)).toEqual(['item_sku', 'material'])
    expect(requiredByType.get('PANTS')!.map((c) => c.id)).toEqual(['item_sku', 'inseam'])
  })
  it('applicable is per-type (a Jacket row excludes the Pants-only inseam)', () => {
    expect(applicableByType.get('JACKET')!.has('inseam')).toBe(false)
    expect(applicableByType.get('PANTS')!.has('inseam')).toBe(true)
    expect(applicableByType.get('JACKET')!.has('item_sku')).toBe(true)
  })
  it('a column with no applicableProductTypes applies to every type (legacy)', () => {
    const u = { productTypes: ['JACKET'], groups: [{ columns: [{ id: 'legacy', labelEn: 'L' }] }] }
    expect(buildPerTypeValidation(u).applicableByType.get('JACKET')!.has('legacy')).toBe(true)
  })
})

describe('P0 — buildPerTypeValidation derives lengthByType from manifest caps', () => {
  const union = {
    productTypes: ['JACKET', 'PANTS'],
    groups: [{ columns: [
      { id: 'item_name', labelEn: 'Title', applicableProductTypes: ['JACKET', 'PANTS'], maxUtf8ByteLength: 200 },
      { id: 'inseam', labelEn: 'Inseam', applicableProductTypes: ['PANTS'], maxLength: 10 },
      { id: 'color', labelEn: 'Color', applicableProductTypes: ['JACKET', 'PANTS'] }, // no cap → excluded
    ] }],
  }
  const { lengthByType } = buildPerTypeValidation(union)
  it('includes only capped columns, per applicable type', () => {
    expect(lengthByType.get('JACKET')!.map((c) => c.id)).toEqual(['item_name'])
    expect(lengthByType.get('PANTS')!.map((c) => c.id).sort()).toEqual(['inseam', 'item_name'])
  })
  it('carries the byte/char cap through', () => {
    expect(lengthByType.get('JACKET')!.find((c) => c.id === 'item_name')!.maxUtf8ByteLength).toBe(200)
    expect(lengthByType.get('PANTS')!.find((c) => c.id === 'inseam')!.maxLength).toBe(10)
  })
})

describe('FX.6 — validateImportRows (per-type pre-flight of import rows)', () => {
  const requiredByType = new Map([
    ['JACKET', [{ id: 'item_name', label: 'Title' }, { id: 'brand', label: 'Brand' }]],
    ['PANTS', [{ id: 'item_name', label: 'Title' }, { id: 'inseam', label: 'Inseam' }]],
  ])
  const fallback = [{ id: 'item_name', label: 'Title' }]
  const img = 'http://x/img.jpg'

  it('checks each row against its OWN product type', () => {
    const rows = [
      { item_sku: 'A1', product_type: 'JACKET', item_name: 'X', brand: '', main_product_image_locator: img }, // missing brand
      { item_sku: 'A2', product_type: 'PANTS', item_name: 'Y', inseam: '32', main_product_image_locator: img }, // ok
    ]
    const r = validateImportRows(rows, requiredByType, fallback)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ rowIndex: 0, sku: 'A1' })
    expect(r[0].issues.some((i) => i.field === 'brand' && i.severity === 'error')).toBe(true)
  })
  it('falls back to the shared required set for an unknown/blank type', () => {
    const rows = [{ item_sku: 'A3', product_type: '', item_name: '', main_product_image_locator: img }]
    const r = validateImportRows(rows, requiredByType, fallback)
    expect(r[0].issues.some((i) => i.field === 'item_name' && i.severity === 'error')).toBe(true)
  })
})
