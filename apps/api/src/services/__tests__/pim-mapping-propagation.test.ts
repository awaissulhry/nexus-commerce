/**
 * FM.5 — catalog propagation planner verifier (pure core).
 *
 * applyMasterChanges (cascade respects per-coordinate overrides) and
 * buildCoordinateEntries (current→proposed diff + flags + currency guard).
 * prisma is stubbed because the module imports it at load; the functions
 * under test never touch it.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {
  marketplace: { findFirst: async (a: any) => ({ currency: ({ UK: 'GBP', GB: 'GBP', US: 'USD', PL: 'PLN', SE: 'SEK', TR: 'TRY' } as Record<string, string>)[String(a?.where?.code ?? '').toUpperCase()] ?? 'EUR', languages: [String(a?.where?.code ?? '').toUpperCase() === 'DE' ? 'de' : 'it'] }), findMany: async () => [] },
} }))

import { applyMasterChanges, buildCoordinateEntries } from '../pim/mapping-propagation.service.js'
import type { ResolvedAttributes, ValueSource } from '../pim/attribute-resolver.js'
import type { FieldLinkGroupLike } from '../pim/resolve-channel-field.js'
import type { FieldMappingRule } from '../pim/schema-mapping.service.js'

const PROD = { localizedContent: null, categoryAttributes: null, variantAttributes: null }

function attrs(map: Record<string, { value: unknown; source?: ValueSource; language?: string }>): ResolvedAttributes {
  const out: ResolvedAttributes = {}
  for (const [k, v] of Object.entries(map)) {
    out[k] = { ...v, source: v.source ?? 'master', inheritedFrom: null }
  }
  return out
}

// ════════════════════════════════════════════════════════════════════
// applyMasterChanges
// ════════════════════════════════════════════════════════════════════
describe('applyMasterChanges', () => {
  it('updates an inherited attribute (source master)', () => {
    const base = attrs({ material: { value: 'Leather', source: 'master' } })
    const next = applyMasterChanges(base, { material: 'Cotton' })
    expect(next.material.value).toBe('Cotton')
    expect(next.material.source).toBe('master')
  })

  it('does NOT touch an attribute the coordinate overrides', () => {
    const base = attrs({ material: { value: 'Premium Cowhide', source: 'channelExplicit' } })
    const next = applyMasterChanges(base, { material: 'Cotton' })
    expect(next.material.value).toBe('Premium Cowhide') // override kept
  })

  it('does NOT touch a channelOverride-sourced attribute', () => {
    const base = attrs({ color: { value: 'Nero', source: 'channelOverride' } })
    const next = applyMasterChanges(base, { color: 'Blu' })
    expect(next.color.value).toBe('Nero')
  })

  it('adds an attribute absent from the base', () => {
    const next = applyMasterChanges(attrs({}), { keywords: ['a', 'b'] })
    expect(next.keywords.value).toEqual(['a', 'b'])
  })

  it('does not mutate the base', () => {
    const base = attrs({ material: { value: 'Leather' } })
    applyMasterChanges(base, { material: 'Cotton' })
    expect(base.material.value).toBe('Leather')
  })
})

// ════════════════════════════════════════════════════════════════════
// buildCoordinateEntries
// ════════════════════════════════════════════════════════════════════
describe('buildCoordinateEntries', () => {
  const baseArgs = {
    channel: 'AMAZON',
    marketplace: 'DE',
    product: PROD,
    locale: 'en',
    links: [] as FieldLinkGroupLike[],
    sourceCurrency: 'EUR',
    // P4.4a — the target market's currency is DATA now, resolved by the caller
    // from `Marketplace.currency`. The default market here is DE = EUR.
    targetCurrency: 'EUR' as string | null,
  }

  it('surfaces a changed field as an update, skips unaffected fields', () => {
    const rules: Record<string, FieldMappingRule> = {
      material_type: { source: 'material' },
      brand: { source: 'brand' },
    }
    const base = attrs({ material: { value: 'Leather' }, brand: { value: 'XAVIA' } })
    const proposed = attrs({ material: { value: 'Cotton' }, brand: { value: 'XAVIA' } })
    const entries = buildCoordinateEntries({ ...baseArgs, rules, baseAttrs: base, proposedAttrs: proposed })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ fieldKey: 'material_type', current: 'Leather', proposed: 'Cotton', action: 'update' })
  })

  it('flags transformed when a value-map transform changes the value', () => {
    const rules: Record<string, FieldMappingRule> = {
      color_name: { source: 'color', transforms: [{ type: 'valueMap', attribute: 'color' }] },
    }
    const base = attrs({ color: { value: '' } })
    const proposed = attrs({ color: { value: 'Rosso' } })
    const entries = buildCoordinateEntries({
      ...baseArgs,
      rules,
      baseAttrs: base,
      proposedAttrs: proposed,
      transformCtx: { lookupValueMap: (a, f) => (a === 'color' && f === 'Rosso' ? 'Rot' : null) },
    })
    expect(entries[0].proposed).toBe('Rot')
    expect(entries[0].flags.transformed).toBe(true)
  })

  it('guards price fields against cross-currency cascade (skip + currencyMismatch)', () => {
    const rules: Record<string, FieldMappingRule> = { our_price: { source: 'price' } }
    const base = attrs({ price: { value: 100 } })
    const proposed = attrs({ price: { value: 120 } })
    // marketplace UK → GBP, source EUR → mismatch
    const entries = buildCoordinateEntries({ ...baseArgs, marketplace: 'UK', targetCurrency: 'GBP', rules, baseAttrs: base, proposedAttrs: proposed })
    expect(entries[0].action).toBe('skip')
    expect(entries[0].flags.currencyMismatch).toBe(true)
  })

  it('🔴 an UNCONFIGURED target currency is a mismatch, never a match', () => {
    // The old code derived the currency from the market code and returned EUR
    // for anything it did not recognise — so Poland and Sweden looked like
    // same-currency targets and a euro price cascaded straight into them.
    const rules: Record<string, FieldMappingRule> = { our_price: { source: 'price' } }
    const base = attrs({ price: { value: 100 } })
    const proposed = attrs({ price: { value: 120 } })
    const entries = buildCoordinateEntries({ ...baseArgs, marketplace: 'PL', targetCurrency: null, rules, baseAttrs: base, proposedAttrs: proposed })
    expect(entries[0].action).toBe('skip')
    expect(entries[0].flags.currencyMismatch).toBe(true)
  })

  it('does NOT flag currency for a same-currency market', () => {
    const rules: Record<string, FieldMappingRule> = { our_price: { source: 'price' } }
    const base = attrs({ price: { value: 100 } })
    const proposed = attrs({ price: { value: 120 } })
    const entries = buildCoordinateEntries({ ...baseArgs, marketplace: 'DE', rules, baseAttrs: base, proposedAttrs: proposed })
    expect(entries[0].action).toBe('update')
    expect(entries[0].flags.currencyMismatch).toBe(false)
  })

  it('flags needsTranslation for a cross-language linked field even when the master value is unchanged', () => {
    const rules: Record<string, FieldMappingRule> = { item_name: { source: 'title' } }
    const links: FieldLinkGroupLike[] = [
      {
        fieldKey: 'item_name',
        variantId: null,
        translatePolicy: 'TRANSLATE',
        sourceLanguage: 'it',
        members: [{ channel: 'AMAZON', marketplace: 'DE' }],
      },
    ]
    const base = attrs({ title: { value: 'Giacca', language: 'it' } })
    const proposed = attrs({ title: { value: 'Giacca', language: 'it' } }) // unchanged
    const entries = buildCoordinateEntries({ ...baseArgs, rules, baseAttrs: base, proposedAttrs: proposed, links })
    expect(entries).toHaveLength(1)
    expect(entries[0].flags.needsTranslation).toBe(true)
    expect(entries[0].action).toBe('update')
  })

  it('flags unmappedRequired when a required field resolves empty', () => {
    const rules: Record<string, FieldMappingRule> = { material_type: { source: 'material', required: true } }
    const base = attrs({ material: { value: 'Leather' } })
    const proposed = attrs({ material: { value: '' } }) // cleared
    const entries = buildCoordinateEntries({ ...baseArgs, rules, baseAttrs: base, proposedAttrs: proposed })
    expect(entries[0].flags.unmappedRequired).toBe(true)
  })
})
