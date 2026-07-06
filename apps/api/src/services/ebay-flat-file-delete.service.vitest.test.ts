// apps/api/src/services/ebay-flat-file-delete.service.vitest.test.ts
//
// P2.D1 — unit tests for eBay flat-file soft-delete service.
//
// All external I/O is mocked:
//   - prisma (product.findFirst/findMany/update/updateMany,
//             sharedListingMembership.findMany/deleteMany/$transaction)
//   - dispatchChannelDelist (from channel-delist.service)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DeleteTargetResult } from './ebay-flat-file-delete.service.js'

// ── Mock channel-delist module ─────────────────────────────────────────────
// Must be declared BEFORE the dynamic import of the module under test.
const mockDispatchChannelDelist = vi.fn()
vi.mock('./channel-delist.service.js', () => ({
  dispatchChannelDelist: (...args: unknown[]) =>
    mockDispatchChannelDelist(...args),
}))

// ── Import module under test (after vi.mock) ───────────────────────────────
const { runEbayFlatFileDelete } = await import(
  './ebay-flat-file-delete.service.js'
)

// ── Prisma mock factory ────────────────────────────────────────────────────

function makeProduct(overrides: Partial<{
  id: string; sku: string; deletedAt: Date | null; ebayItemId: string | null
}> = {}) {
  return {
    id: 'prod-1',
    sku: 'TEST-SKU',
    deletedAt: null,
    ebayItemId: null,
    ...overrides,
  }
}

function mockPrisma(opts: {
  productFindFirst?: unknown
  productFindMany?: unknown[]
  membershipFindMany?: unknown[]
  productUpdateResult?: unknown
  productUpdateManyResult?: { count: number }
  membershipDeleteManyResult?: { count: number }
} = {}) {
  const product = {
    findFirst: vi.fn().mockResolvedValue(opts.productFindFirst ?? null),
    findMany: vi.fn().mockResolvedValue(opts.productFindMany ?? []),
    update: vi.fn().mockResolvedValue(opts.productUpdateResult ?? {}),
    updateMany: vi.fn().mockResolvedValue(
      opts.productUpdateManyResult ?? { count: 0 },
    ),
  }

  const sharedListingMembership = {
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue(
      opts.membershipDeleteManyResult ?? { count: 0 },
    ),
    findMany: vi.fn().mockResolvedValue(opts.membershipFindMany ?? []),
  }

  const $transaction = vi.fn(
    async (fn: (tx: { product: typeof product; sharedListingMembership: typeof sharedListingMembership }) => Promise<unknown>) =>
      fn({ product, sharedListingMembership }),
  )

  return { product, sharedListingMembership, $transaction }
}

