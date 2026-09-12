/**
 * PES.7 — the per-record image read for PES.4's drawer.
 * The load-bearing test is inheritance: a child with no images of its own is not a child with no
 * images, and saying so would raise a false alarm on every SKU in a family.
 */
import { describe, expect, it } from 'vitest'

import { pickFaceImage, resolveRecordImages, type ProductImageRow } from './recordImages'

const img = (p: Partial<ProductImageRow> & { id: string }): ProductImageRow => ({
  url: `https://cdn/${p.id}.jpg`, alt: null, type: 'ALT', sortOrder: 0, isPrimary: false, ...p,
})

describe('pickFaceImage — one rule, written down once', () => {
  it('the operator’s explicit hero always wins', () => {
    const rows = [img({ id: 'a', type: 'MAIN', sortOrder: 0 }), img({ id: 'b', isPrimary: true, sortOrder: 5 })]
    expect(pickFaceImage(rows)?.id).toBe('b')
  })

  it('falls to type MAIN when nothing is pinned', () => {
    expect(pickFaceImage([img({ id: 'a', sortOrder: 3 }), img({ id: 'b', type: 'MAIN', sortOrder: 9 })])?.id).toBe('b')
  })

  it('otherwise the first by sort order, not the first in the array', () => {
    expect(pickFaceImage([img({ id: 'a', sortOrder: 7 }), img({ id: 'b', sortOrder: 2 })])?.id).toBe('b')
  })

  it('never picks a video as the face', () => {
    expect(pickFaceImage([img({ id: 'v', mediaType: 'VIDEO', type: 'MAIN' })])).toBeNull()
  })

  it('is null on an empty gallery rather than throwing', () => {
    expect(pickFaceImage([])).toBeNull()
  })
})

describe('🔴 resolveRecordImages — a child with none of its own is not a child with none', () => {
  const parent = [img({ id: 'p1', type: 'MAIN' }), img({ id: 'p2', sortOrder: 1 })]

  it('shows the parent’s gallery, marked inherited, when the record has none', () => {
    // Measured on GALE-JACKET: 24 images on the parent, 0 on all 20 children.
    const r = resolveRecordImages({ ownRows: [], parentRows: parent, parentLabel: 'GALE-JACKET' })
    expect(r.images).toHaveLength(2)
    expect(r.images.every((i) => i.inherited)).toBe(true)
    expect(r.inheritedFrom).toBe('GALE-JACKET')
  })

  it('shows the record’s OWN gallery when it has one, unmixed', () => {
    // A half-inherited strip cannot be read, so own images win outright rather than merging.
    const r = resolveRecordImages({ ownRows: [img({ id: 'c1' })], parentRows: parent })
    expect(r.images.map((i) => i.id)).toEqual(['c1'])
    expect(r.inheritedFrom).toBeNull()
    expect(r.images[0].inherited).toBeUndefined()
  })

  it('is genuinely empty only when neither has anything — and does NOT claim inheritance', () => {
    const r = resolveRecordImages({ ownRows: [], parentRows: [] })
    expect(r.images).toEqual([])
    expect(r.inheritedFrom).toBeNull()
  })

  it('names the face within an inherited gallery too', () => {
    const r = resolveRecordImages({ ownRows: [], parentRows: parent })
    expect(r.images.find((i) => i.isMain)?.id).toBe('p1')
  })

  it('orders by sortOrder so the strip reads as the gallery does', () => {
    const jumbled = [img({ id: 'b', sortOrder: 2 }), img({ id: 'a', sortOrder: 1 })]
    expect(resolveRecordImages({ ownRows: jumbled }).images.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('leaves videos out of a picture strip', () => {
    const r = resolveRecordImages({ ownRows: [img({ id: 'i' }), img({ id: 'v', mediaType: 'VIDEO' })] })
    expect(r.images.map((i) => i.id)).toEqual(['i'])
  })
})
