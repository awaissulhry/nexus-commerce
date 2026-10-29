import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinks } from '../seed/links'
import { seed as seedMoney, type MoneySeed } from '../seed/money'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The money walls beyond the generated isolation tests (plan A1 §2.1, §2.2, §2.5 "Invoice", §2.6; PLAN §2.8
 * "Corrections only by credit note" (DPR 633/1972 art. 26), "Rejected file resent within 5 working days" (Provv. AdE
 * 89757/2018), "Sequential, gap-free numbering" (art. 21 c.2); Q12; features FIN-054, FIN-061, FIN-069, FIN-084,
 * FIN-086, FIN-087, FIN-121), on a database built from the migrations and seeded twice (tenants A and B), through the
 * real login and the scoped client:
 *   - the floor reads nothing of money; a portal or link session reads only its own party's ISSUED invoices (never a
 *     draft), their lines and sends, its payments and allocations, never an internal column;
 *   - an invoice starts as a DRAFT without a number; it is numbered only at issue, from a fiscal series of its company
 *     (the NumberAllocation row checked at commit), with totals that add up to its lines and VAT summary; once issued it
 *     never changes but for its SDI status, for every login (a correction is a credit note);
 *   - a rejected file (never issued for SDI) is corrected, its lines and totals too, and sent again under the same
 *     number and date; the resend runs the issue's checks again; a corrected total never drops below what is paid or
 *     credited; each send carries the invoice's XML;
 *   - a TD04 credits an issued invoice of its company and party, never more than is still creditable; a deposit
 *     invoice is deducted at most for its net; a TD02 invoices a deposit request that needs one;
 *   - allocations never pass the payment, the invoice (less its credit notes) or the deposit request, also when two
 *     race; a wrong one is reversed once by a new row; a payment is voided only when nothing is allocated;
 *   - SDI notifications and allocations are append-only; the seed is idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through the scoped client's raw SQL.
 */

const DENIED = /permission denied/
const MONEY_TABLES = ['Invoice', 'InvoiceLine', 'SdiSubmission', 'SdiNotification', 'Payment', 'PaymentAllocation']

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let seeded: MoneySeed

const key = (namespace: string, name: string): string => seedUuid(namespace, name)
const A = {
  companyA: key('mo-a', 'company:A'),
  companyB: key('mo-a', 'company:B'),
  P1: key('mo-a', 'party:P1'),
  P3: key('mo-a', 'party:P3'),
  invoiceSeries: key('mo-a', 'series:A:INVOICE:MAIN:2026'),
  ddtSeries: key('mo-a', 'series:A:DDT:MAIN:2026'),
  store: key('mo-a', 'files:account:r2'),
  sdi: key('mo-a', 'integration:account:sdi'),
}
const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01' }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000001016', name: 'Seed Customer One S.r.l.', sdiCode: 'SEEDC01' }

const office = (core: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const partner = (partyId: string, core: CoreSeed = a): FactoryScope => ({ audience: 'partner', tenantId: core.tenantId, actorId: randomUUID(), partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const ids = (rows: Record<string, unknown>[]): string[] => rows.map((row) => String(row.id))

/** `INSERT INTO "<table>" (<the row's columns>) …`: the columns it leaves out take their defaults (tenantId too). */
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
  db = await migratedDatabase('money')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'mo-a' })
  b = await seedCore({ db: factory, namespace: 'mo-b' })
  await seedAuth({ db: factory, namespace: 'mo-a' })
  await seedLinks({ db: factory, namespace: 'mo-a' })
  await seedLinks({ db: factory, namespace: 'mo-b' })
  seeded = await seedMoney({ db: factory, namespace: 'mo-a' })
  await seedMoney({ db: factory, namespace: 'mo-b' })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

/** A DRAFT invoice of company A to P1 (by default a TD01 of net 100.00 + 22% VAT), not inserted. */
const invoiceRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  buyerPartyId: A.P1,
  docType: 'TD01',
  billTo: BILL_TO,
  netTotal: 10000,
  vatTotal: 2200,
  grossTotal: 12200,
  vatSummary: [{ rate: '22.00', nature: null, taxable: 10000, vat: 2200, rounding: 0 }],
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
/** Totals of a one-rate (22%) invoice with these net amounts. */
const totals = (net: number) => {
  const vat = Math.round((net * 22) / 100)
  return { netTotal: net, vatTotal: vat, grossTotal: net + vat, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat, rounding: 0 }] }
}
/** A file row of an invoice: its FatturaPA XML (FISCAL_ARCHIVE). */
const xmlRow = (invoiceId: string, id: string = randomUUID()): Record<string, unknown> => ({
  id,
  companyId: A.companyA,
  recordType: 'Invoice',
  recordId: invoiceId,
  kind: 'FISCAL_ARCHIVE',
  originalName: `IT00000003038_${tag()}.xml`,
  contentType: 'application/xml',
  sizeBytes: 2048,
  sha256: 'b'.repeat(64),
  storeAccountId: A.store,
  storageKey: `legal/t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
  status: 'AVAILABLE',
  availableAt: new Date().toISOString(),
  retainUntil: '2037-01-01T00:00:00.000Z',
})

/** A DRAFT invoice with its lines (one line of the invoice's net by default). */
async function draft(extra: Record<string, unknown> = {}, lines?: Record<string, unknown>[]): Promise<string> {
  const row = invoiceRow(extra)
  const id = row.id as string
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', row))
      for (const line of lines ?? [lineRow(id, { netAmount: row.netTotal, unitPrice: `${Number(row.netTotal) / 100}` })]) {
        await tx.$executeRawUnsafe(...insertSql('InvoiceLine', { ...lineRow(id), ...line, invoiceId: id }))
      }
    }),
  )
  return id
}

/** Issues a DRAFT as the issuing command does: the number from the series (its NumberAllocation row), the XML file. */
async function issue(
  invoiceId: string,
  options: { date?: string; number?: string; series?: string; allocate?: boolean; kind?: string; xml?: boolean } = {},
): Promise<{ number: string; date: string; xmlFileId: string }> {
  const number = options.number ?? `T-${tag()}-${++counter}`
  const date = options.date ?? '2026-11-15'
  const series = options.series ?? A.invoiceSeries
  const xmlFileId = randomUUID()
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      const exec = (table: string, row: Record<string, unknown>) => tx.$executeRawUnsafe(...insertSql(table, row))
      if (options.allocate !== false) {
        await exec('NumberAllocation', {
          id: randomUUID(),
          companyId: A.companyA,
          seriesId: series,
          kind: options.kind ?? 'INVOICE',
          value: 100_000 + counter,
          formatted: number,
          documentDate: date,
          recordType: 'Invoice',
          recordId: invoiceId,
          allocatedAt: new Date().toISOString(),
          allocatedById: a.actorId,
          requestId: `test-${tag()}`,
        })
      }
      if (options.xml !== false) await exec('StoredFile', xmlRow(invoiceId, xmlFileId))
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = $4, "issueDate" = $5::date, "issuedAt" = now(),
           "issuedById" = $6::uuid, "partyId" = "buyerPartyId", seller = $7::jsonb, "xmlFileId" = $8::uuid WHERE id = $1::uuid`,
        invoiceId,
        series,
        number,
        Number(date.slice(0, 4)),
        date,
        a.actorId,
        JSON.stringify(SELLER),
        options.xml === false ? null : xmlFileId,
      )
    }),
  )
  return { number, date, xmlFileId }
}
const issued = async (extra: Record<string, unknown> = {}, options: Parameters<typeof issue>[1] = {}) => {
  const id = await draft(extra)
  return { id, ...(await issue(id, options)) }
}
const setStatus = (id: string, status: string) => run(office(), `UPDATE "Invoice" SET status = $2::"InvoiceStatus" WHERE id = $1::uuid`, id, status)

