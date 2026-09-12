/**
 * FM.13 — mapping-suggest verifier (pure matcher).
 *
 * suggestSourceForField: exact normalized alias → high, substring → medium,
 * no match → null. prisma stubbed (module imports it at load).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { suggestSourceForField } from '../pim/mapping-suggest.service.js'

describe('suggestSourceForField', () => {
  it('exact alias (key) → high confidence', () => {
    expect(suggestSourceForField('item_name')).toMatchObject({ source: 'title', confidence: 'high' })
    expect(suggestSourceForField('product_description')).toMatchObject({ source: 'description', confidence: 'high' })
    expect(suggestSourceForField('our_price')).toMatchObject({ source: 'basePrice', confidence: 'high' })
    expect(suggestSourceForField('material_type')).toMatchObject({ source: 'categoryAttributes.material', confidence: 'high' })
    expect(suggestSourceForField('generic_keyword')).toMatchObject({ source: 'keywords', confidence: 'high' })
  })

  it('matches on the label when the key does not', () => {
    expect(suggestSourceForField('attr_42', 'Brand')).toMatchObject({ source: 'brand', confidence: 'high' })
  })

  it('refuses substring-only matches with different semantics', () => {
    expect(suggestSourceForField('outer_shell_color_name')).toBeNull()
    expect(suggestSourceForField('purchasable_offer__discounted_price__end_at')).toBeNull()
    expect(suggestSourceForField('gpsr_manufacturer_reference', 'Manufacturer email')).toBeNull()
  })

  it('returns null for an unrelated field', () => {
    expect(suggestSourceForField('voltage')).toBeNull()
    expect(suggestSourceForField('hazmat_un_number')).toBeNull()
  })

  it('does not suggest prices for list prices, or partial matches for empty and short keys', () => {
    expect(suggestSourceForField('list_price')?.confidence).not.toBe('high')
    expect(suggestSourceForField('')).toBeNull()
    expect(suggestSourceForField('id')).toBeNull()
    expect(suggestSourceForField('xx', 'a')).toBeNull()
    expect(suggestSourceForField('fabric_type')?.confidence).not.toBe('high')
  })

  it('is case/punctuation insensitive', () => {
    expect(suggestSourceForField('Item-Name')).toMatchObject({ source: 'title' })
    expect(suggestSourceForField('ITEM_NAME')).toMatchObject({ source: 'title' })
  })
})
