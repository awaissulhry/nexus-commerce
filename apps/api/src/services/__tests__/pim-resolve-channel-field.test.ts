/**
 * FM.2 — resolveChannelField verifier.
 *
 * Pins the unified resolver's precedence + the VALUE-IDENTITY invariant
 * (resolveChannelField's value === the legacy resolveSourcePath →
 * applyTransforms formula) that lets payload-preview keep its exact
 * output while the richer provenance/needsTranslation ride alongside.
 * Pure — no DB/AI.
 */

import { describe, it, expect } from 'vitest'
import type { ResolvedAttributes, ValueSource } from '../pim/attribute-resolver.js'
import type { FieldMappingRule } from '../pim/schema-mapping.service.js'
import {
  resolveChannelField,
  resolveSourcePath,
  applyTransforms,
  isPresent,
  linkForCoordinate,
  type FieldLinkGroupLike,
  type FieldLinkMembership,
} from '../pim/resolve-channel-field.js'

// ── fixtures ────────────────────────────────────────────────────────
const PROD = { localizedContent: null, categoryAttributes: null, variantAttributes: null }

function attrs(map: Record<string, { value: unknown; source?: ValueSource }>): ResolvedAttributes {
  const out: ResolvedAttributes = {}
  for (const [k, v] of Object.entries(map)) {
    out[k] = { value: v.value, source: v.source ?? 'master', inheritedFrom: null }
  }
  return out
}

function flatten(r: ResolvedAttributes): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) flat[k] = v.value
  return flat
}

