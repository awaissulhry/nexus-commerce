import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAccounting, type AccountingSeed } from '../seed/accounting'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFollowups, type FollowupsQualityMoneySeed } from '../seed/followups-quality-money'
import { seed as seedHolds, type HoldsSeed } from '../seed/holds'
import { seed as seedPlanning } from '../seed/planning'
import { seed as seedQuality, type QualitySeed } from '../seed/quality'
import { seed as seedQualityLab } from '../seed/quality-lab'
import { seed as seedReceivables, type ReceivablesSeed } from '../seed/receivables'
import { seed as seedSchedule, type ScheduleSeed } from '../seed/schedule'
import { seed as seedSourcing, type SourcingSeed } from '../seed/sourcing'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2b schema wave 2/7 (the W2a follow-ups for quality, planning and money) beyond the generated isolation tests, on a
 * database built from the migrations and seeded, through the real login and the scoped client
 * (…_followups_quality_money_w2b_guards):
 *   - the walls: the six new tables are the office's; the seeds are idempotent;
 *   - holds and NCRs are floor document kinds; a hold's number is given once;
 *   - a containment action's cancel reason, an inspection's due time (the office's), the default containment time;
 *   - a certificate renewal's application log;
 *   - a carried firm line made planned again; the PO reminder switch;
 *   - the scrap of a rework opened by hand; a company's costing method apart from the overhead;
 *   - supplier invoices: a voided one frees its number, files of several invoices (lotto), the claim a credit note
 *     settles; the payables settings; the SDI inbox;
 *   - a PAID deposit that issues no deposit invoice carried onto its order's invoice in one command;
 *   - a refund's reason; the half-year reference rates.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b2-a'
const DENIED = /permission denied/
const TABLES = ['CertificateRenewal', 'InterestReferenceRate', 'PayablesSettings', 'PurchasingSettings', 'SdiInboxItem', 'SupplierInvoiceFile'] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let followups: FollowupsQualityMoneySeed
let holds: HoldsSeed
let quality: QualitySeed
let schedule: ScheduleSeed
let sourcing: SourcingSeed
let receivables: ReceivablesSeed
let accounting: AccountingSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  invoiceSeries: key('series:A:INVOICE:MAIN:2026'),
  holdSeries: `ffffffff${key('series:A:HOLD:MAIN:2026').slice(8)}`,
  ncrSeries: `ffffffff${key('series:A:NCR:MAIN:2026').slice(8)}`,
  jacketCertificate: key('compliance:certificate:JKT-01'),
  protectorCertificate: key('compliance:certificate:PRO-300'),
  orderSO2: key('production:sales-order:SO-0002'),
  sdiAccount: key('integration:account:sdi'),
}
const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01' }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000001016', name: 'Seed Customer One S.r.l.', sdiCode: 'SEEDC01' }

const office = (actorId: string = a.actorId): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]))[0]!.n)
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
const tag = (): string => randomUUID().slice(0, 8)
let counter = 0

