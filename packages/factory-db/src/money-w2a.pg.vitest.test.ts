import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAccounting, type AccountingSeed } from '../seed/accounting'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPricing } from '../seed/pricing'
import { seed as seedReceivables, type ReceivablesSeed } from '../seed/receivables'
import { seed as seedReturns } from '../seed/returns'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2a schema wave 7/7 (money) beyond the generated isolation tests, on a database built from the migrations and seeded,
 * through the real login and the scoped client (…_money_w2a_guards):
 *   - the walls: every new table is the office's (no floor, no portal); the cost ledger names no person;
 *   - the work-order cost ledger is append-only for every login, the owner included; its entries' shapes, the method in
 *     force and locked, and the reversal;
 *   - charge lines; a credit note's lines crediting return lines (company, invoice, never more than returned); lines
 *     billing a payment-schedule step;
 *   - refunds against a credit note and against a payment's unplaced part, and the W1 allocation and void rules
 *     counting them;
 *   - the reminder ladder, the reminders a person approves, and the Owner's switch;
 *   - the costing method and its lock; frozen standards that never overlap;
 *   - supplier invoices: what SDI delivered never changes, approval by another person once the differences are
 *     accepted, the match while not approved;
 *   - accounting exports frozen once exported, one first export per period, files only while a draft;
 *   - hard period locks refuse what is dated inside them, soft ones are the API's;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2a7-a'
const DENIED = /permission denied/
const FILES = new Set(['receivables.prisma', 'payables.prisma', 'cost-ledger.prisma', 'accounting.prisma'])
const TABLES = [
  'Refund',
  'PaymentReminder',
  'ReceivablesSettings',
  'SupplierInvoice',
  'SupplierInvoiceLine',
  'SupplierInvoiceMatch',
  'StandardCost',
  'WorkOrderCostEntry',
  'AccountingExport',
  'AccountingExportFile',
  'PeriodLock',
] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let receivables: ReceivablesSeed
let accounting: AccountingSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  siteA: key('site:A1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  invoiceSeries: key('series:A:INVOICE:MAIN:2026'),
  store: key('files:account:r2'),
  leather: key('product:item:leather'),
  lining: key('product:item:lining'),
  liningGRY: key('product:item-colour:lining:GRY'),
  sampleLine: key('money:line:FT-2026-00001:1'),
  waitingReturnLine: `00000000${key('returns:RMA-0001:10').slice(8)}`,
  orderSO2: key('production:sales-order:SO-0002'),
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
  db = await migratedDatabase('moneyw2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  receivables = await seedReceivables({ db: factory, namespace: NS })
  accounting = await seedAccounting({ db: factory, namespace: NS })
  // The return lines a credit note credits, and the payment schedule a line bills (W2a wave 2/7).
  await seedReturns({ db: factory, namespace: NS })
  await seedPricing({ db: factory, namespace: NS })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers: invoices as the issuing command writes them (…_money_guards) -------------------------------------------

const totals = (net: number) => {
  const vat = Math.round((net * 22) / 100)
  return { netTotal: net, vatTotal: vat, grossTotal: net + vat, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat, rounding: 0 }] }
}
const invoiceRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  buyerPartyId: A.P1,
  docType: 'TD01',
  billTo: BILL_TO,
  ...totals(10000),
  ...extra,
})
const lineRow = (invoiceId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  invoiceId,
  buyerPartyId: A.P1,
  seq: 1,
  kind: 'GOODS',
  description: 'Test jacket',
  quantity: '1',
  unitPrice: '100.000000',
  netAmount: 10000,
  vatRatePct: '22.00',
  ...extra,
})
async function draft(extra: Record<string, unknown> = {}, lines: Record<string, unknown>[] = [{}]): Promise<string> {
  const row = invoiceRow(extra)
  const id = row.id as string
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', row))
      for (const [index, line] of lines.entries()) await tx.$executeRawUnsafe(...insertSql('InvoiceLine', { ...lineRow(id, { seq: index + 1, netAmount: row.netTotal, unitPrice: `${Number(row.netTotal) / 100}` }), ...line, invoiceId: id }))
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
          value: 200_000 + counter,
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
/** A credit note of FT-2026-00001 (two sample jackets at 250.00) for `pieces` jackets, its lines naming `returnLineId`. */
async function creditNote(pieces: number, returnLineId: string | null, extra: Record<string, unknown> = {}): Promise<string> {
  const net = 25000 * pieces
  return draft({ docType: 'TD04', creditOfId: receivables.money.sampleInvoiceId, causale: 'Reso', ...totals(net), ...extra }, [
    { quantity: String(pieces), unitPrice: '250.000000', netAmount: net, returnLineId },
  ])
}
const paymentRow = (amount: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  partyId: A.P1,
  amount,
  receivedOn: '2026-11-20',
  externalRef: `TRN-${tag()}`,
  ...extra,
})
const refundRow = (source: { creditNoteId?: string; paymentId?: string }, amount: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  partyId: A.P1,
  ...source,
  amount,
  ...extra,
})
const paid = (on = '2026-11-21') => ({ status: 'PAID', paidOn: on, externalRef: `OUT-${tag()}`, paidAt: new Date().toISOString(), paidById: a.actorId })

// --- the seeds and the walls ----------------------------------------------------------------------------------------

