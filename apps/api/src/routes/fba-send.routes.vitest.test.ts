/**
 * Step 4 Send to FBA (Part C) — the routes the Matrix dialog, the FBA plans drawer and the FBA shipments page call, and the
 * retired doors.
 *
 *   routes      each route parses, calls its service through the contract with the signed-in person as the actor, and
 *               answers the service's shape; a thrown FbaSendError answers its status with { ok: false, code, error,
 *               problems }; "Add to draft" answers 200 { planId }, "Send to Amazon" 202 { planId } (drafts, Owner 2026-10-08).
 *   double      every POST is in COMMAND_SCOPES: the same Idempotency-Key twice runs the service once and replays the answer.
 *   permission  the real RBAC gate (enforce): `inbound.manage` may, `inventory.view` alone may not.
 *   410         the wizard's step routes (POST /api/fba/inbound/v2 …) and the v0 plan / create routes answer 410 Gone with
 *               the sentence the web shows; the wizard's two reads still answer.
 *
 * Real SQL (PGlite: the command receipts), the real route plugins, hooks and contract; the services are spies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import { FBA_SEND_COPY } from '@nexus/shared/fba-send'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn(async () => undefined) }))
// The services behind the contract are spies (their own suites hold their rules); the contract itself is real.
vi.mock('../services/fba-inbound/send.service.js', () => ({
  readSendDraft: vi.fn(), createSendPlan: vi.fn(), confirmChoice: vi.fn(), cancelPlan: vi.fn(), retryPlan: vi.fn(),
}))
vi.mock('../services/fba-inbound/draft.service.js', () => ({ addToDraft: vi.fn(), updateDraft: vi.fn(), deleteDraft: vi.fn(), sendDraft: vi.fn() }))
vi.mock('../services/fba-inbound/ship.service.js', () => ({ markShipped: vi.fn(), labelsFor: vi.fn() }))
vi.mock('../services/fba-inbound/read.service.js', () => ({
  readPlans: vi.fn(), readPlan: vi.fn(), readPlanList: vi.fn(),
  wizardPlanRows: vi.fn(async () => [{ id: 'wiz-1', status: 'ACTIVE' }]), wizardPlanRow: vi.fn(async (id: string) => (id === 'wiz-1' ? { id, status: 'ACTIVE' } : null)),
}))

import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { COMMAND_SCOPE_ROUTES, registerCommandIdempotency } from '../lib/command-idempotency.js'
import {
  addToDraft, cancelPlan, confirmChoice, createSendPlan, deleteDraft, FbaSendError, labelsFor, markShipped, readPlan, readPlanList, readSendDraft,
  retryPlan, sendDraft, updateDraft,
} from '../services/fba-inbound/contract.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const MANAGER = [F.inboundManage].join(',')
const VIEWER = [F.inventoryView].join(',')
const VIEW = { id: 'plan-1', status: 'WAITING_FOR_CHOICE' }
const WHO = { actor: 'fba@example.test', userId: 'u-fba' }
let app: FastifyInstance

type Json = any
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, payload: payload as never, headers: { 'x-test-permissions': MANAGER, ...headers } })
  return { status: response.statusCode, body: response.body ? response.json() : null }
}

beforeAll(async () => {
  database = await formulaDatabase()
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    const named = request.headers['x-test-permissions']
    request.__sessionLoaded = true
    request.authUser = { id: 'u-fba', email: 'fba@example.test' } as never
    request.__rbacResolved = { isOwner: false, permissions: new Set(typeof named === 'string' ? named.split(',') : []) } as never
    withWorkspace(business, done)
  })
  app.addHook('preHandler', rbacHook)
  registerCommandIdempotency(app)
  await app.register((await import('./fba-send.routes.js')).default, { prefix: '/api' })
  await app.register((await import('./fba-inbound-v2.routes.js')).default, { prefix: '/api' })
  await app.register((await import('./fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

beforeEach(() => { vi.stubEnv('NEXUS_RBAC_MODE', 'enforce'); vi.clearAllMocks() })
afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
})

describe('/api/fba/inbound — Send to FBA', () => {
  it('GET send-draft: the ids (comma list), From and market reach readSendDraft; no ids → 400; a refusal answers its status', async () => {
    vi.mocked(readSendDraft).mockResolvedValueOnce({ market: 'IT' } as never)
    expect(await call('GET', '/api/fba/inbound/send-draft?productIds=a,b&from=TEST-MAIN&market=it')).toEqual({ status: 200, body: { market: 'IT' } })
    expect(readSendDraft).toHaveBeenCalledWith({ productIds: ['a', 'b'], planId: null, from: 'TEST-MAIN', market: 'it' })
    expect((await call('GET', '/api/fba/inbound/send-draft')).status).toBe(400)
    vi.mocked(readSendDraft).mockResolvedValueOnce({ draftId: 'draft-1' } as never)
    expect((await call('GET', '/api/fba/inbound/send-draft?planId=draft-1')).body).toEqual({ draftId: 'draft-1' })
    expect(readSendDraft).toHaveBeenLastCalledWith({ productIds: [], planId: 'draft-1', from: null, market: null })
    vi.mocked(readSendDraft).mockRejectedValueOnce(new FbaSendError('NOT_FOUND', 'Product not found'))
    expect(await call('GET', '/api/fba/inbound/send-draft?productIds=x')).toEqual({ status: 404, body: { ok: false, code: 'NOT_FOUND', error: 'Product not found', problems: [] } })
  })

  it('POST drafts ("Add to draft"): 200 { planId } as the signed-in person, source matrix; one Idempotency-Key runs once; the old POST plans is gone', async () => {
    const body = { from: 'TEST-MAIN', market: 'IT', lines: [{ productId: 'a', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 2 }] }
    vi.mocked(addToDraft).mockResolvedValue({ planId: 'draft-1' })
    const first = await call('POST', '/api/fba/inbound/drafts', body, { 'idempotency-key': 'add-once' })
    expect(first).toEqual({ status: 200, body: { planId: 'draft-1' } })
    expect(addToDraft).toHaveBeenCalledWith(body, WHO, 'matrix')
    expect(await call('POST', '/api/fba/inbound/drafts', body, { 'idempotency-key': 'add-once' })).toEqual(first)
    expect(addToDraft).toHaveBeenCalledTimes(1)
    vi.mocked(addToDraft).mockRejectedValueOnce(new FbaSendError('REFUSED', 'Choose one of your active warehouses as From'))
    expect((await call('POST', '/api/fba/inbound/drafts', body, { 'idempotency-key': 'add-refused' })).status).toBe(400)
    expect((await call('POST', '/api/fba/inbound/plans', body)).status).toBe(404)
    expect(createSendPlan).not.toHaveBeenCalled()
  })

  it('PATCH / DELETE a draft and "Send to Amazon" (202, one Idempotency-Key runs once); DRAFT_EXISTS and WRONG_STATE are 409', async () => {
    const patch = { readyToShipOn: '2026-10-09', lines: [{ productId: 'a', cases: [], looseUnits: 0 }] }
    vi.mocked(updateDraft).mockResolvedValueOnce({ id: 'draft-1', status: 'DRAFT' } as never)
    expect(await call('PATCH', '/api/fba/inbound/plans/draft-1', patch)).toEqual({ status: 200, body: { id: 'draft-1', status: 'DRAFT' } })
    expect(updateDraft).toHaveBeenCalledWith('draft-1', patch, WHO)
    vi.mocked(updateDraft).mockRejectedValueOnce(new FbaSendError('DRAFT_EXISTS', FBA_SEND_COPY.draftExists('TEST-MAIN', 'DE')))
    expect(await call('PATCH', '/api/fba/inbound/plans/draft-1', { market: 'DE' })).toEqual({ status: 409, body: { ok: false, code: 'DRAFT_EXISTS', error: FBA_SEND_COPY.draftExists('TEST-MAIN', 'DE'), problems: [] } })
    vi.mocked(deleteDraft).mockResolvedValueOnce({ planId: 'draft-1', deleted: true })
    expect(await call('DELETE', '/api/fba/inbound/plans/draft-1')).toEqual({ status: 200, body: { planId: 'draft-1', deleted: true } })
    expect(deleteDraft).toHaveBeenCalledWith('draft-1', WHO)
    vi.mocked(deleteDraft).mockRejectedValueOnce(new FbaSendError('WRONG_STATE', 'only a draft can be deleted'))
    expect((await call('DELETE', '/api/fba/inbound/plans/plan-1')).status).toBe(409)
    vi.mocked(sendDraft).mockResolvedValue({ planId: 'draft-1' })
    const sent = await call('POST', '/api/fba/inbound/plans/draft-1/send', { readyToShipOn: '2026-10-09' }, { 'idempotency-key': 'send-once' })
    expect(sent).toEqual({ status: 202, body: { planId: 'draft-1' } })
    expect(await call('POST', '/api/fba/inbound/plans/draft-1/send', { readyToShipOn: '2026-10-09' }, { 'idempotency-key': 'send-once' })).toEqual(sent)
    expect(sendDraft).toHaveBeenCalledTimes(1)
    expect(sendDraft).toHaveBeenCalledWith('draft-1', { readyToShipOn: '2026-10-09' }, WHO)
  })

  it('GET plans: the tab, family, open, cursor and limit reach readPlanList; an unknown tab is 400; one plan; a missing plan is 404', async () => {
    const list = { plans: [VIEW], next: null, counts: { drafts: 1, active: 1, done: 0 } }
    vi.mocked(readPlanList).mockResolvedValueOnce(list as never)
    expect(await call('GET', '/api/fba/inbound/plans?productId=fam-1&open=1')).toEqual({ status: 200, body: list })
    expect(readPlanList).toHaveBeenCalledWith({ productId: 'fam-1', open: true, view: null, cursor: null, limit: null })
    vi.mocked(readPlanList).mockResolvedValueOnce(list as never)
    await call('GET', '/api/fba/inbound/plans?view=drafts&cursor=abc&limit=10')
    expect(readPlanList).toHaveBeenLastCalledWith({ productId: null, open: false, view: 'drafts', cursor: 'abc', limit: 10 })
    expect((await call('GET', '/api/fba/inbound/plans?view=later')).status).toBe(400)
    vi.mocked(readPlan).mockResolvedValueOnce(VIEW as never)
    expect(await call('GET', '/api/fba/inbound/plans/plan-1')).toEqual({ status: 200, body: VIEW })
    vi.mocked(readPlan).mockResolvedValueOnce(null)
    expect((await call('GET', '/api/fba/inbound/plans/nope')).body).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('choice / cancel / retry: the person reaches the service; WRONG_STATE 409, OPTION_UNKNOWN 400, OPTIONS_EXPIRED 409', async () => {
    const choice = { placementOptionId: 'po-1', shipments: [{ shipmentId: 'sh-1', transportationOptionId: 'to-1', deliveryWindowOptionId: 'dw-1' }] }
    vi.mocked(confirmChoice).mockResolvedValueOnce({ ...VIEW, status: 'CONFIRMING' } as never)
    expect(await call('POST', '/api/fba/inbound/plans/plan-1/choice', choice, { 'idempotency-key': 'choice-1' })).toEqual({ status: 200, body: { ...VIEW, status: 'CONFIRMING' } })
    expect(confirmChoice).toHaveBeenCalledWith('plan-1', choice, WHO)
    vi.mocked(confirmChoice).mockRejectedValueOnce(new FbaSendError('OPTION_UNKNOWN', 'not offered'))
    expect((await call('POST', '/api/fba/inbound/plans/plan-1/choice', choice)).status).toBe(400)
    vi.mocked(confirmChoice).mockRejectedValueOnce(new FbaSendError('OPTIONS_EXPIRED', FBA_SEND_COPY.optionsExpired))
    expect((await call('POST', '/api/fba/inbound/plans/plan-1/choice', choice)).status).toBe(409)
    vi.mocked(cancelPlan).mockResolvedValueOnce({ ...VIEW, status: 'CANCELLING' } as never)
    expect((await call('POST', '/api/fba/inbound/plans/plan-1/cancel', {})).body).toMatchObject({ status: 'CANCELLING' })
    expect(cancelPlan).toHaveBeenCalledWith('plan-1', WHO)
    vi.mocked(retryPlan).mockRejectedValueOnce(new FbaSendError('WRONG_STATE', 'nothing to try again'))
    expect(await call('POST', '/api/fba/inbound/plans/plan-1/retry', {})).toEqual({ status: 409, body: { ok: false, code: 'WRONG_STATE', error: 'nothing to try again', problems: [] } })
    expect(retryPlan).toHaveBeenCalledWith('plan-1', WHO)
  })

  it('shipments: labels answer a fresh link (409 when unavailable); shipped passes the tracking and the person', async () => {
    vi.mocked(labelsFor).mockResolvedValueOnce({ downloadUrl: 'https://labels.example.test/a.pdf' })
    expect(await call('GET', '/api/fba/inbound/shipments/s-1/labels')).toEqual({ status: 200, body: { downloadUrl: 'https://labels.example.test/a.pdf' } })
    vi.mocked(labelsFor).mockRejectedValueOnce(new FbaSendError('LABELS_UNAVAILABLE', 'no boxes yet'))
    expect((await call('GET', '/api/fba/inbound/shipments/s-1/labels')).status).toBe(409)
    const tracking = { tracking: [{ boxId: 'FBA15X1U000001', trackingId: 'TRK-1' }] }
    vi.mocked(markShipped).mockResolvedValue({ ...VIEW, status: 'SHIPPED' } as never)
    expect((await call('POST', '/api/fba/inbound/shipments/s-1/shipped', tracking, { 'idempotency-key': 'ship-1' })).body).toMatchObject({ status: 'SHIPPED' })
    expect((await call('POST', '/api/fba/inbound/shipments/s-1/shipped', tracking, { 'idempotency-key': 'ship-1' })).body).toMatchObject({ status: 'SHIPPED' })
    expect(markShipped).toHaveBeenCalledTimes(1)
    expect(markShipped).toHaveBeenCalledWith('s-1', tracking, WHO)
    vi.mocked(markShipped).mockRejectedValueOnce(new FbaSendError('TRACKING_INVALID', 'Every box needs a tracking number'))
    expect((await call('POST', '/api/fba/inbound/shipments/s-1/shipped', { tracking: [] })).status).toBe(400)
  })

  it('every POST is a durable command; the routes need inbound.manage (inventory.view alone is refused)', async () => {
    for (const route of ['/api/fba/inbound/drafts', '/api/fba/inbound/plans/:id/send', '/api/fba/inbound/plans/:id/choice', '/api/fba/inbound/plans/:id/cancel', '/api/fba/inbound/plans/:id/retry', '/api/fba/inbound/shipments/:id/shipped']) {
      expect(COMMAND_SCOPE_ROUTES).toContain(route)
      expect(permissionForRoute('POST', route)).toBe('inbound.manage')
    }
    expect(COMMAND_SCOPE_ROUTES).not.toContain('/api/fba/inbound/plans')
    expect(permissionForRoute('GET', '/api/fba/inbound/send-draft')).toBe('inbound.manage')
    expect(permissionForRoute('PATCH', '/api/fba/inbound/plans/:id')).toBe('inbound.manage')
    expect(permissionForRoute('DELETE', '/api/fba/inbound/plans/:id')).toBe('inbound.manage')
    expect((await call('GET', '/api/fba/inbound/plans', undefined, { 'x-test-permissions': VIEWER })).status).toBe(403)
    expect((await call('POST', '/api/fba/inbound/drafts', {}, { 'x-test-permissions': VIEWER })).status).toBe(403)
    expect((await call('DELETE', '/api/fba/inbound/plans/draft-1', undefined, { 'x-test-permissions': VIEWER })).status).toBe(403)
    expect(readPlanList).not.toHaveBeenCalled()
    expect(addToDraft).not.toHaveBeenCalled()
    expect(deleteDraft).not.toHaveBeenCalled()
  })
})

describe('the retired doors answer 410 Gone with the sentence the web shows', () => {
  it('the wizard\'s step routes and the v0 plan / create routes; the wizard\'s two reads still answer', async () => {
    const gone = { error: 'gone', message: FBA_SEND_COPY.movedToMatrix, replacement: '/api/fba/inbound/plans' }
    for (const [method, url] of [
      ['POST', '/api/fba/inbound/v2'], ['GET', '/api/fba/inbound/v2/wiz-1/packing-options'], ['POST', '/api/fba/inbound/v2/wiz-1/packing-options/p1/confirm'],
      ['GET', '/api/fba/inbound/v2/wiz-1/placement-options'], ['POST', '/api/fba/inbound/v2/wiz-1/placement-options/p1/confirm'],
      ['GET', '/api/fba/inbound/v2/wiz-1/shipments/sh-1/transport-options'], ['POST', '/api/fba/inbound/v2/wiz-1/transport-options/confirm'],
      ['GET', '/api/fba/inbound/v2/wiz-1/labels'], ['POST', '/api/fulfillment/fba/plan-shipment'], ['POST', '/api/fulfillment/fba/create-shipment'],
    ] as const) {
      expect(await call(method, url, method === 'POST' ? {} : undefined), `${method} ${url}`).toEqual({ status: 410, body: gone })
    }
    expect(await call('GET', '/api/fba/inbound/v2')).toEqual({ status: 200, body: { plans: [{ id: 'wiz-1', status: 'ACTIVE' }], count: 1 } })
    expect(await call('GET', '/api/fba/inbound/v2/wiz-1')).toEqual({ status: 200, body: { plan: { id: 'wiz-1', status: 'ACTIVE' } } })
    expect((await call('GET', '/api/fba/inbound/v2/nope')).status).toBe(404)
  })
})
