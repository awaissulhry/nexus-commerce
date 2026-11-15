import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { textOf } from '../../../adapters/ses/fake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { runReportMails } from '../reports/subscriptions'
import { runOwnerDigests } from './mail'

/**
 * The owner digest, Today's value per stage and "E-mail me this" for any report (B-W2b-435; ANA-032; follow-up DG1:01) on the
 * local stack with the app's real routes and EVERY factory-db seed (made up), some rows moved by the test into yesterday: my
 * morning e-mail's defaults, saved at its version (refusals in words), previewed in a language as me (my rights: a section of a
 * list I cannot read left out and said, money only with its grain), the owner's switch per company (OFF by default; the test
 * mail and the scheduler both held while it is off; the database refuses a sent mark too), the scheduler sending once on FAKE
 * SES, the work-order flow's value at cost for the cost grain only, and a report e-mailed to the person who asked. Nothing is
 * sent by itself: every send here is called by the test. Run with `node scripts/factory/run-pg-tests.mjs modules/insights/digest`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'PUT' | 'DELETE' | 'POST'

vi.setConfig({ testTimeout: 180_000 })

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'insights-digest435'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const companyB = seedUuid(NS, 'company:B')
const ZONE = 'Europe/Rome'

const PEOPLE = { owner: newId(), planner: newId(), quality: newId(), finance: newId() } as Record<string, string>
const ROLE_OF: Record<string, string> = { owner: 'owner', planner: 'planner', quality: 'quality_inspector', finance: 'finance' }
const SESSIONS: Record<string, SessionContext> = {}
const grantOf = (role: string): Grant => {
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const email = (person: string) => `k435-${person}-${run}@example.com`

async function call(person: string, method: Method, url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `k435-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(200)
  return answer.body
}
async function no(person: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return ((answer.body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
}

const errors: string[] = []
const log: Log = { info: () => undefined, warn: () => undefined, error: (fields, message) => errors.push(`${message} ${JSON.stringify(fields)}`) }
const today = () => businessDate(new Date(), ZONE)
const yesterday = () => plusDays(today(), -1)
/** The scheduler's clock: today 23:30 on the site's clock (every 07:30 digest is due by then). */
const lateToday = () => ({ now: () => localInstant(today(), 23 * 60 + 30, ZONE) })
const mailsTo = (person: string) => h.ses.mails.filter((mail) => mail.to.includes(email(person)))