beforeAll(async () => {
  db = await migratedDatabase('followupsw2b2')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  followups = await seedFollowups({ db: factory, namespace: NS })
  receivables = await seedReceivables({ db: factory, namespace: NS })
  accounting = await seedAccounting({ db: factory, namespace: NS })
  holds = await seedHolds({ db: factory, namespace: NS })
  quality = await seedQuality({ db: factory, namespace: NS })
  schedule = await seedSchedule({ db: factory, namespace: NS })
  sourcing = await seedSourcing({ db: factory, namespace: NS })
  await seedPlanning({ db: factory, namespace: NS })
  // The office users (an approver to list) and the tenant-wide quality settings.
  await seedAuth({ db: factory, namespace: NS })
  await seedQualityLab({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers: invoices as the issuing command writes them (…_money_guards; as money-w2a's test) ---------------------

const totals = (net: number) => {
  const vat = Math.round((net * 22) / 100)
  return { netTotal: net, vatTotal: vat, grossTotal: net + vat, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat, rounding: 0 }] }
}
async function draft(extra: Record<string, unknown> = {}): Promise<string> {
  const row = { id: randomUUID(), companyId: A.companyA, buyerPartyId: A.P1, docType: 'TD01', priceBasis: 'NET', billTo: BILL_TO, ...totals(10000), ...extra }
  const id = row.id as string
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', row))
      await tx.$executeRawUnsafe(
        ...insertSql('InvoiceLine', {
          id: randomUUID(),
          invoiceId: id,
          buyerPartyId: A.P1,
          seq: 1,
          kind: 'GOODS',
          description: 'Test jacket',
          quantity: '1',
          unitPrice: `${Number(row.netTotal) / 100}`,
          netAmount: row.netTotal,
          vatRatePct: '22.00',
        }),
      )
    }),
  )
  return id
}
async function issue(invoiceId: string, date = '2026-11-15'): Promise<void> {
  const number = `T-${tag()}-${++counter}`
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        ...insertSql('NumberAllocation', {
          id: randomUUID(),
          companyId: A.companyA,
          seriesId: A.invoiceSeries,
          kind: 'INVOICE',
          value: 300_000 + counter,
          formatted: number,
          documentDate: date,
          recordType: 'Invoice',
          recordId: invoiceId,
          allocatedAt: new Date().toISOString(),
          allocatedById: a.actorId,
          requestId: `test-${tag()}`,
        }),
      )
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = $4, "issueDate" = $5::date, "issuedAt" = now(),
           "issuedById" = $6::uuid, "partyId" = "buyerPartyId", seller = $7::jsonb WHERE id = $1::uuid`,
        invoiceId,
        A.invoiceSeries,
        number,
        Number(date.slice(0, 4)),
        date,
        a.actorId,
        JSON.stringify(SELLER),
      )
    }),
  )
}
const supplierInvoiceRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  partyId: A.P2,
  source: 'MANUAL',
  kind: 'INVOICE',
  number: `M-${tag()}`,
  issueDate: '2026-11-10',
  receivedOn: '2026-11-12',
  netTotal: 1000,
  vatTotal: 220,
  grossTotal: 1220,
  vatSummary: [],
  createdById: a.actorId,
  ...extra,
})

// --- the seeds and the walls ----------------------------------------------------------------------------------------

describe('the seeds and the walls', () => {
  it('the seeds are idempotent: a second run writes nothing new', async () => {
    const before = await Promise.all(TABLES.map(count))
    await seedFollowups({ db: factory, namespace: NS })
    expect(await Promise.all(TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
    expect(await count('SupplierInvoice')).toBeGreaterThanOrEqual(3)
  })

  it('the new tables are the office’s: the floor and the portal read none of them', async () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => (TABLES as readonly string[]).includes(model.name))
    expect(models.map(({ model }) => model.name).sort()).toEqual([...TABLES].sort())
    for (const { model, ownership } of models) {
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      expect(ownership.access[FLOOR_ROLE], model.name).toBeUndefined()
      await expect(sql(floor(), `SELECT id FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
    }
  })

  it('the seeded lotto is recorded with its two bodies, and the reminders switch is off', async () => {
    const bodies = await sql(office(), `SELECT "sdiBodyIndex" AS body, "sdiIdentifier" AS sdi FROM "SupplierInvoice" WHERE "sdiFileId" = $1::uuid ORDER BY 1`, followups.supplierInvoiceFileId)
    expect(bodies).toEqual([
      { body: 1, sdi: 'SEED-SDI-IN-0000002' },
      { body: 2, sdi: 'SEED-SDI-IN-0000002' },
    ])
    const [settings] = await sql(office(), `SELECT "confirmationRemindersEnabled" AS on FROM "PurchasingSettings" WHERE id = $1::uuid`, followups.purchasingSettingsId)
    expect(settings).toEqual({ on: false })
  })
})

// --- numbering: holds and NCRs at the bench -------------------------------------------------------------------------

describe('holds and NCRs are numbered at the bench', () => {
  it('the floor sees its company’s HOLD and NCR series, takes a hold number, and still never a fiscal series', async () => {
    const kinds = (await sql(floor(), `SELECT DISTINCT kind::text AS kind FROM "NumberSeries"`)).map((row) => row.kind)
    expect(kinds).toEqual(expect.arrayContaining(['HOLD', 'NCR', 'INSPECTION']))
    expect(kinds).not.toContain('INVOICE')
    const [series] = await sql(floor(), `SELECT "nextValue" AS next FROM "NumberSeries" WHERE id = $1::uuid`, A.holdSeries)
    const value = Number(series!.next)
    await as(floor(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          ...insertSql('NumberAllocation', {
            id: randomUUID(),
            companyId: A.companyA,
            seriesId: A.holdSeries,
            kind: 'HOLD',
            value,
            formatted: `HLD-2026-${String(value).padStart(4, '0')}`,
            documentDate: '2026-11-20',
            recordType: 'QualityHold',
            recordId: randomUUID(),
            allocatedAt: new Date().toISOString(),
            allocatedById: randomUUID(),
            requestId: `test-${tag()}`,
          }),
        )
        await tx.$executeRawUnsafe(`UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 1 WHERE id = $1::uuid`, A.holdSeries)
      }),
    )
    const [after] = await sql(office(), `SELECT "nextValue" AS next FROM "NumberSeries" WHERE id = $1::uuid`, A.holdSeries)
    expect(Number(after!.next)).toBe(value + 1)
    await expect(sql(floor(), `UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 5 WHERE id = $1::uuid RETURNING id`, A.ncrSeries)).rejects.toThrow(/one number at a time/)
    await expect(
      insert(floor(), 'NumberAllocation', {
        id: randomUUID(),
        companyId: A.companyA,
        seriesId: A.invoiceSeries,
        kind: 'INVOICE',
        value: 900_000,
        formatted: `FT-X-${tag()}`,
        documentDate: '2026-11-20',
        recordType: 'Invoice',
        recordId: randomUUID(),
        allocatedAt: new Date().toISOString(),
        allocatedById: randomUUID(),
        requestId: `test-${tag()}`,
      }),
    ).rejects.toThrow(/row-level security/)
  })

  it('a hold’s number is given once (null before), never changes and is never blank', async () => {
    const number = `HLD-2026-${tag()}`
    await expect(run(office(), `UPDATE "QualityHold" SET number = '  ' WHERE id = $1::uuid`, holds.holdId)).rejects.toThrow(/never blank/)
    expect(await run(office(), `UPDATE "QualityHold" SET number = $2 WHERE id = $1::uuid`, holds.holdId, number)).toBe(1)
    await expect(run(office(), `UPDATE "QualityHold" SET number = $2 WHERE id = $1::uuid`, holds.holdId, `${number}-2`)).rejects.toThrow(/never changes/)
    await expect(run(floor(), `UPDATE "QualityHold" SET number = NULL WHERE id = $1::uuid`, holds.holdId)).rejects.toThrow(/floor confirms the quarantine move|never changes/)
    expect(await run(office(), `UPDATE "QualityHold" SET number = number WHERE id = $1::uuid`, holds.holdId)).toBe(1)
  })
})

