/**
 * PIM A.1 — Attribute resolver verifier.
 *
 * Pins the merge precedence contract that downstream phases depend on.
 * Any change to merge order requires updating these tests.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveAttributes,
  resolveAttributesFlat,
  resolveAttributesBySource,
  type ProductLike,
  type ChannelListingLike,
} from '../pim/attribute-resolver.js'

// ────────────────────────────────────────────────────────────────────
// Fixture builders — keep test bodies focused on the assertion, not
// scaffold setup.
// ────────────────────────────────────────────────────────────────────

function mkProduct(overrides: Partial<ProductLike> = {}): ProductLike {
  return {
    id: 'p_default',
    parentId: null,
    categoryAttributes: null,
    localizedContent: null,
    variantAttributes: null,
    ...overrides,
  }
}

function mkChannelListing(overrides: Partial<ChannelListingLike> = {}): ChannelListingLike {
  return {
    id: 'cl_default',
    overrideData: null,
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────
// Case 1: standalone product, no variant, no channel
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — standalone product', () => {
  it('returns master categoryAttributes with source=master', () => {
    const product = mkProduct({
      id: 'p1',
      categoryAttributes: { material: 'Cowhide', armor: 'CE Level 2' },
    })

    const result = resolveAttributes({ product, parent: null })

    expect(result.material).toEqual({ value: 'Cowhide', source: 'master', inheritedFrom: 'p1' })
    expect(result.armor).toEqual({ value: 'CE Level 2', source: 'master', inheritedFrom: 'p1' })
  })

  it('returns empty result when product has nothing set', () => {
    const product = mkProduct()
    const result = resolveAttributes({ product, parent: null })
    expect(Object.keys(result)).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 2: variant inheritance from parent
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — variant inheritance', () => {
  it('variant inherits parent categoryAttributes when own is empty', () => {
    const parent = mkProduct({ id: 'parent1', categoryAttributes: { material: 'Cowhide' } })
    const variant = mkProduct({ id: 'v1', parentId: 'parent1' })

    const result = resolveAttributes({ product: variant, parent })

    expect(result.material.value).toBe('Cowhide')
    expect(result.material.source).toBe('master')
    expect(result.material.inheritedFrom).toBe('parent1')
  })

  it('variant overrides parent when own categoryAttributes set', () => {
    const parent = mkProduct({ id: 'parent1', categoryAttributes: { material: 'Cowhide' } })
    const variant = mkProduct({
      id: 'v1',
      parentId: 'parent1',
      categoryAttributes: { material: 'Kangaroo' },
    })

    const result = resolveAttributes({ product: variant, parent })

    expect(result.material.value).toBe('Kangaroo')
    expect(result.material.source).toBe('variant')
    expect(result.material.inheritedFrom).toBe('v1')
  })

  it('variant axis values (variantAttributes) carry variant source', () => {
    const parent = mkProduct({ id: 'parent1', categoryAttributes: { brand: 'Xavia' } })
    const variant = mkProduct({
      id: 'v1',
      parentId: 'parent1',
      variantAttributes: { Color: 'Black', Size: '52' },
    })

    const result = resolveAttributes({ product: variant, parent })

    expect(result.Color).toEqual({ value: 'Black', source: 'variant', inheritedFrom: 'v1' })
    expect(result.brand.value).toBe('Xavia')
    expect(result.brand.source).toBe('master')
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 3: locale fallback
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — locale fallback', () => {
  it('uses requested locale when present', () => {
    const product = mkProduct({
      id: 'p1',
      localizedContent: { en: { title: 'Racing Suit' }, it: { title: 'Tuta da Pista' } },
    })

    const result = resolveAttributes({ product, parent: null, locale: 'it' })

    expect(result.title.value).toBe('Tuta da Pista')
    expect(result.title.source).toBe('masterLocale')
  })

  it('falls back to en when requested locale is missing', () => {
    const product = mkProduct({
      id: 'p1',
      localizedContent: { en: { title: 'Racing Suit' }, it: {} },
    })

    const result = resolveAttributes({ product, parent: null, locale: 'it' })

    expect(result.title.value).toBe('Racing Suit')
    expect(result.title.source).toBe('masterLocale')
  })

  it('per-key locale fallback — partial it content fills gaps from en', () => {
    const product = mkProduct({
      id: 'p1',
      localizedContent: {
        en: { title: 'Racing Suit', description: 'A racing suit.' },
        it: { title: 'Tuta da Pista' }, // description absent
      },
    })

    const result = resolveAttributes({ product, parent: null, locale: 'it' })

    expect(result.title.value).toBe('Tuta da Pista')
    expect(result.description.value).toBe('A racing suit.')
  })

  it('defaults to en when no locale specified', () => {
    const product = mkProduct({
      id: 'p1',
      localizedContent: { en: { title: 'Racing Suit' }, it: { title: 'Tuta' } },
    })

    const result = resolveAttributes({ product, parent: null })

    expect(result.title.value).toBe('Racing Suit')
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 4: channel-level JSONB override (overrideData bag)
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — channel overrideData', () => {
  it('channel override beats master value', () => {
    const product = mkProduct({ id: 'p1', categoryAttributes: { material: 'Cowhide' } })
    const channelListing = mkChannelListing({
      id: 'cl1',
      overrideData: { material: 'Premium Cowhide' },
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.material).toEqual({
      value: 'Premium Cowhide',
      source: 'channelOverride',
      inheritedFrom: 'cl1',
    })
  })

  it('channel override coexists with non-overridden master keys', () => {
    const product = mkProduct({
      id: 'p1',
      categoryAttributes: { material: 'Cowhide', armor: 'CE2' },
    })
    const channelListing = mkChannelListing({
      id: 'cl1',
      overrideData: { material: 'Premium Cowhide' },
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.material.source).toBe('channelOverride')
    expect(result.armor.source).toBe('master')
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 5: SSOT explicit overrides (Phase 20 followMaster* + *Override)
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — SSOT explicit overrides', () => {
  it('respects followMasterTitle=true: titleOverride is ignored, master wins', () => {
    const product = mkProduct({
      id: 'p1',
      localizedContent: { en: { title: 'Master Title' }, it: {} },
    })
    const channelListing = mkChannelListing({
      id: 'cl1',
      followMasterTitle: true,
      titleOverride: 'Channel Title',
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.title.value).toBe('Master Title')
    expect(result.title.source).toBe('masterLocale')
  })

  it('followMasterTitle=false: titleOverride wins with channelExplicit source', () => {
    const product = mkProduct({
      id: 'p1',
      localizedContent: { en: { title: 'Master Title' }, it: {} },
    })
    const channelListing = mkChannelListing({
      id: 'cl1',
      followMasterTitle: false,
      titleOverride: 'Channel Title',
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.title).toEqual({
      value: 'Channel Title',
      source: 'channelExplicit',
      inheritedFrom: 'cl1',
    })
  })

  it('followMasterPrice=false with priceOverride=999 returns 999 channelExplicit', () => {
    const channelListing = mkChannelListing({
      id: 'cl1',
      followMasterPrice: false,
      priceOverride: 999,
    })
    const product = mkProduct({ id: 'p1', categoryAttributes: { price: 850 } })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.price.value).toBe(999)
    expect(result.price.source).toBe('channelExplicit')
  })

  it('followMasterPrice=false but priceOverride=null falls back to direct .price column', () => {
    // Legacy row that never got Phase-20-migrated: keeps value in
    // .price not .priceOverride. Resolver must still surface it.
    const channelListing = mkChannelListing({
      id: 'cl1',
      followMasterPrice: false,
      priceOverride: null,
      price: 875,
    })
    const product = mkProduct({ id: 'p1', categoryAttributes: { price: 850 } })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.price.value).toBe(875)
    expect(result.price.source).toBe('channelExplicit')
  })

  it('followMaster flag absent defaults to TRUE (mirrors schema default)', () => {
    const channelListing = mkChannelListing({
      id: 'cl1',
      titleOverride: 'Should be ignored',
      // followMasterTitle is undefined here
    })
    const product = mkProduct({
      id: 'p1',
      localizedContent: { en: { title: 'Master Title' }, it: {} },
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.title.value).toBe('Master Title')
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 6: explicit null vs absent key semantics
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — null vs absent', () => {
  it('explicit null in overrideData overrides master to null (not the same as absent)', () => {
    const product = mkProduct({ id: 'p1', categoryAttributes: { material: 'Cowhide' } })
    const channelListing = mkChannelListing({
      id: 'cl1',
      overrideData: { material: null },
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.material.value).toBeNull()
    expect(result.material.source).toBe('channelOverride')
  })

  it('absent key in overrideData leaves master value intact', () => {
    const product = mkProduct({ id: 'p1', categoryAttributes: { material: 'Cowhide' } })
    const channelListing = mkChannelListing({
      id: 'cl1',
      overrideData: { otherKey: 'value' },
    })

    const result = resolveAttributes({ product, parent: null, channelListing })

    expect(result.material.value).toBe('Cowhide')
    expect(result.material.source).toBe('master')
    expect(result.otherKey.source).toBe('channelOverride')
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 7: convenience wrappers
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributesFlat', () => {
  it('strips provenance and returns plain key→value map', () => {
    const product = mkProduct({
      id: 'p1',
      categoryAttributes: { material: 'Cowhide', armor: 'CE2' },
    })

    const flat = resolveAttributesFlat({ product, parent: null })

    expect(flat).toEqual({ material: 'Cowhide', armor: 'CE2' })
  })
})

describe('resolveAttributesBySource', () => {
  it('filters to only the requested origin sources', () => {
    const parent = mkProduct({ id: 'parent1', categoryAttributes: { brand: 'Xavia' } })
    const variant = mkProduct({
      id: 'v1',
      parentId: 'parent1',
      variantAttributes: { Color: 'Black' },
    })
    const channelListing = mkChannelListing({
      id: 'cl1',
      overrideData: { material: 'Premium Cowhide' },
    })

    const onlyOverrides = resolveAttributesBySource(
      { product: variant, parent, channelListing },
      ['channelOverride', 'channelExplicit'],
    )

    expect(Object.keys(onlyOverrides)).toEqual(['material'])
    expect(onlyOverrides.material.value).toBe('Premium Cowhide')
  })
})

// ────────────────────────────────────────────────────────────────────
// Case 8: full-stack scenario — variant + channel + locale together
// ────────────────────────────────────────────────────────────────────
describe('resolveAttributes — full stack', () => {
  it('master → variant → channelOverride → channelExplicit all compose', () => {
    const parent = mkProduct({
      id: 'parent1',
      categoryAttributes: { material: 'Cowhide', armor: 'CE2', brand: 'Xavia' },
      localizedContent: {
        en: { title: 'Apex Racing Suit', description: 'A premium suit.' },
        it: { title: 'Tuta Apex' },
      },
    })
    const variant = mkProduct({
      id: 'v1',
      parentId: 'parent1',
      variantAttributes: { Color: 'Black/White', Size: '52' },
      categoryAttributes: { material: 'Kangaroo' }, // override parent
    })
    const channelListing = mkChannelListing({
      id: 'cl1',
      overrideData: { armor: 'CE Level 2 (Certified)' }, // override parent
      followMasterPrice: false,
      priceOverride: 1299,
    })

    const result = resolveAttributes({
      product: variant,
      parent,
      channelListing,
      locale: 'it',
    })

    // From parent master
    expect(result.brand).toEqual({ value: 'Xavia', source: 'master', inheritedFrom: 'parent1' })
    // From parent locale (it has title, en fills description)
    expect(result.title.value).toBe('Tuta Apex')
    expect(result.description.value).toBe('A premium suit.')
    // From variant
    expect(result.material).toEqual({ value: 'Kangaroo', source: 'variant', inheritedFrom: 'v1' })
    expect(result.Color.source).toBe('variant')
    expect(result.Size.value).toBe('52')
    // From channelOverride bag
    expect(result.armor).toEqual({
      value: 'CE Level 2 (Certified)',
      source: 'channelOverride',
      inheritedFrom: 'cl1',
    })
    // From channelExplicit (SSOT)
    expect(result.price).toEqual({
      value: 1299,
      source: 'channelExplicit',
      inheritedFrom: 'cl1',
    })
  })
})
