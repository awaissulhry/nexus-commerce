/**
 * Negative Targeting page (2026-10-11, lane NWRITE) — the WRITE routes of /api/advertising/waste on PGlite (production
 * schema), business profiles ON, the permission manifest enforced (rbac-hook), Idempotency-Key receipts on, the ads mode
 * sandbox and the job queue a stub (nothing leaves the process). Made-up ids and terms.
 *
 *   preview    one step per row: the tool it becomes, from → to, where it lands, the place as links, its refusal in words
 *              (a keyword is never negated, a row that is not one); a planHash; nothing written
 *   apply      a moved preview is 409; the rows become ONE change plan (one step per row) asked and approved by the person
 *              on the page (via app); committed and run: the keyword paused AND kept paused, the term negated with its
 *              author (PERSON) and audit row; one row is the tool itself
 *   turn on    the kept-paused keyword: TURN_ON releases it (enable-ads releaseKeepPaused), raises spend; applied, it is
 *              on again and the hold ended
 *   skip       7 days, then unskip with the undo that puts the same end back
 *   waiting    a page request rejected through the Approvals page's path; another kind of request is 404
 *   cards      a rule's Ask-me cards (`suggestion:<id>`): approve applies a pause_target through the Suggestions page's own
 *              path and keeps the keyword paused (the rule holds it); reject dismisses a negative card; another kind of
 *              card is 404
 *   release    the campaign screen's PATCH: a kept-paused keyword's turn-on is 409 "Kept paused by … — turn on from
 *              Negative Targeting or confirm the release" with who holds it; with releaseKeptPaused it is on, the hold ended
 *   refusals   403 without ads.campaigns.manage (the manifest); 400 a wrong body
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { seedAdsFixture } from '../test-support/ads-fixtures.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn(async () => undefined) }))
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

const A = 'neg_waste_writes_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const OWNER = [FEATURES.adsView, FEATURES.adsCampaignsManage, FEATURES.adsBidsEdit, FEATURES.adsAutomationManage, FIELDS.financialsAdspendView, FEATURES.aiRun, FEATURES.settingsSecurityManage]
let permissions = new Set<string>(OWNER)
let app: FastifyInstance
let userId = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  userId = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Nora Negative' } })).id
  await inA(async () => {
    const c = database.client
    const role = await c.role.create({ data: { key: `NEG_${randomUUID().slice(0, 8)}`, name: 'Ads owner', description: 'test', permissions: OWNER, isSystem: false } })
    await c.userRole.create({ data: { userId, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: A, userId, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    await c.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
    await seedAdsFixture(c)
    // One product advertised in the Italian ad group (add-negative-targets keeps a product's negatives to its own places).
    const p = await c.product.create({ data: { id: 'neg-jacket', sku: 'NEG-JACKET', name: 'Jacket', basePrice: '80.00' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-c-it', productId: p.id, sku: 'NEG-JACKET', asin: 'B0NEGJACK1', externalAdId: 'EXT-pa-neg' } })
    // Polish S17 — another ad group of the same product (where some searches still run), and one of another product.
    const other = await c.product.create({ data: { id: 'neg-boot', sku: 'NEG-BOOT', name: 'Boot', basePrice: '60.00' } })
    await c.adGroup.create({ data: { id: 'g-it2', campaignId: 'c-it', name: 'group broad', externalAdGroupId: 'EXT-g-it2' } })
    await c.adGroup.create({ data: { id: 'g-other', campaignId: 'c-pin', name: 'group boots', externalAdGroupId: 'EXT-g-other' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-it2', productId: p.id, sku: 'NEG-JACKET', asin: 'B0NEGJACK1', externalAdId: 'EXT-pa-neg2' } })
    await c.adProductAd.create({ data: { adGroupId: 'g-other', productId: other.id, sku: 'NEG-BOOT', asin: 'B0NEGBOOT1', externalAdId: 'EXT-pa-boot' } })
    const term = (adGroupId: string, query: string) => ({ profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 5 * 86_400_000), campaignId: adGroupId === 'EXT-g-other' ? 'EXT-c-pin' : 'EXT-c-it', adGroupId, query, impressions: 50, clicks: 5, costMicros: 2_000_000n, currencyCode: 'EUR', sales7dCents: 0, orders7d: 0 })
    await c.amazonAdsSearchTerm.createMany({ data: [term('EXT-g-it2', 'made up shoes'), term('EXT-g-it2', 'race jacket'), term('EXT-g-other', 'made up shoes')] as never })
  })
  const { rbacHook } = await import('../lib/auth/rbac-hook.js')
  const { registerCommandIdempotency } = await import('../lib/command-idempotency.js')
  const { default: routes } = await import('./advertising-waste.routes.js')
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    const r = request as unknown as Record<string, unknown>
    r.__sessionLoaded = true
    r.authUser = { id: userId, email: 'nora@example.test', displayName: 'Nora Negative' }
    r.__rbacResolved = { isOwner: false, permissions }
    r.workspace = business(A)
    withWorkspace(business(A), done)
  })
  app.addHook('preHandler', rbacHook)
  registerCommandIdempotency(app)
  await app.register(routes, { prefix: '/api' })
  await app.register(advertisingRoutes, { prefix: '/api' }) // PATCH /advertising/ad-targets/:id (the release)
  await app.ready()
}, 180_000)

beforeEach(() => { permissions = new Set(OWNER) })

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

type Row = Record<string, any>
const post = (path: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api/advertising/waste${path}`, payload, headers })
const target = (id: string) => inA(() => database.client.adTarget.findUniqueOrThrow({ where: { id } }))
/** The undo window closes now; the commit runs it as the person who approved (a plan: the plan runner runs its steps). */
async function commitNow(approvalId: string) {
  const { commitScheduledApproval } = await import('../services/agent-fleet/approval-inbox.service.js')
  const { runPlan } = await import('../services/agents/change-plan.service.js')
  await inA(() => database.client.agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  const committed = await inA(() => commitScheduledApproval(approvalId))
  const row = await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: approvalId } }))
  if (row.toolName === 'submit-change-plan') return inA(() => runPlan(approvalId))
  return committed
}

const PAUSE = { rowId: 'kw:t-it', action: 'PAUSE' }
const NEGATE = { rowId: 'term:IT|EXT-g-c-it|made up shoes', action: 'NEGATE_EXACT' }