// --- quality ----------------------------------------------------------------------------------------------------------

describe('quality follow-ups', () => {
  it('a containment action says why it was cancelled, only with the move to CANCELLED', async () => {
    const [ncr] = await sql(office(), `SELECT "siteId" AS site FROM "Nonconformance" WHERE id = $1::uuid`, holds.openNcrId)
    const action = (row: Record<string, unknown>) =>
      insert(office(), 'NcrContainmentAction', { id: randomUUID(), siteId: ncr!.site, ncrId: holds.openNcrId, seq: 500 + ++counter, kind: 'OTHER', description: 'Check the second lot', ...row })
    await expect(action({ cancelReason: 'Not needed' })).rejects.toThrow(/only when CANCELLED/)
    const id = randomUUID()
    expect(await action({ id })).toBe(1)
    await expect(run(office(), `UPDATE "NcrContainmentAction" SET status = 'CANCELLED', "cancelReason" = ' ' WHERE id = $1::uuid`, id)).rejects.toThrow(/only when CANCELLED, in words/)
    expect(await run(office(), `UPDATE "NcrContainmentAction" SET status = 'CANCELLED', "cancelReason" = 'The supplier took the lot back' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `UPDATE "NcrContainmentAction" SET "cancelReason" = 'Another reason' WHERE id = $1::uuid`, id)).rejects.toThrow(/never changes/)
  })

  it('an inspection’s due time is the office’s; a decided inspection keeps it', async () => {
    expect(await run(office(), `UPDATE "Inspection" SET "dueAt" = '2026-11-25T16:00:00Z' WHERE id = $1::uuid`, quality.openInspectionId)).toBe(1)
    await expect(run(floor(), `UPDATE "Inspection" SET "dueAt" = '2026-11-26T16:00:00Z' WHERE id = $1::uuid`, quality.openInspectionId)).rejects.toThrow(/office sets by when/)
    await expect(run(office(), `UPDATE "Inspection" SET "dueAt" = now() WHERE id = $1::uuid`, quality.passedInspectionId)).rejects.toThrow(/never changes/)
  })

  it('the default containment time is 1 to 720 hours; who may release is a setting', async () => {
    const [settings] = await sql(office(), `SELECT id FROM "QualitySettings" ORDER BY id LIMIT 1`)
    const set = (assignment: string) => run(office(), `UPDATE "QualitySettings" SET ${assignment} WHERE id = $1::uuid`, settings!.id)
    await expect(set(`"defaultContainmentHours" = 0`)).rejects.toThrow(/1 to 720 hours/)
    await expect(set(`"defaultContainmentHours" = 721`)).rejects.toThrow(/1 to 720 hours/)
    expect(await set(`"defaultContainmentHours" = 48, "placerMayRelease" = true`)).toBe(1)
    expect(await set(`"defaultContainmentHours" = NULL, "placerMayRelease" = NULL`)).toBe(1)
  })
})

// --- compliance -----------------------------------------------------------------------------------------------------

describe('a certificate renewal’s application log', () => {
  const renewal = (row: Record<string, unknown> = {}) =>
    insert(office(), 'CertificateRenewal', {
      id: randomUUID(),
      certificateId: A.jacketCertificate,
      windowOpensOn: '2030-01-14',
      windowClosesOn: '2030-07-14',
      startedAt: new Date().toISOString(),
      startedById: a.actorId,
      ...row,
    })
  const move = (id: string, assignment: string, ...values: unknown[]) => run(office(), `UPDATE "CertificateRenewal" SET ${assignment} WHERE id = $1::uuid`, id, ...values)

  it('starts STARTED with its window; is applied once (never ahead of the day), then renewed by another certificate, then frozen', async () => {
    await expect(renewal({ status: 'APPLIED' })).rejects.toThrow(/starts STARTED/)
    await expect(renewal({ windowOpensOn: '2030-08-01' })).rejects.toThrow(/first day on or before its last/)
    const id = randomUUID()
    expect(await renewal({ id })).toBe(1)
    await expect(move(id, `status = 'APPLIED'`)).rejects.toThrow(/wrong application/)
    await expect(move(id, `status = 'APPLIED', "appliedOn" = (now() AT TIME ZONE 'Europe/Rome')::date + 2, "appliedAt" = now(), "appliedInWindow" = false`)).rejects.toThrow(/after the day it was recorded/)
    expect(await move(id, `status = 'APPLIED', "appliedOn" = (now() AT TIME ZONE 'Europe/Rome')::date, "appliedAt" = now(), "appliedById" = $2::uuid, "appliedInWindow" = false, "applicationReference" = 'NB-REQ-1'`, a.actorId)).toBe(1)
    await expect(move(id, `"applicationReference" = 'NB-REQ-2'`)).rejects.toThrow(/recorded once/)
    await expect(move(id, `"certificateId" = $2::uuid`, A.protectorCertificate)).rejects.toThrow(/never change/)
    await expect(move(id, `status = 'RENEWED', "newCertificateId" = "certificateId", "renewedAt" = now()`)).rejects.toThrow(/another one/)
    await expect(move(id, `status = 'STARTED', "appliedOn" = NULL, "appliedAt" = NULL, "appliedById" = NULL, "appliedInWindow" = NULL, "applicationReference" = NULL`)).rejects.toThrow(/recorded once|cannot move/)
    expect(await move(id, `status = 'RENEWED', "newCertificateId" = $2::uuid, "renewedAt" = now(), "renewedById" = $3::uuid`, A.protectorCertificate, a.actorId)).toBe(1)
    await expect(move(id, `note = 'later'`)).rejects.toThrow(/it never changes/)
    await expect(admin(`DELETE FROM "CertificateRenewal" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
    await expect(run(office(), `DELETE FROM "CertificateRenewal" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
  })

  it('is cancelled with when and why; the task is named once', async () => {
    const id = randomUUID()
    expect(await renewal({ id })).toBe(1)
    expect(await move(id, `"taskId" = $2::uuid`, randomUUID())).toBe(1)
    await expect(move(id, `"taskId" = $2::uuid`, randomUUID())).rejects.toThrow(/task once/)
    await expect(move(id, `status = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/wrong cancellation/)
    expect(await move(id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2::uuid, "cancelReason" = 'The style is no longer made'`, a.actorId)).toBe(1)
    await expect(move(id, `status = 'APPLIED'`)).rejects.toThrow(/never changes/)
  })
})

// --- planning and purchasing ----------------------------------------------------------------------------------------

describe('a carried firm line made planned again; the PO reminder switch', () => {
  it('a line carrying a firm order is written firm, and may then be made planned again (it keeps what it carried)', async () => {
    const [from] = await admin(
      `SELECT m.id, m."itemId" AS item, m."itemColourId" AS colour, m.action::text AS action, m.uom FROM "MaterialRequirement" m
        JOIN "PlanningRun" r ON r."tenantId" = m."tenantId" AND r.id = m."runId"
       WHERE m."tenantId" = $1 AND m."siteId" = $2 AND m."firmedAt" IS NOT NULL AND r.status = 'DONE' ORDER BY m.id LIMIT 1`,
      [a.tenantId, A.siteA],
    )
    expect(from).toBeDefined()
    const runId = randomUUID()
    await insert(office(), 'PlanningRun', { id: runId, companyId: A.companyA, siteId: A.siteA, trigger: 'MANUAL', startedAt: new Date(Date.now() - 60_000).toISOString() })
    const line = (row: Record<string, unknown> = {}) =>
      insert(office(), 'MaterialRequirement', {
        id: randomUUID(),
        siteId: A.siteA,
        runId,
        seq: 1 + ++counter,
        itemId: from!.item,
        itemColourId: from!.colour,
        action: from!.action,
        uom: from!.uom,
        grossQuantity: '10',
        usableStock: '0',
        heldStock: '0',
        onOrder: '0',
        netQuantity: '10',
        suggestedQuantity: '10',
        suggestedUom: from!.uom,
        needDate: '2026-12-01',
        sources: [],
        firmQuantity: '10',
        firmBaseQuantity: '10',
        firmDate: '2026-12-01',
        firmedAt: new Date().toISOString(),
        firmedById: a.actorId,
        firmCarriedFromId: from!.id,
        ...row,
      })
    await expect(line({ firmQuantity: null, firmBaseQuantity: null, firmDate: null, firmedAt: null, firmedById: null })).rejects.toThrow(/so it is firm when it is written/)
    const id = randomUUID()
    expect(await line({ id })).toBe(1)
    expect(await run(office(), `UPDATE "PlanningRun" SET status = 'DONE', "finishedAt" = now() WHERE id = $1::uuid`, runId)).toBe(1)
    expect(
      await run(office(), `UPDATE "MaterialRequirement" SET "firmQuantity" = NULL, "firmBaseQuantity" = NULL, "firmDate" = NULL, "firmSupplierId" = NULL, "firmedAt" = NULL, "firmedById" = NULL WHERE id = $1::uuid`, id),
    ).toBe(1)
    const [unfirmed] = await sql(office(), `SELECT "firmedAt" AS firmed, "firmCarriedFromId" AS carried FROM "MaterialRequirement" WHERE id = $1::uuid`, id)
    expect(unfirmed).toEqual({ firmed: null, carried: from!.id })
    await expect(run(office(), `UPDATE "MaterialRequirement" SET "firmCarriedFromId" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/snapshot/)
    expect(await run(office(), `UPDATE "MaterialRequirement" SET "firmQuantity" = 4, "firmBaseQuantity" = 4, "firmDate" = '2026-12-02', "firmedAt" = now() WHERE id = $1::uuid`, id)).toBe(1)
  })

  it('the purchasing settings are switched, never deleted, and keep their company', async () => {
    expect(await run(office(), `UPDATE "PurchasingSettings" SET "confirmationRemindersEnabled" = true WHERE id = $1::uuid`, followups.purchasingSettingsId)).toBe(1)
    expect(await run(office(), `UPDATE "PurchasingSettings" SET "confirmationRemindersEnabled" = false WHERE id = $1::uuid`, followups.purchasingSettingsId)).toBe(1)
    await expect(run(office(), `UPDATE "PurchasingSettings" SET "companyId" = NULL WHERE id = $1::uuid`, followups.purchasingSettingsId)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "PurchasingSettings" WHERE id = $1::uuid`, [followups.purchasingSettingsId])).rejects.toThrow(/never deleted/)
    await expect(admin(`TRUNCATE "PurchasingSettings"`)).rejects.toThrow(/TRUNCATE/)
  })
})

// --- costing ----------------------------------------------------------------------------------------------------------

describe('costing follow-ups', () => {
  const scrap = (row: Record<string, unknown>) =>
    insert(office(), 'WorkOrderCostEntry', {
      id: randomUUID(),
      companyId: A.companyA,
      siteId: A.siteA,
      workOrderId: schedule.production.workOrderId,
      kind: 'SCRAP',
      occurredAt: new Date().toISOString(),
      amount: 0,
      currency: 'EUR',
      costingMethod: 'UNDECIDED',
      idempotencyKey: `test:${tag()}`,
      ...row,
    })

  it('a rework opened by hand posts its scrap through the rework order, not a move or a scan', async () => {
    await expect(scrap({})).rejects.toThrow(/rework order of the work order that scrapped/)
    await expect(scrap({ sourceType: 'ReworkOrder', sourceId: randomUUID() })).rejects.toThrow(/not a rework order of work order/)
    expect(await scrap({ sourceType: 'ReworkOrder', sourceId: schedule.reworkOrderId, reason: 'Scrapped at the rework' })).toBe(1)
    await expect(run(office(), `UPDATE "WorkOrderCostEntry" SET amount = 0 WHERE "sourceId" = $1::uuid`, schedule.reworkOrderId)).rejects.toThrow(DENIED)
  })

  it('a company’s row may hold its method only, following the tenant-wide overhead', async () => {
    const [tenantRow] = await sql(office(), `SELECT id FROM "CostingSettings" WHERE "companyId" IS NULL LIMIT 1`)
    await expect(run(office(), `UPDATE "CostingSettings" SET "overheadFromTenant" = true WHERE id = $1::uuid`, tenantRow!.id)).rejects.toThrow(/only as a company''s row|only as a company's row/)
    await expect(insert(office(), 'CostingSettings', { id: A.companyB, companyId: A.companyB, overheadPct: '5', overheadFromTenant: true })).rejects.toThrow(/own overhead at 0/)
    expect(await insert(office(), 'CostingSettings', { id: A.companyB, companyId: A.companyB, overheadPct: '0', overheadFromTenant: true })).toBe(1)
    await expect(run(office(), `UPDATE "CostingSettings" SET "overheadPct" = 3 WHERE id = $1::uuid`, A.companyB)).rejects.toThrow(/own overhead at 0/)
  })
})

// --- payables ---------------------------------------------------------------------------------------------------------

describe('payables follow-ups', () => {
  it('a voided typed invoice frees its number and date; a live one still holds them', async () => {
    const number = `V-${tag()}`
    const first = randomUUID()
    expect(await insert(office(), 'SupplierInvoice', supplierInvoiceRow({ id: first, number }))).toBe(1)
    await expect(insert(office(), 'SupplierInvoice', supplierInvoiceRow({ number }))).rejects.toThrow(/SupplierInvoice_one_live_per_number|duplicate key/)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'Typed twice' WHERE id = $1::uuid`, first)).toBe(1)
    expect(await insert(office(), 'SupplierInvoice', supplierInvoiceRow({ number }))).toBe(1)
  })

  it('a file of several invoices: each body once, with the file’s IdentificativoSdI and day; a single invoice never takes a file’s', async () => {
    const lotto = (row: Record<string, unknown>) =>
      insert(office(), 'SupplierInvoice', supplierInvoiceRow({ source: 'SDI', docType: 'TD01', sdiIdentifier: 'SEED-SDI-IN-0000002', sdiFileName: 'IT00000002022_00415.xml', receivedOn: '2026-11-20', sdiFileId: followups.supplierInvoiceFileId, ...row }))
    await expect(lotto({ sdiBodyIndex: 3 })).rejects.toThrow(/carries the file''s IdentificativoSdI|carries the file's IdentificativoSdI/)
    await expect(lotto({ sdiBodyIndex: 1, receivedOn: '2026-11-21' })).rejects.toThrow(/carries the file/)
    await expect(lotto({ sdiBodyIndex: 2 })).rejects.toThrow(/duplicate key|sdiBodyIndex/)
    await expect(lotto({ sdiBodyIndex: null })).rejects.toThrow(/both or neither/)
    await expect(lotto({ sdiFileId: null, sdiBodyIndex: null })).rejects.toThrow(/is a file of several invoices/)
    await expect(lotto({ source: 'MANUAL', docType: null, sdiIdentifier: null, sdiFileName: null, sdiBodyIndex: 1 })).rejects.toThrow(/only when it came through SDI/)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "sdiBodyIndex" = 2 WHERE id = $1::uuid`, followups.lottoInvoiceIds[0])).rejects.toThrow(/what it says never changes/)
    const file = (row: Record<string, unknown>) =>
      insert(office(), 'SupplierInvoiceFile', { id: randomUUID(), companyId: A.companyA, partyId: A.P2, sdiIdentifier: `SDI-F-${tag()}`, sdiFileName: 'IT00000002022_00500.xml', receivedOn: '2026-11-22', invoiceCount: 2, ...row })
    await expect(file({ invoiceCount: 1 })).rejects.toThrow(/two invoices or more/)
    await expect(file({ sdiIdentifier: 'SEED-SDI-IN-0000001' })).rejects.toThrow(/recorded already as one supplier invoice/)
    expect(await file({})).toBe(1)
    await expect(run(office(), `UPDATE "SupplierInvoiceFile" SET "invoiceCount" = 3 WHERE id = $1::uuid`, followups.supplierInvoiceFileId)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "SupplierInvoiceFile" SET "xmlFileId" = NULL WHERE id = $1::uuid`, followups.supplierInvoiceFileId)).rejects.toThrow(/named once/)
    await expect(admin(`DELETE FROM "SupplierInvoiceFile" WHERE id = $1::uuid`, [followups.supplierInvoiceFileId])).rejects.toThrow(/never deleted/)
  })

  it('a supplier’s credit note names the claim it settles once, even when PAID; never an invoice, never a voided one', async () => {
    const claim = { claimId: sourcing.claimId, claimSiteId: A.siteA }
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "claimId" = $2::uuid, "claimSiteId" = $3::uuid WHERE id = $1::uuid`, accounting.supplierInvoiceId, claim.claimId, claim.claimSiteId)).rejects.toThrow(/only a supplier''s credit note|only a supplier's credit note/)
    await expect(insert(office(), 'SupplierInvoice', supplierInvoiceRow({ kind: 'CREDIT_NOTE', claimId: claim.claimId }))).rejects.toThrow(/with the claim''s site|with the claim's site/)
    const note = randomUUID()
    expect(await insert(office(), 'SupplierInvoice', supplierInvoiceRow({ id: note, kind: 'CREDIT_NOTE' }))).toBe(1)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET "matchStatus" = 'NO_PO', "matchedAt" = now() WHERE id = $1::uuid`, note)).toBe(1)
    expect(await run(office(randomUUID()), `UPDATE "SupplierInvoice" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, note, randomUUID())).toBe(1)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET status = 'PAID', "paidOn" = '2026-11-25', "paymentRef" = $2 WHERE id = $1::uuid`, note, `PAY-${tag()}`)).toBe(1)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET "claimId" = $2::uuid, "claimSiteId" = $3::uuid WHERE id = $1::uuid`, note, claim.claimId, claim.claimSiteId)).toBe(1)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "claimId" = NULL, "claimSiteId" = NULL WHERE id = $1::uuid`, note)).rejects.toThrow(/named once/)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "paymentRef" = 'X' WHERE id = $1::uuid`, note)).rejects.toThrow(/never changes/)
    const voided = randomUUID()
    expect(await insert(office(), 'SupplierInvoice', supplierInvoiceRow({ id: voided, kind: 'CREDIT_NOTE' }))).toBe(1)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'Duplicate' WHERE id = $1::uuid`, voided)).toBe(1)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "claimId" = $2::uuid, "claimSiteId" = $3::uuid WHERE id = $1::uuid`, voided, claim.claimId, claim.claimSiteId)).rejects.toThrow(/never changes/)
  })

  it('the payables settings: tolerances in range; LISTED approvers are office users of the tenant, each once', async () => {
    const [user] = await admin(`SELECT id FROM "User" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])
    const set = (assignment: string, ...values: unknown[]) => run(office(), `UPDATE "PayablesSettings" SET ${assignment} WHERE id = $1::uuid`, followups.payablesSettingsId, ...values)
    await expect(set(`"priceTolerancePct" = 101`)).rejects.toThrow(/0 to 100 percent/)
    await expect(set(`"differenceToleranceAmount" = -1`)).rejects.toThrow(/amount tolerance of 0 or more/)
    await expect(set(`"sdiApproval" = 'LISTED'`)).rejects.toThrow(/exactly when LISTED/)
    await expect(set(`"sdiApproverIds" = ARRAY[$2::uuid]`, user!.id)).rejects.toThrow(/exactly when LISTED/)
    await expect(set(`"sdiApproval" = 'LISTED', "sdiApproverIds" = ARRAY[$2::uuid]`, randomUUID())).rejects.toThrow(/not an office user/)
    await expect(set(`"sdiApproval" = 'LISTED', "sdiApproverIds" = ARRAY[$2::uuid, $2::uuid]`, user!.id)).rejects.toThrow(/each once/)
    expect(await set(`"sdiApproval" = 'LISTED', "sdiApproverIds" = ARRAY[$2::uuid]`, user!.id)).toBe(1)
    await expect(admin(`DELETE FROM "PayablesSettings" WHERE id = $1::uuid`, [followups.payablesSettingsId])).rejects.toThrow(/never deleted/)
  })

  it('the SDI inbox: OPEN → RECORDED (what it became) | DISMISSED (why) → OPEN; what SDI said never changes', async () => {
    const id = randomUUID()
    const item = (row: Record<string, unknown>) =>
      insert(office(), 'SdiInboxItem', {
        id,
        companyId: A.companyA,
        accountId: A.sdiAccount,
        providerRef: `ref-${tag()}`,
        sdiIdentifier: `SDI-W-${tag()}`,
        fileName: 'IT00000002022_00600.xml',
        receivedAt: '2026-11-21T06:00:00Z',
        problem: 'DUPLICATE_NUMBER',
        problemText: 'Invoice 2026/0412 of this supplier is registered already (typed in).',
        firstSeenAt: '2026-11-21T06:05:00Z',
        lastTriedAt: '2026-11-21T06:05:00Z',
        ...row,
      })
    await expect(item({ status: 'DISMISSED', dismissedAt: new Date().toISOString(), dismissReason: 'x' })).rejects.toThrow(/starts OPEN/)
    expect(await item({})).toBe(1)
    const move = (assignment: string, ...values: unknown[]) => run(office(), `UPDATE "SdiInboxItem" SET ${assignment} WHERE id = $1::uuid`, id, ...values)
    await expect(move(`status = 'RECORDED', "recordedAt" = now()`)).rejects.toThrow(/wrong recording/)
    await expect(move(`status = 'RECORDED', "recordedAt" = now(), "supplierInvoiceId" = $2::uuid`, accounting.supplierInvoiceId)).rejects.toThrow(/another delivery or company/)
    await expect(move(`status = 'DISMISSED', "dismissedAt" = now()`)).rejects.toThrow(/wrong dismissal/)
    expect(await move(`status = 'DISMISSED', "dismissedAt" = now(), "dismissedById" = $2::uuid, "dismissReason" = 'A test delivery of the intermediary'`, a.actorId)).toBe(1)
    expect(await move(`status = 'OPEN', "dismissedAt" = NULL, "dismissedById" = NULL, "dismissReason" = NULL, attempts = attempts + 1, "lastTriedAt" = "lastTriedAt" + interval '1 hour'`)).toBe(1)
    await expect(move(`attempts = 1`)).rejects.toThrow(/only move forward/)
    await expect(move(`"lastTriedAt" = "firstSeenAt"`)).rejects.toThrow(/only move forward/)
    await expect(move(`"sdiIdentifier" = 'OTHER'`)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "SdiInboxItem" SET "problemText" = 'changed' WHERE id = $1::uuid`, followups.recordedInboxItemId)).rejects.toThrow(/RECORDED; it never changes/)
    await expect(admin(`DELETE FROM "SdiInboxItem" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
  })
})

