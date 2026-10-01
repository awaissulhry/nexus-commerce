/**
 * P2 (2026-09-30) — remembered reads inside one snapshot transaction (`transaction-read-memo.ts`), on a real PostgreSQL
 * (PGlite) through the real `inDatabaseTransaction` / `inSavepoint`: a read repeated with nothing written in between is
 * answered from memory, and every write, raw write and savepoint rolled back after a write makes the next read go to
 * the database; a raw read is remembered only when its caller names it a plain read (`rememberedRead`).
 * Then a bulk save of 21 rows: the reads every row repeats are made once per operation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('./queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
import prisma from '../db.js'
import { activeDatabaseTransaction, inDatabaseTransaction, inSavepoint, rememberedRead } from './database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from './workspace-context.js'
import { applyProductBulkSave, type BulkSaveUnit } from '../services/products/bulk-save.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const remembered = <T>(work: () => Promise<T>) => scoped(() => inDatabaseTransaction(prisma, work, { memoReads: true }))

/** The SQL the pg driver sends, one entry per round trip. */
async function sent<T>(work: () => Promise<T>): Promise<{ value: T; texts: string[] }> {
  const original = pg.Client.prototype.query
  const texts: string[] = []
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as { text?: string } | string
    texts.push(typeof first === 'string' ? first : first?.text ?? '?')
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof original
  try { return { value: await work(), texts } } finally { pg.Client.prototype.query = original }
}
const reads = (texts: string[], table: string) => texts.filter(text => /^\s*SELECT/i.test(text) && text.includes(`FROM "public"."${table}"`)).length

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
  await prisma.product.create({ data: { id: 'memo-p', sku: 'MEMO-P', name: 'Before', basePrice: 10 } })
  await prisma.ebayDescriptionTheme.create({ data: { id: 'memo-theme', name: 'memo-theme', html: '<div>{{description}}</div>' } })
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('remembered reads', () => {
  it('answers a repeated read once, with a copy for each asker', async () => {
    const { value: [a, b], texts } = await sent(() => remembered(async () => [
      await prisma.product.findUnique({ where: { id: 'memo-p' }, select: { id: true, name: true } }),
      await prisma.product.findUnique({ where: { id: 'memo-p' }, select: { id: true, name: true } }),
    ]))
    expect(a).toEqual({ id: 'memo-p', name: 'Before' })
    expect(b).toEqual(a)
    expect(b).not.toBe(a)
    expect(reads(texts, 'Product')).toBe(1)
  })

  it('reads again after every kind of write, and sees the write', async () => {
    await remembered(async () => {
      const read = () => prisma.product.findUnique({ where: { id: 'memo-p' }, select: { name: true } })
      expect(await read()).toEqual({ name: 'Before' })
      await prisma.product.update({ where: { id: 'memo-p' }, data: { name: 'Model write' } })
      expect(await read()).toEqual({ name: 'Model write' })
      await prisma.$executeRaw`UPDATE "Product" SET name = ${'Raw write'} WHERE id = ${'memo-p'}`
      expect(await read()).toEqual({ name: 'Raw write' })
      // A read created before a write and awaited after it runs after it, as Prisma's lazy query does.
      const early = read()
      await prisma.product.update({ where: { id: 'memo-p' }, data: { name: 'Before' } })
      expect(await early).toEqual({ name: 'Before' })
    })
  })

  it('keeps a reference read across a product write, and forgets it when a write touches a reference table', async () => {
    const { texts } = await sent(() => remembered(async () => {
      const market = () => prisma.marketplace.findFirst({ where: { channel: 'EBAY', code: 'DE' }, select: { name: true } })
      expect(await market()).toEqual({ name: 'Germany' })
      await prisma.product.update({ where: { id: 'memo-p' }, data: { name: 'Before' } })
      expect(await market()).toEqual({ name: 'Germany' })
      await prisma.marketplace.updateMany({ where: { channel: 'EBAY', code: 'DE' }, data: { name: 'Deutschland' } })
      expect(await market()).toEqual({ name: 'Deutschland' })
      await prisma.marketplace.updateMany({ where: { channel: 'EBAY', code: 'DE' }, data: { name: 'Germany' } })
    }))
    expect(reads(texts, 'Marketplace')).toBe(2)
  })

  it('forgets what a rolled-back savepoint wrote', async () => {
    await remembered(async () => {
      const read = () => prisma.product.findUnique({ where: { id: 'memo-p' }, select: { name: true } })
      const outcome = await inSavepoint(async () => {
        await prisma.product.update({ where: { id: 'memo-p' }, data: { name: 'Undone' } })
        expect(await read()).toEqual({ name: 'Undone' })
        throw new Error('refused')
      })
      expect(outcome.ok).toBe(false)
      expect(await read()).toEqual({ name: 'Before' })
    })
  })

  // 2026-10-01 — a refused platform batch reads a whole family and writes nothing; its rows then read it all again.
  it('keeps what it read across a savepoint, or a nested transaction, that rolled back without writing', async () => {
    const { texts } = await sent(() => remembered(async () => {
      const read = () => prisma.product.findUnique({ where: { id: 'memo-p' }, select: { name: true } })
      const outcome = await inSavepoint(async () => {
        expect(await read()).toEqual({ name: 'Before' })
        throw new Error('refused before any write')
      })
      expect(outcome.ok).toBe(false)
      expect(await read()).toEqual({ name: 'Before' })
      const tx = activeDatabaseTransaction() as unknown as { $transaction: (work: (inner: typeof prisma) => Promise<unknown>) => Promise<unknown> }
      await expect(tx.$transaction(async inner => {
        expect(await inner.product.findUnique({ where: { id: 'memo-p' }, select: { name: true } })).toEqual({ name: 'Before' })
        throw new Error('undo nothing')
      })).rejects.toThrow('undo nothing')
      expect(await read()).toEqual({ name: 'Before' })
    }))
    expect(reads(texts, 'Product')).toBe(1)
  })

  it('remembers a raw read its caller names a plain read, until the next write', async () => {
    const { texts } = await sent(() => remembered(async () => {
      const name = () => rememberedRead(`memo-name:memo-p`, () => prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM "Product" WHERE id = ${'memo-p'}`)
      expect(await name()).toEqual([{ name: 'Before' }])
      expect(await name()).toEqual([{ name: 'Before' }])
      await prisma.$executeRaw`UPDATE "Product" SET name = ${'Raw named'} WHERE id = ${'memo-p'}`
      expect(await name()).toEqual([{ name: 'Raw named' }])
      await prisma.product.update({ where: { id: 'memo-p' }, data: { name: 'Before' } })
      expect(await name()).toEqual([{ name: 'Before' }])
    }))
    expect(texts.filter(text => /^\s*SELECT name FROM "Product"/.test(text)).length).toBe(3)
    // Outside a remembering transaction the read simply runs, every time.
    const { texts: plain } = await sent(() => scoped(() => inDatabaseTransaction(prisma, async () => {
      for (let i = 0; i < 2; i++) await rememberedRead(`memo-name:memo-p`, () => prisma.$queryRaw`SELECT name FROM "Product" WHERE id = ${'memo-p'}`)
    })))
    expect(plain.filter(text => /^\s*SELECT name FROM "Product"/.test(text)).length).toBe(2)
  })

  it('is refused outside a snapshot transaction', async () => {
    await expect(scoped(() => inDatabaseTransaction(prisma, async () => 1, { memoReads: true, isolationLevel: 'ReadCommitted' }))).rejects.toThrow('snapshot transaction')
  })
})

describe('remembered reads — code review P2 (findings 6 and 7)', () => {
  // A reference-table read that looks through a relation depends on product rows: a product write must make it read again.
  it('reads a reference table again after a product write when the read looks through a relation', async () => {
    await scoped(() => prisma.productFamily.create({ data: { id: 'memo-family', code: 'memo-family', label: 'Memo family' } }))
    try {
      await remembered(async () => {
        const byProduct = () => prisma.productFamily.findMany({ where: { products: { some: { id: 'memo-p' } } }, select: { id: true } })
        const counted = () => prisma.productFamily.findUnique({ where: { id: 'memo-family' }, select: { _count: { select: { products: true } } } })
        const included = () => prisma.productFamily.findUnique({ where: { id: 'memo-family' }, include: { products: { select: { id: true } } } })
        expect(await byProduct()).toEqual([])
        expect(await counted()).toEqual({ _count: { products: 0 } })
        expect((await included())?.products).toEqual([])
        await prisma.product.update({ where: { id: 'memo-p' }, data: { familyId: 'memo-family' } })
        expect(await byProduct()).toEqual([{ id: 'memo-family' }])
        expect(await counted()).toEqual({ _count: { products: 1 } })
        expect((await included())?.products).toEqual([{ id: 'memo-p' }])
        await prisma.product.update({ where: { id: 'memo-p' }, data: { familyId: null } })
      })
    } finally { await scoped(() => prisma.productFamily.delete({ where: { id: 'memo-family' } })) }
  })

  it('reads raw SQL again after a product write when it joins a product table with a comma', async () => {
    await scoped(() => prisma.productFamily.create({ data: { id: 'memo-family-raw', code: 'memo-family-raw', label: 'Memo family raw' } }))
    try {
      await remembered(async () => {
        const joined = () => prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "ProductFamily" f, "Product" p WHERE p."familyId" = f.id AND f.id = ${'memo-family-raw'}`
        expect(await joined()).toEqual([{ n: 0 }])
        await prisma.product.update({ where: { id: 'memo-p' }, data: { familyId: 'memo-family-raw' } })
        expect(await joined()).toEqual([{ n: 1 }])
        await prisma.product.update({ where: { id: 'memo-p' }, data: { familyId: null } })
      })
    } finally { await scoped(() => prisma.productFamily.delete({ where: { id: 'memo-family-raw' } })) }
  })

  // A nested interactive transaction is a savepoint: when it throws, its writes are undone, and so must be what was read after them.
  it('forgets what a nested transaction read after its own writes when that transaction rolls back', async () => {
    await remembered(async () => {
      const read = () => prisma.product.findUnique({ where: { id: 'memo-p' }, select: { name: true } })
      const tx = activeDatabaseTransaction() as unknown as { $transaction: (work: (inner: typeof prisma) => Promise<unknown>) => Promise<unknown> }
      await expect(tx.$transaction(async inner => {
        await inner.product.update({ where: { id: 'memo-p' }, data: { name: 'Rolled back' } })
        expect(await inner.product.findUnique({ where: { id: 'memo-p' }, select: { name: true } })).toEqual({ name: 'Rolled back' })
        throw new Error('undo')
      })).rejects.toThrow('undo')
      expect(await read()).toEqual({ name: 'Before' })
    })
  })
})

describe('a bulk save of 21 rows', () => {
  it('reads what every row shares once per operation, and saves every row', async () => {
    const kids = Array.from({ length: 21 }, (_, i) => `memo-kid-${String(i).padStart(2, '0')}`)
    await scoped(async () => {
      await prisma.product.create({ data: { id: 'memo-parent', sku: 'MEMO-PARENT', name: 'memo-parent', basePrice: 10, isParent: true } })
      await prisma.product.createMany({ data: kids.map(id => ({ id, sku: id.toUpperCase(), name: id, basePrice: 10, parentId: 'memo-parent' })) })
      await prisma.channelListing.createMany({ data: kids.map(productId => ({ id: `l-${productId}`, productId, channel: 'EBAY', channelMarket: 'EBAY_DE', marketplace: 'DE', region: 'EU' })) })
    })
    const units: BulkSaveUnit[] = kids.map(productId => ({
      key: `EBAY:DE::${productId}`, expectedVersion: 1,
      changes: [{ id: productId, field: 'attr_descriptionThemeId', value: 'memo-theme', target: 'channel', intent: 'set' } as never],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', locale: 'de', aliasKey: '' }],
    }))
    const { value: result, texts } = await sent(() => scoped(() => applyProductBulkSave({ operationId: 'memo-op', units }, { logger: { warn: vi.fn(), error: vi.fn() } } as never)))
    expect(result.saved).toBe(21)
    const themes = await scoped(() => prisma.channelListing.findMany({ where: { productId: { in: kids } }, select: { platformAttributes: true } }))
    expect(themes.every(row => (row.platformAttributes as { descriptionThemeId?: string }).descriptionThemeId === 'memo-theme')).toBe(true)
    // Measured on this fixture: 90 marketplace reads and 71 statements a row without remembered reads; 6 and 39 with.
    expect(reads(texts, 'Marketplace')).toBeLessThanOrEqual(10)
    expect(texts.length / 21).toBeLessThan(45)
  }, 60_000)
})
