/**
 * Proposal 2.3 — an approved change is refused only when what it changes moved, never for a listing VERSION that every
 * write to the row moves (an order's stock cascade, a quantity push). PGlite, production schema; the job queue a stub;
 * made-up names and ids.
 *
 *   price basis  set-listing-price (a sale) and bulk-listing-price-change stood on the listing version: an order between
 *                the approval and the run refused them, the price untouched. They now stand on the price (the sale) they
 *                saw: an order moves nothing; a price or a sale someone else set still refuses them.
 *   plans        a later step on the listing an earlier step of the SAME plan changed was skipped for that step's version
 *                bump ("the facts moved"). Another field: nothing it stands on moved. The same field: the steps' entities
 *                (AgentTool.planEntities) take the later step's basis again after the earlier one ran. A change made
 *                outside the plan between the steps still skips it.
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
// A seam for "someone changes it outside the plan, just before this step is re-checked": runs once, then clears itself.
const hooks = vi.hoisted(() => ({ beforeCheck: null as null | ((toolName: string, args: Record<string, unknown>) => Promise<boolean>) }))
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
import { getTool } from './tool-registry.js'
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
afterEach(() => { hooks.beforeCheck = null })
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

/** The basis bulk-listing-price-change previewed until 2026-10-13: every listing's VERSION with its price facts. */
async function versionBasisOf(listingIds: string[], to: number[]): Promise<string> {
  const rows = await Promise.all(listingIds.map((id) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id }, include: { product: true } }))))
  const facts = rows.map((l: Row, i) => [l.id, l.version, n(l.price), n(l.priceOverride), l.followMasterPrice, n(l.product.basePrice), to[i]])
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
}
/** An approval stored before this change: its preview as the tool wrote it then (no `basisOn`, the version in its basis). */
async function storedBefore(approvalId: string, preview: (now: Row) => Row) {
  const row = await stored(approvalId)
  const { basisOn: _on, versionBasis: _v, versions: _vs, ...rest } = row.preview
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

  it('a price, then a percent on that same price: both run, and the second says its basis was taken again', async () => {
    const j = await jacket('PLAN-SAME')
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test price then percent', steps: [
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay], mode: 'set', value: 20 } },
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay], mode: 'percent', value: 10 } },
    ] })
    await commit(approvalId)
    const out = await inside(() => runPlan(approvalId))
    const rows = await steps(approvalId)
    expect(out, JSON.stringify(rows.map((s) => [s.status, s.reason]))).toMatchObject({ finished: true, counts: { done: 2 } })
    expect(n((await listing(j.ebay)).price)).toBe(22)
    const trace = await inside(() => db().agentControlAudit.findMany({ where: { action: 'basis_rebased' } })) as Row[]
    expect(trace.some((t) => t.toValue?.approvalId === approvalId && t.toValue?.step === 2 && /^step 1 \(bulk-listing-price-change\) of this plan changed what it stands on/.test(t.note))).toBe(true)
  })

  it('control: a price another writer set between the two steps still skips the second', async () => {
    const j = await jacket('PLAN-OUT')
    const { approvalId } = await askApprove('submit-change-plan', { title: 'Test price then percent, moved meanwhile', steps: [
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay], mode: 'set', value: 20 } },
      { tool: 'bulk-listing-price-change', args: { listingIds: [j.ebay], mode: 'percent', value: 10 } },
    ] })
    await commit(approvalId)
    // A person pins the listing on the Matrix after step 1 ran, just before step 2 is re-checked.
    hooks.beforeCheck = async (tool, args) => {
      if (tool !== 'bulk-listing-price-change' || args.mode !== 'percent') return false
      await someonePins(j.ebay, 30)
      return true
    }
    expect(await inside(() => runPlan(approvalId))).toMatchObject({ finished: true, counts: { done: 1, skipped: 1 } })
    const [first, second] = await steps(approvalId)
    expect(first.status).toBe('done')
    expect(second.reason).toMatch(/^not run — the facts moved since you approved it/)
    expect(n((await listing(j.ebay)).price)).toBe(30)
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

