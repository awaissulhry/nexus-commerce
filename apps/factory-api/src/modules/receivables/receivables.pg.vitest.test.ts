import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seed as seedReceivables, type ReceivablesSeed } from '../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../platform/outbox/system'
import { fireDueTimers } from '../../platform/timers/fire'
import { onRecheck, onTimerFired, runLadder } from './ladder'
import { useReceivablesClock } from './store'

/**
 * Receivables on the local stack (B-W2a-55; FIN-109, FIN-110, FIN-111), through the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), the factory-db seeds up to
 * receivables (company A, customer P1: FT-2026-00001 TD01 of 610.00 due 27 Nov with 200.00 paid, the TD02 deposit and its
 * payment, a 400.00 transfer on account, a 100.00 duplicate transfer with 50.00 to refund, the tenant-wide ladder −3 /
 * +7 / +30 switched OFF with the interest rule UNDECIDED, and a level-1 reminder PREPARED by hand), the local file store,
 * FAKE mail. The day is 10 December 2026.
 *
 *   - the ageing and the statement: what P1 owes and how late; the running balance; the PDF; amounts only with the grain
 *   - the ladder ON ITS TIMERS: the daily pass sets the invoice's timers (due now: level 2; next: level 3), the timer
 *     fires, the worker's handler prepares the level-2 e-mail in Italian; nothing is sent by the ladder
 *   - a person approves; sending is refused while reminders are switched off (and the switch while the interest rule is
 *     the accountant's question); a payment makes the approved reminder stale → the ladder cancels it and prepares it
 *     again with the open amount
 *   - the Owner's switch (step-up) once the rule is recorded; the e-mail queued on the reminder's thread; a letter by hand
 *     stored on the reminder; skip; the statement e-mailed with its PDF
 * Run with `node scripts/factory/run-pg-tests.mjs modules/receivables`.
 */

type Json = Record<string, any>
const NS = 'receivables-a'
const key = (name: string) => seedUuid(NS, name)
const ids = { tenant: key('tenant'), companyA: key('company:A'), companyB: key('company:B'), P1: key('party:P1'), finance: newId() }
const TENANT: TestTenant = { id: ids.tenant, slug: NS, companies: [{ id: ids.companyA, code: 'A' }, { id: ids.companyB, code: 'B' }] }

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId, grants })
const fromTemplate = (name: string, actorId = newId()) => {
  const role = templateOf(name)!
  return office(actorId, [grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance', ids.finance),
  /** Reads, no price grain. */
  viewer: office(newId(), [grant(['receivables.view'])]),
  /** Prepares and edits, never approves. */
  clerk: office(newId(), [grant(['receivables.view', 'receivables.reminders.manage', 'money.price'])]),
  companyB: office(newId(), [grant(['receivables.view', 'receivables.reminders.manage', 'receivables.reminders.approve', 'money.price'], [ids.companyB])]),
}

let h: Harness
let app: FastifyInstance
let seeded: ReceivablesSeed
let system: CommandCaller
let owner: { browser: Browser; secret: string }
let serial = 0
const clock = { at: new Date('2026-12-10T09:00:00.000Z') }
const idem = () => `rcv-${randomBytes(4).toString('hex')}-${++serial}`

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const refusal = async (response: Promise<LightMyRequestResponse>, status: number): Promise<string[]> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json().error.issues ?? []).map((issue: Json) => issue.path)
}
const asOwner = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const answer = await owner.browser.send(method as 'POST', url, body, method === 'GET' ? {} : { headers: { 'idempotency-key': idem() } })
  return { status: answer.status, body: answer.body as Json }
}
const outbox = async (type: string, since = new Date(0)) => admin<{ id: string; payload: Json }>(`SELECT id, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND "occurredAt" >= $3 ORDER BY id`, [ids.tenant, type, since])
const reminders = async () => admin<{ id: string; level: number; status: string; amountDue: number; action: string; createdById: string | null }>(`SELECT id, level, status::text AS status, "amountDue", action::text AS action, "createdById" FROM "PaymentReminder" WHERE "tenantId" = $1 ORDER BY "createdAt", id`, [ids.tenant])
const ladderTimers = async (status = 'PENDING') => admin<{ timerKey: string; recordId: string; fireAt: Date; payload: Json }>(`SELECT "timerKey", "recordId", "fireAt", payload FROM "DueTimer" WHERE "tenantId" = $1 AND "timerKey" LIKE 'PAYMENT_REMINDER%' AND status = $2::"DueTimerStatus" ORDER BY "fireAt", id`, [ids.tenant, status])