/** A send of an issued invoice. */
const sendRow = (invoiceId: string, xmlFileId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  partyId: A.P1,
  invoiceId,
  attempt: 1,
  integrationAccountId: A.sdi,
  fileName: `IT00000003038_${tag()}.xml`,
  xmlFileId,
  status: 'SENT',
  sentAt: new Date().toISOString(),
  ...extra,
})
const paymentRow = (amount: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  partyId: A.P1,
  amount,
  receivedOn: '2026-11-20',
  externalRef: `TRN-${tag()}`,
  ...extra,
})
const allocationRow = (paymentId: string, target: { invoiceId?: string; depositRequestId?: string }, amount: number, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  partyId: A.P1,
  paymentId,
  ...target,
  amount,
  ...extra,
})
const payment = async (amount: number): Promise<string> => {
  const row = paymentRow(amount)
  await insert(office(), 'Payment', row)
  return row.id as string
}
/** A deposit request of SEED-SO-0001 (the sales seed's order), OPEN. */
const depositRequest = async (amount: number, fiscalDocument = 'TD02'): Promise<string> => {
  const row = {
    id: randomUUID(),
    companyId: A.companyA,
    partyId: A.P1,
    orderId: seeded.sales.orderId,
    kind: 'ACCONTO',
    currency: 'EUR',
    amount,
    dueDate: '2026-12-01',
    fiscalDocument,
    fiscalRule: 'test.deposit',
  }
  await insert(office(), 'DepositRequest', row)
  return row.id
}

/** Two transactions that insert at once: the first holds its transaction open after its insert; the second waits. */
async function race(table: string, first: Record<string, unknown>, second: Record<string, unknown>): Promise<PromiseSettledResult<unknown>[]> {
  let firstInserted!: () => void
  const inserted = new Promise<void>((resolve) => {
    firstInserted = resolve
  })
  const one = as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql(table, first))
      firstInserted()
      await new Promise((resolve) => setTimeout(resolve, 300))
    }),
  )
  await inserted
  const two = insert(office(), table, second)
  return Promise.allSettled([one, two])
}

// --- the walls ------------------------------------------------------------------------------------------------------

describe('the walls', () => {
  it('the floor reads and writes nothing of money', async () => {
    for (const table of MONEY_TABLES) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`), table).rejects.toThrow(DENIED)
      await expect(run(floor(), `DELETE FROM "${table}" WHERE false`), table).rejects.toThrow(DENIED)
    }
  })

  it("a portal or link session reads its own party's issued invoices, never a draft, never another party's, never an internal column", async () => {
    const own = ids(await sql(partner(A.P1), 'SELECT id::text AS id FROM "Invoice"'))
    expect(own).toEqual(expect.arrayContaining([seeded.sampleInvoiceId, seeded.depositInvoiceId]))
    expect(own).not.toContain(seeded.draftInvoiceId)
    const lineInvoices = (await sql(partner(A.P1), 'SELECT "invoiceId"::text AS id FROM "InvoiceLine"')).map((row) => row.id)
    expect(lineInvoices).toContain(seeded.sampleInvoiceId)
    expect(lineInvoices).not.toContain(seeded.draftInvoiceId)
    expect(await sql(partner(A.P3), 'SELECT id FROM "Invoice"')).toEqual([])
    expect(await sql(partner(A.P3), 'SELECT id FROM "Payment"')).toEqual([])
    expect(await sql(partner(A.P1, b), 'SELECT id FROM "Invoice" WHERE id = $1::uuid', seeded.sampleInvoiceId)).toEqual([])
    expect(ids(await sql(partner(A.P1), 'SELECT id::text AS id FROM "Payment"')).sort()).toEqual([seeded.depositPaymentId, seeded.onAccountPaymentId].sort())
    expect(ids(await sql(partner(A.P1), 'SELECT id::text AS id FROM "SdiSubmission"'))).toEqual(expect.arrayContaining([...seeded.sampleSubmissionIds]))
    for (const [table, column] of [
      ['Invoice', 'internalNote'],
      ['Invoice', 'issuedById'],
      ['SdiSubmission', 'failureReason'],
      ['SdiSubmission', 'integrationAccountId'],
      ['SdiNotification', 'payload'],
      ['Payment', 'internalNote'],
      ['PaymentAllocation', 'note'],
    ]) {
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "${table}" LIMIT 1`), `${table}.${column}`).rejects.toThrow(DENIED)
    }
    for (const table of MONEY_TABLES) await expect(run(partner(A.P1), `UPDATE "${table}" SET id = id WHERE false`), table).rejects.toThrow(DENIED)
  })

  it('the issue opens an invoice and its lines to the portal, in the same transaction', async () => {
    const id = await draft()
    expect(await sql(partner(A.P1), 'SELECT id FROM "Invoice" WHERE id = $1::uuid', id)).toEqual([])
    expect(await sql(partner(A.P1), 'SELECT id FROM "InvoiceLine" WHERE "invoiceId" = $1::uuid', id)).toEqual([])
    await issue(id)
    expect(await sql(partner(A.P1), 'SELECT id FROM "Invoice" WHERE id = $1::uuid', id)).toHaveLength(1)
    expect(await sql(partner(A.P1), 'SELECT id FROM "InvoiceLine" WHERE "invoiceId" = $1::uuid', id)).toHaveLength(1)
  })
})

