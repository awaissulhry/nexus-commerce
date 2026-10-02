/**
 * MCP full control 08 S10 (lead finding) — two identical receives sent through the ROUTE at the same moment (a
 * double-click, a retried request) add the stock once. On a REAL multi-connection PostgreSQL.
 *
 * `receiveItems` read each line's received count, moved stock by target − received, and then wrote the line: two
 * receives of "5 received" on a line at 0 both read 0, both added 5, and the shelf showed 10 for 5 that arrived. Now
 * each line is locked while it is read and moved: the second finds 5 already received and moves nothing.
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
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

const WS = 'nexus_legacy_workspace'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const business = { workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }

describe.skipIf(!serverUrl)(`08 S10 — one receive per arrival through the route (needs ${CONCURRENT_PG_ENV})`, () => {
  let app: FastifyInstance
  const id: Record<string, string> = {}
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const stock = async () => Number((await q<{ quantity: number }>(`SELECT quantity FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $2`, [id.product, id.location]))[0]?.quantity ?? 0)
  const shipment = async (sku: string) => {
    const sid = randomUUID()
    const iid = randomUUID()
    await q(`INSERT INTO "InboundShipment" (id, "workspaceId", type, status, reference, "warehouseId", "updatedAt") VALUES ($1,$2,'SUPPLIER','ARRIVED',$3,$4,now())`, [sid, WS, `TEST-${sku}`, id.warehouse])
    await q(`INSERT INTO "InboundShipmentItem" (id, "workspaceId", "inboundShipmentId", "productId", sku, "quantityExpected") VALUES ($1,$2,$3,$4,$5,10)`, [iid, WS, sid, id.product, sku])
    return { sid, iid }
  }
  const receive = (sid: string, iid: string, quantityReceived: number) =>
    app.inject({ method: 'POST', url: `/api/fulfillment/inbound/${sid}/receive`, payload: { items: [{ itemId: iid, quantityReceived }] } })

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 16 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    id.warehouse = randomUUID()
    id.location = randomUUID()
    id.product = randomUUID()
    await q(`INSERT INTO "Warehouse" (id, "workspaceId", code, name, "isDefault", "updatedAt") VALUES ($1,$2,'IT-MAIN','Test main',true,now())`, [id.warehouse, WS])
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "warehouseId", "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Test main',$3,now())`, [id.location, WS, id.warehouse])
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,'TEST-SKU-S10-RACE','Test jacket',100,now())`, [id.product, WS])
    app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => { (request as { authUser?: { id: string } }).authUser = { id: 'u-s10-race' }; withWorkspace(business, done) })
    await app.register((await import('../../routes/fulfillment.routes.js')).default, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('CONTROL — one receive of 5: stock +5, the line at 5, one receipt', async () => {
    const { sid, iid } = await shipment('ONE')
    const before = await stock()
    expect((await receive(sid, iid, 5)).statusCode).toBe(200)
    expect(await stock()).toBe(before + 5)
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "InboundReceipt" WHERE "inboundShipmentItemId" = $1`, [iid]))[0].n).toBe(1)
  }, 60_000)

  it('R1 — five identical receives of "5 received" at the same moment: stock +5 once, the line at 5, one receipt', async () => {
    const { sid, iid } = await shipment('FIVE')
    const before = await stock()
    const answers = await Promise.all(Array.from({ length: 5 }, () => receive(sid, iid, 5)))
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 200, 200])
    expect(await stock()).toBe(before + 5)
    expect((await q<{ quantityReceived: number }>(`SELECT "quantityReceived" FROM "InboundShipmentItem" WHERE id = $1`, [iid]))[0].quantityReceived).toBe(5)
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "InboundReceipt" WHERE "inboundShipmentItemId" = $1`, [iid]))[0].n).toBe(1)
  }, 60_000)

  it('R2 — "3 received" and "5 received" at once: the line ends at one of them and stock moved by exactly that', async () => {
    const { sid, iid } = await shipment('MIXED')
    const before = await stock()
    await Promise.all([receive(sid, iid, 3), receive(sid, iid, 5)])
    const line = (await q<{ quantityReceived: number }>(`SELECT "quantityReceived" FROM "InboundShipmentItem" WHERE id = $1`, [iid]))[0].quantityReceived
    expect([3, 5]).toContain(line)
    expect(await stock()).toBe(before + line)
    const receipts = await q<{ quantity: number }>(`SELECT quantity FROM "InboundReceipt" WHERE "inboundShipmentItemId" = $1`, [iid])
    expect(receipts.reduce((n, r) => n + r.quantity, 0)).toBe(line)
  }, 60_000)
})
