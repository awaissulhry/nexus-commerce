/**
 * Proposal 2.3 — an approved change is refused only when what it changes moved, never for a listing VERSION that every
 * write to the row moves (an order's stock cascade, a quantity push). PGlite, production schema; the job queue a stub;
 * made-up names and ids.
 *
 *   price basis  set-listing-price (a sale) and bulk-listing-price-change stood on the listing version: an order between
 *                the approval and the run refused them, the price untouched. They now stand on the price (the sale) they
 *                saw: an order moves nothing; a price or a sale someone else set still refuses them.
 *   sale/price   a sale stands on the price it was planned against, a price on the listing's sale: neither runs past the
 *                other when someone moved it after the approval.
 *   plans        a later step on the listing an earlier step of the SAME plan changed was skipped for that step's version
 *                bump ("the facts moved"). It is re-based on what that earlier step WROTE (ToolResult.planWrites), fact by
 *                fact, and only when what it sets is unchanged: a step whose value would follow the moved base (a percent)
 *                is skipped, and so is one where anyone else moved a fact — between the steps, or while the earlier one ran.
 *   before       a request approved before this change (its preview stood on the version, and has no `basisOn`) is
 *                checked on the version, as it was approved.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))
// Seams for "someone changes it outside the plan": just before a step is re-checked, or while a step runs (after its own
// write, before the plan runner looks at the later steps). Each runs once, then clears itself.
type Hook = null | ((toolName: string, args: Record<string, unknown>) => Promise<boolean>)
const hooks = vi.hoisted(() => ({ beforeCheck: null as Hook, duringRun: null as Hook }))
vi.mock('./call-tool.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./call-tool.js')>()
  return {
    ...real,
    executeTool: async (...a: Parameters<typeof real.executeTool>) => {
      const out = await real.executeTool(...a)
      if (hooks.duringRun && (await hooks.duringRun(a[1], a[2]))) hooks.duringRun = null
      return out
    },
  }
})
vi.mock('../agent-fleet/approval-inbox.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent-fleet/approval-inbox.service.js')>()
  return {
    ...real,
    previewStaleness: async (...a: Parameters<typeof real.previewStaleness>) => {
      if (hooks.beforeCheck && (await hooks.beforeCheck(a[0], a[1]))) hooks.beforeCheck = null
      return real.previewStaleness(...a)
    },
  }
})

import type { UserPrincipal } from './call-tool.js'
import { runOrQueueTool } from './approval-gate.service.js'
import { runPlan } from './change-plan.service.js'
import { rebaseVerdict } from './change-plan.service.js'
import { factHash } from './tool-types.js'
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
const accounts = { ebay: '', amazon: '' }
const SALE = { start: '2026-12-01', end: '2026-12-24' }

/** Claude asks (a request or a plan) and a person approves it in Nexus; the undo window is still open. */
async function askApprove(tool: string, args: Record<string, unknown>): Promise<{ approvalId: string; preview: Row }> {
  const asked = await inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    return runOrQueueTool(tool, args, principal(people.asker, 'claude'), run.id, { forceAsk: true })
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
const steps = (approvalId: string) => inside(() => db().agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' } })) as Promise<Row[]>
const stored = (approvalId: string) => inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: approvalId } })) as Promise<Row>
const listing = (id: string) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id } })) as Promise<Row>
const n = (value: unknown) => (value === null || value === undefined ? null : Number(value))

/** What an order's stock cascade writes on a listing that follows the stock (stock-movement.service.ts): its quantity and its version. */
const orderCascade = (listingId: string) => inside(() => db().channelListing.update({
  where: { id: listingId }, data: { quantity: { decrement: 1 }, lastSyncStatus: 'PENDING', lastSyncedAt: null, version: { increment: 1 } },
}))
/** Another writer (a person on the Matrix, a repricer) pins the listing at its own price. */
const someonePins = (listingId: string, price: number) => inside(() => db().channelListing.update({
  where: { id: listingId }, data: { followMasterPrice: false, priceOverride: price, price, version: { increment: 1 } },
}))
/** Another writer sets the listing's sale price. */
const someoneSetsSale = (listingId: string, price: number) => inside(() => db().channelListing.update({
  where: { id: listingId }, data: { salePrice: price, version: { increment: 1 } },
}))