// ════════════════════════════════════════════════════════════════════
// isPresent
// ════════════════════════════════════════════════════════════════════
describe('isPresent', () => {
  it('treats null/undefined/blank/empty-array as absent; 0 and false as present', () => {
    expect(isPresent(null)).toBe(false)
    expect(isPresent(undefined)).toBe(false)
    expect(isPresent('   ')).toBe(false)
    expect(isPresent([])).toBe(false)
    expect(isPresent(0)).toBe(true)
    expect(isPresent(false)).toBe(true)
    expect(isPresent('x')).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════
// resolveSourcePath (moved verbatim from publish-validator)
// ════════════════════════════════════════════════════════════════════
describe('resolveSourcePath', () => {
  it('reads a single-segment key from the resolved map', () => {
    expect(resolveSourcePath('title', { title: 'Hi' }, PROD, 'en')).toBe('Hi')
  })

  it('substitutes {locale} and walks raw product for multi-segment paths', () => {
    const product = {
      localizedContent: { it: { title: 'Ciao' }, en: { title: 'Hi' } },
      categoryAttributes: null,
      variantAttributes: null,
    }
    expect(resolveSourcePath('localizedContent.{locale}.title', {}, product, 'it')).toBe('Ciao')
  })

  it('returns null for a missing deep path', () => {
    expect(resolveSourcePath('categoryAttributes.material', {}, PROD, 'en')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════
// applyTransforms (moved verbatim from payload-preview)
// ════════════════════════════════════════════════════════════════════
describe('applyTransforms', () => {
  it('runs ops in order and records applied types', () => {
    const w: string[] = []
    const { out, applied } = applyTransforms('hello', [{ type: 'upperCase' }, { type: 'append', value: '!' }], w)
    expect(out).toBe('HELLO!')
    expect(applied).toEqual(['upperCase', 'append'])
  })

  it('truncates with a warning', () => {
    const w: string[] = []
    const { out } = applyTransforms('abcdef', [{ type: 'truncate', max: 3 }], w)
    expect(out).toBe('abc')
    expect(w.some((m) => m.includes('truncated'))).toBe(true)
  })

  it('default fires only on an empty value', () => {
    const w: string[] = []
    expect(applyTransforms('', [{ type: 'default', value: 'X' }], w).out).toBe('X')
    expect(applyTransforms('Y', [{ type: 'default', value: 'X' }], w).out).toBe('Y')
  })

  it('skips an unknown transform with a warning instead of throwing', () => {
    const w: string[] = []
    const { out } = applyTransforms('v', [{ type: 'fictional' } as any], w)
    expect(out).toBe('v')
    expect(w.some((m) => m.includes('unknown transform'))).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════
// resolveChannelField — provenance precedence
// ════════════════════════════════════════════════════════════════════
describe('resolveChannelField — provenance', () => {
  const rule = (over: Partial<FieldMappingRule> = {}): FieldMappingRule => ({ source: 'title', ...over })

  it('catalogRule when the value comes from the source path', () => {
    const r = resolveChannelField({ fieldKey: 'item_name', rule: rule(), resolvedAttrs: attrs({ title: { value: 'Hello' } }), product: PROD, locale: 'en' })
    expect(r.value).toBe('Hello')
    expect(r.source).toBe('catalogRule')
    expect(r.legacySource).toBe('source')
  })

  it('fallback when source is empty but fallback resolves', () => {
    const r = resolveChannelField({
      fieldKey: 'item_name',
      rule: rule({ fallback: 'name' }),
      resolvedAttrs: attrs({ title: { value: '' }, name: { value: 'Backup' } }),
      product: PROD,
      locale: 'en',
    })
    expect(r.value).toBe('Backup')
    expect(r.source).toBe('fallback')
    expect(r.legacySource).toBe('fallback')
  })

  it('default when a default transform fires on an empty source', () => {
    const r = resolveChannelField({
      fieldKey: 'item_name',
      rule: rule({ transforms: [{ type: 'default', value: 'D' }] }),
      resolvedAttrs: attrs({ title: { value: '' } }),
      product: PROD,
      locale: 'en',
    })
    expect(r.value).toBe('D')
    expect(r.source).toBe('default')
    expect(r.legacySource).toBe('default')
  })

  it('missing when source, fallback and default are all empty', () => {
    const r = resolveChannelField({ fieldKey: 'item_name', rule: rule(), resolvedAttrs: attrs({ title: { value: '' } }), product: PROD, locale: 'en' })
    expect(r.value).toBeNull()
    expect(r.source).toBe('missing')
    expect(r.legacySource).toBe('missing')
  })

  it('override when the source attribute came from a channel override', () => {
    const r = resolveChannelField({
      fieldKey: 'item_name',
      rule: rule(),
      resolvedAttrs: attrs({ title: { value: 'Pinned', source: 'channelExplicit' } }),
      product: PROD,
      locale: 'en',
    })
    expect(r.value).toBe('Pinned')
    expect(r.source).toBe('override')
    expect(r.legacySource).toBe('source') // value still came from the source path
  })

  it('locked wins over override/linked', () => {
    const r = resolveChannelField({
      fieldKey: 'gtin',
      rule: rule({ source: 'gtin' }),
      resolvedAttrs: attrs({ gtin: { value: '123', source: 'channelExplicit' } }),
      product: PROD,
      locale: 'en',
      locked: true,
    })
    expect(r.source).toBe('locked')
  })

  it('linked when the coordinate is a link member (no override)', () => {
    const link: FieldLinkMembership = { translatePolicy: 'VERBATIM', sourceLanguage: 'it', targetLanguage: 'it' }
    const r = resolveChannelField({ fieldKey: 'item_name', rule: rule(), resolvedAttrs: attrs({ title: { value: 'Hello' } }), product: PROD, locale: 'en', link })
    expect(r.source).toBe('linked')
    expect(r.needsTranslation).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// resolveChannelField — needsTranslation
// ════════════════════════════════════════════════════════════════════
describe('resolveChannelField — needsTranslation', () => {
  const base = { fieldKey: 'item_name', rule: { source: 'title' } as FieldMappingRule, resolvedAttrs: attrs({ title: { value: 'Ciao' } }), product: PROD, locale: 'it' }

  it('flags a cross-language TRANSLATE member', () => {
    const link: FieldLinkMembership = { translatePolicy: 'TRANSLATE', sourceLanguage: 'it', targetLanguage: 'de' }
    expect(resolveChannelField({ ...base, link }).needsTranslation).toBe(true)
  })

  it('does NOT flag a same-language TRANSLATE member', () => {
    const link: FieldLinkMembership = { translatePolicy: 'TRANSLATE', sourceLanguage: 'it', targetLanguage: 'it' }
    expect(resolveChannelField({ ...base, link }).needsTranslation).toBe(false)
  })

  it('does NOT flag a VERBATIM member even cross-language', () => {
    const link: FieldLinkMembership = { translatePolicy: 'VERBATIM', sourceLanguage: 'it', targetLanguage: 'de' }
    expect(resolveChannelField({ ...base, link }).needsTranslation).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// resolveChannelField — transforms still apply; raw preserved
// ════════════════════════════════════════════════════════════════════
describe('resolveChannelField — transforms', () => {
  it('applies transforms to the value and preserves the pre-transform raw', () => {
    const r = resolveChannelField({
      fieldKey: 'item_name',
      rule: { source: 'title', transforms: [{ type: 'truncate', max: 3 }] },
      resolvedAttrs: attrs({ title: { value: 'abcdef' } }),
      product: PROD,
      locale: 'en',
    })
    expect(r.raw).toBe('abcdef')
    expect(r.value).toBe('abc')
    expect(r.appliedTransforms).toEqual(['truncate'])
  })
})

// ════════════════════════════════════════════════════════════════════
// VALUE-IDENTITY invariant — the core FM.2 safety guarantee
// ════════════════════════════════════════════════════════════════════
describe('resolveChannelField — value identity vs legacy formula', () => {
  const cases: Array<{ name: string; rule: FieldMappingRule; resolvedAttrs: ResolvedAttributes; link?: FieldLinkMembership; locked?: boolean }> = [
    { name: 'plain source', rule: { source: 'title' }, resolvedAttrs: attrs({ title: { value: 'Hello' } }) },
    { name: 'source + truncate', rule: { source: 'title', transforms: [{ type: 'truncate', max: 4 }] }, resolvedAttrs: attrs({ title: { value: 'HelloWorld' } }) },
    { name: 'fallback path', rule: { source: 'title', fallback: 'name' }, resolvedAttrs: attrs({ title: { value: '' }, name: { value: 'Backup' } }) },
    { name: 'default transform', rule: { source: 'title', transforms: [{ type: 'default', value: 'D' }] }, resolvedAttrs: attrs({ title: { value: '' } }) },
    { name: 'all empty → null', rule: { source: 'title' }, resolvedAttrs: attrs({ title: { value: '' } }) },
    { name: 'override value', rule: { source: 'title' }, resolvedAttrs: attrs({ title: { value: 'Pinned', source: 'channelOverride' } }) },
    { name: 'linked member', rule: { source: 'title' }, resolvedAttrs: attrs({ title: { value: 'Hello' } }), link: { translatePolicy: 'TRANSLATE', sourceLanguage: 'it', targetLanguage: 'de' } },
    { name: 'locked identity', rule: { source: 'gtin' }, resolvedAttrs: attrs({ gtin: { value: '123' } }), locked: true },
    { name: 'append+upper', rule: { source: 'title', transforms: [{ type: 'upperCase' }, { type: 'append', value: '!' }] }, resolvedAttrs: attrs({ title: { value: 'hey' } }) },
  ]

  for (const c of cases) {
    it(`matches legacy value: ${c.name}`, () => {
      // legacy formula
      const flat = flatten(c.resolvedAttrs)
      const warnings: string[] = []
      let legacy = resolveSourcePath(c.rule.source, flat, PROD, 'en')
      if (!isPresent(legacy) && c.rule.fallback) {
        const fb = resolveSourcePath(c.rule.fallback, flat, PROD, 'en')
        if (isPresent(fb)) legacy = fb
      }
      const { out } = applyTransforms(legacy, c.rule.transforms, warnings)
      const expected = isPresent(out) ? out : null

      const r = resolveChannelField({ fieldKey: 'f', rule: c.rule, resolvedAttrs: c.resolvedAttrs, product: PROD, locale: 'en', link: c.link ?? null, locked: c.locked })
      expect(r.value).toEqual(expected)
    })
  }
})

// ════════════════════════════════════════════════════════════════════
// linkForCoordinate
// ════════════════════════════════════════════════════════════════════
describe('linkForCoordinate', () => {
  const parentGroup: FieldLinkGroupLike = {
    fieldKey: 'item_name',
    variantId: null,
    translatePolicy: 'TRANSLATE',
    sourceLanguage: 'it',
    members: [
      { channel: 'AMAZON', marketplace: 'IT' },
      { channel: 'AMAZON', marketplace: 'DE' },
    ],
  }

  it('returns membership with the target market language for a member coordinate', () => {
    const m = linkForCoordinate([parentGroup], 'item_name', 'AMAZON', 'DE')
    expect(m).not.toBeNull()
    expect(m!.translatePolicy).toBe('TRANSLATE')
    expect(m!.sourceLanguage).toBe('it')
    expect(m!.targetLanguage).toBe('de') // languageForMarketplace('DE')
  })

  it('returns null for a non-member coordinate', () => {
    expect(linkForCoordinate([parentGroup], 'item_name', 'AMAZON', 'FR')).toBeNull()
  })

  it('returns null when the field key does not match', () => {
    expect(linkForCoordinate([parentGroup], 'description', 'AMAZON', 'IT')).toBeNull()
  })

  it('scopes CHILD groups by variantId', () => {
    const childGroup: FieldLinkGroupLike = {
      fieldKey: 'purchasable_offer.our_price',
      variantId: 'v1',
      translatePolicy: 'NONE',
      sourceLanguage: null,
      members: [{ channel: 'AMAZON', marketplace: 'IT', variantId: 'v1' }],
    }
    expect(linkForCoordinate([childGroup], 'purchasable_offer.our_price', 'AMAZON', 'IT', 'v1')).not.toBeNull()
    // wrong variant → not a member
    expect(linkForCoordinate([childGroup], 'purchasable_offer.our_price', 'AMAZON', 'IT', 'v2')).toBeNull()
    // product-level query → not a CHILD member
    expect(linkForCoordinate([childGroup], 'purchasable_offer.our_price', 'AMAZON', 'IT', null)).toBeNull()
  })

  it('tolerates malformed members without throwing', () => {
    const bad: FieldLinkGroupLike = { fieldKey: 'item_name', variantId: null, translatePolicy: 'VERBATIM', sourceLanguage: null, members: 'not-an-array' as unknown }
    expect(linkForCoordinate([bad], 'item_name', 'AMAZON', 'IT')).toBeNull()
  })
})
