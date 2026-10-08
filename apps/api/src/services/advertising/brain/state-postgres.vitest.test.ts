/**
 * ONE BRAIN AB-12 — the state lever on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs,
 * row-level policies on, the app as the restricted runtime login, business profiles ON), the server switch `live`, the ads
 * mode LIVE (the real write gate judges every write) and the job queue a stub: nothing leaves the process — a write is at
 * most queued (OutboundSyncQueue), never sent to Amazon.
 *
 *   table     AdsBrainStateDecision: invisible to another business through Prisma and raw SQL, refused without a business,
 *             row-level security forced with the business policy and the reference guard
 *   no-op     nothing enrolled (production today): nothing decided, nothing written
 *   OBSERVE   the JACKET family out of stock with a purchase order dated 10 days out: each of its campaigns logged as a
 *             SHADOW pause with that horizon — nothing asked, nothing queued, every status as it was
 *   AUTO      the state lever at AUTO: the brain's pause goes through the real status path and the real gate (owned →
 *             one queued status write as the brain, its memory on the log); the excluded campaign is left alone; a rerun
 *             writes nothing
 *   not owned the brain's state writer on a campaign no brain owns is refused by the gate: nothing written
 *   holds     a person's pause is a hold: the brain never resumes it
 *   resume    stock back: the brain's pause, 30 hours on, resumed — ENABLED again, the stop's memory (lanes, strategy, the
 *             keywords' remembered bids, the floor's mark) exactly as before, only the status written
 *   lock      the Owner's lock of the state lever: the brain refused at the gate in his words, and decides nothing
 *   archive   the HELMET family's campaign without an impression for 4 weeks: asked through the real approval queue (archive-
 *             ads, as "Nexus ads brain"), never archived; asked once
 *   business  another business with nothing enrolled decides nothing and sees none of these rows
 *   view      the ads-brain view state: each campaign decided now beside what was logged; the market's pauses and requests;
 *             nothing stored
 *   missed    the brain's resume refused at dispatch (its action-log row SKIPPED, the status put back): not tried again for
 *             24 hours, then resumed
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
// The app's client as db.ts builds it: an inDatabaseTransaction's statements run on its transaction (all or nothing).
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

const { runStateBrainOnce, writeAsTheBrain } = await import('./state-run.js')
const { stateWatchProducts } = await import('./state-load.js')
const { enrollProduct, setLever, setOverride, endOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { BRAIN_STATE_ACTOR } = await import('../ads-write-gate.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
const { ADS_BRAIN_TOOLS } = await import('../../agents/tools/ads-brain.tools.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab12_state_${hex}`
const W2 = `ab12_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const P = `${hex}-jacket`, P1 = `${hex}-jacket-m`, Q = `${hex}-helmet`, Q1 = `${hex}-helmet-m`
// The real clock: the status path stamps its own rows with it, and the brain reads them against `now`.
const NOW = new Date()
const HOUR = 3_600_000
const DAY = 86_400_000
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR)
const TABLE = 'AdsBrainStateDecision'
const SAVED_LANES = [{ placement: 'PLACEMENT_TOP', percentage: 50 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 10 }]

type Data = Record<string, any>
const decisions = () => rows<Data>('SELECT * FROM "AdsBrainStateDecision" WHERE "workspaceId" = $1 ORDER BY "createdAt", "campaignId", id', [W])
const queued = () => rows<Data>('SELECT payload->>\'entityId\' AS "entityId", payload FROM "OutboundSyncQueue" WHERE "workspaceId" = $1 ORDER BY "createdAt", id', [W])
const statusOf = async (id: string) => (await rows<{ status: string }>('SELECT status::text FROM "Campaign" WHERE id = $1', [id]))[0].status
/** The stop recipe's memory on c-it (Campaign + keywords): what the stop's owner gives back, never the state lever. */
const stopMemory = async () => ({
  campaign: (await rows<Data>('SELECT "suppressedFromPlacements", "suppressedFromBiddingStrategy"::text AS s, "biddingStrategy"::text AS b, "bidsSuppressedAt", "bidsSuppressedFloorCents", "bidsSuppressedBy", "dailyBudget"::text AS budget FROM "Campaign" WHERE id = \'c-it\'', []))[0],
  targets: await rows<Data>('SELECT id, "bidCents", "suppressedFromBidCents", status::text FROM "AdTarget" WHERE "adGroupId" = \'g-c-it\' ORDER BY id', []),
})
const state = (args: Record<string, unknown>) => inW(() => ADS_BRAIN_TOOLS[0].handler!({ view: 'state', ...args }, {} as never)) as Promise<{ ok: boolean; data?: Data; error?: string }>

