/**
 * MAP.2 — every imported eBay order names the store it came from.
 *
 * Until 2026-09-16 `processOrder(order, _connectionId)` ignored the store, so eBay orders were saved
 * with `channelConnectionId = NULL` (production: an order from 2026-08-30). A store's order history was
 * then invisible to the profile move guard, which scans linked records.
 */
import { describe, expect, it } from 'vitest'
import { ebayOrderConnectionLink } from './ebay-orders.service.js'

describe('ebayOrderConnectionLink', () => {
  it('links a new order to the store that imported it', () => {
    expect(ebayOrderConnectionLink(undefined, 'store-a')).toEqual({ data: { channelConnectionId: 'store-a' }, conflict: false })
  })

  it('links an existing order that has no store yet', () => {
    expect(ebayOrderConnectionLink(null, 'store-a')).toEqual({ data: { channelConnectionId: 'store-a' }, conflict: false })
  })

  it('leaves an order already linked to the same store unchanged', () => {
    expect(ebayOrderConnectionLink('store-a', 'store-a')).toEqual({ data: {}, conflict: false })
  })

  it('never moves an order that is linked to a different store, and reports it', () => {
    expect(ebayOrderConnectionLink('store-a', 'store-b')).toEqual({ data: {}, conflict: true })
  })
})
