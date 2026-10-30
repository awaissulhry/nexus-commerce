import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedInventory, type InventorySeed } from '../seed/inventory'
import { seed as seedLinks } from '../seed/links'
import { seed as seedProduction } from '../seed/production'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, partnerWalledColumns } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The supply and inventory walls beyond the generated isolation tests (plan A1 §2.1, §2.2, §2.5, §2.6; PLAN §1.4, §2.8
 * "Cr VI", §4.7 stages 08-buy to 11a-issue; features SCM-053, SCM-113, SCM-117, SCM-189, SCM-192, SCM-194, PLN-062,
 * QHS-029), on a database built from the migrations and seeded twice (tenants A and B), through the real login and the
 * scoped client:
 *   - the floor (factory_floor_runtime) reads and posts only its own site's stock, never a price, cost or value: no
 *     cost column of a table it reads, and nothing of the valuation ledger;
 *   - a supplier's link session (factory_partner_runtime) reads only its own party's purchase orders and lines, never a
 *     price or an internal note (the PO_CONFIRM link shows quantities and dates), and only confirms or declines a SENT
 *     order, once;
 *   - a purchase order starts as DRAFT, its lines change only while it is DRAFT, it is sent with a line and the sum of
 *     its lines, the supplier's confirmation is set once, and it is never deleted;
 *   - the stock ledger and its valuation are append-only for every login, the owner included;
 *   - a lot in QUARANTINE (or BLOCKED) is never issued; it is released only with a Cr VI PASS, below the limit;
 *   - a move never takes a location below zero, also when two moves of the same hide race; a receipt is POSTED only
 *     when the ledger holds its lines' quantities; a move has at most one reversal, which mirrors it;
 *   - a planning run runs alone on its site, and a requirement's numbers never change;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through the scoped client's raw SQL.
 */

const DENIED = /permission denied/
const RLS = /row-level security/
const FILES = new Set(['supply.prisma', 'inventory.prisma'])
const MONEY_GRAINS = new Set(['@grain cost', '@grain price', '@grain margin'])

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let seeded: InventorySeed
/** The production seed's WO-0001 at A1 (IN_PROGRESS): what the ISSUE rows name (a move to a work order names a real one). */
let workOrderId: string

const key = (namespace: string, name: string): string => seedUuid(namespace, name)
const A = {
  companyA: key('supply-a', 'company:A'),
  siteA: key('supply-a', 'site:A1'),
  P1: key('supply-a', 'party:P1'),
  P2: key('supply-a', 'party:P2'),
  P3: key('supply-a', 'party:P3'),
  linkP2: key('supply-a', 'link:P2'),
  leather: key('supply-a', 'product:item:leather'),
  leatherBLK: key('supply-a', 'product:item-colour:leather:BLK'),
  protector: key('supply-a', 'product:item:protector'),
}

const office = (core: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
const floor = (site = 0): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[site]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (text: string, values: unknown[] = []) => Number((await admin(text, values))[0]!.n)

/** `INSERT INTO "<table>" (<the row's columns>) …`: the columns it leaves out take their defaults (tenantId too). */
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
const tag = (): string => randomUUID().slice(0, 8)

beforeAll(async () => {
  db = await migratedDatabase('supply')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'supply-a' })
  b = await seedCore({ db: factory, namespace: 'supply-b' })
  await seedLinks({ db: factory, namespace: 'supply-a' })
  // Tenant A's stock comes with the production seed (it runs the inventory seed first), so issues have a work order.
  const production = await seedProduction({ db: factory, namespace: 'supply-a' })
  seeded = production.inventory
  workOrderId = production.workOrderId
  await seedInventory({ db: factory, namespace: 'supply-b' })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

/** A move row of tenant A's site A1 (black leather by default): the caller adds what the move is. */
const moveRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  itemId: A.leather,
  itemColourId: A.leatherBLK,
  uom: 'FT2',
  idempotencyKey: `test-${randomUUID()}`,
  occurredAt: new Date().toISOString(),
  ...extra,
})

interface Received {
  readonly receiptId: string
  readonly lineId: string
  readonly lotId: string
  readonly hideIds: readonly string[]
  readonly moveIds: readonly string[]
}

/**
 * Receives black leather against PO1's leather line in the office, as the receipt command does: a receipt, its line, a
 * lot in QUARANTINE (Cr VI PENDING), its hides and their RECEIPT moves into the bin, POSTED in one transaction. `posted`
 * lets a test post moves that do not add up to the line.
 */
async function receive(areas: readonly string[], options: { lineQuantity?: string } = {}): Promise<Received> {
  const ids: Received = {
    receiptId: randomUUID(),
    lineId: randomUUID(),
    lotId: randomUUID(),
    hideIds: areas.map(() => randomUUID()),
    moveIds: areas.map(() => randomUUID()),
  }
  const total = options.lineQuantity ?? areas.reduce((sum, area) => sum + Number(area), 0).toFixed(4)
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      const exec = (table: string, row: Record<string, unknown>) => tx.$executeRawUnsafe(...insertSql(table, row))
      await exec('GoodsReceipt', {
        id: ids.receiptId,
        companyId: A.companyA,
        siteId: A.siteA,
        number: `T-GR-${tag()}`,
        supplierId: A.P2,
        purchaseOrderId: seeded.supply.purchaseOrderId,
        receivedAt: new Date().toISOString(),
      })
      await exec('GoodsReceiptLine', {
        id: ids.lineId,
        siteId: A.siteA,
        receiptId: ids.receiptId,
        seq: 10,
        purchaseOrderLineId: seeded.supply.leatherLineId,
        itemId: A.leather,
        itemColourId: A.leatherBLK,
        quantity: total,
        uom: 'FT2',
        baseQuantity: total,
        hideCount: areas.length,
      })
      await exec('Lot', {
        id: ids.lotId,
        companyId: A.companyA,
        siteId: A.siteA,
        itemId: A.leather,
        itemColourId: A.leatherBLK,
        code: `T-LOT-${tag()}`,
        supplierId: A.P2,
        receiptLineId: ids.lineId,
        requiresCrViTest: true,
        crViLimitMgKg: '3.000',
        crViStatus: 'PENDING',
      })
      for (const [index, area] of areas.entries()) {
        await exec('Hide', { id: ids.hideIds[index], siteId: A.siteA, lotId: ids.lotId, itemId: A.leather, code: `T-HIDE-${tag()}`, area, areaUom: 'FT2', baseArea: area })
        await exec(
          'StockMove',
          moveRow({
            id: ids.moveIds[index],
            reason: 'RECEIPT',
            lotId: ids.lotId,
            hideId: ids.hideIds[index],
            toLocationId: seeded.locations.bin,
            quantity: area,
            baseQuantity: area,
            receiptLineId: ids.lineId,
          }),
        )
      }
      await tx.$executeRawUnsafe(`UPDATE "GoodsReceipt" SET status = 'POSTED', "postedAt" = now() WHERE id = $1::uuid`, ids.receiptId)
    }),
  )
  return ids
}

