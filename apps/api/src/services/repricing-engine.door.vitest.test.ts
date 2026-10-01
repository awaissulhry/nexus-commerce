/**
 * The repricing engine's apply goes through the ONE channel price door (2026-10-01).
 *
 * 🔴 WHAT THIS GUARDS. `RepricingEngineService.evaluate(..., { applyToProduct: true })` wrote `priceOverride` and
 * `followMasterPrice = false` and nothing else: never `price` (the column the push reads), no audit, no queue row. The
 * evaluator cron then queued a row of its own with no hold and no cancel of a pending one; the manual route queued
 * nothing. Now the engine pins the price through the door (price + priceOverride + follow off, audit, timeline, ONE
 * PRICE_UPDATE row on the 30 s hold), its own rule clamp still decides the price, the door holds it to the product's
 * floor/ceiling in the master currency, and a refusal is recorded on the decision as not applied.
 *
 * Real PostgreSQL in-process (PGlite). Every id is invented.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async (importOriginal) => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('./outbound-enqueue.js', async (importOriginal) => ({ ...await importOriginal<any>(), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: vi.fn(async () => undefined), emitMany: vi.fn(), emitManyTx: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { RepricingEngineService } from './repricing-engine.service.js'
import { runRepricingEvaluatorOnce } from '../jobs/repricing-evaluator.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const accounts: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'UK', name: 'United Kingdom', currency: 'GBP', region: 'EU', language: 'en', languages: ['en'] } })
  for (const channel of ['AMAZON', 'EBAY']) accounts[channel] = (await prisma.channelConnection.create({ data: { channelType: channel, accountLabel: `repricer-${channel}`, isActive: true } })).id
}), 120_000)
afterEach(() => { vi.unstubAllEnvs() })
afterAll(async () => { await state.db?.close() }, 60_000)

/** A product at master 10 following on one live listing, and a match-the-Buy-Box rule (5–50) for it. */
async function seed(id: string, opts: { channel?: 'AMAZON' | 'EBAY'; marketplace?: string; product?: Record<string, unknown> } = {}) {
  const channel = opts.channel ?? 'AMAZON'
  const marketplace = opts.marketplace ?? 'IT'
  await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, ...opts.product } as never })
  const listing = await prisma.channelListing.create({ data: { productId: id, channel, channelConnectionId: accounts[channel], channelMarket: `${channel}_${marketplace}`,
    marketplace, region: 'EU', listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ITEM-${id}`, price: 10, masterPrice: 10, followMasterPrice: true } })
  const rule = await prisma.repricingRule.create({ data: { productId: id, channel, marketplace, strategy: 'match_buy_box', minPrice: 5, maxPrice: 50 } })
  return { listing, rule }
}
const market = { currentPrice: 10, buyBoxPrice: 12, lowestCompPrice: null, competitorCount: null }
const pending = (channelListingId: string) => prisma.outboundSyncQueue.findMany({ where: { channelListingId, syncStatus: 'PENDING' } })

describe('the repricer pins its price through the price door', () => {
  it('🔴 an applied reprice is price + override + follow off, audited, on the timeline and queued ONCE', () => scoped(async () => {
    const { listing, rule } = await seed('rp-applied')
    const result = await new RepricingEngineService(prisma as never).evaluate(rule.id, market, { applyToProduct: true })
    expect(result).toMatchObject({ changed: true, price: 12, applied: true })
    const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(stored.followMasterPrice).toBe(false)
    expect(Number(stored.price)).toBe(12)
    expect(Number(stored.priceOverride)).toBe(12)
    const rows = await pending(listing.id)
    expect(rows.map((row) => [row.syncType, (row.payload as any).price, (row.payload as any).actor])).toEqual([['PRICE_UPDATE', 12, `repricer:${rule.id}`]])
    expect(await prisma.priceChangeEvent.findMany({ where: { productId: 'rp-applied' }, select: { source: true } })).toEqual([{ source: 'REPRICER' }])
    expect(await prisma.repricingDecision.findFirstOrThrow({ where: { ruleId: rule.id } })).toMatchObject({ applied: true })
  }))

  it('🔴 above the product\'s own EUR ceiling: not applied, said on the decision, nothing written or queued', () => scoped(async () => {
    const { listing, rule } = await seed('rp-ceiling', { product: { maxPrice: 11 } })
    const result = await new RepricingEngineService(prisma as never).evaluate(rule.id, market, { applyToProduct: true })
    expect(result).toMatchObject({ changed: true, price: 12, applied: false })
    expect(result.notApplied).toContain('above its pricing ceiling of 11.00')
    const decision = await prisma.repricingDecision.findFirstOrThrow({ where: { ruleId: rule.id } })
    expect(decision.applied).toBe(false)
    expect(decision.reason).toContain('not applied:')
    const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(stored).toMatchObject({ followMasterPrice: true, priceOverride: null })
    expect(await pending(listing.id)).toEqual([])
  }))

  it('a GBP market is not held to the EUR ceiling (refuse, don\'t convert)', () => scoped(async () => {
    const { listing, rule } = await seed('rp-gbp', { channel: 'EBAY', marketplace: 'UK', product: { maxPrice: 11 } })
    const result = await new RepricingEngineService(prisma as never).evaluate(rule.id, market, { applyToProduct: true })
    expect(result).toMatchObject({ applied: true, price: 12 })
    expect((await pending(listing.id)).map((row) => (row.payload as any).price)).toEqual([12])
  }))

  it('without applyToProduct nothing is written: the decision is logged only', () => scoped(async () => {
    const { listing, rule } = await seed('rp-dry')
    expect(await new RepricingEngineService(prisma as never).evaluate(rule.id, market)).toMatchObject({ changed: true, applied: false })
    expect(Number((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).price)).toBe(10)
    expect(await pending(listing.id)).toEqual([])
  }))

  it('🔴 the live evaluator cron queues the reprice once — the door\'s row, not a second one of its own', () => scoped(async () => {
    const { listing } = await seed('rp-cron')
    await prisma.buyBoxHistory.create({ data: { productId: 'rp-cron', channel: 'AMAZON', marketplace: 'IT', buyBoxPrice: 12, lowestCompetitorPrice: 11.5 } })
    vi.stubEnv('NEXUS_REPRICER_LIVE', '1')
    await runRepricingEvaluatorOnce()
    const rows = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: listing.id } })
    expect(rows.map((row) => [row.syncType, (row.payload as any).source, (row.payload as any).price])).toEqual([['PRICE_UPDATE', 'CHANNEL_PRICE_WRITE', 12]])
    expect(rows[0].holdUntil).not.toBeNull()
    expect(await prisma.priceChangeEvent.count({ where: { productId: 'rp-cron' } })).toBe(1)
  }))
})
