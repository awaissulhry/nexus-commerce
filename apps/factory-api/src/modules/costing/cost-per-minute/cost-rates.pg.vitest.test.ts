import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { CPM_REFUSAL_WORDS, MINUTES_FROM_WORDS, OVERHEAD_TWICE } from '@nexus/factory-domain/costing/cost-per-minute/rules'
import { OVERHEAD_UNVERIFIED } from '@nexus/factory-domain/costing/overhead-rules/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The cost rates on the local stack (B-W2b-419; FIN-005, FIN-007) with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security and the …_cost_sheets_w2b_guards are real), the core seed's
 * plants (A1: the cutting table CUT with one station, the sewing work centre SEW with two; B1 the same), the calendar seed
 * (each company Monday to Friday, one shift 08:00-17:00 less an hour's lunch = 480 minutes, Italy's holidays; plant A1 closed
 * on 24 and 28-31 December 2026), the costing seed's tenant-wide rates (sewing 0.40 at 80 %) and 0 % overhead, and A1's
 * planned seats typed below as Planning settings keeps them (cutting 2 tables, sewing 8 machines; plant B1 none: its active
 * stations count). Every figure is made up and worked out by hand. Run with `node scripts/factory/run-pg-tests.mjs
 * modules/costing/cost-per-minute`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'cost-rates'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const siteA1 = id('site:A1')