describe('the seeds and the walls', () => {
  it('the seeds are idempotent: a second run writes nothing new', async () => {
    const before = await Promise.all(TABLES.map(count))
    await seedReceivables({ db: factory, namespace: NS })
    await seedAccounting({ db: factory, namespace: NS })
    expect(await Promise.all(TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
  })

  it('the new tables are the office’s: the floor and the portal read none of them', async () => {
    // The wave's own tables (W2b schema wave 2/7 adds more to payables.prisma and receivables.prisma: its own test).
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file) && (TABLES as readonly string[]).includes(model.name))
    expect(models.map(({ model }) => model.name).sort()).toEqual([...TABLES].sort())
    for (const { model, ownership } of models) {
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      expect(ownership.access[FLOOR_ROLE], model.name).toBeUndefined()
      await expect(sql(floor(), `SELECT id FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
    }
  })

  it('the cost ledger and the standards are per work order and item: no column names a person (Statuto dei Lavoratori art. 4)', async () => {
    const columns = await admin(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [['WorkOrderCostEntry', 'StandardCost']])
    expect(columns.filter((column) => /worker|person|employee|operator/i.test(String(column.c)))).toEqual([])
  })

  it('the seeded charge draft adds up, and the seed’s reminders are switched off', async () => {
    const [draftRow] = await sql(office(), `SELECT "netTotal" AS net, "grossTotal" AS gross, status::text AS status FROM "Invoice" WHERE id = $1::uuid`, receivables.chargeInvoiceId)
    expect(draftRow).toEqual({ net: 3700, gross: 4514, status: 'DRAFT' })
    const lines = await sql(office(), `SELECT kind::text AS kind, "chargeKind"::text AS charge FROM "InvoiceLine" WHERE "invoiceId" = $1::uuid ORDER BY seq`, receivables.chargeInvoiceId)
    expect(lines).toEqual([
      { kind: 'CHARGE', charge: 'SAMPLES' },
      { kind: 'CHARGE', charge: 'FREIGHT' },
    ])
    const [settings] = await sql(office(), `SELECT "remindersEnabled" AS enabled, "lateInterestMode"::text AS interest FROM "ReceivablesSettings" WHERE id = $1::uuid`, receivables.settingsId)
    expect(settings).toEqual({ enabled: false, interest: 'UNDECIDED' })
  })
})

// --- the cost ledger ------------------------------------------------------------------------------------------------

describe('the work-order cost ledger', () => {
  const entryRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    workOrderId: accounting.money.shipping.quality.production.workOrderId,
    kind: 'OVERHEAD',
    occurredAt: '2026-11-18T10:00:00.000Z',
    amount: 1000,
    costingMethod: 'UNDECIDED',
    idempotencyKey: `test:${tag()}`,
    ...extra,
  })

  it('is append-only for every login, the owner included', async () => {
    const id = accounting.costEntryIds.material
    await expect(run(office(), `UPDATE "WorkOrderCostEntry" SET amount = 1 WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "WorkOrderCostEntry" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "WorkOrderCostEntry" SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "WorkOrderCostEntry" is refused/)
    await expect(admin(`DELETE FROM "WorkOrderCostEntry" WHERE id = $1`, [id])).rejects.toThrow(/append-only: DELETE/)
    await expect(admin(`TRUNCATE "WorkOrderCostEntry"`)).rejects.toThrow(/append-only: TRUNCATE/)
  })

  it('checks each kind’s source, and reverses an entry exactly once', async () => {
    const production = accounting.money.shipping.quality.production
    const move = production.issueMoveId
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'MATERIAL', itemId: A.leather, quantity: '53.2000', amount: 100 }))).rejects.toThrow(/names its item, quantity and stock move/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'MATERIAL', itemId: A.leather, quantity: '50.0000', stockMoveId: move, amount: 100 }))).rejects.toThrow(/an ISSUE to the work order adds its base quantity/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'MATERIAL', itemId: A.lining, quantity: '53.2000', stockMoveId: move, amount: 100 }))).rejects.toThrow(/an ISSUE to the work order adds/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'MATERIAL', itemId: A.leather, quantity: '-53.2000', stockMoveId: move, amount: -100 }))).rejects.toThrow(/an ISSUE to the work order adds/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'LABOUR', minutes: '10', amount: 500 }))).rejects.toThrow(/names its scan and the minutes earned/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'LABOUR', operationScanId: production.scanIds[2], minutes: '0', amount: 0 }))).rejects.toThrow(/above 0/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'SUBCONTRACT' }))).rejects.toThrow(/names its subcontract order/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'COMPLETION', amount: 100 }))).rejects.toThrow(/moves value out of the work order/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'ADJUSTMENT' }))).rejects.toThrow(/adjustment .* says why/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ sourceType: 'ReworkOrder' }))).rejects.toThrow(/a source type and id together/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ idempotencyKey: `move:${move}` }))).rejects.toThrow(/duplicate key|unique/i)
    // The reversal of the seeded material entry: exactly its opposite, with a reason, once.
    const original = accounting.costEntryIds.material
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'MATERIAL', reversalOfId: original, amount: -22_000, reason: 'Wrong hide' }))).rejects.toThrow(/takes back entry .* exactly/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'LABOUR', reversalOfId: original, amount: -22_344, reason: 'Wrong hide' }))).rejects.toThrow(/the same kind/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'MATERIAL', reversalOfId: original, amount: -22_344 }))).rejects.toThrow(/says why/)
    const reversal = entryRow({ kind: 'MATERIAL', reversalOfId: original, amount: -22_344, reason: 'Posted to the wrong work order' })
    expect(await insert(office(), 'WorkOrderCostEntry', reversal)).toBe(1)
    await expect(insert(office(), 'WorkOrderCostEntry', { ...reversal, id: randomUUID(), idempotencyKey: `test:${tag()}` })).rejects.toThrow(/is reversed already/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ kind: 'OVERHEAD', reversalOfId: reversal.id, amount: 22_344, reason: 'x' }))).rejects.toThrow(/the same kind and the opposite amount/)
  })

  it('is valued by the company’s costing method in force, and a decided method only once locked', async () => {
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ costingMethod: 'STANDARD' }))).rejects.toThrow(/valued by STANDARD, but the company's costing method is UNDECIDED/)
    // Company A decides (its own row wins over the tenant-wide one): STANDARD, not locked yet.
    await insert(office(), 'CostingSettings', { id: A.companyA, companyId: A.companyA, overheadPct: '0', costingMethod: 'STANDARD' })
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ costingMethod: 'UNDECIDED' }))).rejects.toThrow(/the company's costing method is STANDARD/)
    await expect(insert(office(), 'WorkOrderCostEntry', entryRow({ costingMethod: 'STANDARD' }))).rejects.toThrow(/lock the method first/)
    await expect(run(office(), `UPDATE "CostingSettings" SET "methodLockedAt" = now() WHERE id = $1::uuid`, A.companyA)).rejects.toThrow(/locked with when and by whom/)
    await run(office(), `UPDATE "CostingSettings" SET "methodLockedAt" = now(), "methodLockedById" = $2::uuid WHERE id = $1::uuid`, A.companyA, a.actorId)
    expect(await insert(office(), 'WorkOrderCostEntry', entryRow({ costingMethod: 'STANDARD' }))).toBe(1)
    await expect(run(office(), `UPDATE "CostingSettings" SET "costingMethod" = 'FIFO' WHERE id = $1::uuid`, A.companyA)).rejects.toThrow(/is STANDARD and locked since .* it never changes/)
    await expect(run(office(), `UPDATE "CostingSettings" SET "methodLockedAt" = NULL, "methodLockedById" = NULL WHERE id = $1::uuid`, A.companyA)).rejects.toThrow(/locked since/)
    // The overhead still changes (W1's guard), the lock does not.
    expect(await run(office(), `UPDATE "CostingSettings" SET "overheadPct" = 5 WHERE id = $1::uuid`, A.companyA)).toBe(1)
    // A lock needs a decided method.
    await expect(run(office(), `UPDATE "CostingSettings" SET "methodLockedAt" = now(), "methodLockedById" = $2::uuid WHERE id = $1::uuid`, a.tenantId, a.actorId)).rejects.toThrow(/is UNDECIDED; only a method the accountant chose is locked/)
  })
})

