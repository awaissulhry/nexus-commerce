import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid, type SeedContext } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, SEED_DIR } from './tools'

/**
 * The W2b-5 follow-ups for sales, buying and approvals (W2b-6 schema wave 45/57, B-W2b-363, …_followups_sales_w2b5_guards)
 * on a database built from the migrations and seeded twice (every seed file, in name order, as the CLI runs them), through
 * the real login and the scoped client:
 *   - REMAKE as what the customer would like: at the making, or marked once by the office while the RMA is open;
 *   - the made-to-measure photos: of their record, the office's only, with a delete date that moves and is never cleared;
 *     a superseded version still takes it; a supplier document's type, an active code of its list;
 *   - option groups that take a colour or a material;
 *   - the price list PDF as a generated document of a price list version;
 *   - nobody approves their own quote approval or timesheet, the Owner included;
 *   - a receipt line held for a yes: never posted while held;
 *   - the confirm-by and the reminder cadence; a CHASE only while the order waits for goods;
 *   - the partner never reads a whole IBAN (write-only for it), and still proposes an account;
 *   - a FEE line credited against the bulk order, whatever its own order's state; fixed once credited;
 *   - return reasons by group.
 * The refusals are check_violation (23514) or a key's violation; their messages are read through raw SQL.
 */

const NS = 'w2b-363-a'

let db: MigratedDatabase
let factory: FactoryDatabase

const key = (name: string): string => seedUuid(NS, name)
const T = { tenant: key('tenant'), owner: key('actor'), member: key('user:member'), invited: key('user:invited'), companyA: key('company:A'), companyB: key('company:B'), P2: key('party:P2') }
const office = (actorId = T.owner): FactoryScope => ({ audience: 'office', tenantId: T.tenant, actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: T.tenant, actorId: randomUUID(), siteId: key('site:A1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
const idOf = async (text: string, values: unknown[] = []): Promise<string> => (await one(text, values)).id as string
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`

async function seedAll(): Promise<void> {
  const context: SeedContext = { db: factory, namespace: NS }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
}

beforeAll(async () => {
  db = await migratedDatabase('followupssalesw2b5')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await seedAll()
  // Run twice: every seed is idempotent, the new one too.
  await seedAll()
}, 600_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('REMAKE as what the customer would like (B-W2b-346)', () => {
  it('is written at the making, or marked once by the office while the RMA is open; then it never changes', async () => {
    const open = await idOf(`SELECT id::text AS id FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND status = 'AUTHORISED' ORDER BY id LIMIT 1`, [T.tenant])
    const done = await idOf(`SELECT id::text AS id FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND status = 'INSPECTED' ORDER BY id LIMIT 1`, [T.tenant])
    await expect(update(office(), 'ReturnAuthorisation', done, `"outcomeWanted" = 'REMAKE'`)).rejects.toThrow(/the office marks a remake once, while it is REQUESTED, AUTHORISED or RECEIVED/)
    await expect(update(office(), 'ReturnAuthorisation', open, `"outcomeWanted" = 'CREDIT'`)).rejects.toThrow(/never change/)
    expect(await update(office(), 'ReturnAuthorisation', open, `"outcomeWanted" = 'REMAKE'`)).toBe(1)
    expect((await one(`SELECT "outcomeWanted"::text AS wish FROM "ReturnAuthorisation" WHERE id = $1`, [open])).wish).toBe('REMAKE')
    await expect(update(office(), 'ReturnAuthorisation', open, `"outcomeWanted" = 'REPAIR'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'ReturnAuthorisation', open, `"outcomeWanted" = NULL`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'ReturnAuthorisation', open, `"customerNote" = 'Changed.'`)).rejects.toThrow(/never change/)
    // At the making, through a customer's portal request (REQUESTED).
    expect(await copyRow(office(), 'ReturnAuthorisation', open, { id: randomUUID(), number: tag('T-RMA'), status: 'REQUESTED', authorisedAt: null, authorisedById: null, goodsDueBy: null, channel: 'PORTAL', outcomeWanted: 'REMAKE', customerNote: 'The sleeves are too short.' })).toBe(1)
  })
})

