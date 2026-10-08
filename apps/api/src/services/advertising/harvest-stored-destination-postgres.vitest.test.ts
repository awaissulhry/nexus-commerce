/**
 * Batch 2 review fix — a harvest that names no destination (a rule's harvest_and_negate, a recommendation's accept) lands
 * where the Owner STORED one, at the grain he stored it: the portfolio grain included, through the real resolver
 * (harvest-destination.service.ts resolveStoredDestinations + resolveDestination, nothing mocked), on a real PostgreSQL
 * (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on, the restricted runtime login,
 * business profiles ON), the ads mode LIVE with Amazon's create calls stubbed at the client (nothing leaves the process).
 *
 *   portfolio   a jacket whose two exact ad groups both could take the term (the resolver alone: ambiguous, refused); the
 *               Owner's EXACT destination stored for the jacket's PORTFOLIO, negateAtSource off: a rule's harvest lands the
 *               keyword there and the source is never negated
 *   keep        a glove with one exact ad group (the resolver alone: that one, and the source negated on landing); the
 *               Owner's portfolio destination says negateAtSource off: a recommendation's accept lands it there and the
 *               source stays; turned back on, the next one is negated — the flag is read from his portfolio row
 *   gone        his stored destination no longer exists, or lies in another market: refused by name, never the resolver's
 *               own pick, nothing created
 *   paused      a boot whose only exact ad group does not serve (its campaign paused, or the ad group itself): refused with
 *               the reason, nothing created; enabled again, it lands
 *   scope       the graph one harvest reads: the sources' products in their markets and the stored destinations only — not
 *               the jacket's other market, the other products or the rest of the business
 *   business    another business's destination stored for the same portfolio id is never read
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { workspaceKey } from '@nexus/database/workspace-context'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
// Amazon's create calls, stubbed at the client: what reaches them is what the real services and the real gate let through.
const amz = vi.hoisted(() => ({ keywords: [] as Array<Record<string, unknown>>, negatives: [] as Array<Record<string, unknown>>, n: 0 }))
vi.mock('./ads-api-client.js', async (original) => ({
  ...(await original<object>()),
  createKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-K-${++amz.n}`, rawResponse: {}, error: null } }),
  createNegativeKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.negatives.push(input); return { ok: true, mode: 'live', externalId: `AMZ-N-${++amz.n}`, rawResponse: {} } }),
  listNegativeKeywords: vi.fn(async () => []),
}))

const { applyHarvest } = await import('./ads-harvest.service.js')
const { loadDestinationGraph, resolveStoredDestinations } = await import('./harvest-destination.service.js')
const { setAutonomy } = await import('./ads-automation-state.service.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `b2rf_dest_${hex}`
const W2 = `b2rf_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l'), BOOT = id('boot'), BOOT_L = id('boot-l')
const PF_JACKET = `PF-J-${hex}`
const PF_GLOVE = `PF-G-${hex}`

/** A graduation as a rule's card or a recommendation hands it to applyHarvest: no destination named. */
const term = (campaign: string, query: string) => ({
  query, externalCampaignId: `EXT-${C(campaign)}`, externalAdGroupId: `EXT-${G(campaign)}`,
  impressions: 600, clicks: 30, costCents: 600, orders: 3, salesCents: 24_000, market: 'IT',
})
const reset = () => { amz.keywords.length = 0; amz.negatives.length = 0 }
const store = (grain: string, scopeId: string, adGroupId: string, negateAtSource: boolean) => inW(() => database.client.adsHarvestDestination.upsert({
  where: { scopeGrain_scopeId_matchType: workspaceKey({ scopeGrain: grain, scopeId, matchType: 'EXACT' }) },
  create: { scopeGrain: grain, scopeId, matchType: 'EXACT', adGroupId, negateAtSource, updatedBy: 'user:owner' },
  update: { adGroupId, negateAtSource },
}))