// --- standard costs -------------------------------------------------------------------------------------------------

describe('standard costs', () => {
  const standardRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    itemId: A.lining,
    validFrom: `2030-0${1 + (++counter % 9)}-01`,
    source: 'MANUAL',
    materialCost: '3.000000',
    unitCost: '3.000000',
    ...extra,
  })

  it('start as a DRAFT, add up, freeze without overlapping, and then change only their end, once', async () => {
    await expect(insert(office(), 'StandardCost', standardRow({ status: 'FROZEN', frozenAt: new Date().toISOString(), frozenById: a.actorId }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'StandardCost', standardRow({ labourCost: '1.000000' }))).rejects.toThrow(/a unit cost that is their sum/)
    await expect(insert(office(), 'StandardCost', standardRow({ validFrom: '2031-01-01', validTo: '2030-12-31' }))).rejects.toThrow(/an end not before its start/)
    // The seeded lining standard is FROZEN from 2026-10-01 with no end: a new one from 2027 overlaps it.
    const next = standardRow({ validFrom: '2027-01-01' })
    await insert(office(), 'StandardCost', next)
    const freeze = (id: unknown) => run(office(), `UPDATE "StandardCost" SET status = 'FROZEN', "frozenAt" = now(), "frozenById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)
    await expect(freeze(next.id)).rejects.toThrow(/overlaps the frozen standard/)
    // End the old one first, then freeze.
    const old = accounting.standardCostIds.lining
    await run(office(), `UPDATE "StandardCost" SET "validTo" = '2026-12-31' WHERE id = $1::uuid`, old)
    expect(await freeze(next.id)).toBe(1)
    await expect(run(office(), `UPDATE "StandardCost" SET "validTo" = '2027-06-30' WHERE id = $1::uuid`, old)).rejects.toThrow(/only its end is set, once/)
    await expect(run(office(), `UPDATE "StandardCost" SET "unitCost" = 9, "materialCost" = 9 WHERE id = $1::uuid`, next.id)).rejects.toThrow(/is FROZEN for its period/)
    await expect(run(office(), `UPDATE "StandardCost" SET status = 'DRAFT', "frozenAt" = NULL, "frozenById" = NULL WHERE id = $1::uuid`, next.id)).rejects.toThrow(/is FROZEN for its period/)
    await expect(run(office(), `DELETE FROM "StandardCost" WHERE id = $1::uuid`, next.id)).rejects.toThrow(/is FROZEN; it is never deleted/)
    // A draft is deleted.
    const scrap = standardRow()
    await insert(office(), 'StandardCost', scrap)
    expect(await run(office(), `DELETE FROM "StandardCost" WHERE id = $1::uuid`, scrap.id)).toBe(1)
  })
})

// --- charge lines, credit notes from returns, payment-schedule steps --------------------------------------------------

describe('invoice lines: charges, return lines and payment-schedule steps', () => {
  it('a CHARGE line names its kind and bills no order line; only charges carry a charge kind', async () => {
    const id = await draft()
    const line = (extra: Record<string, unknown>) => insert(office(), 'InvoiceLine', lineRow(id, { seq: 2 + ++counter, ...extra }))
    await expect(line({ kind: 'CHARGE' })).rejects.toThrow(/a CHARGE line \(and only it\) names what it charges/)
    await expect(line({ kind: 'GOODS', chargeKind: 'FREIGHT' })).rejects.toThrow(/a CHARGE line \(and only it\)/)
    await expect(line({ kind: 'CHARGE', chargeKind: 'FREIGHT', size: '50' })).rejects.toThrow(/bills no order line or size/)
    await expect(line({ kind: 'CHARGE', chargeKind: 'FEE', netAmount: -100, unitPrice: '-1' })).rejects.toThrow(/an amount and price of 0 or more/)
    await expect(line({ kind: 'CHARGE', chargeKind: 'PACKAGING', milestoneId: randomUUID() })).rejects.toThrow(/bills no step of the payment schedule/)
    expect(await line({ kind: 'CHARGE', chargeKind: 'PACKAGING', description: 'Imballo', netAmount: 500, unitPrice: '5' })).toBe(1)
  })

  it('a TD01 with a charge line is issued like any other (its totals add up)', async () => {
    const id = await draft({ ...totals(10500) }, [
      { netAmount: 10000, unitPrice: '100' },
      { kind: 'CHARGE', chargeKind: 'FREIGHT', description: 'Trasporto', netAmount: 500, unitPrice: '5', ddtId: accounting.money.shipping.ddtId },
    ])
    await expect(issue(id)).resolves.toBeUndefined()
  })

  it('only a credit note’s lines name a return line; it credits the invoice that billed it, never more than came back', async () => {
    const onTd01 = await draft()
    await expect(insert(office(), 'InvoiceLine', lineRow(onTd01, { seq: 2, returnLineId: A.waitingReturnLine }))).rejects.toThrow(/only a credit note's line .* names the return line it credits/)
    // SEED-RMA-0001's line takes back 1 of FT-2026-00001's 2 sample jackets.
    const two = await creditNote(2, A.waitingReturnLine)
    await expect(issue(two)).rejects.toThrow(/return line .* brings back 1 pieces; the credit notes that credit it would credit 2/)
    // A credit note of another invoice (100.00) crediting that return line: refused.
    const other = await draft()
    await issue(other)
    const wrong = await draft({ docType: 'TD04', creditOfId: other, causale: 'Reso', ...totals(10000) }, [{ netAmount: 10000, unitPrice: '100', returnLineId: A.waitingReturnLine }])
    await expect(issue(wrong)).rejects.toThrow(/returns a line of another invoice than the one it credits/)
    // One piece: issued; a second credit note of the same piece: refused.
    const one = await creditNote(1, A.waitingReturnLine)
    await issue(one)
    const again = await creditNote(1, A.waitingReturnLine)
    await expect(issue(again)).rejects.toThrow(/would credit 2/)
  })

  it('a line billing a payment-schedule step bills one of the invoice’s company and order, not a waived one', async () => {
    const [milestone] = await sql(office(), `SELECT id::text AS id, "orderId"::text AS order FROM "SalesOrderMilestone" WHERE "tenantId" = $1::uuid AND status = 'OPEN' ORDER BY seq LIMIT 1`, a.tenantId)
    expect(milestone).toBeDefined()
    const ofOtherOrder = await draft({ salesOrderId: A.orderSO2 }, [{ milestoneId: milestone!.id }])
    await expect(issue(ofOtherOrder)).rejects.toThrow(/bills a payment-schedule step of another company or order/)
    const ofItsOrder = await draft({ salesOrderId: milestone!.order }, [{ milestoneId: milestone!.id }])
    await expect(issue(ofItsOrder)).resolves.toBeUndefined()
  })
})

// --- refunds --------------------------------------------------------------------------------------------------------

describe('refunds', () => {
  it('of a payment never pass what it left unplaced, and count against its allocations and its void', async () => {
    // The seeded duplicate transfer: 100.00, nothing allocated, 50.00 refund DUE.
    const payment = receivables.overpaymentId
    await expect(insert(office(), 'Refund', refundRow({ paymentId: payment }, 5_001))).rejects.toThrow(/has 0 allocated and 5000 refunded or due; refund .* of 5001 passes what is unplaced/)
    const rest = refundRow({ paymentId: payment }, 3_000)
    expect(await insert(office(), 'Refund', rest)).toBe(1)
    // 20.00 left: an allocation of 30.00 to FT-2026-00001 passes it (W1's check counts the refunds now).
    const allocation = { id: randomUUID(), companyId: A.companyA, partyId: A.P1, paymentId: payment, invoiceId: receivables.money.sampleInvoiceId, amount: 3_000 }
    await expect(insert(office(), 'PaymentAllocation', allocation)).rejects.toThrow(/payment .* of 10000 has 0 allocated; 3000 more passes it \(8000 of it refunded or due to be\)/)
    expect(await insert(office(), 'PaymentAllocation', { ...allocation, id: randomUUID(), amount: 2_000 })).toBe(1)
    // A payment with a refund DUE is not voided.
    const other = paymentRow(1_000)
    await insert(office(), 'Payment', other)
    await insert(office(), 'Refund', refundRow({ paymentId: other.id as string }, 1_000))
    await expect(run(office(), `UPDATE "Payment" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'typed twice' WHERE id = $1::uuid`, other.id)).rejects.toThrow(/has a refund due or paid of its unplaced part/)
  })

  it('of a credit note never pass its gross total; a draft or an invoice is no source', async () => {
    const note = await creditNote(1, null, { creditOfId: receivables.money.sampleInvoiceId })
    await expect(insert(office(), 'Refund', refundRow({ creditNoteId: note }, 100))).rejects.toThrow(/a refund pays back what an issued credit note \(TD04\) credits/)
    await issue(note)
    await expect(insert(office(), 'Refund', refundRow({ creditNoteId: receivables.money.sampleInvoiceId }, 100))).rejects.toThrow(/an issued credit note \(TD04\)/)
    await expect(insert(office(), 'Refund', refundRow({ creditNoteId: note, paymentId: receivables.overpaymentId }, 100))).rejects.toThrow(/pays back exactly one thing/)
    // Gross 305.00: 200.00 DUE, then 105.01 more refused, 105.00 accepted.
    await insert(office(), 'Refund', refundRow({ creditNoteId: note }, 20_000))
    await expect(insert(office(), 'Refund', refundRow({ creditNoteId: note }, 10_501))).rejects.toThrow(/credits 30500 and has 20000 refunded or due/)
    expect(await insert(office(), 'Refund', refundRow({ creditNoteId: note }, 10_500))).toBe(1)
  })

  it('move DUE → PAID | CANCELLED and PAID → VOIDED, each with its columns; nothing is deleted', async () => {
    const payment = paymentRow(5_000)
    await insert(office(), 'Payment', payment)
    const refund = refundRow({ paymentId: payment.id as string }, 1_000)
    await insert(office(), 'Refund', refund)
    await expect(insert(office(), 'Refund', refundRow({ paymentId: payment.id as string }, 100, { status: 'CANCELLED', cancelledAt: new Date().toISOString(), cancelReason: 'x' }))).rejects.toThrow(/starts DUE/)
    await expect(run(office(), `UPDATE "Refund" SET status = 'PAID' WHERE id = $1::uuid`, refund.id)).rejects.toThrow(/with the wrong payment columns/)
    const pay = paid()
    await run(office(), `UPDATE "Refund" SET status = 'PAID', "paidOn" = $2::date, "externalRef" = $3, "paidAt" = now(), "paidById" = $4::uuid WHERE id = $1::uuid`, refund.id, pay.paidOn, pay.externalRef, a.actorId)
    await expect(run(office(), `UPDATE "Refund" SET amount = 900 WHERE id = $1::uuid`, refund.id)).rejects.toThrow(/is PAID; what was paid never changes/)
    await expect(run(office(), `UPDATE "Refund" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, refund.id)).rejects.toThrow(/cannot move from PAID to CANCELLED|is PAID; what was paid never changes/)
    await run(office(), `UPDATE "Refund" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'typed twice' WHERE id = $1::uuid`, refund.id)
    await expect(run(office(), `UPDATE "Refund" SET "internalNote" = 'x' WHERE id = $1::uuid`, refund.id)).rejects.toThrow(/is VOIDED; it never changes/)
    await expect(admin(`DELETE FROM "Refund" WHERE id = $1`, [refund.id])).rejects.toThrow(/cancelled or voided, never deleted/)
    await expect(admin(`TRUNCATE "Refund"`)).rejects.toThrow(/TRUNCATE on "Refund" is refused/)
  })
})

