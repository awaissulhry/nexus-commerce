import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Incentive schemes (B-W2b-38; MES-253, MES-257, MES-258, MES-259; W2b plan §3 GATE-PIECE-PAY) through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and
 * the …_pay_w2b_guards triggers are real), on the seeds up to people (no pay seed: no scheme, no pay period; this file
 * makes its own). Every figure is made up; none is any CCNL's. The law the tests name: c.c. art. 2100 (waiting not the
 * worker's doing is paid), art. 2101 and the CCNL minimum (piece pay never below the guaranteed pay); the pay grain: HR
 * and the worker only. Run with `node scripts/factory/run-pg-tests.mjs modules/people/schemes`.
 */

// Each test walks several real routes: more than vitest's 5 s under a loaded machine.
vi.setConfig({ testTimeout: 60_000 })

let h: Harness
let app: FastifyInstance

const NS = 'w2b38-schemes'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteA2 = newId()
const lineL1 = idOf('site:A1:line:L1')

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants })
const MANAGE: Permission[] = ['people.piecerates.view', 'people.piecerates.manage']
const PAY = 'money.pay' as Permission
const SESSIONS: Record<string, SessionContext> = {
  hr: office([grant([...MANAGE, PAY])]),
  managerNoPay: office([grant(MANAGE)]),
  viewer: office([grant([...(templateOf('production_manager')?.permissions ?? [])])]),
  siteOnly: office([grant([...MANAGE, PAY], [companyA], [siteA1])]),
  companyB: office([grant([...MANAGE, PAY], [companyB])]),
  plain: office([grant(['home.view'])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grant([...MANAGE, PAY])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const outbox = (type: string) => admin('SELECT subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const auditOf = (action: string) => admin('SELECT "recordId", before, after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2 ORDER BY at, id', [T, action])
const schemeRow = async (id: string) => (await admin('SELECT status::text AS status, "validFrom"::text AS "validFrom", "validTo"::text AS "validTo", version FROM "IncentiveScheme" WHERE id = $1', [id]))[0]

const today = businessDate(new Date())
const day = (offset: number) => plusDays(today, offset)
const monthStart = (date: string) => `${date.slice(0, 7)}-01`
const nextMonth = (date: string) => plusDays(monthStart(date), 32).slice(0, 7) + '-01'
const thisMonth = { start: monthStart(today), end: plusDays(nextMonth(today), -1) }
const followingMonth = { start: nextMonth(today), end: plusDays(nextMonth(nextMonth(today)), -1) }
const periodNow = newId()
const periodNext = newId()

const base = { companyId: companyA, name: 'Plant scheme', kind: 'PIECE_RATE', validFrom: today }
let s1 = ''
let s2 = ''
let lineScheme = ''

beforeAll(async () => {
  h = await startHarness('people_schemes')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedPeople({ db: h.database, namespace: NS })
  // A second site of company A (a company's scheme pays at every site of the company), and two pay periods.
  await admin('INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $5, $6)', [siteA2, T, companyA, `A2-${run}`, 'Seed plant A2', 'PLANT'])
  for (const [id, month] of [
    [periodNow, thisMonth],
    [periodNext, followingMonth],
  ] as const) {
    await admin('INSERT INTO "PayPeriod" (id, "tenantId", "companyId", "periodStart", "periodEnd") VALUES ($1, $2, $3, $4::date, $5::date)', [id, T, companyA, month.start, month.end])
  }
  await admin('UPDATE "PayPeriod" SET status = \'PREVIEW\', "previewedAt" = now(), "previewedById" = $2 WHERE id = $1', [periodNow, newId()])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('scheme settings (MES-253): a DRAFT per company or line, changed freely, its rates the pay grain only', () => {
  it('drafts the company\'s scheme with its guaranteed pay undecided: it cannot start yet, and says why', async () => {
    const made = await ok('hr', 'POST', '/people/incentive-schemes', base, 201)
    s1 = made.scheme.id
    expect(made.scheme).toMatchObject({ companyId: companyA, siteId: null, line: null, status: 'DRAFT', state: 'DRAFT', guaranteedBasis: 'UNDECIDED', guaranteedHourlyRate: null, othersFaultPay: 'AVERAGE', waitingPay: 'AVERAGE', payOnlyWhileClockedIn: true, version: 1 })
    expect(made.company).toMatchObject({ id: companyA, code: expect.any(String) })
    expect(made.actions.activate).toEqual({ allowed: false, refusal: { code: 'NO_GUARANTEE', message: expect.stringContaining('c.c. art. 2101') } })
    expect(made.actions.edit.allowed).toBe(true)
    expect(made.rules).toContain("Waiting that is not the worker's doing is paid at the worker's average earnings per minute in the period: never unpaid (c.c. art. 2100).")
    expect(made.periods.map((row: Json) => [row.id, row.effect])).toEqual([
      [periodNow, 'RUN_AGAIN'],
      [periodNext, 'ACCRUES'],
    ])
    const refused = await no('hr', 'POST', `/people/incentive-schemes/${s1}/activate`, { version: 1 }, 409)
    expect(refused.issues).toEqual([{ path: 'refusal/NO_GUARANTEE', message: expect.stringContaining("the labour consultant's answer") }])
    expect((await outbox('incentive_scheme.changed')).map((row) => row.payload)).toEqual([{ schemeId: s1, companyId: companyA, lineId: null, change: 'CREATED', status: 'DRAFT' }])
  })

  it('refuses a past first day, a bonus with no threshold, a rate from a role without the pay grain, and anyone outside the company', async () => {
    expect((await no('hr', 'POST', '/people/incentive-schemes', { ...base, validFrom: day(-1) }, 400)).issues).toEqual([{ path: 'validFrom', message: expect.stringContaining('never changes pay already worked') }])
    expect((await no('hr', 'POST', '/people/incentive-schemes', { ...base, kind: 'STANDARD_MINUTE_BONUS' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['efficiencyThresholdPct'])
    expect((await no('hr', 'POST', '/people/incentive-schemes', { ...base, waitingPay: 'UNPAID' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/waitingPay'])
    await no('managerNoPay', 'POST', '/people/incentive-schemes', { ...base, guaranteedHourlyRate: '9' }, 403)
    await no('viewer', 'POST', '/people/incentive-schemes', base, 403)
    await no('plain', 'GET', '/people/incentive-schemes', undefined, 403)
    await no('companyB', 'POST', '/people/incentive-schemes', base, 404)
    await no('companyB', 'GET', `/people/incentive-schemes/${s1}`, undefined, 404)
    await no('otherTenant', 'GET', `/people/incentive-schemes/${s1}`, undefined, 404)
    // A company's scheme pays at A1 and A2: a grant over A1 alone may read it, never keep it.
    expect((await ok('siteOnly', 'GET', `/people/incentive-schemes/${s1}`)).canManage).toBe(false)
    await no('siteOnly', 'POST', '/people/incentive-schemes', base, 403)
    await no('siteOnly', 'PATCH', `/people/incentive-schemes/${s1}`, { version: 1, name: 'Mine' }, 403)
  })

  it('changes the DRAFT on the EditModeBar: the guaranteed pay, own-fault rules; a stale version and a missing reduced rate are refused', async () => {
    await no('hr', 'PATCH', `/people/incentive-schemes/${s1}`, { version: 9, name: 'X' }, 409)
    expect((await no('hr', 'PATCH', `/people/incentive-schemes/${s1}`, { version: 1, reworkOwnFault: 'REDUCED_RATE' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['ownFaultRatePct'])
    const changed = await ok('hr', 'PATCH', `/people/incentive-schemes/${s1}`, { version: 1, guaranteedBasis: 'CCNL_MINIMUM', guaranteedHourlyRate: '9.5', traineeHourlyRate: '7.25', reworkOwnFault: 'REDUCED_RATE', ownFaultRatePct: '50' })
    expect(changed.scheme).toMatchObject({ guaranteedBasis: 'CCNL_MINIMUM', guaranteedHourlyRate: '9.5', traineeHourlyRate: '7.25', reworkOwnFault: 'REDUCED_RATE', ownFaultRatePct: '50', version: 2 })
    expect(changed.rules).toContain("Rework of the worker's own fault is paid at 50% of the rate.")
    expect(changed.rules.join(' ')).not.toContain('9.5')
    expect(changed.actions.activate.allowed).toBe(true)
    // Without the pay grain: the rules, never the rates.
    const blind = await ok('managerNoPay', 'GET', `/people/incentive-schemes/${s1}`)
    expect(blind.payShown).toBe(false)
    expect(blind.scheme).not.toHaveProperty('guaranteedHourlyRate')
    expect(blind.scheme).not.toHaveProperty('traineeHourlyRate')
    expect(blind.scheme.guaranteedBasis).toBe('CCNL_MINIMUM')
    const [audit] = await auditOf('people.updateIncentiveScheme')
    expect(audit!.after.guaranteedHourlyRate).toEqual({ $money: 'pay', value: '9.5' })
  })
})

describe('starting and ending (MES-253, MES-257): schemes of a company and line follow each other', () => {
  it('starts the company\'s scheme from today and says which pay periods it touches', async () => {
    const started = await ok('hr', 'POST', `/people/incentive-schemes/${s1}/activate`, { version: 2 })
    expect(started.scheme).toMatchObject({ status: 'ACTIVE', state: 'IN_FORCE', validFrom: today, validTo: null, version: 3 })
    expect(started.scheme.activatedAt).toEqual(expect.any(String))
    expect(started.words[0]).toBe(`"Plant scheme" starts on ${today}.`)
    expect(started.words.at(-1)).toBe(`Applies from ${today}: accrues in ${followingMonth.start.slice(0, 7)}; run ${thisMonth.start.slice(0, 7)} again.`)
    expect(started.actions.edit.refusal.code).toBe('NOT_DRAFT')
    await no('hr', 'PATCH', `/people/incentive-schemes/${s1}`, { version: 3, name: 'Changed' }, 409)
    await no('hr', 'DELETE', `/people/incentive-schemes/${s1}?version=3`, undefined, 409)
  })

  it('a later scheme takes over: the one before ends the day before and is RETIRED, in the same command', async () => {
    const draft = await ok('hr', 'POST', '/people/incentive-schemes', { ...base, name: 'Plant scheme 2027', validFrom: day(40), guaranteedBasis: 'AGREED_HOURLY', guaranteedHourlyRate: '10' }, 201)
    s2 = draft.scheme.id
    const started = await ok('hr', 'POST', `/people/incentive-schemes/${s2}/activate`, { version: 1 })
    expect(started.scheme).toMatchObject({ status: 'ACTIVE', state: 'TO_COME' })
    expect(started.follows).toMatchObject({ id: s1, validTo: day(39), status: 'RETIRED' })
    expect(started.words).toContain(`"Plant scheme" applies until ${day(39)}: this scheme takes over the day after.`)
    expect(await schemeRow(s1)).toMatchObject({ status: 'RETIRED', validTo: day(39), version: 4 })
    const before = await ok('hr', 'GET', `/people/incentive-schemes/${s1}`)
    expect(before.scheme).toMatchObject({ state: 'ENDING', stateWords: `In force until ${day(39)}.` })
    expect(before.followedBy).toMatchObject({ id: s2 })
    expect((await outbox('incentive_scheme.changed')).slice(-3).map((row) => [row.subject, row.payload.change, row.payload.status])).toEqual([
      [s2, 'CREATED', 'DRAFT'],
      [s1, 'RETIRED', 'RETIRED'],
      [s2, 'ACTIVATED', 'ACTIVE'],
    ])
  })

  it('refuses a scheme that would overlap one that already ends later; a DRAFT is deleted', async () => {
    const draft = await ok('hr', 'POST', '/people/incentive-schemes', { ...base, name: 'Too early', validFrom: day(10), guaranteedBasis: 'CCNL_MINIMUM', guaranteedHourlyRate: '9.5' }, 201)
    const refused = await no('hr', 'POST', `/people/incentive-schemes/${draft.scheme.id}/activate`, { version: 1 }, 409)
    expect(refused.issues[0].path).toBe('refusal/OVERLAPS')
    expect(refused.message).toContain(`applies until ${day(39)}`)
    expect(await ok('hr', 'DELETE', `/people/incentive-schemes/${draft.scheme.id}?version=1`)).toEqual({ deleted: { id: draft.scheme.id, name: 'Too early' } })
    expect(await schemeRow(draft.scheme.id)).toBeUndefined()
    expect((await outbox('incentive_scheme.changed')).at(-1)!.payload).toMatchObject({ schemeId: draft.scheme.id, change: 'DELETED' })
  })

  it("a line's own team scheme (MES-259) wins on its line; a grant over the line's site keeps it", async () => {
    const made = await ok('siteOnly', 'POST', '/people/incentive-schemes', { ...base, lineId: lineL1, name: 'Line L1 team', kind: 'TEAM_INCENTIVE', teamSplit: 'HOURS_PRESENT', guaranteedBasis: 'AGREED_HOURLY', guaranteedHourlyRate: '9.75' }, 201)
    lineScheme = made.scheme.id
    expect(made.scheme).toMatchObject({ siteId: siteA1, line: { id: lineL1, code: 'L1' }, teamSplit: 'HOURS_PRESENT' })
    expect(made.rules).toContain("A team's pay splits in proportion to each member's hours present.")
    const started = await ok('siteOnly', 'POST', `/people/incentive-schemes/${lineScheme}/activate`, { version: 1 })
    expect(started.follows).toBeNull()
    expect(await schemeRow(s1)).toMatchObject({ status: 'RETIRED', validTo: day(39) })
    const list = await ok('hr', 'GET', `/people/incentive-schemes?companyId=${companyA}`)
    expect(list.applies).toEqual([
      { line: null, scheme: { id: s1, name: 'Plant scheme' }, inherited: false },
      { line: expect.objectContaining({ id: lineL1, siteId: siteA1 }), scheme: { id: lineScheme, name: 'Line L1 team' }, inherited: false },
    ])
    expect(list.schemes.map((row: Json) => row.id).sort()).toEqual([s1, s2, lineScheme].sort())
    // The production manager reads the schemes without a rate.
    const viewer = await ok('viewer', 'GET', `/people/incentive-schemes?companyId=${companyA}`)
    expect(viewer.payShown).toBe(false)
    expect(viewer.schemes.every((row: Json) => !('guaranteedHourlyRate' in row))).toBe(true)
  })

  it('ends a scheme once, with why, from its first day on; then it never changes', async () => {
    const before = await ok('hr', 'GET', `/people/incentive-schemes/${s2}`)
    expect((await no('hr', 'POST', `/people/incentive-schemes/${s2}/end`, { version: before.scheme.version, lastDay: day(39), reason: 'Consultant asked' }, 409)).issues[0].path).toBe('refusal/ENDS_BEFORE_START')
    expect((await no('hr', 'POST', `/people/incentive-schemes/${s2}/end`, { version: before.scheme.version, lastDay: day(70), reason: 'x' }, 400)).issues[0].path).toBe('reason')
    const ended = await ok('hr', 'POST', `/people/incentive-schemes/${s2}/end`, { version: before.scheme.version, lastDay: day(70), reason: 'The labour consultant asked for a new scheme from then' })
    expect(ended.scheme).toMatchObject({ status: 'RETIRED', validTo: day(70), state: 'TO_COME' })
    const [audit] = await auditOf('people.endIncentiveScheme')
    expect(audit).toMatchObject({ recordId: s2, after: { status: 'RETIRED', validTo: day(70) }, reason: 'The labour consultant asked for a new scheme from then' })
    expect((await no('hr', 'POST', `/people/incentive-schemes/${s2}/end`, { version: ended.scheme.version, lastDay: day(80), reason: 'Again please' }, 409)).issues[0].path).toBe('refusal/NOT_ACTIVE')
  })
})

describe('the legal switch names a scheme (GATE-PIECE-PAY: SCHEME precondition)', () => {
  it("meets the switch's SCHEME precondition with a started scheme; a DRAFT the switch names is not deleted", async () => {
    const first = await ok('hr', 'GET', `/people/piece-rates/sites/${siteA1}/switch`)
    expect(first.preconditions.find((row: Json) => row.code === 'SCHEME').met).toBe(false)
    const recorded = await ok('hr', 'PUT', `/people/piece-rates/sites/${siteA1}/switch/preconditions`, { ...(first.version === null ? {} : { version: first.version }), schemeId: lineScheme })
    expect(recorded.recorded.scheme).toMatchObject({ id: lineScheme, status: 'ACTIVE' })
    expect(recorded.preconditions.find((row: Json) => row.code === 'SCHEME').met).toBe(true)
    expect((await ok('hr', 'GET', `/people/incentive-schemes/${lineScheme}`)).switches).toEqual([{ site: expect.objectContaining({ id: siteA1 }), state: 'OFF' }])

    const draft = await ok('hr', 'POST', '/people/incentive-schemes', { ...base, name: 'Named draft', validFrom: day(100) }, 201)
    const named = await ok('hr', 'PUT', `/people/piece-rates/sites/${siteA1}/switch/preconditions`, { version: recorded.version, schemeId: draft.scheme.id })
    expect(named.preconditions.find((row: Json) => row.code === 'SCHEME').met).toBe(false)
    const refused = await no('hr', 'DELETE', `/people/incentive-schemes/${draft.scheme.id}?version=1`, undefined, 409)
    expect(refused.issues).toEqual([{ path: 'refusal/NAMED_BY_SWITCH', message: expect.stringContaining('name another scheme there first') }])
    await ok('hr', 'PUT', `/people/piece-rates/sites/${siteA1}/switch/preconditions`, { version: named.version, schemeId: lineScheme })
  })
})

describe('try the scheme (MES-257, MES-258, MES-259): made-up figures, the pay grain only', () => {
  it('makes piece pay up to the guaranteed pay, prices waiting and rework by the rules (c.c. arts. 2100-2101)', async () => {
    const answer = await ok('hr', 'POST', `/people/incentive-schemes/${s1}/example`, { minutesPresent: 9600, pieceEarnings: '1300.00', waitingMinutes: 120, rework: { ownPieces: 10, ratePerPiece: '1.20', othersMinutes: 60 } })
    // guaranteed 9600 min × 9.50 / 60 = 1520.00; average 1300.00 / 9420 min = 0.138004 per minute.
    expect(answer.lines.map((line: Json) => [line.code, line.minutes, line.pieces, line.rate, line.amount])).toEqual([
      ['PIECES', null, null, null, 130_000],
      ['WAITING', '120', null, '0.138004', 1_656],
      ['REWORK_OWN', null, 10, '0.6', 600],
      ['REWORK_OTHERS', '60', null, '0.138004', 828],
      ['MAKE_UP', '9600', null, '0.158333', 18_916],
    ])
    expect(answer).toMatchObject({ guaranteed: 152_000, makeUp: 18_916, total: 152_000, currency: 'EUR' })
    expect(answer.words[0]).toContain('never below the guaranteed pay')
    await no('managerNoPay', 'POST', `/people/incentive-schemes/${s1}/example`, { minutesPresent: 60, pieceEarnings: '1' }, 403)
    const undecided = await ok('hr', 'POST', '/people/incentive-schemes', { ...base, name: 'Undecided', validFrom: day(120) }, 201)
    expect((await no('hr', 'POST', `/people/incentive-schemes/${undecided.scheme.id}/example`, { minutesPresent: 60, pieceEarnings: '1' }, 409)).issues[0].path).toBe('refusal/NO_GUARANTEE')
  })

  it("splits a team's pay by hours present, adding up exactly; another kind refuses a team", async () => {
    const answer = await ok('hr', 'POST', `/people/incentive-schemes/${lineScheme}/example`, { minutesPresent: 480, pieceEarnings: '90.00', team: { teamEarnings: '100.00', members: [{ label: 'A', minutesPresent: 480 }, { label: 'B', minutesPresent: 240 }] } })
    expect(answer.teamShares).toEqual([
      { label: 'A', sharePct: '66.6667', amount: 6_667 },
      { label: 'B', sharePct: '33.3333', amount: 3_333 },
    ])
    // 480 min × 9.75 / 60 = 78.00: 90.00 earned, no make-up.
    expect(answer).toMatchObject({ guaranteed: 7_800, makeUp: 0, total: 9_000 })
    expect((await no('hr', 'POST', `/people/incentive-schemes/${s1}/example`, { minutesPresent: 60, pieceEarnings: '1', team: { teamEarnings: '1', members: [{ label: 'A', minutesPresent: 1 }] } }, 400)).issues[0].path).toBe('team')
  })
})

describe('a locked pay period never changes', () => {
  it('refuses a scheme whose first day falls in a LOCKED period', async () => {
    await admin('UPDATE "PayPeriod" SET status = \'REVIEW\', "reviewStartedAt" = now(), "reviewStartedById" = $2 WHERE id = $1', [periodNow, newId()])
    await admin('UPDATE "PayPeriod" SET status = \'LOCKED\', "lockedAt" = now(), "lockedById" = $2 WHERE id = $1', [periodNow, newId()])
    const draft = await ok('hr', 'POST', '/people/incentive-schemes', { ...base, lineId: lineL1, name: 'Late line scheme', validFrom: thisMonth.end, guaranteedBasis: 'CCNL_MINIMUM', guaranteedHourlyRate: '9.5' }, 201)
    expect(draft.periods.find((row: Json) => row.id === periodNow)).toMatchObject({ status: 'LOCKED', effect: 'LOCKED' })
    const refused = await no('hr', 'POST', `/people/incentive-schemes/${draft.scheme.id}/activate`, { version: 1 }, 409)
    expect(refused.issues[0].path).toBe('refusal/PERIOD_LOCKED')
  })

  it('events carry ids and states only: never a rate or a reason', async () => {
    for (const row of await outbox('incentive_scheme.changed')) expect(Object.keys(row.payload).sort()).toEqual(['change', 'companyId', 'lineId', 'schemeId', 'status'])
  })
})
