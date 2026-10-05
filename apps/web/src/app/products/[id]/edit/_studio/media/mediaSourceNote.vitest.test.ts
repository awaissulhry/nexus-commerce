import { describe, expect, it } from 'vitest'
import { IMAGE_URLS_NOTE, mediaSourceNote, type MediaRow } from './useMediaCellActions'
import type { StudioRow } from '../sheet/channel/types'

/**
 * Owner 2026-10-05 — one list at a time, the last save wins: the cell says when it shows an eBay Image URLs list, and
 * (review 2026-10-05) how many of its photos are outside the media library — only a save in Product media adds them.
 */
const photo = (id: string) => ({ id, type: 'IMAGE', preview: `https://cdn.test/${id}.jpg`, alt: '' })
describe('the Product media cell names an Image URLs list', () => {
  it('every photo in the media library: a save moves the list into Product media', () => {
    expect(mediaSourceNote({ productMediaSource: 'image-urls', productMedia: [photo('img-a'), photo('img-b')] })).toBe(IMAGE_URLS_NOTE)
    expect(IMAGE_URLS_NOTE).toBe('From the Image URLs list. A save in Product media moves it into Product media.')
  })
  it('counts the photos outside the media library (the server\'s `url:` ids)', () => {
    expect(mediaSourceNote({ productMediaSource: 'image-urls', productMedia: [photo('url:aaa'), photo('img-a'), photo('url:bbb')] }))
      .toBe('From the Image URLs list. 2 photos are not in the media library. Save the list in Product media to add them.')
    expect(mediaSourceNote({ productMediaSource: 'image-urls', productMedia: [photo('img-a'), photo('url:aaa')] }))
      .toBe('From the Image URLs list. 1 photo is not in the media library. Save the list in Product media to add it.')
  })
  it('says nothing when the list is Product media, even with an id that looks like an address', () => {
    expect(mediaSourceNote({})).toBe('')
    expect(mediaSourceNote({ productMedia: [photo('url:aaa')] })).toBe('')
  })
  it('the channel sheet row carries the mark to the cell unchanged', () => {
    const row = { id: 'p1', productMediaSource: 'image-urls', productMedia: [photo('url:aaa')] } as Pick<StudioRow, 'productMediaSource' | 'productMedia'> & { id: string }
    const media: MediaRow = row
    expect(mediaSourceNote(media)).toContain('1 photo is not in the media library')
  })
})
