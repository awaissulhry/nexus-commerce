import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ marketplace: { findFirst: vi.fn(), findMany: vi.fn() } }))
vi.mock('../../db.js', () => ({ default: db }))
import { marketLanguages, languageTag, marketplaceForLanguage } from './market-languages.js'
import { assertInformationLocale } from './information-locale.js'

const rows = [
  { channel: 'AMAZON', code: 'BE', language: 'nl', languages: ['nl', 'fr'] },
  { channel: 'AMAZON', code: 'DE', language: 'de', languages: ['de'] },
  { channel: 'EBAY', code: 'DE', language: 'en', languages: ['en'] },
  { channel: 'AMAZON', code: 'FR', language: 'fr', languages: ['fr'] },
  { channel: 'AMAZON', code: 'UK', language: 'en', languages: ['en'] },
]
beforeEach(() => {
  vi.clearAllMocks()
  db.marketplace.findFirst.mockImplementation(async ({ where }) => rows.find(row => row.channel === where.channel && row.code === where.code) ?? null)
  db.marketplace.findMany.mockResolvedValue(rows.filter(row => row.channel === 'AMAZON'))
})
describe('LX.2 ordered marketplace language authority', () => {
  it('reads by channel and code, preserves Belgium order and never mutates the row', async () => {
    const result = await marketLanguages('amazon', 'be')
    expect(result).toEqual(['nl', 'fr'])
    result.reverse()
    expect(await marketLanguages('AMAZON', 'BE')).toEqual(['nl', 'fr'])
    expect(db.marketplace.findFirst).toHaveBeenCalledWith({ where: { channel: 'AMAZON', code: 'BE' }, select: { languages: true, language: true } })
    expect(await marketLanguages('AMAZON', 'DE')).toEqual(['de'])
    expect(await marketLanguages('EBAY', 'DE')).toEqual(['en'])
  })
  it('uses already-loaded rows without another query and lets arrays override the scalar', () => {
    expect(marketLanguages('AMAZON', 'BE', [{ ...rows[0], language: 'en' }])).toEqual(['nl', 'fr'])
    expect(db.marketplace.findFirst).not.toHaveBeenCalled()
  })
  it('supports old scalar-only inserts without inventing a market language', async () => {
    expect(marketLanguages('AMAZON', 'BE', [{ ...rows[0], languages: [] }])).toEqual(['nl'])
    await expect(marketLanguages('AMAZON', 'ZZ')).rejects.toThrow('AMAZON/ZZ')
  })
  it('uses the UK authority row for the GB alias', async () => {
    expect(await marketLanguages('AMAZON', 'GB')).toEqual(['en'])
  })
  it.each([['de', 'DE', 'de_DE'], ['nl', 'BE', 'nl_BE'], ['fr', 'BE', 'fr_BE'], ['en', 'UK', 'en_GB']])('serializes %s / %s from the supplied language', (language, market, tag) => {
    expect(languageTag(language, market)).toBe(tag)
  })
  it('accepts both Belgian languages and names them when refusing another', async () => {
    const languages = await marketLanguages('AMAZON', 'BE')
    expect(() => assertInformationLocale('AMAZON', 'nl', languages)).not.toThrow()
    expect(() => assertInformationLocale('AMAZON', 'fr', languages)).not.toThrow()
    expect(() => assertInformationLocale('AMAZON', 'de', languages)).toThrow('nl, fr')
    expect(() => languageTag('de-DE', 'DE')).toThrow()
  })
  it('selects a representative market from rows rather than a language preference map', async () => {
    expect(await marketplaceForLanguage('fr')).toBe('FR')
    expect(await marketplaceForLanguage('nl')).toBe('BE')
  })
})
