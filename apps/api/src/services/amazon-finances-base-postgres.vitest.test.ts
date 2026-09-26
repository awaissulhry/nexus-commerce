/**
 * CX finances trim (review 2026-09-26) — the Finances dry run (A2) and order attribution (A5) in REAL
 * PostgreSQL, on the schema as it is WITHOUT migration 20260924a (A3/A4 are held until A2 has run on real
 * data). Nothing here reads or writes a Finances 2024 identity column or a cutover row.
 *
 * The A5 cases are the lane's own (fix/cx-amazon-finances at eed45a47c), unchanged; the dry-run cases are
 * its A2/P3 cases without the cutover table, and with a "would write" positive control in place of the
 * held 2024 writer. Every session runs in a non-UTC time zone, as in the lane's suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { concurrentDatabase, concurrentDatabaseUrl, CONCURRENT_PG_ENV } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => (database.client as any)[key] }) }))
// The channel is synthetic: the 2024 read returns `h.pages` for `h.account`.
const h = vi.hoisted(() => ({ account: '', pages: [] as unknown[] }))
vi.mock('./marketplaces/amazon.service.js', () => ({ AmazonService: class { isConfigured = async () => true } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ amazonAccount: async () => ({ id: h.account }) }))
vi.mock('./gateway/amazon-sdk.js', () => ({ amazonSellerFetch: async () => ({ ok: true, json: async () => ({ payload: { transactions: h.pages } }) }) }))
const { syncFinancialTransactions } = await import('./amazon-financial-events.service.js')
const { runAttributionCensus, executeAttribution, attributeBatch } = await import('./amazon-order-attribution.js')

const ZONE = 'Pacific/Kiritimati' // UTC+14: any local-time reading of a UTC instant is visibly wrong
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let ws = ''
const inWs = <T>(work: () => Promise<T>) => inProfile(ws, work)
const q = (sql: string, values: unknown[] = []) => database.pool.query(sql, values)
async function newProfile() {
  const id = randomUUID()
  await q(`INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,'Finance case','test',$1,now())`, [id])
  return id
}
/** An inactive, disconnected Amazon account (a legacy row): never a runtime target. */
async function connection(workspaceId: string, seller = `SELLER${randomUUID().slice(0, 8)}`) {
  const id = randomUUID()
  await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'AMAZON',$3,false,'oauth','disconnected',now())`, [id, workspaceId, seller])
  return id
}
/** A runtime-usable account: active, identified, connected (what amazonAccount() accepts). */
async function usable(workspaceId: string) {
  const id = randomUUID()
  await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'AMAZON',$3,true,'oauth','connected',now())`, [id, workspaceId, `SELLER-${id.slice(0, 8)}`])
  return id
}
async function order(workspaceId: string, channelOrderId: string, account: string | null = null, metadata: object | null = null) {
  const id = randomUUID()
  await q(`INSERT INTO "Order" (id,"workspaceId",channel,"channelOrderId","totalPrice","customerName","customerEmail","shippingAddress","channelConnectionId","amazonMetadata","updatedAt")
    VALUES ($1,$2,'AMAZON',$3,10,'c','c@example.test','{}'::jsonb,$4,$5::jsonb,now())`, [id, workspaceId, channelOrderId, account, metadata === null ? null : JSON.stringify(metadata)])
  return id
}
/** A legacy (v0-shaped) row, dated by an explicit UTC instant — never a JS Date through the driver. */
async function legacyRow(workspaceId: string, orderId: string, channelOrderId: string, at: string, type = 'Order', amount = '10.00') {
  const id = randomUUID()
  await q(`INSERT INTO "FinancialTransaction" (id,"workspaceId","amazonTransactionId","orderId","transactionType","transactionDate",amount,"currencyCode","grossRevenue","netRevenue",status,"updatedAt")
    VALUES ($1,$2,$3,$4,$5,($6::timestamptz AT TIME ZONE 'UTC'),$7::numeric,'EUR',$7::numeric,$7::numeric,'Completed',now())`, [id, workspaceId, channelOrderId, orderId, type, at, amount])
  return id
}
/** A Finances 2024 transaction in the official schema's shape. */
function tx2024(transactionId: string, orderId: string, postedDate: string, amount = 10, transactionStatus = 'RELEASED') {
  const money = { currencyAmount: amount, currencyCode: 'EUR' }
  return { transactionId, transactionType: 'Shipment', transactionStatus, postedDate, totalAmount: money,
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId }],
    breakdowns: [{ breakdownType: 'Sales', breakdownAmount: money, breakdowns: [{ breakdownType: 'Product Charges', breakdownAmount: money, breakdowns: [] }] }] }
}
const count = async (sql: string, values: unknown[] = []) => (await q(sql, values)).rows[0].n as number
/** Sessions of this database waiting on a lock — the witness that a writer is really in flight. */
async function waitForLockWaiters(n: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await count(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`) >= n) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}
/** Every finance and order row of the case's business, byte for byte. */
const domainRows = async () => Promise.all(['FinancialTransaction', 'Order'].map(table =>
  q(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "workspaceId" = $1 ORDER BY id`, [ws]).then(result => result.rows)))