/** Records a Cr VI PASS on the lot's own report and releases it, as the quality command does. */
const release = (lotId: string, mgKg = '0.800') =>
  run(
    office(),
    `UPDATE "Lot" SET "crViStatus" = 'PASS', "crViMgKg" = $2::numeric, "crViEvidence" = 'LOT_REPORT', "crViTestedAt" = current_date,
       "qualityStatus" = 'RELEASED', "qualityDecidedAt" = now() WHERE id = $1::uuid`,
    lotId,
    mgKg,
  )

/** An ISSUE of a whole hide to the seeded work order WO-0001, from the bin. */
const issueRow = (received: Received, index: number, area: string) =>
  moveRow({ reason: 'ISSUE', lotId: received.lotId, hideId: received.hideIds[index], fromLocationId: seeded.locations.bin, quantity: area, baseQuantity: area, workOrderId })

interface DraftOrder {
  readonly orderId: string
  readonly lineId: string
}

/** A new DRAFT purchase order of company A to `partyId`, delivered to A1, with one line of 10 protectors at 6.50. */
async function draftOrder(partyId: string = A.P2): Promise<DraftOrder> {
  const ids = { orderId: randomUUID(), lineId: randomUUID() }
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        ...insertSql('PurchaseOrder', {
          id: ids.orderId,
          companyId: A.companyA,
          siteId: A.siteA,
          number: `T-PO-${tag()}`,
          partyId,
          orderDate: '2026-11-01',
          netAmount: 6_500,
        }),
      )
      await tx.$executeRawUnsafe(
        ...insertSql('PurchaseOrderLine', {
          id: ids.lineId,
          purchaseOrderId: ids.orderId,
          partyId,
          siteId: A.siteA,
          seq: 10,
          itemId: A.protector,
          quantity: '10.0000',
          uom: 'PCS',
          baseQuantity: '10.0000',
          unitPrice: '6.500000',
          netAmount: 6_500,
          needDate: '2026-12-01',
        }),
      )
    }),
  )
  return ids
}

const send = (orderId: string) => run(office(), `UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now() WHERE id = $1::uuid`, orderId)

// --- the floor --------------------------------------------------------------------------------------------------------

