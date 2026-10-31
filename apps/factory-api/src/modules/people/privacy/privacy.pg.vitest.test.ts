import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MonitoringBasis, PeoplePurpose } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { GATE_PURPOSES } from '@nexus/factory-domain/people/privacy/purposes'
import { MONITORING_BASES } from '@nexus/factory-domain/production/settings/monitoring'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import type { CommandCaller } from '../../../core/command'
import { buildApp } from '../../../core/app'
import { SYSTEM_ACTOR_ID, testAuthenticator, withContextClient, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { personFiguresAccess } from './access'
import { assertPersonDecides } from './decide'
import { legalGateFor, legalGateReader, requireLegalGate } from './gate'
import { minimumGroupSizeFor } from './groups'

/**
 * Privacy of people data (B-W2b-27; W2b plan §2 GATE-LABOUR; PLT-207, PLT-209, ANA-075, MES-249, MES-281, MES-282;
 * Statuto dei Lavoratori, L. 300/1970, art. 4 c.1, c.2, c.3; GDPR arts. 5, 13, 22, 35; D.Lgs. 152/1997 art. 1-bis) on
 * the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the
 * column grants and the …_people_w2b_guards triggers are real), the seeds of two tenants (company A's plant A1 names
 * workers on an RSU agreement and has a published worker notice and a stored DPIA; company B's plant B1 records stations
 * and has neither; A1's ATTENDANCE gate was switched on and off once, so NO purpose is in force anywhere), the real
 * office sign-in with two-factor and step-up, and test sessions for the walls. Every person is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/privacy`.
 */

let h: Harness
let app: FastifyInstance
let people: PeopleSeed

const ns = { a: 'people-privacy-a', b: 'people-privacy-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  member: idOf(ns.a, 'user:member'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
  device: idOf(ns.a, 'device:A1:cutting'),
}
const B = { tenant: idOf(ns.b, 'tenant'), siteA1: idOf(ns.b, 'site:A1') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const templateGrant = (key: string): Grant => grant([...(templateOf(key)?.permissions ?? [])])

let hrUserId = ''
let plainUserId = ''
const SESSIONS: Record<string, SessionContext> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function as(session: string, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await call(session, method, url, payload)
  return { status: response.statusCode, body: response.json() }
}

/** The person who records the basis per site and purpose (the Owner's permissions on people data), with two-factor. */
let keeper: { browser: Browser; secret: string; userId: string }
const stepUpLapses = () => h.clock.advance(6 * 60_000)

const gateRows = (siteId: string, purpose: string) =>
  admin('SELECT id, basis, "basisReference", "basisCoversLeads", "leadsSeeFigures", "noticeId", "dpiaId", "switchedOffAt", "switchOffReason", version FROM "PeopleLegalGate" WHERE "siteId" = $1 AND purpose = $2 ORDER BY "switchedOnAt", id', [siteId, purpose])
const inForce = async (siteId: string, purpose: string) => (await gateRows(siteId, purpose)).filter((row) => row.switchedOffAt === null)
const auditOf = (action: string) => admin('SELECT "recordType", "recordId", "actorId", before, after, reason FROM "AuditLog" WHERE action = $1 ORDER BY at, id', [action])
const eventsOf = (type: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt", id', [type])

async function addCustomRole(key: string, name: string, permissions: Permission[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
    client.role.create({ data: { id, key, name, permissions, grains: [], requireMfa: false, audience: 'OFFICE' } }),
  )
  return id
}
async function assign(userId: string, roleId: string, scope: { allCompanies?: boolean; companyIds?: string[]; siteIds?: string[] } = { allCompanies: true }): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: userId }, (client) =>
    client.roleAssignment.create({ data: { id: newId(), userId, roleId, allCompanies: scope.allCompanies ?? false, companyIds: scope.companyIds ?? [], siteIds: scope.siteIds ?? [], validFrom: new Date('2026-10-01T00:00:00.000Z') } }),
  )
}

