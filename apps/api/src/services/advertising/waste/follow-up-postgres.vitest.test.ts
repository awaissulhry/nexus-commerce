/**
 * Negative Targeting step 4 — "Remove protection and stop" finishes on the server, on a real PostgreSQL
 * (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs: row-level policies on, the app as the restricted
 * runtime login, business profiles ON), the ads mode LIVE (the real write gate judges every write), Amazon a recorder and
 * the job queue a stub (nothing leaves the process).
 *
 *   follow-up  a shopper's term a protected term keeps safe: the removal is sent, its negative waits; until the removal
 *              ran nothing is sent; once it ran two runners at once (the page's "now" and the cron) send the negative ONCE,
 *              as the person who approved the removal, through the page's own write (one change set, approved by them)
 *   cron       the page is gone: the cron's pass sends it; another business sees no follow-up (row security)
 *   refused    the removal rejected (an Undo inside its window): the follow-up says so in words and sends nothing
 *
 * Values are made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
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
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../../../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn(async () => undefined) }))
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const { previewWaste, applyWaste } = await import('./write.js')
const { runFollowUp, runDueFollowUps, readFollowUp } = await import('./follow-up.js')
const { commitScheduledApproval, undoScheduledApproval, decideFleetApproval } = await import('../../agent-fleet/approval-inbox.service.js')
const { setAutonomy } = await import('../ads-automation-state.service.js')
const { invalidateWasteFacts } = await import('./read.js')

const hex = randomBytes(4).toString('hex')
const W = `neg_follow_${hex}`
const W2 = `neg_follow_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
let userId = ''
const person = () => ({ kind: 'user' as const, userId, label: 'Made up approver', via: 'app' as const, workspace: scope(W), permissions: { isOwner: false, permissions: EVERYTHING } })
type Item = Parameters<typeof previewWaste>[0][number]

/** The page's Send: the preview, then one change set asked and approved by the person. */
async function send(items: Item[]) {
  return inW(async () => {
    const p = await previewWaste(items, person() as never)
    return applyWaste({ items, planHash: p.planHash }, person() as never)
  })
}
/** The removal's 20 s window closes now, and it runs (the approval maintenance pass, or the page's commit). */
async function runRemoval(approvalId: string) {
  await inW(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inW(() => commitScheduledApproval(approvalId))
}
const protect = async (term: string) => {
  const p = await inW(() => database.client.adKeywordProtection.create({ data: { mode: 'WHITELIST', term, matchType: 'CONTAINS', marketplace: 'IT', reason: 'made up line', createdBy: 'user:made-up' } }))
  invalidateWasteFacts()
  return p
}
const negativesAsked = () => inW(() => database.client.agentApproval.count({ where: { toolName: 'add-negative-targets' } }))

describe.skipIf(!concurrentDatabaseUrl())('Negative Targeting step 4 — the server follow-up of Remove protection and stop (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    vi.stubEnv('NEXUS_WASTE_FACTS_TTL_MS', '0')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    userId = (await database.client.userProfile.create({ data: { email: `follow-${hex}@example.test`, status: 'active', displayName: 'Made up approver' } })).id
    await inW(async () => {
      const c = database.client
      await seedAdsFixture(c)
      await setAutonomy('AUTO', 'test')
      const role = await c.role.create({ data: { key: `FOLLOW_${hex}`, name: 'Ads owner', description: 'test', permissions: [...EVERYTHING], isSystem: false } })
      await c.userRole.create({ data: { userId, roleId: role.id } })
      const membership = await c.workspaceMembership.create({ data: { workspaceId: W, userId, status: 'active' } })
      await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
      const p = await c.product.create({ data: { id: `follow-coat-${hex}`, sku: `FOLLOW-COAT-${hex}`, name: 'Made up coat', basePrice: '80.00' } })
      await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: p.id, sku: `FOLLOW-COAT-${hex}`, asin: 'B0FOLLOW01', externalAdId: `EXT-pa-follow-${hex}` } })
      await c.amazonAdsSearchTerm.createMany({ data: ['made up rain hat', 'made up rain cap', 'made up storm hat'].map((query) => ({
        profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 6 * 86_400_000), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it',
        query, impressions: 40, clicks: 4, costMicros: 1_500_000n, currencyCode: 'EUR', sales7dCents: 0, orders7d: 0,
      })) as never })
    })
    await inW2(async () => { await seedAdsFixture(database.client, { prefix: 'w2-' }) })
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('the removal ran: two runners at once send the negative ONCE, as the person who approved it, through the page\'s write', async () => {
    const p = await protect('rain')
    const row = 'term:IT|EXT-g-c-it|made up rain hat'
    const sent = await send([{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_EXACT', where: 'adGroup' }])
    expect(sent.http, JSON.stringify(sent.body)).toBe(202)
    const removalId = String(sent.body.changeSetId)
    expect(sent.body).toMatchObject({ tool: 'set-ad-guardrail', followUp: { status: 'WAITING', rowIds: [row] } })
    // Before the removal ran nothing is sent.
    expect(await inW(() => runFollowUp(removalId))).toMatchObject({ status: 'WAITING' })
    expect(await negativesAsked()).toBe(0)
    expect(await runRemoval(removalId)).toMatchObject({ ok: true })
    expect(await inW(() => database.client.adKeywordProtection.count({ where: { id: p.id } }))).toBe(0)
    invalidateWasteFacts()
    // The page's "now" and the cron at the same moment: one claims it.
    await Promise.all([inW(() => runFollowUp(removalId)), inW(() => runFollowUp(removalId))])
    const done = await inW(() => readFollowUp(removalId))
    expect(done).toMatchObject({ status: 'SENT', changeSetId: expect.any(String), results: [{ rowId: row, sent: true, why: null }] })
    expect(await negativesAsked()).toBe(1)
    const negative = await inW(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: done!.changeSetId! }, include: { agentRun: { select: { via: true, userId: true } } } }))
    expect(negative).toMatchObject({ toolName: 'add-negative-targets', status: 'scheduled', decidedByUserId: userId, agentRun: { via: 'app', userId } })
  })

  it('the page is gone: the cron\'s pass sends it; another business sees no follow-up', async () => {
    const p = await protect('cap')
    const row = 'term:IT|EXT-g-c-it|made up rain cap'
    const sent = await send([{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_EXACT', where: 'adGroup' }])
    const removalId = String(sent.body.changeSetId)
    expect(await runRemoval(removalId)).toMatchObject({ ok: true })
    invalidateWasteFacts()
    expect(await inW(() => runDueFollowUps())).toMatchObject({ ran: 1, sent: 1 })
    expect(await inW(() => readFollowUp(removalId))).toMatchObject({ status: 'SENT' })
    expect(await inW2(() => database.client.adsWasteFollowUp.count())).toBe(0)
    expect(await inW2(() => readFollowUp(removalId))).toBeNull()
  })

  it('the removal rejected (an Undo inside its window): the follow-up says so in words and sends nothing', async () => {
    const p = await protect('storm')
    const row = 'term:IT|EXT-g-c-it|made up storm hat'
    const sent = await send([{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_EXACT', where: 'adGroup' }])
    const removalId = String(sent.body.changeSetId)
    const before = await negativesAsked()
    expect(await inW(() => undoScheduledApproval({ id: removalId, actor: person() as never }))).toMatchObject({ ok: true })
    expect(await inW(() => decideFleetApproval({ id: removalId, decision: 'reject', actor: person() as never }))).toMatchObject({ ok: true })
    expect(await inW(() => runFollowUp(removalId))).toMatchObject({ status: 'REFUSED', why: expect.stringMatching(/^The protection was not removed \(it was rejected\), so no negative was sent/) })
    expect(await negativesAsked()).toBe(before)
    expect(await inW(() => database.client.adKeywordProtection.count({ where: { id: p.id } }))).toBe(1)
  })
})
