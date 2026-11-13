import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { runFittingReminders } from './reminders'

/**
 * Fittings, alterations and remakes (B-W2b-360; SAL-054, SAL-297, SAL-353) on the local stack, through the app's real routes: a
 * throwaway PostgreSQL 17 database with every factory-db seed (the JACKET template, OFF as built; SEED-JKT-01 flagged made to
 * measure; the private rider SEED-R1 with its contact; company A's mail identity and its one plant), FAKE files and mail (the
 * harness), and office people holding their role templates (sales, the production manager, the administrator, the owner,
 * read-only). Test data past its guards, named where it is: SEED-JKT-01's brand cleared (the private rider may order it), the
 * quote's version accepted, an appointment's times moved into the past (a fitting that took place), one appointment booked
 * three days ago (its reminder is due), and a returned unit received and graded (an RMA copied from the seed's SEED-RMA-0002:
 * no made-to-measure unit ships while W1's work orders refuse one). Every name, number and address is made up; every time is
 * relative to now (no test depends on today's date). Run with `node scripts/factory/run-pg-tests.mjs modules/sales/fittings/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'fittings-360'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const companyA = sid('company:A')

const PEOPLE = { sales: newId(), pm: newId(), admin: newId(), owner: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', pm: 'production_manager', admin: 'admin', owner: 'owner', reader: 'read_only' }
const SESSIONS: Record<string, SessionContext> = {}
const grantsOf = (role: string): Grant[] => {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
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
const call = (person: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `w2b360-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(person: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(person: Person, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Log
/** The calendar object a FAKE mail carries (its base64 attachment), or ''. */
const icsOf = (raw: string): string => {
  const part = /Content-Type: text\/calendar; name="[^"]+"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: [^\r\n]+\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw)?.[1] ?? ''
  return Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8')
}

const S = { r1: '', contact: '', jacket: '', jkt01: '', blk: '' }
const RIDER = 'Made-up rider 360'
const values = { chest: '100', waist: '84', sleeve: '64', height: '178' }
let rev1 = ''
let rev2 = ''

beforeAll(async () => {
  h = await startHarness('fittings_w2b360')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (sales.fittings.manage for sales, the production manager and the administrator).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b360-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  S.r1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R1'`, [T])).id
  S.contact = (await one<{ id: string }>(`SELECT id FROM "PartyContact" WHERE "partyId" = $1 AND email IS NOT NULL ORDER BY "createdAt", id LIMIT 1`, [S.r1])).id
  S.jacket = (await one<{ id: string }>(`SELECT id FROM "MeasurementTemplate" WHERE "tenantId" = $1 AND code = 'JACKET'`, [T])).id
  S.jkt01 = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [T])).id
  S.blk = (await one<{ id: string }>(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [S.jkt01])).id
  // Test data past its guards: SEED-JKT-01 has no brand here, so the private rider may order it (B-W2b-294's private label).
  await force(`UPDATE "Style" SET "brandPartyId" = NULL WHERE id = $1`, [S.jkt01])
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The JACKET template measures the height too (the certificate's made-to-measure route asks it, B-W2b-358's notes).
  const template = (await ok('owner', 'GET', `/product/measurement-templates/${S.jacket}`)).template
  await ok('owner', 'PUT', `/product/measurement-templates/${S.jacket}/points`, {
    version: template.version,
    points: [
      { code: 'chest', name: 'Chest', minValue: '70', maxValue: '150' },
      { code: 'waist', name: 'Waist', minValue: '60', maxValue: '140' },
      { code: 'sleeve', name: 'Sleeve', minValue: '50', maxValue: '80' },
      { code: 'height', name: 'Height', minValue: '140', maxValue: '210', required: false },
    ],
  })
  rev1 = (await ok('sales', 'POST', '/sales/mtm/profiles', { partyId: S.r1, contactId: S.contact, riderName: RIDER, garmentType: 'JACKET', measurements: values, takenAt: at(-24), measuredByUserId: PEOPLE.sales, measuredPlace: 'Made-up showroom', privacyNoticeRef: 'Made-up notice v1', privacyNoticeAt: at(-48) }, 201)).profile.id
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const appointmentOf = async (id: string) => (await ok('sales', 'GET', `/sales/fittings/appointments/${id}`)).appointment
const book = (body: Json, person: Person = 'sales', status = 201) => ok(person, 'POST', '/sales/fittings/appointments', { companyId: companyA, partyId: S.r1, place: 'Made-up showroom', ...body }, status)
let fitting = ''

