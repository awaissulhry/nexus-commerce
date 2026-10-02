/**
 * MCP full control C2 — what an approved change did is kept (AgentChange), and it can be undone.
 *
 * Proven through the doors a person or Claude uses (runOrQueueTool, scheduleApproval + commitScheduledApproval, as
 * the Approvals page and the sweep run them), on a real PostgreSQL with the production schema and business policies
 * (PGlite). The master price service, the product bulk writer and the queue rows are real; nothing is sent to any
 * marketplace from here.
 *
 *   recorded    an executed approval stores before → after, the door it came through, who ran it, and its undo
 *   round trip  set-price, apply-content and bulk-price-change: undo is a NEW request of the inverse tool, through
 *               the same gate; once approved it puts the old values back, and the undo is itself undoable
 *   stale       refused when what is stored is no longer what the change wrote (someone changed it since), both
 *               when the undo is asked for and when it would run
 *   one at a    a second undo while one waits is refused; an undone change cannot be undone again
 *   time
 *   limits      a change without an undo says so; the inverse needs the inverse tool's permission; another
 *               business's change is not found
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
// No Redis, and the product writer's read cache and readiness rebuild left out (as bulk.tools.vitest.test.ts does).
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { runOrQueueTool } from './approval-gate.service.js'
import type { UserPrincipal } from './call-tool.js'
import { commitScheduledApproval, scheduleApproval } from '../agent-fleet/approval-inbox.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'c2_change_record_bravo'
const DB_TEST_TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)

const EVERYTHING = new Set<string>([...Object.values(F), ...Object.values(FIELDS)])
const ids = { approver: '', price: '', content: '', bulk1: '', bulk2: '', attr: '', bravo: '' }

const person = (permissions: Set<string>, extra: Partial<UserPrincipal> = {}): UserPrincipal => ({
  kind: 'user', userId: ids.approver, label: 'Una Undo', permissions: { isOwner: false, permissions }, workspace: business(A), via: 'app', ...extra,
})
const ALL = () => person(EVERYTHING)
const CLAUDE = () => person(EVERYTHING, { via: 'claude', oauthGrantId: 'grant-c2' })
const NO_PRICE = () => person(new Set([...EVERYTHING].filter((p) => p !== F.productsPriceEdit)))

type Data = Record<string, any>
const db = () => database.client

/** Ask for a change as `who` would: one run, through the gate; a change always waits for a person. */
async function ask(who: UserPrincipal, tool: string, args: Record<string, unknown>, workspaceId = A) {
  const run = await inside(() => db().agentRun.create({
    data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: who.via, oauthGrantId: who.oauthGrantId ?? null },
  }), workspaceId)
  return inside(() => runOrQueueTool(tool, args, who, run.id, { forceAsk: true }), workspaceId)
}

/** A person approves it on the Approvals page, the undo window closes, and the sweep runs it. */
async function approveAndRun(approvalId: string) {
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: ALL() }))
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId))
}

async function askAndRun(tool: string, args: Record<string, unknown>, who = ALL()) {
  const queued = await ask(who, tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId!)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return queued.approvalId!
}

