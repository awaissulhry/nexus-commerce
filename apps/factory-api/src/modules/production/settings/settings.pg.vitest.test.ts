import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MonitoringBasis, ScanSubject } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addRole, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { standardBundleSizeFor } from './bundle-size'
import { floorRecordSubjectFor, scanSubjectFor } from './subject'

/**
 * The floor rules and the monitoring switch per site (B-W1-37; A2 SCR-074; MES-278, PLT-208; Statuto dei Lavoratori,
 * L. 300/1970, art. 4; GDPR art. 13) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login, so row-level security, the column grants and the …_production_guards triggers are real), the
 * factory-db seeds of two tenants (plant A1 names workers with an agreement on record, B1 records the station only;
 * WO-0001 in progress at A1 with two bundles; A1's operator acknowledged the notice, its team leader has not), the real
 * office sign-in with two-factor and step-up for the switch, and test sessions for the walls and the floor. Every name
 * and number is made up. Run with `node scripts/factory/run-pg-tests.mjs production`.
 */

let h: Harness
let app: FastifyInstance
let seedA: ProductionSeed

const ns = { a: 'floor-rules-a', b: 'floor-rules-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
  device: idOf(ns.a, 'device:A1:cutting'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
  packStation: idOf(ns.a, 'site:A1:station:PACK-01'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant'), siteA1: idOf(ns.b, 'site:A1'), siteB1: idOf(ns.b, 'site:B1') }

const BOTH: Permission[] = ['production.settings.view', 'production.settings.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const floor = (siteId: string, companyId: string, permissions: Permission[], actorId = A.operator): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId,
  deviceId: A.device,
  grants: [grant(permissions, [companyId], [siteId])],
})
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(BOTH)]),
  viewer: office([grant(['production.settings.view'])]),
  companyB: office([grant(BOTH, [A.companyB])]),
  siteB1: office([grant(BOTH, 'all', [A.siteB1])]),
  otherTenant: { audience: 'office', tenantId: B.tenant, actorId: newId(), grants: [grant(BOTH)] },
  partner: { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.brand, grants: [grant(BOTH)] },
  floorA1: floor(A.siteA1, A.companyA, ['floor.work']),
  floorA1Lead: floor(A.siteA1, A.companyA, ['floor.work'], A.lead),
  floorB1: floor(A.siteB1, A.companyB, ['floor.work'], A.operatorB1),
  floorA1NoWork: floor(A.siteA1, A.companyA, ['shipping.pack']),
  floorWithOffice: floor(A.siteA1, A.companyA, ['floor.work', ...BOTH]),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function status(session: string, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<number> {
  return (await call(session, method, url, payload)).statusCode
}
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, 'GET', url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** A signed-in person with two-factor (so they can step up). */
interface Person {
  browser: Browser
  secret: string
  userId: string
}
let manager: Person
let supervisor: Browser

async function person(tenant: TestTenant, email: string, role: string): Promise<Person> {
  const user = await addUser(h, tenant, { email })
  await addRole(h, tenant, user.id, role)
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { browser, secret: await enrolTotp(h, browser), userId: user.id }
}

/** Moves the clock past the step-up's 5 minutes (the office session's idle end is 8 hours). */
const stepUpLapses = () => h.clock.advance(6 * 60_000)

const rulesRow = async (siteId: string) =>
  (await admin('SELECT "scanSubject", "monitoringBasis", "monitoringReference", "monitoringRecordedById", version FROM "ProductionSettings" WHERE id = $1', [siteId]))[0]
const auditRows = (siteId: string) => admin('SELECT action, reason, before, after, "actorId" FROM "AuditLog" WHERE "recordType" = \'ProductionSettings\' AND "recordId" = $1 ORDER BY at, id', [siteId])
const events = (siteId: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = \'production.monitoring_changed\' AND subject = $1 ORDER BY "occurredAt", id', [siteId])

/** A scan inserted by A1's floor (the cutting tablet), as scans (B-W1-42) will: the triggers judge its subject. */
const scanAt = (operation: 'qc' | 'pack', subject: { workerId: string | null; stationId: string | null }, actorId = A.operator, bundle: 0 | 1 = 1) =>
  h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId, siteId: A.siteA1 }, (client) =>
    client.operationScan.create({
      data: {
        id: newId(),
        siteId: A.siteA1,
        workOrderId: seedA.workOrderId,
        workOrderOperationId: seedA.operationIds[operation],
        bundleId: seedA.bundleIds[bundle],
        kind: 'REPORT',
        // Bundle 1 holds one garment, bundle 2 two.
        goodQuantity: bundle === 0 ? 1 : 2,
        ...subject,
        deviceId: A.device,
        clientScanId: `floor-rules-${newId()}`,
        deviceTime: h.clock.now(),
        createdById: actorId,
      },
      select: { id: true },
    }),
  )

