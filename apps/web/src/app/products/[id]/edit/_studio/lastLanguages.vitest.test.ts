import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { languagesKey, languagesPatch, readLastLanguages, writeLastLanguages } from './lastLanguages'

describe('the languages remembered per scope (TOOLBAR REBUILD 2026-09-27)', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('keys Shared once and a channel per market', () => {
    expect(languagesKey('master', 'IT')).toBe('master')
    expect(languagesKey('AMAZON', 'BE')).toBe('AMAZON:BE')
  })

  it('reads back only languages this scope supports, in its order', () => {
    writeLastLanguages('master', ['de', 'it', 'xx'])
    expect(readLastLanguages('master', ['it', 'de', 'en'])).toEqual(['it', 'de'])
    expect(readLastLanguages('master', ['en'])).toBeNull()
    expect(readLastLanguages('AMAZON:BE', ['nl', 'fr'])).toBeNull()
  })

  it('keeps other scopes when one is written', () => {
    writeLastLanguages('master', ['it'])
    writeLastLanguages('AMAZON:BE', ['nl', 'fr'])
    expect(readLastLanguages('master', ['it', 'de'])).toEqual(['it'])
    expect(readLastLanguages('AMAZON:BE', ['nl', 'fr'])).toEqual(['nl', 'fr'])
  })

  it('survives storage that throws', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } })
    expect(() => writeLastLanguages('master', ['it'])).not.toThrow()
    expect(readLastLanguages('master', ['it'])).toBeNull()
  })

  it('writes one language as ?locale= and two or more as ?locales=, never both', () => {
    expect(languagesPatch(['it'])).toEqual({ locale: 'it', locales: undefined })
    expect(languagesPatch(['it', 'de'])).toEqual({ locale: undefined, locales: 'it,de' })
  })
})
