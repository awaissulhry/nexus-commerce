/**
 * P2 (2026-09-30) — remembered reads inside one snapshot transaction (`transaction-read-memo.ts`), on a real PostgreSQL
 * (PGlite) through the real `inDatabaseTransaction` / `inSavepoint`: a read repeated with nothing written in between is
 * answered from memory, and every write, raw write and rolled-back savepoint makes the next read go to the database.
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
import { inDatabaseTransaction, inSavepoint } from './database-context.js'
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

  it('is refused outside a snapshot transaction', async () => {
    await expect(scoped(() => inDatabaseTransaction(prisma, async () => 1, { memoReads: true, isolationLevel: 'ReadCommitted' }))).rejects.toThrow('snapshot transaction')
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
