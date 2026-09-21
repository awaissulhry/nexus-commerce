/**
 * P4.6d — listing content and images on Etsy.
 *
 * The rules checked here are Etsy's own, copied from its OpenAPI document's field descriptions
 * (read 2026-09-21), not invented. The case that carries the slice is the last describe block:
 * `state` is not a content field, because on a sold-out listing it is also a stock write and a
 * charge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ sends: [] as Array<Record<string, unknown>> }))
vi.mock('./write-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./write-client.js')>()),
  etsyWriter: vi.fn(async () => ({
    shopId: '42',
    send: vi.fn(async (input: Record<string, unknown>) => { h.sends.push(input); return { listing_image_id: 555 } }),
  })),
}))

import {
  deleteEtsyListingImage, setEtsyListingState, updateEtsyListingContent, uploadEtsyListingImage,
} from './listing-write.service.js'
import { encodeEtsyForm } from './write-client.js'
import { EtsyListingContentError, etsyListingContentFields, etsyListingStateFields } from './listing-content.js'

beforeEach(() => { h.sends = [] })
afterEach(() => { vi.clearAllMocks() })

const base = { accountId: 'etsy-1', listingId: 7 }

describe('P4.6d — encodeEtsyForm', () => {
  it('an array becomes repeated keys, which is what OpenAPI declares for a form body', () => {
    expect(encodeEtsyForm({ tags: ['one', 'two'] })).toBe('tags=one&tags=two')
    expect(encodeEtsyForm({ image_ids: [9, 4] })).toBe('image_ids=9&image_ids=4')
  })
  it('🔴 undefined is LEFT OUT and null is SENT EMPTY — different instructions on a PATCH', () => {
    // "do not touch this field" vs "clear this field". Collapsing them is how a partial update
    // quietly blanks something nobody asked it to.
    expect(encodeEtsyForm({ title: undefined, description: null })).toBe('description=')
  })
  it('an EMPTY array is still sent — "this listing now has no tags" is a real instruction', () => {
    expect(encodeEtsyForm({ tags: [] })).toBe('tags=')
  })
  it('values are escaped, so a title cannot break out of the body', () => {
    expect(encodeEtsyForm({ title: 'a&b=c d' })).toBe('title=a%26b%3Dc+d')
  })
})

describe('P4.6d — Etsy\'s published text rules', () => {
  it('a plain title, tags and materials pass', () => {
    expect(etsyListingContentFields({ title: 'Blue Ceramic Mug', tags: ['mug', 'hand made'], materials: ['ceramic'] }))
      .toEqual({ title: 'Blue Ceramic Mug', tags: ['mug', 'hand made'], materials: ['ceramic'] })
  })
  it.each(['$', '€', '£', '¥', '`', '^'])('the character %p is refused in a title, and NAMED', (char) => {
    expect(() => etsyListingContentFields({ title: `Mug ${char} Nice` }))
      .toThrow(`Etsy does not allow the character «${char}» in a title; nothing was sent.`)
  })
  it('🔴 a CURRENCY SYMBOL is refused in an Etsy title — "$19.99 Mug" cannot be sent', () => {
    // Worth its own case because it is the surprise. Etsy's set allows \\p{Sm} (MATHEMATICAL
    // symbols: < > = + ~ |) and not \\p{Sc} (CURRENCY symbols: $ € £ ¥), which reads backwards
    // from what a seller expects — a price in a title is an ordinary thing to want.
    expect(() => etsyListingContentFields({ title: '$19.99 Ceramic Mug' })).toThrow('«$»')
    expect(etsyListingContentFields({ title: '19.99 EUR Ceramic Mug' }).title).toBe('19.99 EUR Ceramic Mug')
  })
  it.each(['<', '>', '=', '+', '~', '|', '#', '@', '!', '?', '/', '*'])('the character %p IS allowed in a title', (char) => {
    // Written down because a later "tidy-up" that tightens this regex would break real titles.
    // These are punctuation and mathematical symbols, which Etsy's set includes.
    expect(etsyListingContentFields({ title: `Mug ${char} Nice` }).title).toBe(`Mug ${char} Nice`)
  })
  it('🔴 %, :, & and + are allowed ONCE — a second one is refused, with the count', () => {
    expect(etsyListingContentFields({ title: '50% off Mug' }).title).toBe('50% off Mug')
    expect(() => etsyListingContentFields({ title: '50% off & 20% more' }))
      .toThrow('Etsy allows the character «%» only once in a title, and this one has 2; nothing was sent.')
  })
  it('™ © and ® are allowed, because Etsy says so', () => {
    expect(etsyListingContentFields({ title: 'Mug™ ©® Ltd' }).title).toBe('Mug™ ©® Ltd')
  })
  it('a tag may not contain punctuation, but a hyphen and an apostrophe are fine', () => {
    expect(etsyListingContentFields({ tags: ["hand-made", "potter's"] }).tags).toEqual(["hand-made", "potter's"])
    expect(() => etsyListingContentFields({ tags: ['hand.made'] })).toThrow('in a tag')
  })
  it('a material may not contain a hyphen — its rule is stricter than a tag\'s', () => {
    expect(() => etsyListingContentFields({ materials: ['hand-made'] })).toThrow('in a material')
    expect(etsyListingContentFields({ materials: ['fine bone china 2'] }).materials).toEqual(['fine bone china 2'])
  })
  it('an empty title is refused rather than sent', () => {
    expect(() => etsyListingContentFields({ title: '   ' })).toThrow('cannot be empty')
  })
  it('a title is trimmed but never TRUNCATED — a half title is a change nobody made', () => {
    expect(etsyListingContentFields({ title: '  Mug  ' }).title).toBe('Mug')
  })
  it('null clears tags and materials; undefined leaves them alone', () => {
    expect(etsyListingContentFields({ tags: null })).toEqual({ tags: null })
    expect(() => etsyListingContentFields({})).toThrow('There is nothing to change')
  })
  it('a description has no character rule, because Etsy publishes none', () => {
    expect(etsyListingContentFields({ description: 'Price: $9 <b>50% off</b> & more' }).description)
      .toBe('Price: $9 <b>50% off</b> & more')
  })
})

describe('P4.6d — image order', () => {
  it('20 ids is fine, 21 is refused with the count', () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(etsyListingContentFields({ imageIds: ids }).image_ids).toEqual(ids)
    expect(() => etsyListingContentFields({ imageIds: [...ids, 21] }))
      .toThrow('Etsy allows at most 20 images on a listing, and this order has 21; nothing was sent.')
  })
  it('a repeated image is refused — an order with a duplicate is not an order', () => {
    expect(() => etsyListingContentFields({ imageIds: [1, 2, 1] })).toThrow('appears twice')
  })
  it.each([[0], [-1], [1.5]])('an image id of %p is refused', (id) => {
    expect(() => etsyListingContentFields({ imageIds: [id] })).toThrow('positive whole number')
  })
})

describe('P4.6d — what actually goes to Etsy', () => {
  it('a content change is a form-encoded PATCH on the shop path', async () => {
    await updateEtsyListingContent({ ...base, content: { title: 'Mug', tags: ['a', 'b'] } })
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]).toMatchObject({
      path: '/shops/42/listings/7', method: 'PATCH', kind: 'write',
      form: { title: 'Mug', tags: ['a', 'b'] },
      operation: 'PATCH /shops/:id/listings/:id',
    })
    expect(h.sends[0].body).toBeUndefined()   // never JSON
  })
  it('an image upload is multipart, with the file name Etsy is given', async () => {
    const result = await uploadEtsyListingImage({ ...base, image: { bytes: new Uint8Array([1, 2]), fileName: 'mug.jpg', rank: 1, altText: 'A mug' } })
    expect(result).toEqual({ listing_image_id: 555 })
    const sent = h.sends[0]
    expect(sent).toMatchObject({ path: '/shops/42/listings/7/images', method: 'POST', kind: 'write' })
    const form = sent.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect((form.get('image') as File).name).toBe('mug.jpg')
    expect(form.get('rank')).toBe('1')
    expect(form.get('alt_text')).toBe('A mug')
    expect(form.get('overwrite')).toBeNull()   // not sent when not asked for
  })
  it('alt text over 500 characters is refused, not trimmed', async () => {
    await expect(uploadEtsyListingImage({ ...base, image: { bytes: new Uint8Array([1]), fileName: 'a.jpg', altText: 'x'.repeat(501) } }))
      .rejects.toThrow('Etsy allows 500 characters of alt text and this has 501; nothing was sent.')
    expect(h.sends).toEqual([])
  })
  it('deleting an image is a DELETE with no body', async () => {
    await deleteEtsyListingImage({ ...base, imageId: 555 })
    expect(h.sends[0]).toMatchObject({ path: '/shops/42/listings/7/images/555', method: 'DELETE' })
    expect(h.sends[0].body).toBeUndefined()
  })
  it.each(['0', 'abc', '-1'])('a listing id of %p never reaches a URL', async (id) => {
    await expect(updateEtsyListingContent({ accountId: 'etsy-1', listingId: id, content: { title: 'Mug' } }))
      .rejects.toThrow('That is not an Etsy listing id; nothing was sent.')
    expect(h.sends).toEqual([])
  })
})

describe('P4.6d — 🔴 state is NOT a content field', () => {
  it('making a listing active needs an explicit yes, because Etsy may reset the stock and charge', () => {
    // Etsy's own words: "Setting a sold_out listing to active will update the quantity to 1 and
    // renew the listing on etsy.com." A quantity write past the resolver, and a charge.
    expect(() => etsyListingStateFields({ state: 'active' }))
      .toThrow('Making an Etsy listing active can set its quantity to 1 and charge a renewal, so it needs an explicit yes; nothing was sent.')
    expect(etsyListingStateFields({ state: 'active', acceptRenewalAndQuantityReset: true })).toEqual({ state: 'active' })
  })
  it('hiding a listing needs no such yes — it costs nothing and resets nothing', () => {
    expect(etsyListingStateFields({ state: 'inactive' })).toEqual({ state: 'inactive' })
  })
  it('🔴 state cannot be smuggled in through the content path', async () => {
    // The type forbids it; this proves the RUNTIME does too, so a caller casting through `any`
    // cannot publish and renew a listing while believing it edited a title.
    await expect(updateEtsyListingContent({ ...base, content: { state: 'active' } as never }))
      .rejects.toThrow('There is nothing to change on this Etsy listing; nothing was sent.')
    expect(h.sends).toEqual([])
  })
  it('a state change is its own ledger operation, so the two are told apart afterwards', async () => {
    await setEtsyListingState({ ...base, change: { state: 'inactive' } })
    expect(h.sends[0]).toMatchObject({ form: { state: 'inactive' }, operation: 'PATCH /shops/:id/listings/:id (state)' })
  })
  it('the content error type is the one callers can catch', () => {
    expect(() => etsyListingStateFields({ state: 'active' })).toThrow(EtsyListingContentError)
  })
})
