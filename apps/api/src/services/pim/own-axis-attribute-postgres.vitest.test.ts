import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet pop-up P3, slice A3 — two "New attribute" clicks with the same name at the same moment (two operators, or one
 * retried click): ONE attribute and ONE family link come out; the second click is answered "present", never an error
 * and never a copy.
 *
 * On `concurrent-database.ts`, never PGlite: PGlite is one connection, so it serialises the two creates and the test
 * would pass whether or not the write is safe. The race is FORCED, not hoped for: a third connection holds a SHARE lock
 * on "CustomAttribute", so both creates read "no attribute with this code" and then block on their insert; the test
 * waits until PostgreSQL reports both of them waiting before it releases the lock. The application client is the
 * restricted runtime login (row security enforced). Every id is invented.
 *
 * Run: node scripts/run-real-postgres-tests.mjs (it starts a throwaway PostgreSQL 17 and sets NEXUS_TEST_CONCURRENT_PG_URL).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`own-axis-attribute-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { createOwnAxisAttribute } from './own-axis-attribute.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

/** `raceChannelListingInserts` for "CustomAttribute": both calls must be blocked on their insert before the lock goes. */
async function raceAttributeInserts<T>(calls: Array<() => Promise<T>>): Promise<Array<{ value: T } | { error: unknown }>> {
  const locker = await state.db.pool.connect()
  let running: Array<Promise<{ value: T } | { error: unknown }>> = []
  let released = false
  try {
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE "CustomAttribute" IN SHARE MODE')
    running = calls.map(call => call().then(value => ({ value }), error => ({ error })))
    let waiting = 0
    const deadline = Date.now() + 60_000
    while (waiting < calls.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await state.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [state.db.name])
      waiting = rows[0].n
    }
    const forced = waiting === calls.length
    await locker.query(forced ? 'COMMIT' : 'ROLLBACK')
    released = true
    const settled = await Promise.all(running)
    if (!forced) throw new Error(`The race was not forced: ${waiting} of ${calls.length} creates were blocked on their insert before the lock was released.`)
    return settled
  } finally {
    if (!released) {
      await locker.query('ROLLBACK').catch(() => undefined)
      await Promise.all(running)
    }
    locker.release()
  }
}

describe.skipIf(!concurrentDatabaseUrl())(`"New attribute" — two creates of the same name at once (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    state.db = await concurrentDatabase()
    await scoped(async () => {
      await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'EBAY IT', region: 'EU', currency: 'EUR', language: 'it' } as never })
      ids.group = (await prisma.attributeGroup.create({ data: { code: 'race_fixture', label: 'Specifications' } as never })).id
      ids.family = (await prisma.productFamily.create({ data: { code: 'race_jackets', label: 'Made-up race jackets' } })).id
      const fit = await prisma.customAttribute.create({ data: { code: 'fit', label: 'Fit', type: 'text', groupId: ids.group, scope: 'per_variant' } as never })
      await prisma.familyAttribute.create({ data: { attributeId: fit.id, familyId: ids.family, channels: [], sortOrder: 1 } })
      ids.parent = (await prisma.product.create({ data: { sku: 'OA-RACE', name: 'race', basePrice: 10, isParent: true, familyId: ids.family, variationAxes: ['Color'] } as never })).id
      for (const [variant, color] of [['A', 'Red'], ['B', 'Blue']]) {
        await prisma.product.create({ data: { sku: `OA-RACE-${variant}`, name: `race ${variant}`, basePrice: 10, parentId: ids.parent, familyId: ids.family,
          categoryAttributes: { variations: { Color: color }, fit: 'Slim' } } as never })
      }
    })
  }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('one create makes the attribute and its family link; the other is answered "present" — one row each', async () => {
    const create = () => scoped(() => createOwnAxisAttribute({ productId: ids.parent, market: 'IT', name: 'Vestibilità' }))
    const settled = await raceAttributeInserts([create, create])
    const errors = settled.filter(outcome => 'error' in outcome).map(outcome => (outcome as { error: unknown }).error)
    expect(errors).toEqual([])
    const outcomes = settled.map(outcome => (outcome as { value: { outcome: string } }).value.outcome).sort()
    expect(outcomes).toEqual(['created', 'present'])
    for (const outcome of settled) {
      expect((outcome as { value: { source: unknown } }).value.source).toEqual({ field: 'vestibilita', label: 'Vestibilità', filled: 0, of: 2, values: [] })
    }
    const attributes = await scoped(() => prisma.customAttribute.findMany({ where: { code: 'vestibilita' }, select: { id: true } }))
    expect(attributes).toHaveLength(1)
    expect(await scoped(() => prisma.familyAttribute.count({ where: { attributeId: attributes[0].id } }))).toBe(1)
  }, 120_000)
})
