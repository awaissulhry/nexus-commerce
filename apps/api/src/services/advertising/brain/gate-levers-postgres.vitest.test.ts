/**
 * ONE BRAIN AB-5 — one owner per lever through the real write gate on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles
 * ON), the server switch `live`, the ads mode LIVE and the job queue a stub: nothing leaves the process, and every write
 * below is either refused by the gate or only queued — nothing is sent to Amazon.
 *
 *   today      nothing enrolled in the business (production as AB-5 ships): every automatic write passes as before
 *   owned      the GALE family enrolled in IT with its budgets, state, negatives and harvest levers at AUTO (the levels a
 *              lever takes are widened here, as each lever's own PR will): a rule's budget raise, target pause, negative,
 *              retire of a negative and new keyword on its own campaign are refused through the real write paths (the
 *              mutation layer, the negative service, the create service), naming the lever and the product's brain,
 *              and leave nothing behind; the brain, a person and the safety owners pass; a campaign of another product
 *              and the keyword bids are judged as before
 *   shadow     a lever at OBSERVE refuses nothing
 *   lock       the Owner's lock of a whole lever: every automatic writer refused, the brain included; a person passes;
 *              a product's lock holds its shared campaign too, which no brain owns
 *   exclusion  an excluded campaign is judged as before
 *   business   another business with the same shapes and nothing enrolled is judged as before
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
// Each lever's own PR widens the levels it takes (levers.ts LEVER_LEVELS_NOW); the gate must hold them right already.
vi.mock('./levers.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./levers.js')>()), levelRefusal: () => null }))

const { checkAdsWriteGate, PRODUCT_BRAIN_ACTOR } = await import('../ads-write-gate.js')
const { enrollProduct, setLever, setOverride, endOverride } = await import('./enrollment.js')
const { forgetLeverOwners } = await import('./lever-owners.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { updateAdTargetWithSync, updateCampaignWithSync } = await import('../ads-mutation.service.js')
const { writeNegativeKeyword } = await import('../ads-negative-kw.service.js')
const { createKeywordLocal } = await import('../ads-create.service.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `ab5_gate_${hex}`
const W2 = `ab5_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const P = `${hex}-gale`, P1 = `${hex}-gale-m`, Q = `${hex}-misano`, Q1 = `${hex}-misano-m`
const NOW = new Date('2026-10-08T12:00:00Z')
const RULE = 'automation:rule-ab5' as const

/** Queue rows and action-log rows of the business: a refused write leaves neither. */
const traces = async () => (await rows<{ q: number; l: number }>(
  'SELECT (SELECT count(*)::int FROM "OutboundSyncQueue" WHERE "workspaceId" = $1) q, (SELECT count(*)::int FROM "AdvertisingActionLog" WHERE "workspaceId" = $1) l', [W]))[0]

/** The gate as the worker hands it a queued change of c-it (fields), or a named lever. */
const gate = (fields: Record<string, unknown>, actor: string | null, extra: Record<string, unknown> = {}) =>
  inW(() => checkAdsWriteGate({ marketplace: 'IT', campaignId: 'c-it', payloadValueCents: 0, ...fields, actor, ...extra } as never))
const BUDGET = { field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 2_500, previousValueCents: 2_000, payloadValueCents: 2_500 }
const STATE = { field: 'status', fields: ['status'] }
const NEGATIVE = { dimension: 'negatives', isNegation: true, keywordText: 'cheap jacket', negativeMatchType: 'NEGATIVE_EXACT' }

