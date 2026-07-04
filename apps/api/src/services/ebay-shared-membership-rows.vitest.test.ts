/**
 * Task 3 — Tests for ebay-shared-membership-rows.ts
 *
 * Phase 1 (RED): written before implementation — describes expected behaviour.
 * Phase 2 (GREEN): implementation makes them pass.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  reverseVariationSpecifics,
  synthesizeSharedRow,
  loadSharedMembershipRows,
} from './ebay-shared-membership-rows.js'

// ── reverseVariationSpecifics ─────────────────────────────────────────────────

describe('reverseVariationSpecifics', () => {
  it('produces cased AND lowercase aspect_ keys', () => {
    const result = reverseVariationSpecifics({ Colore: 'Nero', 'Base Color': 'Black' })
    expect(result).toMatchObject({
      aspect_Colore: 'Nero',
      aspect_colore: 'Nero',
      aspect_Base_Color: 'Black',
      aspect_base_color: 'Black',
    })
  })

  it('returns empty object for empty input', () => {
    expect(reverseVariationSpecifics({})).toEqual({})
  })

  it('returns empty object when called with no arguments', () => {
    expect(reverseVariationSpecifics()).toEqual({})
  })
})

// ── synthesizeSharedRow ───────────────────────────────────────────────────────

describe('synthesizeSharedRow', () => {
  it('membership price WINS over base price; sets shared/readonly flags; preserves base fields', () => {
    const membership = {
      sku: 'C',
      itemId: '110',
      parentSku: 'P',
      marketplace: 'IT',
      price: 120,
      lastQtyPushed: 5,
      variationSpecifics: { Colore: 'Nero' } as Record<string, string>,
    }
    const childBaseRow: Record<string, unknown> = { sku: 'C', it_price: 100, title: 'Jacket' }

    const row = synthesizeSharedRow({
      membership,
      childBaseRow,
      parentProductId: 'pid-P',
    })

    // identity / family
    expect(row.platformProductId).toBe('pid-P')
    expect(row._isParent).toBe(false)
    expect(row._shared).toBe(true)
    expect(row._readonly).toBe(true)

    // P1a — explicit parentage fields
    expect(row.parentage).toBe('child')
    expect(row.parent_sku).toBe('P')

    // eBay item IDs
    expect(row.ebay_item_id).toBe('110')
    expect(row.it_item_id).toBe('110')

    // price: membership WINS over child base row's it_price:100
    expect(row.it_price).toBe(120)
    expect(row.price).toBe(120)

    // quantity
    expect(row.it_qty).toBe(5)
    expect(row.quantity).toBe(5)

    // variation specifics
    expect(row.aspect_Colore).toBe('Nero')

    // base field preserved
    expect(row.title).toBe('Jacket')
  })

  it('omits price and qty keys entirely when both are null', () => {
    const row = synthesizeSharedRow({
      membership: {
        sku: 'X',
        itemId: '999',
        marketplace: 'DE',
        price: null,
        lastQtyPushed: null,
        variationSpecifics: {},
      },
      childBaseRow: null,
      parentProductId: 'pid-Q',
    })

    expect(row).not.toHaveProperty('de_price')
    expect(row).not.toHaveProperty('price')
    expect(row).not.toHaveProperty('de_qty')
    expect(row).not.toHaveProperty('quantity')
  })

  it('falls back to { sku } skeleton when childBaseRow is null', () => {
    const row = synthesizeSharedRow({
      membership: {
        sku: 'Z',
        itemId: '777',
        marketplace: 'FR',
        price: 50,
        lastQtyPushed: 2,
        variationSpecifics: {},
      },
      childBaseRow: null,
      parentProductId: 'pid-R',
    })

    expect(row.sku).toBe('Z')
    expect(row.fr_price).toBe(50)
    expect(row.fr_qty).toBe(2)
  })

  it('C1: sets a unique _rowId (shared::<itemId>::<sku>) distinct from the child base row _rowId', () => {
    const childBaseRow: Record<string, unknown> = {
      sku: 'C', _rowId: 'prod-C', _productId: 'prod-C', it_price: 100, title: 'Jacket',
    }
    const row = synthesizeSharedRow({
      membership: {
        sku: 'C', itemId: '110', marketplace: 'IT',
        price: null, lastQtyPushed: null, variationSpecifics: {}, productId: 'prod-C',
      },
      childBaseRow,
      parentProductId: 'pid-P',
    })
    expect(row._rowId).toBe('shared::110::C')
    // MUST differ from the child's natural row _rowId (no duplicate React key / selection clash)
    expect(row._rowId).not.toBe(childBaseRow._rowId)
    // _productId stays the real child id for downstream resolution
    expect(row._productId).toBe('prod-C')
  })

  it('C1: seeds _productId from membership.productId when childBaseRow is null', () => {
    const row = synthesizeSharedRow({
      membership: {
        sku: 'Z', itemId: '777', marketplace: 'FR',
        price: 50, lastQtyPushed: 2, variationSpecifics: {}, productId: 'child-prod-Z',
      },
      childBaseRow: null,
      parentProductId: 'pid-R',
    })
    expect(row._rowId).toBe('shared::777::Z')
    expect(row._productId).toBe('child-prod-Z')
  })
})

// ── loadSharedMembershipRows ──────────────────────────────────────────────────

describe('loadSharedMembershipRows', () => {
  it('returns [] without querying DB when no parent rows supplied', async () => {
    const mockPrisma = {
      sharedListingMembership: { findMany: vi.fn() },
      product: { findMany: vi.fn() },
    }

    const result = await loadSharedMembershipRows(mockPrisma as any, [], [])

    expect(result).toEqual([])
    expect(mockPrisma.sharedListingMembership.findMany).not.toHaveBeenCalled()
  })

  it('returns [] when no parent rows have _isParent === true', async () => {
    const mockPrisma = {
      sharedListingMembership: { findMany: vi.fn() },
      product: { findMany: vi.fn() },
    }

    const parentRows = [{ sku: 'child-X', _isParent: false, _productId: 'prod-X' }]
    const result = await loadSharedMembershipRows(mockPrisma as any, parentRows, [])

    expect(result).toEqual([])
    expect(mockPrisma.sharedListingMembership.findMany).not.toHaveBeenCalled()
  })

  it('deduplicates: child already under parent-A in normalRows is skipped; child under parent-B via membership is synthesized', async () => {
    // Scenario:
    //   - Two parent rows: parent-A (prod-A) and parent-B (prod-B).
    //   - normalRows already contains child-1 under parent-A.
    //   - A SharedListingMembership places child-1 also under parent-B.
    //   - Expected: exactly ONE synthesized row (under parent-B). parent-A is skipped.

    const parentRows: Record<string, unknown>[] = [
      { sku: 'parent-A', _isParent: true, _productId: 'prod-A' },
      { sku: 'parent-B', _isParent: true, _productId: 'prod-B' },
    ]

    const normalRows: Record<string, unknown>[] = [
      // child-1 is already under parent-A (its own natural family)
      { sku: 'child-1', platformProductId: 'prod-A', _isParent: false },
    ]

    // Prisma-like Decimal value (has .valueOf())
    const decimalPrice = {
      valueOf: () => 99,
      toString: () => '99',
      [Symbol.toPrimitive]: () => 99,
    }

    const mockMembership = {
      sku: 'child-1',
      itemId: 'item-111',
      marketplace: 'IT',
      parentSku: 'parent-B',
      productId: 'child-prod-1',
      variationSpecifics: { Colore: 'Nero' },
      price: decimalPrice,
      lastQtyPushed: 3,
    }

    // Minimal child product that buildFlatRow can work with
    const mockChildProduct = {
      id: 'child-prod-1',
      sku: 'child-1',
      name: 'Child Product',
      ean: null,
      parentId: 'prod-A',
      brand: null,
      variationTheme: null,
      categoryAttributes: null,
      variantAttributes: null,
      images: [],
      channelListings: [],
    }

    // child-1 ALSO has a membership under parent-A — but parent-A already shows child-1 as a
    // normal row, so this membership MUST be deduped (skipped) against normalRows.
    const mockMembershipA = { ...mockMembership, parentSku: 'parent-A', itemId: 'item-000' }

    const mockPrisma = {
      sharedListingMembership: {
        findMany: vi.fn().mockResolvedValue([mockMembershipA, mockMembership]),
      },
      product: {
        findMany: vi.fn().mockResolvedValue([mockChildProduct]),
      },
    }

    const result = await loadSharedMembershipRows(mockPrisma as any, parentRows, normalRows)

    // Exactly one synthesized row — the parent-A membership was deduped against the normal row.
    expect(result).toHaveLength(1)
    expect(result.some(r => r.platformProductId === 'prod-A')).toBe(false)

    const row = result[0]
    expect(row.sku).toBe('child-1')
    // Points to parent-B (the membership parent)
    expect(row.platformProductId).toBe('prod-B')
    expect(row._shared).toBe(true)
    expect(row._readonly).toBe(true)
    expect(row._isParent).toBe(false)
    expect(row.ebay_item_id).toBe('item-111')
    // Decimal price converted to number
    expect(row.it_price).toBe(99)
    expect(row.it_qty).toBe(3)
    expect(row.aspect_Colore).toBe('Nero')

    // P1a — explicit parentage fields on synthesized rows
    expect(row.parentage).toBe('child')
    expect(row.parent_sku).toBe('parent-B')

    // Membership DB was queried with both parent SKUs
    expect(mockPrisma.sharedListingMembership.findMany).toHaveBeenCalledWith({
      where: { parentSku: { in: ['parent-A', 'parent-B'] }, status: 'ACTIVE' },
    })
  })

  it('does not duplicate when the same membership appears twice (within-call dedup)', async () => {
    // Two memberships for the same parentSku+sku pair → only one synthesized row
    const parentRows: Record<string, unknown>[] = [
      { sku: 'parent-A', _isParent: true, _productId: 'prod-A' },
    ]

    const twoMemberships = [
      {
        sku: 'child-1',
        itemId: 'item-111',
        marketplace: 'IT',
        parentSku: 'parent-A',
        productId: null,
        variationSpecifics: {},
        price: null,
        lastQtyPushed: null,
      },
      {
        sku: 'child-1',
        itemId: 'item-222',
        marketplace: 'DE',
        parentSku: 'parent-A',
        productId: null,
        variationSpecifics: {},
        price: null,
        lastQtyPushed: null,
      },
    ]

    const mockPrisma = {
      sharedListingMembership: {
        findMany: vi.fn().mockResolvedValue(twoMemberships),
      },
      product: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    }

    const result = await loadSharedMembershipRows(mockPrisma as any, parentRows, [])

    // Second entry for the same key should be dropped
    expect(result).toHaveLength(1)
  })

  it('C1/integration: synthesized rows get a UNIQUE _rowId vs normal rows AND are push-filterable', async () => {
    // child-1 is a NORMAL row under parent-A (buildFlatRow → _rowId = child product id)
    // AND a membership under parent-B → the synthesized row must not collide on _rowId.
    const parentRows: Record<string, unknown>[] = [
      { sku: 'parent-A', _isParent: true, _productId: 'prod-A' },
      { sku: 'parent-B', _isParent: true, _productId: 'prod-B' },
    ]
    const normalRows: Record<string, unknown>[] = [
      { sku: 'child-1', _rowId: 'child-prod-1', _productId: 'child-prod-1', platformProductId: 'prod-A', _isParent: false },
    ]

    const mockMembership = {
      sku: 'child-1', itemId: 'item-111', marketplace: 'IT', parentSku: 'parent-B',
      productId: 'child-prod-1', variationSpecifics: { Colore: 'Nero' }, price: null, lastQtyPushed: 3,
    }
    const mockChildProduct = {
      id: 'child-prod-1', sku: 'child-1', name: 'Child', ean: null, parentId: 'prod-A',
      brand: null, variationTheme: null, categoryAttributes: null, variantAttributes: null, images: [], channelListings: [],
    }
    const mockPrisma = {
      sharedListingMembership: { findMany: vi.fn().mockResolvedValue([mockMembership]) },
      product: { findMany: vi.fn().mockResolvedValue([mockChildProduct]) },
    }

    const synth = await loadSharedMembershipRows(mockPrisma as any, parentRows, normalRows)
    expect(synth).toHaveLength(1)

    const allRows = [...normalRows, ...synth]
    // (a) every _rowId (normal + synthesized) is unique — no collision
    const rowIds = allRows.map(r => r._rowId)
    expect(new Set(rowIds).size).toBe(rowIds.length)
    expect(synth[0]._rowId).toBe('shared::item-111::child-1')
    expect(synth[0]._rowId).not.toBe(normalRows[0]._rowId)

    // (b) a `!_readonly && !_shared` push filter excludes the synthesized VIEW row
    const pushable = allRows.filter(r => !(r as Record<string, unknown>)._readonly && !(r as Record<string, unknown>)._shared)
    expect(pushable).toHaveLength(1)
    expect(pushable[0].sku).toBe('child-1')
    expect(pushable[0]._rowId).toBe('child-prod-1')
  })
})
