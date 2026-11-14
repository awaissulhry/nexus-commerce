import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCostActuals, type CostActualsSeed } from '../../../../../../packages/factory-db/seed/cost-actuals'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedTax } from '../../../../../../packages/factory-db/seed/tax'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { saveJournalsSettings } from '../mapping/service'
import { useAccountingClock } from '../store'
import { runNightlyIntegrity } from './jobs'

// The routes' clock: 2 December 2026, after November (the seeds' month of the cost bridge), running on from there.
vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-12-02T09:00:00.000Z'), shouldAdvanceTime: true })
afterAll(() => vi.useRealTimers())

/**
 * The accountant's bridge on the local stack (B-W2b-408; FIN-106, FIN-151, FIN-152, FIN-154, FIN-157), through the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), the
 * factory-db seeds up to the actual costs (company A: November's work-order close with its variances and an undone close,
 * the purchase price variance of P2's invoice 2026/0412, the cost of goods sold of SEED-SH-0001 with a reversal) and the
 * tax codes (company A's 22 % code with its account key VAT_SALES_22).
 *
 *   - the account mapping: a key's first row may start earlier, a change starts today or later, a row is changed or
 *     removed only before its first day, a key Nexus does not post is refused; every write audited with its event;
 *   - the journals switch: the route asks a fresh code (a test session has none: 401); switched on as the route does after it;
 *   - November's export with the cost of goods sold and variances and the VAT registers: the checks (work orders closed,
 *     every account mapped, entries balance), the files (registers, entries with the mapped accounts, the three VAT files),
 *     each document handed over once (an invoice in two packages is one document);
 *   - a later change: the integrity checks run now flag the document once; the re-export hands it over as CHANGED, and the
 *     check passes again; the nightly run keeps a run per check of every active company (no person).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/accounting`.
 */

