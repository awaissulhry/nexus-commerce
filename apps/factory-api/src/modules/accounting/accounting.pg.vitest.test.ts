import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting, type AccountingSeed } from '../../../../../packages/factory-db/seed/accounting'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import { createGateway } from '../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../platform/outbox/testing'
import { createSecretsService } from '../../platform/secrets/envelope'
import { localKeyProvider } from '../../platform/secrets/local'
import { useCountsClock } from '../inventory/counts/counts'
import { useAccountingClock } from './store'

/**
 * Numbered accounting exports, Intrastat data and file, the year-end stock pack and the period lock on the local stack
 * (B-W2a-39; FIN-046, LOG-098, LOG-100), through the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security is real), the factory-db seeds up to accounting (company A: FT-2026-
 * 00001 TD01 of 28 October and the TD02 deposit FT-2026-00003 of 29 October with its payment; September exported as
 * EXP-2026-0001 and HARD-locked; October's export a DRAFT), the local file store behind the gateway. A test invoice to an
 * EU buyer (made here, issued in SQL as the invoicing module would) makes October's Intrastat row.
 *
 *   - the wizard's month: checks with their fixes, contents counted and summed (by grain), the next number;
 *   - Intrastat: the EU sale row flagged until its style has a CN code, origin and mass; the file sums it;
 *   - the first export: refused while a failing check is not explained, a W2b package, the year-end pack in October, a
 *     package of a grain not held; then EXP-2026-0002 with its four CSV files (DOCUMENT, ten years), the October draft
 *     replaced, a repeat answering from its receipt, a second first export refused;
 *   - the re-export: nothing changed is refused; a payment added → EXP-2026-0003 carrying only that payment;
 *   - the locks: soft with warnings, hard only with the phrase, then the database refuses a payment dated in October;
 *     a soft lock lifted with a reason and locked again; a hard lock not lifted without accounting.unlock;
 *   - the year-end pack: December's export carries the signed-off inventory's valued list (PDF and sheet copied, the
 *     same bytes) and the stock valuation at 31 December.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/accounting`.
 */

