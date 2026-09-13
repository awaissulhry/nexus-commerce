/**
 * VT.1b / R-VT-2 — a stored mapping document is NEVER parsed to empty, and the variation rule has a validator.
 *
 * The arm that matters is the one VT.3 hit on the live local catalogue: a VX M2 rule block inside
 * `byProductType.AUTO_ACCESSORY`. Before this change it cost the marketplace every rule it had — `mappingVersion
 * 12 → 1`, mapped `65 → 57`, coverage `100 → 88` — with a 200 response. The overlay fixture below carries the two
 * rule SHAPES that were the measured casualties (one with a `transforms` expression, one that exists only in the
 * overlay), so "the marketplace keeps its rules" is asserted on the shapes that actually lost them.
 *
 * Every table has its CONTROL in the same run: the identical mapping with no variations key must validate clean and
 * parse to version 12. A run where the control also fails proves the instrument, not the fix.
 */

import { describe, expect, it } from 'vitest'
import {
  getRulesFor,
  getVariationRule,
  parseMapping,
  parseMappingWithWarnings,
  setVariationRuleInMapping,
  validateMapping,
  type MarketplaceSchemaMapping,
} from './schema-mapping.service.js'
import {
  looksLikeVariationRule,
  validateStoredVariationRule,
  VARIATION_RULE_KEY,
  type StoredVariationRule,
} from './variation-rule-store.js'

const RULE: StoredVariationRule = {
  theme: 'COLOR_NAME/SIZE_NAME',
  axes: [
    { axisKey: 'color', target: 'color', order: 0, included: true },
    { axisKey: 'size', target: 'size', order: 1, included: true },
  ],
  collisions: { resolver: 'fold', foldInto: 'color', foldSeparator: ' / ' },
  split: { mode: 'one', axisKey: null },
  label: 'Accessory default',
}

/** A realistic AUTO_ACCESSORY overlay: the two rule shapes VT.3 measured as the casualties. */
const base = (): MarketplaceSchemaMapping => ({
  version: 12,
  fields: { item_name: { source: 'name' }, brand: { source: 'brand' } },
  byProductType: {
    AUTO_ACCESSORY: {
      item_weight: { source: 'weightValue', transforms: [{ type: 'unit', from: 'kg', to: 'g' }] },
      volume_capacity_name: { source: 'categoryAttributes.volume' },
    },
  },
  expressions: { 'Margin 20': '$basePrice * 0.8' },
  lastSyncedAt: null,
  schemaSnapshotVersion: null,
})

const FIELDS_BEFORE = ['brand', 'item_name', 'item_weight', 'volume_capacity_name']
const resolved = (m: MarketplaceSchemaMapping) => Object.keys(getRulesFor(m, 'AUTO_ACCESSORY')).sort()
const raw = (m: MarketplaceSchemaMapping) => m as unknown as Record<string, any>