/** A jacket family of its own per test: the parent, one variation on eBay IT and Amazon IT (FBM), price 10, following the master. */
async function jacket(tag: string) {
  return inside(async () => {
    const parent = await db().product.create({ data: { sku: `TEST-SKU-PB-${tag}`, name: `PB jacket ${tag}`, basePrice: 10, isParent: true } })
    const child = await db().product.create({ data: { sku: `TEST-SKU-PB-${tag}-M`, name: `PB jacket ${tag} M`, basePrice: 10, totalStock: 9, parentId: parent.id } })
    const list = (channel: string, extra: Row = {}) => db().channelListing.create({ data: {
      productId: child.id, channel, marketplace: 'IT', channelMarket: `${channel}_IT`, region: 'IT', channelConnectionId: channel === 'EBAY' ? accounts.ebay : accounts.amazon,
      price: 10, quantity: 5, followMasterQuantity: true, followMasterPrice: true, listingStatus: 'ACTIVE', isPublished: true,
      externalListingId: `TEST-PB-${channel}-${tag}`, ...extra,
    } as never })
    const ebay = await list('EBAY')
    const amazon = await list('AMAZON', { fulfillmentMethod: 'FBM' })
    return { parent: parent.id as string, child: child.id as string, ebay: ebay.id as string, amazon: amazon.id as string }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  // The sale-window columns a migration adds with raw SQL (20260913_mx1_sale_price_window), as the sale suites add them.
  await database.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver' } })).id
  // The approver holds every permission in this business (the run checks the decider's access again).
  const role = await c.role.create({ data: { key: `PB_${randomUUID().slice(0, 8)}`, name: 'Price approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    for (const channel of ['EBAY', 'AMAZON']) {
      await c.marketplace.create({ data: { channel, code: 'IT', name: `${channel} IT`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    accounts.ebay = (await c.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true, externalAccountId: 'TEST-PB-EBAY' } })).id
    accounts.amazon = (await c.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, isPrimary: true, externalAccountId: 'TEST-PB-AMAZON' } })).id
  })
}, 180_000)
afterEach(() => { hooks.beforeCheck = null; hooks.duringRun = null })
afterAll(async () => { await database?.close() }, 60_000)

const salePrice = (j: { child: string; parent: string }, price: number) =>
  ({ productId: j.child, action: 'sale', sale: { price, ...SALE }, targets: [{ rowId: j.child, coordinateKey: 'AMAZON:IT' }] })
const setPrice = (j: { child: string }, price: number, coordinateKey = 'AMAZON:IT') =>
  ({ productId: j.child, action: 'set-price', price, targets: [{ rowId: j.child, coordinateKey }] })

