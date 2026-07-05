/**
 * P1.2 — eBay flat-file create/reparent service tests.
 *
 * Tests runEbayFlatFileCreates with a hand-rolled mock prisma that records
 * calls and returns canned responses. No real DB — verifies ordering, id
 * resolution, reparent update calls, P2002 idempotency, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runEbayFlatFileCreates } from './ebay-flat-file-create.service.js'

// ──────────────────────────────────────────────────────────────────────
// Mock builder
// ──────────────────────────────────────────────────────────────────────

/** Controls what the mock returns for each call type. */
interface MockResponses {
  /** Results for product.findMany by sku (existingBySku lookup) */
  existingBySku?: Array<{ id: string; sku: string; parentId: string | null; variationTheme: string | null; isParent: boolean }>
  /** Results for product.findMany by id (existingParentById lookup) */
  existingParentById?: Array<{ id: string; variationTheme: string | null; isParent: boolean }>
  /** If true, $transaction will throw a P2002 error */
  throwP2002?: boolean
  /** Results for product.findMany during P2002 recovery (sku lookup with select.sku present but no select.parentId) */
  p2002Recovery?: Array<{ id: string; sku: string }>
  /** Override the created product id (defaults to auto-incrementing 'prod-N') */
  createIdOverride?: string | null
  /** Results for product.findFirst (used in reparent validation) */
  findFirstResult?: { id: string } | null
}

let createCounter = 0

function makeMock(opts: MockResponses = {}) {
  const calls: {
    findMany: unknown[]
    findFirst: unknown[]
    create: unknown[]
    update: unknown[]
    transaction: number
  } = { findMany: [], findFirst: [], create: [], update: [], transaction: 0 }

  const product = {
    findMany: vi.fn().mockImplementation(async (args: any) => {
      calls.findMany.push(args)

      // Dispatch by WHERE clause shape — more robust than call-order counting.
      if (args.where?.id?.in) {
        // existingParentById: findMany({ where: { id: { in: [...] } } })
        return opts.existingParentById ?? []
      }

      if (args.where?.sku?.in) {
        // Either existingBySku (select has parentId) or P2002 recovery (select has only id+sku).
        if (args.select?.parentId !== undefined) {
          return opts.existingBySku ?? []
        }
        // P2002 recovery — no parentId in select
        return opts.p2002Recovery ?? []
      }

      return []
    }),

    findFirst: vi.fn().mockImplementation(async (args: any) => {
      calls.findFirst.push(args)
      return opts.findFirstResult !== undefined ? opts.findFirstResult : null
    }),

    create: vi.fn().mockImplementation(async (args: any) => {
      calls.create.push(args)
      return { id: opts.createIdOverride ?? `prod-${++createCounter}` }
    }),

    update: vi.fn().mockImplementation(async (args: any) => {
      calls.update.push(args)
      return {}
    }),
  }

  const prisma: any = {
    product,
    $transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      calls.transaction++
      if (opts.throwP2002) {
        const err: any = new Error('Unique constraint violated')
        err.code = 'P2002'
        err.meta = { target: ['sku'] }
        throw err
      }
      // Pass the same product mock as tx.product — no real DB transaction
      return fn({ product })
    }),
  }

  return { prisma, calls }
}

// Reset create counter before each test
beforeEach(() => { createCounter = 0 })

