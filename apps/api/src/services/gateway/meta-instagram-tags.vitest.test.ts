/**
 * Meta step 35 (Q9) — the ONE Instagram product-tag judge (a leaf: the tag tools, the gateway and a new post's publish use it):
 * Meta's limits per target, the shape per media type (x / y only on a photo), one spelling, each product once, and the room a
 * post has left (tagging is additive: a product already tagged moves).
 */
import { describe, expect, it } from 'vitest'
import { META_IG_TAG_LIMITS, metaIgCoordinateOk, metaIgProductTagIds, metaIgProductTagsParam, metaIgProductTagsProblem, metaIgTagMax, metaIgTagRoomProblem } from './meta-instagram-tags.js'

const P = (n: number) => `12000000000${String(n).padStart(4, '0')}`

describe('meta-instagram-tags', () => {
  it('writes the one spelling: x and y only on photos', () => {
    expect(metaIgProductTagsParam([{ productId: P(1), x: 0.5, y: 0.8 }], 'image')).toBe(`[{"product_id":"${P(1)}","x":0.5,"y":0.8}]`)
    expect(metaIgProductTagsParam([{ productId: P(1), x: 0.5, y: 0.8 }], 'reel')).toBe(`[{"product_id":"${P(1)}"}]`)
    expect(metaIgProductTagIds(metaIgProductTagsParam([{ productId: P(1) }, { productId: P(2) }], 'video'))).toEqual([P(1), P(2)])
    expect(metaIgProductTagIds('not json')).toEqual([])
  })
  it('judges each target by Meta\'s limits and shape', () => {
    expect(metaIgTagMax('image')).toBe(META_IG_TAG_LIMITS.feedPost)
    expect(metaIgTagMax('carousel-image')).toBe(5)
    expect(metaIgTagMax('reel')).toBe(30)
    const list = (n: number, placed: boolean) => JSON.stringify(Array.from({ length: n }, (_, i) => (placed ? { product_id: P(i), x: 0.1, y: 0.2 } : { product_id: P(i) })))
    expect(metaIgProductTagsProblem(list(20, true), 'image')).toBeNull()
    expect(metaIgProductTagsProblem(list(21, true), 'image')).toMatch(/1 to 20/)
    expect(metaIgProductTagsProblem(list(6, true), 'carousel-image')).toMatch(/1 to 5/)
    expect(metaIgProductTagsProblem(list(30, false), 'reel')).toBeNull()
    expect(metaIgProductTagsProblem(list(2, false), 'image')).toMatch(/needs both places/)
    expect(metaIgProductTagsProblem(list(2, true), 'video')).toMatch(/x and y are for images only/)
    expect(metaIgProductTagsProblem('[]', 'image')).toMatch(/1 to 20/)
    expect(metaIgCoordinateOk(0.12345)).toBe(false)
    expect(metaIgCoordinateOk(1)).toBe(true)
    expect(metaIgCoordinateOk(-0.1)).toBe(false)
  })
  it('counts the room a post has left: added tags count, moved ones do not; a carousel\'s 20; a Reel\'s unknown tags', () => {
    const existing = Array.from({ length: 19 }, (_, i) => P(i))
    expect(metaIgTagRoomProblem('image', [P(0), P(50)], existing)).toBeNull()
    expect(metaIgTagRoomProblem('image', [P(50), P(51)], existing)).toMatch(/21 tags \(19 now, 2 new\)/)
    expect(metaIgTagRoomProblem('carousel-image', [P(1)], [], 19)).toBeNull()
    expect(metaIgTagRoomProblem('carousel-image', [P(1), P(2)], [], 19)).toMatch(/at most 20 on one carousel/)
    expect(metaIgTagRoomProblem('reel', Array.from({ length: 30 }, (_, i) => P(i)), null)).toBeNull()
  })
})