// --- reminders ------------------------------------------------------------------------------------------------------

describe('the reminder ladder and the reminders', () => {
  const reminderRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    partyId: A.P1,
    level: 2,
    action: 'EMAIL',
    invoiceIds: [receivables.money.sampleInvoiceId],
    amountDue: 41_000,
    oldestDueDate: '2026-11-27',
    subject: 'Sollecito',
    body: 'Testo',
    ...extra,
  })
  const settings = (set: string, ...values: unknown[]) => run(office(), `UPDATE "ReceivablesSettings" SET ${set} WHERE id = $1::uuid`, receivables.settingsId, ...values)

  it('the ladder: levels in order, days increasing, an action each; switched on only with the interest rule decided', async () => {
    await expect(settings(`ladder = '[{"level": 2, "offsetDays": 1, "action": "EMAIL"}]'`)).rejects.toThrow(/step 1 of the reminder ladder/)
    await expect(settings(`ladder = '[{"level": 1, "offsetDays": 5, "action": "EMAIL"}, {"level": 2, "offsetDays": 5, "action": "CALL"}]'`)).rejects.toThrow(/each later than the one before/)
    await expect(settings(`ladder = '[{"level": 1, "offsetDays": 5, "action": "FAX"}]'`)).rejects.toThrow(/EMAIL \| LETTER \| CALL/)
    await expect(settings(`ladder = '[{"level": 1, "offsetDays": -90, "action": "EMAIL"}]'`)).rejects.toThrow(/from 60 days before the due date/)
    await expect(settings(`"lateInterestMode" = 'AGREED'`)).rejects.toThrow(/an agreed late-payment rate exactly when the rule is AGREED/)
    await expect(settings(`"remindersEnabled" = true`)).rejects.toThrow(/only with a ladder and the late-payment rule decided by the accountant/)
    await expect(admin(`DELETE FROM "ReceivablesSettings" WHERE id = $1`, [receivables.settingsId])).rejects.toThrow(/changed, never deleted/)
  })

  it('a reminder covers issued TD01 / TD24 invoices of its customer; a person approves its text before it is sent', async () => {
    await expect(insert(office(), 'PaymentReminder', reminderRow({ invoiceIds: [receivables.chargeInvoiceId] }))).rejects.toThrow(/is not an issued TD01 or TD24 of the company to the customer/)
    await expect(insert(office(), 'PaymentReminder', reminderRow({ partyId: key('party:P3') }))).rejects.toThrow(/is not an issued TD01 or TD24 of the company to the customer/)
    await expect(insert(office(), 'PaymentReminder', reminderRow({ invoiceIds: [receivables.money.sampleInvoiceId, receivables.money.sampleInvoiceId] }))).rejects.toThrow(/at least one invoice, each once/)
    await expect(insert(office(), 'PaymentReminder', reminderRow({ status: 'APPROVED', approvedAt: new Date().toISOString(), approvedById: a.actorId }))).rejects.toThrow(/starts PREPARED/)
    const reminder = reminderRow()
    await insert(office(), 'PaymentReminder', reminder)
    const update = (set: string, ...values: unknown[]) => run(office(), `UPDATE "PaymentReminder" SET ${set} WHERE id = $1::uuid`, reminder.id, ...values)
    expect(await update(`body = 'Testo rivisto'`)).toBe(1)
    await expect(update(`"amountDue" = 1`)).rejects.toThrow(/what reminder .* covers .* never change/)
    await expect(update(`status = 'SENT', "sentAt" = now()`)).rejects.toThrow(/cannot move from PREPARED to SENT \(a person approves it before it is sent\)/)
    await expect(update(`status = 'APPROVED'`)).rejects.toThrow(/with the wrong approval/)
    await update(`status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)
    await expect(update(`body = 'Altro'`)).rejects.toThrow(/its text is edited only while PREPARED/)
    // Reminders are switched off (the Owner's switch): nothing is sent.
    await expect(update(`status = 'SENT', "sentAt" = now()`)).rejects.toThrow(/reminders are switched off for the company/)
    // The accountant decides (an agreed rate), the Owner switches them on: sent.
    await settings(`"lateInterestMode" = 'AGREED', "lateInterestAgreedPct" = 8, "remindersEnabled" = true`)
    expect(await update(`status = 'SENT', "sentAt" = now()`)).toBe(1)
    await expect(update(`"subject" = 'x'`)).rejects.toThrow(/is SENT; it never changes/)
    await settings(`"remindersEnabled" = false`)
    // A skip says who, when and why; a call is sent with what was said.
    const skipped = reminderRow({ action: 'CALL', subject: null, body: null })
    await insert(office(), 'PaymentReminder', skipped)
    await expect(run(office(), `UPDATE "PaymentReminder" SET status = 'SKIPPED', "skippedAt" = now() WHERE id = $1::uuid`, skipped.id)).rejects.toThrow(/skipped \(who, when, why\)/)
    expect(await run(office(), `UPDATE "PaymentReminder" SET status = 'SKIPPED', "skippedAt" = now(), "skippedById" = $2::uuid, "skipReason" = 'Promise to pay' WHERE id = $1::uuid`, skipped.id, a.actorId)).toBe(1)
    await expect(admin(`DELETE FROM "PaymentReminder" WHERE id = $1`, [skipped.id])).rejects.toThrow(/never deleted/)
  })
})

// --- supplier invoices ----------------------------------------------------------------------------------------------

describe('supplier invoices and the three-way match', () => {
  const typedRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    partyId: A.P2,
    source: 'MANUAL',
    number: `F-${tag()}`,
    issueDate: '2026-11-10',
    receivedOn: '2026-11-11',
    netTotal: 10_000,
    vatTotal: 2_200,
    grossTotal: 12_200,
    ...extra,
  })

  it('what SDI delivered never changes; only its lines’ mapping does; it is never voided', async () => {
    const id = accounting.supplierInvoiceId
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "netTotal" = 1 WHERE id = $1::uuid`, id)).rejects.toThrow(/came through SDI .* what it says never changes/)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "xmlFileId" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/named once/)
    await expect(run(office(), `UPDATE "SupplierInvoiceLine" SET "netAmount" = 1 WHERE id = $1::uuid`, accounting.supplierLineIds.leather)).rejects.toThrow(/came through SDI; what it says never changes \(only its kind and mapping do\)/)
    await expect(run(office(), `DELETE FROM "SupplierInvoiceLine" WHERE id = $1::uuid`, accounting.supplierLineIds.freight)).rejects.toThrow(/never removed \(only remapped\)/)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/a fiscal document, never voided/)
    await expect(insert(office(), 'SupplierInvoice', typedRow({ source: 'SDI' }))).rejects.toThrow(/IdentificativoSdI and TipoDocumento exactly when it came through SDI/)
    await expect(insert(office(), 'SupplierInvoice', typedRow({ sdiIdentifier: 'X-1' }))).rejects.toThrow(/IdentificativoSdI and TipoDocumento exactly when/)
  })

  it('is approved by another person than its registrant, once every difference outside the tolerance is accepted', async () => {
    const id = accounting.supplierInvoiceId
    const approve = (by: string) => run(office(), `UPDATE "SupplierInvoice" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, id, by)
    const other = randomUUID()
    await expect(approve(a.actorId)).rejects.toThrow(/approved by another person than the one who registered it/)
    await expect(approve(other)).rejects.toThrow(/has a difference outside the tolerance .* that nobody accepted/)
    const match = accounting.matchId
    await expect(run(office(), `UPDATE "SupplierInvoiceMatch" SET "acceptedAt" = now(), "acceptedById" = $2::uuid WHERE id = $1::uuid`, match, other)).rejects.toThrow(/accepted with who, when and why/)
    await run(office(), `UPDATE "SupplierInvoiceMatch" SET "acceptedAt" = now(), "acceptedById" = $2::uuid, "acceptNote" = 'New price list from November' WHERE id = $1::uuid`, match, other)
    expect(await approve(other)).toBe(1)
    // From APPROVED on: no line, no match, no fact changes; it is paid with the bank's date and reference.
    await expect(run(office(), `UPDATE "SupplierInvoiceLine" SET "purchaseOrderLineId" = NULL, "siteId" = NULL WHERE id = $1::uuid`, accounting.supplierLineIds.leather)).rejects.toThrow(/is APPROVED; its lines are written only while/)
    await expect(run(office(), `UPDATE "SupplierInvoiceMatch" SET "acceptNote" = 'x' WHERE id = $1::uuid`, match)).rejects.toThrow(/is APPROVED; its match is written only while/)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET "dueDate" = '2027-01-31' WHERE id = $1::uuid`, id)).rejects.toThrow(/is APPROVED; it is paid, or its approval is withdrawn/)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET status = 'PAID' WHERE id = $1::uuid`, id)).rejects.toThrow(/paid \(the bank's date and reference\) exactly when PAID/)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET status = 'PAID', "paidOn" = '2026-12-30', "paymentRef" = 'SEPA-0001' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET status = 'RECEIVED' WHERE id = $1::uuid`, id)).rejects.toThrow(/is PAID; it never changes/)
    await expect(admin(`DELETE FROM "SupplierInvoice" WHERE id = $1`, [id])).rejects.toThrow(/is kept, never deleted/)
  })

  it('a typed invoice is corrected and its lines mapped while RECEIVED; WAITING_GOODS is not approved; a typed one is voided', async () => {
    const invoice = typedRow()
    await insert(office(), 'SupplierInvoice', invoice)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET "netTotal" = 10100, "grossTotal" = 12300 WHERE id = $1::uuid`, invoice.id)).toBe(1)
    const lineOf = (extra: Record<string, unknown>) => ({ id: randomUUID(), partyId: A.P2, invoiceId: invoice.id, seq: ++counter, description: 'Pelle', netAmount: 10_100, vatRatePct: '22.00', ...extra })
    const poLine = accounting.money.shipping.quality.production.inventory.supply.leatherLineId
    await expect(insert(office(), 'SupplierInvoiceLine', lineOf({ purchaseOrderLineId: poLine }))).rejects.toThrow(/with that order's site/)
    await expect(insert(office(), 'SupplierInvoiceLine', lineOf({ kind: 'SERVICE', siteId: A.siteA, purchaseOrderLineId: poLine }))).rejects.toThrow(/a GOODS or CHARGE line to a purchase order line/)
    const line = lineOf({ siteId: A.siteA, purchaseOrderLineId: poLine })
    expect(await insert(office(), 'SupplierInvoiceLine', line)).toBe(1)
    // A match against a receipt not posted (SEED-GR-0002 is OPEN, and of another order line) is refused.
    const openLine = accounting.money.shipping.quality.production.inventory.openReceiptLineId
    const matchOf = (extra: Record<string, unknown>) => ({
      id: randomUUID(),
      siteId: A.siteA,
      partyId: A.P2,
      invoiceId: invoice.id,
      invoiceLineId: line.id,
      purchaseOrderLineId: poLine,
      invoicedQuantity: '10',
      receivedQuantity: '0',
      orderedUnitPrice: '4.2',
      invoicedUnitPrice: '4.2',
      differenceAmount: 4200,
      quantityTolerancePct: '5',
      priceTolerancePct: '2',
      withinTolerance: false,
      ...extra,
    })
    await expect(insert(office(), 'SupplierInvoiceMatch', matchOf({ goodsReceiptLineId: openLine }))).rejects.toThrow(/is not a POSTED receipt of the purchase order line/)
    await expect(insert(office(), 'SupplierInvoiceMatch', matchOf({ withinTolerance: true, acceptedAt: new Date().toISOString(), acceptedById: a.actorId, acceptNote: 'x' }))).rejects.toThrow(/a match within it needs none/)
    expect(await insert(office(), 'SupplierInvoiceMatch', matchOf({}))).toBe(1)
    await run(office(), `UPDATE "SupplierInvoice" SET "matchStatus" = 'WAITING_GOODS' WHERE id = $1::uuid`, invoice.id)
    await expect(run(office(), `UPDATE "SupplierInvoice" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, invoice.id, randomUUID())).rejects.toThrow(/is WAITING_GOODS; it is approved once it is matched/)
    // A typed invoice typed twice is voided; its lines may be removed before.
    expect(await run(office(), `DELETE FROM "SupplierInvoiceMatch" WHERE "invoiceId" = $1::uuid`, invoice.id)).toBe(1)
    expect(await run(office(), `DELETE FROM "SupplierInvoiceLine" WHERE id = $1::uuid`, line.id)).toBe(1)
    expect(await run(office(), `UPDATE "SupplierInvoice" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'Typed twice' WHERE id = $1::uuid`, invoice.id)).toBe(1)
    // The same supplier's number on the same date is recorded once while it is not VOIDED: W2b (schema wave 2/7) frees the
    // number of a voided typed invoice, and the one recorded again holds it.
    expect(await insert(office(), 'SupplierInvoice', { ...invoice, id: randomUUID(), status: 'RECEIVED' })).toBe(1)
    await expect(insert(office(), 'SupplierInvoice', { ...invoice, id: randomUUID(), status: 'RECEIVED' })).rejects.toThrow(/duplicate key|unique/i)
  })
})