describe('the floor', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))

  it('never reads a price, cost or value of a supply or inventory table', async () => {
    const walled = models.flatMap(({ model, ownership }) =>
      model.fields.filter((field) => !field.relation && field.tags.some((entry) => MONEY_GRAINS.has(entry))).map((field) => ({ model, ownership, column: field.column })),
    )
    // Not vacuous: purchase prices and stock values are such columns.
    expect(walled.map(({ model, column }) => `${model.name}.${column}`).sort()).toEqual([
      'PurchaseOrder.netAmount',
      'PurchaseOrderLine.netAmount',
      'PurchaseOrderLine.unitPrice',
      'StockValuation.unitCost',
      'StockValuation.valueAmount',
    ])
    for (const { model, ownership, column } of walled) {
      const access = ownership.access[FLOOR_ROLE]
      if (access) expect(access.hiddenColumns ?? [], `${model.name}.${column}`).toContain(column)
      await expect(sql(floor(), `SELECT "${column}" FROM "${model.table}" LIMIT 1`), `${model.name}.${column}`).rejects.toThrow(DENIED)
      expect((await sql(office(), `SELECT "${column}" FROM "${model.table}"`)).length, `${model.name}.${column} for the office`).toBeGreaterThan(0)
    }
    // No table the floor inserts into has a money column (the copy of a row it inserts names every column).
    for (const { model, ownership } of models) {
      if (ownership.access[FLOOR_ROLE]?.privileges.includes('insert')) {
        expect(model.fields.filter((field) => field.tags.some((entry) => entry.startsWith('@grain'))), model.name).toEqual([])
      }
    }
    // Nothing of the valuation ledger, not even that a row exists; Prisma's default select fails loudly.
    await expect(sql(floor(), 'SELECT id FROM "StockValuation" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(as(floor(), (client) => client.purchaseOrderLine.findMany())).rejects.toThrow(DENIED)
    const lines = await as(floor(), (client) =>
      client.purchaseOrderLine.findMany({ where: { purchaseOrderId: seeded.supply.purchaseOrderId }, select: { seq: true, quantity: true, uom: true, needDate: true }, orderBy: { seq: 'asc' } }),
    )
    expect(lines.map((line) => [line.seq, line.quantity.toString(), line.uom])).toEqual([
      [10, '420', 'FT2'],
      [20, '24', 'PCS'],
    ])
  })

  it('reads and posts only its own site’s stock', async () => {
    const codes = async (scope: FactoryScope) => ({
      orders: (await as(scope, (client) => client.purchaseOrder.findMany({ where: { number: { startsWith: 'SEED-' } }, select: { number: true }, orderBy: { number: 'asc' } }))).map(
        (row) => row.number,
      ),
      locations: (await as(scope, (client) => client.location.findMany({ select: { code: true }, orderBy: { code: 'asc' } }))).map((row) => row.code),
      lots: (await as(scope, (client) => client.lot.findMany({ where: { code: { startsWith: 'SEED-' } }, select: { code: true }, orderBy: { code: 'asc' } }))).map((row) => row.code),
      moves: (await as(scope, (client) => client.stockMove.findMany({ where: { idempotencyKey: { startsWith: 'seed-' } }, select: { id: true } }))).length,
    })
    expect(await codes(floor(0))).toMatchObject({
      orders: ['SEED-PO-0001', 'SEED-PO-0002'],
      locations: ['A1-CUT', 'A1-QUA', 'A1-RCV', 'A1-STORE', 'A1-STORE-01'],
      lots: ['SEED-LOT-LEA-01', 'SEED-LOT-LIN-01'],
      moves: 4,
    })
    // The plant of company B (site B1) sees its own store only.
    expect(await codes(floor(1))).toEqual({ orders: [], locations: ['B1-STORE'], lots: [], moves: 0 })

    // It moves its site's stock (the second hide to the cutting room's rack), never another site's.
    const [, hide2] = seeded.hideIds
    const transfer = moveRow({ reason: 'TRANSFER', lotId: seeded.leatherLotId, hideId: hide2, fromLocationId: seeded.locations.bin, toLocationId: seeded.locations.cutting, quantity: '51.8000', baseQuantity: '51.8000' })
    await expect(insert(floor(1), 'StockMove', { ...transfer, id: randomUUID() })).rejects.toThrow(RLS)
    expect(await insert(floor(0), 'StockMove', transfer)).toBe(1)
    const back = moveRow({ reason: 'TRANSFER', lotId: seeded.leatherLotId, hideId: hide2, fromLocationId: seeded.locations.cutting, toLocationId: seeded.locations.bin, quantity: '51.8000', baseQuantity: '51.8000' })
    expect(await insert(floor(0), 'StockMove', back)).toBe(1)

    // It never releases a lot, nor changes or removes a move.
    await expect(run(floor(0), `UPDATE "Lot" SET "qualityNote" = 'x' WHERE id = $1::uuid`, seeded.leatherLotId)).rejects.toThrow(DENIED)
    await expect(run(floor(0), `UPDATE "StockMove" SET note = 'x' WHERE id = $1::uuid`, transfer.id)).rejects.toThrow(DENIED)
    await expect(run(floor(0), 'DELETE FROM "StockMove" WHERE id = $1::uuid', transfer.id)).rejects.toThrow(DENIED)
  })
})

// --- the partner wall -------------------------------------------------------------------------------------------------

