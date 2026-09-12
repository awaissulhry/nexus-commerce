import { describe, expect, it } from 'vitest'
import { resolveAttributes } from './attribute-resolver.js'
import { resolveChannelField } from './resolve-channel-field.js'
import { contentSlots, stampContentReview } from './content-locale.js'
import { mergeLocalizedContent } from './localized-content.js'

const product = { id: 'p', parentId: null, categoryAttributes: {}, variantAttributes: {}, localizedContent: {} }
describe('Information locale provenance and lifecycle', () => {
  it('marks the reproduced English fallback as untranslated German, including fallback mappings', () => {
    const p = { ...product, localizedContent: { en: { title: 'Waterproof jacket' } } }
    const resolvedAttrs = resolveAttributes({ product: p, parent: null, locale: 'de' })
    for (const rule of [{ source: 'title' }, { source: 'absent', fallback: 'title' }, { source: 'localizedContent.en.title' }]) {
      expect(resolveChannelField({ fieldKey: 'title', rule, product: p, resolvedAttrs, locale: 'de' })).toMatchObject({ value: 'Waterproof jacket', requestedLocale: 'de', effectiveLocale: 'en', needsTranslation: true, translationState: 'fallback' })
    }
  })
  it('preserves current-locale parent content and child fallbacks with the right owner', () => {
    const parent = { ...product, localizedContent: { en: { title: 'Parent' }, de: { description: 'Beschreibung' } } }
    const child = { ...product, id: 'child', parentId: 'p', localizedContent: { en: { title: 'Child', description: 'English' } } }
    const resolved = resolveAttributes({ product: child, parent, locale: 'de' })
    expect(resolved.title).toMatchObject({ value: 'Child', inheritedFrom: 'child', effectiveLocale: 'en', translationState: 'fallback' })
    expect(resolved.description).toMatchObject({ value: 'Beschreibung', inheritedFrom: 'p', effectiveLocale: 'de' })
  })
  it('retains legacy translations without overwriting authored empty/false/zero values', () => {
    const p = { ...product, localizedContent: { de: { bulletPoints: [], score: 0, washable: false } }, translations: [{ language: 'de', name: 'Jacke', bulletPoints: ['old'] }] }
    expect(contentSlots(p).de).toMatchObject({ title: 'Jacke', bulletPoints: [], score: 0, washable: false })
    const resolved = resolveAttributes({ product: p, parent: null, locale: 'de' })
    expect(resolved.title).toMatchObject({ value: 'Jacke', translationState: 'draft' })
    expect(resolveChannelField({ fieldKey: 'bullets', rule: { source: 'bulletPoints', fallback: 'title' }, product: p, resolvedAttrs: resolved, locale: 'de' }).value).toEqual([])
  })
  it('marks a reviewed translation outdated after its source changes through any writer', () => {
    const p = { ...product, name: 'Giacca', localizedContent: { it: { title: 'Giacca' }, de: { title: 'Jacke' } } }
    const localizedContent = stampContentReview(p, p.localizedContent, { de: { title: 'Jacke' } }, 'reviewed')
    expect(resolveAttributes({ product: { ...p, localizedContent }, parent: null, locale: 'de' }).title.translationState).toBe('reviewed')
    const changed = { ...p, localizedContent: { ...localizedContent, it: { title: 'Giacca impermeabile' } } }
    expect(resolveAttributes({ product: changed, parent: null, locale: 'de' }).title.translationState).toBe('outdated')
  })
  it('distinguishes intentional removal from return to inherited content', () => {
    const parent = { ...product, localizedContent: { de: { title: 'Parent' } } }
    const child = { ...product, id: 'c', parentId: 'p', localizedContent: { de: { title: null } } }
    expect(resolveAttributes({ product: child, parent, locale: 'de' }).title.value).toBeNull()
    const localizedContent = mergeLocalizedContent(child.localizedContent, {}, {}, { de: ['title'] })
    expect(resolveAttributes({ product: { ...child, localizedContent }, parent, locale: 'de' }).title).toMatchObject({ value: 'Parent', inheritedFrom: 'p' })
  })
})