const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
const approvalOf = (id: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id } }))
const priceOf = async (id: string) => inside(async () => Number((await db().product.findUniqueOrThrow({ where: { id } })).basePrice))
const setPriceDirectly = (id: string, price: string) => inside(() => db().product.update({ where: { id }, data: { basePrice: price } }))
const pendingCount = () => inside(() => db().agentApproval.count({ where: { status: 'pending' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const client = database.client

  // The approver: the commit re-resolves them from the database (their roles with profiles off, their membership on).
  const role = await client.role.create({
    data: { key: `C2_UNDO_${randomUUID().slice(0, 8)}`, name: 'Undo tester', description: 'test', isSystem: false, permissions: [...EVERYTHING] },
  })
  const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Una Undo' } })
  ids.approver = approver.id
  await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
  await client.workspace.create({ data: { id: B, name: 'Bravo undo business', createdByUserId: approver.id, creationKey: randomUUID() } })
  for (const workspaceId of [A, B]) {
    const membership = await client.workspaceMembership.create({ data: { workspaceId, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  }

  await inside(async () => {
    await client.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'C2_AMAZON_IT' } as never })
    // No listing follows it: on PGlite's one connection the price cascade's queue write waits out its transaction.
    // What reaches the channels is the master price service's own business (its tests); here it is the record.
    ids.price = (await client.product.create({ data: { sku: 'TEST-UNDO-PRICE', name: 'Undo price jacket', basePrice: '100.00' } })).id
    ids.content = (await client.product.create({
      data: { sku: 'TEST-UNDO-CONTENT', name: 'Old title', description: null, bulletPoints: ['old one', 'old two'], basePrice: '30.00' },
    })).id
    ids.bulk1 = (await client.product.create({ data: { sku: 'TEST-UNDO-BULK-1', name: 'Bulk one', basePrice: '10.00' } })).id
    ids.bulk2 = (await client.product.create({ data: { sku: 'TEST-UNDO-BULK-2', name: 'Bulk two', basePrice: '20.00' } })).id
    ids.attr = (await client.product.create({ data: { sku: 'TEST-UNDO-ATTR', name: 'Attr jacket', basePrice: '10.00', categoryAttributes: { fit: 'regular' } } })).id
  })
  await inside(async () => {
    ids.bravo = (await client.product.create({ data: { sku: 'TEST-UNDO-PRICE', name: 'Bravo jacket', basePrice: '50.00' } })).id
  }, B)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('C2 — an executed approval keeps what it changed', { timeout: DB_TEST_TIMEOUT }, () => {
  it('set-price from Claude: before → after, the door, the connection, who ran it, and how to undo it', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 110 }, CLAUDE())
    expect(await priceOf(ids.price)).toBe(110)
    const change = await changeOf(approvalId)
    expect(change).toMatchObject({
      toolName: 'set-price',
      via: 'claude',
      oauthGrantId: 'grant-c2',
      executedByUserId: ids.approver,
      reversibility: 'full',
      before: { productId: ids.price, sku: 'TEST-UNDO-PRICE', price: 100 },
      after: { productId: ids.price, price: 110 },
      undoTool: 'set-price',
      undoArgs: { productId: ids.price, price: 100 },
      outbound: true,
      undoneAt: null,
      undoneByApprovalId: null,
      planStepId: null,
    })
    expect(change.workspaceId).toBe(A)
    await setPriceDirectly(ids.price, '100.00')
  })
})

describe('C2 — undo is a new request of the inverse tool, through the same gate', { timeout: DB_TEST_TIMEOUT }, () => {
  it('set-price: undo asks to set the old price, a person approves it, the price is back, and the undo can be undone', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 120 })
    const change = await changeOf(approvalId)

    const undo = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued', undoes: change.id })
    expect(undo.preview).toMatchObject({ action: 'set-price', changes: { 'base price': { from: 120, to: 100 } } })
    // Nothing changed yet: it waits for a person like any change.
    expect(await priceOf(ids.price)).toBe(120)
    const request = await approvalOf(undo.approvalId!)
    expect(request).toMatchObject({ toolName: 'set-price', status: 'pending', args: { productId: ids.price, price: 100 } })
    expect((await changeOf(approvalId)).undoneByApprovalId).toBe(undo.approvalId)

    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect(await priceOf(ids.price)).toBe(100)
    expect((await changeOf(approvalId)).undoneAt).toBeInstanceOf(Date)
    // The undo is a change of its own, kept the same way: it can be undone too.
    const undoChange = await changeOf(undo.approvalId!)
    expect(undoChange).toMatchObject({ toolName: 'set-price', before: { price: 120 }, after: { price: 100 }, undoneAt: null })
  })

  it('apply-content: the old title, bullets, keywords and an empty description come back', async () => {
    const approvalId = await askAndRun('apply-content', {
      productId: ids.content, title: 'New title', bulletPoints: ['new one'], description: 'A new description', keywords: ['new kw'],
    })
    const after = await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.content } }))
    expect(after).toMatchObject({ name: 'New title', bulletPoints: ['new one'], description: 'A new description', keywords: ['new kw'] })
    const change = await changeOf(approvalId)
    expect(change).toMatchObject({
      before: { productId: ids.content, title: 'Old title', bulletPoints: ['old one', 'old two'], description: null, keywords: [] },
      after: { productId: ids.content, title: 'New title', bulletPoints: ['new one'], description: 'A new description', keywords: ['new kw'] },
      outbound: false,
    })

    const undo = await ask(ALL(), 'undo-change', { approvalId })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true })
    const back = await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.content } }))
    expect(back.name).toBe('Old title')
    expect(back.bulletPoints).toEqual(['old one', 'old two'])
    expect(back.keywords).toEqual([])
    // Nexus had no description; apply-content cannot store "none", so undo stores an empty one.
    expect(back.description ?? '').toBe('')
  })

  it('bulk-price-change: every product gets its own old price back, in one request', async () => {
    const approvalId = await askAndRun('bulk-price-change', { products: [ids.bulk1, 'TEST-UNDO-BULK-2'], operation: 'percent', value: 10 })
    expect([await priceOf(ids.bulk1), await priceOf(ids.bulk2)]).toEqual([11, 22])
    const change = await changeOf(approvalId)
    expect(change).toMatchObject({
      before: { prices: { [ids.bulk1]: 10, [ids.bulk2]: 20 } },
      after: { prices: { [ids.bulk1]: 11, [ids.bulk2]: 22 } },
      undoTool: 'set-master-prices',
    })

    const undo = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(undo, undo.error).toMatchObject({ ok: true, mode: 'queued' })
    expect(undo.preview).toMatchObject({
      action: 'set-master-prices',
      changes: { 'TEST-UNDO-BULK-1 base price': { from: 11, to: 10 }, 'TEST-UNDO-BULK-2 base price': { from: 22, to: 20 } },
    })
    expect(await approveAndRun(undo.approvalId!)).toMatchObject({ ok: true, status: 'executed' })
    expect([await priceOf(ids.bulk1), await priceOf(ids.bulk2)]).toEqual([10, 20])
    expect((await changeOf(approvalId)).undoneAt).toBeInstanceOf(Date)
  })
})

