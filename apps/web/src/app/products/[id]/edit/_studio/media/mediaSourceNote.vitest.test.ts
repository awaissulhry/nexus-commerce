import { describe, expect, it } from 'vitest'
import { IMAGE_URLS_NOTE, mediaSourceNote, type MediaRow } from './useMediaCellActions'
import type { StudioRow } from '../sheet/channel/types'

/** Owner 2026-10-05 — one list at a time, the last save wins: the cell says when it shows an old eBay Image URLs list. */
describe('the Product media cell names an old Image URLs list', () => {
  it('says where the list comes from and what a save does', () => {
    expect(mediaSourceNote({ productMediaSource: 'image-urls' })).toBe(IMAGE_URLS_NOTE)
    expect(IMAGE_URLS_NOTE).toBe('From the old Image URLs list. A save in Product media moves it into Product media.')
  })
  it('says nothing when the list is Product media', () => {
    expect(mediaSourceNote({})).toBe('')
  })
  it('the channel sheet row carries the mark to the cell unchanged', () => {
    const row = { id: 'p1', productMediaSource: 'image-urls' } as Pick<StudioRow, 'productMediaSource'> & { id: string }
    const media: MediaRow = row
    expect(mediaSourceNote(media)).toBe(IMAGE_URLS_NOTE)
  })
})