beforeAll(async () => {
  h = await startHarness('production_settings')
  // As the seed CLI runs them: _core first; the production seed runs the seeds it builds on.
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  seedA = await seedProduction({ db: h.database, namespace: ns.a })
  await seedProduction({ db: h.database, namespace: ns.b })
  // The tenant's system roles, as tenant set-up writes them (the harness's addTenant does the same).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  const tenantA: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
  manager = await person(tenantA, 'production.manager@example.com', 'production_manager')
  supervisor = (await person(tenantA, 'floor.supervisor@example.com', 'floor_supervisor')).browser
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      clock: h.clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...SCAN_SUBJECTS].sort()).toEqual(Object.values(ScanSubject).sort())
    expect([...MONITORING_BASES].sort()).toEqual(Object.values(MonitoringBasis).sort())
  })
})

describe('reading the floor rules (SCR-074)', () => {
  it('lists every site the grants reach, with who its records name and whether real floor work may start', async () => {
    const answer = await manager.browser.get('/production/settings')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const bySite = new Map((answer.body.sites as Json[]).map((entry) => [entry.site.id, entry]))
    expect([...bySite.keys()].sort()).toEqual([A.siteA1, A.siteB1].sort())
    expect(bySite.get(A.siteA1)).toMatchObject({
      rules: { scanSubject: 'WORKER', isDefault: false, legalBasis: { kind: 'UNION_AGREEMENT', reference: 'SEED-RSU-AGREEMENT-2026-01' }, version: 1 },
      status: { readyForFloor: true },
    })
    expect(bySite.get(A.siteB1)).toMatchObject({ rules: { scanSubject: 'STATION', legalBasis: null }, status: { readyForFloor: true, notes: ['Scans and cut logs name the station only, never the worker.'] } })
  })

  it('one site: what the switch reaches, in counts (open work orders, workers yet to acknowledge, devices without a station)', async () => {
    const answer = await manager.browser.get(`/production/settings/${A.siteA1}`)
    expect(answer.status).toBe(200)
    expect(answer.body.affected).toEqual({ openWorkOrders: 1, workersActive: 2, workersNotAcknowledged: 1, devicesWithoutStation: 0 })
    expect(answer.body.status.notes).toContain('1 of 2 active workers have not acknowledged the information notice: they cannot scan or log cuts by name until they do.')
    expect(answer.body.ifSwitched).toMatchObject({ to: 'STATION', needsStepUp: false, needsReason: false, needsLegalBasis: false })
    expect(answer.body.ifSwitched.words[0]).toBe('From now on scans and cut logs at this site name the station only, never the worker. 1 open work order goes on that way.')
    const b1 = (await manager.browser.get(`/production/settings/${A.siteB1}`)).body
    expect(b1.ifSwitched).toMatchObject({ to: 'WORKER', needsStepUp: true, needsReason: true, needsLegalBasis: true })
  })

  it('the notice: counts for every viewer, names only with production.settings.manage, sorted by name (never a ranking)', async () => {
    const asManager = (await manager.browser.get(`/production/settings/${A.siteA1}/notice-acks`)).body
    expect(asManager.workers).toEqual({ active: 2, acknowledged: 1, notAcknowledged: 1 })
    expect(asManager.versions).toEqual([{ noticeVersion: '2026-10', workers: 1 }])
    expect(asManager.people.map((entry: Json) => [entry.displayName, entry.acknowledged, entry.acknowledgements.map((ack: Json) => ack.noticeVersion)])).toEqual([
      ['Seed Worker A1-1', true, ['2026-10']],
      ['Seed Worker A1-2', false, []],
    ])
    const asSupervisor = await supervisor.get(`/production/settings/${A.siteA1}/notice-acks`)
    expect(asSupervisor.status).toBe(200)
    expect(asSupervisor.body).toMatchObject({ workers: { active: 2, acknowledged: 1, notAcknowledged: 1 }, people: null })
    expect(JSON.stringify(asSupervisor.body)).not.toContain('Seed Worker')
  })
})

