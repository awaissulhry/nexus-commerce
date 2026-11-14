import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { runNightlyIntegrity } from '../integrity/jobs'

/**
 * The accountant's bridge's actions that ask for a fresh code, with real sign-ins (B-W2b-408; FIN-155, FIN-151; lead
 * decision 11-14: the hard lock is a step-up action): the platform's auth harness (a throwaway database from the
 * migrations, a made-up tenant with its system roles from the templates, real sessions, two-factor and step-up).
 *
 *   - closing a month for good: the typed phrase first (no code asked for a request refused anyway), then a fresh code
 *     (403 stepUp, nothing written), then the HARD lock with its event and audit row;
 *   - the journals switch (GATE-ACCOUNTANT): a fresh code, then on;
 *   - the nightly integrity checks over the tenant: a run per check of its company, every check passed (nothing to fail).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/accounting`.
 */

type Json = Record<string, any>

let h: Harness
let tenant: TestTenant
let finance: Browser
let secret: string
let companyId: string

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

beforeAll(async () => {
  h = await startHarness('accounting_hard')
  tenant = await addTenant(h, 'close-a')
  companyId = tenant.companies[0]!.id
  const user = await addUser(h, tenant, { email: 'finance@close-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const answer = await finance.signIn(tenant.slug, user.email, user.password)
  if (answer.status !== 200) throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  secret = await enrolTotp(h, finance)
}, 180_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('closing a month for good asks a fresh code (FIN-155)', () => {
  it('the phrase first, then a fresh code; then the HARD lock, its event and audit row', async () => {
    h.clock.advance(6 * 60_000)
    const body = { companyId, month: '2026-09', level: 'HARD', phrase: 'close September 2026' }
    const noPhrase = await finance.post('/accounting/locks', { ...body, phrase: 'close it' })
    expect(noPhrase.status).toBe(400)
    expect(noPhrase.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/phrase'])
    const noCode = await finance.post('/accounting/locks', body)
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues.map((issue: Json) => issue.path)).toEqual(['stepUp'])
    expect(await admin('SELECT id FROM "PeriodLock" WHERE "tenantId" = $1', [tenant.id])).toEqual([])

    await stepUp(h, finance, secret)
    const closed = await finance.post('/accounting/locks', body)
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    expect(closed.body).toMatchObject({ lock: { level: 'HARD', status: 'LOCKED', period: { month: '2026-09' }, words: expect.stringMatching(/^Closed for good/) }, warnings: [] })
    expect(await admin(`SELECT payload->>'level' AS level FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'period_lock.locked'`, [tenant.id])).toEqual([{ level: 'HARD' }])
    expect(await admin(`SELECT action, after->>'level' AS level FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'PeriodLock'`, [tenant.id])).toEqual([{ action: 'accounting.lock', level: 'HARD' }])
  })
})

describe('the journals switch asks a fresh code (FIN-151; GATE-ACCOUNTANT)', () => {
  it('refused without one, switched on with one', async () => {
    h.clock.advance(6 * 60_000)
    const before = await finance.get(`/accounting/settings?companyId=${companyId}`)
    expect(before.body.settings).toMatchObject({ journalsOn: false, from: 'DEFAULT', can: { switch: true } })
    const noCode = await finance.put('/accounting/settings', { companyId, journalsOn: true })
    expect(noCode.status).toBe(403)
    await stepUp(h, finance, secret)
    const on = await finance.put('/accounting/settings', { companyId, journalsOn: true, reason: 'The accountant confirmed the mapping.' })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body.settings).toMatchObject({ journalsOn: true, from: 'COMPANY', settingsId: companyId, version: 1 })
  })
})

describe('the nightly integrity checks (FIN-157)', () => {
  it("keep a run per check of the tenant's company, by no person; nothing to fail passes", async () => {
    const night = await runNightlyIntegrity({ database: h.database, log: { info() {}, warn() {}, error() {} } as never }, new Date('2026-10-29T03:10:00.000Z'))
    expect(night).toMatchObject({ failed: 0 })
    const runs = await admin<{ checkCode: string; result: string; createdById: string | null }>(`SELECT "checkCode", result, "createdById" FROM "IntegrityCheckRun" WHERE "companyId" = $1 ORDER BY "checkCode"`, [companyId])
    expect(runs).toEqual(
      ['ALLOCATIONS_WITHIN_PAYMENTS', 'EXPORTED_DOCUMENTS_UNCHANGED', 'INVOICE_TOTALS_EQUAL_LINES', 'LEDGER_BALANCES', 'PAYMENTS_PLACED', 'SUPPLIER_INVOICE_TOTALS_EQUAL_LINES'].map((checkCode) => ({ checkCode, result: 'PASSED', createdById: null })),
    )
    const view = await finance.get(`/accounting/integrity?companyId=${companyId}`)
    expect(view.status).toBe(200)
    expect(view.body).toMatchObject({ failing: 0, lastRunAt: expect.any(String), can: { run: true } })
  })
})
