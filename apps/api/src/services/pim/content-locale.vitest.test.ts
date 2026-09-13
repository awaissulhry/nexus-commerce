/**
 * Information locale provenance — against the SHIPPED stores.
 *
 * LX.F R-LX-13 rewrote this file. Its five arms all expressed content inside
 * `Product.localizedContent`, and the one resolver does not read that slot for
 * content any more (design Appendix C: the JSON slot is retired for text; LX.1
 * made `ProductTranslation` the language tier). They therefore measured a
 * mechanism no writer feeds and no reader consults — while the property that
 * actually matters, "the retired slot cannot answer a cell", was asserted
 * nowhere. It is asserted here, with the shipped stores as the positive control.
 *
 * Measured while rewriting (`/usr/bin/grep -rln`, excluding tests):
 * `mergeLocalizedContent` → 0 non-test callers · `stampContentReview` → 0 (only
 * its own module) · `contentSlots` → 1 IMPORT in `product-translations.routes.ts`
 * and 0 calls, and it no longer reads the slot either (it composes the resolver).
 * Removing them is a scope decision (Appendix C stages it), so they are reported,
 * not deleted: LX.F finding F-LX-3.
 */
import { describe, expect, it } from 'vitest'
import { resolveAttributes } from './attribute-resolver.js'
import { resolveChannelField } from './resolve-channel-field.js'
import { contentSlots } from './content-locale.js'

const product = { id: 'p', parentId: null, categoryAttributes: {}, variantAttributes: {}, localizedContent: {}, translations: [] as unknown[] }

describe('the retired localizedContent slot', () => {
  it('cannot answer a content cell, while the shipped stores can', () => {
    // ARM — text ONLY in the legacy slot: the resolver must not find it.
    const legacyOnly = { ...product, localizedContent: { de: { title: 'Jacke aus dem JSON' } } }
    expect(resolveAttributes({ product: legacyOnly, parent: null, locale: 'de' }).title?.value ?? null).toBeNull()
    // And neither does `contentSlots`, which now composes the same resolver
    // (`content-locale.ts:15-23`) rather than reading the slot: the legacy German
    // key produces no German entry — only the primary language the product has.
    expect(Object.keys(contentSlots(legacyOnly))).toEqual(['it'])
    expect(contentSlots(legacyOnly).de).toBeUndefined()

    // POSITIVE CONTROL — the same text on the language tier IS read, and the one
    // that never moves is the source column.
    const shipped = { ...product, name: 'Giacca', translations: [{ language: 'de', name: 'Jacke', source: 'manual', reviewedAt: new Date('2026-09-12T00:00:00Z') }] }
    expect(resolveAttributes({ product: shipped, parent: null, locale: 'de' }).title).toMatchObject({ value: 'Jacke', effectiveLocale: 'de', translationState: 'reviewed' })
    expect(resolveAttributes({ product: shipped, parent: null, locale: 'it' }).title).toMatchObject({ value: 'Giacca', effectiveLocale: 'it' })
  })

  it('marks a source fallback as untranslated for the requested language, through every rule shape', () => {
    const p = { ...product, name: 'Giacca' }
    const resolvedAttrs = resolveAttributes({ product: p, parent: null, locale: 'de' })
    for (const rule of [{ source: 'title' }, { source: 'absent', fallback: 'title' }]) {
      expect(resolveChannelField({ fieldKey: 'title', rule, product: p, resolvedAttrs, locale: 'de' }))
        .toMatchObject({ value: 'Giacca', requestedLocale: 'de', effectiveLocale: 'it', needsTranslation: true, translationState: 'fallback' })
    }
  })

  it('keeps parent ownership and child fallback distinct on the language tier', () => {
    const parent = { ...product, name: 'Giacca padre', translations: [{ language: 'de', description: 'Beschreibung', source: 'manual' }] }
    const child = { ...product, id: 'child', parentId: 'p', name: 'Giacca figlio', translations: [] }
    const resolved = resolveAttributes({ product: child, parent, locale: 'de' })
    // The child's own source answers its title; the parent's German row answers the description.
    expect(resolved.title).toMatchObject({ value: 'Giacca figlio', inheritedFrom: 'child', effectiveLocale: 'it', translationState: 'fallback' })
    expect(resolved.description).toMatchObject({ value: 'Beschreibung', inheritedFrom: 'p', effectiveLocale: 'de' })
  })

  it('honours an authored clear on the language tier over the parent value', () => {
    const parent = { ...product, translations: [{ language: 'de', name: 'Parent', source: 'manual' }] }
    // The authored clear is the KEY's presence in the attributes bag, not an empty column.
    const cleared = { ...product, id: 'c', parentId: 'p', translations: [{ language: 'de', attributes: { title: null }, source: 'manual' }] }
    expect(resolveAttributes({ product: cleared, parent, locale: 'de' }).title.value).toBeNull()
    // POSITIVE CONTROL — with no row at all the child inherits the parent's German.
    const inheriting = { ...product, id: 'c', parentId: 'p', translations: [] }
    expect(resolveAttributes({ product: inheriting, parent, locale: 'de' })).toMatchObject({ title: { value: 'Parent', inheritedFrom: 'p' } })
  })
})