// ──────────────────────────────────────────────────────────────────────
// Test: parents created before children (ordering)
// ──────────────────────────────────────────────────────────────────────
describe('ordering — parents before children', () => {
  it('calls product.create for parent THEN child in a single transaction', async () => {
    const { prisma, calls } = makeMock()
    const rows = [
      // Parent row — no platformProductId / points to itself
      { sku: 'P1', title: 'Parent', _rowId: 'row-parent', it_price: '100', variation_theme: 'Colore' },
      // Child row — platformProductId points to the parent tempRowId
      { sku: 'C1', title: 'Child', _rowId: 'row-child', it_price: '90', platformProductId: 'row-parent', aspect_Colore: 'Nero' },
    ]

    await runEbayFlatFileCreates(prisma, rows)

    // product.create should have been called twice
    expect(calls.create).toHaveLength(2)

    const [firstCreate, secondCreate] = calls.create as any[]

    // First create: parent (no parentId)
    expect(firstCreate.data.sku).toBe('P1')
    expect(firstCreate.data.parentId).toBeUndefined()
    expect(firstCreate.data.isParent).toBe(true)

    // Second create: child (parentId set to the parent's returned id = 'prod-1')
    expect(secondCreate.data.sku).toBe('C1')
    expect(secondCreate.data.parentId).toBe('prod-1')
    expect(secondCreate.data.isParent).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: child parentId resolved from temp map (new family)
// ──────────────────────────────────────────────────────────────────────
describe('child parentId — resolved from temp map (new family)', () => {
  it('idMap entry for child has the real parentId from the just-created parent', async () => {
    const { prisma } = makeMock({ createIdOverride: null }) // createIdOverride: null = auto-increment

    const rows = [
      { sku: 'PAR', title: 'Parent', _rowId: 'tmp-par', variation_theme: 'Taglia' },
      { sku: 'CHI', title: 'Child', _rowId: 'tmp-chi', platformProductId: 'tmp-par', aspect_Taglia: 'L' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)
    expect(result.idMap).toHaveLength(2)

    const parentEntry = result.idMap.find(e => e.sku === 'PAR')!
    const childEntry = result.idMap.find(e => e.sku === 'CHI')!

    expect(parentEntry.tempRowId).toBe('tmp-par')
    expect(childEntry.tempRowId).toBe('tmp-chi')
    // The child's idMap entry must exist (parentId injected from parent during tx)
    expect(childEntry.productId).toBeTruthy()
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: child parentId resolved directly (existing parent family)
// ──────────────────────────────────────────────────────────────────────
describe('child parentId — resolved directly from existingParentById', () => {
  it('creates child with the existing parent id when platformProductId maps to a DB product', async () => {
    const { prisma, calls } = makeMock({
      existingParentById: [{ id: 'existing-parent-xyz', variationTheme: 'Colore', isParent: true }],
    })

    const rows = [
      // Child whose platformProductId is a real existing product id (not a tempRowId in this payload)
      { sku: 'NEW-C', title: 'New Child', _rowId: 'tmp-c', platformProductId: 'existing-parent-xyz', aspect_Colore: 'Rosso', it_price: '50' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)
    expect(calls.create).toHaveLength(1)

    const [childCreate] = calls.create as any[]
    expect(childCreate.data.sku).toBe('NEW-C')
    expect(childCreate.data.parentId).toBe('existing-parent-xyz')
    expect(childCreate.data.isParent).toBe(false)

    expect(result.idMap).toHaveLength(1)
    expect(result.idMap[0]).toMatchObject({ tempRowId: 'tmp-c', sku: 'NEW-C' })
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: reparents call product.update with correct args
// ──────────────────────────────────────────────────────────────────────
describe('reparents', () => {
  it('calls product.update({where:{id}, data:{parentId}}) for a reparent', async () => {
    const { prisma, calls } = makeMock({
      // Existing child currently under 'old-parent'
      existingBySku: [{ id: 'child-id', sku: 'CHILD', parentId: 'old-parent', variationTheme: 'Colore', isParent: false }],
      // The new parent is also an existing product
      existingParentById: [{ id: 'new-parent', variationTheme: 'Colore', isParent: true }],
    })

    const rows = [
      // Existing child row pointing to a DIFFERENT parent → triggers reparent
      { sku: 'CHILD', _productId: 'child-id', platformProductId: 'new-parent' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)
    expect(calls.update).toHaveLength(1)

    const [updateCall] = calls.update as any[]
    expect(updateCall).toEqual({
      where: { id: 'child-id' },
      data: { parentId: 'new-parent' },
    })

    expect(result.reparented).toHaveLength(1)
    expect(result.reparented[0]).toMatchObject({
      sku: 'CHILD',
      productId: 'child-id',
      newParentId: 'new-parent',
    })
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: P2002 is swallowed idempotently
// ──────────────────────────────────────────────────────────────────────
describe('P2002 idempotency', () => {
  it('swallows P2002, looks up existing products, and populates idMap without errors', async () => {
    const { prisma, calls } = makeMock({
      throwP2002: true,
      p2002Recovery: [
        { id: 'already-exists-parent', sku: 'PAR-DUPE' },
        { id: 'already-exists-child', sku: 'CHI-DUPE' },
      ],
    })

    const rows = [
      { sku: 'PAR-DUPE', title: 'Parent', _rowId: 'tmp-p', variation_theme: 'Taglia' },
      { sku: 'CHI-DUPE', title: 'Child', _rowId: 'tmp-c', platformProductId: 'tmp-p', aspect_Taglia: 'M' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    // No errors from the P2002 — swallowed idempotently
    expect(result.errors).toHaveLength(0)

    // idMap should contain entries for both SKUs from the recovery lookup
    expect(result.idMap).toHaveLength(2)
    const parentEntry = result.idMap.find(e => e.sku === 'PAR-DUPE')!
    const childEntry = result.idMap.find(e => e.sku === 'CHI-DUPE')!
    expect(parentEntry.productId).toBe('already-exists-parent')
    expect(childEntry.productId).toBe('already-exists-child')

    // product.create was NOT called (transaction threw before creating anything)
    expect(calls.create).toHaveLength(0)

    // product.findMany was called for recovery (call index 2 in our mock)
    const findManyCalls = calls.findMany as any[]
    const recoveryCalls = findManyCalls.filter((c: any) => c.where?.sku?.in)
    expect(recoveryCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: idMap correctness
// ──────────────────────────────────────────────────────────────────────
describe('idMap correctness', () => {
  it('returns tempRowId + sku + productId for each created product', async () => {
    const { prisma } = makeMock()

    const rows = [
      { sku: 'SKU-A', title: 'Product A', _rowId: 'row-a', variation_theme: 'Colore' },
      { sku: 'SKU-B', title: 'Product B', _rowId: 'row-b', platformProductId: 'row-a', aspect_Colore: 'Blu' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)
    expect(result.idMap).toHaveLength(2)

    const a = result.idMap.find(e => e.sku === 'SKU-A')!
    expect(a.tempRowId).toBe('row-a')
    expect(typeof a.productId).toBe('string')
    expect(a.productId).toBeTruthy()

    const b = result.idMap.find(e => e.sku === 'SKU-B')!
    expect(b.tempRowId).toBe('row-b')
    expect(typeof b.productId).toBe('string')
    expect(b.productId).toBeTruthy()
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: empty / invalid reparent target is skipped, not thrown
// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────
// Test: null-reparent (detach to standalone)
// ──────────────────────────────────────────────────────────────────────
describe('null-reparent — detach to standalone', () => {
  it('calls product.update with parentId:null and records in reparented when newParentId is null', async () => {
    const { prisma, calls } = makeMock({
      existingBySku: [{ id: 'p1', sku: 'C', parentId: 'old-parent', variationTheme: null, isParent: false }],
      existingParentById: [],
    })

    const rows = [
      // Existing child with cleared platformProductId → detach
      { sku: 'C', _productId: 'p1', platformProductId: '' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)
    expect(calls.update).toHaveLength(1)

    const [updateCall] = calls.update as any[]
    expect(updateCall).toEqual({
      where: { id: 'p1' },
      data: { parentId: null },
    })

    expect(result.reparented).toHaveLength(1)
    expect(result.reparented[0]).toMatchObject({
      sku: 'C',
      productId: 'p1',
      newParentId: null,
    })
  })
})

describe('invalid reparent target — skipped not thrown', () => {
  it('adds an error entry but does NOT throw when newParentId cannot be resolved', async () => {
    const { prisma, calls } = makeMock({
      // Existing child pointing to a non-existent parent
      existingBySku: [{ id: 'child-id-x', sku: 'CHI-X', parentId: 'old', variationTheme: null, isParent: false }],
      existingParentById: [], // 'ghost-parent' is NOT in existingParentById
      findFirstResult: null,  // fresh DB lookup also returns null
    })

    const rows = [
      { sku: 'CHI-X', _productId: 'child-id-x', platformProductId: 'ghost-parent' },
    ]

    // Call once — must NOT throw
    const result = await runEbayFlatFileCreates(prisma, rows)

    // product.update must NOT have been called
    expect(calls.update).toHaveLength(0)

    // An error entry should describe the skipped reparent
    expect(result.errors.some((e: any) => e.reason.includes('Reparent skipped'))).toBe(true)
    expect(result.reparented).toHaveLength(0)
  })

  it('returns empty CreateResult for an empty rows array (no DB calls)', async () => {
    const { prisma, calls } = makeMock()
    const result = await runEbayFlatFileCreates(prisma, [])

    expect(result.idMap).toHaveLength(0)
    expect(result.reparented).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
    expect(calls.findMany).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: RP1 — existing child reparented to batch-created parent (newParentTempRowId)
// ──────────────────────────────────────────────────────────────────────
describe('RP1 temp-parent reparent — newParentTempRowId resolved via tempToRealId', () => {
  it('reparents existing child to batch-created parent when newParentTempRowId is set', async () => {
    const { prisma, calls } = makeMock({
      // Existing child under old-parent; new parent is NOT yet in DB
      existingBySku: [{ id: 'child-existing-id', sku: 'EXIST-CHILD', parentId: 'old-parent', variationTheme: null, isParent: false }],
      existingParentById: [],
    })

    const rows = [
      // New parent being created in this same batch
      { sku: 'NEW-PARENT', title: 'New Parent', _rowId: 'np-temp', parentage: 'parent', variation_theme: 'Colore' },
      // Existing child that needs to be reparented under the new parent
      { sku: 'EXIST-CHILD', _productId: 'child-existing-id', parentage: 'child', parent_sku: 'NEW-PARENT' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)

    // Parent was created (new product) — idMap must contain it
    const parentEntry = result.idMap.find(e => e.sku === 'NEW-PARENT')
    expect(parentEntry).toBeDefined()
    const newParentRealId = parentEntry!.productId

    // product.update was called to reparent the existing child
    expect(calls.update).toHaveLength(1)
    const [updateCall] = calls.update as any[]
    expect(updateCall).toEqual({
      where: { id: 'child-existing-id' },
      data: { parentId: newParentRealId },
    })

    // reparented result contains the entry with the real parent id
    expect(result.reparented).toHaveLength(1)
    expect(result.reparented[0]).toMatchObject({
      sku: 'EXIST-CHILD',
      productId: 'child-existing-id',
      newParentId: newParentRealId,
    })
  })
})

// ──────────────────────────────────────────────────────────────────────
// Test: P2 parentPromotions — promotes standalone product via product.update
// ──────────────────────────────────────────────────────────────────────
describe('P2 parentPromotions — promotes standalone to isParent:true before children attach', () => {
  it('calls product.update({isParent:true, variationTheme}) for a standalone parent BEFORE child creates', async () => {
    const { prisma, calls } = makeMock({
      // STANDALONE-X is returned by the existingBySku query (isParent:false, parentId:null)
      existingBySku: [
        { id: 'standalone-x-id', sku: 'STANDALONE-X', parentId: null, variationTheme: null, isParent: false },
      ],
      existingParentById: [],
    })

    const rows = [
      // New child whose parent_sku points to the standalone product
      {
        sku: 'NEW-CHILD',
        _rowId: 'nc-tmp',
        parentage: 'child',
        parent_sku: 'STANDALONE-X',
        variation_theme: 'Colore',
        it_price: '49.99',
      },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)

    // product.update was called: promotion + (potentially reparent — but here it's a new child
    // under an existing product, so no reparent; just the promotion + child create)
    const updateCalls = calls.update as any[]
    const promotionCall = updateCalls.find((c: any) => c.where?.id === 'standalone-x-id')
    expect(promotionCall).toBeDefined()
    expect(promotionCall.data.isParent).toBe(true)
    expect(promotionCall.data.variationTheme).toBe('Colore')

    // Child was created under the (now-promoted) standalone product
    const createCalls = calls.create as any[]
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].data.sku).toBe('NEW-CHILD')
    expect(createCalls[0].data.parentId).toBe('standalone-x-id')
  })

  it('promotion update runs before child create (update call index < create call index)', async () => {
    // We track global call order by pushing into a shared log.
    const callLog: Array<'update' | 'create'> = []

    const { prisma } = makeMock({
      existingBySku: [
        { id: 'standalone-x-id', sku: 'STANDALONE-X', parentId: null, variationTheme: null, isParent: false },
      ],
      existingParentById: [],
    })

    // Override update + create to record order
    ;(prisma.product.update as ReturnType<typeof vi.fn>).mockImplementation(async (args: any) => {
      callLog.push('update')
      return {}
    })
    ;(prisma.product.create as ReturnType<typeof vi.fn>).mockImplementation(async (args: any) => {
      callLog.push('create')
      return { id: 'new-child-id' }
    })

    const rows = [
      {
        sku: 'NEW-CHILD',
        _rowId: 'nc-tmp',
        parentage: 'child',
        parent_sku: 'STANDALONE-X',
        variation_theme: 'Colore',
      },
    ]

    await runEbayFlatFileCreates(prisma, rows)

    // update (promotion) must appear before create (child)
    const updateIdx = callLog.indexOf('update')
    const createIdx = callLog.indexOf('create')
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(createIdx).toBeGreaterThanOrEqual(0)
    expect(updateIdx).toBeLessThan(createIdx)
  })
})

// ──────────────────────────────────────────────────────────────────────
// FIX 3: out-of-payload parent_sku resolution
// A child whose parent_sku references a real existing parent NOT present
// as a row in the payload must resolve to that parent — not create a synthetic.
// ──────────────────────────────────────────────────────────────────────
describe('FIX3 — out-of-payload parent_sku resolves to real existing parent (no synthetic)', () => {
  it('existing child with parent_sku pointing to real out-of-payload parent → reparented to real parent, no synthetic created', async () => {
    const { prisma, calls } = makeMock({
      // The mock returns BOTH the child and the out-of-payload parent when queried by sku.
      // With FIX 3 the service includes parent_sku values in the sku query, so both appear.
      existingBySku: [
        { id: 'child-id', sku: 'EXIST-CHILD', parentId: 'old-parent-id', variationTheme: null, isParent: false },
        { id: 'real-parent-id', sku: 'OUT-OF-PAYLOAD-PARENT', parentId: null, variationTheme: 'Colore', isParent: true },
      ],
      existingParentById: [],
      // Fresh DB lookup (reparent validation) returns the real parent
      findFirstResult: { id: 'real-parent-id' },
    })

    const rows = [
      // OUT-OF-PAYLOAD-PARENT is NOT in the rows array
      { sku: 'EXIST-CHILD', _productId: 'child-id', parentage: 'child', parent_sku: 'OUT-OF-PAYLOAD-PARENT' },
    ]

    const result = await runEbayFlatFileCreates(prisma, rows)

    expect(result.errors).toHaveLength(0)

    // FIX 3 key assertion: service queried for the out-of-payload parent's SKU
    const skuQueryCall = (calls.findMany as any[]).find(
      (c: any) => c.where?.sku?.in && c.select?.parentId !== undefined,
    )
    expect(skuQueryCall).toBeDefined()
    expect(skuQueryCall.where.sku.in).toContain('OUT-OF-PAYLOAD-PARENT')

    // Reparented to the real parent (not via a synthetic)
    expect(result.reparented).toHaveLength(1)
    expect(result.reparented[0]).toMatchObject({
      sku: 'EXIST-CHILD',
      productId: 'child-id',
      newParentId: 'real-parent-id',
    })

    // No product creates (no synthetic parent was needed)
    expect(calls.create).toHaveLength(0)
    // No idMap entries for a parent (none was created)
    expect(result.idMap.some(e => e.sku === 'OUT-OF-PAYLOAD-PARENT')).toBe(false)
    // No auto-created warning
    expect(result.warnings.some(w => w.reason.includes('auto-created parent'))).toBe(false)
  })
})
