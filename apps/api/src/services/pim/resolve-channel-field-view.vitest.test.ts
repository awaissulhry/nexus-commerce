/**
 * P7 (docs/attributes/PLAN.md §10.8) — the per-product view `resolveBatch` now builds ONCE and hands to every field.
 *
 * Before P7, `resolveChannelField` rebuilt three lookups on every call (the flat value map, the attribute keys, the keys
 * that carry a language). The pre-P7 code is kept below as the REFERENCE, and the shared view must give the same answer
 * for every field of a product — including when one view is reused for all of them, which is what the batch does.
 * Pure — no database.
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedAttributes, ValueSource } from './attribute-resolver.js'
import type { FieldMappingRule } from './schema-mapping.service.js'
import { resolveChannelField, resolvedAttrsView, type FieldLinkMembership } from './resolve-channel-field.js'
import { contentField, contentPathAddress } from './content-resolver.js'
import { CONTENT_COLUMNS } from './content-locale.js'

function attrs(map: Record<string, { value: unknown; source?: ValueSource; language?: string }>): ResolvedAttributes {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { ...v, source: v.source ?? 'master', inheritedFrom: null }]))
}

// ── the pre-P7 code, verbatim in behaviour ──
const referenceFlat = (r: ResolvedAttributes) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]))
const referenceKeys = (r: ResolvedAttributes) => Object.keys(r)
const referenceLanguageKeys = (r: ResolvedAttributes) => Object.keys(r).filter(key => r[key].language)
const referenceAddress = (path: string, requested: string, keys: readonly string[]) => {
  const parts = path.replace(/\{locale\}/g, requested).split('.')
  if (parts[0] === 'localizedContent') { parts.shift(); parts.shift() } else if (['categoryAttributes', 'variantAttributes'].includes(parts[0])) parts.shift()
  const field = contentField(parts.shift() ?? '')
  return [...Object.keys(CONTENT_COLUMNS), ...keys].includes(field)
}

const PRODUCT = { id: 'p1', parentId: null, localizedContent: null, categoryAttributes: null, variantAttributes: null }
const MIXED = attrs({
  title: { value: 'Giacca', language: 'it' },
  description: { value: 'Descrizione', language: 'it' },
  color: { value: 'Nero' },
  size: { value: 'M', language: '' },
  material: { value: ['Pelle', 'Cotone'], language: 'it' },
  weight: { value: 0 },
  lining: { value: null },
  flag: { value: false, source: 'channelOverride' },
  gtin: { value: '8000000000000', source: 'channelExplicit' },
})

describe('resolvedAttrsView', () => {
  it('equals the flat map, the keys and the language keys the pre-P7 code built on every call', () => {
    const view = resolvedAttrsView(MIXED)
    expect(view.flat).toEqual(referenceFlat(MIXED))
    expect([...view.keys]).toEqual(referenceKeys(MIXED))
    // `size` has an EMPTY language: the reference's truthiness test leaves it out, and so must the view.
    expect([...view.languageKeys]).toEqual(referenceLanguageKeys(MIXED))
    expect(view.languageKeys.has('size')).toBe(false)
  })
})

describe('contentPathAddress with a Set', () => {
  const keys = ['color', 'material', 'size']
  const paths = ['title', 'name', 'description', 'bulletPoints', 'keywords', 'color', 'categoryAttributes.color', 'variantAttributes.size',
    'localizedContent.de.color', 'localizedContent.{locale}.material', 'material.0', 'unknown', 'constructor', 'toString', '__proto__', '']
  for (const localizable of [keys, [] as string[]]) {
    for (const path of paths) {
      it(`answers like the array form: "${path}" with ${localizable.length} localizable keys`, () => {
        const withArray = contentPathAddress(path, 'it', localizable)
        const withSet = contentPathAddress(path, 'it', new Set(localizable))
        expect(withSet).toEqual(withArray)
        expect(withSet !== null).toBe(referenceAddress(path, 'it', localizable))
      })
    }
  }
})

describe('resolveChannelField with one shared view', () => {
  const rules: Array<{ name: string; rule: FieldMappingRule; locale?: string; link?: FieldLinkMembership }> = [
    { name: 'plain source', rule: { source: 'title' } },
    { name: 'fallback', rule: { source: 'lining', fallback: 'color' } },
    { name: 'list source', rule: { source: 'material' } },
    { name: 'zero', rule: { source: 'weight' } },
    { name: 'override provenance', rule: { source: 'flag' } },
    { name: 'explicit override', rule: { source: 'gtin' } },
    { name: 'localized path, other language', rule: { source: 'localizedContent.de.color' } },
    { name: 'localized attribute, other language', rule: { source: 'localizedContent.de.material' } },
    { name: 'category path', rule: { source: 'categoryAttributes.color' } },
    { name: 'expression', rule: { source: 'color', transforms: [{ type: 'expr', expr: 'concat($color, " / ", $size)' }] } },
    { name: 'template', rule: { source: 'title', transforms: [{ type: 'template', expr: '{{title}} – {{color}}' }] } },
    { name: 'default on empty', rule: { source: 'lining', transforms: [{ type: 'default', value: 'none' }] } },
    { name: 'German request', rule: { source: 'title' }, locale: 'de' },
    { name: 'translate link', rule: { source: 'title' }, locale: 'de', link: { translatePolicy: 'TRANSLATE', sourceLanguage: 'it', targetLanguage: 'de' } },
  ]
  const view = resolvedAttrsView(MIXED)
  for (const c of rules) {
    it(`gives the per-call answer: ${c.name}`, () => {
      const input = { fieldKey: 'f', rule: c.rule, resolvedAttrs: MIXED, product: PRODUCT, locale: c.locale ?? 'it', link: c.link ?? null }
      // The same view object serves every case in this block, as it serves every field of a product in resolveBatch.
      expect(resolveChannelField({ ...input, attrsView: view })).toEqual(resolveChannelField(input))
    })
  }

  it('leaves the shared view unchanged after every field has used it', () => {
    const before = JSON.stringify({ flat: view.flat, keys: [...view.keys], languageKeys: [...view.languageKeys] })
    for (const c of rules) resolveChannelField({ fieldKey: 'f', rule: c.rule, resolvedAttrs: MIXED, attrsView: view, product: PRODUCT, locale: c.locale ?? 'it', link: c.link ?? null })
    expect(JSON.stringify({ flat: view.flat, keys: [...view.keys], languageKeys: [...view.languageKeys] })).toBe(before)
  })
})