const sewA1 = id('site:A1:work-centre:SEW')
const cutA1 = id('site:A1:work-centre:CUT')
const cutB1 = id('site:B1:work-centre:CUT')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext => {
  const role = templateOf(name)!
  return office([grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance'),
  // Sales holds costing.view, not the cost grain: it sees the rules and calculations without a figure.
  sales: fromTemplate('sales'),
  managerB: office([grant(['costing.view', 'costing.rates.manage', 'money.cost'], [companyB])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [grant(['costing.view', 'costing.rates.manage', 'money.wages'], [companyA])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function failed(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
async function refusal(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const error = await failed(session, method, url, payload, 409)
  expect(error.issues?.[0]?.path).toBe(`refusal/${code}`)
  return error
}
const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => [event.type, event.payload])
const auditOf = async (recordId: string) => admin<{ action: string; before: Json | null; after: Json | null }>('SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [recordId])
const cost = (value: string) => ({ $money: 'cost', value })
// A day surely to come (the rates applied below start then), and one surely gone.
const NEXT_YEAR = `${Number(businessDate(new Date()).slice(0, 4)) + 1}-01-01`

beforeAll(async () => {
  db = await migratedDatabase('cost_rates')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  // Plant A1's planned seats, as Planning settings keeps them (B-W2a-16's WorkCentreCapacity): cutting 2, sewing 8.
  for (const [centre, units] of [
    [cutA1, 2],
    [sewA1, 8],
  ] as const) {
    await admin('INSERT INTO "WorkCentreCapacity" (id, "tenantId", "companyId", "siteId", "workCentreId", units, "plannedEfficiencyPct") VALUES ($1, $2, $3, $4, $1, $5, 90)', [centre, tenant, companyA, siteA1, units])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const rule = (body: Json, status = 201) => ok('finance', 'POST', '/costing/overhead-rules', body, status)
const labourA = { companyId: companyA, basis: 'PERCENT_OF_LABOUR', value: '25', periodStart: '2026-01-01', note: 'Made-up absorption rate.' }

describe('overhead absorption rules (FIN-007)', () => {
  const ids = { labourA: '', labourA2: '', sewingA: '', unitH1: '', unitH2: '' }

  it('are kept per company or every company, basis, kind and whole months, UNVERIFIED, with an audit row and an event', async () => {
    const made = await rule(labourA)
    ids.labourA = made.rule.id
    expect(made).toMatchObject({
      rule: { companyId: companyA, key: `overhead:${companyA}:PERCENT_OF_LABOUR:all`, basis: 'PERCENT_OF_LABOUR', workCentreKind: null, value: '25', currency: null, periodStart: '2026-01-01', periodEnd: null, status: 'ACTIVE', version: 1 },
      ended: null,
      unverified: OVERHEAD_UNVERIFIED,
    })
    ids.sewingA = (await rule({ companyId: companyA, basis: 'PER_MINUTE', workCentreKind: 'SEWING', value: '0.05', currency: 'EUR', periodStart: '2026-11-01' })).rule.id
    ids.unitH1 = (await rule({ basis: 'PER_UNIT', value: '2.5', currency: 'EUR', periodStart: '2026-01-01', periodEnd: '2026-06-30' })).rule.id
    // The second half follows the first without touching it (no day shared).
    ids.unitH2 = (await rule({ basis: 'PER_UNIT', value: '2.75', currency: 'EUR', periodStart: '2026-07-01' })).rule.id
    expect(await eventsOf(ids.labourA)).toEqual([['overhead_rule.changed', { ruleId: ids.labourA, basis: 'PERCENT_OF_LABOUR', workCentreKind: null, change: 'created' }]])
    expect(await auditOf(ids.labourA)).toEqual([
      {
        action: 'costing.createOverheadRule',
        before: null,
        after: { companyId: companyA, key: `overhead:${companyA}:PERCENT_OF_LABOUR:all`, basis: 'PERCENT_OF_LABOUR', workCentreKind: null, value: cost('25'), currency: null, periodStart: '2026-01-01', periodEnd: null, note: 'Made-up absorption rate.', status: 'ACTIVE' },
      },
    ])
  })

  it('refuse an overlap in words, and end the rule before on request in the same command', async () => {
    const later = { companyId: companyA, basis: 'PERCENT_OF_LABOUR', value: '30', periodStart: '2026-12-01' }
    const overlap = await refusal('finance', 'POST', '/costing/overhead-rules', later, 'OVERLAPS')
    expect(overlap.message).toMatch(/^Another active rule of the same company, basis and kind of work centre covers part of this period/)
    const made = await rule({ ...later, endPrevious: true })
    ids.labourA2 = made.rule.id
    expect(made.ended).toMatchObject({ id: ids.labourA, periodEnd: '2026-11-30', version: 2 })
    expect((await eventsOf(ids.labourA)).at(-1)).toEqual(['overhead_rule.changed', { ruleId: ids.labourA, basis: 'PERCENT_OF_LABOUR', workCentreKind: null, change: 'ended' }])
    expect((await auditOf(ids.labourA)).at(-1)).toEqual({ action: 'costing.endOverheadRule', before: { periodEnd: null }, after: { periodEnd: '2026-11-30' } })
    // The same key and month again; endPrevious ends one earlier rule, never two.
    await refusal('finance', 'POST', '/costing/overhead-rules', later, 'START_TAKEN')
    await refusal('finance', 'POST', '/costing/overhead-rules', { ...labourA, periodStart: '2026-02-01', endPrevious: true }, 'OVERLAPS')
  })

  it('check the figure, the months and who may keep them', async () => {
    const bad = await failed('finance', 'POST', '/costing/overhead-rules', { ...labourA, currency: 'EUR', periodStart: '2027-01-15' }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/currency', 'body/periodStart'])
    expect((await failed('finance', 'POST', '/costing/overhead-rules', { basis: 'PER_UNIT', value: '0', periodStart: '2027-01-01' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/value', 'body/currency'])
    // Company B's manager keeps company B's rules only: not every company's, not company A's.
    expect((await failed('managerB', 'POST', '/costing/overhead-rules', { basis: 'PER_UNIT', value: '1', currency: 'EUR', periodStart: '2027-01-01' }, 403)).message).toBe("Every company's overhead rule is changed only by a role over every company.")
    await failed('managerB', 'POST', '/costing/overhead-rules', { ...labourA, periodStart: '2030-01-01' }, 403)
    await failed('sales', 'POST', '/costing/overhead-rules', { ...labourA, periodStart: '2030-01-01' }, 403)
    await failed('floor', 'GET', '/costing/overhead-rules', undefined, 403)
  })

  it('are corrected, ended and archived, never deleted; an archived rule changes no more', async () => {
    const corrected = await ok('finance', 'PATCH', `/costing/overhead-rules/${ids.sewingA}`, { version: 1, value: '0.055', note: 'Made-up correction.' })
    expect(corrected.rule).toMatchObject({ value: '0.055', note: 'Made-up correction.', version: 2 })
    expect((await auditOf(ids.sewingA)).at(-1)).toEqual({ action: 'costing.updateOverheadRule', before: { value: cost('0.05'), note: null }, after: { value: cost('0.055'), note: 'Made-up correction.' } })
    await refusal('finance', 'PATCH', `/costing/overhead-rules/${ids.sewingA}`, { version: 2, value: '0.055' }, 'NOTHING_CHANGES')
    expect((await failed('finance', 'PATCH', `/costing/overhead-rules/${ids.sewingA}`, { version: 2, periodEnd: '2026-11-29' }, 400)).issues[0].path).toBe('body/periodEnd')
    // Open-ended again, the first 25 % would run into December's 30 %.
    await refusal('finance', 'PATCH', `/costing/overhead-rules/${ids.labourA}`, { version: 2, periodEnd: null }, 'OVERLAPS')
    expect((await ok('finance', 'POST', `/costing/overhead-rules/${ids.unitH1}/archive`, { version: 1, reason: 'Made-up: replaced.' })).rule).toMatchObject({ status: 'ARCHIVED', inForce: false })
    await refusal('finance', 'POST', `/costing/overhead-rules/${ids.unitH1}/archive`, { version: 2 }, 'ARCHIVED')
    await refusal('finance', 'PATCH', `/costing/overhead-rules/${ids.unitH1}`, { version: 2, value: '3' }, 'ARCHIVED')
    expect(await admin('SELECT count(*)::int AS n FROM "OverheadRule" WHERE id = $1', [ids.unitH1])).toEqual([{ n: 1 }])
  })

  it("are listed for a company with every company's, without a figure for a caller without the cost grain", async () => {
    const listed = await ok('finance', 'GET', `/costing/overhead-rules?companyId=${companyA}&status=ALL`)
    expect(listed.unverified).toBe(OVERHEAD_UNVERIFIED)
    expect(listed.rules.map((found: Json) => found.id)).toEqual([ids.unitH2, ids.unitH1, ids.labourA2, ids.labourA, ids.sewingA])
    expect((await ok('finance', 'GET', `/costing/overhead-rules?companyId=${companyA}&on=2026-11-15`)).rules.map((found: Json) => found.id)).toEqual([ids.unitH2, ids.labourA, ids.sewingA])
    const blind = await ok('sales', 'GET', `/costing/overhead-rules/${ids.sewingA}`)
    expect(blind.rule.basis).toBe('PER_MINUTE')
    expect(blind.rule).not.toHaveProperty('value')
    expect(await ok('managerB', 'GET', `/costing/overhead-rules?companyId=${companyB}`)).toMatchObject({ rules: [{ id: ids.unitH2 }] })
    await failed('managerB', 'GET', `/costing/overhead-rules/${ids.sewingA}`, undefined, 404)
  })

  it('in force for a company and kind on a day: one per basis, the most specific, and the overhead they absorb', async () => {
    // November, sewing: 25 % of labour 48.25 = 12.0625; 96.5 minutes × 0.055 = 5.3075; 1 garment × 2.75; total 20.12.
    const november = await ok('finance', 'GET', `/costing/overhead-rules/in-force?companyId=${companyA}&workCentreKind=SEWING&on=2026-11-15&labourCost=48.25&minutes=96.5&units=1`)
    expect(november).toMatchObject({ currency: 'EUR', total: '20.120000', fallback: null, words: '3 overhead rules are in force here, one per basis: they add up.', unverified: OVERHEAD_UNVERIFIED })
    expect(november.lines).toEqual([
      { ruleId: ids.labourA, basis: 'PERCENT_OF_LABOUR', workCentreKind: null, quantity: '1', unitCost: '12.062500', pct: '25', amount: '12.062500', missing: null, missingWords: null },
      { ruleId: ids.sewingA, basis: 'PER_MINUTE', workCentreKind: 'SEWING', quantity: '96.5', unitCost: '0.055', pct: null, amount: '5.307500', missing: null, missingWords: null },
      { ruleId: ids.unitH2, basis: 'PER_UNIT', workCentreKind: null, quantity: '1', unitCost: '2.75', pct: null, amount: '2.750000', missing: null, missingWords: null },
    ])
    // December: 30 % takes over; without the minutes the total is not drawn.
    const december = await ok('finance', 'GET', `/costing/overhead-rules/in-force?companyId=${companyA}&workCentreKind=SEWING&on=2026-12-15&labourCost=48.25&units=1`)
    expect(december.lines.map((line: Json) => [line.ruleId, line.amount, line.missing])).toEqual([
      [ids.labourA2, '14.475000', null],
      [ids.sewingA, null, 'MINUTES'],
      [ids.unitH2, '2.750000', null],
    ])
    expect(december.total).toBeNull()
    // Company B before July 2026 has none (the first half's rule is archived): the costing settings' 0 % stays.
    const none = await ok('finance', 'GET', `/costing/overhead-rules/in-force?companyId=${companyB}&on=2026-03-01`)
    expect(none).toMatchObject({ rules: [], lines: [], total: '0.000000', fallback: { settingsId: tenant, overheadPct: '0' } })
    expect(none.words).toMatch(/^No overhead rule is in force here/)
    const blind = await ok('sales', 'GET', `/costing/overhead-rules/in-force?companyId=${companyA}&workCentreKind=SEWING&on=2026-11-15&units=1`)
    expect(blind).not.toHaveProperty('total')
    expect(blind.lines[2]).not.toHaveProperty('amount')
  })
})

describe('the cost-per-minute calculator (FIN-005)', () => {
  const calcs: { basis: Json; october: Json; table: Json } = { basis: {}, october: {}, table: {} }
  const october = { companyId: companyA, workCentreKind: 'SEWING', periodStart: '2026-10-01', periodEnd: '2026-10-31' }
  // Plant A1's calendar decides the normal week (the most specific of the chain) and its closures; the company's its holidays.
  const CALENDARS_A1 = [id('calendar:company:A'), id('calendar:site:A1')].sort()

  it("prefills a department's available minutes from its calendars × its planned seats, with no headcount", async () => {
    // October 2026: 22 working days × 480 minutes × 8 machines = 84,480. No per-minute rule for sewing yet.
    const { prefill } = await ok('finance', 'GET', `/costing/cost-per-minute/prefill?companyId=${companyA}&workCentreKind=SEWING&periodStart=2026-10-01&periodEnd=2026-10-31`)
    expect(prefill).toMatchObject({ currency: 'EUR', availableMinutes: '84480', overheadRules: [], overheadPerMinuteFromRules: '0.000000', words: [MINUTES_FROM_WORDS] })
    expect(prefill.workCentres).toEqual([{ id: sewA1, siteId: siteA1, code: 'SEW', name: expect.any(String), workingDays: 22, availableMinutes: '84480', seatsFrom: 'CAPACITY', calendarIds: CALENDARS_A1 }])
    expect(prefill.minutesBasis).toEqual({ source: 'CALENDARS', periodStart: '2026-10-01', periodEnd: '2026-10-31', workCentres: [{ id: sewA1, code: 'SEW', workingDays: 22, availableMinutes: '84480', capacityFrom: 'CAPACITY' }] })
    calcs.basis = prefill.minutesBasis
    // December: 23 weekdays less the 8th, 24th, 25th and 28-31 (plant A1's closure) = 16 × 480 × 8 = 61,440; company A's
    // per-minute sewing rule is in force, so the rate should carry no overhead of its own.
    const december = (await ok('finance', 'GET', `/costing/cost-per-minute/prefill?companyId=${companyA}&workCentreKind=SEWING&periodStart=2026-12-01&periodEnd=2026-12-31`)).prefill
    expect(december).toMatchObject({ availableMinutes: '61440', overheadPerMinuteFromRules: '0.055000', words: [MINUTES_FROM_WORDS, OVERHEAD_TWICE] })
    expect(december.workCentres[0].calendarIds).toEqual(CALENDARS_A1)
    // Plant B1's cutting table: one active station, no planned seats: one person's pay.
    const single = (await ok('finance', 'GET', `/costing/cost-per-minute/prefill?companyId=${companyB}&workCentreKind=CUTTING&periodStart=2026-10-01&periodEnd=2026-10-31`)).prefill
    expect(single).toMatchObject({ availableMinutes: '10560', words: [MINUTES_FROM_WORDS, CPM_REFUSAL_WORDS.ONE_SEAT] })
    expect(single.workCentres[0]).toMatchObject({ id: cutB1, seatsFrom: 'STATIONS' })
    await refusal('finance', 'GET', `/costing/cost-per-minute/prefill?companyId=${companyA}&workCentreKind=SEWING&workCentreId=${cutA1}&periodStart=2026-10-01&periodEnd=2026-10-31`, undefined, 'NOT_OF_KIND')
    expect((await failed('finance', 'GET', `/costing/cost-per-minute/prefill?companyId=${companyA}&workCentreKind=SEWING&periodStart=2026-10-01&periodEnd=2026-10-30`, undefined, 400)).issues[0].path).toBe('querystring/periodEnd')
  })

  it('computes the cost per minute once, half up, keeps the totals only, audited and announced', async () => {
    // 42,240.00 ÷ 84,480 = 0.50; + 0.06 + 0.04 = 0.60.
    const { calc } = await ok('finance', 'POST', '/costing/cost-per-minute', { ...october, directLabourCost: '42240', availableMinutes: '84480', indirectPerMinute: '0.06', overheadPerMinute: '0.04', minutesBasis: calcs.basis, note: 'Made-up payroll total.' }, 201)
    calcs.october = calc
    expect(calc).toMatchObject({
      companyId: companyA,
      workCentreKind: 'SEWING',
      workCentre: null,
      key: `cpm:${companyA}:SEWING:all`,
      currency: 'EUR',
      directLabourCost: '42240',
      availableMinutes: '84480',
      costPerMinute: '0.6',
      labourRateId: null,
      labourRate: null,
      warnings: [],
      unverified: OVERHEAD_UNVERIFIED,
      version: 1,
    })
    expect(calc.words).toMatch(/^Not applied/)
    expect(await eventsOf(calc.id)).toEqual([['cost_per_minute.changed', { calcId: calc.id, workCentreKind: 'SEWING', change: 'created', labourRateId: null }]])
    expect((await auditOf(calc.id))[0]).toMatchObject({
      action: 'costing.createCostPerMinute',
      after: { directLabourCost: cost('42240'), availableMinutes: '84480', indirectPerMinute: cost('0.06'), overheadPerMinute: cost('0.04'), costPerMinute: cost('0.6') },
    })
    // One work centre of the department: the cutting table of A1 (2 seats), 1 ÷ 3 rounds down once.
    const table = (await ok('finance', 'POST', '/costing/cost-per-minute', { companyId: companyA, workCentreKind: 'CUTTING', workCentreId: cutA1, periodStart: '2026-10-01', periodEnd: '2026-10-31', directLabourCost: '1', availableMinutes: '3' }, 201)).calc
    expect(table).toMatchObject({ workCentre: { id: cutA1, siteId: siteA1, code: 'CUT' }, key: `cpm:${companyA}:CUTTING:${cutA1}`, costPerMinute: '0.333333' })
    calcs.table = table
  })

  it('refuses a headcount, another currency, one seat, a work centre of another kind, and callers without the right', async () => {
    const bad = await failed('finance', 'POST', '/costing/cost-per-minute', { ...october, directLabourCost: '1', availableMinutes: '1', minutesBasis: { headcount: 8 } }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/minutesBasis/headcount'])
    await refusal('finance', 'POST', '/costing/cost-per-minute', { ...october, currency: 'CHF', directLabourCost: '1', availableMinutes: '1' }, 'CURRENCY')
    const one = await refusal('finance', 'POST', '/costing/cost-per-minute', { companyId: companyB, workCentreKind: 'CUTTING', periodStart: '2026-10-01', periodEnd: '2026-10-31', directLabourCost: '2500', availableMinutes: '10560' }, 'ONE_SEAT')
    expect(one.message).toBe(CPM_REFUSAL_WORDS.ONE_SEAT)
    await refusal('finance', 'POST', '/costing/cost-per-minute', { ...october, workCentreId: cutA1, directLabourCost: '1', availableMinutes: '1' }, 'NOT_OF_KIND')
    await refusal('finance', 'POST', '/costing/cost-per-minute', { ...october, directLabourCost: '999999999999', availableMinutes: '0.0001' }, 'TOO_BIG')
    await failed('managerB', 'POST', '/costing/cost-per-minute', { ...october, directLabourCost: '1', availableMinutes: '1' }, 403)
    await failed('sales', 'POST', '/costing/cost-per-minute', { ...october, directLabourCost: '1', availableMinutes: '1' }, 403)
    await failed('floor', 'GET', '/costing/cost-per-minute', undefined, 403)
    expect(await admin('SELECT count(*)::int AS n FROM "CostPerMinuteCalc"')).toEqual([{ n: 2 }])
  })

  it('is corrected and removed while not applied; the cost per minute follows, and the overhead twice is said', async () => {
    // 50,688.00 ÷ 84,480 = 0.60; + 0.10 = 0.70. The basis cleared.
    const { calc } = await ok('finance', 'PATCH', `/costing/cost-per-minute/${calcs.october.id}`, { version: 1, directLabourCost: '50688', minutesBasis: null })
    expect(calc).toMatchObject({ directLabourCost: '50688', costPerMinute: '0.7', minutesBasis: null, version: 2 })
    expect((await auditOf(calc.id)).at(-1)).toEqual({
      action: 'costing.updateCostPerMinute',
      before: { directLabourCost: cost('42240'), costPerMinute: cost('0.6') },
      after: { directLabourCost: cost('50688'), costPerMinute: cost('0.7'), minutesBasis: null },
    })
    calcs.october = calc
    const december = (await ok('finance', 'POST', '/costing/cost-per-minute', { ...october, periodStart: '2026-12-01', periodEnd: '2026-12-31', directLabourCost: '30720', availableMinutes: '61440', overheadPerMinute: '0.04' }, 201)).calc
    expect(december).toMatchObject({ costPerMinute: '0.54', warnings: [OVERHEAD_TWICE] })
    expect(await ok('finance', 'DELETE', `/costing/cost-per-minute/${december.id}?version=1`)).toEqual({ id: december.id, removed: true })
    expect((await eventsOf(december.id)).map(([, payload]) => (payload as Json).change)).toEqual(['created', 'removed'])
    await failed('finance', 'GET', `/costing/cost-per-minute/${december.id}`, undefined, 404)
  })

  it("applies as the company's labour rate of the department from a day, in one command, and changes no more", async () => {
    await refusal('finance', 'POST', `/costing/cost-per-minute/${calcs.october.id}/apply`, { version: 2, validFrom: '2000-01-01' }, 'PAST_DAY')
    const applied = await ok('finance', 'POST', `/costing/cost-per-minute/${calcs.october.id}/apply`, { version: 2, validFrom: NEXT_YEAR })
    // The planned efficiency of the rate in force for sewing that day: the tenant-wide 80 %.
    expect(applied.rate).toMatchObject({ companyId: companyA, workCentreKind: 'SEWING', costPerMinute: '0.7', currency: 'EUR', plannedEfficiencyPct: '80', validFrom: NEXT_YEAR, status: 'ACTIVE', note: 'From the cost-per-minute calculation of 2026-10-01 to 2026-10-31.' })
    expect(applied.calc).toMatchObject({ labourRateId: applied.rate.id, appliedById: expect.any(String), labourRate: { id: applied.rate.id }, words: `Applied: the labour rate from ${NEXT_YEAR} came from this calculation. It changes no more.`, version: 3 })
    expect(await eventsOf(applied.rate.id)).toEqual([['labour_rate.created', { rateId: applied.rate.id, workCentreKind: 'SEWING', validFrom: NEXT_YEAR }]])
    expect((await eventsOf(calcs.october.id)).at(-1)).toEqual(['cost_per_minute.changed', { calcId: calcs.october.id, workCentreKind: 'SEWING', change: 'applied', labourRateId: applied.rate.id }])
    expect((await auditOf(applied.rate.id)).map((row) => row.action)).toEqual(['costing.createRate'])
    expect((await auditOf(calcs.october.id)).at(-1)).toEqual({
      action: 'costing.applyCostPerMinute',
      before: { applied: false },
      after: { applied: true, labourRateId: applied.rate.id, validFrom: NEXT_YEAR, costPerMinute: cost('0.7'), plannedEfficiencyPct: '80' },
    })
    // Applied: never changed, removed or applied again; a second calculation of the department and month is not applied.
    await refusal('finance', 'POST', `/costing/cost-per-minute/${calcs.october.id}/apply`, { version: 3, validFrom: NEXT_YEAR }, 'APPLIED')
    await refusal('finance', 'PATCH', `/costing/cost-per-minute/${calcs.october.id}`, { version: 3, note: 'x' }, 'APPLIED')
    await refusal('finance', 'DELETE', `/costing/cost-per-minute/${calcs.october.id}?version=3`, undefined, 'APPLIED')
    const again = (await ok('finance', 'POST', '/costing/cost-per-minute', { ...october, directLabourCost: '1', availableMinutes: '1' }, 201)).calc
    await refusal('finance', 'POST', `/costing/cost-per-minute/${again.id}/apply`, { version: 1, validFrom: NEXT_YEAR }, 'ANOTHER_APPLIED')
    // The cutting table's rate from a day the company has a cutting rate already: POST /costing/rates' own words.
    await ok('finance', 'POST', '/costing/rates', { companyId: companyA, workCentreKind: 'CUTTING', costPerMinute: '0.55', validFrom: NEXT_YEAR }, 201)
    expect((await failed('finance', 'POST', `/costing/cost-per-minute/${calcs.table.id}/apply`, { version: 1, validFrom: NEXT_YEAR }, 409)).message).toBe(
      `A CUTTING rate from ${NEXT_YEAR} exists already for this company (or tenant-wide): correct it, or choose another first day.`,
    )
    expect(await admin('SELECT "appliedAt" IS NULL AS open FROM "CostPerMinuteCalc" WHERE id = $1', [calcs.table.id])).toEqual([{ open: true }])
    // The database holds it too, for every login: an applied calculation changes no more.
    await expect(admin('UPDATE "CostPerMinuteCalc" SET note = $2 WHERE id = $1', [calcs.october.id, 'x'])).rejects.toThrow(/was applied as a labour rate: it changes no more/)
  })

  it('is listed per company, department and whether applied, without a figure for a caller without the cost grain', async () => {
    const applied = await ok('finance', 'GET', `/costing/cost-per-minute?companyId=${companyA}&applied=true`)
    expect(applied.calcs.map((found: Json) => [found.id, found.words])).toEqual([[calcs.october.id, `Applied: the labour rate from ${NEXT_YEAR} came from this calculation. It changes no more.`]])
    const first = await ok('finance', 'GET', `/costing/cost-per-minute?companyId=${companyA}&limit=1`)
    expect(first.calcs).toHaveLength(1)
    const rest = await ok('finance', 'GET', `/costing/cost-per-minute?companyId=${companyA}&limit=10&cursor=${first.nextCursor}`)
    expect(rest.calcs).toHaveLength(2)
    expect(rest.nextCursor).toBeNull()
    expect((await ok('finance', 'GET', `/costing/cost-per-minute?workCentreKind=CUTTING`)).calcs.map((found: Json) => found.id)).toEqual([calcs.table.id])
    const blind = (await ok('sales', 'GET', `/costing/cost-per-minute/${calcs.october.id}`)).calc
    expect(blind).toMatchObject({ availableMinutes: '84480', workCentreKind: 'SEWING' })
    for (const field of ['directLabourCost', 'indirectPerMinute', 'overheadPerMinute', 'costPerMinute']) expect(blind).not.toHaveProperty(field)
    expect(blind.labourRate).not.toHaveProperty('costPerMinute')
    expect(await ok('managerB', 'GET', '/costing/cost-per-minute')).toEqual({ calcs: [], nextCursor: null })
    await failed('managerB', 'GET', `/costing/cost-per-minute/${calcs.october.id}`, undefined, 404)
  })
})
