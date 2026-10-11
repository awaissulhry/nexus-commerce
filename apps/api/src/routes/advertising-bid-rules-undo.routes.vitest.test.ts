/**
 * Bid page R4 — POST /api/advertising/bid-rules/:id/asks/undo on PGlite with the production schema, business profiles ON,
 * the ads mode LIVE (the real write gate is asked before every undo writes) and the real write path (the queue row and its
 * typed rows; nothing leaves the process):
 *
 *   put back   an approved ask's write goes back AS THE RULE: the bid as it was, the ask waiting again; no BidHold, not a
 *              person's bid of 60 days, the owner the one before the approval (the write and its undo fold away), never "You"
 *   refused    per ask and whole, nothing written: a later change on the keyword, the largest change of one step, another
 *              rule's ask, an unknown one, an ask not approved; the brain and a non-bid rule
 *   expired    put back, but an ask too old to wait or of an archived rule expires, and says so
 *   brain      an approval the brain took as its input: the input ends, nothing written, no hold
 *   history    R10 — the page's approval reads "You" in the rule's history
 *
 * The brain-owned campaign end to end (the real approval, a write refused by the gate the brain owns, row security) is the
 * real-PostgreSQL suite services/advertising/bid-rules/ask-undo-postgres.vitest.test.ts. Values are made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// The enqueue's transaction and the reads inside it share PGlite's one connection (lib/database-context.ts).
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
// Nothing here may open a Redis connection.
vi.mock('../lib/queue.js', () => {
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

const A = 'bid_ask_undo_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const inA = <T>(fn: () => Promise<T>) => withWorkspace(business(A), fn)
const db = () => database.client as any
const ids: Record<string, string> = {}
let app: FastifyInstance
const permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }

/** A builder Bid rule's body: Clicks ≥ 1 → set the bid to €0.60 on the picked campaigns. */
const builderBody = (campaigns: string[]) => ({
  actions: [{ type: 'bid', windowDays: 14, control: 'manual', campaigns: campaigns.map((id) => ({ id })) }],
  conditions: [{ conditions: [{ metric: 'Clicks', op: 'gte', value: '1' }], action: { op: 'set', value: '0.60' } }],
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    await seedAdsFixture(db())
    ids.r2 = (await db().automationRule.create({ data: { name: 'Cut wasted spend', domain: 'advertising', trigger: 'KEYWORD_WASTED_SPEND', enabled: true, dryRun: false, autonomyLevel: 'AUTO', scopeMarketplace: 'IT', conditions: [], actions: [{ type: 'bid_down', percent: 20 }] } })).id
    ids.r5 = (await db().automationRule.create({ data: { name: 'Budget rule', domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT', conditions: [], actions: [{ type: 'adjust_ad_budget' }] } })).id
  })
  const { default: routes } = await import('./advertising-bid-rules.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.__rbacResolved = permissions
    withWorkspace(business(A), done)
  })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, headers: { 'x-actor-id': 'owner-1' } })
const row = (body: { rules: Array<{ id: string }> }, id: string) => body.rules.find((r) => r.id === id) as any

describe('POST /api/advertising/bid-rules/:id/asks/undo — R4: an approved ask put back as the rule, never as a person\'s bid', () => {
  // A rule and a keyword of their own (c-it, 40¢), so the counts above stay as they are.
  const T = 't-undo'
  let rid = ''
  const bid = () => inA(async () => (await db().adTarget.findUnique({ where: { id: T } })).bidCents as number)
  const ask = (id: string) => inA(() => db().adsRuleSuggestion.findUnique({ where: { id } })) as Promise<any>
  const undo = (ruleId: string, suggestionIds: string[]) => post(`/api/advertising/bid-rules/${ruleId}/asks/undo`, { suggestionIds })
  const ownerOf = async (targetId: string) => inA(async () => {
    const { readBidRows } = await import('../services/advertising/bid-rows.service.js')
    const out = await readBidRows({ campaignId: 'c-it' })
    if (!out.ok) throw new Error(out.error)
    return out.rows.find((r) => r.targetId === targetId)!
  })
  let key = 0
  /** An approval of the rule's ask: its write as the rule, through the real write path, and the ask applied with that result. */
  const approve = (toCents: number, extra: Record<string, unknown> = {}) => inA(async () => {
    const { updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')
    const from = (await db().adTarget.findUnique({ where: { id: T } })).bidCents
    const w = await updateAdTargetWithSync({ adTargetId: T, patch: { bidCents: toCents }, actor: `automation:${rid}` as never, reason: 'approved ask (test)' })
    expect(w.ok, w.error ?? '').toBe(true)
    const s = await db().adsRuleSuggestion.create({
      data: {
        ruleId: rid, ruleName: 'Undo probe', entityType: 'AD_TARGET', entityId: T, proposedKey: `bid_apply:set:${toCents}:${key++}`,
        proposedAction: { type: 'bid_apply', op: 'set', value: toCents / 100, adTargetId: T, wouldChange: `${from}¢ → ${toCents}¢` },
        status: 'applied', decidedAt: new Date(), decidedBy: 'operator',
        appliedResult: { type: 'bid_apply', ok: true, output: { adTargetId: T, newBidCents: toCents, outboundQueueId: w.outboundQueueId } }, ...extra,
      },
    })
    return { suggestionId: s.id as string, actionLogId: w.actionLogId as string }
  })

  beforeAll(async () => {
    await inA(async () => {
      await db().adTarget.create({ data: { id: T, adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'undo jacket', bidCents: 40, externalTargetId: 'EXT-t-undo' } })
      rid = (await db().automationRule.create({ data: { name: 'Undo probe', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: true, autonomyLevel: 'PROPOSE', scopeMarketplace: 'IT', createdAt: ago(30), ...builderBody(['c-it']) } })).id
    })
  })

  it('the bid as it was, written as the rule; the ask waits again; no hold, no person\'s bid; the owner is the one before the approval', async () => {
    const before = await ownerOf(T)
    const approved = await approve(46)
    expect(await bid()).toBe(46)
    const afterApprove = await ownerOf(T)
    expect(afterApprove.owner).toMatchObject({ kind: 'RULE', id: rid })
    // R10 — the page's approval (decidedBy 'operator') reads "You" in the rule's history, never "operator".
    const history = (await get(`/api/advertising/bid-rules/${rid}/history`)).json()
    expect(history.changes.find((c: { target: { id: string } | null }) => c.target?.id === T)).toMatchObject({ who: { kind: 'person', id: null, name: 'You' } })

    const res = await undo(rid, [approved.suggestionId])
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json()).toEqual({ results: [{ suggestionId: approved.suggestionId, restored: true, reopened: true, reason: null }], undone: 1, reopened: 1 })
    expect(await bid()).toBe(40)
    expect(await ask(approved.suggestionId)).toMatchObject({ status: 'pending', decidedAt: null, decidedBy: null })

    const stored = await inA(async () => ({
      original: await db().advertisingActionLog.findUnique({ where: { id: approved.actionLogId } }),
      undoRow: await db().advertisingActionLog.findFirst({ where: { entityId: T, evidence: { path: ['undoOf'], equals: approved.actionLogId } } }),
      holds: await db().bidHold.count({ where: { targetId: T } }),
      person: (await (await import('../services/advertising/bid-grid.service.js')).personBidTargetIds({ targetIds: [T] })).has(T),
      audit: await db().advertisingActionLog.findFirst({ where: { entityType: 'RULE', entityId: rid, actionType: 'undo_rule_asks' } }),
    }))
    expect(stored.original.rolledBackAt).not.toBeNull()
    // The undo is the rule's write (its actor, never a person's), marked with the write it puts back.
    expect(stored.undoRow).toMatchObject({ userId: `automation:${rid}`, payloadBefore: { bidCents: 46 }, payloadAfter: { bidCents: 40 } })
    expect(stored.holds).toBe(0)
    expect(stored.person).toBe(false)
    expect(stored.audit).toMatchObject({ userId: 'user:owner-1' })
    // Who sets it, the last change and the 7-day count: as before the approval (the write and its undo fold away), never "You".
    const after = await ownerOf(T)
    expect(after.owner).toEqual(before.owner)
    expect(after.owner.kind).not.toBe('PERSON')
    expect(after.changes7d).toBe(before.changes7d)
    expect(after.lastChange).toEqual(before.lastChange)
    // The rule's own 7-day changes fold the pair away too.
    const rules = (await get('/api/advertising/bid-rules?market=IT')).json()
    expect(row(rules, rid)).toMatchObject({ changed7d: { bids: 0 }, last7d: { written: 0, applied: 0 }, waiting: 1 })
    // Again: it is waiting now, not approved — nothing to undo, nothing written.
    expect((await undo(rid, [approved.suggestionId])).json()).toEqual({
      results: [{ suggestionId: approved.suggestionId, restored: false, reopened: false, reason: 'This ask is still waiting, not approved: nothing to undo.' }], undone: 0, reopened: 0,
    })
    await inA(() => db().adsRuleSuggestion.delete({ where: { id: approved.suggestionId } }))
  })

  it('refused per ask, nothing written: a later change on the keyword, another rule\'s ask, an unknown one; the brain and a non-bid rule', async () => {
    const approved = await approve(48)
    // Another writer moved the bid since: putting 40¢ back would overwrite its change.
    await inA(async () => {
      const { updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')
      expect((await updateAdTargetWithSync({ adTargetId: T, patch: { bidCents: 50 }, actor: 'automation:rank-defend-test' as never, reason: 'test' })).ok).toBe(true)
    })
    const other = await inA(() => db().adsRuleSuggestion.create({ data: { ruleId: ids.r2, entityType: 'AD_TARGET', entityId: T, proposedKey: 'bid_down:other', proposedAction: { type: 'bid_down' }, status: 'applied', decidedAt: new Date(), decidedBy: 'operator' } }))
    const res = await undo(rid, [approved.suggestionId, other.id, 'no-such-ask'])
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ undone: 0, reopened: 0 })
    expect(body.results[0]).toMatchObject({ suggestionId: approved.suggestionId, restored: false, reopened: false, reason: expect.stringMatching(/^Not put back: a later change on the same ad target superseded it .* Nothing was written\.$/) })
    expect(body.results[1]).toEqual({ suggestionId: other.id, restored: false, reopened: false, reason: 'This ask is another rule\'s.' })
    expect(body.results[2]).toEqual({ suggestionId: 'no-such-ask', restored: false, reopened: false, reason: 'No such ask in this business.' })
    expect(await bid()).toBe(50)
    expect((await ask(approved.suggestionId)).status).toBe('applied')
    expect((await undo('brain', ['x'])).statusCode).toBe(400)
    expect((await undo(ids.r5, ['x'])).statusCode).toBe(404)
    expect((await post(`/api/advertising/bid-rules/${rid}/asks/undo`, {})).statusCode).toBe(400)
    expect((await post(`/api/advertising/bid-rules/${rid}/asks/undo`, { suggestionIds: [] })).statusCode).toBe(400)
    await inA(async () => {
      await db().adsRuleSuggestion.deleteMany({ where: { id: { in: [approved.suggestionId, other.id] } } })
      await db().adTarget.update({ where: { id: T }, data: { bidCents: 40 } })
    })
  })

  it('the largest change of one step holds the way back: refused whole, never written part of the way', async () => {
    const approved = await approve(60)
    const was = await inA(async () => (await db().campaign.findUnique({ where: { id: 'c-it' } })).dynamicBidding)
    await inA(() => db().campaign.update({ where: { id: 'c-it' }, data: { dynamicBidding: { ...(was ?? {}), maxBidChangePct: 10 } } }))
    try {
      const refused = (await undo(rid, [approved.suggestionId])).json()
      expect(refused.results[0]).toMatchObject({ restored: false, reopened: false, reason: 'Not put back: the largest change of one step (10 %, the campaign) holds the way back from 60¢ to 40¢ at 54¢. Nothing was written; change the bid by hand if you want it back.' })
      expect(await bid()).toBe(60)
      expect((await ask(approved.suggestionId)).status).toBe('applied')
    } finally {
      await inA(() => db().campaign.update({ where: { id: 'c-it' }, data: { dynamicBidding: was ?? Prisma.DbNull } }))
    }
    // With the step allowed again, the same undo puts it back whole.
    expect((await undo(rid, [approved.suggestionId])).json()).toMatchObject({ undone: 1, reopened: 1 })
    expect(await bid()).toBe(40)
    await inA(() => db().adsRuleSuggestion.delete({ where: { id: approved.suggestionId } }))
  })

  it('put back, but an ask too old to wait, or of an archived rule, expires instead of waiting again — and says so', async () => {
    const old = await approve(44, { lastSeenAt: ago(10) })
    const stale = (await undo(rid, [old.suggestionId])).json()
    expect(stale).toEqual({
      results: [{ suggestionId: old.suggestionId, restored: true, reopened: false, reason: 'Put back. The rule last asked this more than 3 days ago, so the ask does not wait again: it expired. If it still holds, the rule asks again.' }],
      undone: 1, reopened: 0,
    })
    expect(await bid()).toBe(40)
    expect(await ask(old.suggestionId)).toMatchObject({ status: 'expired', decidedBy: 'system:stale' })

    // Sent to Amazon before the archive (an archive cancels only the rule's writes still queued).
    const recent = await approve(42)
    await inA(() => db().advertisingActionLog.update({ where: { id: recent.actionLogId }, data: { amazonResponseStatus: 'SUCCESS' } }))
    expect((await post(`/api/advertising/bid-rules/${rid}/archive`)).statusCode).toBe(200)
    try {
      const archived = (await undo(rid, [recent.suggestionId])).json()
      expect(archived.results[0]).toEqual({ suggestionId: recent.suggestionId, restored: true, reopened: false, reason: 'Put back. The rule is archived, so the ask does not wait again: it expired.' })
      expect(await bid()).toBe(40)
      expect(await ask(recent.suggestionId)).toMatchObject({ status: 'expired', decidedBy: 'system:archived' })
    } finally {
      await post(`/api/advertising/bid-rules/${rid}/unarchive`)
    }
  })

  it('a change the archive cancelled before it was sent: the value is already back, nothing to put back, and the answer says so', async () => {
    const queued = await approve(43)
    expect((await post(`/api/advertising/bid-rules/${rid}/archive`)).json()).toMatchObject({ cancelledWrites: 1 })
    try {
      expect(await bid()).toBe(40)
      const logs = await inA(() => db().advertisingActionLog.count({ where: { entityId: T } }))
      expect((await undo(rid, [queued.suggestionId])).json().results[0]).toEqual({
        suggestionId: queued.suggestionId, restored: true, reopened: false,
        reason: 'Its change never reached Amazon (cancelled) and the value is already back, so nothing had to be put back. The rule is archived, so the ask does not wait again: it expired.',
      })
      expect(await inA(() => db().advertisingActionLog.count({ where: { entityId: T } }))).toBe(logs)
    } finally {
      await post(`/api/advertising/bid-rules/${rid}/unarchive`)
    }
  })

  it('an approval the brain took as its input (a campaign it runs): the input ends now; nothing is written, no hold', async () => {
    const until = new Date(Date.now() + 7 * DAY)
    const created = await inA(async () => {
      const directive = await db().bidDirective.create({ data: { campaignId: 'c-it', targetId: T, kind: 'CEILING', valueCents: 30, source: `rule:${rid}`, until, reason: 'bid_apply set 40¢ → 30¢' } })
      const s = await db().adsRuleSuggestion.create({
        data: {
          ruleId: rid, entityType: 'AD_TARGET', entityId: T, proposedKey: 'bid_apply:set:0.3:brain', proposedAction: { type: 'bid_apply', op: 'set', value: 0.3, adTargetId: T },
          status: 'applied', decidedAt: new Date(), decidedBy: 'operator',
          appliedResult: { type: 'bid_apply', ok: true, output: { campaignId: 'c-it', bidBrain: { stored: 'a ceiling 30¢ on 1 keyword — the brain reads it on its next run', directives: 1, until: until.toISOString(), sample: [{ targetId: T, lane: null, kind: 'CEILING', valueCents: 30, valuePct: null }] } } },
        },
      })
      return { directiveId: directive.id as string, suggestionId: s.id as string }
    })
    const logsBefore = await inA(() => db().advertisingActionLog.count({ where: { entityId: T } }))
    const res = (await undo(rid, [created.suggestionId])).json()
    expect(res).toEqual({ results: [{ suggestionId: created.suggestionId, restored: true, reopened: true, reason: 'Its input to the brain ended: the brain no longer reads it. Nothing had been sent to Amazon.' }], undone: 1, reopened: 1 })
    const after = await inA(async () => ({
      directive: await db().bidDirective.findUnique({ where: { id: created.directiveId } }),
      logs: await db().advertisingActionLog.count({ where: { entityId: T } }),
      holds: await db().bidHold.count({ where: { targetId: T } }),
    }))
    expect(after.directive.until.getTime()).toBeLessThanOrEqual(Date.now())
    expect(after.logs).toBe(logsBefore)
    expect(after.holds).toBe(0)
    expect(await bid()).toBe(40)
    expect((await ask(created.suggestionId)).status).toBe('pending')
  })
})