type Json = Record<string, any>
const NS = 'accounting-a'
const key = (name: string) => seedUuid(NS, name)
const ids = { tenant: key('tenant'), companyA: key('company:A'), companyB: key('company:B'), siteA: key('site:A1'), P1: key('party:P1'), finance: newId(), counter: newId() }

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId, grants })
const fromTemplate = (name: string, actorId = newId()) => {
  const role = templateOf(name)!
  return office(actorId, [grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance', ids.finance),
  owner: fromTemplate('owner'),
  viewer: office(newId(), [grant(['accounting.view'])]),
  /** Exports with the price grain only. */
  pricesOnly: office(newId(), [grant(['accounting.view', 'accounting.export', 'files.read', 'money.price'])]),
  companyB: office(newId(), [grant(['accounting.view', 'accounting.export', 'money.price', 'money.cost'], [ids.companyB])]),
  counter: office(ids.counter, [grant(['inventory.counts.view', 'inventory.counts.manage', 'inventory.counts.approve', 'inventory.counts.signoff', 'inventory.adjust', 'inventory.stock.view', 'money.cost'])]),
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
let seeded: AccountingSeed
let serial = 0
const clock = { at: new Date('2026-10-30T15:00:00.000Z') }
const idem = () => `acc-${randomBytes(4).toString('hex')}-${++serial}`

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown, idempotencyKey: string | null = idem()): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' && idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const problemOf = async (response: Promise<LightMyRequestResponse>, status: number): Promise<string[]> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json().error.issues ?? []).map((issue: Json) => issue.path)
}
const events = async (type: string) => (await admin<{ subject: string; payload: Json }>('SELECT subject, payload FROM "OutboxEvent" WHERE type = $1 ORDER BY id', [type])).map((row) => row.payload)
const fileText = async (exported: Json, pkg: string, session = 'finance'): Promise<string> => {
  const file = exported.files.find((entry: Json) => entry.package === pkg && entry.format === 'CSV')
  const link = await ok(call(session, 'GET', `/accounting/exports/${exported.id}/files/${file.id}/download`))
  const bytes = await app.inject({ method: 'GET', url: link.download.url })
  expect(bytes.statusCode).toBe(200)
  return bytes.body
}

let euInvoice: { id: string; styleId: string }

/** An issued TD01 of 12 jackets to P1 as an EU buyer in Germany (billTo FOREIGN DE), dated 30 October, no DDT. */
async function issueEuInvoice(): Promise<{ id: string; styleId: string }> {
  const [line] = await admin<{ id: string; partyId: string; companyId: string; styleId: string }>(`SELECT l.id, l."partyId", l."companyId", l."styleId" FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o.number = 'SEED-SO-0001' ORDER BY l.seq LIMIT 1`)
  const [series] = await admin<{ id: string }>(`SELECT id FROM "NumberSeries" WHERE "companyId" = $1 AND kind = 'INVOICE' AND "scopeKey" = '2026'`, [ids.companyA])
  const id = newId()
  const at = new Date('2026-10-30T10:00:00.000Z')
  const billTo = { kind: 'FOREIGN', country: 'DE', taxId: '999999999', name: 'Testkunde GmbH', address: { street: 'Musterstraße 1', postcode: '10115', city: 'Berlin', country: 'DE' } }
  const summary = [{ rate: null, nature: 'N3.2', legalRef: 'Art. 41 D.L. 331/1993', taxable: 504000, vat: 0, rounding: 0 }]
  await admin(
    `INSERT INTO "Invoice" (id, "tenantId", "companyId", "buyerPartyId", "docType", status, currency, "billTo", "netTotal", "vatTotal", "grossTotal", "vatSummary", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'TD01', 'DRAFT', 'EUR', $5, 504000, 0, 504000, $6, $7, $7)`,
    [id, ids.tenant, line!.companyId, line!.partyId, JSON.stringify(billTo), JSON.stringify(summary), at],
  )
  await admin(
    `INSERT INTO "InvoiceLine" (id, "tenantId", "invoiceId", "buyerPartyId", seq, kind, description, quantity, uom, "unitPrice", "netAmount", "vatRatePct", "vatNature", "vatLegalRef", "salesOrderLineId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 1, 'GOODS', 'Racing jacket', 12, 'PZ', 420, 504000, 0, 'N3.2', 'Art. 41 D.L. 331/1993', $5, $6, $6)`,
    [newId(), ids.tenant, id, line!.partyId, line!.id, at],
  )
  // The number as allocateNumber gives it: the series' next value, its NumberAllocation row, the series moved on.
  const [next] = await admin<{ nextValue: number }>(`SELECT "nextValue" FROM "NumberSeries" WHERE id = $1`, [series!.id])
  const number = `FT-2026-${String(next!.nextValue).padStart(5, '0')}`
  await admin(
    `INSERT INTO "NumberAllocation" (id, "tenantId", "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
     VALUES ($1, $2, $3, $4, 'INVOICE', $5, $6, '2026-10-30', 'Invoice', $7, $8, $9, 'accounting-test')`,
    [newId(), ids.tenant, ids.companyA, series!.id, next!.nextValue, number, id, at, ids.finance],
  )
  await admin(`UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 1, "lastIssuedDate" = '2026-10-30', version = version + 1 WHERE id = $1`, [series!.id])
  await admin(
    `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2, number = $5, year = 2026, "issueDate" = '2026-10-30', "issuedAt" = $3, "issuedById" = $4, "partyId" = "buyerPartyId", seller = '{}'::jsonb, version = 2, "updatedAt" = $3 WHERE id = $1`,
    [id, series!.id, at, ids.finance, number],
  )
  return { id, styleId: line!.styleId }
}

beforeAll(async () => {
  db = await migratedDatabase('accounting')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  seeded = await seedAccounting({ db: database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [ids.tenant])
  for (const [id, name] of [
    [ids.finance, 'Fiona Neri'],
    [ids.counter, 'Carla Conti'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, ids.tenant, `${id.slice(-6)}@example.com`, name])
  }
  useAccountingClock({ now: () => clock.at })
  useCountsClock({ now: () => clock.at })
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-accounting-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  euInvoice = await issueEuInvoice()
}, 180_000)

afterAll(async () => {
  useAccountingClock(undefined)
  useCountsClock(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const OCTOBER = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT']
// B-W2b-30: the shipping seed dates DDT 144/2026 on 30 October; its goods are on the money seed's TD24 DRAFT, so October's
// "every shipment invoiced" check fails and each October export explains it.
const SEED_DDT_EXPLAINED = { code: 'SHIPMENTS_INVOICED', explanation: 'DDT 144/2026 of 30 October is on a TD24 draft, issued in November.' }
let first: Json

describe('the months and the wizard (design finance.accounting 1 · Period … 4 · Review)', () => {
  it('lists the year: September exported and closed for good, October with its unfinished draft', async () => {
    const year = await ok(call('finance', 'GET', `/accounting/periods?companyId=${ids.companyA}&year=2026`))
    expect(year.yearEndMonth).toBe('2026-12')
    const september = year.months.find((month: Json) => month.period.month === '2026-09')
    expect(september).toMatchObject({ ended: true, lock: { level: 'HARD', status: 'LOCKED' }, latest: { number: 'EXP-2026-0001' } })
    const october = year.months.find((month: Json) => month.period.month === '2026-10')
    expect(october).toMatchObject({ ended: false, lock: null, latest: null, exports: [{ id: seeded.draftExportId, status: 'DRAFT' }] })
    expect((await call('companyB', 'GET', `/accounting/periods?companyId=${ids.companyA}&year=2026`)).statusCode).toBe(403)
    expect((await call('counter', 'GET', `/accounting/periods?companyId=${ids.companyA}&year=2026`)).statusCode).toBe(403)
  })

  it('flags the EU sale until its style has a CN code, origin and mass; the file sums it (LOG-098, LOG-100)', async () => {
    const before = await ok(call('finance', 'GET', `/accounting/intrastat?companyId=${ids.companyA}&month=2026-10`))
    expect(before.rows).toHaveLength(1)
    expect(before.rows[0]).toMatchObject({ invoice: { number: 'FT-2026-00004' }, partnerVatId: 'DE999999999', destinationCountry: 'DE', value: 504000, supplementaryUnits: '12', nature: 'SALE', suggestedNatureCode: '11', transportMode: null })
    expect(before.rows[0].flags.map((flag: Json) => flag.code)).toEqual(expect.arrayContaining(['CN_CODE_MISSING', 'ORIGIN_MISSING', 'NET_MASS_MISSING', 'DESTINATION_FROM_BILL_TO']))
    expect(before.rows[0].flags.find((flag: Json) => flag.code === 'CN_CODE_MISSING').fix).toEqual({ recordType: 'Style', recordId: euInvoice.styleId, field: 'hsCode' })
    expect(before.blocking).toBe(1)
    expect(before.words).toContain('TO CONFIRM WITH THE ACCOUNTANT')
    // Without the price grain the values are not drawn (the row and its flags are).
    const viewer = await ok(call('viewer', 'GET', `/accounting/intrastat?companyId=${ids.companyA}&month=2026-10`))
    expect(viewer.rows[0].value).toBeUndefined()
    expect(viewer.rows[0].cnCode).toBeNull()

    await admin(`UPDATE "Style" SET "hsCode" = '4203100010', "originCountry" = 'IT', "netMassKg" = 1.850 WHERE id = $1`, [euInvoice.styleId])
    const after = await ok(call('finance', 'GET', `/accounting/intrastat?companyId=${ids.companyA}&month=2026-10`))
    expect(after.rows[0]).toMatchObject({ cnCode: '42031000', originCountry: 'IT', netMassKg: '22.200' })
    expect(after.blocking).toBe(0)
    expect(after.fileRows).toEqual([expect.objectContaining({ partnerVatId: 'DE999999999', cnCode: '42031000', value: 504000, netMassKg: '22.200', documents: ['FT-2026-00004'] })])
  })

  it("reads October's checks, contents and next number; amounts only with their grain", async () => {
    const month = await ok(call('finance', 'GET', `/accounting/periods/2026-10?companyId=${ids.companyA}&packages=${OCTOBER.join(',')}`))
    expect(month).toMatchObject({ ended: false, yearEnd: false, reExportOf: null, draft: { id: seeded.draftExportId }, nextNumber: 'EXP-2026-0002', layout: 'DEFAULT' })
    const checks = Object.fromEntries(month.checks.map((check: Json) => [check.code, check]))
    expect(checks.PERIOD_ENDED).toMatchObject({ passed: false, count: 1 })
    expect(checks.INTRASTAT_COMPLETE.passed).toBe(true)
    expect(checks.NO_INVOICE_REJECTED.passed).toBe(true)
    expect(checks.TOTALS_EQUAL_ROWS.passed).toBe(true)
    expect(Object.keys(checks)).not.toContain('YEAR_END_SIGNED_OFF')
    const sales = month.contents.find((entry: Json) => entry.package === 'SALES_JOURNAL')
    expect(sales.documents).toMatchObject({ documents: 3, new: 3, changed: 0 })
    expect(sales.priceTotals.find((total: Json) => total.key === 'GROSS')).toMatchObject({ currency: 'EUR', amount: expect.any(Number) })
    // No purchase arrived in October; the supplier invoice of 13 November is November's.
    expect(month.contents.find((entry: Json) => entry.package === 'PURCHASES_JOURNAL').documents.documents).toBe(0)
    const viewer = await ok(call('viewer', 'GET', `/accounting/periods/2026-10?companyId=${ids.companyA}&packages=${OCTOBER.join(',')}`))
    expect(viewer.contents.find((entry: Json) => entry.package === 'SALES_JOURNAL').priceTotals[0].amount).toBeUndefined()
    expect(viewer.contents.find((entry: Json) => entry.package === 'PURCHASES_JOURNAL')).toMatchObject({ available: false, heldReason: expect.stringContaining('cost grain') })
  })
})

describe('the first export of a month (FIN-046 numbered batch)', () => {
  it('is refused while a failing check is not explained, for a W2b package, the year-end pack in October and a grain not held', async () => {
    const body = { companyId: ids.companyA, month: '2026-10', packages: OCTOBER }
    expect(await problemOf(call('finance', 'POST', '/accounting/exports', body), 400)).toEqual(['body/explanations/PERIOD_ENDED', 'body/explanations/SHIPMENTS_INVOICED'])
    expect(await problemOf(call('finance', 'POST', '/accounting/exports', { ...body, packages: ['VAT_REGISTERS'] }), 409)).toEqual(['problem/PACKAGE_W2B'])
    expect(await problemOf(call('finance', 'POST', '/accounting/exports', { ...body, packages: ['YEAR_END_STOCK'] }), 409)).toEqual(['problem/YEAR_END_NOT_THIS_PERIOD'])
    expect((await call('pricesOnly', 'POST', '/accounting/exports', body)).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/accounting/exports', body)).statusCode).toBe(403)
    expect((await call('companyB', 'POST', '/accounting/exports', body)).statusCode).toBe(403)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AccountingExport" WHERE "periodStart" = '2026-10-01' AND status = 'EXPORTED'`))[0]!.n).toBe(0)
  })

  it('makes EXP-2026-0002 with its files, replaces the draft, and answers a repeat from its receipt', async () => {
    const idempotencyKey = idem()
    const body = { companyId: ids.companyA, month: '2026-10', packages: OCTOBER, explanations: [{ code: 'PERIOD_ENDED', explanation: 'Exported on the last working day for the VAT advance; a re-export brings the 31st.' }, SEED_DDT_EXPLAINED], note: 'October.' }
    first = (await ok(call('finance', 'POST', '/accounting/exports', body, idempotencyKey), 201)).export
    expect(first).toMatchObject({ number: 'EXP-2026-0002', status: 'EXPORTED', layout: 'DEFAULT', supersedes: null, madeBy: { name: 'Fiona Neri' }, exportedBy: { name: 'Fiona Neri' }, changedSince: { count: 0 } })
    expect(first.files.map((file: Json) => [file.seq, file.package, file.format, file.rowCount])).toEqual([
      [1, 'SALES_JOURNAL', 'CSV', 3],
      [2, 'PURCHASES_JOURNAL', 'CSV', 0],
      [3, 'PAYMENTS', 'CSV', 1],
      [4, 'INTRASTAT', 'CSV', 1],
    ])
    expect(first.checks.find((check: Json) => check.code === 'PERIOD_ENDED')).toMatchObject({ passed: false, explanation: expect.stringContaining('VAT advance') })
    expect(first.manifest.filter((entry: Json) => entry.package === 'SALES_JOURNAL').map((entry: Json) => entry.number).sort()).toEqual(['FT-2026-00001', 'FT-2026-00003', 'FT-2026-00004'])
    const stored = await admin<Json>(`SELECT kind, "contentType", "recordType", "retainUntil", "originalName" FROM "StoredFile" WHERE "recordId" = $1 ORDER BY "originalName"`, [first.id])
    expect(stored).toHaveLength(4)
    for (const file of stored) expect([file.kind, file.contentType, file.recordType, (file.retainUntil as Date).getUTCFullYear() >= 2036]).toEqual(['DOCUMENT', 'text/csv', 'AccountingExport', true])
    const [company] = await admin<{ code: string }>('SELECT code FROM "Company" WHERE id = $1', [ids.companyA])
    expect(stored.map((file) => file.originalName)).toContain(`${company!.code}_2026-10_sales-journal.csv`)
    expect(await admin(`SELECT formatted FROM "NumberAllocation" WHERE "recordType" = 'AccountingExport' AND "recordId" = $1`, [first.id])).toEqual([{ formatted: 'EXP-2026-0002' }])
    expect(await events('accounting_export.exported')).toEqual([expect.objectContaining({ exportId: first.id, number: 'EXP-2026-0002', periodStart: '2026-10-01', files: 4, supersedesId: null })])
    const [draft] = await admin<Json>('SELECT status, "cancelReason" FROM "AccountingExport" WHERE id = $1', [seeded.draftExportId])
    expect(draft).toMatchObject({ status: 'CANCELLED', cancelReason: expect.stringContaining('Replaced') })

    const sales = await fileText(first, 'SALES_JOURNAL')
    expect(sales.split('\r\n')[0]).toContain('tracciato DEFAULT (da confermare con il commercialista)')
    expect(sales.split('\r\n')[1]).toBe('Numero;Data;Tipo;Codice cliente;Cliente;Partita IVA;Codice fiscale;Paese;Aliquota IVA;Natura IVA;Imponibile;IVA;Totale documento;Bollo;Nota di credito su;Variazione')
    expect(sales).toContain('FT-2026-00004;2026-10-30;TD01;')
    expect(sales).toContain(';DE999999999;;DE;;N3.2;5040,00;0,00;5040,00;;;NEW')
    const intrastat = await fileText(first, 'INTRASTAT')
    expect(intrastat).toContain('DE999999999;DE;42031000;SALE;11;')
    expect(intrastat).toContain(';IT;5040,00;22,2;12;FT-2026-00004')
    // A person without the price grain gets no link to a price file.
    expect((await call('viewer', 'GET', `/accounting/exports/${first.id}/files/${first.files[0].id}/download`)).statusCode).toBe(403)

    const replay = await ok(call('finance', 'POST', '/accounting/exports', body, idempotencyKey), 201)
    expect(replay.export).toMatchObject({ id: first.id, number: 'EXP-2026-0002' })
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AccountingExport" WHERE "periodStart" = '2026-10-01'`))[0]!.n).toBe(2)
    expect(await problemOf(call('finance', 'POST', '/accounting/exports', body), 409)).toEqual(['problem/ALREADY_EXPORTED'])
  })

  it('shows the batch in the history with its files and what may be done', async () => {
    const list = await ok(call('finance', 'GET', `/accounting/exports?companyId=${ids.companyA}`))
    expect(list.rows.map((row: Json) => [row.number, row.status, row.period.month])).toEqual([
      ['EXP-2026-0002', 'EXPORTED', '2026-10'],
      [null, 'CANCELLED', '2026-10'],
      ['EXP-2026-0001', 'EXPORTED', '2026-09'],
    ])
    const record = await ok(call('finance', 'GET', `/accounting/exports/${first.id}`))
    expect(record.export.actions).toMatchObject({ reExport: { allowed: false, reason: 'Nothing changed since this batch.' }, cancel: { allowed: false }, lock: { allowed: true }, download: { allowed: true } })
    expect(record.export.words).toContain('to confirm with the accountant')
    expect((await call('companyB', 'GET', `/accounting/exports/${first.id}`)).statusCode).toBe(404)
  })
})

describe('the re-export: only the changes (never twice)', () => {
  it('is refused when nothing changed; a payment of 31 October goes alone in EXP-2026-0003', async () => {
    const body = { companyId: ids.companyA, month: '2026-10', packages: OCTOBER, supersedesId: first.id, explanations: [{ code: 'PERIOD_ENDED', explanation: 'Still the same day.' }, SEED_DDT_EXPLAINED] }
    expect(await problemOf(call('finance', 'POST', '/accounting/exports', body), 409)).toEqual(['problem/NOTHING_CHANGED'])
    await admin(
      `INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, currency, "receivedOn", "externalRef", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 12000, 'EUR', '2026-10-31', 'SEED-TRN-LATE-0001', $5, $5)`,
      [newId(), ids.tenant, ids.companyA, ids.P1, new Date('2026-10-31T10:00:00.000Z')],
    )
    const history = await ok(call('finance', 'GET', `/accounting/exports?companyId=${ids.companyA}&year=2026`))
    expect(history.rows.find((row: Json) => row.id === first.id).changedSince).toMatchObject({ count: 1 })
    clock.at = new Date('2026-11-03T09:00:00.000Z')
    const second = (await ok(call('finance', 'POST', '/accounting/exports', { ...body, explanations: [{ code: 'PAYMENTS_PLACED', explanation: 'The late transfer is placed in November.' }, SEED_DDT_EXPLAINED] }), 201)).export
    expect(second).toMatchObject({ number: 'EXP-2026-0003', supersedes: { id: first.id, number: 'EXP-2026-0002' }, packages: ['PAYMENTS'] })
    expect(second.files.map((file: Json) => [file.package, file.rowCount])).toEqual([['PAYMENTS', 1]])
    expect(second.manifest).toEqual([expect.objectContaining({ recordType: 'Payment', number: 'SEED-TRN-LATE-0001', change: 'NEW' })])
    const payments = await fileText(second, 'PAYMENTS')
    expect(payments.split('\r\n')[0]).toContain('solo le variazioni da EXP-2026-0002')
    expect(payments).toContain('PAYMENT;2026-10-31;SEED-TRN-LATE-0001;')
    expect(payments).not.toContain('SEED-TRN-0000001')
    const record = await ok(call('finance', 'GET', `/accounting/exports/${first.id}`))
    expect(record.export).toMatchObject({ supersededBy: { number: 'EXP-2026-0003' }, changedSince: null })
  })
})

describe('the period locks (5 · Export and lock)', () => {
  let lock: Json

  it('soft-locks October, then closes it for good only with its phrase; the database then refuses what is dated in it', async () => {
    const soft = await ok(call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-10', level: 'SOFT', note: 'Closing October.' }))
    expect(soft.lock).toMatchObject({ level: 'SOFT', status: 'LOCKED', export: { number: 'EXP-2026-0003' }, lockedBy: { name: 'Fiona Neri' } })
    lock = soft.lock
    expect(await problemOf(call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-10', level: 'HARD', phrase: 'close it', version: lock.version }), 400)).toEqual(['body/phrase'])
    expect(await problemOf(call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-10', level: 'SOFT', version: lock.version }), 409)).toEqual(['problem/ALREADY_LOCKED'])
    const hard = await ok(call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-10', level: 'HARD', phrase: 'Chiudi ottobre 2026', version: lock.version }))
    expect(hard.lock).toMatchObject({ id: lock.id, level: 'HARD', status: 'LOCKED', words: expect.stringContaining('Closed for good') })
    lock = hard.lock
    expect((await events('period_lock.locked')).map((event) => event.level)).toEqual(['SOFT', 'HARD'])
    await expect(
      admin(`INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, currency, "receivedOn", "externalRef", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 100, 'EUR', '2026-10-15', 'LATE-AFTER-CLOSE', now(), now())`, [newId(), ids.tenant, ids.companyA, ids.P1]),
    ).rejects.toThrow(/period lock/)
    const month = await ok(call('finance', 'GET', `/accounting/periods/2026-10?companyId=${ids.companyA}`))
    expect(month.lock).toMatchObject({ level: 'HARD', status: 'LOCKED' })
  })

  it('lifts a soft lock with a reason and locks it again; a hard lock is not lifted without accounting.unlock', async () => {
    expect((await call('finance', 'POST', `/accounting/locks/${lock.id}/lift`, { version: lock.version, reason: 'A correction.' })).statusCode).toBe(403)
    const november = await ok(call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-11', level: 'SOFT' }))
    expect(november.warnings.length).toBeGreaterThanOrEqual(0)
    const lifted = await ok(call('finance', 'POST', `/accounting/locks/${november.lock.id}/lift`, { version: november.lock.version, reason: 'A supplier invoice arrives late.' }))
    expect(lifted.lock).toMatchObject({ status: 'UNLOCKED', unlockReason: 'A supplier invoice arrives late.', unlockedBy: { name: 'Fiona Neri' } })
    clock.at = new Date('2026-11-03T10:00:00.000Z')
    const again = await ok(call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-11', level: 'SOFT', version: lifted.lock.version }))
    expect(again.lock).toMatchObject({ id: november.lock.id, status: 'LOCKED', unlockReason: null })
    const list = await ok(call('viewer', 'GET', `/accounting/locks?companyId=${ids.companyA}`))
    expect(list.locks.map((row: Json) => [row.period.month, row.level, row.status])).toEqual([
      ['2026-11', 'SOFT', 'LOCKED'],
      ['2026-10', 'HARD', 'LOCKED'],
      ['2026-09', 'HARD', 'LOCKED'],
    ])
    expect((await call('viewer', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-12', level: 'SOFT' })).statusCode).toBe(403)
  })
})

describe('the year-end stock pack (FIN-046, c.c. art. 2217)', () => {
  it("carries the signed-off inventory's valued list as it was frozen, and the valuation at 31 December", async () => {
    // A seeded cycle count holding the store (the planning seed's) is cancelled before the year-end inventory of the site.
    for (const cycle of await admin<{ id: string; version: number }>(`SELECT id, version FROM "StockCount" WHERE number = 'SEED-CNT-0001' AND status = 'COUNTING'`)) {
      await ok(call('counter', 'POST', `/inventory/stock-counts/${cycle.id}/cancel`, { version: cycle.version, reason: 'The year-end inventory counts everything.' }))
    }
    clock.at = new Date('2027-01-04T08:00:00.000Z')
    let count = (await ok(call('counter', 'POST', '/inventory/stock-counts', { siteId: ids.siteA, kind: 'YEAR_END', inventoryDate: '2026-12-31', start: true }), 201)).count
    const lines = (await ok(call('counter', 'GET', `/inventory/stock-counts/${count.id}/lines?limit=500`))).lines as Json[]
    await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/lines/record`, { lines: lines.map((line) => ({ lineId: line.id, version: line.version, counted: line.expected })) }))
    count = (await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/submit`, { version: count.version }))).count
    count = (await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/apply`, { version: count.version }))).count
    count = (await ok(call('counter', 'POST', `/inventory/stock-counts/${count.id}/sign-off`, { version: count.version, phrase: count.number }))).count
    expect(count.status).toBe('SIGNED_OFF')

    const month = await ok(call('finance', 'GET', `/accounting/periods/2026-12?companyId=${ids.companyA}`))
    expect(month).toMatchObject({ yearEnd: true, packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'YEAR_END_STOCK'] })
    const checks = Object.fromEntries(month.checks.map((check: Json) => [check.code, check]))
    expect(checks.YEAR_END_SIGNED_OFF.passed).toBe(true)
    expect(checks.STOCK_VALUED.passed).toBe(true)
    expect(month.contents.find((entry: Json) => entry.package === 'YEAR_END_STOCK').costTotals[0]).toMatchObject({ key: 'VALUE', currency: 'EUR', amount: expect.any(Number) })
    // Without the cost grain the pack is not exported.
    expect((await call('pricesOnly', 'POST', '/accounting/exports', { companyId: ids.companyA, month: '2026-12', packages: ['YEAR_END_STOCK'] })).statusCode).toBe(403)

    const explanations = month.checks.filter((check: Json) => !check.passed).map((check: Json) => ({ code: check.code, explanation: `Known at the close: ${check.words}` }))
    const pack = (await ok(call('finance', 'POST', '/accounting/exports', { companyId: ids.companyA, month: '2026-12', packages: ['YEAR_END_STOCK'], explanations, language: 'en' }), 201)).export
    expect(pack).toMatchObject({ number: 'EXP-2027-0001', packages: ['YEAR_END_STOCK'] })
    expect(pack.files.map((file: Json) => file.format)).toEqual(['PDF', 'XLSX', 'CSV'])
    const copies = await admin<Json>(`SELECT f.kind, f.sha256, f."recordType" FROM "AccountingExportFile" e JOIN "StoredFile" f ON f.id = e."fileId" WHERE e."exportId" = $1 ORDER BY e.seq`, [pack.id])
    const frozen = await admin<Json>(`SELECT kind, sha256 FROM "StoredFile" WHERE "recordType" = 'StockCount' AND "recordId" = $1 ORDER BY kind DESC`, [count.id])
    expect(copies.slice(0, 2).map((file) => [file.kind, file.sha256])).toEqual(frozen.map((file) => [file.kind, file.sha256]))
    expect(copies.every((file) => file.recordType === 'AccountingExport')).toBe(true)
    const valuation = await fileText(pack, 'YEAR_END_STOCK')
    expect(valuation.split('\r\n')[0]).toContain('values at the end of 2026-12-31, costing method to confirm')
    expect(valuation.split('\r\n')[1]).toBe('Category,Site,Item code,Item,Colour,Lot,Work order,Quantity,Unit,Hides,Value,Valued,Depends on the costing method')
    expect(valuation).toContain('WIP,')
    expect(pack.manifest.map((entry: Json) => entry.recordType).sort()).toEqual(['StockCount', 'StockValuation'])
  })
})