beforeAll(async () => {
  h = await startHarness('insights_dig435')
  h.clock.set(new Date())
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  for (const [person, role] of Object.entries(ROLE_OF)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'it')`, [PEOPLE[person], T, email(person), `Made-up ${person}`])
    const roleId = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, role])).id
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), T, PEOPLE[person], roleId])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person]!, companyId: companyA, grants: [grantOf(role)] } as SessionContext
  }
  // Yesterday: SEED-SO-0001 ordered, SEED-SH-0001 left; SEED-SO-0002 is three days past its promise and still open.
  await force(`UPDATE "SalesOrder" SET "orderDate" = $2::date WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T, yesterday()])
  await force(`UPDATE "SalesOrder" SET "promiseDate" = $2::date, status = 'CONFIRMED' WHERE "tenantId" = $1 AND number = 'SEED-SO-0002'`, [T, plusDays(today(), -3)])
  await force(`UPDATE "Shipment" SET status = 'SHIPPED', "shippedAt" = $2 WHERE "tenantId" = $1 AND number = 'SEED-SH-0001'`, [T, new Date(businessDayRange(yesterday(), ZONE).start.getTime() + 10 * 3_600_000)])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await ok('owner', 'POST', '/insights/facts/rebuild', { from: plusDays(today(), -3), to: today() })
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('my morning e-mail (ANA-032)', () => {
  it('starts off, at 07:30 site time, Monday to Friday, in my language, every section; the companies are switched off', async () => {
    const digest = await ok('planner', 'GET', '/insights/digest')
    expect(digest.setting).toMatchObject({ saved: false, enabled: false, sendTime: '07:30', timeZone: ZONE, weekdays: [1, 2, 3, 4, 5], locale: 'it', sections: ['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS'], version: 0 })
    expect(digest).toMatchObject({ held: 'OFF', nextAt: null, email: email('planner') })
    const a = digest.companies.find((company: Json) => company.id === companyA)
    // B-W2b-381's seed keeps both companies' switches, OFF (version 1).
    expect(a).toMatchObject({ mailOn: false, maySwitch: false, switchVersion: 1, recipients: null })
    // The owner holds the switch and sees who gets it (the seed's owner has a group digest on).
    const owner = await ok('owner', 'GET', '/insights/digest')
    const ownerA = owner.companies.find((company: Json) => company.id === companyA)
    expect(ownerA.maySwitch).toBe(true)
    expect(ownerA.recipients.some((person: Json) => person.group === true)).toBe(true)
  })

  it('is saved at its version (every day, in English) and still held: the company is switched off', async () => {
    const saved = await ok('planner', 'PUT', '/insights/digest', { enabled: true, sendTime: '07:30', weekdays: [1, 2, 3, 4, 5, 6, 7], locale: 'en', sections: ['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS'], companyId: companyA, version: 0 })
    expect(saved.setting).toMatchObject({ saved: true, enabled: true, companyId: companyA, locale: 'en', timeZone: ZONE, version: 1 })
    expect(saved.setting.enabledAt).not.toBeNull()
    expect(saved.held).toBe('MAIL_OFF')
    expect(await no('planner', 'PUT', '/insights/digest', { enabled: true, sendTime: '07:30', weekdays: [1], locale: 'en', sections: ['ALERTS'], companyId: companyA, version: 0 }, 409)).toEqual(['version'])
    expect(await no('planner', 'PUT', '/insights/digest', { enabled: true, sendTime: '25:00', weekdays: [1], locale: 'en', sections: ['ALERTS'], companyId: companyA, version: 1 }, 400)).toEqual(['body/sendTime'])
    expect(await no('planner', 'PUT', '/insights/digest', { enabled: true, sendTime: '07:30', weekdays: [1], locale: 'en', sections: ['ALERTS'], companyId: newId(), version: 1 }, 400)).toEqual(['body/companyId'])
    const event = await one(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'digest.changed' ORDER BY "occurredAt" DESC LIMIT 1`, [T])
    expect(event.payload).toMatchObject({ userId: PEOPLE.planner, enabled: true, change: 'CREATED' })
  })

  it('previews what it would say as me, in a language: yesterday’s shipped and new orders, late orders, money only with its grain', async () => {
    const italian = await ok('planner', 'GET', '/insights/digest/preview?locale=it')
    expect(italian).toMatchObject({ locale: 'it', companyId: companyA, day: yesterday(), today: today(), wouldSend: false })
    expect(italian.mail.subject).toMatch(/^Il riepilogo del mattino · /)
    const section = (answer: Json, key: string) => answer.sections.find((entry: Json) => entry.section === key)
    expect(italian.sections.map((entry: Json) => entry.section)).toEqual(['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS'])
    expect(section(italian, 'SHIPPED').items.map((item: Json) => item.label)).toContain('SEED-SH-0001')
    expect(section(italian, 'LATE').items.find((item: Json) => item.label === 'SEED-SO-0002')).toMatchObject({ days: 3 })
    expect(section(italian, 'NEW_ORDERS').items.map((item: Json) => item.label)).toContain('SEED-SO-0001')
    expect(section(italian, 'WIP_STUCK').state).toBe('READY')
    // No price grain: no value field at all, no money in the lines.
    expect(section(italian, 'NEW_ORDERS').priceValue).toBeUndefined()
    expect(italian.mail.lines.join('\n')).not.toMatch(/€/)
    expect(italian.mail.lines.join('\n')).toMatch(/SEED-SO-0002 \(3 giorni\)/)
    // The owner (price grain) gets yesterday's value from the metric layer.
    const owner = await ok('owner', 'GET', `/insights/digest/preview?locale=en&companyId=${companyA}`)
    expect(typeof section(owner, 'NEW_ORDERS').priceValue).toBe('number')
    expect(owner.mail.lines.join('\n')).toMatch(/New orders yesterday: \d+ orders?, worth €/)
    // A reader without the orders list: those sections left out, and said.
    const quality = await ok('quality', 'GET', '/insights/digest/preview?locale=en')
    expect(section(quality, 'SHIPPED').state).toBe('NO_ACCESS')
    expect(quality.mail.lines).toContain('Left out because of your rights: Shipped yesterday, Late orders, New orders.')
  })

  it('“Send me a test” is held while the company is switched off; only the owner switches it', async () => {
    expect(await no('planner', 'POST', '/insights/digest/test', {}, 409)).toEqual(['digest/MAIL_OFF'])
    expect((await call('planner', 'PUT', '/insights/digest/switch', { companyId: companyA, on: true, version: 1 })).status).toBe(403)
    const on = await ok('owner', 'PUT', '/insights/digest/switch', { companyId: companyA, on: true, version: 1 })
    expect(on.companies.find((company: Json) => company.id === companyA)).toMatchObject({ mailOn: true, switchVersion: 2 })
    expect((await one(`SELECT "digestMailOnById" FROM "InsightsSettings" WHERE key = $1`, [`insights:${companyA}`])).digestMailOnById).toBe(PEOPLE.owner)
    expect(await no('owner', 'PUT', '/insights/digest/switch', { companyId: companyA, on: false, version: 1 }, 409)).toEqual(['version'])
    const before = mailsTo('planner').length
    const sent = await ok('planner', 'POST', '/insights/digest/test', { locale: 'en' })
    expect(sent).toMatchObject({ sent: true, to: email('planner') })
    const mail = mailsTo('planner').slice(before)
    expect(mail).toHaveLength(1)
    expect(mail[0]!.templateKey).toBe('insights.digest')
    expect(textOf(mail[0]!.raw)).toMatch(/^Yesterday, .+\.$/m)
    expect(textOf(mail[0]!.raw)).toMatch(/SEED-SO-0002 \(3 days\)/)
    expect(textOf(mail[0]!.raw)).toMatch(/Figures per company, line and order, never per person\./)
    // A test never marks it sent.
    expect((await one(`SELECT "lastSentAt" FROM "DigestSetting" WHERE key = $1`, [`digest:${PEOPLE.planner}`])).lastSentAt).toBeNull()
  })

  it('goes out once a day by the scheduler (FAKE SES), and is held — never marked — while the switch is off', async () => {
    const before = mailsTo('planner').length
    const first = await runOwnerDigests({ database: h.database, log, clock: lateToday(), runtime: () => h.email })
    expect(first.failed, errors.join('\n')).toBe(0)
    expect(first.sent).toBeGreaterThanOrEqual(1)
    expect(mailsTo('planner').slice(before)).toHaveLength(1)
    const mark = await one(`SELECT "lastSentAt" FROM "DigestSetting" WHERE key = $1`, [`digest:${PEOPLE.planner}`])
    expect(mark.lastSentAt).not.toBeNull()
    expect((await one(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'digest.sent' AND payload->>'userId' = $2`, [T, PEOPLE.planner])).n).toBe(2)
    // The next tick: nothing again today.
    await runOwnerDigests({ database: h.database, log, clock: lateToday(), runtime: () => h.email })
    expect(mailsTo('planner').slice(before)).toHaveLength(1)
    // The switch off: due again (yesterday's mark), held, nothing sent or written.
    await ok('owner', 'PUT', '/insights/digest/switch', { companyId: companyA, on: false, version: 2 })
    await force(`UPDATE "DigestSetting" SET "lastSentAt" = $2 WHERE key = $1`, [`digest:${PEOPLE.planner}`, new Date(Date.now() - 86_400_000)])
    const held = await runOwnerDigests({ database: h.database, log, clock: lateToday(), runtime: () => h.email })
    expect(held.held).toBeGreaterThanOrEqual(1)
    expect(mailsTo('planner').slice(before)).toHaveLength(1)
    // The database holds the Owner's rule too, for every login.
    await expect(admin(`UPDATE "DigestSetting" SET "lastSentAt" = now() WHERE key = $1`, [`digest:${PEOPLE.planner}`])).rejects.toThrow(/goes out only while/)
  })
})

