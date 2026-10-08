/**
 * ONE BRAIN AB-4 — Amazon's own rules on brain campaigns on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON). Amazon is a stub handed to the read (the answer of GET /sp/campaigns/{id}/budgetRules from a fixture in the
 * spec's shape): nothing leaves the process, and nothing here may write to Amazon.
 *
 *   table     AdsNativeRuleSnapshot: one row per campaign, invisible to another business through Prisma and raw SQL,
 *             refused without a business, row-level security forced with the business policy and the reference guard
 *   no-op     the bid brain not live and no product enrolled: the read asks nothing and writes nothing
 *   read      the brain campaigns only — LIVE under the bid brain, then every campaign of the enrolled product (own and
 *             shared); archived ones and another product's are left out; another business reads nothing of these
 *   map       each rule that acts on a brain campaign is a clash (an Amazon budget rule on budgets, a bidding strategy
 *             Amazon runs on bids), Amazon's rule is a writer of the lever it moves, idle rules are listed apart, the
 *             kinds Nexus cannot read are said; one on a campaign no brain runs is no clash; setup says what was read
 *   refuse    ending the adopted OBSERVE on a campaign whose bids Amazon runs (it would go LIVE: bids to AUTO) is
 *             refused with the rule's name and the way out, and changes nothing; a budget rule does not refuse the bids
 *             lever; once the strategy is back to one Nexus knows, the same change passes
 *   rollback  (follow-up) a give-back of a LIVE campaign whose bids Amazon runs is approved and runs; a product's change
 *             that would put a campaign LIVE only as a side effect (its own AUTO, sitting in shadow) skips it by name
 *             while Amazon runs its bids, and the rest of the plan runs — a step back to shadow included
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
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

const { readNativeRulesOnce } = await import('./native-rules.js')
const { brainSettings, enrollProduct, endOverride, planOverride, setLever } = await import('./enrollment.js')
const { decideApproval, runOrQueueTool } = await import('../../agents/approval-gate.service.js')
const { parseCampaignBudgetRules } = await import('../ads-api-client.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab4_rules_${hex}`
const W2 = `ab4_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const P = id('p'), P1 = id('p1'), Q = id('q'), Q1 = id('q1')
const NOW = new Date('2026-10-08T04:35:00Z')
const TABLE = 'AdsNativeRuleSnapshot'

type Data = Record<string, any>
const person = (userId: string, via: 'claude' | 'app') => ({
  kind: 'user' as const, userId, label: `Person ${userId}`, via, workspace: scope(W),
  permissions: { isOwner: false, permissions: new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
})
const tool = (args: Record<string, unknown>) => inW(() => ADS_BRAIN_TOOLS[0].handler!(args, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>

// Amazon, stubbed: the fixture's four rules on the budget campaign, none elsewhere; every ask recorded.
const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/sp-campaign-budget-rules.json', import.meta.url), 'utf8')) as unknown
const asked: string[] = []
const amazon = {
  listBudgetRules: async (_ctx: unknown, ext: string) => {
    asked.push(ext)
    const parsed = parseCampaignBudgetRules(ext === `EXT-${C('c-budget')}` ? FIXTURE : { associatedRules: [] })
    if ('error' in parsed) throw new Error(parsed.error)
    return parsed.rules
  },
  contextFor: async (m: string | null) => (m === 'IT' ? { profileId: 'p-it', region: 'EU' as const } : null),
  mode: () => 'live' as const,
}
const read = (now = NOW) => readNativeRulesOnce({ now, ...amazon })

const amazonRows = async () => (await rows<{ n: number }>(
  'SELECT ((SELECT count(*) FROM "AdMutation" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) + (SELECT count(*) FROM "AdvertisingActionLog" WHERE "workspaceId" = $1))::int AS n', [W]))[0].n
const snapshotIds = async (w: string) => (await rows<{ campaignId: string }>('SELECT "campaignId" FROM "AdsNativeRuleSnapshot" WHERE "workspaceId" = $1 ORDER BY "campaignId"', [w])).map((r) => r.campaignId)
const modes = async () => Object.fromEntries((await rows<{ campaignId: string; mode: string }>('SELECT "campaignId", mode FROM "BidBrainEnrollment" WHERE "workspaceId" = $1', [W])).map((r) => [r.campaignId, r.mode]))

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(P, `AB4-JACKET-${hex}`, { isParent: true })
  await product(P1, `AB4-JACKET-S-${hex}`, { parentId: P, amazonAsin: `B0AB4JKS${H}` })
  await product(Q, `AB4-GLOVE-${hex}`, { isParent: true })
  await product(Q1, `AB4-GLOVE-L-${hex}`, { parentId: Q, amazonAsin: `B0AB4GLL${H}` })
  const campaign = async (key: string, ads: Array<[string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: key, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: `g-${C(key)}`, campaignId: C(key), name: `group ${key}`, externalAdGroupId: `EXT-g-${C(key)}` } })
    await db.adTarget.create({ data: { id: `t-${C(key)}`, adGroupId: `g-${C(key)}`, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `jacket ${key}`, bidCents: 40, externalTargetId: `EXT-t-${C(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: `g-${C(key)}`, productId, asin } })
  }
  const jacket: [string, string] = [P1, `B0AB4JKS${H}`]
  const glove: [string, string] = [Q1, `B0AB4GLL${H}`]
  await campaign('a-live', [jacket], { dynamicBidding: { strategy: 'LEGACY_FOR_SALES' } })
  // Amazon runs this campaign's bids (rule-based bidding, as the settings sync read it).
  await campaign('b-rule', [jacket], { dynamicBidding: { strategy: 'RULE_BASED' }, lastSyncedAt: new Date('2026-10-08T04:20:00Z') })
  await campaign('c-budget', [jacket], { dynamicBidding: { strategy: 'LEGACY_FOR_SALES' } })
  await campaign('d-archived', [jacket], { status: 'ARCHIVED' })
  await campaign('e-shared', [jacket, glove])
  await campaign('q-other', [glove], { dynamicBidding: { strategy: 'RULE_BASED' } })
  await db.bidBrainEnrollment.create({ data: { campaignId: C('a-live'), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [], placements: [] } } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-4 — Amazon\'s own rules on brain campaigns (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: one row per campaign, invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const row = await inW(() => db.adsNativeRuleSnapshot.create({ data: { campaignId: 'x-table-test', externalCampaignId: '1', marketplace: 'IT', fetchedAt: NOW, readings: { budgetRules: { state: 'read', rules: [] } } } }))
    expect(row).toMatchObject({ workspaceId: W, campaignId: 'x-table-test' })
    await expect(inW(() => db.adsNativeRuleSnapshot.create({ data: { campaignId: 'x-table-test', externalCampaignId: '1', fetchedAt: NOW, readings: {} } }))).rejects.toMatchObject({ code: 'P2002' })
    await inW2(async () => {
      expect(await db.adsNativeRuleSnapshot.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsNativeRuleSnapshot"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsNativeRuleSnapshot" SET marketplace = 'DE' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsNativeRuleSnapshot.create({ data: { workspaceId: W, campaignId: 'x', externalCampaignId: '1', fetchedAt: NOW, readings: {} } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      // The same campaign id in another business is its own row.
      expect((await db.adsNativeRuleSnapshot.create({ data: { campaignId: 'x-table-test', externalCampaignId: '1', fetchedAt: NOW, readings: {} } })).workspaceId).toBe(W2)
    })
    await expect(db.adsNativeRuleSnapshot.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [TABLE])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [TABLE])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [TABLE])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "AdsNativeRuleSnapshot" WHERE "campaignId" = \'x-table-test\'')
  })

  it('no-op: the bid brain not live and no product enrolled — Amazon is not asked, nothing is written', async () => {
    expect(await inW(() => read())).toMatchObject({ ran: false, calls: 0 })
    expect(asked).toEqual([])
    expect(await snapshotIds(W)).toEqual([])
  })

  it('the read: the LIVE campaign, then every campaign of the enrolled product; archived and another product\'s left out; another business reads none', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    expect(await inW(() => read())).toMatchObject({ ran: true, campaigns: 1, read: 1, calls: 1, acting: 0 })
    expect(asked).toEqual([`EXT-${C('a-live')}`])
    // The product enrolled (bids adopted AUTO from its LIVE campaign; the others kept in shadow by an adopted OBSERVE).
    expect(await inW(() => enrollProduct({ productId: P, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, bids: 'AUTO', keptInShadow: [C('b-rule'), C('c-budget')] })
    asked.length = 0
    expect(await inW(() => read())).toMatchObject({ ran: true, campaigns: 4, read: 4, couldNotRead: 0, calls: 4, acting: 2 })
    expect(asked.sort()).toEqual(['a-live', 'b-rule', 'c-budget', 'e-shared'].map((k) => `EXT-${C(k)}`).sort())
    expect(await snapshotIds(W)).toEqual(['a-live', 'b-rule', 'c-budget', 'e-shared'].map(C).sort())
    // A rerun the same day replaces the same rows.
    await inW(() => read())
    expect(await snapshotIds(W)).toEqual(['a-live', 'b-rule', 'c-budget', 'e-shared'].map(C).sort())
    asked.length = 0
    expect(await inW2(() => read())).toMatchObject({ ran: true, campaigns: 0, calls: 0 })
    expect(asked).toEqual([])
    expect(await inW2(() => database.client.adsNativeRuleSnapshot.findMany({ where: { campaignId: { startsWith: hex } } }))).toEqual([])
  })

  it('map and clashes: each Amazon rule on a brain campaign is a clash and a writer of its lever; one elsewhere is not; setup says what was read', async () => {
    const out = await tool({ view: 'clashes', market: 'IT', productId: P })
    expect(out.ok).toBe(true)
    const gap = out.data!.gaps.amazonRules
    expect(gap.clashes.map((c: Data) => [c.name, c.kind, c.rule, c.levers]).sort()).toEqual([
      ['b-rule', 'ruleBasedBidding', 'RULE_BASED', ['bids', 'biddingStrategy']],
      ['c-budget', 'budgetRules', 'ROAS above 4', ['budgets']],
      ['c-budget', 'budgetRules', 'Weekend boost', ['budgets']],
    ])
    expect(gap.notBrainCampaigns).toBeUndefined()
    // Said, not guessed: the kinds Nexus cannot read, and the shared campaign whose strategy the sync never read.
    expect(gap.couldNotRead).toEqual([
      expect.objectContaining({ kind: 'optimizationRules' }), expect.objectContaining({ kind: 'scheduleBidRules' }),
      expect.objectContaining({ campaignId: C('e-shared'), kind: 'ruleBasedBidding', why: expect.stringMatching(/has not read this campaign's bidding strategy/) }),
    ])
    // The market's view: the other product's campaign Amazon also runs is listed apart — no brain there, no clash.
    const market = await tool({ view: 'clashes', market: 'IT' })
    expect(market.data!.gaps.amazonRules.notBrainCampaigns).toEqual([expect.objectContaining({ campaignId: C('q-other'), kind: 'ruleBasedBidding' })])
    // One campaign's map: Amazon's rule writes its budgets; the paused and the ended rules are attached but idle.
    const map = await tool({ view: 'map', campaignId: C('c-budget') })
    const c = map.data!.campaigns[0]
    expect(c.brainCampaign).toBe(true)
    expect(c.levers.budgets.writers).toEqual(expect.arrayContaining([
      expect.objectContaining({ who: 'Amazon budget rule "Weekend boost"', kind: 'amazon', state: 'acts', basis: 'configured' }),
      expect.objectContaining({ who: 'Amazon budget rule "ROAS above 4"', kind: 'amazon' }),
    ]))
    expect(c.levers.budgets.owner).toMatch(/^two or more writers: Amazon budget rule "ROAS above 4", Amazon budget rule "Weekend boost"/)
    expect(c.amazonRules.idle.map((r: Data) => r.name)).toEqual(['Event push', 'Summer sale'])
    expect(map.data!.amazonRulesNotRead.map((k: Data) => k.kind)).toEqual(['optimizationRules', 'scheduleBidRules'])
    // The bids of the rule-based campaign: Amazon's strategy is its writer.
    const b = (await tool({ view: 'map', campaignId: C('b-rule') })).data!.campaigns[0]
    expect(b.levers.bids.writers).toContainEqual(expect.objectContaining({ who: 'Amazon-run bidding strategy "RULE_BASED"', kind: 'amazon' }))
    const setup = await tool({ view: 'setup', market: 'IT' })
    expect(setup.data!.brain).toContainEqual(expect.objectContaining({
      item: 'Amazon\'s own rules',
      state: expect.stringMatching(/^budget rules: the daily read covers 4 brain campaigns, last at 2026-10-08T04:35:00.000Z; 2 rules act on a brain campaign/),
      fix: expect.stringMatching(/^detach each rule on a brain campaign/),
    }))
  })

  it('a lever does not go AUTO where Amazon\'s rule acts on it: refused by name, nothing changes; a budget rule does not refuse bids; back to a known strategy, it passes', async () => {
    const before = await modes()
    const endAdopted = (key: string) => ({ productId: P, market: 'IT', override: { scope: 'CAMPAIGN' as const, campaignId: C(key), kind: 'LEVEL' as const, key: 'bids' }, by: 'user:owner', now: NOW })
    const refused = await inW(() => endOverride(endAdopted('b-rule')))
    expect(refused).toEqual({ ok: false, refusal: expect.stringMatching(/^the bids lever cannot go AUTO while Amazon's own rule acts on it there — Amazon-run bidding strategy "RULE_BASED" on campaign b-rule .*detach the rule in Amazon's Campaign Manager/) })
    expect(await modes()).toEqual(before)
    expect(await rows('SELECT count(*)::int n FROM "AdsBrainOverride" WHERE "workspaceId" = $1 AND "campaignId" = $2 AND "endedAt" IS NULL', [W, C('b-rule')])).toEqual([{ n: 1 }])
    // The budget rules on c-budget move its budgets, not its bids: its bids may go AUTO (the preview is not refused by AB-4).
    expect(await inW(() => planOverride({ productId: P, market: 'IT', end: endAdopted('c-budget').override }))).toMatchObject({ ok: true })
    // The Owner switched b-rule back to down only in the console; the settings sync read it: the same change passes.
    await database.pool.query('UPDATE "Campaign" SET "dynamicBidding" = \'{"strategy":"LEGACY_FOR_SALES"}\' WHERE id = $1', [C('b-rule')])
    expect(await inW(() => planOverride({ productId: P, market: 'IT', end: endAdopted('b-rule').override }))).toMatchObject({ ok: true })
    expect(await amazonRows()).toBe(0)
  })
  it('follow-up: a give-back of a LIVE campaign whose bids Amazon runs is approved and runs — a way back is never refused for Amazon\'s rule', async () => {
    await database.pool.query('UPDATE "Campaign" SET "dynamicBidding" = \'{"strategy":"RULE_BASED"}\' WHERE id = $1', [C('a-live')])
    const decided = await inW(async () => {
      const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: 'u-asker' } })
      const asked = await runOrQueueTool('set-bid-brain-enrollment', { campaignId: C('a-live'), op: 'give-back', why: 'AB-4 follow-up rollback' }, person('u-asker', 'claude'), run.id)
      expect(asked).toMatchObject({ ok: true, mode: 'queued' })
      return decideApproval(asked.approvalId!, 'approve', person('u-approver', 'app'))
    })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect((await modes())[C('a-live')]).toBe('SHADOW')
    // Recorded as the Owner's campaign choice through the product's brain: the change to OBSERVE was not refused.
    expect((await inW(() => brainSettings(P, 'IT', C('a-live'))))?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'campaign' }, effective: 'OBSERVE' })
  })

  it('follow-up: a campaign the product\'s change would put LIVE only as a side effect is skipped by name while Amazon runs its bids; the rest of the plan runs', async () => {
    const db = database.client
    // b-rule: its own campaign AUTO, sitting in shadow (it could not go LIVE when it was set); Amazon now runs its bids.
    await database.pool.query('UPDATE "AdsBrainOverride" SET "endedAt" = now(), "endedBy" = \'user:owner\' WHERE "workspaceId" = $1 AND "campaignId" = $2 AND "endedAt" IS NULL', [W, C('b-rule')])
    await inW(() => db.adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'CAMPAIGN', campaignId: C('b-rule'), kind: 'LEVEL', key: 'bids', value: 'AUTO', by: 'user:owner', reason: 'its own choice; it could not go LIVE then' } }))
    await database.pool.query('UPDATE "Campaign" SET "dynamicBidding" = \'{"strategy":"RULE_BASED"}\' WHERE id = ANY($1)', [[C('b-rule'), C('c-budget')]])
    // c-budget: LIVE (by hand) under its adopted OBSERVE, with Amazon running its bids too: the plan takes it back to shadow.
    await inW(() => db.bidBrainEnrollment.create({ data: { campaignId: C('c-budget'), marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner-1008', snapshot: { takenAt: '2026-10-08T10:56:00.000Z', adGroups: [], targets: [], placements: [] } } }))
    const r = await inW(() => setLever({ productId: P, market: 'IT', lever: 'bids', level: 'OBSERVE', by: 'user:owner', now: NOW }))
    expect(r).toMatchObject({ ok: true })
    const steps = (r as { plan: { steps: Array<Record<string, unknown>>; goesLive: string[] } }).plan
    expect(steps.goesLive).toEqual([])
    expect(steps.steps).toEqual(expect.arrayContaining([
      { campaignId: C('b-rule'), name: 'b-rule', op: 'skip', why: expect.stringMatching(/^an Amazon rule acts on it: Amazon-run bidding strategy "RULE_BASED" \(Amazon's rule-based bidding .*\) — it stays in shadow$/) },
      expect.objectContaining({ campaignId: C('c-budget'), op: 'shadow' }),
    ]))
    const now = await modes()
    expect(now[C('c-budget')]).toBe('SHADOW')
    expect(now[C('b-rule')]).toBeUndefined()
    expect((await inW(() => brainSettings(P, 'IT')))?.levers.bids).toMatchObject({ level: { value: 'OBSERVE', source: 'product' } })
  })
})
