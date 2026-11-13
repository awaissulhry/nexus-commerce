import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCustoms, SEED_EORI_A, SEED_MRN, type CustomsSeed } from '../seed/customs'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Delivery, returns and customs (W2b-6, schema wave 51/57, B-W2b-372, …_delivery_customs_w2b_guards) on a database built from
 * the migrations and seeded twice, through the real login and the scoped client:
 *   - tracking problems (raised on a shipment that left, one open per shipment and kind, their task named once, resolved once
 *     and then frozen, the office's only);
 *   - return labels (offered by a RETURN_LABEL link of the RMA or booked at once, the booking and the label together, used or
 *     cancelled, read by the customer's own portal or link session);
 *   - customs declarations (the pack sent, the MRN once filed, the exit with its proof against an issued invoice once the goods
 *     left, removed only while the pack is merely sent) and the broker's pack by link only while the site switched it on;
 *   - the proof of delivery of a delivered shipment, an order DELIVERED from SHIPPED with its time, the EORI and the commercial
 *     invoice, CN22 and CN23 documents.
 * The refusals are check_violation (23514) in words, or a unique key (23505); their messages are read through raw SQL.
 */

const NS = 'w2b-372-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: CustomsSeed

const key = (name: string): string => seedUuid(NS, name)
const SITE_A1 = key('site:A1')
const COMPANY_A = key('company:A')
const P1 = key('party:P1')
const P2 = key('party:P2')
const ORDER_SO_0002 = key('production:sales-order:SO-0002')
const INSPECTED_RMA = key('returns:RMA-0002')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: SITE_A1 })
const partner = (party = P1): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: party })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(text, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const one = async (table: string, id: string) => (await admin(`SELECT * FROM "${table}" WHERE id = $1::uuid`, [id]))[0]!
/** A file of `recordType` `recordId` (a copy of the seeded label's file). */
async function fileOf(recordType: string, recordId: string): Promise<string> {
  const fileId = randomUUID()
  expect(await copyRow(office(), 'StoredFile', s.labelFileId, { id: fileId, recordType, recordId, storageKey: `test/${fileId}` })).toBe(1)
  return fileId
}
/** A one-off link (a copy of the seeded RETURN_LABEL link) with `changes`. */
const newLink = (changes: Record<string, unknown>) =>
  copyRow(office(), 'OneOffLink', s.linkId, { id: randomUUID(), tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), ...changes })