// ── Shared setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Default: eBay delist is not yet implemented (stub returns success:false).
  mockDispatchChannelDelist.mockResolvedValue({
    success: false,
    error: 'eBay delist not yet implemented (W5.49b pending).',
    errorCode: 'EBAY_DELIST_NOT_IMPLEMENTED',
    retryable: false,
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. delete-product
// ═══════════════════════════════════════════════════════════════════════════

describe('delete-product', () => {
  it('sets product.deletedAt, deletes memberships, and attempts delist', async () => {
    const prod = makeProduct({ id: 'p1', sku: 'SKU-A', ebayItemId: 'ITEM-1' })
    const db = mockPrisma({
      productFindFirst: prod,
      membershipFindMany: [{ itemId: 'ITEM-1' }],
      membershipDeleteManyResult: { count: 2 },
    })

    const results: DeleteTargetResult[] = await runEbayFlatFileDelete(db as any, [
      { sku: 'SKU-A', marketplace: 'IT', intent: 'delete-product' },
    ])

    const r = results[0]
    expect(r.intent).toBe('delete-product')
    expect(r.softDeleted).toEqual(['p1'])
    expect(r.membershipsRemoved).toBe(2)
    expect(r.error).toBeUndefined()

    // product.update was called with deletedAt set (not hard delete)
    expect(db.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    )
    expect(db.product.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: undefined }) }),
    )

    // product.delete was NOT called (no hard delete)
    // (there is no product.delete method on the interface — confirmed absent)

    // Memberships were deleted via deleteMany
    expect(db.sharedListingMembership.deleteMany).toHaveBeenCalled()

    // Delist was attempted
    expect(mockDispatchChannelDelist).toHaveBeenCalledWith(
      expect.objectContaining({ externalListingId: 'ITEM-1', targetChannel: 'EBAY' }),
    )

    // delisted is false because the stub returns success: false
    expect(r.delisted).toBe(false)
  })

  it('resolves product by productId when provided', async () => {
    const prod = makeProduct({ id: 'p-explicit', sku: 'SKU-B' })
    const db = mockPrisma({ productFindFirst: prod })

    await runEbayFlatFileDelete(db as any, [
      { sku: 'SKU-B', marketplace: 'IT', productId: 'p-explicit', intent: 'delete-product' },
    ])

    expect(db.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-explicit' } }),
    )
  })

  it('returns error (not throws) when product not found', async () => {
    const db = mockPrisma({ productFindFirst: null })

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'MISSING-SKU', marketplace: 'IT', intent: 'delete-product' },
    ])

    expect(results[0].error).toMatch(/not found/i)
    expect(results[0].softDeleted).toHaveLength(0)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. delete-family
// ═══════════════════════════════════════════════════════════════════════════

describe('delete-family', () => {
  it('soft-deletes parent + all non-deleted children in one transaction', async () => {
    const parent = makeProduct({ id: 'parent-1', sku: 'PARENT-SKU' })
    const children = [
      { id: 'child-1', sku: 'CHILD-A', ebayItemId: null },
      { id: 'child-2', sku: 'CHILD-B', ebayItemId: null },
    ]
    const db = mockPrisma({
      productFindFirst: parent,
      productFindMany: children,
      membershipDeleteManyResult: { count: 3 },
    })

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'PARENT-SKU', marketplace: 'IT', intent: 'delete-family' },
    ])

    const r = results[0]
    expect(r.softDeleted).toContain('parent-1')
    expect(r.softDeleted).toContain('child-1')
    expect(r.softDeleted).toContain('child-2')
    expect(r.membershipsRemoved).toBe(3)
    expect(r.error).toBeUndefined()

    // parent updated via product.update
    expect(db.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'parent-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )

    // children updated via product.updateMany
    expect(db.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['child-1', 'child-2'] } }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    )
  })

  it('soft-deletes a standalone product (no children) without calling updateMany', async () => {
    const standalone = makeProduct({ id: 'solo-1', sku: 'SOLO-SKU' })
    const db = mockPrisma({
      productFindFirst: standalone,
      productFindMany: [], // no children
    })

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'SOLO-SKU', marketplace: 'DE', intent: 'delete-family' },
    ])

    const r = results[0]
    expect(r.softDeleted).toEqual(['solo-1'])
    expect(db.product.update).toHaveBeenCalledOnce()
    // updateMany should NOT be called when there are no children
    expect(db.product.updateMany).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. remove-listing
// ═══════════════════════════════════════════════════════════════════════════