describe('POST /advertising/waste/preview — the page\'s rows as the MCP tools\' steps, nothing written', () => {
  it('one step per row: tool, from → to, where it lands, the place as links; refusals in words; a planHash', async () => {
    const res = await post('/preview', { items: [PAUSE, NEGATE, { rowId: 'kw:t-low', action: 'NEGATE_EXACT' }, { rowId: 'nope', action: 'PAUSE' }] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json()
    expect(body.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.blocked).toBe(2)
    expect(body.steps[0]).toMatchObject({
      rowId: 'kw:t-it', action: 'PAUSE', tool: 'pause-ads', text: 'race jacket', from: 'RUNNING', to: 'KEPT_PAUSED', refusal: null, raise: false, needsCode: false,
      lands: 'nexus', // sandbox: nothing reaches Amazon
      place: { campaign: { id: 'c-it', href: '/marketing/ads/campaigns/c-it' }, adGroup: { id: 'g-c-it', href: '/marketing/ads/campaigns/c-it/ad-groups/g-c-it?tab=targets&focus=t-it' } },
      summary: expect.stringMatching(/Keeps 1 keyword or target paused \(always\)/),
    })
    expect(body.steps[1]).toMatchObject({ rowId: NEGATE.rowId, tool: 'add-negative-targets', text: 'made up shoes', from: 'RUNNING', to: 'NEGATED', refusal: null, place: { adGroup: { href: expect.stringContaining('tab=search-terms&focus=made%20up%20shoes') } } })
    expect(body.steps[2]).toMatchObject({ refusal: { code: 'keyword_is_paused_not_negated' }, tool: null })
    expect(body.steps[3]).toMatchObject({ refusal: { code: 'bad_row' } })
    // Nothing written: no request, the keyword as it was.
    expect(await inA(() => database.client.agentApproval.count())).toBe(0)
    expect(await target('t-it')).toMatchObject({ status: 'ENABLED', keptPausedAt: null })
  })

  it('polish M1, M2, M9, S17: level and final on each step; the negative over a keyword; a named ad group of the same product', async () => {
    const body = (await post('/preview', { items: [
      { rowId: 'term:IT|EXT-g-c-it|made up shoes', action: 'NEGATE_EXACT', where: 'campaign' },
      { rowId: 'neg:t-neg', action: 'REMOVE_NEGATIVE' },
      { rowId: 'kw:t-it', action: 'REMOVE_NEGATIVE', targetRowId: 'neg:t-neg' },
      { rowId: 'kw:t-low', action: 'REMOVE_NEGATIVE', targetRowId: 'neg:t-sup' },
      { rowId: 'term:IT|EXT-g-c-it|made up hats', action: 'NEGATE_EXACT', adGroupId: 'g-it2' },
      { rowId: 'term:IT|EXT-g-c-it|made up shoe', action: 'NEGATE_PHRASE', adGroupId: 'g-other' },
      { rowId: 'kw:t-sup', action: 'NEGATE_EXACT', adGroupId: 'g-it2' },
      { rowId: 'kw:t-uk', action: 'NEGATE_EXACT', adGroupId: 'g-other' },
    ] })).json()
    const by = (i: number) => body.steps[i]
    // M1 — a campaign negative: level CAMPAIGN, its place ends at the campaign.
    expect(by(0)).toMatchObject({ level: 'CAMPAIGN', final: false, refusal: null, place: { campaign: { id: 'c-it' }, adGroup: null } })
    // M2 — a removal is final at Amazon; HONEST 18d — here (a sandbox) it lands in Nexus only: never "archived at Amazon",
    // and it lets nothing spend again.
    expect(by(1)).toMatchObject({ action: 'REMOVE_NEGATIVE', level: 'AD_GROUP', lands: 'nexus', final: false, raise: false, refusal: null, tool: 'retire-negatives', text: 'free' })
    // M9 — from our keyword's row, only a clash's negative (HONEST 5): "free" stands in its place but does not block
    // "race jacket", so it is not removed from there; one that is not over it at all is refused as before.
    expect(by(2)).toMatchObject({ rowId: 'kw:t-it', action: 'REMOVE_NEGATIVE', refusal: { code: 'not_a_clash' }, tool: null, text: 'free' })
    expect(by(3)).toMatchObject({ refusal: { code: 'not_over_keyword' } })
    // S17 — a named ad group: refused where the term never ran, where another product is advertised, and our keyword's text
    // in another ad group of its product where it does not run.
    expect(by(4)).toMatchObject({ refusal: { code: 'not_running_there' } })
    expect(by(5)).toMatchObject({ refusal: { code: 'other_product' } })
    expect(by(6)).toMatchObject({ refusal: { code: 'not_running_there' } })
    expect(by(7)).toMatchObject({ refusal: { code: 'other_product' } })
    const ok = (await post('/preview', { items: [
      { rowId: 'term:IT|EXT-g-c-it|made up shoes', action: 'NEGATE_EXACT', adGroupId: 'g-it2' },
      { rowId: 'kw:t-it', action: 'NEGATE_EXACT', adGroupId: 'g-it2' },
      { rowId: 'kw:t-low', action: 'NEGATE_EXACT', adGroupId: 'g-c-it' },
    ] })).json()
    expect(ok.steps[0]).toMatchObject({ refusal: null, level: 'AD_GROUP', tool: 'add-negative-targets', place: { adGroup: { id: 'g-it2' } } })
    expect(ok.steps[1]).toMatchObject({ refusal: null, text: 'race jacket', place: { adGroup: { id: 'g-it2' } } })
    expect(ok.steps[2]).toMatchObject({ refusal: { code: 'own_place' } })
  })

  it('a row named twice is one change: the second is refused', async () => {
    const body = (await post('/preview', { items: [PAUSE, { ...PAUSE, keepUntil: '2099-01-01' }] })).json()
    expect(body.steps.map((s: Row) => s.refusal?.code ?? null)).toEqual([null, 'duplicate_row'])
  })

  it('400 a wrong body; 403 without ads.campaigns.manage', async () => {
    expect((await post('/preview', { items: [] })).statusCode).toBe(400)
    expect((await post('/preview', { items: [{ rowId: 'kw:t-it', action: 'DELETE' }] })).statusCode).toBe(400)
    permissions = new Set(OWNER.filter((p) => p !== FEATURES.adsCampaignsManage))
    expect((await post('/preview', { items: [PAUSE] })).statusCode).toBe(403)
  })
})

describe('POST /advertising/waste/apply — ONE request, approved by the person on the page', () => {
  it('a moved preview is 409, with the fresh one', async () => {
    const res = await post('/apply', { items: [PAUSE], planHash: '0'.repeat(64) })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'stale_preview', planHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(await inA(() => database.client.agentApproval.count())).toBe(0)
  })

  it('two rows: one change plan via the page, approved now; run, the keyword kept paused and the term negated (author: the person)', async () => {
    const items = [PAUSE, NEGATE]
    const { planHash } = (await post('/preview', { items })).json()
    const res = await post('/apply', { items, planHash }, { 'idempotency-key': `neg-apply-${randomUUID()}` })
    expect(res.statusCode, res.body).toBe(202)
    const body = res.json()
    expect(body).toMatchObject({ changeSetId: expect.any(String), status: 'queued', tool: 'submit-change-plan', needsCode: false, approve: { ok: true }, blocked: 0, executeAfter: expect.any(String) })
    const ap = await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: body.changeSetId }, include: { agentRun: { select: { via: true } } } }))
    expect(ap).toMatchObject({ toolName: 'submit-change-plan', status: 'scheduled', decidedByUserId: userId, agentRun: { via: 'app' } })
    const steps = await inA(() => database.client.agentPlanStep.findMany({ where: { approvalId: body.changeSetId }, orderBy: { position: 'asc' } }))
    expect(steps.map((s) => s.toolName)).toEqual(['pause-ads', 'add-negative-targets'])

    expect(await commitNow(body.changeSetId)).toMatchObject({ finished: true, counts: { done: 2 } })
    expect(await target('t-it')).toMatchObject({ status: 'PAUSED', keptPausedAt: expect.any(Date), keptPausedBy: `user:${userId}`, keptPausedUntil: null })
    const negative = await inA(() => database.client.adTarget.findFirstOrThrow({ where: { adGroupId: 'g-c-it', isNegative: true, expressionValue: 'made up shoes' } }))
    expect(negative).toMatchObject({ negativeOrigin: 'PERSON', expressionType: 'NEGATIVE_EXACT', negativeLevel: 'AD_GROUP' })
    const audit = await inA(() => database.client.advertisingActionLog.findMany({ where: { executionId: body.changeSetId }, orderBy: { createdAt: 'asc' } }))
    expect(audit.map((a) => a.actionType).sort()).toEqual(['AD_ENTITY_STATE_UPDATE', 'create_negative_keyword', 'keep_paused'])
  })

  it('the kept-paused keyword: TURN_ON releases it (raise); one row is the tool itself; run, it is on and the hold ended', async () => {
    const items = [{ rowId: 'kw:t-it', action: 'TURN_ON' }]
    const preview = (await post('/preview', { items })).json()
    expect(preview.steps[0]).toMatchObject({ tool: 'enable-ads', from: 'KEPT_PAUSED', to: 'RUNNING', raise: true, refusal: null, summary: expect.stringMatching(/Releases 1 keyword or target kept paused/) })
    const res = await post('/apply', { items, planHash: preview.planHash })
    expect(res.statusCode, res.body).toBe(202)
    const body = res.json()
    expect(body).toMatchObject({ status: 'queued', tool: 'enable-ads', approve: { ok: true } })
    expect(await commitNow(body.changeSetId)).toMatchObject({ ok: true })
    expect(await target('t-it')).toMatchObject({ status: 'ENABLED', keptPausedAt: null, keptPausedBy: null })
    const released = await inA(() => database.client.advertisingActionLog.findFirst({ where: { entityId: 't-it', actionType: 'release_kept_paused' } }))
    expect(released).toMatchObject({ executionId: body.changeSetId, userId: `user:${userId}`, amazonResponseStatus: 'SKIPPED' })
  })

  it('RELEASE on a keyword not kept paused is refused in the preview, and nothing is sent', async () => {
    const items = [{ rowId: 'kw:t-low', action: 'RELEASE' }]
    const preview = (await post('/preview', { items })).json()
    expect(preview.steps[0]).toMatchObject({ refusal: { code: 'not_kept_paused' } })
    const res = await post('/apply', { items, planHash: preview.planHash })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Nothing to send/)
  })
})

