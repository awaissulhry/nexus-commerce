/**
 * An approved create-variations runs when its family did not change (2026-10-15, MISANO: approved twice, refused twice as
 * "the facts moved since you approved it"). PGlite, production schema; the job queue a stub; made-up names and ids.
 *
 *   key order   the preview token hashed the request's `axisValues` as they were sent. An approval keeps its args as jsonb,
 *               and jsonb re-orders object keys (`{"Color","Size"}` comes back `{"Size","Color"}`), so the re-check and the
 *               run computed another token from the same family and the same plan. The token is canonical now.
 *   stock       a sale between the approval and the run writes `totalStock` (no version): the plan does not stand on it.
 *   real change a member added, or a member's SKU renamed, after the approval still refuses the run.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
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
vi.mock('../outbound-enqueue.js', async (original) => ({ ...(await original<object>()), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))

import type { UserPrincipal } from './call-tool.js'
import { runOrQueueTool } from './approval-gate.service.js'
import { commitScheduledApproval, decideFleetApproval } from '../agent-fleet/approval-inbox.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { asker: '', approver: '' }
const principal = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
type Row = Record<string, any>

/** Claude asks and a person approves it in Nexus; the undo window is still open. */
async function askApprove(args: Record<string, unknown>): Promise<{ approvalId: string; preview: Row }> {
  const asked = await inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    return runOrQueueTool('create-variations', args, principal(people.asker, 'claude'), run.id, { forceAsk: true })
  }) as Row
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: principal(people.approver, 'app') })) as Row
  expect(parked, JSON.stringify(parked)).toMatchObject({ ok: true, status: 'scheduled' })
  return { approvalId: asked.approvalId, preview: asked.preview }
}
/** The undo window closes and the commit takes it (re-checked, then run as the approver). */
async function commit(approvalId: string): Promise<Row> {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Row>
}
const stored = (approvalId: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: approvalId } })) as Promise<Row>
const members = (parentId: string) => inside(() => db().product.findMany({ where: { parentId, deletedAt: null }, orderBy: { sku: 'asc' } })) as Promise<Row[]>

/** A jacket family of its own per test: Color × Size, two sizes of one colour (the MISANO shape). */
async function jacket(tag: string) {
  return inside(async () => {
    const parent = await db().product.create({ data: { sku: `TEST-SKU-CV-${tag}`, name: `CV jacket ${tag}`, basePrice: 199, isParent: true, variationAxes: ['Color', 'Size'] } })
    const child = (size: string) => db().product.create({ data: { sku: `TEST-SKU-CV-${tag}-${size}-BROWN`, name: `CV jacket ${tag} ${size}`, basePrice: 199, totalStock: 5,
      parentId: parent.id, categoryAttributes: { variations: { Color: 'Marrone', Size: size } } } })
    const first = await child('44')
    await child('46')
    return { parent: parent.id as string, first: first.id as string }
  })
}
/** The request as Claude sends it: `Color` before `Size` — jsonb keeps `Size` first. */
const plan = (j: { parent: string }, tag: string) => ({ productId: j.parent, axisValues: { Color: ['Marrone'], Size: ['56', '58'] },
  skuPattern: `TEST-SKU-CV-${tag}-{Size.code}-BROWN`, valueCodes: { Size: { 56: '3XL', 58: '4XL' } } })

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver' } })).id
  const role = await c.role.create({ data: { key: `CV_${randomUUID().slice(0, 8)}`, name: 'Catalogue approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
}, 180_000)
afterAll(async () => { await database?.close() }, 60_000)

describe('an approved create-variations runs when its family did not change', { timeout: 60_000 }, () => {
  it('the stored args come back in another key order (jsonb), and the approved plan still runs', async () => {
    const j = await jacket('KEYS')
    const { approvalId } = await askApprove(plan(j, 'KEYS'))
    // The positive control of the cause: the approval keeps its args with the keys re-ordered.
    expect(Object.keys((await stored(approvalId)).args.axisValues)).toEqual(['Size', 'Color'])
    const done = await commit(approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect((await members(j.parent)).map((m) => m.sku)).toEqual([
      'TEST-SKU-CV-KEYS-3XL-BROWN', 'TEST-SKU-CV-KEYS-44-BROWN', 'TEST-SKU-CV-KEYS-46-BROWN', 'TEST-SKU-CV-KEYS-4XL-BROWN'])
  })

  it('a sale between the approval and the run (totalStock, no version) moves nothing', async () => {
    const j = await jacket('SALE')
    const { approvalId } = await askApprove(plan(j, 'SALE'))
    await inside(() => db().product.update({ where: { id: j.first }, data: { totalStock: { decrement: 1 } } }))
    const done = await commit(approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect(await members(j.parent)).toHaveLength(4)
  })

  it('a member added after the approval refuses the run', async () => {
    const j = await jacket('ADD')
    const { approvalId } = await askApprove(plan(j, 'ADD'))
    await inside(() => db().product.create({ data: { sku: 'TEST-SKU-CV-ADD-48-BROWN', name: 'CV jacket ADD 48', basePrice: 199, parentId: j.parent,
      categoryAttributes: { variations: { Color: 'Marrone', Size: '48' } } } }))
    const done = await commit(approvalId)
    expect(done.status, JSON.stringify(done)).not.toBe('executed')
    expect((await stored(approvalId)).status).not.toBe('executed')
    expect(await members(j.parent)).toHaveLength(3)
  })

  it('a member\'s SKU renamed after the approval refuses the run', async () => {
    const j = await jacket('RENAME')
    const { approvalId } = await askApprove(plan(j, 'RENAME'))
    await inside(() => db().product.update({ where: { id: j.first }, data: { sku: 'TEST-SKU-CV-RENAME-44-BRN' } }))
    const done = await commit(approvalId)
    expect(done.status, JSON.stringify(done)).not.toBe('executed')
    expect(await members(j.parent)).toHaveLength(2)
  })
})