describe('an approved price change stands on the price it saw, not on the listing version', { timeout: 60_000 }, () => {
  it('set-listing-price, a sale: runs after an order\'s stock cascade moved the version; the sale it saw had not moved', async () => {
    const j = await jacket('SALE')
    const { approvalId } = await askApprove('set-listing-price', salePrice(j, 8))
    const before = await listing(j.amazon)
    await orderCascade(j.amazon)
    expect((await listing(j.amazon)).version).toBe(before.version + 1)
    const done = await commit(approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect(n((await listing(j.amazon)).salePrice)).toBe(8)
  })

  it('set-listing-price, a price: runs after an order\'s stock cascade moved the version', async () => {
    const j = await jacket('PRICE')
    const { approvalId } = await askApprove('set-listing-price', setPrice(j, 12.5, 'EBAY:IT'))
    await orderCascade(j.ebay)
    const done = await commit(approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect(n((await listing(j.ebay)).price)).toBe(12.5)
  })

  it('bulk-listing-price-change: runs after an order\'s stock cascade moved the version', async () => {
    const j = await jacket('BULK')
    const { approvalId } = await askApprove('bulk-listing-price-change', { listingIds: [j.ebay, j.amazon], mode: 'percent', value: 10 })
    await orderCascade(j.ebay)
    await orderCascade(j.amazon)
    const done = await commit(approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect([n((await listing(j.ebay)).price), n((await listing(j.amazon)).price)]).toEqual([11, 11])
  })

  it('control: refused when someone else changed the price, or the sale, after the approval; their value stays', async () => {
    const j = await jacket('MOVED')
    const bulk = await askApprove('bulk-listing-price-change', { listingIds: [j.ebay], mode: 'percent', value: 10 })
    const sale = await askApprove('set-listing-price', salePrice(j, 8))
    const matrix = await askApprove('set-listing-price', setPrice(j, 12.5))
    await someonePins(j.ebay, 14)
    await someoneSetsSale(j.amazon, 7)
    await someonePins(j.amazon, 13)
    for (const approvalId of [bulk.approvalId, sale.approvalId, matrix.approvalId]) {
      const out = await commit(approvalId)
      expect(out, JSON.stringify(out)).toMatchObject({ ok: false, error: expect.stringMatching(/the facts moved since you approved it/) })
      expect((await stored(approvalId)).status).toBe('pending')
    }
    expect(n((await listing(j.ebay)).price)).toBe(14)
    expect([n((await listing(j.amazon)).salePrice), n((await listing(j.amazon)).price)]).toEqual([7, 13])
  })
})

describe('a sale and a price guard each other', { timeout: 60_000 }, () => {
  it('an approved sale is refused when someone repriced the listing after the approval: it never runs above the price', async () => {
    const j = await jacket('SALE-REPRICED')
    const { approvalId } = await askApprove('set-listing-price', salePrice(j, 8))
    await someonePins(j.amazon, 7)
    const out = await commit(approvalId)
    expect(out, JSON.stringify(out)).toMatchObject({ ok: false, error: expect.stringMatching(/the facts moved since you approved it — a price, sale or pricing it stands on changed/) })
    expect([n((await listing(j.amazon)).price), n((await listing(j.amazon)).salePrice)]).toEqual([7, null])
  })

  it('an approved price is refused when someone set a sale on the listing after the approval (the bulk tool and the Matrix)', async () => {
    const j = await jacket('PRICE-ON-SALE')
    const bulk = await askApprove('bulk-listing-price-change', { listingIds: [j.ebay], mode: 'set', value: 12 })
    const matrix = await askApprove('set-listing-price', setPrice(j, 12, 'EBAY:IT'))
    await someoneSetsSale(j.ebay, 11)
    for (const approvalId of [bulk.approvalId, matrix.approvalId]) {
      const out = await commit(approvalId)
      expect(out, JSON.stringify(out)).toMatchObject({ ok: false, error: expect.stringMatching(/the facts moved since you approved it/) })
    }
    expect([n((await listing(j.ebay)).price), n((await listing(j.ebay)).salePrice)]).toEqual([10, 11])
  })
})

/** The basis bulk-listing-price-change previewed until 2026-10-13: every listing's VERSION with its price facts. */
async function versionBasisOf(listingIds: string[], to: number[]): Promise<string> {
  const rows = await Promise.all(listingIds.map((id) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id }, include: { product: true } }))))
  const facts = rows.map((l: Row, i) => [l.id, l.version, n(l.price), n(l.priceOverride), l.followMasterPrice, n(l.product.basePrice), to[i]])
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
}
/** An approval stored before this change: its preview as the tool wrote it then (no `basisOn`, the version in its basis). */
async function storedBefore(approvalId: string, preview: (now: Row) => Row) {
  const row = await stored(approvalId)
  const { basisOn: _on, versionBasis: _v, versions: _vs, planFacts: _f, ...rest } = row.preview
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { preview: preview(rest) } }))
}

describe('a request approved before this change stands on the version, as it was approved', { timeout: 60_000 }, () => {
  it('bulk-listing-price-change: runs when nothing moved; refused after an order\'s cascade moved the version', async () => {
    const j = await jacket('OLD-BULK')
    const quiet = await askApprove('bulk-listing-price-change', { listingIds: [j.ebay], mode: 'set', value: 12 })
    const basis = await versionBasisOf([j.ebay], [12])
    await storedBefore(quiet.approvalId, (p) => ({ ...p, basis }))
    const ran = await commit(quiet.approvalId)
    expect(ran, JSON.stringify(ran)).toMatchObject({ ok: true, status: 'executed' })
    expect(n((await listing(j.ebay)).price)).toBe(12)

    const moved = await askApprove('bulk-listing-price-change', { listingIds: [j.amazon], mode: 'set', value: 12 })
    const movedBasis = await versionBasisOf([j.amazon], [12])
    await storedBefore(moved.approvalId, (p) => ({ ...p, basis: movedBasis }))
    await orderCascade(j.amazon)
    const refused = await commit(moved.approvalId)
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, error: expect.stringMatching(/the facts moved since you approved it — basis changed/) })
    expect(n((await listing(j.amazon)).price)).toBe(10)
  })

  it('set-listing-price, a sale: runs at the version it saw when nothing moved; refused after an order\'s cascade moved the version', async () => {
    const j = await jacket('OLD-SALE')
    const withVersion = async (approvalId: string, listingId: string) => {
      const { version } = await listing(listingId)
      await storedBefore(approvalId, (p) => ({ ...p, changes: p.changes.map((c: Row) => ({ ...c, version })) }))
    }
    const quiet = await askApprove('set-listing-price', salePrice(j, 8))
    await withVersion(quiet.approvalId, j.amazon)
    const ran = await commit(quiet.approvalId)
    expect(ran, JSON.stringify(ran)).toMatchObject({ ok: true, status: 'executed' })
    expect(n((await listing(j.amazon)).salePrice)).toBe(8)

    const moved = await askApprove('set-listing-price', salePrice(j, 7))
    await withVersion(moved.approvalId, j.amazon)
    await orderCascade(j.amazon)
    const refused = await commit(moved.approvalId)
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, error: expect.stringMatching(/the facts moved since you approved it — changes changed/) })
    expect(n((await listing(j.amazon)).salePrice)).toBe(8)
  })
})

