import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinks } from '../seed/links'
import { seed as seedPortalSupply, type PortalSupplySeed } from '../seed/portal-supply'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The supplier portal (W2b schema wave 22/22, B-W2b-158, …_portal_supply_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - grants: a supplier or workshop (portal or link session) reads and writes its own party's ship notices, lines, hides,
 *     progress reports, return notices and questionnaire answers, reads its own subcontract orders and kit lines without
 *     a fee, amount or internal note, never another party's; the floor reads the ship notices of its site; the
 *     questionnaire versions, operations and receipts stay the office's;
 *   - ship notices: a DRAFT of a sent or confirmed order, changed until received, deleted while DRAFT; numbered and sent by
 *     the office, RECEIVED exactly while a posted receipt names it, cancelled once; lines of the order's open lines in
 *     their unit; the packing list per hide; a goods receipt prefilled from a SENT notice of its own order;
 *   - purchase order lines: a substitute (another item) always waits for the buyer, written with the proposal while SENT;
 *   - subcontract orders: the workshop answers a job once (accepted, with another date and why, or declined); the office
 *     answers a proposed date once; back to DRAFT clears both; a partner session answers only;
 *   - kit lines: the workshop checks a SENT line once; cleared only back to PLANNED;
 *   - progress reports append-only; return notices announced once, received with a receipt of the order or cancelled;
 *   - the questionnaire fixed once published; an answer written once, reviewed once.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-158-a'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PortalSupplySeed

const key = (name: string): string => seedUuid(NS, name)
const first = (name: string): string => `00000000${key(name).slice(8)}`
const P1 = key('party:P1')
const P2 = key('party:P2')
const SITE = key('site:A1')
const PO2 = first('supply:PO2')
const PO2_LINE = first('supply:PO2:10')
const ITEM = { leather: key('product:item:leather'), lining: key('product:item:lining'), protector: key('product:item:protector') }
const SC1 = key('subcontract:SC-0001')
const SC1_KIT = key('subcontract:SC-0001:kit:10')
const R1 = key('inventory:receipt:R1')
const R2 = first('inventory:receipt:R2')
const OPENING_MOVE = first('inventory:move:opening:LIN-01')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: key('worker:A1:operator'), siteId: SITE })
const partner = (partyId: string = P2): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes`, as `scope` (only the columns it may write when `columns` is given). */
const copyRow = async (table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office(), columns?: readonly string[]) => {
  const [source] = await admin(`SELECT to_jsonb(r) AS row FROM "${table}" r WHERE r.id = $1::uuid`, [id])
  const list = columns ? columns.map((name) => `"${name}"`).join(', ') : '*'
  const target = columns ? `"${table}" (${list})` : `"${table}"`
  return run(scope, `INSERT INTO ${target} SELECT ${list} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify({ ...(source!.row as Record<string, unknown>), ...changes }))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const one = async (table: string, id: string): Promise<Record<string, unknown>> => (await admin(`SELECT * FROM "${table}" WHERE id = $1::uuid`, [id]))[0]!