describe('remove-listing', () => {
  it('deletes ONE membership, does NOT soft-delete the product, attempts delist', async () => {
    const db = mockPrisma({
      membershipDeleteManyResult: { count: 1 },
    })

    const results = await runEbayFlatFileDelete(db as any, [
      {
        sku: 'SHARED-M',
        marketplace: 'IT',
        itemId: '110099887766',
        intent: 'remove-listing',
      },
    ])

    const r = results[0]
    expect(r.intent).toBe('remove-listing')
    expect(r.membershipsRemoved).toBe(1)
    expect(r.softDeleted).toHaveLength(0)
    expect(r.error).toBeUndefined()

    // Product was NOT modified
    expect(db.product.update).not.toHaveBeenCalled()
    expect(db.product.updateMany).not.toHaveBeenCalled()

    // Membership was deleted
    expect(db.sharedListingMembership.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          marketplace: 'IT',
          itemId: '110099887766',
          sku: 'SHARED-M',
        }),
      }),
    )

    // Delist attempted with the itemId
    expect(mockDispatchChannelDelist).toHaveBeenCalledWith(
      expect.objectContaining({ externalListingId: '110099887766' }),
    )
  })

  it('resolves itemId via parentSku when itemId is not provided', async () => {
    const db = mockPrisma({
      membershipFindMany: [{ itemId: 'RESOLVED-ITEM' }],
      membershipDeleteManyResult: { count: 1 },
    })

    const results = await runEbayFlatFileDelete(db as any, [
      {
        sku: 'SHARED-L',
        marketplace: 'IT',
        parentSku: 'LINER-PARENT',
        intent: 'remove-listing',
      },
    ])

    expect(results[0].membershipsRemoved).toBe(1)
    // Delist attempted with the resolved itemId
    expect(mockDispatchChannelDelist).toHaveBeenCalledWith(
      expect.objectContaining({ externalListingId: 'RESOLVED-ITEM' }),
    )
  })

  it('returns error when neither itemId nor parentSku is provided', async () => {
    const db = mockPrisma()

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'SKU-X', marketplace: 'IT', intent: 'remove-listing' },
    ])

    expect(results[0].error).toMatch(/itemId or parentSku/i)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Idempotency — already-deleted product
// ═══════════════════════════════════════════════════════════════════════════

describe('idempotency', () => {
  it('skips a product that already has deletedAt set — no error, no DB write', async () => {
    const alreadyDeleted = makeProduct({ id: 'p-del', sku: 'DEL-SKU', deletedAt: new Date() })
    const db = mockPrisma({ productFindFirst: alreadyDeleted })

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'DEL-SKU', marketplace: 'IT', intent: 'delete-product' },
    ])

    const r = results[0]
    expect(r.softDeleted).toHaveLength(0)
    expect(r.membershipsRemoved).toBe(0)
    expect(r.error).toBeUndefined()

    // No transaction was started
    expect(db.$transaction).not.toHaveBeenCalled()
    // No delist attempted (product already gone from Nexus perspective)
    expect(mockDispatchChannelDelist).not.toHaveBeenCalled()
  })

  it('skips a family whose parent already has deletedAt set', async () => {
    const alreadyDeleted = makeProduct({ id: 'fam-del', sku: 'FAM-SKU', deletedAt: new Date() })
    const db = mockPrisma({ productFindFirst: alreadyDeleted })

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'FAM-SKU', marketplace: 'IT', intent: 'delete-family' },
    ])

    expect(results[0].softDeleted).toHaveLength(0)
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Best-effort delist — failure must NOT roll back the soft-delete
// ═══════════════════════════════════════════════════════════════════════════

describe('best-effort delist', () => {
  it('soft-delete commits even when delist throws — error is in result.delisted, not a thrown error', async () => {
    mockDispatchChannelDelist.mockRejectedValueOnce(new Error('network timeout'))

    const prod = makeProduct({ id: 'p-throw', sku: 'THROW-SKU', ebayItemId: 'ITEM-99' })
    const db = mockPrisma({
      productFindFirst: prod,
      membershipFindMany: [{ itemId: 'ITEM-99' }],
      membershipDeleteManyResult: { count: 1 },
    })

    // Must NOT throw
    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'THROW-SKU', marketplace: 'IT', intent: 'delete-product' },
    ])

    const r = results[0]
    // Soft-delete still happened
    expect(r.softDeleted).toEqual(['p-throw'])
    expect(db.product.update).toHaveBeenCalled()
    // Delist flagged as failed
    expect(r.delisted).toBe(false)
    // But NO error in the result (delist failure is non-fatal)
    expect(r.error).toBeUndefined()
  })

  it('soft-delete commits even when delist returns success:false — no rollback', async () => {
    // Default mock already returns { success: false } — no extra setup needed.
    const prod = makeProduct({ id: 'p-fail-delist', sku: 'FAIL-DELIST' })
    const db = mockPrisma({ productFindFirst: prod, membershipDeleteManyResult: { count: 1 } })

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'FAIL-DELIST', marketplace: 'IT', intent: 'delete-product' },
    ])

    expect(results[0].softDeleted).toEqual(['p-fail-delist'])
    expect(results[0].delisted).toBe(false)
    expect(results[0].error).toBeUndefined()
    // Transaction committed
    expect(db.$transaction).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NEW: remove-channel-listing — channel/market isolation + inventory guard
