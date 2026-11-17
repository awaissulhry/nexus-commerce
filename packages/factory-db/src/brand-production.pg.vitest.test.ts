import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedBrandProduction, type BrandProductionSeed } from '../seed/brand-production'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * B-PR-15 (production plan, schema wave 3/5; lead picks L17, L18, L20, L21, L24; review fixes R-41…R-49): a customer's production
 * state of its orders, the issues that need an answer and the plain production hold, on a database built from the migrations
 * and seeded (seed/brand-production.ts: P1's SEED-SO-0002 and SEED-SO-0003 Urgent, SEED-SO-0001 locked by us; Seed Brand Two's
 * open BRAND issue; SEED-WO-0001's lifted hold), through the real login and the scoped client.
 *   - PW-15 (DB part): P2's partner role reads no P1 BrandOrderProduction row (and P1 none of the second brand's), never the
 *     office's note on a raise, who raised it, who set or locked an urgency, the supervisor or since when; no partner grant on
 *     ProductionIssue; the partner role cannot SELECT SalesOrder.priority or SalesOrderLine.priority; WorkOrderHold is the
 *     office's and its own site's floor's (never the office's note), no partner grant;
 *   - the guards (…_brand_production_guards), for every login: urgentRank exactly while URGENT and 1 or more; who set an
 *     urgency, both or neither, a BRAND mark by a portal person of the order's own customer (PW-11 DB part); a locked row
 *     REGULAR with its reason, when and by whom; the supervisor with since when, an active office person; the health raise
 *     only to AT_RISK, all or none; one row per order (the key); ProductionIssue about one customer's record, with its task and
 *     a message of its record's own thread, answeredAt exactly when ANSWERED, escalation step 0-2, never deleted; the hold's
 *     life; WorkOrder_production_holds: no leaving ON_HOLD while an ACTIVE WorkOrderHold names it.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'pr15-production'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: BrandProductionSeed
