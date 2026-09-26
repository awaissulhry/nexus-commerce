/**
 * CX Etsy E3/E4/E5 — the one receipt writer, the webhook handler and the poller, on a real
 * multi-connection PostgreSQL with the generated policies (profiles ON). Only Etsy's HTTP answers
 * are faked (`read-client.js`); the ledger, the writer, the stock primitives, the database clock,
 * the locks and the row policies are real.
 *
 * Owner rulings under test: S1 — hold on paid, take out on shipment, give back on cancel before
 * shipment; after shipment nothing is put back and the owner is told. H1 — from activation only.
 * Stock model (2026-09-26): one hold per (order, product) for all its lines (R10), taken out when the
 * WHOLE receipt has shipped (R3; a partial shipment keeps the hold and tells the owners), and a stock
 * problem on a line is recorded and told, never blocking the receipt or the poll (R5).
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL; SKIPS without it. Run by scripts/run-real-postgres-tests.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

/** A fake Etsy: per account, a shop id and its receipts; `failWith` makes every call answer that status. */
const etsy = vi.hoisted(() => ({
  shops: new Map<string, { shopId: string; receipts: Map<string, Record<string, unknown>>; failWith: number | null; listCalls: string[]; afterList?: (call: number) => void | Promise<void>; transformList?: (page: { count: number; results: Record<string, unknown>[] }, query: URLSearchParams) => unknown }>(),
}))
vi.mock('./read-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./read-client.js')>()
  return {
    ...original,
    etsyReader: vi.fn(async (accountId: string) => {
      const shop = etsy.shops.get(accountId)
      if (!shop) throw new Error('The Etsy account has no verified shop identity.')
      return {
        shopId: shop.shopId,
        get: async (path: string) => {
          if (shop.failWith) throw new original.EtsyReadError(shop.failWith)
          const one = /^\/shops\/(\d+)\/receipts\/(\d+)$/.exec(path)
          if (one) {
            const found = shop.receipts.get(one[2])
            if (!found || one[1] !== shop.shopId) throw new original.EtsyReadError(404)
            return structuredClone(found)
          }
          const list = /^\/shops\/(\d+)\/receipts\?/.exec(path)
          if (list) {
            shop.listCalls.push(path)
            const params = new URL(path, 'https://etsy.invalid').searchParams
            const [limit, offset] = [Number(params.get('limit')), Number(params.get('offset'))]
            const rows = [...shop.receipts.values()].filter((r) =>
              (!params.has('min_created') || (r.created_timestamp as number) >= Number(params.get('min_created'))) &&
              (!params.has('max_created') || (r.created_timestamp as number) <= Number(params.get('max_created'))) &&
              (!params.has('min_last_modified') || (r.updated_timestamp as number) >= Number(params.get('min_last_modified'))))
            const sort = params.get('sort_on') === 'receipt_id' ? 'receipt_id' : 'updated_timestamp'
            const direction = params.get('sort_order') === 'desc' ? -1 : 1
            rows.sort((a, b) => direction * ((a[sort] as number) - (b[sort] as number)))
            const page = { count: rows.length, results: rows.slice(offset, offset + limit).map((r) => structuredClone(r)) }
            await shop.afterList?.(shop.listCalls.length)
            return shop.transformList ? shop.transformList(page, params) : page
          }
          throw new Error(`unexpected Etsy path ${path}`)
        },
      }
    }),
  }
})

const B = 'ws_etsy_ingest'
const SELLER = 900000001
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const ingestBefore = process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST

type Json = Record<string, any>
let nextReceipt = 4_000_000_000
let nextTransaction = 5_000_000_000
/** Active Etsy connections must name different sellers (ChannelConnection_active_account_key). */
let nextSeller = SELLER
const sellerOf = new Map<string, number>()