beforeAll(async () => {
  db = await migratedDatabase('customsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedCustoms({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedCustoms({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('tracking problems (LOG-063)', () => {
  const raise = (changes: Record<string, unknown>) => copyRow(office(), 'TrackingException', s.trackingIds.resolved, { id: randomUUID(), resolvedAt: null, taskId: null, raisedAt: new Date().toISOString(), ...changes })

  it('are raised on a shipment that left, one open per shipment and kind', async () => {
    await expect(raise({ shipmentId: s.draftShipmentId })).rejects.toThrow(/a tracking problem is raised only once it left/)
    await expect(raise({ kind: 'DELAYED' })).rejects.toThrow(/TrackingException_one_open/)
    await expect(raise({ kind: 'ADDRESS_PROBLEM', raisedAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow(/raised in the future/)
    await expect(raise({ kind: 'ADDRESS_PROBLEM', resolvedAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(/resolved after it was raised/)
    const open = randomUUID()
    expect(await raise({ id: open, kind: 'ADDRESS_PROBLEM' })).toBe(1)
    // Its task: a task of its shipment, named once.
    const otherTask = randomUUID()
    expect(await copyRow(office(), 'Task', s.taskId, { id: otherTask, recordType: 'ReturnAuthorisation', recordId: s.returnId })).toBe(1)
    await expect(update(office(), 'TrackingException', open, `"taskId" = $2::uuid`, otherTask)).rejects.toThrow(/worked in a task of its shipment/)
    const task = randomUUID()
    expect(await copyRow(office(), 'Task', s.taskId, { id: task })).toBe(1)
    expect(await update(office(), 'TrackingException', open, `"taskId" = $2::uuid, version = version + 1`, task)).toBe(1)
    await expect(update(office(), 'TrackingException', open, `"taskId" = $2::uuid`, s.taskId)).rejects.toThrow(/names its task once/)
    await expect(update(office(), 'TrackingException', open, `kind = 'NO_SCAN'`)).rejects.toThrow(/shipment, kind, raise time and creation of tracking problem .* never change/)
    // Resolved once, then frozen; the same kind may be raised again.
    expect(await update(office(), 'TrackingException', open, `"resolvedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'TrackingException', open, `"resolvedAt" = now() - interval '1 minute'`)).rejects.toThrow(/was resolved at .* it never changes/)
    expect(await raise({ kind: 'ADDRESS_PROBLEM' })).toBe(1)
    await expect(admin(`DELETE FROM "TrackingException" WHERE id = $1::uuid`, [open])).rejects.toThrow(/kept, never deleted/)
    await expect(admin(`TRUNCATE "TrackingException"`)).rejects.toThrow(/TRUNCATE on "TrackingException" is refused/)
  })

  it("are the office's only", async () => {
    expect((await sql(office(), `SELECT kind FROM "TrackingException" WHERE id = $1::uuid`, s.trackingIds.open))[0]).toEqual({ kind: 'DELAYED' })
    await expect(sql(floor(), `SELECT id FROM "TrackingException" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT id FROM "TrackingException" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})

describe('return labels (LOG-112)', () => {
  const newLabel = (changes: Record<string, unknown>) => copyRow(office(), 'ReturnLabel', s.labelIds.offered, { id: randomUUID(), ...changes })

  it('are made offered by a RETURN_LABEL link of the RMA, or booked at once, while the goods may come back', async () => {
    await expect(newLabel({ status: 'BOOKED' })).rejects.toThrow(/made OFFERED with its link, or BOOKED without one/)
    await expect(newLabel({ status: 'OFFERED', linkId: null })).rejects.toThrow(/made OFFERED with its link, or BOOKED without one/)
    await expect(newLabel({ status: 'USED', linkId: null, usedAt: new Date().toISOString() })).rejects.toThrow(/made OFFERED with its link, or BOOKED without one/)
    await expect(newLabel({ carrierCode: 'two words' })).rejects.toThrow(/code of 1 to 40 characters without spaces/)
    // A link of another purpose, or one revoked, offers nothing.
    const viewLink = randomUUID()
    expect(await newLink({ id: viewLink, purpose: 'DOCUMENT_VIEW' })).toBe(1)
    await expect(newLabel({ linkId: viewLink })).rejects.toThrow(/offered by a RETURN_LABEL link of its return/)
    // The inspected RMA takes no new label (FK holds its site and party: P1, A1).
    await expect(newLabel({ returnId: INSPECTED_RMA, linkId: null, status: 'BOOKED', bookingReference: 'T-1', labelFileId: await fileOf('ReturnAuthorisation', INSPECTED_RMA) })).rejects.toThrow(
      /a return label is made and booked only while the goods may come back/,
    )
    // Booked at once: the booking reference and a file of the RMA, together.
    await expect(newLabel({ linkId: null, status: 'BOOKED', bookingReference: 'T-2' })).rejects.toThrow(/booking reference .* and the label come together/)
    await expect(newLabel({ linkId: null, status: 'BOOKED', bookingReference: 'T-2', labelFileId: await fileOf('Shipment', s.shippedShipmentId) })).rejects.toThrow(/a file of its return/)
    expect(await newLabel({ linkId: null, status: 'BOOKED', bookingReference: 'T-2', labelFileId: await fileOf('ReturnAuthorisation', s.returnId) })).toBe(1)
  })

  it('move OFFERED → BOOKED → USED (or CANCELLED), the booking set once, then frozen', async () => {
    const label = randomUUID()
    expect(await newLabel({ id: label })).toBe(1)
    await expect(update(office(), 'ReturnLabel', label, `status = 'BOOKED'`)).rejects.toThrow(/booking reference .* and the label come together/)
    await expect(update(office(), 'ReturnLabel', label, `"bookingReference" = 'T-3', "labelFileId" = $2::uuid`, await fileOf('ReturnAuthorisation', s.returnId))).rejects.toThrow(/wrong booking/)
    expect(await update(office(), 'ReturnLabel', label, `status = 'BOOKED', "bookingReference" = 'T-3', "labelFileId" = $2::uuid, version = version + 1`, await fileOf('ReturnAuthorisation', s.returnId))).toBe(1)
    await expect(update(office(), 'ReturnLabel', label, `"bookingReference" = 'T-4'`)).rejects.toThrow(/set once/)
    await expect(update(office(), 'ReturnLabel', label, `status = 'OFFERED', "bookingReference" = NULL, "labelFileId" = NULL`)).rejects.toThrow(/cannot move from BOOKED to OFFERED/)
    await expect(update(office(), 'ReturnLabel', label, `"linkId" = NULL`)).rejects.toThrow(/return, carrier, link and creation of return label .* never change/)
    await expect(update(office(), 'ReturnLabel', label, `status = 'USED'`)).rejects.toThrow(/exactly when USED/)
    await expect(update(office(), 'ReturnLabel', label, `status = 'USED', "usedAt" = now() + interval '1 day'`)).rejects.toThrow(/not in the future/)
    expect(await update(office(), 'ReturnLabel', label, `status = 'USED', "usedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'ReturnLabel', label, `status = 'CANCELLED', "usedAt" = NULL`)).rejects.toThrow(/is USED; it never changes/)
    expect(await update(office(), 'ReturnLabel', s.labelIds.offered, `version = version`)).toBe(1)
    await expect(admin(`DELETE FROM "ReturnLabel" WHERE id = $1::uuid`, [label])).rejects.toThrow(/kept, never deleted/)
    await expect(admin(`TRUNCATE "ReturnLabel"`)).rejects.toThrow(/TRUNCATE on "ReturnLabel" is refused/)
  })

  it("are read by the customer's own session, never who made them; the floor reads none", async () => {
    const rows = await sql(partner(), `SELECT status::text, "bookingReference" FROM "ReturnLabel" WHERE "returnId" = $1::uuid AND id IN ($2::uuid, $3::uuid) ORDER BY id`, s.returnId, s.labelIds.offered, s.labelIds.used)
    expect(rows).toEqual([
      { status: 'OFFERED', bookingReference: null },
      { status: 'USED', bookingReference: 'SEED-RL-0001' },
    ])
    expect(await sql(partner(P2), `SELECT id FROM "ReturnLabel"`)).toEqual([])
    await expect(sql(partner(), `SELECT "createdById" FROM "ReturnLabel" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT id FROM "ReturnLabel" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('are offered by a RETURN_LABEL link of an open RMA of its company and customer only', async () => {
    await expect(newLink({ recordType: 'Shipment', recordId: s.shippedShipmentId })).rejects.toThrow(/a RETURN_LABEL link opens a ReturnAuthorisation, not a Shipment/)
    await expect(newLink({ recordId: INSPECTED_RMA })).rejects.toThrow(/is INSPECTED; a return label is offered only while the goods may come back/)
    await expect(newLink({ partyId: P2 })).rejects.toThrow(/goes to the customer of return/)
    expect(await newLink({})).toBe(1)
  })
})

describe('customs declarations (LOG-088, LOG-089) and the broker pack (LOG-097)', () => {
  const declare = (changes: Record<string, unknown>) => copyRow(office(), 'CustomsDeclaration', s.declarationIds.packSent, { id: randomUUID(), shipmentId: s.shippedShipmentId, ...changes })

  beforeAll(async () => {
    // The seed's SH-0001 leaves on 24 November; here it left at the start of the month, so its exit can be confirmed today.
    await force(`UPDATE "Shipment" SET "shippedAt" = '2026-11-01T08:00:00.000Z', "packedAt" = '2026-10-31T08:00:00.000Z' WHERE id = $1::uuid`, [s.shippedShipmentId])
  })

  it('start with the pack sent, for a shipment that is not cancelled', async () => {
    await expect(declare({ status: 'FILED', mrn: SEED_MRN })).rejects.toThrow(/starts with its pack sent \(PACK_SENT\), not FILED/)
    const cancelled = randomUUID()
    expect(await copyRow(office(), 'Shipment', s.draftShipmentId, { id: cancelled, number: `SH-T-${cancelled.slice(0, 8)}`, version: 1 })).toBe(1)
    expect(await update(office(), 'Shipment', cancelled, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'test', version = version + 1`)).toBe(1)
    await expect(declare({ shipmentId: cancelled })).rejects.toThrow(/is CANCELLED; no customs declaration is made for it/)
    await expect(declare({ alertAfterDays: 0 })).rejects.toThrow(/alert after 1 to 365 days/)
  })

  it('are FILED with their MRN, set once, never back', async () => {
    const declaration = randomUUID()
    expect(await declare({ id: declaration, brokerPartyId: s.brokerPartyId })).toBe(1)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'FILED'`)).rejects.toThrow(/from FILED on it has its MRN/)
    await expect(update(office(), 'CustomsDeclaration', declaration, `mrn = $2`, SEED_MRN)).rejects.toThrow(/from FILED on it has its MRN/)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'FILED', mrn = '26itseed0000000001'`)).rejects.toThrow(/two digits, two capitals, 14 capitals or digits/)
    expect(await update(office(), 'CustomsDeclaration', declaration, `status = 'FILED', mrn = $2, version = version + 1`, SEED_MRN)).toBe(1)
    await expect(update(office(), 'CustomsDeclaration', declaration, `mrn = '26ITSEED0000000002'`)).rejects.toThrow(/MRN and the invoice of customs declaration .* are set once/)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'PACK_SENT', mrn = NULL`)).rejects.toThrow(/cannot move from FILED back to PACK_SENT/)
    await expect(update(office(), 'CustomsDeclaration', declaration, `"brokerPartyId" = NULL`)).rejects.toThrow(/shipment, broker and creation of customs declaration .* never change/)
    await expect(admin(`DELETE FROM "CustomsDeclaration" WHERE id = $1::uuid`, [declaration])).rejects.toThrow(/is FILED; it is kept/)
  })

  it('are EXITED with the proof, against an issued invoice, once the goods left; then frozen', async () => {
    const declaration = randomUUID()
    expect(await declare({ id: declaration })).toBe(1)
    expect(await update(office(), 'CustomsDeclaration', declaration, `status = 'FILED', mrn = $2, version = version + 1`, SEED_MRN)).toBe(1)
    const proof = await fileOf('CustomsDeclaration', declaration)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'EXITED', "exitConfirmedAt" = now()`)).rejects.toThrow(/exit confirmed \(when, not in the future, and its proof\) exactly when EXITED/)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'EXITED', "exitConfirmedAt" = now(), "exitFileId" = $2::uuid`, proof)).rejects.toThrow(/EXITED against its invoice \(name it first\)/)
    // The seeded FILED declaration names the shipment's TD24, still a draft.
    await expect(update(office(), 'CustomsDeclaration', s.declarationIds.filed, `status = 'EXITED', "exitConfirmedAt" = now(), "exitFileId" = $2::uuid`, await fileOf('CustomsDeclaration', s.declarationIds.filed))).rejects.toThrow(
      /EXITED against an issued invoice \(invoice .* is a DRAFT\)/,
    )
    expect(await update(office(), 'CustomsDeclaration', declaration, `"invoiceId" = $2::uuid, version = version + 1`, s.issuedInvoiceId)).toBe(1)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'EXITED', "exitConfirmedAt" = '2026-10-20T08:00:00.000Z', "exitFileId" = $2::uuid`, proof)).rejects.toThrow(/confirmed once the goods left .* not before/)
    await expect(update(office(), 'CustomsDeclaration', declaration, `status = 'EXITED', "exitConfirmedAt" = now(), "exitFileId" = $2::uuid`, await fileOf('Shipment', s.shippedShipmentId))).rejects.toThrow(/proof of exit .* is a file of the declaration/)
    expect(await update(office(), 'CustomsDeclaration', declaration, `status = 'EXITED', "exitConfirmedAt" = now(), "exitFileId" = $2::uuid, version = version + 1`, proof)).toBe(1)
    await expect(update(office(), 'CustomsDeclaration', declaration, `"alertAfterDays" = 60`)).rejects.toThrow(/is EXITED; it never changes/)
  })

  it('are removed only while the pack is merely sent; the office alone sees them', async () => {
    const declaration = randomUUID()
    expect(await declare({ id: declaration })).toBe(1)
    expect(await run(office(), `DELETE FROM "CustomsDeclaration" WHERE id = $1::uuid`, declaration)).toBe(1)
    await expect(admin(`TRUNCATE "CustomsDeclaration"`)).rejects.toThrow(/TRUNCATE on "CustomsDeclaration" is refused/)
    await expect(sql(floor(), `SELECT id FROM "CustomsDeclaration" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT id FROM "CustomsDeclaration" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('go to the broker by a BROKER_PACK link, with its papers, only while the site switched the pack on', async () => {
    const declaration = randomUUID()
    expect(await declare({ id: declaration, brokerPartyId: s.brokerPartyId })).toBe(1)
    const pack = (changes: Record<string, unknown>) => newLink({ purpose: 'BROKER_PACK', recordType: 'CustomsDeclaration', recordId: declaration, partyId: s.brokerPartyId, email: null, ...changes })
    await expect(pack({ recordType: 'Shipment', recordId: s.shippedShipmentId })).rejects.toThrow(/a BROKER_PACK link opens a CustomsDeclaration, not a Shipment/)
    await expect(pack({ partyId: P2 })).rejects.toThrow(/goes to the broker of customs declaration/)
    await expect(pack({ recordId: s.declarationIds.filed })).rejects.toThrow(/is FILED; its broker's pack goes by link only while it waits to be filed/)
    // OFF by default (the Owner's rule of 11-13).
    expect(await one('ShippingSettings', SITE_A1)).toMatchObject({ brokerPackOn: false, customerNoticeOn: false })
    await expect(pack({})).rejects.toThrow(/the broker pack is switched off at the site/)
    expect(await update(office(), 'ShippingSettings', SITE_A1, `"brokerPackOn" = true, version = version + 1`)).toBe(1)
    const link = randomUUID()
    expect(await pack({ id: link })).toBe(1)
    // Its papers: a set of files (LinkFile), as a SECURE_FILE link's; a RETURN_LABEL link carries none.
    const paper = await fileOf('Shipment', s.shippedShipmentId)
    expect(await run(office(), `INSERT INTO "LinkFile" ("id", "partyId", "linkId", "fileId", "position") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1)`, randomUUID(), s.brokerPartyId, link, paper)).toBe(1)
    await expect(run(office(), `INSERT INTO "LinkFile" ("id", "partyId", "linkId", "fileId", "position") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1)`, randomUUID(), P1, s.linkId, paper)).rejects.toThrow(
      /only a DOCUMENT_VIEW or SECURE_FILE link has a set of files, and a BROKER_PACK link its papers/,
    )
    expect(await update(office(), 'ShippingSettings', SITE_A1, `"brokerPackOn" = false, version = version + 1`)).toBe(1)
  })
})

describe('the proof of delivery (LOG-065) and the delivered order (LOG-067)', () => {
  it('keeps the proof on a delivered shipment only, each part set once', async () => {
    const shipment = s.shippedShipmentId
    const pod = await fileOf('Shipment', shipment)
    await expect(update(office(), 'Shipment', shipment, `"podSignedBy" = 'A. Receiver'`)).rejects.toThrow(/proof of delivery is kept on a DELIVERED shipment only/)
    await expect(update(office(), 'Shipment', shipment, `status = 'DELIVERED', "deliveredAt" = now(), "podAt" = '2026-10-01T08:00:00.000Z'`)).rejects.toThrow(/signed for after it left, not in the future/)
    await expect(update(office(), 'Shipment', shipment, `status = 'DELIVERED', "deliveredAt" = now(), "podSignedBy" = E'two\\nlines'`)).rejects.toThrow(/1 to 200 characters on one line/)
    await expect(update(office(), 'Shipment', shipment, `status = 'DELIVERED', "deliveredAt" = now(), "podFileId" = $2::uuid`, await fileOf('ReturnAuthorisation', s.returnId))).rejects.toThrow(
      /proof of delivery of shipment .* is a file of the shipment/,
    )
    expect(await update(office(), 'Shipment', shipment, `status = 'DELIVERED', "deliveredAt" = now(), "podSignedBy" = 'A. Receiver', "podAt" = now(), version = version + 1`)).toBe(1)
    // The image may come after the delivery (the shipment guard lets it change once the goods left); then each part stays.
    expect(await update(office(), 'Shipment', shipment, `"podFileId" = $2::uuid, version = version + 1`, pod)).toBe(1)
    await expect(update(office(), 'Shipment', shipment, `"podSignedBy" = 'B. Other'`)).rejects.toThrow(/each set once/)
    await expect(update(floor(), 'Shipment', shipment, `"podSignedBy" = NULL`)).rejects.toThrow(/the floor packs and unpacks shipment/)
    expect((await sql(partner(), `SELECT "podSignedBy" FROM "Shipment" WHERE id = $1::uuid`, shipment))[0]).toEqual({ podSignedBy: 'A. Receiver' })
  })

  it('moves an order SHIPPED → DELIVERED with its time once a shipment was delivered and none travels, then only to CLOSED', async () => {
    const order = ORDER_SO_0002
    // The seed's order is still being made; here everything of it left (SH-0001, delivered above).
    await force(`UPDATE "SalesOrder" SET status = 'SHIPPED' WHERE id = $1::uuid`, [order])
    await expect(update(office(), 'SalesOrder', order, `status = 'DELIVERED'`)).rejects.toThrow(/with the wrong delivered time/)
    await expect(update(office(), 'SalesOrder', order, `"deliveredAt" = now()`)).rejects.toThrow(/with the wrong delivered time/)
    await expect(update(office(), 'SalesOrder', order, `status = 'DELIVERED', "deliveredAt" = now() + interval '1 day'`)).rejects.toThrow(/delivered in the future/)
    // A shipment still travelling keeps it SHIPPED.
    const travelling = randomUUID()
    await force(`INSERT INTO "Shipment" SELECT * FROM jsonb_populate_record(NULL::"Shipment", (SELECT to_jsonb(r) || $1::jsonb FROM "Shipment" r WHERE r.id = $2::uuid))`, [
      JSON.stringify({ id: travelling, number: `SH-T-${travelling.slice(0, 8)}`, status: 'SHIPPED', deliveredAt: null, podSignedBy: null, podAt: null, podFileId: null, manifestId: null }),
      s.shippedShipmentId,
    ])
    await expect(update(office(), 'SalesOrder', order, `status = 'DELIVERED', "deliveredAt" = now()`)).rejects.toThrow(/[1-9]\d* delivered, [1-9]\d* on the way/)
    await force(`UPDATE "Shipment" SET status = 'DELIVERED', "deliveredAt" = now() WHERE id = $1::uuid`, [travelling])
    expect(await update(office(), 'SalesOrder', order, `status = 'DELIVERED', "deliveredAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'SalesOrder', order, `"deliveredAt" = now() - interval '1 hour'`)).rejects.toThrow(/delivered time of sales order .* never changes/)
    await expect(update(office(), 'SalesOrder', order, `status = 'SHIPPED', "deliveredAt" = NULL`)).rejects.toThrow(/cannot move from DELIVERED to SHIPPED/)
    expect(await update(office(), 'SalesOrder', order, `status = 'CLOSED', "closedAt" = now(), version = version + 1`)).toBe(1)
    expect(await one('SalesOrder', order)).toMatchObject({ status: 'CLOSED' })
    expect((await one('SalesOrder', order)).deliveredAt).not.toBeNull()
  })

  it('refuses DELIVERED from anything but SHIPPED', async () => {
    const [other] = await admin(`SELECT id, status::text FROM "SalesOrder" WHERE "tenantId" = $1::uuid AND id <> $2::uuid AND status <> 'SHIPPED' ORDER BY number LIMIT 1`, [a.tenantId, ORDER_SO_0002])
    const order = other!.id as string
    await expect(update(office(), 'SalesOrder', order, `status = 'DELIVERED', "deliveredAt" = now()`)).rejects.toThrow(/cannot move from .* to DELIVERED/)
  })
})

describe('the EORI (LOG-095) and the customs documents (LOG-086, LOG-087)', () => {
  it("keeps a company's EORI in its shape, never on the floor", async () => {
    expect(await one('Company', COMPANY_A)).toMatchObject({ eori: SEED_EORI_A })
    await expect(update(office(), 'Company', COMPANY_A, `eori = 'it123'`)).rejects.toThrow(/two capitals then 1 to 15 capitals or digits/)
    await expect(update(office(), 'Company', COMPANY_A, `eori = 'IT0000000303800000'`)).rejects.toThrow(/two capitals then 1 to 15 capitals or digits/)
    expect(await update(office(), 'Company', COMPANY_A, `eori = $2, version = version + 1`, SEED_EORI_A)).toBe(1)
    await expect(sql(floor(), `SELECT eori FROM "Company" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('makes the commercial invoice, CN22 and CN23 of a shipment only', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'GeneratedDocument', s.commercialInvoiceDocumentId, { id: randomUUID(), ...changes })
    expect(await copy({ kind: 'CN23' })).toBe(1)
    expect(await copy({ kind: 'CN22' })).toBe(1)
    expect(await copy({ version: 2 })).toBe(1)
    await expect(copy({ kind: 'CN22', version: 1, recordType: 'SalesOrder', recordId: ORDER_SO_0002, siteId: null })).rejects.toThrow(/a commercial invoice, a CN22 and a CN23 a Shipment's/)
  })
})
