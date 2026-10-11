/**
 * Bid page R4 — undoing approved rule asks on a real PostgreSQL (the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, row-level policies on, the app as the restricted runtime login, business profiles ON),
 * the bid brain's server switch `live`, the ads mode LIVE (the real write gate judges every write) and the job queue a stub
 * (nothing leaves the process). Every ask is approved through the real approval (applySuggestion), as the Bid page's
 * Waiting tab does:
 *
 *   write       a campaign the brain does not run: the approved bid goes back AS THE RULE — the bid as it was, the ask
 *               waiting again, no BidHold, not a person's bid, the owner the one before the approval (never "You")
 *   brain input a campaign the brain runs: the approval was the brain's input (a BidDirective); the undo ends it — no write,
 *               no hold (the brain does not leave the keyword for 60 days), the owner still the brain
 *   brain now   a write approved before the brain took the campaign: the gate the brain owns refuses the rule's undo — nothing
 *               written, no hold, the ask still approved, and the answer says why
 *   business    another business's ask reads as not found
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
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

const { undoApprovedAsks } = await import('./ask-undo.js')
const { applySuggestion } = await import('../ads-suggestion-decide.service.js')
const { setEnrollment } = await import('../bid-brain/enrollment.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { readBidRows } = await import('../bid-rows.service.js')
const { personBidTargetIds } = await import('../bid-grid.service.js')

const W = `r4_undo_${randomBytes(4).toString('hex')}`
const OTHER = `r4_other_${randomBytes(4).toString('hex')}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const rows = async <T,>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const bidOf = async (id: string) => (await rows<{ b: number }>('SELECT "bidCents" b FROM "AdTarget" WHERE id = $1', [id]))[0].b
const statusOf = async (id: string) => (await rows<{ status: string }>('SELECT status FROM "AdsRuleSuggestion" WHERE id = $1', [id]))[0]?.status
const holdsOf = async (targetId: string) => (await rows<{ n: number }>('SELECT count(*)::int n FROM "BidHold" WHERE "workspaceId" = $1 AND "targetId" = $2', [W, targetId]))[0].n
const ownerOf = async (campaignId: string, targetId: string) => inside(async () => {
  const out = await readBidRows({ campaignId })
  if (!out.ok) throw new Error(out.error)
  return out.rows.find((r) => r.targetId === targetId)!.owner
})
let ruleId = ''
let key = 0
/** A waiting ask of the rule to set one keyword's bid to `cents`, approved through the real approval, as the Bid page does. */
const approveAsk = async (targetId: string, cents: number) => inside(async () => {
  const from = await bidOf(targetId)
  const ask = await database.client.adsRuleSuggestion.create({
    data: {
      ruleId, ruleName: 'Undo probe', entityType: 'AD_TARGET', entityId: targetId, proposedKey: `bid_apply:set:${cents}:${key++}`, status: 'pending',
      proposedAction: { type: 'bid_apply', op: 'set', value: cents / 100, adTargetId: targetId, wouldChange: `${from}¢ → ${cents}¢` },
    },
  })
  const decided = await applySuggestion(ask.id)
  expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true })
  expect(await statusOf(ask.id)).toBe('applied')
  return ask.id
})

