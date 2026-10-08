/**
 * ONE BRAIN AB-3 — the `ads-brain` tool's three views on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), over a GALE IT shape: ten own campaigns the bid brain runs LIVE (the server switch live), one campaign an hourly
 * plan holds, one with a classic dayparting schedule, one shared with another product, the other product's own campaign
 * LIVE one by one, two rules at Auto, and the action log of the last weeks. Nothing is written by the reads.
 *
 *   map      the product's brain (its levels with their source) and each campaign's levers: the brain and a market rule
 *            on the LIVE campaigns' bids (a clash), auto-bid's own writes as evidence, a person's budget change, an old
 *            write outside the window left out; one campaign alone; the market's products
 *   clashes  the campaigns where two automatic writers act, and the gaps: a keyword blocked where it is targeted, a
 *            harvest rule with no destination, a keyword two products bid on, Amazon's rules not read
 *   setup    the engines held off with their fix, the other product LIVE one campaign at a time but not enrolled
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../../lib/queue.js', () => {
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

const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { enrollProduct } = await import('./enrollment.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab3_map_${hex}`
const inW = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const GALE = id('gale'), GALE_S = id('gale-s'), GALE_M = id('gale-m'), MISANO = id('misano'), MISANO_L = id('misano-l')
const LIVE = Array.from({ length: 10 }, (_, i) => `g${i + 1}`)
const DAY = 86_400_000

type Data = Record<string, any>
const tool = (args: Record<string, unknown>) => inW(() => ADS_BRAIN_TOOLS[0].handler!(args, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(GALE, `AB3-GALE-${hex}`, { isParent: true })
  await product(GALE_S, `AB3-GALE-S-${hex}`, { parentId: GALE, amazonAsin: `B0AB3GLS${H}` })
  await product(GALE_M, `AB3-GALE-M-${hex}`, { parentId: GALE, amazonAsin: `B0AB3GLM${H}` })
  await product(MISANO, `AB3-MISANO-${hex}`, { isParent: true })
  await product(MISANO_L, `AB3-MISANO-L-${hex}`, { parentId: MISANO, amazonAsin: `B0AB3MSL${H}` })
  const campaign = async (key: string, ads: Array<[string, string]>, keywords: Array<[string, string, Record<string, unknown>?]> = []) => {
    await db.campaign.create({ data: { id: C(key), name: key, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, portfolioId: 'pf-gale' } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
    let i = 0
    for (const [text, match, extra] of [[`jacket ${key}`, 'EXACT'] as [string, string], ...keywords]) {
      await db.adTarget.create({ data: { id: `t-${C(key)}-${i}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: match, expressionValue: text, bidCents: 40, externalTargetId: `EXT-t-${C(key)}-${i++}`, ...(extra ?? {}) } })
    }
  }
  for (const key of LIVE) {
    await campaign(key, [[GALE_S, `B0AB3GLS${H}`]], key === 'g1' ? [['gale jacket', 'EXACT'], ['gale jacket', 'NEGATIVE_EXACT', { isNegative: true, negativeLevel: 'AD_GROUP' }], ['moto jacket', 'PHRASE']] : [])
    await db.bidBrainEnrollment.create({ data: { campaignId: C(key), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [], placements: [] } } })
  }
  await campaign('plan-a', [[GALE_M, `B0AB3GLM${H}`]])
  await db.adSchedule.create({ data: { id: `s-${hex}-plan`, campaignId: C('plan-a'), name: 'evening plan', windows: [{ days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'own-top' }], defaultTargetKey: 'rest-of-search', enabled: true } })
  await campaign('classic', [[GALE_M, `B0AB3GLM${H}`]])
  await db.adSchedule.create({ data: { id: `s-${hex}-classic`, campaignId: C('classic'), name: 'weekend boost', windows: [{ days: [0, 6], startHour: 9, endHour: 21, bidMultiplierPct: 25 }], enabled: true } })
  await campaign('shared', [[GALE_S, `B0AB3GLS${H}`], [MISANO_L, `B0AB3MSL${H}`]])
  await campaign('misano-1', [[MISANO_L, `B0AB3MSL${H}`]], [['Moto Jacket', 'EXACT']])
  await db.bidBrainEnrollment.create({ data: { campaignId: C('misano-1'), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [], placements: [] } } })
  await db.automationRule.create({ data: { id: id('r-bid'), name: 'Lower bids on waste', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, dryRun: false, autonomyLevel: 'AUTO', scopeMarketplace: 'IT', actions: [{ type: 'bid_down', pct: 10 }] } })
  await db.automationRule.create({ data: { id: id('r-harvest'), name: 'Harvest winners', domain: 'advertising', trigger: 'SCHEDULE', enabled: true, dryRun: false, autonomyLevel: 'AUTO', actions: [{ type: 'harvest_and_negate' }] } })
  // The action log: auto-bid on g2 (2 changes), the brain on g1, a person's budget on g3, dayparting on g4 forty days ago.
  const log = (userId: string, actionType: string, entityType: string, entityId: string, ageDays: number) => db.advertisingActionLog.create({ data: { userId, actionType, entityType, entityId, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUCCESS', createdAt: new Date(Date.now() - ageDays * DAY) } })
  await log('automation:auto-bid', 'AD_BID_UPDATE', 'AD_TARGET', `t-${C('g2')}-0`, 2)
  await log('automation:auto-bid', 'AD_BID_UPDATE', 'AD_TARGET', `t-${C('g2')}-0`, 1)
  await log('automation:bid-brain', 'AD_BID_UPDATE', 'AD_TARGET', `t-${C('g1')}-0`, 1)
  await log('user:owner', 'AD_BUDGET_UPDATE', 'CAMPAIGN', C('g3'), 3)
  await log('automation:dayparting-s1', 'AD_BID_UPDATE', 'AD_TARGET', `t-${C('g4')}-0`, 40)
  await setAutonomy('AUTO', 'test')
}

describe.skipIf(!concurrentDatabaseUrl())('AB-3 — ads-brain: map, clashes, setup (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    database = await concurrentDatabase()
    await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [W])
    await inW(seed)
    expect(await inW(() => enrollProduct({ productId: GALE, market: 'IT', by: 'user:owner' }))).toMatchObject({ ok: true, bids: 'AUTO' })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('map of a product: its brain with each level\'s source, and every lever of each campaign with its owner and its writers', async () => {
    const before = await rows<{ n: number }>('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "workspaceId" = $1', [W])
    const out = await tool({ view: 'map', productId: GALE_S, market: 'it' })
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(d.scope).toEqual({ productId: GALE, market: 'IT' })
    expect(d.product).toMatchObject({ enrolled: true, levers: { bids: { level: 'AUTO', effective: 'AUTO', source: 'product', by: 'user:owner' }, negatives: { level: 'OBSERVE', source: 'default' } } })
    expect(d.product.settings.portfolioCapOn).toMatchObject({ portfolioCapOn: true, source: 'default' })
    const byId = new Map<string, Data>(d.campaigns.map((c: Data) => [c.name, c]))
    expect([...byId.keys()].sort()).toEqual([...LIVE, 'classic', 'plan-a', 'shared'].sort())
    // A LIVE campaign: the brain and the market rule on its bids — a clash; the brain's own write is evidence.
    const g1 = byId.get('g1')!
    expect(g1).toMatchObject({ ownedBy: 'one product', bidBrain: 'LIVE' })
    expect(g1.levers.bids.owner).toBe('two or more writers: rule "Lower bids on waste", the brain')
    expect(g1.levers.bids.clash).toEqual(['rule "Lower bids on waste"', 'the brain'])
    expect(g1.levers.bids.writers).toContainEqual(expect.objectContaining({ who: 'the brain', basis: 'wrote', changes: 1 }))
    // auto-bid wrote on g2 although the brain owns it: evidence; a person's budget on g3; the old dayparting write is outside 14 days.
    expect(byId.get('g2')!.levers.bids.writers).toContainEqual(expect.objectContaining({ who: 'Bid optimiser', kind: 'engine', basis: 'wrote', changes: 2 }))
    expect(byId.get('g3')!.levers.budgets.writers).toContainEqual(expect.objectContaining({ who: 'a person', basis: 'wrote', changes: 1 }))
    expect(byId.get('g4')!.levers.bids.writers.some((w: Data) => w.who === 'Classic dayparting')).toBe(false)
    // The hourly plan and the classic schedule, each by its own read; the shared campaign; the adopted per-campaign brake.
    expect(byId.get('plan-a')!.levers.hours.writers).toContainEqual(expect.objectContaining({ who: 'Hourly bid plans', basis: 'configured' }))
    expect(byId.get('classic')!.levers.hours.writers).toContainEqual(expect.objectContaining({ who: 'Classic dayparting', basis: 'configured' }))
    expect(byId.get('shared')!).toMatchObject({ ownedBy: 'shared', productIds: [GALE, MISANO].sort() })
    expect(byId.get('shared')!.levers.bids).toMatchObject({ brain: 'SHARED', brainWhy: expect.stringContaining('no product\'s brain owns') })
    expect(byId.get('plan-a')!.levers.bids).toMatchObject({ brain: 'OBSERVE', brainWhy: expect.stringContaining('campaign override') })
    expect(byId.get('g1')!.levers.offAmazon.owner).toMatch(/could not measure/)
    // A read writes nothing.
    expect(await rows('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "workspaceId" = $1', [W])).toEqual(before)
  })

  it('map of one campaign, and of the market alone', async () => {
    const one = await tool({ view: 'map', campaignId: C('shared') })
    expect(one).toMatchObject({ ok: true, data: { scope: { campaignId: C('shared') }, campaigns: [{ name: 'shared', ownedBy: 'shared' }] } })
    const market = await tool({ view: 'map', market: 'IT' })
    expect(market.data!.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: GALE, enrolled: true, liveCampaigns: LIVE.map(C).sort() }),
      expect.objectContaining({ productId: MISANO, enrolled: false, liveCampaigns: [C('misano-1')] }),
    ]))
    expect(await tool({ view: 'map', campaignId: 'not-in-this-business' })).toEqual({ ok: false, error: 'campaign not-in-this-business not found' })
    expect(await tool({ view: 'map', productId: 'no-such-product', market: 'IT' })).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
  })

  it('clashes: two automatic writers per campaign lever, and the known gaps', async () => {
    const out = await tool({ view: 'clashes', market: 'IT' })
    expect(out.ok).toBe(true)
    const d = out.data!
    const bids = d.clashes.filter((c: Data) => c.lever === 'bids').map((c: Data) => c.name)
    expect(bids).toEqual(expect.arrayContaining(LIVE))
    expect(d.clashes.find((c: Data) => c.name === 'g2' && c.lever === 'bids').writers.map((w: Data) => `${w.who} (${w.basis})`).sort()).toEqual(['Bid optimiser (wrote)', 'rule "Lower bids on waste" (configured)', 'the brain (configured)'].sort())
    expect(d.gaps.harvestVersusNegate).toEqual([expect.objectContaining({ campaignId: C('g1'), text: 'gale jacket', negative: 'negative exact "gale jacket" at its ad group' })])
    expect(d.gaps.harvestWithoutDestination).toEqual([expect.objectContaining({ rule: 'Harvest winners', meaning: expect.stringContaining('never negated') })])
    expect(d.gaps.harvestWithoutDestination[0].campaigns.length).toBe(14)
    expect(d.gaps.siblingKeywords).toEqual([expect.objectContaining({ text: 'moto jacket', products: [GALE, MISANO].sort() })])
    expect(d.gaps.amazonRules).toMatch(/^could not measure/)
    // One product's campaigns only.
    const gale = await tool({ view: 'clashes', market: 'IT', productId: GALE })
    expect(gale.data!.campaignsRead).toBe(13)
  })

  it('setup: the engines held off with their fix, and a product LIVE one campaign at a time but not enrolled', async () => {
    const out = await tool({ view: 'setup', market: 'IT' })
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(Array.isArray(d.tools) || typeof d.tools === 'string').toBe(true)
    if (Array.isArray(d.tools)) for (const t of d.tools) expect(t).toMatchObject({ tool: expect.any(String), mode: expect.any(String), fix: expect.any(String) })
    expect(d.brain).toContainEqual(expect.objectContaining({ item: `product ${MISANO} (IT)`, fix: expect.stringContaining('enroll the product') }))
    expect(d.brain.some((b: Data) => b.item === 'bid brain server switch')).toBe(false)
    expect(d.brain).toContainEqual(expect.objectContaining({ item: 'Amazon\'s own rules', state: expect.stringMatching(/^could not measure/) }))
  })
})
