/**
 * MCP full control 08 S6 — stock changes in Nexus, for the stock page and for Claude.
 *
 *   Routes: the set-on-hand cell (`POST /api/stock/adjust-location`, `/adjust-locations`), holds (`POST
 *   /api/stock/reserve`, `/release/:id`) and locations (`POST /api/stock/locations`, `PATCH`/`DELETE /:id`) keep their
 *   answers now that their work lives in `services/stock/` (location-adjust, stock-hold, location-write services).
 *   Written against the routes BEFORE the move and unchanged after it.
 *   Step 3 (cases): the same batch counts sealed cases per case size (`cases: [{ unitsPerCase, cases }]`) with the units
 *   of one cell, in ONE transaction; a refused count leaves the cell's units unsaved; a call without `cases` answers
 *   exactly as before.
 *   Tools: Claude's six stock changes through the doors a person uses (runOrQueueTool, then the Approvals page's
 *   schedule and commit): what each previews, what it changes once approved, how undo puts it back (a NEW request
 *   through the same gate), the staleness check when stock moved since the approval, and that Amazon FBA and Shopify
 *   locations are never changed.
 *
 * Real SQL (PGlite with the production schema); the real route plugin in a Fastify app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { CASE_COPY } from '@nexus/shared/stock-cases'
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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { main: '', second: '', fba: '', shop: '', jacket: '', gloves: '' }
let app: FastifyInstance

async function send(method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) })
  return { status: response.statusCode, body: response.json() }
}
const level = (productId: string, locationId: string) => inside(async () => (await database.client.stockLevel.findFirst({ where: { productId, locationId } })) ?? null)

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    const warehouse = await db.warehouse.create({ data: { code: 'TEST-MAIN-WH', name: 'Main', isDefault: true } as never })
    ids.main = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse', warehouseId: warehouse.id } })).id
    ids.second = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-SECOND', name: 'Second warehouse' } })).id
    ids.fba = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Amazon FBA' } })).id
    ids.shop = (await db.stockLocation.create({ data: { type: 'SHOPIFY_LOCATION', code: 'TEST-SHOP', name: 'Shopify shop' } })).id
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S6-JACKET', name: 'Test jacket', basePrice: '10.00', totalStock: 15 } })).id
    ids.gloves = (await db.product.create({ data: { sku: 'TEST-SKU-S6-GLOVES', name: 'Test gloves', basePrice: '5.00' } })).id
    for (const [productId, locationId, quantity] of [[ids.jacket, ids.main, 10], [ids.jacket, ids.fba, 5]] as const) {
      await db.stockLevel.create({ data: { productId, locationId, quantity, reserved: 0, available: quantity } })
    }
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  await app.register((await import('../../routes/stock.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
})

describe('08 S6 — the stock change routes answer as before', () => {
  it('POST /api/stock/adjust-location: sets on-hand; a no-op; FBA and Shopify read-only; bad input; unknown location', async () => {
    const set = await send('POST', '/api/stock/adjust-location', { productId: ids.jacket, locationId: ids.main, value: 12, reason: 'INVENTORY_COUNT', notes: 'TEST count' })
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({ ok: true, noop: false, movement: { change: 2, reason: 'INVENTORY_COUNT', notes: 'TEST count', actor: 'products-grid-location-edit' } })
    expect(Object.keys(set.body).sort()).toEqual(['movement', 'noop', 'ok', 'totals'])
    expect((await level(ids.jacket, ids.main))?.quantity).toBe(12)
    expect(await send('POST', '/api/stock/adjust-location', { productId: ids.jacket, locationId: ids.main, value: 12 })).toMatchObject({ status: 200, body: { ok: true, noop: true, movement: null } })
    expect(await send('POST', '/api/stock/adjust-location', { productId: ids.jacket, locationId: ids.fba, value: 1 })).toEqual({ status: 400, body: { error: 'FBA stock cannot be edited directly — Amazon is the source of truth.', code: 'FBA_READ_ONLY' } })
    expect((await send('POST', '/api/stock/adjust-location', { productId: ids.jacket, locationId: ids.shop, value: 1 })).body.code).toBe('SHOPIFY_SYNCED_READ_ONLY')
    expect((await send('POST', '/api/stock/adjust-location', { productId: ids.jacket, locationId: ids.main, value: -1 })).body).toMatchObject({ code: 'INVALID_VALUE' })
    expect(await send('POST', '/api/stock/adjust-location', { productId: ids.jacket })).toEqual({ status: 400, body: { error: 'productId and locationId are required', code: 'MISSING_FIELDS' } })
    expect(await send('POST', '/api/stock/adjust-location', { productId: ids.jacket, locationId: 'nope', value: 1 })).toEqual({ status: 404, body: { error: 'Location not found', code: 'NO_LOCATION' } })
  })

  it('POST /api/stock/adjust-locations: each change answers for itself; empty, malformed and too many', async () => {
    const out = await send('POST', '/api/stock/adjust-locations', {
      reason: 'WRITE_OFF', notes: ' TEST batch ',
      changes: [
        { productId: ids.jacket, locationId: ids.main, value: 11 },
        { productId: ids.jacket, locationId: ids.fba, value: 1 },
        { productId: ids.gloves, locationId: ids.second, value: 3 },
        { productId: ids.gloves },
      ],
    })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({
      ok: false,
      results: [
        { productId: ids.jacket, locationId: ids.main, ok: true, noop: false, quantity: 11, reserved: 0, available: 11 },
        { productId: ids.jacket, locationId: ids.fba, ok: false, error: 'FBA stock cannot be edited directly — Amazon is the source of truth.', code: 'FBA_READ_ONLY' },
        { productId: ids.gloves, locationId: ids.second, ok: true, noop: false, quantity: 3, reserved: 0, available: 3 },
        { productId: ids.gloves, locationId: '', ok: false, error: 'productId and locationId are required', code: 'MISSING_FIELDS' },
      ],
    })
    expect(await send('POST', '/api/stock/adjust-locations', { changes: [] })).toEqual({ status: 200, body: { ok: true, results: [] } })
    expect(await send('POST', '/api/stock/adjust-locations', {})).toEqual({ status: 400, body: { error: '`changes` must be an array', code: 'MISSING_FIELDS' } })
    expect(await send('POST', '/api/stock/adjust-locations', { changes: Array.from({ length: 501 }, () => ({})) })).toEqual({ status: 400, body: { error: 'At most 500 changes per batch', code: 'TOO_MANY' } })
  })

  it('POST /api/stock/reserve and /release/:id: a hold and its release; bad input', async () => {
    const held = await send('POST', '/api/stock/reserve', { productId: ids.jacket, locationId: ids.main, quantity: 2, reason: 'MANUAL_HOLD' })
    expect(held.status).toBe(200)
    expect(held.body).toMatchObject({ ok: true, reservation: { quantity: 2, reason: 'MANUAL_HOLD', releasedAt: null, consumedAt: null } })
    expect((await level(ids.jacket, ids.main))).toMatchObject({ quantity: 11, reserved: 2, available: 9 })
    const released = await send('POST', `/api/stock/release/${held.body.reservation.id}`)
    expect(released.status).toBe(200)
    expect(released.body).toMatchObject({ ok: true, reservation: { id: held.body.reservation.id, releasedAt: expect.any(String) } })
    expect((await level(ids.jacket, ids.main))).toMatchObject({ reserved: 0, available: 11 })
    expect(await send('POST', '/api/stock/reserve', { productId: ids.jacket })).toEqual({ status: 400, body: { error: 'productId, locationId required' } })
    expect(await send('POST', '/api/stock/reserve', { productId: ids.jacket, locationId: ids.main, quantity: 0 })).toEqual({ status: 400, body: { error: 'quantity must be > 0' } })
    expect((await send('POST', '/api/stock/reserve', { productId: ids.jacket, locationId: ids.main, quantity: 99 })).status).toBe(400)
    expect((await send('POST', '/api/stock/release/nope')).status).toBe(400)
  })

  it('POST, PATCH and DELETE /api/stock/locations: create, rename, deactivate; duplicates, bad codes, built-in locations', async () => {
    const created = await send('POST', '/api/stock/locations', { name: ' Third ', code: 'test-third', type: 'WAREHOUSE', servesMarketplaces: ['IT'] })
    expect(created.status).toBe(201)
    expect(created.body.location).toMatchObject({ name: 'Third', code: 'TEST-THIRD', type: 'WAREHOUSE', servesMarketplaces: ['IT'], isActive: true })
    expect(await send('POST', '/api/stock/locations', { name: 'Again', code: 'TEST-THIRD', type: 'WAREHOUSE', servesMarketplaces: [] })).toEqual({ status: 409, body: { error: 'Location code TEST-THIRD already exists' } })
    expect(await send('POST', '/api/stock/locations', { name: 'Bad', code: 'no spaces', type: 'WAREHOUSE', servesMarketplaces: [] })).toEqual({ status: 400, body: { error: 'code must be uppercase alphanumeric with hyphens, 1–30 chars' } })
    expect(await send('POST', '/api/stock/locations', { name: 'Bad', code: 'X', type: 'SHOPIFY_LOCATION', servesMarketplaces: [] })).toEqual({ status: 400, body: { error: 'type must be WAREHOUSE or AMAZON_FBA' } })
    expect(await send('POST', '/api/stock/locations', { code: 'X', type: 'WAREHOUSE' })).toEqual({ status: 400, body: { error: 'name is required' } })
    const id = created.body.location.id
    const renamed = await send('PATCH', `/api/stock/locations/${id}`, { name: ' Third renamed ', isActive: false })
    expect(renamed.body.location).toMatchObject({ name: 'Third renamed', isActive: false })
    expect(await send('PATCH', `/api/stock/locations/${ids.main}`, { isActive: false })).toEqual({ status: 409, body: { error: 'Choose another default warehouse before deactivating this location.' } })
    expect(await send('PATCH', '/api/stock/locations/nope', { name: 'x' })).toEqual({ status: 404, body: { error: 'Location not found' } })
    // Step 2 — a location that still holds units is not switched off (a switched-off warehouse feeds no listing).
    expect(await send('DELETE', `/api/stock/locations/${ids.second}`)).toEqual({ status: 409, body: { error: 'TEST-SECOND still holds 3 units: move or count them out first. A location is switched off only at 0.' } })
    expect(await send('DELETE', `/api/stock/locations/${id}`)).toEqual({ status: 200, body: { ok: true } })
    expect(await send('DELETE', `/api/stock/locations/${ids.main}`)).toEqual({ status: 409, body: { error: 'Built-in location TEST-MAIN cannot be deactivated here' } })
    expect(await send('DELETE', '/api/stock/locations/nope')).toEqual({ status: 404, body: { error: 'Location not found' } })
    await inside(() => database.client.stockLocation.update({ where: { id: ids.second }, data: { isActive: true } }))
  })
})

// ── Claude's stock changes ─────────────────────────────────────────────────────────────────────────────

describe("08 S6 — Claude's stock changes, approved, run and undone", { timeout: 60_000 }, () => {
  const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
  let approverId = ''
  const claude = () => ({ kind: 'user' as const, userId: approverId, label: 'S6 Approver', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'claude' as const })
  const db = () => database.client

  /** Claude asks; the change waits for a person (forceAsk as Claude's door does). */
  async function ask(tool: string, args: Record<string, unknown>) {
    const { runOrQueueTool } = await import('../agents/approval-gate.service.js')
    const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: approverId, via: 'claude' } }))
    return inside(() => runOrQueueTool(tool, args, claude(), run.id, { forceAsk: true }))
  }
  /** A person approves it on the Approvals page, the undo window closes, and the sweep runs it. */
  async function approveAndRun(approvalId: string, between?: () => Promise<unknown>) {
    const { commitScheduledApproval, scheduleApproval } = await import('../agent-fleet/approval-inbox.service.js')
    const parked = await inside(() => scheduleApproval({ id: approvalId, actor: claude() as never }))
    expect(parked, (parked as { error?: string }).error).toMatchObject({ ok: true, status: 'scheduled' })
    if (between) await between()
    await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
    return inside(() => commitScheduledApproval(approvalId))
  }
  async function askAndRun(tool: string, args: Record<string, unknown>) {
    const queued = await ask(tool, args)
    expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    return queued.approvalId!
  }
  /** Undo the change an approval made: undo-change asks for the inverse, a person approves it, it runs. */
  async function undo(approvalId: string) {
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
    const asked = await ask('undo-change', { changeId: change.id })
    expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
    const ran = await approveAndRun(asked.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  }
  const qty = async (productId: string, locationId: string) => (await level(productId, locationId))?.quantity ?? 0
  const fbaBefore = { quantity: 0 }

  beforeAll(async () => {
    vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
    vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
    const client = database.client
    const role = await client.role.create({ data: { key: `S6_${randomUUID().slice(0, 8)}`, name: 'S6 approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
    const approver = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'S6 Approver' } })
    approverId = approver.id
    await client.userRole.create({ data: { userId: approver.id, roleId: role.id } })
    const membership = await client.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: approver.id, status: 'active' } })
    await client.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    fbaBefore.quantity = await qty(ids.jacket, ids.fba)
  })

  it('set-stock: refuses FBA and Shopify locations; sets the count once approved; undo sets the old count back', async () => {
    expect(await ask('set-stock', { items: [{ productId: ids.jacket, location: 'TEST-FBA', quantity: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining('FBA stock cannot be edited directly') })
    expect(await ask('set-stock', { items: [{ productId: ids.jacket, location: 'TEST-SHOP', quantity: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining('Shopify location stock') })
    const start = await qty(ids.jacket, ids.main)
    const queued = await ask('set-stock', { items: [{ productId: ids.jacket, location: 'test-main', quantity: start + 4 }], reason: 'INVENTORY_COUNT' })
    expect(queued).toMatchObject({ ok: true, mode: 'queued', preview: { changes: [{ sku: 'TEST-SKU-S6-JACKET', location: 'TEST-MAIN', from: start, to: start + 4, delta: 4 }], totals: { rows: 1, unitsUp: 4 } } })
    expect(await qty(ids.jacket, ids.main)).toBe(start) // nothing before a person approves
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(await qty(ids.jacket, ids.main)).toBe(start + 4)
    await undo(queued.approvalId!)
    expect(await qty(ids.jacket, ids.main)).toBe(start)
  })

  it('set-stock: a sale between the approval and the run makes it stale — handed back, nothing changed', async () => {
    const start = await qty(ids.jacket, ids.main)
    const queued = await ask('set-stock', { items: [{ productId: ids.jacket, location: 'TEST-MAIN', quantity: start + 1 }] })
    const { applyStockMovement } = await import('../stock-movement.service.js')
    const ran = await approveAndRun(queued.approvalId!, () => inside(() => applyStockMovement({ productId: ids.jacket, locationId: ids.main, change: -1, reason: 'ORDER_PLACED' })))
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('changes') })
    expect(await qty(ids.jacket, ids.main)).toBe(start - 1)
    expect((await inside(() => db().agentApproval.findUniqueOrThrow({ where: { id: queued.approvalId! } }))).status).toBe('pending')
  })

  it('transfer-stock: moves units in one transaction; refuses more than is available and FBA; undo moves them back', async () => {
    expect(await ask('transfer-stock', { items: [{ productId: ids.jacket, fromLocation: 'TEST-MAIN', toLocation: 'TEST-FBA', quantity: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon FBA stock') })
    expect(await ask('transfer-stock', { items: [{ productId: ids.jacket, fromLocation: 'TEST-MAIN', toLocation: 'TEST-SECOND', quantity: 999 }] })).toMatchObject({ ok: false, error: expect.stringContaining('available at TEST-MAIN') })
    const [main, second] = [await qty(ids.jacket, ids.main), await qty(ids.jacket, ids.second)]
    const approvalId = await askAndRun('transfer-stock', { items: [{ productId: ids.jacket, fromLocation: 'TEST-MAIN', toLocation: 'TEST-SECOND', quantity: 3 }] })
    expect([await qty(ids.jacket, ids.main), await qty(ids.jacket, ids.second)]).toEqual([main - 3, second + 3])
    await undo(approvalId)
    expect([await qty(ids.jacket, ids.main), await qty(ids.jacket, ids.second)]).toEqual([main, second])
  })

  it('stock-count and reconcile-stock-count: create (undo cancels it), start, record (undo puts the old count back), reconcile (undo sets the stock back)', async () => {
    const created = await askAndRun('stock-count', { action: 'create', location: 'TEST-SECOND', note: 'TEST tool count' })
    const countId = (await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: created } }))).after as { countId: string }
    await undo(created)
    expect((await inside(() => db().cycleCount.findUniqueOrThrow({ where: { id: countId.countId } }))).status).toBe('CANCELLED')

    const second = await askAndRun('stock-count', { action: 'create', location: 'TEST-SECOND' })
    const { countId: id } = (await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId: second } }))).after as { countId: string }
    await askAndRun('stock-count', { action: 'start', countId: id })
    const expected = await qty(ids.jacket, ids.second)
    await askAndRun('stock-count', { action: 'record', countId: id, items: [{ productId: ids.jacket, counted: expected + 1 }] })
    const recorded = await askAndRun('stock-count', { action: 'record', countId: id, items: [{ productId: ids.jacket, counted: expected + 2 }] })
    await undo(recorded)
    const item = () => inside(() => db().cycleCountItem.findFirstOrThrow({ where: { cycleCountId: id, productId: ids.jacket } }))
    expect((await item()).countedQuantity).toBe(expected + 1)

    const queued = await ask('reconcile-stock-count', { countId: id, productIds: [ids.jacket] })
    expect(queued).toMatchObject({ ok: true, mode: 'queued', preview: { variances: [{ sku: 'TEST-SKU-S6-JACKET', expected, counted: expected + 1, variance: 1, stockNow: expected, stockAfter: expected + 1 }] } })
    const ran = await approveAndRun(queued.approvalId!)
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(await qty(ids.jacket, ids.second)).toBe(expected + 1)
    expect((await item()).status).toBe('RECONCILED')
    await undo(queued.approvalId!)
    expect(await qty(ids.jacket, ids.second)).toBe(expected)
  })

  it('reconcile-stock-count: refused at an FBA location; stale when stock moved after the approval', async () => {
    const fbaCount = await inside(() => db().cycleCount.create({ data: { locationId: ids.fba, status: 'IN_PROGRESS', items: { create: [{ productId: ids.jacket, sku: 'TEST-SKU-S6-JACKET', expectedQuantity: 5, countedQuantity: 4, status: 'COUNTED' }] } } }))
    expect(await ask('reconcile-stock-count', { countId: fbaCount.id })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon FBA stock') })
    const main = await qty(ids.jacket, ids.main)
    const count = await inside(() => db().cycleCount.create({ data: { locationId: ids.main, status: 'IN_PROGRESS', items: { create: [{ productId: ids.jacket, sku: 'TEST-SKU-S6-JACKET', expectedQuantity: main, countedQuantity: main - 1, status: 'COUNTED' }] } } }))
    const queued = await ask('reconcile-stock-count', { countId: count.id })
    const { applyStockMovement } = await import('../stock-movement.service.js')
    const ran = await approveAndRun(queued.approvalId!, () => inside(() => applyStockMovement({ productId: ids.jacket, locationId: ids.main, change: -1, reason: 'ORDER_PLACED' })))
    expect(ran).toMatchObject({ ok: false })
    expect(await qty(ids.jacket, ids.main)).toBe(main - 1)
  })

  it('reserve-stock: holds units (undo releases them); an order\'s hold and FBA are refused', async () => {
    expect(await ask('reserve-stock', { action: 'reserve', productId: ids.jacket, location: 'TEST-FBA', quantity: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon FBA stock') })
    const before = await level(ids.jacket, ids.main)
    const approvalId = await askAndRun('reserve-stock', { action: 'reserve', productId: ids.jacket, location: 'TEST-MAIN', quantity: 2, days: 3 })
    expect(await level(ids.jacket, ids.main)).toMatchObject({ reserved: before!.reserved + 2, available: before!.available - 2 })
    await undo(approvalId)
    expect(await level(ids.jacket, ids.main)).toMatchObject({ reserved: before!.reserved, available: before!.available })
    const { reserveStock } = await import('../stock-level.service.js')
    const orderHold = await inside(() => reserveStock({ productId: ids.jacket, locationId: ids.main, quantity: 1, reason: 'PENDING_ORDER' }))
    expect(await ask('reserve-stock', { action: 'release', productId: ids.jacket, reservationId: orderHold.id })).toMatchObject({ ok: false, error: expect.stringContaining("an order's") })
  })

  it('set-stock-location: rename (undo renames back); create (undo switches it off); a warehouse with stock is not switched off; FBA refused', async () => {
    const renamed = await askAndRun('set-stock-location', { action: 'rename', location: 'TEST-SECOND', name: 'Second, renamed' })
    expect((await inside(() => db().stockLocation.findUniqueOrThrow({ where: { id: ids.second } }))).name).toBe('Second, renamed')
    await undo(renamed)
    expect((await inside(() => db().stockLocation.findUniqueOrThrow({ where: { id: ids.second } }))).name).toBe('Second warehouse')
    const created = await askAndRun('set-stock-location', { action: 'create', location: 'test-fourth', name: 'Fourth' })
    expect(await inside(() => db().stockLocation.findFirst({ where: { code: 'TEST-FOURTH' }, select: { type: true, isActive: true } }))).toEqual({ type: 'WAREHOUSE', isActive: true })
    await undo(created)
    expect((await inside(() => db().stockLocation.findFirstOrThrow({ where: { code: 'TEST-FOURTH' } }))).isActive).toBe(false)
    expect(await ask('set-stock-location', { action: 'archive', location: 'TEST-SECOND' })).toMatchObject({ ok: false, error: expect.stringContaining('still holds') })
    expect(await ask('set-stock-location', { action: 'rename', location: 'TEST-FBA', name: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon FBA stock') })
  })

  it('no stock change ever touched the FBA mirror', async () => {
    expect(await qty(ids.jacket, ids.fba)).toBe(fbaBefore.quantity)
    expect(await inside(() => db().stockMovement.count({ where: { locationId: ids.fba } }))).toBe(0)
  })
})


// ── Step 3: sealed cases in the same batch ─────────────────────────────────────────────────────────────

describe('Step 3 — sealed cases are counted in the batch, with the units of the same cell', () => {
  const box = { id: '', loose: '' }
  const batch = (changes: unknown[]) => send('POST', '/api/stock/adjust-locations', { reason: 'INVENTORY_COUNT', notes: 'TEST cases', changes })
  /** The STORED sealed count at one level (null = no row). */
  const stored = (productId: string, locationId: string) => inside(async () => {
    const lvl = await database.client.stockLevel.findFirst({ where: { productId, locationId }, select: { id: true } })
    return lvl ? ((await database.client.stockCaseCount.findFirst({ where: { stockLevelId: lvl.id }, select: { cases: true } }))?.cases ?? null) : null
  })
  /** Sealed cases of the 12 / case size, as the wire carries them. */
  const c = (n: number) => [{ unitsPerCase: 12, cases: n }]
  const movements = (productId: string) => inside(() => database.client.stockMovement.count({ where: { productId } }))

  beforeAll(async () => {
    await inside(async () => {
      const db = database.client
      box.id = (await db.product.create({ data: { sku: 'TEST-SKU-S3C-BOX', name: 'Test box', basePrice: '9.00', totalStock: 24 } })).id
      box.loose = (await db.product.create({ data: { sku: 'TEST-SKU-S3C-LOOSE', name: 'Test loose', basePrice: '9.00' } })).id
      await db.stockLevel.create({ data: { productId: box.id, locationId: ids.main, quantity: 24, reserved: 0, available: 24 } })
      await db.stockLevel.create({ data: { productId: box.id, locationId: ids.fba, quantity: 12, reserved: 0, available: 12 } })
      await db.productCaseSize.create({ data: { productId: box.id, unitsPerCase: 12 } })
    })
  })

  it('a case-only count: the sealed cases are saved, no unit moves, one 0-unit movement logs it; the answer carries `cases`', async () => {
    const before = await movements(box.id)
    const out = await batch([{ productId: box.id, locationId: ids.main, cases: c(1) }])
    expect(out).toEqual({ status: 200, body: { ok: true, results: [{ productId: box.id, locationId: ids.main, ok: true, noop: false, quantity: 24, reserved: 0, available: 24, cases: c(1) }] } })
    expect(await stored(box.id, ids.main)).toBe(1)
    expect((await level(box.id, ids.main))?.quantity).toBe(24)
    expect(await movements(box.id)).toBe(before + 1)
    const logged = await inside(() => database.client.stockMovement.findFirst({ where: { productId: box.id, referenceType: 'CaseCount' }, orderBy: { createdAt: 'desc' } }))
    expect(logged).toMatchObject({ change: 0, reason: 'INVENTORY_COUNT', locationId: ids.main, actor: 'products-next-inventory-editor' })
    // The same count again changes nothing.
    expect((await batch([{ productId: box.id, locationId: ids.main, value: 24, cases: c(1) }])).body.results[0]).toMatchObject({ ok: true, noop: true, cases: c(1) })
    expect(await movements(box.id)).toBe(before + 1)
  })

  it('ONE transaction: the count is checked against the NEW units, and a refused count leaves the units unsaved too', async () => {
    // 3 cases need 36 units: refused at today's 24, allowed with the 36 counted in the same cell.
    const up = await batch([{ productId: box.id, locationId: ids.main, value: 36, cases: c(3) }])
    expect(up.body.results).toEqual([{ productId: box.id, locationId: ids.main, ok: true, noop: false, quantity: 36, reserved: 0, available: 36, cases: c(3) }])
    expect(await stored(box.id, ids.main)).toBe(3)
    const before = await movements(box.id)
    const refused = await batch([{ productId: box.id, locationId: ids.main, value: 30, cases: c(3) }])
    expect(refused.body).toEqual({ ok: false, results: [{ productId: box.id, locationId: ids.main, ok: false, code: 'CASES_EXCEED_UNITS', error: CASE_COPY.exceeds(c(3), 30) }] })
    expect((await level(box.id, ids.main))?.quantity).toBe(36)
    expect(await stored(box.id, ids.main)).toBe(3)
    expect(await movements(box.id)).toBe(before)
  })

  it('lowering the units opens a case (loose first): a units-only change answers as before, and the count follows', async () => {
    const out = await batch([{ productId: box.id, locationId: ids.main, value: 35 }])
    expect(out.body.results).toEqual([{ productId: box.id, locationId: ids.main, ok: true, noop: false, quantity: 35, reserved: 0, available: 35 }])
    expect(await stored(box.id, ids.main)).toBe(2) // 3 × 12 = 36 > 35 → one case opened
  })

  it('each refusal by its code, each change answering for itself', async () => {
    const out = await batch([
      { productId: box.loose, locationId: ids.main, cases: c(1) },
      { productId: box.id, locationId: ids.fba, cases: c(1) },
      { productId: box.id, locationId: ids.shop, cases: c(1) },
      { productId: box.id, locationId: ids.fba, value: 3, cases: c(0) },
      { productId: box.id, locationId: ids.main, cases: c(-1) },
      { productId: box.id, locationId: ids.main, cases: c(1.5) },
      { productId: box.id, locationId: ids.main, cases: 2 },
      { productId: box.id, locationId: 'nope', cases: c(1) },
      { productId: box.loose, locationId: ids.second, cases: c(0) },
      { productId: box.id, locationId: ids.main, cases: [{ unitsPerCase: 6, cases: 1 }] },
    ])
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(false)
    expect(out.body.results.map((r: Json) => [r.ok, r.code ?? null])).toEqual([
      [false, 'NO_CASE_SIZE'],
      [false, 'NOT_A_WAREHOUSE'],
      [false, 'NOT_A_WAREHOUSE'],
      [false, 'FBA_READ_ONLY'],
      [false, 'INVALID_CASES'],
      [false, 'INVALID_CASES'],
      [false, 'INVALID_CASES'],
      [false, 'NO_LOCATION'],
      [true, null],
      [false, 'NO_CASE_SIZE'],
    ])
    expect(out.body.results[0].error).toBe(CASE_COPY.noSize)
    expect(out.body.results[1].error).toBe(CASE_COPY.notHere)
    expect(out.body.results[4].error).toBe(CASE_COPY.invalidCases)
    expect(out.body.results[6].error).toBe('Each sealed count names its case size (units per case)') // an older page's plain number
    expect(out.body.results[9].error).toBe(CASE_COPY.noSizeOf(6))
    // 0 sealed cases is always allowed at a warehouse — even without a case size; nothing to change.
    expect(out.body.results[8]).toEqual({ productId: box.loose, locationId: ids.second, ok: true, noop: true, quantity: 0, reserved: 0, available: 0, cases: [] })
    expect(await stored(box.id, ids.main)).toBe(2)
    expect(await inside(() => database.client.stockMovement.count({ where: { productId: box.id, locationId: ids.fba } }))).toBe(0)
  })

  it('the single cell route takes `cases` too; a call without `cases` answers exactly as before (Claude\'s set-stock, the products grid)', async () => {
    const single = await send('POST', '/api/stock/adjust-location', { productId: box.id, locationId: ids.main, cases: c(1) })
    expect(single.status).toBe(200)
    expect(single.body).toMatchObject({ ok: true, noop: false, movement: null, cases: c(1) })
    expect(Object.keys(single.body).sort()).toEqual(['cases', 'movement', 'noop', 'ok', 'totals'])
    expect(await send('POST', '/api/stock/adjust-location', { productId: box.id, locationId: ids.main, cases: c(9) })).toEqual({ status: 400, body: { error: CASE_COPY.exceeds(c(9), 35), code: 'CASES_EXCEED_UNITS' } })
    expect(await send('POST', '/api/stock/adjust-location', { productId: box.id, locationId: ids.main, value: 30, cases: c(9) })).toMatchObject({ status: 400, body: { code: 'CASES_EXCEED_UNITS' } })
    expect((await level(box.id, ids.main))?.quantity).toBe(35)

    const { adjustOneLocation } = await import('./location-adjust.service.js')
    const mcp = await inside(() => adjustOneLocation({ productId: box.id, locationId: ids.main, value: 34, reason: 'INVENTORY_COUNT', actor: 'agent:set-stock' }))
    expect(Object.keys(mcp).sort()).toEqual(['available', 'movement', 'noop', 'quantity', 'reserved', 'totals'])
    expect(mcp).toMatchObject({ noop: false, quantity: 34, movement: { change: -1, reason: 'INVENTORY_COUNT', actor: 'agent:set-stock' } })
    expect(await stored(box.id, ids.main)).toBe(1)
    const unitsOnly = await send('POST', '/api/stock/adjust-location', { productId: box.id, locationId: ids.main, value: 34 })
    expect(Object.keys(unitsOnly.body).sort()).toEqual(['movement', 'noop', 'ok', 'totals'])
  })
})