/** Runs `text` as the owner with the triggers off: to put a row in a state the guards only reach through other modules. */
async function bypass(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** The columns a partner session may write on a table (no hidden column). */
const partnerColumns = (table: string): string[] => {
  const ownership = loadOwnership()
  const { model, ownership: entry } = classifiedModels(loadSchema(), ownership).find(({ model }) => model.table === table)!
  const hidden = new Set(entry.access.factory_partner_runtime?.hiddenColumns ?? [])
  return model.columns.filter((column) => !hidden.has(column))
}
/** A new DRAFT ship notice of P2 on PO1, as the supplier makes it, with one line of `quantity` ft² of the leather line. */
async function newNotice(): Promise<{ notice: string; line: string }> {
  const notice = randomUUID()
  const line = randomUUID()
  await copyRow('ShipNotice', seeded.shipNotices.draft, { id: notice, note: 'test' }, partner(), partnerColumns('ShipNotice'))
  await copyRow('ShipNoticeLine', seeded.shipNoticeLines.leather, { id: line, shipNoticeId: notice }, partner(), partnerColumns('ShipNoticeLine'))
  return { notice, line }
}

beforeAll(async () => {
  db = await migratedDatabase('portalsupplyw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  // The links seed: P2's PO_CONFIRM link (a link of the wrong purpose for a questionnaire answer).
  await seedLinks({ db: factory, namespace: NS })
  seeded = await seedPortalSupply({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the seven models: office, partner by party, the floor reads ship notices; the partner wall on the subcontract order', () => {
    const ownership = loadOwnership()
    const all = classifiedModels(loadSchema(), ownership)
    const models = all.filter(({ model }) => model.file === 'portal-supply.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'ShipNotice',
      'ShipNoticeHide',
      'ShipNoticeLine',
      'SubcontractProgressReport',
      'SubcontractReturnNotice',
      'SupplierQuestionnaire',
      'SupplierQuestionnaireResponse',
    ])
    const access = (name: string) => all.find(({ model }) => model.name === name)!.ownership.access
    for (const name of ['ShipNotice', 'ShipNoticeLine', 'ShipNoticeHide']) {
      expect(Object.keys(access(name)).sort(), name).toEqual(['factory_floor_runtime', 'factory_partner_runtime', 'factory_runtime'])
      expect(access(name).factory_floor_runtime).toMatchObject({ privileges: ['select'], scopedBy: ['site'] })
    }
    expect(Object.keys(access('SupplierQuestionnaire'))).toEqual(['factory_runtime'])
    expect(access('SubcontractOrder').factory_partner_runtime!.hiddenColumns).toEqual(expect.arrayContaining(['netAmount', 'internalNote', 'issuedById', 'proposedDateDecidedById']))
    expect(Object.keys(access('SubcontractOperation'))).toEqual(['factory_runtime'])
    expect(Object.keys(access('SubcontractReceipt'))).toEqual(['factory_runtime'])
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
  })

  it('seeds P2 as the app writes it, twice without a change', async () => {
    const counts = async () =>
      (
        await admin(`SELECT (SELECT count(*) FROM "ShipNotice")::int AS notices, (SELECT count(*) FROM "ShipNoticeHide")::int AS hides,
          (SELECT count(*) FROM "SubcontractProgressReport")::int AS reports, (SELECT count(*) FROM "SubcontractReturnNotice")::int AS backs,
          (SELECT count(*) FROM "SupplierQuestionnaireResponse")::int AS answers`)
      )[0]
    const before = await counts()
    expect(before).toEqual({ notices: 2, hides: 3, reports: 1, backs: 2, answers: 2 })
    await seedPortalSupply({ db: factory, namespace: NS })
    expect(await counts()).toEqual(before)
    expect(await one('ShipNotice', seeded.shipNotices.sent)).toMatchObject({ status: 'SENT', number: 'SEED-ASN-0001', createdById: null })
    expect(await one('SubcontractOrder', seeded.subcontractOrderId)).toMatchObject({ acceptedByName: 'Seed Workshop Desk', declinedAt: null })
    expect(await one('SubcontractReturnNotice', seeded.returnNotices.received)).toMatchObject({ status: 'RECEIVED', receiptId: seeded.subcontractReceiptId })
  })

  it('a supplier reads its own rows, never the office columns; another party reads none of them', async () => {
    expect(await sql(partner(), 'SELECT id FROM "ShipNotice"')).toHaveLength(2)
    expect(await sql(partner(), 'SELECT id FROM "ShipNoticeHide"')).toHaveLength(3)
    expect(await sql(partner(), 'SELECT id, "acceptedAt", status FROM "SubcontractOrder"')).toHaveLength(2)
    expect(await sql(partner(), 'SELECT id, status FROM "SubcontractKitLine"')).toHaveLength(1)
    expect(await sql(partner(), 'SELECT id, decision FROM "SupplierQuestionnaireResponse"')).toHaveLength(2)
    for (const table of ['ShipNotice', 'ShipNoticeLine', 'ShipNoticeHide', 'SubcontractProgressReport', 'SubcontractReturnNotice', 'SupplierQuestionnaireResponse', 'SubcontractOrder', 'SubcontractKitLine']) {
      expect(await sql(partner(P1), `SELECT id FROM "${table}"`), table).toEqual([])
    }
    await expect(sql(partner(), 'SELECT "internalNote" FROM "ShipNotice"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "netAmount" FROM "SubcontractOrder"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "reviewNote" FROM "SupplierQuestionnaireResponse"')).rejects.toThrow(DENIED)
    for (const table of ['SupplierQuestionnaire', 'SubcontractOperation', 'SubcontractReceipt', 'GoodsReceipt']) await expect(sql(partner(), `SELECT id FROM "${table}"`), table).rejects.toThrow(DENIED)
  })

  it('the floor reads the ship notices of its site, nothing else of the portal', async () => {
    expect(await sql(floor(), 'SELECT id, "internalNote" FROM "ShipNotice"')).toHaveLength(2)
    expect(await sql(floor(), 'SELECT id FROM "ShipNoticeHide"')).toHaveLength(3)
    for (const table of ['SubcontractProgressReport', 'SubcontractReturnNotice', 'SupplierQuestionnaire', 'SupplierQuestionnaireResponse']) await expect(sql(floor(), `SELECT id FROM "${table}"`), table).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "ShipNotice" SET note = 'x' WHERE id = $1::uuid`, seeded.shipNotices.sent)).rejects.toThrow(DENIED)
  })
})

describe('ship notices', () => {
  it('the supplier drafts a notice with a line and the packing list, changes it, and deletes the draft', async () => {
    const { notice, line } = await newNotice()
    const hide = randomUUID()
    await copyRow('ShipNoticeHide', seeded.shipNoticeHides[0]!, { id: hide, shipNoticeId: notice, shipNoticeLineId: line, hideNumber: 'T-001' }, partner(), partnerColumns('ShipNoticeHide'))
    expect(await update(partner(), 'ShipNoticeHide', hide, `area = 40.1, grade = 'B', version = version + 1`)).toBe(1)
    expect(await update(partner(), 'ShipNotice', notice, `carrier = 'Seed Courier', parcels = 3, version = version + 1`)).toBe(1)
    expect(await run(partner(), 'DELETE FROM "ShipNoticeHide" WHERE id = $1::uuid', hide)).toBe(1)
    expect(await run(partner(), 'DELETE FROM "ShipNoticeLine" WHERE id = $1::uuid', line)).toBe(1)
    expect(await run(partner(), 'DELETE FROM "ShipNotice" WHERE id = $1::uuid', notice)).toBe(1)
  })

  it('REFUSES a notice born sent or numbered, or of a draft order', async () => {
    const columns = partnerColumns('ShipNotice')
    await expect(copyRow('ShipNotice', seeded.shipNotices.draft, { id: randomUUID(), status: 'SENT', number: 'X-1', sentAt: '2026-11-06T10:00:00Z' }, partner(), columns)).rejects.toThrow(/starts as a DRAFT without a number/)
    await expect(copyRow('ShipNotice', seeded.shipNotices.draft, { id: randomUUID(), number: 'X-2' }, partner(), columns)).rejects.toThrow(/starts as a DRAFT without a number/)
    // P1's own order SEED-PO-0002 is a DRAFT: nothing of it can be announced.
    await expect(copyRow('ShipNotice', seeded.shipNotices.draft, { id: randomUUID(), partyId: P1, purchaseOrderId: PO2 }, partner(P1), columns)).rejects.toThrow(/SENT, CONFIRMED or PARTLY_RECEIVED purchase order \(DRAFT\)/)
  })

  it('REFUSES a line of another order, in another unit, or the received quantity from the supplier', async () => {
    const { notice, line } = await newNotice()
    const columns = partnerColumns('ShipNoticeLine')
    // P1's draft order line: the supplier cannot see it, so it is not a line of its notice's order.
    await expect(copyRow('ShipNoticeLine', line, { id: randomUUID(), seq: 20, purchaseOrderLineId: PO2_LINE }, partner(), columns)).rejects.toThrow(/an open line of its notice's purchase order/)
    await expect(copyRow('ShipNoticeLine', line, { id: randomUUID(), seq: 30, uom: 'M2' }, partner(), columns)).rejects.toThrow(/in that line's unit/)
    await expect(copyRow('ShipNoticeLine', line, { id: randomUUID(), seq: 40, quantity: 0 }, partner(), columns)).rejects.toThrow(/a quantity above 0/)
    await expect(update(partner(), 'ShipNoticeLine', line, '"receivedQuantity" = 5')).rejects.toThrow(/the office's, written while the notice is SENT/)
    // A DRAFT's line: not even the office writes what was received.
    await expect(update(office(), 'ShipNoticeLine', line, '"receivedQuantity" = 5')).rejects.toThrow(/written while the notice is SENT/)
    expect(await update(partner(), 'ShipNoticeLine', line, `quantity = 60, "dyeBatch" = '2232'`)).toBe(1)
    expect(await sql(partner(), 'SELECT id FROM "ShipNotice" WHERE id = $1::uuid', notice)).toHaveLength(1)
  })

  it('REFUSES a packing list hide with no area, a volume unit, a padded or repeated number, or a thickness of a metre', async () => {
    const { notice, line } = await newNotice()
    const columns = partnerColumns('ShipNoticeHide')
    const hide = (changes: Record<string, unknown>) => copyRow('ShipNoticeHide', seeded.shipNoticeHides[0]!, { id: randomUUID(), shipNoticeId: notice, shipNoticeLineId: line, ...changes }, partner(), columns)
    expect(await hide({ hideNumber: 'H-1' })).toBe(1)
    await expect(hide({ hideNumber: 'H-2', seq: 2, area: 0 })).rejects.toThrow(/an area above 0/)
    await expect(hide({ hideNumber: 'H-3', seq: 3, areaUom: 'M' })).rejects.toThrow(/in M2, DM2 or FT2/)
    await expect(hide({ hideNumber: ' H-4', seq: 4 })).rejects.toThrow(/trimmed/)
    await expect(hide({ hideNumber: 'H-5', seq: 5, thicknessMm: 1000 })).rejects.toThrow(/below 100 mm/)
    await expect(hide({ hideNumber: 'H-1', seq: 9 })).rejects.toThrow(/unique|ShipNoticeHide_tenantId_shipNoticeId_hideNumber_key/)
  })

  it('the office numbers and sends it; the supplier cannot send, number or receive it; a draft with no line is not sent', async () => {
    const { notice, line } = await newNotice()
    await expect(update(partner(), 'ShipNotice', notice, `status = 'SENT', number = 'X-9', "sentAt" = now()`)).rejects.toThrow(/the office numbers, sends and receives it/)
    await expect(update(office(), 'ShipNotice', notice, `status = 'SENT', "sentAt" = now()`)).rejects.toThrow(/a number, send time and ship date from SENT on/)
    await expect(update(office(), 'ShipNotice', notice, `status = 'SENT', number = 'ASN-T-1', "sentAt" = now(), "shipDate" = NULL`)).rejects.toThrow(/a number, send time and ship date from SENT on/)
    const empty = randomUUID()
    await copyRow('ShipNotice', seeded.shipNotices.draft, { id: empty }, partner(), partnerColumns('ShipNotice'))
    await expect(update(office(), 'ShipNotice', empty, `status = 'SENT', number = 'ASN-T-0', "sentAt" = now()`)).rejects.toThrow(/has no line; it cannot be sent/)
    expect(await update(office(), 'ShipNotice', notice, `status = 'SENT', number = 'ASN-T-2', "sentAt" = now(), version = version + 1`)).toBe(1)
    // Sent: the supplier still corrects it until received; the number stays.
    expect(await update(partner(), 'ShipNoticeLine', line, 'quantity = 118')).toBe(1)
    await expect(update(office(), 'ShipNotice', notice, `number = 'ASN-T-3'`)).rejects.toThrow(/gets its number and send time when it is sent/)
    await expect(update(office(), 'ShipNotice', notice, `status = 'DRAFT', number = NULL, "sentAt" = NULL`)).rejects.toThrow(/cannot move from SENT to DRAFT/)
    // What the receipt took is the office's, while SENT.
    expect(await update(office(), 'ShipNoticeLine', line, '"receivedQuantity" = 118')).toBe(1)
    // A sent notice is cancelled, never deleted (its line may still go while it is SENT).
    expect(await run(partner(), 'DELETE FROM "ShipNoticeLine" WHERE id = $1::uuid', line)).toBe(1)
    await expect(run(partner(), 'DELETE FROM "ShipNotice" WHERE id = $1::uuid', notice)).rejects.toThrow(/only a DRAFT is deleted/)
  })

  it('the supplier cancels a sent notice once, with its reason; then only the office note changes', async () => {
    const { notice } = await newNotice()
    await update(office(), 'ShipNotice', notice, `status = 'SENT', number = 'ASN-T-4', "sentAt" = now()`)
    await expect(update(partner(), 'ShipNotice', notice, `status = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/cancelled with its time and reason/)
    expect(await update(partner(), 'ShipNotice', notice, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Truck not available'`)).toBe(1)
    await expect(update(partner(), 'ShipNotice', notice, `note = 'again'`)).rejects.toThrow(/CANCELLED; only the office's note changes/)
    await expect(update(office(), 'ShipNotice', notice, `status = 'SENT', "cancelledAt" = NULL, "cancelReason" = NULL`)).rejects.toThrow(/cannot move from CANCELLED to SENT/)
    expect(await update(office(), 'ShipNotice', notice, `"internalNote" = 'Called the tannery'`)).toBe(1)
  })

  it('a goods receipt is prefilled from a sent notice of its own order; the notice is RECEIVED exactly while a posted receipt names it', async () => {
    const sent = seeded.shipNotices.sent
    await expect(update(office(), 'GoodsReceipt', R2, '"shipNoticeId" = $2::uuid', seeded.shipNotices.draft)).rejects.toThrow(/prefilled from a SENT \(or RECEIVED\) ship notice of its own purchase order/)
    expect(await update(office(), 'GoodsReceipt', R2, '"shipNoticeId" = $2::uuid', sent)).toBe(1)
    await expect(update(office(), 'GoodsReceipt', R2, '"purchaseOrderId" = NULL')).rejects.toThrow(/of its own purchase order/)
    await expect(update(office(), 'ShipNotice', sent, `status = 'RECEIVED', "receivedAt" = now()`)).rejects.toThrow(/RECEIVED exactly while a POSTED goods receipt names it \(0 do\)/)
    // The posted receipt SEED-GR-0001 of the same order and supplier (the stock ledger is the inventory seed's) names it.
    await bypass('UPDATE "GoodsReceipt" SET "shipNoticeId" = $2::uuid WHERE id = $1::uuid', [R1, sent])
    await expect(update(partner(), 'ShipNotice', sent, `status = 'RECEIVED', "receivedAt" = now()`)).rejects.toThrow(/the office numbers, sends and receives it/)
    expect(await update(office(), 'ShipNotice', sent, `status = 'RECEIVED', "receivedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(partner(), 'ShipNoticeLine', seeded.shipNoticeLines.leather, 'quantity = 100')).rejects.toThrow(/lines change only while it is DRAFT or SENT/)
    await expect(update(partner(), 'ShipNoticeHide', seeded.shipNoticeHides[1]!, `grade = 'B'`)).rejects.toThrow(/packing list changes only while it is DRAFT or SENT/)
    await expect(update(office(), 'ShipNotice', sent, `carrier = 'Other'`)).rejects.toThrow(/is RECEIVED; it changes no more/)
    await expect(update(office(), 'ShipNotice', sent, `status = 'SENT', "receivedAt" = NULL`)).rejects.toThrow(/\(1 do\)/)
    // The receipt reversed: back to SENT.
    await bypass(`UPDATE "GoodsReceipt" SET status = 'REVERSED', "reversedAt" = now(), "reversalReason" = 'test' WHERE id = $1::uuid`, [R1])
    expect(await update(office(), 'ShipNotice', sent, `status = 'SENT', "receivedAt" = NULL`)).toBe(1)
  })
})

describe('purchase order lines: a substitute waits for the buyer', () => {
  let order: string
  let line: string
  beforeAll(async () => {
    order = randomUUID()
    line = randomUUID()
    await copyRow('PurchaseOrder', PO2, { id: order, number: 'PO-T-158', partyId: P2, contactId: null, netAmount: 7000 })
    await copyRow('PurchaseOrderLine', PO2_LINE, { id: line, purchaseOrderId: order, partyId: P2 })
    await update(office(), 'PurchaseOrder', order, `status = 'SENT', "sentAt" = now()`)
  })

  it('REFUSES a new line born with a proposal', async () => {
    const draft = randomUUID()
    await copyRow('PurchaseOrder', PO2, { id: draft, number: 'PO-T-158-D', partyId: P2, contactId: null })
    await expect(copyRow('PurchaseOrderLine', PO2_LINE, { id: randomUUID(), purchaseOrderId: draft, partyId: P2, proposalNeedsBuyer: true })).rejects.toThrow(/is new; the supplier has not confirmed it yet/)
  })

  it('the supplier proposes a substitute that waits for the buyer; never its own item, never without the buyer', async () => {
    await expect(update(partner(), 'PurchaseOrderLine', line, '"proposedSubstituteItemId" = $2::uuid, "proposalNeedsBuyer" = true', ITEM.protector)).rejects.toThrow(/a substitute other than its own item/)
    await expect(update(partner(), 'PurchaseOrderLine', line, '"proposedSubstituteItemId" = $2::uuid', ITEM.lining)).rejects.toThrow(/always waits for the buyer/)
    await expect(update(partner(), 'PurchaseOrderLine', line, '"proposalNeedsBuyer" = true')).rejects.toThrow(/waits for the buyer only with a proposal/)
    await expect(update(partner(), 'PurchaseOrderLine', line, `"proposedSubstituteNote" = '  ', "proposalNeedsBuyer" = true`)).rejects.toThrow(/its words not blank/)
    expect(
      await update(partner(), 'PurchaseOrderLine', line, `"proposedSubstituteItemId" = $2::uuid, "proposedSubstituteNote" = 'Our article SEED-ART-301, same level', "proposalNeedsBuyer" = true, "proposedQuantity" = 10, "proposedDate" = '2026-12-04'`, ITEM.lining),
    ).toBe(1)
    // Not the price or the item themselves.
    await expect(update(partner(), 'PurchaseOrderLine', line, '"itemId" = $2::uuid', ITEM.lining)).rejects.toThrow(/its lines change only while it is DRAFT|only confirms the lines of its SENT purchase order/)
  })

  it('REFUSES a proposal on a confirmed order; recalled to DRAFT, the proposal is cleared', async () => {
    await update(office(), 'PurchaseOrder', order, `status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE'`)
    await expect(update(office(), 'PurchaseOrderLine', line, `"proposedSubstituteNote" = 'Another article'`)).rejects.toThrow(/written only while its order is SENT/)
    await update(office(), 'PurchaseOrder', order, `status = 'DRAFT', revision = revision + 1, "sentAt" = NULL, "confirmedAt" = NULL, "confirmedVia" = NULL`)
    expect(
      await update(office(), 'PurchaseOrderLine', line, `"proposedSubstituteItemId" = NULL, "proposedSubstituteNote" = NULL, "proposalNeedsBuyer" = false, "proposedQuantity" = NULL, "proposedDate" = NULL`),
    ).toBe(1)
  })
})

describe('subcontract orders: the workshop answers the job', () => {
  beforeAll(async () => {
    await update(office(), 'SubcontractOrder', SC1, `status = 'ISSUED', "issuedAt" = now()`)
  })

  it('a partner session answers only, once; never the dates, the status or the office answer', async () => {
    await expect(update(partner(), 'SubcontractOrder', SC1, `"expectedBackDate" = '2026-12-30'`)).rejects.toThrow(/a partner session only answers its job/)
    await expect(update(partner(), 'SubcontractOrder', SC1, `status = 'AT_WORKSHOP'`)).rejects.toThrow(/a partner session only answers its job/)
    await expect(update(partner(), 'SubcontractOrder', SC1, `"acceptedAt" = now(), "proposedDate" = '2026-11-30'`)).rejects.toThrow(/a proposed date only with its reason/)
    await expect(update(partner(), 'SubcontractOrder', SC1, `"acceptedAt" = now(), "declinedAt" = now(), "declineReason" = 'x'`)).rejects.toThrow(/never both/)
    expect(await update(partner(), 'SubcontractOrder', SC1, `"acceptedAt" = now(), "acceptedByName" = 'Seed Workshop Desk', "proposedDate" = '2026-11-30', "proposedDateReason" = 'Busy with another brand', version = version + 1`)).toBe(1)
    await expect(update(partner(), 'SubcontractOrder', SC1, `"acceptedByName" = 'Somebody else'`)).rejects.toThrow(/answers subcontract order .* once/)
    await expect(update(partner(), 'SubcontractOrder', SC1, `"proposedDateDecision" = 'ACCEPTED', "proposedDateDecidedAt" = now()`)).rejects.toThrow(/a partner session only answers its job/)
    // The seed's SEED-SC-0002 was accepted already.
    await expect(update(partner(), 'SubcontractOrder', seeded.subcontractOrderId, `"declinedAt" = now(), "declineReason" = 'No'`)).rejects.toThrow(/answers subcontract order .* once/)
  })

  it('the office answers the proposed date once: ACCEPTED makes it the expected-back date', async () => {
    await expect(update(office(), 'SubcontractOrder', SC1, `"proposedDateDecision" = 'ACCEPTED', "proposedDateDecidedAt" = now()`)).rejects.toThrow(/ACCEPTED makes it the expected-back date/)
    expect(await update(office(), 'SubcontractOrder', SC1, `"proposedDateDecision" = 'ACCEPTED', "proposedDateDecidedAt" = now(), "proposedDateDecidedById" = $2::uuid, "expectedBackDate" = '2026-11-30'`, a.actorId)).toBe(1)
    await expect(update(office(), 'SubcontractOrder', SC1, `"proposedDateDecision" = 'REFUSED'`)).rejects.toThrow(/answers the date the workshop proposed .* once/)
  })

  it('back to DRAFT clears both answers; issued again, the workshop declines; then no progress or return', async () => {
    expect(await update(office(), 'SubcontractOrder', SC1, `status = 'DRAFT', "issuedAt" = NULL`)).toBe(1)
    expect(await one('SubcontractOrder', SC1)).toMatchObject({ acceptedAt: null, acceptedByName: null, proposedDate: null, proposedDateDecision: null, proposedDateDecidedById: null })
    await expect(update(office(), 'SubcontractOrder', SC1, `"acceptedAt" = now()`)).rejects.toThrow(/never while DRAFT/)
    await update(office(), 'SubcontractOrder', SC1, `status = 'ISSUED', "issuedAt" = now()`)
    await expect(update(partner(), 'SubcontractOrder', SC1, `"declinedAt" = now()`)).rejects.toThrow(/declined \(with its reason\)/)
    expect(await update(partner(), 'SubcontractOrder', SC1, `"declinedAt" = now(), "declineReason" = 'No capacity this month', "declinedByName" = 'Seed Workshop Desk'`)).toBe(1)
    await expect(
      copyRow('SubcontractProgressReport', seeded.progressReportId, { id: randomUUID(), subcontractOrderId: SC1, subcontractOperationId: key('subcontract:SC-0001:op:10'), bundleId: null, workOrderSizeId: null }, partner(), partnerColumns('SubcontractProgressReport')),
    ).rejects.toThrow(/out \(ISSUED, AT_WORKSHOP or PARTLY_RECEIVED\) and not declined/)
  })
})

describe('kit lines: the workshop checks what came', () => {
  it('REFUSES a check of a line not sent; checks a sent one once; cleared only back to PLANNED', async () => {
    await expect(update(partner(), 'SubcontractKitLine', SC1_KIT, `"receivedByWorkshopAt" = now(), "receivedByWorkshopQuantity" = 12.6`)).rejects.toThrow(/while it is SENT|only while SENT/)
    await bypass(`UPDATE "SubcontractKitLine" SET status = 'SENT', "sentAt" = now() - interval '1 day', "moveId" = $2::uuid WHERE id = $1::uuid`, [SC1_KIT, OPENING_MOVE])
    await expect(update(partner(), 'SubcontractKitLine', SC1_KIT, `"receivedByWorkshopAt" = now()`)).rejects.toThrow(/when and how much/)
    await expect(update(partner(), 'SubcontractKitLine', SC1_KIT, `"receivedByWorkshopAt" = now() - interval '2 days', "receivedByWorkshopQuantity" = 12.6`)).rejects.toThrow(/not before it was sent/)
    await expect(update(partner(), 'SubcontractKitLine', SC1_KIT, `note = 'mine'`)).rejects.toThrow(/only checks the kit it received/)
    expect(await update(partner(), 'SubcontractKitLine', SC1_KIT, `"receivedByWorkshopAt" = now(), "receivedByWorkshopQuantity" = 12, "receivedByWorkshopNote" = '0.6 m missing', version = version + 1`)).toBe(1)
    await expect(update(partner(), 'SubcontractKitLine', SC1_KIT, `"receivedByWorkshopQuantity" = 12.6`)).rejects.toThrow(/checks kit line .* once/)
    await expect(update(office(), 'SubcontractKitLine', SC1_KIT, `status = 'PLANNED', "sentAt" = NULL, "moveId" = NULL`)).rejects.toThrow(/only while SENT/)
    expect(await update(office(), 'SubcontractKitLine', SC1_KIT, `status = 'PLANNED', "sentAt" = NULL, "moveId" = NULL, "receivedByWorkshopAt" = NULL, "receivedByWorkshopQuantity" = NULL, "receivedByWorkshopNote" = NULL`)).toBe(1)
  })
})

describe('progress reports and return notices', () => {
  it('the workshop reports finished pieces; nobody changes or removes a report, the owner included', async () => {
    const report = randomUUID()
    expect(await copyRow('SubcontractProgressReport', seeded.progressReportId, { id: report, finishedQuantity: 1, note: null }, partner(), partnerColumns('SubcontractProgressReport'))).toBe(1)
    await expect(copyRow('SubcontractProgressReport', seeded.progressReportId, { id: randomUUID(), finishedQuantity: 0 }, partner(), partnerColumns('SubcontractProgressReport'))).rejects.toThrow(/1 to 100000 finished pieces/)
    await expect(copyRow('SubcontractProgressReport', seeded.progressReportId, { id: randomUUID(), reportedByName: ' ' }, partner(), partnerColumns('SubcontractProgressReport'))).rejects.toThrow(/who reported it/)
    await expect(copyRow('SubcontractProgressReport', seeded.progressReportId, { id: randomUUID(), partyId: P1 }, partner(P1), partnerColumns('SubcontractProgressReport'))).rejects.toThrow(/foreign key|violates/)
    await expect(update(office(), 'SubcontractProgressReport', report, 'note = $2', 'x')).rejects.toThrow(DENIED)
    await expect(admin('UPDATE "SubcontractProgressReport" SET note = $2 WHERE id = $1::uuid', [report, 'x'])).rejects.toThrow(/append-only: UPDATE/)
    await expect(admin('DELETE FROM "SubcontractProgressReport" WHERE id = $1::uuid', [report])).rejects.toThrow(/append-only: DELETE/)
    await expect(admin('TRUNCATE "SubcontractProgressReport"')).rejects.toThrow(/append-only: TRUNCATE/)
  })

  it('the workshop announces a return once; the office receives it with a receipt of the order or cancels it', async () => {
    const columns = partnerColumns('SubcontractReturnNotice')
    const op = seeded.subcontractOperationId
    const back = (changes: Record<string, unknown>) => copyRow('SubcontractReturnNotice', seeded.returnNotices.announced, { id: randomUUID(), ...changes }, partner(), columns)
    await expect(back({ seq: 3, quantities: [{ subcontractOperationId: op, finished: 0, scrapped: 0 }] })).rejects.toThrow(/at least one piece/)
    await expect(back({ seq: 4, quantities: [{ subcontractOperationId: op, finished: 0, scrapped: 1 }] })).rejects.toThrow(/with a reason code for scrapped ones/)
    await expect(back({ seq: 5, quantities: [{ subcontractOperationId: op, finished: 1.5, scrapped: 0 }] })).rejects.toThrow(/whole finished and scrapped pieces/)
    await expect(back({ seq: 6, materialBack: [{ kitLineId: SC1_KIT, quantity: '1.0000' }] })).rejects.toThrow(/a line of its own order/)
    await expect(back({ seq: 7, parcels: 0 })).rejects.toThrow(/1 to 9999 parcels/)
    const notice = randomUUID()
    expect(await copyRow('SubcontractReturnNotice', seeded.returnNotices.announced, { id: notice, seq: 8, quantities: [{ subcontractOperationId: op, bundleId: null, finished: 0, scrapped: 1, reasonCode: 'STAIN' }] }, partner(), columns)).toBe(1)
    await expect(update(partner(), 'SubcontractReturnNotice', notice, `status = 'CANCELLED'`)).rejects.toThrow(DENIED)
    await expect(update(office(), 'SubcontractReturnNotice', notice, 'parcels = 2')).rejects.toThrow(/what the workshop announced in return notice .* never changes/)
    await expect(update(office(), 'SubcontractReturnNotice', notice, `status = 'RECEIVED', "receivedAt" = now()`)).rejects.toThrow(/received with its receipt and time/)
    await expect(update(office(), 'SubcontractReturnNotice', notice, `status = 'RECEIVED', "receivedAt" = now(), "receiptId" = $2::uuid`, randomUUID())).rejects.toThrow(/foreign key/)
    expect(await update(office(), 'SubcontractReturnNotice', notice, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Announced twice'`)).toBe(1)
    await expect(update(office(), 'SubcontractReturnNotice', notice, `status = 'RECEIVED', "receivedAt" = now(), "receiptId" = $2::uuid, "cancelledAt" = NULL, "cancelReason" = NULL`, seeded.subcontractReceiptId)).rejects.toThrow(/is CANCELLED; it is received or cancelled once/)
    await expect(admin('DELETE FROM "SubcontractReturnNotice" WHERE id = $1::uuid', [notice])).rejects.toThrow(/cancelled, never deleted/)
  })
})

describe('the supplier questionnaire', () => {
  it('a version changes until published, then it is fixed and kept; its keys are unique', async () => {
    const version = randomUUID()
    await copyRow('SupplierQuestionnaire', seeded.questionnaireId, { id: version, revision: 2, publishedAt: null, publishedById: null })
    expect(await update(office(), 'SupplierQuestionnaire', version, `title = 'Due diligence 2027'`)).toBe(1)
    await expect(update(office(), 'SupplierQuestionnaire', version, `questions = '[{"key":"a"},{"key":"a"}]'::jsonb`)).rejects.toThrow(/its own key/)
    await expect(update(office(), 'SupplierQuestionnaire', version, `questions = '[]'::jsonb`)).rejects.toThrow(/a list of questions/)
    expect(await update(office(), 'SupplierQuestionnaire', version, `"publishedAt" = now(), "publishedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(office(), 'SupplierQuestionnaire', version, `title = 'Changed'`)).rejects.toThrow(/is published; it is fixed/)
    await expect(run(office(), 'DELETE FROM "SupplierQuestionnaire" WHERE id = $1::uuid', version)).rejects.toThrow(/was published; it is kept/)
    const draft = randomUUID()
    await copyRow('SupplierQuestionnaire', seeded.questionnaireId, { id: draft, revision: 3, publishedAt: null, publishedById: null })
    expect(await run(office(), 'DELETE FROM "SupplierQuestionnaire" WHERE id = $1::uuid', draft)).toBe(1)
  })

  it('the supplier answers once (through a SUPPLIER_ONBOARD link only), never changes it; the buyer reviews it once', async () => {
    const columns = partnerColumns('SupplierQuestionnaireResponse')
    const answer = (changes: Record<string, unknown>) => copyRow('SupplierQuestionnaireResponse', seeded.answers.open, { id: randomUUID(), ...changes }, partner(), columns)
    const [link] = await admin(`SELECT id FROM "OneOffLink" WHERE "partyId" = $1::uuid AND purpose = 'PO_CONFIRM' LIMIT 1`, [P2])
    await expect(answer({ linkId: link!.id })).rejects.toThrow(/through a SUPPLIER_ONBOARD link of its party/)
    await expect(answer({ sites: [{ name: 'Somewhere' }] })).rejects.toThrow(/a two-letter country/)
    await expect(answer({ signedName: '' })).rejects.toThrow(/who signed it/)
    await expect(answer({ answers: [] })).rejects.toThrow(/holds its answers/)
    const mine = randomUUID()
    expect(await copyRow('SupplierQuestionnaireResponse', seeded.answers.open, { id: mine }, partner(), columns)).toBe(1)
    await expect(update(partner(), 'SupplierQuestionnaireResponse', mine, `"signedRole" = 'Owner'`)).rejects.toThrow(DENIED)
    await expect(update(office(), 'SupplierQuestionnaireResponse', mine, `"signedRole" = 'Owner'`)).rejects.toThrow(/never changes \(asked again, it answers again\)/)
    await expect(update(office(), 'SupplierQuestionnaireResponse', mine, `decision = 'ACCEPTED'`)).rejects.toThrow(/a review with its time/)
    expect(await update(office(), 'SupplierQuestionnaireResponse', mine, `decision = 'ACCEPTED', "reviewedAt" = now(), "reviewedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(office(), 'SupplierQuestionnaireResponse', mine, `decision = 'QUESTIONS'`)).rejects.toThrow(/reviewed once/)
    expect((await sql(partner(), 'SELECT decision, "reviewedAt" FROM "SupplierQuestionnaireResponse" WHERE id = $1::uuid', mine))[0]).toMatchObject({ decision: 'ACCEPTED' })
    // An unpublished version is never answered (the office's check; the API offers published versions only).
    const draft = randomUUID()
    await copyRow('SupplierQuestionnaire', seeded.questionnaireId, { id: draft, revision: 4, publishedAt: null, publishedById: null })
    await expect(copyRow('SupplierQuestionnaireResponse', seeded.answers.open, { id: randomUUID(), questionnaireId: draft })).rejects.toThrow(/answers a published version/)
  })

  it('REFUSES TRUNCATE of the new tables for every login (those no other table references)', async () => {
    for (const table of ['ShipNoticeHide', 'SubcontractReturnNotice', 'SupplierQuestionnaireResponse']) {
      await expect(admin(`TRUNCATE "${table}"`), table).rejects.toThrow(/portal supply: TRUNCATE on/)
    }
  })
})
