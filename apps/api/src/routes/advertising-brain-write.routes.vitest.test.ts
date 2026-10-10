/**
 * Ads brain page A5 — the brain's write routes on a real PostgreSQL (PGlite), business profiles ON, the permission manifest
 * enforced (rbac-hook) and the Idempotency-Key receipts on:
 *
 *   ask        POST …/brain/control asks the gate for set-ads-brain as this person: 202, one pending request through the page's
 *              door (via app), the tool's own arguments only — `approve` and `code` never stored
 *   one click  a lever to AUTO needs the approver's code: approve without it is refused (mfa_required) and the request waits;
 *              decided with the code it is scheduled (the undo window), committed it runs as that person
 *   kill       op kill runs at once on the person's click (recorded, undoable); op end waits for approval and the code
 *   refusals   403 without ads.automation.manage (the manifest) or ai.run (the gate); 400 wrong arguments
 *   requests   GET …/brain/requests lists what waits on the brain; decide refuses an id the list does not hold (404)
 *   double     the same Idempotency-Key twice asks once
 *
 * Values are made up (public repo).
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecret, generateSync } from 'otplib'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import { __stepUpTest } from '../lib/auth/step-up.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// The app's client as db.ts builds it: an inDatabaseTransaction's statements run on its transaction (one connection).
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
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn(async () => undefined) }))

const A = 'a5_brain_writes_alpha'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const P = 'a5-jacket'
const Q = 'a5-gloves'
const OWNER = [FEATURES.adsView, FEATURES.adsAutomationManage, FEATURES.adsCampaignsManage, FIELDS.financialsAdspendView, FEATURES.aiRun, FEATURES.settingsSecurityManage]
let permissions = new Set<string>(OWNER)
let app: FastifyInstance
let userId = ''
let secret = ''

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  secret = generateSecret()
  userId = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Rita Brain', twoFactorEnabledAt: new Date(), twoFactorSecret: secret } })).id
  await inA(async () => {
    const c = database.client
    // A member of the business with these permissions: the commit re-checks the approver's membership before it runs.
    const role = await c.role.create({ data: { key: `A5_${randomUUID().slice(0, 8)}`, name: 'Brain owner', description: 'test', permissions: OWNER, isSystem: false } })
    await c.userRole.create({ data: { userId, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: A, userId, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    await c.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
    await c.product.create({ data: { id: P, sku: 'A5-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    await c.product.create({ data: { id: Q, sku: 'A5-GLOVES', name: 'Gloves', basePrice: '30.00', isParent: true } })
    await c.adsBrainEnrollment.create({ data: { productId: P, marketplace: 'IT', enrolledBy: 'user:owner', updatedBy: 'user:owner' } })
  })
  const { rbacHook } = await import('../lib/auth/rbac-hook.js')
  const { registerCommandIdempotency } = await import('../lib/command-idempotency.js')
  const { default: routes } = await import('./advertising-brain.routes.js')
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    const r = request as unknown as Record<string, unknown>
    r.__sessionLoaded = true
    r.authUser = { id: userId, email: 'rita@example.test', displayName: 'Rita Brain' }
    r.__rbacResolved = { isOwner: false, permissions }
    r.workspace = business(A)
    withWorkspace(business(A), done)
  })
  app.addHook('preHandler', rbacHook)
  registerCommandIdempotency(app)
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 180_000)

beforeEach(() => { __stepUpTest.reset(); permissions = new Set(OWNER) })

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 30_000)

const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api/advertising/automation/brain${url}`, payload, headers })
const approval = (id: string) => inA(() => database.client.agentApproval.findUniqueOrThrow({ where: { id }, include: { agentRun: { select: { via: true } } } }))
const killRows = (key: string) => inA(() => database.client.adsBrainOverride.findMany({ where: { scope: 'KILL', key, productId: P }, orderBy: { createdAt: 'asc' } }))

describe('A5 — the brain\'s writes ask the gate as the person on the page', () => {
  it('POST /control: 202, one pending request via the page, the tool\'s own arguments only (approve and code never stored)', async () => {
    const res = await post('/control', { op: 'enroll', productId: Q, market: 'IT', why: 'a made-up start', code: '123456', approve: false, extra: 'dropped' })
    expect(res.statusCode, res.body).toBe(202)
    const body = res.json()
    expect(body).toMatchObject({ tool: 'set-ads-brain', status: 'pending', needsCode: false, preview: { op: 'enroll' } })
    const row = await approval(body.approvalId)
    expect(row).toMatchObject({ toolName: 'set-ads-brain', status: 'pending', agentRun: { via: 'app' } })
    expect(row.args).toEqual({ op: 'enroll', productId: Q, market: 'IT', why: 'a made-up start' })
  })

  it('a lever to AUTO: approve without the code is refused and the request waits; with it, scheduled; committed, it runs as the person', async () => {
    const noCode = (await post('/control', { op: 'set-level', productId: P, market: 'IT', lever: 'state', level: 'AUTO', why: 'a made-up raise', approve: true })).json()
    expect(noCode).toMatchObject({ status: 'pending', needsCode: true, stepUp: { raises: ['Brain level'] }, approve: { ok: false, code: 'mfa_required' } })
    expect((await approval(noCode.approvalId)).status).toBe('pending')
    expect(JSON.stringify((await approval(noCode.approvalId)).args)).not.toMatch(/approve|code/)
    // The same request, decided on the brain page with the code.
    const decided = await post(`/requests/${noCode.approvalId}/decide`, { decision: 'approve', code: generateSync({ secret }) })
    expect(decided.statusCode, decided.body).toBe(200)
    expect(decided.json()).toMatchObject({ approvalId: noCode.approvalId, ok: true, status: 'scheduled', executeAfter: expect.any(String) })
    // The undo window ends; the commit runs it as the person who approved.
    await inA(() => database.client.agentApproval.update({ where: { id: noCode.approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    const { commitScheduledApproval } = await import('../services/agent-fleet/approval-inbox.service.js')
    expect(await inA(() => commitScheduledApproval(noCode.approvalId))).toMatchObject({ ok: true })
    const level = await inA(() => database.client.adsBrainOverride.findFirstOrThrow({ where: { productId: P, kind: 'LEVEL', key: 'state', endedAt: null } }))
    expect(level).toMatchObject({ value: 'AUTO', by: `user:${userId}` })
  })

  it('kill: op kill runs at once on the click, recorded and undoable; op end waits for approval and the code', async () => {
    const res = await post('/kill', { op: 'kill', lever: 'budgets', productId: P, market: 'IT', why: 'a made-up stop' })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ tool: 'set-brain-kill-switch', status: 'executed', result: { op: 'kill', lever: 'budgets', by: `user:${userId}` } })
    expect(await killRows('budgets')).toMatchObject([{ by: `user:${userId}`, reason: 'a made-up stop', endedAt: null }])
    expect((await approval(body.approvalId)).status).toBe('executed')
    const change = await inA(() => database.client.agentChange.findFirst({ where: { approvalId: body.approvalId } }))
    expect(change).toBeTruthy()
    const end = (await post('/kill', { op: 'end', lever: 'budgets', productId: P, market: 'IT', why: 'a made-up restart', approve: true })).json()
    expect(end).toMatchObject({ status: 'pending', needsCode: true, approve: { ok: false, code: 'mfa_required' } })
    expect((await killRows('budgets'))[0].endedAt).toBeNull()
    // It is on the brain's list of requests, asked by a person, needing the code.
    const listed = (await app.inject({ method: 'GET', url: '/api/advertising/automation/brain/requests?market=IT' })).json()
    expect(listed.requests).toEqual(expect.arrayContaining([expect.objectContaining({ approvalId: end.approvalId, tool: 'set-brain-kill-switch', askedBy: 'person', needsCode: true, status: 'pending', productId: P, market: 'IT', lever: 'budgets' })]))
    // Rejected on the brain page: gone from the list, and a second decision is 404.
    expect((await post(`/requests/${end.approvalId}/decide`, { decision: 'reject' })).json()).toMatchObject({ ok: true, status: 'rejected' })
    expect((await post(`/requests/${end.approvalId}/decide`, { decision: 'reject' })).statusCode).toBe(404)
  })

  it('refusals: 403 without ads.automation.manage (the manifest) or ai.run (the gate); 400 wrong arguments; a request not the brain\'s is 404', async () => {
    permissions = new Set([FEATURES.adsView, FEATURES.aiRun])
    expect((await post('/kill', { op: 'kill', lever: 'state', productId: P, market: 'IT', why: 'x stop' })).statusCode).toBe(403)
    permissions = new Set(OWNER.filter((p) => p !== FEATURES.aiRun))
    const noAi = await post('/kill', { op: 'kill', lever: 'state', productId: P, market: 'IT', why: 'x stop' })
    expect(noAi.statusCode).toBe(403)
    expect(noAi.json().error).toMatch(/ai\.run/)
    permissions = new Set(OWNER)
    expect((await post('/kill', { op: 'explode', lever: 'state' })).statusCode).toBe(400)
    expect((await post('/control', { op: 'set-level', productId: P, market: 'IT', lever: 'state', level: 'BOGUS' })).statusCode).toBe(400)
    const run = await inA(() => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual' } }))
    const other = await inA(() => database.client.agentApproval.create({ data: { agentRunId: run.id, toolName: 'set-price', riskTier: 'medium', args: {}, status: 'pending', expiresAt: new Date(Date.now() + 3_600_000) } }))
    expect((await post(`/requests/${other.id}/decide`, { decision: 'approve' })).statusCode).toBe(404)
    expect((await post('/requests/no-such-request/decide', { decision: 'reject' })).statusCode).toBe(404)
    expect((await post(`/requests/${other.id}/decide`, { decision: 'maybe' })).statusCode).toBe(400)
    expect((await approval(other.id)).status).toBe('pending')
  })

  it('the same Idempotency-Key twice asks once', async () => {
    const payload = { op: 'kill', lever: 'negatives', productId: P, market: 'IT', why: 'a made-up double click' }
    const first = await post('/kill', payload, { 'idempotency-key': 'a5-kill-once' })
    const again = await post('/kill', payload, { 'idempotency-key': 'a5-kill-once' })
    expect(first.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect(await killRows('negatives')).toHaveLength(1)
  })
})

describe('A5 — GET /requests: what the brain itself asked for', () => {
  it('a lever log\'s request and a structure build are listed as asked by the brain, with their lever; expired ones are not; decided through the brain page', async () => {
    const ids = await inA(async () => {
      const c = database.client
      const run = await c.agentRun.create({ data: { agentKey: 'ads-brain', trigger: 'schedule' } })
      const ask = (toolName: string, expiresAt: Date) => c.agentApproval.create({ data: { agentRunId: run.id, toolName, riskTier: 'medium', args: {}, preview: { summary: 'a made-up ask' }, status: 'pending', expiresAt } })
      const state = await ask('pause-ads', new Date(Date.now() + 3_600_000))
      const old = await ask('pause-ads', new Date(Date.now() - 60_000))
      const build = await ask('create-ad-campaign', new Date(Date.now() + 3_600_000))
      for (const [campaignId, approvalId] of [['a5-c1', state.id], ['a5-c2', old.id]]) {
        await c.adsBrainStateDecision.create({ data: { runId: 'a5', mode: 'PROPOSE', kind: 'change', productId: P, marketplace: 'IT', campaignId, level: 'PROPOSE', action: 'pause', outcome: 'asked', cause: 'stock', status: 'ENABLED', approvalId, decisionHash: `h-${campaignId}`, why: 'made-up', decision: {} } })
      }
      const at = new Date()
      await c.adsBrainStructure.create({ data: { productId: P, marketplace: 'IT', kind: 'SKC', key: 'a5-skc', status: 'ASKED', level: 'PROPOSE', plan: {}, evidence: {}, why: 'made-up', digest: 'a5', runId: 'a5', decidedAt: at, checkedAt: at, changedAt: at, approvalId: build.id } })
      return { state: state.id, old: old.id, build: build.id }
    })
    const listed = (await app.inject({ method: 'GET', url: `/api/advertising/automation/brain/requests?market=IT&productId=${P}` })).json()
    const byId = Object.fromEntries(listed.requests.map((r: { approvalId: string }) => [r.approvalId, r]))
    expect(byId[ids.state]).toMatchObject({ askedBy: 'brain', lever: 'state', tool: 'pause-ads', status: 'pending', productId: P, market: 'IT', summary: 'a made-up ask' })
    expect(byId[ids.build]).toMatchObject({ askedBy: 'brain', lever: 'structure' })
    expect(byId[ids.old]).toBeUndefined()
    // Rejected through the brain page: it is the brain's, so the decide route takes it.
    expect((await post(`/requests/${ids.state}/decide`, { decision: 'reject', reason: 'not now' })).json()).toMatchObject({ ok: true, status: 'rejected' })
    expect((await app.inject({ method: 'GET', url: '/api/advertising/automation/brain/requests?productId=no-such-product' })).statusCode).toBe(404)
  })

  it('the brain door (lane B1): a request it schedules reads as running alone at its time', async () => {
    const { brainDoorRow } = await import('../services/advertising/brain/requests-read.js')
    expect(brainDoorRow('2026-10-12T05:30:00.000Z')).toEqual({ runsAloneAt: '2026-10-12T05:30:00.000Z', words: 'runs alone at 2026-10-12 05:30 UTC unless a person stops it' })
    expect(brainDoorRow(null).runsAloneAt).toBeNull()
  })
})
