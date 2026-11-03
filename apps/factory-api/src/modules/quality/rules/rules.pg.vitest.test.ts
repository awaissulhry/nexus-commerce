import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCapa } from '../../../../../../packages/factory-db/seed/capa'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { escalationRuleOf } from '../capa/reminders'
import { ruleInForce } from '../final/facts'
import { evaluateTenant, fireAtOnce } from './firing'

/**
 * Quality rules (B-W2b-118; QHS-154 alerts and escalation, QHS-300 separation of duties) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (row-level security and the
 * …_quality_problems_w2b_guards triggers real), tenant A from the factory-db seeds up to capa (the tenant-wide quality
 * settings, the seven alert rules of every company, an ACTIVE hold, an OPEN inspection, valid certificates). Test sessions
 * for most calls; the owner signed in through the real sign-in with two-factor for a looser rule. The rules' cron body and
 * handler run with moved clocks; the bell's fan-out runs on the events they wrote. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/rules`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const NS = 'w2b118-rules-a'
const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B'), siteA1: id('site:A1') }
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (permissions: readonly Permission[], scope: Partial<Grant> = {}): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions, scope)] })
const KEEPER: Permission[] = ['home.view', 'quality.rules.view', 'quality.alerts.manage', 'quality.settings.manage', 'quality.inspections.view', 'quality.holds.view']
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(KEEPER),
  viewer: office(['home.view', 'quality.rules.view']),
  companyB: office(KEEPER, { companies: [A.companyB] }),
  outsider: office(['home.view', 'quality.holds.view']),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b118-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ id: string; payload: Json }>(`SELECT id, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row): Json => ({ ...row.payload, id: row.id }))
const system = () => callerFor(h.database, systemContext(A.tenant, `w2b118-${newId()}`))

/** The bell's fan-out of one outbox event, as the worker runs it; how many notifications it made. */
async function ring(eventId: string): Promise<number> {
  const [row] = await admin<{ id: string; type: string; payload: Json; companyId: string | null; siteId: string | null }>(`SELECT id, type, payload, "companyId", "siteId" FROM "OutboxEvent" WHERE id = $1`, [eventId])
  return fanOut(system(), { eventId: row!.id, type: row!.type, payload: row!.payload, companyId: row!.companyId, siteId: row!.siteId } as unknown as EventEnvelope)
}
const notes = async (userId: string) => admin<{ messageKey: string; recordType: string; recordLabel: string; params: Json; category: string }>(`SELECT "messageKey", "recordType", "recordLabel", params, category FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId])

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
const signedIn = async (email: string, role: string): Promise<Person> => {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
async function as(person: Person, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await person.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

let owner: Person
let qa: { id: string }

beforeAll(async () => {
  h = await startHarness('quality_rules')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedCapa({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (quality.rules.view and quality.alerts.manage for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  owner = await signedIn('owner.w2b118@example.com', 'owner')
  qa = await addUser(h, TENANT, { email: 'qa.w2b118@example.com', role: 'quality_inspector' })
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('who may sign what (QHS-300; design qs-sod, qs-loosen)', () => {
  it('reads both cards for every company and for a company: what is in force, where it comes from, the separations, who scans name', async () => {
    const all = await ok('viewer', 'GET', '/quality/rules')
    expect(all).toMatchObject({ companyId: null, mayChange: false, version: 2 })
    expect(all.duties.inForce).toEqual({ releaseFourEyes: { rule: 'WHEN_REQUIRED', source: 'DEFAULT' }, conditions: ['CUSTOMER', 'OVERRIDE'], conditionsFromTenant: [], placerMayRelease: { value: false, source: 'DEFAULT' } })
    expect(all.results.inForce).toEqual({ stopAtRejectNumber: { value: false, source: 'TENANT' }, benchUndoSeconds: { value: 10, source: 'TENANT' } })
    expect(all.separations.every((rule: Json) => rule.kept)).toBe(true)
    const a = await ok('keeper', 'GET', `/quality/rules?companyId=${A.companyA}`)
    expect(a).toMatchObject({ companyId: A.companyA, company: { code: expect.any(String) }, version: 0, mayChange: true, duties: { own: null, inForce: { conditionsFromTenant: ['CUSTOMER', 'OVERRIDE'] } } })
    expect(a.monitoring.length).toBeGreaterThan(0)
    expect(a.monitoring[0]).toMatchObject({ scanSubject: expect.stringMatching(/^(WORKER|STATION)$/) })
    expect((await refused('outsider', 'GET', '/quality/rules', undefined, 403)).code).toBe('forbidden')
  })

  it('tightens with no code; refuses a reader, another company’s keeper for every company, a stale version', async () => {
    const saved = await ok('keeper', 'PUT', '/quality/rules/duties', { companyId: null, version: 2, releaseFourEyes: 'ALWAYS', fourEyesConditions: ['OVERRIDE', 'CUSTOMER'], secondPersonPartyIds: [], placerMayRelease: null })
    expect(saved.loosened).toEqual([])
    expect(saved.rules.duties.inForce.releaseFourEyes).toEqual({ rule: 'ALWAYS', source: 'TENANT' })
    expect(saved.rules.version).toBe(3)
    expect((await events('quality.rules_changed')).at(-1)).toMatchObject({ companyId: null, card: 'DUTIES', fields: ['releaseFourEyes'], loosened: [] })
    expect((await events('quality.release_rule_changed')).at(-1)).toMatchObject({ releaseFourEyes: 'ALWAYS', previousRule: null, loosened: false })
    expect((await refused('viewer', 'PUT', '/quality/rules/duties', { version: 3, releaseFourEyes: 'ALWAYS', fourEyesConditions: [], secondPersonPartyIds: [], placerMayRelease: null }, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'PUT', '/quality/rules/duties', { companyId: null, version: 3, releaseFourEyes: 'ALWAYS', fourEyesConditions: [], secondPersonPartyIds: [], placerMayRelease: null }, 403)).message).toMatch(/every company/)
    await refused('keeper', 'PUT', '/quality/rules/duties', { companyId: null, version: 2, releaseFourEyes: 'ALWAYS', fourEyesConditions: ['OVERRIDE'], secondPersonPartyIds: [], placerMayRelease: null }, 409)
    expect(paths(await refused('keeper', 'PUT', '/quality/rules/duties', { companyId: null, version: 3, releaseFourEyes: 'ALWAYS', fourEyesConditions: ['OVERRIDE', 'CUSTOMER'], secondPersonPartyIds: [A.companyA], placerMayRelease: null }, 400))).toEqual(['body/secondPersonPartyIds'])
  })

  it('a looser rule asks the reason, then a fresh code; it is said in words and the release gate follows it', async () => {
    const body = { companyId: null, version: 3, releaseFourEyes: 'WHEN_REQUIRED', fourEyesConditions: ['CUSTOMER'], secondPersonPartyIds: [], placerMayRelease: true }
    expect(paths((await as(owner, 'PUT', '/quality/rules/duties', body, 400)).error)).toEqual(['body/reason'])
    expect((await as(owner, 'PUT', '/quality/rules/duties', { ...body, reason: 'One quality person on the night shift' }, 403)).error.issues.map((issue: Json) => issue.path)).toContain('stepUp')
    await stepUp(h, owner.browser, owner.secret)
    const saved = await as(owner, 'PUT', '/quality/rules/duties', { ...body, reason: 'One quality person on the night shift' })
    expect(saved.loosened).toEqual(['RELEASE_ALONE', 'OVERRIDE_ALONE', 'PLACER_RELEASES'])
    expect(saved.rules.duties.inForce).toMatchObject({ releaseFourEyes: { rule: 'WHEN_REQUIRED', source: 'TENANT' }, conditions: ['CUSTOMER'], placerMayRelease: { value: true, source: 'TENANT' } })
    const [audit] = await admin<{ reason: string; after: Json }>(`SELECT reason, after FROM "AuditLog" WHERE "recordType" = 'QualitySettings' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [A.tenant])
    expect(audit).toMatchObject({ reason: 'One quality person on the night shift', after: { loosened: ['RELEASE_ALONE', 'OVERRIDE_ALONE', 'PLACER_RELEASES'] } })
    expect((await events('quality.hold_rule_changed')).at(-1)).toMatchObject({ placerMayRelease: true, loosened: true })
    // The release gate reads the conditions as the database does: an override alone no longer asks a second person.
    const rule = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => ruleInForce(client, A.tenant, A.companyA))
    expect(rule.conditions).toEqual(['CUSTOMER'])
    expect((await ok('keeper', 'GET', `/quality/release-rule?companyId=${A.companyA}`)).inForce.words).toBe('An inspector who made none of the garments releases alone; a second person only for the listed customers.')
  })

  it('a company adds to what every company asks and cannot drop it alone (no code asked); it follows every company again', async () => {
    const saved = await ok('keeper', 'PUT', '/quality/rules/duties', { companyId: A.companyA, version: 0, releaseFourEyes: null, fourEyesConditions: ['OVERRIDE'], secondPersonPartyIds: [], placerMayRelease: false })
    expect(saved.loosened).toEqual([])
    expect(saved.rules.duties.inForce).toMatchObject({ conditions: ['CUSTOMER', 'OVERRIDE'], conditionsFromTenant: ['CUSTOMER'], placerMayRelease: { value: false, source: 'COMPANY' } })
    // Following every company again drops OVERRIDE and lets the placer release: looser, so the reason and the code again.
    const follow = { companyId: A.companyA, version: 1, releaseFourEyes: null, fourEyesConditions: [], secondPersonPartyIds: [], placerMayRelease: null }
    expect(paths(await refused('keeper', 'PUT', '/quality/rules/duties', follow, 400))).toEqual(['body/reason'])
    await stepUp(h, owner.browser, owner.secret)
    const back = await as(owner, 'PUT', '/quality/rules/duties', { ...follow, reason: 'Company A follows the group again' })
    expect(back.loosened).toEqual(['OVERRIDE_ALONE', 'PLACER_RELEASES'])
    expect(back.rules.duties.inForce).toMatchObject({ conditions: ['CUSTOMER'], placerMayRelease: { value: true, source: 'TENANT' } })
  })
})