describe('a change plan: a later step on the listing an earlier step changed', { timeout: 60_000 }, () => {
  it('a price, then a sale, on ONE listing: both run', async () => {
    const j = await jacket('PLAN-2')
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test price then sale', steps: [
      { tool: 'set-listing-price', args: setPrice(j, 12) },
      { tool: 'set-listing-price', args: salePrice(j, 9) },
    ] })
    expect(await commit(approvalId)).toMatchObject({ ok: true, status: 'executing' })
    const out = await inside(() => runPlan(approvalId))
    const rows = await steps(approvalId)
    expect(out, JSON.stringify(rows.map((s) => [s.status, s.reason]))).toMatchObject({ finished: true, counts: { done: 2 } })
    const after = await listing(j.amazon)
    expect([n(after.price), n(after.salePrice)]).toEqual([12, 9])
  })

  it('two absolute prices: the second, on a listing the first priced and one it did not, runs on the first one\'s own write', async () => {
    const [j, k] = [await jacket('PLAN-SET'), await jacket('PLAN-SET-OTHER')]
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test two prices', steps: [
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay, j.amazon], mode: 'set', value: 20 } },
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.amazon, k.ebay], mode: 'set', value: 25 } },
    ] })
    await commit(approvalId)
    const out = await inside(() => runPlan(approvalId))
    const rows = await steps(approvalId)
    expect(out, JSON.stringify(rows.map((r) => [r.status, r.reason]))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect([n((await listing(j.ebay)).price), n((await listing(j.amazon)).price), n((await listing(k.ebay)).price)]).toEqual([20, 25, 25])
    const trace = await inside(() => db().agentControlAudit.findMany({ where: { action: 'basis_rebased' } })) as Row[]
    expect(trace.some((t) => t.toValue?.approvalId === approvalId && t.toValue?.step === 2 && /^step 1 \(bulk-listing-price-change\) of this plan wrote what it stands on/.test(t.note))).toBe(true)
  })

  it('a price, then a percent of it: the percent would now run on the new price, not the one approved — skipped, and it says so', async () => {
    const j = await jacket('PLAN-PCT')
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test price then percent', steps: [
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay], mode: 'set', value: 20 } },
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay], mode: 'percent', value: 10 } },
    ] })
    await commit(approvalId)
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 1, skipped: 1 } })
    const [, second] = await steps(approvalId)
    expect(second.reason).toMatch(/^not run — an earlier step of this plan changed what it stands on, but it would now set another value than the one you approved/)
    expect(n((await listing(j.ebay)).price)).toBe(20)
  })

  it('a master price, then a percent on a listing that follows it: skipped, the listing keeps following the new master price', async () => {
    const j = await jacket('PLAN-MASTER')
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test master then percent', steps: [
      { tool: 'set-price', args: { productId: j.child, price: 20 } },
      { tool: 'set-listing-price', args: { productId: j.child, action: 'adjust-prices', percent: 10, targets: [{ rowId: j.child, coordinateKey: 'EBAY:IT' }] } },
    ] })
    await commit(approvalId)
    const out = await inside(() => runPlan(approvalId))
    const rows = await steps(approvalId)
    expect(out, JSON.stringify(rows.map((r) => [r.status, r.reason]))).toMatchObject({ finished: true, counts: { done: 1, skipped: 1 } })
    expect(rows[1].reason).toMatch(/^not run — the facts moved since you approved it/)
    expect((await listing(j.ebay)).followMasterPrice).toBe(true)
  })

  it('control: a price another writer set WHILE the first step ran, on a listing it did not touch, skips the second', async () => {
    const [j, k] = [await jacket('PLAN-DURING'), await jacket('PLAN-DURING-OTHER')]
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test two prices, one moved meanwhile', steps: [
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay, j.amazon], mode: 'set', value: 20 } },
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.amazon, k.ebay], mode: 'set', value: 25 } },
    ] })
    await commit(approvalId)
    // A person pins the other listing on the Matrix while step 1 runs: after its write, before the runner looks again.
    hooks.duringRun = async (tool, args) => {
      if (tool !== 'bulk-listing-price-change' || (args as { value?: unknown }).value !== 20) return false
      await someonePins(k.ebay, 30)
      return true
    }
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 1, skipped: 1 } })
    const [first, second] = await steps(approvalId)
    expect(first.status).toBe('done')
    expect(second.reason).toMatch(/^not run — an earlier step of this plan changed what it stands on, but a listing's own price changed outside this plan/)
    expect([n((await listing(j.amazon)).price), n((await listing(k.ebay)).price)]).toEqual([20, 30])
  })

  it('control: a sale another writer set between a price and a sale on one listing still skips the sale', async () => {
    const j = await jacket('PLAN-SALE-OUT')
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test price then sale, sale moved meanwhile', steps: [
      { tool: 'set-listing-price', args: setPrice(j, 12) },
      { tool: 'set-listing-price', args: salePrice(j, 9) },
    ] })
    await commit(approvalId)
    hooks.beforeCheck = async (tool, args) => {
      if (tool !== 'set-listing-price' || args.action !== 'sale') return false
      await someoneSetsSale(j.amazon, 7)
      return true
    }
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 1, skipped: 1 } })
    const [, second] = await steps(approvalId)
    expect(second.reason).toMatch(/^not run — the facts moved since you approved it — changes changed/)
    const after = await listing(j.amazon)
    expect([n(after.price), n(after.salePrice)]).toEqual([12, 7])
  })
})