const floorContext = (workerId: string, permissions: Permission[]): RequestContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId: workerId,
  siteId: A.siteA1,
  deviceId: A.device,
  grants: [grant(permissions, [A.companyA], [A.siteA1])],
  requestId: newId(),
})

/** A floor request as the API sees it: its client follows `this.factoryContext`, as a FastifyRequest's does. */
const floorCaller = (context: RequestContext): CommandCaller => ({
  factoryContext: context,
  withClient(work) {
    return withContextClient(h.database, this.factoryContext, work)
  },
})

beforeAll(async () => {
  h = await startHarness('people_privacy')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  // Production first (A1's floor rules with the RSU agreement), then people (privacy: the worker notice and the DPIA).
  for (const namespace of [ns.a, ns.b]) await seedProduction({ db: h.database, namespace })
  people = await seedPeople({ db: h.database, namespace: ns.a })
  await seedPeople({ db: h.database, namespace: ns.b })
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  const tenantA: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
  // The keeper: a custom role with the owner's people data permissions (the owner holds them through every()).
  const keeperUser = await addUser(h, tenantA, { email: 'gate.keeper@example.com' })
  await assign(keeperUser.id, await addCustomRole('custom.gatekeeper', 'Gate keeper', ['people.privacy.view', 'people.privacy.manage']))
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenantA.slug, keeperUser.email, keeperUser.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  keeper = { browser, secret: await enrolTotp(h, browser), userId: keeperUser.id }
  // HR: a custom role that may open one person's figures (named in People settings later), over company A only.
  hrUserId = (await addUser(h, tenantA, { email: 'hr.office@example.com' })).id
  await assign(hrUserId, await addCustomRole('custom.hr', 'HR', ['people.figures.view']), { companyIds: [A.companyA] })
  plainUserId = (await addUser(h, tenantA, { email: 'plain.office@example.com' })).id
  Object.assign(SESSIONS, {
    viewer: office([templateGrant('admin')]),
    production: office([templateGrant('production_manager')]),
    companyB: office([grant(['people.privacy.view', 'people.privacy.manage'], [A.companyB])]),
    otherTenant: { audience: 'office', tenantId: B.tenant, actorId: newId(), grants: [grant(['people.privacy.view', 'people.privacy.manage'])] },
    partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(['people.privacy.view', 'people.figures.view'])] },
    floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: A.device, grants: [grant(['floor.work', 'people.privacy.view'], [A.companyA], [A.siteA1])] },
    hr: office([grant(['people.figures.view'], [A.companyA])], hrUserId),
    plain: office([grant(['home.view'])], plainUserId),
    plainFigures: office([grant(['people.figures.view'])], plainUserId),
    // The seed member's account is E2's (the lead of team L1-A, with E1 and E3 in it).
    leadE2: office([grant(['people.figures.view'], [A.companyA])], A.member),
  } satisfies Record<string, SessionContext>)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      clock: h.clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...GATE_PURPOSES].sort()).toEqual(Object.values(PeoplePurpose).sort())
    expect([...MONITORING_BASES].sort()).toEqual(Object.values(MonitoringBasis).sort())
  })
})

