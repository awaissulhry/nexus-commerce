/**
 * Amazon sheet gaps — the sheet's live stock cells, the pure parts: the versions the live rule reads (the rows at event
 * time plus every version a stock write answered with, so the sheet's own echo is `none`), which rows a live read must
 * leave alone, and what it patches.
 */
import { describe, expect, it } from 'vitest'

import { CellSaveTracker } from '@/design-system/grid'

import type { MatrixCells, MatrixRead } from '../../matrix/contract'
import { liveRefreshNeeded } from '../../listingValuesLive'
import { applyStockValue, rememberListingVersions } from './stockCells'
import { applyLiveStockRead, LiveListingVersions, liveRowBusy } from './useLiveStockCells'
import type { ChannelSheetRow } from './types'

function cells(listingId: string, version: number, intended = 12): MatrixCells {
  return {
    listingId, version, listing: null, fulfilment: null,
    sync: { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended, held: intended, buffer: 0, poolAvailable: intended, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false },
    queue: null, price: null, sale: null, writable: { syncMode: true, syncQty: true, syncBuffer: true }, writeBlockedReason: {},
  }
}

function row(n: number): ChannelSheetRow {
  return {
    rowId: `primary:v${n}`, id: `v${n}`, parentId: 'root', isParent: false, aliasId: null,
    listing: { id: `LIVE-DE-${n}`, version: 3, externalListingId: null },
    values: { stock_qty: { value: 12, editable: true, writable: true, writeBlockedReason: null } },
    stock: { key: 'AMAZON:EU', marketKey: 'AMAZON:DE', cells: cells(`LIVE-IT-${n}`, 7), coordinate: null },
  } as unknown as ChannelSheetRow
}

const read = (entries: Array<[string, MatrixCells]>): MatrixRead => ({
  version: 1, productId: 'root', source: 'live', generatedAt: '', coordinates: [], policies: [],
  rows: entries.map(([id, c]) => ({ id, sku: id, role: 'variant', stock: { available: null, uncounted: false, locations: [] }, basePrice: null, status: '', cells: { 'AMAZON:EU': c } })),
})

const event = (listings: Array<{ listingId: string; productId: string; version: number }>) => ({
  type: 'listing.values_changed' as const, id: 'root', meta: { source: 'local', productId: 'root', listings, fields: ['quantityMode', 'quantity'] },
})

describe('LiveListingVersions — what the live rule knows, read when it asks', () => {
  it('follows the rows without a rebuild: a version a write adopted is known at once', () => {
    const rows = [row(1)]
    const versions = new LiveListingVersions(() => rows)
    expect(versions.get('LIVE-DE-1')).toBe(3)
    expect(versions.get('LIVE-IT-1')).toBe(7)
    rows[0].listing!.version = 4
    expect(versions.get('LIVE-DE-1')).toBe(4)
    expect(versions.has('LIVE-FR-1')).toBe(false)
  })
  it('the sheet\'s own EU write echoes as none — even for the EU markets the sheet does not show', () => {
    const rows = [row(1)]
    const versions = new LiveListingVersions(() => rows)
    const scope = { familyId: 'root', memberIds: new Set(['root', 'v1']), knownVersions: versions }
    const moved = [{ listingId: 'LIVE-IT-1', productId: 'v1', version: 8 }, { listingId: 'LIVE-DE-1', productId: 'v1', version: 4 }, { listingId: 'LIVE-FR-1', productId: 'v1', version: 5 }]
    expect(liveRefreshNeeded(event(moved), scope)).toBe('stock')
    rememberListingVersions(moved)
    expect(liveRefreshNeeded(event(moved), scope)).toBe('none')
    // Someone else moved the IT listing past what this sheet wrote: a stock re-read.
    expect(liveRefreshNeeded(event([{ listingId: 'LIVE-IT-1', productId: 'v1', version: 9 }]), scope)).toBe('stock')
  })
})

describe('liveRowBusy — a row the live read leaves alone', () => {
  it('an open editor, a stock edit not settled, or a stock cell still saving', () => {
    const tracker = new CellSaveTracker()
    const a = row(1), b = row(2), c = row(3), d = row(4)
    applyStockValue(b, 'syncQty', 3)
    tracker.set('primary:v3', 'stock_buffer', 'saving')
    const editing = new Set(['primary:v1'])
    expect([a, b, c, d].map((r) => liveRowBusy(r, editing, tracker))).toEqual([true, true, true, false])
    tracker.set('primary:v4', 'stock_qty', 'refused', 'no')
    expect(liveRowBusy(d, editing, tracker)).toBe(false)
  })
})

describe('applyLiveStockRead — only the rows that changed; owes the quiet read for the ones it could not place', () => {
  it('patches a changed idle row, skips a busy one, leaves an equal one, and owes', () => {
    const idle = row(1), busy = row(2), same = row(3)
    const result = applyLiveStockRead([idle, busy, same], read([['v1', cells('LIVE-IT-1', 8, 5)], ['v2', cells('LIVE-IT-2', 8, 5)], ['v3', cells('LIVE-IT-3', 7)]]), (r) => r === busy)
    expect(result.changed).toEqual([idle])
    expect(result.skipped).toEqual([busy])
    expect(result.owe).toBe(true)
    expect(idle.stock!.cells!.sync!.intended).toBe(5)
    expect(idle.values.stock_qty.value).toBe(5)
    expect(busy.stock!.cells!.version).toBe(7)
  })
  it('nothing busy and every row placed: no read owed', () => {
    const r = row(1)
    expect(applyLiveStockRead([r], read([['v1', cells('LIVE-IT-1', 8, 5)]]), () => false).owe).toBe(false)
  })
  it('the read holds another listing for a row: only a full read can place it', () => {
    const r = row(1)
    const result = applyLiveStockRead([r], read([['v1', cells('ANOTHER', 8, 5)]]), () => false)
    expect(result.mismatched).toEqual([r])
    expect(result.owe).toBe(true)
  })
})
