import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RetentionAction, RetentionSweepMode, RetentionSweepStatus } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { RETENTION_ACTIONS, SWEEP_MODES, SWEEP_STATUSES, UNVERIFIED_WORDS, WAITING_WORDS } from '@nexus/factory-domain/privacy/retention/retention'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { addRole, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'
import { runRetentionSweeps } from './sweep'

/**
 * Retention rules and the nightly sweep (B-W2b-405; PLT-204; GATE-PRIVACY; GDPR art. 5(1)(e)) on the local stack: a throwaway
 * PostgreSQL 17 from the migrations (the …_privacy_integration_w2b_guards triggers are real: an APPLY sweep of a rule nobody
 * switched on is refused, a job run is deleted no sooner than 7 days after it finished), one tenant, a real administrator with
 * two-factor (switching a rule on and shortening a period ask a fresh code). Made-up job runs. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/privacy/retention`.
 */

let h: Harness
const NS = 'retention-405-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const companyB = seedUuid(NS, 'company:B')
const DAY = 86_400_000

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const quiet = { info() {}, warn() {}, error() {} }

let desk: { browser: Browser; secret: string }
let keys = 0
const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => desk.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': `w2b405r-${++keys}-${newId()}` } })
async function ok(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await send(method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** A finished run of the outbox lag job `daysAgo` days ago (made up). */
async function jobRun(daysAgo: number): Promise<string> {
  const id = newId()
  const at = new Date(Date.now() - daysAgo * DAY)
  await admin(
    `INSERT INTO "CronRun" (id, "tenantId", "jobKey", trigger, key, "scheduledAt", "startedAt", "finishedAt", status, "ranOn") VALUES ($1, $2, 'outbox.lag', 'SCHEDULE', $3, $4, $4, $5, 'SUCCEEDED', 'test-replica')`,
    [id, T, `outbox.lag@${Math.floor(at.getTime() / 1000)}`, at, new Date(at.getTime() + 1000)],
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('retention_405')
  await seedCore({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
  const user = await addUser(h, tenant, { email: 'retention.desk.405@example.com' })
  await addRole(h, tenant, user.id, 'admin')
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  desk = { browser, secret: await enrolTotp(h, browser) }
}, 300_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...RETENTION_ACTIONS].sort()).toEqual(Object.values(RetentionAction).sort())
    expect([...SWEEP_MODES].sort()).toEqual(Object.values(RetentionSweepMode).sort())
    expect([...SWEEP_STATUSES].sort()).toEqual(Object.values(RetentionSweepStatus).sort())
  })
})

