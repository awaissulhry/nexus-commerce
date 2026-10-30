import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedPlanning, type PlanningSeed } from '../seed/planning'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2a schema wave 4/7 (stock and planning) beyond the generated isolation tests, on a database built from the
 * migrations and seeded, through the real login and the scoped client (…_stock_plan_w2a_guards):
 *   - the walls: the new tables are the office's; the floor reads its site's reservations and records an issue against
 *     one, nothing else; no capacity table names a person;
 *   - the planning runs' pegging is append-only for every login, the owner included;
 *   - reservations: their kinds, one demand, one ACTIVE reservation per hide, ACTIVE → ISSUED | RELEASED;
 *   - counts: the scope, submit once all is counted, the lines' history from SUBMITTED on, the counter never approves
 *     their own variance, apply with the COUNT moves, the year-end sign-off with its valued list;
 *   - the firm planned order of a requirement, and a later run carrying it;
 *   - item parameters, planning settings, line and work-centre capacity, pegging shapes and exceptions;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2a4-a'
const DENIED = /permission denied/
const UNIQUE = /duplicate key|unique/i
const FILES = new Set(['reservations.prisma', 'stockcount.prisma', 'planning.prisma'])
const TABLES = ['Reservation', 'StockCount', 'StockCountLine', 'ItemPlanning', 'PlanningSettings', 'LineCapacity', 'WorkCentreCapacity', 'RequirementPegging', 'PlanningException'] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PlanningSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  siteA: key('site:A1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  leather: key('product:item:leather'),
  leatherBLK: key('product:item-colour:leather:BLK'),
  leatherRED: key('product:item-colour:leather:RED'),
  lining: key('product:item:lining'),
  liningGRY: key('product:item-colour:lining:GRY'),
  protector: key('product:item:protector'),
  store: key('inventory:location:A1-STORE'),
  bin: key('inventory:location:A1-STORE-01'),
  dock: key('inventory:location:A1-RCV'),
  liningLot: key('inventory:lot:LIN-01'),
  leatherLot: key('inventory:lot:LEA-01'),
  hide2: key('inventory:hide:H2'),
  wo1: key('production:work-order:WO-0001'),
  wo2: `00000000${key('production:work-order:WO-0002').slice(8)}`,
  soLineBLK: key('sales:SO1:line:10'),
  soLineRED: key('sales:SO1:line:20'),
  run1: key('supply:run:1'),
  reqBLK: key('supply:run:1:1'),
  reqRED: key('supply:run:1:2'),
  reqLining: key('supply:run:1:3'),
  reqProtector: key('supply:run:1:4'),
  poLeather: key('supply:PO1:10'),
  poProtector: key('supply:PO1:20'),
  lineA1: key('site:A1:line:L1'),
  sewA1: key('site:A1:work-centre:SEW'),
}

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]))[0]!.n)
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const tag = (): string => randomUUID().slice(0, 8)
const status = async (table: string, id: string) => String((await admin(`SELECT status::text AS s FROM "${table}" WHERE id = $1`, [id]))[0]!.s)

