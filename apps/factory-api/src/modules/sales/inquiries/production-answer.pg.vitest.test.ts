import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isoWeekKey, weekStart } from '@nexus/factory-domain/planning/settings/buckets'
import { PARTNER_LIVE_EVENTS } from '@nexus/factory-domain/portal/notifications/live'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-TH-094 (threads plan TH-9, N17, X-G04; O-SAL-INQ-LIST.list-F10 the Production column, .pane-head-F07 its chip): production's
 * answer on a request, through the app's real routes on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to
 * the sales intake (company A; P3's open request SEED-INQ-0002 asked in words; P1's SEED-INQ-0004, QUOTED). Sessions from the
 * system role templates:
 *   pm       the production manager (sales.inquiries.view + planning.promise.manage, no price grain), a person of the tenant
 *   pmP1     the same role limited to customer P1 (brand A): P3's request is never found (W27 / W30)
 *   sales    reads and keeps requests and reads promise dates, but records none: may not type the answer
 *   planner  records promise dates but does not read requests: the request is not found
 * The answer shows on the request's row, the Incoming row and the record (who answered: the record only), its every change is in
 * the request's Changes (audit) and its own office-only event; a closed request keeps it; the customer never reads it (the
 * partner role cannot read the columns; no portal live rule carries the event). Every name and word is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs inquiries/production-answer`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'PUT'

const NS = 'th094-production-answer'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const PM = newId()
const permissionsOf = (key: string) => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const office = (key: string, actorId: string = newId(), parties: 'all' | string[] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [{ permissions: permissionsOf(key), companies: 'all', sites: 'all', parties }] })
const SESSIONS: Record<string, SessionContext> = {
  pm: office('production_manager', PM),
  pmP1: office('production_manager', newId(), [P1]),
  sales: office('sales'),
  planner: office('planner'),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `i-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const seeded = async (number: string) => (await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = $2`, [T, number])).id
const version = async (id: string) => (await one<{ version: number }>('SELECT version FROM "Inquiry" WHERE id = $1', [id])).version
const answerOf = (id: string) =>
  one(`SELECT "productionAnswer"::text AS answer, "productionNotBefore"::text AS "notBefore", "productionAnsweredById" AS "byId", ("productionAnsweredAt" IS NOT NULL) AS "at" FROM "Inquiry" WHERE id = $1`, [id])
const url = (id: string) => `/sales/inquiries/${id}/production-answer`

/** A week three weeks from now (never "over" while the test runs), as the body names it, and its Monday. */
const later = weekStart(plusDays(businessDate(new Date()), 21))
const laterKey = isoWeekKey(later)
const lastWeekKey = isoWeekKey(plusDays(businessDate(new Date()), -7))

let p3Request: string
let p1Quoted: string

beforeAll(async () => {
  h = await startHarness('th094_production_answer')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  // The production manager is a person of the tenant: the record names who answered.
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id: PM, email: `pia.production.${run}@th094.example.com`, displayName: 'Pia Production', locale: 'en', status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
  })
  p3Request = await seeded('SEED-INQ-0002')
  p1Quoted = await seeded('SEED-INQ-0004')
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('production answers a request (B-TH-094)', () => {
  it('the templates: the production manager reads requests and records promise dates; sales records none; the planner reads no request', () => {
    expect(permissionsOf('production_manager')).toEqual(expect.arrayContaining(['sales.inquiries.view', 'planning.promise.manage']))
    expect(permissionsOf('sales')).not.toContain('planning.promise.manage')
    expect(permissionsOf('planner')).toContain('planning.promise.manage')
    expect(permissionsOf('planner')).not.toContain('sales.inquiries.view')
  })

  it('the production manager types "not before week N": the record names him, the row and the Incoming row show the chip without a name', async () => {
    const before = (await ok('pm', 'GET', `/sales/inquiries/${p3Request}`)).inquiry
    expect(before.production).toBeNull()
    expect(before.productionAction).toEqual({ allowed: true, refusal: null })
    const { inquiry } = await ok('pm', 'PUT', url(p3Request), { version: before.version, answer: 'NOT_BEFORE', week: laterKey })
    expect(inquiry.production).toMatchObject({ answer: 'NOT_BEFORE', notBefore: later, week: laterKey, weekNumber: Number(laterKey.slice(-2)), tone: 'WARNING', answeredBy: { id: PM, name: 'Pia Production' } })
    expect(inquiry.production.words.en).toMatch(/^Production: not before week \d+/)
    expect(inquiry.production.words.it).toMatch(/^Produzione: non prima della settimana \d+/)
    expect(inquiry.version).toBe(before.version + 1)
    expect(await answerOf(p3Request)).toEqual({ answer: 'NOT_BEFORE', notBefore: later, byId: PM, at: true })

    const row = (await ok('pm', 'GET', '/sales/inquiries?tile=ALL')).rows.find((entry: Json) => entry.id === p3Request)
    expect(row.production).toMatchObject({ answer: 'NOT_BEFORE', week: laterKey, tone: 'WARNING' })
    expect('answeredBy' in row.production).toBe(false)
    const incoming = (await ok('pm', 'GET', '/sales/incoming?tile=ALL')).rows.find((entry: Json) => entry.kind === 'REQUEST' && entry.id === p3Request)
    expect(incoming.request.production).toMatchObject({ answer: 'NOT_BEFORE', week: laterKey })
    // Sales reads the same answer on the request it keeps.
    expect((await ok('sales', 'GET', `/sales/inquiries/${p3Request}`)).inquiry.production).toMatchObject({ answer: 'NOT_BEFORE', answeredBy: { name: 'Pia Production' } })
  })

  it('changes it to OK and takes it back; each change is in the request\'s Changes and its own office event', async () => {
    const changed = (await ok('pm', 'PUT', url(p3Request), { version: await version(p3Request), answer: 'OK' })).inquiry
    expect(changed.production).toMatchObject({ answer: 'OK', notBefore: null, week: null, tone: 'POSITIVE', words: { en: 'Production: OK', it: 'Produzione: OK' } })
    const taken = (await ok('pm', 'PUT', url(p3Request), { version: await version(p3Request), answer: null })).inquiry
    expect(taken.production).toBeNull()
    expect(await answerOf(p3Request)).toEqual({ answer: null, notBefore: null, byId: null, at: false })
    // Nothing left to take back.
    const again = await call('pm', 'PUT', url(p3Request), { version: await version(p3Request), answer: null })
    expect(again.statusCode, again.body).toBe(409)
    expect(again.json().error.issues).toEqual([{ path: 'refusal/NO_ANSWER', message: expect.stringMatching(/nothing to take back/) }])

    const audit = await admin(`SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action LIKE 'sales.inquiries.productionAnswer%' ORDER BY at, id`, [p3Request])
    expect(audit.map((entry) => entry.action)).toEqual(['sales.inquiries.productionAnswer', 'sales.inquiries.productionAnswer', 'sales.inquiries.productionAnswerTakenBack'])
    expect(audit[0]!.after).toEqual({ productionAnswer: 'NOT_BEFORE', productionNotBefore: later })
    expect(audit[1]!.before).toEqual({ productionAnswer: 'NOT_BEFORE', productionNotBefore: later })
    expect(audit[2]!.after).toEqual({ productionAnswer: null, productionNotBefore: null })

    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND subject = $2 AND type = 'inquiry.production_answered' ORDER BY "occurredAt", id`, [T, p3Request])
    expect(events.map((event) => event.payload)).toEqual([
      { inquiryId: p3Request, number: 'SEED-INQ-0002', answer: 'NOT_BEFORE', notBefore: later, partyId: P3 },
      { inquiryId: p3Request, number: 'SEED-INQ-0002', answer: 'OK', notBefore: null, partyId: P3 },
      { inquiryId: p3Request, number: 'SEED-INQ-0002', answer: null, notBefore: null, partyId: P3 },
    ])
    // The answer is never an inquiry.changed (which the customer's portal session receives as a refresh).
    expect((await admin(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND subject = $2 AND type IN ('inquiry.changed', 'inquiry.closed')`, [T, p3Request])).map((event) => event.type)).toEqual([])
  })

  it('refuses in words: a stale version, a week missing, over or with OK, a closed request', async () => {
    const current = await version(p3Request)
    expect((await call('pm', 'PUT', url(p3Request), { version: current - 1, answer: 'OK' })).statusCode).toBe(409)
    const noWeek = await call('pm', 'PUT', url(p3Request), { version: current, answer: 'NOT_BEFORE' })
    expect(noWeek.statusCode).toBe(400)
    expect(noWeek.json().error.issues).toEqual([{ path: 'body/week', message: expect.stringMatching(/Name the week/) }])
    const over = await call('pm', 'PUT', url(p3Request), { version: current, answer: 'NOT_BEFORE', week: lastWeekKey })
    expect(over.statusCode).toBe(400)
    expect(over.json().error.message).toMatch(/That week is over/)
    expect((await call('pm', 'PUT', url(p3Request), { version: current, answer: 'OK', week: laterKey })).statusCode).toBe(400)
    expect((await call('pm', 'PUT', url(p3Request), { version: current, answer: 'NOT_BEFORE', week: '2026-14' })).statusCode).toBe(400)
    // P1's request became a quote: closed, it keeps the answer it had (none).
    const closed = await call('pm', 'PUT', url(p1Quoted), { version: await version(p1Quoted), answer: 'OK' })
    expect(closed.statusCode, closed.body).toBe(409)
    expect(closed.json().error.issues).toEqual([{ path: 'refusal/CLOSED', message: expect.stringMatching(/SEED-INQ-0004 is quoted/) }])
    expect((await ok('pm', 'GET', `/sales/inquiries/${p1Quoted}`)).inquiry.productionAction).toMatchObject({ allowed: false, refusal: { code: 'CLOSED' } })
    expect(await answerOf(p1Quoted)).toEqual({ answer: null, notBefore: null, byId: null, at: false })
  })

  it('who: sales may not type it (said); the planner does not find the request; a person limited to brand A never finds brand B\'s', async () => {
    const current = await version(p3Request)
    const bySales = await call('sales', 'PUT', url(p3Request), { version: current, answer: 'OK' })
    expect(bySales.statusCode, bySales.body).toBe(403)
    expect(bySales.json().error.message).toMatch(/planning or the production manager/)
    expect((await ok('sales', 'GET', `/sales/inquiries/${p3Request}`)).inquiry.productionAction).toMatchObject({ allowed: false, refusal: { code: 'NOT_PRODUCTION', words: { it: expect.any(String), en: expect.any(String) } } })
    expect((await call('planner', 'PUT', url(p3Request), { version: current, answer: 'OK' })).statusCode).toBe(404)
    // W27 / W30: the same role limited to P1 neither finds nor answers P3's request, nor lists its answer.
    expect((await call('pmP1', 'GET', `/sales/inquiries/${p3Request}`)).statusCode).toBe(404)
    expect((await call('pmP1', 'PUT', url(p3Request), { version: current, answer: 'OK' })).statusCode).toBe(404)
    expect((await call('pmP1', 'GET', `${url(p3Request)}/suggestion`)).statusCode).toBe(404)
    expect((await ok('pmP1', 'GET', '/sales/inquiries?tile=ALL')).rows.map((row: Json) => row.id)).not.toContain(p3Request)
    expect(await version(p3Request)).toBe(current)
  })

  it('the customer never reads it: no partner column, no portal live rule', async () => {
    await ok('pm', 'PUT', url(p3Request), { version: await version(p3Request), answer: 'NOT_BEFORE', week: laterKey })
    // P3's own portal role reads its request, never production's answer (the column grants of ownership/sales-intake.json).
    const own = await h.database.withScope({ audience: 'partner', tenantId: T, actorId: newId(), partyId: P3 }, (client) => client.inquiry.findMany({ where: { id: p3Request }, select: { id: true, status: true } }))
    expect(own).toEqual([{ id: p3Request, status: 'ASSIGNED' }])
    for (const column of ['productionAnswer', 'productionNotBefore', 'productionAnsweredAt', 'productionAnsweredById'] as const) {
      await expect(h.database.withScope({ audience: 'partner', tenantId: T, actorId: newId(), partyId: P3 }, (client) => client.inquiry.findMany({ where: { id: p3Request }, select: { id: true, [column]: true } }))).rejects.toThrow(/permission denied/)
    }
    // Another customer does not even find the request.
    expect(await h.database.withScope({ audience: 'partner', tenantId: T, actorId: newId(), partyId: P1 }, (client) => client.inquiry.findMany({ where: { id: p3Request }, select: { id: true } }))).toEqual([])
    expect(Object.keys(PARTNER_LIVE_EVENTS)).not.toContain('inquiry.production_answered')
  })

  it('planning\'s suggestion: a request asked in words cannot be dated — said per line, nothing written', async () => {
    const site = await one<{ id: string }>(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'PLANT' AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [T, companyA])
    const before = await version(p3Request)
    const answer = await ok('pm', 'GET', `${url(p3Request)}/suggestion?siteId=${site.id}`)
    expect(answer).toMatchObject({
      inquiry: { id: p3Request, number: 'SEED-INQ-0002', version: before },
      site: { id: site.id },
      suggestion: { answer: null, notBefore: null, week: null, readyDate: null, partial: true, words: { en: expect.stringMatching(/answer it yourself/) } },
      lines: [],
      leftOut: [{ seq: 10, why: { en: expect.stringMatching(/^Asked in words/), it: expect.any(String) } }],
      current: { answer: 'NOT_BEFORE', week: laterKey, answeredBy: { name: 'Pia Production' } },
    })
    expect(await version(p3Request)).toBe(before)
    // Sales reads promise dates too (it asks "when?" on every quote): it may read the suggestion, not type the answer.
    expect((await ok('sales', 'GET', `${url(p3Request)}/suggestion?siteId=${site.id}`)).suggestion.answer).toBeNull()
    expect((await call('planner', 'GET', `${url(p3Request)}/suggestion?siteId=${site.id}`)).statusCode).toBe(404)
  })
})