describe.skipIf(!concurrentDatabaseUrl())('Amazon Finances dry run and attribution on the base schema (real PostgreSQL)', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('TZ', ZONE)
    // The fixture sets the zone on the database before any session opens (its pools stay open from
    // setup on), so every session inherits it: the owner's and the restricted runtime login's alike.
    database = await concurrentDatabase({ maxConnections: 12, timeZone: ZONE })
    expect((await q('SHOW timezone')).rows[0].TimeZone).toBe(ZONE)
    expect((await database.client.$queryRaw<Array<{ zone: string }>>`SELECT current_setting('TimeZone') AS zone`)[0].zone).toBe(ZONE)
    const server = new URL(process.env[CONCURRENT_PG_ENV]!)
    server.pathname = `/${database.name}`
    const admin = new pg.Client({ connectionString: server.toString() })
    await admin.connect()
    expect((await admin.query('SHOW timezone')).rows[0].TimeZone).toBe(ZONE)
    await admin.end()
    // The premise of this suite: the held A3 objects do not exist here.
    expect((await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'FinancialTransaction' AND column_name IN ('channelConnectionId','providerScheme','providerTransactionId')`)).rows[0].n).toBe(0)
    expect((await q(`SELECT to_regclass('"AmazonFinanceCutover"') AS t`)).rows[0].t).toBeNull()
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  describe('A2 — the Finances dry run writes no finance or order row', () => {
    beforeEach(async () => { ws = await newProfile(); h.account = await usable(ws) })
    const window = () => { const start = new Date(Date.now() - 2 * 86_400_000); return { start, end: new Date(Date.now() - 86_400_000), posted: new Date(start.getTime() + 3_600_000).toISOString() } }

    it('🔴 every finance and order row is unchanged — and the positive control shows the input WOULD write one row', async () => {
      const channelOrderId = '404-0000800-0000001'
      await order(ws, channelOrderId, h.account)
      const { start, end, posted } = window()
      h.pages = [tx2024('tx-dry', channelOrderId, posted)]
      const before = await domainRows()
      const summary = await inWs(() => syncFinancialTransactions(start, end, 'APJ6JRA9NG5V4', { dryRun: true, accountId: h.account }))
      // Positive control: the transaction matched this account's order and mapped — so "no row" is a real zero.
      expect(summary).toMatchObject({ dryRun: true, txCreated: 0, txWouldCreate: 1, ordersMatched: 1, census: { outcomes: { mapped: 1 } } })
      expect(await domainRows()).toEqual(before)
    })

    it.each(['transaction total', 'stable item association'])('review P3 — conflicting %s refuses the dry run and leaves every finance and order row unchanged', async conflict => {
      const amazonId = 'dry-run-conflicting-money'
      const orderId = await order(ws, amazonId, h.account)
      const { start, end, posted } = window()
      await legacyRow(ws, orderId, amazonId, posted)
      const item = (id: string, amount: number) => ({ totalAmount: { currencyAmount: amount, currencyCode: 'EUR' },
        relatedIdentifiers: [{ itemRelatedIdentifierName: 'ORDER_ADJUSTMENT_ITEM_ID', itemRelatedIdentifierValue: id }] })
      const first = tx2024('tx-conflicting-observations', amazonId, posted, 10)
      h.pages = conflict === 'transaction total' ? [first, tx2024('tx-conflicting-observations', amazonId, posted, 11)]
        : [{ ...first, items: [item('A', 6), item('B', 4)] }, { ...first, items: [item('A', 4), item('B', 6)] }]
      const before = await domainRows()
      await expect(inWs(() => syncFinancialTransactions(start, end, 'APJ6JRA9NG5V4', { dryRun: true, accountId: h.account }))).rejects.toThrow(/conflicting money/)
      expect(await domainRows()).toEqual(before)
    })
  })

  describe('A5 — attribution of historical Amazon orders', () => {
    const IT = 'APJ6JRA9NG5V4', DE = 'A1PA6795UKMFR9', FR = 'A13V1IB3VIYZZH'
    async function scope(workspaceId: string, connectionId: string, marketplaceId: string) {
      await q(`INSERT INTO "ConnectionScope" (id,"workspaceId","connectionId",kind,"externalId","updatedAt") VALUES ($1,$2,$3,'marketplace',$4,now())`, [randomUUID(), workspaceId, connectionId, marketplaceId])
    }
    const linkOf = async (orderId: string) => (await q('SELECT "channelConnectionId" AS c FROM "Order" WHERE id = $1', [orderId])).rows[0].c as string | null
    async function withClient<T>(work: (client: pg.PoolClient) => Promise<T>) {
      const client = await database.pool.connect()
      try { return await work(client) } finally { client.release() }
    }

    it('🔴 attributes only orders with exactly ONE runtime-usable matching account; ambiguous, inactive-only and unmatched orders are untouched and reported', async () => {
      const one = await newProfile(), two = await newProfile(), three = await newProfile(), four = await newProfile()
      const itAccount = await usable(one), deAccount = await usable(one)
      await scope(one, itAccount, IT); await scope(one, deAccount, DE)
      const itOrder = await order(one, '404-0001000-0000001', null, { MarketplaceId: IT })
      const deOrder = await order(one, '404-0001000-0000002', null, { MarketplaceId: DE })
      const frOrder = await order(one, '404-0001000-0000003', null, { MarketplaceId: FR })
      const unknownMarket = await order(one, '404-0001000-0000004', null, {})
      // A stored SellerId is not part of the rule (v0/2026 order payloads carry none): only the market decides.
      const withSellerField = await order(one, '404-0001000-0000005', null, { MarketplaceId: IT, SellerId: 'SOMEONE-ELSE' })
      // An account that declares no marketplaces matches every marketplace…
      const soleAccount = await usable(two)
      const soleOrder = await order(two, '404-0001000-0000007', null, { MarketplaceId: FR })
      // …so beside a scoped account it makes an order ambiguous, never less.
      const scoped = await usable(three)
      await usable(three)
      await scope(three, scoped, IT)
      const mixedOrder = await order(three, '404-0001000-0000008', null, { MarketplaceId: IT })
      // review #3 — an inactive (legacy) account is never a target: alone it leaves the order untouched…
      const inactive = await connection(four)
      await scope(four, inactive, IT)
      const inactiveOnly = await order(four, '404-0001000-0000009', null, { MarketplaceId: IT })
      // …and beside one usable account it does not block, but it is reported.
      await scope(four, inactive, DE)
      const usableFour = await usable(four)
      await scope(four, usableFour, DE)
      const deFour = await order(four, '404-0001000-0000010', null, { MarketplaceId: DE })
      // An active row that needs sign-in is not usable either (amazonAccount() refuses it).
      const five = await newProfile(), reauth = randomUUID()
      await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'AMAZON',$3,true,'oauth','needs_reauth',now())`, [reauth, five, `SELLER-${reauth.slice(0, 8)}`])
      const reauthOrder = await order(five, '404-0001000-0000011', null, { MarketplaceId: IT })
      const census = await withClient(client => runAttributionCensus(client))
      expect(census.readProof).toMatchObject({ bypassesRowSecurity: true })
      expect(census.amazonOrdersVisible).toBeGreaterThanOrEqual(10)
      expect(census.attributableByAccount).toEqual(expect.arrayContaining([
        { workspaceId: one, connectionId: itAccount, orders: 2 },
        { workspaceId: one, connectionId: deAccount, orders: 1 },
        { workspaceId: two, connectionId: soleAccount, orders: 1 },
        { workspaceId: four, connectionId: usableFour, orders: 1 },
      ]))
      expect(census.inactiveMatchesByAccount).toEqual(expect.arrayContaining([{ workspaceId: four, connectionId: inactive, orders: 2 }, { workspaceId: five, connectionId: reauth, orders: 1 }]))
      expect(census.inactiveOnly).toBeGreaterThanOrEqual(1)
      expect(census.attributableAlsoMatchingInactive).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(census)).not.toContain('404-0001000')
      const result = await withClient(client => executeAttribution(client, { batch: 1000 }))
      expect(result.complete).toBe(true)
      expect(await linkOf(itOrder)).toBe(itAccount)
      expect(await linkOf(withSellerField)).toBe(itAccount)
      expect(await linkOf(deOrder)).toBe(deAccount)
      expect(await linkOf(soleOrder)).toBe(soleAccount)
      expect(await linkOf(deFour)).toBe(usableFour)
      for (const untouched of [frOrder, unknownMarket, mixedOrder, inactiveOnly, reauthOrder]) expect(await linkOf(untouched)).toBeNull()
    })

    it('🔴 trim mutation survivor — an INACTIVE account is never a target even when it is connected and identified', async () => {
      // Every inactive fixture above is also 'disconnected', so dropping the isActive test from the usable
      // predicate passed them all (mutation a5-inactive-target, 2026-09-26). This account differs ONLY by isActive.
      const ws1 = await newProfile(), paused = randomUUID()
      await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'AMAZON',$3,false,'oauth','connected',now())`, [paused, ws1, `SELLER-${paused.slice(0, 8)}`])
      const orderId = await order(ws1, '404-0001020-0000001', null, { MarketplaceId: IT })
      const census = await withClient(client => runAttributionCensus(client))
      expect(census.attributableByAccount.filter(row => row.workspaceId === ws1)).toEqual([])
      expect(census.inactiveMatchesByAccount).toEqual(expect.arrayContaining([{ workspaceId: ws1, connectionId: paused, orders: 1 }]))
      await withClient(client => executeAttribution(client, { batch: 1000 }))
      expect(await linkOf(orderId)).toBeNull()
    })

    it('reports Amazon orders by linked account and whether that account is runtime-usable (counts only)', async () => {
      const ws1 = await newProfile()
      const live = await usable(ws1), old = await connection(ws1)
      await order(ws1, '404-0001050-0000001', live)
      const oldOrder = await order(ws1, '404-0001050-0000002', old)
      await legacyRow(ws1, oldOrder, '404-0001050-0000002', '2026-09-20T10:00:00Z')
      await order(ws1, '404-0001050-0000003', null)
      const rows = (await withClient(client => runAttributionCensus(client))).ordersByLinkedAccount.filter(r => r.workspaceId === ws1)
      expect(rows).toEqual(expect.arrayContaining([
        { workspaceId: ws1, connectionId: live, usable: true, isActive: true, orders: 1, financeRows: 0 },
        { workspaceId: ws1, connectionId: old, usable: false, isActive: false, orders: 1, financeRows: 1 },
        { workspaceId: ws1, connectionId: null, usable: null, isActive: null, orders: 1, financeRows: 0 },
      ]))
    })

    it('🔴 "could not read" is never reported as "measured empty": a role that cannot bypass row security is refused', async () => {
      await withClient(async client => {
        await client.query('SET ROLE nexus_workspace_runtime')
        try {
          await expect(runAttributionCensus(client)).rejects.toThrow(/cannot read every business/)
          await expect(executeAttribution(client, { batch: 10 })).rejects.toThrow(/cannot read every business/)
        } finally { await client.query('RESET ROLE') }
      })
    })

    it('the census is read-only: the same statement that attributes is refused inside its transaction mode', async () => {
      const ws1 = await newProfile()
      await usable(ws1)
      const orderId = await order(ws1, '404-0001100-0000001', null, { MarketplaceId: IT })
      await withClient(async client => {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await expect(attributeBatch(client, 10)).rejects.toMatchObject({ code: '25006' })
        await client.query('ROLLBACK')
      })
      expect(await linkOf(orderId)).toBeNull()
    })

    it('🔴 a race with ingestion does not overwrite: an import that links the order first wins', async () => {
      const ws1 = await newProfile()
      const first = await usable(ws1)
      const orderId = await order(ws1, '404-0001200-0000001', null, { MarketplaceId: IT })
      // Ingestion, mid-transaction: a second account connects and imports this order (not yet committed).
      const ingestion = await database.pool.connect()
      await ingestion.query('BEGIN')
      const second = randomUUID()
      await ingestion.query(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","managedBy","authStatus","updatedAt") VALUES ($1,$2,'AMAZON','LATE-SELLER',false,'oauth','disconnected',now())`, [second, ws1])
      await ingestion.query(`UPDATE "Order" SET "channelConnectionId" = $2 WHERE id = $1 AND "channelConnectionId" IS NULL`, [orderId, second])
      // The backfill still sees one usable account and picks it, then waits on the row the import holds.
      const backfill = withClient(client => executeAttribution(client, { batch: 1000 }))
      expect(await waitForLockWaiters(1)).toBe(true)
      await ingestion.query('COMMIT'); ingestion.release()
      const result = await backfill
      expect(result.lostToConcurrentLink).toBeGreaterThanOrEqual(1)
      expect(await linkOf(orderId)).toBe(second)
      expect(first).not.toBe(second)
    })
  })
})
