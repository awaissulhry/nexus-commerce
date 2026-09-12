/**
 * D7 — the rules that keep a translation draft from landing in the wrong place.
 *
 * Every one of these is a routing decision. A translation written to the master column, or a
 * German draft compared against the Italian master, fails silently and looks like a working
 * feature — which is why they are pinned here rather than left to the apply path to discover.
 */
import { describe, expect, it } from 'vitest'

import { isDraftableField, isTranslationDraft } from './draft.service.js'
import { decodeCellKey, encodeCellKey } from './cell-key.js'

describe('isTranslationDraft', () => {
  it('is a translation only on the MASTER scope with a locale', () => {
    const a = (channel: string | null, locale: string | null) => ({ channel, locale })
    expect(isTranslationDraft(a(null, 'de'))).toBe(true)
    expect(isTranslationDraft(a(null, null))).toBe(false)
    // A channel coordinate has its own per-coordinate content; ProductTranslation is master-only,
    // so routing this to the translation row would overwrite a different cell entirely.
    expect(isTranslationDraft(a('AMAZON', 'de'))).toBe(false)
  })
})

describe('isDraftableField with a locale', () => {
  it('allows exactly the four keys ProductTranslation stores', () => {
    for (const f of ['title', 'name', 'description', 'bulletPoints', 'keywords']) {
      expect(isDraftableField(f, 'de')).toBe(true)
    }
  })

  it('refuses an attribute in a locale run — attributes have no per-locale storage', () => {
    // Drafting one would produce a value with no address to apply to: the exact class of bug the
    // attr_* marketplace-context failure was.
    expect(isDraftableField('attr_material', 'de')).toBe(false)
    expect(isDraftableField('attr_color', 'de')).toBe(false)
  })

  it('refuses a channel field in a locale run', () => {
    expect(isDraftableField('amazon_title', 'de')).toBe(false)
    expect(isDraftableField('ebay_description', 'de')).toBe(false)
  })

  it('still allows master columns and attributes when there is NO locale', () => {
    expect(isDraftableField('attr_material')).toBe(true)
    expect(isDraftableField('description')).toBe(true)
    expect(isDraftableField('amazon_title')).toBe(true)
    // `title` is not a Product column — it only exists per-locale.
    expect(isDraftableField('title')).toBe(false)
  })
})

describe('locale round-trips through the cell key', () => {
  it('keeps a per-locale master cell distinct from the master cell itself', () => {
    const master = { channel: null, marketplace: null, aliasId: null, locale: null, writeField: 'description' }
    const german = { ...master, locale: 'de' }
    expect(encodeCellKey(master)).toBe('master:description')
    expect(encodeCellKey(german)).toBe('master:@de:description')
    // Distinct keys mean the unique index cannot collapse a translation onto its master, which
    // would make one supersede the other on the next run.
    expect(encodeCellKey(master)).not.toBe(encodeCellKey(german))
    expect(decodeCellKey(encodeCellKey(german))).toEqual(german)
  })

  it('keeps two target locales distinct', () => {
    const de = { channel: null, marketplace: null, aliasId: null, locale: 'de', writeField: 'name' }
    const fr = { ...de, locale: 'fr' }
    expect(encodeCellKey(de)).not.toBe(encodeCellKey(fr))
  })
})