// --- payments: a NONE deposit carried onto the order's invoice ---------------------------------------------------------

describe('a PAID deposit that issues no deposit invoice is carried onto its order’s invoice, in one command', () => {
  let invoiceOfOrder: string
  let deposit: string
  let payment: string
  let allocation: string

  beforeAll(async () => {
    invoiceOfOrder = await draft({ salesOrderId: A.orderSO2 })
    await issue(invoiceOfOrder)
    deposit = randomUUID()
    payment = randomUUID()
    allocation = randomUUID()
    await as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          ...insertSql('DepositRequest', { id: deposit, companyId: A.companyA, partyId: A.P1, orderId: A.orderSO2, kind: 'ACCONTO', currency: 'EUR', amount: 5000, dueDate: '2026-11-10', fiscalDocument: 'NONE', fiscalRule: 'test.deposit.EU_B2B_VIES' }),
        )
        await tx.$executeRawUnsafe(...insertSql('Payment', { id: payment, companyId: A.companyA, partyId: A.P1, amount: 5000, receivedOn: '2026-11-08', externalRef: `TRN-${tag()}` }))
        await tx.$executeRawUnsafe(...insertSql('PaymentAllocation', { id: allocation, companyId: A.companyA, partyId: A.P1, paymentId: payment, depositRequestId: deposit, amount: 5000 }))
        await tx.$executeRawUnsafe(`UPDATE "DepositRequest" SET status = 'PAID', "paidAt" = now() WHERE id = $1::uuid`, deposit)
      }),
    )
  })

  const reversal = (id: string) => ({ id, companyId: A.companyA, partyId: A.P1, paymentId: payment, depositRequestId: deposit, amount: -5000, reversalOfId: allocation, note: 'Carried onto the order’s invoice' })
  const carry = (reversalId: string, row: Record<string, unknown> = {}) => ({ id: randomUUID(), companyId: A.companyA, partyId: A.P1, paymentId: payment, invoiceId: invoiceOfOrder, amount: 5000, carriedFromId: reversalId, ...row })
  const inOneCommand = (rows: [string, Record<string, unknown>][]) =>
    as(office(), (client) =>
      client.$transaction(async (tx) => {
        for (const [table, row] of rows) await tx.$executeRawUnsafe(...insertSql(table, row))
      }),
    )

  it('a reversal alone is refused at commit: the money is carried in the same command', async () => {
    await expect(inOneCommand([['PaymentAllocation', reversal(randomUUID())]])).rejects.toThrow(/carried onto an invoice of its order/)
  })

  it('the carry goes to an invoice of the order, for the opposite amount, from a reversal of a deposit', async () => {
    const r1 = randomUUID()
    await expect(inOneCommand([['PaymentAllocation', reversal(r1)], ['PaymentAllocation', carry(r1, { invoiceId: receivables.money.sampleInvoiceId })]])).rejects.toThrow(/not an invoice of its order/)
    const r2 = randomUUID()
    await expect(inOneCommand([['PaymentAllocation', reversal(r2)], ['PaymentAllocation', carry(r2, { amount: 4000 })]])).rejects.toThrow(/opposite amount/)
    await expect(inOneCommand([['PaymentAllocation', carry(allocation)]])).rejects.toThrow(/not a reversal of a deposit/)
    const r3 = randomUUID()
    await expect(inOneCommand([['PaymentAllocation', reversal(r3)], ['PaymentAllocation', carry(r3, { depositRequestId: deposit, invoiceId: null })]])).rejects.toThrow(/it pays an invoice/)
  })

  it('reversal and carry in one command: the deposit’s money now pays the order’s invoice', async () => {
    const r = randomUUID()
    expect(await inOneCommand([['PaymentAllocation', reversal(r)], ['PaymentAllocation', carry(r)]])).toBeUndefined()
    const placed = await sql(office(), `SELECT coalesce(sum(amount) FILTER (WHERE "depositRequestId" IS NOT NULL), 0)::int AS deposit, coalesce(sum(amount) FILTER (WHERE "invoiceId" IS NOT NULL), 0)::int AS invoice FROM "PaymentAllocation" WHERE "paymentId" = $1::uuid`, payment)
    expect(placed).toEqual([{ deposit: 0, invoice: 5000 }])
    await expect(inOneCommand([['PaymentAllocation', reversal(randomUUID())]])).rejects.toThrow(/reversed already/)
  })

  it('a PAID deposit with a deposit invoice (TD02) keeps its allocations', async () => {
    const original = receivables.money.depositAllocationId
    const [row] = await admin(`SELECT "paymentId" AS payment, "depositRequestId" AS deposit, amount FROM "PaymentAllocation" WHERE id = $1::uuid`, [original])
    await expect(
      inOneCommand([['PaymentAllocation', { id: randomUUID(), companyId: A.companyA, partyId: A.P1, paymentId: row!.payment, depositRequestId: row!.deposit, amount: -Number(row!.amount), reversalOfId: original, note: 'Try' }]]),
    ).rejects.toThrow(/PAID \(final\); its allocations stay/)
  })
})

