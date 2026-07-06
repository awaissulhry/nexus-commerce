/**
 * FF2.6a — applyChanges TDD tests.
 *
 * ALL tests use a MOCK prisma. No real DB is touched.
 * The mock records every write call into arrays so tests can assert on them.
 *
 * Suites:
 *   1. Governed write-back (price update → priceOverride + followMasterPrice=false)
 *   2. Follow-flag true (price_follows_master@IT=true → followMasterPrice=true, priceOverride=null)
 *   3. Non-governed field (sale_price → salePrice column)
 *   4. Master field (brand → product.updateMany)
 *   5. SKU guard (base=sku → SKIPPED, no write)
 *   5b. parent_sku guard (base=parent_sku → SKIPPED, reparent detail)
 *   6. Inverse diff (captures previous values for rollback)
 *   7. New listing (findFirst=null → channelListing.create with product.connect)
 *   8. Conflict and out-of-scope → SKIPPED, not written
 */

import { describe, it, expect } from 'vitest'
import { applyChanges } from '../apply.js'
import type { ImportDiff, CellChange } from '../diff.js'
import type { ImportScope } from '../scope.js'

// ── Mock Prisma ────────────────────────────────────────────────────────────────

interface MockPrismaOpts {
  /** Value returned by channelListing.findFirst — use null to simulate missing listing. */
  channelListingRow?: Record<string, unknown> | null
  /** Value returned by product.findFirst — used for master changes + soft-delete guard. */
  productRow?: Record<string, unknown> | null
}