describe('the monitoring switch (MES-278; L. 300/1970 art. 4 c.1)', () => {
  it('naming workers is refused without a legal basis on record, even with a fresh step-up', async () => {
    await stepUp(h, manager.browser, manager.secret)
    const refused = await manager.browser.post(`/production/settings/${A.siteB1}/scan-subject`, { scanSubject: 'WORKER', reason: 'The agreement is coming.' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/legalBasis', message: expect.stringMatching(/^Record the legal basis for naming workers first \(L\. 300\/1970 art\. 4 c\.1\)/) }])
    const noReason = await manager.browser.post(`/production/settings/${A.siteB1}/scan-subject`, { scanSubject: 'WORKER', legalBasis: { kind: 'UNION_AGREEMENT', reference: 'RSU agreement 2027-03' } })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error.issues).toEqual([{ path: 'body/reason', message: 'Say why floor records will name workers from now on.' }])
    expect(await rulesRow(A.siteB1)).toMatchObject({ scanSubject: 'STATION', monitoringBasis: null, version: 1 })
  })

  it('widening (STATION → WORKER) is refused without a fresh step-up, and nothing is recorded', async () => {
    stepUpLapses()
    const refused = await manager.browser.post(`/production/settings/${A.siteB1}/scan-subject`, {
      scanSubject: 'WORKER',
      reason: 'Agreement signed with the RSU.',
      legalBasis: { kind: 'UNION_AGREEMENT', reference: 'RSU agreement 2027-03' },
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect(await rulesRow(A.siteB1)).toMatchObject({ scanSubject: 'STATION', monitoringBasis: null, version: 1 })
    expect(await auditRows(A.siteB1)).toEqual([])
  })

  it('widening with a fresh step-up, a reason and the basis: one command, its audit row with the reason, its event', async () => {
    await stepUp(h, manager.browser, manager.secret)
    const answer = await manager.browser.post(`/production/settings/${A.siteB1}/scan-subject`, {
      scanSubject: 'WORKER',
      reason: 'Agreement signed with the RSU.',
      legalBasis: { kind: 'UNION_AGREEMENT', reference: '  RSU agreement 2027-03  ' },
      version: 1,
    })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toMatchObject({
      changed: true,
      change: 'WIDENED',
      rules: { scanSubject: 'WORKER', version: 2, legalBasis: { kind: 'UNION_AGREEMENT', reference: 'RSU agreement 2027-03', recordedById: manager.userId, recordedByName: 'production manager' } },
      affected: { workersActive: 2, workersNotAcknowledged: 2 },
    })
    expect(answer.body.words).toContain('2 of 2 active workers have not acknowledged the information notice: no scan or cut log names them until they do (L. 300/1970 art. 4 c.3; GDPR art. 13).')
    expect(answer.body.words).toContain('Records already made keep what they recorded: scans and cut logs are never changed.')
    const [audit] = await auditRows(A.siteB1)
    expect(audit).toMatchObject({ action: 'production.changeScanSubject', reason: 'Agreement signed with the RSU.', actorId: manager.userId, before: { scanSubject: 'STATION', monitoringBasis: null }, after: { scanSubject: 'WORKER', monitoringBasis: 'UNION_AGREEMENT' } })
    expect((await events(A.siteB1)).map((row) => row.payload)).toEqual([{ siteId: A.siteB1, scanSubject: 'WORKER', previous: 'STATION', change: 'WIDENED', basisOnRecord: true }])
  })

  it('a stale version is a conflict; the same subject again changes nothing (no audit row, no event)', async () => {
    stepUpLapses()
    const stale = await manager.browser.post(`/production/settings/${A.siteB1}/scan-subject`, { scanSubject: 'STATION', version: 1 })
    expect(stale.status).toBe(409)
    const same = await manager.browser.post(`/production/settings/${A.siteB1}/scan-subject`, { scanSubject: 'WORKER' })
    expect(same.status).toBe(200)
    expect(same.body).toMatchObject({ changed: false, change: null, rules: { version: 2 } })
    expect(await auditRows(A.siteB1)).toHaveLength(1)
  })

  it('replacing the legal basis needs no step-up and keeps the subject; the same basis again changes nothing; a bad one is refused in words', async () => {
    const bad = await manager.browser.post(`/production/settings/${A.siteB1}/legal-basis`, { kind: 'A_HANDSHAKE', reference: ' ' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/kind', 'body/reference'])
    const replaced = await manager.browser.post(`/production/settings/${A.siteB1}/legal-basis`, { kind: 'INL_AUTHORISATION', reference: 'INL authorisation 12/2027', reason: 'The inspectorate replaced the agreement.' })
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200)
    expect(replaced.body).toMatchObject({ changed: true, change: 'BASIS_REPLACED', words: [], rules: { scanSubject: 'WORKER', version: 3, legalBasis: { kind: 'INL_AUTHORISATION' } } })
    const again = await manager.browser.post(`/production/settings/${A.siteB1}/legal-basis`, { kind: 'INL_AUTHORISATION', reference: 'INL authorisation 12/2027' })
    expect(again.body).toMatchObject({ changed: false, rules: { version: 3 } })
    expect((await auditRows(A.siteB1)).map((row) => [row.action, row.reason])).toEqual([
      ['production.changeScanSubject', 'Agreement signed with the RSU.'],
      ['production.recordLegalBasis', 'The inspectorate replaced the agreement.'],
    ])
    expect((await events(A.siteB1)).map((row) => row.payload.change)).toEqual(['WIDENED', 'BASIS_REPLACED'])
  })

  it('production.settings.view alone changes nothing (403)', async () => {
    const answer = await supervisor.post(`/production/settings/${A.siteA1}/scan-subject`, { scanSubject: 'STATION' })
    expect(answer.status).toBe(403)
    expect((await supervisor.post(`/production/settings/${A.siteA1}/legal-basis`, { kind: 'NOT_REQUIRED', reference: 'x' })).status).toBe(403)
  })
})

describe('the database holds the subject: narrowing applies from now on, history is kept (art. 4; GDPR art. 13)', () => {
  let namedScan: string

  it('at a WORKER site a scan naming a worker who has not acknowledged the notice is refused; one who has, passes', async () => {
    await expect(scanAt('qc', { workerId: A.lead, stationId: A.qcStation }, A.lead)).rejects.toThrow(/has not acknowledged the information notice/)
    await expect(scanAt('qc', { workerId: null, stationId: A.qcStation })).rejects.toThrow(/records the worker/)
    namedScan = (await scanAt('qc', { workerId: A.operator, stationId: A.qcStation })).id
  })

  it('narrowing (WORKER → STATION) is always allowed: no step-up, no reason', async () => {
    stepUpLapses()
    const answer = await manager.browser.post(`/production/settings/${A.siteA1}/scan-subject`, { scanSubject: 'STATION', version: 1 })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toMatchObject({ changed: true, change: 'NARROWED', rules: { scanSubject: 'STATION', version: 2, legalBasis: { kind: 'UNION_AGREEMENT' } } })
    expect(answer.body.words[0]).toBe('From now on scans and cut logs at this site name the station only, never the worker. 1 open work order goes on that way.')
    expect((await auditRows(A.siteA1)).map((row) => [row.action, row.reason])).toEqual([['production.changeScanSubject', null]])
  })

  it('after narrowing, a scan naming a worker is refused by the database; a station scan passes; the earlier scan still names its worker', async () => {
    await expect(scanAt('pack', { workerId: A.operator, stationId: A.packStation })).rejects.toThrow(/records the station, not the worker/)
    await expect(scanAt('pack', { workerId: null, stationId: null })).rejects.toThrow(/names its station and no worker/)
    const stationScan = (await scanAt('pack', { workerId: null, stationId: A.packStation })).id
    const rows = await admin<{ id: string; workerId: string | null; stationId: string | null }>('SELECT id, "workerId", "stationId" FROM "OperationScan" WHERE id = ANY($1::uuid[])', [[namedScan, stationScan]])
    expect(new Map(rows.map((row) => [row.id, [row.workerId, row.stationId]]))).toEqual(
      new Map([
        [namedScan, [A.operator, A.qcStation]],
        [stationScan, [null, A.packStation]],
      ]),
    )
  })

  it('the exported reads answer what the triggers will check, in words', async () => {
    await h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, async (client) => {
      expect(await scanSubjectFor(client, A.siteA1)).toBe('STATION')
      expect(await floorRecordSubjectFor(client, { siteId: A.siteA1, workerId: A.operator, stationId: A.packStation })).toEqual({ workerId: null, stationId: A.packStation })
      await expect(floorRecordSubjectFor(client, { siteId: A.siteA1, workerId: A.operator, stationId: null })).rejects.toThrow(InvalidStateError)
    })
    await h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorB1, siteId: A.siteB1 }, async (client) => {
      expect(await scanSubjectFor(client, A.siteB1)).toBe('WORKER')
      await expect(floorRecordSubjectFor(client, { siteId: A.siteB1, workerId: A.operatorB1, stationId: null })).rejects.toThrow(/acknowledge the information notice first/)
    })
    // Another tenant's STATION site reads as the default: row-level security hides its row.
    await h.database.withScope({ audience: 'office', tenantId: B.tenant, actorId: newId() }, async (client) => expect(await scanSubjectFor(client, B.siteB1)).toBe('STATION'))
    await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => expect(await scanSubjectFor(client, B.siteB1)).toBe('WORKER'))
  })
})

