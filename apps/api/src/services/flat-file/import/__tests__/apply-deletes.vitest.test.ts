/**
 * FF2.6b — applyDeletes TDD tests.
 *
 * ALL tests use a MOCK prisma. No real DB is touched.
 * The mock records every write call into arrays so tests can assert on them.
 *
 * Suites:
 *   deleteConfirmationPhrase — correct phrase format for N records
 *   applyDeletes:
 *     1a — wrong phrase throws before any write
 *     1b — correct phrase proceeds without throwing
 *     2  — scoped-market channel delete writes ENDED to the scoped market only
 *     3  — master delete soft-deletes product + cascades to children
 *     4a — inverse diff captures previous channel listing state
 *     4b — inverse diff captures previous product deletedAt
 *     C1 — master delete with 2 children → inverseDiff captures children
 *     C2a — channel delete markets=ALL: per-market inverse+end (not capture-one/write-many)
 *     C2b — channel delete markets=undefined → SKIPPED (footgun guard)
 */

import { describe, it, expect } from 'vitest'
import { applyDeletes, deleteConfirmationPhrase } from '../apply.js'
import type { ImportDiff } from '../diff.js'

// ── Mock Prisma ────────────────────────────────────────────────────────────────

interface MockDeletesPrismaOpts {
  /** Returned by channelListing.findFirst (for inverse capture before end). */
  channelListingRow?: Record<string, unknown> | null
  /** Returned by channelListing.findMany (for ALL-market discovery). */
  channelListingRows?: Record<string, unknown>[]
  /** Returned by product.findFirst (for soft-delete + cascade). */
  productRow?: Record<string, unknown> | null
  /** Returned by product.findMany (for C1 children capture). */
  productChildRows?: { id: string }[]
}

function makeMockPrisma(opts: MockDeletesPrismaOpts = {}) {
  const calls = {
    channelListingUpdateMany: [] as Array<{ where: any; data: any }>,
    productUpdateMany: [] as Array<{ where: any; data: any }>,
  }

  const prisma = {
    channelListing: {
      findFirst: async (_args: any) =>
        opts.channelListingRow !== undefined ? opts.channelListingRow : null,
      findMany: async (_args: any) =>
        opts.channelListingRows !== undefined ? opts.channelListingRows : [],
      updateMany: async (args: { where: any; data: any }) => {
        calls.channelListingUpdateMany.push(args)
        return { count: 1 }
      },
    },
    product: {
      findFirst: async (_args: any) =>
        opts.productRow !== undefined ? opts.productRow : null,
      findMany: async (_args: any) =>
        opts.productChildRows !== undefined ? opts.productChildRows : [],
      updateMany: async (args: { where: any; data: any }) => {
        calls.productUpdateMany.push(args)
        return { count: 1 }
      },
    },
    _calls: calls,
  }

  return prisma
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeEmptyDiff(): ImportDiff {
  return {
    changes: [],
    masterChanges: [],
    deletes: [],
    stats: { adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 },
  }
}

// ── deleteConfirmationPhrase ───────────────────────────────────────────────────

describe('deleteConfirmationPhrase', () => {
  it('returns DELETE 2 PRODUCTS for a 2-record diff', () => {
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [
        { sku: 'X', sheet: 'Products' },
        { sku: 'Y', sheet: 'Products' },
      ],
    }
    expect(deleteConfirmationPhrase(diff)).toBe('DELETE 2 PRODUCTS')
  })

  it('returns DELETE 0 PRODUCTS for an empty diff', () => {
    expect(deleteConfirmationPhrase(makeEmptyDiff())).toBe('DELETE 0 PRODUCTS')
  })

  it('returns DELETE 1 PRODUCTS for a 1-record diff', () => {
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'X', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] }],
    }
    expect(deleteConfirmationPhrase(diff)).toBe('DELETE 1 PRODUCTS')
  })
})

// ── applyDeletes ───────────────────────────────────────────────────────────────

