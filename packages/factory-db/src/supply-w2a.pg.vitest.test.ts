import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedLinks } from '../seed/links'
import { seed as seedSourcing, type SourcingSeed } from '../seed/sourcing'
import { seed as seedSubcontract, type SubcontractSeed } from '../seed/subcontract'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, partnerWalledColumns } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2a schema wave 3/7 (product and supply) beyond the generated isolation tests, on a database built from the
 * migrations and seeded twice (tenants A and B), through the real login and the scoped client:
 *   - the walls: the new tables are the office's; the floor reads the type-change reviews and never a subcontracted
 *     step's fee; a supplier's link session reads only its own party's purchase order revisions, never their prices,
 *     PDF or who sent them; every cost column is hidden from the partner;
 *   - revisions and reminders are append-only for every login, the owner included, and are written only for a sent
 *     (waiting) order;
 *   - a confirmed order goes back to DRAFT as its next revision, losing its confirmation, and is sent again only once its
 *     lines' earlier confirmation is cleared; a refused proposal may become a new revision; the confirm-by deadline;
 *   - a line is cancelled or closed short once, with its reason, then changes no more and takes no goods; a cancelled
 *     line does not count at the send;
 *   - a receipt line's received unit and factor give its base quantity; a SUBCONTRACTOR location names its workshop;
 *   - customs data, a subcontracted routing step, a certificate's renewal and a type-change review hold their rules;
 *   - sources, discrepancies, claims and subcontract orders (operations, kit) move only as their states allow;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const DENIED = /permission denied/
const FILES = new Set(['sourcing.prisma', 'claims.prisma', 'subcontract.prisma'])

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let seeded: SourcingSeed
let seededB: SourcingSeed
let sub: SubcontractSeed

const key = (namespace: string, name: string): string => seedUuid(namespace, name)
const A = {
  companyA: key('w2a3-a', 'company:A'),
  siteA: key('w2a3-a', 'site:A1'),
  P1: key('w2a3-a', 'party:P1'),
  P2: key('w2a3-a', 'party:P2'),
  leather: key('w2a3-a', 'product:item:leather'),
  leatherBLK: key('w2a3-a', 'product:item-colour:leather:BLK'),
  lining: key('w2a3-a', 'product:item:lining'),
  liningGRY: key('w2a3-a', 'product:item-colour:lining:GRY'),
  protector: key('w2a3-a', 'product:item:protector'),
  style: key('w2a3-a', 'product:style:JKT-01'),
  revision: key('w2a3-a', 'product:revision:JKT-01:1'),
  certificate: key('w2a3-a', 'compliance:certificate:JKT-01'),
  bin: key('w2a3-a', 'inventory:location:A1-STORE-01'),
  store: key('w2a3-a', 'inventory:location:A1-STORE'),
  liningLot: key('w2a3-a', 'inventory:lot:LIN-01'),
}