describe('result rules (design qs-results)', () => {
  it('keeps the undo window in 0..300 seconds and the stop rule per company; no code asked', async () => {
    expect(paths(await refused('keeper', 'PUT', '/quality/rules/results', { companyId: A.companyA, version: 2, stopAtRejectNumber: true, benchUndoSeconds: 301 }, 400))).toEqual(['body/benchUndoSeconds'])
    const saved = await ok('keeper', 'PUT', '/quality/rules/results', { companyId: A.companyA, version: 2, stopAtRejectNumber: true, benchUndoSeconds: 30 })
    expect(saved.changed).toEqual(['stopAtRejectNumber', 'benchUndoSeconds'])
    expect(saved.rules.results.inForce).toEqual({ stopAtRejectNumber: { value: true, source: 'COMPANY' }, benchUndoSeconds: { value: 30, source: 'COMPANY' } })
    expect((await events('quality.rules_changed')).at(-1)).toMatchObject({ companyId: A.companyA, card: 'RESULTS', fields: ['stopAtRejectNumber', 'benchUndoSeconds'] })
    expect((await ok('keeper', 'PUT', '/quality/rules/results', { companyId: A.companyA, version: 3, stopAtRejectNumber: true, benchUndoSeconds: 30 })).changed).toEqual([])
  })
})