describe('R-VT-2 (a) — a stored document is never parsed to empty', () => {
  it('CONTROL: no variations key — clean, version 12, all four rules', () => {
    const m = base()
    expect(validateMapping(m)).toEqual([])
    expect(parseMapping(m).version).toBe(12)
    expect(resolved(parseMapping(m))).toEqual(FIELDS_BEFORE)
    expect(parseMappingWithWarnings(m).warnings).toEqual([])
  })

  it("THE ARM VT.3 HIT: a VX M2 rule block at byProductType.<cat>.variations keeps the marketplace's rules", () => {
    const m = base()
    raw(m).byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = RULE
    // was: ["byProductType.AUTO_ACCESSORY.variations.source must be a string"]
    expect(validateMapping(m)).toEqual([])
    // was: 1 (emptyMapping)
    expect(parseMapping(m).version).toBe(12)
    // was: [] — every rule on the marketplace gone
    expect(resolved(parseMapping(m))).toEqual(FIELDS_BEFORE)
    // and the rule itself is readable, at its stored address
    expect(getVariationRule(parseMapping(m), 'AUTO_ACCESSORY')).toMatchObject({
      scope: 'category', storedAt: `byProductType.AUTO_ACCESSORY.${VARIATION_RULE_KEY}`, rule: RULE,
    })
  })

  it('an UNKNOWN non-rule key is REPORTED on the write and WARNED on the read — never emptied', () => {
    const m = base()
    raw(m).byProductType.AUTO_ACCESSORY.somethingNobodyKnows = { not: 'a rule' }
    const errors = validateMapping(m)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('byProductType.AUTO_ACCESSORY.somethingNobodyKnows')
    const { mapping, warnings } = parseMappingWithWarnings(m)
    expect(mapping.version).toBe(12)
    expect(warnings).toEqual(errors)
    // served as stored — the read does not silently drop what a later write would have to preserve
    expect(resolved(mapping)).toContain('somethingNobodyKnows')
    expect(resolved(mapping)).toEqual([...FIELDS_BEFORE, 'somethingNobodyKnows'].sort())
  })

  it('a MALFORMED variation rule is refused on the write and warned on the read, rules intact', () => {
    const m = base()
    raw(m).variationsByProductType = { AUTO_ACCESSORY: { theme: 42, axes: 'nope', collisions: { resolver: 'teleport' } } }
    const errors = validateMapping(m)
    expect(errors.length).toBeGreaterThan(0)
    for (const e of errors) expect(e).toContain('mapping.variationsByProductType.AUTO_ACCESSORY')
    const { mapping, warnings } = parseMappingWithWarnings(m)
    expect(mapping.version).toBe(12)
    expect(resolved(mapping)).toEqual(FIELDS_BEFORE)
    expect(warnings).toEqual(errors)
  })

  it('a container of the wrong type is normalised, not fatal', () => {
    const m = raw(base())
    m.fields = 'not an object'
    m.byProductType = 7
    m.expressions = []
    m.version = 'twelve'
    m.lastSyncedAt = 42
    const { mapping, warnings } = parseMappingWithWarnings(m)
    expect(mapping.fields).toEqual({})
    expect(mapping.byProductType).toEqual({})
    expect(mapping.expressions).toEqual({})
    expect(mapping.version).toBe(1)
    expect(mapping.lastSyncedAt).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('only a non-object raw value still yields the empty mapping — there is nothing stored to serve', () => {
    expect(parseMapping(null).version).toBe(1)
    expect(parseMapping('{}').fields).toEqual({})
    expect(parseMappingWithWarnings([]).warnings).toEqual([])
    // the positive control in the same test: a real document is NOT emptied
    expect(parseMapping(base()).version).toBe(12)
  })
})

describe('R-VT-2 (c) — the validator knows the VariationRule shape at both addresses', () => {
  it('accepts a valid rule at all three placements', () => {
    for (const place of ['in-bucket', 'top-level', 'by-product-type'] as const) {
      const m = base()
      if (place === 'in-bucket') raw(m).byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = RULE
      if (place === 'top-level') raw(m).variations = RULE
      if (place === 'by-product-type') raw(m).variationsByProductType = { AUTO_ACCESSORY: RULE }
      expect(validateMapping(m), place).toEqual([])
      expect(parseMapping(m).version, place).toBe(12)
    }
  })

  it('names every malformed member', () => {
    expect(validateStoredVariationRule({ ...RULE, theme: 7 }, 'r')).toEqual(['r.theme must be a string or null'])
    expect(validateStoredVariationRule({ ...RULE, axes: {} }, 'r')).toEqual(['r.axes must be an array'])
    expect(validateStoredVariationRule({ ...RULE, axes: [{ axisKey: '', target: 1, order: -1, included: 'yes' }] }, 'r')).toEqual([
      'r.axes[0].axisKey must be a non-empty string',
      'r.axes[0].target must be a string or null',
      'r.axes[0].order must be a whole number',
      'r.axes[0].included must be true or false',
    ])
    expect(validateStoredVariationRule({ ...RULE, axes: [RULE.axes[0], RULE.axes[0]] }, 'r')).toEqual(['r.axes[1].axisKey "color" appears twice'])
    expect(validateStoredVariationRule({ ...RULE, collisions: { resolver: 'fold', foldInto: null, foldSeparator: ' / ' } }, 'r'))
      .toEqual(['r.collisions.foldInto is required when the resolver is fold'])
    expect(validateStoredVariationRule({ ...RULE, split: { mode: 'per-axis', axisKey: null } }, 'r'))
      .toEqual(['r.split.axisKey is required when the split mode is per-axis'])
    expect(validateStoredVariationRule({ theme: null }, 'r')).toEqual([
      'r.axes must be an array', 'r.collisions must be an object', 'r.split must be an object',
    ])
    expect(validateStoredVariationRule(null, 'r')).toEqual(['r must be an object'])
    // the control: the real rule is clean
    expect(validateStoredVariationRule(RULE, 'r')).toEqual([])
  })

  it('a missing `theme` key is named — null and absent are different statements', () => {
    const { theme, ...withoutTheme } = RULE
    expect(validateStoredVariationRule(withoutTheme, 'r')).toEqual(['r.theme is required (null when the channel derives it)'])
    expect(validateStoredVariationRule({ ...RULE, theme: null }, 'r')).toEqual([])
  })

  it('looksLikeVariationRule separates the two vocabularies', () => {
    expect(looksLikeVariationRule(RULE)).toBe(true)
    expect(looksLikeVariationRule({ source: 'name' })).toBe(false)
    expect(looksLikeVariationRule({ source: 'name', axes: [] })).toBe(false)
    expect(looksLikeVariationRule(null)).toBe(false)
  })
})

describe('resolution and the accessors', () => {
  it('getRulesFor NEVER resolves the reserved key as a field', () => {
    const m = base()
    raw(m).byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = RULE
    const fields = getRulesFor(parseMapping(m), 'AUTO_ACCESSORY')
    expect(Object.keys(fields).sort()).toEqual(FIELDS_BEFORE)
    expect(fields[VARIATION_RULE_KEY]).toBeUndefined()
    // the positive control: an overlay field IS resolved, and it overrides the default bucket
    expect(fields.item_weight).toMatchObject({ source: 'weightValue' })
  })

  it('getVariationRule precedence: the category canonical home, then the in-bucket legacy, then channel-wide', () => {
    const channelOnly = base(); raw(channelOnly).variations = RULE
    expect(getVariationRule(channelOnly, 'AUTO_ACCESSORY')).toMatchObject({ scope: 'channel', storedAt: 'variations' })
    expect(getVariationRule(channelOnly, null)).toMatchObject({ scope: 'channel' })

    const legacy = base(); raw(legacy).variations = RULE
    raw(legacy).byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = { ...RULE, label: 'legacy' }
    expect(getVariationRule(legacy, 'AUTO_ACCESSORY')).toMatchObject({ scope: 'category', rule: { label: 'legacy' } })

    const canonical = base(); raw(canonical).variations = RULE
    raw(canonical).byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = { ...RULE, label: 'legacy' }
    raw(canonical).variationsByProductType = { AUTO_ACCESSORY: { ...RULE, label: 'canonical' } }
    expect(getVariationRule(canonical, 'AUTO_ACCESSORY')).toMatchObject({
      scope: 'category', storedAt: 'variationsByProductType.AUTO_ACCESSORY', rule: { label: 'canonical' },
    })

    expect(getVariationRule(base(), 'AUTO_ACCESSORY')).toBeNull()
  })

  it('setVariationRuleInMapping writes the canonical home and touches no field rule', () => {
    const next = setVariationRuleInMapping(base(), 'AUTO_ACCESSORY', RULE)
    expect(next.variationsByProductType).toEqual({ AUTO_ACCESSORY: RULE })
    expect(next.fields).toEqual(base().fields)
    expect(next.byProductType).toEqual(base().byProductType)
    expect(validateMapping(next)).toEqual([])
    expect(resolved(parseMapping(next))).toEqual(FIELDS_BEFORE)
  })

  it('clearing a rule removes BOTH copies, so the next read cannot resolve a leftover', () => {
    const withBoth = base()
    raw(withBoth).variationsByProductType = { AUTO_ACCESSORY: RULE }
    raw(withBoth).byProductType.AUTO_ACCESSORY[VARIATION_RULE_KEY] = RULE
    const cleared = setVariationRuleInMapping(withBoth, 'AUTO_ACCESSORY', null)
    expect(getVariationRule(cleared, 'AUTO_ACCESSORY')).toBeNull()
    expect(cleared.variationsByProductType).toEqual({})
    expect(VARIATION_RULE_KEY in (cleared.byProductType!.AUTO_ACCESSORY as Record<string, unknown>)).toBe(false)
    // and the field rules that shared that bucket survive
    expect(Object.keys(cleared.byProductType!.AUTO_ACCESSORY).sort()).toEqual(['item_weight', 'volume_capacity_name'])
  })

  it('the channel-wide rule is set and cleared without a category', () => {
    const set = setVariationRuleInMapping(base(), null, RULE)
    expect(set.variations).toEqual(RULE)
    expect(setVariationRuleInMapping(set, null, null).variations).toBeUndefined()
  })
})