describe('POST /advertising/waste/skip · /unskip — Nexus only, undoable', () => {
  it('skips 7 days; unskip ends it and answers the body that puts the same end back', async () => {
    const skipped = await post('/skip', { ids: ['kw:t-low', 'term:IT|EXT-g-c-it|made up socks'], days: 7 })
    expect(skipped.statusCode, skipped.body).toBe(200)
    const body = skipped.json()
    expect(body).toMatchObject({ ok: true, skipped: [{ rowId: 'kw:t-low' }, { rowId: 'term:IT|EXT-g-c-it|made up socks' }], undo: { path: '/api/advertising/waste/unskip', body: { ids: ['kw:t-low', 'term:IT|EXT-g-c-it|made up socks'] } } })
    const rows = await inA(() => database.client.adsWasteSkip.findMany({ where: { endedAt: null } }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ by: `user:${userId}` })
    const un = await post('/unskip', { ids: ['kw:t-low'] })
    expect(un.statusCode, un.body).toBe(200)
    const first = await inA(() => database.client.adsWasteSkip.findFirstOrThrow({ where: { rowKey: 'kw:t-low' } }))
    expect(un.json()).toMatchObject({ ok: true, unskipped: 1, undo: { path: '/api/advertising/waste/skip', body: { reopen: [first.id] } } })
    expect(await inA(() => database.client.adsWasteSkip.count({ where: { endedAt: null } }))).toBe(1)
    // Polish M5 — the undo of the unskip reopens the very skip: same start, person, end and reason.
    const reopened = await post('/skip', { reopen: [first.id] })
    expect(reopened.statusCode, reopened.body).toBe(200)
    expect(reopened.json()).toMatchObject({ ok: true, reopened: [{ rowId: 'kw:t-low', until: body.skipped[0].until }], notReopened: [] })
    expect(await inA(() => database.client.adsWasteSkip.findUniqueOrThrow({ where: { id: first.id } }))).toMatchObject({ endedAt: null, endedBy: null, at: first.at, by: first.by, until: first.until })
    expect(await inA(() => database.client.adsWasteSkip.count({ where: { rowKey: 'kw:t-low' } }))).toBe(1)
    expect((await post('/skip', { ids: ['kw:t-sup'], until: new Date(Date.now() + 40 * 86_400_000).toISOString() })).statusCode).toBe(400)
    expect((await post('/skip', { ids: ['kw:t-low'], days: 3 })).statusCode).toBe(400)
    expect((await post('/skip', { ids: ['camp:c-it'], days: 7 })).statusCode).toBe(400)
  })
})

describe('POST /advertising/waste/waiting/decide — through the Approvals page\'s path', () => {
  it('rejects a waiting page request; another kind of request is 404 here', async () => {
    const { requestApproval } = await import('../services/agents/approval-gate.service.js')
    const person = { kind: 'user' as const, userId, label: 'Nora Negative', via: 'claude' as const, workspace: business(A), permissions: { isOwner: false, permissions: new Set<string>(OWNER) } }
    const asked = await inA(() => requestApproval('pause-ads', { targetIds: ['t-low'], keepPaused: true, why: 'a made-up ask' }, person as never))
    expect(asked).toMatchObject({ ok: true, mode: 'queued' })
    const first = await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: (asked as Row).approvalId } }))
    const other = await inA(() => database.client.agentApproval.create({ data: { agentRunId: first.agentRunId, toolName: 'set-price', riskTier: 'high', args: {}, status: 'pending' } }))
    const res = await post('/waiting/decide', { decisions: [{ approvalId: (asked as Row).approvalId, decide: 'reject', reason: 'not now' }, { approvalId: other.id, decide: 'approve' }] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ failed: 1, results: [{ ok: true, status: 'rejected' }, { ok: false, httpStatus: 404 }] })
    expect((await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: (asked as Row).approvalId } }))).status).toBe('rejected')
    expect((await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: other.id } }))).status).toBe('pending')
    expect(await target('t-low')).toMatchObject({ status: 'ENABLED', keptPausedAt: null })
  })
})

describe('GET /advertising/waste/waiting/:id — every step of a request, before it is decided here (NFIX)', () => {
  it('a mixed change plan lists each step — the page\'s and the others — as approved together; another kind of request is 404', async () => {
    const { queuePlan } = await import('../services/agents/change-plan.service.js')
    const person = { kind: 'user' as const, userId, label: 'Nora Negative', via: 'claude' as const, workspace: business(A), permissions: { isOwner: false, permissions: new Set<string>(OWNER) } }
    const run = await inA(() => database.client.agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'awaiting_approval', via: 'claude' } }))
    const asked = await inA(() => queuePlan({ title: 'A made-up mixed plan', steps: [
      { tool: 'pause-ads', args: { targetIds: ['t-low'], keepPaused: true, why: 'made up' } },
      { tool: 'set-target-bid', args: { targetId: 't-it', proposedBidCents: 50, why: 'made up' } },
    ] }, person as never, run.id))
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
    const id = (asked as Row).approvalId as string
    try {
      const res = await app.inject({ method: 'GET', url: `/api/advertising/waste/waiting/${id}` })
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ approvalId: id, plan: true, status: 'pending', title: 'A made-up mixed plan', offPage: 1 })
      expect(body.steps.map((x: Row) => [x.step, x.tool, x.onPage])).toEqual([[1, 'pause-ads', true], [2, 'set-target-bid', false]])
      expect(body.steps[0].words).toBe('Pause')
      // The step this page does not show is listed with what it changes, from → to.
      expect(body.steps[1].changes.length).toBeGreaterThan(0)
      expect(body.steps[1].changes.some((c: Row) => c.from != null && c.to != null)).toBe(true)
      expect(res.body).not.toMatch(/set-target-bid"[^,]*"words":"set-target-bid/)
      // A request of another kind is not this page's.
      const other = await inA(() => database.client.agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-price', riskTier: 'high', args: {}, status: 'pending' } }))
      expect((await app.inject({ method: 'GET', url: `/api/advertising/waste/waiting/${other.id}` })).statusCode).toBe(404)
      await inA(() => database.client.agentApproval.delete({ where: { id: other.id } }))
    } finally {
      await inA(() => database.client.agentApproval.updateMany({ where: { id, status: 'pending' }, data: { status: 'rejected', reason: 'test cleanup' } }))
    }
  })
})

