import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTE_CONCEPTS, conceptByKey, conceptFieldToken, conceptForChannelField, conceptValueCode, customAttributeConcepts, matchConceptValue,
} from './attribute-concepts'
import type { AttributeChannel } from './attributes'

describe('catalogue integrity — the rules in the file header', () => {
  it('has unique concept keys, all lower snake case', () => {
    const keys = ATTRIBUTE_CONCEPTS.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('gives every channel field name to at most ONE concept per channel', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const concept of ATTRIBUTE_CONCEPTS) {
      for (const [channel, names] of Object.entries(concept.bindings) as Array<[AttributeChannel, string[]]>) {
        for (const token of new Set(names.map(conceptFieldToken))) {
          const at = `${channel}:${token}`
          if (owner.has(at) && owner.get(at) !== concept.key) clashes.push(`${at} → ${owner.get(at)} and ${concept.key}`)
          owner.set(at, concept.key)
        }
      }
    }
    expect(clashes).toEqual([])
  })

  it('never lets one spelling stand for two values of the same concept', () => {
    const clashes: string[] = []
    for (const concept of ATTRIBUTE_CONCEPTS) {
      const owner = new Map<string, string>()
      for (const [code, spellings] of Object.entries(concept.valueSynonyms ?? {})) {
        for (const token of new Set([code, ...spellings].map(conceptFieldToken))) {
          if (owner.has(token) && owner.get(token) !== code) clashes.push(`${concept.key}: ${token} → ${owner.get(token)} and ${code}`)
          owner.set(token, code)
        }
      }
    }
    expect(clashes).toEqual([])
  })

  it('never lets one existing code be adopted by two concepts, nor a concept key be another concept’s adopt code', () => {
    const claims = new Map<string, string>()
    for (const concept of ATTRIBUTE_CONCEPTS) for (const code of [concept.key, ...(concept.adoptCodes ?? [])]) {
      expect(claims.get(code) ?? concept.key, `${code} claimed twice`).toBe(concept.key)
      claims.set(code, concept.key)
    }
  })

  it('creates custom attributes only for concepts no master field already holds', () => {
    const custom = customAttributeConcepts()
    expect(custom.every(c => !c.masterField)).toBe(true)
    expect(custom.map(c => c.key)).toContain('color')
    expect(custom.map(c => c.key)).not.toContain('brand')
  })
})

describe('lookups', () => {
  it.each([
    // Localized eBay aspect keys measured in stored listings (§ header): they must land on the concept.
    ['EBAY', 'aspect_Colore', 'color'], ['EBAY', 'aspect_Farbe', 'color'], ['EBAY', 'aspect_Marke', 'brand'],
    ['EBAY', 'aspect_Taglia', 'size'], ['EBAY', 'aspect_Größe', 'size'], ['EBAY', 'aspect_Scollatura', 'neckline'],
    ['EBAY', 'Country/Region of Manufacture', 'country_of_origin'],
    ['AMAZON', 'apparel_size__size', 'size'], ['AMAZON', 'department', 'target_gender'], ['AMAZON', 'fit_type', 'fit'],
    ['SHOPIFY', 'shopify.color-pattern', 'color'], ['ETSY', 'primary_color', 'color'],
  ] as const)('%s %s → %s', (channel, key, concept) => {
    expect(conceptForChannelField(channel, key)?.key).toBe(concept)
  })

  it('links nothing it does not know, and falls back to the label only when the key is unknown', () => {
    expect(conceptForChannelField('AMAZON', 'lifecycle_supply_type')).toBeUndefined()
    expect(conceptForChannelField('EBAY', 'aspect_123', 'Colore')?.key).toBe('color')
    // A binding on one channel is not a binding on another.
    expect(conceptForChannelField('AMAZON', 'aspect_Colore')).toBeUndefined()
  })

  it('maps value spellings to the canonical code, case- and accent-insensitive', () => {
    const color = conceptByKey('color')!
    expect(conceptValueCode(color, 'Nero')).toBe('black')
    expect(conceptValueCode(color, ' schwarz ')).toBe('black')
    expect(conceptValueCode(color, 'Gray')).toBe('grey')
    expect(conceptValueCode(conceptByKey('season')!, 'ete')).toBe('summer')
    expect(conceptValueCode(conceptByKey('size')!, '2XL')).toBe('XXL')
    expect(conceptValueCode(color, 'Chartreuse')).toBeUndefined()
  })
})

describe('matchConceptValue — the auto-match ladder', () => {
  const color = conceptByKey('color')!
  it('matches ignoring case and accents, and returns the option CODE when the label matched', () => {
    expect(matchConceptValue(color, 'black', ['Black', 'Blue'])).toEqual({ to: 'Black', how: 'exact' })
    expect(matchConceptValue(color, 'Nero', ['1', '2'], { 1: 'Nero', 2: 'Rosso' })).toEqual({ to: '1', how: 'exact' })
  })
  it('falls back to the concept synonyms, across languages', () => {
    expect(matchConceptValue(color, 'Nero', ['Black', 'Blue'])).toEqual({ to: 'Black', how: 'synonym' })
    expect(matchConceptValue(color, 'Schwarz', ['10', '11'], { 10: 'Nero', 11: 'Bianco' })).toEqual({ to: '10', how: 'synonym' })
    expect(matchConceptValue(conceptByKey('target_gender')!, 'Uomo', ['mens', 'womens', 'unisex-adult'])).toEqual({ to: 'mens', how: 'synonym' })
  })
  it('never guesses: no concept, or no shared meaning, is no match', () => {
    expect(matchConceptValue(undefined, 'Nero', ['Black'])).toBeNull()
    expect(matchConceptValue(color, 'Chartreuse', ['Black', 'Blue'])).toBeNull()
    expect(matchConceptValue(color, '', ['Black'])).toBeNull()
  })
})
