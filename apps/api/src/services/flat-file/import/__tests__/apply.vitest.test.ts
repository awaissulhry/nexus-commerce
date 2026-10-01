/**
 * FF2.6a — applyChanges TDD tests.
 *
 * ALL tests use a MOCK prisma. No real DB is touched.
 * The mock records every write call into arrays so tests can assert on them.
 *
 * Suites:
 *   1.   A price cell pins the listing THROUGH the channel price door (2026-10-01; was a raw priceOverride write)
 *   2.   price_follows_master@IT=true hands the listing back through the door (was a raw flag write)
 *   P.   pricing_rule / price_adj_pct cells go through the door; a door refusal is the row's FAILED detail
 *   3.   Non-governed field (sale_price → salePrice column)
 *   4.   Master field (brand → product.updateMany with deletedAt:null guard)
 *   5.   SKU guard (base=sku → SKIPPED, no write)
 *   5b.  parent_sku guard (base=parent_sku → SKIPPED, reparent detail)
 *   6.   Inverse diff (captures previous values for rollback)
 *   7.   New listing (findFirst=null → channelListing.create with product.connect)
 *   8.   Conflict and out-of-scope → SKIPPED, not written
 *   9.   Soft-delete guard (add for soft-deleted product → SKIPPED)
 *   10.  delete kind (to="" writes null for the field)
 *   I1.  New listing create includes required channelMarket + region columns
 *   I4.  Decimal field with non-numeric value → SKIPPED, no write
 *   I5a. Readonly field (READONLY_SYNCED/DERIVED/SYSTEM) slipped into diff → not written
 *   I5b. Out-of-scope market slipped into diff → not written (defensive guard)
 */

import { describe, it, expect } from 'vitest'
import { applyChanges } from '../apply.js'
import type { PriceWriteOutcome } from '../../../pim/channel-price-write.service.js'
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
        return { id: 'created-listing' }
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

/**
 * A stand-in for the ONE channel price door: records what each pricing cell asks of it and answers `outcome`.
 * The real door is exercised against a database in `flat-file-import-prices.vitest.test.ts`.
 */