describe('a plan step with no stored preview still names its words and its place (NFIX)', () => {
  it('reads them from the step\'s own arguments: a negative, a removal, a pause', async () => {
    const run = await inA(() => database.client.agentRun.create({ data: { agentKey: 'ads-brain-negatives', trigger: 'schedule', status: 'done' } }))
    const ap = await inA(() => database.client.agentApproval.create({ data: {
      agentRunId: run.id, toolName: 'submit-change-plan', riskTier: 'high', args: { title: 'made up', steps: 3 }, status: 'pending', expiresAt: new Date(Date.now() + 86_400_000),
      planSteps: { create: [
        { position: 1, toolName: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-c-it', text: 'cheap made up', matchType: 'NEGATIVE_PHRASE' }, { campaignId: 'c-it', text: 'free made up' }] } },
        { position: 2, toolName: 'retire-negatives', args: { negativeIds: ['t-neg'] } },
        { position: 3, toolName: 'pause-ads', args: { targetIds: ['t-low'] } },
      ] },
    } }))
    try {
      const res = await app.inject({ method: 'GET', url: `/api/advertising/waste/waiting/${ap.id}` })
      expect(res.statusCode, res.body).toBe(200)
      const [add, retire, pause] = res.json().steps as Row[]
      expect(add).toMatchObject({ where: null, changeCount: 2 })
      expect(add.changes).toEqual([
        { label: 'Negative phrase "cheap made up" · Italy exact › group c-it', from: null, to: 'Added' },
        { label: 'Negative exact "free made up" · Italy exact · whole campaign', from: null, to: 'Added' },
      ])
      expect(retire).toMatchObject({ where: { name: 'Italy exact › group c-it', href: '/marketing/ads/campaigns/c-it/ad-groups/g-c-it' }, changes: [{ label: 'Negative exact "free"', from: 'Standing', to: 'Removed' }] })
      expect(pause).toMatchObject({ where: { name: 'Italy exact › group c-it' }, changes: [{ label: 'cheap boots', from: 'Running', to: 'Paused' }] })
    } finally {
      await inA(() => database.client.agentApproval.delete({ where: { id: ap.id } }))
    }
  })
})

describe('rule cards and the campaign screen\'s release', () => {
  const RULE = 'cnegwasterule000000000001'
  it('a rule\'s Ask-me cards: approve applies the pause and keeps it paused, reject dismisses, another card is 404', async () => {
    const ids = await inA(async () => {
      const c = database.client
      await c.automationRule.create({ data: { id: RULE, name: 'Stop waste — keywords (made up)', domain: 'advertising', trigger: 'TARGET_PERFORMANCE', enabled: true, dryRun: false, autonomyLevel: 'PROPOSE', conditions: [], actions: [{ type: 'pause_target' }] } as never })
      const card = (key: string, entityType: string, entityId: string, proposedAction: Record<string, unknown>) =>
        c.adsRuleSuggestion.create({ data: { ruleId: RULE, ruleName: 'Stop waste — keywords (made up)', trigger: 'TARGET_PERFORMANCE', marketplace: 'IT', entityType, entityId, proposedAction: proposedAction as never, proposedKey: key } })
      return {
        pause: (await card('k-pause', 'AD_TARGET', 't-low', { type: 'pause_target', adTargetId: 't-low' })).id,
        negate: (await card('k-neg', 'SEARCH_TERM', 'EXT-c-it:made up hats', { type: 'add_negative_exact' })).id,
        bid: (await card('k-bid', 'AD_TARGET', 't-sup', { type: 'bid_apply', adTargetId: 't-sup', op: 'setValue', value: 0.3 })).id,
      }
    })
    const res = await post('/waiting/decide', { decisions: [
      { approvalId: `suggestion:${ids.pause}`, decide: 'approve' },
      { approvalId: `suggestion:${ids.negate}`, decide: 'reject' },
      { approvalId: `suggestion:${ids.bid}`, decide: 'approve' },
    ] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ failed: 1, results: [
      { approvalId: `suggestion:${ids.pause}`, ok: true, status: 'applied' },
      { approvalId: `suggestion:${ids.negate}`, ok: true, status: 'dismissed' },
      { approvalId: `suggestion:${ids.bid}`, ok: false, httpStatus: 404 },
    ] })
    expect(await target('t-low')).toMatchObject({ status: 'PAUSED', keptPausedBy: `automation:${RULE}`, keptPausedUntil: null })
    const cards = await inA(() => database.client.adsRuleSuggestion.findMany({ where: { id: { in: [ids.pause, ids.negate, ids.bid] } }, orderBy: { proposedKey: 'asc' } }))
    expect(cards.map((c) => [c.proposedKey, c.status, c.decidedBy])).toEqual([['k-bid', 'pending', null], ['k-neg', 'dismissed', `user:${userId}`], ['k-pause', 'applied', `user:${userId}`]])
  })

  it('polish M3: KEEP_UNTIL changes only the hold\'s end (from → to), and its Undo asks for the old end back', async () => {
    const items = [{ rowId: 'kw:t-low', action: 'KEEP_UNTIL', keepUntil: '2099-12-31' }]
    const preview = (await post('/preview', { items })).json()
    expect(preview.steps[0]).toMatchObject({ action: 'KEEP_UNTIL', tool: 'pause-ads', from: 'ALWAYS', to: '2099-12-31T00:00:00.000Z', refusal: null, raise: false, final: false })
    const res = await post('/apply', { items, planHash: preview.planHash })
    expect(res.statusCode, res.body).toBe(202)
    expect(await commitNow(res.json().changeSetId)).toMatchObject({ ok: true })
    expect(await target('t-low')).toMatchObject({ status: 'PAUSED', keptPausedBy: `automation:${RULE}`, keptPausedUntil: new Date('2099-12-31T00:00:00.000Z') })
    const change = await inA(() => database.client.agentChange.findFirstOrThrow({ where: { approvalId: res.json().changeSetId } }))
    const { getTool } = await import('../services/agents/tool-registry.js')
    expect(getTool('pause-ads')!.undo!.request(change as never)).toEqual({ tool: 'pause-ads', args: { targetIds: ['t-low'], keepPaused: true, why: 'undo: kept paused always again' } })
    // A keyword not paused takes no end date.
    expect((await post('/preview', { items: [{ rowId: 'kw:t-sup', action: 'KEEP_UNTIL', keepUntil: null }] })).json().steps[0]).toMatchObject({ refusal: { code: 'not_paused' } })
  })

  it('review S5: Turn on from the page lifts the pause of a rule still on — allowed, with a warning that it may pause it again', async () => {
    const body = (await post('/preview', { items: [{ rowId: 'kw:t-low', action: 'TURN_ON' }] })).json()
    expect(body.steps[0]).toMatchObject({ tool: 'enable-ads', from: 'KEPT_PAUSED', refusal: null, needsCode: false, summary: expect.stringMatching(/Warning: .*still on, and its next run may pause it again/) })
  })

  it('PATCH a kept-paused keyword on: 409 with who holds it; with releaseKeptPaused it is on and the hold ended', async () => {
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/advertising/ad-targets/t-low', payload, headers: { 'x-actor-id': 'u-screen' } })
    const refused = await patch({ status: 'ENABLED' })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Kept paused by the rule "Stop waste — keywords \(made up\)" since .* \(until 31 Dec · .*\)\. Turning it on lets it spend: turn it on from Negative Targeting, or confirm the release\./),
      keptPaused: { by: `automation:${RULE}`, byName: 'the rule "Stop waste — keywords (made up)"', needsRelease: true },
    })
    // Review S15 — the refusal names the signed-in person (not "Unknown").
    expect(await inA(() => database.client.advertisingActionLog.findFirst({ where: { entityId: 't-low', actionType: 'kept_paused_refused' } }))).toMatchObject({ userId: `user:${userId}` })
    expect(await target('t-low')).toMatchObject({ status: 'PAUSED', keptPausedBy: `automation:${RULE}` })
    const released = await patch({ status: 'ENABLED', releaseKeptPaused: true })
    expect(released.statusCode, released.body).toBe(200)
    expect(released.json()).toMatchObject({ ok: true })
    expect(await target('t-low')).toMatchObject({ status: 'ENABLED', keptPausedAt: null, keptPausedBy: null })
  })
})