describe.skipIf(!concurrentDatabaseUrl())('R4 — an approved rule ask undone as the rule (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, OTHER]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inside(async () => {
      const db = database.client
      await seedAdsFixture(db)
      // A second allowlisted IT campaign the brain does not run.
      await db.campaign.create({ data: { id: 'c-free', name: 'Italy free', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-c-free', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
      await db.adGroup.create({ data: { id: 'g-c-free', campaignId: 'c-free', name: 'group c-free', externalAdGroupId: 'EXT-g-c-free' } })
      await db.adTarget.create({ data: { id: 't-free', adGroupId: 'g-c-free', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'free jacket', bidCents: 40, externalTargetId: 'EXT-t-free' } })
      await db.adTarget.create({ data: { id: 't-later', adGroupId: 'g-c-free', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'later jacket', bidCents: 40, externalTargetId: 'EXT-t-later' } })
      ruleId = (await db.automationRule.create({
        data: {
          name: 'Undo probe', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT', conditions: [],
          actions: [{ type: 'bid_apply', op: 'set', value: 0.5 }],
        },
      })).id
      await setAutonomy('AUTO', 'test')
      // The brain runs c-it.
      await setEnrollment({ campaignId: 'c-it', marketplace: 'IT', op: 'live', by: 'user:test', now: new Date() })
    })
    await withWorkspace(scope(OTHER), async () => {
      await database.client.adsRuleSuggestion.create({ data: { id: `${OTHER}-ask`, ruleId: 'other-rule', entityType: 'AD_TARGET', entityId: 't-x', proposedKey: 'x', proposedAction: { type: 'bid_apply' }, status: 'applied', decidedAt: new Date() } })
    })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('a campaign the brain does not run: the bid back as the rule, the ask waiting again, no hold, the owner as before', async () => {
    const before = await ownerOf('c-free', 't-free')
    const ask = await approveAsk('t-free', 50)
    expect(await bidOf('t-free')).toBe(50)
    expect(await ownerOf('c-free', 't-free')).toMatchObject({ kind: 'RULE', id: ruleId })
    const out = await inside(() => undoApprovedAsks(ruleId, [ask], 'user:u-owner'))
    expect(out).toEqual({ data: { results: [{ suggestionId: ask, restored: true, reopened: true, reason: null }], undone: 1, reopened: 1 } })
    expect(await bidOf('t-free')).toBe(40)
    expect(await statusOf(ask)).toBe('pending')
    // Under row security: the undo is this business's, written as the rule, marked with the write it puts back.
    const logs = await rows<{ userId: string; from: string; to: string; undoOf: string | null; rolledBack: boolean; workspaceId: string }>(
      'SELECT "userId", "payloadBefore" ->> \'bidCents\' AS from, "payloadAfter" ->> \'bidCents\' AS to, evidence ->> \'undoOf\' AS "undoOf", "rolledBackAt" IS NOT NULL AS "rolledBack", "workspaceId" FROM "AdvertisingActionLog" WHERE "entityId" = \'t-free\' ORDER BY "createdAt"')
    expect(logs).toEqual([
      { userId: `automation:${ruleId}`, from: '40', to: '50', undoOf: null, rolledBack: true, workspaceId: W },
      { userId: `automation:${ruleId}`, from: '50', to: '40', undoOf: expect.any(String), rolledBack: false, workspaceId: W },
    ])
    expect(await holdsOf('t-free')).toBe(0)
    expect((await inside(() => personBidTargetIds({ targetIds: ['t-free'] }))).has('t-free')).toBe(false)
    const after = await ownerOf('c-free', 't-free')
    expect(after).toEqual(before)
    expect(after.kind).not.toBe('PERSON')
    expect(await rows('SELECT "userId", "workspaceId" FROM "AdvertisingActionLog" WHERE "actionType" = \'undo_rule_asks\'')).toEqual([{ userId: 'user:u-owner', workspaceId: W }])
  })

  it('a campaign the brain runs: the approval was its input; the undo ends it — nothing written, no 60-day hold, the brain still the owner', async () => {
    expect(await ownerOf('c-it', 't-it')).toMatchObject({ kind: 'BRAIN' })
    const writes = async () => (await rows<{ n: number }>('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "entityId" = \'t-it\'', []))[0].n
    const before = { writes: await writes(), bid: await bidOf('t-it') }
    const ask = await approveAsk('t-it', 50)
    // The approval stored the rule's ask as the brain's input; nothing was written.
    const open = await rows<{ id: string; kind: string; valueCents: number }>('SELECT id, kind, "valueCents" FROM "BidDirective" WHERE "workspaceId" = $1 AND source = $2 AND "targetId" = \'t-it\' AND until > now()', [W, `rule:${ruleId}`])
    expect(open).toEqual([{ id: expect.any(String), kind: 'FLOOR', valueCents: 50 }])
    expect(await writes()).toBe(before.writes)
    const out = await inside(() => undoApprovedAsks(ruleId, [ask], 'user:u-owner'))
    expect(out).toEqual({ data: { results: [{ suggestionId: ask, restored: true, reopened: true, reason: 'Its input to the brain ended: the brain no longer reads it. Nothing had been sent to Amazon.' }], undone: 1, reopened: 1 } })
    expect(await rows('SELECT id FROM "BidDirective" WHERE "workspaceId" = $1 AND source = $2 AND until > now()', [W, `rule:${ruleId}`])).toEqual([])
    expect(await writes()).toBe(before.writes)
    expect(await bidOf('t-it')).toBe(before.bid)
    expect(await holdsOf('t-it')).toBe(0)
    expect(await statusOf(ask)).toBe('pending')
    expect(await ownerOf('c-it', 't-it')).toMatchObject({ kind: 'BRAIN' })
  })

  it('a write approved before the brain took the campaign: the gate the brain owns refuses the rule\'s undo — nothing written, no hold', async () => {
    const ask = await approveAsk('t-later', 55)
    expect(await bidOf('t-later')).toBe(55)
    await inside(() => setEnrollment({ campaignId: 'c-free', marketplace: 'IT', op: 'live', by: 'user:test', now: new Date() }))
    const owner = await ownerOf('c-free', 't-later')
    expect(owner).toMatchObject({ kind: 'BRAIN' })
    const writes = (await rows<{ n: number }>('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "entityId" = \'t-later\'', []))[0].n
    const out = await inside(() => undoApprovedAsks(ruleId, [ask], 'user:u-owner'))
    expect(out).toMatchObject({ data: { undone: 0, reopened: 0, results: [{ suggestionId: ask, restored: false, reopened: false, reason: 'The brain runs this campaign now and sets its bids, so the rule\'s change is not put back. Nothing was written.' }] } })
    expect(await bidOf('t-later')).toBe(55)
    expect((await rows<{ n: number }>('SELECT count(*)::int n FROM "AdvertisingActionLog" WHERE "entityId" = \'t-later\'', []))[0].n).toBe(writes)
    expect(await holdsOf('t-later')).toBe(0)
    expect(await statusOf(ask)).toBe('applied')
    expect(await ownerOf('c-free', 't-later')).toEqual(owner)
  })

  it('another business\'s ask reads as not found', async () => {
    const out = await inside(() => undoApprovedAsks(ruleId, [`${OTHER}-ask`], 'user:u-owner'))
    expect(out).toEqual({ data: { results: [{ suggestionId: `${OTHER}-ask`, restored: false, reopened: false, reason: 'No such ask in this business.' }], undone: 0, reopened: 0 } })
  })
})
