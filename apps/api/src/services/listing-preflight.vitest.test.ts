/**
 * A5 — pre-flight validators. Pure functions, so the GTIN check-digit math + the
 * schema-required + GTIN + image checks are fully unit-testable.
 */
import { describe, it, expect } from 'vitest'
import { validateGtin, findMissingRequired, preflightRow } from './listing-preflight.service.js'

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
