/**
 * MCP full control 08 S12 — pricing rules, promotions and scheduled price changes, for the pricing pages and Claude.
 *
 *   Routes: they keep their answers now that their writes live in `services/pricing/` (pricing-rule, promotion and
 *   scheduled-price services). Written against the routes BEFORE the move and unchanged after it: `POST`/`PUT`/`DELETE
 *   /api/pricing-rules`, `POST`/`DELETE /api/pricing/promotions`, `POST /api/products/:id/scheduled-changes` and
 *   `POST /api/products/scheduled-changes/:id/cancel`.
 *   Job: a scheduled change that is cancelled never runs — the job claims a row before it runs it, and a cancel landing
 *   while it runs is refused instead of saying "cancelled".
 *   Tools: Claude's set-pricing-rule, set-promotion and schedule-price-change through the doors a person uses (queued,
 *   approved, run, undone), and what each preview says about reaching the channels.
 *
 * Real SQL (PGlite with the production schema); the real route plugins in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
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
vi.mock('../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../routes/saved-view-persistence.routes.js', () => ({ default: async () => {} }))
/** A hook that runs inside the master price write, to land a cancel while the scheduled-changes job runs a change. */
const during: { update?: () => Promise<unknown> } = {}
vi.mock('../master-price.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../master-price.service.js')>()
  const service = actual.masterPriceService as unknown as Record<string, unknown>
  return {
    ...actual,
    masterPriceService: new Proxy(service, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property === 'update' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            const hook = during.update
            during.update = undefined
            if (hook) await hook()
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }),
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const DAY = 86_400_000
const ids = { jacket: '', gloves: '' }
let app: FastifyInstance

