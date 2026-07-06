/**
 * P4 — Unit tests for applyEbayFlatFileSnapshot.
 *
 * Verifies the three-layer merge:
 *  1. derivedRow base  (fields absent from snapshot fall through)
 *  2. snapshot overlay (user-entered fields win: parentage, parent_sku, aspects …)
 *  3. live overrides   (EBAY_SNAPSHOT_LIVE_FIELDS + _ internals always from DB)
 */

import { describe, it, expect } from 'vitest'
import { applyEbayFlatFileSnapshot, EBAY_SNAPSHOT_LIVE_FIELDS } from './ebay-variation-push.service.js'

// ── helpers ─────────────────────────────────────────────────────────────

function derived(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: 'SKU-001',
    ean: '1234567890123',
    parentage: 'child',
    parent_sku: 'SKU-DB-PARENT',
    title: 'DB Title',
    description: 'DB Description',
    category_id: '12345',
    condition: 'NEW',
    aspect_Colore: '',
    ebay_item_id: 'LIVE-789',
    listing_status: 'ACTIVE',
    sync_status: 'synced',
    last_pushed_at: '2026-07-01T12:00:00Z',
    it_price: 55.00,
    it_qty: 10,
    it_item_id: 'IT-LIVE-ID',
    it_status: 'ACTIVE',
    it_listing_id: 'OFFER-IT',
    de_price: 60.00,
    de_qty: 5,
    de_item_id: null,
    de_status: null,
    de_listing_id: null,
    platformProductId: 'parent-db-id',
    _isParent: false,
    _rowId: 'prod-abc',
    _productId: 'prod-abc',
    _dirty: false,
    _status: 'idle',
    _listingId: 'listing-abc',
    ...overrides,
  }
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: 'SKU-001',
    ean: '1234567890123',
    parentage: 'parent',          // user set this to "parent"
    parent_sku: '',               // user cleared parent_sku
    title: 'Saved Title',
    description: 'Saved Description',
    category_id: '67890',
    condition: 'USED_GOOD',
    aspect_Colore: 'NERO',
    ebay_item_id: 'OLD-456',      // stale — should NOT win
    listing_status: 'DRAFT',      // stale — should NOT win
    sync_status: 'pending',       // stale — should NOT win
    last_pushed_at: '2026-01-01', // stale — should NOT win
    it_price: 45.00,              // typed price — SHOULD win (FFP.1)
    it_qty: 3,                    // stale qty — should NOT win
    it_item_id: 'OLD-IT-ID',      // stale — should NOT win
    it_status: 'ENDED',           // stale — should NOT win
    it_listing_id: 'OLD-OFFER',   // stale — should NOT win
    de_price: 50.00,              // typed price — SHOULD win (FFP.1)
    platformProductId: 'wrong-id', // stale — should NOT win
    ...overrides,
  }
}

// ── tests ────────────────────────────────────────────────────────────────

describe('applyEbayFlatFileSnapshot — live fields always win', () => {
  it('sku and ean come from derivedRow (identity)', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot({ sku: 'WRONG', ean: 'WRONG' }))
    expect(result.sku).toBe('SKU-001')
    expect(result.ean).toBe('1234567890123')
  })

  it('ebay_item_id comes from derivedRow (live system field)', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.ebay_item_id).toBe('LIVE-789')
  })

  it('listing_status + sync_status + last_pushed_at come from derivedRow', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.listing_status).toBe('ACTIVE')
    expect(result.sync_status).toBe('synced')
    expect(result.last_pushed_at).toBe('2026-07-01T12:00:00Z')
  })

  it('per-market qty/item_id/status/listing_id come from derivedRow', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.it_qty).toBe(10)
    expect(result.it_item_id).toBe('IT-LIVE-ID')
    expect(result.it_status).toBe('ACTIVE')
    expect(result.it_listing_id).toBe('OFFER-IT')
    expect(result.de_qty).toBe(5)
  })

  it('FFP.1 — per-market PRICE comes from the snapshot (typed price wins)', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.it_price).toBe(45.00)   // operator's saved value, not live 55.00
    expect(result.de_price).toBe(50.00)   // operator's saved value, not live 60.00
  })

  it('FFP.1 — price absent from snapshot falls through to the live value', () => {
    const s = snapshot()
    delete s.it_price
    const result = applyEbayFlatFileSnapshot(derived(), s)
    expect(result.it_price).toBe(55.00)
  })

  it('platformProductId comes from derivedRow (grouping key)', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.platformProductId).toBe('parent-db-id')
  })

  it('_isParent comes from derivedRow (grouping flag)', () => {
    const result = applyEbayFlatFileSnapshot(
      derived({ _isParent: false }),
      snapshot({ _isParent: true }),
    )
    expect(result._isParent).toBe(false)
  })

  it('all _ internal fields come from derivedRow', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result._rowId).toBe('prod-abc')
    expect(result._productId).toBe('prod-abc')
    expect(result._dirty).toBe(false)
    expect(result._status).toBe('idle')
    expect(result._listingId).toBe('listing-abc')
  })
})

