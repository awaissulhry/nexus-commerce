import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { validateSchemaAttributes } from './mapping/schema-requirements.js'
import { shapeAmazonStudioAttributes } from './studio-publication-amazon-shape.js'

/**
 * 2026-10-03 — the studio's Amazon family message against the REAL IT OUTERWEAR schema (trimmed to the family roots,
 * conditions verbatim). Before: the parent failed "/ must have required property 'child_parent_sku_relationship';
 * /variation_theme/0 must NOT have additional properties", the child "/ must have required property 'variation_theme';
 * /fulfillment_availability/0 must NOT have additional properties". Every SKU is invented.
 */
const definition = JSON.parse(readFileSync(new URL('./__fixtures__/amazon-it-outerwear-family.json', import.meta.url), 'utf8'))
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: definition })
const MP = 'APJ6JRA9NG5V4' // Amazon.it's public marketplace id, the schema's own default
const title = [{ value: 'Giacca test', language_tag: 'it_IT', marketplace_id: MP }]
// What the legacy row builder emits (amazon/flat-file.service.ts `buildJsonFeedBodyWithReport`): the theme on the parent
// only, a child relationship without its type, and a marketplace_id in item lists that declare none.
const legacyParent = { item_name: title, parentage_level: [{ value: 'parent', marketplace_id: MP }], variation_theme: [{ name: 'SIZE/COLOR', marketplace_id: MP }] }
const legacyChild = { item_name: title, parentage_level: [{ value: 'child', marketplace_id: MP }],
  child_parent_sku_relationship: [{ parent_sku: 'TEST-SKU-PARENT', marketplace_id: MP }],
  fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, marketplace_id: MP }] }

describe('studio Amazon family shape', () => {
  it('the legacy shape fails the real schema (the fixture reproduces the review failure)', () => {
    expect(validateSchemaAttributes(spec, legacyParent)).toEqual(expect.arrayContaining([
      "/ must have required property 'child_parent_sku_relationship'", '/variation_theme/0 must NOT have additional properties']))
    expect(validateSchemaAttributes(spec, legacyChild)).toEqual(expect.arrayContaining([
      "/ must have required property 'variation_theme'", '/fulfillment_availability/0 must NOT have additional properties']))
  })

  it('a parent carries the relationship type without a parent SKU, and the theme without a marketplace_id', () => {
    const before = structuredClone(legacyParent)
    const shaped = shapeAmazonStudioAttributes(spec, legacyParent, { role: 'parent', theme: 'SIZE/COLOR' })
    expect(validateSchemaAttributes(spec, shaped)).toEqual([])
    expect(shaped.parentage_level).toEqual([{ value: 'parent', marketplace_id: MP }])
    expect(shaped.child_parent_sku_relationship).toEqual([{ child_relationship_type: 'variation', marketplace_id: MP }])
    expect(shaped.variation_theme).toEqual([{ name: 'SIZE/COLOR' }])
    expect(shaped.fulfillment_availability).toBeUndefined()
    expect(legacyParent).toEqual(before) // pure
  })

  it('a child names its parent seller SKU and carries the same theme; its fulfilment keeps channel and quantity', () => {
    const shaped = shapeAmazonStudioAttributes(spec, legacyChild, { role: 'child', theme: 'SIZE/COLOR', parentSku: 'TEST-SKU-PARENT' })
    expect(validateSchemaAttributes(spec, shaped)).toEqual([])
    expect(shaped.parentage_level).toEqual([{ value: 'child', marketplace_id: MP }])
    expect(shaped.child_parent_sku_relationship).toEqual([{ child_relationship_type: 'variation', parent_sku: 'TEST-SKU-PARENT', marketplace_id: MP }])
    expect(shaped.variation_theme).toEqual([{ name: 'SIZE/COLOR' }])
    expect(shaped.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 3 }])
  })

  it('a standalone product gets no relationship, theme or parentage; only the undeclared marketplace_id goes', () => {
    const standalone = { item_name: title, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU', marketplace_id: MP }] }
    const shaped = shapeAmazonStudioAttributes(spec, standalone, null)
    expect(validateSchemaAttributes(spec, shaped)).toEqual([])
    expect(shaped).toEqual({ item_name: title, fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] })
    // A schema that does not describe the root is no evidence: the instance is kept as built.
    const silent = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: { properties: {} } })
    expect(shapeAmazonStudioAttributes(silent, standalone, null)).toEqual(standalone)
  })

  // Item 12 (2026-10-05) — a single product has no family: a stale saved role, relationship or theme is never sent.
  it('a standalone product drops a stale listing role, relationship and theme the row or a saved value carried', () => {
    const stale = { item_name: title, parentage_level: [{ value: 'child', marketplace_id: MP }],
      child_parent_sku_relationship: [{ child_relationship_type: 'variation', parent_sku: 'TEST-SKU-OLD', marketplace_id: MP }],
      variation_theme: [{ name: 'SIZE/COLOR', marketplace_id: MP }], fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, marketplace_id: MP }] }
    const before = structuredClone(stale)
    const shaped = shapeAmazonStudioAttributes(spec, stale, null)
    expect(shaped).toEqual({ item_name: title, fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3 }] })
    expect(validateSchemaAttributes(spec, shaped)).toEqual([])
    expect(stale).toEqual(before) // pure
  })

  it('a family member published without its family row keeps what was built (never turned into a standalone listing)', () => {
    const shaped = shapeAmazonStudioAttributes(spec, legacyParent, null, { familyMember: true })
    expect(shaped.parentage_level).toEqual(legacyParent.parentage_level)
    expect(shaped.variation_theme).toEqual([{ name: 'SIZE/COLOR' }])
  })
})