async function send(method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() }
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S12-JACKET', name: 'Test jacket', basePrice: '100.00', minPrice: '80.00', maxPrice: '130.00' } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S12-GLOVES', name: 'Test gloves', basePrice: '20.00', deletedAt: new Date() } })).id
  })
  app = Fastify()
  // The scheduled-change route records who created the change: a signed-in person.
  app.addHook('preHandler', (request, _reply, done) => { (request as { authUser?: { id: string } }).authUser = { id: 'u-s12-person' }; withWorkspace(business, done) })
  await app.register((await import('../../routes/pricing-rules.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/pricing.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/products-catalog.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S12 — the pricing change routes answer as before', () => {
  it('POST, PUT and DELETE /api/pricing-rules: create with products, update, soft delete; bad type; unknown rule', async () => {
    const created = await send('POST', '/api/pricing-rules', { name: 'TEST rule', type: 'MATCH_LOW', minMarginPercent: 12.5, parameters: { offset: 1 }, productIds: [ids.jacket] })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ name: 'TEST rule', type: 'MATCH_LOW', priority: 100, minMarginPercent: '12.5', maxMarginPercent: null, parameters: { offset: 1 }, isActive: true })
    expect(await inside(() => database.client.pricingRuleProduct.count({ where: { ruleId: created.body.id } }))).toBe(1)
    expect(await inside(() => database.client.auditLog.count({ where: { entityType: 'PricingRule', entityId: created.body.id, action: 'create' } }))).toBe(1)
    expect(await send('POST', '/api/pricing-rules', { type: 'MATCH_LOW' })).toEqual({ status: 400, body: { error: 'name is required' } })
    expect(await send('POST', '/api/pricing-rules', { name: 'x', type: 'NOPE' })).toEqual({ status: 400, body: { error: 'type must be one of MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN, FIXED_PRICE, DYNAMIC_MARGIN' } })
    const updated = await send('PUT', `/api/pricing-rules/${created.body.id}`, { name: 'TEST rule 2', priority: 5, minMarginPercent: null })
    expect(updated.body).toMatchObject({ name: 'TEST rule 2', priority: 5, minMarginPercent: null, type: 'MATCH_LOW' })
    expect(await send('PUT', `/api/pricing-rules/${created.body.id}`, { type: 'NOPE' })).toEqual({ status: 400, body: { error: 'type must be one of MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN, FIXED_PRICE, DYNAMIC_MARGIN' } })
    expect(await send('PUT', '/api/pricing-rules/nope', { name: 'x' })).toEqual({ status: 404, body: { error: 'rule not found' } })
    const deleted = await send('DELETE', `/api/pricing-rules/${created.body.id}`)
    expect(deleted.body).toMatchObject({ id: created.body.id, isActive: false })
    expect(await send('DELETE', '/api/pricing-rules/nope')).toEqual({ status: 404, body: { error: 'rule not found' } })
  })

  it('POST and DELETE /api/pricing/promotions: an event with its action; bad input; ending one; unknown event', async () => {
    const created = await send('POST', '/api/pricing/promotions', { name: 'TEST sale', startDate: '2027-03-01', endDate: '2027-03-07', channel: 'AMAZON', marketplace: 'IT', action: { type: 'PERCENT_OFF', value: 15 } })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ name: 'TEST sale', channel: 'AMAZON', marketplace: 'IT', expectedLift: '1', source: 'CUSTOM', isActive: true, priceActions: [{ action: 'PERCENT_OFF', value: '15', channel: 'AMAZON', marketplace: 'IT', isActive: true }] })
    expect(await send('POST', '/api/pricing/promotions', { startDate: '2027-03-01', endDate: '2027-03-07' })).toEqual({ status: 400, body: { error: 'name is required' } })
    expect(await send('POST', '/api/pricing/promotions', { name: 'x', startDate: '2027-03-01' })).toEqual({ status: 400, body: { error: 'startDate and endDate are required (YYYY-MM-DD)' } })
    expect(await send('POST', '/api/pricing/promotions', { name: 'x', startDate: 'nope', endDate: '2027-03-07' })).toEqual({ status: 400, body: { error: 'invalid date' } })
    expect(await send('POST', '/api/pricing/promotions', { name: 'x', startDate: '2027-03-07', endDate: '2027-03-01' })).toEqual({ status: 400, body: { error: 'endDate must be ≥ startDate' } })
    expect(await send('POST', '/api/pricing/promotions', { name: 'x', startDate: '2027-03-01', endDate: '2027-03-07', action: { type: 'BOGO', value: 1 } })).toEqual({ status: 400, body: { error: 'action.type must be PERCENT_OFF or FIXED_PRICE' } })
    expect(await send('POST', '/api/pricing/promotions', { name: 'x', startDate: '2027-03-01', endDate: '2027-03-07', action: { type: 'PERCENT_OFF', value: 100 } })).toEqual({ status: 400, body: { error: 'action.value must be > 0 (and < 100 for PERCENT_OFF)' } })
    const ended = await send('DELETE', `/api/pricing/promotions/${created.body.id}`)
    expect(ended).toEqual({ status: 200, body: { ok: true, salesEnded: 0 } })
    expect(await inside(() => database.client.retailEventPriceAction.count({ where: { eventId: created.body.id, isActive: true } }))).toBe(0)
    expect(await send('DELETE', '/api/pricing/promotions/nope')).toEqual({ status: 404, body: { error: 'event not found' } })
  })

  it('POST /api/products/:id/scheduled-changes and the cancel: a price change for later; bad input; a deleted product; cancel once', async () => {
    const at = new Date(Date.now() + 3 * DAY).toISOString()
    const created = await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'PRICE', payload: { basePrice: 110 }, scheduledFor: at })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ ok: true, change: { productId: ids.jacket, kind: 'PRICE', payload: { basePrice: 110 }, scheduledFor: at, status: 'PENDING', createdBy: 'u-s12-person' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'NOPE', payload: {}, scheduledFor: at })).toEqual({ status: 400, body: { error: 'kind must be STATUS or PRICE' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'PRICE', scheduledFor: at })).toEqual({ status: 400, body: { error: 'payload (object) required' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'PRICE', payload: { basePrice: 1 } })).toEqual({ status: 400, body: { error: 'scheduledFor (ISO timestamp) required' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'PRICE', payload: { basePrice: 1 }, scheduledFor: 'nope' })).toEqual({ status: 400, body: { error: 'scheduledFor not a valid date: nope' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'PRICE', payload: { basePrice: 1 }, scheduledFor: '2020-01-01T00:00:00Z' })).toEqual({ status: 400, body: { error: 'scheduledFor must be in the future (use the live PATCH endpoint to apply now)' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'PRICE', payload: { nope: 1 }, scheduledFor: at })).toEqual({ status: 400, body: { error: 'PRICE payload requires basePrice (number >= 0) or adjustPercent (number)' } })
    expect(await send('POST', `/api/products/${ids.jacket}/scheduled-changes`, { kind: 'STATUS', payload: { status: 'GONE' }, scheduledFor: at })).toEqual({ status: 400, body: { error: 'STATUS payload.status must be ACTIVE | DRAFT | INACTIVE' } })
    expect(await send('POST', `/api/products/${ids.gloves}/scheduled-changes`, { kind: 'PRICE', payload: { basePrice: 1 }, scheduledFor: at })).toEqual({ status: 404, body: { error: 'product not found or soft-deleted' } })
    const cancelled = await send('POST', `/api/products/scheduled-changes/${created.body.change.id}/cancel`)
    expect(cancelled).toMatchObject({ status: 200, body: { ok: true, change: { id: created.body.change.id, status: 'CANCELLED' } } })
    expect(await send('POST', `/api/products/scheduled-changes/${created.body.change.id}/cancel`)).toEqual({ status: 409, body: { error: 'cannot cancel — current status is CANCELLED' } })
    expect(await send('POST', '/api/products/scheduled-changes/nope/cancel')).toEqual({ status: 404, body: { error: 'not found' } })
  })
})