describe('the walls', () => {
  it('tenant: another tenant\'s site is not found, and its sites are not listed', async () => {
    expect((await manager.browser.get(`/production/settings/${B.siteA1}`)).status).toBe(404)
    expect(await status('otherTenant', 'GET', `/production/settings/${A.siteA1}`)).toBe(404)
    expect(await status('otherTenant', 'POST', `/production/settings/${A.siteA1}/scan-subject`, { scanSubject: 'STATION' })).toBe(404)
    expect((await ok('otherTenant', '/production/settings')).sites.map((entry: Json) => entry.site.id)).not.toContain(A.siteA1)
  })

  it('company and site: a grant limited to company B or to site B1 sees and changes B1 only', async () => {
    for (const session of ['companyB', 'siteB1']) {
      expect((await ok(session, '/production/settings')).sites.map((entry: Json) => entry.site.id)).toEqual([A.siteB1])
      expect(await status(session, 'GET', `/production/settings/${A.siteA1}`)).toBe(404)
      expect(await status(session, 'GET', `/production/settings/${A.siteA1}/notice-acks`)).toBe(404)
      expect(await status(session, 'POST', `/production/settings/${A.siteA1}/legal-basis`, { kind: 'NOT_REQUIRED', reference: 'Opinion 1/2027' })).toBe(404)
      expect(await status(session, 'GET', `/production/settings/${A.siteB1}`)).toBe(200)
    }
    expect(await status('viewer', 'POST', `/production/settings/${A.siteA1}/scan-subject`, { scanSubject: 'STATION' })).toBe(403)
  })

  it('partner sessions read nothing here', async () => {
    expect(await status('partner', 'GET', '/production/settings')).toBe(403)
    expect(await status('partner', 'GET', `/production/settings/${A.siteA1}`)).toBe(403)
    expect(await status('partner', 'GET', '/production/floor-rules')).toBe(403)
  })
})