describe('appointments with the invite and the reminder (SAL-054)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('REFUSES a booking while made-to-measure has not started for JACKET; the Owner starts it, the factory confirms the measures', async () => {
    const refused = await no('sales', 'POST', '/sales/fittings/appointments', { companyId: companyA, partyId: S.r1, kind: 'FITTING', measurementProfileId: rev1, startsAt: at(72), endsAt: at(73), place: 'Made-up showroom', withUserId: PEOPLE.sales }, 409)
    expect(refused.message).toBe('Made-to-measure has not started for measurement template JACKET: its rules stay off until the Owner starts them (GATE-MTM).')
    const rules = (await ok('owner', 'GET', `/product/measurement-templates/${S.jacket}/mtm-rules`)).rules
    await ok('owner', 'PUT', `/product/measurement-templates/${S.jacket}/mtm-rules/switch`, { version: rules.template.version, on: true, reason: 'Made-up first made-to-measure order.' })
    await ok('pm', 'POST', `/sales/mtm/profiles/${rev1}/review`, { decision: 'CONFIRM' })
  })

  it('books a fitting with the fitter of ours and mails the rider the invite with the .ics (FAKE); refuses what the database would', async () => {
    const booked = await book({ kind: 'FITTING', measurementProfileId: rev1, startsAt: at(72), endsAt: at(73), withUserId: PEOPLE.sales, notes: 'Bring the back protector.', language: 'en' })
    fitting = booked.appointment.id
    expect(booked).toMatchObject({ mailed: true, delivery: 'SENT', warnings: [] })
    expect(booked.appointment).toMatchObject({ kind: 'FITTING', status: 'BOOKED', rider: { contactId: S.contact, name: RIDER }, profile: { id: rev1, revision: 1, garmentType: 'JACKET' }, with: { userId: PEOPLE.sales, name: 'Made-up sales' }, mailTo: true, version: 1, may: { move: true, close: false, cancel: true, invite: true, result: false } })
    expect(booked.appointment.mails).toMatchObject([{ mail: 'INVITE', status: 'SENT' }])
    const mail = await one(`SELECT "templateKey", "recordType", status::text, subject FROM "EmailOutbound" WHERE "tenantId" = $1 AND "recordId" = $2`, [T, fitting])
    expect(mail).toMatchObject({ templateKey: 'fittings.invite', recordType: 'Appointment', status: 'SENT' })
    expect(mail.subject).toMatch(/^Appointment: fitting /)
    const ics = icsOf(h.ses.mails.at(-1)!.raw)
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain(`UID:appointment-${fitting}@`)
    expect(ics).toContain('SEQUENCE:1')
    expect((await outbox('appointment.booked')).at(-1)).toMatchObject({ appointmentId: fitting, partyId: S.r1, kind: 'FITTING', profileId: rev1 })
    expect((await outbox('appointment.mailed')).at(-1)).toMatchObject({ appointmentId: fitting, mail: 'INVITE' })
    // The same fitter at the same time: a warning, never a refusal.
    const twice = await book({ kind: 'FITTING', measurementProfileId: rev1, startsAt: at(72.5), endsAt: at(73.5), withUserId: PEOPLE.sales, invite: false })
    expect(twice.warnings.map((warning: Json) => warning.path)).toEqual(['body/withUserId'])
    await ok('sales', 'POST', `/sales/fittings/appointments/${twice.appointment.id}/cancel`, { version: 1, reason: 'Booked twice by mistake.' })
    expect(paths(await no('sales', 'POST', '/sales/fittings/appointments', { companyId: companyA, partyId: S.r1, kind: 'FITTING', startsAt: at(72), endsAt: at(73), place: 'Made-up showroom' }, 400))).toEqual(['body/measurementProfileId'])
    expect(paths(await no('sales', 'POST', '/sales/fittings/appointments', { companyId: companyA, partyId: S.r1, kind: 'MEASURING', startsAt: at(72), endsAt: at(73), place: 'Made-up showroom' }, 400))).toEqual(['body/garmentType'])
    expect(paths(await no('sales', 'POST', '/sales/fittings/appointments', { companyId: companyA, partyId: S.r1, kind: 'SHOWROOM', garmentType: 'JACKET', startsAt: at(-3), endsAt: at(-2), place: 'Made-up showroom' }, 400))).toEqual(['body/startsAt'])
    await no('reader', 'GET', `/sales/fittings/appointments/${fitting}`, undefined, 403)
    const list = await ok('sales', 'GET', `/sales/fittings/appointments?profileId=${rev1}`)
    expect(list.rows.map((row: Json) => row.id)).toContain(fitting)
  })

  it('moves the fitting an hour later: the update mailed with the next sequence; an old version is refused', async () => {
    const moved = await ok('sales', 'PATCH', `/sales/fittings/appointments/${fitting}`, { version: 1, startsAt: at(73), endsAt: at(74) })
    expect(moved).toMatchObject({ mailed: true, delivery: 'SENT', appointment: { version: 2, reminderSentAt: null } })
    expect(moved.appointment.mails.map((mail: Json) => mail.mail)).toEqual(['INVITE', 'UPDATE'])
    expect(icsOf(h.ses.mails.at(-1)!.raw)).toContain('SEQUENCE:2')
    expect((await outbox('appointment.changed')).at(-1)).toEqual({ appointmentId: fitting, partyId: S.r1, fields: ['startsAt', 'endsAt'] })
    await no('sales', 'PATCH', `/sales/fittings/appointments/${fitting}`, { version: 1, place: 'Made-up paddock' }, 409)
  })

  it('reminds the rider once, the day before, of a visit booked days ago (the hourly cron); not twice', async () => {
    const visit = (await book({ kind: 'SHOWROOM', garmentType: 'JACKET', contactId: S.contact, startsAt: at(20), endsAt: at(21), invite: false })).appointment
    expect(visit).toMatchObject({ garmentType: 'JACKET', profile: null, inviteSentAt: null })
    // Test data past its guards: booked three days ago.
    await force(`UPDATE "Appointment" SET "createdAt" = now() - interval '3 days' WHERE id = $1`, [visit.id])
    const first = await runFittingReminders({ database: h.database, log: silent })
    expect(first.reminded).toBeGreaterThanOrEqual(1)
    const reminded = await one(`SELECT "reminderSentAt", version FROM "Appointment" WHERE id = $1`, [visit.id])
    expect(reminded.reminderSentAt).not.toBeNull()
    expect(await one(`SELECT "templateKey", status::text FROM "EmailOutbound" WHERE "recordId" = $1`, [visit.id])).toEqual({ templateKey: 'fittings.reminder', status: 'SENT' })
    expect((await outbox('appointment.mailed')).filter((row) => row.appointmentId === visit.id).map((row) => row.mail)).toEqual(['REMINDER'])
    await runFittingReminders({ database: h.database, log: silent })
    expect((await one(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "recordId" = $1`, [visit.id])).n).toBe(1)
  })

  it('closes a fitting done once it took place, only its notes change after; cancels an invited one and tells the rider', async () => {
    expect((await no('sales', 'POST', `/sales/fittings/appointments/${fitting}/close`, { version: 2, status: 'MISSED' }, 409)).message).toContain('has not started yet')
    // Test data past its guards: the fitting took place two hours ago.
    await force(`UPDATE "Appointment" SET "startsAt" = now() - interval '2 hours', "endsAt" = now() - interval '1 hour' WHERE id = $1`, [fitting])
    const done = await ok('sales', 'POST', `/sales/fittings/appointments/${fitting}/close`, { version: 2, status: 'DONE' })
    expect(done.appointment).toMatchObject({ status: 'DONE', closedBy: { id: PEOPLE.sales }, may: { move: false, result: true, notes: true } })
    expect((await no('sales', 'PATCH', `/sales/fittings/appointments/${fitting}`, { version: 3, place: 'Made-up paddock' }, 409)).message).toContain('only its notes change')
    expect((await ok('sales', 'PATCH', `/sales/fittings/appointments/${fitting}`, { version: 3, notes: 'Sleeves too long; chest tight.' })).appointment.notes).toBe('Sleeves too long; chest tight.')
    const next = (await book({ kind: 'FITTING', measurementProfileId: rev1, startsAt: at(120), endsAt: at(121), withName: 'Made-up dealer fitter', place: 'Made-up dealer shop' })).appointment
    const cancelled = await ok('sales', 'POST', `/sales/fittings/appointments/${next.id}/cancel`, { version: next.version, reason: 'The rider races that weekend.' })
    expect(cancelled).toMatchObject({ mailed: true, delivery: 'SENT', appointment: { status: 'CANCELLED', cancelReason: 'The rider races that weekend.' } })
    const raw = h.ses.mails.at(-1)!.raw
    expect(icsOf(raw)).toContain('METHOD:CANCEL')
    expect(icsOf(raw)).toContain('STATUS:CANCELLED')
    expect(icsOf(raw)).not.toContain('races')
    expect((await outbox('appointment.closed')).filter((row) => row.appointmentId === next.id)).toEqual([{ appointmentId: next.id, partyId: S.r1, kind: 'FITTING', status: 'CANCELLED' }])
  })

  it('a done measuring session names the revision it led to, once', async () => {
    const session = (await book({ kind: 'MEASURING', garmentType: 'JACKET', contactId: S.contact, startsAt: at(48), endsAt: at(49), invite: false })).appointment
    await force(`UPDATE "Appointment" SET "startsAt" = now() - interval '3 hours', "endsAt" = now() - interval '2 hours' WHERE id = $1`, [session.id])
    const done = (await ok('sales', 'POST', `/sales/fittings/appointments/${session.id}/close`, { version: session.version, status: 'DONE', withName: 'Made-up dealer fitter' })).appointment
    expect(done.may.ledTo).toBe(true)
    const led = (await ok('sales', 'POST', `/sales/fittings/appointments/${session.id}/led-to`, { version: done.version, profileId: rev1 })).appointment
    expect(led).toMatchObject({ profile: { id: rev1 }, may: { ledTo: false } })
    await no('sales', 'POST', `/sales/fittings/appointments/${session.id}/led-to`, { version: led.version, profileId: rev1 }, 409)
  })
})

let orderId = ''
let unitLine = ''
let alterResult = ''
let promised = ''

describe('the fitting result and the alteration loop (SAL-297)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('makes the unit’s order (B-W2b-358) and its promise', async () => {
    const quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: S.r1 }, 201)).quote
    await ok('sales', 'POST', `/sales/quotes/${quote.id}/lines/made-to-measure`, { version: quote.version, styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: rev1, unitPrice: '610' }, 201)
    const version = await one<{ id: string }>(`SELECT id FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1`, [quote.id])
    const accepted = await one<{ billTo: Json; shipTo: Json }>(`SELECT v."billTo", v."shipTo" FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0001'`, [T])
    // Test data past its guards: the version accepted (the customer's yes is B-W1-24's link).
    await force(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "billTo" = $2, "shipTo" = $3 WHERE id = $1`, [version.id, accepted.billTo, accepted.shipTo])
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [quote.id])
    orderId = (await ok('sales', 'POST', '/sales/orders', { quoteVersionId: version.id, customerRef: 'PO-360-1' }, 201)).order.id
    expect((await one(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [orderId])).status).toBe('CONFIRMED')
    unitLine = (await one<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 AND kind = 'MADE_TO_MEASURE'`, [orderId])).id
    promised = addDays(businessDate(new Date()), 30)
    const order = await one<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [orderId])
    await ok('sales', 'PUT', `/sales/orders/${orderId}/promise`, { version: order.version, promiseDate: promised, reason: 'Made-up first promise.' })
  })

  it('records what the fitting found per point (ALTER, 5 days); refuses changes the revision cannot take', async () => {
    const body = { appointmentId: fitting, salesOrderLineId: unitLine, verdict: 'ALTER', pointChanges: { chest: { change: '2.0' }, sleeve: { change: '-1.0', note: 'Shorter by a finger' } }, alterationDays: 5 }
    expect(paths(await no('sales', 'POST', '/sales/fittings/results', { ...body, pointChanges: { neck: { change: '+1' }, chest: { change: '0' } } }, 400))).toEqual(['body/pointChanges/neck', 'body/pointChanges/chest/change'])
    expect(paths(await no('sales', 'POST', '/sales/fittings/results', { ...body, verdict: 'OK', alterationDays: null }, 400))).toEqual(['body/pointChanges'])
    await no('reader', 'POST', '/sales/fittings/results', body, 403)
    const recorded = await ok('sales', 'POST', '/sales/fittings/results', body, 201)
    alterResult = recorded.result.id
    expect(recorded).toMatchObject({ appointmentClosed: false, result: { verdict: 'ALTER', alterationDays: 5, profile: { id: rev1, revision: 1 }, orderLine: { id: unitLine }, appointment: { id: fitting, status: 'DONE' }, alteration: null, promise: { current: promised, byAlteration: addDays(promised, 5) }, may: { alteration: true, revision: true } } })
    expect(recorded.result.pointChanges).toEqual([
      { code: 'chest', name: 'Chest', change: '+2.0', unit: 'cm', note: null },
      { code: 'sleeve', name: 'Sleeve', change: '-1.0', unit: 'cm', note: 'Shorter by a finger' },
    ])
    expect(recorded.result.next).toContain('Open the alteration')
    expect((await outbox('fitting_result.recorded')).at(-1)).toEqual({ resultId: alterResult, partyId: S.r1, profileId: rev1, verdict: 'ALTER', appointmentId: fitting, salesOrderLineId: unitLine })
    expect((await no('sales', 'POST', '/sales/fittings/results', body, 409)).message).toContain('has a result for this unit already')
  })

  it('opens the alteration through W2a’s repair command and moves the unit’s promise by its days, in one command', async () => {
    const opened = await ok('sales', 'POST', `/sales/fittings/results/${alterResult}/alteration`, { version: 1 }, 201)
    expect(opened.repair).toMatchObject({ stage: 'AWAITING_GOODS' })
    expect(opened.promise).toEqual({ moved: true, from: promised, to: addDays(promised, 5), why: null })
    expect(opened.result).toMatchObject({ alteration: { id: opened.repair.id }, version: 2, may: { alteration: false } })
    const repair = await one(`SELECT kind::text, "partyId", "workWanted", "styleId" FROM "RepairOrder" WHERE id = $1`, [opened.repair.id])
    expect(repair).toMatchObject({ kind: 'ALTERATION', partyId: S.r1, styleId: S.jkt01 })
    expect(repair.workWanted).toBe('Chest +2.0 cm; Sleeve -1.0 cm (Shorter by a finger)')
    expect((await one(`SELECT "promiseDate"::text AS d FROM "SalesOrderLine" WHERE id = $1`, [unitLine])).d).toBe(addDays(promised, 5))
    expect((await admin(`SELECT kind::text FROM "PromiseRecord" WHERE "salesOrderLineId" = $1 ORDER BY "promisedAt", id`, [unitLine])).map((row) => row.kind)).toContain('RE_PROMISE')
    expect((await outbox('fitting_result.linked')).at(-1)).toEqual({ resultId: alterResult, partyId: S.r1, alterationRepairId: opened.repair.id, newProfileId: null })
    expect((await no('sales', 'POST', `/sales/fittings/results/${alterResult}/alteration`, { version: 2 }, 409)).message).toBe('This fitting opened its alteration already.')
  })

  it('names the new revision the fitting led to (recorded by B-W2b-358), once; a REMAKE result on the order line says why', async () => {
    rev2 = (await ok('admin', 'POST', `/sales/mtm/profiles/${rev1}/revisions`, { measurements: { ...values, chest: '102', sleeve: '63' }, takenAt: at(-0.5), measuredByUserId: PEOPLE.admin, measuredPlace: 'Made-up showroom' }, 201)).profile.id
    expect(paths(await no('sales', 'POST', `/sales/fittings/results/${alterResult}/revision`, { version: 2, profileId: rev1 }, 400))).toEqual(['body/profileId'])
    const named = await ok('sales', 'POST', `/sales/fittings/results/${alterResult}/revision`, { version: 2, profileId: rev2 })
    expect(named.result).toMatchObject({ newProfile: { id: rev2, revision: 2, review: 'WAITING' }, may: { revision: false } })
    await no('sales', 'POST', `/sales/fittings/results/${alterResult}/revision`, { version: 3, profileId: rev2 }, 409)
    expect(paths(await no('sales', 'POST', '/sales/fittings/results', { salesOrderLineId: unitLine, verdict: 'REMAKE' }, 400))).toEqual(['body/notes'])
    const remake = await ok('sales', 'POST', '/sales/fittings/results', { salesOrderLineId: unitLine, verdict: 'REMAKE', notes: 'The back panel cannot be let out enough.' }, 201)
    expect(remake.result).toMatchObject({ verdict: 'REMAKE', appointment: null, next: expect.stringContaining('Measure the rider again') })
    const tab = (await ok('sales', 'GET', `/sales/mtm/profiles/${rev2}/fittings`)).fittings
    expect(tab).toMatchObject({ riderName: RIDER, garmentType: 'JACKET', started: true, may: { book: true, record: true } })
    expect(tab.results.map((result: Json) => result.verdict)).toEqual(['REMAKE', 'ALTER'])
    expect(tab.appointments.map((row: Json) => row.id)).toContain(fitting)
  })
})