describe('alert and escalation rules (QHS-154; design qs-alerts)', () => {
  let ruleA = ''
  it('lists the rules of every company as sentences, the roles, where the reader may keep rules', async () => {
    const list = await ok('viewer', 'GET', '/quality/alert-rules')
    expect(list.rules.map((rule: Json) => rule.event)).toEqual(['HOLD_PLACED', 'CRITICAL_NCR', 'SAFETY_COMPLAINT', 'INSPECTION_WAITING', 'CERTIFICATE_EXPIRING', 'RELEASE_WAITING_SECOND_PERSON', 'CAPA_ACTION_OVERDUE'])
    expect(list.rules[0].sentence.en).toBe("When goods are put on hold, tell the hold's owner at once, by the bell.")
    expect(list.rules[4].sentence.it).toMatch(/^Quando un certificato scade tra 180 \/ 90 \/ 30 giorni, avvisa chi ha il ruolo /)
    expect(list).toMatchObject({ starterMissing: [], mayManage: false, places: { everywhere: false, companies: [] } })
    expect(list.roles.some((role: Json) => role.key === 'quality_inspector')).toBe(true)
    expect((await ok('keeper', 'GET', '/quality/alert-rules')).places.everywhere).toBe(true)
  })

  it('refuses a rule with its problems in words; adds a company’s own, which shadows every company’s for it', async () => {
    const base = { companyId: A.companyA, event: 'HOLD_PLACED', audience: 'ROLE', roleId: null, withinMinutes: 60, daysBefore: [], channels: ['IN_APP'] }
    expect(paths(await refused('keeper', 'POST', '/quality/alert-rules', base, 400))).toEqual(['body/roleId'])
    expect(paths(await refused('keeper', 'POST', '/quality/alert-rules', { ...base, event: 'CERTIFICATE_EXPIRING', audience: 'OWNER', withinMinutes: 0, daysBefore: [30] }, 400))).toEqual(['body/audience'])
    expect(paths(await refused('keeper', 'POST', '/quality/alert-rules', { ...base, audience: 'OWNER', channels: ['EMAIL'] }, 400))).toEqual(['body/channels'])
    expect((await refused('companyB', 'POST', '/quality/alert-rules', { ...base, audience: 'OWNER' }, 403)).code).toBe('forbidden')
    const created = await ok('keeper', 'POST', '/quality/alert-rules', { ...base, audience: 'OWNER_AND_ROLE', roleId: (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'quality_inspector'`, [A.tenant]))[0]!.id, channels: ['IN_APP', 'EMAIL'] }, 201)
    ruleA = created.rule.id
    expect(created.rule).toMatchObject({ companyId: A.companyA, company: { code: expect.any(String) }, enabled: true, version: 1, fired7d: 0, lastFiredAt: null })
    expect(created.rule.sentence.en).toMatch(/^When goods are still on hold 1 hour after they were held, tell the hold's owner and everyone with the role /)
    const forA = await ok('keeper', 'GET', `/quality/alert-rules?companyId=${A.companyA}`)
    expect(forA.rules.find((rule: Json) => rule.event === 'HOLD_PLACED' && rule.companyId === null).inForce).toBe(false)
    expect(forA.rules.find((rule: Json) => rule.id === ruleA).inForce).toBe(true)
    expect((await events('quality.alert_rule_changed')).at(-1)).toMatchObject({ ruleIds: [ruleA], companyId: A.companyA, events: ['HOLD_PLACED'], change: 'CREATED' })
  })

  it('changes a rule at its version, refuses a stale one, removes it; the starter puts back a missing rule of every company', async () => {
    await refused('keeper', 'PATCH', `/quality/alert-rules/${ruleA}`, { version: 9, enabled: false }, 409)
    const off = await ok('keeper', 'PATCH', `/quality/alert-rules/${ruleA}`, { version: 1, enabled: false, audience: 'OWNER' })
    expect(off.rule).toMatchObject({ enabled: false, audience: 'OWNER', roleId: null, version: 2 })
    await ok('keeper', 'DELETE', `/quality/alert-rules/${ruleA}?version=2`)
    const release = (await ok('keeper', 'GET', '/quality/alert-rules')).rules.find((rule: Json) => rule.event === 'RELEASE_WAITING_SECOND_PERSON')
    await ok('keeper', 'DELETE', `/quality/alert-rules/${release.id}?version=${release.version}`)
    expect((await ok('keeper', 'GET', '/quality/alert-rules')).starterMissing).toEqual(['RELEASE_WAITING_SECOND_PERSON'])
    const starter = await ok('keeper', 'POST', '/quality/alert-rules/starter', {})
    expect(starter.added).toEqual(['RELEASE_WAITING_SECOND_PERSON'])
    expect((await ok('keeper', 'GET', '/quality/alert-rules')).starterMissing).toEqual([])
    expect((await refused('companyB', 'POST', '/quality/alert-rules/starter', {}, 403)).code).toBe('forbidden')
  })

  it('keeps the CAPA escalation rule B-W2b-108 reads working', async () => {
    const rule = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => escalationRuleOf(client, A.companyA))
    expect(rule).toMatchObject({ withinMinutes: 1440, owner: true })
    expect(rule.roleIds).toHaveLength(1)
  })
})

describe('firing and the bell (QHS-154)', () => {
  it('fires at once on a hold placed, once; the bell tells the hold’s owner in their language', async () => {
    const [hold] = await admin<{ id: string; placedAt: Date }>(`SELECT id, "placedAt" FROM "QualityHold" WHERE "tenantId" = $1 AND status = 'ACTIVE' ORDER BY "placedAt" LIMIT 1`, [A.tenant])
    await admin(`UPDATE "QualityHold" SET "ownerId" = $1 WHERE id = $2`, [qa.id, hold!.id])
    expect(await fireAtOnce(system(), { type: 'quality.hold_placed', payload: { holdId: hold!.id } }, new Date())).toBe(1)
    expect(await fireAtOnce(system(), { type: 'quality.hold_placed', payload: { holdId: hold!.id } }, new Date())).toBe(0)
    const fired = (await events('quality.alert_fired')).filter((event) => event.recordId === hold!.id)
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ event: 'HOLD_PLACED', audience: 'OWNER', recordType: 'QualityHold', step: 0, testFor: null })
    expect(await ring(fired[0]!.id)).toBe(1)
    expect((await notes(qa.id)).at(-1)).toMatchObject({ category: 'ALERT', messageKey: 'notifications.alert.raised', recordType: 'QualityHold', params: { title: 'merce messa in blocco (regola qualità)' } })
  })

  it('fires a wait once crossed (an inspection waiting more than 4 hours) and a certificate at the latest step reached, each once', async () => {
    const [inspection] = await admin<{ id: string; createdAt: Date }>(`SELECT id, "createdAt" FROM "Inspection" WHERE "tenantId" = $1 AND status = 'OPEN' ORDER BY "createdAt" DESC LIMIT 1`, [A.tenant])
    const at = new Date(inspection!.createdAt.getTime() + 5 * 3600_000)
    const first = await evaluateTenant(system(), at)
    expect(first.failed).toBe(0)
    const waiting = (await events('quality.alert_fired')).find((event) => event.recordId === inspection!.id)
    expect(waiting).toMatchObject({ event: 'INSPECTION_WAITING', recordType: 'Inspection', step: 0 })
    expect((await evaluateTenant(system(), new Date(at.getTime() + 600_000))).fired).toBe(0)
    // A certificate 20 days before its last valid day (the clock moved there; a VALID certificate's date never changes).
    const [certificate] = await admin<{ id: string; validTo: string }>(`SELECT id, "validTo"::text AS "validTo" FROM "Certificate" WHERE "tenantId" = $1 AND status = 'VALID' ORDER BY "validTo" LIMIT 1`, [A.tenant])
    const lastDay = certificate!.validTo
    const before = new Date(Date.parse(`${lastDay}T12:00:00Z`) - 20 * 86_400_000)
    expect((await evaluateTenant(system(), before)).failed).toBe(0)
    expect((await events('quality.alert_fired')).find((event) => event.recordId === certificate!.id)).toMatchObject({ event: 'CERTIFICATE_EXPIRING', step: 30, date: lastDay })
    expect((await evaluateTenant(system(), new Date(before.getTime() + 86_400_000))).fired).toBe(0)
    // The quality inspector's role holds the inspection's view and Home: told.
    expect(await ring(waiting!.id)).toBe(1)
    expect((await notes(qa.id)).at(-1)).toMatchObject({ recordType: 'Inspection', params: { title: 'ispezione in attesa da più di 4 ore (regola qualità)' } })
  })

  it('a test reaches the person who asked only, from the rule', async () => {
    const rule = (await ok('keeper', 'GET', '/quality/alert-rules')).rules.find((entry: Json) => entry.event === 'CRITICAL_NCR')
    const sent = await as(owner, 'POST', `/quality/alert-rules/${rule.id}/test`, {})
    expect(sent.sent).toBe(true)
    const test = (await events('quality.alert_fired')).at(-1)!
    expect(test).toMatchObject({ ruleId: rule.id, testFor: owner.id, recordType: 'QualityAlertRule' })
    expect(await ring(test.id)).toBe(1)
    expect((await notes(owner.id)).at(-1)).toMatchObject({ recordType: 'QualityAlertRule', params: { title: expect.stringMatching(/^Prova della regola qualità: Quando viene aperta una NC critica, avvisa chi ha il ruolo /) } })
    expect((await refused('viewer', 'POST', `/quality/alert-rules/${rule.id}/test`, {}, 403)).code).toBe('forbidden')
  })
})
