// category-model.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { BROWSE_NODE_KEY, PRODUCT_TYPE_KEY, categoryOf, productTypesInUse, assignCategory } from './category-model.js'

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
