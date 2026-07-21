/**
 * SCV.3 — Excel round-trip: mode grammar + build→parse fidelity + FBA lock.
 */
import { describe, it, expect } from 'vitest'
import {
  buildSyncControlWorkbook, parseSyncControlWorkbook, normalizeModeCell,
  LISTING_HEADERS, type SCListingExportRow,
} from './sync-control-excel.js'

describe('SCV.3 — normalizeModeCell', () => {
  it('accepts the four modes EN + IT, case-insensitive', () => {
    expect(normalizeModeCell('Follow')).toBe('FOLLOW')
    expect(normalizeModeCell('segui')).toBe('FOLLOW')
    expect(normalizeModeCell('Pinned')).toBe('PINNED')
    expect(normalizeModeCell('bloccato')).toBe('PINNED')
    expect(normalizeModeCell('Paused')).toBe('PAUSED')
    expect(normalizeModeCell('pausa')).toBe('PAUSED')
    expect(normalizeModeCell('Excluded')).toBe('EXCLUDED')
    expect(normalizeModeCell('escluso')).toBe('EXCLUDED')
  })
  it('blank = null (no change); junk = undefined (invalid)', () => {
    expect(normalizeModeCell('')).toBeNull()
    expect(normalizeModeCell('   ')).toBeNull()
    expect(normalizeModeCell(undefined)).toBeNull()
    expect(normalizeModeCell('Amazon-managed')).toBeUndefined()
    expect(normalizeModeCell('banana')).toBeUndefined()
  })
})

describe('SCV.3 — the sheet never carries a pool-write column', () => {
  it('LISTING_HEADERS have no writable pool/quantity column (Pool is read-only context)', () => {
    // The only editable columns are Mode / PinnedQty / Buffer. There is NO
    // "quantity"/"available"/"stock" header the import could write to the pool.
    const editable = LISTING_HEADERS.map((h) => h.toLowerCase())
    expect(editable).not.toContain('quantity')
    expect(editable).not.toContain('available')
    expect(editable).not.toContain('stock')
  })
})

describe('SCV.3 — build → parse round-trip', () => {
  const listings: SCListingExportRow[] = [
    { product: 'Jacket', sku: 'J-L-BLACK', channel: 'EBAY', market: 'EBAY_IT', itemId: '257600000001', lane: 'SHARED', mode: 'Follow', pinnedQty: '', buffer: 2, pool: 40, intended: 38, live: 38, drift: '', locked: '' },
    { product: 'Jacket', sku: 'J-M-RED', channel: 'AMAZON', market: 'IT', itemId: '', lane: 'LISTING', mode: 'Pinned', pinnedQty: 5, buffer: 0, pool: 10, intended: 5, live: 5, drift: '', locked: '' },
    { product: 'Helmet', sku: 'H-XL', channel: 'AMAZON', market: 'DE', itemId: '', lane: 'LISTING', mode: 'Amazon-managed', pinnedQty: '', buffer: 0, pool: '', intended: '', live: '', drift: '', locked: 'FBA' },
  ]
  const routes = [{ location: 'IT-MAIN', type: 'WAREHOUSE', feeds: 'AMAZON:IT, EBAY' }]

  it('preserves keys, mode, buffer, pinnedQty, itemId-as-text, and the FBA lock', async () => {
    const buf = await buildSyncControlWorkbook(listings, routes)
    const { listings: edits, routes: routeEdits } = await parseSyncControlWorkbook(buf)

    expect(edits).toHaveLength(3)
    const j = edits.find((e) => e.sku === 'J-L-BLACK')!
    expect(j).toMatchObject({ channel: 'EBAY', market: 'EBAY_IT', itemId: '257600000001', mode: 'Follow', buffer: 2, locked: false })
    const p = edits.find((e) => e.sku === 'J-M-RED')!
    expect(p).toMatchObject({ mode: 'Pinned', pinnedQty: 5, locked: false })
    const fba = edits.find((e) => e.sku === 'H-XL')!
    expect(fba.locked).toBe(true) // FBA row round-trips as locked → import skips it

    expect(routeEdits).toHaveLength(1)
    expect(routeEdits[0]).toMatchObject({ location: 'IT-MAIN', feeds: ['AMAZON:IT', 'EBAY'] })
  })

  it('a workbook with no Routes sheet still parses listings', async () => {
    const buf = await buildSyncControlWorkbook(listings, [])
    const { listings: edits, routes: routeEdits } = await parseSyncControlWorkbook(buf)
    expect(edits.length).toBe(3)
    expect(routeEdits.length).toBe(0)
  })
})
