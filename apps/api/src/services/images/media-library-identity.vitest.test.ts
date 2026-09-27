import { describe, expect, it } from 'vitest'

import { libraryEntries, pictureKeys, samePhoto, type LibraryRow } from './media-library-identity.js'

/** GALE-JACKET's shape (production, 2026-09-28): the root's own photos, and Amazon's pictures stored once per SKU. */
const row = (id: string, productId: string, url: string, extra: Partial<LibraryRow & { versionGroupId: string | null }> = {}) => ({ id, productId, url, contentHash: null, isPrimary: false, versionGroupId: null, ...extra })
const AMZ = 'https://m.media-amazon.com/images/I/81abc.jpg'
const rows = [
  row('kid1-main', 'kid1', AMZ),
  row('kid2-main', 'kid2', 'https://m.media-amazon.com/images/I/81abc._AC_SL1500_.jpg'),
  row('kid3-main', 'kid3', AMZ),
  row('root-cover', 'root', 'https://res.cloudinary.com/x/cover.jpg', { contentHash: 'h-cover' }),
  row('kid1-cover', 'kid1', 'https://res.cloudinary.com/x/cover-copy.jpg', { contentHash: 'h-cover' }),
  row('root-chart', 'root', 'https://res.cloudinary.com/x/chart.jpg'),
]

describe('one picture, one library card', () => {
  it('rows with the same address (Amazon size variants included) or the same bytes are one picture', () => {
    const keys = pictureKeys(rows)
    expect(new Set(['kid1-main', 'kid2-main', 'kid3-main'].map(id => keys.get(id))).size).toBe(1)
    expect(keys.get('root-cover')).toBe(keys.get('kid1-cover'))
    expect(keys.get('root-chart')).not.toBe(keys.get('root-cover'))
  })
  it('shows each picture once, the root\'s own photos first; the card is the row the plan points at, else the root\'s', () => {
    const entries = libraryEntries(rows, 'root', new Set())
    expect(entries.map(e => `${e.id}+${e.copies.length}`)).toEqual(['root-cover+1', 'root-chart+0', 'kid1-main+2'])
    // A plan that points at a variant's copy keeps that row as the card, so the plan and the library agree.
    expect(libraryEntries(rows, 'root', new Set(['kid1-cover'])).find(e => e.copies.includes('root-cover'))?.id).toBe('kid1-cover')
  })
  it('the no-repeat rule treats any copy, and any language version, as the same photo', () => {
    const same = samePhoto([...rows, row('chart-de', 'root', 'https://res.cloudinary.com/x/chart-de.jpg', { versionGroupId: 'chart' }),
      row('chart-it', 'kid1', 'https://res.cloudinary.com/x/chart-it.jpg', { versionGroupId: 'chart' })])
    expect(same('kid1-main', 'kid3-main')).toBe(true)
    expect(same('root-cover', 'kid1-cover')).toBe(true)
    expect(same('chart-de', 'chart-it')).toBe(true)
    expect(same('root-chart', 'root-cover')).toBe(false)
  })
})