describe('08 S12 — a cancelled scheduled price change never runs', () => {
  it('a cancel that lands while the scheduled-changes job is running the change is refused; it never says "cancelled" for a change that ran', async () => {
    const { runScheduledChangesOnce } = await import('../../jobs/scheduled-changes.job.js')
    const change = await inside(() => database.client.scheduledProductChange.create({
      data: { productId: ids.jacket, kind: 'PRICE', payload: { basePrice: 105 }, scheduledFor: new Date(Date.now() + DAY), status: 'PENDING' },
    }))
    await inside(() => database.client.$executeRawUnsafe(`UPDATE "ScheduledProductChange" SET "scheduledFor" = now() - interval '1 minute' WHERE id = $1`, change.id))
    let cancel: { status: number; body: Json } | null = null
    during.update = async () => { cancel = await send('POST', `/api/products/scheduled-changes/${change.id}/cancel`) }
    const run = await inside(() => runScheduledChangesOnce())
    const price = Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: ids.jacket } }))).basePrice)
    const row = await inside(() => database.client.scheduledProductChange.findUniqueOrThrow({ where: { id: change.id } }))
    expect(run.applied).toBe(1)
    expect(price).toBe(105)
    expect(row.status).toBe('APPLIED')
    // The change ran, so the cancel must not have said it was cancelled.
    expect(cancel).toMatchObject({ status: 409 })
  })

  it('control: a change cancelled before the job runs it is never applied', async () => {
    const { runScheduledChangesOnce } = await import('../../jobs/scheduled-changes.job.js')
    const before = Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: ids.jacket } }))).basePrice)
    const change = await inside(() => database.client.scheduledProductChange.create({
      data: { productId: ids.jacket, kind: 'PRICE', payload: { basePrice: 101 }, scheduledFor: new Date(Date.now() + DAY), status: 'PENDING' },
    }))
    expect(await send('POST', `/api/products/scheduled-changes/${change.id}/cancel`)).toMatchObject({ status: 200 })
    await inside(() => database.client.$executeRawUnsafe(`UPDATE "ScheduledProductChange" SET "scheduledFor" = now() - interval '1 minute' WHERE id = $1`, change.id))
    await inside(() => runScheduledChangesOnce())
    expect(Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: ids.jacket } }))).basePrice)).toBe(before)
    expect((await inside(() => database.client.scheduledProductChange.findUniqueOrThrow({ where: { id: change.id } }))).status).toBe('CANCELLED')
  })
})

// ── Claude's pricing records ───────────────────────────────────────────────────────────────────────────

