import { describe, expect, it } from 'vitest'

import { libraryEntries, lookalikes, pictureKeys, samePhoto, type LibraryRow, type LookalikeRow } from './media-library-identity.js'

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

describe('same picture at two addresses (W4a)', () => {
  // 64-bit aHash (16 hex) and 256-bit dHash (64 hex): the numbers of differing bits are chosen per pair.
  const flip = (hex: string, bits: number) => { const chars = hex.split(''); for (let i = 0; i < bits; i++) chars[i] = chars[i] === '0' ? '1' : '0'; return chars.join('') }
  const A = '0'.repeat(16), D = '0'.repeat(64)
  const flipEnd = (hex: string, bits: number) => flip(hex.split('').reverse().join(''), bits).split('').reverse().join('')
  const pic = (id: string, extra: Partial<LookalikeRow> = {}): LookalikeRow => ({ id, productId: 'root', url: `https://cdn.test/${id}.jpg`, mediaType: 'IMAGE', perceptualHash: A, dhash256: D, ...extra })
  it('a merged row joins the kept photo: one card, the kept one, whatever the address', () => {
    const merged = [pic('ours'), pic('amz', { productId: 'kid1', url: 'https://m.media-amazon.com/images/I/9x.jpg', sameAsImageId: 'ours' })]
    const keys = pictureKeys(merged)
    expect(keys.get('amz')).toBe(keys.get('ours'))
    // Even when the plan still points at the merged row, the kept one is the card.
    expect(libraryEntries(merged, 'root', new Set(['amz'])).map(e => [e.id, e.copies])).toEqual([['ours', ['amz']]])
    expect(samePhoto(merged)('amz', 'ours')).toBe(true)
  })
  it('suggests the same picture (≤ 16) and language versions (17–26); leaves out versions already joined, "not the same" answers, videos and unhashed photos', () => {
    const list = [pic('ours'), pic('amz', { dhash256: flip(D, 16) }), pic('template', { dhash256: flipEnd(D, 20) }), pic('far', { perceptualHash: flip(A, 7) }),
      pic('chart-it', { versionGroupId: 'chart' }), pic('chart-de', { versionGroupId: 'chart' }), pic('video', { mediaType: 'VIDEO' }), pic('bare', { dhash256: null })]
    const entries = list.map(r => ({ id: r.id, copies: [] }))
    const found = lookalikes(list, entries)
    expect(found.get('amz')).toEqual([{ id: 'ours', distance: 16, kind: 'same' }, { id: 'chart-it', distance: 16, kind: 'same' }, { id: 'chart-de', distance: 16, kind: 'same' }])
    // 17–26 bits: the same template with other text — suggested as language versions (W4b), never as the same photo.
    expect(found.get('template')).toEqual([{ id: 'ours', distance: 20, kind: 'versions' }, { id: 'chart-it', distance: 20, kind: 'versions' }, { id: 'chart-de', distance: 20, kind: 'versions' }])
    expect(found.get('far')).toBeUndefined()
    expect(found.get('chart-it')?.map(x => x.id)).not.toContain('chart-de')
    expect(found.has('video') || found.has('bare')).toBe(false)
    // "Not the same", answered on either photo, stops the suggestion both ways.
    const answered = lookalikes([pic('ours', { distinctFromIds: ['amz'] }), pic('amz')], [{ id: 'ours', copies: [] }, { id: 'amz', copies: [] }])
    expect(answered.size).toBe(0)
  })
})