describe('the partner wall', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))

  it('a supplier reads only its own purchase orders and lines, never a price, an internal note or who wrote them', async () => {
    const numbers = async (partyId: string) =>
      (await as(partner(partyId), (client) => client.purchaseOrder.findMany({ where: { number: { startsWith: 'SEED-' } }, select: { number: true }, orderBy: { number: 'asc' } }))).map(
        (row) => row.number,
      )
    expect(await numbers(A.P2)).toEqual(['SEED-PO-0001'])
    expect(await numbers(A.P1)).toEqual(['SEED-PO-0002'])
    expect(await numbers(A.P3)).toEqual([])

    // What the PO_CONFIRM link shows: quantities and dates.
    const order = await as(partner(A.P2), (client) =>
      client.purchaseOrder.findUniqueOrThrow({
        where: { id: seeded.supply.purchaseOrderId },
        select: { number: true, status: true, lines: { select: { seq: true, quantity: true, uom: true, needDate: true, confirmedQuantity: true }, orderBy: { seq: 'asc' } } },
      }),
    )
    expect(order.lines.map((line) => [line.seq, line.quantity.toString(), line.uom, line.confirmedQuantity?.toString()])).toEqual([
      [10, '420', 'FT2', '420'],
      [20, '24', 'PCS', '24'],
    ])

    // Never a price, cost or internal column: every walled column is hidden and refused.
    const hidden: string[] = []
    for (const { model, ownership } of models) {
      const access = ownership.access[PARTNER_ROLE]
      if (!access) {
        await expect(sql(partner(A.P2), `SELECT 1 FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
        continue
      }
      for (const { column } of partnerWalledColumns(model)) expect(access.hiddenColumns ?? [], `${model.name}.${column}`).toContain(column)
      for (const column of access.hiddenColumns ?? []) {
        hidden.push(`${model.name}.${column}`)
        await expect(sql(partner(A.P2), `SELECT "${column}" FROM "${model.table}" LIMIT 1`), `${model.name}.${column}`).rejects.toThrow(DENIED)
      }
    }
    expect(hidden.sort()).toEqual([
      'PurchaseOrder.createdById',
      'PurchaseOrder.internalNote',
      'PurchaseOrder.netAmount',
      'PurchaseOrder.proposalDecidedById',
      'PurchaseOrder.proposalDecisionNote',
      'PurchaseOrder.sentById',
      'PurchaseOrderLine.cancelledById',
      'PurchaseOrderLine.closedShortById',
      'PurchaseOrderLine.createdById',
      'PurchaseOrderLine.netAmount',
      'PurchaseOrderLine.unitPrice',
    ])
    await expect(as(partner(A.P2), (client) => client.purchaseOrder.findMany())).rejects.toThrow(DENIED)
  })

  it('confirms its SENT order once, through its link, and changes nothing else', async () => {
    const order = await draftOrder(A.P2)
    // Not before it is sent; not another party's order.
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 10, "confirmedDate" = '2026-11-20' WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(
      /is set once, while its order is SENT or CONFIRMED/,
    )
    await send(order.orderId)
    expect(await run(partner(A.P1), `UPDATE "PurchaseOrder" SET "supplierRef" = 'x' WHERE id = $1::uuid`, order.orderId)).toBe(0)
    // Only the confirmation: not a quantity, not a need date.
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrderLine" SET quantity = 12 WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/change only while it is DRAFT/)
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrder" SET note = 'cheaper please' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/terms change only while it is DRAFT/)

    // The confirm: the lines, then the order, in one transaction (the confirm command).
    await as(partner(A.P2), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 10, "confirmedDate" = '2026-11-20' WHERE id = $1::uuid`, order.lineId)
        await tx.$executeRawUnsafe(
          `UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'LINK', "confirmLinkId" = $2::uuid,
             "confirmedByName" = 'Seed Order Desk', "supplierRef" = 'OC-1' WHERE id = $1::uuid`,
          order.orderId,
          A.linkP2,
        )
      }),
    )
    // Set once: neither the supplier nor the office changes it after.
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrderLine" SET "confirmedDate" = '2026-11-27' WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/is set once/)
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrder" SET "supplierRef" = 'OC-2' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/is set once/)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET "confirmedByName" = 'Someone else' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/is set once/)
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(
      /only confirms or declines its SENT purchase order/,
    )
    // A link confirmation names a link of the order's own party.
    const other = await draftOrder(A.P2)
    await send(other.orderId)
    await expect(
      run(partner(A.P2), `UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'LINK' WHERE id = $1::uuid`, other.orderId),
    ).rejects.toThrow(/inconsistent confirmation/)
  })

  it('proposes changes to its SENT order through its link; only the buyer decides, and a new proposal clears the last decision (B-W1-31)', async () => {
    const order = await draftOrder(A.P2)
    await send(order.orderId)
    const propose = (date: string) =>
      as(partner(A.P2), (client) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "PurchaseOrderLine" SET "proposedQuantity" = 6, "proposedDate" = $2::date, "proposedSplitQuantity" = 4, "proposedSplitDate" = '2026-12-10', "proposalReason" = 'Two lots' WHERE id = $1::uuid`,
            order.lineId,
            date,
          )
          await tx.$executeRawUnsafe(`UPDATE "PurchaseOrder" SET status = 'CHANGES_PROPOSED', "proposedAt" = now(), "proposalLinkId" = $2::uuid, "proposedByName" = 'Seed Order Desk' WHERE id = $1::uuid`, order.orderId, A.linkP2)
        }),
      )
    // A split's second delivery needs its date; a proposal names the link it came through.
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrderLine" SET "proposedQuantity" = 6, "proposedDate" = '2026-12-03', "proposedSplitQuantity" = 4 WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/a second delivery with its quantity and date/)
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrder" SET status = 'CHANGES_PROPOSED', "proposedAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/inconsistent proposal/)
    await propose('2026-12-03')
    let [row] = await admin('SELECT status::text, "confirmedAt", "proposalDecision" FROM "PurchaseOrder" WHERE id = $1', [order.orderId])
    expect(row).toEqual({ status: 'CHANGES_PROPOSED', confirmedAt: null, proposalDecision: null })

    // The supplier neither decides nor confirms now; its proposal is not changed but by a new one.
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrder" SET status = 'SENT', "proposalDecision" = 'REFUSED', "proposalDecidedAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/only confirms or declines its SENT purchase order/)
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 10, "confirmedDate" = '2026-12-10' WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/only confirms the lines of its SENT purchase order/)
    await expect(run(partner(A.P2), `UPDATE "PurchaseOrderLine" SET "proposalReason" = 'Other words' WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/written only while its order is SENT/)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET "proposalNote" = 'Edited' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/is written only when it moves from SENT to CHANGES_PROPOSED/)

    // It leaves CHANGES_PROPOSED only by the buyer's decision.
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'SENT' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/only by the buyer's decision/)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/cannot move from CHANGES_PROPOSED to CANCELLED/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET status = 'SENT', "proposalDecision" = 'REFUSED', "proposalDecidedAt" = now(), "proposalDecisionNote" = 'We need it all' WHERE id = $1::uuid`, order.orderId)).toBe(1)
    // Its next proposal clears that decision (the trigger), and the buyer accepts it: the proposal becomes the confirmation.
    await propose('2026-12-04')
    ;[row] = await admin('SELECT status::text, "proposalDecision", "proposalDecidedAt", "proposalDecisionNote" FROM "PurchaseOrder" WHERE id = $1', [order.orderId])
    expect(row).toEqual({ status: 'CHANGES_PROPOSED', proposalDecision: null, proposalDecidedAt: null, proposalDecisionNote: null })
    await expect(
      run(office(), `UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', "proposalDecision" = 'ACCEPTED', "proposalDecidedAt" = now() WHERE id = $1::uuid`, order.orderId),
    ).rejects.toThrow(/only by the buyer's decision/)
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 10, "confirmedDate" = '2026-12-10' WHERE id = $1::uuid`, order.lineId)
        await tx.$executeRawUnsafe(
          `UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'LINK', "confirmLinkId" = $2::uuid, "proposalDecision" = 'ACCEPTED', "proposalDecidedAt" = now() WHERE id = $1::uuid`,
          order.orderId,
          A.linkP2,
        )
      }),
    )
    ;[row] = await admin('SELECT status::text, "proposalDecision", "proposedAt" IS NOT NULL AS kept FROM "PurchaseOrder" WHERE id = $1', [order.orderId])
    expect(row).toEqual({ status: 'CONFIRMED', proposalDecision: 'ACCEPTED', kept: true })
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "proposedQuantity" = 1 WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/written only while its order is SENT/)
  })

  it('declines a SENT order with its reason; the office changes it in a new revision', async () => {
    const order = await draftOrder(A.P2)
    await send(order.orderId)
    expect(await run(partner(A.P2), `UPDATE "PurchaseOrder" SET status = 'DECLINED', "declinedAt" = now(), "declineReason" = 'No stock before January.' WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', "sentAt" = NULL WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/revision of purchase order/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', "sentAt" = NULL, revision = revision + 1 WHERE id = $1::uuid`, order.orderId)).toBe(1)
    expect(await run(office(), `UPDATE "PurchaseOrderLine" SET "needDate" = '2027-01-15' WHERE id = $1::uuid`, order.lineId)).toBe(1)
    const [row] = await admin('SELECT status::text, revision, "declineReason" FROM "PurchaseOrder" WHERE id = $1', [order.orderId])
    expect(row).toEqual({ status: 'DRAFT', revision: 2, declineReason: 'No stock before January.' })
  })
})

// --- purchase orders --------------------------------------------------------------------------------------------------

describe('a purchase order', () => {
  it('freezes its lines once it is sent', async () => {
    const { purchaseOrderId, leatherLineId } = seeded.supply
    // The seeded PO1 is PARTLY_RECEIVED.
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET quantity = 500 WHERE id = $1::uuid`, leatherLineId)).rejects.toThrow(/its lines change only while it is DRAFT/)
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "unitPrice" = 3.9 WHERE id = $1::uuid`, leatherLineId)).rejects.toThrow(/its lines change only while it is DRAFT/)
    await expect(run(office(), 'DELETE FROM "PurchaseOrderLine" WHERE id = $1::uuid', leatherLineId)).rejects.toThrow(/removed only while it is DRAFT/)
    await expect(
      insert(office(), 'PurchaseOrderLine', {
        id: randomUUID(),
        purchaseOrderId,
        partyId: A.P2,
        siteId: A.siteA,
        seq: 30,
        itemId: A.protector,
        quantity: '1.0000',
        uom: 'PCS',
        baseQuantity: '1.0000',
        unitPrice: '6.500000',
        netAmount: 650,
        needDate: '2026-12-01',
      }),
    ).rejects.toThrow(/lines are added only while it is DRAFT/)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET "paymentTerms" = 'cash' WHERE id = $1::uuid`, purchaseOrderId)).rejects.toThrow(/terms change only while it is DRAFT/)
    // The owner too.
    await expect(admin(`UPDATE "PurchaseOrderLine" SET quantity = 500 WHERE id = $1`, [leatherLineId])).rejects.toThrow(/its lines change only while it is DRAFT/)

    // A draft's lines change; it is sent with a line and the sum of its lines; a recall raises the revision.
    const order = await draftOrder()
    expect(await run(office(), `UPDATE "PurchaseOrderLine" SET quantity = 12, "baseQuantity" = 12, "netAmount" = 7800 WHERE id = $1::uuid`, order.lineId)).toBe(1)
    await expect(send(order.orderId)).rejects.toThrow(/is not the sum of its lines/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET "netAmount" = 7800 WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await send(order.orderId)
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET quantity = 14 WHERE id = $1::uuid`, order.lineId)).rejects.toThrow(/its lines change only while it is DRAFT/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', "sentAt" = NULL, revision = revision + 1 WHERE id = $1::uuid`, order.orderId)).toBe(1)
    expect(await run(office(), `UPDATE "PurchaseOrderLine" SET quantity = 14, "baseQuantity" = 14, "netAmount" = 9100 WHERE id = $1::uuid`, order.lineId)).toBe(1)
    expect(await run(office(), 'DELETE FROM "PurchaseOrderLine" WHERE id = $1::uuid', order.lineId)).toBe(1)
    await expect(send(order.orderId)).rejects.toThrow(/has no line; it cannot be sent/)
  })

  it('starts as DRAFT, moves only along its states, is cancelled with a reason and never deleted', async () => {
    await expect(
      insert(office(), 'PurchaseOrder', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, number: `T-PO-${tag()}`, partyId: A.P2, orderDate: '2026-11-01', status: 'SENT', sentAt: new Date().toISOString() }),
    ).rejects.toThrow(/starts as DRAFT/)
    const order = await draftOrder()
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'RECEIVED', "sentAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/cannot move from DRAFT to RECEIVED/)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'CANCELLED', "cancelledAt" = now() WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/cancellation has its time and reason/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Bought elsewhere.' WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT' WHERE id = $1::uuid`, order.orderId)).rejects.toThrow(/cannot move from CANCELLED to DRAFT/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET "internalNote" = 'kept for the record' WHERE id = $1::uuid`, order.orderId)).toBe(1)
    await expect(run(office(), 'DELETE FROM "PurchaseOrder" WHERE id = $1::uuid', order.orderId)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "PurchaseOrder" WHERE id = $1', [order.orderId])).rejects.toThrow(/cancelled, never deleted/)
    // CASCADE: the lines, receipts and requirements refer to it; the first refusing trigger stops the whole statement.
    await expect(admin('TRUNCATE "PurchaseOrder" CASCADE')).rejects.toThrow(/TRUNCATE on "\w+" is refused/)
  })
})