describe('the floor reads its own site\'s subject, never the legal basis', () => {
  it('a signed-in worker reads the device site\'s scan subject and whether they acknowledged the notice', async () => {
    const a1 = await ok('floorA1', '/production/floor-rules')
    expect(a1).toEqual({ siteId: A.siteA1, scanSubject: 'STATION', workerAcknowledged: true, standardBundleSize: 10 })
    expect(await ok('floorA1Lead', '/production/floor-rules')).toEqual({ siteId: A.siteA1, scanSubject: 'STATION', workerAcknowledged: false, standardBundleSize: 10 })
    expect(await ok('floorB1', '/production/floor-rules')).toEqual({ siteId: A.siteB1, scanSubject: 'WORKER', workerAcknowledged: false, standardBundleSize: 10 })
    for (const body of [a1, await ok('floorB1', '/production/floor-rules')]) {
      expect(JSON.stringify(body)).not.toMatch(/RSU|INL|UNION_AGREEMENT|INL_AUTHORISATION|NOT_REQUIRED|reference|basis|recorded/i)
    }
  })

  it('the office routes are closed to the floor, whatever its grants; the floor route needs floor.work', async () => {
    for (const url of ['/production/settings', `/production/settings/${A.siteA1}`, `/production/settings/${A.siteA1}/notice-acks`]) {
      expect(await status('floorWithOffice', 'GET', url)).toBe(403)
    }
    expect(await status('floorWithOffice', 'POST', `/production/settings/${A.siteA1}/scan-subject`, { scanSubject: 'WORKER' })).toBe(403)
    expect(await status('floorA1NoWork', 'GET', '/production/floor-rules')).toBe(403)
    expect((await manager.browser.get('/production/floor-rules')).status).toBe(403)
  })
})