describe.skipIf(!serverUrl)(`Etsy receipt ingest — writer, webhook, poller (needs ${CONCURRENT_PG_ENV})`, () => {
  let ingest: typeof import('./receipt-ingest.js')
  let routes: typeof import('../../routes/etsy-webhooks.routes.js')
  let poll: typeof import('../../jobs/etsy-receipts-poll.job.js')
  let ledger: typeof import('../cx/ingress/ledger.js')
  let claims: typeof import('../cx/ingress/claims.js')
  const id: Record<string, string> = {}
  const owner = randomUUID()
  let nowSec = 0

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const level = async (productId: string) => {
    const [row] = await q<{ quantity: number; reserved: number; available: number }>(`SELECT quantity, reserved, available FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $2`, [productId, id.itMain])
    return row ? [row.quantity, row.reserved, row.available] : null
  }
  const product = async (sku: string, quantity: number, withLevel = true) => {
    const pid = randomUUID()
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [pid, B, sku, quantity])
    if (withLevel) await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), B, id.itMain, pid, quantity])
    return pid
  }
  const connection = async (shopId: string, options: { active?: boolean; activate?: boolean } = {}) => {
    const cid = randomUUID()
    const seller = nextSeller++
    sellerOf.set(cid, seller)
    await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "isActive", "externalAccountId", identity, "updatedAt") VALUES ($1,$2,'ETSY',$3,$4,$5::jsonb,now())`,
      [cid, B, options.active ?? true, String(seller), JSON.stringify({ extra: { shopId } })])
    etsy.shops.set(cid, { shopId, receipts: new Map(), failWith: null, listCalls: [] })
    if (options.activate ?? true) await activate(cid)
    return cid
  }
  // Historical activation, with all receipt timestamps in the real database clock's past.
  const activate = async (cid: string) => {
    await inB(() => ingest.activateEtsyIngest(cid))
    await q(`UPDATE "EtsyReceiptIngest" SET "activatedAt" = date_trunc('second', clock_timestamp()) - interval '2 hours' WHERE "connectionId" = $1`, [cid])
  }
  const eur = (amount: number) => ({ amount, divisor: 100, currency_code: 'EUR' })
  const line = (over: Json = {}): Json => ({
    transaction_id: nextTransaction++, receipt_id: 0, seller_user_id: SELLER, buyer_user_id: 77, title: 'Wallet', listing_id: 1234,
    product_id: 5678, sku: 'WALLET', quantity: 1, price: eur(1999), shipping_cost: eur(0), created_timestamp: nowSec + 5,
    paid_timestamp: nowSec + 6, shipped_timestamp: null, is_digital: false, ...over,
  })
  /** A valid receipt created AFTER activation (unless told otherwise), with lines bound to it and to the account's seller. */
  const receipt = (lines: Json[], over: Json = {}, forConnection?: string): Json => {
    const receiptId = over.receipt_id ?? nextReceipt++
    const seller = sellerOf.get(forConnection ?? id.shop) ?? SELLER
    const bound = lines.map((l) => ({ ...l, receipt_id: receiptId, seller_user_id: seller }))
    const total = bound.reduce((sum, l) => sum + l.price.amount * l.quantity, 0)
    return {
      receipt_id: receiptId, receipt_type: 0, seller_user_id: seller, buyer_user_id: 77, buyer_email: null, name: 'A Buyer',
      first_line: 'Via Roma 1', second_line: '', city: 'Milano', state: null, zip: '20100', country_iso: 'IT', formatted_address: 'Via Roma 1',
      status: 'paid', is_paid: true, is_shipped: false, created_timestamp: nowSec + 5, updated_timestamp: nowSec + 10,
      grandtotal: eur(total + 500), subtotal: eur(total), total_price: eur(total), total_shipping_cost: eur(500), total_tax_cost: eur(0),
      total_vat_cost: eur(0), discount_amt: eur(0), gift_wrap_price: eur(0), transactions: bound, refunds: [], shipments: [], ...over,
    }
  }
  const publish = (connectionId: string, r: Json) => { etsy.shops.get(connectionId)!.receipts.set(String(r.receipt_id), structuredClone(r)) }
  const write = (connectionId: string, r: Json, extra: { deliveredEvent?: boolean } = {}) =>
    inB(async () => ingest.ingestEtsyReceipt({ connectionId, raw: structuredClone(r), binding: await ingest.etsyIngestBinding(connectionId), source: 'webhook', ...extra }))
  const orderOf = async (receiptId: unknown) => (await q<{ id: string; status: string; totalPrice: string; currencyCode: string; deliveredAtSource: string | null; meta: Json }>(
    `SELECT id, status::text AS status, "totalPrice"::text AS "totalPrice", "currencyCode", "deliveredAtSource", "etsyMetadata" AS meta FROM "Order" WHERE channel = 'ETSY' AND "channelOrderId" = $1`, [String(receiptId)]))
  const itemsOf = (orderId: string) => q<{ externalLineItemId: string; quantity: number; price: string; productId: string | null }>(`SELECT "externalLineItemId", quantity, price::text AS price, "productId" FROM "OrderItem" WHERE "orderId" = $1 ORDER BY "externalLineItemId"`, [orderId])
  /** The order's own holds, per product (one per order and product), with their state. */
  const holdsOf = (orderId: string) => q<{ productId: string; quantity: number; state: string }>(`SELECT lv."productId", r.quantity,
    CASE WHEN r."consumedAt" IS NOT NULL THEN 'consumed' WHEN r."releasedAt" IS NOT NULL THEN 'released' ELSE 'open' END AS state
    FROM "StockReservation" r JOIN "StockLevel" lv ON lv.id = r."stockLevelId" WHERE r."orderId" = $1 ORDER BY lv."productId", r."createdAt"`, [orderId])
  const stockOf = async (receiptId: unknown) => ((await orderOf(receiptId))[0]?.meta?.stock ?? {}) as Record<string, string>
  const byProduct = <T extends { productId: string }>(rows: T[]) => [...rows].sort((a, b) => (a.productId < b.productId ? -1 : 1))
  const ledgerRow = async (connectionId: string, eventType = 'order.paid', receiptId?: unknown) => {
    const written = await inB(() => ledger.recordInbound({
      channel: 'ETSY', eventType, externalId: `msg_${randomUUID()}`, payload: { event_type: eventType, shop_id: etsy.shops.get(connectionId)!.shopId, receipt_id: receiptId },
      signatureOk: true, verifiedBy: 'none', connectionId, status: 'pending',
    }))
    return written.id!
  }
  const rowOf = async (rowId: string) => (await q<{ status: string; attempts: number; deferred: boolean; lastError: string | null }>(
    `SELECT status, attempts, ("nextAttemptAt" > now() + interval '20 minutes') AS deferred, "lastError" FROM "WebhookEvent" WHERE id = $1`, [rowId]))[0]
  const notices = (type: string, entityId: string) => q(`SELECT id FROM "Notification" WHERE "workspaceId" = $1 AND type = $2 AND "entityId" = $3`, [B, type, entityId])

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '1'
    database = await concurrentDatabase({ maxConnections: 30 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)
    const role = randomUUID(), membership = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [role])
    await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,'owner@example.test','active',now())`, [owner])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Etsy test business','active','e3','e3',now())`, [B])
    await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [membership, B, owner])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [membership, role])
    id.itMain = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','IT-MAIN',now())`, [id.itMain, B])
    ingest = await import('./receipt-ingest.js')
    routes = await import('../../routes/etsy-webhooks.routes.js')
    poll = await import('../../jobs/etsy-receipts-poll.job.js')
    ledger = await import('../cx/ingress/ledger.js')
    claims = await import('../cx/ingress/claims.js')
    id.shop = await connection('10000001')
    nowSec = Number((await q<{ s: string }>(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS s`))[0].s) - 1800
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    if (ingestBefore === undefined) delete process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST
    else process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = ingestBefore
    await database?.close()
  }, 60_000)

  beforeEach(() => { process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '1' })

  describe('the writer (E3, S1 + H1)', () => {
    it('a paid receipt: one order, one item per transaction, exact money, raw minor units kept, each product HELD', async () => {
      const wallet = await product('W-1', 10), belt = await product('B-1', 10)
      const r = receipt([line({ sku: 'W-1', quantity: 2 }), line({ sku: 'B-1', quantity: 1, price: eur(1250) })])
      const outcome = await write(id.shop, r)
      expect(outcome).toMatchObject({ kind: 'written', created: true, status: 'PROCESSING', warnings: [] })
      const [order] = await orderOf(r.receipt_id)
      expect(order).toMatchObject({ status: 'PROCESSING', totalPrice: '57.48', currencyCode: 'EUR' })
      expect(order.meta.money.grandtotal).toEqual({ amount: 5748, divisor: 100, currency_code: 'EUR' })
      expect((await itemsOf(order.id)).map((i) => [i.quantity, i.price, i.productId])).toEqual([[2, '19.99', wallet], [1, '12.50', belt]])
      expect(await holdsOf(order.id)).toEqual(byProduct([{ productId: wallet, quantity: 2, state: 'open' }, { productId: belt, quantity: 1, state: 'open' }]))
      expect(await stockOf(r.receipt_id)).toEqual({ [r.transactions[0].transaction_id]: 'held', [r.transactions[1].transaction_id]: 'held' })
      expect([await level(wallet), await level(belt)]).toEqual([[10, 2, 8], [10, 1, 9]])
    })

    it('the same receipt delivered again, and five times at once (webhook, replay, poll): one order, one item per line and one hold per product', async () => {
      const pid = await product('W-2', 10)
      const r = receipt([line({ sku: 'W-2', quantity: 3 })])
      await write(id.shop, r)
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => write(id.shop, r)))
      expect(results.filter((x) => x.status === 'rejected')).toEqual([])
      const orders = await orderOf(r.receipt_id)
      expect(orders).toHaveLength(1)
      expect(await itemsOf(orders[0].id)).toHaveLength(1)
      expect(await holdsOf(orders[0].id)).toHaveLength(1)
      expect(await level(pid)).toEqual([10, 3, 7])
    }, 60_000)

    it('shipment takes the held stock out ONCE; a re-delivery takes nothing more; an older read changes nothing', async () => {
      const pid = await product('W-3', 10)
      const paid = receipt([line({ sku: 'W-3', quantity: 2 })])
      await write(id.shop, paid)
      const shipped = { ...structuredClone(paid), status: 'Completed', is_shipped: true, updated_timestamp: nowSec + 100 }
      shipped.transactions[0].shipped_timestamp = nowSec + 90
      expect(await write(id.shop, shipped)).toMatchObject({ kind: 'written', status: 'SHIPPED', consumed: 1 })
      expect(await write(id.shop, shipped)).toMatchObject({ kind: 'written', status: 'SHIPPED', consumed: 0 })
      expect(await level(pid)).toEqual([8, 0, 8])
      expect(await write(id.shop, paid)).toMatchObject({ kind: 'stale', storedUpdatedAt: nowSec + 100, incomingUpdatedAt: nowSec + 10 })
      const [order] = await orderOf(paid.receipt_id)
      expect(order.status).toBe('SHIPPED')
      expect(await level(pid)).toEqual([8, 0, 8])
    })

    it('SKU rename after a paid hold: simultaneous shipment replays settle the original line exactly once', async () => {
      const pid = await product('SKU-RENAME-PAID', 10)
      const paid = receipt([line({ sku: 'SKU-RENAME-PAID', quantity: 2 })])
      await write(id.shop, paid)
      const [order] = await orderOf(paid.receipt_id)
      await q(`UPDATE "Product" SET sku = 'SKU-RENAMED-PAID' WHERE id = $1`, [pid])
      const shipped = { ...structuredClone(paid), status: 'completed', is_shipped: true, updated_timestamp: nowSec + 100 }
      shipped.transactions[0].shipped_timestamp = nowSec + 90
      const results = await Promise.all(Array.from({ length: 5 }, () => write(id.shop, shipped)))
      for (const result of results) expect(result).toMatchObject({ kind: 'written', warnings: [] })
      expect(results.reduce((n, result) => n + (result.kind === 'written' ? result.consumed : 0), 0)).toBe(1)
      expect(await level(pid)).toEqual([8, 0, 8])
      expect(await itemsOf(order.id)).toEqual([expect.objectContaining({ productId: pid, quantity: 2 })])
      expect(await holdsOf(order.id)).toEqual([{ productId: pid, quantity: 2, state: 'consumed' }])
      expect(await q(`SELECT "productId", change FROM "StockMovement" WHERE "orderId" = $1 AND reason = 'RESERVATION_CONSUMED'`, [order.id])).toEqual([{ productId: pid, change: -2 }])
    })

    it('reusing a sold SKU for another product does not redirect its paid hold or report a false mapping refusal', async () => {
      const original = await product('SKU-REUSED-PAID', 10)
      const paid = receipt([line({ sku: 'SKU-REUSED-PAID', quantity: 2 })])
      await write(id.shop, paid)
      await q(`UPDATE "Product" SET sku = 'SKU-ORIGINAL-PAID' WHERE id = $1`, [original])
      const replacement = await product('SKU-REUSED-PAID', 10)
      expect(await write(id.shop, { ...paid, status: 'completed', is_shipped: true, updated_timestamp: nowSec + 100 })).toMatchObject({ kind: 'written', consumed: 1, warnings: [] })
      expect([await level(original), await level(replacement)]).toEqual([[8, 0, 8], [10, 0, 10]])
      const [order] = await orderOf(paid.receipt_id)
      expect((await itemsOf(order.id))[0].productId).toBe(original)
      expect(await holdsOf(order.id)).toEqual([{ productId: original, quantity: 2, state: 'consumed' }])
    })

    // Owner ruling 2026-09-26 (sanctioned change): an Etsy receipt is held as soon as it arrives, also
    // before payment. Before, this arm asserted an unpaid receipt held nothing.
    it('a persisted unpaid line keeps its product when its SKU is reused before the first paid shipment', async () => {
      const original = await product('SKU-REUSED-UNPAID', 10)
      const unpaid = receipt([line({ sku: 'SKU-REUSED-UNPAID', quantity: 2, paid_timestamp: null })], { status: 'open', is_paid: false })
      await write(id.shop, unpaid)
      const [order] = await orderOf(unpaid.receipt_id)
      expect(await holdsOf(order.id)).toEqual([{ productId: original, quantity: 2, state: 'open' }])
      await q(`UPDATE "Product" SET sku = 'SKU-ORIGINAL-UNPAID' WHERE id = $1`, [original])
      const replacement = await product('SKU-REUSED-UNPAID', 10)
      const shipped = { ...structuredClone(unpaid), status: 'completed', is_paid: true, is_shipped: true, updated_timestamp: nowSec + 100 }
      shipped.transactions[0].paid_timestamp = nowSec + 80
      shipped.transactions[0].shipped_timestamp = nowSec + 90
      expect(await write(id.shop, shipped)).toMatchObject({ kind: 'written', consumed: 1, warnings: [] })
      expect([await level(original), await level(replacement)]).toEqual([[8, 0, 8], [10, 0, 10]])
      expect(await holdsOf(order.id)).toEqual([{ productId: original, quantity: 2, state: 'consumed' }])
    })

    // Owner ruling 2026-09-26: hold on arrival, including while Etsy is still processing the payment (up
    // to about three days); give the hold back if the payment fails (Etsy cancels the receipt); take it
    // when the whole receipt has shipped.
    it('ruling: a receipt whose payment is processing is held on arrival; paid then shipped takes it once', async () => {
      const pid = await product('PROC-1', 10)
      const processing = receipt([line({ sku: 'PROC-1', quantity: 3, paid_timestamp: null })], { status: 'payment processing', is_paid: false })
      expect(await write(id.shop, processing)).toMatchObject({ kind: 'written', status: 'AWAITING_PAYMENT', warnings: [] })
      expect(await level(pid)).toEqual([10, 3, 7])
      expect(await stockOf(processing.receipt_id)).toEqual({ [processing.transactions[0].transaction_id]: 'held' })
      const paid = { ...structuredClone(processing), status: 'paid', is_paid: true, updated_timestamp: nowSec + 20 }
      paid.transactions[0].paid_timestamp = nowSec + 15
      expect(await write(id.shop, paid)).toMatchObject({ status: 'PROCESSING', consumed: 0 })
      expect(await level(pid)).toEqual([10, 3, 7])
      const shipped = { ...structuredClone(paid), status: 'completed', is_shipped: true, updated_timestamp: nowSec + 40 }
      shipped.transactions[0].shipped_timestamp = nowSec + 35
      expect(await write(id.shop, shipped)).toMatchObject({ status: 'SHIPPED', consumed: 1 })
      expect(await write(id.shop, shipped)).toMatchObject({ status: 'SHIPPED', consumed: 0 })
      expect(await level(pid)).toEqual([7, 0, 7])
      const [order] = await orderOf(processing.receipt_id)
      expect(await holdsOf(order.id)).toEqual([{ productId: pid, quantity: 3, state: 'consumed' }])
    })

    it('ruling: the payment fails (Etsy cancels the receipt before payment): the hold is given back, nothing is taken, nobody is told', async () => {
      const pid = await product('PROC-2', 10)
      const processing = receipt([line({ sku: 'PROC-2', quantity: 2, paid_timestamp: null })], { status: 'payment processing', is_paid: false })
      await write(id.shop, processing)
      expect(await level(pid)).toEqual([10, 2, 8])
      expect(await write(id.shop, { ...processing, status: 'canceled', updated_timestamp: nowSec + 30 })).toMatchObject({ status: 'CANCELLED', released: 1, warnings: [] })
      expect(await level(pid)).toEqual([10, 0, 10])
      const [order] = await orderOf(processing.receipt_id)
      expect(await holdsOf(order.id)).toEqual([{ productId: pid, quantity: 2, state: 'released' }])
      expect(await notices('channel-order-cancelled-after-shipment', order.id)).toHaveLength(0)
    })

    it('ruling: the webhook and the poll racing on a receipt in payment processing, then on its shipment: held once, taken once', async () => {
      const pid = await product('PROC-3', 10)
      const processing = receipt([line({ sku: 'PROC-3', quantity: 2, paid_timestamp: null })], { status: 'payment processing', is_paid: false })
      const viaPoll = (r: Json) => inB(async () => ingest.ingestEtsyReceipt({ connectionId: id.shop, raw: structuredClone(r), binding: await ingest.etsyIngestBinding(id.shop), source: 'poll' }))
      const first = await Promise.allSettled([write(id.shop, processing), viaPoll(processing), write(id.shop, processing), viaPoll(processing)])
      expect(first.filter((x) => x.status === 'rejected')).toEqual([])
      expect(await level(pid)).toEqual([10, 2, 8])
      const shipped = { ...structuredClone(processing), status: 'completed', is_paid: true, is_shipped: true, updated_timestamp: nowSec + 60 }
      shipped.transactions[0].paid_timestamp = nowSec + 50
      shipped.transactions[0].shipped_timestamp = nowSec + 55
      const second = await Promise.allSettled([write(id.shop, shipped), viaPoll(shipped), write(id.shop, shipped), viaPoll(shipped)])
      expect(second.filter((x) => x.status === 'rejected')).toEqual([])
      expect(await level(pid)).toEqual([8, 0, 8])
      const [order] = await orderOf(processing.receipt_id)
      expect(await holdsOf(order.id)).toEqual([{ productId: pid, quantity: 2, state: 'consumed' }])
    }, 60_000)

    it('an initially unmapped line can still gain its first product and persist that link on retry', async () => {
      const paid = receipt([line({ sku: 'SKU-MAPPED-LATER', quantity: 2 })])
      expect(await write(id.shop, paid)).toMatchObject({ kind: 'written', warnings: [expect.objectContaining({ code: 'unmapped_line' })] })
      const pid = await product('SKU-MAPPED-LATER', 10)
      expect(await write(id.shop, paid)).toMatchObject({ kind: 'written', warnings: [] })
      const [order] = await orderOf(paid.receipt_id)
      expect((await itemsOf(order.id))[0].productId).toBe(pid)
      expect(await level(pid)).toEqual([10, 2, 8])
      expect(await holdsOf(order.id)).toHaveLength(1)
    })

    // R3 (sanctioned change): before, a partial shipment took out the line that shipped (consumed 1,
    // [9, 0, 9]). Stock is now taken when the WHOLE receipt has shipped; a partial shipment keeps
    // every hold and tells the owners once.
    it('a partial shipment keeps every hold and tells the owners once; the whole shipment takes them out once', async () => {
      const a = await product('W-4', 10), b = await product('W-5', 10)
      const r = receipt([line({ sku: 'W-4', quantity: 1 }), line({ sku: 'W-5', quantity: 2 })])
      await write(id.shop, r)
      const partial = { ...structuredClone(r), updated_timestamp: nowSec + 50 }
      partial.transactions[0].shipped_timestamp = nowSec + 40
      expect(await write(id.shop, partial)).toMatchObject({ status: 'PARTIALLY_SHIPPED', consumed: 0, warnings: [expect.objectContaining({ code: 'partly_shipped' })] })
      expect(await write(id.shop, partial)).toMatchObject({ status: 'PARTIALLY_SHIPPED', consumed: 0 })
      expect([await level(a), await level(b)]).toEqual([[10, 1, 9], [10, 2, 8]])
      const [order] = await orderOf(r.receipt_id)
      expect(await notices('channel-order-partly-shipped', order.id)).toHaveLength(1)
      const whole = { ...structuredClone(partial), status: 'completed', is_shipped: true, updated_timestamp: nowSec + 70 }
      whole.transactions[1].shipped_timestamp = nowSec + 60
      expect(await write(id.shop, whole)).toMatchObject({ status: 'SHIPPED', consumed: 2 })
      expect(await write(id.shop, whole)).toMatchObject({ status: 'SHIPPED', consumed: 0 })
      expect([await level(a), await level(b)]).toEqual([[9, 0, 9], [8, 0, 8]])
    })

    it('cancelled before shipment: the holds are given back', async () => {
      const pid = await product('W-6', 10)
      const r = receipt([line({ sku: 'W-6', quantity: 4 })])
      await write(id.shop, r)
      expect(await level(pid)).toEqual([10, 4, 6])
      expect(await write(id.shop, { ...r, status: 'canceled', updated_timestamp: nowSec + 60 })).toMatchObject({ status: 'CANCELLED', released: 1, warnings: [] })
      expect(await level(pid)).toEqual([10, 0, 10])
      const [order] = await orderOf(r.receipt_id)
      expect(await holdsOf(order.id)).toEqual([{ productId: pid, quantity: 4, state: 'released' }])
      expect(await notices('channel-order-cancelled-after-shipment', order.id)).toHaveLength(0)
    })

    it('cancelled AFTER shipment: nothing is put back, and the owners are told', async () => {
      const pid = await product('W-7', 10)
      const r = receipt([line({ sku: 'W-7', quantity: 1 })])
      await write(id.shop, r)
      const shipped = { ...structuredClone(r), status: 'completed', is_shipped: true, updated_timestamp: nowSec + 100 }
      await write(id.shop, shipped)
      const cancelled = await write(id.shop, { ...shipped, status: 'canceled', updated_timestamp: nowSec + 200 })
      expect(cancelled).toMatchObject({ kind: 'written', status: 'CANCELLED', released: 0 })
      expect((cancelled as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code)).toEqual(['cancelled_after_shipment'])
      expect(await level(pid)).toEqual([9, 0, 9])
      const [order] = await orderOf(r.receipt_id)
      // One notice, the same one every channel raises (E3's kind and occurrence), across re-reads.
      await write(id.shop, { ...shipped, status: 'canceled', updated_timestamp: nowSec + 200 })
      expect(await notices('channel-order-cancelled-after-shipment', order.id)).toHaveLength(1)
    })

    // C1 (review 2026-09-26): Etsy says per line when it shipped. A cancellation after a partial shipment
    // takes the lines that shipped and gives the rest back — never the shipped units back into stock.
    it('C1: partly shipped, then cancelled: the shipped line is taken, the other given back, once; the owners are told truthfully', async () => {
      const a = await product('W-12', 10), b = await product('W-13', 10)
      const r = receipt([line({ sku: 'W-12', quantity: 1 }), line({ sku: 'W-13', quantity: 2 })])
      await write(id.shop, r)
      const partial = { ...structuredClone(r), updated_timestamp: nowSec + 50 }
      partial.transactions[0].shipped_timestamp = nowSec + 40
      await write(id.shop, partial)
      expect([await level(a), await level(b)]).toEqual([[10, 1, 9], [10, 2, 8]])
      const cancelled = { ...structuredClone(partial), status: 'canceled', updated_timestamp: nowSec + 90 }
      expect(await write(id.shop, cancelled)).toMatchObject({ status: 'CANCELLED', consumed: 1, released: 1 })
      expect(await write(id.shop, cancelled)).toMatchObject({ status: 'CANCELLED', consumed: 0, released: 0 })
      expect([await level(a), await level(b)]).toEqual([[9, 0, 9], [10, 0, 10]])
      const [order] = await orderOf(r.receipt_id)
      expect(await holdsOf(order.id)).toEqual(byProduct([{ productId: a, quantity: 1, state: 'consumed' }, { productId: b, quantity: 2, state: 'released' }]))
      expect(await stockOf(r.receipt_id)).toEqual({ [String(r.transactions[0].transaction_id)]: 'taken', [String(r.transactions[1].transaction_id)]: 'released' })
      const told = await q<{ body: string }>(`SELECT body FROM "Notification" WHERE "workspaceId" = $1 AND type = 'channel-order-cancelled-after-shipment' AND "entityId" = $2`, [B, order.id])
      expect(told).toHaveLength(1)
      expect(told[0].body).toBe('Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back. 2 units that had not shipped were put back on sale.')
    })

    it('H1 — a receipt created before the account\'s activation is skipped; an account never activated too', async () => {
      await product('W-8', 10)
      const early = receipt([line({ sku: 'W-8' })], { created_timestamp: nowSec - 10800 })
      expect(await write(id.shop, early)).toMatchObject({ kind: 'skipped', reason: 'before_activation' })
      expect(await orderOf(early.receipt_id)).toEqual([])
      const dormant = await connection('11112222', { activate: false })
      expect(await write(dormant, receipt([line({ sku: 'W-8' })], {}, dormant))).toMatchObject({ kind: 'refused', code: 'not_activated' })
    })

    it('explicit activation precedes a genuine receipt in the same provider second; no subsecond order is discarded', async () => {
      const shop = await connection('55556668', { activate: false })
      // Align the real database clock near the start of a second; never backdate activation.
      await q(`SELECT pg_sleep((1 - (extract(epoch FROM clock_timestamp()) % 1) + 0.1)::double precision)`)
      const [{ requestedAt }] = await q<{ requestedAt: Date }>(`SELECT clock_timestamp() AS "requestedAt"`)
      const activatedAt = await inB(() => ingest.activateEtsyIngest(shop))
      const [{ createdAt }] = await q<{ createdAt: Date }>(`SELECT clock_timestamp() AS "createdAt"`)
      const providerSecond = Math.floor(createdAt.getTime() / 1000)
      expect(providerSecond).toBe(Math.floor(requestedAt.getTime() / 1000))
      expect(activatedAt.getTime() % 1000).toBe(0)
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(activatedAt.getTime())
      const r = receipt([], { status: 'open', is_paid: false, created_timestamp: providerSecond, updated_timestamp: providerSecond }, shop)
      expect(await write(shop, r)).toMatchObject({ kind: 'written', created: true })
      expect(await orderOf(r.receipt_id)).toHaveLength(1)
    })

    it('an existing subsecond activation is interpreted at provider precision without rewriting its stored evidence', async () => {
      const shop = await connection('55556669', { activate: false })
      await q(`SELECT pg_sleep((1 - (extract(epoch FROM clock_timestamp()) % 1) + 0.1)::double precision)`)
      const [{ activatedAt }] = await q<{ activatedAt: Date }>(`INSERT INTO "EtsyReceiptIngest" (id, "workspaceId", "connectionId", "activatedAt", "updatedAt") VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp()) RETURNING "activatedAt" AT TIME ZONE 'UTC' AS "activatedAt"`, [randomUUID(), B, shop])
      const [{ createdAt }] = await q<{ createdAt: Date }>(`SELECT clock_timestamp() AS "createdAt"`)
      expect(activatedAt.getTime() % 1000).toBeGreaterThan(0)
      expect(Math.floor(createdAt.getTime() / 1000)).toBe(Math.floor(activatedAt.getTime() / 1000))
      const r = receipt([], { status: 'open', is_paid: false, created_timestamp: Math.floor(createdAt.getTime() / 1000), updated_timestamp: Math.floor(createdAt.getTime() / 1000) }, shop)
      expect(await write(shop, r)).toMatchObject({ kind: 'written' })
      expect((await q<{ activatedAt: Date }>(`SELECT "activatedAt" AT TIME ZONE 'UTC' AS "activatedAt" FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0].activatedAt).toEqual(activatedAt)
    })

    it('a line whose SKU matches no product is written without stock, and the owners are told', async () => {
      const r = receipt([line({ sku: 'NOPE-404' })])
      const outcome = await write(id.shop, r)
      expect((outcome as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code)).toEqual(['unmapped_line'])
      const [order] = await orderOf(r.receipt_id)
      expect(await holdsOf(order.id)).toEqual([])
      expect((await itemsOf(order.id))[0].productId).toBeNull()
      expect(await stockOf(r.receipt_id)).toEqual({ [r.transactions[0].transaction_id]: 'unlinked' })
      await write(id.shop, r)
      expect(await notices('channel-order-stock-unlinked', order.id)).toHaveLength(1)
    })

    // R5: a product with no stock level is a stock problem on its line now, not a failure (see below);
    // this arm injects a real failure after the first hold to keep proving the write is atomic.
    it('a failure inside the write rolls ALL of it back: no order, no item, no hold', async () => {
      const held = await product('W-9', 10), failing = await product('W-9-FAIL', 10)
      const r = receipt([line({ sku: 'W-9', quantity: 1 }), line({ sku: 'W-9-FAIL', quantity: 1 })])
      await q(`CREATE FUNCTION test_etsy_hold_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "StockLevel" WHERE id = NEW."stockLevelId" AND "productId" = '${failing}') THEN RAISE EXCEPTION 'injected hold failure'; END IF; RETURN NEW; END $$`)
      await q(`CREATE TRIGGER test_etsy_hold_failure BEFORE INSERT ON "StockReservation" FOR EACH ROW EXECUTE FUNCTION test_etsy_hold_failure()`)
      try {
        await expect(write(id.shop, r)).rejects.toThrow(/injected hold failure/)
      } finally {
        await q('DROP TRIGGER IF EXISTS test_etsy_hold_failure ON "StockReservation"')
        await q('DROP FUNCTION IF EXISTS test_etsy_hold_failure()')
      }
      expect(await orderOf(r.receipt_id)).toEqual([])
      expect([await level(held), await level(failing)]).toEqual([[10, 0, 10], [10, 0, 10]])
    })

    // The one lock door (nexus_lock_order_stock): the writer holds the shared pool-link lock for its
    // whole transaction, so no product it writes can switch to a new pool source mid-write (a link
    // insert takes that lock exclusively), and own products and pool sources lock in one sorted set.
    it('the writer holds the shared pool-link lock through its transaction: a link switch waits for it', async () => {
      await product('LOCKDOOR-1', 10)
      const r = receipt([line({ sku: 'LOCKDOOR-1', quantity: 1 })])
      await q(`CREATE FUNCTION test_etsy_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."channelOrderId" = '${r.receipt_id}' AND NEW."etsyMetadata" ? 'stock' THEN PERFORM pg_sleep(3); END IF; RETURN NEW; END $$`)
      await q(`CREATE TRIGGER test_etsy_pause BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION test_etsy_pause()`)
      const probe = await database.pool.connect()
      try {
        const writing = write(id.shop, r)
        void writing.catch(() => undefined)
        // Wait until the writer sleeps at its last statement (the lines' stock on the order), still inside its transaction.
        const deadline = Date.now() + 10_000
        let paused = false
        while (!paused && Date.now() < deadline) {
          paused = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%"Order"%'`))[0].n > 0
          if (!paused) await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(paused).toBe(true)
        const [{ free }] = (await probe.query(`SELECT pg_try_advisory_lock(hashtext('nexus_stock_pool_link')) AS free`)).rows
        if (free) await probe.query(`SELECT pg_advisory_unlock(hashtext('nexus_stock_pool_link'))`)
        expect(free).toBe(false)
        expect(await writing).toMatchObject({ kind: 'written' })
      } finally {
        probe.release()
        await q('DROP TRIGGER IF EXISTS test_etsy_pause ON "Order"')
        await q('DROP FUNCTION IF EXISTS test_etsy_pause()')
      }
    })

    it('R5 — a line with no stock level and a line short of stock are recorded on the order and told once; the receipt and its other line are written', async () => {
      const held = await product('R5-OK', 10), short = await product('R5-SHORT', 1)
      await product('R5-NOLEVEL', 0, false)
      const r = receipt([line({ sku: 'R5-OK', quantity: 1 }), line({ sku: 'R5-SHORT', quantity: 3 }), line({ sku: 'R5-NOLEVEL', quantity: 1 })])
      const outcome = await write(id.shop, r)
      expect(outcome).toMatchObject({ kind: 'written', status: 'PROCESSING' })
      expect((outcome as { warnings: Array<{ code: string }> }).warnings.map((w) => w.code)).toEqual(['hold_shortfall', 'hold_shortfall'])
      expect(await stockOf(r.receipt_id)).toEqual({ [r.transactions[0].transaction_id]: 'held', [r.transactions[1].transaction_id]: 'shortfall', [r.transactions[2].transaction_id]: 'shortfall' })
      expect([await level(held), await level(short)]).toEqual([[10, 1, 9], [1, 0, 1]])
      const [order] = await orderOf(r.receipt_id)
      await write(id.shop, r)
      expect(await notices('channel-order-stock-shortfall', order.id)).toHaveLength(1)
      // Stock arrives: the next read holds the short line once, and the shipment takes everything once.
      await q(`UPDATE "StockLevel" SET quantity = 5, available = 5 WHERE "productId" = $1`, [short])
      await write(id.shop, r)
      expect(await level(short)).toEqual([5, 3, 2])
      const shipped = { ...structuredClone(r), status: 'completed', is_shipped: true, updated_timestamp: nowSec + 100 }
      await write(id.shop, shipped)
      await write(id.shop, shipped)
      expect([await level(held), await level(short)]).toEqual([[9, 0, 9], [2, 0, 2]])
    })

    it('two receipts with the same two products in opposite line order, written at once many times: no deadlock, each product held once per receipt', async () => {
      const a = await product('ORDER-A', 20), b = await product('ORDER-B', 20)
      const first = receipt([line({ sku: 'ORDER-A', quantity: 1 }), line({ sku: 'ORDER-B', quantity: 2 })])
      const second = receipt([line({ sku: 'ORDER-B', quantity: 3 }), line({ sku: 'ORDER-A', quantity: 4 })])
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => write(id.shop, i % 2 ? first : second)))
      expect(results.filter((x) => x.status === 'rejected').map((x) => String((x as PromiseRejectedResult).reason))).toEqual([])
      expect([await level(a), await level(b)]).toEqual([[20, 5, 15], [20, 5, 15]])
      const [one] = await orderOf(first.receipt_id), [two] = await orderOf(second.receipt_id)
      expect(await holdsOf(one.id)).toEqual(byProduct([{ productId: a, quantity: 1, state: 'open' }, { productId: b, quantity: 2, state: 'open' }]))
      expect(await holdsOf(two.id)).toEqual(byProduct([{ productId: a, quantity: 4, state: 'open' }, { productId: b, quantity: 3, state: 'open' }]))
    }, 60_000)

    it('an account that is no longer active is refused and nothing is written', async () => {
      const off = await connection('33334444')
      await q(`UPDATE "ChannelConnection" SET "isActive" = false WHERE id = $1`, [off])
      const r = receipt([line({ sku: 'W-1' })], {}, off)
      expect(await inB(async () => ingest.ingestEtsyReceipt({ connectionId: off, raw: r, binding: { shopId: '33334444', sellerUserId: String(sellerOf.get(off)) }, source: 'poll' })))
        .toMatchObject({ kind: 'refused', code: 'connection_inactive' })
      expect(await orderOf(r.receipt_id)).toEqual([])
    })

    it('order.delivered is believed only for a receipt that shows it shipped', async () => {
      await product('W-10', 10)
      const paid = receipt([line({ sku: 'W-10' })])
      expect(await write(id.shop, paid, { deliveredEvent: true })).toMatchObject({ status: 'PROCESSING' })
      const [before] = await orderOf(paid.receipt_id)
      expect(before.deliveredAtSource).toBeNull()
      expect(await write(id.shop, { ...paid, status: 'Completed', is_shipped: true, updated_timestamp: nowSec + 300 }, { deliveredEvent: true })).toMatchObject({ status: 'DELIVERED' })
      const [after] = await orderOf(paid.receipt_id)
      expect(after).toMatchObject({ status: 'DELIVERED', deliveredAtSource: 'ETSY_WEBHOOK' })
      // A later read without the event (Etsy still says "completed") never walks it back.
      expect(await write(id.shop, { ...paid, status: 'completed', is_shipped: true, updated_timestamp: nowSec + 400 })).toMatchObject({ status: 'DELIVERED' })
    })

    it('a receipt first seen already shipped (the real #1356 shape) is held and taken out in one transaction: stock leaves once', async () => {
      const ribbon = await product('RIBBON-5Y', 5), grosgrain = await product('RIBBON-5Y-GG', 5)
      const usd = (amount: number) => ({ amount, divisor: 100, currency_code: 'USD' })
      const r = receipt([
        line({ sku: 'RIBBON-5Y', price: usd(700), shipping_cost: usd(0), shipped_timestamp: nowSec + 8 }),
        line({ sku: 'RIBBON-5Y-GG', price: usd(650), shipping_cost: usd(0), shipped_timestamp: nowSec + 8 }),
      ], { status: 'Completed', is_shipped: true, grandtotal: usd(2127), subtotal: usd(1350), total_price: usd(1350), total_shipping_cost: usd(0), total_tax_cost: usd(95), total_vat_cost: usd(0), discount_amt: usd(0), gift_wrap_price: usd(0) })
      expect(await write(id.shop, r)).toMatchObject({ kind: 'written', created: true, status: 'SHIPPED', consumed: 2 })
      const [order] = await orderOf(r.receipt_id)
      expect(order).toMatchObject({ totalPrice: '21.27', currencyCode: 'USD' })
      expect([await level(ribbon), await level(grosgrain)]).toEqual([[4, 0, 4], [4, 0, 4]])
    })
  })

  describe('the webhook handler (E4, behind NEXUS_ENABLE_ETSY_ORDER_INGEST)', () => {
    const event = (connectionId: string, r: Json) => ({ event_type: 'order.paid', shop_id: etsy.shops.get(connectionId)!.shopId, resource_url: `https://api.etsy.com/v3/application/shops/${etsy.shops.get(connectionId)!.shopId}/receipts/${r.receipt_id}` })

    /** The ledger row as the receiver records it, with the event's own payload. */
    const delivered = (connectionId: string, r: Json) => inB(async () => (await ledger.recordInbound({
      channel: 'ETSY', eventType: 'order.paid', externalId: `msg_${randomUUID()}`, payload: event(connectionId, r),
      signatureOk: true, verifiedBy: 'none', connectionId, status: 'pending',
    })).id!)
    // recordInbound stamps "due now" with the application clock and claimInbound compares with the
    // database clock; the test server's clock can lag the host's, so claims here name their time.
    const claimTime = () => new Date(Date.now() + 5_000)
    /** Every execution path runs the handler under the row's processing claim (PR #4), as the receiver does. */
    const underClaim = (rowId: string, now: Date = claimTime()) => inB(async () => {
      const claim = await claims.claimInbound(rowId, now)
      expect(claim).not.toBeNull()
      return claims.runWithInboundClaim(claim!, (stored, signal) => routes.handleEtsyOrderEvent(stored.payload, { connectionId: stored.connectionId, eventType: stored.eventType, signal }))
    })

    it('one account, one receipt: read back, written, and the row finished by its claim', async () => {
      const pid = await product('H-1', 10)
      const r = receipt([line({ sku: 'H-1', quantity: 2 })])
      publish(id.shop, r)
      const rowId = await delivered(id.shop, r)
      await underClaim(rowId)
      expect(await rowOf(rowId)).toMatchObject({ status: 'done', attempts: 1 })
      expect(await orderOf(r.receipt_id)).toHaveLength(1)
      expect(await level(pid)).toEqual([10, 2, 8])
    })

    // Ruling (2026-09-26): the row belongs to its claim. A holder whose lease was taken over can still
    // run its (idempotent) write, but it cannot finish the row: only the current token can.
    it('a stale claim holder cannot finish the row; the current holder does, and the receipt is held once', async () => {
      const pid = await product('H-STALE', 10)
      const r = receipt([line({ sku: 'H-STALE', quantity: 2 })])
      publish(id.shop, r)
      const rowId = await delivered(id.shop, r)
      const stale = await inB(() => claims.claimInbound(rowId, claimTime()))
      expect(stale).not.toBeNull()
      // Its lease runs out (a paused process); another worker claims the row.
      await q(`UPDATE "WebhookEvent" SET "processingUntil" = clock_timestamp() - interval '1 minute', "nextAttemptAt" = clock_timestamp() - interval '1 minute' WHERE id = $1`, [rowId])
      const current = await inB(() => claims.claimInbound(rowId, claimTime()))
      expect(current).toMatchObject({ attempt: 2 })
      await expect(inB(() => claims.runWithInboundClaim(stale!, (stored, signal) => routes.handleEtsyOrderEvent(stored.payload, { connectionId: stored.connectionId, eventType: stored.eventType, signal }))))
        .rejects.toThrow(/lease lost/)
      expect(await q(`SELECT status, "processingToken" = $2 AS current FROM "WebhookEvent" WHERE id = $1`, [rowId, current!.token])).toEqual([{ status: 'pending', current: true }])
      await inB(() => claims.runWithInboundClaim(current!, (stored, signal) => routes.handleEtsyOrderEvent(stored.payload, { connectionId: stored.connectionId, eventType: stored.eventType, signal })))
      expect(await rowOf(rowId)).toMatchObject({ status: 'done', attempts: 2 })
      expect(await orderOf(r.receipt_id)).toHaveLength(1)
      expect(await level(pid)).toEqual([10, 2, 8])
    })

    it('an unactivated webhook remains recoverable: deferred without spending its attempt; explicit T0 predates the first genuine order', async () => {
      const shop = await connection('55556667', { activate: false })
      const r = receipt([], { status: 'open', is_paid: false }, shop)
      publish(shop, r)
      const rowId = await delivered(shop, r)
      await expect(underClaim(rowId)).rejects.toBeInstanceOf(ledger.InboundDeferred)
      expect(await q(`SELECT id FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])).toEqual([])
      expect(await rowOf(rowId)).toMatchObject({ status: 'failed', attempts: 0, deferred: true })
      await activate(shop)
      // Read through Prisma: the pg driver reads these timestamp columns as local time.
      const due = (await inB(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: rowId }, select: { nextAttemptAt: true } }))).nextAttemptAt!
      await underClaim(rowId, due)
      expect(await orderOf(r.receipt_id)).toHaveLength(1)
      expect(await rowOf(rowId)).toMatchObject({ status: 'done', attempts: 1 })
    })

    it('Etsy 401: deferred WITHOUT spending an attempt; nothing written', async () => {
      const r = receipt([line({ sku: 'H-1' })])
      publish(id.shop, r)
      const rowId = await delivered(id.shop, r)
      etsy.shops.get(id.shop)!.failWith = 401
      try {
        await expect(underClaim(rowId)).rejects.toBeInstanceOf(ledger.InboundDeferred)
      } finally { etsy.shops.get(id.shop)!.failWith = null }
      expect(await rowOf(rowId)).toMatchObject({ status: 'failed', attempts: 0, deferred: true })
      expect((await rowOf(rowId)).lastError).toContain('auth hold')
      expect(await orderOf(r.receipt_id)).toEqual([])
    })

    it('a refused receipt fails with its code and is stored durably; nothing written', async () => {
      const r = receipt([line({ sku: 'H-1' })], { seller_user_id: 42 })
      publish(id.shop, r)
      await expect(inB(() => routes.handleEtsyOrderEvent(event(id.shop, r), { connectionId: id.shop, eventType: 'order.paid' })))
        .rejects.toThrow(/^\[seller_mismatch\]/)
      // Every path now names the event it runs for; the stored source says it came from a webhook.
      expect(await q(`SELECT code, source FROM "EtsyReceiptRefusal" WHERE "receiptId" = $1`, [String(r.receipt_id)])).toEqual([{ code: 'seller_mismatch', source: 'webhook' }])
      expect(await orderOf(r.receipt_id)).toEqual([])
    })

    // Review of PR #32 (2026-09-26): the switch is read by the API (receiver), the worker (retry) and the
    // scheduler (poll) separately. A process with it OFF must never finish an ACTIVATED account's order
    // event as a mere read-back: that completed the row with no order and no hold (the event was lost).
    it('with the flag OFF in this process, an activated account\'s event stays held: no attempt spent, one warning, nothing read or written; a process with it ON writes it', async () => {
      const pid = await product('H-OFF', 10)
      const r = receipt([line({ sku: 'H-OFF', quantity: 2 })])
      publish(id.shop, r)
      const rowId = await delivered(id.shop, r)
      const { logger } = await import('../../utils/logger.js')
      const warn = vi.spyOn(logger, 'warn')
      const reader = vi.mocked((await import('./read-client.js')).etsyReader)
      const reads = reader.mock.calls.length
      process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '0'
      try {
        await expect(underClaim(rowId)).rejects.toBeInstanceOf(ledger.InboundDeferred)
      } finally { process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '1' }
      expect(await rowOf(rowId)).toMatchObject({ status: 'failed', attempts: 0, deferred: true })
      expect((await rowOf(rowId)).lastError).toContain('NEXUS_ENABLE_ETSY_ORDER_INGEST')
      expect(await orderOf(r.receipt_id)).toEqual([])
      expect(reader.mock.calls.length).toBe(reads)
      expect(warn.mock.calls.filter(([message]) => String(message).includes('order ingest is off'))).toHaveLength(1)
      warn.mockRestore()
      // A process with the switch on takes it when it is due.
      const due = (await inB(() => database.client.webhookEvent.findUniqueOrThrow({ where: { id: rowId }, select: { nextAttemptAt: true } }))).nextAttemptAt!
      await underClaim(rowId, due)
      expect(await rowOf(rowId)).toMatchObject({ status: 'done', attempts: 1 })
      expect(await orderOf(r.receipt_id)).toHaveLength(1)
      expect(await level(pid)).toEqual([10, 2, 8])
    })

    it('with the flag OFF the handler only reads back and logs, exactly as before: no order, no activation', async () => {
      process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '0'
      const quiet = await connection('55556666', { activate: false })
      const r = receipt([line({ sku: 'H-1' })], {}, quiet)
      publish(quiet, r)
      await inB(() => routes.handleEtsyOrderEvent(event(quiet, r), { connectionId: quiet, eventType: 'order.paid' }))
      expect(await orderOf(r.receipt_id)).toEqual([])
      expect(await q(`SELECT id FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [quiet])).toEqual([])
    })
  })

  const checkpointOf = async (connectionId: string) => (await q<{ through: string | null; offset: number; count: number | null; success: string | null }>(
    `SELECT "scanCreatedThrough"::text AS through, "scanOffset" AS offset, "scanExpectedCount" AS count, "lastPollSucceededAt"::text AS success FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [connectionId]))[0]
  const seedCheckpoint = async (connectionId: string, offset: number, count: number) => {
    await q(`UPDATE "EtsyReceiptIngest" SET "scanCreatedThrough" = date_trunc('second', clock_timestamp()) - interval '1 minute',
      "scanOffset" = $2, "scanExpectedCount" = $3, "lastPollSucceededAt" = clock_timestamp() - interval '30 minutes',
      "lastPollCounts" = '{"recentPages":1}', "backlog" = true WHERE "connectionId" = $1`, [connectionId, offset, count])
    return checkpointOf(connectionId)
  }

  describe('the poller (E5/E6)', () => {
    it('first run after explicit activation: receipts before T0 skipped, the rest written; cursor, outcome and connection stamp by the database clock', async () => {
      const shop = await connection('77770001', { activate: false })
      await activate(shop)
      const [{ t0 }] = await q<{ t0: string }>(`SELECT floor(extract(epoch FROM "activatedAt"))::text AS t0 FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      const base = Number(t0)
      publish(shop, receipt([], { status: 'open', is_paid: false, created_timestamp: base - 100, updated_timestamp: base + 1 }, shop))
      const after = [1, 2, 3].map((i) => receipt([], { status: 'open', is_paid: false, created_timestamp: base + 1, updated_timestamp: base + 1 + i }, shop))
      after.forEach((r) => publish(shop, r))
      const outcome = await inB(() => poll.pollEtsyConnection(shop))
      expect(outcome).toMatchObject({ status: 'SUCCESS', backlog: false, counts: { fetched: 3, written: 3, created: 3, skippedBeforeActivation: 0, refused: 0 } })
      const [state] = await q<{ cursorReceiptId: string; lastPollStatus: string; ok: boolean; leaseToken: string | null }>(
        `SELECT "cursorReceiptId", "lastPollStatus", "lastPollSucceededAt" IS NOT NULL AS ok, "leaseToken" FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      expect(state).toEqual({ cursorReceiptId: String(after[2].receipt_id), lastPollStatus: 'SUCCESS', ok: true, leaseToken: null })
      const [stamp] = await q<{ lastSyncStatus: string; recent: boolean }>(`SELECT "lastSyncStatus", "lastSyncAt" > clock_timestamp() - interval '1 minute' AS recent FROM "ChannelConnection" WHERE id = $1`, [shop])
      expect(stamp).toEqual({ lastSyncStatus: 'SUCCESS', recent: true })
    })

    it('creation-window reconciliation: 230 receipts (a page boundary inside one second) over a page cap — backlog, then the rest; each written once', async () => {
      const shop = await connection('77770002', { activate: false })
      await activate(shop)
      const [{ t0 }] = await q<{ t0: string }>(`SELECT floor(extract(epoch FROM "activatedAt"))::text AS t0 FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      const base = Number(t0) + 1
      // 150 receipts share ONE second (a page fills inside it), then 80 spread over later seconds.
      const all = [
        ...Array.from({ length: 150 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: base, updated_timestamp: base }, shop)),
        ...Array.from({ length: 80 }, (_, i) => receipt([], { status: 'open', is_paid: false, created_timestamp: base, updated_timestamp: base + 1 + i }, shop)),
      ]
      all.forEach((r) => publish(shop, r))
      const first = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))
      expect(first).toMatchObject({ status: 'PARTIAL', backlog: true, counts: { pages: 2 } })
      const second = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))
      expect(second).toMatchObject({ status: 'PARTIAL', backlog: true })
      const third = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))
      expect(third).toMatchObject({ status: 'SUCCESS', backlog: false })
      const ids = all.map((r) => String(r.receipt_id))
      const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE channel = 'ETSY' AND "channelOrderId" = ANY($1::text[])`, [ids])
      expect(n).toBe(230)
      expect(first.counts.created + second.counts.created + third.counts.created).toBe(230)
      const [state] = await q<{ cursorReceiptId: string; backlog: boolean }>(`SELECT "cursorReceiptId", backlog FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      expect(state).toEqual({ cursorReceiptId: String(all[229].receipt_id), backlog: false })
    }, 120_000)

    // The cases below write 130–460 receipts through the one-transaction-per-receipt writer over several
    // polls: inherently heavy, so they take the same budget as the 230-receipt case above. A CI runner
    // measured ~2.5x slower than a developer machine; the 10 s default timed them out there.
    it('receipt-ID order: an updated receipt keeps its position while reconciliation pages', async () => {
      const shop = await connection('77770006', { activate: false })
      await activate(shop)
      const [{ t0 }] = await q<{ t0: string }>(`SELECT floor(extract(epoch FROM "activatedAt"))::text AS t0 FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      const base = Number(t0) + 1
      const all = Array.from({ length: 150 }, (_, i) => receipt([], { status: 'open', is_paid: false, created_timestamp: base, updated_timestamp: base + i }, shop))
      all.forEach((r) => publish(shop, r))
      // After the first page is served, the 10th receipt (already read) changes and moves to the end.
      etsy.shops.get(shop)!.afterList = (call) => {
        if (call !== 2) return
        const moved = etsy.shops.get(shop)!.receipts.get(String(all[9].receipt_id))!
        moved.updated_timestamp = base + 1_000
      }
      const outcome = await inB(() => poll.pollEtsyConnection(shop))
      expect(outcome).toMatchObject({ status: 'SUCCESS', counts: { created: 150 } })
    }, 120_000)

    it('equal timestamps with descending IDs across pages ingest every receipt without an invented secondary sort', async () => {
      const shop = await connection('77770008')
      const base = nowSec + 100
      const all = Array.from({ length: 230 }, (_, i) => receipt([], { receipt_id: 8_000_000_230 - i, status: 'open', is_paid: false, created_timestamp: base, updated_timestamp: base }, shop))
      all.forEach((r) => publish(shop, r))
      const runs = []
      for (let i = 0; i < 4; i++) {
        const result = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))
        runs.push(result)
        if (!result.backlog) break
      }
      expect(runs.at(-1)).toMatchObject({ status: 'SUCCESS', backlog: false })
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE "channelConnectionId" = $1`, [shop]))[0].n).toBe(230)
    }, 120_000)

    it('a receipt updated between capped runs cannot remove an unread member from an old timestamp bucket', async () => {
      const shop = await connection('77770011')
      const [{ currentSecond }] = await q<{ currentSecond: string }>(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS "currentSecond"`)
      const old = Number(currentSecond) - 3600
      const all = Array.from({ length: 230 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop))
      all.forEach((r) => publish(shop, r))
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))).toMatchObject({ status: 'PARTIAL', backlog: true })
      // This real provider mutation changes updated membership/order, never creation or receipt ID.
      etsy.shops.get(shop)!.receipts.get(String(all[0].receipt_id))!.updated_timestamp = Number(currentSecond)
      const runs = []
      for (let i = 0; i < 3; i++) {
        const result = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))
        runs.push(result)
        if (!result.backlog) break
      }
      expect(runs.at(-1)).toMatchObject({ status: 'SUCCESS', backlog: false })
      // A completed scan must not depend on a 600-second updated overlap to repair this loss.
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE "channelConnectionId" = $1`, [shop]))[0].n).toBe(230)
      expect(await orderOf(all[100].receipt_id)).toHaveLength(1)
    }, 120_000)

    it.each([10, 60])('a newly paid receipt is held within the cap after a %i-minute interval while historical reconciliation has a backlog', async (interval) => {
      const shop = await connection(`77770012${interval}`)
      const pid = await product(`RECENT-PAID-${interval}`, 10)
      const [{ currentSecond }] = await q<{ currentSecond: string }>(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS "currentSecond"`)
      const old = Number(currentSecond) - 3600
      Array.from({ length: 350 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop)).forEach((r) => publish(shop, r))
      const paidAt = Number(currentSecond) - (interval - 1) * 60
      const fresh = receipt([line({ sku: `RECENT-PAID-${interval}`, quantity: 2, created_timestamp: old, paid_timestamp: paidAt })], { created_timestamp: old, updated_timestamp: paidAt }, shop)
      publish(shop, fresh)
      const previous = process.env.NEXUS_ETSY_RECEIPTS_POLL_MINUTES
      process.env.NEXUS_ETSY_RECEIPTS_POLL_MINUTES = String(interval)
      let result
      try { result = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 })) } finally {
        if (previous === undefined) delete process.env.NEXUS_ETSY_RECEIPTS_POLL_MINUTES
        else process.env.NEXUS_ETSY_RECEIPTS_POLL_MINUTES = previous
      }
      expect(result).toMatchObject({ status: 'PARTIAL', backlog: true, counts: { pages: 2 } })
      expect(await orderOf(fresh.receipt_id)).toHaveLength(1)
      expect(await level(pid)).toEqual([10, 2, 8])
    }, 120_000)

    it('a late member changes the fixed window count and restarts its offset before declaring completeness', async () => {
      const shop = await connection('77770013')
      const old = nowSec - 1800
      const all = Array.from({ length: 230 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop))
      all.forEach((r) => publish(shop, r))
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))).toMatchObject({ backlog: true })
      const late = receipt([], { receipt_id: 3_999_999_999, status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop)
      publish(shop, late)
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))).toMatchObject({ backlog: true })
      expect((await q(`SELECT "scanOffset" FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0]).toEqual({ scanOffset: 0 })
      const runs = []
      for (let i = 0; i < 3; i++) runs.push(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 })))
      expect(runs.at(-1)).toMatchObject({ status: 'SUCCESS', backlog: false })
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE "channelConnectionId" = $1`, [shop]))[0].n).toBe(231)
      expect(await orderOf(late.receipt_id)).toHaveLength(1)
    }, 120_000)

    it('a single-page cap alternates recent work and historical progress without raising the cap', async () => {
      const shop = await connection('77770014')
      const pid = await product('CAP-ONE', 10)
      const old = nowSec - 1800
      Array.from({ length: 130 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop)).forEach((r) => publish(shop, r))
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 1 }))).toMatchObject({ backlog: true, counts: { pages: 1, recentPages: 1 } })
      expect((await q(`SELECT "lastPollSucceededAt" FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0]).toEqual({ lastPollSucceededAt: null })
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 1 }))).toMatchObject({ backlog: true, counts: { pages: 1, reconciliationPages: 1, created: 100 } })
      const [{ currentSecond }] = await q<{ currentSecond: string }>(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS "currentSecond"`)
      const fresh = receipt([line({ sku: 'CAP-ONE', quantity: 2, created_timestamp: Number(currentSecond), paid_timestamp: Number(currentSecond) })], { created_timestamp: Number(currentSecond), updated_timestamp: Number(currentSecond) }, shop)
      publish(shop, fresh)
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 1 }))).toMatchObject({ backlog: true, counts: { pages: 1, recentPages: 1 } })
      expect(await level(pid)).toEqual([10, 2, 8])
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 1 }))).toMatchObject({ status: 'SUCCESS', backlog: false, counts: { pages: 1, reconciliationPages: 1 } })
    }, 120_000)

    it('a short reconciliation page with a larger count fails held, retaining its page and last success until recovery', async () => {
      const shop = await connection('77770015')
      const old = nowSec - 1800
      const all = Array.from({ length: 103 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop))
      all.forEach((r) => publish(shop, r))
      const before = await seedCheckpoint(shop, 100, 103)
      // Malformed provider answer: count still reports three remaining members, page has one.
      etsy.shops.get(shop)!.transformList = (page) => ({ ...page, results: page.results.slice(0, 1) })
      const result = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 1 }))
      expect(result).toMatchObject({ status: 'FAILED', backlog: true, error: expect.stringContaining('page/count disagreed') })
      expect(await checkpointOf(shop)).toEqual(before)
      expect((await q(`SELECT "lastPollStatus", backlog, "leaseToken" FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0]).toEqual({ lastPollStatus: 'FAILED', backlog: true, leaseToken: null })
      expect(await orderOf(all[100].receipt_id)).toHaveLength(1) // committed work is replayed, never abandoned
      expect(await orderOf(all[101].receipt_id)).toHaveLength(0)
      delete etsy.shops.get(shop)!.transformList
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))).toMatchObject({ status: 'SUCCESS', backlog: false, counts: { created: 2 } })
      expect(await orderOf(all[101].receipt_id)).toHaveLength(1)
      const after = await checkpointOf(shop)
      expect(after).toMatchObject({ through: null, offset: 0, count: null })
      expect(after.success).not.toEqual(before.success)
    })

    it.each([
      ['missing', undefined], ['null', null], ['string', '1'], ['negative', -1],
      ['fraction', 1.5], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['NaN', Number.NaN], ['infinite', Infinity],
    ])('a %s provider count fails before effects and preserves reconciliation recovery state', async (_label, count) => {
      const shop = await connection(String(nextReceipt++))
      const r = receipt([], { status: 'open', is_paid: false, created_timestamp: nowSec - 1800, updated_timestamp: nowSec - 1800 }, shop)
      publish(shop, r)
      const before = await seedCheckpoint(shop, 0, 1)
      etsy.shops.get(shop)!.transformList = (page) => count === undefined ? { results: page.results } : { ...page, count }
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 1 }))).toMatchObject({
        status: 'FAILED', backlog: true, error: expect.stringContaining('without a valid receipt count'), counts: { written: 0 },
      })
      expect(await checkpointOf(shop)).toEqual(before)
      expect(await orderOf(r.receipt_id)).toEqual([])
      expect((await q(`SELECT "lastPollStatus", backlog FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0]).toEqual({ lastPollStatus: 'FAILED', backlog: true })
      delete etsy.shops.get(shop)!.transformList
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))).toMatchObject({ status: 'SUCCESS', backlog: false, counts: { created: 1 } })
    })

    it('the last legal offset is read, then the remaining window stays held at the ceiling without stamping success', async () => {
      const shop = await connection('77770016')
      const old = nowSec - 1800
      // A seeded checkpoint keeps the DB work bounded to the final legal page (100 receipts).
      // The fake API still filters/sorts all members honestly, including one beyond that page.
      const all = Array.from({ length: 12101 }, () => receipt([], { status: 'open', is_paid: false, created_timestamp: old, updated_timestamp: old }, shop))
      all.forEach((r) => publish(shop, r))
      const before = await seedCheckpoint(shop, 12000, 12101)
      const outcome = await inB(() => poll.pollEtsyConnection(shop, { pageCap: 3 }))
      expect(outcome).toMatchObject({ status: 'FAILED', backlog: true, error: expect.stringContaining('reconciliation reached its offset limit'), counts: { pages: 2, written: 100, reconciliationPages: 1 } })
      expect(await checkpointOf(shop)).toEqual({ ...before, offset: 12100 })
      expect(await orderOf(all[12099].receipt_id)).toHaveLength(1)
      expect(await orderOf(all[12100].receipt_id)).toHaveLength(0)
      const callsBefore = etsy.shops.get(shop)!.listCalls.length
      expect(await inB(() => poll.pollEtsyConnection(shop, { pageCap: 2 }))).toMatchObject({ status: 'FAILED', backlog: true, error: expect.stringContaining('reconciliation reached its offset limit'), counts: { pages: 1, reconciliationPages: 0 } })
      expect(await checkpointOf(shop)).toEqual({ ...before, offset: 12100 })
      expect((await q(`SELECT "lastPollStatus", backlog FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0]).toEqual({ lastPollStatus: 'FAILED', backlog: true })
      expect(etsy.shops.get(shop)!.listCalls.slice(callsBefore).every((path) => new URL(path, 'https://etsy.invalid').searchParams.get('offset') === '0')).toBe(true)
    }, 30_000)

    it('refusal storage failure stops the cursor and the same receipt is durably recovered on rerun', async () => {
      const shop = await connection('77770009')
      const bad = receipt([], { status: 'open', is_paid: false, seller_user_id: 42 }, shop)
      publish(shop, bad)
      await q(`ALTER TABLE "EtsyReceiptRefusal" ADD CONSTRAINT refusal_write_failure CHECK ("connectionId" <> '${shop}')`)
      try {
        expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'FAILED' })
        expect((await q(`SELECT "cursorUpdatedAt" FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0]).toEqual({ cursorUpdatedAt: null })
      } finally { await q(`ALTER TABLE "EtsyReceiptRefusal" DROP CONSTRAINT refusal_write_failure`) }
      expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'PARTIAL', counts: { refused: 1 } })
      expect(await q(`SELECT code FROM "EtsyReceiptRefusal" WHERE "connectionId" = $1`, [shop])).toEqual([{ code: 'seller_mismatch' }])
    })

    it('an unactivated poll is held without fetching or lazily establishing T0', async () => {
      const shop = await connection('77770010', { activate: false })
      expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'SKIPPED', reason: 'not_activated' })
      expect(etsy.shops.get(shop)!.listCalls).toEqual([])
      expect(await q(`SELECT id FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])).toEqual([])
    })

    it('a run that loses its lease mid-way stops, FAILED, and does not move the cursor again', async () => {
      const shop = await connection('77770007', { activate: false })
      await activate(shop)
      const [{ t0 }] = await q<{ t0: string }>(`SELECT floor(extract(epoch FROM "activatedAt"))::text AS t0 FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      const all = Array.from({ length: 120 }, (_, i) => receipt([], { status: 'open', is_paid: false, created_timestamp: Number(t0) + 1, updated_timestamp: Number(t0) + 1 + i }, shop))
      all.forEach((r) => publish(shop, r))
      etsy.shops.get(shop)!.afterList = async (call) => {
        if (call === 3) await q(`UPDATE "EtsyReceiptIngest" SET "leaseToken" = 'someone-else' WHERE "connectionId" = $1`, [shop])
      }
      const outcome = await inB(() => poll.pollEtsyConnection(shop))
      expect(outcome).toMatchObject({ status: 'FAILED', error: expect.stringContaining('lost its lease') })
      const [state] = await q<{ c: string; token: string }>(`SELECT "cursorReceiptId" AS c, "leaseToken" AS token FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      expect(state).toEqual({ c: String(all[99].receipt_id), token: 'someone-else' })
    })

    it('a run already holding the account\'s lease makes a second run step aside', async () => {
      const shop = await connection('77770003')
      await q(`UPDATE "EtsyReceiptIngest" SET "leaseToken" = 'other', "leaseUntil" = clock_timestamp() + interval '5 minutes' WHERE "connectionId" = $1`, [shop])
      expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'SKIPPED' })
      expect(etsy.shops.get(shop)!.listCalls).toEqual([])
    })

    it('a refused receipt is stored and passed; the run is PARTIAL, the cursor moves past it', async () => {
      const shop = await connection('77770004', { activate: false })
      await activate(shop)
      const [{ t0 }] = await q<{ t0: string }>(`SELECT floor(extract(epoch FROM "activatedAt"))::text AS t0 FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      const bad = receipt([], { status: 'open', is_paid: false, seller_user_id: 42, created_timestamp: Number(t0) + 1, updated_timestamp: Number(t0) + 2 })
      const good = receipt([], { status: 'open', is_paid: false, created_timestamp: Number(t0) + 1, updated_timestamp: Number(t0) + 3 }, shop)
      publish(shop, bad); publish(shop, good)
      expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'PARTIAL', counts: { refused: 1, written: 1 } })
      expect(await q(`SELECT code, source FROM "EtsyReceiptRefusal" WHERE "connectionId" = $1`, [shop])).toEqual([{ code: 'seller_mismatch', source: 'poll' }])
      expect((await q<{ c: string }>(`SELECT "cursorReceiptId" AS c FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0].c).toBe(String(good.receipt_id))
    })

    it('R5 — the poller writes past receipts whose stock cannot be held (an unmapped shipped SKU, a product with no stock level): SUCCESS, the cursor moves, later receipts are written', async () => {
      const shop = await connection('77770006', { activate: false })
      await activate(shop)
      const [{ t0 }] = await q<{ t0: string }>(`SELECT floor(extract(epoch FROM "activatedAt"))::text AS t0 FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      await product('R5-POLL-NOLEVEL', 0, false)
      const ok = await product('R5-POLL-OK', 10)
      const unmapped = receipt([line({ sku: 'R5-POLL-NOPE', shipped_timestamp: Number(t0) + 2 })], { status: 'completed', is_shipped: true, created_timestamp: Number(t0) + 1, updated_timestamp: Number(t0) + 2 }, shop)
      const noLevel = receipt([line({ sku: 'R5-POLL-NOLEVEL' })], { created_timestamp: Number(t0) + 1, updated_timestamp: Number(t0) + 3 }, shop)
      const good = receipt([line({ sku: 'R5-POLL-OK', quantity: 2 })], { created_timestamp: Number(t0) + 1, updated_timestamp: Number(t0) + 4 }, shop)
      for (const r of [unmapped, noLevel, good]) publish(shop, r)
      expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'SUCCESS', counts: { written: 3, refused: 0 } })
      expect((await q<{ c: string }>(`SELECT "cursorReceiptId" AS c FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop]))[0].c).toBe(String(good.receipt_id))
      expect(await stockOf(unmapped.receipt_id)).toEqual({ [unmapped.transactions[0].transaction_id]: 'unlinked' })
      expect(await stockOf(noLevel.receipt_id)).toEqual({ [noLevel.transactions[0].transaction_id]: 'shortfall' })
      expect(await level(ok)).toEqual([10, 2, 8])
    })

    it('E6 — a failing poll is FAILED everywhere, keeps the last success time, and a stale account tells its owners', async () => {
      const shop = await connection('77770005')
      expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'SUCCESS' })
      await q(`UPDATE "EtsyReceiptIngest" SET "lastPollSucceededAt" = clock_timestamp() - interval '3 hours' WHERE "connectionId" = $1`, [shop])
      etsy.shops.get(shop)!.failWith = 503
      try {
        expect(await inB(() => poll.pollEtsyConnection(shop))).toMatchObject({ status: 'FAILED' })
      } finally { etsy.shops.get(shop)!.failWith = null }
      const [state] = await q<{ lastPollStatus: string; old: boolean }>(`SELECT "lastPollStatus", "lastPollSucceededAt" < clock_timestamp() - interval '2 hours' AS old FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      expect(state).toEqual({ lastPollStatus: 'FAILED', old: true })
      expect((await q<{ s: string }>(`SELECT "lastSyncStatus" AS s FROM "ChannelConnection" WHERE id = $1`, [shop]))[0].s).toBe('FAILED')
      const [row] = await q<{ activatedAt: Date; lastPollSucceededAt: Date; backlog: boolean; now: Date }>(`SELECT "activatedAt", "lastPollSucceededAt", backlog, clock_timestamp() AS now FROM "EtsyReceiptIngest" WHERE "connectionId" = $1`, [shop])
      expect(ingest.etsyReceiptFreshness(row, row.now, 10 * 60_000).status).toBe('stale')
      etsy.shops.get(shop)!.failWith = 503
      // This account's stale alert must not replay every earlier pagination fixture in this test.
      const others = await q<{ id: string }>(`UPDATE "ChannelConnection" SET "isActive" = false WHERE "isActive" AND id <> $1 RETURNING id`, [shop])
      try { await inB(() => poll.pollEtsyReceipts()) } finally {
        etsy.shops.get(shop)!.failWith = null
        await q(`UPDATE "ChannelConnection" SET "isActive" = true WHERE id = ANY($1::text[])`, [others.map((r) => r.id)])
      }
      expect(await notices('etsy-receipts-stale', shop)).toHaveLength(1)
    })

    it('with the flag OFF a run reads and writes nothing', async () => {
      process.env.NEXUS_ENABLE_ETSY_ORDER_INGEST = '0'
      const calls = [...etsy.shops.values()].reduce((n, s) => n + s.listCalls.length, 0)
      expect(await inB(() => poll.pollEtsyReceipts())).toEqual({ enabled: false, accounts: [] })
      expect([...etsy.shops.values()].reduce((n, s) => n + s.listCalls.length, 0)).toBe(calls)
    })
  })
})
