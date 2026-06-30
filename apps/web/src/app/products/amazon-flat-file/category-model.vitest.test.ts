// category-model.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { BROWSE_NODE_KEY, PRODUCT_TYPE_KEY, categoryOf, productTypesInUse, assignCategory, mixedTypeFamilies, rowsMissingNode, formatNodeBreadcrumb } from './category-model.js'

const LABELS = { '2420941031': 'Auto e Moto > … > Giacche', '2420943031': 'Auto e Moto > … > Pantaloni' }

describe('category-model', () => {
  it('keys are the column ids', () => {
    expect(BROWSE_NODE_KEY).toBe('recommended_browse_nodes')
    expect(PRODUCT_TYPE_KEY).toBe('product_type')
  })

  it('reads a row category (type + node id + path)', () => {
    const row = { product_type: 'COAT', recommended_browse_nodes: '2420941031' }
    expect(categoryOf(row, LABELS)).toEqual({ productType: 'COAT', nodeId: '2420941031', nodePath: 'Auto e Moto > … > Giacche' })
  })

  it('null node + unknown-label path are handled', () => {
    expect(categoryOf({ product_type: 'COAT' }, LABELS)).toEqual({ productType: 'COAT', nodeId: null, nodePath: null })
    expect(categoryOf({ product_type: 'X', recommended_browse_nodes: '999' }, LABELS)).toEqual({ productType: 'X', nodeId: '999', nodePath: null })
  })

  it('lists distinct product types UPPERCASED first-seen, skipping empty', () => {
    const rows = [{ product_type: 'coat' }, { product_type: 'PANTS' }, { product_type: 'COAT' }, { product_type: '' }, {}]
    expect(productTypesInUse(rows)).toEqual(['COAT', 'PANTS'])
  })

  it('assigns category immutably onto the col.id keys', () => {
    const row = { item_sku: 'X', product_type: 'COAT', recommended_browse_nodes: '2420941031' }
    const out = assignCategory(row, { productType: 'pants', nodeId: '2420943031' })
    expect(out.product_type).toBe('PANTS')
    expect(out.recommended_browse_nodes).toBe('2420943031')
    expect(out.item_sku).toBe('X')
    expect(row.product_type).toBe('COAT') // original untouched
  })

  it('assignCategory with null nodeId clears the browse node to empty string', () => {
    const out = assignCategory({ product_type: 'COAT' }, { productType: 'COAT', nodeId: null })
    expect(out.recommended_browse_nodes).toBe('')
  })
})

describe('formatNodeBreadcrumb', () => {
  it('collapses 4 levels to A › … › C › D', () => {
    expect(formatNodeBreadcrumb('A > B > C > D')).toBe('A › … › C › D')
  })
  it('keeps 3 levels as-is', () => {
    expect(formatNodeBreadcrumb('A > B > C')).toBe('A › B › C')
  })
  it('keeps 2 levels as-is', () => {
    expect(formatNodeBreadcrumb('A > B')).toBe('A › B')
  })
  it('collapses 5 levels to A › … › D › E', () => {
    expect(formatNodeBreadcrumb('A > B > C > D > E')).toBe('A › … › D › E')
  })
  it('returns empty string for empty/null/undefined', () => {
    expect(formatNodeBreadcrumb('')).toBe('')
    expect(formatNodeBreadcrumb(null)).toBe('')
    expect(formatNodeBreadcrumb(undefined)).toBe('')
  })
  it('real Amazon path: 4 levels → collapses middle', () => {
    expect(formatNodeBreadcrumb('Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Giacche'))
      .toBe('Auto e Moto › … › Abbigliamento protettivo › Giacche')
  })
})

describe('mixedTypeFamilies', () => {
  it('returns parent SKU when children span >1 product type (AIREON COAT+PANTS case)', () => {
    const rows = [
      { parentage_level: 'parent', item_sku: 'AIREON' },
      { parentage_level: 'child', parent_sku: 'AIREON', product_type: 'COAT', _rowId: 'r1' },
      { parentage_level: 'child', parent_sku: 'AIREON', product_type: 'PANTS', _rowId: 'r2' },
    ]
    expect(mixedTypeFamilies(rows)).toEqual(['AIREON'])
  })

  it('returns [] when all children share the same product type', () => {
    const rows = [
      { parentage_level: 'parent', item_sku: 'JACKET' },
      { parentage_level: 'child', parent_sku: 'JACKET', product_type: 'COAT', _rowId: 'r1' },
      { parentage_level: 'child', parent_sku: 'JACKET', product_type: 'coat', _rowId: 'r2' },
    ]
    expect(mixedTypeFamilies(rows)).toEqual([])
  })

  it('returns [] when there are no parents', () => {
    const rows = [
      { parentage_level: 'child', parent_sku: 'X', product_type: 'COAT', _rowId: 'r1' },
    ]
    expect(mixedTypeFamilies(rows)).toEqual([])
  })
})

describe('rowsMissingNode', () => {
  it('returns _rowId for a child with product_type but no browse node', () => {
    const rows = [
      { parentage_level: 'child', product_type: 'COAT', _rowId: 'r1' },
    ]
    expect(rowsMissingNode(rows)).toEqual(['r1'])
  })

  it('excludes a child that has a browse node', () => {
    const rows = [
      { parentage_level: 'child', product_type: 'COAT', recommended_browse_nodes: '2420941031', _rowId: 'r1' },
    ]
    expect(rowsMissingNode(rows)).toEqual([])
  })

  it('excludes parent rows', () => {
    const rows = [
      { parentage_level: 'parent', product_type: 'COAT', _rowId: 'r1' },
    ]
    expect(rowsMissingNode(rows)).toEqual([])
  })

  it('excludes ghost rows', () => {
    const rows = [
      { _ghost: true, parentage_level: 'child', product_type: 'COAT', _rowId: 'r1' },
    ]
    expect(rowsMissingNode(rows)).toEqual([])
  })

  it('excludes rows with empty product_type', () => {
    const rows = [
      { parentage_level: 'child', product_type: '', _rowId: 'r1' },
    ]
    expect(rowsMissingNode(rows)).toEqual([])
  })
})
