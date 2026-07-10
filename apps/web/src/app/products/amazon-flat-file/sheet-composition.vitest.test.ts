import { describe, it, expect } from 'vitest'
import {
  sheetCompositionKey, serializeComposition, parseComposition,
  compositionMatchesPrimary, compositionStorageType,
} from './sheet-composition'

describe('sheetCompositionKey', () => {
  it('scopes per marketplace, uppercased, with a family suffix like rowStorageKey', () => {
    expect(sheetCompositionKey('it')).toBe('ff-sheettypes-IT')
    expect(sheetCompositionKey('DE', 'fam-1')).toBe('ff-sheettypes-DE-family-fam-1')
    expect(sheetCompositionKey('DE', null)).toBe('ff-sheettypes-DE')
  })
})

describe('serializeComposition', () => {
  it('stores composites, clears singles (null)', () => {
    expect(serializeComposition('JACKET+PANTS')).toBe('JACKET+PANTS')
    expect(serializeComposition('jacket+pants')).toBe('JACKET+PANTS')
    expect(serializeComposition('JACKET')).toBeNull()
    expect(serializeComposition('')).toBeNull()
  })
})

describe('parseComposition', () => {
  it('round-trips the write-side composite and rejects non-composites', () => {
    expect(parseComposition('JACKET+PANTS')).toEqual(['JACKET', 'PANTS'])
    expect(parseComposition('jacket + pants')).toEqual(['JACKET', 'PANTS'])
    expect(parseComposition('JACKET')).toBeNull()
    expect(parseComposition('JACKET+')).toBeNull()      // one real member
    expect(parseComposition('JACKET+JACKET')).toBeNull() // dedup → one member
    expect(parseComposition(null)).toBeNull()
    expect(parseComposition('')).toBeNull()
  })
})

describe('compositionMatchesPrimary', () => {
  it('only a member primary restores the composite', () => {
    expect(compositionMatchesPrimary(['JACKET', 'PANTS'], 'jacket')).toBe(true)
    expect(compositionMatchesPrimary(['JACKET', 'PANTS'], 'PANTS')).toBe(true)
    expect(compositionMatchesPrimary(['JACKET', 'PANTS'], 'SHIRT')).toBe(false)
  })
})

describe('compositionStorageType', () => {
  it('matches the write-side computeStorageType exactly (sorted + joined)', () => {
    // Mirror of the page's computeStorageType for multi-type rows:
    const computeStorageTypeMirror = (types: string[]) => [...new Set(types)].sort().join('+')
    expect(compositionStorageType(['PANTS', 'JACKET'])).toBe('JACKET+PANTS')
    expect(compositionStorageType(['PANTS', 'JACKET'])).toBe(computeStorageTypeMirror(['PANTS', 'JACKET']))
    expect(compositionStorageType(['b', 'a', 'c'])).toBe('A+B+C')
  })
})