describe('the database hides the legal basis from the floor role (B-W1-37; ownership/production.json hiddenColumns)', () => {
  const asFloor = <T>(work: (client: Parameters<Parameters<typeof h.database.withScope>[1]>[0]) => Promise<T>) =>
    h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, work)
  const BASIS_COLUMNS = ['monitoringBasis', 'monitoringReference', 'monitoringRecordedAt', 'monitoringRecordedById']

  it('a floor session cannot select the basis, its reference, or who recorded it, when; scanSubject still reads', async () => {
    for (const column of BASIS_COLUMNS) {
      await expect(asFloor((client) => client.$queryRawUnsafe(`SELECT "${column}" FROM "ProductionSettings"`))).rejects.toThrow(/permission denied/)
    }
    await expect(asFloor((client) => client.$queryRawUnsafe('SELECT * FROM "ProductionSettings"'))).rejects.toThrow(/permission denied/)
    // A model read without a select asks for every column: the floor names what it reads.
    await expect(asFloor((client) => client.productionSettings.findUnique({ where: { id: A.siteA1 } }))).rejects.toThrow(/permission denied/)
    expect(await asFloor((client) => client.$queryRawUnsafe('SELECT id, "scanSubject"::text AS "scanSubject" FROM "ProductionSettings"'))).toEqual([{ id: A.siteA1, scanSubject: 'STATION' }])
    expect(await asFloor((client) => scanSubjectFor(client, A.siteA1))).toBe('STATION')
    // The office still reads every column (the API's office routes show the basis).
    const office = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
      client.productionSettings.findUnique({ where: { id: A.siteA1 }, select: { monitoringBasis: true, monitoringReference: true } }),
    )
    expect(office).toEqual({ monitoringBasis: 'UNION_AGREEMENT', monitoringReference: 'SEED-RSU-AGREEMENT-2026-01' })
  })

  it("the subject guard still reads the site's rules when the floor role fires it", async () => {
    await expect(scanAt('qc', { workerId: A.operator, stationId: A.qcStation }, A.operator, 0)).rejects.toThrow(/records the station, not the worker/)
    expect((await scanAt('qc', { workerId: null, stationId: A.qcStation }, A.operator, 0)).id).toEqual(expect.any(String))
  })
})