// --- accounting exports ---------------------------------------------------------------------------------------------

describe('accounting exports', () => {
  const exportRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    packages: ['SALES_JOURNAL'],
    ...extra,
  })
  const fileFor = async (exportId: string, seq = 1, extra: Record<string, unknown> = {}) => {
    const fileId = randomUUID()
    await insert(office(), 'StoredFile', {
      id: fileId,
      companyId: A.companyA,
      recordType: 'AccountingExport',
      recordId: exportId,
      kind: 'FISCAL_ARCHIVE',
      originalName: `exp-${tag()}.csv`,
      contentType: 'text/csv',
      sizeBytes: 10,
      sha256: 'c'.repeat(64),
      storeAccountId: A.store,
      storageKey: `legal/t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
      status: 'AVAILABLE',
      availableAt: new Date().toISOString(),
      retainUntil: '2037-01-01T00:00:00.000Z',
    })
    const row = { id: randomUUID(), exportId, seq, package: 'SALES_JOURNAL', fileId, format: 'CSV', rowCount: 3, ...extra }
    return { row, done: await insert(office(), 'AccountingExportFile', row) }
  }
  const exportIt = (id: unknown, number = `EXP-2026-${tag()}`) =>
    run(office(), `UPDATE "AccountingExport" SET status = 'EXPORTED', number = $2, "numberSeriesId" = $3::uuid, "exportedAt" = now(), "exportedById" = $4::uuid WHERE id = $1::uuid`, id, number, accounting.exportSeriesId, a.actorId)

  it('starts as a DRAFT of whole months, is exported with a file and its checks passed or explained, then never changes', async () => {
    await expect(insert(office(), 'AccountingExport', exportRow({ status: 'EXPORTED' }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'AccountingExport', exportRow({ periodStart: '2026-11-02' }))).rejects.toThrow(/covers whole months/)
    await expect(insert(office(), 'AccountingExport', exportRow({ packages: [] }))).rejects.toThrow(/at least one package, each once/)
    const batch = exportRow({ checks: [{ code: 'SHIPMENTS_INVOICED', passed: false }] })
    await insert(office(), 'AccountingExport', batch)
    await expect(exportIt(batch.id)).rejects.toThrow(/has no file/)
    await expect(fileFor(batch.id as string, 1, { package: 'INTRASTAT' })).rejects.toThrow(/a package of the export/)
    await fileFor(batch.id as string)
    await expect(exportIt(batch.id)).rejects.toThrow(/a check that failed with no explanation/)
    await run(office(), `UPDATE "AccountingExport" SET checks = '[{"code": "SHIPMENTS_INVOICED", "passed": false, "explanation": "SH-0002 ships in December"}]' WHERE id = $1::uuid`, batch.id)
    expect(await exportIt(batch.id)).toBe(1)
    await expect(run(office(), `UPDATE "AccountingExport" SET note = 'x' WHERE id = $1::uuid`, batch.id)).rejects.toThrow(/is EXPORTED; it never changes/)
    await expect(fileFor(batch.id as string, 2)).rejects.toThrow(/is EXPORTED; its files are added \(or removed\) only while it is a DRAFT/)
    await expect(admin(`DELETE FROM "AccountingExportFile" WHERE "exportId" = $1`, [batch.id])).rejects.toThrow(/only while it is a DRAFT/)
    await expect(admin(`DELETE FROM "AccountingExport" WHERE id = $1`, [batch.id])).rejects.toThrow(/never deleted/)
    // One first export per period; a re-export names the one it amends.
    const second = exportRow()
    await insert(office(), 'AccountingExport', second)
    await fileFor(second.id as string)
    await expect(exportIt(second.id)).rejects.toThrow(/duplicate key|unique/i)
    await expect(insert(office(), 'AccountingExport', exportRow({ supersedesId: batch.id, periodStart: '2026-10-01', periodEnd: '2026-10-31' }))).rejects.toThrow(/an EXPORTED batch of the same company and period/)
    const amend = exportRow({ supersedesId: batch.id })
    await insert(office(), 'AccountingExport', amend)
    await fileFor(amend.id as string)
    expect(await exportIt(amend.id)).toBe(1)
  })

  it('a file is a stored file of its export, and never changes', async () => {
    const draftExport = accounting.draftExportId
    const { row } = await fileFor(draftExport, 50)
    await expect(run(office(), `UPDATE "AccountingExportFile" SET "rowCount" = 1 WHERE id = $1::uuid`, row.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "AccountingExportFile" SET "rowCount" = 1 WHERE id = $1`, [row.id])).rejects.toThrow(/never changes/)
    await expect(insert(office(), 'AccountingExportFile', { ...row, id: randomUUID(), seq: 51, fileId: accounting.supplierXmlFileId })).rejects.toThrow(/a stored file of the export \(recordType AccountingExport\)/)
  })
})