describe('pure: when a later step may be re-based on an earlier step\'s own write (rebaseVerdict)', () => {
  const tool = { name: 'bulk-listing-price-change', planRebase: () => ['changes', 'totals', 'basis'] }
  const was = { follow: true, override: null, price: 10 }
  const pinned = { follow: false, override: 20, price: 20 }
  const preview = (stands: Record<string, unknown>, sets: unknown = { 'listing:l1:price': 25 }, extra: Row = {}) =>
    ({ changes: [], totals: {}, basis: factHash({ stands, sets }), ...extra, planFacts: { stands: Object.fromEntries(Object.entries(stands).map(([k, v]) => [k, factHash(v)])), sets: factHash(sets) } })
  const before = preview({ 'listing:l1:price': was, 'listing:l2:price': was, context: 'c' })
  const write = { key: 'listing:l1:price' as const, before: was, after: pinned }

  it('a fact the earlier step wrote, holding exactly what it left: re-based', () => {
    expect(rebaseVerdict(tool, before, preview({ 'listing:l1:price': pinned, 'listing:l2:price': was, context: 'c' }), [write])).toBeNull()
  })
  it('what it sets moved (a percent on the moved base): refused', () => {
    expect(rebaseVerdict(tool, before, preview({ 'listing:l1:price': pinned, 'listing:l2:price': was, context: 'c' }, { 'listing:l1:price': 22 }), [write]))
      .toMatch(/^it would now set another value/)
  })
  it('the written fact holds another value than the write left, or the write found another one: refused', () => {
    expect(rebaseVerdict(tool, before, preview({ 'listing:l1:price': { ...pinned, price: 21 }, 'listing:l2:price': was, context: 'c' }), [write])).toMatch(/changed outside this plan$/)
    expect(rebaseVerdict(tool, before, preview({ 'listing:l1:price': pinned, 'listing:l2:price': was, context: 'c' }), [{ ...write, before: pinned }])).toMatch(/changed outside this plan$/)
  })
  it('a fact the earlier step did not write moved, or the context, or a field its facts do not explain: refused', () => {
    expect(rebaseVerdict(tool, before, preview({ 'listing:l1:price': pinned, 'listing:l2:price': pinned, context: 'c' }), [write])).toBe('a listing\'s own price changed outside this plan')
    expect(rebaseVerdict(tool, before, preview({ 'listing:l1:price': pinned, 'listing:l2:price': was, context: 'd' }), [write])).toMatch(/^its pricing/)
    const sale = { name: 'set-listing-price', planRebase: () => [] as string[] }
    const verb = (changes: unknown, stands: Record<string, unknown>) => ({ verb: 'set-price', changes, planFacts: { stands: Object.fromEntries(Object.entries(stands).map(([k, v]) => [k, factHash(v)])), sets: 'x' } })
    expect(rebaseVerdict(sale, verb([{ from: 10 }], { 'listing:l1:sale': 1 }), verb([{ from: 11 }], { 'listing:l1:sale': 2 }), [{ key: 'listing:l1:sale', after: 2 }])).toBe('changes changed outside this plan')
  })
  it('a step without facts (approved before this change) is never re-based', () => {
    expect(rebaseVerdict(tool, { basis: 'old' }, before, [write])).toMatch(/^it has no facts/)
  })
})