let production: ProductionSeed
let second: SecondBrand

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const P2 = key('party:P2')
const companyA = key('company:A')
const siteA1 = key('site:A1')
const buyer = key('portal:user:P1:buyer')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partnerOf = (partyId: string, actorId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: siteA1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** UPDATE row `id` of `table` with `changes` (office). */
const update = (table: string, id: string, changes: Record<string, unknown>) => {
  const sets = Object.keys(changes).map((column) => `"${column}" = r."${column}"`).join(', ')
  return run(office(), `UPDATE "${table}" t SET ${sets} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(changes), id)
}
const NOW = () => new Date().toISOString()
const TODAY = () => new Date().toISOString().slice(0, 10)
/** A week from now (a due day after the raise's day in Rome, whatever the hour). */
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
/** A placing time before any lift the test writes. */
const PLACED_BEFORE = '2026-11-15T11:00:00.000Z'

/** A person of the tenant (office scope): an office one by default; returns its id. */
const person = async (changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `u.${id}@example.com`, displayName: 'Test Person', status: 'ACTIVE', ...changes })
  return id
}
/** A CONFIRMED order of a customer of company A (typed by the office), to hang one production state row on. */
const newOrder = async (partyId = P1): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'SalesOrder', { id, companyId: companyA, partyId, number: `T-PR15-${id.slice(0, 8)}`, status: 'CONFIRMED', orderDate: TODAY(), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' } })
  return id
}
/** A production state row of an order (the key its own). */
const productionRow = async (orderId: string, changes: Record<string, unknown> = {}, partyId = P1): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'BrandOrderProduction', { id, companyId: companyA, partyId, salesOrderId: orderId, key: `brand-production:${orderId}`, ...changes })
  return id
}
const marked = (setById: string | null = buyer) => ({ urgency: 'URGENT', urgentRank: 1, urgencySetAt: NOW(), urgencySetBy: 'BRAND', urgencySetById: setById })

const U = { suspended: '', p2Partner: '' }

beforeAll(async () => {
  db = await migratedDatabase('brandproduction')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seeded = await seedBrandProduction({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
  U.suspended = await person({ status: 'SUSPENDED' })
  U.p2Partner = await person({ audience: 'PARTNER', partyId: P2, partnerKind: 'SUPPLIER' })
}, 600_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('what the partner role reads (PW-15, DB part)', () => {
  it('a customer reads its own orders’ production state only — never another customer’s row', async () => {
    const own = await sql(partnerOf(P1, buyer), `SELECT id::text AS id FROM "BrandOrderProduction" ORDER BY id`)
    expect(own.map((row) => row.id).sort()).toEqual([seeded.rowIds.so1, seeded.rowIds.so2, seeded.rowIds.so3].sort())
    expect(await sql(partnerOf(P1, buyer), `SELECT id FROM "BrandOrderProduction" WHERE id = $1::uuid`, seeded.rowIds.secondBrand)).toEqual([])
    // Not vacuous: the second brand reads exactly its own row, and none of P1's.
    const theirs = await sql(partnerOf(second.partyId, second.userId), `SELECT id::text AS id, "partyId"::text AS party FROM "BrandOrderProduction"`)
    expect(theirs).toEqual([{ id: seeded.rowIds.secondBrand, party: second.partyId }])
    // P2 (a supplier) reads none.
    expect(await sql(partnerOf(P2, U.p2Partner), `SELECT id FROM "BrandOrderProduction"`)).toEqual([])
    // What it does read: its urgency, its place, who set it (BRAND or FACTORY, never a name), the lock and its reason.
    const rows = await sql(partnerOf(P1, buyer), `SELECT "salesOrderId"::text AS "order", urgency::text AS urgency, "urgentRank", "urgencySetBy"::text AS "setBy", "urgencyLocked" AS locked, "urgencyLockReason" AS reason, "healthSet"::text AS raised, "healthReasonCode"::text AS reason_code FROM "BrandOrderProduction"`)
    const byOrder = new Map(rows.map((row) => [row.order, row]))
    expect(byOrder.get(seeded.orderIds.so2)).toMatchObject({ urgency: 'URGENT', urgentRank: 1, setBy: 'BRAND', locked: false })
    expect(byOrder.get(seeded.orderIds.so3)).toMatchObject({ urgency: 'URGENT', urgentRank: 2, raised: 'AT_RISK', reason_code: 'QUALITY' })
    expect(byOrder.get(seeded.orderIds.so1)).toMatchObject({ urgency: 'REGULAR', urgentRank: null, setBy: 'FACTORY', locked: true, reason: expect.stringContaining('deposit') })
  })

  it('never reads the office’s note, who raised the health, who set or locked an urgency, the supervisor or since when', async () => {
    for (const column of ['healthNote', 'healthSetById', 'urgencySetById', 'urgencyLockedById', 'supervisorId', 'supervisorAssignedAt', 'createdById']) {
      const [grant] = await admin(`SELECT has_column_privilege($1, '"BrandOrderProduction"', $2, 'SELECT') AS granted`, [PARTNER_ROLE, column])
      expect(grant!.granted, column).toBe(false)
      await expect(sql(partnerOf(P1, buyer), `SELECT "${column}" FROM "BrandOrderProduction" LIMIT 1`), column).rejects.toThrow(DENIED)
    }
    for (const column of ['urgency', 'urgentRank', 'urgencySetBy', 'urgencyBatchId', 'urgencyLocked', 'urgencyLockReason', 'stage', 'health', 'healthReasonCode', 'waitingOn']) {
      const [grant] = await admin(`SELECT has_column_privilege($1, '"BrandOrderProduction"', $2, 'SELECT') AS granted`, [PARTNER_ROLE, column])
      expect(grant!.granted, column).toBe(true)
    }
    // Prisma's default select names every column, so a forgotten `select` fails loudly; the partner writes nothing here.
    await expect(as(partnerOf(P1, buyer), (client) => client.brandOrderProduction.findMany())).rejects.toThrow(DENIED)
    await expect(run(partnerOf(P1, buyer), `UPDATE "BrandOrderProduction" SET urgency = 'URGENT' WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(partnerOf(P1, buyer), `INSERT INTO "BrandOrderProduction" (id) VALUES (NULL)`)).rejects.toThrow(DENIED)
  })

  it('has no grant on ProductionIssue (nor the floor); never SalesOrder.priority or SalesOrderLine.priority', async () => {
    for (const role of [PARTNER_ROLE, FLOOR_ROLE]) {
      const [grants] = await admin(
        `SELECT has_table_privilege($1, '"ProductionIssue"', 'SELECT') AS "select", has_table_privilege($1, '"ProductionIssue"', 'INSERT') AS "insert", has_any_column_privilege($1, '"ProductionIssue"', 'SELECT') AS "anyColumn"`,
        [role],
      )
      expect(grants, role).toEqual({ select: false, insert: false, anyColumn: false })
    }
    await expect(sql(partnerOf(second.partyId, second.userId), `SELECT 1 FROM "ProductionIssue" LIMIT 1`)).rejects.toThrow(DENIED)
    for (const table of ['SalesOrder', 'SalesOrderLine']) {
      const [grant] = await admin(`SELECT has_column_privilege($1, format('%I', $2::text), 'priority', 'SELECT') AS granted`, [PARTNER_ROLE, table])
      expect(grant!.granted, table).toBe(false)
      await expect(sql(partnerOf(P1, buyer), `SELECT priority FROM "${table}" LIMIT 1`), table).rejects.toThrow(DENIED)
    }
    // The orders themselves still read (their number, status and dates).
    expect((await sql(partnerOf(P1, buyer), `SELECT number FROM "SalesOrder" WHERE id = $1::uuid`, seeded.orderIds.so2))[0]).toEqual({ number: 'SEED-SO-0002' })
  })

  it('WorkOrderHold: the office’s and its own site’s floor (never the office’s note); no partner grant', async () => {
    const [partner] = await admin(`SELECT has_table_privilege($1, '"WorkOrderHold"', 'SELECT') AS "select", has_any_column_privilege($1, '"WorkOrderHold"', 'SELECT') AS "anyColumn"`, [PARTNER_ROLE])
    expect(partner).toEqual({ select: false, anyColumn: false })
    const seen = await sql(floor(), `SELECT id::text AS id, "reasonCode", status::text AS status FROM "WorkOrderHold" WHERE id = $1::uuid`, seeded.holdId)
    expect(seen).toEqual([{ id: seeded.holdId, reasonCode: 'MATERIAL_MISSING', status: 'LIFTED' }])
    await expect(sql(floor(), `SELECT note FROM "WorkOrderHold" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "WorkOrderHold" SET "brandWords" = "brandWords" WHERE false`)).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('BrandOrderProduction (…_brand_production_guards)', () => {
  it('one row per order, by its key `brand-production:<salesOrderId>`', async () => {
    const order = await newOrder()
    await expect(insert(office(), 'BrandOrderProduction', { id: randomUUID(), companyId: companyA, partyId: P1, salesOrderId: order, key: `brand-production:${randomUUID()}` })).rejects.toThrow(/brand-production:<salesOrderId>/)
    await productionRow(order)
    await expect(productionRow(order)).rejects.toThrow(/duplicate key|unique/)
    // The isolation tests' copy (a `-…` suffix) passes; the app writes the key itself.
    expect(await insert(office(), 'BrandOrderProduction', { id: randomUUID(), companyId: companyA, partyId: P1, salesOrderId: order, key: `brand-production:${order}-copy-1` })).toBe(1)
    // The order's own customer (the foreign key): another customer's order is refused.
    await expect(productionRow(await newOrder(), {}, second.partyId)).rejects.toThrow(/foreign key/)
  })

  it('urgentRank is set exactly while Urgent and is 1 or more; an Urgent mark says who set it and when', async () => {
    await expect(productionRow(await newOrder(), { ...marked(), urgentRank: null })).rejects.toThrow(/exactly while it is Urgent/)
    await expect(productionRow(await newOrder(), { urgency: 'REGULAR', urgentRank: 1 })).rejects.toThrow(/exactly while it is Urgent/)
    await expect(productionRow(await newOrder(), { ...marked(), urgentRank: 0 })).rejects.toThrow(/exactly while it is Urgent/)
    await expect(productionRow(await newOrder(), { urgency: 'URGENT', urgentRank: 1 })).rejects.toThrow(/an Urgent mark always has them/)
    await expect(productionRow(await newOrder(), { urgencySetAt: NOW() })).rejects.toThrow(/both or neither/)
    await expect(productionRow(await newOrder(), { urgencySetById: buyer })).rejects.toThrow(/both or neither/)
    const row = await productionRow(await newOrder(), marked())
    // No unique key on the place: the command rewrites the ranks 1..n (and a shipped order keeps its last urgency).
    expect(await productionRow(await newOrder(), marked())).toBeTruthy()
    // Back to Regular: the place goes with it.
    await expect(update('BrandOrderProduction', row, { urgency: 'REGULAR' })).rejects.toThrow(/exactly while it is Urgent/)
    expect(await update('BrandOrderProduction', row, { urgency: 'REGULAR', urgentRank: null, urgencySetAt: NOW() })).toBe(1)
  })

  it('a BRAND mark is set by a portal person of the order’s own customer, a FACTORY one by an office person (PW-11, DB part)', async () => {
    await expect(productionRow(await newOrder(), marked(second.userId))).rejects.toThrow(/portal person of its own customer/)
    await expect(productionRow(await newOrder(), marked(a.actorId))).rejects.toThrow(/portal person of its own customer/)
    await expect(productionRow(await newOrder(), { ...marked(buyer), urgencySetBy: 'FACTORY' })).rejects.toThrow(/office person \(FACTORY\)/)
    expect(await productionRow(await newOrder(), marked(buyer))).toBeTruthy()
    expect(await productionRow(await newOrder(), { ...marked(a.actorId), urgencySetBy: 'FACTORY' })).toBeTruthy()
    // The system (no person) may set it too.
    expect(await productionRow(await newOrder(), marked(null))).toBeTruthy()
  })

  it('a locked order is Regular, with the reason its customer reads, when and by whom', async () => {
    const urgent = await productionRow(await newOrder(), marked())
    const lock = { urgencyLocked: true, urgencyLockReason: 'Made-up: our plan for this week.', urgencyLockedAt: NOW(), urgencyLockedById: a.actorId }
    await expect(update('BrandOrderProduction', urgent, lock)).rejects.toThrow(/locked by us is Regular/)
    const regular = await productionRow(await newOrder())
    await expect(update('BrandOrderProduction', regular, { ...lock, urgencyLockReason: null })).rejects.toThrow(/exactly while it is locked/)
    await expect(update('BrandOrderProduction', regular, { ...lock, urgencyLockedById: null })).rejects.toThrow(/exactly while it is locked/)
    await expect(update('BrandOrderProduction', regular, { ...lock, urgencyLockReason: 'Two\nlines' })).rejects.toThrow(/one line of at most 500/)
    await expect(update('BrandOrderProduction', regular, { ...lock, urgencyLockReason: 'x'.repeat(501) })).rejects.toThrow(/one line of at most 500/)
    await expect(update('BrandOrderProduction', regular, { ...lock, urgencyLockedById: buyer })).rejects.toThrow(/active office person/)
    await expect(update('BrandOrderProduction', regular, { ...lock, urgencyLockedById: U.suspended })).rejects.toThrow(/active office person/)
    expect(await update('BrandOrderProduction', regular, lock)).toBe(1)
    // Unlocked: the reason, when and by whom go too.
    await expect(update('BrandOrderProduction', regular, { urgencyLocked: false })).rejects.toThrow(/exactly while it is locked/)
    expect(await update('BrandOrderProduction', regular, { urgencyLocked: false, urgencyLockReason: null, urgencyLockedAt: null, urgencyLockedById: null })).toBe(1)
  })

  it('names its supervisor with since when, or neither; an active office person when named or changed', async () => {
    const row = await productionRow(await newOrder())
    await expect(update('BrandOrderProduction', row, { supervisorId: a.actorId })).rejects.toThrow(/together with since when/)
    await expect(update('BrandOrderProduction', row, { supervisorAssignedAt: NOW() })).rejects.toThrow(/together with since when/)
    await expect(update('BrandOrderProduction', row, { supervisorId: buyer, supervisorAssignedAt: NOW() })).rejects.toThrow(/active office person/)
    await expect(update('BrandOrderProduction', row, { supervisorId: U.suspended, supervisorAssignedAt: NOW() })).rejects.toThrow(/active office person/)
    const supervisor = await person()
    expect(await update('BrandOrderProduction', row, { supervisorId: supervisor, supervisorAssignedAt: NOW() })).toBe(1)
    // The Inquiry assignee's rule: made inactive later, the person stays named until the office changes it.
    expect(await update('User', supervisor, { status: 'SUSPENDED' })).toBe(1)
    expect(await update('BrandOrderProduction', row, { waitingOn: 'US', waitingSince: NOW() })).toBe(1)
    // Back to the customer's default: both go.
    expect(await update('BrandOrderProduction', row, { supervisorId: null, supervisorAssignedAt: null })).toBe(1)
  })

  it('raises the health only to AT_RISK, with its reason code, when, by whom and until when; the office’s note only beside it', async () => {
    const row = await productionRow(await newOrder(), { health: 'ON_TRACK', healthAt: NOW() })
    const raise = { healthSet: 'AT_RISK', healthReasonCode: 'MATERIAL_LATE', healthSetAt: NOW(), healthSetById: a.actorId, healthSetUntil: TODAY() }
    await expect(update('BrandOrderProduction', row, { ...raise, healthSet: 'ON_TRACK' })).rejects.toThrow(/AT_RISK only/)
    await expect(update('BrandOrderProduction', row, { ...raise, healthSetUntil: null })).rejects.toThrow(/reason code, when, by whom and until when/)
    await expect(update('BrandOrderProduction', row, { healthNote: 'Made-up: waiting for the lining.' })).rejects.toThrow(/only beside a raise/)
    await expect(update('BrandOrderProduction', row, { ...raise, healthNote: 'x'.repeat(201) })).rejects.toThrow(/one line of at most 200/)
    expect(await update('BrandOrderProduction', row, { ...raise, healthNote: 'Made-up: waiting for the lining.' })).toBe(1)
    // The raise drops whole.
    await expect(update('BrandOrderProduction', row, { healthSet: null, healthReasonCode: null, healthSetAt: null, healthSetById: null, healthSetUntil: null })).rejects.toThrow(/only beside a raise/)
    expect(await update('BrandOrderProduction', row, { healthSet: null, healthReasonCode: null, healthSetAt: null, healthSetById: null, healthSetUntil: null, healthNote: null })).toBe(1)
  })

  it('waits since a time only on someone', async () => {
    await expect(productionRow(await newOrder(), { waitingSince: NOW() })).rejects.toThrow(/waits since a time only on someone/)
    expect(await productionRow(await newOrder(), { waitingOn: 'SUPPLIER', waitingSince: NOW() })).toBeTruthy()
  })

  it('keeps its order, customer, key and creation; never deleted, never truncated', async () => {
    const order = await newOrder()
    const row = await productionRow(order)
    await expect(update('BrandOrderProduction', row, { salesOrderId: await newOrder() })).rejects.toThrow(/never change/)
    await expect(update('BrandOrderProduction', row, { key: `brand-production:${order}-other` })).rejects.toThrow(/never change/)
    expect(await update('BrandOrderProduction', row, { stage: 'CUTTING', stageAt: NOW() })).toBe(1)
    await expect(admin(`DELETE FROM "BrandOrderProduction" WHERE id = $1`, [row])).rejects.toThrow(/kept, never deleted/)
    await expect(admin(`TRUNCATE "BrandOrderProduction"`)).rejects.toThrow(/TRUNCATE on "BrandOrderProduction" is refused/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('ProductionIssue (…_brand_production_guards)', () => {
  const thread = async (recordType: string, recordId: string, extra: Record<string, unknown>): Promise<string> => {
    const [found] = await admin(`SELECT id::text AS id FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3`, [a.tenantId, recordType, recordId])
    if (found) return found.id as string
    const id = randomUUID()
    await insert(office(), 'Thread', { id, companyId: companyA, recordType, recordId, replyToken: randomUUID().replace(/-/g, ''), ...extra })
    return id
  }
  const message = async (threadId: string, row: Record<string, unknown>): Promise<string> => {
    const id = randomUUID()
    await insert(office(), 'Message', { id, threadId, channel: 'APP', bodyText: 'Made-up: the zip of two jackets is the wrong colour.', at: NOW(), ...row })
    return id
  }
  const task = async (row: Record<string, unknown>): Promise<string> => {
    const id = randomUUID()
    await insert(office(), 'Task', { id, companyId: companyA, title: 'Made-up: answer the customer', ...row })
    return id
  }
  const R = { so2Message: '', so2Task: '', woMessage: '', woTask: '' }
  const so2 = () => seeded.orderIds.so2
  const wo1 = () => production.workOrderId
  /** A new issue on SEED-SO-0002 (P1) raised with P1's own portal message (BRAND by default). */
  const issueOf = async (changes: Record<string, unknown> = {}): Promise<string> => {
    const id = randomUUID()
    await insert(office(), 'ProductionIssue', {
      id,
      companyId: companyA,
      partyId: P1,
      recordType: 'SalesOrder',
      recordId: so2(),
      salesOrderId: so2(),
      taskId: R.so2Task,
      messageId: R.so2Message,
      source: 'BRAND',
      raisedAt: NOW(),
      dueDate: NEXT_WEEK(),
      ...changes,
    })
    return id
  }

  beforeAll(async () => {
    const orderThread = await thread('SalesOrder', so2(), { partyId: P1 })
    R.so2Message = await message(orderThread, { partyId: P1, direction: 'INBOUND', audience: 'PARTNER', authorKind: 'PARTY', authorName: 'Made-up buyer' })
    R.so2Task = await task({ partyId: P1, recordType: 'SalesOrder', recordId: so2(), recordLabel: 'SEED-SO-0002' })
    const workThread = await thread('WorkOrder', wo1(), { siteId: siteA1 })
    R.woMessage = await message(workThread, { direction: 'INTERNAL_NOTE', audience: 'OFFICE', authorKind: 'USER', authorId: a.actorId, authorName: 'Made-up office', bodyText: 'Made-up: @supervisor the sleeves do not match.' })
    R.woTask = await task({ siteId: siteA1, partyId: P1, recordType: 'WorkOrder', recordId: wo1(), recordLabel: 'SEED-WO-0001' })
  }, 120_000)

  it('the seeded issue: OPEN on Seed Brand Two’s order, its task on the SALES ORDER, its message in that order’s thread', async () => {
    const [row] = await admin(
      `SELECT i.status::text AS status, i.source::text AS source, i."partyId"::text AS party, i."recordType", t."recordType" AS "taskRecordType", t."recordId"::text AS "taskRecord", th."recordId"::text AS "messageRecord"
         FROM "ProductionIssue" i JOIN "Task" t ON t.id = i."taskId" JOIN "Message" m ON m.id = i."messageId" JOIN "Thread" th ON th.id = m."threadId" WHERE i.id = $1`,
      [seeded.issue.id],
    )
    expect(row).toEqual({ status: 'OPEN', source: 'BRAND', party: second.partyId, recordType: 'SalesOrder', taskRecordType: 'SalesOrder', taskRecord: second.salesOrderId, messageRecord: second.salesOrderId })
  })

  it('a new issue is OPEN, about a sales order or a work order of ONE customer, carrying its record’s company, site and customer', async () => {
    await expect(issueOf({ status: 'ANSWERED', answeredAt: NOW() })).rejects.toThrow(/is OPEN, unanswered and not escalated/)
    await expect(issueOf({ escalationStep: 1, escalatedAt: NOW() })).rejects.toThrow(/is OPEN, unanswered and not escalated/)
    await expect(issueOf({ recordType: 'Quote' })).rejects.toThrow(/about a SalesOrder or a WorkOrder/)
    await expect(issueOf({ salesOrderId: null })).rejects.toThrow(/carries its record's company, site and customer/)
    await expect(issueOf({ siteId: siteA1 })).rejects.toThrow(/carries its record's company, site and customer/)
    // PW-17 (DB part): an issue never names another customer's record (the customer of a work order of P1 is P1).
    await expect(issueOf({ partyId: second.partyId, salesOrderId: null })).rejects.toThrow(/carries its record's company, site and customer/)
    expect(await issueOf()).toBeTruthy()
    // A work order's issue: its site and customer, its single order (or none), its own thread's message and a task.
    const onWork = { recordType: 'WorkOrder', recordId: wo1(), taskId: R.woTask, messageId: R.woMessage, source: 'OFFICE' }
    await expect(issueOf({ ...onWork, siteId: null })).rejects.toThrow(/carries its record's company, site and customer/)
    expect(await issueOf({ ...onWork, siteId: siteA1 })).toBeTruthy()
    expect(await issueOf({ ...onWork, siteId: siteA1, salesOrderId: null })).toBeTruthy()
  })

  it('its task is a task of this tenant, its message one of its own record’s thread; due on or after the day it was raised', async () => {
    await expect(issueOf({ taskId: randomUUID() })).rejects.toThrow(/names a task of this session's/)
    await expect(issueOf({ messageId: R.woMessage })).rejects.toThrow(/message of its own record's thread/)
    await expect(issueOf({ messageId: second.messageIds[1] })).rejects.toThrow(/message of its own record's thread/)
    await expect(issueOf({ raisedAt: '2026-11-13T09:00:00.000Z', dueDate: '2026-11-12' })).rejects.toThrow(/falls due on or after the day it was raised/)
    // One Task per batch: every issue of a batch names the batch's task.
    const batchId = randomUUID()
    expect(await issueOf({ batchId })).toBeTruthy()
    expect(await issueOf({ batchId })).toBeTruthy()
  })

  it('answered exactly while ANSWERED; OPEN → ANSWERED or CANCELLED; an office issue reopens with its task, a brand one does not; CANCELLED is final', async () => {
    const brand = await issueOf()
    await expect(update('ProductionIssue', brand, { status: 'ANSWERED' })).rejects.toThrow(/exactly while it is ANSWERED/)
    await expect(update('ProductionIssue', brand, { answeredAt: NOW() })).rejects.toThrow(/exactly while it is ANSWERED/)
    await expect(update('ProductionIssue', brand, { status: 'ANSWERED', answeredAt: '2020-01-01T00:00:00.000Z' })).rejects.toThrow(/not before it was raised/)
    expect(await update('ProductionIssue', brand, { status: 'ANSWERED', answeredAt: NOW() })).toBe(1)
    await expect(update('ProductionIssue', brand, { status: 'OPEN', answeredAt: null })).rejects.toThrow(/cannot move from ANSWERED to OPEN/)
    const ours = await issueOf({ source: 'OFFICE' })
    expect(await update('ProductionIssue', ours, { status: 'ANSWERED', answeredAt: NOW() })).toBe(1)
    expect(await update('ProductionIssue', ours, { status: 'OPEN', answeredAt: null })).toBe(1)
    expect(await update('ProductionIssue', ours, { status: 'CANCELLED' })).toBe(1)
    await expect(update('ProductionIssue', ours, { status: 'OPEN' })).rejects.toThrow(/cannot move from CANCELLED to OPEN/)
  })

  it('escalates by step 0 to 2, with when exactly from step 1', async () => {
    const issue = await issueOf()
    await expect(update('ProductionIssue', issue, { escalationStep: 1 })).rejects.toThrow(/step 0 to 2/)
    await expect(update('ProductionIssue', issue, { escalationStep: 3, escalatedAt: NOW() })).rejects.toThrow(/step 0 to 2/)
    await expect(update('ProductionIssue', issue, { escalatedAt: NOW() })).rejects.toThrow(/step 0 to 2/)
    expect(await update('ProductionIssue', issue, { escalationStep: 1, escalatedAt: NOW() })).toBe(1)
    expect(await update('ProductionIssue', issue, { escalationStep: 2, escalatedAt: NOW() })).toBe(1)
  })

  it('what it is about never changes; never deleted, never truncated', async () => {
    const issue = await issueOf()
    for (const changes of [{ recordId: seeded.orderIds.so3, salesOrderId: seeded.orderIds.so3 }, { taskId: R.woTask }, { messageId: R.woMessage }, { source: 'OFFICE' }, { dueDate: '2099-01-01' }, { batchId: randomUUID() }]) {
      await expect(update('ProductionIssue', issue, changes), JSON.stringify(changes)).rejects.toThrow(/never change/)
    }
    await expect(admin(`DELETE FROM "ProductionIssue" WHERE id = $1`, [issue])).rejects.toThrow(/never deleted/)
    await expect(admin(`TRUNCATE "ProductionIssue"`)).rejects.toThrow(/TRUNCATE on "ProductionIssue" is refused/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('WorkOrderHold and WorkOrder_production_holds (…_brand_production_guards)', () => {
  const wo1 = () => production.workOrderId
  const wo2 = () => production.draftWorkOrderId
  /** A hold on a work order of P1 at A1 (PRODUCTION, ACTIVE by default). */
  const holdOf = async (changes: Record<string, unknown> = {}, workOrderId = wo1()): Promise<string> => {
    const id = randomUUID()
    await insert(office(), 'WorkOrderHold', { id, companyId: companyA, siteId: siteA1, workOrderId, partyId: P1, kind: 'PRODUCTION', reasonCode: 'MATERIAL_MISSING', placedAt: NOW(), placedById: a.actorId, ...changes })
    return id
  }
  /** P1 asks in its portal (the partner role writes its own asks). */
  const ask = async (kind: string): Promise<string> => {
    const id = randomUUID()
    await insert(partnerOf(P1, buyer), 'OrderChangeRequest', { id, companyId: companyA, partyId: P1, orderId: production.salesOrderId, kind, reason: 'Made-up: please wait for our new artwork.', createdById: buyer })
    return id
  }
  const lift = () => ({ status: 'LIFTED', liftedAt: NOW(), liftedById: a.actorId, liftReason: 'Made-up: the material came in.' })

  it('carries its work order’s company and customer; a production hold answers no ask, a customer’s hold its own HOLD ask', async () => {
    await expect(holdOf({ partyId: second.partyId })).rejects.toThrow(/carries its work order's company and customer/)
    await expect(holdOf({ partyId: null })).rejects.toThrow(/carries its work order's company and customer/)
    const change = await ask('CHANGE')
    await expect(holdOf({ requestId: change })).rejects.toThrow(/answers no customer's ask/)
    await expect(holdOf({ kind: 'BRAND', requestId: change })).rejects.toThrow(/HOLD ask of the work order's own customer/)
    await expect(holdOf({ kind: 'BRAND', requestId: randomUUID() })).rejects.toThrow(/HOLD ask of the work order's own customer/)
    expect(await holdOf({ kind: 'BRAND', requestId: await ask('HOLD'), brandWords: 'Paused at your request.' })).toBeTruthy()
    expect(await holdOf({ kind: 'BRAND' })).toBeTruthy()
  })

  it('a reason code, the office’s note and the customer’s words in shape; placed by an office person', async () => {
    await expect(holdOf({ reasonCode: 'material missing' })).rejects.toThrow(/PRODUCTION_HOLD reason list/)
    await expect(holdOf({ brandWords: 'Two\nlines' })).rejects.toThrow(/one line, at most 500/)
    await expect(holdOf({ note: 'x'.repeat(2001) })).rejects.toThrow(/at most 2000 characters/)
    await expect(holdOf({ placedById: buyer })).rejects.toThrow(/placed by an office person/)
    await expect(holdOf({ status: 'LIFTED' })).rejects.toThrow(/exactly while LIFTED/)
    // Written whole as history: LIFTED with its lift (the seed's, a copy).
    expect(await holdOf({ placedAt: PLACED_BEFORE, ...lift() })).toBeTruthy()
    await expect(holdOf({ placedAt: PLACED_BEFORE, ...lift(), liftedById: buyer })).rejects.toThrow(/lifted by an office person/)
  })

  it('ACTIVE → LIFTED once with when, by whom and why; while ACTIVE only the note and the words are put right; a lifted hold never changes', async () => {
    const hold = await holdOf()
    await expect(update('WorkOrderHold', hold, { reasonCode: 'CAPACITY' })).rejects.toThrow(/only the office's note and the customer's words/)
    await expect(update('WorkOrderHold', hold, { kind: 'BRAND' })).rejects.toThrow(/only the office's note and the customer's words/)
    expect(await update('WorkOrderHold', hold, { note: 'Made-up: the supplier promised Friday.', brandWords: 'Waiting for one material.' })).toBe(1)
    await expect(update('WorkOrderHold', hold, { status: 'LIFTED', liftedAt: NOW(), liftedById: a.actorId })).rejects.toThrow(/exactly while LIFTED/)
    await expect(update('WorkOrderHold', hold, { ...lift(), liftedAt: '2020-01-01T00:00:00.000Z' })).rejects.toThrow(/not before it was placed/)
    await expect(update('WorkOrderHold', hold, { ...lift(), reasonCode: 'CAPACITY' })).rejects.toThrow(/lifting hold .* changes only/)
    expect(await update('WorkOrderHold', hold, lift())).toBe(1)
    await expect(update('WorkOrderHold', hold, { note: 'Made-up: later words.' })).rejects.toThrow(/lifted; it never changes again/)
    await expect(admin(`DELETE FROM "WorkOrderHold" WHERE id = $1`, [hold])).rejects.toThrow(/lifted, never deleted/)
    await expect(admin(`TRUNCATE "WorkOrderHold"`)).rejects.toThrow(/TRUNCATE on "WorkOrderHold" is refused/)
  })

  it('a work order leaves ON_HOLD only when no ACTIVE production or customer hold names it (WorkOrder_production_holds)', async () => {
    const hold = await holdOf({}, wo2())
    const held = { status: 'ON_HOLD', heldFromStatus: 'DRAFT', holdReason: 'Made-up: material missing.', heldAt: NOW(), heldById: a.actorId, holdRecordType: 'WorkOrderHold', holdRecordId: hold }
    const back = { status: 'DRAFT', heldFromStatus: null, holdReason: null, heldAt: null, heldById: null, holdRecordType: null, holdRecordId: null }
    expect(await update('WorkOrder', wo2(), held)).toBe(1)
    await expect(update('WorkOrder', wo2(), back)).rejects.toThrow(/stays on hold while 1 production or customer hold\(s\) stand/)
    // A second hold on the held work order, then both lifted: only then it goes back.
    const more = await holdOf({ kind: 'BRAND' }, wo2())
    expect(await update('WorkOrderHold', hold, lift())).toBe(1)
    await expect(update('WorkOrder', wo2(), back)).rejects.toThrow(/stays on hold while 1 production or customer hold\(s\) stand/)
    expect(await update('WorkOrderHold', more, lift())).toBe(1)
    expect(await update('WorkOrder', wo2(), back)).toBe(1)
    expect((await admin(`SELECT status::text AS status FROM "WorkOrder" WHERE id = $1`, [wo2()]))[0]).toEqual({ status: 'DRAFT' })
  })
})