describe('every site starts closed: the build ships every purpose OFF (GATE-LABOUR)', () => {
  it('lists every site with both purposes off and what switching each on needs, in words', async () => {
    const answer = await keeper.browser.get('/people/privacy')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const bySite = new Map((answer.body.sites as Json[]).map((entry) => [entry.site.id, entry]))
    expect([...bySite.keys()].sort()).toEqual([A.siteA1, A.siteB1].sort())
    for (const entry of bySite.values()) expect(entry.purposes.map((purpose: Json) => [purpose.purpose, purpose.open, purpose.gate])).toEqual([['ATTENDANCE', false, null], ['PERFORMANCE', false, null]])
    const a1 = bySite.get(A.siteA1)!.purposes as Json[]
    expect(a1.map((purpose) => purpose.readiness.canSwitchOn)).toEqual([true, true])
    const b1 = bySite.get(A.siteB1)!.purposes as Json[]
    expect(b1.map((purpose) => purpose.readiness.missing.map((missing: Json) => missing.code))).toEqual([['WORKER_NOTICE', 'DPIA'], ['WORKER_NOTICE', 'DPIA', 'SITE_BASIS']])
    expect(answer.body.companies.map((entry: Json) => entry.settings)).toEqual([
      { minimumGroupSize: 3, figureRoleKeys: [], version: 1 },
      { minimumGroupSize: 3, figureRoleKeys: [], version: 1 },
    ])
  })

  it("one site: the site basis, the notice and the DPIA in force (Admin › Privacy), and the seed's earlier decision in the history", async () => {
    const answer = await keeper.browser.get(`/people/privacy/sites/${A.siteA1}`)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      scanSubject: 'WORKER',
      siteBasis: { kind: 'UNION_AGREEMENT' },
      workerNotice: { label: '2026-10' },
      dpia: { versionNo: 1, status: 'STORED' },
      privacyPage: 'admin.privacy',
    })
    expect(answer.body.history).toHaveLength(1)
    expect(answer.body.history[0]).toMatchObject({ id: people.gateId, purpose: 'ATTENDANCE', switchedOffAt: expect.any(String), switchOffReason: expect.any(String) })
  })

  it("a per-person read is refused while the gate is off: 409 gate/<PURPOSE>, also for the worker's own figures", async () => {
    const access = await as('hr', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)
    expect(access.status).toBe(200)
    expect(access.body).toMatchObject({ allowed: false, refusal: 'GATE_CLOSED', as: null, words: [expect.stringMatching(/art\. 4 c\.1/)] })
    const open = await as('hr', 'POST', `/people/privacy/figures/${people.employeeIds.e1}/open`, { purpose: 'PERFORMANCE', reason: 'PAY_QUERY' })
    expect(open.status).toBe(409)
    expect(open.body.error).toMatchObject({ code: 'invalid_state', issues: [{ path: 'gate/PERFORMANCE' }] })
    const own = await as('leadE2', 'POST', `/people/privacy/figures/${people.employeeIds.e2}/open`, { purpose: 'ATTENDANCE' })
    expect(own.status).toBe(409)
    expect(own.body.error.issues).toEqual([{ path: 'gate/ATTENDANCE', message: expect.stringMatching(/art\. 4 c\.2-3/) }])
    await expect(h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => requireLegalGate(client, A.siteA1, 'ATTENDANCE'))).rejects.toMatchObject({ code: 'invalid_state' })
    expect(await auditOf('people.openPersonFigures')).toEqual([])
  })
})

