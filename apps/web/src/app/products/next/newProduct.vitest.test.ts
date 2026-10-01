import { describe, expect, it } from 'vitest'
import { createOutcome, draftProblems, EMPTY_NEW_PRODUCT, familyOptions, firstProblemField, newProductBody, productStudioPath } from './newProduct'

describe('the New product dialog', () => {
  it('checks the typed fields before sending, and focuses the first field with a problem', () => {
    const problems = draftProblems({ ...EMPTY_NEW_PRODUCT, name: 'Gale' })
    expect(problems).toEqual({ sku: 'Enter a SKU.' })
    expect(firstProblemField(draftProblems(EMPTY_NEW_PRODUCT))).toBe('sku')
    expect(firstProblemField(draftProblems({ ...EMPTY_NEW_PRODUCT, sku: 'GALE' }))).toBe('name')
    expect(firstProblemField(draftProblems({ ...EMPTY_NEW_PRODUCT, sku: 'GALE', name: 'Gale' }))).toBeNull()
  })

  it('sends trimmed values, and no family when none was chosen', () => {
    expect(newProductBody({ sku: ' GALE ', name: ' Gale ', kind: 'parent', familyId: '' })).toEqual({ sku: 'GALE', name: 'Gale', kind: 'parent' })
    expect(newProductBody({ sku: 'GALE', name: 'Gale', kind: 'single', familyId: 'fam_1' })).toEqual({ sku: 'GALE', name: 'Gale', kind: 'single', familyId: 'fam_1' })
  })

  it('opens the studio of the created product', () => {
    expect(createOutcome(201, { id: 'p_1', sku: 'GALE' })).toEqual({ kind: 'created', id: 'p_1', sku: 'GALE' })
    expect(productStudioPath('p_1')).toBe('/products/p_1/edit/studio')
  })

  it('shows a refusal under the field it names, with the product that already has the SKU', () => {
    expect(createOutcome(409, { error: 'GALE already exists in this business.', code: 'DUPLICATE_SKU', field: 'sku', productId: 'p_0' }))
      .toEqual({ kind: 'field', field: 'sku', message: 'GALE already exists in this business.', productId: 'p_0' })
    expect(createOutcome(400, { error: 'This product family is not in this business. Choose another family, or none.', field: 'familyId' }))
      .toEqual({ kind: 'field', field: 'familyId', message: 'This product family is not in this business. Choose another family, or none.' })
  })

  it('puts everything else in one plain sentence, never a status code', () => {
    expect(createOutcome(403, { error: 'This operation requires products.create.' }).kind).toBe('failed')
    expect(createOutcome(403, {})).toEqual({ kind: 'failed', message: 'You do not have permission to create products in this business.' })
    expect(createOutcome(401, null)).toEqual({ kind: 'failed', message: 'Your session has ended. Sign in again, then create the product.' })
    expect(createOutcome(404, { error: 'Not Found' })).toEqual({ kind: 'failed', message: 'Not Found' })
    expect(createOutcome(500, { error: 'boom' })).toEqual({ kind: 'failed', message: 'The product could not be created. Try again in a moment.' })
    expect(createOutcome(502, null)).toEqual({ kind: 'failed', message: 'The product could not be created. Try again in a moment.' })
    expect(createOutcome(400, { error: 'Bad', field: 'price' })).toEqual({ kind: 'failed', message: 'Bad' })
  })

  it('lists the families by name, searchable by name and code', () => {
    expect(familyOptions({ families: [{ id: 'b', code: 'helmet', label: 'Helmet' }, { id: 'a', code: 'jacket', label: 'Air jacket' }, { id: 'c', code: 'gloves', label: '' }, { nope: 1 }] }))
      .toEqual([{ value: 'a', label: 'Air jacket', searchText: 'Air jacket jacket' }, { value: 'c', label: 'gloves', searchText: 'gloves' }, { value: 'b', label: 'Helmet', searchText: 'Helmet helmet' }])
    expect(familyOptions(null)).toEqual([])
  })
})