describe('pure: what each listing step stands on and changes (planEntities)', () => {
  const entities = (tool: string, args: Record<string, unknown>, preview: unknown = {}) => getTool(tool)!.planEntities!(args, preview)

  it('a listing\'s price and sale by its id; by its Matrix row and coordinate; a product\'s master price', () => {
    expect(entities('bulk-listing-price-change', { listingIds: ['l2', 'l1'], mode: 'percent', value: 5 }))
      .toEqual({ reads: ['listing:l1:price', 'listing:l2:price'], writes: ['listing:l1:price', 'listing:l2:price'] })
    expect(entities('bulk-listing-price-change', { prices: [{ listingId: 'l3', price: null }] }))
      .toEqual({ reads: ['listing:l3:price'], writes: ['listing:l3:price'] })
    // A resend sends the price a listing carries when it runs (a rule price is stored again if it moved).
    expect(entities('resend-prices', { listingIds: ['l1'] })).toEqual({ reads: ['listing:l1:price'], writes: ['listing:l1:price'] })
    expect(entities('set-price', { productId: 'p1', price: 12 })).toEqual({ reads: ['product:p1:price'], writes: ['product:p1:price'] })
    const matrixPrice = { productId: 'p0', action: 'set-price', price: 12, targets: [{ rowId: 'p1', coordinateKey: 'EBAY:IT' }] }
    expect(entities('set-listing-price', matrixPrice, { verb: 'set-price', changes: [{ rowId: 'p1', coordinateKey: 'EBAY:IT', cell: 'price' }] }))
      .toEqual({ reads: ['listing:p1@EBAY:IT:price', 'product:p1:price'], writes: ['listing:p1@EBAY:IT:price'] })
    const sale = { productId: 'p0', action: 'sale', sale: { price: 8 }, targets: [{ rowId: 'p1', coordinateKey: 'AMAZON:IT' }] }
    expect(entities('set-listing-price', sale, { verb: 'sale', changes: [{ rowId: 'p1', coordinateKey: 'AMAZON:IT' }] }))
      .toEqual({ reads: ['listing:p1@AMAZON:IT:sale'], writes: ['listing:p1@AMAZON:IT:sale'] })
    // Stock lands where the Matrix put it (Amazon's one EU quantity), named both as asked and as landed.
    const pin = { productId: 'p0', action: 'pin-quantity', quantity: 3, targets: [{ rowId: 'p1', coordinateKey: 'AMAZON:IT' }] }
    expect(entities('set-listing-stock', pin, { verb: 'pin-quantity', changes: [{ rowId: 'p1', coordinateKey: 'AMAZON:EU', cell: 'syncQty' }] }))
      .toEqual({ reads: ['listing:p1@AMAZON:EU:stock', 'listing:p1@AMAZON:IT:stock'], writes: ['listing:p1@AMAZON:EU:stock', 'listing:p1@AMAZON:IT:stock'] })
    // copy-prices also reads the market it copies from.
    const copy = { productId: 'p0', action: 'copy-prices', fromCoordinateKey: 'EBAY:IT', targets: [{ rowId: 'p1', coordinateKey: 'AMAZON:IT' }] }
    expect(entities('set-listing-price', copy, { verb: 'copy-prices', changes: [] }).reads)
      .toEqual(['listing:p1@AMAZON:IT:price', 'listing:p1@EBAY:IT:price', 'product:p1:price'])
  })

  it('a product\'s shared text per field and language (and the source it falls back to); a listing\'s own text', () => {
    expect(entities('set-content', { product: 'p1', language: 'de', title: 'x' }, { productId: 'p1', language: 'de', layer: 'language', changes: { title: {} } }))
      .toEqual({ reads: ['product:p1:title@de', 'product:p1:title@source'], writes: ['product:p1:title@de'] })
    expect(entities('set-content', { product: 'TEST-SKU-1', language: 'it', title: 'x' }, { productId: 'p1', language: 'it', layer: 'source', changes: { title: {} } }).writes)
      .toEqual(['product:TEST-SKU-1:title@it', 'product:TEST-SKU-1:title@source', 'product:p1:title@it', 'product:p1:title@source'])
    expect(entities('bulk-content-change', { language: 'de', items: [{ product: 'SKU-A', title: 'x' }, { product: 'SKU-B', attributes: { care_note: 'y' }, reset: ['description'] }] },
      { language: 'de', layer: 'language', changes: [{ sku: 'SKU-A', field: 'title' }] }).writes)
      .toEqual(['product:SKU-A:title@de', 'product:SKU-B:care_note@de', 'product:SKU-B:description@de'])
    expect(entities('set-listing-content', { product: 'p1', coordinate: { channel: 'amazon', market: 'de' }, language: 'de' },
      { productId: 'p1', language: 'de', changes: { title: { kind: 'pin' }, color: { kind: 'attribute' } } }))
      .toEqual({
        reads: ['listing:p1@AMAZON:DE:color@de', 'listing:p1@AMAZON:DE:title@de', 'product:p1:title@de', 'product:p1:title@source'],
        writes: ['listing:p1@AMAZON:DE:color@de', 'listing:p1@AMAZON:DE:title@de', 'product:p1:title@de'],
      })
  })
})