async function seed() {
  const db = database.client
  await seedAdsFixture(db)
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `B2RF-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `B2RF-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0B2RFJM${H}` })
  await product(GLOVE, `B2RF-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `B2RF-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0B2RFGL${H}`, basePrice: '30.00' })
  await product(BOOT, `B2RF-BOOT-${hex}`, { isParent: true, name: 'Boot' })
  await product(BOOT_L, `B2RF-BOOT-L-${hex}`, { parentId: BOOT, amazonAsin: `B0B2RFBL${H}` })
  const campaign = async (key: string, groupName: string, productId: string, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} ${hex}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, targetingType: 'MANUAL', ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: groupName, externalAdGroupId: `EXT-${G(key)}`, defaultBidCents: 40 } })
    await db.adProductAd.create({ data: { adGroupId: G(key), productId } })
  }
  await campaign('jk-auto', 'Auto', JACKET_M, { targetingType: 'AUTO', portfolioId: PF_JACKET })
  await campaign('jk-exact-a', 'Exact A', JACKET_M, { portfolioId: PF_JACKET })
  await campaign('jk-exact-b', 'Exact B', JACKET_M, { portfolioId: PF_JACKET })
  await campaign('jk-de-exact', 'Exact DE', JACKET_M, { marketplace: 'DE' })
  await campaign('gl-auto', 'Auto', GLOVE_L, { targetingType: 'AUTO', portfolioId: PF_GLOVE })
  await campaign('gl-exact', 'Exact', GLOVE_L, { portfolioId: PF_GLOVE })
  await campaign('bt-auto', 'Auto', BOOT_L, { targetingType: 'AUTO' })
  await campaign('bt-exact', 'Exact', BOOT_L, { status: 'PAUSED' })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'IT', dailyCapCents: 10_000 } })
}