/** The scheduler's tick of the date timers, then the worker's ladder handler for each timer that fired (once each). */
const handled = new Set<string>()
async function fireAndHandle(): Promise<number> {
  await fireDueTimers({ database: h.database, log: { info() {}, warn() {}, error() {} }, clock: { now: () => clock.at } })
  let prepared = 0
  for (const event of await outbox('timer.fired')) {
    if (handled.has(event.id)) continue
    handled.add(event.id)
    prepared += (await onTimerFired(system, event.payload))?.prepared.length ?? 0
  }
  return prepared
}

beforeAll(async () => {
  h = await startHarness('receivables')
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  seeded = await seedReceivables({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [ids.tenant])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'fiona@example.com', 'Fiona Neri', 'ACTIVE')`, [ids.finance, ids.tenant])
  // The letterhead's c.c. art. 2250 data (made up), as the documents need it.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`, [ids.companyA, JSON.stringify({ line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' })])
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const user = await addUser(h, TENANT, { email: `owner-${randomBytes(3).toString('hex')}@example.test`, role: 'owner' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`owner sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser) }
  useReceivablesClock({ now: () => clock.at })
  system = callerFor(h.database, systemContext(ids.tenant, `receivables-test-${newId()}`))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  useReceivablesClock(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

const SAMPLE = () => seeded.money.sampleInvoiceId

describe('what customers owe and the statement (FIN-109, FIN-110)', () => {
  it("ages P1's open invoice: 410.00 overdue 13 days; amounts only with the price grain; another company sees nothing", async () => {
    const answer = await ok(call('finance', 'GET', '/receivables/ageing'))
    expect(answer.asOf).toBe('2026-12-10')
    const row = answer.customers.find((entry: Json) => entry.customer.id === ids.P1)
    expect(row).toMatchObject({ company: { id: ids.companyA }, currency: 'EUR', open: 41000, overdue: 41000, invoices: 1, oldestDueDate: '2026-11-27', daysLate: 13, remindersSent: 0, remindersWaiting: 1, creditLimitUsed: null })
    expect(row.buckets).toEqual({ NOT_DUE: 0, D1_30: 41000, D31_60: 0, D61_90: 0, OVER_90: 0 })
    expect(row.lastPaymentOn).toBe('2026-11-12')
    expect(answer.tiles.find((tile: Json) => tile.currency === 'EUR')).toMatchObject({ open: 41000, overdue: 41000 })
    // A tile filters the table.
    expect((await ok(call('finance', 'GET', '/receivables/ageing?bucket=D31_60'))).customers).toEqual([])
    const blind = await ok(call('viewer', 'GET', '/receivables/ageing'))
    const blindRow = blind.customers.find((entry: Json) => entry.customer.id === ids.P1)
    expect(blindRow.open).toBeUndefined()
    expect(blindRow.invoices).toBe(1)
    expect((await ok(call('companyB', 'GET', '/receivables/ageing'))).customers).toEqual([])
    // As of 1 December only 4 days late; before the invoice, nothing.
    expect((await ok(call('finance', 'GET', `/receivables/ageing?asOf=2026-12-01&partyId=${ids.P1}`))).customers[0]).toMatchObject({ daysLate: 4 })
    expect((await ok(call('finance', 'GET', `/receivables/ageing?asOf=2026-10-01&partyId=${ids.P1}`))).customers).toEqual([])
  })

  it('the statement: opening + invoices − payments − credits = running balance; the open items; the PDF', async () => {
    const statement = await ok(call('finance', 'GET', `/receivables/customers/${ids.P1}/statement?companyId=${ids.companyA}&from=2026-10-01&to=2026-12-10&language=it`))
    expect(statement).toMatchObject({ currency: 'EUR', from: '2026-10-01', to: '2026-12-10', opening: 0 })
    const balance = statement.lines.reduce((sum: number, line: Json) => sum + line.debit - line.credit, statement.opening)
    expect(statement.closing).toBe(balance)
    expect(statement.lines.at(-1).balance).toBe(statement.closing)
    expect(statement.lines.find((line: Json) => line.reference === 'FT-2026-00001')).toMatchObject({ kind: 'INVOICE', debit: 61000, credit: 0, dueDate: '2026-11-27', label: 'Fattura FT-2026-00001' })
    expect(statement.lines.find((line: Json) => line.reference === 'SEED-CRO-DUPLICATE-0001')).toMatchObject({ kind: 'PAYMENT', credit: 10000 })
    // The refund is DUE, not paid: no money yet. The 300.00 on account explain the gap to what is open.
    expect(statement.lines.some((line: Json) => line.kind === 'REFUND')).toBe(false)
    expect(statement.openItems).toEqual([expect.objectContaining({ invoiceId: SAMPLE(), open: 41000, bucket: 'D1_30', daysLate: 13 })])
    expect(statement.ageing.open - statement.closing).toBe(30000)
    expect(statement.recipients).toEqual([{ name: 'Seed Accounts One', email: 'accounts.p1@example.com' }])
    const blind = await ok(call('viewer', 'GET', `/receivables/customers/${ids.P1}/statement?companyId=${ids.companyA}`))
    expect(blind.closing).toBeUndefined()
    expect(blind.lines[0].debit).toBeUndefined()
    const pdf = await call('finance', 'GET', `/receivables/customers/${ids.P1}/statement/pdf?companyId=${ids.companyA}&from=2026-10-01&to=2026-12-10`)
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await call('viewer', 'GET', `/receivables/customers/${ids.P1}/statement/pdf?companyId=${ids.companyA}`)).statusCode).toBe(403)
    expect((await call('companyB', 'GET', `/receivables/customers/${ids.P1}/statement?companyId=${ids.companyA}`)).statusCode).toBe(404)
  })

  it('the settings: the tenant ladder holds, reminders off, the interest rule the accountant\'s, the wording to confirm', async () => {
    const settings = await ok(call('finance', 'GET', `/receivables/settings?companyId=${ids.companyA}`))
    expect(settings).toMatchObject({ source: 'TENANT', company: null, mayManage: true, interest: { mode: 'UNDECIDED' }, wording: { toConfirm: true } })
    expect(settings.effective.ladder.map((step: Json) => [step.level, step.offsetDays, step.action, step.template])).toEqual([
      [1, -3, 'EMAIL', 'BEFORE_DUE'],
      [2, 7, 'EMAIL', 'LATE_7'],
      [3, 30, 'LETTER', 'LATE_30'],
    ])
    expect(settings.switch).toMatchObject({ on: false, mayChange: false, blockers: [{ code: 'INTEREST_UNDECIDED' }] })
    expect(settings.switch.words).toContain('accountant')
  })
})

let level2: Json

describe('the ladder on its timers; a person approves (FIN-111)', () => {
  it('the daily pass sets the timers (level 2 due now, level 3 on 27 Dec); the timer fires; the level-2 e-mail is prepared, nothing sent', async () => {
    const run = await runLadder({ database: h.database, log: { info() {}, warn() {}, error() {} } })
    expect(run).toMatchObject({ tenants: expect.any(Number), failed: 0 })
    const pending = await ladderTimers()
    expect(pending.map((timer) => [timer.timerKey, timer.recordId, timer.fireAt.toISOString()])).toEqual([
      ['PAYMENT_REMINDER:+7d', SAMPLE(), '2026-12-09T23:00:00.000Z'],
      ['PAYMENT_REMINDER:+30d', SAMPLE(), '2026-12-26T23:00:00.000Z'],
    ])
    expect(pending[0]!.payload).toEqual({ level: 2, offsetDays: 7 })
    // A second pass has nothing to do: no command, no audit row.
    const audits = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action LIKE 'receivables.%'`, [ids.tenant]))[0]!.n
    await runLadder({ database: h.database, log: { info() {}, warn() {}, error() {} } })
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action LIKE 'receivables.%'`, [ids.tenant]))[0]!.n).toBe(audits)

    expect(await fireAndHandle()).toBe(1)
    const rows = await reminders()
    expect(rows.map((row) => [row.level, row.status, row.amountDue, row.action, row.createdById])).toEqual([
      [1, 'PREPARED', 41000, 'EMAIL', expect.any(String)],
      [2, 'PREPARED', 41000, 'EMAIL', null],
    ])
    // A repeated firing prepares nothing twice.
    expect(await fireAndHandle()).toBe(0)
    expect(await reminders()).toHaveLength(2)
    expect(await admin(`SELECT id FROM "EmailOutbound" WHERE "recordType" = 'PaymentReminder'`)).toEqual([])
    const listed = await ok(call('finance', 'GET', '/receivables/reminders'))
    expect(listed.counts).toEqual({ toApprove: 2, waiting: 0, sent30Days: 0 })
    level2 = listed.reminders.find((entry: Json) => entry.level === 2)
    expect(level2).toMatchObject({ customer: { id: ids.P1 }, action: 'EMAIL', status: 'PREPARED', byHand: false, step: { offsetDays: 7, words: { en: '7 days late' } }, amountDue: 41000, language: 'it', invoices: [{ id: SAMPLE(), number: 'FT-2026-00001', openNow: 41000 }] })
    expect(level2.text.subject).toBe('Sollecito di pagamento: fattura FT-2026-00001 scaduta il 27/11/2026')
    expect(level2.text.body).toContain('Totale: € 410,00')
    expect(level2.held.map((held: Json) => held.code)).toEqual(['UNPLACED_PAYMENT', 'SWITCHED_OFF'])
    expect(level2.actions).toEqual({ edit: true, approve: true, send: false, skip: true, cancel: true })
    // Without the grain: no amount and no text (it names amounts).
    const blind = (await ok(call('viewer', 'GET', `/receivables/reminders/${level2.id}`))).reminder
    expect(blind.amountDue).toBeUndefined()
    expect(blind.text).toBeUndefined()
    expect((await ok(call('finance', 'GET', '/receivables/reminders/counts'))).toApprove).toBe(2)
    expect((await outbox('payment_reminder.prepared')).map((event) => event.payload)).toEqual([expect.objectContaining({ reminderId: level2.id, level: 2, byHand: false })])
  })

  it('edits the text; approving and sending at once is refused while reminders are off; approving alone waits', async () => {
    const edited = (await ok(call('clerk', 'PATCH', `/receivables/reminders/${level2.id}`, { version: level2.version, body: `${level2.text.body}\n\nRif. ordine SEED-SO-0001.` }))).reminder
    expect(edited.text.body).toContain('Rif. ordine')
    expect(await refusal(call('clerk', 'PATCH', `/receivables/reminders/${level2.id}`, { version: level2.version, subject: 'x' }), 409)).toEqual(['body/version'])
    expect((await call('clerk', 'POST', `/receivables/reminders/${level2.id}/approve`, { version: edited.version })).statusCode).toBe(403)
    expect(await refusal(call('finance', 'POST', `/receivables/reminders/${level2.id}/approve`, { version: edited.version, send: true }), 409)).toEqual(['reminder/SWITCHED_OFF'])
    const approved = (await ok(call('finance', 'POST', `/receivables/reminders/${level2.id}/approve`, { version: edited.version }))).reminder
    expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: { id: ids.finance, name: 'Fiona Neri' }, actions: { send: false, cancel: true } })
    expect(await refusal(call('finance', 'POST', `/receivables/reminders/${level2.id}/send`, { version: approved.version }), 409)).toEqual(['reminder/SWITCHED_OFF'])
    expect((await reminders()).find((row) => row.id === level2.id)!.status).toBe('APPROVED')
    level2 = approved
  })

  it('a payment of 50.00 makes both waiting reminders stale: the ladder cancels them and prepares level 2 again with 360.00', async () => {
    const paymentId = newId()
    await admin(`INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, currency, "receivedOn", "externalRef") VALUES ($1, $2, $3, $4, 5000, 'EUR', '2026-12-09', 'TEST-CRO-50')`, [paymentId, ids.tenant, ids.companyA, ids.P1])
    await admin(`INSERT INTO "PaymentAllocation" (id, "tenantId", "companyId", "partyId", "paymentId", "invoiceId", amount, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, 5000, $7)`, [newId(), ids.tenant, ids.companyA, ids.P1, paymentId, SAMPLE(), new Date('2026-12-10T08:00:00.000Z')])
    await onRecheck(system, 'payment.allocated', { paymentId })
    const rows = await reminders()
    expect(rows.map((row) => [row.level, row.status, row.amountDue])).toEqual([
      [1, 'CANCELLED', 41000],
      [2, 'CANCELLED', 41000],
      [2, 'PREPARED', 36000],
    ])
    const cancelled = await admin<{ cancelReason: string }>(`SELECT "cancelReason" FROM "PaymentReminder" WHERE id = $1`, [level2.id])
    expect(cancelled[0]!.cancelReason).toContain('Paid or credited since it was prepared')
    expect((await outbox('payment_reminder.cancelled')).map((event) => event.payload.bySystem)).toEqual([true, true])
    level2 = (await ok(call('finance', 'GET', '/receivables/reminders'))).reminders.find((entry: Json) => entry.level === 2)
    expect(level2.text.body).toContain('€ 360,00')
  })
})

describe("the Owner's switch, sending, a letter by hand, skip, the statement e-mailed", () => {
  it('the switch: only the owner, with a fresh step-up, and only once the late-payment rule is recorded', async () => {
    expect((await call('finance', 'PUT', '/receivables/settings/switch', { companyId: null, on: true, version: 1 })).statusCode).toBe(403)
    const noStepUp = await asOwner('PUT', '/receivables/settings/switch', { companyId: null, on: true, version: 1 })
    expect([noStepUp.status, noStepUp.body.error.issues]).toEqual([403, [{ path: 'stepUp', message: 'Required.' }]])
    await stepUp(h, owner.browser, owner.secret)
    const undecided = await asOwner('PUT', '/receivables/settings/switch', { companyId: null, on: true, version: 1 })
    expect([undecided.status, undecided.body.error.issues.map((issue: Json) => issue.path)]).toEqual([409, ['switch/INTEREST_UNDECIDED']])
    // The accountant's answer recorded by finance (no interest; 40.00 recovery charge per invoice).
    const ladder = [
      { offsetDays: -3, action: 'EMAIL', template: 'BEFORE_DUE' },
      { offsetDays: 7, action: 'EMAIL', template: 'LATE_7' },
      { offsetDays: 30, action: 'LETTER', template: 'LATE_30' },
    ]
    expect(await refusal(call('finance', 'PUT', '/receivables/settings', { companyId: null, version: 1, ladder: [{ offsetDays: 7, action: 'EMAIL' }, { offsetDays: 7, action: 'CALL' }], lateInterestMode: 'NONE', recoveryChargeAmount: null, minimumAmount: null }), 400)).toEqual(['body/ladder/1/offsetDays'])
    const recorded = await ok(call('finance', 'PUT', '/receivables/settings', { companyId: null, version: 1, ladder, lateInterestMode: 'NONE', recoveryChargeAmount: 4000, minimumAmount: null }))
    expect(recorded).toMatchObject({ interest: { mode: 'NONE' }, switch: { on: false, blockers: [] }, effective: { version: 2, recoveryChargeAmount: 4000 } })
    const on = await asOwner('PUT', '/receivables/settings/switch', { companyId: null, on: true, version: 2 })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body.switch).toMatchObject({ on: true })
    expect((await outbox('receivables_settings.changed')).map((event) => event.payload.switched)).toEqual([false, true])
  })

  it('approves and sends the level-2 e-mail: queued to the invoice contact on the reminder thread (FAKE), SENT', async () => {
    // Switched on, the ladder alone still sends nothing: its pass and its timers only prepare.
    await runLadder({ database: h.database, log: { info() {}, warn() {}, error() {} } })
    await fireAndHandle()
    expect(await admin(`SELECT id FROM "EmailOutbound" WHERE "recordType" = 'PaymentReminder'`)).toEqual([])
    expect((await reminders()).find((row) => row.id === level2.id)!.status).toBe('PREPARED')
    const sent = (await ok(call('finance', 'POST', `/receivables/reminders/${level2.id}/approve`, { version: level2.version, send: true }))).reminder
    expect(sent).toMatchObject({ status: 'SENT', email: { status: 'QUEUED', to: ['accounts.p1@example.com'] }, actions: { send: false, cancel: false } })
    expect(sent.sentAt).toBe('2026-12-10T09:00:00.000Z')
    const [mail] = await admin<{ subject: string; recordId: string; threadId: string }>(`SELECT subject, "recordId", "threadId" FROM "EmailOutbound" WHERE "recordType" = 'PaymentReminder'`)
    expect(mail).toMatchObject({ subject: 'Sollecito di pagamento: fattura FT-2026-00001 scaduta il 27/11/2026', recordId: level2.id })
    expect(await admin(`SELECT id FROM "Thread" WHERE id = $1 AND "recordType" = 'PaymentReminder' AND "partyId" = $2`, [mail!.threadId, ids.P1])).toHaveLength(1)
    expect((await outbox('payment_reminder.sent')).map((event) => event.payload)).toEqual([expect.objectContaining({ reminderId: level2.id, action: 'EMAIL', fileId: null })])
    expect(await refusal(call('finance', 'POST', `/receivables/reminders/${level2.id}/skip`, { version: sent.version, reason: 'x' }), 409)).toEqual(['reminder/FINAL'])
    expect((await ok(call('finance', 'GET', '/receivables/ageing'))).customers.find((entry: Json) => entry.customer.id === ids.P1).remindersSent).toBe(1)
  })

  it('a reminder by hand climbs to level 3 (a letter): approved and sent, its PDF stored on the reminder', async () => {
    expect((await call('viewer', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1 })).statusCode).toBe(403)
    expect((await call('companyB', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1 })).statusCode).toBe(404)
    const prepared = (await ok(call('clerk', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1, invoiceIds: [SAMPLE()] }), 201)).reminder
    expect(prepared).toMatchObject({ level: 3, action: 'LETTER', byHand: true, amountDue: 36000, status: 'PREPARED' })
    expect(prepared.text.subject).toBe('Secondo sollecito: fattura FT-2026-00001 scaduta il 27/11/2026')
    expect(prepared.text.body).toContain('€ 40,00 per fattura')
    expect(await refusal(call('clerk', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1 }), 409)).toEqual(['reminder/OPEN_AT_LEVEL'])
    const preview = await call('finance', 'GET', `/receivables/reminders/${prepared.id}/pdf`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    const sent = (await ok(call('finance', 'POST', '/receivables/reminders/approve', { items: [{ id: prepared.id, version: prepared.version }], send: true }))).reminders[0]
    expect(sent).toMatchObject({ status: 'SENT', letterFileId: expect.any(String), email: null })
    const [file] = await admin<{ kind: string; recordType: string; contentType: string }>(`SELECT kind::text AS kind, "recordType", "contentType" FROM "StoredFile" WHERE id = $1`, [sent.letterFileId])
    expect(file).toEqual({ kind: 'DOCUMENT', recordType: 'PaymentReminder', contentType: 'application/pdf' })
  })

  it('all or none in bulk; skip with a reason; the statement e-mailed with its PDF on the customer', async () => {
    const again = (await ok(call('clerk', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1 }), 201)).reminder
    expect(again.level).toBe(3)
    expect(await refusal(call('finance', 'POST', '/receivables/reminders/approve', { items: [{ id: again.id, version: again.version + 5 }], send: false }), 400)).toEqual(['body/items/0/version'])
    expect((await reminders()).find((row) => row.id === again.id)!.status).toBe('PREPARED')
    const skipped = (await ok(call('clerk', 'POST', `/receivables/reminders/${again.id}/skip`, { version: again.version, reason: 'Promessa di pagamento entro il 20/12' }))).reminder
    expect(skipped).toMatchObject({ status: 'SKIPPED', skipReason: 'Promessa di pagamento entro il 20/12' })

    const sent = await ok(call('finance', 'POST', `/receivables/customers/${ids.P1}/statement/send`, { companyId: ids.companyA, from: '2026-10-01', to: '2026-12-10', message: 'Restiamo a disposizione.' }), 201)
    expect(sent).toMatchObject({ to: ['accounts.p1@example.com'], from: '2026-10-01', until: '2026-12-10' })
    const [file] = await admin<{ recordType: string; partyId: string; visibility: string[] }>(`SELECT "recordType", "partyId", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1`, [sent.fileId])
    expect(file).toEqual({ recordType: 'Party', partyId: ids.P1, visibility: ['OFFICE', 'PARTNER'] })
    expect((await outbox('customer_statement.sent')).map((event) => event.payload)).toEqual([expect.objectContaining({ partyId: ids.P1, fileId: sent.fileId, outboundId: sent.emailId })])
    expect((await call('clerk', 'POST', `/receivables/customers/${ids.P1}/statement/send`, { companyId: ids.companyA })).statusCode).toBe(403)
  })
})

describe('statutory interest from the half-year reference rates (B-W2b-21; D.Lgs. 231/2002 art. 5)', () => {
  it('finance records and corrects a half-year rate; the same half-year twice, a wrong day or a role over one company are refused', async () => {
    const empty = await ok(call('finance', 'GET', '/receivables/interest-rates'))
    expect(empty).toMatchObject({ rates: [], today: { halfYearStart: '2026-07-01', ratePct: null }, missing: ['2026-07-01'], mayManage: true })
    expect(empty.today.words).toContain('No reference rate is recorded for the half-year from 1 July 2026')
    expect(await refusal(call('finance', 'POST', '/receivables/interest-rates', { halfYearStart: '2026-03-01', referenceRatePct: '2.15', addedPointsPct: '8', source: 'Test placeholder' }), 400)).toEqual(['body/halfYearStart'])
    expect((await call('clerk', 'POST', '/receivables/interest-rates', { halfYearStart: '2026-07-01', referenceRatePct: '2.15', addedPointsPct: '8', source: 'Test placeholder' })).statusCode).toBe(403)
    expect((await call('companyB', 'GET', '/receivables/interest-rates')).statusCode).toBe(200)
    const recorded = (await ok(call('finance', 'POST', '/receivables/interest-rates', { halfYearStart: '2026-07-01', referenceRatePct: '2.4', addedPointsPct: '8', source: 'Test placeholder, not the published rate' }), 201)).rate
    expect(recorded).toMatchObject({ halfYearStart: '2026-07-01', halfYearEnd: '2026-12-31', referenceRatePct: '2.4', addedPointsPct: '8', statutoryRatePct: '10.4', version: 1, createdBy: { id: ids.finance, name: 'Fiona Neri' } })
    expect(await refusal(call('finance', 'POST', '/receivables/interest-rates', { halfYearStart: '2026-07-01', referenceRatePct: '2.15', addedPointsPct: '8', source: 'Again' }), 409)).toEqual(['body/halfYearStart'])
    expect(await refusal(call('finance', 'PATCH', `/receivables/interest-rates/${recorded.id}`, { version: 7, referenceRatePct: '2.15' }), 409)).toEqual(['body/version'])
    const corrected = (await ok(call('finance', 'PATCH', `/receivables/interest-rates/${recorded.id}`, { version: 1, referenceRatePct: '2.15', note: 'Typed again from the notice' }))).rate
    expect(corrected).toMatchObject({ referenceRatePct: '2.15', statutoryRatePct: '10.15', note: 'Typed again from the notice', version: 2 })
    const listed = await ok(call('viewer', 'GET', '/receivables/interest-rates'))
    expect(listed).toMatchObject({ rates: [{ id: recorded.id, statutoryRatePct: '10.15' }], today: { ratePct: '10.15' }, missing: [], mayManage: false })
    expect((await outbox('interest_rate.recorded')).map((event) => event.payload)).toEqual([{ rateId: recorded.id, halfYearStart: '2026-07-01' }])
    expect((await outbox('interest_rate.changed')).map((event) => event.payload)).toEqual([{ rateId: recorded.id, halfYearStart: '2026-07-01' }])
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'InterestReferenceRate' ORDER BY at, id`, [ids.tenant])
    expect(audit.map((row) => row.action)).toEqual(['receivables.interestRate', 'receivables.interestRateCorrect'])
  })

  it('the STATUTORY rule: the settings say the half-year has its rate; a reminder carries 13 days at 10.15 %; without the rate it says interest is due, without an amount', async () => {
    const ladder = [
      { offsetDays: -3, action: 'EMAIL', template: 'BEFORE_DUE' },
      { offsetDays: 7, action: 'EMAIL', template: 'LATE_7' },
      { offsetDays: 30, action: 'LETTER', template: 'LATE_30' },
    ]
    const settings = await ok(call('finance', 'PUT', '/receivables/settings', { companyId: null, version: 3, ladder, lateInterestMode: 'STATUTORY', recoveryChargeAmount: 4000, minimumAmount: null }))
    expect(settings.interest).toMatchObject({ mode: 'STATUTORY', statutory: { halfYearStart: '2026-07-01', ratePct: '10.15', missing: [] } })
    // 360.00 open since 27 Nov: 13 days at 10.15 % = 1.30.
    const prepared = (await ok(call('clerk', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1, invoiceIds: [SAMPLE()] }), 201)).reminder
    expect(prepared).toMatchObject({ level: 3, amountDue: 36000, interestAmount: 130 })
    expect(prepared.text.body).toContain('Interessi di mora (D.Lgs. 231/2002) maturati a oggi: € 1,30')
    await ok(call('clerk', 'POST', `/receivables/reminders/${prepared.id}/cancel`, { version: prepared.version, reason: 'Test: the next half-year has no rate' }))
    // In January 2027 the half-year from 1 January has no rate: no amount, the D.Lgs. 231/2002 mention only.
    clock.at = new Date('2027-01-05T09:00:00.000Z')
    try {
      expect((await ok(call('finance', 'GET', `/receivables/settings?companyId=${ids.companyA}`))).interest.statutory).toMatchObject({ halfYearStart: '2027-01-01', ratePct: null, missing: ['2027-01-01'] })
      const without = (await ok(call('clerk', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P1, invoiceIds: [SAMPLE()] }), 201)).reminder
      expect(without).toMatchObject({ level: 3, amountDue: 36000, interestAmount: null })
      expect(without.text.body).toContain('Sulle somme scadute sono dovuti gli interessi di mora ai sensi del D.Lgs. 231/2002.')
      const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'PaymentReminder' AND "recordId" = $2 AND action = 'receivables.prepare'`, [ids.tenant, without.id])
      expect(audit!.after.interestMissing).toEqual(['2027-01-01'])
    } finally {
      clock.at = new Date('2026-12-10T09:00:00.000Z')
    }
  })
})
