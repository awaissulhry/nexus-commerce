/**
 * ONE BRAIN AB-10 — the negatives module on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the server switch `live`, the ads mode LIVE, the job queue a stub and Amazon's create calls a recorder: nothing
 * leaves the process. One made-up jacket in IT — an auto, an exact (home of "racing jacket") and a broad campaign — a glove
 * with a campaign of its own, and a campaign both advertise; the IT strategy's 25 % target, the jacket's brand word and
 * negative set in its playbook, a protected term.
 *
 *   table     AdsBrainNegative: one row per (product, market, key), invisible to another business, refused without one,
 *             row-level security forced with the business policy and the reference guard
 *   no-op     nothing enrolled: the tick reads the enrollments, decides nothing, writes nothing, records no run
 *   shadow    the jacket enrolled (negatives OBSERVE by default): the day's negatives logged as SHADOW — the playbook's set
 *             in every keyword and auto ad group, the waste term exact where it served, the home's term isolated in the
 *             auto ad group, a rule's negative over a term that converted where it stands revived — and nothing at
 *             Amazon; never the brand, the protected term or the shared campaign; a rerun changes nothing
 *   AUTO      the lever at AUTO, the shadow days at the Owner's 0: each add written as the brain through the one negative
 *             write service and the real write gate (rows, audit rows naming automation:ads-brain-negatives, Amazon's ids),
 *             the revive queued through the retire queue; a rerun the same day writes nothing more
 *   not owned an excluded campaign takes nothing (named); the gate refuses the brain's negatives actor on a campaign its
 *             brain does not own (the glove's) and passes it on the jacket's; back at OBSERVE a new waste term is only logged
 *   PROPOSE   one change plan for the day (submit-change-plan, add-negative-targets steps) waiting for a person; a rerun asks
 *             nothing again
 *   read      the ads-brain negatives view: the day decided now, every entity against the limit, the campaigns left, the
 *             log; the market's logs; every amount hidden without the ad-spend permission; another business sees nothing
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
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
/** Amazon, as a recorder of the negative creates the gate let through (nothing leaves the process). */
const amz = vi.hoisted(() => ({ keywords: [] as Array<Record<string, unknown>>, products: [] as Array<Record<string, unknown>>, calls: [] as Array<Record<string, unknown>> }))
vi.mock('../ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ads-api-client.js')>()
  return {
    ...real,
    createNegativeKeyword: async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-NK-${amz.keywords.length}`, rawResponse: {} } },
    createNegativeProductTarget: async (_ctx: unknown, input: Record<string, unknown>) => { amz.products.push(input); return { ok: true, mode: 'live', externalId: `AMZ-NP-${amz.products.length}`, rawResponse: {} } },
    liveCall: async (req: Record<string, unknown>) => { amz.calls.push(req); return { campaignNegativeKeywords: { success: [{ keywordId: `AMZ-CNK-${amz.calls.length}` }] } } },
  }
})

const { runNegativesOnce, negativesDue } = await import('./negatives-run.js')
const { runBrainNegativesTick, BRAIN_NEGATIVES_JOB } = await import('../../../jobs/ads-brain-negatives.job.js')
const { enrollProduct, setLever, setOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { checkAdsWriteGate, BRAIN_NEGATIVES_ACTOR } = await import('../ads-write-gate.js')
const { writeNegativeKeyword } = await import('../ads-negative-kw.service.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')
const { visibleTo } = await import('../../agents/call-tool.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab10_neg_${hex}`
const W2 = `ab10_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const JACKET = id('jacket'), JACKET_M = id('jacket-m'), GLOVE = id('glove'), GLOVE_L = id('glove-l')
const NOW = new Date('2026-10-09T05:25:00Z')
const DAY = 86_400_000

type Data = Record<string, any>
const view = (args: Record<string, unknown>, inX: <T>(work: () => Promise<T>) => Promise<T> = inW) =>
  inX(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'negatives', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>
// Through Prisma inside the business: a TIMESTAMP read through the raw pool lands on this machine's local clock.
const log = async () => (await inW(() => database.client.adsBrainNegative.findMany({ where: { productId: JACKET }, orderBy: { key: 'asc' } }))) as Data[]
const brief = (r: Data) => `${r.action} ${r.reason} ${r.match} "${r.text}" ${r.level === 'CAMPAIGN' ? r.campaignId : r.adGroupId} ${r.status}`
const negativeRows = async () => rows<{ id: string; expressionValue: string; expressionType: string; adGroupId: string; externalTargetId: string | null; status: string }>(
  'SELECT id, "expressionValue", "expressionType", "adGroupId", "externalTargetId", status::text FROM "AdTarget" WHERE "workspaceId" = $1 AND "isNegative" ORDER BY "adGroupId", "expressionValue"', [W])
const traces = async () => (await rows<{ q: number; l: number; m: number }>(
  'SELECT (SELECT count(*)::int FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) q, (SELECT count(*)::int FROM "AdvertisingActionLog" WHERE "workspaceId" = $1) l, (SELECT count(*)::int FROM "AdMutation" WHERE "workspaceId" = $1) m', [W]))[0]

/** One search-term row: clicks, orders, spend and sales in cents, on one day. */
const st = (campaign: string, query: string, clicks: number, orders: number, spendCents: number, salesCents: number, date = '2026-09-20') => ({
  profileId: 'p-it', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(`${date}T00:00:00Z`), campaignId: `EXT-${C(campaign)}`, adGroupId: `EXT-${G(campaign)}`,
  query, impressions: clicks * 7, clicks, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: salesCents, orders7d: orders,
})

async function seed() {
  const db = database.client
  const product = (pid: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: pid, sku, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(JACKET, `AB10-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(JACKET_M, `AB10-JACKET-M-${hex}`, { parentId: JACKET, amazonAsin: `B0AB10JK${H}` })
  await product(GLOVE, `AB10-GLOVE-${hex}`, { isParent: true, name: 'Glove', basePrice: '30.00' })
  await product(GLOVE_L, `AB10-GLOVE-L-${hex}`, { parentId: GLOVE, amazonAsin: `B0AB10GL${H}`, basePrice: '30.00' })
  const campaign = async (key: string, ads: Array<[string, string]>, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: key, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: `${key} group`, externalAdGroupId: `EXT-${G(key)}` } })
    for (const [productId, asin] of ads) await db.adProductAd.create({ data: { adGroupId: G(key), productId, asin } })
  }
  const kw = (key: string, tid: string, text: string, match: string, extra: Record<string, unknown> = {}) =>
    db.adTarget.create({ data: { id: id(tid), adGroupId: G(key), kind: 'KEYWORD', expressionType: match, expressionValue: text, bidCents: 50, externalTargetId: `EXT-${id(tid)}`, ...extra } })
  const jacket: [string, string] = [JACKET_M, `B0AB10JK${H}`]
  const glove: [string, string] = [GLOVE_L, `B0AB10GL${H}`]
  await campaign('jk-auto', [jacket], { targetingType: 'AUTO' })
  await campaign('jk-exact', [jacket], { targetingType: 'MANUAL' })
  await campaign('jk-broad', [jacket], { targetingType: 'MANUAL' })
  await campaign('gl-exact', [glove], { targetingType: 'MANUAL' })
  await campaign('shared', [jacket, glove], { targetingType: 'AUTO' })
  await kw('jk-exact', 't-racing', 'racing jacket', 'EXACT')
  await kw('jk-broad', 't-moto', 'moto jacket', 'BROAD')
  await kw('gl-exact', 't-winter', 'winter gloves', 'EXACT')
  // A rule's old negative over "city jacket" in the broad ad group, where the term converted since.
  await kw('jk-broad', 'n-city', 'city jacket', 'NEGATIVE_EXACT', { isNegative: true, negativeLevel: 'AD_GROUP', bidCents: 0 })
  await db.advertisingActionLog.create({ data: { userId: 'automation:rule-old', actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: id('n-city'), payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUCCESS' } })
  await db.amazonAdsSearchTerm.createMany({
    data: [
      st('jk-auto', 'cheap jacket', 800, 0, 16_000, 0),
      st('jk-exact', 'racing jacket', 600, 18, 12_000, 144_000),
      st('jk-auto', 'racing jacket', 100, 0, 2000, 0),
      st('jk-broad', 'storm jacket', 900, 0, 18_000, 0),
      st('jk-auto', 'giacca moto acme', 900, 0, 18_000, 0),
      // Converts, at too high a cost per click to be harvested: WATCH (a harvest candidate's source negative is AB-11's).
      st('jk-broad', 'city jacket', 40, 1, 4000, 8000),
      st('gl-exact', 'winter gloves', 300, 3, 3000, 9000),
      st('shared', 'cheap gloves', 1000, 0, 10_000, 0),
    ],
  })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.adsPlaybook.create({ data: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: JACKET, label: 'Jacket (IT)', enrolled: true, terms: { brand: ['storm'], negatives: [{ text: 'free', match: 'EXACT' }] }, updatedBy: 'user:owner' } })
  await db.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'acme', matchType: 'CONTAINS', marketplace: 'IT', reason: 'brand' } })
  await db.amazonAdsConnection.create({ data: { profileId: `P-IT-${hex}`, marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
  await setAutonomy('AUTO', 'test')
}

describe.skipIf(!concurrentDatabaseUrl())('AB-10 — the negatives module (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(seed)
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: one row per product × market × key, invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const base = { action: 'ADD', reason: 'waste', reasons: ['waste'], kind: 'KEYWORD', match: 'EXACT', text: 'x', level: 'AD_GROUP', campaignId: 'c', mode: 'OBSERVE', status: 'SHADOW', why: 't', evidence: {}, digest: 'd', runId: 'r', dataDay: NOW, firstSeenAt: NOW, checkedAt: NOW, changedAt: NOW }
    const row = await inW(() => db.adsBrainNegative.create({ data: { productId: 'x-table', marketplace: 'IT', key: 'k', ...base } }))
    expect(row.workspaceId).toBe(W)
    await expect(inW(() => db.adsBrainNegative.create({ data: { productId: 'x-table', marketplace: 'IT', key: 'k', ...base } }))).rejects.toMatchObject({ code: 'P2002' })
    await inW2(async () => {
      expect(await db.adsBrainNegative.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainNegative"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainNegative" SET status = 'WRITTEN' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsBrainNegative.create({ data: { workspaceId: W, productId: 'x', marketplace: 'IT', key: 'k', ...base } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
      expect((await db.adsBrainNegative.create({ data: { productId: 'x-table', marketplace: 'IT', key: 'k', ...base } })).workspaceId).toBe(W2)
    })
    await expect(db.adsBrainNegative.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', ['AdsBrainNegative'])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', ['AdsBrainNegative'])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', ['AdsBrainNegative'])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "AdsBrainNegative" WHERE "productId" = \'x-table\'')
  })

  it('no-op: nothing enrolled — the tick decides nothing, writes nothing and records no run', async () => {
    expect(await inW(() => negativesDue())).toMatchObject({ due: false, why: expect.stringMatching(/no product is enrolled/) })
    expect(await inW(() => runBrainNegativesTick(NOW))).toMatchObject({ ran: false, planned: 0, pruned: 0 })
    expect(await rows('SELECT count(*)::int AS n FROM "AdsBrainNegative" WHERE "workspaceId" = $1', [W])).toEqual([{ n: 0 }])
    expect(await rows('SELECT count(*)::int AS n FROM "CronRun" WHERE "jobName" = $1', [BRAIN_NEGATIVES_JOB])).toEqual([{ n: 0 }])
  })

  it('shadow: the jacket\'s day logged — its set, the waste, the isolation, the revive — and nothing at Amazon; a rerun changes nothing', async () => {
    const before = { traces: await traces(), negatives: await negativeRows() }
    expect(await inW(() => enrollProduct({ productId: JACKET_M, market: 'IT', by: 'user:owner', now: new Date(NOW.getTime() - 30 * DAY) }))).toMatchObject({ ok: true, productId: JACKET })
    const run = await inW(() => runBrainNegativesTick(NOW))
    expect(run).toMatchObject({ ran: true, products: 1, markets: ['IT'], skipped: [], proposed: [] })
    expect(await rows('SELECT status FROM "CronRun" WHERE "jobName" = $1', [BRAIN_NEGATIVES_JOB])).toHaveLength(1)
    const l = await log()
    expect(l.map(brief).sort()).toEqual([
      `ADD isolation EXACT "racing jacket" ${G('jk-auto')} SHADOW`,
      `ADD productSet EXACT "free" ${G('jk-auto')} SHADOW`,
      `ADD productSet EXACT "free" ${G('jk-broad')} SHADOW`,
      `ADD productSet EXACT "free" ${G('jk-exact')} SHADOW`,
      `ADD waste EXACT "cheap jacket" ${G('jk-auto')} SHADOW`,
      `RETIRE reviveConverts EXACT "city jacket" ${G('jk-broad')} SHADOW`,
    ])
    expect(l.every((r) => r.mode === 'OBSERVE' && r.actedAt === null)).toBe(true)
    expect(l.find((r) => r.reason === 'reviveConverts')).toMatchObject({ negativeId: id('n-city'), origin: 'automation' })
    // Never the brand word, the protected term, nor the shared campaign's terms; nothing at Amazon.
    expect(l.some((r) => /storm|acme|gloves/.test(r.text) || r.campaignId === C('shared'))).toBe(false)
    expect(amz).toMatchObject({ keywords: [], products: [], calls: [] })
    expect(await traces()).toEqual(before.traces)
    expect(await negativeRows()).toEqual(before.negatives)
    const again = await inW(() => runNegativesOnce({ now: new Date(NOW.getTime() + 60_000) }))
    expect(again.stored).toEqual({ created: 0, changed: 0, unchanged: 6 })
  })

  it('AUTO (owned): each add written as the brain through the negative write service and the real gate; the revive queued; a rerun writes nothing more', async () => {
    forgetLeverOwners()
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', lever: 'negatives', level: 'AUTO', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: JACKET, market: 'IT', by: 'user:owner', now: NOW, override: { scope: 'PRODUCT', kind: 'VALUE', key: 'negativesShadowDays', value: 0 } }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const run = await inW(() => runNegativesOnce({ now: NOW }))
    expect(run.byStatus).toEqual({ WRITTEN: 5, QUEUED: 1 })
    const l = await log()
    expect(l.filter((r) => r.action === 'ADD').every((r) => r.status === 'WRITTEN' && r.mode === 'AUTO' && r.adTargetId && /added at Amazon \(AMZ-NK-\d\)/.test(r.result))).toBe(true)
    // Amazon was asked for exactly these five, each in its ad group.
    expect(amz.keywords.map((k) => `${k.keywordText}@${k.externalAdGroupId}`).sort()).toEqual([
      `cheap jacket@EXT-${G('jk-auto')}`, `free@EXT-${G('jk-auto')}`, `free@EXT-${G('jk-broad')}`, `free@EXT-${G('jk-exact')}`, `racing jacket@EXT-${G('jk-auto')}`,
    ])
    const made = (await negativeRows()).filter((n) => n.externalTargetId?.startsWith('AMZ-'))
    expect(made).toHaveLength(5)
    const audits = await rows<{ userId: string; n: number }>('SELECT "userId", count(*)::int n FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "actionType" = \'create_negative_keyword\' AND "entityId" = ANY($2) GROUP BY "userId"', [W, made.map((m) => m.id)])
    expect(audits).toEqual([{ userId: BRAIN_NEGATIVES_ACTOR, n: 5 }])
    // The revive: the rule's negative archived here and queued for Amazon (the gate judges it at dispatch).
    const revive = l.find((r) => r.reason === 'reviveConverts')!
    expect(revive).toMatchObject({ status: 'QUEUED', mode: 'AUTO' })
    expect(revive.outboundQueueId).toBeTruthy()
    expect(await rows('SELECT status::text FROM "AdTarget" WHERE id = $1', [id('n-city')])).toEqual([{ status: 'ARCHIVED' }])
    expect(await rows('SELECT "userId" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1 AND "actionType" = \'retire_negative\'', [W])).toEqual([{ userId: BRAIN_NEGATIVES_ACTOR }])
    expect(await rows('SELECT count(*)::int n FROM "OutboundSyncQueue" WHERE "workspaceId" = $1 AND id = $2', [W, revive.outboundQueueId])).toEqual([{ n: 1 }])
    // A rerun the same day: everything stands, nothing more is sent.
    const sent = amz.keywords.length
    const tracesNow = await traces()
    const again = await inW(() => runNegativesOnce({ now: new Date(NOW.getTime() + 60_000) }))
    expect(again.byStatus).toEqual({})
    expect(amz.keywords).toHaveLength(sent)
    expect(await traces()).toEqual(tracesNow)
  })

  it('not owned: an excluded campaign takes nothing (named); the gate refuses the brain\'s negatives actor where its brain owns nothing; back at OBSERVE a new term is only logged', async () => {
    // A new waste term in the auto and the broad campaign, the next day; the broad campaign excluded by the Owner.
    await inW(() => database.client.amazonAdsSearchTerm.createMany({ data: [st('jk-auto', 'bargain jacket', 400, 0, 8000, 0, '2026-09-21'), st('jk-broad', 'bargain jacket', 400, 0, 8000, 0, '2026-09-21')] }))
    expect(await inW(() => setOverride({ productId: JACKET, market: 'IT', by: 'user:owner', reason: 'mine', now: NOW, override: { scope: 'CAMPAIGN', campaignId: C('jk-broad'), kind: 'EXCLUDE', key: '*' } }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const next = new Date(NOW.getTime() + DAY)
    const run = await inW(() => runNegativesOnce({ now: next }))
    expect(run.byStatus).toMatchObject({ WRITTEN: 1 })
    expect(amz.keywords.at(-1)).toMatchObject({ keywordText: 'bargain jacket', externalAdGroupId: `EXT-${G('jk-auto')}` })
    expect((await log()).filter((r) => r.text === 'bargain jacket').map(brief)).toEqual([`ADD waste EXACT "bargain jacket" ${G('jk-auto')} WRITTEN`])
    const day = await view({ market: 'IT', productId: JACKET_M, now: next })
    expect(day.data!.skippedCampaigns).toEqual([{ campaignId: C('jk-broad'), name: 'jk-broad', why: expect.stringMatching(/excluded by the Owner's campaign override/) }])

    // The real gate: the brain's negatives actor passes on the jacket's own campaign, never on the glove's (its brain owns
    // nothing there), as for a queued retire at dispatch; a write through the service there is refused and leaves nothing.
    const asWorker = (campaignId: string) => inW(() => checkAdsWriteGate({ marketplace: 'IT', campaignId, payloadValueCents: 0, field: 'status', fields: ['status'], dimension: 'negatives', actor: BRAIN_NEGATIVES_ACTOR } as never))
    expect(await asWorker(C('jk-auto'))).toMatchObject({ allowed: true, mode: 'live' })
    expect(await asWorker(C('gl-exact'))).toMatchObject({ allowed: false, deniedAt: 'brain_not_owner', reason: expect.stringMatching(/writes only a lever the brain owns: the negatives of campaign "gl-exact"/) })
    const before = await negativeRows()
    const refused = await inW(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: G('gl-exact'), keywordText: 'cheap gloves', matchType: 'EXACT', userId: BRAIN_NEGATIVES_ACTOR }))
    expect(refused).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'brain_not_owner' }, adTargetId: null })
    expect(await negativeRows()).toEqual(before)

    // Back at OBSERVE: a new waste term is decided and logged, never written.
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', lever: 'negatives', level: 'OBSERVE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    await inW(() => database.client.amazonAdsSearchTerm.create({ data: st('jk-auto', 'outlet jacket', 800, 0, 16_000, 0, '2026-09-22') }))
    const sent = amz.keywords.length
    await inW(() => runNegativesOnce({ now: new Date(NOW.getTime() + 2 * DAY) }))
    expect((await log()).filter((r) => r.text === 'outlet jacket').map(brief)).toEqual([`ADD waste EXACT "outlet jacket" ${G('jk-auto')} SHADOW`])
    expect(amz.keywords).toHaveLength(sent)
  })

  it('PROPOSE: the day\'s negatives as one change plan waiting for a person; a rerun asks nothing again', async () => {
    expect(await inW(() => setLever({ productId: JACKET, market: 'IT', lever: 'negatives', level: 'PROPOSE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    forgetLeverOwners()
    const at = new Date(NOW.getTime() + 2 * DAY + 3_600_000)
    const run = await inW(() => runNegativesOnce({ now: at }))
    expect(run.proposed).toHaveLength(1)
    const approvalId = run.proposed[0]
    const row = (await log()).find((r) => r.text === 'outlet jacket')!
    expect(row).toMatchObject({ status: 'PROPOSED', mode: 'PROPOSE', approvalId })
    expect(await rows('SELECT "toolName", status FROM "AgentApproval" WHERE id = $1', [approvalId])).toEqual([{ toolName: 'submit-change-plan', status: 'pending' }])
    const steps = await rows<{ toolName: string; args: Data }>('SELECT "toolName", args FROM "AgentPlanStep" WHERE "approvalId" = $1 ORDER BY position', [approvalId])
    expect(steps.map((s) => s.toolName)).toEqual(['add-negative-targets'])
    expect(steps[0].args).toMatchObject({ negatives: [{ adGroupId: G('jk-auto'), text: 'outlet jacket', matchType: 'NEGATIVE_EXACT' }], product: JACKET })
    // Nothing written: a person decides.
    expect(amz.keywords.some((k) => k.keywordText === 'outlet jacket')).toBe(false)
    const again = await inW(() => runNegativesOnce({ now: new Date(at.getTime() + 60_000) }))
    expect(again.proposed).toEqual([])
    expect(await rows('SELECT count(*)::int n FROM "AgentApproval" WHERE "workspaceId" = $1 AND "toolName" = \'submit-change-plan\'', [W])).toEqual([{ n: 1 }])
  })

  it('read: the day decided now, every entity against the limit, the log; the market\'s logs; every amount hidden without the ad-spend permission; another business sees nothing', async () => {
    const out = await view({ market: 'IT', productId: JACKET_M, now: new Date(NOW.getTime() + 2 * DAY + 7_200_000) })
    expect(out.ok).toBe(true)
    const d = out.data!
    expect(d.scope).toEqual({ productId: JACKET, market: 'IT' })
    expect(d.product).toMatchObject({ enrolled: true, lever: { effective: 'PROPOSE' } })
    expect(d.shadow).toMatchObject({ inShadow: false, days: 0, ceilingLive: true })
    expect(d.adds.map((a: Data) => [a.negative.text, a.status])).toEqual([['outlet jacket', 'PROPOSED']])
    expect(d.entities.find((e: Data) => e.id === G('jk-auto'))).toMatchObject({ kind: 'AD_GROUP', standing: 4, warn: 800, max: 950, amazonLimit: 1000, state: 'ok' })
    expect(d.log.rows.length).toBeGreaterThanOrEqual(8)
    const market = await view({ market: 'IT' })
    expect(market.data!.products).toEqual([expect.objectContaining({ productId: JACKET, name: 'Jacket', byStatus: expect.objectContaining({ WRITTEN: 6, PROPOSED: 1 }), waitingRequests: [expect.any(String)] })])
    // The glove is not enrolled: decided as if at the default level, stored nowhere.
    const glove = await view({ market: 'IT', productId: GLOVE })
    expect(glove.data!.product).toMatchObject({ enrolled: false, lever: { effective: 'NOT_ENROLLED' } })
    expect(await rows('SELECT count(*)::int n FROM "AdsBrainNegative" WHERE "workspaceId" = $1 AND "productId" = $2', [W, GLOVE])).toEqual([{ n: 0 }])
    // A person who may read ads but not their money: the same answer minus every money key.
    const principal = (perms: string[]) => ({ kind: 'user' as const, userId: 'u', label: 'u', via: 'claude' as const, workspace: scope(W), permissions: { isOwner: false, permissions: new Set<string>(perms) } })
    const everything = [...Object.values(FEATURES), ...Object.values(FIELDS)]
    const noMoney = everything.filter((p) => !p.startsWith('financials.'))
    for (const answer of [d, market.data]) {
      expect(JSON.stringify(visibleTo(principal(everything) as never, ADS_BRAIN_TOOLS[0], answer))).toBe(JSON.stringify(answer))
      const text = JSON.stringify(visibleTo(principal(noMoney) as never, ADS_BRAIN_TOOLS[0], answer))
      expect(text).not.toContain('"money":')
      expect(text).not.toContain('spendCents')
      expect(text).toBe(JSON.stringify(answer, (k, v) => (k === 'money' ? undefined : v)))
    }
    expect((await view({ market: 'IT' }, inW2)).data!.products).toEqual([])
    expect(await inW2(() => runNegativesOnce({ now: NOW }))).toMatchObject({ ran: false, pruned: 0 })
  })
})