describe('a retention rule reports until a person switches it on (GATE-PRIVACY), then the sweep applies it', () => {
  let rule: Json
  let old: string[]
  let recent: string

  it('is made with a made-up period, reporting only; record types the sweep does not know and the ledgers are refused', async () => {
    rule = (await ok('POST', '/privacy/retention/rules', { companyId: null, recordType: 'CronRun', keepMonths: 3, thenAction: 'DELETE', legalReason: 'Job runs: 3 months (made up, GATE-PRIVACY).' }, 201)).rule
    expect(rule).toMatchObject({ key: 'retention:CronRun:all', company: null, active: true, applyOn: false, unverified: true, unverifiedWords: UNVERIFIED_WORDS, period: '3 months', known: true, lastSweep: null })
    expect(rule.actions.applyOn.allowed).toBe(true)
    expect((await send('POST', '/privacy/retention/rules', { companyId: null, recordType: 'CronRun', keepMonths: 6, thenAction: 'DELETE', legalReason: 'Again.' })).status).toBe(409)
    const ledger = await send('POST', '/privacy/retention/rules', { companyId: null, recordType: 'AuditLog', keepMonths: 24, thenAction: 'DELETE', legalReason: 'Two years.' })
    expect(ledger.status).toBe(400)
    expect(ledger.body.error.message).toBe(WAITING_WORDS)
    expect((await send('POST', '/privacy/retention/rules', { companyId: companyA, recordType: 'CronRun', keepMonths: 3, thenAction: 'DELETE', legalReason: 'Per company.' })).status).toBe(400)
    expect((await send('POST', '/privacy/retention/rules', { companyId: null, recordType: 'Invoice', keepMonths: 120, thenAction: 'DELETE', legalReason: 'c.c. art. 2220: 10 years.' })).body.error.issues[0].path).toBe('thenAction')
    // A company's own rule (fiscal records: archived where they are) is listed beside the group's.
    const invoices = (await ok('POST', '/privacy/retention/rules', { companyId: companyA, recordType: 'Invoice', keepMonths: 120, thenAction: 'ARCHIVE', legalReason: 'c.c. art. 2220: 10 years.' }, 201)).rule
    expect(invoices).toMatchObject({ key: `retention:Invoice:${companyA}`, company: { id: companyA }, holdsAll: { code: 'ARCHIVE_STAYS' } })
    const listed = await ok('GET', '/privacy/retention')
    expect(listed.rules.map((entry: Json) => entry.key).sort()).toEqual(['retention:CronRun:all', `retention:Invoice:${companyA}`])
    expect(listed.ledgers.map((entry: Json) => entry.recordType)).toEqual(['AuditLog', 'ReadLog', 'SecurityEvent', 'StepUpAttempt'])
    expect(listed.datedPurges.map((entry: Json) => entry.job)).toContain('sales.measurementPhotos')
    expect(listed.types.map((entry: Json) => entry.recordType)).toEqual(expect.arrayContaining(['CronRun', 'ReportRun', 'IntegrationErrorItem', 'InboundEmail', 'Invoice']))
  })

  it('reports what is due and changes nothing; shortening and switching on ask a fresh code', async () => {
    old = [await jobRun(200), await jobRun(150)]
    recent = await jobRun(10)
    const swept = await ok('POST', `/privacy/retention/rules/${rule.id}/sweep`, undefined, 201)
    expect(swept.sweep).toMatchObject({ mode: 'REPORT', status: 'DONE', due: 2, applied: 0, held: 0 })
    expect((await admin(`SELECT id FROM "CronRun" WHERE "tenantId" = $1`, [T])).length).toBe(3)
    const shorter = await send('PATCH', `/privacy/retention/rules/${rule.id}`, { version: swept.rule.version, keepMonths: 1 })
    expect(shorter.status).toBe(403)
    expect(shorter.body.error.issues[0].path).toBe('stepUp')
    const on = await send('POST', `/privacy/retention/rules/${rule.id}/apply`, { version: swept.rule.version, on: true })
    expect(on.status).toBe(403)
    // A longer period never asks.
    rule = (await ok('PATCH', `/privacy/retention/rules/${rule.id}`, { version: swept.rule.version, keepMonths: 4, legalReason: 'Job runs: 4 months (made up).' })).rule
    expect(rule.keepMonths).toBe(4)
  })

  it('applies once switched on: the old runs deleted, the recent kept, counted; off again, it reports', async () => {
    await stepUp(h, desk.browser, desk.secret)
    rule = (await ok('POST', `/privacy/retention/rules/${rule.id}/apply`, { version: rule.version, on: true })).rule
    expect(rule).toMatchObject({ applyOn: true, applyOnBy: { name: expect.any(String) } })
    const swept = await ok('POST', `/privacy/retention/rules/${rule.id}/sweep`, undefined, 201)
    expect(swept.sweep).toMatchObject({ mode: 'APPLY', status: 'DONE', due: 2, applied: 2, held: 0, requestedBy: { name: expect.any(String) } })
    expect((await admin(`SELECT id FROM "CronRun" WHERE "tenantId" = $1`, [T])).map((row) => row.id)).toEqual([recent])
    for (const id of old) expect((await admin(`SELECT id FROM "CronRun" WHERE id = $1`, [id])).length).toBe(0)
    rule = (await ok('POST', `/privacy/retention/rules/${rule.id}/apply`, { version: swept.rule.version, on: false })).rule
    expect(rule.applyOn).toBe(false)
    // The database itself refuses an APPLY sweep of a rule nobody switched on.
    await expect(admin(`INSERT INTO "RetentionSweep" (id, "tenantId", "ruleId", mode, "keepMonths", "thenAction", "cutoffOn", "startedAt") VALUES ($1, $2, $3, 'APPLY', 4, 'DELETE', (now() - interval '4 months')::date, now())`, [newId(), T, rule.id])).rejects.toThrow()
  })

  it('switched off, it neither reports nor applies; the nightly sweep sweeps every rule that is on', async () => {
    const other = (await ok('POST', '/privacy/retention/rules', { companyId: null, recordType: 'ReportRun', keepMonths: 12, thenAction: 'DELETE', legalReason: 'Report runs: 12 months (made up).' }, 201)).rule
    rule = (await ok('POST', `/privacy/retention/rules/${rule.id}/active`, { version: rule.version, active: false })).rule
    expect(rule).toMatchObject({ active: false, applyOn: false })
    expect((await send('POST', `/privacy/retention/rules/${rule.id}/sweep`)).status).toBe(409)
    const before = (await admin(`SELECT "ruleId", count(*)::int AS n FROM "RetentionSweep" WHERE "tenantId" = $1 GROUP BY 1`, [T])).reduce<Record<string, number>>((all, row) => ({ ...all, [row.ruleId]: row.n }), {})
    const night = await runRetentionSweeps({ database: h.database, log: quiet })
    expect(night.failed).toBe(0)
    const after = (await admin(`SELECT "ruleId", count(*)::int AS n, max(mode::text) AS mode FROM "RetentionSweep" WHERE "tenantId" = $1 GROUP BY 1`, [T])).reduce<Record<string, Json>>((all, row) => ({ ...all, [row.ruleId]: row }), {})
    expect(after[other.id]).toMatchObject({ n: 1, mode: 'REPORT' })
    expect(after[rule.id]!.n).toBe(before[rule.id])
    const sweeps = await ok('GET', `/privacy/retention/rules/${other.id}/sweeps`)
    expect(sweeps.sweeps[0]).toMatchObject({ mode: 'REPORT', status: 'DONE', requestedBy: null })
  })
})