describe('switching a purpose on (Statuto art. 4 c.2 / c.1; GDPR arts. 13, 35)', () => {
  it('is refused in words while the notice and the DPIA are missing, before any code is asked', async () => {
    stepUpLapses()
    const refused = await keeper.browser.post(`/people/privacy/sites/${A.siteB1}/purposes/ATTENDANCE/switch-on`, { basis: { kind: 'NOT_REQUIRED', reference: 'Counsel opinion 2026-10' }, reason: 'Clock-in starts at B1.' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues.map((issue: Json) => issue.path)).toEqual(['company/workerNotice', 'company/dpia'])
    expect(await inForce(A.siteB1, 'ATTENDANCE')).toEqual([])
  })

  it('is refused without a fresh step-up (403 stepUp), and nothing is recorded', async () => {
    stepUpLapses()
    const refused = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/switch-on`, { basis: { kind: 'NOT_REQUIRED', reference: 'Counsel opinion 2026-10-20' }, reason: 'Badge clock-in starts at A1.' })
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues?.[0]?.path).toBe('stepUp')
    expect(await inForce(A.siteA1, 'ATTENDANCE')).toEqual([])
  })

  it('is refused for a holder of people.privacy.view only (the administrator) and out of scope (another company: 404)', async () => {
    expect((await as('viewer', 'POST', `/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/switch-on`, { reason: 'x' })).status).toBe(403)
    expect((await as('companyB', 'GET', `/people/privacy/sites/${A.siteA1}`)).status).toBe(404)
    expect((await as('companyB', 'POST', `/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/switch-on`, { reason: 'x' })).status).toBe(404)
  })

  it('ATTENDANCE: with the basis kept, a reason and a step-up: the gate records the notice and the DPIA in force; audit and event', async () => {
    await stepUp(h, keeper.browser, keeper.secret)
    const answer = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/switch-on`, { basis: { kind: 'NOT_REQUIRED', reference: 'Counsel opinion 2026-10-20' }, reason: 'Badge clock-in starts at A1.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toMatchObject({ changed: true, change: 'SWITCHED_ON' })
    const attendance = (answer.body.purposes as Json[]).find((purpose) => purpose.purpose === 'ATTENDANCE')!
    expect(attendance).toMatchObject({
      open: true,
      law: expect.stringMatching(/art\. 4 c\.2/),
      gate: { basis: { kind: 'NOT_REQUIRED', reference: 'Counsel opinion 2026-10-20' }, notice: { label: '2026-10', status: 'PUBLISHED' }, dpia: { versionNo: 1, status: 'STORED' }, switchedOnByName: 'gate keeper', switchedOffAt: null },
      notes: [],
    })
    const rows = await inForce(A.siteA1, 'ATTENDANCE')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ basis: 'NOT_REQUIRED', basisCoversLeads: false, leadsSeeFigures: false })
    const audit = await auditOf('people.switchOnPurpose')
    expect(audit).toEqual([expect.objectContaining({ recordType: 'PeopleLegalGate', recordId: rows[0]!.id, actorId: keeper.userId, reason: 'Badge clock-in starts at A1.' })])
    expect((await eventsOf('legal_gate.changed')).map((row) => row.payload)).toEqual([
      { gateId: rows[0]!.id, siteId: A.siteA1, purpose: 'ATTENDANCE', change: 'SWITCHED_ON', open: true, leadsSeeFigures: false },
    ])
    // PERFORMANCE stays off: the purposes are separate.
    expect(await inForce(A.siteA1, 'PERFORMANCE')).toEqual([])
  })

  it('a second switch-on of a purpose in force is refused (409); PERFORMANCE never takes a basis from the body', async () => {
    await stepUp(h, keeper.browser, keeper.secret)
    const again = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/switch-on`, { basis: { kind: 'NOT_REQUIRED', reference: 'Another opinion' }, reason: 'Again.' })
    expect(again.status).toBe(409)
    const bodyBasis = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/switch-on`, { basis: { kind: 'INL_AUTHORISATION', reference: 'INL 1' }, reason: 'Efficiency per person.' })
    expect(bodyBasis.status).toBe(400)
    expect(bodyBasis.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/basis'])
  })

  it("PERFORMANCE: the site's basis from Production › Settings (the RSU agreement), the basis covering leads; leads off until chosen", async () => {
    await stepUp(h, keeper.browser, keeper.secret)
    const answer = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/switch-on`, { basisCoversLeads: true, reason: 'The RSU agreement covers efficiency per person and names team leads.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const rows = await inForce(A.siteA1, 'PERFORMANCE')
    expect(rows).toEqual([expect.objectContaining({ basis: 'UNION_AGREEMENT', basisReference: 'SEED-RSU-AGREEMENT-2026-01', basisCoversLeads: true, leadsSeeFigures: false })])
  })
})

describe("one person's figures: the worker and HR only (MES-249; Owner answer H3)", () => {
  it('with the gate open and nobody named in People settings, nobody but the worker opens them', async () => {
    expect((await as('hr', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)).body).toMatchObject({ allowed: false, refusal: 'NOT_ALLOWED' })
    const own = await as('leadE2', 'GET', `/people/privacy/figures/${people.employeeIds.e2}/access?purpose=PERFORMANCE`)
    expect(own.body).toMatchObject({ allowed: true, as: 'SELF', needsReason: false, reasons: [] })
    // E2 leads E1's team, but the site does not let leads see one person's figures yet.
    expect((await as('leadE2', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)).body).toMatchObject({ allowed: false, refusal: 'NOT_ALLOWED' })
    const refused = await as('leadE2', 'POST', `/people/privacy/figures/${people.employeeIds.e1}/open`, { purpose: 'PERFORMANCE', reason: 'COACHING_ASKED' })
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues).toEqual([{ path: 'figures/NOT_ALLOWED', message: expect.stringMatching(/only by the worker/) }])
  })

  it('naming HR in People settings widens: a reason and a fresh step-up; a floor role or an unknown role is refused', async () => {
    stepUpLapses()
    const noStepUp = await keeper.browser.post(`/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 3, figureRoleKeys: ['custom.hr'], reason: 'HR answers pay queries (Owner answer H3).', version: 1 })
    expect(noStepUp.status).toBe(403)
    await stepUp(h, keeper.browser, keeper.secret)
    const wrong = await keeper.browser.post(`/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 2, figureRoleKeys: ['team_leader', 'custom.nobody'], version: 1 })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/minimumGroupSize', 'body/figureRoleKeys/0', 'body/figureRoleKeys/1', 'body/reason'])
    const named = await keeper.browser.post(`/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 3, figureRoleKeys: ['custom.hr'], reason: 'HR answers pay queries (Owner answer H3).', version: 1 })
    expect(named.status, JSON.stringify(named.body)).toBe(200)
    expect(named.body).toMatchObject({ changed: true, settings: { figureRoleKeys: ['custom.hr'], version: 2 }, named: [{ key: 'custom.hr', name: 'HR' }] })
    expect((await eventsOf('people_settings.privacy_changed')).map((row) => row.payload)).toEqual([{ companyId: A.companyA, minimumGroupSize: 3, figureRoleCount: 1, change: 'WIDENED' }])
  })

  it('HR opens one person with a reason; the opening is recorded (who, whose, purpose, why); no reason: 400', async () => {
    const access = await as('hr', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)
    expect(access.body).toMatchObject({ allowed: true, as: 'FIGURE_ROLE', needsReason: true, reasons: [{ code: 'COACHING_ASKED' }, { code: 'PAY_QUERY' }, { code: 'WORKER_REQUEST' }] })
    const noReason = await as('hr', 'POST', `/people/privacy/figures/${people.employeeIds.e1}/open`, { purpose: 'PERFORMANCE' })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/reason'])
    const opened = await as('hr', 'POST', `/people/privacy/figures/${people.employeeIds.e1}/open`, { purpose: 'PERFORMANCE', reason: 'PAY_QUERY', note: 'The worker asked about October.' })
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body).toMatchObject({ employeeId: people.employeeIds.e1, as: 'FIGURE_ROLE', reason: 'PAY_QUERY', recorded: true })
    const gate = (await inForce(A.siteA1, 'PERFORMANCE'))[0]!
    expect(await auditOf('people.openPersonFigures')).toEqual([
      { recordType: 'Employee', recordId: people.employeeIds.e1, actorId: hrUserId, before: null, after: { purpose: 'PERFORMANCE', as: 'FIGURE_ROLE', reason: 'PAY_QUERY', gateId: gate.id }, reason: 'The worker asked about October.' },
    ])
  })

  it("HR's role reaches company A only: a person of company B is not even found (404); a role not named sees nothing", async () => {
    expect((await as('hr', 'GET', `/people/privacy/figures/${people.employeeIds.eb1}/access?purpose=PERFORMANCE`)).status).toBe(404)
    expect((await as('plainFigures', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)).body).toMatchObject({ allowed: false, refusal: 'NOT_ALLOWED' })
    expect((await as('hr', 'GET', `/people/privacy/figures/${newId()}/access?purpose=PERFORMANCE`)).status).toBe(404)
  })

  it('leads: widening asks the basis to cover them, a reason and a step-up; the lead then opens his team only; narrowing never asks', async () => {
    const gate = (await inForce(A.siteA1, 'PERFORMANCE'))[0]!
    const attendanceGate = (await inForce(A.siteA1, 'ATTENDANCE'))[0]!
    stepUpLapses()
    const noBasis = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/leads`, { version: attendanceGate.version, leadsSeeFigures: true, reason: 'Leads coach.' })
    expect(noBasis.status).toBe(400)
    expect(noBasis.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/leadsSeeFigures'])
    const noStepUp = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/leads`, { version: gate.version, leadsSeeFigures: true, reason: 'The agreement lets leads coach their team.' })
    expect(noStepUp.status).toBe(403)
    await stepUp(h, keeper.browser, keeper.secret)
    const widened = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/leads`, { version: gate.version, leadsSeeFigures: true, reason: 'The agreement lets leads coach their team.' })
    expect(widened.status, JSON.stringify(widened.body)).toBe(200)
    expect(widened.body).toMatchObject({ change: 'LEADS_WIDENED', changed: true })
    expect((await as('leadE2', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)).body).toMatchObject({ allowed: true, as: 'LEAD', needsReason: true })
    // E4 is not in E2's team: no lead access.
    expect((await as('leadE2', 'GET', `/people/privacy/figures/${people.employeeIds.e4}/access?purpose=PERFORMANCE`)).body).toMatchObject({ allowed: false, refusal: 'NOT_ALLOWED' })
    stepUpLapses()
    const stale = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/leads`, { version: gate.version, leadsSeeFigures: false })
    expect(stale.status).toBe(409)
    const narrowed = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/leads`, { version: gate.version + 1, leadsSeeFigures: false })
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200)
    expect(narrowed.body.change).toBe('LEADS_NARROWED')
    expect((await as('leadE2', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=PERFORMANCE`)).body).toMatchObject({ allowed: false })
  })

  it('on the floor: the worker sees their own, a team leader with floor.lead sees the team only where leads may; the gate read goes through the system caller', async () => {
    const own = await personFiguresAccess(floorCaller(floorContext(A.operator, ['floor.work'])), people.employeeIds.e1, 'PERFORMANCE')
    expect(own.decision).toEqual({ allowed: true, as: 'SELF', needsReason: false })
    const leadNoChoice = await personFiguresAccess(floorCaller(floorContext(A.lead, ['floor.work', 'floor.lead'])), people.employeeIds.e1, 'PERFORMANCE')
    expect(leadNoChoice.decision).toMatchObject({ allowed: false, code: 'NOT_ALLOWED' })
    // Another site's person is not in the floor's reach.
    await expect(personFiguresAccess(floorCaller(floorContext(A.operator, ['floor.work'])), people.employeeIds.eb1, 'PERFORMANCE')).rejects.toMatchObject({ code: 'not_found' })
    // The floor role itself reads no legal gate (B-W1-36): only through legalGateReader's system caller.
    await expect(h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) => client.peopleLegalGate.findMany({ select: { id: true } }))).rejects.toThrow(/permission denied/)
    const read = await legalGateReader(floorCaller(floorContext(A.operator, ['floor.work'])), (db) => legalGateFor(db, A.siteA1, 'ATTENDANCE'))
    expect(read.open).toBe(true)
  })
})