const office = (core: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (text: string, values: unknown[] = []) => Number((await admin(text, values))[0]!.n)
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const tag = (): string => randomUUID().slice(0, 8)

beforeAll(async () => {
  db = await migratedDatabase('supplyw2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'w2a3-a' })
  b = await seedCore({ db: factory, namespace: 'w2a3-b' })
  // P2's PO_CONFIRM link (a proposal names it) and the files seed's StoredFile rows (none of a purchase order).
  await seedLinks({ db: factory, namespace: 'w2a3-a' })
  await seedFiles({ db: factory, namespace: 'w2a3-a' })
  seeded = await seedSourcing({ db: factory, namespace: 'w2a3-a' })
  sub = await seedSubcontract({ db: factory, namespace: 'w2a3-a' })
  seededB = await seedSourcing({ db: factory, namespace: 'w2a3-b' })
  await seedSubcontract({ db: factory, namespace: 'w2a3-b' })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

/** A DRAFT purchase order of company A to `partyId` at A1, with one line of 10 protectors at 6.50. */
async function draftOrder(partyId: string = A.P2): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID()
  const lineId = randomUUID()
  await insert(office(), 'PurchaseOrder', { id: orderId, companyId: A.companyA, siteId: A.siteA, number: `T-PO-${tag()}`, partyId, orderDate: '2026-11-01', netAmount: 6_500 })
  await insert(office(), 'PurchaseOrderLine', {
    id: lineId,
    purchaseOrderId: orderId,
    partyId,
    siteId: A.siteA,
    seq: 10,
    itemId: A.protector,
    quantity: '10',
    uom: 'PCS',
    baseQuantity: '10',
    unitPrice: '6.5',
    netAmount: 6_500,
    needDate: '2026-12-01',
  })
  return { orderId, lineId }
}
const send = (orderId: string) => run(office(), `UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now() WHERE id = $1::uuid`, orderId)
async function confirm(orderId: string, lineId: string): Promise<void> {
  await run(office(), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 10, "confirmedDate" = '2026-12-01' WHERE id = $1::uuid`, lineId)
  await run(office(), `UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', "confirmedByName" = 'Seed desk' WHERE id = $1::uuid`, orderId)
}
const status = async (table: string, id: string) => String((await admin(`SELECT status::text AS s FROM "${table}" WHERE id = $1`, [id]))[0]!.s)

// --- the walls ------------------------------------------------------------------------------------------------------

describe('the walls', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))

  it('the new tables are the office’s: the floor reads none, the partner only its own revisions without prices', async () => {
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'PurchaseOrderReminder',
      'PurchaseOrderRevision',
      'ReceiptDiscrepancy',
      // W2b schema wave 1/7 (B-W2b-01): the bundles out and the receipts back, office only.
      'SubcontractBundle',
      'SubcontractKitLine',
      'SubcontractOperation',
      'SubcontractOrder',
      'SubcontractReceipt',
      'SubcontractReceiptLine',
      'SupplierClaim',
      'SupplierClaimLine',
      'SupplierItem',
    ])
    for (const { model, ownership } of models) {
      expect(ownership.access[FLOOR_ROLE], model.name).toBeUndefined()
      await expect(sql(floor(), `SELECT 1 FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
      const access = ownership.access[PARTNER_ROLE]
      if (!access) {
        await expect(sql(partner(A.P1), `SELECT 1 FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
        continue
      }
      expect(model.name).toBe('PurchaseOrderRevision')
      expect(access.privileges).toEqual(['select'])
      for (const { column } of partnerWalledColumns(model)) expect(access.hiddenColumns, `${model.name}.${column}`).toContain(column)
      for (const column of access.hiddenColumns ?? []) await expect(sql(partner(A.P1), `SELECT "${column}" FROM "${model.table}" LIMIT 1`), column).rejects.toThrow(DENIED)
    }
    // The cost columns of the new tables (every one of them hidden from a partner that reads the table).
    const walled = models.flatMap(({ model }) => partnerWalledColumns(model).map(({ column }) => `${model.name}.${column}`)).sort()
    expect(walled).toEqual([
      'PurchaseOrderRevision.afterPrices',
      'PurchaseOrderRevision.beforePrices',
      'SubcontractOperation.netAmount',
      'SubcontractOperation.pricePerPiece',
      'SubcontractOrder.internalNote',
      'SubcontractOrder.netAmount',
      'SupplierClaim.expectedCreditAmount',
      'SupplierClaim.internalNote',
      'SupplierClaimLine.creditAmount',
      'SupplierClaimLine.unitCost',
      'SupplierItem.unitPrice',
    ])
  })

  it('a supplier’s link session reads its own party’s revisions (what changed), never another party’s or a price', async () => {
    const mine = await sql(partner(A.P1), 'SELECT id, revision, "after", "before", "changeNote" FROM "PurchaseOrderRevision" ORDER BY revision')
    expect(mine.map((row) => [row.id, row.revision])).toEqual([
      [seeded.revisionIds[0], 1],
      [seeded.revisionIds[1], 2],
    ])
    expect(JSON.stringify(mine)).not.toMatch(/unitPrice|netAmount/)
    expect(await sql(partner(A.P2), 'SELECT id FROM "PurchaseOrderRevision"')).toEqual([])
    // Prisma's default select names every column, so a forgotten select fails loudly.
    await expect(as(partner(A.P1), (client) => client.purchaseOrderRevision.findMany())).rejects.toThrow(DENIED)
    // The new line columns of the order that say who cancelled or closed it short stay hidden too.
    for (const column of ['cancelledById', 'closedShortById']) await expect(sql(partner(A.P1), `SELECT "${column}" FROM "PurchaseOrderLine" LIMIT 1`)).rejects.toThrow(DENIED)
  })

  it('the floor reads routing steps without a subcontracted step’s fee, and the type-change reviews', async () => {
    await expect(sql(floor(), 'SELECT "pricePerPiece" FROM "RoutingOperation" LIMIT 1')).rejects.toThrow(DENIED)
    expect((await sql(floor(), 'SELECT "supplierId", "transitDays" FROM "RoutingOperation" LIMIT 1')).length).toBe(1)
    expect((await sql(floor(), 'SELECT id, status::text AS status FROM "TypeChangeReview"')).map((row) => row.id)).toEqual([seeded.typeChangeReviewId])
    await expect(run(floor(), `UPDATE "TypeChangeReview" SET "changes" = '[]' WHERE id = $1::uuid`, seeded.typeChangeReviewId)).rejects.toThrow(DENIED)
  })
})

// --- revisions and reminders --------------------------------------------------------------------------------------

describe('purchase order revisions and reminders', () => {
  it('are append-only, for every login', async () => {
    for (const [table, id] of [
      ['PurchaseOrderRevision', seeded.revisionIds[0]],
      ['PurchaseOrderReminder', seeded.reminderId],
    ] as const) {
      await expect(admin(`UPDATE "${table}" SET "createdById" = NULL WHERE id = $1`, [id])).rejects.toThrow(new RegExp(`append-only: UPDATE on "${table}" is refused`))
      await expect(admin(`DELETE FROM "${table}" WHERE id = $1`, [id])).rejects.toThrow(new RegExp(`append-only: DELETE on "${table}" is refused`))
      await expect(admin(`TRUNCATE "${table}"`)).rejects.toThrow(new RegExp(`append-only: TRUNCATE on "${table}" is refused`))
    }
  })

  it('a revision freezes a sent order, with its snapshot objects and the order’s own PDF', async () => {
    const { orderId } = await draftOrder()
    const row = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), purchaseOrderId: orderId, partyId: A.P2, siteId: A.siteA, revision: 1, sentAt: new Date().toISOString(), after: { lines: [] }, afterPrices: { lines: [] }, ...extra })
    await expect(insert(office(), 'PurchaseOrderRevision', row())).rejects.toThrow(/is DRAFT; a revision is written when it is sent/)
    await send(orderId)
    await expect(insert(office(), 'PurchaseOrderRevision', row({ after: [] }))).rejects.toThrow(/the order as sent and its prices/)
    await expect(insert(office(), 'PurchaseOrderRevision', row({ before: { lines: [] } }))).rejects.toThrow(/the previous state with its prices or neither/)
    // A file of another record is not this order's PDF.
    const [file] = await admin(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" <> 'PurchaseOrder' LIMIT 1`, [a.tenantId])
    await expect(insert(office(), 'PurchaseOrderRevision', row({ documentFileId: file!.id }))).rejects.toThrow(/is a file of that order/)
    expect(await insert(office(), 'PurchaseOrderRevision', row())).toBe(1)
    // One row per revision of an order.
    await expect(insert(office(), 'PurchaseOrderRevision', row())).rejects.toThrow(/PurchaseOrderRevision_tenantId_purchaseOrderId_revision_key|duplicate key/)
  })

  it('a reminder to confirm goes only to a SENT order, for its current revision', async () => {
    const { orderId, lineId } = await draftOrder()
    const row = (revision = 1) => ({ id: randomUUID(), purchaseOrderId: orderId, partyId: A.P2, siteId: A.siteA, revision, kind: 'CONFIRMATION', sentAt: new Date().toISOString() })
    await expect(insert(office(), 'PurchaseOrderReminder', row())).rejects.toThrow(/a reminder to confirm goes only to a SENT order/)
    await send(orderId)
    await expect(insert(office(), 'PurchaseOrderReminder', row(2))).rejects.toThrow(/for its current revision/)
    expect(await insert(office(), 'PurchaseOrderReminder', row())).toBe(1)
    await confirm(orderId, lineId)
    await expect(insert(office(), 'PurchaseOrderReminder', row())).rejects.toThrow(/is CONFIRMED \(revision 1\)/)
  })
})