describe('08 S12 — a scheduled price change left half-run is never run again blindly', () => {
  /**
   * The job claims a row (PENDING → APPLYING) before it runs it. When the process dies between the claim and the
   * final status, the row stays APPLYING: it may or may not have reached the channels. The sweep marks such a row
   * UNKNOWN after a safe window ("outcome unknown — check") and never runs it again by itself; a person, or an approved
   * schedule-price-change, says what happened: applied, or retry.
   */
  const stuck = async (minutesAgo: number, basePrice: number) => {
    const row = await inside(() => database.client.scheduledProductChange.create({
      data: { productId: ids.jacket, kind: 'PRICE', payload: { basePrice }, scheduledFor: new Date(Date.now() - 60 * 60_000), status: 'APPLYING' },
    }))
    // Through the client, as the app writes it (a raw now() is the session's local time in a timestamp column).
    await inside(() => database.client.scheduledProductChange.update({ where: { id: row.id }, data: { updatedAt: new Date(Date.now() - minutesAgo * 60_000) } }))
    return row.id
  }
  const statusOf = async (id: string) => (await inside(() => database.client.scheduledProductChange.findUniqueOrThrow({ where: { id } })))
  const priceOf = async () => Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: ids.jacket } }))).basePrice)

  it('the sweep marks a change APPLYING past the safe window as UNKNOWN, runs nothing, and leaves a fresh one alone', async () => {
    const { runScheduledChangesOnce } = await import('../../jobs/scheduled-changes.job.js')
    const price = await priceOf()
    const old = await stuck(30, 99)
    const fresh = await stuck(1, 98)
    await inside(() => runScheduledChangesOnce())
    expect(await statusOf(old)).toMatchObject({ status: 'UNKNOWN', error: expect.stringContaining('outcome unknown') })
    expect((await statusOf(fresh)).status).toBe('APPLYING')
    expect(await priceOf()).toBe(price)
    await inside(() => runScheduledChangesOnce())
    expect((await statusOf(old)).status).toBe('UNKNOWN')
    expect(await priceOf()).toBe(price)
  })

  it('a person says what happened: marked applied stays applied; retry runs it on the next sweep', async () => {
    const { runScheduledChangesOnce } = await import('../../jobs/scheduled-changes.job.js')
    const applied = await stuck(30, 97)
    const retry = await stuck(30, 104)
    await inside(() => runScheduledChangesOnce())
    const markApplied = await app.inject({ method: 'POST', url: `/api/products/scheduled-changes/${applied}/resolve`, payload: { outcome: 'applied' } })
    expect(markApplied.statusCode, markApplied.body).toBe(200)
    expect(await statusOf(applied)).toMatchObject({ status: 'APPLIED', error: expect.stringContaining('marked applied') })
    const markRetry = await app.inject({ method: 'POST', url: `/api/products/scheduled-changes/${retry}/resolve`, payload: { outcome: 'retry' } })
    expect(markRetry.statusCode, markRetry.body).toBe(200)
    expect((await statusOf(retry)).status).toBe('PENDING')
    await inside(() => runScheduledChangesOnce())
    expect((await statusOf(retry)).status).toBe('APPLIED')
    expect(await priceOf()).toBe(104)
    // A row that is not waiting for a check cannot be resolved.
    expect((await app.inject({ method: 'POST', url: `/api/products/scheduled-changes/${retry}/resolve`, payload: { outcome: 'retry' } })).statusCode).toBe(409)
    // "retry" sets a master price again: the route needs the price permission, not just products.edit.
    const { permissionForRoute } = await import('../../lib/auth/permissions-manifest.js')
    expect(permissionForRoute('POST', `/api/products/scheduled-changes/${retry}/resolve`)).toBe('products.price.edit')
  })
})