const rma = sid('rma:360')
const rmaLine = sid('rma-line:360')

describe('the remake order of a returned unit (SAL-353)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('decides REMAKE only for a made-to-measure unit, its goods never back into stock', async () => {
    // Test data past its guards: the unit came back, received and graded (SEED-RMA-0002's row copied; no unit ships while W1's
    // work orders refuse one).
    await force(
      `INSERT INTO "ReturnAuthorisation" SELECT (jsonb_populate_record(NULL::"ReturnAuthorisation", to_jsonb(r) || $2::jsonb)).* FROM "ReturnAuthorisation" r WHERE r."tenantId" = $1 AND r.number = 'SEED-RMA-0002'`,
      [T, JSON.stringify({ id: rma, number: 'RMA-360-0001', partyId: S.r1, contactId: null, salesOrderId: null, status: 'RECEIVED', inspectedAt: null, replacementOrderId: null, closedAt: null, statusReason: null, finishReason: null, scanCode: null, policyId: null, withdrawal: false, version: 1 })],
    )
    await force(
      `INSERT INTO "ReturnLine" SELECT (jsonb_populate_record(NULL::"ReturnLine", to_jsonb(l) || $2::jsonb)).* FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r.id = l."returnId" WHERE r."tenantId" = $1 AND r.number = 'SEED-RMA-0002' ORDER BY l.seq LIMIT 1`,
      [T, JSON.stringify({ id: rmaLine, returnId: rma, partyId: S.r1, seq: 10, salesOrderLineId: unitLine, size: null, invoiceLineId: null, description: 'Made-up made-to-measure jacket', serial: null, batchNumber: null, quantity: 1, receivedQuantity: 1, receiptId: null, grade: 'DAMAGED', cause: 'NO_FAULT', disposition: null, goodsOutcome: null, decidedAt: null, decidedById: null, replacementLineId: null, garmentSerial: null, garmentBatch: null, parentLineId: null, creditWithoutReturn: false, exchangeSize: null, feeRuleId: null, feeAmount: null, creditAmount: 0, version: 1 })],
    )
    const preview = await ok('sales', 'POST', `/sales/returns/${rma}/decisions/preview`, { lines: [{ lineId: rmaLine, disposition: 'REMAKE' }] })
    expect(preview).toMatchObject({ ok: true, lines: [{ disposition: 'REMAKE', goodsOutcome: 'SCRAP', problems: [] }] })
    const restock = await ok('sales', 'POST', `/sales/returns/${rma}/decisions/preview`, { lines: [{ lineId: rmaLine, disposition: 'REMAKE', goodsOutcome: 'RESTOCK' }] })
    expect(restock.problems.map((problem: Json) => problem.message)).toContain('A remade unit was made to a body: it is scrapped or held in quarantine, never put back into stock.')
    const seeded = await one<{ id: string; lineId: string }>(`SELECT r.id, l.id AS "lineId" FROM "ReturnAuthorisation" r JOIN "ReturnLine" l ON l."returnId" = r.id WHERE r."tenantId" = $1 AND r.number = 'SEED-RMA-0002' ORDER BY l.seq LIMIT 1`, [T])
    const notUnit = await ok('sales', 'POST', `/sales/returns/${seeded.id}/decisions/preview`, { lines: [{ lineId: seeded.lineId, disposition: 'REMAKE' }] })
    expect(notUnit.problems.map((problem: Json) => problem.message)).toContain('Line 10 is not a made-to-measure unit: a remake is for made-to-measure units (replace it instead).')
    const version = (await one<{ version: number }>(`SELECT version FROM "ReturnAuthorisation" WHERE id = $1`, [rma])).version
    await ok('sales', 'POST', `/sales/returns/${rma}/decisions`, { version, lines: [{ lineId: rmaLine, disposition: 'REMAKE' }] })
    expect(await one(`SELECT disposition::text, "goodsOutcome"::text FROM "ReturnLine" WHERE id = $1`, [rmaLine])).toEqual({ disposition: 'REMAKE', goodsOutcome: 'SCRAP' })
    expect((await one(`SELECT status::text FROM "ReturnAuthorisation" WHERE id = $1`, [rma])).status).toBe('INSPECTED')
  })

  it('makes the remake on the rider’s newest revision: the order waits for the factory review, which lets it go on', async () => {
    const before = (await ok('sales', 'GET', `/sales/returns/${rma}/remake-order`)).remake
    expect(before).toMatchObject({ may: { order: true }, outcomes: ['SCRAP', 'QUARANTINE'] })
    expect(before.lines[0]).toMatchObject({ lineId: rmaLine, held: null, remakeOrder: null, unit: { orderLineId: unitLine, madeTo: { id: rev1, revision: 1 }, newest: { id: rev2, revision: 2, review: 'WAITING' }, started: true } })
    const other = sid('measurement:P1:rider:JACKET:1')
    expect(paths(await no('sales', 'POST', `/sales/returns/${rma}/remake-order`, { version: before.version, lines: [{ lineId: rmaLine, profileId: other }] }, 400))).toEqual(['body/lines/0/profileId'])
    await no('reader', 'POST', `/sales/returns/${rma}/remake-order`, { version: before.version }, 403)
    const made = await ok('sales', 'POST', `/sales/returns/${rma}/remake-order`, { version: before.version }, 201)
    expect(made.order).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(made.remake.lines[0].remakeOrder).toMatchObject({ orderId: made.order.id, number: made.order.number, profileId: rev2, status: 'PENDING_APPROVAL' })
    const line = await one(`SELECT kind::text, "measurementProfileId", "baseSize", quantity, "unitPrice"::text AS price, description FROM "SalesOrderLine" WHERE "orderId" = $1`, [made.order.id])
    expect(line).toMatchObject({ kind: 'MADE_TO_MEASURE', measurementProfileId: rev2, quantity: 1 })
    expect(Number(line.price)).toBe(0)
    expect(line.description).toContain('Remake for RMA-360-0001 line 10')
    expect((await one(`SELECT count(*)::int AS n FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1`, [made.order.id])).n).toBe(0)
    expect((await one(`SELECT "customerRef" FROM "SalesOrder" WHERE id = $1`, [made.order.id])).customerRef).toBe('RMA-360-0001')
    expect((await outbox('remake_order.made')).at(-1)).toEqual({ returnId: rma, number: 'RMA-360-0001', orderId: made.order.id, orderNumber: made.order.number, lineIds: [rmaLine], waits: true })
    expect((await no('sales', 'POST', `/sales/returns/${rma}/remake-order`, { version: made.remake.version }, 409)).message).toContain('waits for its remake order')
    const confirmed = await ok('pm', 'POST', `/sales/mtm/profiles/${rev2}/review`, { decision: 'CONFIRM' })
    expect(confirmed.ordersGoneOn.map((order: Json) => order.id)).toContain(made.order.id)
    expect((await one(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [made.order.id])).status).toBe('CONFIRMED')
  })

  it('records nothing while made-to-measure is off again for JACKET (GATE-MTM)', async () => {
    const rules = (await ok('owner', 'GET', `/product/measurement-templates/${S.jacket}/mtm-rules`)).rules
    await ok('owner', 'PUT', `/product/measurement-templates/${S.jacket}/mtm-rules/switch`, { version: rules.template.version, on: false, reason: 'Made-up pause.' })
    expect((await no('sales', 'POST', '/sales/fittings/results', { salesOrderLineId: unitLine, verdict: 'OK' }, 409)).message).toContain('Made-to-measure has not started for measurement template JACKET')
    expect((await appointmentOf(fitting)).may.result).toBe(false)
  })
})
