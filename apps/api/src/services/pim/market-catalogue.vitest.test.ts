import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MARKET_CATALOGUE, marketCatalogueRows } from './market-catalogue.js'

/**
 * A-53 — the catalogue every business starts with. Pure arms; the database arms live in
 * `market-catalogue-backfill.vitest.test.ts` (the migration), `workspace.vitest.test.ts` (creation) and
 * `routes/marketplaces-seed.vitest.test.ts` (the create-only seed route).
 */
const snapshot = JSON.parse(readFileSync(new URL('./market-catalogue.production-2026-09-24.json', import.meta.url), 'utf8')) as { rows: unknown[] }
const key = (m: { channel: string; code: string }) => `${m.channel}:${m.code}`
const euTaxed = MARKET_CATALOGUE.filter(m => (m.channel === 'AMAZON' || m.channel === 'EBAY') && m.region === 'EU')

describe('market catalogue', () => {
  it('equals the 20 rows Xavia Racing carries in production, column for column (the reference, read 2026-09-24)', () => {
    expect(snapshot.rows).toHaveLength(20)
    expect(MARKET_CATALOGUE.map(m => ({ ...m, languages: [...m.languages] }))).toEqual(snapshot.rows)
  })

  it('names each (channel, code) once — the database key it is written under', () => {
    expect(new Set(MARKET_CATALOGUE.map(key)).size).toBe(MARKET_CATALOGUE.length)
  })

  it('gives every market its languages, the first being its legacy `language`', () => {
    for (const m of MARKET_CATALOGUE) {
      expect(m.languages.length, key(m)).toBeGreaterThan(0)
      expect(m.language, key(m)).toBe(m.languages[0])
    }
    expect(MARKET_CATALOGUE.find(m => key(m) === 'AMAZON:BE')?.languages).toEqual(['nl', 'fr'])
  })

  it('carries VAT on every EU Amazon and eBay market — a row without it prices the listing net of VAT', () => {
    expect(euTaxed).toHaveLength(16)
    for (const m of euTaxed) {
      expect(m.taxInclusive, key(m)).toBe(true)
      expect(Number(m.vatRate), key(m)).toBeGreaterThan(0)
    }
    expect(MARKET_CATALOGUE.find(m => key(m) === 'EBAY:IT')).toMatchObject({ vatRate: '22.00', taxInclusive: true })
  })

  it('prices Sweden, Poland and Turkey in their own currencies, not euros', () => {
    const currency = (code: string) => MARKET_CATALOGUE.find(m => m.channel === 'AMAZON' && m.code === code)?.currency
    expect([currency('SE'), currency('PL'), currency('TR')]).toEqual(['SEK', 'PLN', 'TRY'])
  })

  it('holds 19 active markets; Amazon US is the one inactive row', () => {
    expect(MARKET_CATALOGUE.filter(m => !m.isActive).map(key)).toEqual(['AMAZON:US'])
  })

  it('hands every writer a fresh copy — one caller cannot change the next caller\'s languages', () => {
    const first = marketCatalogueRows()
    first[0].languages.push('xx')
    expect(marketCatalogueRows()[0].languages).toEqual(['nl', 'fr'])
    expect(MARKET_CATALOGUE[0].languages).toEqual(['nl', 'fr'])
  })
})
