/**
 * Editing speed (2026-10-13) — the scheduled readiness drain leaves a family whose pending marks are younger than
 * READINESS_DRAIN_MIN_AGE_MS to the lane that marked it (a sheet save's rebuild after its answer, the queue worker), so
 * the two no longer rebuild the same family at the same moment. A mark older than that is drained as before; a hand run
 * (no age) still takes every pending family. PGlite; ids invented.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: { name: 'readiness' }, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('../../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: () => true } }))

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { countPendingReadinessFamilies, drainPendingReadiness, markReadinessPending, READINESS_DRAIN_MIN_AGE_MS, reconcileFamilyReadiness } from './readiness-index.service.js'
import { runReadinessPendingDrain } from '../../jobs/readiness-pending.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ROOT = 'rd-root'
const pending = () => scoped(() => prisma.readinessIndex.count({ where: { pendingSince: { not: null }, product: { OR: [{ id: ROOT }, { parentId: ROOT }] } } }))
const mark = () => scoped(() => inDatabaseTransaction(prisma as never, () => markReadinessPending([ROOT])))
/** As if the family was marked `ms` ago (the same clock the mark itself uses). */
const age = (ms: number) => scoped(() => prisma.$executeRaw`UPDATE "ReadinessIndex" SET "pendingSince" = now() - ${ms}::int * interval '1 millisecond' WHERE "pendingSince" IS NOT NULL`)

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'rd-ebay', channelType: 'EBAY', isActive: true } as never })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.product.create({ data: { id: ROOT, sku: 'RD-ROOT', name: 'Parent', basePrice: 10, isParent: true, status: 'DRAFT' } })
  await prisma.product.create({ data: { id: `${ROOT}-child`, sku: 'RD-ROOT-CHILD', name: 'Child', basePrice: 10, parentId: ROOT, status: 'DRAFT' } })
  for (const productId of [ROOT, `${ROOT}-child`]) {
    await prisma.channelListing.create({ data: { productId, channel: 'EBAY', channelMarket: 'EBAY_IT' as never, marketplace: 'IT', region: 'EU', channelConnectionId: 'rd-ebay', price: 10 } })
  }
}), 120_000)
beforeEach(() => scoped(() => reconcileFamilyReadiness(ROOT)), 120_000)
afterAll(async () => { await state.db?.close() })

it('is 30 seconds', () => {
  expect(READINESS_DRAIN_MIN_AGE_MS).toBe(30_000)
})

it('the scheduled drain leaves a family marked moments ago, and takes it once its oldest mark is older than the age', async () => {
  await mark()
  const rows = await pending()
  expect(rows).toBeGreaterThan(0)
  expect(await scoped(() => countPendingReadinessFamilies(READINESS_DRAIN_MIN_AGE_MS))).toBe(0)
  expect(await scoped(() => countPendingReadinessFamilies())).toBe(1)
  const young = await scoped(() => drainPendingReadiness({ budgetMs: 60_000, minPendingAgeMs: READINESS_DRAIN_MIN_AGE_MS }))
  expect(young).toMatchObject({ planned: 0, processed: 0, failed: 0, remaining: 0, stoppedBecause: 'complete' })
  expect(await pending()).toBe(rows)

  await age(READINESS_DRAIN_MIN_AGE_MS + 1_000)
  expect(await scoped(() => countPendingReadinessFamilies(READINESS_DRAIN_MIN_AGE_MS))).toBe(1)
  const old = await scoped(() => drainPendingReadiness({ budgetMs: 60_000, minPendingAgeMs: READINESS_DRAIN_MIN_AGE_MS }))
  expect(old).toMatchObject({ planned: 1, processed: 1, failed: 0, remaining: 0 })
  expect(await pending()).toBe(0)
}, 120_000)

it('the cron\'s drain uses the age; a hand run without it takes every pending family, as before', async () => {
  await mark()
  await scoped(() => runReadinessPendingDrain())
  expect(await pending()).toBeGreaterThan(0)
  const hand = await scoped(() => drainPendingReadiness({ budgetMs: 60_000 }))
  expect(hand).toMatchObject({ planned: 1, processed: 1, failed: 0, remaining: 0 })
  expect(await pending()).toBe(0)
}, 120_000)
