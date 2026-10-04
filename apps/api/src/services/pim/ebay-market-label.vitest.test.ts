import { describe, expect, it } from 'vitest'
import { conceptByKey } from '@nexus/shared/attribute-concepts'
import { optionsFor } from './attribute-concepts-rows.js'
import type { DictionaryAttribute } from './family-variations-core.js'
import { ebayMarketLabel, ebayMarketWords } from './ebay-market-label.js'

/**
 * E1b (product sheet consistency, 2026-10-05) — eBay gets a colour or size as the dictionary option's word in the market's
 * language, whichever form is stored: the sheet's code (`black`) or the Variations writer's spelling (`Nero`).
 * The dictionary here is the one a business starts with (the concept's seeded options, labelled in Italian).
 */
const seeded = (key: 'color' | 'size'): DictionaryAttribute => ({
  id: `attr-${key}`, code: key, label: key === 'color' ? 'Color' : 'Size', semanticKey: key, archivedAt: null,
  options: optionsFor(conceptByKey(key)!, 'it').map((o, i) => ({ id: `${key}-${i}`, code: o.code, label: o.label, metadata: o.metadata ?? null,
    synonyms: o.synonyms, sortOrder: o.sortOrder, archivedAt: null })),
})
const dictionary = [seeded('color'), seeded('size')]
const word = (attribute: string, value: string, language: string) => ebayMarketLabel(dictionary, attribute, value, language)

describe('ebayMarketLabel — the market word eBay receives', () => {
  it('a stored code goes out as the market word: black → Nero (IT), Black (UK), Schwarz (DE)', () => {
    expect(word('color', 'black', 'it')).toBe('Nero')
    expect(word('color', 'black', 'en')).toBe('Black')
    expect(word('color', 'black', 'de')).toBe('Schwarz')
  })
  it('the Variations writer\'s spelling names the same option: Nero → Schwarz on DE, and stays Nero on IT', () => {
    expect(word('color', 'Nero', 'de')).toBe('Schwarz')
    expect(word('color', 'Nero', 'it')).toBe('Nero')
    expect(word('color', 'nero ', 'it')).toBe('Nero')
  })
  it('the family\'s axis name finds the attribute too (Colore, Taglia)', () => {
    expect(word('Colore', 'white', 'fr')).toBe('Blanc')
    expect(word('Taglia', 'xs', 'it')).toBe('XS')
  })
  it('a size code with no language label goes out as the dictionary spells it: xs → XS', () => {
    expect(word('size', 'xs', 'it')).toBe('XS')
    expect(word('size', 'xs', 'de')).toBe('XS')
  })
  it('one size goes out in the market\'s words: one_size → Einheitsgröße (DE), Taglia unica (IT)', () => {
    expect(word('size', 'one_size', 'de')).toBe('Einheitsgröße')
    expect(word('size', 'one_size', 'it')).toBe('Taglia unica')
    expect(word('size', 'Taglia unica', 'es')).toBe('Talla única')
  })
  it('a name the dictionary keeps as it is spelled stays: XXXL is not turned into 3XL', () => {
    expect(word('size', 'XXXL', 'it')).toBe('XXXL')
    expect(word('size', '3XL', 'it')).toBe('3XL')
  })
  it('a value or an attribute the dictionary does not know stays as it is', () => {
    expect(word('color', 'Fucsia acceso', 'it')).toBe('Fucsia acceso')
    expect(word('material', 'black', 'it')).toBe('black')
    expect(word('color', '', 'it')).toBe('')
  })
  it('no label for the market language: the stored text stays when it is already the dictionary spelling', () => {
    expect(word('color', 'Nero', 'pl')).toBe('Nero')
    const finish: DictionaryAttribute = { id: 'attr-finish', code: 'finish', label: 'Finish', semanticKey: null, archivedAt: null, options: [
      { id: 'f1', code: 'carbon', label: 'Carbonio', metadata: { labels: { it: 'Carbonio' } }, synonyms: [], sortOrder: 0, archivedAt: null },
    ] }
    expect(ebayMarketLabel([finish], 'finish', 'Carbonio', 'de')).toBe('Carbonio')
    expect(ebayMarketLabel([finish], 'finish', 'carbon', 'it')).toBe('Carbonio')
  })
  it('an option seeded before it had language labels takes the concept\'s label', () => {
    const old: DictionaryAttribute = { ...seeded('color'), options: seeded('color').options.map(o => ({ ...o, metadata: null })) }
    expect(ebayMarketLabel([old], 'color', 'black', 'de')).toBe('Schwarz')
    expect(ebayMarketLabel([old], 'color', 'Nero', 'es')).toBe('Negro')
  })
  it('an option\'s own label wins over the concept\'s', () => {
    const own: DictionaryAttribute = { ...seeded('color'), options: seeded('color').options.map(o => o.code === 'black' ? { ...o, metadata: { labels: { de: 'Tiefschwarz' } } } : o) }
    expect(ebayMarketLabel([own], 'color', 'black', 'de')).toBe('Tiefschwarz')
  })
  it('ebayMarketWords binds one market\'s language', () => {
    const it = ebayMarketWords(dictionary, 'it-IT')
    expect([it('color', 'black'), it('size', 'one_size'), it('size', 'xs')]).toEqual(['Nero', 'Taglia unica', 'XS'])
  })
})
