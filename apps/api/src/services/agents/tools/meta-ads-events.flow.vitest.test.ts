/**
 * Meta step 33 re-review N1 — through the REAL approval flow (PGlite, production schema; Meta's reads and the sender are
 * stand-ins): Claude asks twice for the same sale, a person approves both, the first run throws AFTER its request left
 * (a worker dying mid-run). Its approval goes back to pending with no decision on it, so the approval row says nothing
 * any more — but the run's send log, written before the request, does: a new request's preview and the second approved
 * run are both refused, and nothing is sent again. Made-up ids and buyer.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
const h = vi.hoisted(() => ({ sent: 0 }))
vi.mock('../../marketing/meta-ads/change-account.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/change-account.js')>()),
  metaChangeAccount: vi.fn(async () => ({ target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' })),
}))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', businessId: '900000000000001' })),
}))
vi.mock('../../marketing/meta-ads/live-audiences.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-audiences.js')>()),
  ownPixel: vi.fn(async () => '120000000000050'),
}))
vi.mock('../../marketing/meta-ads/read-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/read-client.js')>()),
  metaReadOne: vi.fn(async () => ({ body: { id: '120000000000050', is_consolidated_container: true } })),
}))
// The first request leaves, then the run dies (an error after the send).
vi.mock('../../marketing/meta-ads/events-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/events-client.js')>()),
  metaSendEvents: vi.fn(async () => { h.sent += 1; throw new Error('the worker stopped right after the request left') }),
}))

import type { UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { asker: '', approver: '' }
const principal = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
type Row = Record<string, any>
const ARGS = { orderIds: ['M-1001'], manualAs: 'phone_call' }

const ask = () => inside(async () => {
  const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
  return runOrQueueTool('upload-meta-events', ARGS, principal(people.asker, 'claude'), run.id, { forceAsk: true })
}) as Promise<Row>
async function askApprove(): Promise<string> {
  const asked = await ask()
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: principal(people.approver, 'app') })) as Row
  expect(parked, JSON.stringify(parked)).toMatchObject({ ok: true, status: 'scheduled' })
  return asked.approvalId
}
async function commit(approvalId: string): Promise<Row> {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Row>
}

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver' } })).id
  const role = await c.role.create({ data: { key: `CAPI_${randomUUID().slice(0, 8)}`, name: 'Sales approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    // A person switched "Send sales to Meta" on for this business.
    await c.accountSettings.upsert({ where: { workspaceId: LEGACY_WORKSPACE_ID }, create: { workspaceId: LEGACY_WORKSPACE_ID, metaConversionsApiOnAt: new Date(), metaConversionsApiOnBy: 'Test Owner' }, update: { metaConversionsApiOnAt: new Date(), metaConversionsApiOnBy: 'Test Owner' } })
    // A sale taken in by hand in Nexus, yesterday.
    await c.order.create({ data: {
      channel: 'MANUAL', channelOrderId: 'M-1001', status: 'DELIVERED', totalPrice: 49.9, currencyCode: 'EUR', customerName: 'Buyer A',
      customerEmail: 'buyer.a@example.test', shippingAddress: { city: 'Roma', country: 'IT', phone: '+39 333 123 4567' },
      purchaseDate: new Date(Date.now() - 86_400_000),
    } })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 60_000)

describe('a run that throws after sending', () => {
  it('blocks a second approval\'s run and a new request\'s preview: nothing is sent again', async () => {
    const first = await askApprove()
    const second = await askApprove()
    const failed = await commit(first)
    expect(failed.ok, JSON.stringify(failed)).toBe(false)
    expect(h.sent).toBe(1)
    // The approval row no longer says it ran (back to pending, no decision on it) — the send log does.
    const row = await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: first } })) as Row
    expect(row.status).toBe('pending')
    const logs = await inside(() => db().auditLog.findMany({ where: { entityType: 'MetaConversionsApi' } })) as Row[]
    expect(logs.map((l) => l.action)).toEqual(['send'])
    expect(JSON.stringify(logs)).not.toMatch(/buyer\.a@example\.test|393331234567|[a-f0-9]{64}/)

    // Moments later it may still be running: a new request is told to ask again in minutes.
    const soon = await ask()
    expect(soon.ok, JSON.stringify(soon)).toBe(false)
    expect(JSON.stringify(soon)).toMatch(/Not queued: another upload of 1 sale to pixel 120000000000050 started at .* may be running now/)
    // Past the time a run takes, it is a run that may have reached Meta unrecorded: blocked for 9 days.
    await inside(() => db().auditLog.updateMany({ where: { entityType: 'MetaConversionsApi' }, data: { createdAt: new Date(Date.now() - 3600_000) } }))
    const ran = await commit(second)
    expect(ran.ok, JSON.stringify(ran)).toBe(false)
    expect(JSON.stringify(ran)).toMatch(/left no record/)
    const asked = await ask()
    expect(asked.ok, JSON.stringify(asked)).toBe(false)
    expect(JSON.stringify(asked)).toMatch(/Not queued: an upload of 1 sale to pixel 120000000000050 began at .* left no record/)
    expect(h.sent).toBe(1)
  }, 120_000)
})
