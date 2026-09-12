/**
 * PES.8 — a cellKey that decodes to a different cell than it encoded would
 * approve an AI value onto a field nobody reviewed. These tests exist for that
 * one failure, so they lean on round-tripping rather than on string shapes.
 */
import { describe, expect, it } from 'vitest'

import { CellKeyError, decodeCellKey, encodeCellKey, isMasterKey, type CellAddress } from './cell-key.js'

const master = (writeField: string, locale: string | null = null): CellAddress => ({
  channel: null,
  marketplace: null,
  aliasId: null,
  locale,
  writeField,
})

describe('encodeCellKey / decodeCellKey', () => {
  it('round-trips every shape a sheet cell can have', () => {
    const cases: CellAddress[] = [
      master('name'),
      master('attr_material'),
      master('description', 'de'),
      { channel: 'AMAZON', marketplace: 'IT', aliasId: null, locale: null, writeField: 'amazon_title' },
      { channel: 'EBAY', marketplace: 'IT', aliasId: '2', locale: null, writeField: 'ebay_title' },
      { channel: 'AMAZON', marketplace: 'DE', aliasId: null, locale: 'de', writeField: 'amazon_description' },
      { channel: 'EBAY', marketplace: 'IT', aliasId: '3', locale: 'it', writeField: 'ebay_description' },
    ]
    for (const addr of cases) {
      expect(decodeCellKey(encodeCellKey(addr))).toEqual(addr)
    }
  })

  it('produces the documented keys', () => {
    expect(encodeCellKey(master('name'))).toBe('master:name')
    expect(encodeCellKey(master('attr_material'))).toBe('master:attr_material')
    expect(
      encodeCellKey({ channel: 'AMAZON', marketplace: 'IT', aliasId: null, locale: null, writeField: 'amazon_title' }),
    ).toBe('AMAZON:IT:amazon_title')
    expect(
      encodeCellKey({ channel: 'EBAY', marketplace: 'IT', aliasId: '2', locale: null, writeField: 'ebay_title' }),
    ).toBe('EBAY:IT:#2:ebay_title')
  })

  it('keeps an alias and a locale distinguishable in the same key', () => {
    // The whole reason the optional segments are sigilled: without them, a
    // two-segment tail could not say which of the two it was.
    const withAlias = encodeCellKey({ channel: 'EBAY', marketplace: 'IT', aliasId: '2', locale: null, writeField: 'ebay_title' })
    const withLocale = encodeCellKey({ channel: 'EBAY', marketplace: 'IT', aliasId: null, locale: '2', writeField: 'ebay_title' })
    expect(withAlias).not.toBe(withLocale)
    expect(decodeCellKey(withAlias).aliasId).toBe('2')
    expect(decodeCellKey(withAlias).locale).toBeNull()
    expect(decodeCellKey(withLocale).locale).toBe('2')
    expect(decodeCellKey(withLocale).aliasId).toBeNull()
  })

  it('refuses to build an ambiguous key rather than emitting one', () => {
    expect(() => encodeCellKey(master('a:b'))).toThrow(CellKeyError)
    expect(() => encodeCellKey(master(''))).toThrow(CellKeyError)
    expect(() =>
      encodeCellKey({ channel: 'AMAZON', marketplace: null, aliasId: null, locale: null, writeField: 'amazon_title' }),
    ).toThrow(CellKeyError)
    expect(() =>
      encodeCellKey({ channel: null, marketplace: 'IT', aliasId: null, locale: null, writeField: 'name' }),
    ).toThrow(CellKeyError)
    expect(() =>
      encodeCellKey({ channel: null, marketplace: null, aliasId: '2', locale: null, writeField: 'name' }),
    ).toThrow(CellKeyError)
  })

  it('refuses to decode something it did not produce', () => {
    expect(() => decodeCellKey('name')).toThrow(CellKeyError)
    expect(() => decodeCellKey('AMAZON:amazon_title')).toThrow(CellKeyError)
    expect(() => decodeCellKey('AMAZON:IT:mystery:amazon_title')).toThrow(CellKeyError)
    expect(() => decodeCellKey('master:2:name')).toThrow(CellKeyError)
  })

  it('carries a real alias id, not a display label', () => {
    // PES.5 ruling #20: ProductListingAlias.label is NOT unique per coordinate
    // (the DB unique is on `position`) and is operator-renameable, so the key
    // holds the id. cuids are long and contain no colon — the format must take
    // one whole and give it back unchanged.
    const aliasId = 'cmr1b1yxl0000s4rcvopsqv42'
    const key = encodeCellKey({
      channel: 'EBAY',
      marketplace: 'IT',
      aliasId,
      locale: null,
      writeField: 'ebay_title',
    })
    expect(key).toBe(`EBAY:IT:#${aliasId}:ebay_title`)
    expect(decodeCellKey(key).aliasId).toBe(aliasId)
  })

  it('treats an absent optional field as absent, not as a violation', () => {
    // A JSON body that simply omitted `aliasId`, or an untyped caller, must not
    // trip the master-scope alias check — `undefined` means no alias.
    const loose = { channel: null, marketplace: null, locale: null, writeField: 'name' } as CellAddress
    expect(encodeCellKey(loose)).toBe('master:name')
    const looseChannel = { channel: 'AMAZON', marketplace: 'IT', writeField: 'amazon_title' } as CellAddress
    expect(encodeCellKey(looseChannel)).toBe('AMAZON:IT:amazon_title')
  })

  it('names the master scope', () => {
    expect(isMasterKey('master:name')).toBe(true)
    expect(isMasterKey('AMAZON:IT:amazon_title')).toBe(false)
  })
})