function makeMockPrisma(opts: MockPrismaOpts = {}) {
  const calls = {
    channelListingUpdateMany: [] as Array<{ where: any; data: any }>,
    channelListingCreate: [] as Array<{ data: any }>,
    productUpdateMany: [] as Array<{ where: any; data: any }>,
  }

  const prisma = {
    channelListing: {
      findFirst: async (_args: any) =>
        opts.channelListingRow !== undefined ? opts.channelListingRow : null,
      updateMany: async (args: { where: any; data: any }) => {
        calls.channelListingUpdateMany.push(args)
        return { count: 1 }
      },
      create: async (args: { data: any }) => {
        calls.channelListingCreate.push(args)
        return {}
      },
    },
    product: {
      findFirst: async (_args: any) =>
        opts.productRow !== undefined ? opts.productRow : null,
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

const SCOPE_AMAZON_IT: ImportScope = {
  channel: 'AMAZON',
  markets: ['IT'],
  includeMaster: true,
}

function makeEmptyDiff(): ImportDiff {
  return {
    changes: [],
    masterChanges: [],
    deletes: [],
    stats: { adds: 0, updates: 0, deletes: 0, conflicts: 0, outOfScope: 0 },
  }
}

/** Build a channel (Amazon) CellChange with reasonable defaults. */
function makeChannelChange(overrides: Partial<CellChange>): CellChange {
  return {
    sku: 'GALE-M',
    sheet: 'Amazon',
    channel: 'AMAZON',
    market: 'IT',
    column: 'price@IT',
    base: 'price',
    from: 189.9,
    to: '199.9',
    kind: 'update',
    ...overrides,
  } as CellChange
}

/** Build a master (Products sheet) CellChange with reasonable defaults. */
function makeMasterChange(overrides: Partial<CellChange>): CellChange {
  return {
    sku: 'GALE-M',
    sheet: 'Products',
    channel: undefined,
    market: undefined,
    column: 'brand',
    base: 'brand',
    from: 'Xavia',
    to: 'Xavia New',
    kind: 'update',
    ...overrides,
  } as CellChange
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('applyChanges', () => {
  // ── 1. Governed write-back ─────────────────────────────────────────────────
  it('1 — governed price update writes priceOverride + sets followMasterPrice=false', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { followMasterPrice: true, priceOverride: null },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ column: 'price@IT', base: 'price', to: '199.9', kind: 'update' }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(1)
    expect(result.failed).toBe(0)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(1)
    const written = prisma._calls.channelListingUpdateMany[0].data
    expect(written.priceOverride).toBe(199.9)
    expect(written.followMasterPrice).toBe(false)
  })

  // ── 2. Follow-flag true ────────────────────────────────────────────────────
  it('2 — follow-flag to=true writes followMasterPrice=true and priceOverride=null', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { followMasterPrice: false, priceOverride: 250.0 },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          column: 'price_follows_master@IT',
          base: 'price',
          to: 'true',
          kind: 'update',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(1)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(1)
    const written = prisma._calls.channelListingUpdateMany[0].data
    expect(written.followMasterPrice).toBe(true)
    expect(written.priceOverride).toBeNull()
  })

  // ── 3. Non-governed field ──────────────────────────────────────────────────
  it('3 — non-governed field writes to source column directly', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { salePrice: 100.0 },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ column: 'sale_price@IT', base: 'sale_price', to: '89.9', kind: 'update' }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(1)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(1)
    const written = prisma._calls.channelListingUpdateMany[0].data
    expect(written.salePrice).toBe(89.9)
    // Must NOT touch any governed columns
    expect(written.priceOverride).toBeUndefined()
    expect(written.followMasterPrice).toBeUndefined()
  })

  // ── 4. Master field ────────────────────────────────────────────────────────
  it('4 — master (Products sheet) change calls product.updateMany', async () => {
    const prisma = makeMockPrisma({
      productRow: { brand: 'Xavia', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      masterChanges: [
        makeMasterChange({ column: 'brand', base: 'brand', to: 'Xavia New', kind: 'update' }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(1)
    expect(prisma._calls.productUpdateMany).toHaveLength(1)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    const call = prisma._calls.productUpdateMany[0]
    expect(call.where).toEqual({ sku: 'GALE-M' })
    expect(call.data).toEqual({ brand: 'Xavia New' })
  })

  // ── 5. SKU guard ──────────────────────────────────────────────────────────
  it('5 — base=sku is SKIPPED, no write recorded', async () => {
    const prisma = makeMockPrisma()
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ column: 'sku', base: 'sku', to: 'NEW-SKU', kind: 'update' }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
  })

  // ── 5b. parent_sku guard ───────────────────────────────────────────────────
  it('5b — base=parent_sku is SKIPPED with re-parenting detail', async () => {
    const prisma = makeMockPrisma()
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      masterChanges: [
        makeMasterChange({
          column: 'parent_sku',
          base: 'parent_sku',
          to: 'PARENT-SKU',
          kind: 'update',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].detail).toBe('re-parenting via import not supported')
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
  })

  // ── 6. Inverse diff ────────────────────────────────────────────────────────
  it('6 — inverseDiff captures previous governed columns before overwriting', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { followMasterPrice: true, priceOverride: null },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ column: 'price@IT', base: 'price', to: '199.9', kind: 'update' }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.inverseDiff).toHaveLength(1)
    const inv = result.inverseDiff[0]
    expect(inv.model).toBe('ChannelListing')
    expect(inv.sku).toBe('GALE-M')
    expect(inv.channel).toBe('AMAZON')
    expect(inv.market).toBe('IT')
    // Previous state of the governed columns we wrote
    expect(inv.data.priceOverride).toBeNull()
    expect(inv.data.followMasterPrice).toBe(true)
  })

  // ── 7. New listing (create path) ───────────────────────────────────────────
  it('7 — when channelListing does not exist, creates it with product.connect', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: null, // no existing listing
      productRow: { sku: 'NEW-CHILD', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          sku: 'NEW-CHILD',
          column: 'price@IT',
          base: 'price',
          to: '150.0',
          kind: 'add',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(1)
    expect(prisma._calls.channelListingCreate).toHaveLength(1)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    const created = prisma._calls.channelListingCreate[0].data
    expect(created.product).toEqual({ connect: { sku: 'NEW-CHILD' } })
    expect(created.channel).toBe('AMAZON')
    expect(created.marketplace).toBe('IT')
    // Governed field write-back: sets priceOverride + followMasterPrice=false
    expect(created.priceOverride).toBe(150)
    expect(created.followMasterPrice).toBe(false)
  })

  // ── 8. Conflict and out-of-scope skipped ──────────────────────────────────
  it('8 — conflict and out-of-scope changes are SKIPPED; nothing written', async () => {
    const prisma = makeMockPrisma()
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ kind: 'conflict', note: 'Row changed in DB since export' }),
        makeChannelChange({ kind: 'out-of-scope' }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.failed).toBe(0)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(prisma._calls.channelListingCreate).toHaveLength(0)
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
    // Both rows reported
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((r) => r.status === 'SKIPPED')).toBe(true)
  })

  // ── 9. Soft-delete guard ───────────────────────────────────────────────────
  it('9 — add for a soft-deleted product is SKIPPED', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: null,
      productRow: { sku: 'DEAD-SKU', deletedAt: new Date('2026-01-01') },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          sku: 'DEAD-SKU',
          column: 'price@IT',
          base: 'price',
          to: '99.9',
          kind: 'add',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].detail).toBe('skipped: product is soft-deleted (would resurrect)')
    expect(prisma._calls.channelListingCreate).toHaveLength(0)
  })

  // ── 10. delete kind (cell-level __CLEAR__) ────────────────────────────────
  it('10 — delete kind (to="") writes null for the field (cell-level clear)', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { salePrice: 89.9 },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          column: 'sale_price@IT',
          base: 'sale_price',
          to: '',      // __CLEAR__ sentinel emitted as to='' by computeDiff
          kind: 'delete',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.applied).toBe(1)
    const written = prisma._calls.channelListingUpdateMany[0].data
    expect(written.salePrice).toBeNull()
  })
})