beforeAll(async () => {
  db = await migratedDatabase('stockplanw2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  seeded = await seedPlanning({ db: factory, namespace: NS })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- the seeds and the walls ----------------------------------------------------------------------------------------

describe('the seeds and the walls', () => {
  it('the seeds are idempotent: a second run writes nothing new', async () => {
    const before = await Promise.all(TABLES.map(count))
    await seedPlanning({ db: factory, namespace: NS })
    expect(await Promise.all(TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
  })

  it('the new tables are the office’s: the floor reads its reservations and records an issue, the partner nothing', async () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))
    expect(models.map(({ model }) => model.name).sort()).toEqual([...TABLES].sort())
    for (const { model, ownership } of models) {
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      if (model.name === 'Reservation') expect(ownership.access[FLOOR_ROLE]?.privileges).toEqual(['select', 'update'])
      else {
        expect(ownership.access[FLOOR_ROLE], model.name).toBeUndefined()
        await expect(sql(floor(), `SELECT id FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
      }
    }
    expect(await sql(floor(), `SELECT id::text AS id FROM "Reservation"`)).toEqual([{ id: seeded.reservationId }])
  })

  it('capacity is per line and work centre: no column names a person (Statuto dei Lavoratori art. 4)', async () => {
    const columns = await admin(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['LineCapacity', 'WorkCentreCapacity', 'PlanningSettings']],
    )
    expect(columns.filter((column) => /worker|person|employee|operatorId|userId/i.test(String(column.c)))).toEqual([])
  })
})

// --- pegging: append-only -------------------------------------------------------------------------------------------

describe('the pegging of a run', () => {
  it('is append-only for every login, the owner included', async () => {
    const [row] = await admin(`SELECT id FROM "RequirementPegging" WHERE "tenantId" = $1 LIMIT 1`, [a.tenantId])
    await expect(run(office(), `UPDATE "RequirementPegging" SET quantity = 1 WHERE id = $1::uuid`, row!.id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "RequirementPegging" WHERE id = $1::uuid`, row!.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "RequirementPegging" SET quantity = 1 WHERE id = $1`, [row!.id])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "RequirementPegging" WHERE id = $1`, [row!.id])).rejects.toThrow(/append-only/)
    await expect(admin(`TRUNCATE "RequirementPegging"`)).rejects.toThrow(/append-only/)
  })

  it('names the demand and the supply of its kinds, of the requirement’s own material', async () => {
    const peg = (row: Record<string, unknown>) =>
      insert(office(), 'RequirementPegging', { id: randomUUID(), siteId: A.siteA, runId: A.run1, requirementId: A.reqBLK, seq: 900 + Math.floor(Math.random() * 1e6), demandDate: '2026-11-16', quantity: '1', ...row })
    const line = { demandKind: 'ORDER_LINE', salesOrderLineId: A.soLineBLK, partyId: A.P1, size: '52' }
    await expect(peg({ ...line, salesOrderLineId: null, partyId: null, supplyKind: 'STOCK' })).rejects.toThrow(/names the demand/)
    await expect(peg({ ...line, partyId: null, supplyKind: 'STOCK' })).rejects.toThrow(/names the demand/)
    await expect(peg({ demandKind: 'SAFETY_STOCK', workOrderId: A.wo1, supplyKind: 'STOCK' })).rejects.toThrow(/names the demand/)
    await expect(peg({ ...line, supplyKind: 'PURCHASE_ORDER', purchaseOrderLineId: A.poLeather })).rejects.toThrow(/names the supply/)
    await expect(peg({ ...line, supplyKind: 'STOCK', supplyDate: '2026-11-13' })).rejects.toThrow(/names the supply/)
    await expect(peg({ ...line, supplyKind: 'PURCHASE_ORDER', purchaseOrderLineId: A.poProtector, supplyDate: '2026-11-13' })).rejects.toThrow(/another material/)
    await expect(peg({ ...line, quantity: '0', supplyKind: 'STOCK' })).rejects.toThrow(/above 0/)
    expect(await peg({ ...line, supplyKind: 'PURCHASE_ORDER', purchaseOrderLineId: A.poLeather, supplyDate: '2026-11-13' })).toBe(1)
    expect(await peg({ demandKind: 'WORK_ORDER', workOrderId: A.wo1, salesOrderLineId: A.soLineBLK, partyId: A.P1, supplyKind: 'PLANNED', supplyDate: '2026-11-16' })).toBe(1)
  })
})

// --- reservations ---------------------------------------------------------------------------------------------------

describe('reservations', () => {
  const reserve = (row: Record<string, unknown>) => {
    const id = randomUUID()
    return insert(office(), 'Reservation', { id, companyId: A.companyA, siteId: A.siteA, quantity: '10', workOrderId: A.wo1, ...row }).then(() => id)
  }

  it('reserve leather by AREA or HIDE and other items by QUANTITY, in the item’s or lot’s own colour', async () => {
    await expect(reserve({ kind: 'QUANTITY', itemId: A.leather, itemColourId: A.leatherBLK })).rejects.toThrow(/reserved by AREA or HIDE/)
    await expect(reserve({ kind: 'AREA', itemId: A.lining, itemColourId: A.liningGRY })).rejects.toThrow(/reserved by AREA or HIDE/)
    await expect(reserve({ kind: 'HIDE', itemId: A.leather, itemColourId: A.leatherBLK, lotId: A.leatherLot })).rejects.toThrow(/names its hide and lot/)
    await expect(reserve({ kind: 'AREA', itemId: A.leather, hideId: A.hide2, lotId: A.leatherLot, itemColourId: A.leatherBLK })).rejects.toThrow(/names its hide and lot/)
    await expect(reserve({ kind: 'AREA', itemId: A.leather })).rejects.toThrow(/names the colour/)
    await expect(reserve({ kind: 'AREA', itemId: A.leather, itemColourId: A.leatherRED, lotId: A.leatherLot })).rejects.toThrow(/lot''s own colour|own colour/)
    await expect(reserve({ kind: 'QUANTITY', itemId: A.protector, quantity: '0' })).rejects.toThrow(/above 0/)
    expect(await reserve({ kind: 'QUANTITY', itemId: A.protector })).toBeTruthy()
    expect(await reserve({ kind: 'QUANTITY', itemId: A.lining, itemColourId: A.liningGRY, lotId: A.liningLot, quantity: '12.6' })).toBeTruthy()
  })

  it('are held for exactly one open work order or one open order line of the company', async () => {
    const base = { kind: 'QUANTITY', itemId: A.protector }
    await expect(reserve({ ...base, workOrderId: null })).rejects.toThrow(/exactly one work order or one sales order line/)
    await expect(reserve({ ...base, salesOrderLineId: A.soLineBLK, partyId: A.P1 })).rejects.toThrow(/exactly one/)
    await expect(reserve({ ...base, workOrderId: null, salesOrderLineId: A.soLineBLK })).rejects.toThrow(/exactly one/)
    expect(await reserve({ ...base, workOrderId: null, salesOrderLineId: A.soLineBLK, partyId: A.P1 })).toBeTruthy()
    await expect(reserve({ ...base, companyId: key('company:B'), siteId: key('site:B1'), workOrderId: null, salesOrderLineId: A.soLineBLK, partyId: A.P1 })).rejects.toThrow(
      /not a line of an open order of the company/,
    )
  })

  it('one ACTIVE reservation holds a hide; released, the hide may be held again', async () => {
    const hide = { kind: 'HIDE', itemId: A.leather, itemColourId: A.leatherBLK, lotId: A.leatherLot, hideId: A.hide2, quantity: '51.8' }
    const first = await reserve(hide)
    await expect(reserve({ ...hide, workOrderId: A.wo2 })).rejects.toThrow(UNIQUE)
    await run(office(), `UPDATE "Reservation" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid, "releaseReason" = 'Cut from another lot' WHERE id = $1::uuid`, first, a.actorId)
    expect(await reserve({ ...hide, workOrderId: A.wo2 })).toBeTruthy()
  })

  it('ACTIVE → ISSUED once all of it is issued, or RELEASED with its reason; final after; never deleted', async () => {
    const id = await reserve({ kind: 'QUANTITY', itemId: A.protector, quantity: '8' })
    const update = (set: string) => run(office(), `UPDATE "Reservation" SET ${set} WHERE id = $1::uuid`, id)
    await expect(update(`"issuedQuantity" = 9`)).rejects.toThrow(/0 up to all of it/)
    await expect(update(`quantity = 2, "issuedQuantity" = 3`)).rejects.toThrow(/0 up to all of it/)
    await expect(update(`"itemId" = '${A.lining}'::uuid, "itemColourId" = '${A.liningGRY}'::uuid`)).rejects.toThrow(/never change/)
    await expect(update(`"workOrderId" = '${A.wo2}'::uuid`)).rejects.toThrow(/never change/)
    await expect(update(`status = 'RELEASED', "releasedAt" = now(), "releasedById" = '${a.actorId}'::uuid`)).rejects.toThrow(/RELEASED exactly with when, by whom and why/)
    await expect(update(`status = 'ISSUED', "issuedAt" = now(), "issuedQuantity" = 4`)).rejects.toThrow(/once all of it was issued/)
    expect(await update(`"issuedQuantity" = 4, quantity = 6, "needDate" = '2026-12-01'`)).toBe(1)
    expect(await update(`status = 'ISSUED', "issuedAt" = now(), "issuedQuantity" = 6`)).toBe(1)
    await expect(update(`note = 'later'`)).rejects.toThrow(/is ISSUED; it changes no more/)
    await expect(run(office(), `DELETE FROM "Reservation" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "Reservation" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    // Its pegging references it, so PostgreSQL refuses before the trigger does; the trigger is tested on a free table.
    await expect(admin(`TRUNCATE "Reservation"`)).rejects.toThrow(/TRUNCATE|cannot truncate/)
  })

  it('a floor session records only what was issued against its site’s reservation', async () => {
    const id = await reserve({ kind: 'QUANTITY', itemId: A.protector, quantity: '4' })
    const update = (set: string) => run(floor(), `UPDATE "Reservation" SET ${set} WHERE id = $1::uuid`, id)
    await expect(update(`quantity = 3`)).rejects.toThrow(/a floor session records only what was issued/)
    await expect(update(`status = 'RELEASED', "releasedAt" = now(), "releasedById" = '${a.actorId}'::uuid, "releaseReason" = 'x'`)).rejects.toThrow(/a floor session records only/)
    await expect(run(floor(), `INSERT INTO "Reservation" (id) VALUES (NULL)`)).rejects.toThrow(DENIED)
    expect(await update(`"issuedQuantity" = 1`)).toBe(1)
    expect(await update(`"issuedQuantity" = 4, status = 'ISSUED', "issuedAt" = now()`)).toBe(1)
    expect(await status('Reservation', id)).toBe('ISSUED')
  })
})

// --- counts ---------------------------------------------------------------------------------------------------------

describe('stock counts', () => {
  const approver = randomUUID()
  async function openCount(row: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID()
    await insert(office(), 'StockCount', {
      id,
      companyId: A.companyA,
      siteId: A.siteA,
      number: `T-CNT-${tag()}`,
      kind: 'CYCLE',
      locationId: A.store,
      status: 'COUNTING',
      startedAt: '2026-11-21T07:00:00Z',
      snapshotAt: '2026-11-21T07:00:00Z',
      ...row,
    })
    return id
  }
  const line = (countId: string, row: Record<string, unknown> = {}) => {
    const id = randomUUID()
    return insert(office(), 'StockCountLine', {
      id,
      siteId: A.siteA,
      countId,
      seq: Math.floor(Math.random() * 1e6),
      locationId: A.bin,
      itemId: A.lining,
      itemColourId: A.liningGRY,
      lotId: A.liningLot,
      expectedQuantity: '120',
      ...row,
    }).then(() => id)
  }
  const setCount = (id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "StockCount" SET ${set} WHERE id = $1::uuid`, id, ...values)
  const setLine = (id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "StockCountLine" SET ${set} WHERE id = $1::uuid`, id, ...values)
  const submit = (id: string) => setCount(id, `status = 'SUBMITTED', "submittedAt" = now(), "submittedById" = $2::uuid, "differenceAmount" = 150`, a.actorId)
  const approve = (id: string, by: string) => setCount(id, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, by)

  it('starts DRAFT or COUNTING; a year-end count has its inventory date; never deleted', async () => {
    await expect(openCount({ status: 'SUBMITTED' })).rejects.toThrow(/starts DRAFT or COUNTING/)
    await expect(openCount({ status: 'DRAFT' })).rejects.toThrow(/start and snapshot exactly from COUNTING on/)
    await expect(openCount({ kind: 'YEAR_END' })).rejects.toThrow(/inventory date exactly when it is YEAR_END/)
    await expect(openCount({ lotId: A.liningLot })).rejects.toThrow(/the item of a lot/)
    const id = await openCount({ kind: 'YEAR_END', inventoryDate: '2026-12-31', locationId: null })
    await expect(setCount(id, `"inventoryDate" = '2026-12-30'`)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "StockCount" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })

  it('its lines lie inside its scope, in the lot’s own colour, and name no move while counting', async () => {
    const id = await openCount({ itemId: A.lining })
    await expect(line(id, { locationId: A.dock })).rejects.toThrow(/outside the scope/)
    await expect(line(id, { itemId: A.leather, itemColourId: A.leatherBLK, lotId: A.leatherLot, hideId: A.hide2, expectedQuantity: '51.8' })).rejects.toThrow(/outside the scope/)
    await expect(line(id, { itemColourId: null })).rejects.toThrow(/own colour/)
    await expect(line(id, { origin: 'ADDED' })).rejects.toThrow(/expects 0 when it was ADDED/)
    await expect(line(id, { countedQuantity: '3' })).rejects.toThrow(/counted .* with its time/)
    const lineId = await line(id)
    await expect(setLine(lineId, `"expectedQuantity" = 100`)).rejects.toThrow(/snapshot; they never change/)
    await expect(setLine(lineId, `"moveId" = $2::uuid`, randomUUID())).rejects.toThrow(/only while its count is APPROVED|names a move only/)
    expect(await setLine(lineId, `"countedQuantity" = 119, "countedAt" = now(), "countedById" = $2::uuid, "reasonCode" = 'COUNT_ERROR'`, a.actorId)).toBe(1)
    await expect(setLine(lineId, `"reasonCode" = 'count error'`)).rejects.toThrow(/without spaces/)
  })

  it('is submitted once all is counted; from then on its lines are history; sent back, they change again', async () => {
    const id = await openCount()
    const lineId = await line(id)
    await expect(submit(id)).rejects.toThrow(/every line is counted/)
    await setLine(lineId, `"countedQuantity" = 118, "countedAt" = now(), "countedById" = $2::uuid, "recountRequestedAt" = now()`, a.actorId)
    await expect(submit(id)).rejects.toThrow(/every recount asked for is done/)
    await setLine(lineId, `"recountQuantity" = 118.5, "recountedAt" = now(), "recountedById" = $2::uuid`, a.actorId)
    expect(await submit(id)).toBe(1)
    await expect(setLine(lineId, `"reasonNote" = 'later'`)).rejects.toThrow(/is history; it never changes/)
    await expect(line(id)).rejects.toThrow(/added to a count while it is DRAFT or COUNTING/)
    await expect(run(office(), `DELETE FROM "StockCountLine" WHERE id = $1::uuid`, lineId)).rejects.toThrow(/history; it is never removed/)
    await expect(setCount(id, `status = 'COUNTING', "submittedAt" = NULL, "submittedById" = NULL, "differenceAmount" = NULL`)).rejects.toThrow(/new rejection/)
    expect(
      await setCount(id, `status = 'COUNTING', "submittedAt" = NULL, "submittedById" = NULL, "differenceAmount" = NULL, "rejectedAt" = now(), "rejectedById" = $2::uuid, "rejectReason" = 'Count the bin again'`, approver),
    ).toBe(1)
    expect(await setLine(lineId, `"reasonNote" = 'Recounted after the rejection'`)).toBe(1)
  })

  it('the counter never approves their own variance; applying needs each differing line’s COUNT move', async () => {
    const id = await openCount()
    const lineId = await line(id, { countedQuantity: '118.5', countedAt: '2026-11-21T08:00:00Z', countedById: a.actorId, reasonCode: 'COUNT_ERROR' })
    const sameLine = await line(id, { countedQuantity: '120', countedAt: '2026-11-21T08:00:00Z', countedById: approver })
    await submit(id)
    await expect(approve(id, a.actorId)).rejects.toThrow(/never approves their own variance/)
    expect(await approve(id, approver)).toBe(1)
    await expect(setCount(id, `status = 'APPLIED', "appliedAt" = now(), "appliedById" = $2::uuid`, approver)).rejects.toThrow(/every line that differs names its COUNT move/)
    // The difference (−1.5 m) leaves the bin as one COUNT move through the ledger.
    const move = (quantity: string) => {
      const moveId = randomUUID()
      return insert(office(), 'StockMove', {
        id: moveId,
        companyId: A.companyA,
        siteId: A.siteA,
        reason: 'COUNT',
        itemId: A.lining,
        itemColourId: A.liningGRY,
        lotId: A.liningLot,
        fromLocationId: A.bin,
        quantity,
        uom: 'M',
        baseQuantity: quantity,
        note: 'Count difference',
        idempotencyKey: `count:${moveId}`,
        occurredAt: '2026-11-21T09:00:00Z',
      }).then(() => moveId)
    }
    await expect(setLine(lineId, `"moveId" = $2::uuid`, await move('1.0000'))).rejects.toThrow(/does not post the difference/)
    await expect(setLine(sameLine, `"moveId" = $2::uuid`, await move('1.5000'))).rejects.toThrow(/names a move only when what was counted differs/)
    await expect(setLine(lineId, `"reasonNote" = 'x', "moveId" = $2::uuid`, await move('1.5000'))).rejects.toThrow(/takes only the COUNT move/)
    expect(await setLine(lineId, `"moveId" = $2::uuid`, await move('1.5000'))).toBe(1)
    await expect(setLine(lineId, `"moveId" = $2::uuid`, await move('1.5000'))).rejects.toThrow(/takes only the COUNT move that posts its difference, once/)
    expect(await setCount(id, `status = 'APPLIED', "appliedAt" = now(), "appliedById" = $2::uuid`, approver)).toBe(1)
    await expect(setCount(id, `note = 'later'`)).rejects.toThrow(/APPLIED: its history changes no more/)
    await expect(setLine(lineId, `"reasonNote" = 'later'`)).rejects.toThrow(/is history/)
    // A cycle count is never signed off.
    await expect(setCount(id, `status = 'SIGNED_OFF', "signedOffAt" = now(), "signedOffById" = $2::uuid, "valuedListFileId" = $3::uuid`, approver, randomUUID())).rejects.toThrow(
      /a year-end count/,
    )
  })

  it('a year-end count is signed off with its valued list, a file of that count; then it changes no more', async () => {
    const id = await openCount({ kind: 'YEAR_END', inventoryDate: '2026-12-31' })
    await line(id, { countedQuantity: '120', countedAt: '2027-01-02T08:00:00Z', countedById: a.actorId })
    await submit(id)
    await approve(id, approver)
    await setCount(id, `status = 'APPLIED', "appliedAt" = now(), "appliedById" = $2::uuid`, approver)
    // A copy of a seeded file, as the count's own document (and one of another record).
    const file = async (recordType: string, recordId: string): Promise<string> => {
      const fileId = randomUUID()
      await admin(
        `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile",
           (SELECT to_jsonb(f) || jsonb_build_object('id', $1::text, 'storageKey', f."storageKey" || '-' || $1::text, 'recordType', $2::text, 'recordId', $3::text)
              FROM "StoredFile" f WHERE f."tenantId" = $4::uuid AND f."companyId" = $5::uuid ORDER BY f.id LIMIT 1))`,
        [fileId, recordType, recordId, a.tenantId, A.companyA],
      )
      return fileId
    }
    const signOff = (fileId: string | null) => setCount(id, `status = 'SIGNED_OFF', "signedOffAt" = now(), "signedOffById" = $2::uuid, "valuedListFileId" = $3::uuid`, approver, fileId)
    await expect(signOff(null)).rejects.toThrow(/signed off \(when, by whom, its valued list\)/)
    await expect(signOff(await file('StockCount', randomUUID()))).rejects.toThrow(/a file of that count/)
    expect(await signOff(await file('StockCount', id))).toBe(1)
    await expect(setCount(id, `"countTeam" = 'later'`)).rejects.toThrow(/is SIGNED_OFF; it changes no more/)
  })

  it('moves only as its states allow: no skipping, cancelled with its reason before it is applied', async () => {
    const id = await openCount()
    await expect(approve(id, approver)).rejects.toThrow(/cannot move from COUNTING to APPROVED/)
    await expect(setCount(id, `status = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/cancelled with its reason/)
    expect(await setCount(id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Opened twice'`)).toBe(1)
    await expect(setCount(id, `status = 'COUNTING', "cancelledAt" = NULL, "cancelReason" = NULL`)).rejects.toThrow(/is CANCELLED; it changes no more/)
  })
})

// --- the firm planned order -----------------------------------------------------------------------------------------

describe('the firm planned order of a requirement', () => {
  const firm = (id: string, set: string) => run(office(), `UPDATE "MaterialRequirement" SET ${set} WHERE id = $1::uuid`, id)

  it('has its quantities, date and time, a supplier only for a BUY; never on an IGNORED line; fixed while ORDERED', async () => {
    expect(String((await admin(`SELECT "firmQuantity"::text AS q FROM "MaterialRequirement" WHERE id = $1`, [A.reqRED]))[0]!.q)).toBe('4.0000')
    await expect(firm(A.reqRED, `"firmDate" = NULL`)).rejects.toThrow(/firm planned order of material requirement .* has its quantity/)
    await expect(firm(A.reqRED, `"firmQuantity" = 0`)).rejects.toThrow(/above 0/)
    await expect(firm(A.reqLining, `"firmQuantity" = 1, "firmBaseQuantity" = 1, "firmDate" = '2026-11-16', "firmedAt" = now()`)).rejects.toThrow(/set aside \(IGNORED\)/)
    await expect(firm(A.reqBLK, `"firmQuantity" = 8, "firmBaseQuantity" = 420, "firmDate" = '2026-11-16', "firmedAt" = now()`)).rejects.toThrow(/fixed while it is ORDERED/)
    await expect(firm(A.reqRED, `"grossQuantity" = 1`)).rejects.toThrow(/snapshot; they never change/)
    expect(await firm(A.reqRED, `"firmQuantity" = 5, "firmBaseQuantity" = 262.5, "firmDate" = '2026-11-18'`)).toBe(1)
  })

  it('a later run carries it: a firm line of another run, of the same material, colour and action', async () => {
    const runId = randomUUID()
    await insert(office(), 'PlanningRun', { id: runId, companyId: A.companyA, siteId: A.siteA, trigger: 'MANUAL', startedAt: '2026-11-01T02:00:00Z' })
    const carry = (from: string, row: Record<string, unknown> = {}) =>
      insert(office(), 'MaterialRequirement', {
        id: randomUUID(),
        siteId: A.siteA,
        runId,
        seq: Math.floor(Math.random() * 1e6),
        itemId: A.leather,
        itemColourId: A.leatherRED,
        action: 'BUY',
        uom: 'FT2',
        grossQuantity: '202.16',
        usableStock: '0',
        heldStock: '0',
        onOrder: '0',
        netQuantity: '202.16',
        suggestedQuantity: '4',
        suggestedUom: 'HIDE',
        needDate: '2026-11-16',
        sources: [],
        firmQuantity: '5',
        firmBaseQuantity: '262.5',
        firmDate: '2026-11-18',
        firmSupplierId: A.P2,
        firmedAt: '2026-10-30T12:00:00Z',
        firmedById: a.actorId,
        firmCarriedFromId: from,
        ...row,
      })
    await expect(carry(A.reqRED, { firmQuantity: null, firmBaseQuantity: null, firmDate: null, firmSupplierId: null, firmedAt: null, firmedById: null })).rejects.toThrow(/so it is firm/)
    await expect(carry(A.reqBLK, { itemColourId: A.leatherBLK })).rejects.toThrow(/carries a firm line of another run/)
    await expect(carry(A.reqRED, { itemColourId: A.leatherBLK })).rejects.toThrow(/carries a firm line of another run/)
    expect(await carry(A.reqRED)).toBe(1)
    await run(office(), `UPDATE "PlanningRun" SET status = 'FAILED', "finishedAt" = "startedAt" + interval '1 minute', error = 'test run' WHERE id = $1::uuid`, runId)
  })
})

// --- planning parameters, settings, capacity ------------------------------------------------------------------------

describe('item parameters, settings and capacity', () => {
  const parameters = (row: Record<string, unknown>) => insert(office(), 'ItemPlanning', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, itemId: A.protector, ...row })

  it('item parameters: the reorder columns go with REORDER_POINT, min/max with MIN_MAX; sizes and days in range', async () => {
    await expect(parameters({ method: 'REORDER_POINT', reorderPoint: '10' })).rejects.toThrow(/exactly for REORDER_POINT/)
    await expect(parameters({ method: 'ORDERS', minStock: '1', maxStock: '5' })).rejects.toThrow(/exactly for MIN_MAX/)
    await expect(parameters({ method: 'MIN_MAX', minStock: '5', maxStock: '5' })).rejects.toThrow(/maxima not below their minima/)
    await expect(parameters({ minOrderQty: '10', maxOrderQty: '5' })).rejects.toThrow(/maxima not below/)
    await expect(parameters({ orderMultiple: '0' })).rejects.toThrow(/sizes above 0/)
    await expect(parameters({ buyLeadTimeDays: 400 })).rejects.toThrow(/0 to 366 days/)
    await expect(parameters({ supplierId: A.P2 })).rejects.toThrow(/a supplier only for a BUY/)
    await expect(parameters({ source: 'MAKE', makeSiteId: key('site:B1') })).rejects.toThrow(/foreign key|violates/)
    expect(await parameters({ method: 'MIN_MAX', minStock: '12', maxStock: '96', source: 'MAKE', makeSiteId: A.siteA })).toBe(1)
    const [row] = await admin(`SELECT id FROM "ItemPlanning" WHERE "tenantId" = $1 AND "makeSiteId" IS NOT NULL`, [a.tenantId])
    await expect(run(office(), `UPDATE "ItemPlanning" SET "itemId" = $2::uuid WHERE id = $1::uuid`, row!.id, A.lining)).rejects.toThrow(/never change/)
    expect(await run(office(), `DELETE FROM "ItemPlanning" WHERE id = $1::uuid`, row!.id)).toBe(1)
  })

  it('settings, line and work-centre capacity hold their ranges and are never deleted', async () => {
    const setSettings = (set: string) => run(office(), `UPDATE "PlanningSettings" SET ${set} WHERE id = $1::uuid`, A.siteA)
    await expect(setSettings(`"horizonWeeks" = 0`)).rejects.toThrow(/1 to 104 weeks/)
    await expect(setSettings(`"dayBucketWeeks" = 20`)).rejects.toThrow(/1 to 104 weeks/)
    await expect(setSettings(`"defaultEfficiencyPct" = 0`)).rejects.toThrow(/above 0 and at most 200/)
    await expect(setSettings(`"scheduledRunTime" = '25:00'`)).rejects.toThrow(/a time HH:MM/)
    expect(await setSettings(`"scheduledRunTime" = '01:30'`)).toBe(1)
    await expect(run(office(), `UPDATE "LineCapacity" SET "plannedEfficiencyPct" = 250 WHERE id = $1::uuid`, A.lineA1)).rejects.toThrow(/at most 200/)
    await expect(run(office(), `UPDATE "LineCapacity" SET operators = 0 WHERE id = $1::uuid`, A.lineA1)).rejects.toThrow(/1 to 500 people/)
    await expect(run(office(), `UPDATE "WorkCentreCapacity" SET units = 0 WHERE id = $1::uuid`, A.sewA1)).rejects.toThrow(/1 to 500 units/)
    for (const table of ['PlanningSettings', 'LineCapacity', 'WorkCentreCapacity']) {
      await expect(run(office(), `DELETE FROM "${table}" WHERE false`), table).rejects.toThrow(DENIED)
      await expect(admin(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]), table).rejects.toThrow(/never deleted/)
    }
    for (const table of ['PlanningSettings', 'ItemPlanning', 'LineCapacity', 'WorkCentreCapacity', 'PlanningException']) {
      await expect(admin(`TRUNCATE "${table}"`), table).rejects.toThrow(/TRUNCATE on .* is refused/)
    }
  })
})

// --- planning exceptions --------------------------------------------------------------------------------------------

describe('planning exceptions', () => {
  const raise = (row: Record<string, unknown> = {}) => {
    const id = randomUUID()
    return insert(office(), 'PlanningException', {
      id,
      companyId: A.companyA,
      siteId: A.siteA,
      kind: 'SUPPLY_LATE',
      dedupeKey: `SUPPLY_LATE:${A.poLeather}:${tag()}`,
      firstRunId: A.run1,
      lastRunId: A.run1,
      firstSeenAt: '2026-10-30T09:01:00Z',
      lastSeenAt: '2026-10-30T09:01:00Z',
      recordType: 'PurchaseOrderLine',
      recordId: A.poLeather,
      facts: { needDate: '2026-11-16', supplyDate: '2026-11-20' },
      daysLate: 4,
      ordersAffected: 1,
      ...row,
    }).then(() => id)
  }
  const set = (id: string, text: string, ...values: unknown[]) => run(office(), `UPDATE "PlanningException" SET ${text} WHERE id = $1::uuid`, id, ...values)

  it('starts NEW with nothing done; its key names its kind; one unresolved per condition', async () => {
    await expect(raise({ status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-30T10:00:00Z', acknowledgedById: a.actorId })).rejects.toThrow(/starts NEW/)
    await expect(raise({ dedupeKey: `SHORT:${A.poLeather}` })).rejects.toThrow(/starts with SUPPLY_LATE:/)
    await expect(raise({ recordId: null })).rejects.toThrow(/both its type and id/)
    await expect(raise({ facts: [] })).rejects.toThrow(/facts as an object/)
    const dedupeKey = `SUPPLY_LATE:${A.poLeather}`
    await raise({ dedupeKey })
    await expect(raise({ dedupeKey, occurrence: 2 })).rejects.toThrow(UNIQUE)
  })

  it('NEW → ACKNOWLEDGED → RESOLVED: acknowledged once, HANDLED with a person and a note, CLEARED by a run; then final', async () => {
    const id = await raise()
    await expect(set(id, `status = 'ACKNOWLEDGED'`)).rejects.toThrow(/acknowledged \(when, by whom\)/)
    expect(await set(id, `status = 'ACKNOWLEDGED', "acknowledgedAt" = now(), "acknowledgedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(set(id, `"acknowledgedById" = $2::uuid`, randomUUID())).rejects.toThrow(/acknowledged once/)
    await expect(set(id, `"snoozedUntil" = now() + interval '1 day'`)).rejects.toThrow(/snoozed by a person/)
    expect(await set(id, `"snoozedAt" = now(), "snoozedById" = $2::uuid, "snoozedUntil" = now() + interval '1 day'`, a.actorId)).toBe(1)
    expect(await set(id, `"lastRunId" = $2::uuid, "lastSeenAt" = '2026-10-31T02:00:00Z', "daysLate" = 5`, A.run1)).toBe(1)
    await expect(set(id, `"lastSeenAt" = '2026-10-30T09:30:00Z'`)).rejects.toThrow(/never moves back/)
    await expect(set(id, `status = 'RESOLVED', "resolvedAt" = now(), resolution = 'HANDLED', "resolvedById" = $2::uuid`, a.actorId)).rejects.toThrow(/HANDLED by a person with a note/)
    await expect(set(id, `status = 'RESOLVED', "resolvedAt" = now(), resolution = 'CLEARED', "resolvedById" = $2::uuid`, a.actorId)).rejects.toThrow(/CLEARED by a run/)
    expect(await set(id, `status = 'RESOLVED', "resolvedAt" = now(), resolution = 'HANDLED', "resolvedById" = $2::uuid, "resolveNote" = 'Chased: the supplier ships on Monday'`, a.actorId)).toBe(1)
    await expect(set(id, `"ownerId" = $2::uuid`, a.actorId)).rejects.toThrow(/RESOLVED; it changes no more/)
    await expect(set(id, `status = 'NEW'`)).rejects.toThrow(/RESOLVED; it changes no more/)
    await expect(admin(`DELETE FROM "PlanningException" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })

  it('comes back after it was resolved as a new occurrence; what it is about never changes', async () => {
    const dedupeKey = `SUPPLY_LATE:${A.poProtector}`
    const first = await raise({ dedupeKey })
    await expect(set(first, `"dedupeKey" = $2`, `${dedupeKey}:x`)).rejects.toThrow(/never change/)
    await set(first, `status = 'RESOLVED', "resolvedAt" = now(), resolution = 'CLEARED'`)
    expect(await raise({ dedupeKey, occurrence: 2 })).toBeTruthy()
  })
})