// ═══════════════════════════════════════════════════════════════════════════

describe('remove-channel-listing — channel/market isolation + inventory guard', () => {
  function guardPrisma(deleteManyAssert: (args: any) => void) {
    // product has NO update/updateMany → any attempt to soft-delete throws → guard.
    return {
      product: {
        findFirst: async () => ({ id: 'p1', sku: 'SKU1', ebayItemId: null }),
        findMany: async () => [],                       // no children
      },
      sharedListingMembership: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      channelListing: {
        findMany: async () => [{ externalListingId: 'IT-ITEM-1' }],
        deleteMany: async (a: any) => { deleteManyAssert(a); return { count: 1 } },
      },
      $transaction: async (fn: any) => fn({
        product: {
          update: () => { throw new Error('Product.update must NOT be called (inventory guard)') },
          updateMany: () => { throw new Error('Product.updateMany must NOT be called') },
        },
        sharedListingMembership: { deleteMany: async () => ({ count: 0 }) },
        channelListing: { deleteMany: async (a: any) => { deleteManyAssert(a); return { count: 1 } } },
      }),
    }
  }

  it('removes only the EBAY listing for the target marketplace; Product untouched', async () => {
    const prisma = guardPrisma((a) => {
      expect(a.where.channel).toBe('EBAY')
      expect(a.where.marketplace).toBe('IT')
    })
    const [res] = await runEbayFlatFileDelete(prisma as any, [
      { sku: 'SKU1', productId: 'p1', marketplace: 'IT', intent: 'remove-channel-listing' },
    ])
    expect(res.error).toBeUndefined()
    expect(res.intent).toBe('remove-channel-listing')
    expect(res.softDeleted).toEqual([])          // inventory guard: nothing soft-deleted
    expect(res.channelListingsRemoved).toBe(1)
  })

  it('errors (does not throw) when the product is missing', async () => {
    const prisma = guardPrisma(() => {})
    ;(prisma.product as any).findFirst = async () => null
    const [res] = await runEbayFlatFileDelete(prisma as any, [
      { sku: 'GONE', marketplace: 'IT', intent: 'remove-channel-listing' },
    ])
    expect(res.error).toMatch(/not found/i)
    expect(res.channelListingsRemoved).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Per-target isolation — one failure does not abort others
// ═══════════════════════════════════════════════════════════════════════════

describe('per-target isolation', () => {
  it('processes the second target even if the first target errors', async () => {
    const db = mockPrisma({
      productFindFirst: null, // first target: product not found (error)
    })

    // Second target: re-use a fresh findFirst result after the first call fails.
    const goodProd = makeProduct({ id: 'good-p', sku: 'GOOD-SKU' })
    db.product.findFirst
      .mockResolvedValueOnce(null)          // first target: not found
      .mockResolvedValueOnce(goodProd)      // second target: found

    const results = await runEbayFlatFileDelete(db as any, [
      { sku: 'BAD-SKU', marketplace: 'IT', intent: 'delete-product' },
      { sku: 'GOOD-SKU', marketplace: 'IT', intent: 'delete-product' },
    ])

    expect(results).toHaveLength(2)
    expect(results[0].error).toBeDefined()
    expect(results[1].error).toBeUndefined()
    expect(results[1].softDeleted).toEqual(['good-p'])
  })
})
