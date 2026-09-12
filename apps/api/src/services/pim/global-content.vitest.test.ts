import { describe, expect, it } from 'vitest'
import { globalContentLocales } from './global-content.js'

const product = { id: 'p', parentId: null, name: 'Giacca', description: 'Descrizione', bulletPoints: ['Fonte'], keywords: ['moto'], categoryAttributes: {}, variantAttributes: {}, localizedContent: {} }

describe('LX.1 global content table projection', () => {
  it('reads every language present in the table, with the source response slot', () => {
    const result = globalContentLocales({ ...product, translations: [{ language: 'de', name: 'Jacke' }, { language: 'fr', name: 'Veste' }, { language: 'nl', name: 'Jas' }] }, null)
    expect(Object.keys(result)).toEqual(['de', 'fr', 'it', 'nl'])
    expect(result.de.title).toBe('Jacke'); expect(result.fr.title).toBe('Veste'); expect(result.nl.title).toBe('Jas')
    expect(result.it).toEqual({ title: 'Giacca', description: 'Descrizione', bulletPoints: ['Fonte'], keywords: ['moto'] })
  })
  it('does not read legacy JSON or manufacture languages from its keys', () => {
    const input = { ...product, localizedContent: { de: { title: 'OLD' }, it: { title: 'OLD SOURCE' }, es: { title: 'OLD SPANISH' } }, translations: [{ language: 'de', name: 'Neu' }] }
    const before = structuredClone(input)
    const result = globalContentLocales(input, null)
    expect(result.de.title).toBe('Neu'); expect(result.it.title).toBe('Giacca'); expect(result.es).toBeUndefined()
    expect(input).toEqual(before)
  })
  it('retains native-column fallback for missing translations without adding records', () => {
    expect(globalContentLocales(product, null, ['en'])).toEqual({ en: { title: 'Giacca', description: 'Descrizione', bulletPoints: ['Fonte'], keywords: ['moto'] }, it: { title: 'Giacca', description: 'Descrizione', bulletPoints: ['Fonte'], keywords: ['moto'] } })
  })
  it('includes parent table languages and preserves existing variant-native precedence', () => {
    const result = globalContentLocales({ ...product, id: 'child', parentId: 'p', translations: [{ language: 'de', name: 'Kind' }] }, { ...product, translations: [{ language: 'de', name: 'Eltern' }, { language: 'fr', name: 'Parent français' }], localizedContent: { nl: { title: 'Legacy parent' } } })
    expect(result.de.title).toBe('Kind'); expect(result.fr.title).toBe('Giacca'); expect(result.nl).toBeUndefined()
  })
  it('keeps byte-level text, list order and multilingual Unicode from table records', () => {
    const result = globalContentLocales({ ...product, translations: [{ language: 'DE', name: '  Jacke\n', description: '<p>Größe é e\u0301</p>', bulletPoints: ['z', 'a'], keywords: ['eins', 'zwei'] }] }, null)
    expect(result.de).toEqual({ title: '  Jacke\n', description: '<p>Größe é e\u0301</p>', bulletPoints: ['z', 'a'], keywords: ['eins', 'zwei'] })
  })
})
