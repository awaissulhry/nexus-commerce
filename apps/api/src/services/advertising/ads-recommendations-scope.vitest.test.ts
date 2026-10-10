/**
 * C5 (2026-10-10) — the engines' suggestions for what runs, and the Owner keeps control (ads-recommendations.service.ts),
 * on PGlite with the production schema. The bid optimiser, the harvester, pacing and the retail check are stand-ins whose
 * lines the test sets (each names a real campaign, target or Amazon campaign id); share of voice, the mutes, the bid
 * brain's enrollments and the feed's scope are the real ones; who holds a product brain's levers is a stand-in (the real
 * resolver is proven in brain/lever-owners and the real-PG suites).
 *
 *   target     a bid line toward no target he set (the 30 % fallback) is left out; one toward his campaign target stays
 *   running    a paused campaign gets no negative and no graduation line
 *   levers     no line on a lever a product's brain owns (negatives) or the bid brain runs (keyword bids)
 *   sov        share of voice per market: the same query in IT and DE is not "2 campaigns competing"; only enabled
 *              campaigns count in the running scope; a mute of the query made before C5 still hides it
 *   market     a market he muted (mute-ad-recommendations with markets) has no line; unmute brings them back
 *   all        scope all lists every line, each one the running scope leaves out saying why; leftOut counts them
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// The tool registry loads the queues: a stub (nothing here enqueues).
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const h = vi.hoisted(() => ({ bids: [] as unknown[], negatives: [] as unknown[], graduations: [] as unknown[], owners: new Map<string, unknown>() }))
vi.mock('./ads-bid-optimizer.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  previewBidOptimization: async () => ({ targetAcos: 0.3, profitMode: false, bayesian: false, proposals: h.bids, held: [], waiting: [] }),
}))
vi.mock('./ads-harvest.service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  previewHarvest: async () => ({ negatives: h.negatives, graduations: h.graduations, criteria: { from: 'strategy', defaults: { windowDays: 30, minSpendCents: 500, minOrders: 2 }, strategy: [] }, protectedAsins: [] }),
}))
vi.mock('./ads-budget-pacing.service.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), previewPacing: async () => ({ targetRoas: 3, proposals: [] }) }))
vi.mock('./ads-retail-readiness.service.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), analyzeRetailReadiness: async () => ({ campaigns: [] }) }))
vi.mock('./brain/lever-owners.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  anyBrainEnrolled: async () => true,
  campaignLeverOwners: async (ids: string[]) => new Map(ids.filter((id) => h.owners.has(id)).map((id) => [id, h.owners.get(id)])),
}))

const { buildRecommendations } = await import('./ads-recommendations.service.js')
const { muteMarkets, unmuteMarkets, muteRecommendations, unmuteRecommendations } = await import('./ads-recommendation-mutes.service.js')
const { getTool } = await import('../agents/tool-registry.js')

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const feed = (opts: Parameters<typeof buildRecommendations>[0] = {}) => inside(() => buildRecommendations(opts))
const idsOf = (f: { recommendations: Array<{ id: string }> }) => f.recommendations.map((r) => r.id).sort()

/** A campaign with one ad group and one keyword; `target` = his own campaign target ACoS (a fraction). */
async function campaign(id: string, market: string, status: string, target?: number) {
  await db().campaign.create({
    data: {
      id, name: id, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: market, externalCampaignId: `EXT-${id}`, status, dailyBudget: '10.00',
      startDate: new Date('2026-01-01T00:00:00Z'), dynamicBidding: target ? { targetAcos: target } : {},
    },
  })
  await db().adGroup.create({ data: { id: `${id}-g`, campaignId: id, name: `${id}-g`, externalAdGroupId: `EXT-${id}-g`, defaultBidCents: 40 } })
  await db().adTarget.create({ data: { id: `${id}-t`, adGroupId: `${id}-g`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `${id} kw`, bidCents: 50 } })
}
const proposal = (targetId: string, targetSource: string, targetAcosUsed: number) => ({
  targetId, expression: `${targetId} kw`, matchType: 'EXACT', currentBidCents: 50, proposedBidCents: 40, deltaCents: -10, acos: 0.6,
  spendCents: 600, salesCents: 1000, clicks: 12, reason: 'ACOS above target', targetAcosUsed, targetBasis: targetSource, targetSource,
})
const term = (query: string, campaignId: string, market: string, orders = 0) => ({
  query, externalCampaignId: `EXT-${campaignId}`, externalAdGroupId: `EXT-${campaignId}-g`, impressions: 400, clicks: 15, costCents: 900, orders, salesCents: orders * 2000, market,
})
async function searchTerm(query: string, campaignId: string, market: string, extra: { impressions?: number; clicks?: number; costMicros?: bigint } = {}) {
  await db().amazonAdsSearchTerm.create({
    data: {
      profileId: `P-${market}`, marketplace: market, adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 3 * 86_400_000), campaignId: `EXT-${campaignId}`,
      adGroupId: `EXT-${campaignId}-g`, query, impressions: extra.impressions ?? 300, clicks: extra.clicks ?? 6, costMicros: extra.costMicros ?? 3_000_000n, currencyCode: 'EUR',
    },
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await campaign('it-on', 'IT', 'ENABLED', 0.25)
    await campaign('de-on', 'DE', 'ENABLED')
    await campaign('it-off', 'IT', 'PAUSED')
    await campaign('it-brain', 'IT', 'ENABLED', 0.25)
    await db().bidBrainEnrollment.create({ data: { campaignId: 'it-brain', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner' } })
    // The same query in two markets; a query two enabled IT campaigns share; one an enabled and a paused IT campaign share.
    await searchTerm('jacket', 'it-on', 'IT')
    await searchTerm('jacket', 'de-on', 'DE')
    await searchTerm('two live', 'it-on', 'IT')
    await searchTerm('two live', 'it-brain', 'IT')
    await searchTerm('live and paused', 'it-on', 'IT')
    await searchTerm('live and paused', 'it-off', 'IT')
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() })
beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.bids = [proposal('it-on-t', 'campaign', 0.25), proposal('de-on-t', 'flat', 0.3), proposal('it-brain-t', 'campaign', 0.25)]
  h.negatives = [term('waste it', 'it-on', 'IT'), term('waste paused', 'it-off', 'IT'), term('waste brain', 'it-brain', 'IT'), term('waste de', 'de-on', 'DE')]
  h.graduations = [term('winner paused', 'it-off', 'IT', 4), term('winner it', 'it-on', 'IT', 4)]
  h.owners = new Map([['it-brain', { campaignId: 'it-brain', name: 'it-brain', market: 'IT', levers: { negatives: { kind: 'owned', productId: 'prod-jacket', market: 'IT', why: 'its negatives lever is AUTO' } } }]])
})

describe('C5 — the running scope (the default)', () => {
  it('bids only toward a target he set, only for running campaigns, never on a lever a brain holds', async () => {
    const f = await feed()
    expect(f.scope).toBe('running')
    const ids = idsOf(f)
    // bid: IT toward his campaign target stays; DE (the 30 % fallback) and the bid brain's campaign are left out.
    expect(ids.filter((id) => id.startsWith('bid:'))).toEqual(['bid:it-on-t'])
    // negatives and graduations: the paused campaign's and the brain-owned negatives are left out.
    expect(ids.filter((id) => id.startsWith('neg:') || id.startsWith('grad:'))).toEqual(['grad:EXT-it-on-g:winner it', 'neg:EXT-de-on-g:waste de', 'neg:EXT-it-on-g:waste it'])
    expect(f.leftOut).toEqual({ total: 5, byReason: { noTargetSetByYou: 1, leverHeld: 2, notEnabled: 2 } })
  })

  it('share of voice per market: the same query in IT and DE is not two campaigns competing; only enabled campaigns count', async () => {
    const sov = (await feed()).recommendations.filter((r) => r.category === 'sov')
    expect(sov.map((r) => r.id)).toEqual(['sov:cannib:IT:two live'])
    expect(sov[0].title).toBe('2 campaigns competing on “two live” in IT')
    // scope all: every campaign of the market counts — the paused one too; still never across markets.
    const all = (await feed({ scope: 'all' })).recommendations.filter((r) => r.category === 'sov' && r.id.startsWith('sov:cannib:')).map((r) => r.id).sort()
    expect(all).toEqual(['sov:cannib:IT:live and paused', 'sov:cannib:IT:two live'])
  })

  it('a mute of the query made before C5 (no market) still hides its line in every market', async () => {
    await inside(() => muteRecommendations([{ id: 'sov:cannib:two live', label: 'old mute' }], 'user:owner', 'test'))
    expect(idsOf(await feed()).some((id) => id.startsWith('sov:'))).toBe(false)
    expect((await feed({ includeMuted: true })).recommendations.map((r) => r.id)).toContain('sov:cannib:IT:two live')
    await inside(() => unmuteRecommendations(['sov:cannib:two live']))
  })

  it('a market he muted has no line; unmuted, its lines come back', async () => {
    await inside(() => muteMarkets(['DE'], 'user:owner', 'DE is dormant'))
    const f = await feed()
    expect(idsOf(f).some((id) => id.includes('de-on'))).toBe(false)
    expect(f.mutedMarkets).toEqual(['DE'])
    expect(f.leftOut?.byReason.marketMuted).toBe(2) // its negative, and its bid line (no target he set either: the mute is named first)
    await inside(() => unmuteMarkets(['DE']))
    expect(idsOf(await feed())).toContain('neg:EXT-de-on-g:waste de')
  })
})

describe('C5 — scope all: every line, read only, each left-out one says why', () => {
  it('lists today\'s full list; the running scope\'s left-outs carry outOfScope', async () => {
    const f = await feed({ scope: 'all' })
    expect(f.scope).toBe('all')
    expect(f.leftOut).toBeUndefined()
    const byId = new Map(f.recommendations.map((r) => [r.id, r]))
    expect([...byId.keys()].filter((id) => id.startsWith('bid:')).sort()).toEqual(['bid:de-on-t', 'bid:it-brain-t', 'bid:it-on-t'])
    expect(byId.get('bid:it-on-t')?.outOfScope).toBeUndefined()
    expect(byId.get('bid:de-on-t')?.outOfScope).toMatch(/^no target ACoS you set: it aimed at 30 % \(the 30 % fallback\)/)
    expect(byId.get('bid:it-brain-t')?.outOfScope).toMatch(/^the bid brain runs the keyword bids of campaign it-brain/)
    expect(byId.get('neg:EXT-it-off-g:waste paused')?.outOfScope).toMatch(/^its campaign is paused: only running campaigns get suggestions/)
    expect(byId.get('grad:EXT-it-off-g:winner paused')?.outOfScope).toMatch(/^its campaign is paused/)
    expect(byId.get('neg:EXT-it-brain-g:waste brain')?.outOfScope).toMatch(/^a product's brain runs the negative.* of campaign "it-brain" \(it-brain\) — product prod-jacket in IT: its own views carry it$/)
    expect(f.recommendations).toHaveLength((await feed()).recommendations.length + 5 + 1) // the 5 left out, and the paused campaign's share-of-voice line
  })
})

describe('C5 — mute-ad-recommendations with markets (Nexus only, he approves it)', () => {
  const tool = () => getTool('mute-ad-recommendations')!
  const ctx = (approvedPreview?: unknown) => ({ approvalId: 'appr-c5', userId: 'owner-1', via: 'claude', approvedPreview }) as never

  it('mute: a preview naming the market, then the run mutes it; undo asks for the unmute', async () => {
    const args = tool().input.parse({ markets: ['de'], op: 'mute', why: 'DE is dormant for now' }) as Record<string, unknown>
    expect(args.markets).toEqual(['DE'])
    const dry = await inside(() => tool().handler(args, ctx()))
    expect(dry.ok).toBe(true)
    const preview = (dry as { preview: { items: Array<{ id: string; from: string; to: string }>; summary: string } }).preview
    expect(preview.items).toEqual([expect.objectContaining({ id: 'market:DE', from: 'shown', to: 'muted' })])
    expect(preview.summary).toMatch(/^Mutes every engine suggestion in DE: Nexus stops offering them/)
    const ran = await inside(() => tool().execute!(args, ctx(preview)))
    expect(ran.ok, (ran as { error?: string }).error).toBe(true)
    expect((await feed()).mutedMarkets).toEqual(['DE'])
    const undo = tool().undo!.request({ after: (ran as { change: { after: unknown } }).change.after } as never)
    expect(undo).toMatchObject({ tool: 'mute-ad-recommendations', args: { markets: ['DE'], op: 'unmute' } })
    expect((undo as { args: Record<string, unknown> }).args).not.toHaveProperty('recommendationIds')
    expect(await inside(() => tool().undo!.current({ after: (ran as { change: { after: unknown } }).change.after } as never))).toEqual({ op: 'mute', items: [{ id: 'market:DE', state: 'muted' }] })
  })

  it('a market mute always waits for a person: never inside the run-by-rule limit, however high', () => {
    const market = { action: 'mute-ad-recommendations', op: 'mute', items: [{ id: 'market:DE', category: 'market' }] }
    const ones = { action: 'mute-ad-recommendations', op: 'mute', items: [{ id: 'bid:t1', category: 'bid' }] }
    expect(tool().withinLimits!(market, { maxItems: 100 })).toMatch(/a person always decides that, it never runs by rule/)
    expect(tool().withinLimits!({ ...market, items: [...market.items, ...ones.items] }, { maxItems: 100 })).toMatch(/never runs by rule/)
    expect(tool().withinLimits!(ones, { maxItems: 100 })).toBeNull() // a mute by id, inside the limit, may still run by rule
  })

  it('refused before anything waits: a market muted already, one with no campaign, nothing named, a dismiss', async () => {
    const refusal = async (a: Record<string, unknown>) => ((await inside(() => tool().handler(tool().input.parse(a) as Record<string, unknown>, ctx()))) as { error?: string }).error
    expect(await refusal({ markets: ['DE'], op: 'mute', why: 'again please' })).toMatch(/DE: its suggestions are muted already/)
    expect(await refusal({ markets: ['ES'], op: 'mute', why: 'not there' })).toMatch(/ES: this business runs no Amazon ad campaign in this market/)
    expect(await refusal({ op: 'mute', why: 'nothing named' })).toMatch(/Name the recommendationIds or the markets/)
    expect(await refusal({ markets: ['DE'], op: 'dismiss', why: 'wrong op' })).toMatch(/markets are muted \(op mute\) and unmuted \(op unmute\)/)
    expect(await refusal({ markets: ['IT'], op: 'unmute', why: 'not muted' })).toMatch(/IT: its suggestions are not muted/)
    await inside(() => unmuteMarkets(['DE']))
  })
})
