/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing, one list at a time, the last save wins:
 * the eBay "Image URLs" field's store `replaces` the listing's Product media (`_productMediaLocales`). The rule lives in
 * the code-built eBay spec (`ebaySpecFromCache`; the database holds only eBay's aspects), and every writer reads the same
 * store object: the sheet and Claude through the sheet contract (`buildSheetColumns` → `channels[label].store`), the file
 * import through the field catalogue (`cap.channelStore`). Both then write through `channelValueMutation`.
 */
import { describe, expect, it } from 'vitest'
import { applyPlatformMutations, channelValueMutation, channelValuePatch } from './channel-value-mutation.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'
import { buildSheetColumns } from './sheet-columns.service.js'
import type { ChannelStore } from './channel-specs/types.js'

const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] })
const store = spec.fields.find(field => field.key === 'imageUrls')!.channelStore as ChannelStore
const media = { und: { version: 1, items: [{ assetId: 'asset-1' }] } }
const listing = { overrideData: {}, platformAttributes: { subtitle: 'kept', _productMediaLocales: media } }

describe('eBay Image URLs replace the listing\'s Product media', () => {
  it('the code-built spec declares it, and the sheet contract carries the same store', () => {
    expect(store).toEqual({ kind: 'platformAttributes', path: ['imageUrls'], replaces: [['_productMediaLocales']] })
    const coordinate = { channel: 'EBAY' as const, marketplace: 'IT', label: 'eBay · IT', inMarket: true }
    const column = buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
      .columns.find(c => c.channels?.[coordinate.label]?.key === 'imageUrls')!
    expect(column.channels![coordinate.label].store).toEqual(store)
  })

  it('a SET stores the list and removes Product media (sheet, Claude, import)', () => {
    const urls = ['https://example.invalid/a.jpg', 'https://example.invalid/b.jpg']
    const mutation = channelValueMutation(store, ['imageUrls', 'attr_imageUrls'], 'SET', urls)
    expect(mutation.platform).toEqual([{ path: ['imageUrls'], value: urls, remove: false }, { path: ['_productMediaLocales'], value: null, remove: true }])
    expect(applyPlatformMutations(listing.platformAttributes, mutation.platform)).toEqual({ subtitle: 'kept', imageUrls: urls })
    expect(channelValuePatch(listing, store, ['imageUrls'], 'SET', urls).platformAttributes).toEqual({ subtitle: 'kept', imageUrls: urls })
  })

  it('a reset (INHERIT) or a clear removes both lists: the listing shows the shared Product media', () => {
    const withList = { subtitle: 'kept', imageUrls: ['https://example.invalid/a.jpg'], _productMediaLocales: media }
    expect(applyPlatformMutations(withList, channelValueMutation(store, ['imageUrls'], 'INHERIT').platform)).toEqual({ subtitle: 'kept' })
    expect(applyPlatformMutations(withList, channelValueMutation(store, ['imageUrls'], 'CLEAR').platform)).toEqual({ subtitle: 'kept', imageUrls: null })
  })

  it('another field\'s store removes nothing it does not name', () => {
    expect(applyPlatformMutations(listing.platformAttributes, channelValueMutation({ kind: 'platformAttributes', path: ['subtitle'] }, ['subtitle'], 'SET', 'new').platform))
      .toEqual({ subtitle: 'new', _productMediaLocales: media })
  })
})