describe.skipIf(!concurrentDatabaseUrl())('batch 2 review fix — a harvest with no destination named honours the Owner\'s stored one (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    // The Owner's EXACT destinations, stored per portfolio (as set-harvest-destination saves them), negate-at-source off.
    await store('portfolio', PF_JACKET, G('jk-exact-a'), false)
    await store('portfolio', PF_GLOVE, G('gl-exact'), false)
    // Another business stores its own destination under the same portfolio id: never read here.
    await inW2(() => database.client.adsHarvestDestination.create({ data: { scopeGrain: 'portfolio', scopeId: PF_JACKET, matchType: 'EXACT', adGroupId: 'other-business-ag', negateAtSource: true, updatedBy: 'user:other' } }))
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the stored destination is found at the portfolio grain — this business\'s only, whatever another stores under the same id', async () => {
    const stored = await inW(() => resolveStoredDestinations({ market: 'IT', portfolio: PF_JACKET, campaign: C('jk-auto'), adGroup: G('jk-auto') }))
    expect(stored.get('EXACT')).toMatchObject({ adGroupId: G('jk-exact-a'), negateAtSource: false, grain: 'portfolio', scopeId: PF_JACKET })
    // Without the portfolio in the chain nothing is stored for the jacket (the defect: every harvest asked this way).
    expect((await inW(() => resolveStoredDestinations({ market: 'IT', campaign: C('jk-auto'), adGroup: G('jk-auto') }))).get('EXACT')).toBeUndefined()
    expect((await inW2(() => resolveStoredDestinations({ market: 'IT', portfolio: PF_JACKET }))).get('EXACT')).toMatchObject({ adGroupId: 'other-business-ag' })
  })

  it('portfolio: a rule\'s harvest lands the keyword in the Owner\'s portfolio destination — not refused as ambiguous between the two exact ad groups — and never negates the source', async () => {
    reset()
    const r = await inW(() => applyHarvest({ graduations: [term('jk-auto', 'touring jacket')], userId: 'automation:b2rf-rule', rule: { criteria: { minOrders: 1, windowDays: 30 } } }))
    expect(r.errors).toEqual([])
    expect(r.outcomes[0]).toMatchObject({ outcome: 'acted', sourceAdGroupId: G('jk-auto'), destinationAdGroupId: G('jk-exact-a'), reachedAmazon: true, negative: null })
    expect(r.outcomes[0].negateReason).toMatch(/never negated for a term that graduated from it/)
    expect(amz.keywords.map((k) => [k.externalAdGroupId, k.keywordText, k.matchType])).toEqual([[`EXT-${G('jk-exact-a')}`, 'touring jacket', 'EXACT']])
    expect(amz.negatives).toEqual([])
  })

  it('keep: a recommendation\'s accept lands in the portfolio destination and keeps the source (negateAtSource off); turned on, the next is negated', async () => {
    reset()
    const kept = await inW(() => applyHarvest({ graduations: [term('gl-auto', 'winter glove')], userId: 'user:b2rf-person' }))
    expect(kept.outcomes[0]).toMatchObject({ outcome: 'acted', destinationAdGroupId: G('gl-exact'), negative: null })
    expect(kept.outcomes[0].negateReason).toMatch(/never negated for a term that graduated from it/)
    expect(amz.keywords.map((k) => k.externalAdGroupId)).toEqual([`EXT-${G('gl-exact')}`])
    expect(amz.negatives).toEqual([])
    // His row says negate-at-source on: the source is negated where the keyword landed elsewhere.
    await store('portfolio', PF_GLOVE, G('gl-exact'), true)
    reset()
    const negated = await inW(() => applyHarvest({ graduations: [term('gl-auto', 'summer glove')], userId: 'user:b2rf-person' }))
    expect(negated.outcomes[0]).toMatchObject({ outcome: 'acted', destinationAdGroupId: G('gl-exact'), negative: { attempted: true, reachedAmazon: true } })
    expect(amz.negatives.map((n) => [n.externalAdGroupId, n.keywordText])).toEqual([[`EXT-${G('gl-auto')}`, 'summer glove']])
    await store('portfolio', PF_GLOVE, G('gl-exact'), false)
  })

  it('gone: a stored destination that no longer exists, or lies in another market, refuses by name — never the resolver\'s own pick', async () => {
    reset()
    await store('portfolio', PF_GLOVE, id('no-such-ad-group'), false)
    const gone = await inW(() => applyHarvest({ graduations: [term('gl-auto', 'rain glove')], userId: 'user:b2rf-person' }))
    expect(gone.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination', reason: expect.stringMatching(/stored for this match type \(at the portfolio grain\) no longer exists, so nothing was created/) } })
    await store('portfolio', PF_GLOVE, G('jk-de-exact'), false)
    const elsewhere = await inW(() => applyHarvest({ graduations: [term('gl-auto', 'rain glove')], userId: 'user:b2rf-person' }))
    expect(elsewhere.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination', reason: expect.stringMatching(/“Exact DE”, is in DE, but this search term is from IT, so nothing was created/) } })
    expect([amz.keywords, amz.negatives]).toEqual([[], []])
    await store('portfolio', PF_GLOVE, G('gl-exact'), false)
  })

  it('paused: the only exact ad group does not serve (its campaign, then the ad group itself) — refused with the reason; enabled, it lands', async () => {
    reset()
    const paused = await inW(() => applyHarvest({ graduations: [term('bt-auto', 'hiking boot')], userId: 'user:b2rf-person' }))
    expect(paused.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination', reason: expect.stringMatching(/The only ad group that could take it, “Exact” in “bt-exact .*”, does not serve: its campaign is paused\. .*Nothing was created\./) } })
    await inW(async () => {
      await database.client.campaign.update({ where: { id: C('bt-exact') }, data: { status: 'ENABLED' } })
      await database.client.adGroup.update({ where: { id: G('bt-exact') }, data: { status: 'PAUSED' } })
    })
    const groupPaused = await inW(() => applyHarvest({ graduations: [term('bt-auto', 'hiking boot')], userId: 'user:b2rf-person' }))
    expect(groupPaused.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { reason: expect.stringMatching(/does not serve: the ad group is paused\./) } })
    expect([amz.keywords, amz.negatives]).toEqual([[], []])
    await inW(() => database.client.adGroup.update({ where: { id: G('bt-exact') }, data: { status: 'ENABLED' } }))
    const lands = await inW(() => applyHarvest({ graduations: [term('bt-auto', 'hiking boot')], userId: 'user:b2rf-person' }))
    expect(lands.outcomes[0]).toMatchObject({ outcome: 'acted', destinationAdGroupId: G('bt-exact'), negative: { reachedAmazon: true } })
  })

  it('scope: one harvest\'s graph holds its sources\' products in their markets and the stored destinations — nothing else of the business', async () => {
    const scoped = await inW(() => loadDestinationGraph({ sourceAdGroupIds: [G('jk-auto')], alsoAdGroupIds: [G('gl-exact')] }))
    expect([...scoped.adGroups.keys()].sort()).toEqual([G('gl-exact'), G('jk-auto'), G('jk-exact-a'), G('jk-exact-b')].sort())
    expect(scoped.productsOfAdGroup.get(G('jk-exact-a'))).toEqual(new Set([JACKET_M]))
    expect(scoped.adGroups.get(G('jk-exact-a'))).toMatchObject({ marketplace: 'IT', campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED', role: 'EXACT' })
    // The holders of a term: only inside the scope (the jacket's keyword landed in Exact A above).
    expect(scoped.holdersOfTerm.get('KEYWORD|touring jacket')).toEqual([{ adGroupId: G('jk-exact-a'), atAmazon: true }])
    // The whole business, as the Keyword Harvest page reads it: the DE ad group, the boots and the fixture's campaigns too.
    const whole = await inW(() => loadDestinationGraph())
    expect(whole.adGroups.has(G('jk-de-exact'))).toBe(true)
    expect(whole.adGroups.has(G('bt-exact'))).toBe(true)
    expect(whole.adGroups.size).toBeGreaterThan(scoped.adGroups.size + 5)
    // No source named: only the ad groups asked for by id.
    expect([...(await inW(() => loadDestinationGraph({ sourceAdGroupIds: [], alsoAdGroupIds: [G('gl-exact')] }))).adGroups.keys()]).toEqual([G('gl-exact')])
  })
})