async function seed(prefix = '') {
  const db = database.client
  await seedAdsFixture(db, { prefix })
  const product = (id: string, sku: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { id: `${prefix}${id}`, sku: `${prefix}${sku}`, name: sku, basePrice: '99.00', totalStock: 5, ...extra } })
  await product(P, `AB5-GALE-${hex}`, { isParent: true })
  await product(P1, `AB5-GALE-M-${hex}`, { parentId: `${prefix}${P}`, amazonAsin: `B0AB5GLM${H}` })
  await product(Q, `AB5-MISANO-${hex}`, { isParent: true })
  await product(Q1, `AB5-MISANO-M-${hex}`, { parentId: `${prefix}${Q}`, amazonAsin: `B0AB5MSM${H}` })
  // c-it advertises GALE only (its brain's own campaign); c-off advertises MISANO (put on the allowlist here); c-pin
  // advertises both (shared; its bids pin holds no lever judged below).
  await db.campaign.update({ where: { id: `${prefix}c-off` }, data: { liveBidWritesEnabled: true } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-it`, productId: `${prefix}${P1}`, asin: `B0AB5GLM${H}` } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-off`, productId: `${prefix}${Q1}`, asin: `B0AB5MSM${H}` } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-pin`, productId: `${prefix}${P1}`, asin: `B0AB5GLM${H}` } })
  await db.adProductAd.create({ data: { adGroupId: `${prefix}g-c-pin`, productId: `${prefix}${Q1}`, asin: `B0AB5MSM${H}` } })
}

describe.skipIf(!concurrentDatabaseUrl())('AB-5 — one owner per lever at the real write gate (real PostgreSQL)', { timeout: 120_000 }, () => {
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

  it('today: nothing enrolled in the business — every automatic write passes as before', async () => {
    forgetLeverOwners()
    expect(await rows('SELECT id FROM "AdsBrainEnrollment" WHERE "workspaceId" = $1', [W])).toEqual([])
    for (const [fields, extra] of [[BUDGET, {}], [STATE, {}], [NEGATIVE, {}], [{ dimension: 'keywords', field: 'bid', intendedValueCents: 40 }, {}], [{ field: 'biddingStrategy', fields: ['biddingStrategy'] }, {}], [{ dimension: 'placement' }, {}]] as const) {
      expect(await gate(fields, RULE, extra), JSON.stringify(fields)).toMatchObject({ allowed: true, mode: 'live' })
    }
  })

  it('owned: a rule\'s change to a lever GALE\'s brain owns is refused through the real write paths, naming the lever and the brain, leaving nothing', async () => {
    const enrolled = await inW(() => enrollProduct({ productId: P1, market: 'IT', by: 'user:owner', now: NOW }))
    expect(enrolled).toMatchObject({ ok: true, productId: P })
    for (const lever of ['budgets', 'state', 'negatives', 'harvest'] as const) {
      expect(await inW(() => setLever({ productId: P, market: 'IT', lever, level: 'AUTO', by: 'user:owner', now: NOW })), lever).toMatchObject({ ok: true })
    }
    const before = await traces()

    // A budget raise (the mutation layer asks the gate before Nexus writes, as at dispatch).
    const budget = await inW(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 25 }, actor: RULE, reason: 'test', askGate: true }))
    expect(budget.ok).toBe(false)
    expect(budget.error).toMatch(new RegExp(`campaign "Italy exact" \\(c-it\\) is run by the brain of product ${P} in IT \\(one owner per lever\\): ${RULE} may not change its daily budget — the brain owns that lever \\(AUTO by the Owner's product override \\(user:owner, 2026-10-08\\)\\)`))
    // A keyword's pause (the state lever).
    const pause = await inW(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { status: 'PAUSED' }, actor: RULE, reason: 'test', askGate: true }))
    expect(pause.ok).toBe(false)
    expect(pause.error).toMatch(/may not change its state \(pause, enable, archive\)/)
    // The retire of a negative is the negatives lever (not the state lever).
    const retire = await inW(() => updateAdTargetWithSync({ adTargetId: 't-neg', patch: { status: 'ARCHIVED' }, actor: RULE, reason: 'test', askGate: true }))
    expect(retire.ok).toBe(false)
    expect(retire.error).toMatch(/may not change its negatives/)
    // A new negative through the one negative write service.
    const negative = await inW(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'cheap jacket', matchType: 'EXACT', userId: RULE }))
    expect(negative).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'brain_owned' }, adTargetId: null })
    // A new keyword through the create service (a harvest).
    const keyword = await inW(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'race jacket xl', matchType: 'EXACT', bidEur: 0.4, userId: RULE, requireAmazon: true }))
    expect(keyword).toMatchObject({ id: null, denied: { deniedAt: 'brain_owned' } })
    expect(keyword.denied?.reason).toMatch(/may not change its new keywords and targets/)

    expect(await traces()).toEqual(before)
    expect(await rows('SELECT id FROM "AdTarget" WHERE "workspaceId" = $1 AND "expressionValue" IN (\'cheap jacket\', \'race jacket xl\')', [W])).toEqual([])
    expect((await rows<{ status: string }>('SELECT status FROM "AdTarget" WHERE id IN (\'t-it\', \'t-neg\') ORDER BY id', [])).map((r) => r.status)).toEqual(['ENABLED', 'ENABLED'])
  })

  it('owned: the brain, a person and the safety owners pass; another product\'s campaign and the keyword bids are judged as before', async () => {
    for (const fields of [BUDGET, STATE, NEGATIVE]) {
      expect(await gate(fields, PRODUCT_BRAIN_ACTOR), JSON.stringify(fields)).toMatchObject({ allowed: true })
      expect(await gate(fields, 'user:owner', { manual: true })).toMatchObject({ allowed: true })
      expect(await gate(fields, 'automation:auto-undo')).toMatchObject({ allowed: true })
      expect(await gate(fields, RULE, { campaignId: 'c-off' })).toMatchObject({ allowed: true })
    }
    // A person's budget edit goes all the way to the queue.
    const person = await inW(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 22 }, actor: 'user:owner', manual: true, reason: 'test', askGate: true }))
    expect(person).toMatchObject({ ok: true })
    expect(person.outboundQueueId).toBeTruthy()
    // The keyword bids stay the bid brain's: c-it is not LIVE there, so a rule's bid passes.
    expect(await gate({ field: 'bid', fields: ['bid'], intendedValueCents: 50, payloadValueCents: 50 }, RULE)).toMatchObject({ allowed: true })
  })

  it('shadow: a lever at OBSERVE refuses nothing', async () => {
    expect(await inW(() => setLever({ productId: P, market: 'IT', lever: 'budgets', level: 'OBSERVE', by: 'user:owner', now: NOW }))).toMatchObject({ ok: true })
    expect(await gate(BUDGET, RULE)).toMatchObject({ allowed: true })
    expect(await gate(STATE, RULE)).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })

  it('lock: the Owner\'s value stands — every automatic writer refused, the brain included; a person passes; his lock holds the shared campaign', async () => {
    const set = await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'my own budget', now: NOW, override: { scope: 'PRODUCT', kind: 'LOCK', key: 'budgets' } }))
    expect(set).toMatchObject({ ok: true })
    for (const actor of [RULE, PRODUCT_BRAIN_ACTOR]) {
      const r = await gate(BUDGET, actor)
      expect(r, actor).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
      expect((r as { reason: string }).reason).toMatch(/^the Owner holds the daily budget of campaign "Italy exact" \(c-it\) at his own value \(locked by the Owner's product override \(user:owner, 2026-10-08\) \("my own budget"\)/)
    }
    expect(((await gate(BUDGET, PRODUCT_BRAIN_ACTOR)) as { reason: string }).reason).toMatch(/— the brain included/)
    expect(await gate(BUDGET, 'user:owner', { manual: true })).toMatchObject({ allowed: true })
    expect(await gate(BUDGET, 'automation:budget-manager-cron')).toMatchObject({ allowed: true })
    // c-pin advertises GALE and MISANO: no brain owns it (its state at AUTO refuses nothing), but GALE's lock holds its budget.
    expect(await gate(STATE, RULE, { campaignId: 'c-pin' })).toMatchObject({ allowed: true })
    expect(await gate(BUDGET, RULE, { campaignId: 'c-pin' })).toMatchObject({ allowed: false, deniedAt: 'owner_locked' })
    // MISANO's own campaign is not GALE's.
    expect(await gate(BUDGET, RULE, { campaignId: 'c-off' })).toMatchObject({ allowed: true })
    // Ending the lock lets automation write it again (budgets is at OBSERVE).
    expect(await inW(() => endOverride({ productId: P, market: 'IT', by: 'user:owner', now: NOW, override: { scope: 'PRODUCT', kind: 'LOCK', key: 'budgets' } }))).toMatchObject({ ok: true })
    expect(await gate(BUDGET, RULE)).toMatchObject({ allowed: true })
  })

  it('another business: the same shapes, nothing enrolled there — judged as before, while the first business still refuses', async () => {
    forgetLeverOwners()
    const there = await inW2(() => checkAdsWriteGate({ marketplace: 'IT', campaignId: 'w2-c-it', payloadValueCents: 0, field: 'status', fields: ['status'], actor: RULE }))
    expect(there).toMatchObject({ allowed: true })
    expect(await gate(STATE, RULE)).toMatchObject({ allowed: false, deniedAt: 'brain_owned' })
  })

  it('exclusion: an excluded campaign is judged as before', async () => {
    const set = await inW(() => setOverride({ productId: P, market: 'IT', by: 'user:owner', reason: 'mine', now: NOW, override: { scope: 'CAMPAIGN', campaignId: 'c-it', kind: 'EXCLUDE', key: '*' } }))
    expect(set).toMatchObject({ ok: true })
    for (const fields of [BUDGET, STATE, NEGATIVE]) expect(await gate(fields, RULE), JSON.stringify(fields)).toMatchObject({ allowed: true })
  })
})