// --- period locks ---------------------------------------------------------------------------------------------------

describe('period locks', () => {
  const lockRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: A.companyA,
    periodStart: '2026-12-01',
    periodEnd: '2026-12-31',
    level: 'HARD',
    lockedAt: new Date().toISOString(),
    lockedById: a.actorId,
    ...extra,
  })

  it('close whole months, never overlap, and are lifted (with a reason) and locked again, never deleted', async () => {
    await expect(insert(office(), 'PeriodLock', lockRow({ periodEnd: '2026-12-30' }))).rejects.toThrow(/closes whole months/)
    await expect(insert(office(), 'PeriodLock', lockRow({ periodStart: '2026-08-01', periodEnd: '2026-09-30' }))).rejects.toThrow(/overlaps lock/)
    await expect(insert(office(), 'PeriodLock', lockRow({ exportId: accounting.draftExportId }))).rejects.toThrow(/names the EXPORTED batch made before it/)
    await expect(insert(office(), 'PeriodLock', lockRow({ status: 'UNLOCKED' }))).rejects.toThrow(/starts LOCKED/)
    const seeded = accounting.periodLockId
    await expect(run(office(), `UPDATE "PeriodLock" SET status = 'UNLOCKED' WHERE id = $1::uuid`, seeded)).rejects.toThrow(/lifted exactly with when, by whom and why/)
    await expect(run(office(), `UPDATE "PeriodLock" SET "periodEnd" = '2026-10-31' WHERE id = $1::uuid`, seeded)).rejects.toThrow(/period and creation of lock .* never change/)
    await expect(admin(`DELETE FROM "PeriodLock" WHERE id = $1`, [seeded])).rejects.toThrow(/lifted, never deleted/)
  })

  it('a HARD lock refuses what is dated inside it; a SOFT one is the API’s; a lifted one refuses nothing', async () => {
    const lock = lockRow()
    await insert(office(), 'PeriodLock', lock)
    const inside = '2026-12-15'
    // An invoice issued in December.
    const invoice = await draft()
    await expect(issue(invoice, inside)).rejects.toThrow(/period lock: invoice .* is dated 2026-12-15, inside the closed period 2026-12-01 to 2026-12-31/)
    // A payment received in December.
    await expect(insert(office(), 'Payment', paymentRow(100, { receivedOn: inside }))).rejects.toThrow(/period lock: payment/)
    // A refund paid in December (of a November payment).
    const november = paymentRow(1_000)
    await insert(office(), 'Payment', november)
    await expect(insert(office(), 'Refund', refundRow({ paymentId: november.id as string }, 100, paid(inside)))).rejects.toThrow(/period lock: refund/)
    // A supplier invoice received in December.
    await expect(insert(office(), 'SupplierInvoice', { id: randomUUID(), companyId: A.companyA, partyId: A.P2, source: 'MANUAL', number: `F-${tag()}`, issueDate: '2026-12-10', receivedOn: inside })).rejects.toThrow(/period lock: supplier invoice/)
    // A cost entry and an office stock move in December.
    const production = accounting.money.shipping.quality.production
    await expect(
      insert(office(), 'WorkOrderCostEntry', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, workOrderId: production.workOrderId, kind: 'OVERHEAD', occurredAt: '2026-12-15T10:00:00.000Z', amount: 100, costingMethod: 'STANDARD', idempotencyKey: `test:${tag()}` }),
    ).rejects.toThrow(/period lock: cost entry/)
    const inventory = production.inventory
    const move = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, reason: 'ADJUSTMENT', itemId: A.lining, itemColourId: A.liningGRY, lotId: inventory.liningLotId, toLocationId: inventory.locations.bin, quantity: '1', uom: 'M', baseQuantity: '1', note: 'Found', idempotencyKey: `test:${tag()}` }
    await expect(insert(office(), 'StockMove', { ...move, occurredAt: '2026-12-15T10:00:00.000Z' })).rejects.toThrow(/period lock: stock move/)
    // The day is Rome's: New Year's Eve 23:30 UTC is already 1 January there, outside the lock.
    expect(await insert(office(), 'StockMove', { ...move, id: randomUUID(), idempotencyKey: `test:${tag()}`, occurredAt: '2026-12-31T23:30:00.000Z' })).toBe(1)
    // SOFT: the database lets it through (the API asks finance for a reason).
    await run(office(), `UPDATE "PeriodLock" SET level = 'SOFT' WHERE id = $1::uuid`, lock.id)
    expect(await insert(office(), 'Payment', paymentRow(100, { receivedOn: inside }))).toBe(1)
    // HARD again, then lifted: nothing is refused.
    await run(office(), `UPDATE "PeriodLock" SET level = 'HARD' WHERE id = $1::uuid`, lock.id)
    await expect(issue(invoice, inside)).rejects.toThrow(/period lock/)
    await run(office(), `UPDATE "PeriodLock" SET status = 'UNLOCKED', "unlockedAt" = now(), "unlockedById" = $2::uuid, "unlockReason" = 'The accountant reopened December' WHERE id = $1::uuid`, lock.id, a.actorId)
    await expect(issue(invoice, inside)).resolves.toBeUndefined()
    // Locked again (a new time): refused again.
    await run(office(), `UPDATE "PeriodLock" SET status = 'LOCKED', "lockedAt" = now() + interval '1 second', "unlockedAt" = NULL, "unlockedById" = NULL, "unlockReason" = NULL WHERE id = $1::uuid`, lock.id)
    await expect(insert(office(), 'Payment', paymentRow(100, { receivedOn: inside }))).rejects.toThrow(/period lock: payment/)
  })

  it('the seeded September lock is HARD: nothing dated in September is written', async () => {
    await expect(insert(office(), 'Payment', paymentRow(100, { receivedOn: '2026-09-30' }))).rejects.toThrow(/inside the closed period 2026-09-01 to 2026-09-30/)
  })
})
