import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinks } from '../seed/links'
import { seed as seedPortalFollowups, type PortalFollowupsSeed } from '../seed/portal-followups'
import { seed as seedPortalFrame, type PortalFrameSeed } from '../seed/portal-frame'
import { seed as seedReturns, type ReturnsSeed } from '../seed/returns'
import { seed as seedSafety, type SafetySeed } from '../seed/safety'
import { seed as seedSupply, type SupplySeed } from '../seed/supply'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The portal follow-ups (W2b schema wave 23, B-W2b-F12, …_portal_followups_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - grants: a supplier reads and writes its own document uploads and change requests (never the decider's id), a
 *     customer reads its own returns, return lines and complaints without the office's columns, and adds a delivery address
 *     that waits for the office's check; nobody reads another party's;
 *   - purchase orders: a PORTAL confirmation names its person, a proposal names its link or its person (exactly one), an
 *     accepted portal proposal becomes a PORTAL confirmation by the same person; the person is of the order's supplier;
 *   - delivery addresses: a partner session inserts only a WAITING SHIP_TO address of its own party asked by one of its
 *     active people; the office decides once (a refusal with its reason, archived); a quote version or a shipment never
 *     names a waiting or refused address;
 *   - document uploads and change requests: born waiting / open, decided once, what the supplier said never changes, the
 *     version of a request moves by one, a partner session only withdraws;
 *   - returns: a request from the portal or a link starts REQUESTED; its channel, wish and words never change;
 *   - DVR signatures: LINK names an APPROVED request of its own version, for the appointment of the request's party, with the
 *     typed name and the day of the answer; no other register is signed LINK;
 *   - a task handed to an active colleague of its party while OPEN; the carrier's ETA moves after the goods left; a tracking
 *     page is https; the cancel fee 0 to 100; a website http(s).
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-f12-a'
const DENIED = /permission denied/
const RLS = /row-level security/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PortalFollowupsSeed
let frame: PortalFrameSeed
let returns: ReturnsSeed
let safety: SafetySeed
let supply: SupplySeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const P2 = key('party:P2')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
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

beforeAll(async () => {
  db = await migratedDatabase('portalfollowupsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  // The links seed: P2's PO_CONFIRM link (a proposal names its link or its portal person, never both).
  await seedLinks({ db: factory, namespace: NS })
  supply = await seedSupply({ db: factory, namespace: NS })
  returns = await seedReturns({ db: factory, namespace: NS })
  safety = await seedSafety({ db: factory, namespace: NS })
  frame = await seedPortalFrame({ db: factory, namespace: NS })
  seeded = await seedPortalFollowups({ db: factory, namespace: NS }, { partnerScope: true })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the two models: office, partner by party (never the decider), no personal-data map', () => {
    const ownership = loadOwnership()
    const all = classifiedModels(loadSchema(), ownership)
    const models = all.filter(({ model }) => model.file === 'portal-followups.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['PartyChangeRequest', 'SupplierDocumentUpload'])
    const access = (name: string) => all.find(({ model }) => model.name === name)!.ownership.access
    expect(Object.keys(access('SupplierDocumentUpload')).sort()).toEqual(['factory_partner_runtime', 'factory_runtime'])
    expect(access('SupplierDocumentUpload').factory_partner_runtime).toMatchObject({ privileges: ['select', 'insert'], scopedBy: ['party'] })
    expect(access('PartyChangeRequest').factory_partner_runtime).toMatchObject({ privileges: ['select', 'insert', 'update'], scopedBy: ['party'] })
    expect(access('PartyAddress').factory_partner_runtime).toMatchObject({ privileges: ['select', 'insert'], hiddenColumns: expect.arrayContaining(['decidedById']) })
    for (const name of ['ReturnAuthorisation', 'ReturnLine', 'Complaint']) expect(access(name).factory_partner_runtime, name).toMatchObject({ privileges: ['select'], scopedBy: ['party'] })
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
  })

  it('seeds P2 as the app writes it, twice without a change', async () => {
    const counts = async () =>
      (
        await admin(`SELECT (SELECT count(*) FROM "SupplierDocumentUpload")::int AS uploads, (SELECT count(*) FROM "PartyChangeRequest")::int AS requests,
          (SELECT count(*) FROM "PartyAddress" WHERE "approvalStatus" IS NOT NULL)::int AS waiting`)
      )[0]
    const before = await counts()
    expect(before).toEqual({ uploads: 3, requests: 3, waiting: 1 })
    await seedPortalFollowups({ db: factory, namespace: NS }, { partnerScope: true })
    expect(await counts()).toEqual(before)
    expect(await one('SupplierDocumentUpload', seeded.uploads.accepted)).toMatchObject({ status: 'ACCEPTED', documentFileId: seeded.files.certificate, version: 3 })
    expect(await one('SupplierDocumentUpload', seeded.uploads.waiting)).toMatchObject({ status: 'WAITING', receivedAt: null, decidedAt: null, version: 1 })
    expect(await one('PartyChangeRequest', seeded.changeRequests.refused)).toMatchObject({ status: 'REFUSED', version: 2 })
    expect(await one('PartyAddress', seeded.partner.addressId)).toMatchObject({ approvalStatus: 'WAITING', requestedByUserId: seeded.buyerUserId, isDefaultShipTo: false })
  })

  it('a supplier reads its own uploads and requests, never the decider; another party reads none of them', async () => {
    expect(await sql(partner(), 'SELECT id, "decidedByName", "refuseReason" FROM "SupplierDocumentUpload"')).toHaveLength(2)
    expect(await sql(partner(), 'SELECT id, "decidedByName", "refuseReason" FROM "PartyChangeRequest"')).toHaveLength(2)
    expect(await sql(partner(P1), 'SELECT id FROM "SupplierDocumentUpload"')).toEqual([{ id: seeded.partner.uploadId }])
    expect(await sql(partner(P1), 'SELECT id FROM "PartyChangeRequest"')).toEqual([{ id: seeded.partner.changeRequestId }])
    for (const table of ['SupplierDocumentUpload', 'PartyChangeRequest']) {
      await expect(sql(partner(), `SELECT "decidedById" FROM "${table}"`), table).rejects.toThrow(DENIED)
      await expect(sql(partner(), `SELECT "createdById" FROM "${table}"`), table).rejects.toThrow(DENIED)
    }
    await expect(update(partner(), 'SupplierDocumentUpload', seeded.uploads.waiting, `note = 'x'`)).rejects.toThrow(DENIED)
    await expect(run(partner(), 'DELETE FROM "PartyChangeRequest" WHERE id = $1::uuid', seeded.changeRequests.open)).rejects.toThrow(DENIED)
  })

  it('a customer reads its own returns, lines and complaints without the office columns; the supplier reads none; neither writes', async () => {
    expect((await sql(partner(P1), 'SELECT id, channel, "outcomeWanted", "customerNote", status FROM "ReturnAuthorisation"')).length).toBe(2)
    expect((await sql(partner(P1), 'SELECT id, "unitPrice", "creditAmount", grade FROM "ReturnLine"')).length).toBeGreaterThan(0)
    expect(await sql(partner(P1), 'SELECT id, status, "answerDueOn" FROM "Complaint"')).toEqual(expect.arrayContaining([expect.objectContaining({ id: returns.complaintId })]))
    for (const table of ['ReturnAuthorisation', 'ReturnLine', 'Complaint']) expect(await sql(partner(), `SELECT id FROM "${table}"`), table).toEqual([])
    for (const [table, column] of [['ReturnAuthorisation', 'internalNote'], ['ReturnAuthorisation', 'ownerId'], ['ReturnAuthorisation', 'authorisedById'], ['ReturnLine', 'decidedById'], ['Complaint', 'findings'], ['Complaint', 'rootCause'], ['Complaint', 'severity'], ['Complaint', 'answerText'], ['Complaint', 'internalNote']] as const) {
      await expect(sql(partner(P1), `SELECT "${column}" FROM "${table}"`), `${table}.${column}`).rejects.toThrow(DENIED)
    }
    await expect(update(partner(P1), 'ReturnAuthorisation', returns.waitingReturnId, `"customerRef" = 'x'`)).rejects.toThrow(DENIED)
    await expect(update(partner(P1), 'Complaint', returns.complaintId, `description = 'x'`)).rejects.toThrow(DENIED)
  })
})

describe('purchase orders confirmed in the portal', () => {
  /** A SENT copy of PO1 (P2's), put there as the owner (the send needs its lines, which are W1's to test). */
  async function sentOrder(): Promise<string> {
    const orderId = randomUUID()
    const [source] = await admin('SELECT to_jsonb(o) AS row FROM "PurchaseOrder" o WHERE o.id = $1::uuid', [supply.purchaseOrderId])
    const row = {
      ...(source!.row as Record<string, unknown>),
      id: orderId,
      number: `T-PO-${orderId.slice(0, 8)}`,
      status: 'SENT',
      sentAt: new Date(Date.now() - 3_600_000).toISOString(),
      confirmBy: null,
      confirmedAt: null,
      confirmedVia: null,
      confirmLinkId: null,
      confirmedByName: null,
      supplierRef: null,
      confirmNote: null,
      version: 1,
    }
    await bypass('INSERT INTO "PurchaseOrder" SELECT * FROM jsonb_populate_record(NULL::"PurchaseOrder", $1::jsonb)', [JSON.stringify(row)])
    return orderId
  }
  const confirmedInPortal = (userId: string) =>
    `status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'PORTAL', "confirmedByUserId" = '${userId}', "confirmedByName" = 'Seed Portal Order Desk', version = version + 1`
  const proposedInPortal = (userId: string) => `status = 'CHANGES_PROPOSED', "proposedAt" = now(), "proposedByUserId" = '${userId}', "proposedByName" = 'Seed Portal Order Desk', version = version + 1`

  it('a person of the supplier confirms in the portal: PORTAL with its person, never a link', async () => {
    const order = await sentOrder()
    expect(await update(partner(), 'PurchaseOrder', order, confirmedInPortal(seeded.supplierUserId))).toBe(1)
    expect(await one('PurchaseOrder', order)).toMatchObject({ status: 'CONFIRMED', confirmedVia: 'PORTAL', confirmedByUserId: seeded.supplierUserId, confirmLinkId: null })
  })

  it('REFUSES a PORTAL confirmation without its person, a LINK one with a person, and a person of another party', async () => {
    const order = await sentOrder()
    await expect(update(partner(), 'PurchaseOrder', order, `status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'PORTAL'`)).rejects.toThrow(/PORTAL with its person/)
    await expect(update(office(), 'PurchaseOrder', order, `status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', "confirmedByUserId" = '${seeded.supplierUserId}'`)).rejects.toThrow(/PORTAL with its person, OFFICE with neither/)
    // P1's buyer is no person of P2: the supplier's session does not even see them.
    await expect(update(partner(), 'PurchaseOrder', order, confirmedInPortal(seeded.buyerUserId))).rejects.toThrow(/by an active person of its own supplier/)
    await expect(update(office(), 'PurchaseOrder', order, confirmedInPortal(seeded.buyerUserId))).rejects.toThrow(/by an active person of its own supplier/)
  })

  it('a portal proposal names its person; accepted, it becomes a PORTAL confirmation by that person, never a LINK one', async () => {
    const order = await sentOrder()
    expect(await update(partner(), 'PurchaseOrder', order, proposedInPortal(seeded.supplierUserId))).toBe(1)
    const accept = `status = 'CONFIRMED', "proposalDecision" = 'ACCEPTED', "proposalDecidedAt" = now(), "proposalDecidedById" = '${a.actorId}', "confirmedAt" = now(), version = version + 1`
    const link = (await admin(`SELECT id FROM "OneOffLink" WHERE "partyId" = $1::uuid LIMIT 1`, [P2]))[0]!.id as string
    await expect(update(office(), 'PurchaseOrder', order, `${accept}, "confirmedVia" = 'LINK', "confirmLinkId" = '${link}'`)).rejects.toThrow(/leaves CHANGES_PROPOSED only by the buyer's decision/)
    await expect(update(office(), 'PurchaseOrder', order, `${accept}, "confirmedVia" = 'PORTAL', "confirmedByUserId" = '${a.actorId}'`)).rejects.toThrow(/leaves CHANGES_PROPOSED only|active person of its own supplier/)
    expect(await update(office(), 'PurchaseOrder', order, `${accept}, "confirmedVia" = 'PORTAL', "confirmedByUserId" = '${seeded.supplierUserId}'`)).toBe(1)
    expect(await one('PurchaseOrder', order)).toMatchObject({ status: 'CONFIRMED', confirmedVia: 'PORTAL', confirmedByUserId: seeded.supplierUserId, proposedByUserId: seeded.supplierUserId, proposalLinkId: null })
  })

  it('REFUSES a proposal with no link and no person, with both, or a person written outside the proposal', async () => {
    const order = await sentOrder()
    await expect(update(partner(), 'PurchaseOrder', order, `status = 'CHANGES_PROPOSED', "proposedAt" = now(), version = version + 1`)).rejects.toThrow(/its link or its portal person \(exactly one\)/)
    const link = (await admin(`SELECT id FROM "OneOffLink" WHERE "partyId" = $1::uuid LIMIT 1`, [P2]))[0]!.id as string
    await expect(update(partner(), 'PurchaseOrder', order, `${proposedInPortal(seeded.supplierUserId)}, "proposalLinkId" = '${link}'`)).rejects.toThrow(/exactly one/)
    await expect(update(office(), 'PurchaseOrder', order, `"proposedByUserId" = '${seeded.supplierUserId}'`)).rejects.toThrow(/proposal for purchase order .* is written only when it moves from SENT to CHANGES_PROPOSED/)
  })
})

describe('delivery addresses that wait for the office', () => {
  const addressColumns = () => partnerColumns('PartyAddress')
  const waitingCopy = (changes: Record<string, unknown> = {}, scope: FactoryScope = partner(P1)) =>
    copyRow('PartyAddress', seeded.partner.addressId, { id: randomUUID(), ...changes }, scope, scope.audience === 'partner' ? addressColumns() : undefined)

  it('a customer adds a delivery address of its own that waits; the office approves it once', async () => {
    const id = randomUUID()
    expect(await waitingCopy({ id })).toBe(1)
    expect(await one('PartyAddress', id)).toMatchObject({ approvalStatus: 'WAITING', partyId: P1, isDefaultShipTo: false, createdById: null })
    expect(await update(office(), 'PartyAddress', id, `"approvalStatus" = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'PartyAddress', id, `"approvalStatus" = 'REFUSED', "refuseReason" = 'Too late', status = 'ARCHIVED'`)).rejects.toThrow(/is checked once/)
    await expect(update(office(), 'PartyAddress', id, `"requestedAt" = now()`)).rejects.toThrow(/who asked for address .* never change/)
    // Approved, it is an address like any other: on an order too.
    expect(await update(office(), 'QuoteVersion', returns.money.sales.draftVersionId, `"shipToAddressId" = $2::uuid`, id)).toBe(1)
    expect(await update(office(), 'QuoteVersion', returns.money.sales.draftVersionId, `"shipToAddressId" = NULL`)).toBe(1)
  })

  it('REFUSES a partner insert that is not a waiting delivery address of its own party, asked by one of its active people', async () => {
    await expect(waitingCopy({ approvalStatus: null, requestedAt: null, requestedByUserId: null })).rejects.toThrow(/adds only a delivery address \(SHIP_TO\) of its own party/)
    await expect(waitingCopy({ kinds: ['SHIP_TO', 'BILL_TO'] })).rejects.toThrow(/adds only a delivery address/)
    await expect(waitingCopy({ approvalStatus: 'APPROVED', decidedAt: new Date().toISOString() })).rejects.toThrow(/office's own \(no check\) or WAITING/)
    await expect(waitingCopy({ isDefaultShipTo: true })).rejects.toThrow(/never a default until approved/)
    await expect(waitingCopy({ requestedByUserId: seeded.supplierUserId })).rejects.toThrow(/asked for by an active person of its own party/)
    await expect(waitingCopy({ partyId: P2 })).rejects.toThrow(RLS)
    // The office may record one for the customer too, but never born approved, and an address of its own never waits later.
    expect(await waitingCopy({}, office())).toBe(1)
    await expect(waitingCopy({ approvalStatus: 'REFUSED', decidedAt: new Date().toISOString(), refuseReason: 'No', status: 'ARCHIVED' }, office())).rejects.toThrow(/office's own \(no check\) or WAITING/)
    const own = (await admin(`SELECT id FROM "PartyAddress" WHERE "partyId" = $1::uuid AND "approvalStatus" IS NULL LIMIT 1`, [P1]))[0]!.id as string
    await expect(update(office(), 'PartyAddress', own, `"approvalStatus" = 'WAITING', "requestedAt" = now(), "requestedByUserId" = $2::uuid`, seeded.buyerUserId)).rejects.toThrow(/never change|checked once/)
  })

  it('REFUSES a waiting or refused address on a quote version or a shipment; a refusal has its reason and archives it for good', async () => {
    const id = randomUUID()
    expect(await waitingCopy({ id })).toBe(1)
    await expect(update(office(), 'QuoteVersion', returns.money.sales.draftVersionId, `"shipToAddressId" = $2::uuid`, id)).rejects.toThrow(/names address .*, which is WAITING/)
    await expect(update(office(), 'QuoteVersion', returns.money.sales.draftVersionId, `"billToAddressId" = $2::uuid`, id)).rejects.toThrow(/which is WAITING/)
    const shipment = returns.money.shipping.draftShipmentId
    expect((await one('Shipment', shipment)).partyId).toBe(P1)
    await expect(update(office(), 'Shipment', shipment, `"shipToAddressId" = $2::uuid`, id)).rejects.toThrow(/names address .*, which is WAITING/)
    await expect(update(office(), 'PartyAddress', id, `"approvalStatus" = 'REFUSED', "decidedAt" = now(), status = 'ARCHIVED'`)).rejects.toThrow(/a refusal with its reason/)
    await expect(update(office(), 'PartyAddress', id, `"approvalStatus" = 'REFUSED', "decidedAt" = now(), "refuseReason" = 'Not a shop of yours'`)).rejects.toThrow(/archived, never a default/)
    expect(await update(office(), 'PartyAddress', id, `"approvalStatus" = 'REFUSED', "decidedAt" = now(), "refuseReason" = 'Not a shop of yours', status = 'ARCHIVED', version = version + 1`)).toBe(1)
    await expect(update(office(), 'PartyAddress', id, `status = 'ACTIVE'`)).rejects.toThrow(/was refused; it never changes again/)
    await expect(update(office(), 'QuoteVersion', returns.money.sales.draftVersionId, `"shipToAddressId" = $2::uuid`, id)).rejects.toThrow(/which is REFUSED/)
  })
})

describe('supplier document uploads', () => {
  const uploadCopy = (changes: Record<string, unknown> = {}, scope: FactoryScope = partner()) =>
    copyRow('SupplierDocumentUpload', seeded.uploads.waiting, { id: randomUUID(), receivedAt: null, version: 1, ...changes }, scope, scope.audience === 'partner' ? partnerColumns('SupplierDocumentUpload') : undefined)

  it('the supplier records an upload; the office marks it arrived and accepts it once; then nothing changes', async () => {
    const id = randomUUID()
    expect(await uploadCopy({ id })).toBe(1)
    const accept = `status = 'ACCEPTED', "decidedAt" = now(), "decidedById" = '${a.actorId}', "decidedByName" = 'Seed Buyer', "acceptedCategory" = 'DECLARATION', "documentFileId" = "fileId", version = version + 1`
    await expect(update(office(), 'SupplierDocumentUpload', id, accept)).rejects.toThrow(/ACCEPTED \(its file arrived/)
    expect(await update(office(), 'SupplierDocumentUpload', id, `"receivedAt" = now(), version = version + 1`)).toBe(1)
    expect(await update(office(), 'SupplierDocumentUpload', id, accept)).toBe(1)
    await expect(update(office(), 'SupplierDocumentUpload', id, `status = 'REFUSED', "refuseReason" = 'Blurred scan', version = version + 1`)).rejects.toThrow(/is ACCEPTED; it changes no more/)
    await expect(update(office(), 'SupplierDocumentUpload', id, `issuer = 'Someone else'`)).rejects.toThrow(/what the supplier said .* never change/)
    await expect(update(office(), 'SupplierDocumentUpload', id, `version = version + 2`)).rejects.toThrow(/goes up by one/)
    await expect(run(office(), 'DELETE FROM "SupplierDocumentUpload" WHERE id = $1::uuid', id)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "SupplierDocumentUpload" WHERE id = $1::uuid', [id])).rejects.toThrow(/decided, never deleted/)
  })

  it('a refusal says why (3 to 500 characters)', async () => {
    const id = randomUUID()
    expect(await uploadCopy({ id })).toBe(1)
    await expect(update(office(), 'SupplierDocumentUpload', id, `status = 'REFUSED', "decidedAt" = now(), version = version + 1`)).rejects.toThrow(/REFUSED \(its reason, 3 to 500 characters\)/)
    await expect(update(office(), 'SupplierDocumentUpload', id, `status = 'REFUSED', "decidedAt" = now(), "refuseReason" = 'no', version = version + 1`)).rejects.toThrow(/3 to 500 characters/)
    expect(await update(office(), 'SupplierDocumentUpload', id, `status = 'REFUSED', "decidedAt" = now(), "refuseReason" = 'The scan is blurred: send it again.', version = version + 1`)).toBe(1)
  })

  it('REFUSES an upload born decided, of another party, of another kind, by another party\'s person, or with too many codes', async () => {
    await expect(uploadCopy({ status: 'ACCEPTED' })).rejects.toThrow(/WAITS for a person of ours/)
    await expect(uploadCopy({ recordId: P1 })).rejects.toThrow(/for the party itself or one of its purchase orders/)
    await expect(uploadCopy({ recordType: 'PurchaseOrder', recordId: supply.draftPurchaseOrderId })).rejects.toThrow(/for the party itself or one of its purchase orders/)
    await expect(uploadCopy({ recordType: 'Quote', recordId: P2 })).rejects.toThrow(/for the party itself/)
    await expect(uploadCopy({ category: 'PROOF' })).rejects.toThrow(/a certificate, a test report or a declaration/)
    await expect(uploadCopy({ uploadedById: seeded.buyerUserId })).rejects.toThrow(/uploaded by an active person of its own party/)
    await expect(uploadCopy({ articleCodes: Array.from({ length: 21 }, (_, n) => `A-${n}`) })).rejects.toThrow(/up to 20 articles/)
    await expect(uploadCopy({ lotCodes: [' '] })).rejects.toThrow(/codes of 1 to 60 characters/)
    await expect(uploadCopy({ issuedOn: '2026-10-30', expiresOn: '2026-10-01' })).rejects.toThrow(/expires on or after/)
    await expect(uploadCopy({ partyId: P1 })).rejects.toThrow(RLS)
    // The office's own check of the file: a file of another record is refused.
    await expect(uploadCopy({ fileId: seeded.files.certificate, recordType: 'PurchaseOrder', recordId: supply.purchaseOrderId }, office())).rejects.toThrow(/is a file of the record it is for/)
    // A purchase order of the supplier itself is a record it may answer for.
    expect(await uploadCopy({ recordType: 'PurchaseOrder', recordId: supply.purchaseOrderId, recordLabel: 'SEED-PO-0001' })).toBe(1)
  })
})

describe('profile change requests', () => {
  const requestCopy = (changes: Record<string, unknown> = {}, scope: FactoryScope = partner()) =>
    copyRow('PartyChangeRequest', seeded.changeRequests.open, { id: randomUUID(), ...changes }, scope, scope.audience === 'partner' ? partnerColumns('PartyChangeRequest') : undefined)

  it('the supplier asks and withdraws; it never decides', async () => {
    const id = randomUUID()
    expect(await requestCopy({ id })).toBe(1)
    await expect(update(partner(), 'PartyChangeRequest', id, `status = 'APPROVED', "decidedAt" = now(), version = version + 1`)).rejects.toThrow(/only withdraws its open change request/)
    expect(await update(partner(), 'PartyChangeRequest', id, `status = 'WITHDRAWN', "decidedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'PartyChangeRequest', id, `status = 'APPROVED', version = version + 1`)).rejects.toThrow(/is WITHDRAWN; it changes no more/)
  })

  it('the office decides once, moving the version by one; a refusal says why; what was asked never changes', async () => {
    const id = randomUUID()
    expect(await requestCopy({ id })).toBe(1)
    await expect(update(office(), 'PartyChangeRequest', id, `summary = 'Something else', version = version + 1`)).rejects.toThrow(/what change request .* asks, who asked and when never change/)
    await expect(update(office(), 'PartyChangeRequest', id, `status = 'APPROVED', "decidedAt" = now()`)).rejects.toThrow(/moves its version up by one/)
    await expect(update(office(), 'PartyChangeRequest', id, `status = 'REFUSED', "decidedAt" = now(), version = version + 1`)).rejects.toThrow(/a refusal with its reason/)
    expect(await update(office(), 'PartyChangeRequest', id, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, "decidedByName" = 'Seed Buyer', version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'PartyChangeRequest', id, `"decidedByName" = 'Another', version = version + 1`)).rejects.toThrow(/is APPROVED; it changes no more/)
  })

  it('REFUSES a request born decided, with no change, with a change that is no object, or asked by another party\'s person', async () => {
    await expect(requestCopy({ status: 'APPROVED', decidedAt: new Date().toISOString() })).rejects.toThrow(/is OPEN, not decided/)
    await expect(requestCopy({ changes: [] })).rejects.toThrow(/asks 1 to 20 changes/)
    await expect(requestCopy({ changes: { op: 'ADD' } })).rejects.toThrow(/asks 1 to 20 changes/)
    await expect(requestCopy({ changes: ['ADD'] })).rejects.toThrow(/each an object/)
    await expect(requestCopy({ requestedById: seeded.buyerUserId })).rejects.toThrow(/asked by an active person of its own party/)
    await expect(requestCopy({ summary: ' ' })).rejects.toThrow(/short words, none blank/)
    await expect(admin('DELETE FROM "PartyChangeRequest" WHERE id = $1::uuid', [seeded.changeRequests.open])).rejects.toThrow(/never deleted/)
  })
})

describe('returns asked from outside', () => {
  const rmaCopy = (changes: Record<string, unknown>) =>
    copyRow('ReturnAuthorisation', returns.waitingReturnId, { id: randomUUID(), number: `T-RMA-${randomUUID().slice(0, 8)}`, ...changes })

  it('a portal or link request starts REQUESTED, with what the customer would like and their words', async () => {
    await expect(rmaCopy({ channel: 'PORTAL', outcomeWanted: 'REPLACE' })).rejects.toThrow(/came from the customer \(PORTAL\): it starts REQUESTED/)
    await expect(rmaCopy({ channel: 'LINK', status: 'REQUESTED', authorisedAt: null, authorisedById: null, goodsDueBy: null, customerNote: '  ' })).rejects.toThrow(/not blank, up to 2000 characters/)
    expect(await rmaCopy({ channel: 'LINK', status: 'REQUESTED', authorisedAt: null, authorisedById: null, goodsDueBy: null, outcomeWanted: 'REPAIR', customerNote: 'The zip broke after a week.' })).toBe(1)
  })

  it('REFUSES changing how it was asked, the wish or the words', async () => {
    await expect(update(office(), 'ReturnAuthorisation', returns.waitingReturnId, `channel = 'PORTAL'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'ReturnAuthorisation', returns.waitingReturnId, `"outcomeWanted" = 'CREDIT'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'ReturnAuthorisation', returns.waitingReturnId, `"customerNote" = 'Later words'`)).rejects.toThrow(/never change/)
  })
})

describe('a DVR signature by link', () => {
  let appointment: string
  let request: string
  const signature = (changes: Record<string, unknown>) =>
    copyRow('RiskAssessmentSignature', key('safety:dvr:A1:v2:RLS'), {
      id: randomUUID(),
      key: `signature:${safety.versionIds.v2}:DOCTOR`,
      role: 'DOCTOR',
      appointmentId: appointment,
      signerName: 'Seed Outside Doctor',
      method: 'LINK',
      signedById: null,
      signedByWorkerId: null,
      approvalRequestId: request,
      ...changes,
    })

  beforeAll(async () => {
    // An outside occupational doctor of party P2 (the parties seed's supplier stands in for the doctor's practice), and the
    // approval request it answered APPROVED by link a minute ago: put there as the owner (asking and answering are
    // links-depth's, tested there).
    appointment = randomUUID()
    expect(await copyRow('SafetyAppointment', safety.appointmentIds.doctor, { id: appointment, outsideName: 'Seed Outside Doctor', outsidePartyId: P2, signedAt: null, signMethod: null, signedName: null, signedById: null })).toBe(1)
    request = randomUUID()
    await bypass(
      `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, "typedName", "answeredAt", version, "createdAt", "updatedAt")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'RiskAssessmentVersion', $4::uuid, $5::uuid, 'SIGNATURE', 'Sign DVR v2', now() + interval '7 days', 'APPROVED', 'Seed Outside Doctor', now() - interval '1 minute', 2, now() - interval '1 day', now())`,
      [request, a.tenantId, key('company:A'), safety.versionIds.v2, P2],
    )
  })
  const today = async () => (await admin(`SELECT (("answeredAt" AT TIME ZONE 'Europe/Rome')::date)::text AS day, "answeredAt" AS at FROM "ApprovalRequest" WHERE id = $1::uuid`, [request]))[0]!

  it('REFUSES LINK without its request, with an office signer, a request elsewhere or still open, another party\'s appointment, or another name', async () => {
    const { day, at } = await today()
    const when = { signedOn: day, signedAt: new Date((at as Date).getTime() + 1000).toISOString() }
    await expect(signature({ ...when, approvalRequestId: null })).rejects.toThrow(/the approval request the outside signer approved \(LINK\), exactly one/)
    await expect(signature({ ...when, signedById: a.actorId })).rejects.toThrow(/exactly one/)
    await expect(signature({ ...when, method: 'OFFICE', signedById: a.actorId })).rejects.toThrow(/exactly one/)
    await bypass(`UPDATE "ApprovalRequest" SET status = 'OPEN' WHERE id = $1::uuid`, [request])
    await expect(signature(when)).rejects.toThrow(/names an approval request of its own version .*, answered APPROVED/)
    await bypass(`UPDATE "ApprovalRequest" SET status = 'APPROVED', "recordType" = 'NcrConcession' WHERE id = $1::uuid`, [request])
    await expect(signature(when)).rejects.toThrow(/of its own version/)
    await bypass(`UPDATE "ApprovalRequest" SET "recordType" = 'RiskAssessmentVersion' WHERE id = $1::uuid`, [request])
    await expect(signature({ ...when, appointmentId: safety.appointmentIds.doctor })).rejects.toThrow(/the outside appointment of the party that approved it/)
    await expect(signature({ ...when, signerName: 'Somebody Else' })).rejects.toThrow(/the name the signer typed and the day it approved/)
    await expect(signature({ ...when, signedAt: new Date((at as Date).getTime() - 60_000).toISOString() })).rejects.toThrow(/signed no earlier than the answer/)
  })

  it('writes the outside doctor\'s LINK signature from its approved request, once', async () => {
    const { day, at } = await today()
    const id = randomUUID()
    expect(await signature({ id, signedOn: day, signedAt: new Date((at as Date).getTime() + 1000).toISOString() })).toBe(1)
    expect(await one('RiskAssessmentSignature', id)).toMatchObject({ method: 'LINK', approvalRequestId: request, signedById: null })
    await expect(update(office(), 'RiskAssessmentSignature', id, `"signerName" = 'x'`)).rejects.toThrow(DENIED)
  })

  it('REFUSES LINK on every other safety register', async () => {
    await expect(update(office(), 'SafetyAppointment', safety.appointmentIds.employer, `"signedAt" = now(), "signMethod" = 'LINK', "signedName" = 'Seed Legal Representative (made-up)', "signedById" = $2::uuid`, a.actorId)).rejects.toThrow(/LINK .* is only a DVR signature's/)
  })
})

describe('the small follow-ups', () => {
  it('hands an open task to an active colleague of its party, never to another party\'s person, never a closed task', async () => {
    expect(await update(office(), 'PartnerTask', frame.tasks.confirmPo, `"assigneeId" = $2::uuid, version = version + 1`, seeded.supplierUserId)).toBe(1)
    await expect(update(office(), 'PartnerTask', frame.tasks.confirmPo, `"assigneeId" = $2::uuid, version = version + 1`, seeded.buyerUserId)).rejects.toThrow(/handed to an active person of its own partner/)
    await expect(update(office(), 'PartnerTask', frame.tasks.uploadCertificate, `"assigneeId" = $2::uuid, version = version + 1`, seeded.supplierUserId)).rejects.toThrow(/is CANCELLED; it changes only by being reopened|only while OPEN/)
    await expect(update(partner(), 'PartnerTask', frame.tasks.confirmPo, `"assigneeId" = NULL`)).rejects.toThrow(/only marks its open task .* done/)
    expect(await update(office(), 'PartnerTask', frame.tasks.confirmPo, `"assigneeId" = NULL, version = version + 1`)).toBe(1)
  })

  it('moves the carrier\'s ETA after the goods left; a tracking page is https', async () => {
    const shipping = returns.money.shipping
    expect(await one('Shipment', shipping.shipmentId)).toMatchObject({ status: 'SHIPPED' })
    expect(await update(office(), 'Shipment', shipping.shipmentId, `"expectedDeliveryAt" = now() + interval '2 days', version = version + 1`)).toBe(1)
    await expect(update(office(), 'Shipment', shipping.shipmentId, `"carrierName" = 'Another carrier'`)).rejects.toThrow(/left; only its delivery or return/)
    await expect(update(office(), 'Parcel', shipping.draftParcelId, `"trackingUrl" = 'http://carrier.example/track/1'`)).rejects.toThrow(/an https address without spaces/)
    await expect(update(office(), 'Parcel', shipping.draftParcelId, `"trackingUrl" = 'https://carrier.example/track 1'`)).rejects.toThrow(/an https address without spaces/)
    expect(await update(office(), 'Parcel', shipping.draftParcelId, `"trackingUrl" = 'https://carrier.example/track/1', version = version + 1`)).toBe(1)
  })

  it('keeps the cancel fee 0 to 100 percent and a website an http(s) address', async () => {
    const settings = (await admin('SELECT id FROM "SalesSettings" WHERE "tenantId" = $1::uuid LIMIT 1', [a.tenantId]))[0]!.id as string
    await expect(update(office(), 'SalesSettings', settings, `"cancelFeePct" = 101`)).rejects.toThrow(/cancel fee .* is 0 to 100 percent/)
    await expect(update(office(), 'SalesSettings', settings, `"cancelFeePct" = -1`)).rejects.toThrow(/0 to 100 percent/)
    expect(await update(office(), 'SalesSettings', settings, `"cancelFeePct" = 15, version = version + 1`)).toBe(1)
    await expect(update(office(), 'Party', P1, `website = 'ftp://p1.example.com'`)).rejects.toThrow(/an http or https address/)
    expect(await update(office(), 'Party', P1, `website = 'https://p1.example.com', version = version + 1`)).toBe(1)
    expect(await sql(partner(P1), 'SELECT website FROM "Party"')).toEqual([{ website: 'https://p1.example.com' }])
  })
})