describe("Today's flow: value per stage at cost", () => {
  it('for the cost grain with costing and work orders only; counts only for everyone else', async () => {
    const owner = await ok('owner', 'GET', '/home/flow/value')
    expect(owner).toMatchObject({ lens: 'WORK_ORDERS', valued: true, currency: 'EUR', mixedCurrencies: false })
    expect(owner.stages.map((stage: Json) => stage.key)).toEqual(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED'])
    for (const stage of owner.stages as Json[]) expect(typeof stage.value).toBe('number')
    expect(await ok('planner', 'GET', '/home/flow/value')).toMatchObject({ valued: false, stages: [] })
    expect(await ok('finance', 'GET', `/home/flow/value?companyId=${companyB}`)).toMatchObject({ valued: false })
  })
})

describe('“E-mail me this” for any report (DG1:01)', () => {
  it('is made, listed, mailed as me on the scheduler’s tick, paused and stopped; a module mail and a report I cannot run are refused', async () => {
    const made = await ok('planner', 'PUT', '/reports/planning.shortages/subscription', { sendTime: '07:00', weekdays: [1, 2, 3, 4, 5, 6, 7], locale: 'it', filters: { workOrders: 'OPEN' }, active: true, version: 0 })
    expect(made.subscription).toMatchObject({ reportKey: 'planning.shortages', filters: { workOrders: 'OPEN' }, active: true, version: 1, locale: 'it' })
    expect((await ok('planner', 'GET', '/reports/subscriptions?reportKey=planning.shortages')).subscriptions).toHaveLength(1)
    expect((await ok('planner', 'GET', '/reports')).reports.find((report: Json) => report.key === 'planning.shortages').mailed).toBe(true)
    expect(await no('planner', 'PUT', '/reports/production.daily/subscription', { sendTime: '07:00', weekdays: [1], locale: 'it', filters: {}, active: true, version: 0 }, 409)).toEqual(['subscription/OWN_MAIL'])
    expect((await call('planner', 'PUT', '/reports/finance.overdue-receivables/subscription', { sendTime: '07:00', weekdays: [1], locale: 'it', filters: {}, active: true, version: 0 })).status).toBe(403)
    expect(await no('planner', 'PUT', '/reports/planning.shortages/subscription', { sendTime: '07:00', weekdays: [1], locale: 'it', filters: { colour: 'RED' }, active: true, version: 1 }, 400)).toEqual(['body/filters/colour'])
    const before = mailsTo('planner').length
    const tick = await runReportMails({ database: h.database, log, clock: lateToday(), runtime: () => h.email })
    expect(tick.failed, errors.join('\n')).toBe(0)
    const mail = mailsTo('planner').slice(before)
    expect(mail).toHaveLength(1)
    expect(mail[0]!.templateKey).toBe('insights.report')
    expect(textOf(mail[0]!.raw)).toMatch(/Mancanze, [^.\n]+ \d+ [^.\n]+\./)
    expect(textOf(mail[0]!.raw)).toMatch(/Righe trovate: \d+\./)
    expect(textOf(mail[0]!.raw)).toMatch(/Apri il report con gli stessi filtri: .*\/home\/reports\/planning\.shortages\?workOrders=OPEN/)
    await runReportMails({ database: h.database, log, clock: lateToday(), runtime: () => h.email })
    expect(mailsTo('planner').slice(before)).toHaveLength(1)
    const paused = await ok('planner', 'PUT', '/reports/planning.shortages/subscription', { sendTime: '07:00', weekdays: [1, 2, 3, 4, 5, 6, 7], locale: 'it', filters: { workOrders: 'OPEN' }, active: false, version: 1 })
    expect(paused.subscription).toMatchObject({ active: false, nextAt: null })
    expect(await no('planner', 'DELETE', '/reports/planning.shortages/subscription?version=1', undefined, 409)).toEqual(['version'])
    await ok('planner', 'DELETE', '/reports/planning.shortages/subscription?version=2')
    expect((await ok('planner', 'GET', '/reports/subscriptions?reportKey=planning.shortages')).subscriptions).toEqual([])
    const changes = (await admin(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'report_subscription.changed' ORDER BY "occurredAt", id`, [T])).map((row) => row.change)
    expect(changes).toEqual(['SUBSCRIBED', 'TURNED_OFF', 'REMOVED'])
  })
})
