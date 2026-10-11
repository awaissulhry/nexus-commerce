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
    // M2 — a removal is final.
    expect(by(1)).toMatchObject({ action: 'REMOVE_NEGATIVE', level: 'AD_GROUP', final: true, refusal: null, tool: 'retire-negatives', text: 'free' })
    // M9 — from our keyword's row, the negative over it; not one that is not over it.
    expect(by(2)).toMatchObject({ rowId: 'kw:t-it', action: 'REMOVE_NEGATIVE', final: true, refusal: null, tool: 'retire-negatives', text: 'free', place: { adGroup: { id: 'g-c-it' } } })
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