describe('the minimum group size (ANA-075)', () => {
  it('lowering it below 3 is refused; raising never asks for a code; the reader gives it to the later People reads', async () => {
    stepUpLapses()
    const raised = await keeper.browser.post(`/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 5, figureRoleKeys: ['custom.hr'], version: 2 })
    expect(raised.status, JSON.stringify(raised.body)).toBe(200)
    expect(raised.body).toMatchObject({ changed: true, settings: { minimumGroupSize: 5 }, words: [expect.stringMatching(/fewer than 5 people shows '—'/)] })
    const lowered = await keeper.browser.post(`/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 4, figureRoleKeys: ['custom.hr'], reason: 'Teams of four.', version: 3 })
    expect(lowered.status).toBe(403)
    expect(await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => minimumGroupSizeFor(client, A.companyA))).toBe(5)
    // The database floor holds for every login.
    await expect(admin('UPDATE "PeopleSettings" SET "minimumGroupSize" = 2 WHERE id = $1', [A.companyA])).rejects.toThrow()
  })

  it('the same settings again change nothing (no audit row, no event)', async () => {
    const before = (await auditOf('people.changePrivacySettings')).length
    const same = await keeper.browser.post(`/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 5, figureRoleKeys: ['custom.hr'], version: 3 })
    expect(same.status).toBe(200)
    expect(same.body.changed).toBe(false)
    expect((await auditOf('people.changePrivacySettings')).length).toBe(before)
  })
})

describe('what a People page says before anything is read (PrivacyNote), and the people data rules', () => {
  it('a plain office person sees groups only; HR one person on request at an open gate; a site outside their roles is 404', async () => {
    const plain = await as('plain', 'GET', `/people/privacy/what-you-see?siteId=${A.siteA1}&purpose=PERFORMANCE`)
    expect(plain.status).toBe(200)
    expect(plain.body).toMatchObject({ open: true, level: 'GROUPS_ONLY', minimumGroupSize: 5, words: [expect.stringMatching(/fewer than 5 people/), expect.stringMatching(/only by the worker and by HR/)] })
    const hr = await as('hr', 'GET', `/people/privacy/what-you-see?siteId=${A.siteA1}&purpose=PERFORMANCE`)
    expect(hr.body).toMatchObject({ level: 'ONE_PERSON_ON_REQUEST' })
    expect((await as('hr', 'GET', `/people/privacy/what-you-see?siteId=${A.siteB1}&purpose=PERFORMANCE`)).status).toBe(404)
  })

  it('the rules: the six purposes with their gates, the facts, no automated decision so no information pack, the switches per site', async () => {
    const answer = await as('production', 'GET', '/people/privacy/rules')
    expect(answer.status).toBe(200)
    expect(answer.body.purposes.map((purpose: Json) => [purpose.purpose, purpose.gate])).toEqual([
      ['EMPLOYMENT', null],
      ['ATTENDANCE', 'ATTENDANCE'],
      ['PERFORMANCE', 'PERFORMANCE'],
      ['PAY', null],
      ['SAFETY', null],
      ['PRODUCTION', null],
    ])
    expect(answer.body).toMatchObject({ automatedDecisions: [], informationPackDue: false })
    expect(answer.body.facts.find((fact: Json) => fact.key === 'PERSON_DECIDES').law).toMatch(/1-bis/)
    expect(answer.body.sites.find((entry: Json) => entry.site.id === A.siteA1).open).toEqual(['ATTENDANCE', 'PERFORMANCE'])
  })
})

describe('a person decides (MES-281; D.Lgs. 152/1997 art. 1-bis; GDPR art. 22)', () => {
  it('a decision about a worker is refused for the system caller and accepted for a person', () => {
    expect(() => assertPersonDecides(systemContext(A.tenant, newId()), 'SKILL_LEVEL')).toThrow(/made by a person, never by the system/)
    expect(() => assertPersonDecides({ audience: 'office', tenantId: A.tenant, actorId: SYSTEM_ACTOR_ID, grants: [], requestId: newId() }, 'SKILL_LEVEL')).toThrow()
    expect(assertPersonDecides({ audience: 'office', tenantId: A.tenant, actorId: keeper.userId, grants: [], requestId: newId() }, 'DISPATCH_ASSIGNMENT')).toBe(keeper.userId)
    expect(assertPersonDecides(floorContext(A.lead, ['floor.work']), 'ATTENDANCE_APPROVAL')).toBe(A.lead)
  })
})

describe('switching a purpose off: narrowing never asks', () => {
  it('needs a reason, never a step-up; the row is final; one person\'s reads are refused again', async () => {
    const gate = (await inForce(A.siteA1, 'PERFORMANCE'))[0]!
    stepUpLapses()
    const noReason = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/switch-off`, { version: gate.version, reason: '' })
    expect(noReason.status).toBe(400)
    const off = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/switch-off`, { version: gate.version, reason: 'The RSU agreement ended.' })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body).toMatchObject({ change: 'SWITCHED_OFF', changed: true })
    expect(await inForce(A.siteA1, 'PERFORMANCE')).toEqual([])
    const row = (await gateRows(A.siteA1, 'PERFORMANCE'))[0]!
    expect(row).toMatchObject({ switchOffReason: 'The RSU agreement ended.', switchedOffAt: expect.any(Date) })
    expect((await as('hr', 'POST', `/people/privacy/figures/${people.employeeIds.e1}/open`, { purpose: 'PERFORMANCE', reason: 'PAY_QUERY' })).status).toBe(409)
    // The database keeps the decision final for every login.
    await expect(admin('UPDATE "PeopleLegalGate" SET "switchOffReason" = $2 WHERE id = $1', [row.id, 'changed'])).rejects.toThrow(/never changes again/)
    await expect(admin('DELETE FROM "PeopleLegalGate" WHERE id = $1', [row.id])).rejects.toThrow(/never deleted/)
    // ATTENDANCE stays on: separate purposes.
    expect(await inForce(A.siteA1, 'ATTENDANCE')).toHaveLength(1)
    const history = (await keeper.browser.get(`/people/privacy/sites/${A.siteA1}`)).body.history as Json[]
    expect(history.map((entry) => [entry.purpose, entry.switchedOffAt === null])).toEqual(expect.arrayContaining([['ATTENDANCE', true], ['PERFORMANCE', false]]))
  })
})

describe('a decision dated later than now (an import, a clock ahead)', () => {
  it('closes from its date on, not before: 409 in words, never a 500', async () => {
    const notice = (await admin('SELECT id FROM "PrivacyNotice" WHERE "companyId" = $1 AND kind = \'WORKER_FLOOR\' AND status = \'PUBLISHED\'', [A.companyA]))[0]!
    const dpia = (await admin('SELECT id FROM "PrivacyDpia" WHERE "companyId" = $1 AND status = \'STORED\'', [A.companyA]))[0]!
    const later = new Date(h.clock.now().getTime() + 7 * 86_400_000)
    const id = newId()
    await admin(
      'INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt") VALUES ($1, $2, $3, $4, \'PERFORMANCE\', \'UNION_AGREEMENT\', \'Imported agreement (made up)\', $5, $6, $7, $8, now())',
      [id, A.tenant, A.companyA, A.siteA1, notice.id, dpia.id, later, keeper.userId],
    )
    const refused = await keeper.browser.post(`/people/privacy/sites/${A.siteA1}/purposes/PERFORMANCE/switch-off`, { version: 1, reason: 'Too early.' })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/switched on with a later date/)
    expect(await inForce(A.siteA1, 'PERFORMANCE')).toHaveLength(1)
  })
})

describe('the walls', () => {
  it('the partner and the floor reach no office route; another tenant finds nothing; the production manager reads, never writes', async () => {
    expect((await as('partner', 'GET', '/people/privacy')).status).toBe(403)
    expect((await as('partner', 'GET', `/people/privacy/figures/${people.employeeIds.e1}/access?purpose=ATTENDANCE`)).status).toBe(403)
    expect((await as('floor', 'GET', '/people/privacy')).status).toBe(403)
    expect((await as('otherTenant', 'GET', `/people/privacy/sites/${A.siteA1}`)).status).toBe(404)
    const theirs = await as('otherTenant', 'GET', '/people/privacy')
    expect(theirs.body.sites.map((entry: Json) => entry.site.id)).not.toContain(A.siteA1)
    expect(theirs.body.sites.map((entry: Json) => entry.site.id)).toContain(B.siteA1)
    expect((await as('production', 'GET', `/people/privacy/sites/${A.siteA1}`)).status).toBe(200)
    expect((await as('production', 'POST', `/people/privacy/sites/${A.siteA1}/purposes/ATTENDANCE/switch-off`, { version: 1, reason: 'Not mine to close.' })).status).toBe(403)
    expect((await as('production', 'POST', `/people/privacy/companies/${A.companyA}`, { minimumGroupSize: 9, figureRoleKeys: [] })).status).toBe(403)
    expect((await as('plain', 'GET', '/people/privacy')).status).toBe(403)
  })
})
