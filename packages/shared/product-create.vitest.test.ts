import { describe, expect, it } from 'vitest'
import { newProductProblems, normaliseNewProduct, PRODUCT_NAME_MAX_LENGTH, PRODUCT_SKU_MAX_LENGTH } from './product-create.js'

const valid = { sku: 'GALE-JACKET', name: 'Gale jacket', kind: 'single' }

describe('a new product’s fields', () => {
  it('accepts a typed SKU and name, with or without a family', () => {
    expect(newProductProblems(valid)).toEqual({})
    expect(newProductProblems({ ...valid, kind: 'parent', familyId: 'fam_1' })).toEqual({})
    expect(newProductProblems({ ...valid, sku: 'a.b_c-1', familyId: null })).toEqual({})
  })

  it('names each missing or wrong field in a sentence', () => {
    expect(newProductProblems({ sku: '  ', name: '', kind: 'bundle' })).toEqual({
      sku: 'Enter a SKU.', name: 'Enter a title.', kind: 'Choose Single product or Product with variations.',
    })
    expect(newProductProblems({ ...valid, sku: 'GALE JACKET' }).sku).toMatch(/No spaces/)
    expect(newProductProblems({ ...valid, sku: 'GALE/JACKET' }).sku).toMatch(/Use only letters/)
    expect(newProductProblems({ ...valid, familyId: 7 }).familyId).toBeDefined()
  })

  it('counts the trimmed length against the limits, and says how long it is', () => {
    expect(newProductProblems({ ...valid, sku: ` ${'A'.repeat(PRODUCT_SKU_MAX_LENGTH)} ` })).toEqual({})
    expect(newProductProblems({ ...valid, sku: 'A'.repeat(PRODUCT_SKU_MAX_LENGTH + 1) }).sku).toBe('A SKU can have up to 100 characters. This one has 101.')
    expect(newProductProblems({ ...valid, name: 'n'.repeat(PRODUCT_NAME_MAX_LENGTH + 1) }).name).toBe('A name can have up to 500 characters. This one has 501.')
  })

  it('stores trimmed values and an empty family as none', () => {
    expect(normaliseNewProduct({ sku: ' GALE ', name: ' Gale ', kind: 'parent', familyId: ' ' })).toEqual({ sku: 'GALE', name: 'Gale', kind: 'parent', familyId: null })
    expect(normaliseNewProduct({ sku: 'GALE', name: 'Gale', kind: 'single', familyId: 'fam_1' }).familyId).toBe('fam_1')
  })
})
