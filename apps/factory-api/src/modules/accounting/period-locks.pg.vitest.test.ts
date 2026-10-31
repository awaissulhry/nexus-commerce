import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { dayWords, monthLabel, monthOfDay } from '@nexus/factory-domain/accounting/periods'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting } from '../../../../../packages/factory-db/seed/accounting'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { mapError } from '../../core/errors'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import { createGateway } from '../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../platform/outbox/testing'
import { createSecretsService } from '../../platform/secrets/envelope'
import { localKeyProvider } from '../../platform/secrets/local'

/**
 * Month locks honoured by every write path (B-W2a-F8, golden todo X7), through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_money_w2a_guards are
 * real), the factory-db seeds up to accounting (company A; September 2026 exported and HARD-locked). This month is
 * SOFT-locked by finance through POST /accounting/locks; per write-path family:
 *
 *   - HARD (September, or this month made hard at the end): 409 in words before any row, never a 500;
 *   - SOFT without a reason: 409 with `period/SOFT_LOCKED` and the write's path, nothing written;
 *   - SOFT with `periodLockOverride.reason`: done, and ONE audit row `accounting.softLockOverride` on the lock (the reason,
 *     the period, the record written).
 *
 * Families here: payments (record, void), refunds, supplier invoices (register), stock moves (a write-off). The invoice
 * issue (step-up: real sign-in) is in modules/invoicing's PG test. The database's own refusal, reached without a check,
 * is answered 409 by the error mapper (`period/HARD_LOCKED`). Run with `node scripts/factory/run-pg-tests.mjs modules/accounting`.
 */

type Json = Record<string, any>
const NS = 'accounting-locks'
const key = (name: string) => seedUuid(NS, name)
const ids = { tenant: key('tenant'), companyA: key('company:A'), siteA: key('site:A1'), P1: key('party:P1'), finance: newId(), owner: newId(), supplier: newId() }

const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const fromTemplate = (name: string, actorId: string): SessionContext => {
  const role = templateOf(name)!
  return { audience: 'office', tenantId: ids.tenant, actorId, grants: [grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])] }
}
const SESSIONS: Record<string, SessionContext> = { finance: fromTemplate('finance', ids.finance), owner: fromTemplate('owner', ids.owner) }

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
let serial = 0
const idem = () => `locks-${randomBytes(4).toString('hex')}-${++serial}`
const today = businessDate(new Date())
const month = monthOfDay(today)

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = async (session: string, method: 'POST', url: string, payload: unknown): Promise<{ status: number; body: Json }> => {
  const answer: LightMyRequestResponse = await app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': idem() }, payload: payload as object })
  return { status: answer.statusCode, body: answer.json() as Json }
}
const expectStatus = (answer: { status: number; body: Json }, status: number) => expect(answer.status, JSON.stringify(answer.body)).toBe(status)
const overrides = async () => admin<{ recordId: string; reason: string; after: Json; actorId: string }>(`SELECT "recordId", reason, after, "actorId" FROM "AuditLog" WHERE action = 'accounting.softLockOverride' ORDER BY at, id`)

/** A refusal by this month's SOFT lock: 409, `period/SOFT_LOCKED` and the write's path, in words naming the lock and what is not done. */
function softRefused(answer: { status: number; body: Json }, path: string, refused: string) {
  expectStatus(answer, 409)
  expect(answer.body.error.issues.map((issue: Json) => issue.path)).toEqual(['period/SOFT_LOCKED', path])
  expect(answer.body.error.message).toBe(
    `${monthLabel(month)} is soft-locked for ${company} (since ${dayWords(today)}, by Fiona Neri): ${refused} without a reason. ` +
      'Say why it goes into that month (3 to 500 characters, kept in the audit trail) and send it again, or ask finance to lift the soft lock in Finance › Accounting.',
  )
}