describe('C2 — undo never overwrites a later change', { timeout: DB_TEST_TIMEOUT }, () => {
  it('refused when asked for, if the value moved since; nothing is queued', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 130 })
    const change = await changeOf(approvalId)
    await setPriceDirectly(ids.price, '135.00') // someone else, after the change ran
    const before = await pendingCount()
    const undo = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(undo).toMatchObject({ ok: false, mode: 'error' })
    expect(undo.error).toContain('changed since')
    expect(undo.error).toContain('135')
    expect(await pendingCount()).toBe(before)
    expect((await changeOf(approvalId)).undoneByApprovalId).toBeNull()
    expect(await priceOf(ids.price)).toBe(135)
    await setPriceDirectly(ids.price, '100.00')
  })

  it('handed back when it would run, if the value moved while it waited', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 140 })
    const change = await changeOf(approvalId)
    const undo = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(undo).toMatchObject({ ok: true, mode: 'queued' })
    await setPriceDirectly(ids.price, '145.00') // someone else, while the undo waits
    const ran = await approveAndRun(undo.approvalId!)
    expect(ran).toMatchObject({ ok: false })
    expect(ran.error).toContain('the facts moved')
    expect(await priceOf(ids.price)).toBe(145)
    expect((await approvalOf(undo.approvalId!)).status).toBe('pending')
    expect((await changeOf(approvalId)).undoneAt).toBeNull()
    await setPriceDirectly(ids.price, '100.00')
  })
})

describe('C2 — one undo at a time, and only what can be undone', { timeout: DB_TEST_TIMEOUT }, () => {
  it('a second undo while one waits is refused; an undone change is not undone twice', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 150 })
    const change = await changeOf(approvalId)
    const first = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(first).toMatchObject({ ok: true, mode: 'queued' })
    const second = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(second).toMatchObject({ ok: false })
    expect(second.error).toContain(first.approvalId!)
    await approveAndRun(first.approvalId!)
    const third = await ask(ALL(), 'undo-change', { changeId: change.id })
    expect(third).toMatchObject({ ok: false })
    expect(third.error).toContain('already undone')
  })

  it('a change of a tool without an undo says so', async () => {
    const approvalId = await askAndRun('bulk-attribute-change', { products: [ids.attr], attributes: { fit: 'slim' } })
    const undo = await ask(ALL(), 'undo-change', { approvalId })
    expect(undo).toMatchObject({ ok: false })
    expect(undo.error).toContain('cannot be undone here yet')
  })

  it('the undo needs the inverse tool’s own permission', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 160 })
    const undo = await ask(NO_PRICE(), 'undo-change', { approvalId })
    expect(undo).toMatchObject({ ok: false })
    expect(undo.error).toContain(F.productsPriceEdit)
    expect(await priceOf(ids.price)).toBe(160)
    await setPriceDirectly(ids.price, '100.00')
  })

  it('an unknown change, or none named, is refused', async () => {
    expect((await ask(ALL(), 'undo-change', { changeId: 'no-such-change' })).error).toContain('not found')
    expect((await ask(ALL(), 'undo-change', {})).error).toMatch(/changeId or approvalId/)
  })

  it('another business’s change is not found (business profiles on)', async () => {
    const approvalId = await askAndRun('set-price', { productId: ids.price, price: 170 })
    const change = await changeOf(approvalId)
    const before = process.env.NEXUS_WORKSPACES_ENABLED
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    try {
      const fromBravo = await ask({ ...ALL(), workspace: business(B) }, 'undo-change', { changeId: change.id }, B)
      expect(fromBravo).toMatchObject({ ok: false })
      expect(fromBravo.error).toContain('not found')
    } finally {
      if (before === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
      else process.env.NEXUS_WORKSPACES_ENABLED = before
    }
    expect(await inside(async () => Number((await db().product.findUniqueOrThrow({ where: { id: ids.bravo } })).basePrice), B)).toBe(50)
    await setPriceDirectly(ids.price, '100.00')
  })
})