// --- invoices -------------------------------------------------------------------------------------------------------

describe('an invoice', () => {
  it('starts as a DRAFT, with no number, date or party key', async () => {
    await expect(insert(office(), 'Invoice', invoiceRow({ status: 'ISSUED' }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'Invoice', invoiceRow({ partyId: A.P1 }))).rejects.toThrow(/a draft has no number, series, year, date or issue, and no party key/)
    await expect(insert(office(), 'Invoice', invoiceRow({ number: 'FT-1' }))).rejects.toThrow(/a draft has no number/)
    await expect(insert(office(), 'Invoice', invoiceRow({ grossTotal: 12199 }))).rejects.toThrow(/gross = net \+ VAT/)
    await expect(insert(office(), 'Invoice', invoiceRow({ depositRequestId: seeded.sales.depositRequestId }))).rejects.toThrow(/a TD02 \(and only a TD02\)/)
    const id = await draft()
    // A draft has no number: it may be deleted (lines first) without a gap.
    await expect(run(office(), 'DELETE FROM "InvoiceLine" WHERE "invoiceId" = $1::uuid', id)).resolves.toBe(1)
    await expect(run(office(), 'DELETE FROM "Invoice" WHERE id = $1::uuid', id)).resolves.toBe(1)
  })

  it('is numbered only at issue, from a fiscal series of its company, with totals that add up to its lines', async () => {
    await expect(issue(await draft(), { allocate: false })).rejects.toThrow(/without that number from its series/)
    await expect(issue(await draft(), { number: 'FT-2026-000000000001' + '0' })).rejects.toThrow(/at most 20 characters with at least one digit/)
    await expect(issue(await draft(), { number: 'FT-NO-DIGIT' })).rejects.toThrow(/at least one digit/)
    await expect(issue(await draft(), { series: A.ddtSeries, kind: 'DDT' })).rejects.toThrow(/from a fiscal INVOICE series .* not from a DDT series/)
    await expect(issue(await draft({}, []))).rejects.toThrow(/has no line/)
    const off = await draft()
    expect(await run(office(), 'UPDATE "Invoice" SET "netTotal" = 9000, "grossTotal" = 11200 WHERE id = $1::uuid', off)).toBe(1)
    await expect(issue(off)).rejects.toThrow(/the totals of invoice .* do not add up/)
    const summary = await draft({ vatSummary: [{ rate: '22.00', taxable: 10000 }] })
    await expect(issue(summary)).rejects.toThrow(/its VAT summary: at least one entry, each with its taxable, VAT and rounding/)
    // TD24: every goods line names its DDT, a live one of the company.
    await expect(issue(await draft({ docType: 'TD24' }))).rejects.toThrow(/TD24 .* names its DDT/)
    const cancelled = await draft({ docType: 'TD24' }, [lineRow('', { ddtId: seeded.shipping.cancelledDdtId })])
    await expect(issue(cancelled)).rejects.toThrow(/names a DDT of another company, or a cancelled one/)
    // GROSS basis: the rounding of the VAT summary closes the gap between the lines and the taxable.
    const gross = await draft({ priceBasis: 'GROSS', netTotal: 10001, vatTotal: 2199, grossTotal: 12200, vatSummary: [{ rate: '22.00', taxable: 10001, vat: 2199, rounding: 1 }] }, [
      lineRow('', { netAmount: 10000, unitPrice: '122' }),
    ])
    await issue(gross)
    const [row] = await admin('SELECT status::text AS status, year FROM "Invoice" WHERE id = $1', [gross])
    expect(row).toEqual({ status: 'ISSUED', year: 2026 })
  })

  it('never changes once issued (DPR 633/1972 art. 26), for every login; only its SDI status moves', async () => {
    const { id, number } = await issued()
    const [line] = await admin('SELECT id::text AS id FROM "InvoiceLine" WHERE "invoiceId" = $1', [id])
    const frozen = /is issued; its number, series, year, date, party and links never change/
    await expect(run(office(), `UPDATE "Invoice" SET number = 'X-1' WHERE id = $1::uuid`, id)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET "issueDate" = "issueDate" + 1 WHERE id = $1::uuid`, id)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET "netTotal" = 1, "vatTotal" = 0, "grossTotal" = 1 WHERE id = $1::uuid`, id)).rejects.toThrow(
      /its data, totals and text are corrected only while it is REJECTED/,
    )
    await expect(run(office(), `UPDATE "Invoice" SET "salesOrderId" = $2::uuid WHERE id = $1::uuid`, id, seeded.sales.orderId)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET "buyerPartyId" = $2::uuid WHERE id = $1::uuid`, id, A.P3)).rejects.toThrow(/company, buyer, type and creation .* never change/)
    await expect(admin(`UPDATE "Invoice" SET number = 'X-1' WHERE id = $1`, [id])).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET "billTo" = '{"name":"Other"}' WHERE id = $1::uuid`, id)).rejects.toThrow(/corrected only while it is REJECTED/)
    await expect(run(office(), `UPDATE "Invoice" SET status = 'DRAFT' WHERE id = $1::uuid`, id)).rejects.toThrow(/cannot move from ISSUED to DRAFT/)
    const lines = /its lines are written only while it is a DRAFT/
    await expect(run(office(), 'UPDATE "InvoiceLine" SET "netAmount" = 1 WHERE id = $1::uuid', line!.id)).rejects.toThrow(lines)
    await expect(run(office(), 'UPDATE "InvoiceLine" SET "partyId" = NULL WHERE id = $1::uuid', line!.id)).rejects.toThrow(lines)
    await expect(insert(office(), 'InvoiceLine', lineRow(id, { seq: 2 }))).rejects.toThrow(lines)
    await expect(run(office(), 'DELETE FROM "InvoiceLine" WHERE id = $1::uuid', line!.id)).rejects.toThrow(lines)
    await expect(admin('DELETE FROM "InvoiceLine" WHERE id = $1', [line!.id])).rejects.toThrow(lines)
    await expect(admin('DELETE FROM "Invoice" WHERE id = $1', [id])).rejects.toThrow(/is ISSUED; an issued invoice is never deleted/)
    await expect(admin('TRUNCATE "Invoice" CASCADE')).rejects.toThrow(/TRUNCATE on "Invoice" is refused/)
    // Its note and its SDI status move; DELIVERED is final.
    expect(await run(office(), `UPDATE "Invoice" SET "internalNote" = 'Called the customer' WHERE id = $1::uuid`, id)).toBe(1)
    expect(await setStatus(id, 'SENT')).toBe(1)
    expect(await setStatus(id, 'DELIVERED')).toBe(1)
    await expect(setStatus(id, 'SENT')).rejects.toThrow(/cannot move from DELIVERED to SENT/)
    const [after] = await admin('SELECT number FROM "Invoice" WHERE id = $1', [id])
    expect(after!.number).toBe(number)
  })

  it('a rejected file is corrected and sent again under the same number and date (Provv. AdE 89757/2018)', async () => {
    const { id, number, date, xmlFileId } = await issued()
    await expect(insert(office(), 'SdiSubmission', sendRow(await draft(), xmlFileId))).rejects.toThrow(/is a DRAFT; only an issued invoice is sent/)
    await expect(insert(office(), 'SdiSubmission', sendRow(id, xmlFileId, { status: 'DELIVERED', outcomeAt: new Date().toISOString() }))).rejects.toThrow(/starts SENDING, SENT or FAILED/)
    const first = sendRow(id, xmlFileId)
    await insert(office(), 'SdiSubmission', first)
    expect(await setStatus(id, 'SENT')).toBe(1)
    await insert(office(), 'SdiNotification', {
      id: randomUUID(),
      partyId: A.P1,
      invoiceId: id,
      submissionId: first.id,
      type: 'NS',
      sdiMessageId: `NS-${tag()}`,
      receivedAt: new Date().toISOString(),
      payload: { ListaErrori: [{ Codice: '00305', Descrizione: 'IdFiscaleIVA del cessionario non valido' }] },
    })
    expect(await run(office(), `UPDATE "SdiSubmission" SET status = 'REJECTED', "outcomeAt" = now(), "failureReason" = '00305' WHERE id = $1::uuid`, first.id)).toBe(1)
    expect(await setStatus(id, 'REJECTED')).toBe(1)
    // The number, series, year, date, type, company, party and links stay.
    const frozen = /is issued; its number, series, year, date, party and links never change/
    await expect(run(office(), `UPDATE "Invoice" SET "issueDate" = "issueDate" + 1 WHERE id = $1::uuid`, id)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET number = 'X-2' WHERE id = $1::uuid`, id)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET year = 2027 WHERE id = $1::uuid`, id)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET "salesOrderId" = $2::uuid WHERE id = $1::uuid`, id, seeded.sales.orderId)).rejects.toThrow(frozen)
    await expect(run(office(), `UPDATE "Invoice" SET "docType" = 'TD24' WHERE id = $1::uuid`, id)).rejects.toThrow(/company, buyer, type and creation .* never change/)
    // The buyer's data, the lines and the totals are corrected (the NS may be in any of them, e.g. 00423), and the file.
    const [line] = await admin('SELECT id::text AS id FROM "InvoiceLine" WHERE "invoiceId" = $1', [id])
    expect(await run(office(), `UPDATE "InvoiceLine" SET "netAmount" = 8000, "unitPrice" = '80' WHERE id = $1::uuid`, line!.id)).toBe(1)
    const added = lineRow(id, { seq: 2, description: 'Test gloves', netAmount: 2000, unitPrice: '20' })
    await insert(office(), 'InvoiceLine', added)
    // A line added while REJECTED gets the invoice's party key: the portal keeps seeing the invoice's lines.
    expect(await sql(partner(A.P1), 'SELECT id::text AS id FROM "InvoiceLine" WHERE "invoiceId" = $1::uuid', id)).toHaveLength(2)
    await expect(run(office(), 'UPDATE "InvoiceLine" SET "partyId" = NULL WHERE id = $1::uuid', added.id)).rejects.toThrow(/has the invoice's party key/)
    const extra = lineRow(id, { seq: 3 })
    await insert(office(), 'InvoiceLine', extra)
    expect(await run(office(), 'DELETE FROM "InvoiceLine" WHERE id = $1::uuid', extra.id)).toBe(1)
    const corrected = randomUUID()
    await insert(office(), 'StoredFile', xmlRow(id, corrected))
    expect(
      await run(
        office(),
        `UPDATE "Invoice" SET "billTo" = $2::jsonb, "xmlFileId" = $3::uuid, "netTotal" = 10000, "vatTotal" = 2200, "grossTotal" = 12200,
           "vatSummary" = '[{"rate":"22.00","taxable":10000,"vat":2200,"rounding":0}]' WHERE id = $1::uuid`,
        id,
        JSON.stringify({ ...BILL_TO, vatNumber: '00000001024' }),
        corrected,
      ),
    ).toBe(1)
    // A send carries the invoice's XML of the moment: never the rejected one.
    await expect(insert(office(), 'SdiSubmission', sendRow(id, xmlFileId, { attempt: 2 }))).rejects.toThrow(/not the invoice's XML/)
    const second = sendRow(id, corrected, { attempt: 2 })
    await insert(office(), 'SdiSubmission', second)
    expect(await setStatus(id, 'SENT')).toBe(1)
    expect(await run(office(), `UPDATE "SdiSubmission" SET status = 'DELIVERED', "outcomeAt" = now(), "sdiIdentifier" = 'SDI-1' WHERE id = $1::uuid`, second.id)).toBe(1)
    expect(await setStatus(id, 'DELIVERED')).toBe(1)
    const [row] = await admin('SELECT number, "issueDate"::text AS date FROM "Invoice" WHERE id = $1', [id])
    expect(row).toEqual({ number, date })
    // Once SDI took it, the lines are fixed again.
    await expect(run(office(), 'UPDATE "InvoiceLine" SET "netAmount" = 7000 WHERE id = $1::uuid', line!.id)).rejects.toThrow(/its lines are written only while it is a DRAFT, or REJECTED/)
    await expect(insert(office(), 'InvoiceLine', lineRow(id, { seq: 4 }))).rejects.toThrow(/its lines are written only while it is a DRAFT, or REJECTED/)
    // A send keeps what it sent; its outcome is final.
    await expect(run(office(), `UPDATE "SdiSubmission" SET "xmlFileId" = $2::uuid WHERE id = $1::uuid`, second.id, xmlFileId)).rejects.toThrow(/never change \(a resend is a new row\)/)
    await expect(run(office(), `UPDATE "SdiSubmission" SET status = 'SENT', "outcomeAt" = NULL WHERE id = $1::uuid`, second.id)).rejects.toThrow(/is DELIVERED; it never changes/)
    await expect(admin('DELETE FROM "SdiSubmission" WHERE id = $1', [second.id])).rejects.toThrow(/is kept, never deleted/)
    await expect(run(office(), `UPDATE "Invoice" SET "billTo" = '{"name":"Again"}' WHERE id = $1::uuid`, id)).rejects.toThrow(/corrected only while it is REJECTED/)
  })

  it('a corrected file is sent again only when it passes every check of the issue again', async () => {
    const rejected = async (extra: Record<string, unknown> = {}, lines?: Record<string, unknown>[]) => {
      const id = await draft(extra, lines)
      const invoice = { id, ...(await issue(id)) }
      await insert(office(), 'SdiSubmission', sendRow(invoice.id, invoice.xmlFileId))
      expect(await setStatus(invoice.id, 'SENT')).toBe(1)
      // While SENT the lines and totals are fixed.
      await expect(run(office(), 'UPDATE "InvoiceLine" SET "netAmount" = 1 WHERE "invoiceId" = $1::uuid', invoice.id)).rejects.toThrow(/its lines are written only while/)
      await expect(run(office(), `UPDATE "Invoice" SET "vatSummary" = '[]' WHERE id = $1::uuid`, invoice.id)).rejects.toThrow(/corrected only while it is REJECTED/)
      expect(await setStatus(invoice.id, 'REJECTED')).toBe(1)
      return invoice
    }
    // A line changed without the totals: the resend (and an ERROR) is refused.
    const broken = await rejected()
    expect(await run(office(), 'UPDATE "InvoiceLine" SET "netAmount" = 9000 WHERE "invoiceId" = $1::uuid', broken.id)).toBe(1)
    await expect(setStatus(broken.id, 'SENT')).rejects.toThrow(/the totals of invoice .* do not add up/)
    await expect(setStatus(broken.id, 'ERROR')).rejects.toThrow(/the totals of invoice .* do not add up/)
    // Every line removed: refused too.
    const empty = await rejected()
    expect(await run(office(), 'DELETE FROM "InvoiceLine" WHERE "invoiceId" = $1::uuid', empty.id)).toBe(1)
    await expect(setStatus(empty.id, 'SENT')).rejects.toThrow(/has no line/)
    // A TD24 goods line that loses its DDT: refused.
    const td24 = await rejected({ docType: 'TD24' }, [lineRow('', { ddtId: seeded.shipping.ddtId })])
    expect(await run(office(), 'UPDATE "InvoiceLine" SET "ddtId" = NULL WHERE "invoiceId" = $1::uuid', td24.id)).toBe(1)
    await expect(setStatus(td24.id, 'SENT')).rejects.toThrow(/TD24 .* names its DDT/)
    // Put right, it goes.
    expect(await run(office(), 'UPDATE "InvoiceLine" SET "ddtId" = $2::uuid WHERE "invoiceId" = $1::uuid', td24.id, seeded.shipping.ddtId)).toBe(1)
    expect(await setStatus(td24.id, 'SENT')).toBe(1)
  })

  it('a corrected total never drops below what is paid on the invoice or credited by its credit notes', async () => {
    const paid = await issued(totals(10000))
    const payer = await payment(12200)
    await insert(office(), 'PaymentAllocation', allocationRow(payer, { invoiceId: paid.id }, 7000))
    expect(await setStatus(paid.id, 'SENT')).toBe(1)
    expect(await setStatus(paid.id, 'REJECTED')).toBe(1)
    const lower = (id: string, net: number) => {
      const t = totals(net)
      return run(office(), `UPDATE "Invoice" SET "netTotal" = $2, "vatTotal" = $3, "grossTotal" = $4, "vatSummary" = $5::jsonb WHERE id = $1::uuid`, id, t.netTotal, t.vatTotal, t.grossTotal, JSON.stringify(t.vatSummary))
    }
    await expect(lower(paid.id, 5000)).rejects.toThrow(/has 7000 paid and 0 credited; its corrected gross total 6100 cannot be below them/)
    expect(await lower(paid.id, 6000)).toBe(1)
    const credited = await issued(totals(10000))
    const note = await draft({ docType: 'TD04', creditOfId: credited.id, causale: 'Reso', ...totals(5000) }, [lineRow('', { netAmount: 5000, unitPrice: '50' })])
    await issue(note)
    expect(await setStatus(credited.id, 'SENT')).toBe(1)
    expect(await setStatus(credited.id, 'REJECTED')).toBe(1)
    await expect(lower(credited.id, 4000)).rejects.toThrow(/has 0 paid and 6100 credited; its corrected gross total 4880 cannot be below them/)
    // A credit note of the corrected invoice is checked again at its own resend: never more than is creditable.
    expect(await lower(credited.id, 5000)).toBe(1)
    expect(await setStatus(note, 'SENT')).toBe(1)
    expect(await setStatus(note, 'REJECTED')).toBe(1)
    const t = totals(6000)
    expect(
      await run(office(), `UPDATE "Invoice" SET "netTotal" = $2, "vatTotal" = $3, "grossTotal" = $4, "vatSummary" = $5::jsonb WHERE id = $1::uuid`, note, t.netTotal, t.vatTotal, t.grossTotal, JSON.stringify(t.vatSummary)),
    ).toBe(1)
    expect(await run(office(), 'UPDATE "InvoiceLine" SET "netAmount" = 6000, "unitPrice" = \'60\' WHERE "invoiceId" = $1::uuid', note)).toBe(1)
    await expect(setStatus(note, 'SENT')).rejects.toThrow(/passes what is still creditable/)
  })

  it('a send goes through an SDI account of the invoice company, and the XML is named from the first send on', async () => {
    const { id, xmlFileId } = await issued()
    await expect(insert(office(), 'SdiSubmission', sendRow(id, xmlFileId, { integrationAccountId: key('mo-a', 'integration:account:ses') }))).rejects.toThrow(
      /goes through an SDI account of the invoice's company, not a SES account/,
    )
    await expect(insert(office(), 'SdiSubmission', sendRow(id, xmlFileId, { status: 'FAILED' }))).rejects.toThrow(/FAILED: why/)
    // The XML is named from the first send on, once (a corrected file only while REJECTED).
    const unnamed = await draft()
    await issue(unnamed, { xml: false })
    await expect(setStatus(unnamed, 'SENT')).rejects.toThrow(/it names its XML \(the legal invoice\) from the first send on/)
    const file = randomUUID()
    await insert(office(), 'StoredFile', xmlRow(unnamed, file))
    expect(await run(office(), `UPDATE "Invoice" SET "xmlFileId" = $2::uuid WHERE id = $1::uuid`, unnamed, file)).toBe(1)
    await expect(run(office(), `UPDATE "Invoice" SET "xmlFileId" = $2::uuid WHERE id = $1::uuid`, unnamed, xmlFileId)).rejects.toThrow(/named once/)
  })
})

// --- credit notes and deposit invoices --------------------------------------------------------------------------------

describe('a credit note (TD04)', () => {
  const credit = (creditOfId: string, net: number, extra: Record<string, unknown> = {}) =>
    draft({ docType: 'TD04', creditOfId, causale: 'Reso merce', ...totals(net), ...extra }, [lineRow('', { netAmount: net, unitPrice: `${net / 100}` })])

  it('credits an issued invoice of its company and party, never more than is still creditable', async () => {
    const original = await issued(totals(10000))
    await expect(draft({ docType: 'TD04', ...totals(1000) })).rejects.toThrow(/a TD04 \(and only a TD04\) names the invoice it credits/)
    await expect(credit(await draft(), 1000)).rejects.toThrow(/credits an issued invoice that is not a credit note/)
    await expect(credit(original.id, 1000, { buyerPartyId: A.P3 })).rejects.toThrow(/foreign key|violates/)
    const first = await credit(original.id, 6000)
    await issue(first)
    await expect(credit(first, 100)).rejects.toThrow(/credits an issued invoice that is not a credit note/)
    // 6000 + 4000 of 10000 net (gross 7320 + 4880 = 12200): exactly what is left.
    const second = await credit(original.id, 4000)
    await issue(second)
    const third = await credit(original.id, 100)
    await expect(issue(third)).rejects.toThrow(/passes what is still creditable \(DPR 633\/1972 art. 26\)/)
    const early = await credit((await issued(totals(10000))).id, 100)
    await expect(issue(early, { date: '2026-11-01' })).rejects.toThrow(/of its date or before/)
    const silent = await credit((await issued(totals(10000))).id, 100, { causale: null })
    await expect(issue(silent)).rejects.toThrow(/says why it credits/)
  })
})

describe('a deposit invoice (TD02)', () => {
  it('invoices a deposit request that needs one; its deposit invoices never pass the request', async () => {
    const none = await depositRequest(5000, 'NONE')
    await expect(draft({ docType: 'TD02', depositRequestId: none })).rejects.toThrow(/needs no deposit invoice \(its fiscal document is NONE/)
    const request = await depositRequest(10000)
    const first = await draft({ docType: 'TD02', depositRequestId: request, priceBasis: 'GROSS', ...totals(5000) })
    await issue(first)
    const second = await draft({ docType: 'TD02', depositRequestId: request, priceBasis: 'GROSS', ...totals(5000) })
    await expect(issue(second)).rejects.toThrow(/asks for 10000; its deposit invoices would reach 12200 \(6100 already\)/)
    expect(await run(office(), `UPDATE "DepositRequest" SET status = 'CANCELLED' WHERE id = $1::uuid`, request)).toBe(1)
    const late = await draft({ docType: 'TD02', depositRequestId: request, priceBasis: 'GROSS', ...totals(100) })
    await expect(issue(late)).rejects.toThrow(/which is CANCELLED in EUR; a deposit invoice is for an OPEN or PAID request/)
  })

  it('is deducted at most for its net, by a TD01 or TD24 of its company', async () => {
    const td02 = seeded.depositInvoiceId
    const [{ net }] = (await admin('SELECT "netTotal" AS net FROM "Invoice" WHERE id = $1', [td02])) as [{ net: number }]
    const goods = 1_000_000
    const deducting = (deducted: number, extra: Record<string, unknown> = {}) =>
      draft({ ...totals(goods - deducted), ...extra }, [
        lineRow('', { netAmount: goods, unitPrice: `${goods / 100}` }),
        lineRow('', { seq: 2, kind: 'DEPOSIT_DEDUCTION', description: 'Storno acconto', depositInvoiceId: td02, netAmount: -deducted, unitPrice: `${-deducted / 100}` }),
      ])
    await expect(deducting(100, { docType: 'TD04', creditOfId: td02, causale: 'x' })).rejects.toThrow(/deduction line .* of a TD01 or TD24/)
    await expect(
      draft({}, [lineRow('', { kind: 'DEPOSIT_DEDUCTION', depositInvoiceId: seeded.sampleInvoiceId, netAmount: -100, unitPrice: '-1' })]),
    ).rejects.toThrow(/a deduction names an issued TD02 of the company/)
    await expect(draft({}, [lineRow('', { kind: 'DEPOSIT_DEDUCTION', netAmount: -100, unitPrice: '-1' })])).rejects.toThrow(/names the deposit invoice it deducts/)
    const all = await deducting(net)
    await issue(all)
    const again = await deducting(1)
    await expect(issue(again)).rejects.toThrow(/the invoices that deduct it would deduct/)
  })
})

// --- payments -------------------------------------------------------------------------------------------------------

describe('payments and allocations', () => {
  it('never pass the payment, the invoice less its credit notes, or the deposit request', async () => {
    const invoice = await issued(totals(10000))
    const small = await payment(10000)
    await insert(office(), 'PaymentAllocation', allocationRow(small, { invoiceId: invoice.id }, 6000))
    await expect(insert(office(), 'PaymentAllocation', allocationRow(small, { invoiceId: invoice.id }, 5000))).rejects.toThrow(/payment .* of 10000 has 6000 allocated; 5000 more passes it/)
    const big = await payment(50000)
    await insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: invoice.id }, 6200))
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: invoice.id }, 1))).rejects.toThrow(/is open for 0 \(gross 12200, credited 0, paid 12200\)/)
    // A credit note lowers what is payable.
    const partly = await issued(totals(10000))
    const note = await draft({ docType: 'TD04', creditOfId: partly.id, causale: 'Sconto', ...totals(5000) }, [lineRow('', { netAmount: 5000, unitPrice: '50' })])
    await issue(note)
    await insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: partly.id }, 6100))
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: partly.id }, 1))).rejects.toThrow(/gross 12200, credited 6100, paid 6100/)
    // Only issued TD01 and TD24 are paid.
    const target = /payments go to issued TD01 and TD24 invoices/
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: seeded.draftInvoiceId }, 100))).rejects.toThrow(target)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: seeded.depositInvoiceId }, 100))).rejects.toThrow(target)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: note }, 100))).rejects.toThrow(target)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, {}, 100))).rejects.toThrow(/pays exactly one deposit request or invoice/)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { invoiceId: invoice.id, depositRequestId: seeded.sales.depositRequestId }, 100))).rejects.toThrow(
      /pays exactly one/,
    )
    // A deposit request: OPEN, up to its amount.
    const request = await depositRequest(3000)
    await insert(office(), 'PaymentAllocation', allocationRow(big, { depositRequestId: request }, 2000))
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { depositRequestId: request }, 1500))).rejects.toThrow(/asks for 3000 and has 2000 paid; 1500 more passes it/)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(big, { depositRequestId: seeded.sales.depositRequestId }, 100))).rejects.toThrow(
      /is PAID; payments are allocated to an OPEN request/,
    )
  })

  it('a wrong allocation is reversed once, by a new row; a payment is voided only when it pays nothing', async () => {
    const invoice = await issued(totals(10000))
    const id = await payment(5000)
    const wrong = allocationRow(id, { invoiceId: invoice.id }, 3000)
    await insert(office(), 'PaymentAllocation', wrong)
    const voiding = `UPDATE "Payment" SET status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'Typed twice' WHERE id = $1::uuid`
    await expect(run(office(), voiding, id)).rejects.toThrow(/still pays 3000 \(its allocations\); reverse them before voiding it/)
    const reversal = (extra: Record<string, unknown>) => allocationRow(id, { invoiceId: invoice.id }, -3000, { reversalOfId: wrong.id, note: 'Wrong invoice', ...extra })
    await expect(insert(office(), 'PaymentAllocation', reversal({ note: null }))).rejects.toThrow(/a reversal with a negative amount and a note/)
    await expect(insert(office(), 'PaymentAllocation', reversal({ amount: -2000 }))).rejects.toThrow(/takes back allocation .* exactly/)
    await expect(insert(office(), 'PaymentAllocation', reversal({ amount: 3000 }))).rejects.toThrow(/a reversal with a negative amount/)
    const back = reversal({})
    await insert(office(), 'PaymentAllocation', back)
    await expect(insert(office(), 'PaymentAllocation', reversal({}))).rejects.toThrow(/is reversed already/)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(id, { invoiceId: invoice.id }, 3000, { reversalOfId: back.id, note: 'x' }))).rejects.toThrow(
      /a reversal with a negative amount/,
    )
    await expect(run(office(), `UPDATE "Payment" SET status = 'VOIDED' WHERE id = $1::uuid`, id)).rejects.toThrow(/void time and reason exactly when VOIDED/)
    expect(await run(office(), voiding, id)).toBe(1)
    await expect(insert(office(), 'PaymentAllocation', allocationRow(id, { invoiceId: invoice.id }, 100))).rejects.toThrow(/is VOIDED; it pays nothing/)
    await expect(run(office(), `UPDATE "Payment" SET status = 'RECEIVED', "voidedAt" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/is VOIDED; it never changes/)
    const other = await payment(1000)
    await expect(run(office(), 'UPDATE "Payment" SET amount = 999 WHERE id = $1::uuid', other)).rejects.toThrow(/never change \(a wrong one is voided and typed again\)/)
    await expect(insert(office(), 'Payment', paymentRow(1000, { status: 'VOIDED', voidedAt: new Date().toISOString(), voidReason: 'x' }))).rejects.toThrow(/starts RECEIVED/)
    await expect(admin('DELETE FROM "Payment" WHERE id = $1', [other])).rejects.toThrow(/is kept \(voided when typed by mistake\), never deleted/)
  })

  it('serialise two allocations racing for the last of a payment, and for the last of an invoice, without a deadlock', async () => {
    const [one, two] = [await issued(totals(10000)), await issued(totals(10000))]
    const shared = await payment(10000)
    const byPayment = await race('PaymentAllocation', allocationRow(shared, { invoiceId: one.id }, 6000), allocationRow(shared, { invoiceId: two.id }, 6000))
    expect(byPayment.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((byPayment[1] as PromiseRejectedResult).reason)).toMatch(/has 6000 allocated; 6000 more passes it/)
    const target = await issued(totals(10000))
    const [first, second] = [await payment(10000), await payment(10000)]
    const byInvoice = await race('PaymentAllocation', allocationRow(first, { invoiceId: target.id }, 7000), allocationRow(second, { invoiceId: target.id }, 7000))
    expect(byInvoice.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((byInvoice[1] as PromiseRejectedResult).reason)).toMatch(/is open for 5200 \(gross 12200, credited 0, paid 7000\)/)
  })
})