describe('applyEbayFlatFileSnapshot — snapshot fields win for user-entered content', () => {
  it('parentage comes from snapshot (PRIMARY use-case)', () => {
    // user saved "parent" — DB still shows "child" from parentId
    const result = applyEbayFlatFileSnapshot(
      derived({ parentage: 'child' }),
      snapshot({ parentage: 'parent' }),
    )
    expect(result.parentage).toBe('parent')
  })

  it('parent_sku comes from snapshot (PRIMARY use-case)', () => {
    const result = applyEbayFlatFileSnapshot(
      derived({ parent_sku: 'SKU-DB-PARENT' }),
      snapshot({ parent_sku: 'SKU-SAVED-PARENT' }),
    )
    expect(result.parent_sku).toBe('SKU-SAVED-PARENT')
  })

  it('parent_sku="" from snapshot wins over DB-derived value', () => {
    // User cleared parent_sku (saved as empty string) — should stay empty
    const result = applyEbayFlatFileSnapshot(
      derived({ parent_sku: 'SKU-DB-PARENT' }),
      snapshot({ parent_sku: '' }),
    )
    expect(result.parent_sku).toBe('')
  })

  it('title comes from snapshot', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.title).toBe('Saved Title')
  })

  it('description comes from snapshot', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.description).toBe('Saved Description')
  })

  it('category_id comes from snapshot', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.category_id).toBe('67890')
  })

  it('condition comes from snapshot', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot())
    expect(result.condition).toBe('USED_GOOD')
  })

  it('aspect_* fields come from snapshot', () => {
    const result = applyEbayFlatFileSnapshot(derived(), snapshot({ aspect_Colore: 'ROSSO', aspect_Taglia: 'M' }))
    expect(result.aspect_Colore).toBe('ROSSO')
    expect(result.aspect_Taglia).toBe('M')
  })
})

describe('applyEbayFlatFileSnapshot — fallback for fields absent from snapshot', () => {
  it('field in derivedRow but absent from snapshot uses derived value', () => {
    // e.g. a new field (like mpn) added after snapshot was written
    const d = derived({ mpn: 'MPN-123', subtitle: 'DB subtitle' })
    const s = snapshot() // no mpn, no subtitle in snapshot
    const result = applyEbayFlatFileSnapshot(d, s)
    expect(result.mpn).toBe('MPN-123')
    expect(result.subtitle).toBe('DB subtitle')
  })

  it('empty snapshot falls back entirely to derivedRow', () => {
    const d = derived()
    const result = applyEbayFlatFileSnapshot(d, {})
    // With empty snapshot: {derivedRow, ...{}, ...live} = derivedRow
    expect(result.parentage).toBe('child')
    expect(result.parent_sku).toBe('SKU-DB-PARENT')
    expect(result.it_price).toBe(55.00)
    expect(result._rowId).toBe('prod-abc')
  })
})

describe('EBAY_SNAPSHOT_LIVE_FIELDS whitelist', () => {
  it('contains all 5 market qty/item_id/status/listing_id combinations (price excluded — FFP.1)', () => {
    for (const mp of ['it', 'de', 'fr', 'es', 'uk']) {
      expect(EBAY_SNAPSHOT_LIVE_FIELDS.has(`${mp}_price`)).toBe(false)
      expect(EBAY_SNAPSHOT_LIVE_FIELDS.has(`${mp}_qty`)).toBe(true)
      expect(EBAY_SNAPSHOT_LIVE_FIELDS.has(`${mp}_item_id`)).toBe(true)
      expect(EBAY_SNAPSHOT_LIVE_FIELDS.has(`${mp}_status`)).toBe(true)
      expect(EBAY_SNAPSHOT_LIVE_FIELDS.has(`${mp}_listing_id`)).toBe(true)
    }
  })

  it('contains system/identity fields', () => {
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('sku')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('ean')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('ebay_item_id')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('sync_status')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('listing_status')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('last_pushed_at')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('platformProductId')).toBe(true)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('_isParent')).toBe(true)
  })

  it('does NOT include user-entered shared fields', () => {
    // These should come from snapshot, not from the live-fields set
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('parentage')).toBe(false)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('parent_sku')).toBe(false)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('title')).toBe(false)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('description')).toBe(false)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('category_id')).toBe(false)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('condition')).toBe(false)
    expect(EBAY_SNAPSHOT_LIVE_FIELDS.has('variation_theme')).toBe(false)
  })
})
