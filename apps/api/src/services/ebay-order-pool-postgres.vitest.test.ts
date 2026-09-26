/** Real pool links, permissions and PostgreSQL locks through the eBay writer. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => (database.client as any)[key] }) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue,
    searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('./advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const as = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
  const client = await database.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actor])
    for (const [sql, params] of statements) await client.query(sql, params)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
const payload = (orderId: string, skus: string[], cancelled = false) => ({ orderId, creationDate: '2026-09-25T01:00:00Z',
  orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED', ...(cancelled ? { cancelStatus: { cancelState: 'CANCELED' } } : {}),
  pricingSummary: { total: { value: '20', currency: 'EUR' } },
  lineItems: skus.map((sku, i) => ({ sku, lineItemId: `${orderId}-${i}`, quantity: 1, lineItemCost: { value: '10', currency: 'EUR' } })) })
let role = ''
async function fixture() {
  const key = randomUUID(), a = `${key}-A`, b = `${key}-B`, ownerA = randomUUID(), ownerB = randomUUID()
  const x = `${key}-a`, y = `${key}-b`, ay = `${key}-c`, bx = `${key}-d`
  const locationA = randomUUID(), locationB = randomUUID(), accountA = randomUUID(), accountB = randomUUID()
  for (const [workspace, owner, location, account] of [[a, ownerA, locationA, accountA], [b, ownerB, locationB, accountB]]) {
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$1,'active','test',$1,now())`, [workspace])
    await q(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',now())`, [owner, `${owner}@example.test`])
    const warehouse = randomUUID()
    await q(`INSERT INTO "Warehouse" (id,"workspaceId",code,name,country,"isDefault","updatedAt") VALUES ($1,$2,'MAIN','Main','IT',true,now())`, [warehouse, workspace])
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"warehouseId","updatedAt") VALUES ($1,$2,'WAREHOUSE','MAIN','Main',$3,now())`, [location, workspace, warehouse])
    await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","updatedAt") VALUES ($1,$2,'EBAY',now())`, [account, workspace])
  }
  for (const workspace of [a, b]) for (const owner of [ownerA, ownerB]) {
    const member = randomUUID()
    await q(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [member, workspace, owner])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [member, role])
  }
  for (const [id, workspace, location] of [[x,a,locationA],[ay,a,locationA],[y,b,locationB],[bx,b,locationB]]) {
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$1,$1,10,10,now())`, [id, workspace])
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,10,0,10,now())`, [randomUUID(),workspace,location,id])
  }
  // The no-chains rule permits reciprocal lending of DIFFERENT products: A.x → B.x, B.y → A.y.
  for (const [lender, borrower, owner, receiver, source, target, location] of [
    [a,b,ownerA,ownerB,x,bx,locationA], [b,a,ownerB,ownerA,y,ay,locationB],
  ]) {
    const assortment = randomUUID(), share = randomUUID(), grant = randomUUID(), catalog = randomUUID()
    await inContext(lender, owner, [
      [`INSERT INTO "Assortment" (id,"workspaceId",name,selection,"updatedAt") VALUES ($1,$2,'Pool','list',now())`, [assortment,lender]],
      [`INSERT INTO "AssortmentMember" (id,"workspaceId","assortmentId","productId",mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(),lender,assortment,source]],
      [`INSERT INTO "AssortmentShare" (id,"assortmentId","ownerWorkspaceId","workspaceId","fieldGroups","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [share,assortment,lender,borrower,owner]],
      [`INSERT INTO "StockPoolGrant" (id,"ownerWorkspaceId","workspaceId","locationIds","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [grant,lender,borrower,[location],owner]],
    ])
    await inContext(borrower, receiver, [
      [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [share]],
      [`SELECT nexus_stock_pool_grant_respond($1,'accept',1)`, [grant]],
      [`INSERT INTO "CatalogLink" (id,"shareId","sourceWorkspaceId","sourceProductId","targetWorkspaceId","targetProductId","linkedBy","sourceVersion","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalog,share,lender,source,borrower,target]],
      [`INSERT INTO "StockPoolLink" (id,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(),borrower,grant,catalog,target,source,receiver]],
    ])
  }
  return { a,b,x,y,ay,bx,accountA,accountB,ownerA,ownerB }
}
async function writer(workspace: string, account: string, order: ReturnType<typeof payload>) {
  const { normalizeEbayOrder, writeEbayOrderInTx } = await import('./ebay-order-writer.js')
  let resolve!: (pid: number) => void
  const pid = new Promise<number>(r => { resolve = r })
  const done = as(workspace, () => database.client.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
    resolve(Number(row.pid))
    return writeEbayOrderInTx(tx, { order: normalizeEbayOrder(order), connectionId: account, actor: 'test' })
  }, { isolationLevel: 'ReadCommitted', timeout: 30_000 }))
  void done.catch(() => undefined)
  return { pid: await pid, done }
}
async function waiting(pid: number, excluding?: number) {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    const [row] = await q<{ pids: number[] }>('SELECT pg_blocking_pids($1::int) AS pids', [pid])
    if (row.pids.length > 0 && (!excluding || !row.pids.includes(excluding))) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}
async function holdOrderStock(workspace: string, ids: string[]) {
  let announce!: () => void, release!: () => void
  const ready = new Promise<void>(r => { announce = r }), gate = new Promise<void>(r => { release = r })
  const done = as(workspace, () => database.client.$transaction(async tx => {
    await tx.$executeRaw`SELECT nexus_lock_order_stock(${ids}::text[])`
    announce()
    await gate
  }, { isolationLevel: 'ReadCommitted', timeout: 30_000 }))
  await Promise.race([ready, done])
  return { done, release }
}
const levels = (ids: string[]) => q(`SELECT "productId", quantity, reserved, available FROM "StockLevel" WHERE "productId"=ANY($1::text[]) ORDER BY "productId"`, [ids])
const poolPending = (workspace: string, orderId: string) => as(workspace, async () => {
  const [row] = await database.client.$queryRaw<Array<{ pending: boolean }>>`SELECT nexus_pool_restore_pending(${orderId}) AS pending`
  return row.pending
})
const flag = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!concurrentDatabaseUrl())('eBay mixed own and pool stock on real PostgreSQL', () => {
  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    role = randomUUID()
    await q(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [role])
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK (available=quantity-reserved)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
  }, 180_000)
  afterAll(async () => {
    if (flag === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flag
    await database?.close()
  }, 60_000)

  it('commits both mixed orders during reciprocal lending without a Product lock cycle', async () => {
    const f = await fixture()
    const holderX = await database.pool.connect(), holderY = await database.pool.connect()
    const pending: Array<ReturnType<typeof writer> extends Promise<infer T> ? T : never> = []
    try {
      await holderX.query('BEGIN'); await holderY.query('BEGIN')
      await holderX.query(`SELECT id FROM "Product" WHERE id=$1 FOR NO KEY UPDATE`, [f.x])
      await holderY.query(`SELECT id FROM "Product" WHERE id=$1 FOR NO KEY UPDATE`, [f.y])
      const xPid = Number((await holderX.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const b = await writer(f.b, f.accountB, payload('RECIPROCAL-B', [f.y,f.bx])); pending.push(b)
      expect(await waiting(b.pid)).toBe(true)
      const a = await writer(f.a, f.accountA, payload('RECIPROCAL-A', [f.x,f.ay])); pending.push(a)
      expect(await waiting(a.pid)).toBe(true)
      await holderX.query('COMMIT')
      expect(await waiting(a.pid, xPid)).toBe(true)
      await holderY.query('COMMIT')
      const outcomes = await Promise.allSettled(pending.map(p => p.done))
      expect(outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => String((outcome as PromiseRejectedResult).reason))).toEqual([])
      expect(await levels([f.x,f.y,f.ay,f.bx])).toEqual([f.x,f.y,f.ay,f.bx].map((productId,i) => ({ productId, quantity: i < 2 ? 8 : 10, reserved: 0, available: i < 2 ? 8 : 10 })))
      const orders = await q(`SELECT id FROM "Order" WHERE "channelOrderId" IN ('RECIPROCAL-A','RECIPROCAL-B')`)
      expect(orders).toHaveLength(2)
      expect(await q(`SELECT 1 FROM "OrderItem" WHERE "orderId"=ANY($1::text[])`, [orders.map(o => o.id)])).toHaveLength(4)
      expect(await q(`SELECT 1 FROM "StockMovement" WHERE "orderId"=ANY($1::text[])`, [orders.map(o => o.id)])).toHaveLength(2)
      expect(await q(`SELECT 1 FROM "StockMovement" WHERE "consumerOrderRef"=ANY($1::text[])`, [orders.map(o => o.id)])).toHaveLength(2)
    } finally {
      await holderX.query('ROLLBACK'); await holderY.query('ROLLBACK')
      holderX.release(); holderY.release()
      await Promise.allSettled(pending.map(p => p.done))
    }
  })
  it('refuses caller-supplied lender or foreign Product ids at the stock lock door', async () => {
    const f = await fixture()
    await expect(as(f.a, () => database.client.$executeRaw`SELECT nexus_lock_order_stock(${[f.x,f.y]}::text[])`)).rejects.toThrow(/Order products must belong/)
  })

  it('refuses missing or inactive profiles and nonmember actors at the stock lock door', async () => {
    const f = await fixture()
    await expect(q(`SELECT nexus_lock_order_stock($1::text[])`, [[f.x]])).rejects.toThrow(/active business profile/)
    await expect(withWorkspace({ workspaceId: f.a, actorUserId: randomUUID(), membershipId: null, roleKeys: [] },
      () => database.client.$executeRaw`SELECT nexus_lock_order_stock(${[f.x]}::text[])`)).rejects.toThrow(/active business profile/)
    await q(`UPDATE "Workspace" SET status='suspended' WHERE id=$1`, [f.a])
    await expect(as(f.a, () => database.client.$executeRaw`SELECT nexus_lock_order_stock(${[f.x]}::text[])`)).rejects.toThrow(/active business profile/)
  })

  it('keeps a new pool source from appearing until the order releases its stock locks', async () => {
    const f = await fixture()
    await inContext(f.a, f.ownerA, [[`UPDATE "StockPoolLink" SET status='ended', "endedAt"=now(), "endedReason"='test switch' WHERE "productId"=$1`, [f.ay]]])
    const held = await holdOrderStock(f.a, [f.ay])
    const insertion = await database.pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await insertion.query('BEGIN')
      await insertion.query(`SELECT set_config('nexus.workspace_id',$1,true),set_config('nexus.actor_id',$2,true)`, [f.a,f.ownerA])
      const pid = Number((await insertion.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      pending = insertion.query(`INSERT INTO "StockPoolLink" (id,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId","updatedAt")
        SELECT $1,"workspaceId","grantId","catalogLinkId","productId","sourceProductId","createdByUserId",now() FROM "StockPoolLink" WHERE "productId"=$2`, [randomUUID(),f.ay])
      void pending.catch(() => undefined)
      expect(await waiting(pid)).toBe(true)
      held.release(); await held.done
      await pending
      await insertion.query('COMMIT')
      expect(await q(`SELECT 1 FROM "StockPoolLink" WHERE "productId"=$1 AND status='active'`, [f.ay])).toHaveLength(1)
    } finally {
      held.release(); await held.done
      await pending?.catch(() => undefined)
      await insertion.query('ROLLBACK'); insertion.release()
    }
  })

  it('locks the source of a paused grant before a concurrent resume can route an order to it', async () => {
    const f = await fixture()
    await inContext(f.b, f.ownerB, [[`UPDATE "StockPoolGrant" SET status='paused',version=version+1 WHERE "ownerWorkspaceId"=$1 AND "workspaceId"=$2`, [f.b,f.a]]])
    const held = await holdOrderStock(f.a, [f.ay])
    const contender = await database.pool.connect()
    try {
      await contender.query('BEGIN')
      await expect(contender.query(`SELECT id FROM "Product" WHERE id=$1 FOR NO KEY UPDATE NOWAIT`, [f.y])).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await contender.query('ROLLBACK'); contender.release()
      held.release(); await held.done
    }
  })

  it.each([false, true])('a later eBay poll retries failed pool restoration once (own stock included: %s)', async (mixed) => {
    const f = await fixture()
    const { EbayOrdersService } = await import('./ebay-orders.service.js')
    const ebay = new EbayOrdersService() as unknown as { processOrder: (order: unknown, account: string) => Promise<{ id: string }> }
    const { handleOrderCancelled } = await import('./order-cancellation/index.js')
    const channelOrderId = `POOL-RETRY-${mixed}`
    const skus = mixed ? [f.x,f.ay] : [f.ay]
    const poll = (cancelled = false) => as(f.a, () => ebay.processOrder(payload(channelOrderId, skus, cancelled), f.accountA))
    const order = await poll()
    const poolMoves = () => q(`SELECT "productId",change,reason::text,"orderId" FROM "StockMovement" WHERE "consumerWorkspaceId"=$1 AND "consumerOrderRef"=$2 ORDER BY change`, [f.a,order.id])
    const ownRestores = () => q(`SELECT "productId",change FROM "StockMovement" WHERE "orderId"=$1 AND reason='ORDER_CANCELLED'`, [order.id])
    expect(await poolMoves()).toEqual([{ productId: f.y,change: -1,reason: 'ORDER_PLACED',orderId: null }])
    // Lender movements are deliberately invisible through the borrower's ordinary ledger access.
    expect(await as(f.a, () => database.client.stockMovement.count({ where: { consumerOrderRef: order.id } }))).toBe(0)
    await q(`CREATE FUNCTION test_pool_restore_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."consumerOrderRef" = '${order.id}' AND NEW.reason = 'ORDER_CANCELLED' THEN RAISE EXCEPTION 'injected pool restore failure'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER test_pool_restore_failure BEFORE INSERT ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION test_pool_restore_failure()`)
    try {
      await q(`UPDATE "Order" SET status='CANCELLED' WHERE id=$1`, [order.id])
      const cancelled = await as(f.a, () => handleOrderCancelled(order.id))
      expect(cancelled.errors).toHaveLength(1)
      expect(cancelled.errors[0].error).toContain('injected pool restore failure')
      expect(await levels([f.x,f.y,f.ay])).toEqual([
        { productId: f.x,quantity: 10,reserved: 0,available: 10 },
        { productId: f.y,quantity: 9,reserved: 0,available: 9 },
        { productId: f.ay,quantity: 10,reserved: 0,available: 10 },
      ])
      expect(await ownRestores()).toEqual(mixed ? [{ productId: f.x,change: 1 }] : [])
    } finally {
      await q('DROP TRIGGER IF EXISTS test_pool_restore_failure ON "StockMovement"')
      await q('DROP FUNCTION IF EXISTS test_pool_restore_failure()')
    }
    await Promise.all([poll(true), poll(true)])
    expect(await levels([f.x,f.y,f.ay])).toEqual([f.x,f.y,f.ay].map(productId => ({ productId,quantity: 10,reserved: 0,available: 10 })))
    await poll(true)
    expect(await poolMoves()).toEqual([
      { productId: f.y,change: -1,reason: 'ORDER_PLACED',orderId: null },
      { productId: f.y,change: 1,reason: 'ORDER_CANCELLED',orderId: null },
    ])
    expect(await ownRestores()).toEqual(mixed ? [{ productId: f.x,change: 1 }] : [])
    const checked = await (await writer(f.a, f.accountA, payload(channelOrderId, skus, true))).done
    expect(checked.restorePending).toBe(false)
  })

  it('follows historical pool debt after a grant ends and subtracts returns before cancelling', async () => {
    const f = await fixture()
    const raw = payload('POOL-RETURN-THEN-CANCEL', [f.ay])
    raw.lineItems[0].quantity = 2
    const created = await (await writer(f.a, f.accountA, raw)).done
    const { poolPutBack } = await import('./stock-pool/pool-doors.js')
    expect(await as(f.a, () => poolPutBack(database.client, { productId: f.ay,quantity: 1,orderRef: created.order.id,
      putBackRef: 'partial-return',reason: 'RETURN_RESTOCKED' }))).toMatchObject({ ok: true,reused: false })
    await inContext(f.b, f.ownerB, [[`UPDATE "StockPoolGrant" SET status='revoked',version=version+1,"endedBySide"='owner',"endedByUserId"=$1,"endedAt"=now() WHERE "ownerWorkspaceId"=$2 AND "workspaceId"=$3`, [f.ownerB,f.b,f.a]]])
    expect(await poolPending(f.a,created.order.id)).toBe(true)
    await q(`UPDATE "Order" SET status='CANCELLED' WHERE id=$1`, [created.order.id])
    const { EbayOrdersService } = await import('./ebay-orders.service.js')
    const ebay = new EbayOrdersService() as unknown as { processOrder: (order: unknown, account: string) => Promise<unknown> }
    await as(f.a, () => ebay.processOrder({ ...raw,cancelStatus: { cancelState: 'CANCELED' } },f.accountA))
    expect(await poolPending(f.a,created.order.id)).toBe(false)
    expect(await levels([f.y,f.ay])).toEqual([f.y,f.ay].map(productId => ({ productId,quantity: 10,reserved: 0,available: 10 })))
    expect(await q(`SELECT reason::text,change FROM "StockMovement" WHERE "consumerOrderRef"=$1 ORDER BY reason::text`, [created.order.id])).toEqual([
      { reason: 'ORDER_CANCELLED',change: 1 },{ reason: 'ORDER_PLACED',change: -2 },{ reason: 'RETURN_RESTOCKED',change: 1 },
    ])
  })

  it('checks both the consumer workspace and order ownership when another borrower reuses an order reference', async () => {
    const f = await fixture()
    const created = await (await writer(f.a,f.accountA,payload('POOL-REFERENCE-COLLISION',[f.x],true))).done
    const { poolTake } = await import('./stock-pool/pool-doors.js')
    expect(await as(f.b, () => poolTake(database.client,{ productId: f.bx,quantity: 1,orderRef: created.order.id }))).toMatchObject({ ok: true,reused: false })
    expect(await poolPending(f.a,created.order.id)).toBe(false)
    expect(await poolPending(f.b,created.order.id)).toBe(false)
  })

  it('refuses missing or inactive profiles and nonmember actors at the pool restore detector', async () => {
    const f = await fixture()
    await expect(q(`SELECT nexus_pool_restore_pending('test-order')`)).rejects.toThrow(/active business profile/)
    await expect(withWorkspace({ workspaceId: f.a,actorUserId: randomUUID(),membershipId: null,roleKeys: [] },
      () => database.client.$queryRaw`SELECT nexus_pool_restore_pending('test-order')`)).rejects.toThrow(/active business profile/)
    await q(`UPDATE "Workspace" SET status='suspended' WHERE id=$1`, [f.a])
    await expect(poolPending(f.a,'test-order')).rejects.toThrow(/active business profile/)
  })

  // R4 (sanctioned change): before, a consumed pool reservation counted as cancellation debt (true).
  // A hold is consumed only when the order ships; shipped units are never given back automatically.
  it('a consumed (shipped) pool reservation is not cancellation debt; a return still puts it back', async () => {
    const f = await fixture()
    const created = await (await writer(f.a,f.accountA,payload('POOL-CONSUMED',[],false))).done
    const { poolReserve,poolConsume,poolPutBack } = await import('./stock-pool/pool-doors.js')
    expect(await as(f.a, () => poolReserve(database.client,{ productId: f.ay,quantity: 1,orderRef: created.order.id }))).toMatchObject({ ok: true })
    expect(await poolPending(f.a,created.order.id)).toBe(false)
    expect(await as(f.a, () => poolConsume(database.client,{ orderRef: created.order.id }))).toMatchObject({ ok: true,units: 1 })
    expect(await poolPending(f.a,created.order.id)).toBe(false)
    expect(await as(f.a, () => poolPutBack(database.client,{ productId: f.ay,quantity: 1,orderRef: created.order.id,
      putBackRef: 'full-return',reason: 'RETURN_RESTOCKED' }))).toMatchObject({ ok: true,reused: false })
    expect(await poolPending(f.a,created.order.id)).toBe(false)
    expect(await levels([f.y])).toEqual([{ productId: f.y,quantity: 10,reserved: 0,available: 10 }])
  })


  // C1 (review 2026-09-26): a pooled eBay sale cancelled after a partial shipment puts back, through door
  // 5, only the units of lines eBay says did not ship; with no line data the units stay taken and the
  // owners are told so.
  it('C1: a partly shipped pooled eBay order cancelled puts back only the unshipped units; with no line data they stay taken', async () => {
    const f = await fixture()
    const { handleOrderCancelled } = await import('./order-cancellation/index.js')
    const run = async (id: string, statuses: Array<string | undefined>) => {
      const read = (extra: Record<string, unknown>) => {
        const order = { ...payload(id, [f.ay, f.ay]), ...extra } as ReturnType<typeof payload> & { lineItems: Array<Record<string, unknown>> }
        order.lineItems.forEach((line, i) => { if (statuses[i]) line.lineItemFulfillmentStatus = statuses[i] })
        return order
      }
      const created = await (await writer(f.a, f.accountA, read({}))).done
      await (await writer(f.a, f.accountA, read({ orderFulfillmentStatus: 'IN_PROGRESS' }))).done
      await (await writer(f.a, f.accountA, read({ cancelStatus: { cancelState: 'CANCELED' } }))).done
      await as(f.a, () => handleOrderCancelled(created.order.id))
      await as(f.a, () => handleOrderCancelled(created.order.id))
      return created.order.id
    }
    const known = await run(`POOL-SPLIT-${randomUUID().slice(0, 6)}`, ['FULFILLED', 'NOT_STARTED'])
    expect(await levels([f.y])).toEqual([{ productId: f.y, quantity: 9, reserved: 0, available: 9 }])
    expect(await q(`SELECT change, reason::text AS reason FROM "StockMovement" WHERE "consumerOrderRef"=$1 ORDER BY change`, [known]))
      .toEqual([{ change: -2, reason: 'ORDER_PLACED' }, { change: 1, reason: 'ORDER_CANCELLED' }])
    const unknown = await run(`POOL-NODATA-${randomUUID().slice(0, 6)}`, [])
    expect(await levels([f.y])).toEqual([{ productId: f.y, quantity: 7, reserved: 0, available: 7 }])
    const [notice] = await q<{ body: string }>(`SELECT body FROM "Notification" WHERE type='channel-order-cancelled-after-shipment' AND "entityId"=$1 LIMIT 1`, [unknown])
    expect(notice.body).toBe(`Nothing that shipped was put back into stock; when a parcel comes back, book it in as a return to put its units back. Nexus cannot tell from EBAY whether 2 × ${f.ay} shipped, so they stay deducted.`)
  })

})