function fakeDoor(outcome: Partial<PriceWriteOutcome> = {}) {
  const calls: any[] = []
  const writePrices = (async (input: any) => {
    calls.push(input)
    const result = { listingId: input.targets[0].listingId, productId: null, channel: null, marketplace: null,
      outcome: 'applied', version: 2, guarded: false, queueId: 'queue-1', ...outcome }
    return { results: [result], applied: result.outcome === 'applied' ? 1 : 0, refused: result.outcome === 'refused' ? 1 : 0, noop: 0, conflict: 0 }
  }) as any
  return { calls, writePrices }
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
  // 2026-10-01 — this arm pinned the old write: `priceOverride` + `followMasterPrice: false` as raw columns, `price`
  // untouched and nothing queued, so an imported price never reached the channel. Now the cell is a door pin.
  it('1 — a price cell pins the listing through the channel price door; no raw column write', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { id: 'listing-1', followMasterPrice: true, priceOverride: null },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ column: 'price@IT', base: 'price', to: '199.9', kind: 'update' }),
      ],
    }
    const door = fakeDoor()

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT, actor: 'person-1', writePrices: door.writePrices })

    expect(result.applied).toBe(1)
    expect(result.failed).toBe(0)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(door.calls).toHaveLength(1)
    expect(door.calls[0]).toMatchObject({ actor: 'person-1', source: 'BULK_OVERRIDE', tx: prisma })
    expect(door.calls[0].targets).toEqual([{ listingId: 'listing-1', price: 199.9, unguardedReason: 'flat-file-import' }])
  })

  // ── 2. Follow-flag true ────────────────────────────────────────────────────
  // 2026-10-01 — this arm pinned a raw flag write (`followMasterPrice: true`, `priceOverride: null`) with nothing
  // recomputed or sent. Now the flag is the door's follower mode: the price is recomputed by the rule and sent.
  it('2 — price_follows_master=true hands the listing back through the door', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { id: 'listing-2', followMasterPrice: false, priceOverride: 250.0 },
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

    const door = fakeDoor()
    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT, writePrices: door.writePrices })

    expect(result.applied).toBe(1)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(door.calls.map((c) => c.targets)).toEqual([[{ listingId: 'listing-2', follow: true, unguardedReason: 'flat-file-import' }]])

    // 'false' stops following: the door keeps the price (flags only).
    const unfollow = fakeDoor()
    await applyChanges(prisma, { ...diff, changes: [{ ...diff.changes[0], to: 'false' }] }, { scope: SCOPE_AMAZON_IT, writePrices: unfollow.writePrices })
    expect(unfollow.calls[0].targets).toEqual([{ listingId: 'listing-2', follow: false, unguardedReason: 'flat-file-import' }])
  })

  it('P — a pricing rule or percent cell goes through the door; an emptied price hands back; a refusal is the FAILED detail', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { id: 'listing-p', followMasterPrice: true, priceOverride: null },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const cells = [
      makeChannelChange({ column: 'pricing_rule@IT', base: 'pricing_rule', to: 'PERCENT_OF_MASTER', kind: 'update' }),
      makeChannelChange({ column: 'price_adj_pct@IT', base: 'price_adj_pct', to: '12.5', kind: 'update' }),
      makeChannelChange({ column: 'price@IT', base: 'price', to: '', kind: 'delete' }),
    ]
    const door = fakeDoor()
    const result = await applyChanges(prisma, { ...makeEmptyDiff(), changes: cells }, { scope: SCOPE_AMAZON_IT, writePrices: door.writePrices })
    expect(result).toMatchObject({ applied: 3, failed: 0 })
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(door.calls.map((c) => c.targets[0])).toEqual([
      { listingId: 'listing-p', rule: { pricingRule: 'PERCENT_OF_MASTER' }, unguardedReason: 'flat-file-import' },
      { listingId: 'listing-p', rule: { priceAdjustmentPercent: 12.5 }, unguardedReason: 'flat-file-import' },
      { listingId: 'listing-p', price: null, unguardedReason: 'flat-file-import' },
    ])

    // The door refuses (outside the floor): the row FAILS with the door's sentence; nothing is written around it.
    const refusing = fakeDoor({ outcome: 'refused', reason: 'This listing on AMAZON IT would follow the master price +12.5% at 112.50, but 112.50 is above its pricing ceiling of 100.00.' })
    const refused = await applyChanges(prisma, { ...makeEmptyDiff(), changes: [cells[1]] }, { scope: SCOPE_AMAZON_IT, writePrices: refusing.writePrices })
    expect(refused).toMatchObject({ applied: 0, failed: 1 })
    expect(refused.rows[0]).toEqual({ sku: 'GALE-M', status: 'FAILED', detail: expect.stringContaining('pricing ceiling') })
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)

    // An emptied rule cell cannot be stored (the column always holds one): FAILED by name, the door not asked.
    const empty = fakeDoor()
    const emptied = await applyChanges(prisma, { ...makeEmptyDiff(), changes: [makeChannelChange({ column: 'pricing_rule@IT', base: 'pricing_rule', to: '', kind: 'delete' })] }, { scope: SCOPE_AMAZON_IT, writePrices: empty.writePrices })
    expect(emptied.rows[0]).toMatchObject({ status: 'FAILED', detail: expect.stringContaining('cannot be empty') })
    expect(empty.calls).toHaveLength(0)
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
  // M4: product.updateMany where now includes deletedAt:null to skip soft-deleted rows.
  it('4 — master (Products sheet) change calls product.updateMany with deletedAt:null guard', async () => {
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
    // M4: where includes deletedAt:null so soft-deleted products are not updated
    expect(call.where).toEqual({ sku: 'GALE-M', deletedAt: null })
    expect(call.data).toEqual({ brand: 'Xavia New' })
  })

  // ── M. Master price ────────────────────────────────────────────────────────
  it('M — a Products-sheet base_price cell goes through the master-price writer, never a plain Product write', async () => {
    const prisma = makeMockPrisma({ productRow: { id: 'product-m', sku: 'SKU-M', deletedAt: null, basePrice: 189.9 } })
    const calls: Array<[string, number, { actor: string; reason: string }]> = []
    const updateMasterPrice = async (productId: string, price: number, ctx: { tx: unknown; actor: string; reason: string }) => { calls.push([productId, price, { actor: ctx.actor, reason: ctx.reason }]); expect(ctx.tx).toBe(prisma) }
    const cell = makeMasterChange({ sku: 'SKU-M', column: 'base_price', base: 'base_price', from: 189.9, to: '199.9' })
    const result = await applyChanges(prisma, { ...makeEmptyDiff(), masterChanges: [cell] }, { scope: SCOPE_AMAZON_IT, actor: 'person-1', updateMasterPrice })
    expect(result).toMatchObject({ applied: 1, failed: 0 })
    expect(calls).toEqual([['product-m', 199.9, { actor: 'person-1', reason: 'Flat-file import base_price' }]])
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
    expect(result.inverseDiff).toEqual([{ model: 'Product', sku: 'SKU-M', data: { basePrice: 189.9 } }])

    // An emptied master price is refused by name; nothing is written.
    const emptied = await applyChanges(prisma, { ...makeEmptyDiff(), masterChanges: [{ ...cell, to: '', kind: 'delete' }] }, { scope: SCOPE_AMAZON_IT, updateMasterPrice })
    expect(emptied.rows[0]).toMatchObject({ status: 'FAILED', detail: expect.stringContaining('cannot be emptied') })
    expect(calls).toHaveLength(1)
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
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

    const door = fakeDoor()
    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT, writePrices: door.writePrices })

    expect(result.applied).toBe(1)
    expect(prisma._calls.channelListingCreate).toHaveLength(1)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    const created = prisma._calls.channelListingCreate[0].data
    expect(created.product).toEqual({ connect: { sku: 'NEW-CHILD' } })
    expect(created.channel).toBe('AMAZON')
    expect(created.marketplace).toBe('IT')
    // 2026-10-01 — the new listing is created without a price; the door then pins it (was a raw priceOverride).
    expect(created.priceOverride).toBeUndefined()
    expect(door.calls[0].targets).toEqual([{ listingId: 'created-listing', price: 150, unguardedReason: 'flat-file-import' }])
  })

  // ── 8. Conflict policy: db-wins and out-of-scope both skip ──────────────────
  it('8 — conflict(db-wins) and out-of-scope → both SKIPPED; nothing written', async () => {
    const prisma = makeMockPrisma()
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({ kind: 'conflict', note: 'Row changed in DB since export' }),
        makeChannelChange({ kind: 'out-of-scope' }),
      ],
    }

    const result = await applyChanges(prisma, diff, {
      scope: SCOPE_AMAZON_IT,
      conflictPolicy: 'db-wins',
    })

    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.failed).toBe(0)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(prisma._calls.channelListingCreate).toHaveLength(0)
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.every((r) => r.status === 'SKIPPED')).toBe(true)
    // db-wins detail is specific
    const conflictRow = result.rows.find(r => r.detail === 'conflict: kept DB value')
    expect(conflictRow).toBeDefined()
  })

  // ── 8a. Conflict with file-wins → APPLIED ─────────────────────────────────
  it('8a — conflict with file-wins applies the file value (governed write-back)', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { id: 'listing-8a', followMasterPrice: true, priceOverride: null },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          kind: 'conflict',
          to: '199.9',
          note: 'Row changed in DB since export',
        }),
      ],
    }

    const door = fakeDoor()
    const result = await applyChanges(prisma, diff, {
      scope: SCOPE_AMAZON_IT,
      conflictPolicy: 'file-wins',
      writePrices: door.writePrices,
    })

    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(0)
    // The file's price, through the door (2026-10-01; was a raw priceOverride write).
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
    expect(door.calls[0].targets).toEqual([{ listingId: 'listing-8a', price: 199.9, unguardedReason: 'flat-file-import' }])
  })

  // ── 8b. Conflict file-wins on out-of-scope market → still not written ──────
  it('8b — conflict(file-wins) on out-of-scope market DE → not written (defensive guard)', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { salePrice: 100.0 },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          kind: 'conflict',
          column: 'sale_price@DE',
          base: 'sale_price',
          market: 'DE',
          to: '79.9',
          note: 'Row changed in DB since export',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, {
      scope: SCOPE_AMAZON_IT,   // only IT in scope
      conflictPolicy: 'file-wins',
    })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].status).toBe('SKIPPED')
    expect(result.rows[0].detail).toMatch(/scope/i)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
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

  // ── I1. New listing requires channelMarket + region (non-null columns) ─────

  it('I1 — new listing create includes channelMarket and region required columns', async () => {
    const createdArgs: any[] = []

    // Mock that throws if the required non-null columns are absent
    const prisma = {
      channelListing: {
        findFirst: async (_args: any) => null,
        updateMany: async (_args: any) => ({ count: 0 }),
        create: async (args: { data: any }) => {
          if (!args.data.channelMarket) throw new Error('channelMarket is required (non-null)')
          if (!args.data.region) throw new Error('region is required (non-null)')
          createdArgs.push(args)
          return { id: 'new-listing' }
        },
      },
      product: {
        findFirst: async (_args: any) => ({ sku: 'NEW', deletedAt: null }),
        updateMany: async (_args: any) => ({ count: 0 }),
      },
    }

    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          sku: 'NEW',
          column: 'price@IT',
          base: 'price',
          to: '99.9',
          kind: 'add',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT, writePrices: fakeDoor().writePrices })

    // Must succeed (not fall into failed)
    expect(result.applied).toBe(1)
    expect(result.failed).toBe(0)
    // The create was called exactly once with the required columns present
    expect(createdArgs).toHaveLength(1)
    expect(createdArgs[0].data.channelMarket).toBe('AMAZON_IT')
    expect(createdArgs[0].data.region).toBe('IT')
  })

  // ── I4. NaN/blank guard in coerce ─────────────────────────────────────────

  it('I4 — decimal field with non-numeric value (N/A) is SKIPPED; no write', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { salePrice: 100.0 },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        makeChannelChange({
          column: 'sale_price@IT',
          base: 'sale_price',
          to: 'N/A',
          kind: 'update',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].status).toBe('SKIPPED')
    expect(result.rows[0].detail).toContain('non-numeric')
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
  })

  // ── I5a. Readonly field defensive guard ───────────────────────────────────

  it('I5a — readonly master field (fnsku, READONLY_SYNCED) slipped into diff is not written', async () => {
    const prisma = makeMockPrisma({
      productRow: { fnsku: 'X00ABC123', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      // fnsku is READONLY_SYNCED in the master field registry
      masterChanges: [
        makeMasterChange({
          column: 'fnsku',
          base: 'fnsku',
          to: 'HACKED',
          kind: 'update',
        }),
      ],
    }

    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].status).toBe('SKIPPED')
    expect(result.rows[0].detail).toMatch(/readonly|READONLY/i)
    expect(prisma._calls.productUpdateMany).toHaveLength(0)
  })

  // ── I5b. Out-of-scope market defensive guard ──────────────────────────────

  it('I5b — change for market DE slipped into diff when scope is IT-only is not written', async () => {
    const prisma = makeMockPrisma({
      channelListingRow: { salePrice: 100.0 },
      productRow: { sku: 'GALE-M', deletedAt: null },
    })
    const diff: ImportDiff = {
      ...makeEmptyDiff(),
      changes: [
        // market=DE but scope only covers IT
        makeChannelChange({
          column: 'sale_price@DE',
          base: 'sale_price',
          market: 'DE',
          to: '79.9',
          kind: 'update',
        }),
      ],
    }

    // scope only covers IT
    const result = await applyChanges(prisma, diff, { scope: SCOPE_AMAZON_IT })

    expect(result.skipped).toBe(1)
    expect(result.applied).toBe(0)
    expect(result.rows[0].status).toBe('SKIPPED')
    expect(result.rows[0].detail).toMatch(/scope|out.of.scope/i)
    expect(prisma._calls.channelListingUpdateMany).toHaveLength(0)
  })
})