describe("08 S12 — Claude's pricing records, approved, run and undone", { timeout: 60_000 }, () => {
  const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
  let approverId = ''
  const claude = () => ({ kind: 'user' as const, userId: approverId, label: 'S12 Approver', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'claude' as const })
  const db = () => database.client

  async function ask(tool: string, args: Record<string, unknown>) {
    const { runOrQueueTool } = await import('../agents/approval-gate.service.js')
    const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: approverId, via: 'claude' } }))
    return inside(() => runOrQueueTool(tool, args, claude(), run.id, { forceAsk: true }))
  }
  async function approveAndRun(approvalId: string) {
    const { commitScheduledApproval, scheduleApproval } = await import('../agent-fleet/approval-inbox.service.js')
    const parked = await inside(() => scheduleApproval({ id: approvalId, actor: claude() as never }))
    expect(parked, (parked as { error?: string }).error).toMatchObject({ ok: true, status: 'scheduled' })
    await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    return inside(() => commitScheduledApproval(approvalId))
  }
  async function askAndRun(tool: string, args: Record<string, unknown>) {
    const queued = await ask(tool, args)
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    return queued
  }
  const changeOf = (approvalId: string) => inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
  async function undo(approvalId: string) {
    const change = await changeOf(approvalId)
    const asked = await ask('undo-change', { changeId: change.id })
    if (!asked.ok) return asked
    const ran = await approveAndRun(asked.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    return asked
  }

  beforeAll(async () => {
    vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    vi.stubEnv('NEXUS_ENABLE_PRICING_CRON', '')
    const client = database.client
    const role = await client.role.create({ data: { key: `S12_${randomUUID().slice(0, 8)}`, name: 'S12 approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
    const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'S12 Approver' } })
    approverId = approver.id
    await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
    const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    await inside(async () => {
      for (const [channel, marketplace] of [['AMAZON', 'IT'], ['EBAY', 'IT']] as const) {
        await client.channelListing.create({ data: { productId: ids.jacket, channelMarket: `${channel}_${marketplace}`, channel, region: marketplace, marketplace, price: '100.00', quantity: 1, listingStatus: 'ACTIVE' } as never })
      }
    })
  })

  it('set-pricing-rule: create says it sends nothing; update with products (undo puts both back); switch off (undo switches it on)', async () => {
    const created = await askAndRun('set-pricing-rule', { action: 'create', name: 'TEST tool rule', type: 'PERCENTAGE_BELOW', parameters: { percent: 3 }, productIds: [ids.jacket] })
    expect(created.preview).toMatchObject({ action: 'create', totals: { products: 1 }, sendsNothing: expect.stringContaining('nothing is sent') })
    const { ruleId } = (await changeOf(created.approvalId!)).after as { ruleId: string }
    expect(await inside(() => db().pricingRule.findUniqueOrThrow({ where: { id: ruleId } }))).toMatchObject({ name: 'TEST tool rule', type: 'PERCENTAGE_BELOW', isActive: true })

    const updated = await askAndRun('set-pricing-rule', { action: 'update', ruleId, priority: 7, productIds: [] })
    expect(updated.preview).toMatchObject({ changes: { priority: { from: 100, to: 7 } }, products: { count: 0, before: 1 } })
    expect(await inside(() => db().pricingRuleProduct.count({ where: { ruleId } }))).toBe(0)
    await undo(updated.approvalId!)
    expect((await inside(() => db().pricingRule.findUniqueOrThrow({ where: { id: ruleId } }))).priority).toBe(100)
    expect(await inside(() => db().pricingRuleProduct.count({ where: { ruleId } }))).toBe(1)

    const off = await askAndRun('set-pricing-rule', { action: 'deactivate', ruleId })
    expect((await inside(() => db().pricingRule.findUniqueOrThrow({ where: { id: ruleId } }))).isActive).toBe(false)
    await undo(off.approvalId!)
    expect((await inside(() => db().pricingRule.findUniqueOrThrow({ where: { id: ruleId } }))).isActive).toBe(true)
    expect(await ask('set-pricing-rule', { action: 'update', ruleId: 'nope', priority: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
  })

  it('set-promotion: create says the pricing cron is off (nothing reaches a channel) and which listings carry no sale; undo ends it; ending cannot be undone', async () => {
    const created = await askAndRun('set-promotion', {
      action: 'create', name: 'TEST tool sale', startDate: '2027-04-01', endDate: '2027-04-10', marketplace: 'IT', discount: { type: 'PERCENT_OFF', value: 10 },
    })
    expect(created.preview).toMatchObject({
      action: 'create', promotion: { days: 10, discount: { type: 'PERCENT_OFF', value: 10 } },
      scope: { listings: 2, onSale: 1, noSale: { EBAY: expect.stringContaining('no sale price') } },
      applies: expect.stringContaining('pricing cron is off'),
    })
    const { promotionId } = (await changeOf(created.approvalId!)).after as { promotionId: string }
    expect(await inside(() => db().retailEvent.findUniqueOrThrow({ where: { id: promotionId }, include: { priceActions: true } }))).toMatchObject({ name: 'TEST tool sale', isActive: true, priceActions: [{ action: 'PERCENT_OFF' }] })
    await undo(created.approvalId!)
    expect((await inside(() => db().retailEvent.findUniqueOrThrow({ where: { id: promotionId } }))).isActive).toBe(false)
    const ending = await inside(() => db().agentChange.findFirstOrThrow({ where: { toolName: 'set-promotion', before: { path: ['action'], equals: 'end' } } }))
    const again = await ask('undo-change', { changeId: ending.id })
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('not started again') })
  })

  it('schedule-price-change: a change for later inside the bounds (outside is refused); undo cancels it, and the cancelled change never runs', async () => {
    const at = new Date(Date.now() + 5 * DAY).toISOString()
    expect(await ask('schedule-price-change', { action: 'create', productId: ids.jacket, price: 150, at })).toMatchObject({ ok: false, error: expect.stringContaining('not scheduled') })
    const price = Number((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.jacket } }))).basePrice)
    const created = await askAndRun('schedule-price-change', { action: 'create', productId: ids.jacket, adjustPercent: 5, at })
    expect(created.preview).toMatchObject({ action: 'create', change: { masterPriceNow: price, wouldBe: Math.round(price * 1.05 * 100) / 100, changePercent: 5, daysAhead: 5 }, applies: expect.stringContaining('runs every minute') })
    const { scheduledChangeId } = (await changeOf(created.approvalId!)).after as { scheduledChangeId: string }
    await undo(created.approvalId!)
    expect((await inside(() => db().scheduledProductChange.findUniqueOrThrow({ where: { id: scheduledChangeId } }))).status).toBe('CANCELLED')
    await inside(() => db().$executeRawUnsafe(`UPDATE "ScheduledProductChange" SET "scheduledFor" = now() - interval '1 minute' WHERE id = $1`, scheduledChangeId))
    const { runScheduledChangesOnce } = await import('../../jobs/scheduled-changes.job.js')
    await inside(() => runScheduledChangesOnce())
    expect(Number((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.jacket } }))).basePrice)).toBe(price)
    expect((await inside(() => db().scheduledProductChange.findUniqueOrThrow({ where: { id: scheduledChangeId } }))).status).toBe('CANCELLED')
  })

  it('scheduled-price-changes counts the changes whose run died; schedule-price-change resolves one once a person approves', async () => {
    const { runScheduledChangesOnce } = await import('../../jobs/scheduled-changes.job.js')
    const { callTool } = await import('../agents/call-tool.js')
    const waiting = ((await inside(() => callTool(claude(), 'scheduled-price-changes', {}))).visible as Json).data.needsCheck as number
    const row = await inside(() => db().scheduledProductChange.create({
      data: { productId: ids.jacket, kind: 'PRICE', payload: { basePrice: 96 }, scheduledFor: new Date(Date.now() - 60 * 60_000), status: 'APPLYING' },
    }))
    await inside(() => db().scheduledProductChange.update({ where: { id: row.id }, data: { updatedAt: new Date(Date.now() - 60 * 60_000) } }))
    await inside(() => runScheduledChangesOnce())
    const listed = (await inside(() => callTool(claude(), 'scheduled-price-changes', { status: 'UNKNOWN' }))).visible as Json
    expect(listed.data.needsCheck).toBe(waiting + 1)
    expect(listed.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.id, status: 'UNKNOWN', check: expect.stringContaining('mark it applied or retry') })]))
    const resolved = await askAndRun('schedule-price-change', { action: 'resolve', productId: ids.jacket, scheduledChangeId: row.id, outcome: 'applied' })
    expect(resolved.preview).toMatchObject({ action: 'resolve', applies: expect.stringContaining('Closed as applied') })
    expect((await inside(() => db().scheduledProductChange.findUniqueOrThrow({ where: { id: row.id } }))).status).toBe('APPLIED')
    expect(((await inside(() => callTool(claude(), 'scheduled-price-changes', {}))).visible as Json).data.needsCheck).toBe(waiting)
  })
})