describe('the standard bundle size (MES-065): the office sets it per site, audited; the floor reads it; the database holds its range', () => {
  it('changes it at the version read (one audit row, before and after, no monitoring event); the same size again changes nothing', async () => {
    const before = (await manager.browser.get(`/production/settings/${A.siteA1}`)).body
    expect(before.rules).toMatchObject({ standardBundleSize: 10, scanSubject: 'STATION' })
    const url = `/production/settings/${A.siteA1}/bundle-size`
    const answer = await manager.browser.post(url, { standardBundleSize: 12, version: before.rules.version })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body).toMatchObject({ changed: true, change: null, rules: { standardBundleSize: 12, scanSubject: 'STATION', version: before.rules.version + 1 } })
    expect(answer.body.words).toEqual([
      'From now on bundles at this site hold 12 garments when the cutter names no other size; a made-to-measure unit stays one garment per bundle. Bundles already made keep theirs.',
    ])
    const rows = await auditRows(A.siteA1)
    expect(rows.at(-1)).toMatchObject({ action: 'production.changeBundleSize', reason: null, actorId: manager.userId, before: { standardBundleSize: 10 }, after: { standardBundleSize: 12 } })
    expect((await events(A.siteA1)).map((row) => row.payload.change)).toEqual(['NARROWED'])
    const same = await manager.browser.post(url, { standardBundleSize: 12 })
    expect(same.body).toMatchObject({ changed: false, rules: { standardBundleSize: 12, version: before.rules.version + 1 } })
    expect(await auditRows(A.siteA1)).toHaveLength(rows.length)
    expect((await manager.browser.post(url, { standardBundleSize: 8, version: before.rules.version })).status).toBe(409)
    // The floor reads it (its one column of the row: never the basis).
    expect(await ok('floorA1', '/production/floor-rules')).toEqual({ siteId: A.siteA1, scanSubject: 'STATION', workerAcknowledged: true, standardBundleSize: 12 })
    expect(await h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) => standardBundleSizeFor(client, A.siteA1))).toBe(12)
  })

  it('refuses a size out of 1 to 500 (400, and the database for every login), a viewer (403) and another company (404)', async () => {
    const url = `/production/settings/${A.siteA1}/bundle-size`
    expect((await manager.browser.post(url, { standardBundleSize: 0 })).status).toBe(400)
    expect((await manager.browser.post(url, { standardBundleSize: 501 })).status).toBe(400)
    await expect(admin('UPDATE "ProductionSettings" SET "standardBundleSize" = 501 WHERE id = $1', [A.siteA1])).rejects.toThrow(/bundle by 1 to 500 garments, not 501/)
    await expect(admin('UPDATE "ProductionSettings" SET "standardBundleSize" = 0 WHERE id = $1', [A.siteA1])).rejects.toThrow(/bundle by 1 to 500 garments/)
    expect((await supervisor.post(url, { standardBundleSize: 9 })).status).toBe(403)
    expect(await status('companyB', 'POST', url, { standardBundleSize: 9 })).toBe(404)
    expect(await status('floorWithOffice', 'POST', url, { standardBundleSize: 9 })).toBe(403)
    expect((await rulesRow(A.siteA1))).toMatchObject({ scanSubject: 'STATION' })
    expect((await admin('SELECT "standardBundleSize" FROM "ProductionSettings" WHERE id = $1', [A.siteA1]))[0]).toEqual({ standardBundleSize: 12 })
  })
})