// --- receivables ------------------------------------------------------------------------------------------------------

describe('refund reasons and the half-year reference rates', () => {
  it('a DUE refund’s reason changes with it; a PAID one’s never does', async () => {
    expect(await run(office(), `UPDATE "Refund" SET "reasonCode" = 'OVERPAYMENT' WHERE id = $1::uuid`, receivables.refundId)).toBe(1)
    const paymentId = randomUUID()
    await insert(office(), 'Payment', { id: paymentId, companyId: A.companyA, partyId: A.P1, amount: 2000, receivedOn: '2026-11-20', externalRef: `TRN-${tag()}` })
    const refundId = randomUUID()
    expect(
      await insert(office(), 'Refund', { id: refundId, companyId: A.companyA, partyId: A.P1, paymentId, amount: 1000, reasonCode: 'OVERPAYMENT', status: 'PAID', paidOn: '2026-11-21', externalRef: `OUT-${tag()}`, paidAt: new Date().toISOString(), paidById: a.actorId }),
    ).toBe(1)
    await expect(run(office(), `UPDATE "Refund" SET "reasonCode" = 'OTHER' WHERE id = $1::uuid`, refundId)).rejects.toThrow(/what was paid never changes/)
  })

  it('one rate per half-year (1 January or 1 July), in range, with its source; corrected, never deleted', async () => {
    const rate = (row: Record<string, unknown>) => insert(office(), 'InterestReferenceRate', { id: randomUUID(), halfYearStart: '2027-01-01', referenceRatePct: '2.0000', addedPointsPct: '8.0000', source: 'Test notice', ...row })
    await expect(rate({ halfYearStart: '2027-02-01' })).rejects.toThrow(/1 January or 1 July/)
    await expect(rate({ referenceRatePct: '101' })).rejects.toThrow(/-10 to 100 percent/)
    await expect(rate({ source: ' ' })).rejects.toThrow(/where it was published/)
    const id = randomUUID()
    expect(await rate({ id })).toBe(1)
    await expect(rate({})).rejects.toThrow(/duplicate key|halfYearStart/)
    expect(await run(office(), `UPDATE "InterestReferenceRate" SET "referenceRatePct" = 2.1000 WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `UPDATE "InterestReferenceRate" SET "halfYearStart" = '2027-07-01' WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "InterestReferenceRate" WHERE id = $1::uuid`, [id])).rejects.toThrow(/never deleted/)
    await expect(run(office(), `DELETE FROM "InterestReferenceRate" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
  })
})