// --- the stock ledger -------------------------------------------------------------------------------------------------

describe('the stock ledger', () => {
  it('is append-only, for every login, and so is its valuation', async () => {
    const move = seeded.openingMoveId
    await expect(run(office(), `UPDATE "StockMove" SET note = 'x' WHERE id = $1::uuid`, move)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "StockMove" WHERE id = $1::uuid', move)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "StockMove" SET note = 'x' WHERE id = $1`, [move])).rejects.toThrow(/append-only: UPDATE on "StockMove" is refused/)
    await expect(admin('DELETE FROM "StockMove" WHERE id = $1', [move])).rejects.toThrow(/append-only: DELETE on "StockMove" is refused/)
    await expect(admin('TRUNCATE "StockMove" CASCADE')).rejects.toThrow(/append-only: TRUNCATE on "Stock(Move|Valuation)" is refused/)
    await expect(run(office(), `UPDATE "StockValuation" SET note = 'x' WHERE "moveId" = $1::uuid`, move)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "StockValuation" SET "unitCost" = 0 WHERE "moveId" = $1`, [move])).rejects.toThrow(/append-only: UPDATE on "StockValuation" is refused/)
    await expect(admin('DELETE FROM "StockValuation" WHERE "moveId" = $1', [move])).rejects.toThrow(/append-only: DELETE on "StockValuation" is refused/)
    await expect(admin('TRUNCATE "StockValuation"')).rejects.toThrow(/append-only: TRUNCATE on "StockValuation" is refused/)
  })

  it('never issues a lot in quarantine; a Cr VI PASS below the limit releases it', async () => {
    const received = await receive(['50.0000'])
    const issue = issueRow(received, 0, '50.0000')
    // Neither the office nor the floor issues it while it is in QUARANTINE.
    await expect(insert(office(), 'StockMove', issue)).rejects.toThrow(/is QUARANTINE; only RELEASED stock is issued \(REACH Annex XVII entry 47/)
    await expect(insert(floor(), 'StockMove', { ...issue, id: randomUUID() })).rejects.toThrow(/only RELEASED stock is issued/)
    // It may still move inside the site (to the quarantine shelf and back).
    const shelf = moveRow({ reason: 'TRANSFER', lotId: received.lotId, hideId: received.hideIds[0], fromLocationId: seeded.locations.bin, toLocationId: seeded.locations.quarantine, quantity: '50.0000', baseQuantity: '50.0000' })
    expect(await insert(floor(), 'StockMove', shelf)).toBe(1)
    expect(await insert(floor(), 'StockMove', { ...shelf, id: randomUUID(), idempotencyKey: `test-${randomUUID()}`, fromLocationId: seeded.locations.quarantine, toLocationId: seeded.locations.bin })).toBe(1)

    // Released only with a PASS below the limit, with its evidence.
    await expect(run(office(), `UPDATE "Lot" SET "qualityStatus" = 'RELEASED', "qualityDecidedAt" = now() WHERE id = $1::uuid`, received.lotId)).rejects.toThrow(
      /it is released only with a PASS/,
    )
    await expect(release(received.lotId, '3.000')).rejects.toThrow(/below the limit is a PASS, at or above it a FAIL/)
    await expect(run(office(), `UPDATE "Lot" SET "crViStatus" = 'PASS', "crViMgKg" = 1 WHERE id = $1::uuid`, received.lotId)).rejects.toThrow(/names its evidence/)
    await expect(
      run(office(), `UPDATE "Lot" SET "crViLimitMgKg" = 5 WHERE id = $1::uuid`, received.lotId),
    ).rejects.toThrow(/Cr VI requirement and creation of lot .* never change/)
    expect(await release(received.lotId)).toBe(1)
    expect(await insert(floor(), 'StockMove', { ...issue, id: randomUUID() })).toBe(1)

    // Later evidence: a FAIL blocks it again, and a blocked lot is not issued.
    const second = await receive(['40.0000'])
    expect(await release(second.lotId)).toBe(1)
    await expect(run(office(), `UPDATE "Lot" SET "crViStatus" = 'FAIL', "crViMgKg" = 4.1 WHERE id = $1::uuid`, second.lotId)).rejects.toThrow(/released only with a PASS/)
    expect(await run(office(), `UPDATE "Lot" SET "crViStatus" = 'FAIL', "crViMgKg" = 4.1, "qualityStatus" = 'BLOCKED' WHERE id = $1::uuid`, second.lotId)).toBe(1)
    await expect(insert(floor(), 'StockMove', issueRow(second, 0, '40.0000'))).rejects.toThrow(/is BLOCKED; only RELEASED stock is issued/)
    await expect(release(second.lotId)).rejects.toThrow(/the Cr VI result of lot .* cannot move from FAIL to PASS/)
    // A lot of an item that needs the test needs it too.
    await expect(
      insert(office(), 'Lot', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, itemId: A.leather, itemColourId: A.leatherBLK, code: `T-LOT-${tag()}`, qualityStatus: 'RELEASED', qualityDecidedAt: new Date().toISOString() }),
    ).rejects.toThrow(/needs Cr VI evidence \(REACH Annex XVII entry 47\), so does its lot/)
  })

  it('never takes a location below zero, also when two issues of one hide race', async () => {
    const received = await receive(['45.5000', '47.2500'])
    await release(received.lotId)
    // Two floor devices issue the same hide at once: the first holds its transaction open after its insert; the second
    // waits for the first's lock, then sees its issue and is refused.
    let firstInserted!: () => void
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve
    })
    const first = as(floor(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(...insertSql('StockMove', issueRow(received, 0, '45.5000')))
        firstInserted()
        await new Promise((resolve) => setTimeout(resolve, 300))
      }),
    )
    await inserted
    const second = insert(floor(), 'StockMove', issueRow(received, 0, '45.5000'))
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/stock never goes below zero/)
    // More than the hide holds, or from a location it is not in.
    await expect(insert(floor(), 'StockMove', issueRow(received, 1, '47.2600'))).rejects.toThrow(/holds 47.25.* stock never goes below zero/)
    await expect(insert(floor(), 'StockMove', { ...issueRow(received, 1, '47.2500'), fromLocationId: seeded.locations.dock })).rejects.toThrow(/stock never goes below zero/)
    // The balance is the sum of the ledger.
    const balance = await sql(
      office(),
      `SELECT coalesce(sum(CASE WHEN "toLocationId" = $2::uuid THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::text AS on_hand
         FROM "StockMove" WHERE "lotId" = $1::uuid AND ("toLocationId" = $2::uuid OR "fromLocationId" = $2::uuid)`,
      received.lotId,
      seeded.locations.bin,
    )
    expect(balance).toEqual([{ on_hand: '47.2500' }])
    // An archived location takes no stock, and a location is archived only once it is empty.
    await expect(run(office(), `UPDATE "Location" SET status = 'ARCHIVED' WHERE id = $1::uuid`, seeded.locations.bin)).rejects.toThrow(/still holds stock/)
    expect(await run(office(), `UPDATE "Location" SET status = 'ARCHIVED' WHERE id = $1::uuid`, seeded.locations.dock)).toBe(1)
    await expect(
      insert(floor(), 'StockMove', moveRow({ reason: 'TRANSFER', lotId: received.lotId, hideId: received.hideIds[1], fromLocationId: seeded.locations.bin, toLocationId: seeded.locations.dock, quantity: '47.2500', baseQuantity: '47.2500' })),
    ).rejects.toThrow(/is archived; it takes no stock/)
    expect(await run(office(), `UPDATE "Location" SET status = 'ACTIVE' WHERE id = $1::uuid`, seeded.locations.dock)).toBe(1)
  })

  it('follows the item’s tracking and the reason’s direction, and says why an adjustment is made', async () => {
    const [, hide2] = seeded.hideIds
    const base = { lotId: seeded.leatherLotId, hideId: hide2, quantity: '1.0000', baseQuantity: '1.0000' }
    await expect(insert(office(), 'StockMove', moveRow({ ...base, reason: 'ADJUSTMENT', toLocationId: seeded.locations.bin }))).rejects.toThrow(/says why \(SCM-192\)/)
    await expect(insert(office(), 'StockMove', moveRow({ ...base, reason: 'ISSUE', fromLocationId: seeded.locations.bin, toLocationId: seeded.locations.cutting, workOrderId }))).rejects.toThrow(
      /with the wrong locations/,
    )
    await expect(insert(office(), 'StockMove', moveRow({ ...base, reason: 'RECEIPT', toLocationId: seeded.locations.bin }))).rejects.toThrow(/names its goods receipt line/)
    await expect(insert(office(), 'StockMove', moveRow({ ...base, reason: 'ISSUE', fromLocationId: seeded.locations.bin }))).rejects.toThrow(/without its work order/)
    await expect(insert(office(), 'StockMove', moveRow({ ...base, hideId: null, reason: 'ADJUSTMENT', note: 'Found', toLocationId: seeded.locations.bin }))).rejects.toThrow(
      /is tracked by HIDE/,
    )
    await expect(insert(office(), 'StockMove', moveRow({ ...base, quantity: '2.0000', reason: 'ADJUSTMENT', note: 'Found', toLocationId: seeded.locations.bin }))).rejects.toThrow(
      /its quantity is its base quantity/,
    )
    await expect(insert(office(), 'StockMove', moveRow({ ...base, quantity: '0.0000', baseQuantity: '0.0000', reason: 'ADJUSTMENT', note: 'x', toLocationId: seeded.locations.bin }))).rejects.toThrow(
      /a quantity above 0/,
    )
    expect(await insert(office(), 'StockMove', moveRow({ ...base, reason: 'ADJUSTMENT', note: 'Remeasured: 1 ft² more.', toLocationId: seeded.locations.bin }))).toBe(1)
    // The hide keeps what was measured at receipt: its area never changes; a CONSUMED hide never changes.
    await expect(run(floor(), `UPDATE "Hide" SET area = 53.8 WHERE id = $1::uuid`, hide2)).rejects.toThrow(/measured area of hide .* never change/)
    expect(await run(floor(), `UPDATE "Hide" SET state = 'PARTLY_CUT', defects = 'Cut around the scar.' WHERE id = $1::uuid`, hide2)).toBe(1)
    await expect(run(floor(), `UPDATE "Hide" SET state = 'FULL' WHERE id = $1::uuid`, hide2)).rejects.toThrow(/never FULL again/)
  })

  it('posts a receipt only when the ledger holds its lines; a move has one reversal, which mirrors it', async () => {
    await expect(receive(['30.0000'], { lineQuantity: '31.0000' })).rejects.toThrow(/the ledger holds 30.* of its line/)
    const received = await receive(['33.3000'])
    // A posted receipt's lines never change.
    await expect(run(office(), `UPDATE "GoodsReceiptLine" SET note = 'x' WHERE id = $1::uuid`, received.lineId)).rejects.toThrow(/its lines change only while it is OPEN/)
    // Reversed: each move reversed once, mirrored; then the receipt is REVERSED, with its reason.
    const reversal = moveRow({
      reason: 'RECEIPT',
      lotId: received.lotId,
      hideId: received.hideIds[0],
      fromLocationId: seeded.locations.bin,
      quantity: '33.3000',
      baseQuantity: '33.3000',
      receiptLineId: received.lineId,
      reversalOfId: received.moveIds[0],
    })
    await expect(insert(office(), 'StockMove', { ...reversal, fromLocationId: seeded.locations.quarantine })).rejects.toThrow(/with its locations swapped/)
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(...insertSql('StockMove', reversal))
        await tx.$executeRawUnsafe(`UPDATE "GoodsReceipt" SET status = 'REVERSED', "reversedAt" = now(), "reversalReason" = 'Wrong lot.' WHERE id = $1::uuid`, received.receiptId)
      }),
    )
    await expect(admin('DELETE FROM "GoodsReceipt" WHERE id = $1', [received.receiptId])).rejects.toThrow(/never deleted/)

    // A receipt's moves come with its posting: never after it (R1 is POSTED), never without it (R2 is OPEN).
    const [, hide2] = seeded.hideIds
    await expect(
      insert(office(), 'StockMove', moveRow({ reason: 'RECEIPT', lotId: seeded.leatherLotId, hideId: hide2, toLocationId: seeded.locations.bin, quantity: '1.0000', baseQuantity: '1.0000', receiptLineId: seeded.receiptLineId })),
    ).rejects.toThrow(/is POSTED; its moves are posted while it is OPEN/)
    const protectorLot = randomUUID()
    await insert(office(), 'Lot', { id: protectorLot, companyId: A.companyA, siteId: A.siteA, itemId: A.protector, code: `T-LOT-${tag()}`, receiptLineId: seeded.openReceiptLineId })
    await expect(
      insert(office(), 'StockMove', moveRow({ itemId: A.protector, itemColourId: null, uom: 'PCS', reason: 'RECEIPT', lotId: protectorLot, toLocationId: seeded.locations.bin, quantity: '24.0000', baseQuantity: '24.0000', receiptLineId: seeded.openReceiptLineId })),
    ).rejects.toThrow(/whose receipt is OPEN at commit/)

    // An issue returned by its reversal: at most one reversal per move, and a reversal is not reversed.
    const issued = await receive(['20.0000'])
    await release(issued.lotId)
    const issue = issueRow(issued, 0, '20.0000')
    expect(await insert(floor(), 'StockMove', issue)).toBe(1)
    const back = { ...issue, id: randomUUID(), idempotencyKey: `test-${randomUUID()}`, fromLocationId: null, toLocationId: seeded.locations.bin, reversalOfId: issue.id }
    expect(await insert(floor(), 'StockMove', back)).toBe(1)
    await expect(insert(floor(), 'StockMove', { ...back, id: randomUUID(), idempotencyKey: `test-${randomUUID()}` })).rejects.toThrow(/StockMove_one_reversal/)
    await expect(
      insert(floor(), 'StockMove', { ...issue, id: randomUUID(), idempotencyKey: `test-${randomUUID()}`, reversalOfId: back.id }),
    ).rejects.toThrow(/is itself a reversal; it is not reversed/)
  })
})

// --- planning ---------------------------------------------------------------------------------------------------------

describe('planning', () => {
  it('runs alone on its site, and a requirement’s numbers never change', async () => {
    const running = () => ({ id: randomUUID(), companyId: A.companyA, siteId: A.siteA, trigger: 'MANUAL', startedAt: new Date().toISOString() })
    const first = running()
    expect(await insert(office(), 'PlanningRun', first)).toBe(1)
    await expect(insert(office(), 'PlanningRun', running())).rejects.toThrow(/PlanningRun_one_running_per_site|duplicate key/)
    await expect(run(office(), `UPDATE "PlanningRun" SET status = 'FAILED', "finishedAt" = now() WHERE id = $1::uuid`, first.id)).rejects.toThrow(/finish time or error/)
    expect(await run(office(), `UPDATE "PlanningRun" SET status = 'DONE', "finishedAt" = now() WHERE id = $1::uuid`, first.id)).toBe(1)

    const requirement = (await admin('SELECT id::text FROM "MaterialRequirement" WHERE "runId" = $1 AND seq = 2', [seeded.supply.planningRunId]))[0]!.id as string
    await expect(run(office(), `UPDATE "MaterialRequirement" SET "grossQuantity" = 1 WHERE id = $1::uuid`, requirement)).rejects.toThrow(/run's snapshot; they never change/)
    await expect(run(office(), `UPDATE "MaterialRequirement" SET decision = 'ORDERED', "decidedAt" = now() WHERE id = $1::uuid`, requirement)).rejects.toThrow(
      /ORDERED with the purchase order line that buys it/,
    )
    await expect(
      run(office(), `UPDATE "MaterialRequirement" SET decision = 'ORDERED', "decidedAt" = now(), "purchaseOrderLineId" = $2::uuid WHERE id = $1::uuid`, requirement, seeded.supply.leatherLineId),
    ).rejects.toThrow(/buys another material or colour/)
    expect(await run(office(), `UPDATE "MaterialRequirement" SET decision = 'IGNORED', "decidedAt" = now(), "decisionNote" = 'Red is postponed.' WHERE id = $1::uuid`, requirement)).toBe(1)
    await expect(
      insert(office(), 'MaterialRequirement', {
        id: randomUUID(),
        siteId: A.siteA,
        runId: first.id,
        seq: 1,
        itemId: A.protector,
        action: 'BUY',
        uom: 'PCS',
        grossQuantity: '24.0000',
        usableStock: '4.0000',
        heldStock: '0.0000',
        onOrder: '0.0000',
        netQuantity: '24.0000',
        suggestedQuantity: '24.0000',
        suggestedUom: 'PCS',
        needDate: '2026-12-01',
        sources: [],
      }),
    ).rejects.toThrow(/net need of max\(0, gross - usable stock - on order\)/)
  })
})

// --- the seeds --------------------------------------------------------------------------------------------------------

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['Location', 'GoodsReceipt', 'GoodsReceiptLine', 'Lot', 'Hide', 'StockMove', 'StockValuation', 'PurchaseOrder', 'PurchaseOrderLine', 'PlanningRun', 'MaterialRequirement']
    const counts = async () => {
      const out: number[] = []
      for (const table of tables) out.push(await count(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId]))
      return out
    }
    const before = await counts()
    await seedInventory({ db: factory, namespace: 'supply-b' })
    expect(await counts()).toEqual(before)
    const [order] = await admin(`SELECT status::text FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = 'SEED-PO-0001'`, [b.tenantId])
    expect(order).toEqual({ status: 'PARTLY_RECEIVED' })
  })
})