// --- ledgers and seed ------------------------------------------------------------------------------------------------

describe('the ledgers', () => {
  it('SDI notifications and allocations are append-only, for every login', async () => {
    const [notification] = await admin('SELECT id::text AS id FROM "SdiNotification" WHERE "tenantId" = $1 LIMIT 1', [a.tenantId])
    const allocation = seeded.onAccountAllocationId
    await expect(run(office(), 'UPDATE "SdiNotification" SET "receivedAt" = now() WHERE id = $1::uuid', notification!.id)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "PaymentAllocation" WHERE id = $1::uuid', allocation)).rejects.toThrow(DENIED)
    for (const [table, id] of [
      ['SdiNotification', notification!.id],
      ['PaymentAllocation', allocation],
    ] as const) {
      await expect(admin(`UPDATE "${table}" SET "createdById" = NULL WHERE id = $1`, [id])).rejects.toThrow(new RegExp(`append-only: UPDATE on "${table}" is refused`))
      await expect(admin(`DELETE FROM "${table}" WHERE id = $1`, [id])).rejects.toThrow(new RegExp(`append-only: DELETE on "${table}" is refused`))
      await expect(admin(`TRUNCATE "${table}"`)).rejects.toThrow(new RegExp(`append-only: TRUNCATE on "${table}" is refused`))
    }
    await expect(
      insert(partner(A.P1), 'SdiNotification', { id: randomUUID(), partyId: A.P1, invoiceId: seeded.sampleInvoiceId, submissionId: seeded.sampleSubmissionIds[1], type: 'RC', receivedAt: new Date().toISOString(), payload: {} }),
    ).rejects.toThrow(DENIED)
  })
})

describe('the seed', () => {
  it('is idempotent, and the first rows of each table can be copied by the generated isolation tests', async () => {
    // The ledgers have no updatedAt.
    const STAMP: Record<string, string> = { SdiNotification: 'recordedAt', PaymentAllocation: 'createdAt' }
    const snapshot = async () => {
      const rows: unknown[] = []
      for (const table of MONEY_TABLES) {
        rows.push((await admin(`SELECT count(*)::int AS n, max("${STAMP[table] ?? 'updatedAt'}")::text AS at FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId]))[0])
      }
      return rows
    }
    const before = await snapshot()
    await seedMoney({ db: factory, namespace: 'mo-b' })
    expect(await snapshot()).toEqual(before)
    for (const table of ['Invoice', 'InvoiceLine', 'SdiSubmission', 'PaymentAllocation']) {
      const [first] = await admin(`SELECT id::text AS id FROM "${table}" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [b.tenantId])
      expect(String(first!.id), table).toMatch(/^00000000-/)
    }
    const [series] = await admin('SELECT "nextValue" FROM "NumberSeries" WHERE id = $1', [key('mo-b', 'series:A:INVOICE:MAIN:2026')])
    expect(series).toEqual({ nextValue: 4 })
    const [request] = await admin('SELECT status::text AS status FROM "DepositRequest" WHERE id = $1', [key('mo-b', 'sales:Q1:deposit')])
    expect(request).toEqual({ status: 'PAID' })
  })
})
