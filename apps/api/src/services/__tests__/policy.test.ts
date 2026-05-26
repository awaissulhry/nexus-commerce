/**
 * FL.6.1 — Unit tests for default link-policy derivation.
 */

import { describe, it, expect } from 'vitest'
import { defaultLinkPolicy } from '../field-resolution/policy.js'

describe('defaultLinkPolicy', () => {
  it('identity fields → locked / NONE', () => {
    for (const k of ['gtin', 'ean', 'upc', 'mpn', 'sku', 'brand', 'asin']) {
      expect(defaultLinkPolicy(k)).toEqual({ scope: 'locked', translatePolicy: 'NONE' })
    }
  })

  it('text copy → master / TRANSLATE', () => {
    for (const k of ['title', 'item_name', 'description', 'product_description', 'bullet_point1']) {
      expect(defaultLinkPolicy(k)).toEqual({ scope: 'master', translatePolicy: 'TRANSLATE' })
    }
  })

  it('images → linked-in-channel / NONE', () => {
    expect(defaultLinkPolicy('main_image_url')).toEqual({ scope: 'linked', translatePolicy: 'NONE' })
    expect(defaultLinkPolicy('swatch_image')).toEqual({ scope: 'linked', translatePolicy: 'NONE' })
  })

  it('price / quantity → master / VERBATIM', () => {
    expect(defaultLinkPolicy('our_price')).toEqual({ scope: 'master', translatePolicy: 'VERBATIM' })
    expect(defaultLinkPolicy('quantity')).toEqual({ scope: 'master', translatePolicy: 'VERBATIM' })
  })

  it('unknown CHILD field → master / VERBATIM', () => {
    expect(defaultLinkPolicy('size_specific_weight', 'CHILD')).toEqual({
      scope: 'master',
      translatePolicy: 'VERBATIM',
    })
  })

  it('unknown PARENT field → master / VERBATIM', () => {
    expect(defaultLinkPolicy('country_of_origin')).toEqual({
      scope: 'master',
      translatePolicy: 'VERBATIM',
    })
  })

  it('identity takes priority over text-substring match (brand)', () => {
    expect(defaultLinkPolicy('brand').scope).toBe('locked')
  })
})