describe('step 4 — the reach check in every negative review, the same for Claude', () => {
  // Made-up searches in the second ad group of the jacket, 6 days ago (inside the page's 60 days, clicks to 3 days ago).
  beforeAll(async () => {
    const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 6 * 86_400_000)
    const t = (query: string, spendCents: number, orders = 0) => ({
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, campaignId: 'EXT-c-it', adGroupId: 'EXT-g-it2', query,
      impressions: 60, clicks: 6, costMicros: BigInt(spendCents) * 10_000n, currencyCode: 'EUR', sales7dCents: orders * 4000, orders7d: orders,
    })
    await inA(() => database.client.amazonAdsSearchTerm.createMany({ data: [t('made up gloves cheap', 300), t('cheap made up gloves', 200), t('made up gloves', 400, 2), t('gloves made up', 900)] as never }))
    const { invalidateWasteFacts } = await import('../services/advertising/waste/read.js')
    invalidateWasteFacts()
  })
  const EXACT = { rowId: 'term:IT|EXT-g-it2|made up gloves cheap', action: 'NEGATE_EXACT' }
  const PHRASE = { rowId: 'term:IT|EXT-g-it2|made up gloves', action: 'NEGATE_PHRASE' }

  it('each negative says what it would block; a phrase every term holding its words; the terms that sold; the sent ones together', async () => {
    const res = await post('/preview', { items: [EXACT, PHRASE, { rowId: 'kw:t-sup', action: 'PAUSE' }] })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.steps[0]).toMatchObject({ refusal: null, reach: { windowDays: 60, currency: 'EUR', terms: 1, spendCents: 300, clicks: 6, orders: 0, salesCents: 0, sold: [] } })
    // The phrase blocks three of the four (not "gloves made up": its words out of order), one of them sold — the warning.
    // The tool keeps its own hold (a term that converts where it lands): a warning here, never a new refusal.
    expect(body.steps[1].reach).toEqual({ windowDays: 60, currency: 'EUR', terms: 3, spendCents: 900, clicks: 18, orders: 2, salesCents: 8000, sold: [{ text: 'made up gloves', orders: 2 }] })
    expect(body.steps[1].refusal).toMatchObject({ code: 'refused' })
    expect(body.steps[2]).not.toHaveProperty('reach')
    // Together: the steps that are sent.
    expect(body.reach).toEqual({ windowDays: 60, currency: 'EUR', terms: 1, spendCents: 300, clicks: 6, orders: 0, salesCents: 0, currencies: [{ currency: 'EUR', spendCents: 300, salesCents: 0 }] })
    // The planHash does not stand on it: apply takes the preview as it is.
    const apply = await post('/apply', { items: [EXACT], planHash: (await post('/preview', { items: [EXACT] })).json().planHash })
    expect(apply.statusCode, apply.body).toBe(202)
    await inA(() => database.client.agentApproval.updateMany({ where: { id: apply.json().changeSetId }, data: { status: 'rejected', reason: 'test cleanup' } }))
  })

  it('a person who may not see ad spend reads the counts, never the money', async () => {
    permissions = new Set(OWNER.filter((p) => p !== FIELDS.financialsAdspendView))
    const body = (await post('/preview', { items: [EXACT] })).json()
    expect(body.steps[0].reach).toEqual({ windowDays: 60, currency: 'EUR', terms: 1, clicks: 6, orders: 0, sold: [] })
    expect(JSON.stringify(body)).not.toMatch(/spendCents|salesCents/)
  })

  it('Claude reads the same answer: add-negative-targets and create-negative-keyword carry it as pageReach', async () => {
    const page = (await post('/preview', { items: [EXACT, PHRASE] })).json()
    const { getTool } = await import('../services/agents/tool-registry.js')
    const add = await inA(() => getTool('add-negative-targets')!.handler({ adGroupIds: ['g-it2'], keywords: [{ text: 'made up gloves cheap', matchType: 'NEGATIVE_EXACT' }] }, {} as never)) as Row
    expect(add.ok, JSON.stringify(add)).toBe(true)
    expect(add.preview.changes[0].pageReach).toEqual(page.steps[0].reach)
    expect(add.preview.pageReachTotal).toMatchObject({ terms: 1, spendCents: 300, currency: 'EUR' })
    const one = await inA(() => getTool('create-negative-keyword')!.handler({ externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-it2', keywordText: 'made up gloves cheap' }, {} as never)) as Row
    expect(one.ok, JSON.stringify(one)).toBe(true)
    expect(one.preview.pageReach).toEqual(page.steps[0].reach)
  })
})

describe('step 4 — Remove protection and stop: the protected term removed through Claude\'s guardrail tool, then the row\'s verb', () => {
  const WITH_BUDGETS = [...OWNER, FEATURES.adsBudgetsEdit]
  // A term written straight to the table moves no change stamp (the page's writes do): the facts are read again.
  const fresh = async () => (await import('../services/advertising/waste/read.js')).invalidateWasteFacts()
  const protect = async (data: Record<string, unknown>) => { const p = await inA(() => database.client.adKeywordProtection.create({ data: { mode: 'WHITELIST', createdBy: 'user:made-up', ...data } as never })); await fresh(); return p }
  const gone = (id: string) => inA(async () => (await database.client.adKeywordProtection.count({ where: { id } })) === 0)
  // The approver's own role holds the guardrail tool's permissions too (the commit re-checks the person's role, not the request).
  const role = () => inA(async () => (await database.client.userRole.findFirstOrThrow({ where: { userId }, select: { roleId: true } })).roleId)
  beforeAll(async () => { const id = await role(); await inA(() => database.client.role.update({ where: { id }, data: { permissions: WITH_BUDGETS } })) })
  afterAll(async () => { const id = await role(); await inA(() => database.client.role.update({ where: { id }, data: { permissions: OWNER } })) })

  it('a protected keyword: the removal and the pause preview together and go as ONE change set; run, the term is gone and the keyword kept paused', async () => {
    const p = await protect({ term: 'cheap boots', matchType: 'EXACT', marketplace: 'IT', reason: 'made up: our own line' })
    const items = [{ rowId: 'kw:t-low', action: 'UNPROTECT', protectionId: p.id }, { rowId: 'kw:t-low', action: 'PAUSE' }]
    // The removal's tool asks ads.budgets.edit too (the same permissions as the guardrail tool today): without it both are left out.
    const without = (await post('/preview', { items })).json()
    expect(without.steps.map((s: Row) => s.refusal?.code)).toEqual(['forbidden', 'needs_unprotect'])
    permissions = new Set(WITH_BUDGETS)
    const preview = (await post('/preview', { items })).json()
    expect(preview.blocked).toBe(0)
    expect(preview.steps[0]).toMatchObject({
      rowId: 'kw:t-low', action: 'UNPROTECT', tool: 'set-ad-guardrail', text: 'cheap boots', from: 'PROTECTED', to: 'NOT_PROTECTED', lands: 'nexus', raise: true, refusal: null,
      place: { campaign: null, adGroup: null },
      protection: { id: p.id, term: 'cheap boots', match: 'EXACT', market: 'IT', campaign: null, reason: 'made up: our own line', alsoKeeps: { count: 0, terms: [] } },
      summary: expect.stringMatching(/Removes the protection of/),
    })
    expect(preview.steps[1]).toMatchObject({ action: 'PAUSE', tool: 'pause-ads', refusal: null })
    expect(preview.steps[1].after).toBeUndefined()
    const res = await post('/apply', { items, planHash: preview.planHash })
    expect(res.statusCode, res.body).toBe(202)
    const body = res.json()
    expect(body).toMatchObject({ status: 'queued', tool: 'submit-change-plan', approve: { ok: true } })
    const steps = await inA(() => database.client.agentPlanStep.findMany({ where: { approvalId: body.changeSetId }, orderBy: { position: 'asc' } }))
    expect(steps.map((s) => s.toolName)).toEqual(['set-ad-guardrail', 'pause-ads'])
    expect(await commitNow(body.changeSetId)).toMatchObject({ finished: true, counts: { done: 2 } })
    expect(await gone(p.id)).toBe(true)
    expect(await target('t-low')).toMatchObject({ status: 'PAUSED', keptPausedBy: `user:${userId}` })
    const audit = await inA(() => database.client.advertisingActionLog.findFirstOrThrow({ where: { actionType: 'remove_keyword_protection', entityId: p.id } }))
    expect(audit).toMatchObject({ userId: `user:${userId}`, entityType: 'KEYWORD_PROTECTION' })
    // Undo puts the protection back exactly: the same term, match and market, its reason and who set it.
    const change = await inA(() => database.client.agentChange.findFirstOrThrow({ where: { toolName: 'set-ad-guardrail', approvalId: body.changeSetId } }))
    const { getTool } = await import('../services/agents/tool-registry.js')
    const back = getTool('set-ad-guardrail')!.undo!.request(change as never) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'set-ad-guardrail', args: { kind: 'protected-term', op: 'set', term: 'cheap boots', matchType: 'EXACT', marketplace: 'IT', note: 'made up: our own line', restoreChangeId: change.id } })
    const { executeTool } = await import('../services/agents/call-tool.js')
    const approver = { kind: 'user' as const, userId, label: 'Nora Negative', via: 'app' as const, workspace: business(A), permissions: { isOwner: false, permissions: new Set<string>(WITH_BUDGETS) } }
    expect((await inA(() => executeTool(approver as never, back.tool, back.args))).raw).toMatchObject({ ok: true })
    expect(await inA(() => database.client.adKeywordProtection.findFirstOrThrow({ where: { term: 'cheap boots' } }))).toMatchObject({ matchType: 'EXACT', marketplace: 'IT', campaignId: null, reason: 'made up: our own line', createdBy: 'user:made-up' })
    await inA(() => database.client.adKeywordProtection.deleteMany({ where: { term: 'cheap boots' } }))
  })

  it('a protected search term: its negative waits for the removal (sent alone first); once it ran, the SERVER sends it as the same person', async () => {
    await inA(() => database.client.amazonAdsSearchTerm.createMany({ data: ['made up blue shoes', 'made up red shoes', 'made up green shoes'].map((query) => ({
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 6 * 86_400_000), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-it2',
      query, impressions: 40, clicks: 4, costMicros: 1_500_000n, currencyCode: 'EUR', sales7dCents: 0, orders7d: 0,
    })) as never }))
    const p = await protect({ term: 'blue', matchType: 'CONTAINS', marketplace: 'IT', campaignId: 'c-it' })
    const row = 'term:IT|EXT-g-it2|made up blue shoes'
    const items = [{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_EXACT', where: 'adGroup' }]
    permissions = new Set(WITH_BUDGETS)
    const preview = (await post('/preview', { items })).json()
    expect(preview.steps[0]).toMatchObject({ action: 'UNPROTECT', refusal: null, protection: { term: 'blue', match: 'CONTAINS', market: 'IT', campaign: { id: 'c-it' }, alsoKeeps: { count: 0 } } })
    // The negative's tool refuses it while the term stands: it waits for the removal, where it would land then.
    expect(preview.steps[1]).toMatchObject({ action: 'NEGATE_EXACT', tool: 'add-negative-targets', refusal: null, after: 'UNPROTECT', lands: 'nexus', text: 'made up blue shoes', place: { adGroup: { id: 'g-it2' } } })
    const res = await post('/apply', { items, planHash: preview.planHash })
    expect(res.statusCode, res.body).toBe(202)
    const first = res.json()
    expect(first).toMatchObject({ status: 'queued', tool: 'set-ad-guardrail', followUp: { approvalId: first.changeSetId, status: 'WAITING', rowIds: [row] } })
    expect(first.steps[1]).toMatchObject({ after: 'UNPROTECT', runsAt: null })
    // The page may take its approve back and reject it (Undo inside the window): it is one of its requests.
    const { isWasteRequest } = await import('../services/advertising/waste/write.js')
    expect(await inA(() => isWasteRequest(first.changeSetId))).toBe(true)
    // Before the removal ran nothing is sent; the row says its negative follows.
    expect((await post(`/follow-ups/${first.changeSetId}/run`, {})).json()).toMatchObject({ status: 'WAITING' })
    const rows = (await app.inject({ method: 'GET', url: '/api/advertising/waste/rows?market=IT&show=all&pageSize=200' })).json()
    expect(rows.rows.find((r: Row) => r.id === row)).toMatchObject({ state: 'PROTECTED', followUp: { status: 'WAITING' } })
    expect(await commitNow(first.changeSetId)).toMatchObject({ ok: true })
    expect(await gone(p.id)).toBe(true)
    // The server sends it — as the person who approved the removal, through the page's own write, one change set.
    const sent = (await post(`/follow-ups/${first.changeSetId}/run`, {})).json()
    // It says where it lands (Nexus only here) and that its own change set is still in its undo window: never "sent" yet.
    expect(sent).toMatchObject({ status: 'SENT', changeSetId: expect.any(String), results: [{ rowId: row, sent: true, why: null, lands: 'nexus' }], changeSet: { status: 'scheduled', executeAfter: expect.any(String) } })
    const second = await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: sent.changeSetId }, include: { agentRun: { select: { via: true, userId: true } } } }))
    expect(second).toMatchObject({ toolName: 'add-negative-targets', status: 'scheduled', decidedByUserId: userId, agentRun: { via: 'app', userId } })
    // Run twice: sent once.
    expect((await post(`/follow-ups/${first.changeSetId}/run`, {})).json()).toMatchObject({ status: 'SENT', changeSetId: sent.changeSetId })
    expect(await inA(() => database.client.agentApproval.count({ where: { toolName: 'add-negative-targets', status: { in: ['scheduled', 'pending'] } } }))).toBe(1)
    expect(await commitNow(sent.changeSetId)).toMatchObject({ ok: true })
    expect((await post(`/follow-ups/${first.changeSetId}/run`, {})).json()).toMatchObject({ status: 'SENT', changeSet: { status: 'executed' } })
    expect(await inA(() => database.client.adTarget.count({ where: { adGroupId: 'g-it2', isNegative: true, expressionValue: 'made up blue shoes' } }))).toBe(1)
    // The page's Undo once the removal ran: the click undoes the change set by its id — the term comes back exactly.
    const { undoChangeByClick } = await import('../services/agents/change-undo.service.js')
    const approver = { kind: 'user' as const, userId, label: 'Nora Negative', via: 'app' as const, workspace: business(A), permissions: { isOwner: false, permissions: new Set<string>(WITH_BUDGETS) } }
    const undo = await inA(() => undoChangeByClick({ ...approver, permissions: { isOwner: false, permissions: new Set<string>([...WITH_BUDGETS, FEATURES.aiView]) } } as never, first.changeSetId))
    expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true, tool: 'set-ad-guardrail', approvalId: expect.any(String) })
    expect(await commitNow((undo as { approvalId: string }).approvalId)).toMatchObject({ ok: true })
    expect(await inA(() => database.client.adKeywordProtection.findFirstOrThrow({ where: { term: 'blue' } }))).toMatchObject({ matchType: 'CONTAINS', marketplace: 'IT', campaignId: 'c-it', createdBy: 'user:made-up' })
    await inA(() => database.client.adKeywordProtection.deleteMany({ where: { term: 'blue' } }))
    await fresh()
  })

  it('the follow-up refused, in words on the row and in its History; the Undo before it ran sends nothing', async () => {
    permissions = new Set(WITH_BUDGETS)
    const p = await protect({ term: 'green', matchType: 'CONTAINS', marketplace: 'IT' })
    const row = 'term:IT|EXT-g-it2|made up green shoes'
    const items = [{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_EXACT', where: 'adGroup' }]
    const first = (await post('/apply', { items, planHash: (await post('/preview', { items })).json().planHash })).json()
    expect(first.followUp).toMatchObject({ status: 'WAITING' })
    // The term changed meanwhile: someone negated it in its ad group already.
    await inA(() => database.client.adTarget.create({ data: { id: 't-green-neg', adGroupId: 'g-it2', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'made up green shoes', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-t-green-neg' } }))
    await fresh()
    expect(await commitNow(first.changeSetId)).toMatchObject({ ok: true })
    const refused = (await post(`/follow-ups/${first.changeSetId}/run`, {})).json()
    expect(refused).toMatchObject({ status: 'REFUSED', results: [{ rowId: row, sent: false, why: expect.stringMatching(/already negated/) }] })
    const history = (await app.inject({ method: 'GET', url: '/api/advertising/waste/history?market=IT&days=30' })).json().rows as Row[]
    expect(history.find((h) => h.rowId === row && h.action === 'refused')).toMatchObject({ delivery: 'REFUSED', why: expect.stringMatching(/^Not stopped after the protection was removed: .*already negated/) })
    // Undo before the removal ran: the follow-up is cancelled and nothing is ever sent.
    await inA(() => database.client.adTarget.delete({ where: { id: 't-green-neg' } }))
    await fresh()
    const again = await protect({ term: 'green', matchType: 'CONTAINS', marketplace: 'IT' })
    const items2 = [{ rowId: row, action: 'UNPROTECT', protectionId: again.id }, { rowId: row, action: 'NEGATE_EXACT', where: 'adGroup' }]
    const second = (await post('/apply', { items: items2, planHash: (await post('/preview', { items: items2 })).json().planHash })).json()
    expect((await post(`/follow-ups/${second.changeSetId}/cancel`, {})).json()).toMatchObject({ status: 'CANCELLED', changeSetId: null })
    expect((await post(`/follow-ups/${second.changeSetId}/run`, {})).json()).toMatchObject({ status: 'CANCELLED' })
    expect((await post('/follow-ups/nope/run', {})).statusCode).toBe(404)
    await inA(() => database.client.adKeywordProtection.deleteMany({ where: { term: 'green' } }))
  })

  it('someone else\'s removal of a protected term is never the page\'s to read, take back or reject; the page\'s own is (its follow-up)', async () => {
    permissions = new Set(WITH_BUDGETS)
    await protect({ term: 'made up felt', matchType: 'EXACT', marketplace: 'IT' })
    await protect({ term: 'made up wool', matchType: 'EXACT', marketplace: 'IT' })
    const { requestApproval } = await import('../services/agents/approval-gate.service.js')
    const { isWasteRequest } = await import('../services/advertising/waste/write.js')
    const other = { kind: 'user' as const, userId, label: 'Nora Negative', via: 'claude' as const, workspace: business(A), permissions: { isOwner: false, permissions: new Set<string>(WITH_BUDGETS) } }
    const removal = (term: string) => ({ kind: 'protected-term', op: 'remove', term, marketplace: 'IT' })
    const alone = await inA(() => requestApproval('set-ad-guardrail', removal('made up felt'), other as never))
    const plan = await inA(() => requestApproval('submit-change-plan', { title: 'A made-up cleanup', steps: [{ tool: 'set-ad-guardrail', args: removal('made up felt') }, { tool: 'set-ad-guardrail', args: removal('made up wool') }] }, other as never))
    expect(alone).toMatchObject({ ok: true, mode: 'queued' })
    expect(plan).toMatchObject({ ok: true, mode: 'queued' })
    for (const asked of [alone, plan]) {
      const id = (asked as Row).approvalId as string
      expect(await inA(() => isWasteRequest(id))).toBe(false)
      expect((await post('/waiting/decide', { decisions: [{ approvalId: id, decide: 'reject' }] })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/advertising/waste/waiting/${id}` })).statusCode).toBe(404)
      expect((await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id } }))).status).toBe('pending')
    }
    // The page's own removal carries its follow-up (the negatives that wait for it): that is what makes it the page's.
    const { createFollowUp } = await import('../services/advertising/waste/follow-up.js')
    const planId = (plan as Row).approvalId as string
    await inA(() => createFollowUp({ approvalId: planId, items: [{ rowId: 'term:IT|EXT-g-it2|made up felt', action: 'NEGATE_EXACT', where: 'adGroup' }] as never, by: `user:${userId}` }))
    expect(await inA(() => isWasteRequest(planId))).toBe(true)
    await inA(() => database.client.adsWasteFollowUp.deleteMany({ where: { approvalId: planId } }))
    await inA(() => database.client.agentApproval.updateMany({ where: { id: { in: [(alone as Row).approvalId as string, planId] } }, data: { status: 'rejected' } }))
    await inA(() => database.client.adKeywordProtection.deleteMany({ where: { term: { in: ['made up felt', 'made up wool'] } } }))
    await fresh()
  })

  it('bulk: one protected term holding two rows is ONE removal; both negatives wait for it and Nexus sends them together', async () => {
    permissions = new Set(WITH_BUDGETS)
    const p = await protect({ term: 'shoes', matchType: 'CONTAINS', marketplace: 'IT', campaignId: 'c-it' })
    const r1 = 'term:IT|EXT-g-it2|made up red shoes'
    const r2 = 'term:IT|EXT-g-it2|made up shoes'
    const items = [{ rowId: r1, action: 'UNPROTECT', protectionId: p.id }, { rowId: r1, action: 'NEGATE_EXACT', where: 'adGroup' }, { rowId: r2, action: 'NEGATE_EXACT', where: 'adGroup' }]
    const preview = (await post('/preview', { items })).json()
    expect(preview.steps.map((x: Row) => [x.action, x.refusal?.code ?? null, x.after ?? null])).toEqual([['UNPROTECT', null, null], ['NEGATE_EXACT', null, 'UNPROTECT'], ['NEGATE_EXACT', null, 'UNPROTECT']])
    // "Also keeps" never counts the rows this review stops.
    expect(preview.steps[0].protection.alsoKeeps.terms.map((t: Row) => t.text)).not.toEqual(expect.arrayContaining(['made up red shoes', 'made up shoes']))
    const res = (await post('/apply', { items, planHash: preview.planHash })).json()
    expect(res).toMatchObject({ tool: 'set-ad-guardrail', followUp: { status: 'WAITING', rowIds: [r1, r2] } })
    expect(await commitNow(res.changeSetId)).toMatchObject({ ok: true })
    const sent = (await post(`/follow-ups/${res.changeSetId}/run`, {})).json()
    expect(sent).toMatchObject({ status: 'SENT', results: [{ rowId: r1, sent: true }, { rowId: r2, sent: true }] })
    expect((await inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id: sent.changeSetId } }))).toolName).toBe('submit-change-plan')
  })

  it('what else the term keeps safe; a stop that cannot go leaves the protection as it is', async () => {
    await inA(() => database.client.amazonAdsSearchTerm.create({ data: {
      profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(Date.now() - 6 * 86_400_000), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-it2',
      query: 'made up red hat', impressions: 30, clicks: 3, costMicros: 900_000n, currencyCode: 'EUR', sales7dCents: 0, orders7d: 0,
    } as never }))
    await fresh()
    const p = await protect({ term: 'red', matchType: 'CONTAINS', marketplace: 'IT' })
    permissions = new Set(WITH_BUDGETS)
    const row = 'term:IT|EXT-g-it2|made up red shoes'
    const one = (await post('/preview', { items: [{ rowId: row, action: 'UNPROTECT', protectionId: p.id }] })).json()
    // Over its own scope (every IT campaign): the other words it holds, the row's own left out.
    expect(one.steps[0].protection.alsoKeeps).toEqual({ count: 1, terms: [{ text: 'made up red hat', kind: 'TERM', places: 1, wasting: false }] })
    // A product's negative (NEGATE_ASIN) does not fit a word: the stop is left out, so the removal is too.
    const bad = (await post('/preview', { items: [{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_ASIN' }] })).json()
    expect(bad.steps.map((s: Row) => s.refusal?.code)).toEqual(['stop_left_out', 'not_an_asin'])
    expect((await post('/apply', { items: [{ rowId: row, action: 'UNPROTECT', protectionId: p.id }, { rowId: row, action: 'NEGATE_ASIN' }], planHash: bad.planHash })).statusCode).toBe(400)
    expect(await gone(p.id)).toBe(false)
    // A row no protected term holds: nothing to remove.
    expect((await post('/preview', { items: [{ rowId: 'kw:t-sup', action: 'UNPROTECT' }] })).json().steps[0]).toMatchObject({ refusal: { code: 'not_protected' } })
    await inA(() => database.client.adKeywordProtection.deleteMany({ where: { id: p.id } }))
  })
})

describe('HONEST 5 and 8 — the server is the guard: a clash only, and no held stop, whatever the client sends', () => {
  const fresh = async () => (await import('../services/advertising/waste/read.js')).invalidateWasteFacts()

  it('a clash\'s negative is removed from our keyword\'s row; the Owner\'s funnel negative is not', async () => {
    await inA(async () => {
      const c = database.client
      // A negative exact over our exact keyword: it blocks its every search (a clash).
      await c.adTarget.create({ data: { id: 'n-race', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'race jacket', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n-race' } })
      // The funnel: our phrase keyword and a negative exact of its own words in its place.
      await c.adTarget.create({ data: { id: 'k-coat', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'PHRASE', expressionValue: 'race coat', bidCents: 40, externalTargetId: 'EXT-k-coat' } })
      await c.adTarget.create({ data: { id: 'n-coat', adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'race coat', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n-coat' } })
    })
    await fresh()
    try {
      const body = (await post('/preview', { items: [
        { rowId: 'kw:t-it', action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n-race' },
        { rowId: 'kw:k-coat', action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n-coat' },
      ] })).json()
      expect(body.steps[0]).toMatchObject({ refusal: null, tool: 'retire-negatives', text: 'race jacket', place: { adGroup: { id: 'g-c-it' } } })
      expect(body.steps[1]).toMatchObject({ refusal: { code: 'not_a_clash', label: expect.stringMatching(/^Not a clash/) }, tool: null })
    } finally {
      await inA(() => database.client.adTarget.deleteMany({ where: { id: { in: ['n-race', 'k-coat', 'n-coat'] } } }))
      await fresh()
    }
  })

  it('a held negative or pause is left out in the preview and the write, with the hold\'s reason', async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000)
    // Harvest made "made up shoes" a keyword 4 days ago: Harvest judges it for 30 days. "race jacket" is a protected term.
    await inA(async () => {
      const c = database.client as any
      await c.adsBrainHarvest.create({ data: {
        productId: 'neg-jacket', marketplace: 'IT', term: 'made up shoes', status: 'LANDED', level: 'AUTO', destinationKind: 'EXACT', landedAt: day(4),
        sources: [], why: 'made up', evidence: {}, digest: 'd', runId: 'run-h1', decidedAt: day(4), checkedAt: day(1), changedAt: day(4),
      } })
      await c.adKeywordProtection.create({ data: { mode: 'WHITELIST', term: 'race jacket', matchType: 'EXACT', createdBy: 'user:made-up' } })
    })
    await fresh()
    try {
      // What any client may send: the term's own place, the keyword's pause, a named place (the Where tab).
      const items = [NEGATE, PAUSE]
      const asked = await inA(() => database.client.agentApproval.count())
      const preview = (await post('/preview', { items })).json()
      expect(preview.steps.map((s: Row) => s.refusal?.code)).toEqual(['held', 'held'])
      expect(preview.steps[0].refusal.label).toMatch(/^Harvest made "made up shoes" a keyword 4 days ago/)
      expect(preview.steps[1].refusal.label).toMatch(/"race jacket" is a protected term/)
      const named = (await post('/preview', { items: [{ rowId: NEGATE.rowId, action: 'NEGATE_EXACT', adGroupId: 'g-it2' }] })).json()
      expect(named.steps[0]).toMatchObject({ place: { adGroup: { id: 'g-it2' } }, refusal: { code: 'held', label: expect.stringMatching(/^Harvest made/) } })
      // The write re-reads the same: nothing is sent.
      const apply = await post('/apply', { items, planHash: preview.planHash })
      expect(apply.statusCode, apply.body).toBe(400)
      expect(apply.json()).toMatchObject({ blocked: 2 })
      expect(await inA(() => database.client.agentApproval.count())).toBe(asked)
    } finally {
      await inA(async () => {
        const c = database.client as any
        await c.adsBrainHarvest.deleteMany({ where: { runId: 'run-h1' } })
        await c.adKeywordProtection.deleteMany({ where: { term: 'race jacket' } })
      })
      await fresh()
    }
  })
})