/** A refusal by a HARD lock, said by the command (never the database's 500). */
function hardRefused(answer: { status: number; body: Json }, months: string, path: string, refused: string) {
  expectStatus(answer, 409)
  expect(answer.body.error.issues).toEqual([{ path, message: 'Dated inside a month closed for good.' }])
  expect(answer.body.error.message).toMatch(new RegExp(`^${months} is closed for good for ${company} \\(a hard lock since .+\\): `))
  expect(answer.body.error.message).toContain(`: ${refused}. Only someone who may lift a hard lock`)
}

let company: string
let lock: Json
let lining: { itemId: string; lotId: string; locationId: string }
const paid: Record<string, Json> = {}

beforeAll(async () => {
  db = await migratedDatabase('period_locks')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  await seedAccounting({ db: database, namespace: NS })
  for (const [id, name] of [
    [ids.finance, 'Fiona Neri'],
    [ids.owner, 'Olga Riva'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, ids.tenant, `${id.slice(-6)}@example.com`, name])
  }
  // A supplier abroad: its invoices are typed in (an Italian one's come through SDI).
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency) VALUES ($1, $2, NULL, 'DE-LOCKS', 'ORGANISATION', 'Beispiel Versand GmbH', '{SUPPLIER}', 'ACTIVE', 'DE', 'EUR')`, [ids.supplier, ids.tenant])
  company = (await admin<{ legalName: string }>('SELECT "legalName" FROM "Company" WHERE id = $1', [ids.companyA]))[0]!.legalName
  lining = (
    await admin<{ itemId: string; lotId: string; locationId: string }>(
      `SELECT m."itemId", m."lotId", m."toLocationId" AS "locationId" FROM "StockMove" m JOIN "Lot" l ON l.id = m."lotId" WHERE l.code = 'SEED-LOT-LIN-01' AND m."toLocationId" IS NOT NULL ORDER BY m.id LIMIT 1`,
    )
  )[0]!
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-locks-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )

  // Before the lock: two transfers received today (one to refund, one to void).
  for (const name of ['refund', 'void']) {
    const answer = await call('owner', 'POST', '/payments', { companyId: ids.companyA, partyId: ids.P1, amount: 5_000, receivedOn: today, externalRef: `CRO-LOCKS-${name.toUpperCase()}` })
    expectStatus(answer, 201)
    paid[name] = answer.body.payment
  }
  // Finance soft-locks this month, as the screen does.
  const soft = await call('finance', 'POST', '/accounting/locks', { companyId: ids.companyA, month, level: 'SOFT', note: 'Handed to the accountant.' })
  expectStatus(soft, 200)
  lock = soft.body.lock
  expect(lock).toMatchObject({ level: 'SOFT', status: 'LOCKED' })
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('payments (payments.record, payments.void)', () => {
  it('a HARD-locked month refuses the payment in words, with or without a reason: nothing written', async () => {
    const answer = await call('owner', 'POST', '/payments', { companyId: ids.companyA, partyId: ids.P1, amount: 1_000, receivedOn: '2026-09-15', externalRef: 'CRO-LOCKS-HARD', periodLockOverride: { reason: 'The bank statement came late.' } })
    hardRefused(answer, 'September 2026', 'body/receivedOn', 'the payment received on 15 Sep 2026 (bank reference CRO-LOCKS-HARD) is not recorded')
    expect(await admin(`SELECT id FROM "Payment" WHERE "externalRef" = 'CRO-LOCKS-HARD'`)).toEqual([])
  })

  it('a SOFT-locked month refuses it without a reason (period/SOFT_LOCKED), takes it with one and audits the override', async () => {
    const body = { companyId: ids.companyA, partyId: ids.P1, amount: 1_000, receivedOn: today, externalRef: 'CRO-LOCKS-SOFT' }
    softRefused(await call('owner', 'POST', '/payments', body), 'body/receivedOn', `the payment received on ${dayWords(today)} (bank reference CRO-LOCKS-SOFT) is not recorded`)
    expect(await admin(`SELECT id FROM "Payment" WHERE "externalRef" = 'CRO-LOCKS-SOFT'`)).toEqual([])
    const short = await call('owner', 'POST', '/payments', { ...body, periodLockOverride: { reason: ' a ' } })
    expectStatus(short, 400)
    expect(short.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/periodLockOverride/reason'])
    expect(await overrides()).toEqual([])

    const done = await call('owner', 'POST', '/payments', { ...body, periodLockOverride: { reason: 'The bank statement of the last day came late.' } })
    expectStatus(done, 201)
    expect(done.body.payment).toMatchObject({ status: 'RECEIVED', receivedOn: today, externalRef: 'CRO-LOCKS-SOFT' })
    expect(await overrides()).toEqual([
      {
        recordId: lock.id,
        reason: 'The bank statement of the last day came late.',
        actorId: ids.owner,
        after: { periodStart: lock.period.start, periodEnd: lock.period.end, level: 'SOFT', writes: [{ day: today, path: 'body/receivedOn', record: { type: 'Payment', id: done.body.payment.id } }] },
      },
    ])
  })

  it('voiding a payment received in the SOFT month needs the reason too', async () => {
    const voided = await call('owner', 'POST', `/payments/${paid.void!.id}/void`, { reason: 'Typed twice.' })
    softRefused(voided, 'paymentId', `the payment received on ${dayWords(today)} (bank reference CRO-LOCKS-VOID) is not voided`)
    expect((await admin('SELECT status FROM "Payment" WHERE id = $1', [paid.void!.id]))[0]!.status).toBe('RECEIVED')
    const done = await call('owner', 'POST', `/payments/${paid.void!.id}/void`, { reason: 'Typed twice.', periodLockOverride: { reason: 'Typed twice; the accountant knows.' } })
    expectStatus(done, 200)
    expect(done.body.payment.status).toBe('VOIDED')
    expect((await overrides()).at(-1)).toMatchObject({ recordId: lock.id, reason: 'Typed twice; the accountant knows.', after: { writes: [{ path: 'paymentId', record: { type: 'Payment', id: paid.void!.id } }] } })
  })
})

describe('refunds (payments.refund)', () => {
  it('HARD refused in words; SOFT refused without a reason, recorded PAID with one and audited', async () => {
    const base = { paymentId: paid.refund!.id, amount: 1_000 }
    hardRefused(
      await call('owner', 'POST', '/payments/refunds', { ...base, paid: { paidOn: '2026-09-20', externalRef: 'CRO-LOCKS-REF-HARD' } }),
      'September 2026',
      'body/paid/paidOn',
      'the refund paid on 20 Sep 2026 (bank reference CRO-LOCKS-REF-HARD) is not recorded',
    )
    softRefused(await call('owner', 'POST', '/payments/refunds', { ...base, paid: { paidOn: today, externalRef: 'CRO-LOCKS-REF-SOFT' } }), 'body/paid/paidOn', `the refund paid on ${dayWords(today)} (bank reference CRO-LOCKS-REF-SOFT) is not recorded`)
    expect(await admin('SELECT id FROM "Refund"')).toEqual([])
    const done = await call('owner', 'POST', '/payments/refunds', { ...base, paid: { paidOn: today, externalRef: 'CRO-LOCKS-REF-SOFT' }, periodLockOverride: { reason: 'Paid back the same day, before the close.' } })
    expectStatus(done, 201)
    expect(done.body.refund).toMatchObject({ status: 'PAID', paidOn: today })
    expect((await overrides()).at(-1)).toMatchObject({ recordId: lock.id, reason: 'Paid back the same day, before the close.', after: { writes: [{ day: today, record: { type: 'Refund', id: done.body.refund.id } }] } })
  })
})

describe('supplier invoices (payables.register)', () => {
  const invoice = (number: string, issueDate: string, receivedOn: string) => ({
    companyId: ids.companyA,
    partyId: ids.supplier,
    source: 'MANUAL',
    number,
    issueDate,
    receivedOn,
    lines: [{ description: 'Versand', netAmount: 2_500, vatRatePct: '0', vatNature: 'N2.1' }],
  })

  it('HARD refused in words; SOFT refused without a reason, registered with one and audited', async () => {
    hardRefused(await call('owner', 'POST', '/payables/invoices', invoice('RE-LOCKS-9', '2026-09-08', '2026-09-10')), 'September 2026', 'body/receivedOn', 'supplier invoice RE-LOCKS-9 received on 10 Sep 2026 is not registered')
    softRefused(await call('owner', 'POST', '/payables/invoices', invoice('RE-LOCKS-10', today, today)), 'body/receivedOn', `supplier invoice RE-LOCKS-10 received on ${dayWords(today)} is not registered`)
    expect(await admin(`SELECT id FROM "SupplierInvoice" WHERE number LIKE 'RE-LOCKS-%'`)).toEqual([])
    const done = await call('owner', 'POST', '/payables/invoices', { ...invoice('RE-LOCKS-10', today, today), periodLockOverride: { reason: 'The paper invoice was found in the post today.' } })
    expectStatus(done, 201)
    expect((await overrides()).at(-1)).toMatchObject({ recordId: lock.id, reason: 'The paper invoice was found in the post today.', after: { writes: [{ path: 'body/receivedOn', record: { type: 'SupplierInvoice', id: done.body.invoice.id } }] } })
  })
})

describe('stock moves (a write-off) and the HARD close', () => {
  const writeOff = (extra: Json = {}) => ({ siteId: ids.siteA, reasonCode: 'DAMAGED', note: 'Wet in the store.', lines: [{ itemId: lining.itemId, lotId: lining.lotId, fromLocationId: lining.locationId, quantity: '1' }], ...extra })

  it('SOFT refused without a reason, posted with one (ONE audit row naming the move)', async () => {
    const before = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE reason = 'SCRAP'`))[0]!.n
    softRefused(await call('owner', 'POST', '/inventory/write-offs', writeOff()), 'body/lines/0/occurredAt', `the stock move (scrap) dated ${dayWords(today)} is not posted`)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE reason = 'SCRAP'`))[0]!.n).toBe(before)
    const done = await call('owner', 'POST', '/inventory/write-offs', writeOff({ periodLockOverride: { reason: 'Found wet at the month-end walk.' } }))
    expectStatus(done, 201)
    const [move] = await admin<{ id: string }>(`SELECT id FROM "StockMove" WHERE reason = 'SCRAP' ORDER BY id DESC LIMIT 1`)
    expect((await overrides()).at(-1)).toMatchObject({ recordId: lock.id, reason: 'Found wet at the month-end walk.', after: { writes: [{ path: 'body/lines/0/occurredAt', record: { type: 'StockMove', id: move!.id } }] } })
    expect(await overrides()).toHaveLength(5)
  })

  it('once the month is closed for good, a reason opens nothing; the database’s own refusal is a 409 in words too, not a 500', async () => {
    await admin(`UPDATE "PeriodLock" SET level = 'HARD', version = version + 1 WHERE id = $1`, [lock.id])
    hardRefused(await call('owner', 'POST', '/inventory/write-offs', writeOff({ periodLockOverride: { reason: 'Found wet at the month-end walk.' } })), monthLabel(month), 'body/lines/0/occurredAt', `the stock move (scrap) dated ${dayWords(today)} is not posted`)
    // A write that reaches the database without its command's check (the last line of defence of core/errors.ts).
    const refused = await database
      .withScope({ audience: 'office', tenantId: ids.tenant, actorId: ids.owner }, (client) =>
        client.payment.create({ data: { id: newId(), companyId: ids.companyA, partyId: ids.P1, method: 'BANK_TRANSFER', amount: 100, currency: 'EUR', receivedOn: new Date(`${today}T00:00:00.000Z`), externalRef: 'CRO-LOCKS-RAW', createdAt: new Date(), updatedAt: new Date() }, select: { id: true } }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(mapError(refused)).toEqual({
      status: 409,
      code: 'conflict',
      message: expect.stringMatching(new RegExp(`^${monthLabel(month)} is closed for good \\(a hard lock\\): the payment \\(CRO-LOCKS-RAW\\) dated ${dayWords(today)} is not written\\. Only someone who may lift a hard lock`)),
      issues: [{ path: 'period/HARD_LOCKED', message: 'Dated inside a month closed for good.' }],
      unexpected: false,
    })
    expect(await overrides()).toHaveLength(5)
  })
})