// --- re-confirm, confirm-by, cancel and close short ----------------------------------------------------------------

describe('purchase order changes', () => {
  it('a confirmed order goes back to DRAFT as its next revision, losing its confirmation, and is sent again once its lines are cleared', async () => {
    const { orderId, lineId } = await draftOrder()
    await send(orderId)
    await confirm(orderId, lineId)
    // The confirmation must go with the move back.
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', revision = 2, "sentAt" = NULL WHERE id = $1::uuid`, orderId)).rejects.toThrow(/set once.*cleared only when a confirmed order goes back to DRAFT|inconsistent confirmation/)
    // And the revision goes up by one.
    await expect(
      run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', "sentAt" = NULL, "confirmedAt" = NULL, "confirmedVia" = NULL, "confirmedByName" = NULL WHERE id = $1::uuid`, orderId),
    ).rejects.toThrow(/revision of purchase order/)
    expect(
      await run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', revision = 2, "sentAt" = NULL, "confirmedAt" = NULL, "confirmedVia" = NULL, "confirmedByName" = NULL WHERE id = $1::uuid`, orderId),
    ).toBe(1)
    // The line still holds revision 1's confirmation: revision 2 is not sent with it.
    await expect(send(orderId)).rejects.toThrow(/still hold the confirmation of an earlier revision/)
    // A confirmation is cleared (never set) while DRAFT.
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 9 WHERE id = $1::uuid`, lineId)).rejects.toThrow(/is set once/)
    expect(await run(office(), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = NULL, "confirmedDate" = NULL, quantity = 12, "baseQuantity" = 12, "netAmount" = 7800 WHERE id = $1::uuid`, lineId)).toBe(1)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET "netAmount" = 7800 WHERE id = $1::uuid`, orderId)).toBe(1)
    expect(await send(orderId)).toBe(1)
    // And the supplier confirms revision 2.
    await run(office(), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 12, "confirmedDate" = '2026-12-02' WHERE id = $1::uuid`, lineId)
    expect(await status('PurchaseOrder', orderId)).toBe('SENT')
  })

  it('a refused proposal may become a new revision (a counter-proposal), never an accepted one', async () => {
    const { orderId, lineId } = await draftOrder(A.P2)
    const [link] = await admin(`SELECT id FROM "OneOffLink" WHERE "tenantId" = $1 AND "partyId" = $2 LIMIT 1`, [a.tenantId, A.P2])
    await send(orderId)
    await run(office(), `UPDATE "PurchaseOrderLine" SET "proposedQuantity" = 8, "proposedDate" = '2026-12-05', "proposalReason" = 'Short of stock' WHERE id = $1::uuid`, lineId)
    await run(office(), `UPDATE "PurchaseOrder" SET status = 'CHANGES_PROPOSED', "proposedAt" = now(), "proposalLinkId" = $2::uuid WHERE id = $1::uuid`, orderId, link!.id)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', revision = 2, "sentAt" = NULL WHERE id = $1::uuid`, orderId)).rejects.toThrow(/only by the buyer's decision/)
    expect(
      await run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', revision = 2, "sentAt" = NULL, "proposalDecision" = 'REFUSED', "proposalDecidedAt" = now() WHERE id = $1::uuid`, orderId),
    ).toBe(1)
    // The stale proposal on the line is cleared while DRAFT, not rewritten.
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "proposedQuantity" = 9 WHERE id = $1::uuid`, lineId)).rejects.toThrow(/written only while its order is SENT/)
    expect(await run(office(), `UPDATE "PurchaseOrderLine" SET "proposedQuantity" = NULL, "proposedDate" = NULL, "proposalReason" = NULL WHERE id = $1::uuid`, lineId)).toBe(1)
  })

  it('the confirm-by deadline comes after the send; the office may move it, a partner session never', async () => {
    const { orderId } = await draftOrder(A.P1)
    await expect(run(office(), `UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "confirmBy" = now() - interval '1 hour' WHERE id = $1::uuid`, orderId)).rejects.toThrow(/to be confirmed by a time after it was sent/)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "confirmBy" = now() + interval '48 hours' WHERE id = $1::uuid`, orderId)).toBe(1)
    expect(await run(office(), `UPDATE "PurchaseOrder" SET "confirmBy" = now() + interval '72 hours' WHERE id = $1::uuid`, orderId)).toBe(1)
    await expect(run(partner(A.P1), `UPDATE "PurchaseOrder" SET "confirmBy" = now() + interval '96 hours' WHERE id = $1::uuid`, orderId)).rejects.toThrow(/a partner session only confirms or declines/)
  })

  it('a line is cancelled once with its reason, then changes no more, takes no goods and does not count at the send', async () => {
    const { orderId, lineId } = await draftOrder(A.P1)
    // A second line, so the order still has one to send.
    const keep = randomUUID()
    await insert(office(), 'PurchaseOrderLine', { id: keep, purchaseOrderId: orderId, partyId: A.P1, siteId: A.siteA, seq: 20, itemId: A.protector, quantity: '2', uom: 'PCS', baseQuantity: '2', unitPrice: '6.5', netAmount: 1_300, needDate: '2026-12-01' })
    await run(office(), `UPDATE "PurchaseOrder" SET "netAmount" = 7800 WHERE id = $1::uuid`, orderId)
    await send(orderId)
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "cancelledAt" = now() WHERE id = $1::uuid`, lineId)).rejects.toThrow(/is cancelled once, with its time and reason/)
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "closedShortAt" = now(), "closeShortReason" = 'x' WHERE id = $1::uuid`, lineId)).rejects.toThrow(/closed short once, with its time and reason, while its order is PARTLY_RECEIVED/)
    // Never by a partner session.
    await expect(run(partner(A.P1), `UPDATE "PurchaseOrderLine" SET "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, lineId)).rejects.toThrow(/a partner session only confirms the lines/)
    expect(await run(office(), `UPDATE "PurchaseOrderLine" SET "cancelledAt" = now(), "cancelledById" = $2::uuid, "cancelReason" = 'No longer needed' WHERE id = $1::uuid`, lineId, a.actorId)).toBe(1)
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "cancelReason" = 'Another reason' WHERE id = $1::uuid`, lineId)).rejects.toThrow(/cancelled or closed short; it changes no more/)
    await expect(run(office(), `UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = 10, "confirmedDate" = '2026-12-01' WHERE id = $1::uuid`, lineId)).rejects.toThrow(/changes no more/)
    // No goods against it: a receipt line naming it is refused.
    const receiptId = randomUUID()
    await insert(office(), 'GoodsReceipt', { id: receiptId, companyId: A.companyA, siteId: A.siteA, number: `T-GR-${tag()}`, supplierId: A.P1, purchaseOrderId: orderId, receivedAt: new Date().toISOString() })
    const receiptLine = (purchaseOrderLineId: string) => ({ id: randomUUID(), siteId: A.siteA, receiptId, seq: 10, purchaseOrderLineId, itemId: A.protector, quantity: '2', uom: 'PCS', baseQuantity: '2' })
    await expect(insert(office(), 'GoodsReceiptLine', receiptLine(lineId))).rejects.toThrow(/is cancelled or closed short; it takes no more goods/)
    expect(await insert(office(), 'GoodsReceiptLine', receiptLine(keep))).toBe(1)
    // Recalled and sent again: the order's amount is its open line's only.
    await run(office(), `UPDATE "PurchaseOrder" SET status = 'DRAFT', revision = 2, "sentAt" = NULL WHERE id = $1::uuid`, orderId)
    await expect(send(orderId)).rejects.toThrow(/is not the sum of its lines \(1300\)/)
    await run(office(), `UPDATE "PurchaseOrder" SET "netAmount" = 1300 WHERE id = $1::uuid`, orderId)
    expect(await send(orderId)).toBe(1)
  })

  it('a line of a PARTLY_RECEIVED order is closed short once; the rest takes no goods', async () => {
    // Tenant B's PO1, partly received by the inventory seed.
    const lineId = seededB.inventory.supply.leatherLineId
    expect(await status('PurchaseOrder', seededB.inventory.supply.purchaseOrderId)).toBe('PARTLY_RECEIVED')
    await expect(run(office(b), `UPDATE "PurchaseOrderLine" SET "closedShortAt" = now() WHERE id = $1::uuid`, lineId)).rejects.toThrow(/closed short once, with its time and reason/)
    expect(await run(office(b), `UPDATE "PurchaseOrderLine" SET "closedShortAt" = now(), "closedShortById" = $2::uuid, "closeShortReason" = 'The tannery has no more of this batch' WHERE id = $1::uuid`, lineId, b.actorId)).toBe(1)
    await expect(run(office(b), `UPDATE "PurchaseOrderLine" SET "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, lineId)).rejects.toThrow(/changes no more/)
    // The open receipt R2 (of the same order) takes nothing more against the closed line.
    const row = { id: randomUUID(), siteId: key('w2a3-b', 'site:A1'), receiptId: seededB.inventory.openReceiptId, seq: 20, purchaseOrderLineId: lineId, itemId: key('w2a3-b', 'product:item:leather'), itemColourId: key('w2a3-b', 'product:item-colour:leather:BLK'), quantity: '10', uom: 'FT2', baseQuantity: '10' }
    await expect(insert(office(b), 'GoodsReceiptLine', row)).rejects.toThrow(/takes no more goods/)
  })
})

// --- receiving, locations, product data ------------------------------------------------------------------------------

describe('receiving and locations', () => {
  it('a receipt line counted in its own unit names the unit and factor its base quantity comes from', async () => {
    const lineId = seeded.inventory.openReceiptLineId // R2: 24 protectors, OPEN
    await expect(run(office(), `UPDATE "GoodsReceiptLine" SET "receivedQuantity" = 2, "receivedUom" = 'BOX' WHERE id = $1::uuid`, lineId)).rejects.toThrow(/all together or not at all/)
    await expect(run(office(), `UPDATE "GoodsReceiptLine" SET "receivedQuantity" = 2, "receivedUom" = 'BOX', "receivedFactor" = 10 WHERE id = $1::uuid`, lineId)).rejects.toThrow(
      /came as 2.* BOX of 10.* base units each: its base quantity is 20.0000/,
    )
    await expect(run(office(), `UPDATE "GoodsReceiptLine" SET "receivedQuantity" = 0, "receivedUom" = 'BOX', "receivedFactor" = 12 WHERE id = $1::uuid`, lineId)).rejects.toThrow(/came as/)
    expect(await run(office(), `UPDATE "GoodsReceiptLine" SET "receivedQuantity" = 2, "receivedUom" = 'BOX', "receivedFactor" = 12 WHERE id = $1::uuid`, lineId)).toBe(1)
    expect(await run(office(), `UPDATE "GoodsReceiptLine" SET "receivedQuantity" = NULL, "receivedUom" = NULL, "receivedFactor" = NULL WHERE id = $1::uuid`, lineId)).toBe(1)
  })

  it('a SUBCONTRACTOR location names its workshop, and only it does; the workshop never changes', async () => {
    const row = (kind: string, partyId: string | null) => ({ id: randomUUID(), companyId: A.companyA, siteId: A.siteA, code: `T-${tag()}`.toUpperCase(), name: 'Test', kind, partyId })
    await expect(insert(office(), 'Location', row('SUBCONTRACTOR', null))).rejects.toThrow(/exactly when it names the workshop/)
    await expect(insert(office(), 'Location', row('WAREHOUSE', A.P2))).rejects.toThrow(/exactly when it names the workshop/)
    await expect(run(office(), `UPDATE "Location" SET "partyId" = $2::uuid WHERE id = $1::uuid`, sub.locationId, A.P1)).rejects.toThrow(/the workshop of location .* never changes/)
    await expect(run(office(), `UPDATE "Location" SET kind = 'WAREHOUSE' WHERE id = $1::uuid`, sub.locationId)).rejects.toThrow(/exactly when it names the workshop/)
    // The floor of A1 sees it (it moves the kit there).
    expect((await sql(floor(), 'SELECT id FROM "Location" WHERE kind = $1::"LocationKind"', 'SUBCONTRACTOR')).map((row) => row.id)).toEqual([sub.locationId])
  })
})

describe('product and compliance data', () => {
  it('customs data: a 6, 8 or 10 digit code, a two-letter origin, a mass above 0', async () => {
    for (const set of [`"hsCode" = '4203'`, `"hsCode" = '4203.10'`, `"originCountry" = 'ita'`, `"netMassKg" = 0`]) {
      await expect(run(office(), `UPDATE "Style" SET ${set} WHERE id = $1::uuid`, A.style), set).rejects.toThrow(/commodity code of 6, 8 or 10 digits/)
    }
    expect(await run(office(), `UPDATE "Style" SET "hsCode" = '42031000', "originCountry" = 'IT', "netMassKg" = 1.85 WHERE id = $1::uuid`, A.style)).toBe(1)
  })

  it('a subcontracted routing step names its workshop before its fee and days', async () => {
    const step = (await admin(`SELECT id FROM "RoutingOperation" WHERE "tenantId" = $1 AND "revisionId" = $2 ORDER BY seq LIMIT 1`, [a.tenantId, A.revision]))[0]!.id as string
    await expect(run(office(), `UPDATE "RoutingOperation" SET "pricePerPiece" = 4.5 WHERE id = $1::uuid`, step)).rejects.toThrow(/names its workshop before a fee/)
    await expect(run(office(), `UPDATE "RoutingOperation" SET "supplierId" = $2::uuid, "transitDays" = -1 WHERE id = $1::uuid`, step, A.P2)).rejects.toThrow(/neither negative/)
    expect(await run(office(), `UPDATE "RoutingOperation" SET "supplierId" = $2::uuid, "pricePerPiece" = 4.5, "transitDays" = 4 WHERE id = $1::uuid`, step, A.P2)).toBe(1)
    expect(await run(office(), `UPDATE "RoutingOperation" SET "supplierId" = NULL, "pricePerPiece" = NULL, "transitDays" = NULL WHERE id = $1::uuid`, step)).toBe(1)
  })

  it('a certificate is renewed once, by another of the same holder valid from a later day, and renews at most one', async () => {
    const [jacket] = await admin(`SELECT to_jsonb(c) AS c FROM "Certificate" c WHERE id = $1`, [A.certificate])
    const base = jacket!.c as Record<string, unknown>
    const certificate = (extra: Record<string, unknown>) => {
      const row = { ...base, id: randomUUID(), number: `T-CERT-${tag()}`, status: 'DRAFT', successorId: null, statusChangedAt: null, ...extra }
      delete (row as Record<string, unknown>).tenantId
      return row
    }
    const later = certificate({ validFrom: '2029-01-01', validTo: '2033-12-31' })
    const earlier = certificate({ validFrom: '2020-01-01', validTo: '2024-12-31' })
    const otherHolder = certificate({ validFrom: '2029-01-01', validTo: '2033-12-31', companyId: A.companyA, holderPartyId: null })
    for (const row of [later, earlier, otherHolder]) await insert(office(), 'Certificate', row)
    const renew = (by: unknown) => run(office(), `UPDATE "Certificate" SET "successorId" = $2::uuid WHERE id = $1::uuid`, A.certificate, by)
    await expect(renew(A.certificate)).rejects.toThrow(/does not renew itself/)
    await expect(renew(earlier.id)).rejects.toThrow(/same holder, valid from a later day/)
    await expect(renew(otherHolder.id)).rejects.toThrow(/same holder, valid from a later day/)
    expect(await renew(later.id)).toBe(1)
    await expect(renew(otherHolder.id)).rejects.toThrow(/is set once, never changed/)
    // `later` renews one certificate only.
    const twin = certificate({ validFrom: '2025-06-01', validTo: '2028-12-31' })
    await insert(office(), 'Certificate', twin)
    await expect(run(office(), `UPDATE "Certificate" SET "successorId" = $2::uuid WHERE id = $1::uuid`, twin.id, later.id)).rejects.toThrow(/Certificate_tenantId_successorId_key|duplicate key/)
  })

  it('a type-change review moves OPEN → NOTIFIED → APPROVED, or OPEN → NOT_NEEDED with its reason, and is kept', async () => {
    const review = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), styleId: A.style, revisionId: A.revision, certificateId: A.certificate, changes: [], ...extra })
    await expect(insert(office(), 'TypeChangeReview', review({ status: 'NOTIFIED', notifiedAt: new Date().toISOString() }))).rejects.toThrow(/starts OPEN/)
    await expect(insert(office(), 'TypeChangeReview', review({ changes: {} }))).rejects.toThrow(/lists what changed/)
    await expect(insert(office(), 'TypeChangeReview', review({ comparedRevisionId: A.revision }))).rejects.toThrow(/against another revision/)
    const first = review()
    const second = review()
    await insert(office(), 'TypeChangeReview', first)
    await insert(office(), 'TypeChangeReview', second)
    const update = (id: string, set: string) => run(office(), `UPDATE "TypeChangeReview" SET ${set} WHERE id = $1::uuid`, id)
    await expect(update(first.id, `status = 'APPROVED'`)).rejects.toThrow(/cannot move from OPEN to APPROVED/)
    await expect(update(first.id, `status = 'NOTIFIED'`)).rejects.toThrow(/with the wrong times/)
    expect(await update(first.id, `status = 'NOTIFIED', "notifiedAt" = now()`)).toBe(1)
    await expect(update(first.id, `changes = '[{"kind":"SEAMS"}]'`)).rejects.toThrow(/fixed once it left OPEN/)
    await expect(update(first.id, `status = 'APPROVED', "decidedAt" = now()`)).rejects.toThrow(/with the wrong times/)
    expect(await update(first.id, `status = 'APPROVED', "answeredAt" = '2026-12-01', "answerReference" = 'ADD-1', "decidedAt" = now(), "decidedById" = '${a.actorId}'`)).toBe(1)
    await expect(update(first.id, `"answerReference" = 'ADD-2'`)).rejects.toThrow(/is APPROVED; it changes no more/)
    await expect(update(second.id, `status = 'NOT_NEEDED', "decidedAt" = now()`)).rejects.toThrow(/with the reason when not needed/)
    expect(await update(second.id, `status = 'NOT_NEEDED', "decidedAt" = now(), "decisionNote" = 'Same lining weight: no effect on the type'`)).toBe(1)
    await expect(admin('DELETE FROM "TypeChangeReview" WHERE id = $1', [first.id])).rejects.toThrow(/is kept, never deleted/)
    await expect(admin('TRUNCATE "TypeChangeReview"')).rejects.toThrow(/TRUNCATE on "TypeChangeReview" is refused/)
  })
})

// --- sources, discrepancies, claims -------------------------------------------------------------------------------

describe('sources, discrepancies and claims', () => {
  it('an approved source is archived, never deleted, and keeps its supplier, material and colour', async () => {
    await expect(run(office(), 'UPDATE "SupplierItem" SET "purchaseFactor" = 0 WHERE id = $1::uuid', seeded.supplierItemId)).rejects.toThrow(/a factor above 0/)
    await expect(run(office(), 'UPDATE "SupplierItem" SET "itemColourId" = NULL WHERE id = $1::uuid', seeded.supplierItemId)).rejects.toThrow(/never change \(another source is a new row\)/)
    expect(await run(office(), `UPDATE "SupplierItem" SET "unitPrice" = 4.35, status = 'ARCHIVED' WHERE id = $1::uuid`, seeded.supplierItemId)).toBe(1)
    await expect(admin('DELETE FROM "SupplierItem" WHERE id = $1', [seeded.supplierItemId])).rejects.toThrow(/archived, never deleted/)
  })

  it('a discrepancy is recorded on an open or posted receipt of its supplier, sent, agreed, credited and closed', async () => {
    const row = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), siteId: A.siteA, receiptId: seeded.inventory.receiptId, seq: 1_000 + Math.floor(Math.random() * 1_000_000), supplierId: A.P2, kind: 'SHORT', ...extra })
    await expect(insert(office(), 'ReceiptDiscrepancy', row({ supplierId: A.P1 }))).rejects.toThrow(/naming its supplier/)
    await expect(insert(office(), 'ReceiptDiscrepancy', row({ status: 'SENT' }))).rejects.toThrow(/starts OPEN/)
    await expect(insert(office(), 'ReceiptDiscrepancy', row({ receiptLineId: seeded.inventory.openReceiptLineId }))).rejects.toThrow(/names a line of its own goods receipt/)
    await expect(insert(office(), 'ReceiptDiscrepancy', row({ quantity: '2' }))).rejects.toThrow(/a quantity above 0 and its unit/)
    const mine = row({ quantity: '2', uom: 'FT2', receiptLineId: seeded.inventory.receiptLineId })
    await insert(office(), 'ReceiptDiscrepancy', mine)
    const update = (set: string) => run(office(), `UPDATE "ReceiptDiscrepancy" SET ${set} WHERE id = $1::uuid`, mine.id)
    await expect(update(`status = 'AGREED'`)).rejects.toThrow(/cannot move from OPEN to AGREED/)
    await expect(update(`status = 'SENT'`)).rejects.toThrow(/sent from SENT on/)
    expect(await update(`status = 'SENT', "sentAt" = now(), "sentById" = '${a.actorId}'`)).toBe(1)
    await expect(update(`quantity = 3`)).rejects.toThrow(/changes only while it is OPEN/)
    await expect(admin('DELETE FROM "ReceiptDiscrepancy" WHERE id = $1', [mine.id])).rejects.toThrow(/only an OPEN one \(never sent\) is removed/)
    expect(await update(`status = 'AGREED'`)).toBe(1)
    expect(await update(`status = 'CREDITED'`)).toBe(1)
    expect(await update(`status = 'CLOSED', "closedAt" = now(), "resolutionNote" = 'Credit note received'`)).toBe(1)
    await expect(update(`"resolutionNote" = 'x'`)).rejects.toThrow(/is CLOSED; it changes no more/)
    // An OPEN one is removed (recorded by mistake).
    const mistake = row()
    await insert(office(), 'ReceiptDiscrepancy', mistake)
    expect(await run(office(), 'DELETE FROM "ReceiptDiscrepancy" WHERE id = $1::uuid', mistake.id)).toBe(1)
  })

  it('a claim is prepared as DRAFT, sent with its remedy, answered, closed; its lines change only while DRAFT', async () => {
    const claimId = seeded.claimId
    const update = (set: string) => run(office(), `UPDATE "SupplierClaim" SET ${set} WHERE id = $1::uuid`, claimId)
    // A line of the claim: its move must be of its own item and lot (the opening lining move is not).
    const [opening] = await admin(`SELECT id FROM "StockMove" WHERE "tenantId" = $1 AND reason = 'OPENING' LIMIT 1`, [a.tenantId])
    await expect(run(office(), 'UPDATE "SupplierClaimLine" SET "moveId" = $2::uuid WHERE id = $1::uuid', seeded.claimLineId, opening!.id)).rejects.toThrow(/a stock move of its own item, lot and hide/)
    await expect(insert(office(), 'SupplierClaim', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, number: `T-CLM-${tag()}`, partyId: A.P1, kind: 'CLAIM', goodsReceiptId: seeded.inventory.receiptId, foundAt: 'RECEIPT', reason: 'x' })).rejects.toThrow(
      /names a goods receipt of its supplier/,
    )
    await expect(update(`status = 'SENT', "sentAt" = now(), remedy = NULL`)).rejects.toThrow(/a remedy from SENT on/)
    await expect(update(`status = 'ACCEPTED'`)).rejects.toThrow(/cannot move from DRAFT to ACCEPTED/)
    expect(await update(`status = 'SENT', "sentAt" = now(), "sentById" = '${a.actorId}'`)).toBe(1)
    await expect(update(`reason = 'Another reason'`)).rejects.toThrow(/fixed once it is sent/)
    await expect(run(office(), 'UPDATE "SupplierClaimLine" SET quantity = 5, "baseQuantity" = 5 WHERE id = $1::uuid', seeded.claimLineId)).rejects.toThrow(/changes only while it is DRAFT/)
    expect(await run(office(), 'UPDATE "SupplierClaimLine" SET "creditAmount" = 1800 WHERE id = $1::uuid', seeded.claimLineId)).toBe(1)
    await expect(run(office(), 'DELETE FROM "SupplierClaimLine" WHERE id = $1::uuid', seeded.claimLineId)).rejects.toThrow(/added and removed only while it is DRAFT/)
    await expect(update(`status = 'ACCEPTED'`)).rejects.toThrow(/answered when ACCEPTED or REJECTED/)
    expect(await update(`status = 'ACCEPTED', "answeredAt" = now(), "supplierAnswer" = 'Credit of 18.00 agreed', "expectedCreditAmount" = 1800`)).toBe(1)
    expect(await update(`status = 'CLOSED', "closedAt" = now(), "closeNote" = 'Credit note matched'`)).toBe(1)
    await expect(update(`"closeNote" = 'x'`)).rejects.toThrow(/only its internal note changes/)
    expect(await update(`"internalNote" = 'Settled'`)).toBe(1)
    await expect(run(office(), 'UPDATE "SupplierClaimLine" SET note = $2 WHERE id = $1::uuid', seeded.claimLineId, 'x')).rejects.toThrow(/its lines change no more/)
    await expect(admin('DELETE FROM "SupplierClaim" WHERE id = $1', [claimId])).rejects.toThrow(/cancelled or closed, never deleted/)
  })
})

// --- subcontracting ---------------------------------------------------------------------------------------------------

describe('subcontract orders', () => {
  it('send work to a SUBCONTRACTOR location of their workshop, are issued with operations adding up, then keep their terms', async () => {
    const orderId = sub.orderId
    const update = (set: string, ...values: unknown[]) => run(office(), `UPDATE "SubcontractOrder" SET ${set} WHERE id = $1::uuid`, orderId, ...values)
    await expect(update(`"locationId" = $2::uuid`, A.bin)).rejects.toThrow(/to a SUBCONTRACTOR location of its workshop/)
    await expect(update(`"partyId" = $2::uuid`, A.P1)).rejects.toThrow(/to a SUBCONTRACTOR location of its workshop|violates foreign key/)
    await expect(update(`status = 'AT_WORKSHOP'`)).rejects.toThrow(/cannot move from DRAFT to AT_WORKSHOP/)
    await expect(update(`status = 'ISSUED', "issuedAt" = now(), "netAmount" = 3000`)).rejects.toThrow(/is not the sum of its operations \(3150\)/)
    await expect(update(`status = 'ISSUED'`)).rejects.toThrow(/issued from ISSUED on/)
    // Operations: pieces per cell add up, counts start at 0.
    await expect(run(office(), `UPDATE "SubcontractOperation" SET pieces = 6 WHERE id = $1::uuid`, sub.operationId)).rejects.toThrow(/its sizes adding up to them/)
    expect(await update(`status = 'ISSUED', "issuedAt" = now(), "issuedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(`"workOrderId" = "workOrderId", "orderDate" = '2026-11-17'`)).rejects.toThrow(/its terms change only while it is DRAFT/)
    expect(await update(`"expectedBackDate" = '2026-11-28', note = 'Due two days later'`)).toBe(1)
    await expect(run(office(), `UPDATE "SubcontractOperation" SET "pricePerPiece" = 5 WHERE id = $1::uuid`, sub.operationId)).rejects.toThrow(/change only while it is DRAFT \(but for the pieces sent and back\)/)
    await expect(run(office(), `UPDATE "SubcontractOperation" SET "piecesSent" = 8 WHERE id = $1::uuid`, sub.operationId)).rejects.toThrow(/no more back than sent nor sent than pieces/)
    expect(await run(office(), `UPDATE "SubcontractOperation" SET "piecesSent" = 7 WHERE id = $1::uuid`, sub.operationId)).toBe(1)
    await expect(run(office(), `UPDATE "SubcontractOperation" SET "piecesBackGood" = 6, "piecesScrapped" = 2 WHERE id = $1::uuid`, sub.operationId)).rejects.toThrow(/no more back than sent/)
    await expect(admin('DELETE FROM "SubcontractOperation" WHERE id = $1', [sub.operationId])).rejects.toThrow(/added and removed only while it is DRAFT/)
    await expect(admin('DELETE FROM "SubcontractOrder" WHERE id = $1', [orderId])).rejects.toThrow(/is cancelled, never deleted/)
  })

  it('a kit line is SENT with the TRANSFER move that put its goods into the workshop’s location', async () => {
    const kitId = sub.kitLineId
    const transfer = async (extra: Record<string, unknown>) => {
      const moveId = randomUUID()
      await insert(office(), 'StockMove', {
        id: moveId,
        companyId: A.companyA,
        siteId: A.siteA,
        reason: 'TRANSFER',
        itemId: A.lining,
        itemColourId: A.liningGRY,
        lotId: A.liningLot,
        fromLocationId: A.bin,
        toLocationId: sub.locationId,
        quantity: '12.6',
        uom: 'M',
        baseQuantity: '12.6',
        idempotencyKey: `test-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        ...extra,
      })
      return moveId
    }
    const update = (set: string, ...values: unknown[]) => run(office(), `UPDATE "SubcontractKitLine" SET ${set} WHERE id = $1::uuid`, kitId, ...values)
    await expect(update(`status = 'SENT', "sentAt" = now()`)).rejects.toThrow(/its time, move and DDT exactly while SENT/)
    const short = await transfer({ quantity: '10', baseQuantity: '10' })
    await expect(update(`status = 'SENT', "sentAt" = now(), "lotId" = $2::uuid, "moveId" = $3::uuid`, A.liningLot, short)).rejects.toThrow(/names the TRANSFER move that put its goods/)
    const elsewhere = await transfer({ toLocationId: A.store })
    await expect(update(`status = 'SENT', "sentAt" = now(), "lotId" = $2::uuid, "moveId" = $3::uuid`, A.liningLot, elsewhere)).rejects.toThrow(/names the TRANSFER move/)
    const good = await transfer({})
    expect(await update(`status = 'SENT', "sentAt" = now(), "lotId" = $2::uuid, "moveId" = $3::uuid`, A.liningLot, good)).toBe(1)
    await expect(update(`quantity = 12, "baseQuantity" = 12`)).rejects.toThrow(/is SENT; the goods it sent are fixed/)
    await expect(admin('DELETE FROM "SubcontractKitLine" WHERE id = $1', [kitId])).rejects.toThrow(/only a PLANNED line is removed/)
    await expect(update(`status = 'CANCELLED', "sentAt" = NULL, "moveId" = NULL`)).rejects.toThrow(/cannot move from SENT to CANCELLED/)
    // Its stock is at the workshop and stays the company's (same site, no value change): both transfers that went in.
    const [{ onHand }] = (await admin(
      `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::text AS "onHand" FROM "StockMove" WHERE "tenantId" = $2 AND ("toLocationId" = $1 OR "fromLocationId" = $1)`,
      [sub.locationId, a.tenantId],
    )) as [{ onHand: string }]
    expect(Number(onHand)).toBe(22.6)
  })
})

// --- the seeds ------------------------------------------------------------------------------------------------------

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['SupplierItem', 'PurchaseOrderRevision', 'PurchaseOrderReminder', 'ReceiptDiscrepancy', 'SupplierClaim', 'SupplierClaimLine', 'SubcontractOrder', 'SubcontractOperation', 'SubcontractKitLine', 'TypeChangeReview']
    const counts = async () => {
      const found: number[] = []
      for (const table of tables) found.push(await count(`SELECT count(*) AS n FROM "${table}"`))
      return found
    }
    const before = await counts()
    await seedSourcing({ db: factory, namespace: 'w2a3-b' })
    await seedSubcontract({ db: factory, namespace: 'w2a3-b' })
    expect(await counts()).toEqual(before)
  })
})
