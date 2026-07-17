/**
 * E2 — membership upsert (import/save ingest for already-live shared listings).
 * DB injected as a mock, mirroring the shared-push service's test pattern.
 */
import { describe, it, expect } from 'vitest'
import { upsertSharedMembershipsFromRows } from './ebay-shared-membership-upsert.service.js'

function mockDb(existing: Array<{ itemId: string; sku: string }> = [], products: Array<{ id: string; sku: string }> = []) {
  const upserts: Array<{ where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }> = []
  return {
    db: {
      sharedListingMembership: {
        findMany: async () => existing,
        upsert: async (args: never) => { upserts.push(args); return {} },
      },
      product: { findMany: async () => products },
    },
    upserts,
  }
}

const PARENT = { sku: 'P1', parentage: 'parent', _isParent: true, shared_sku_listing: true, variation_theme: 'Taglia' }
const CHILD = (sku: string, itemId: string, extra: Record<string, unknown> = {}) => ({
  sku, parentage: 'child', parent_sku: 'P1', it_item_id: itemId,
  aspect_Taglia: 'M', aspect_taglia: 'M', it_price: '49,90', _productId: 'prod-1', ...extra,
})

describe('upsertSharedMembershipsFromRows', () => {
  it('upserts children of a shared family by (marketplace,itemId,sku), never touching eBay', async () => {
    const { db, upserts } = mockDb()
    const res = await upsertSharedMembershipsFromRows([PARENT, CHILD('V-1', '111'), CHILD('V-1', '222', { parent_sku: 'P1' })], 'IT', db as never)
    expect(res.created).toBe(2) // same SKU under two ItemIDs — the owner's model
    expect(res.updated).toBe(0)
    expect(upserts).toHaveLength(2)
    const first = upserts[0]
    expect(first.where).toEqual({ marketplace_itemId_sku: { marketplace: 'IT', itemId: '111', sku: 'V-1' } })
    expect(first.create).toMatchObject({
      marketplace: 'IT', itemId: '111', sku: 'V-1', parentSku: 'P1',
      productId: 'prod-1', variationSpecifics: { Taglia: 'M' }, status: 'ACTIVE',
    })
    expect(String(first.create.price)).toBe('49.9') // it_price EU comma parsed
  })

  it('skips children without a live ItemID (publish creates those) and non-shared families', async () => {
    const { db, upserts } = mockDb()
    const nonSharedParent = { sku: 'NP', parentage: 'parent', shared_sku_listing: false }
    const res = await upsertSharedMembershipsFromRows(
      [PARENT, CHILD('V-2', ''), nonSharedParent, { sku: 'X-1', parentage: 'child', parent_sku: 'NP', it_item_id: '999' }],
      'IT',
      db as never,
    )
    expect(upserts).toHaveLength(0)
    expect(res.created).toBe(0)
    expect(res.skipped).toEqual([{ sku: 'V-2', reason: 'no live ItemID on IT — publish creates the membership' }])
  })

  it('resolves productId by SKU lookup when the row has none, and counts updates honestly', async () => {
    const { db, upserts } = mockDb([{ itemId: '111', sku: 'V-3' }], [{ id: 'prod-77', sku: 'V-3' }])
    const res = await upsertSharedMembershipsFromRows(
      [PARENT, CHILD('V-3', '111', { _productId: undefined })],
      'it',
      db as never,
    )
    expect(res.updated).toBe(1)
    expect(res.created).toBe(0)
    expect(upserts[0].update).toMatchObject({ productId: 'prod-77' })
  })

  it('treats synthesized _shared rows (read-back edits) as members even without their parent row', async () => {
    const { db, upserts } = mockDb()
    const res = await upsertSharedMembershipsFromRows(
      [{ sku: 'V-4', parentage: 'child', parent_sku: 'OTHER-P', _shared: true, it_item_id: '333', _productId: 'p9' }],
      'IT',
      db as never,
    )
    expect(res.created).toBe(1)
    expect(upserts[0].create).toMatchObject({ parentSku: 'OTHER-P', itemId: '333' })
  })
})

describe('normalizeEbaySharedFlags', () => {
  it('coerces text booleans in place; blanks and real booleans untouched', async () => {
    const { normalizeEbaySharedFlags } = await import('./ebay-shared-membership-upsert.service.js')
    const rows: Array<Record<string, unknown>> = [
      { sku: 'A', shared_sku_listing: 'TRUE', best_offer_enabled: 'FALSE' },
      { sku: 'B', shared_sku_listing: 'Sì', best_offer_enabled: 1 },
      { sku: 'C', shared_sku_listing: '', best_offer_enabled: true },
      { sku: 'D', shared_sku_listing: 'vero' },
      { sku: 'E', shared_sku_listing: false },
    ]
    normalizeEbaySharedFlags(rows)
    expect(rows[0].shared_sku_listing).toBe(true)
    expect(rows[0].best_offer_enabled).toBe(false)
    expect(rows[1].shared_sku_listing).toBe(true)
    expect(rows[1].best_offer_enabled).toBe(true)
    expect(rows[2].shared_sku_listing).toBe('') // blank = no value, not false
    expect(rows[2].best_offer_enabled).toBe(true)
    expect(rows[3].shared_sku_listing).toBe(true)
    expect(rows[4].shared_sku_listing).toBe(false)
  })
})

describe('round-trip integrity — snapshot persisted on upsert', () => {
  it('stores the full row (minus _internal keys) + counts pool-governed qty edits', async () => {
    const { upsertSharedMembershipsFromRows } = await import('./ebay-shared-membership-upsert.service.js')
    const upserts: any[] = []
    const db = {
      sharedListingMembership: {
        findMany: async () => [],
        upsert: async (args: any) => { upserts.push(args); return args.create },
      },
      product: { findMany: async () => [] },
    }
    const res = await upsertSharedMembershipsFromRows(
      [
        { sku: 'P1', parentage: 'parent', shared_sku_listing: true },
        {
          sku: 'V1', parentage: 'child', parent_sku: 'P1', it_item_id: '111',
          it_price: '105', it_qty: '7', condition: 'NEW_WITH_TAGS', brand: 'XAVIA',
          aspect_Taglia: 'M', _rowId: 'internal', _dirty: true, _productId: 'pid-1',
        },
      ],
      'it',
      db as never,
    )
    expect(res.created).toBe(1)
    expect(res.qtyPoolGoverned).toBe(1) // it_qty was set — pool governs, counted not silent
    const snap = upserts[0].create.flatFileSnapshot
    expect(snap.condition).toBe('NEW_WITH_TAGS')
    expect(snap.brand).toBe('XAVIA')
    expect(snap.it_price).toBe('105')
    expect(snap._rowId).toBeUndefined() // _internal keys stripped
    expect(snap._dirty).toBeUndefined()
  })
})
