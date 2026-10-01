/**
 * 2026-10-01 — the eBay family clear inside the Owner's bulk-save budget (≤ 15 statements a row), with the same answers.
 * Measured before on 21 rows: 419 statements, of which every family listing paid a guard statement of its own and every
 * later row re-read its own product three times. Here, on PostgreSQL (PGlite) through the real writers:
 *   · every listing guard of one edit is ONE statement, run before any write; a stale token among the family's guards
 *     still refuses the whole edit with that listing's own 409, and every listing stays exactly as it was;
 *   · a variation's family comes from its parent without a relation read, a deleted parent's too;
 *   · the category context reuses the product rows the writer already read, and answers the same.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import pg from 'pg'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkSave } from './bulk-save.service.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'
import { productCategoryContext } from '../pim/product-category-context.js'
import { seedClearEnvironment, seedClearFamily, clearListings, clearUnit, itemSpecifics, COUNTRY_NAME,
  type ClearEnvironment } from '../../test-support/ebay-family-clear-fixture.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }

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
const productReads = (texts: string[]) => texts.filter(text => /^\s*SELECT/i.test(text) && /FROM "public"\."Product"(?!\w)/.test(text)).length

let environment: ClearEnvironment
let fit = ''
beforeAll(() => scoped(async () => {
  environment = await seedClearEnvironment(prisma)
  const group = await prisma.attributeGroup.create({ data: { code: 'shared-reads', label: 'Specifications' } })
  const attribute = await prisma.customAttribute.create({ data: { code: 'shared_fit', label: 'Fit', groupId: group.id, type: 'select' } })
  for (const code of ['slim', 'regular']) await prisma.attributeOption.create({ data: { attributeId: attribute.id, code, label: code } })
  fit = (await prisma.productFamily.create({ data: { code: 'shared-reads-jackets', label: 'Jackets' } })).id
  await prisma.familyAttribute.create({ data: { familyId: fit, attributeId: attribute.id, channels: [] } })
}), 120_000)
afterAll(async () => { await state.db?.close() })

it('checks every listing guard of a family clear in one statement, before any write', async () => {
  const family = await scoped(() => seedClearFamily(prisma, environment, { children: 3 }))
  const before = await scoped(() => clearListings(prisma, family))
  const child = before.find(row => row.productId === family.children[0])!
  const { value: result, texts } = await sent(() => scoped(() => applyProductBulkSave({ units: [clearUnit(family, child)] }, context)))
  expect(result.units.map(unit => unit.status)).toEqual([200])
  const listingWrites = texts.filter(text => /^\s*UPDATE "(public"\.")?ChannelListing"/.test(text))
  // One guard for the four family listings, then each listing's own write: the guard runs first.
  expect(listingWrites.filter(text => /SET "updatedAt" = guard\.at/.test(text))).toHaveLength(1)
  expect(listingWrites.filter(text => /^\s*UPDATE "public"\."ChannelListing" SET "updatedAt"/.test(text))).toHaveLength(0)
  expect(listingWrites).toHaveLength(1 + before.length)
  expect(listingWrites[0]).toMatch(/SET "updatedAt" = guard\.at/)
  for (const row of await scoped(() => clearListings(prisma, family))) {
    expect(itemSpecifics(row)[COUNTRY_NAME] ?? null).toBeNull()
    expect(row.version).toBe(before.find(prior => prior.id === row.id)!.version + 1)
  }
})

it('refuses the whole family clear with the listing\'s own 409 when one guard is stale, and writes nothing', async () => {
  const family = await scoped(() => seedClearFamily(prisma, environment, { children: 3 }))
  const before = await scoped(() => clearListings(prisma, family))
  const child = before.find(row => row.productId === family.children[1])!
  const conflict = { code: 'VERSION_CONFLICT', error: 'Another change landed first on this listing — refresh the scope to pick up the latest version.',
    expectedVersion: child.version - 1, currentVersion: child.version, versionOf: 'channelListing' }
  // Through the sheet's bulk save (the unit's savepoint) and through the single-row writer (its own transaction).
  const saved = await scoped(() => applyProductBulkSave({ units: [clearUnit(family, { ...child, version: child.version - 1 })] }, context))
  expect(saved.units).toEqual([{ key: child.productId, status: 409, body: conflict }])
  const { key: _key, ...unit } = clearUnit(family, { ...child, version: child.version - 1 })
  await expect(scoped(() => applyProductBulkEdits(unit, context))).rejects.toMatchObject({ statusCode: 409, details: conflict })
  expect(await scoped(() => clearListings(prisma, family))).toEqual(before)
})

it('gives a variation its parent\'s family without a relation read, also when that parent is deleted', async () => {
  const outcome = (id: string) => scoped(async () => {
    try {
      const result = await applyProductBulkEdits({ changes: [{ id, field: 'attr_shared_fit', value: 'slim', target: 'master' }] } as never, context) as Record<string, unknown>
      return { updated: result.updated, errors: result.errors ?? [] }
    } catch (error: any) { return { refused: error?.statusCode, errors: error?.details?.errors } }
  })
  const stored = (id: string) => scoped(async () => ((await prisma.product.findUniqueOrThrow({ where: { id } })).categoryAttributes as Record<string, unknown> | null)?.shared_fit)
  /** `SELECT id, familyId FROM Product WHERE id IN (…)`: the parent relation's read, or the deleted parent's own. */
  const familyByIdReads = (texts: string[]) => texts.filter(text => /^\s*SELECT "public"\."Product"\."id", "public"\."Product"\."familyId" FROM "public"\."Product" WHERE/.test(text)).length
  for (const deleted of [false, true]) {
    const parent = await scoped(() => prisma.product.create({ data: { sku: `SHARED-READS-${deleted}`, name: 'Jacket', basePrice: 10, isParent: true, familyId: fit, ...(deleted ? { deletedAt: new Date() } : {}) } }))
    const child = await scoped(() => prisma.product.create({ data: { sku: `SHARED-READS-${deleted}-S`, name: 'Jacket S', basePrice: 10, parentId: parent.id } }))
    const { value, texts } = await sent(() => outcome(child.id))
    expect(value).toEqual({ updated: 1, errors: [] })
    expect(await stored(child.id)).toBe('slim')
    // A live parent is in the family read; only a deleted one is read by id.
    expect(familyByIdReads(texts)).toBe(deleted ? 1 : 0)
  }
  // Control: a variation whose parent has no family is not offered the attribute.
  const parent = await scoped(() => prisma.product.create({ data: { sku: 'SHARED-READS-NONE', name: 'Jacket', basePrice: 10, isParent: true } }))
  const child = await scoped(() => prisma.product.create({ data: { sku: 'SHARED-READS-NONE-S', name: 'Jacket S', basePrice: 10, parentId: parent.id } }))
  expect(await outcome(child.id)).toMatchObject({ refused: 400 })
})

it('answers the category context from the writer\'s own product rows exactly as from a read of them', async () => {
  const family = await scoped(() => seedClearFamily(prisma, environment, { children: 2 }))
  const ids = family.productIds
  const read = (withRows: boolean) => sent(() => scoped(() => inDatabaseTransaction(prisma, async () => {
    const rows = withRows ? await prisma.product.findMany({ where: { id: { in: ids } } }) : undefined
    return productCategoryContext(ids, 'EBAY', family.market, family.accountId, rows)
  })))
  const plain = await read(false), reused = await read(true)
  expect(reused.value).toEqual(plain.value)
  expect(plain.value.categories.length).toBeGreaterThan(0)
  expect(productReads(plain.texts)).toBe(1)
  // The caller's own read only: the context made none of its own.
  expect(productReads(reused.texts)).toBe(1)
})