describe('applyDeletes', () => {
  // ── 1. Typed-confirm gate ──────────────────────────────────────────────────

  describe('1 — typed-confirm gate', () => {
    it('1a — wrong phrase throws before any write', async () => {
      const prisma = makeMockPrisma({
        productRow: { id: 'p1', sku: 'X', deletedAt: null },
      })
      const diff: ImportDiff = {
        ...makeEmptyDiff(),
        deletes: [{ sku: 'X', sheet: 'Products' }],
      }

      await expect(
        applyDeletes(prisma, diff, { deleteConfirmation: 'wrong phrase' }),
      ).rejects.toThrow('delete confirmation phrase does not match')

      // No writes should have happened before the guard fired
      expect(prisma._calls.productUpdateMany).toHaveLength(0)
      expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    })

    it('1b — correct phrase proceeds without throwing', async () => {
      const prisma = makeMockPrisma({
        productRow: { id: 'p1', sku: 'X', deletedAt: null },
      })
      const diff: ImportDiff = {
        ...makeEmptyDiff(),
        deletes: [{ sku: 'X', sheet: 'Products' }],
      }
      const phrase = deleteConfirmationPhrase(diff) // 'DELETE 1 PRODUCTS'

      await expect(
        applyDeletes(prisma, diff, { deleteConfirmation: phrase }),
      ).resolves.not.toThrow()
    })

    it('1c — empty deletes list with correct phrase returns empty ApplyResult', async () => {
      const prisma = makeMockPrisma()
      const diff = makeEmptyDiff()
      const phrase = deleteConfirmationPhrase(diff) // 'DELETE 0 PRODUCTS'

      const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

      expect(result.applied).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.rows).toHaveLength(0)
      expect(result.inverseDiff).toHaveLength(0)
      expect(prisma._calls.productUpdateMany).toHaveLength(0)
      expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    })
  })

  // ── 2. Scoped-market channel delete ───────────────────────────────────────

  it('2 — channel delete writes ENDED to scoped market only; no product write, no DE write', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { listingStatus: 'ACTIVE', isPublished: true, offerActive: true },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'X', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    // Exactly ONE channelListing.updateMany for IT
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(1)
    const call = prisma._calls.channelListingUpdateMany[0]

    // Where must scope to the right channel + market
    expect(call.where.channel).toBe('AMAZON')
    expect(call.where.marketplace).toBe('IT')

    // Data must end the listing
    expect(call.data.listingStatus).toBe('ENDED')
    expect(call.data.isPublished).toBe(false)
    expect(call.data.offerActive).toBe(false)

    // NO product soft-delete
    expect(prisma._calls.productUpdateMany).toHaveLength(0)

    // NO DE or other-market writes
    const deWrite = prisma._calls.channelListingUpdateMany.find(
      (c: any) => c.where.marketplace === 'DE',
    )
    expect(deWrite).toBeUndefined()

    expect(result.applied).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.rows[0].status).toBe('SUCCESS')
  })

  // ── 3. Master delete + cascade ────────────────────────────────────────────
  // I2b: cascade runs BEFORE primary so a cascade failure keeps parent alive.

  it('3 — master delete cascades first then soft-deletes parent; no channelListing write', async () => {
    const prisma = makeMockPrisma({
      productRow: { id: 'p1', sku: 'P', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'P', sheet: 'Products' }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    // Exactly 2 product.updateMany: cascade (first) + primary (second) — I2b order
    expect(prisma._calls.productUpdateMany).toHaveLength(2)

    const [cascade, primary] = prisma._calls.productUpdateMany

    // Cascade runs first: keyed by parentId from findFirst result
    expect(cascade.where).toEqual({ parentId: 'p1', deletedAt: null })
    expect(cascade.data.deletedAt).toBeInstanceOf(Date)

    // Primary soft-delete runs second: keyed by SKU
    expect(primary.where).toEqual({ sku: 'P' })
    expect(primary.data.deletedAt).toBeInstanceOf(Date)

    // NO channelListing writes
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)

    expect(result.applied).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.rows[0].status).toBe('SUCCESS')
  })

  // ── 4. Inverse diff ────────────────────────────────────────────────────────

  it('4a — inverse diff captures previous channel state before ENDED write', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { listingStatus: 'ACTIVE', isPublished: true, offerActive: true },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'X', sheet: 'Amazon', channel: 'AMAZON', markets: ['IT'] }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    expect(result.inverseDiff).toHaveLength(1)
    const inv = result.inverseDiff[0]
    expect(inv.model).toBe('ChannelListing')
    expect(inv.sku).toBe('X')
    expect(inv.channel).toBe('AMAZON')
    expect(inv.market).toBe('IT')
    // Previous values captured (so a rollback can restore ACTIVE state)
    expect(inv.data.listingStatus).toBe('ACTIVE')
    expect(inv.data.isPublished).toBe(true)
    expect(inv.data.offerActive).toBe(true)
  })

  it('4b — inverse diff captures previous product deletedAt before soft-delete', async () => {
    const prisma = makeMockPrisma({
      productRow: { id: 'p1', sku: 'P', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'P', sheet: 'Products' }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    // At least one inverse cell for the Product model with deletedAt from before
    const productInverse = result.inverseDiff.find(
      (inv) => inv.model === 'Product' && inv.sku === 'P' && 'deletedAt' in inv.data && !('__restoreChildrenOf' in inv.data),
    )
    expect(productInverse).toBeDefined()
    // Previous deletedAt was null
    expect(productInverse!.data.deletedAt).toBeNull()
  })

  // ── C1. Children inverse (cascade rollback) ───────────────────────────────

  it('C1 — master delete with 2 children → inverseDiff captures children ids for rollback', async () => {
    const prisma = makeMockPrisma({
      productRow: { id: 'p1', sku: 'PARENT', deletedAt: null },
      productChildRows: [{ id: 'c1' }, { id: 'c2' }],
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'PARENT', sheet: 'Products' }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    expect(result.applied).toBe(1)

    // Children inverse is present and contains both child ids
    const childrenInverse = result.inverseDiff.find(
      (inv) => inv.model === 'Product' && inv.sku === 'PARENT' && '__restoreChildrenOf' in inv.data,
    )
    expect(childrenInverse).toBeDefined()
    expect(childrenInverse!.data.__restoreChildrenOf).toBe('p1')
    expect(childrenInverse!.data.childIds).toEqual(['c1', 'c2'])
    expect(childrenInverse!.data.deletedAt).toBeNull()
  })

  // ── C2. ALL-market and undefined-market channel deletes ───────────────────

  it('C2a — channel delete markets=ALL: findMany discovers markets; per-market inverse+end', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { listingStatus: 'ACTIVE', isPublished: true, offerActive: true },
      channelListingRows: [
        { marketplace: 'IT', listingStatus: 'ACTIVE', isPublished: true, offerActive: true },
        { marketplace: 'DE', listingStatus: 'ACTIVE', isPublished: true, offerActive: true },
      ],
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      deletes: [{ sku: 'X', sheet: 'Amazon', channel: 'AMAZON', markets: 'ALL' }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(0)

    // 2 per-market inverseDiff entries (one per discovered market)
    const channelInverses = result.inverseDiff.filter(
      (inv) => inv.model === 'ChannelListing' && inv.sku === 'X',
    )
    expect(channelInverses).toHaveLength(2)
    const capturedMarkets = channelInverses.map((inv) => inv.market).sort()
    expect(capturedMarkets).toEqual(['DE', 'IT'])

    // 2 per-market updateMany calls
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(2)
    const writtenMarkets = prisma._calls.channelListingUpdateMany
      .map((c: any) => c.where.marketplace)
      .sort()
    expect(writtenMarkets).toEqual(['DE', 'IT'])
    // All calls end the listing
    for (const call of prisma._calls.channelListingUpdateMany) {
      expect(call.data.listingStatus).toBe('ENDED')
    }
  })

  it('C2b — channel delete markets=undefined → SKIPPED; no writes', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { listingStatus: 'ACTIVE', isPublished: true, offerActive: true },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      // markets field absent → undefined
      deletes: [{ sku: 'X', sheet: 'Amazon', channel: 'AMAZON' }],
    }
    const phrase = deleteConfirmationPhrase(diff)

    const result = await applyDeletes(prisma, diff, { deleteConfirmation: phrase })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].status).toBe('SKIPPED')
    expect(result.rows[0].detail).toBe('delete skipped: no market scope')
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
  })
})