async function seed(prefix = '') {
  const db = database.client
  await seedAdsFixture(db, { prefix })
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: `${prefix}${id}`, sku: `${prefix}${sku}`, name: sku, basePrice: '80.00', totalStock: 5, ...extra } })
  await product(P, `AB12-JACKET-${hex}`, { isParent: true, name: 'Jacket' })
  await product(P1, `AB12-JACKET-M-${hex}`, { parentId: `${prefix}${P}`, amazonAsin: `B0AB12JM${H}`, totalStock: 0 })
  await product(Q, `AB12-HELMET-${hex}`, { isParent: true, name: 'Helmet' })
  await product(Q1, `AB12-HELMET-M-${hex}`, { parentId: `${prefix}${Q}`, amazonAsin: `B0AB12HM${H}`, totalStock: 20 })
  const campaign = async (key: string, name: string, ad: [string, string], extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: `${prefix}${key}`, name: `${prefix}${name}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${prefix}${key}`, dailyBudget: '20.00', startDate: new Date(NOW.getTime() - 100 * DAY), liveBidWritesEnabled: true, ...extra } })
    await db.adGroup.create({ data: { id: `${prefix}g-${key}`, campaignId: `${prefix}${key}`, name: `group ${key}`, externalAdGroupId: `EXT-${prefix}g-${key}` } })
    await db.adProductAd.create({ data: { adGroupId: `${prefix}g-${key}`, productId: `${prefix}${ad[0]}`, asin: ad[1] } })
  }
  // c-it (the fixture's) and c-two advertise JACKET only; c-dead advertises HELMET only and never served.
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-it`, productId: `${prefix}${P1}`, asin: `B0AB12JM${H}` } })
  await campaign('c-two', 'Jacket broad', [P1, `B0AB12JM${H}`])
  await campaign('c-dead', 'Helmet old', [Q1, `B0AB12HM${H}`])
  // c-it sits on a stop's floor: its lanes and strategy saved by the stop recipe, its keywords' bids remembered.
  await db.campaign.update({
    where: { id: `${prefix}c-it` },
    data: { suppressedFromPlacements: SAVED_LANES, suppressedFromBiddingStrategy: 'AUTO_FOR_SALES', biddingStrategy: 'LEGACY_FOR_SALES', bidsSuppressedAt: new Date(NOW.getTime() - 2 * DAY), bidsSuppressedFloorCents: 3, bidsSuppressedBy: 'automation:retail-guard' },
  })
  // JACKET's restock: a purchase order sent to the supplier, due in 10 days.
  await db.purchaseOrder.create({ data: { id: `${prefix}po-1`, poNumber: `${prefix}PO-AB12-${hex}`, status: 'SUBMITTED', expectedDeliveryDate: new Date(NOW.getTime() + 10 * DAY), items: { create: [{ productId: `${prefix}${P1}`, sku: `${prefix}AB12-JACKET-M-${hex}`, quantityOrdered: 50 }] } } })
  // The market's daily report: c-it served every day of the last 40; c-dead never did.
  const daily = []
  for (let i = 1; i <= 40; i++) daily.push({ profileId: `${prefix}P-IT-TEST`, marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.parse(`${new Date(NOW.getTime() - i * DAY).toISOString().slice(0, 10)}T00:00:00Z`)), entityType: 'CAMPAIGN', entityId: `EXT-${prefix}c-it`, localEntityId: `${prefix}c-it`, impressions: 100, clicks: 3, costMicros: 900_000n, currencyCode: 'EUR', reportRunId: 'run-test', reportedAt: new Date(NOW.getTime() - (i - 1) * DAY) })
  await db.amazonAdsDailyPerformance.createMany({ data: daily })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-12 — the state lever (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
    await inW2(async () => { await seed('w2-'); await setAutonomy('AUTO', 'test') })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the table: invisible to another business, refused without one, row-level security forced', async () => {
    const db = database.client
    const data = { runId: 'x', mode: 'SHADOW', kind: 'change', productId: 'x-table-test', marketplace: 'IT', campaignId: 'c-x', level: 'OBSERVE', action: 'keep', outcome: 'none', cause: 'none', status: 'ENABLED', decisionHash: 'h', decision: {}, why: 'w' }
    const row = await inW(() => db.adsBrainStateDecision.create({ data }))
    expect(row).toMatchObject({ workspaceId: W, productId: 'x-table-test' })
    await inW2(async () => {
      expect(await db.adsBrainStateDecision.findMany()).toEqual([])
      expect(await db.$queryRaw`SELECT id FROM "AdsBrainStateDecision"`).toEqual([])
      expect(await db.$executeRaw`UPDATE "AdsBrainStateDecision" SET action = 'pause' WHERE id = ${row.id}`).toBe(0)
      await expect(db.adsBrainStateDecision.create({ data: { ...data, workspaceId: W } })).rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    await expect(db.adsBrainStateDecision.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    expect(await rows('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1', [TABLE])).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }])
    expect(await rows('SELECT policyname FROM pg_policies WHERE tablename = $1', [TABLE])).toEqual([{ policyname: 'nexus_workspace_isolation' }])
    expect(await rows('SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal', [TABLE])).toEqual([{ tgname: 'nexus_workspace_references' }])
    await database.pool.query('DELETE FROM "AdsBrainStateDecision" WHERE "productId" = \'x-table-test\'')
  })

  it('no-op: nothing enrolled — nothing decided, nothing written', async () => {
    expect(await inW(() => stateWatchProducts())).toEqual([])
    expect(await inW(() => runStateBrainOnce({ now: NOW }))).toMatchObject({ ran: false, campaigns: [], pruned: 0 })
    expect(await decisions()).toEqual([])
    expect(await queued()).toEqual([])
  })

  it('OBSERVE (the default): JACKET out of stock, a purchase order due in 10 days — each campaign a SHADOW pause; nothing asked or queued', async () => {
    expect(await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true, productId: P })
    expect(await inW(() => stateWatchProducts())).toEqual([{ productId: P, market: 'IT', level: 'OBSERVE' }])
    const r = await inW(() => runStateBrainOnce({ now: NOW }))
    expect(r).toMatchObject({ ran: true, failed: [] })
    const logged = await decisions()
    expect(logged.map((d) => [d.campaignId, d.mode, d.action, d.outcome, d.cause, d.level])).toEqual([['c-it', 'SHADOW', 'pause', 'shadow', 'stock', 'OBSERVE'], ['c-two', 'SHADOW', 'pause', 'shadow', 'stock', 'OBSERVE']])
    expect(logged[0].horizonHours).toBeGreaterThanOrEqual(239)
    expect(logged[0].why).toMatch(/^SHADOW \(OBSERVE\) — would pause: out of stock \(1 product\): the first back — AB12-JACKET-M-.* back on .* \(a purchase order's date\)/)
    expect(await queued()).toEqual([])
    expect([await statusOf('c-it'), await statusOf('c-two')]).toEqual(['ENABLED', 'ENABLED'])
  })

  it('AUTO: the brain\'s pause goes through the real status path and gate — one queued status write, its memory logged; the excluded campaign untouched; a rerun writes nothing', async () => {
    const memoryBefore = await stopMemory()
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'state', level: 'AUTO', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'mine', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-two', kind: 'EXCLUDE', key: '*' } }))).toMatchObject({ ok: true })
    const r = await inW(() => runStateBrainOnce({ now: NOW }))
    expect(r.campaigns.map((c) => [c.campaignId, c.action, c.outcome])).toEqual([['c-it', 'pause', 'queued'], ['c-two', 'skip', 'none']])
    expect(await statusOf('c-it')).toBe('PAUSED')
    expect(await statusOf('c-two')).toBe('ENABLED')
    const q = await queued()
    expect(q).toHaveLength(1)
    expect(q[0].entityId).toBe('c-it')
    expect(q[0].payload).toMatchObject({ actor: BRAIN_STATE_ACTOR, fieldChanges: [{ field: 'status', oldValue: 'ENABLED', newValue: 'PAUSED' }] })
    expect(await rows('SELECT "userId", "actionType" FROM "AdvertisingActionLog" WHERE "workspaceId" = $1', [W])).toEqual([{ userId: BRAIN_STATE_ACTOR, actionType: 'AD_ENTITY_STATE_UPDATE' }])
    const row = (await decisions()).find((d) => d.campaignId === 'c-it' && d.outcome === 'queued')!
    expect(row).toMatchObject({ mode: 'LIVE', action: 'pause', level: 'AUTO' })
    expect(row.decision.memory).toMatchObject({ via: 'auto', statusBefore: 'ENABLED', causes: ['stock'], stop: { savedStrategy: 'AUTO_FOR_SALES', biddingStrategy: 'LEGACY_FOR_SALES', flooredKeywords: 1, floorBy: 'automation:retail-guard', savedPlacements: SAVED_LANES } })
    // Only the status moved: the stop's memory is exactly as it was (FBA, stock, bids, lanes, strategy, budget untouched).
    expect(await stopMemory()).toEqual(memoryBefore)
    // The next run sees its own pause holding (keep, the memory carried: one row); a rerun on the same facts writes nothing.
    await inW(() => runStateBrainOnce({ now: later(1) }))
    const kept = (await decisions()).filter((d) => d.campaignId === 'c-it').at(-1)!
    expect(kept).toMatchObject({ action: 'keep', outcome: 'none', status: 'PAUSED' })
    expect(kept.decision.memory).toMatchObject({ via: 'auto', statusBefore: 'ENABLED' })
    const count = (await decisions()).length
    await inW(() => runStateBrainOnce({ now: later(1.5) }))
    expect((await decisions()).length).toBe(count)
    expect(await queued()).toHaveLength(1)
  })

  it('not owned → nothing: the gate refuses the brain\'s state writer on a campaign no brain owns (or an excluded one), nothing written', async () => {
    forgetLeverOwners()
    for (const id of ['c-pin', 'c-two']) {
      const r = await inW(() => writeAsTheBrain(id, 'PAUSED', 'test', 'run-test'))
      expect(r, id).toMatchObject({ queued: false })
      expect(r.error, id).toMatch(/^Not sent to Amazon: no product's brain owns the state \(pause, enable, archive\) of campaign/)
      expect(await statusOf(id)).toBe('ENABLED')
    }
    expect(await queued()).toHaveLength(1)
  })

  it('holds: a person\'s pause is the person\'s — the brain never resumes it', async () => {
    expect(await inW(() => endOverride({ productId: P, market: 'IT', by: 'user:owner', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-two', kind: 'EXCLUDE', key: '*' } }))).toMatchObject({ ok: true })
    const person = await inW(() => updateCampaignWithSync({ campaignId: 'c-two', patch: { status: 'PAUSED' }, actor: 'user:owner', manual: true, reason: 'my own pause', askGate: true }))
    expect(person).toMatchObject({ ok: true })
    const r = await inW(() => runStateBrainOnce({ now: later(2) }))
    expect(r.campaigns.find((c) => c.campaignId === 'c-two')).toMatchObject({ action: 'hold', outcome: 'none', why: expect.stringMatching(/paused by a person \(user:owner\) on .*: a pause the brain did not make is a hold — it never resumes it/) })
    expect(r.campaigns.find((c) => c.campaignId === 'c-it')).toMatchObject({ action: 'keep', why: expect.stringMatching(/the stop goes on/) })
    expect(await queued()).toHaveLength(2) // the brain's pause and the person's
  })

  it('resume: stock back, 30 hours on — the brain\'s pause resumed to ENABLED; the stop\'s memory exactly as before, only the status written; the person\'s pause stays', async () => {
    const memoryBefore = await stopMemory()
    await database.pool.query('UPDATE "Product" SET "totalStock" = 30 WHERE id = $1', [P1])
    const r = await inW(() => runStateBrainOnce({ now: later(30) }))
    expect(r.campaigns.map((c) => [c.campaignId, c.action, c.outcome])).toEqual([['c-it', 'resume', 'queued'], ['c-two', 'hold', 'none']])
    expect(await statusOf('c-it')).toBe('ENABLED')
    expect(await statusOf('c-two')).toBe('PAUSED')
    const q = await queued()
    expect(q).toHaveLength(3)
    expect(q[2]).toMatchObject({ entityId: 'c-it', payload: { actor: BRAIN_STATE_ACTOR, fieldChanges: [{ field: 'status', oldValue: 'PAUSED', newValue: 'ENABLED' }] } })
    expect(await stopMemory()).toEqual(memoryBefore)
    const row = (await decisions()).find((d) => d.action === 'resume')!
    expect(row).toMatchObject({ mode: 'LIVE', outcome: 'queued' })
    expect(row.decision.memory).toBeNull()
    expect(row.why).toMatch(/back to ENABLED, as before the pause on .*\. The pause changed nothing else: the stop's memory \(1 keyword bid remembered, the lanes saved, the AUTO_FOR_SALES strategy saved\) is given back by its owner as the stop ends/)
  })

  it('lock: the Owner\'s lock of the state lever — the brain refused at the gate in his words, and it decides nothing', async () => {
    expect(await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'my own state', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-it', kind: 'LOCK', key: 'state' } }))).toMatchObject({ ok: true })
    const refused = await inW(() => writeAsTheBrain('c-it', 'PAUSED', 'test', 'run-test'))
    expect(refused.error).toMatch(/the Owner holds the state \(pause, enable, archive\) of campaign .*c-it.* at his own value .*"my own state".* — the brain included/)
    await database.pool.query('UPDATE "Product" SET "totalStock" = 0 WHERE id = $1', [P1])
    const r = await inW(() => runStateBrainOnce({ now: later(60) }))
    expect(r.campaigns.find((c) => c.campaignId === 'c-it')).toMatchObject({ action: 'hold', outcome: 'held', why: expect.stringMatching(/locked at the Owner's own value .* — the brain would pause it/) })
    expect(await statusOf('c-it')).toBe('ENABLED')
    expect(await queued()).toHaveLength(3)
    expect(await inW(() => endOverride({ productId: P, market: 'IT', by: 'user:owner', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-it', kind: 'LOCK', key: 'state' } }))).toMatchObject({ ok: true })
  })

  it('archive: HELMET\'s campaign without an impression for 4 weeks is asked through the real approval queue — never archived; asked once', async () => {
    expect(await inW(() => enrollProduct({ productId: Q, market: 'IT', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await inW(() => setLever({ productId: Q, market: 'IT', lever: 'state', level: 'AUTO', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    // Within the report's freshness (its newest day at most 3 days old), as the product's own runs read it.
    const r = await inW(() => runStateBrainOnce({ now: later(4), products: [{ productId: Q, market: 'IT', level: 'AUTO' }] }))
    expect(r.campaigns).toEqual([expect.objectContaining({ campaignId: 'c-dead', action: 'archive', outcome: 'asked' })])
    const approvals = await rows<Data>('SELECT id, "toolName", status, args FROM "AgentApproval" WHERE "workspaceId" = $1', [W])
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ toolName: 'archive-ads', status: 'pending', args: { campaignIds: ['c-dead'] } })
    expect(approvals[0].args.why).toMatch(/^The ads brain: AUTO, but an archive is only ever a proposal: asks a person to archive it — no impression for 4 weeks while enabled/)
    expect(await statusOf('c-dead')).toBe('ENABLED')
    expect((await decisions()).find((d) => d.campaignId === 'c-dead')).toMatchObject({ mode: 'PROPOSE', action: 'archive', outcome: 'asked', approvalId: approvals[0].id })
    // The next run: the request waits — not asked twice.
    const again = await inW(() => runStateBrainOnce({ now: later(5), products: [{ productId: Q, market: 'IT', level: 'AUTO' }] }))
    expect(again.campaigns).toEqual([expect.objectContaining({ campaignId: 'c-dead', action: 'archive', outcome: 'waiting', approvalId: approvals[0].id })])
    expect(await rows('SELECT id FROM "AgentApproval" WHERE "workspaceId" = $1', [W])).toHaveLength(1)
  })

  it('another business: nothing enrolled there — it decides nothing and sees none of these rows', async () => {
    forgetLeverOwners()
    expect(await inW2(() => stateWatchProducts())).toEqual([])
    expect(await inW2(() => runStateBrainOnce({ now: later(63) }))).toMatchObject({ ran: false })
    expect(await inW2(() => database.client.adsBrainStateDecision.findMany())).toEqual([])
    expect(await rows('SELECT id FROM "AdsBrainStateDecision" WHERE "workspaceId" = $1', [W2])).toEqual([])
    expect(await rows('SELECT id FROM "OutboundSyncQueue" WHERE "workspaceId" = $1', [W2])).toEqual([])
  })

  it('the ads-brain view state: each campaign decided now beside what was logged; the market\'s pauses and requests; nothing stored', async () => {
    const before = (await decisions()).length
    const one = await state({ productId: P1, market: 'it', now: later(64) })
    expect(one.ok).toBe(true)
    expect(one.data).toMatchObject({ view: 'state', scope: { productId: P, market: 'IT' }, enrolled: true, dryRun: true, switches: { serverSwitchLive: true, adsAutomation: 'auto' }, cap: { perDay: 3 } })
    const camps = Object.fromEntries(one.data!.campaigns.map((c: Data) => [c.campaignId, c]))
    // Decided now at AUTO (out of stock again, its lock ended); the newest logged decision is the one under the lock.
    expect(camps['c-it']).toMatchObject({ level: 'AUTO', action: 'pause', mode: 'LIVE', outcome: 'write', cause: 'stock', logged: { action: 'hold', outcome: 'held' } })
    expect(camps['c-two']).toMatchObject({ action: 'hold', hold: expect.stringMatching(/a person \(user:owner\) set it PAUSED/) })
    const market = await state({ market: 'IT', now: later(64) })
    expect(market.data).toMatchObject({ view: 'state', scope: { market: 'IT' } })
    expect(market.data!.products).toEqual(expect.arrayContaining([{ productId: P, level: 'AUTO' }, { productId: Q, level: 'AUTO' }]))
    expect(market.data!.waiting).toEqual([expect.objectContaining({ campaignId: 'c-dead', action: 'archive' })])
    expect(await state({ market: 'XX1' })).toMatchObject({ ok: false })
    expect(await state({ productId: 'no-such-product', market: 'IT', now: later(64) })).toMatchObject({ ok: false, error: 'Product not found' })
    expect((await decisions()).length).toBe(before)
  })

  it('a resume of the brain that did not land (refused at dispatch, put back) is not tried again for 24 hours, then is', async () => {
    // The worker refused the brain's resume at dispatch: its action-log row SKIPPED and the status put back, as it does.
    await database.pool.query('UPDATE "AdvertisingActionLog" SET "amazonResponseStatus" = \'SKIPPED\' WHERE id = (SELECT id FROM "AdvertisingActionLog" WHERE "entityId" = \'c-it\' AND "userId" = $1 AND "payloadAfter"->>\'status\' = \'ENABLED\' ORDER BY "createdAt" DESC LIMIT 1)', [BRAIN_STATE_ACTOR])
    await database.pool.query('UPDATE "Campaign" SET status = \'PAUSED\' WHERE id = \'c-it\'')
    await database.pool.query('UPDATE "Product" SET "totalStock" = 30 WHERE id = $1', [P1])
    const before = (await queued()).length
    const soon = await inW(() => runStateBrainOnce({ now: later(1), products: [{ productId: P, market: 'IT', level: 'AUTO' }] }))
    expect(soon.campaigns.find((c) => c.campaignId === 'c-it')).toMatchObject({ action: 'keep', why: expect.stringMatching(/^the stop has ended, but the brain's resume at .* UTC did not land \(SKIPPED\): it tries again 24 h after it/) })
    expect((await queued()).length).toBe(before)
    const day = await inW(() => runStateBrainOnce({ now: later(30), products: [{ productId: P, market: 'IT', level: 'AUTO' }] }))
    expect(day.campaigns.find((c) => c.campaignId === 'c-it')).toMatchObject({ action: 'resume', outcome: 'queued' })
    expect(await statusOf('c-it')).toBe('ENABLED')
    expect((await queued()).length).toBe(before + 1)
  })
})