type Json = Record<string, any>
const NS = 'bridge-a'
const key = (name: string) => seedUuid(NS, name)
const ids = { tenant: key('tenant'), companyA: key('company:A'), companyB: key('company:B'), P2: key('party:P2'), finance: newId() }

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId, grants })
const fromTemplate = (name: string, actorId = newId()) => {
  const role = templateOf(name)!
  return office(actorId, [grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance', ids.finance),
  viewer: office(newId(), [grant(['accounting.view'])]),
  companyB: office(newId(), [grant(['accounting.view', 'accounting.mapping.manage'], [ids.companyB])]),
  /** Locks months, but may not close one for good. */
  locker: office(newId(), [grant(['accounting.view', 'accounting.lock'])]),
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
let seeded: CostActualsSeed
let serial = 0
const clock = { at: new Date('2026-12-02T09:00:00.000Z') }
const idem = () => `bridge-${randomBytes(4).toString('hex')}-${++serial}`

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const events = async (type: string) => (await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 ORDER BY id', [type])).map((row) => row.payload)
const fileText = async (exported: Json, name: string): Promise<string> => {
  const file = exported.files.find((entry: Json) => entry.file.name.endsWith(name))
  expect(file, `${name} in ${exported.files.map((entry: Json) => entry.file.name).join(', ')}`).toBeDefined()
  const link = await ok(call('finance', 'GET', `/accounting/exports/${exported.id}/files/${file.id}/download`))
  const bytes = await app.inject({ method: 'GET', url: link.download.url })
  expect(bytes.statusCode).toBe(200)
  return bytes.body
}

beforeAll(async () => {
  db = await migratedDatabase('bridge')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  seeded = await seedCostActuals({ db: database, namespace: NS })
  await seedTax({ db: database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [ids.tenant])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Fiona Neri', 'ACTIVE')`, [ids.finance, ids.tenant, `${ids.finance.slice(-6)}@example.com`])
  useAccountingClock({ now: () => clock.at })
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-bridge-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  useAccountingClock(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const NOVEMBER = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS']

describe('the account mapping in one place (FIN-152)', () => {
  it('lists every key Nexus posts, with the row in force today, and who may keep it', async () => {
    const mapping = await ok(call('finance', 'GET', `/accounting/mapping?companyId=${ids.companyA}`))
    const keys = new Map(mapping.keys.map((entry: Json) => [`${entry.kind}|${entry.key}`, entry]))
    expect(keys.get('TAX_CODE|VAT_SALES_22')).toMatchObject({ posted: true, words: { en: 'Output VAT: Ordinary rate 22%' }, current: null })
    expect(keys.get('PARTY_GROUP|CUSTOMERS_IT')).toMatchObject({ posted: true, current: null, upcoming: [], earlier: [] })
    expect(mapping).toMatchObject({ journals: { journalsOn: false, from: 'DEFAULT', can: { switch: true } }, can: { manage: true }, words: expect.stringContaining('GATE-ACCOUNTANT') })
    expect(mapping.unmapped).toBe(mapping.keys.filter((entry: Json) => entry.posted).length)
    expect((await ok(call('viewer', 'GET', `/accounting/mapping?companyId=${ids.companyA}&kind=PAYMENT_METHOD`))).keys.map((entry: Json) => entry.key)).toEqual(['BANK_TRANSFER', 'CARD', 'SEPA_DEBIT'])
    expect((await ok(call('viewer', 'GET', `/accounting/mapping?companyId=${ids.companyA}`))).can.manage).toBe(false)
  })

  it("maps keys from a day (a key's first row may start earlier); refuses a change backdated, a day taken, a key Nexus does not post", async () => {
    const add = (body: Json) => call('finance', 'POST', '/accounting/mapping', { companyId: ids.companyA, ...body })
    const rows: Record<string, Json> = {}
    for (const [kind, key, accountCode] of [
      ['PARTY_GROUP', 'CUSTOMERS_IT', '1201'],
      ['PARTY_GROUP', 'SUPPLIERS_IT', '2201'],
      ['ITEM_GROUP', 'SALES_GARMENTS', '7001'],
      ['TAX_CODE', 'VAT_SALES_22', '2601'],
      ['TAX_CODE', 'VAT_INPUT', '1601'],
      ['PAYMENT_METHOD', 'BANK_TRANSFER', '1801'],
      ['COST_CATEGORY', 'COST_OF_SALES', '6801'],
      ['COST_CATEGORY', 'FINISHED_GOODS', '1401'],
    ] as const) {
      rows[key] = (await ok(add({ kind, key, accountCode, validFrom: '2026-01-01' }), 201)).row
    }
    expect(rows.CUSTOMERS_IT).toMatchObject({ kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', accountCode: '1201', validFrom: '2026-01-01', fixed: true, createdBy: { name: 'Fiona Neri' }, version: 1 })
    expect(await problemOf(add({ kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', accountCode: '1202', validFrom: '2026-11-01' }), 409)).toEqual(['problem/BACKDATED'])
    expect(await problemOf(add({ kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', accountCode: '1202', validFrom: '2026-01-01' }), 409)).toEqual(['problem/BACKDATED'])
    expect(await problemOf(add({ kind: 'ITEM_GROUP', key: 'FINISHED', accountCode: '7002', validFrom: '2027-01-01' }), 400)).toEqual(['body/key'])
    expect(await problemOf(add({ kind: 'ITEM_GROUP', key: 'SALES_FEE', accountCode: '-7002', validFrom: '2027-01-01' }), 400)).toEqual(['body/accountCode'])
    expect((await call('viewer', 'POST', '/accounting/mapping', { companyId: ids.companyA, kind: 'ITEM_GROUP', key: 'SALES_FEE', accountCode: '7003', validFrom: '2027-01-01' })).statusCode).toBe(403)
    expect((await call('companyB', 'POST', '/accounting/mapping', { companyId: ids.companyA, kind: 'ITEM_GROUP', key: 'SALES_FEE', accountCode: '7003', validFrom: '2027-01-01' })).statusCode).toBe(403)

    // A change from a later day: changed and removed only before it.
    const next = (await ok(add({ kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', accountCode: '1210', validFrom: '2027-03-01', note: 'The new chart from March.' }), 201)).row
    expect(await problemOf(add({ kind: 'PARTY_GROUP', key: 'CUSTOMERS_IT', accountCode: '1211', validFrom: '2027-03-01' }), 409)).toEqual(['problem/SAME_DAY'])
    const changed = (await ok(call('finance', 'PATCH', `/accounting/mapping/${next.id}`, { version: next.version, accountCode: '1220' }))).row
    expect(changed).toMatchObject({ accountCode: '1220', note: 'The new chart from March.', fixed: false, version: 2 })
    expect(await problemOf(call('finance', 'PATCH', `/accounting/mapping/${changed.id}`, { version: changed.version, accountCode: '1220' }), 409)).toEqual(['problem/NOTHING_CHANGES'])
    expect(await problemOf(call('finance', 'PATCH', `/accounting/mapping/${rows.CUSTOMERS_IT!.id}`, { version: 1, accountCode: '1299' }), 409)).toEqual(['problem/FIXED'])
    expect(await problemOf(call('finance', 'DELETE', `/accounting/mapping/${rows.CUSTOMERS_IT!.id}?version=1`), 409)).toEqual(['problem/FIXED'])
    expect((await call('finance', 'PATCH', `/accounting/mapping/${changed.id}`, { version: 1, accountCode: '1230' })).statusCode).toBe(409)
    expect(await ok(call('finance', 'DELETE', `/accounting/mapping/${changed.id}?version=${changed.version}`))).toEqual({ removed: changed.id })

    const mapping = await ok(call('finance', 'GET', `/accounting/mapping?companyId=${ids.companyA}&kind=PARTY_GROUP`))
    expect(mapping.keys.find((entry: Json) => entry.key === 'CUSTOMERS_IT')).toMatchObject({ current: { accountCode: '1201' }, upcoming: [] })
    expect((await events('account_mapping.changed')).map((event) => event.change)).toEqual([...Array(9).fill('ADDED'), 'CHANGED', 'REMOVED'])
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'AccountMapping' ORDER BY at, id`)
    expect(audit.map((row) => row.action)).toEqual([...Array(9).fill('accounting.addMapping'), 'accounting.changeMapping', 'accounting.removeMapping'])
  })
})

describe('closing a month for good needs accounting.close (FIN-155)', () => {
  it('is refused in words to whoever only locks months, before the phrase or a code is asked', async () => {
    const answer = await call('locker', 'POST', '/accounting/locks', { companyId: ids.companyA, month: '2026-08', level: 'HARD', phrase: 'close August 2026' })
    expect(answer.statusCode).toBe(403)
    expect(answer.json().error.message).toBe('Closing a month for good needs accounting.close: nothing dated in it can change afterwards.')
    expect(await admin(`SELECT id FROM "PeriodLock" WHERE "periodStart" = '2026-08-01'`)).toEqual([])
  })
})

describe('the journals switch (FIN-151; GATE-ACCOUNTANT)', () => {
  it('asks a fresh code on its route; switched on as the route does after it, once', async () => {
    expect((await call('viewer', 'PUT', '/accounting/settings', { companyId: ids.companyA, journalsOn: true })).statusCode).toBe(403)
    // This app has no office sign-in (test sessions only): the fresh code cannot be asked (503); locks/hard.pg.vitest.test.ts
    // switches the journals through the route with a real step-up.
    expect((await call('finance', 'PUT', '/accounting/settings', { companyId: ids.companyA, journalsOn: true })).statusCode).toBe(503)
    const caller = callerFor(database, completeContext(SESSIONS.finance!, newId()))
    const on = await saveJournalsSettings(caller, { companyId: ids.companyA, journalsOn: true, reason: 'The accountant confirmed the made-up chart for the test.' }, idem())
    expect(on).toMatchObject({ companyId: ids.companyA, settingsId: ids.companyA, version: 1, journalsOn: true, from: 'COMPANY' })
    await expect(saveJournalsSettings(caller, { companyId: ids.companyA, journalsOn: true, version: 1 }, idem())).rejects.toThrow(/Nothing changes/)
    expect(await events('accounting_settings.changed')).toEqual([{ settingsId: ids.companyA, companyId: ids.companyA, journalsOn: true }])
    expect((await ok(call('viewer', 'GET', `/accounting/settings?companyId=${ids.companyA}`))).settings).toMatchObject({ journalsOn: true, can: { switch: false } })
  })
})

describe("November's export with the cost of goods sold and variances and the VAT registers (FIN-151, FIN-106, FIN-154)", () => {
  let batch: Json

  it('checks the month: work orders closed, every account mapped, entries balance; counts each package', async () => {
    const month = await ok(call('finance', 'GET', `/accounting/periods/2026-11?companyId=${ids.companyA}&packages=${NOVEMBER.join(',')}`))
    expect(month.journals).toMatchObject({ on: true })
    const checks = Object.fromEntries(month.checks.map((check: Json) => [check.code, check]))
    const open = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkOrder" WHERE "companyId" = $1 AND status = 'COMPLETED' AND "completedAt" <= '2026-11-30T23:00:00Z'`, [ids.companyA])
    expect(checks.WORK_ORDERS_CLOSED).toMatchObject({ passed: open[0]!.n === 0, count: open[0]!.n })
    expect(checks.MAPPING_COMPLETE).toMatchObject({ passed: false, fixes: expect.arrayContaining([{ recordType: 'AccountMapping', recordId: 'COST_CATEGORY/VARIANCE_MATERIAL_USAGE', number: 'VARIANCE_MATERIAL_USAGE', field: 'COST_CATEGORY' }]) })
    expect(checks.ENTRIES_BALANCE).toBeDefined()
    const cost = month.contents.find((entry: Json) => entry.package === 'COST_OF_SALES')
    // The live close's two variances (the undone close's is not the month's), the purchase price variance, four cost of goods sold.
    expect(cost).toMatchObject({ available: true, scope: 'DOCUMENTS', documents: { documents: 7, new: 7 } })
    expect(cost.costTotals).toEqual([
      { key: 'COST_OF_SALES', currency: 'EUR', amount: 14_800 + 14_500 - 14_500 + 14_650 },
      { key: 'VARIANCE', currency: 'EUR', amount: 550 },
      { key: 'PPV', currency: 'EUR', amount: 1_050 },
    ])
    const vat = month.contents.find((entry: Json) => entry.package === 'VAT_REGISTERS')
    expect(vat).toMatchObject({ available: true, scope: 'WHOLE', grain: 'price' })
    expect(vat.costTotals.map((total: Json) => total.key)).toEqual(['PURCHASES_VAT'])
  })

  it('makes the batch: registers and entries with the mapped accounts, the three VAT files; each document handed over once', async () => {
    const month = await ok(call('finance', 'GET', `/accounting/periods/2026-11?companyId=${ids.companyA}&packages=${NOVEMBER.join(',')}`))
    const explanations = month.checks.filter((check: Json) => !check.passed).map((check: Json) => ({ code: check.code, explanation: `Known at the close: ${check.code}.` }))
    batch = (await ok(call('finance', 'POST', '/accounting/exports', { companyId: ids.companyA, month: '2026-11', packages: NOVEMBER, explanations, language: 'en' }), 201)).export
    expect(batch).toMatchObject({ status: 'EXPORTED', packages: NOVEMBER })
    const names = batch.files.map((file: Json) => file.file.name.replace(/^[^_]+_2026-11_/, ''))
    expect(names).toEqual([
      'sales-journal.csv',
      'sales-journal_entries.csv',
      'purchases-journal.csv',
      'purchases-journal_entries.csv',
      'payments.csv',
      'payments_entries.csv',
      'cost-of-sales.csv',
      'cost-of-sales_entries.csv',
      'vat-registers_sales.csv',
      'vat-registers_purchases.csv',
      'vat-registers_totals.csv',
    ])
    const register = (await fileText(batch, 'cost-of-sales.csv')).split('\r\n')
    expect(register[1]).toBe('Kind,Date,Reference,Work order,Party code,Party,Item,Category,Quantity,Material,Labour,Subcontract,Overhead,Amount,Reverses,Change')
    const variances = register.filter((line) => line.startsWith('VARIANCE,')).map((line) => [line.split(',')[7], line.split(',')[13]])
    expect(variances.sort()).toEqual([
      ['LABOUR_EFFICIENCY', '1.50'],
      ['MATERIAL_USAGE', '4.00'],
    ])
    expect(register.filter((line) => line.startsWith('PPV,'))[0]).toContain(',10.50,')
    expect(register.filter((line) => line.startsWith('COST_OF_SALES,'))).toHaveLength(4)
    const entries = (await fileText(batch, 'cost-of-sales_entries.csv')).split('\r\n')
    expect(entries[1]).toBe('Date,Document,Number,Party code,Party,Line,Account,Mapped as,Key,Debit,Credit,Change')
    expect(entries.some((line) => line.includes(',6801,COST_CATEGORY,COST_OF_SALES,148.00,,NEW'))).toBe(true)
    expect(entries.some((line) => line.includes(',,COST_CATEGORY,VARIANCE_MATERIAL_USAGE,4.00,,NEW'))).toBe(true)
    const purchases = (await fileText(batch, 'purchases-journal_entries.csv')).split('\r\n')
    expect(purchases.some((line) => line.includes(',2201,PARTY_GROUP,SUPPLIERS_IT,'))).toBe(true)
    expect(purchases.some((line) => line.includes(',1601,TAX_CODE,VAT_INPUT,'))).toBe(true)
    const totals = (await fileText(batch, 'vat-registers_totals.csv')).split('\r\n')
    expect(totals[1]).toBe('Register,VAT %,VAT nature,Currency,Taxable,VAT')
    expect(totals.some((line) => line.startsWith('DUE,,,EUR,,'))).toBe(true)

    // Each document once (the supplier invoice is in the purchases journal and the VAT registers: one row).
    const handed = await admin<{ recordType: string; change: string; number: string | null }>(`SELECT "recordType", change, number FROM "ExportedDocument" WHERE "exportId" = $1 ORDER BY "recordType", number`, [batch.id])
    expect(handed.every((row) => row.change === 'NEW')).toBe(true)
    expect(handed.filter((row) => row.recordType === 'SupplierInvoice').map((row) => row.number)).toContainEqual(expect.stringContaining('2026/0412'))
    expect(handed.filter((row) => row.recordType === 'CostOfSalesEntry')).toHaveLength(4)
    expect(handed.length).toBe(new Set(batch.manifest.map((entry: Json) => `${entry.recordType}|${entry.recordId}`)).size)
    const record = (await ok(call('finance', 'GET', `/accounting/exports/${batch.id}`))).export
    expect(record.handedOver).toEqual({ documents: handed.length, flagged: 0 })
  })

  it('a later change is flagged once by the checks run now; the re-export hands it over as CHANGED and the check passes again', async () => {
    await admin(`UPDATE "Party" SET "legalName" = 'Conceria Esempio Due Srl (renamed)', version = version + 1 WHERE id = $1`, [ids.P2])
    const run = await ok(call('finance', 'POST', '/accounting/integrity/run', { companyId: ids.companyA }), 201)
    const exported = run.checks.find((check: Json) => check.code === 'EXPORTED_DOCUMENTS_UNCHANGED')
    expect(exported).toMatchObject({ result: 'FAILED', ranBy: { name: 'Fiona Neri' }, failures: expect.arrayContaining([{ recordType: 'SupplierInvoice', recordId: seeded.accounting.supplierInvoiceId, code: 'CHANGED_AFTER_EXPORT', number: '2026/0412' }]) })
    const flags = async () => admin<{ changedAt: Date | null }>(`SELECT "changedAt" FROM "ExportedDocument" WHERE "exportId" = $1 AND "recordId" = $2`, [batch.id, seeded.accounting.supplierInvoiceId])
    const first = (await flags())[0]!.changedAt
    expect(first).not.toBeNull()
    // Once: a second run finds it changed again but leaves the flag as it was.
    await ok(call('finance', 'POST', '/accounting/integrity/run', { companyId: ids.companyA }), 201)
    expect((await flags())[0]!.changedAt).toEqual(first)
    const record = (await ok(call('finance', 'GET', `/accounting/exports/${batch.id}`))).export
    expect(record.handedOver.flagged).toBeGreaterThanOrEqual(1)
    expect(record.manifest.find((entry: Json) => entry.recordId === seeded.accounting.supplierInvoiceId && entry.package === 'PURCHASES_JOURNAL').changedAt).toEqual(expect.any(String))
    expect((await events('integrity_checks.ran')).at(-1)).toMatchObject({ companyId: ids.companyA, checks: 6, failed: expect.arrayContaining(['EXPORTED_DOCUMENTS_UNCHANGED']) })
    expect((await call('viewer', 'POST', '/accounting/integrity/run', { companyId: ids.companyA })).statusCode).toBe(403)

    // The supplier's name is on its invoice's rows and on its purchase price variance's: both changed. An hour later:
    clock.at = new Date('2026-12-02T10:00:00.000Z')
    const month = await ok(call('finance', 'GET', `/accounting/periods/2026-11?companyId=${ids.companyA}&packages=${NOVEMBER.join(',')}`))
    const explanations = month.checks.filter((check: Json) => !check.passed).map((check: Json) => ({ code: check.code, explanation: `Known: ${check.code}.` }))
    const again = (await ok(call('finance', 'POST', '/accounting/exports', { companyId: ids.companyA, month: '2026-11', packages: NOVEMBER, supersedesId: batch.id, explanations, language: 'en' }), 201)).export
    expect(again.packages).toEqual(['PURCHASES_JOURNAL', 'COST_OF_SALES', 'VAT_REGISTERS'])
    expect(await admin(`SELECT "recordType", change FROM "ExportedDocument" WHERE "exportId" = $1 ORDER BY "recordType"`, [again.id])).toEqual([
      { recordType: 'PurchasePriceVariance', change: 'CHANGED' },
      { recordType: 'SupplierInvoice', change: 'CHANGED' },
    ])
    const passed = await ok(call('finance', 'POST', '/accounting/integrity/run', { companyId: ids.companyA }), 201)
    expect(passed.checks.find((check: Json) => check.code === 'EXPORTED_DOCUMENTS_UNCHANGED')).toMatchObject({ result: 'PASSED', failures: [], history: [expect.objectContaining({ result: 'FAILED' }), expect.objectContaining({ result: 'FAILED' })] })
  })

  it('runs nightly for every active company (no person), and the month reads the last run', async () => {
    const before = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrityCheckRun"`))[0]!.n
    const night = await runNightlyIntegrity({ database, log: { info() {}, warn() {}, error() {} } as never }, new Date('2026-12-03T03:10:00.000Z'))
    expect(night).toMatchObject({ failed: 0 })
    const companies = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Company" WHERE status = 'ACTIVE'`))[0]!.n
    expect(night.companies).toBe(companies)
    const nightly = await admin<{ checkCode: string; createdById: string | null }>(`SELECT "checkCode", "createdById" FROM "IntegrityCheckRun" ORDER BY "createdAt" DESC, id LIMIT $1`, [6 * companies])
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrityCheckRun"`))[0]!.n).toBe(before + 6 * companies)
    expect(nightly.every((row) => row.createdById === null)).toBe(true)
    // The same tick again keeps one run (its key).
    await runNightlyIntegrity({ database, log: { info() {}, warn() {}, error() {} } as never }, new Date('2026-12-03T03:10:00.000Z'))
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrityCheckRun"`))[0]!.n).toBe(before + 6 * companies)
    const month = await ok(call('viewer', 'GET', `/accounting/periods/2026-11?companyId=${ids.companyA}`))
    expect(month.integrity).toMatchObject({ lastRunAt: expect.any(String), checks: expect.arrayContaining([expect.objectContaining({ code: 'LEDGER_BALANCES' })]) })
    const view = await ok(call('viewer', 'GET', `/accounting/integrity?companyId=${ids.companyA}`))
    expect(view).toMatchObject({ can: { run: false }, window: { from: expect.stringMatching(/^\d{4}-\d{2}-01$/) } })
    expect(view.checks.map((check: Json) => check.code)).toEqual(['INVOICE_TOTALS_EQUAL_LINES', 'SUPPLIER_INVOICE_TOTALS_EQUAL_LINES', 'ALLOCATIONS_WITHIN_PAYMENTS', 'PAYMENTS_PLACED', 'LEDGER_BALANCES', 'EXPORTED_DOCUMENTS_UNCHANGED'])
    expect(view.checks.every((check: Json) => check.ranBy === null)).toBe(true)
  })
})
