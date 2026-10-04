import { describe, expect, it, vi } from 'vitest'

import type { InvalidationEvent } from '@/lib/sync/invalidation-channel'

import { awayTooLong, createLiveCoalescer, liveRefreshNeeded, LIVE_AWAY_MS, LIVE_COALESCE_MS, strongerRefresh, type LiveScope } from './listingValuesLive'

/**
 * Amazon sheet gaps — the one live rule the product sheet and the Matrix share: which events re-read the view, how
 * much, and how a burst collapses into one re-read.
 */
const scope = (known: Record<string, number> = { L1: 4, L2: 7 }): LiveScope => ({
  familyId: 'root', memberIds: new Set(['root', 'v1', 'v2']), knownVersions: new Map(Object.entries(known)),
})

const values = (meta: Record<string, unknown>): InvalidationEvent => ({ type: 'listing.values_changed', id: String(meta.productId ?? ''), meta: { source: 'sse', ...meta } })
const listing = (listingId: string, productId: string, version: number) => ({ listingId, productId, version })

describe('liveRefreshNeeded — listing.values_changed', () => {
  it('another family → none', () => {
    expect(liveRefreshNeeded(values({ productId: 'other-root', listings: [listing('X9', 'other-v', 3)], fields: ['price'] }), scope())).toBe('none')
  })
  it('the writer\'s own echo (every listing already held at that version or newer) → none', () => {
    expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L1', 'v1', 4), listing('L2', 'v2', 6)], fields: ['quantity'] }), scope())).toBe('none')
  })
  it('one listing newer than the view holds → a re-read', () => {
    expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L1', 'v1', 4), listing('L2', 'v2', 8)], fields: ['quantity'] }), scope())).toBe('stock')
  })
  it('a listing the view never read counts as not seen', () => {
    expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L3', 'v2', 1)], fields: ['stockBuffer'] }), scope())).toBe('stock')
  })
  it('only Mode / Qty / Buffer / Sync fields → stock', () => {
    for (const fields of [['quantityMode', 'quantity'], ['stockBuffer', 'quantity'], ['syncState']]) {
      expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L1', 'v1', 5)], fields }), scope())).toBe('stock')
    }
  })
  it('price, ASIN, offer draft, fulfilment, or a stock field mixed with one of them → full', () => {
    for (const fields of [['price'], ['salePrice'], ['externalListingId'], ['offerDraft'], ['offer'], ['fulfilment'], ['fulfilmentSettings'], ['quantity', 'price']]) {
      expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L1', 'v1', 5)], fields }), scope())).toBe('full')
    }
  })
  it('no field list → full (the safe side)', () => {
    expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L1', 'v1', 5)] }), scope())).toBe('full')
  })
  it('a family root the view does not name but a member listing it does → ours', () => {
    expect(liveRefreshNeeded(values({ productId: '', listings: [listing('L1', 'v1', 5)], fields: ['quantity'] }), scope())).toBe('stock')
  })
  it('nothing loaded yet → none', () => {
    expect(liveRefreshNeeded(values({ productId: 'root', listings: [listing('L1', 'v1', 5)], fields: ['price'] }), { ...scope(), familyId: null })).toBe('none')
  })
  it('the field list on the event itself is read when meta has none', () => {
    const e: InvalidationEvent = { type: 'listing.values_changed', id: 'root', fields: ['quantity'], meta: { productId: 'root', listings: [listing('L1', 'v1', 9)] } }
    expect(liveRefreshNeeded(e, scope())).toBe('stock')
  })
})

describe('liveRefreshNeeded — stock moves and publications', () => {
  it('a member\'s inventory.stock_changed → stock; another product\'s → none', () => {
    expect(liveRefreshNeeded({ type: 'inventory.stock_changed', id: 'v2', meta: { source: 'sse', productId: 'v2' } }, scope())).toBe('stock')
    expect(liveRefreshNeeded({ type: 'inventory.stock_changed', id: 'elsewhere', meta: { source: 'sse', productId: 'elsewhere' } }, scope())).toBe('none')
  })
  it('a terminal publication of this family → full; a running one, or another family\'s → none', () => {
    expect(liveRefreshNeeded({ type: 'publication.status_changed', id: 'pub', meta: { productId: 'root', terminal: true, status: 'ACCEPTED' } }, scope())).toBe('full')
    expect(liveRefreshNeeded({ type: 'publication.status_changed', id: 'pub', meta: { productId: 'root', terminal: false, status: 'SUBMITTED' } }, scope())).toBe('none')
    expect(liveRefreshNeeded({ type: 'publication.status_changed', id: 'pub', meta: { productId: 'other-root', terminal: true, status: 'FAILED' } }, scope())).toBe('none')
  })
  it('any other type → none', () => {
    expect(liveRefreshNeeded({ type: 'product.updated', id: 'root' }, scope())).toBe('none')
  })
  it('memberIds may be a plain list', () => {
    expect(liveRefreshNeeded({ type: 'inventory.stock_changed', id: 'v1' }, { ...scope(), memberIds: ['root', 'v1'] })).toBe('stock')
  })
})

describe('coalescing and the window coming back', () => {
  it('strongerRefresh orders none < stock < full', () => {
    expect(strongerRefresh('none', 'stock')).toBe('stock')
    expect(strongerRefresh('full', 'stock')).toBe('full')
    expect(strongerRefresh('stock', 'none')).toBe('stock')
  })
  it('a burst becomes ONE call carrying the strongest decision; none never opens a window', () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const c = createLiveCoalescer((d) => calls.push(d))
      c.push('none')
      vi.advanceTimersByTime(LIVE_COALESCE_MS * 2)
      expect(calls).toEqual([])
      c.push('stock')
      c.push('full')
      c.push('stock')
      vi.advanceTimersByTime(LIVE_COALESCE_MS - 1)
      expect(calls).toEqual([])
      vi.advanceTimersByTime(1)
      expect(calls).toEqual(['full'])
      c.push('stock')
      vi.advanceTimersByTime(LIVE_COALESCE_MS)
      expect(calls).toEqual(['full', 'stock'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('the window opens on the FIRST event: a steady stream cannot postpone the re-read', () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const c = createLiveCoalescer((d) => calls.push(d))
      c.push('stock')
      vi.advanceTimersByTime(300)
      c.push('stock')
      vi.advanceTimersByTime(100)
      expect(calls).toEqual(['stock'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('cancel drops a pending window', () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const c = createLiveCoalescer((d) => calls.push(d))
      c.push('full')
      c.cancel()
      vi.advanceTimersByTime(LIVE_COALESCE_MS * 2)
      expect(calls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('back after more than 60 s hidden → a full re-read; a short look away or a window never hidden → nothing', () => {
    expect(awayTooLong(0, LIVE_AWAY_MS + 1)).toBe(true)
    expect(awayTooLong(0, LIVE_AWAY_MS)).toBe(false)
    expect(awayTooLong(null, 10 * LIVE_AWAY_MS)).toBe(false)
  })
})
