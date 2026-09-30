/**
 * A master attribute write moves `Product.version` and `updatedAt` like the other product writes (2026-09-30).
 *
 * The attribute merge is raw SQL, so neither Prisma's `@updatedAt` nor the version CAS moved anything on a tokenless
 * write: a bulk attribute change left `version` and `updatedAt` as they were. Then
 *   - an edit opened before it (the studio, token = the old version) passed the CAS and overwrote it unseen, and
 *   - the product list ETags (count + newest `updatedAt`) kept answering 304 with the old attributes.
 * A token write still moves the version by exactly one, a merge that stores the same attributes moves nothing, and
 * a tokenless write of any other field keeps its old behaviour (no version bump).
 *
 * Runs the real `applyProductBulkEdits` on PostgreSQL (PGlite) and reads what was STORED.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits, setBasedAttrMerges } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const PAST = new Date('2026-01-01T00:00:00.000Z')
let familyId = ''

beforeAll(() => scoped(async () => {
  const group = await prisma.attributeGroup.create({ data: { code: 'version-bump', label: 'Specifications' } })
  const pockets = await prisma.customAttribute.create({ data: { code: 'number_of_pockets', label: 'Pockets', groupId: group.id, type: 'number' } })
  const lining = await prisma.customAttribute.create({ data: { code: 'lining', label: 'Lining', groupId: group.id, type: 'text' } })
  const size = await prisma.customAttribute.create({ data: { code: 'size', label: 'Size', groupId: group.id, type: 'text', scope: 'per_variant' } })
  familyId = (await prisma.productFamily.create({ data: { code: 'version-bump-jackets', label: 'Jackets' } })).id
  for (const attributeId of [pockets.id, lining.id, size.id]) await prisma.familyAttribute.create({ data: { familyId, attributeId, channels: [] } })
}), 60_000)
afterAll(async () => { await state.db?.close() })

/** A product at version 2, last changed long ago, so a move of either is unmistakable. */
const seed = (sku: string, extra: Record<string, unknown> = {}) => scoped(async () => (await prisma.product.create({ data: {
  sku, name: sku, basePrice: 10, familyId, version: 2, updatedAt: PAST, categoryAttributes: { lining: 'Mesh' }, ...extra,
} as never })).id)
const row = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, select: { version: true, updatedAt: true, categoryAttributes: true, brand: true } }))
const write = (changes: Array<{ id: string; field: string; value: unknown }>, expectedVersion?: number) => scoped(async () => {
  try {
    return await applyProductBulkEdits({ changes: changes.map((c) => ({ ...c, target: 'master' })), ...(expectedVersion !== undefined ? { expectedVersion } : {}) } as never,
      { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }) as any
  } catch (error: any) { return { status: error?.statusCode, body: error?.details } }
})

it('a tokenless bulk attribute change moves each product’s version and updatedAt, so an edit opened before it is refused', async () => {
  const a = await seed('VERSION-BULK-A'), b = await seed('VERSION-BULK-B')
  expect(await write([{ id: a, field: 'attr_number_of_pockets', value: 4 }, { id: b, field: 'attr_number_of_pockets', value: 4 }])).toMatchObject({ updated: 2 })
  for (const id of [a, b]) {
    const stored = await row(id)
    expect(stored.categoryAttributes).toEqual({ lining: 'Mesh', number_of_pockets: 4 })
    expect(stored.version).toBe(3)
    expect(stored.updatedAt.getTime()).toBeGreaterThan(PAST.getTime())
  }
  // The studio opened product A at version 2, before the bulk change, and saves the same attribute.
  expect(await write([{ id: a, field: 'attr_number_of_pockets', value: 3 }], 2)).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } })
  expect((await row(a)).categoryAttributes).toEqual({ lining: 'Mesh', number_of_pockets: 4 })
  // Control: with the version it reads now, the same save goes through.
  expect(await write([{ id: a, field: 'attr_number_of_pockets', value: 3 }], 3)).toMatchObject({ updated: 1, currentVersion: 4 })
  expect((await row(a)).categoryAttributes).toEqual({ lining: 'Mesh', number_of_pockets: 3 })
})

it('a token attribute write moves the version by exactly one (the check bumps it, the merge does not again)', async () => {
  const id = await seed('VERSION-TOKEN')
  expect(await write([{ id, field: 'attr_lining', value: 'Cotton' }], 2)).toMatchObject({ updated: 1, currentVersion: 3 })
  const stored = await row(id)
  expect(stored).toMatchObject({ version: 3, categoryAttributes: { lining: 'Cotton' } })
  expect(stored.updatedAt.getTime()).toBeGreaterThan(PAST.getTime())
})

it('a variation-axis attribute write moves them too (the per-product statement)', async () => {
  const parent = await seed('VERSION-AXIS-PARENT', { isParent: true, variationAxes: ['Taglia'], categoryAttributes: {} })
  const child = await seed('VERSION-AXIS-CHILD', { parentId: parent, categoryAttributes: { variations: { Size: 'L' } } })
  expect(await write([{ id: child, field: 'attr_size', value: 'XL' }])).toMatchObject({ updated: 1 })
  const stored = await row(child)
  expect((stored.categoryAttributes as any).variations).toMatchObject({ Size: 'XL' })
  expect(stored.version).toBe(3)
  expect(stored.updatedAt.getTime()).toBeGreaterThan(PAST.getTime())
})

it('a merge that stores the same attributes moves neither', async () => {
  const id = await seed('VERSION-SAME')
  // Straight to the statement: the writer drops a same-value change before it gets here.
  await scoped(async () => { for (const statement of setBasedAttrMerges([{ id, patch: { lining: 'Mesh' }, remove: [] }], () => { throw new Error('no axis merge expected') }, new Map())) await statement })
  expect(await row(id)).toMatchObject({ version: 2, updatedAt: PAST, categoryAttributes: { lining: 'Mesh' } })
})

it('keeps the old behaviour for a tokenless write of any other field: no version bump', async () => {
  const id = await seed('VERSION-OTHER-FIELD')
  expect(await write([{ id, field: 'brand', value: 'Xavia' }])).toMatchObject({ updated: 1 })
  expect(await row(id)).toMatchObject({ brand: 'Xavia', version: 2 })
})