describe('the made-to-measure photos and a supplier document type (B-W2b-297, -315, -360)', () => {
  let source: string
  beforeAll(async () => {
    source = key('portal-followups:file:P2:certificate')
  })
  /** A new AVAILABLE file: a copy of P2's certificate (its bytes) with `changes`. */
  const file = async (changes: Record<string, unknown>, scope = office()): Promise<string> => {
    const id = (changes.id as string | undefined) ?? randomUUID()
    const base = { id, storageKey: `t/${T.tenant}/test/${randomUUID()}`, thumbnailKey: null, exifStrippedAt: null, seriesId: null, versionNo: 1, supersededAt: null, sourceFileId: null, status: 'AVAILABLE', scanStatus: 'NOT_SCANNED', scannedAt: null, scanEngine: null, scanFinding: null, expiresOn: null, expiryRemindedAt: null, documentTypeCode: null, deleteAfter: null, retainUntil: null, legalHold: false }
    expect(await copyRow(scope, 'StoredFile', source, { ...base, ...changes })).toBe(1)
    return id
  }
  const photo = (category: string, recordType: string, changes: Record<string, unknown> = {}) =>
    file({ kind: 'PHOTO', contentType: 'image/jpeg', category, recordType, recordId: randomUUID(), companyId: T.companyA, visibility: ['OFFICE'], partyId: null, floorSiteId: null, ...changes })

  it('keeps an office or fitting photo to its record, a PHOTO, and the office only', async () => {
    expect(await photo('MTM_PHOTO', 'MeasurementProfile')).toBeDefined()
    expect(await photo('FITTING_PHOTO', 'FittingResult')).toBeDefined()
    await expect(photo('MTM_PHOTO', 'FittingResult')).rejects.toThrow(/a made-to-measure photo is a PHOTO of a MeasurementProfile \(MTM_PHOTO\) or of a FittingResult/)
    await expect(photo('FITTING_PHOTO', 'FittingResult', { kind: 'DOCUMENT', contentType: 'application/pdf' })).rejects.toThrow(/a made-to-measure photo is a PHOTO/)
    await expect(photo('MTM_PHOTO', 'MeasurementProfile', { visibility: ['OFFICE', 'PARTNER'], partyId: T.P2 })).rejects.toThrow(/the office's only, never shared with a floor, a portal or a link/)
    const later = await photo('MTM_PHOTO', 'MeasurementProfile')
    await expect(update(office(), 'StoredFile', later, `visibility = ARRAY['OFFICE', 'LINK']::"FileAudience"[], "partyId" = $2::uuid`, T.P2)).rejects.toThrow(/the office's only/)
  })

  it('gives only those photos a delete date: not before the retention date, moved but never cleared, fixed once deleted', async () => {
    const id = await photo('FITTING_PHOTO', 'FittingResult')
    const other = await file({ category: 'SUPPLIER_CERTIFICATE' })
    await expect(update(office(), 'StoredFile', other, `"deleteAfter" = now() + interval '90 days'`)).rejects.toThrow(/takes no delete date: only a made-to-measure photo/)
    expect(await update(office(), 'StoredFile', id, `"deleteAfter" = now() + interval '90 days'`)).toBe(1)
    expect(await update(office(), 'StoredFile', id, `"deleteAfter" = now() + interval '10 days'`)).toBe(1)
    await expect(update(office(), 'StoredFile', id, `"deleteAfter" = NULL`)).rejects.toThrow(/moves but is never cleared/)
    await expect(update(office(), 'StoredFile', id, `"retainUntil" = now() + interval '30 days'`)).rejects.toThrow(/never before it is retained until/)
    await expect(photo('MTM_PHOTO', 'MeasurementProfile', { deleteAfter: '2027-01-01T00:00:00Z', retainUntil: '2027-06-01T00:00:00Z' })).rejects.toThrow(/never before it is retained until/)
    expect(await update(office(), 'StoredFile', id, `status = 'DELETED', "deletedAt" = now()`)).toBe(1)
    await expect(update(office(), 'StoredFile', id, `"deleteAfter" = now() + interval '20 days'`)).rejects.toThrow(/a deleted file's stays as it is/)
  })

  it('lets a superseded version still take its delete date, and nothing else', async () => {
    const recordId = randomUUID()
    const first = await photo('MTM_PHOTO', 'MeasurementProfile', { recordId })
    const second = randomUUID()
    await as(office(), (client) =>
      client.$transaction([
        client.$executeRawUnsafe(
          `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(r) || $1::jsonb FROM "StoredFile" r WHERE r.id = $2::uuid))`,
          JSON.stringify({ id: second, storageKey: `t/${T.tenant}/test/${randomUUID()}`, seriesId: first, versionNo: 2 }),
          first,
        ),
        client.$executeRawUnsafe(`UPDATE "StoredFile" SET "supersededAt" = now() WHERE id = $1::uuid`, first),
      ]),
    )
    expect(await update(office(), 'StoredFile', first, `"deleteAfter" = now() + interval '90 days'`)).toBe(1)
    await expect(update(office(), 'StoredFile', first, `category = 'FITTING_PHOTO'`)).rejects.toThrow(/superseded version: it stays as it is/)
  })

  it('names a supplier document type: a code of an active SUPPLIER_DOCUMENT_TYPE reason, only on a vault category', async () => {
    expect((await one(`SELECT "documentTypeCode" FROM "StoredFile" WHERE id = $1`, [source])).documentTypeCode).toBe('LWG_AUDIT')
    const id = await file({ category: 'SUPPLIER_CERTIFICATE' })
    expect(await update(office(), 'StoredFile', id, `"documentTypeCode" = 'DURC'`)).toBe(1)
    await expect(update(office(), 'StoredFile', id, `"documentTypeCode" = 'NOT_A_TYPE'`)).rejects.toThrow(/NOT_A_TYPE is not an active document type of the tenant/)
    await expect(update(office(), 'StoredFile', id, `"documentTypeCode" = 'durc'`)).rejects.toThrow(/is a code \(upper-case letters, digits and underscores, at most 60\)/)
    await expect(file({ category: 'BODY_PHOTO', documentTypeCode: 'DURC' })).rejects.toThrow(/names a document type \(DURC\) only as a supplier certificate, a test report or a declaration/)
    await expect(file({ category: null, documentTypeCode: 'DURC' })).rejects.toThrow(/only as a supplier certificate/)
    // A code switched off is not named again (a file that names it keeps it).
    const iso = await idOf(`SELECT id::text AS id FROM "ReasonCode" WHERE "tenantId" = $1 AND list = 'SUPPLIER_DOCUMENT_TYPE' AND code = 'ISO_9001'`, [T.tenant])
    expect(await update(office(), 'ReasonCode', iso, `active = false, version = version + 1`)).toBe(1)
    await expect(update(office(), 'StoredFile', id, `"documentTypeCode" = 'ISO_9001'`)).rejects.toThrow(/ISO_9001 is not an active document type/)
    expect(await update(office(), 'StoredFile', id, `"expiresOn" = '2027-12-31'`)).toBe(1)
  })

  it('hides the delete date from the floor and the partner, the document type from the floor', async () => {
    for (const column of ['deleteAfter', 'documentTypeCode']) {
      await expect(sql(floor(), `SELECT "${column}" FROM "StoredFile" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    const partner: FactoryScope = { audience: 'partner', tenantId: T.tenant, actorId: randomUUID(), partyId: T.P2 }
    await expect(sql(partner, `SELECT "deleteAfter" FROM "StoredFile" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect((await sql(partner, `SELECT "documentTypeCode" FROM "StoredFile" WHERE id = $1::uuid`, source))[0]).toEqual({ documentTypeCode: 'LWG_AUDIT' })
  })
})

describe('option groups that take a colour or a material (B-W2b-340)', () => {
  it('keeps a COLOUR group\'s options to a library colour and a MATERIAL group\'s to a material', async () => {
    const perforation = key('options:group:PERF')
    const option = await idOf(
      `SELECT o.id::text AS id FROM "QuoteLineOption" o JOIN "QuoteLine" l ON l.id = o."lineId" JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE o."groupId" = $1 AND v.status = 'DRAFT' ORDER BY o.id LIMIT 1`,
      [perforation],
    )
    const colour = await idOf(`SELECT id::text AS id FROM "Colour" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [T.tenant])
    const material = await one(`SELECT "itemId"::text AS item, id::text AS colour FROM "ItemColour" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [T.tenant])
    expect(await update(office(), 'OptionGroup', perforation, `takes = 'COLOUR', version = version + 1`)).toBe(1)
    await expect(update(office(), 'QuoteLineOption', option, `"itemId" = $2::uuid, "itemColourId" = $3::uuid`, material.item, material.colour)).rejects.toThrow(/which takes a colour of the library: it picks no material/)
    expect(await update(office(), 'QuoteLineOption', option, `"colourId" = $2::uuid`, colour)).toBe(1)
    await expect(update(office(), 'OptionGroup', perforation, `takes = 'MATERIAL', version = version + 1`)).rejects.toThrow(/takes a material only once none of its chosen options picks a library colour/)
    expect(await update(office(), 'QuoteLineOption', option, `"colourId" = NULL`)).toBe(1)
    expect(await update(office(), 'OptionGroup', perforation, `takes = 'MATERIAL', version = version + 1`)).toBe(1)
    await expect(update(office(), 'QuoteLineOption', option, `"colourId" = $2::uuid`, colour)).rejects.toThrow(/which takes a material and its colour: it picks no library colour/)
    expect(await update(office(), 'QuoteLineOption', option, `"itemId" = $2::uuid, "itemColourId" = $3::uuid`, material.item, material.colour)).toBe(1)
    // Null again: either, as B-W2b-340's configurator offers today.
    expect(await update(office(), 'OptionGroup', perforation, `takes = NULL, version = version + 1`)).toBe(1)
    expect(await update(office(), 'QuoteLineOption', option, `"itemId" = NULL, "itemColourId" = NULL, "colourId" = $2::uuid`, colour)).toBe(1)
  })
})

describe('the price list PDF (B-W2b-325, -343)', () => {
  it('is a generated document of a price list version, of its list\'s company, without a site', async () => {
    const version = await idOf(`SELECT v.id::text AS id FROM "PriceListVersion" v JOIN "PriceList" l ON l.id = v."listId" WHERE l."tenantId" = $1 AND l."companyId" = $2 ORDER BY v.id LIMIT 1`, [T.tenant, T.companyA])
    const source = key('portal-followups:file:P2:certificate')
    const pdf = randomUUID()
    expect(await copyRow(office(), 'StoredFile', source, { id: pdf, storageKey: `t/${T.tenant}/test/${randomUUID()}`, kind: 'DOCUMENT', category: null, documentTypeCode: null, recordType: 'PriceListVersion', recordId: version, companyId: T.companyA, visibility: ['OFFICE'], partyId: null, thumbnailKey: null, exifStrippedAt: null, scanStatus: 'NOT_SCANNED', scannedAt: null, scanEngine: null, scanFinding: null, expiresOn: null, seriesId: null, versionNo: 1, supersededAt: null })).toBe(1)
    const insert = (changes: Record<string, unknown>) => {
      const row = { id: randomUUID(), companyId: T.companyA, siteId: null, recordType: 'PriceListVersion', recordId: version, kind: 'PRICE_LIST', version: 1, fingerprint: 'a'.repeat(64), language: 'it', layout: null, number: null, fileId: pdf, createdById: T.owner, ...changes }
      return run(office(), `INSERT INTO "GeneratedDocument" SELECT * FROM jsonb_populate_record(NULL::"GeneratedDocument", $1::jsonb || jsonb_build_object('tenantId', $2::text, 'createdAt', now()))`, JSON.stringify(row), T.tenant)
    }
    await expect(insert({ recordType: 'PriceList' })).rejects.toThrow(/a price list a PriceListVersion's/)
    await expect(insert({ companyId: T.companyB })).rejects.toThrow(/is of the company and site of its PriceListVersion/)
    expect(await insert({})).toBe(1)
  })
})

describe('nobody approves their own request (B-W2b-276, -282; Owner answer Q3 = A)', () => {
  it('refuses a quote approval decided by the person who asked, the Owner included; a reopen by the asker passes', async () => {
    const decided = await idOf(`SELECT id::text AS id FROM "QuoteApproval" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [T.tenant])
    const ask = async (by: string) => {
      const id = randomUUID()
      expect(await copyRow(office(by), 'QuoteApproval', decided, { id, status: 'PENDING', decidedAt: null, decidedById: null, decisionNote: null, createdById: by, version: 1 })).toBe(1)
      return id
    }
    const byOwner = await ask(T.owner)
    await expect(update(office(), 'QuoteApproval', byOwner, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, T.owner)).rejects.toThrow(/nobody approves their own request, the Owner included/)
    await expect(update(office(), 'QuoteApproval', byOwner, `status = 'REJECTED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, T.owner)).rejects.toThrow(/nobody approves their own request/)
    expect(await update(office(T.member), 'QuoteApproval', byOwner, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, T.member)).toBe(1)
    const reopened = await ask(T.member)
    expect(await update(office(T.member), 'QuoteApproval', reopened, `status = 'WITHDRAWN', "decidedAt" = now(), version = version + 1`)).toBe(1)
    await expect(copyRow(office(), 'QuoteApproval', decided, { id: randomUUID(), status: 'APPROVED', decidedAt: new Date().toISOString(), decidedById: T.member, createdById: T.member })).rejects.toThrow(/nobody approves their own request/)
  })

  it("refuses a timesheet approved by the person's own office account (the employee's, or a floor worker's)", async () => {
    const sheet = await one(`SELECT t.id::text AS id, t."employeeId"::text AS employee FROM "TimesheetApproval" t WHERE t."tenantId" = $1 AND t.status = 'PENDING' ORDER BY t.id LIMIT 1`, [T.tenant])
    const lead = (by: string) => update(office(by), 'TimesheetApproval', sheet.id as string, `status = 'LEAD_APPROVED', "leadApprovedAt" = now(), "leadApprovedById" = $2::uuid, version = version + 1`, by)
    // The employee's own office account (the invited person's, linked to no other employee).
    const own = T.invited
    await admin(`UPDATE "Employee" SET "userId" = $2::uuid WHERE id = $1::uuid`, [sheet.employee, own])
    await expect(lead(own)).rejects.toThrow(/nobody approves their own timesheet, the Owner included/)
    // A floor worker's office account of that employee.
    await admin(`UPDATE "Employee" SET "userId" = NULL WHERE id = $1::uuid`, [sheet.employee])
    expect((await admin(`UPDATE "Worker" SET "userId" = $2::uuid WHERE "employeeId" = $1::uuid RETURNING id`, [sheet.employee, own])).length).toBeGreaterThan(0)
    await expect(lead(own)).rejects.toThrow(/nobody approves their own timesheet/)
    expect(await lead(T.owner)).toBe(1)
    const hr = (by: string) => update(office(by), 'TimesheetApproval', sheet.id as string, `status = 'APPROVED', "hrApprovedAt" = now(), "hrApprovedById" = $2::uuid, version = version + 1`, by)
    await expect(hr(own)).rejects.toThrow(/nobody approves their own timesheet/)
    expect(await hr(T.member)).toBe(1)
  })
})

describe('a receipt beyond its tolerance waits for a yes (B-W2b-296)', () => {
  it('holds a line at a time not in the future, and never posts a receipt with a held line', async () => {
    const receipt = await one(`SELECT r.id::text AS id, l.id::text AS line FROM "GoodsReceipt" r JOIN "GoodsReceiptLine" l ON l."receiptId" = r.id WHERE r."tenantId" = $1 AND r.number = 'SEED-GR-0002'`, [T.tenant])
    await expect(update(office(), 'GoodsReceiptLine', receipt.line as string, `"heldForApprovalAt" = now() + interval '1 day'`)).rejects.toThrow(/held for a yes from a time not in the future/)
    expect(await update(office(), 'GoodsReceiptLine', receipt.line as string, `"heldForApprovalAt" = now()`)).toBe(1)
    await expect(update(office(), 'GoodsReceipt', receipt.id as string, `status = 'POSTED', "postedAt" = now(), "postedById" = $2::uuid`, T.owner)).rejects.toThrow(/line\(s\) beyond the delivery tolerance waiting for a yes/)
    expect(await update(office(), 'GoodsReceiptLine', receipt.line as string, `"heldForApprovalAt" = NULL`)).toBe(1)
    const posted = await idOf(`SELECT l.id::text AS id FROM "GoodsReceiptLine" l JOIN "GoodsReceipt" r ON r.id = l."receiptId" WHERE r."tenantId" = $1 AND r.status = 'POSTED' ORDER BY l.id LIMIT 1`, [T.tenant])
    await expect(update(office(), 'GoodsReceiptLine', posted, `"heldForApprovalAt" = now()`)).rejects.toThrow(/its lines change only while it is OPEN/)
  })
})

describe('chase reminders and the confirm-by setting (B-W2b-305, -354)', () => {
  it('keeps the confirm-by to 1-720 hours and the cadence to 1-30 days', async () => {
    const settings = await idOf(`SELECT id::text AS id FROM "PurchasingSettings" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [T.tenant])
    for (const set of [`"confirmByHours" = 0`, `"confirmByHours" = 721`, `"reminderCadenceDays" = 0`, `"reminderCadenceDays" = 31`]) {
      await expect(update(office(), 'PurchasingSettings', settings, set)).rejects.toThrow(/confirm within 1 to 720 hours and remind them every 1 to 30 days/)
    }
    expect(await update(office(), 'PurchasingSettings', settings, `"confirmByHours" = 72, "reminderCadenceDays" = 2`)).toBe(1)
    expect(await update(office(), 'PurchasingSettings', settings, `"confirmByHours" = NULL, "reminderCadenceDays" = NULL`)).toBe(1)
  })

  it('sends a CHASE only to an order that waits for goods, for its current revision', async () => {
    const chase = (status: string, revision = 'o.revision') =>
      run(
        office(),
        `INSERT INTO "PurchaseOrderReminder" (id, "purchaseOrderId", "partyId", "siteId", revision, kind, "sentAt", "sentById", "createdById")
         SELECT gen_random_uuid(), o.id, o."partyId", o."siteId", ${revision}, 'CHASE', now(), $2::uuid, $2::uuid FROM "PurchaseOrder" o WHERE o."tenantId" = $1::uuid AND o.status = '${status}' ORDER BY o.id LIMIT 1`,
        T.tenant,
        T.owner,
      )
    await expect(chase('DRAFT')).rejects.toThrow(/a chase goes only to an order that waits for goods/)
    await expect(chase('CONFIRMED', 'o.revision + 1')).rejects.toThrow(/for its current revision/)
    for (const status of ['SENT', 'CONFIRMED', 'PARTLY_RECEIVED']) expect(await chase(status)).toBe(1)
  })
})

describe("a supplier's IBAN (B-W2b-287, -315)", () => {
  it('is write-only for the partner: it proposes an account and reads back only the last four characters', async () => {
    const entry = loadOwnership().find(({ file }) => file === 'suppliers-depth.json')!.data as { models: Record<string, { access: Record<string, { writeOnlyColumns?: string[] }> }> }
    expect(entry.models.SupplierBankAccount!.access.factory_partner_runtime!.writeOnlyColumns).toEqual(['iban'])
    const supplier = await idOf(`SELECT u.id::text AS id FROM "User" u WHERE u."tenantId" = $1 AND u."partyId" = $2 AND u.status = 'ACTIVE' ORDER BY u.id LIMIT 1`, [T.tenant, T.P2])
    const partner: FactoryScope = { audience: 'partner', tenantId: T.tenant, actorId: supplier, partyId: T.P2 }
    await expect(sql(partner, `SELECT iban FROM "SupplierBankAccount" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner, `SELECT id FROM "SupplierBankAccount" WHERE iban LIKE 'IT%'`)).rejects.toThrow(/permission denied/)
    const own = await sql(partner, `SELECT "ibanCountry", "ibanLast4" FROM "SupplierBankAccount" ORDER BY id`)
    expect(own.length).toBeGreaterThan(0)
    // A proposal still works (no RETURNING of the IBAN); the database gives the masked columns.
    const iban = 'IT27X0000000000000000315004'
    const propose = () =>
      run(partner, `INSERT INTO "SupplierBankAccount" (id, "partyId", iban, holder, currency, "proposedById", "proposedAt") VALUES ($1::uuid, $2::uuid, $3, 'Seed Leather Supplier S.p.A.', 'USD', $4::uuid, now())`, randomUUID(), T.P2, iban, supplier)
    expect(await propose()).toBe(1)
    expect((await one(`SELECT "ibanCountry", "ibanLast4" FROM "SupplierBankAccount" WHERE iban = $1`, [iban]))).toEqual({ ibanCountry: 'IT', ibanLast4: '5004' })
  })
})

describe('a FEE line credited against the bulk order (SAL-181)', () => {
  let fee: string
  let feeOrder: string
  let bulk: string
  beforeAll(async () => {
    const line = await one(
      `SELECT l.id::text AS id, o.id::text AS "order" FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0002' AND l.kind <> 'FEE' ORDER BY l.seq LIMIT 1`,
      [T.tenant],
    )
    bulk = await idOf(`SELECT id::text AS id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T.tenant])
    // The fee's own order: a new order of the same company and customer.
    feeOrder = randomUUID()
    expect(await copyRow(office(), 'SalesOrder', line.order as string, { id: feeOrder, number: tag('T-SO'), quoteVersionId: null })).toBe(1)
    fee = randomUUID()
    expect(await copyRow(office(), 'SalesOrderLine', line.id as string, { id: fee, orderId: feeOrder, seq: 10, kind: 'FEE', feeKind: 'DEVELOPMENT', quantity: 1, quoteLineId: null, priceSteps: null, measurementProfileId: null })).toBe(1)
  })

  it('credits only a FEE line, against another order of its company and customer with goods lines, not cancelled', async () => {
    const goods = await idOf(`SELECT l.id::text AS id FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0003' AND l.kind <> 'FEE' ORDER BY l.seq LIMIT 1`, [T.tenant])
    await expect(update(office(), 'SalesOrderLine', goods, `"feeCreditOrderId" = $2::uuid`, bulk)).rejects.toThrow(/credited against a bulk order only as a FEE line/)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditOrderId" = $2::uuid`, feeOrder)).rejects.toThrow(/never against its own order/)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditOrderId" = $2::uuid`, randomUUID())).rejects.toThrow(/foreign key/)
    // An order with no goods line, and a cancelled one.
    const empty = randomUUID()
    expect(await copyRow(office(), 'SalesOrder', bulk, { id: empty, number: tag('T-SO'), quoteVersionId: null })).toBe(1)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditOrderId" = $2::uuid`, empty)).rejects.toThrow(/against a bulk order with goods lines that is not cancelled \(this one is CONFIRMED, with 0 goods line/)
    const cancelled = randomUUID()
    expect(await copyRow(office(), 'SalesOrder', bulk, { id: cancelled, number: tag('T-SO'), quoteVersionId: null })).toBe(1)
    expect(await copyRow(office(), 'SalesOrderLine', goods, { id: randomUUID(), orderId: cancelled, quoteLineId: null })).toBe(1)
    expect(await update(office(), 'SalesOrder', cancelled, `status = 'CANCELLED', "cancelReason" = 'Test.', "closedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditOrderId" = $2::uuid`, cancelled)).rejects.toThrow(/this one is CANCELLED/)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditedAt" = now()`)).rejects.toThrow(/against the bulk order it names/)
    expect(await update(office(), 'SalesOrderLine', fee, `"feeCreditOrderId" = $2::uuid`, bulk)).toBe(1)
  })

  it('takes its credit whatever its own order\'s state, not in the future; once credited both stay', async () => {
    expect(await update(office(), 'SalesOrder', feeOrder, `status = 'CANCELLED', "cancelReason" = 'The fee stays.', "closedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'SalesOrderLine', fee, `note = 'Changed.'`)).rejects.toThrow(/its lines change only while it is CONFIRMED, IN_PRODUCTION or READY/)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditedAt" = now() + interval '1 day'`)).rejects.toThrow(/credited at a time not in the future/)
    expect(await update(office(), 'SalesOrderLine', fee, `"feeCreditedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditOrderId" = NULL`)).rejects.toThrow(/was credited against its bulk order at .*; that stays as it is/)
    await expect(update(office(), 'SalesOrderLine', fee, `"feeCreditedAt" = now() - interval '1 hour'`)).rejects.toThrow(/that stays as it is/)
    expect((await admin(`SELECT count(*)::int AS n FROM "SalesOrderLine" WHERE "feeCreditOrderId" = $1`, [bulk]))[0]).toEqual({ n: 1 })
  })
})

describe('return reasons by group (B-W2b-348)', () => {
  it('keeps the seed\'s groups and refuses blank, multi-line or padded words', async () => {
    const rows = await admin(`SELECT code, "group" FROM "ReasonCode" WHERE "tenantId" = $1 AND list = 'RETURN' ORDER BY code`, [T.tenant])
    expect(rows).toEqual([
      { code: 'DAMAGED_IN_TRANSIT', group: 'Spedizione' },
      { code: 'DEFECT', group: 'Qualità' },
      { code: 'OTHER', group: null },
      { code: 'WRONG_ITEM', group: 'Spedizione' },
      { code: 'WRONG_SIZE', group: 'Taglia' },
    ])
    const other = await idOf(`SELECT id::text AS id FROM "ReasonCode" WHERE "tenantId" = $1 AND list = 'RETURN' AND code = 'OTHER'`, [T.tenant])
    for (const words of [' Altro', 'Altro ', '', 'Al\ntro', 'x'.repeat(121)]) {
      await expect(update(office(), 'ReasonCode', other, `"group" = $2, version = version + 1`, words)).rejects.toThrow(/1 to 120 characters of one line, with no space at either end/)
    }
    expect(await update(office(), 'ReasonCode', other, `"group" = 'Altro', version = version + 1`)).toBe(1)
  })
})
