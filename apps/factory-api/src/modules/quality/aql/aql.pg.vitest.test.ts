import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { INSPECTION_LEVELS } from '@nexus/factory-domain/quality/aql/iso2859'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The AQL engine and profiles (B-W2b-93; QHS-013, QHS-020, QHS-021) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_inspection_plans_w2b_guards
 * AqlProfile / AqlProfileAssignment / Inspection_plan_guard triggers are real), tenant A from EVERY seed (AQL-STD, the
 * company default; AQL-EXM for the brand P1; SEED-INS-0009, an OPEN final inspection of WO-0001 on AQL-STD with a result
 * and a measurement, so frozen). Made-up words only.
 *   - profiles: listed with what uses them, critical locked at 0 in words, made, renamed, made the default (the old one
 *     stops being it), retired only when nothing names it, never the default;
 *   - assignments: a customer, a style, a style of one customer; a new profile for a pair replaces the old row (kept
 *     inactive); an assignment ends;
 *   - the chain: style of the customer › style › customer › company default;
 *   - the calculator: ISO 2859-1's plan in words, and the result as counted;
 *   - a work order's plan, an inspection's Sample & AQL (office and the bench), the plan taken from a profile onto an open
 *     inspection (a profile other than the chain's with a reason), refused once counting starts.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/aql`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'aql-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `aql-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  company: id('company:A'),
  site: id('site:A1'),
  wo1: id('production:work-order:WO-0001'),
  style: id('production:style:JKT-02'),
  brand: id('party:P1'),
  member: id('user:member'),
  lead: id('worker:A1:lead'),
  device: id('device:A1:cutting'),
  std: id('inspection-plans:aql:STD'),
  exm: firstId('inspection-plans:aql:EXM'),
  seedInspection: id('inspection-plans:inspection:WO-0001'),
}
const tenantB = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP: Permission[] = ['quality.aql.view', 'quality.aql.manage', 'quality.inspections.view', 'quality.inspections.record']
const office = (tenantId: string, actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, A.member, [grant(KEEP)]),
  viewer: office(A.tenant, newId(), [grant(['quality.aql.view', 'quality.inspections.view'])]),
  // An inspector of the company who did not open the inspection.
  other: office(A.tenant, newId(), [grant(['quality.inspections.view', 'quality.inspections.record'])]),
  nobody: office(A.tenant, newId(), [grant(['sites.view'])]),
  bench: { audience: 'floor', tenantId: A.tenant, actorId: A.lead, siteId: A.site, deviceId: A.device, grants: [grant(['floor.work', 'quality.inspections.view', 'quality.inspections.record'], { companies: [A.company], sites: [A.site] })] },
  keeperB: office(tenantB, newId(), [grant(KEEP)]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PATCH'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const audits = async (recordType: string, recordId: string) =>
  (await admin<{ action: string; after: Json; before: Json; reason: string | null }>(`SELECT action, after, before, reason FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3 ORDER BY at, id`, [A.tenant, recordType, recordId]))
const profileIn = (view: Json, code: string): Json => (view.profiles as Json[]).find((row) => row.code === code)!

/** A fresh OPEN final inspection of WO-0001 with no plan, no profile and nothing counted, opened by the keeper. */
async function openInspection(): Promise<string> {
  const inspectionId = newId()
  await admin(
    `INSERT INTO "Inspection" (id, "tenantId", "companyId", "siteId", "workOrderId", number, "lotSize", "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor", "inspectorUserId", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, 2, 2, 'II', 2.5, 4.0, 0, 0, $7, $7)`,
    [inspectionId, A.tenant, A.company, A.site, A.wo1, `T-INS-${inspectionId.slice(0, 8)}`, A.member],
  )
  return inspectionId
}

beforeAll(async () => {
  db = await migratedDatabase('quality_aql')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'aql-b', 'Gruppo Nuovo')`, [tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the engine and the database agree', () => {
  it('the inspection levels are the database enum AqlInspectionLevel', async () => {
    const levels = (await admin<{ value: string }>(`SELECT unnest(enum_range(NULL::"AqlInspectionLevel"))::text AS value`)).map((row) => row.value)
    expect([...levels].sort()).toEqual([...INSPECTION_LEVELS].sort())
  })
})

describe('the calculator (QHS-020)', () => {
  it('lot 480 · general level II → code letter H → inspect 50; per class AQL, Ac and Re as ISO 2859-1 Table 2-A', async () => {
    const answer = await ok('viewer', 'GET', '/quality/aql/calculate?lotSize=480&level=II&aqlMajor=2.5&aqlMinor=4.0')
    expect(answer.plan).toMatchObject({ codeLetter: 'H', sampleSize: 50, levelText: 'II', hundredPercent: false, words: 'Lot 480 · general level II → code letter H → inspect 50.' })
    expect(answer.plan.classes.map((row: Json) => [row.defectClass, row.aql, row.accept, row.reject])).toEqual([
      ['CRITICAL', '0', 0, 1],
      ['MAJOR', '2.5', 3, 4],
      ['MINOR', '4.0', 5, 6],
    ])
    expect(answer.result).toBeNull()
  })

  it("a profile's numbers, and the result as counted: one more major rejects the lot", async () => {
    const answer = await ok('viewer', 'GET', `/quality/aql/calculate?lotSize=480&profileId=${A.exm}&major=3&minor=1&inspected=38`)
    expect(answer.profile).toMatchObject({ code: 'AQL-EXM' })
    // AQL-EXM: major 1.5, minor 2.5 at H → 2/3 and 3/4.
    expect(answer.plan.classes.map((row: Json) => [row.aql, row.accept])).toEqual([['0', 0], ['1.5', 2], ['2.5', 3]])
    expect(answer.result).toMatchObject({ verdict: 'reject', resultNow: 'FAIL', byCountsOnly: true, progress: { words: '38 of 50 inspected' } })
    const typed = await ok('viewer', 'GET', `/quality/aql/calculate?lotSize=480&profileId=${A.exm}&aqlMajor=2.5&major=3&inspected=38`)
    expect(typed.result.classes[1]).toMatchObject({ state: 'limit', words: 'Major: 3 found, accept up to 3 - passes. One more rejects the lot.' })
  })

  it('refuses what ISO 2859-1 has no plan for, in words; another tenant does not see the profile', async () => {
    expect(paths(await refused('viewer', 'GET', '/quality/aql/calculate?lotSize=480&level=II&aqlMajor=3&aqlMinor=4.0', undefined, 400))).toEqual(['query/aqlMajor'])
    expect(paths(await refused('viewer', 'GET', '/quality/aql/calculate?lotSize=480', undefined, 400))).toEqual(['query/level', 'query/aqlMajor', 'query/aqlMinor'])
    await refused('keeperB', 'GET', `/quality/aql/calculate?lotSize=480&profileId=${A.exm}`, undefined, 404)
    await refused('nobody', 'GET', '/quality/aql/calculate?lotSize=480&level=II&aqlMajor=2.5&aqlMinor=4.0', undefined, 403)
  })
})

describe('AQL profiles (QHS-021)', () => {
  it('lists the seed with what uses each, critical locked at 0 with its law', async () => {
    const view = await ok('viewer', 'GET', `/quality/aql/profiles?companyId=${A.company}`)
    expect(profileIn(view, 'AQL-STD')).toMatchObject({ isDefault: true, active: true, inspectionLevel: 'II', levelText: 'II', aqlCritical: '0', aqlMajor: '2.5', aqlMinor: '4.0' })
    expect(profileIn(view, 'AQL-STD').inspections).toBeGreaterThan(0)
    expect(profileIn(view, 'AQL-EXM')).toMatchObject({ isDefault: false, aqlMajor: '1.5', aqlMinor: '2.5', usedBy: { customers: 1, styles: 0, pairs: 0 } })
    expect(view.criticalLock).toMatchObject({ aql: '0', accept: 0, reject: 1, law: 'Regulation (EU) 2016/425 (PPE), art. 8 and Annex II' })
    expect(view.aqlValues).toContain('0.65')
    expect(view.levels.map((row: Json) => row.text)).toEqual(['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III'])
    expect(view.manageCompanyIds).toEqual([])
    expect((await ok('keeper', 'GET', '/quality/aql/profiles')).manageCompanyIds).toEqual([A.company])
    expect((await ok('keeperB', 'GET', '/quality/aql/profiles')).profiles).toEqual([])
  })

  it('makes a profile; refuses a taken code, an AQL outside Table 2-A and a critical other than 0, in words', async () => {
    const made = await ok('keeper', 'POST', '/quality/aql/profiles', { companyId: A.company, code: 'aql-tight', name: 'Tight jackets', inspectionLevel: 'S-4', aqlMajor: '1.0', aqlMinor: '1.5' }, 201)
    expect(made.profile).toMatchObject({ code: 'AQL-TIGHT', inspectionLevel: 'S4', levelText: 'S-4', aqlMajor: '1.0', aqlMinor: '1.5', isDefault: false, version: 1 })
    expect(made.previousDefaultId).toBeNull()
    expect((await refused('keeper', 'POST', '/quality/aql/profiles', { companyId: A.company, code: 'AQL-TIGHT', name: 'Again', inspectionLevel: 'II', aqlMajor: '1.0', aqlMinor: '1.5' }, 409)).message).toContain('AQL-TIGHT is taken')
    const bad = await refused('keeper', 'POST', '/quality/aql/profiles', { companyId: A.company, code: 'AQL-BAD', name: 'Bad', inspectionLevel: 'IV', aqlMajor: '3.0', aqlMinor: '4.0', aqlCritical: '0.65' }, 400)
    expect(paths(bad)).toEqual(['body/inspectionLevel', 'body/aqlMajor', 'body/aqlCritical'])
    expect(bad.issues[2].message).toContain('a critical defect is never accepted')
    await refused('viewer', 'POST', '/quality/aql/profiles', { companyId: A.company, code: 'AQL-V', name: 'V', inspectionLevel: 'II', aqlMajor: '1.0', aqlMinor: '1.5' }, 403)
    await refused('keeperB', 'POST', '/quality/aql/profiles', { companyId: A.company, code: 'AQL-B', name: 'B', inspectionLevel: 'II', aqlMajor: '1.0', aqlMinor: '1.5' }, 404)
    expect((await events('quality.aql_profile_changed')).at(-1)).toMatchObject({ code: 'AQL-TIGHT', change: 'CREATED', companyId: A.company })
  })

  it('changes a profile at its version; the default moves in one change; the default and a profile in use are never retired', async () => {
    const tight = profileIn(await ok('keeper', 'GET', '/quality/aql/profiles'), 'AQL-TIGHT')
    const renamed = await ok('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: tight.version, name: 'Tight jackets, level II', inspectionLevel: 'II' })
    expect(renamed.profile).toMatchObject({ name: 'Tight jackets, level II', inspectionLevel: 'II', version: tight.version + 1 })
    expect((await refused('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: tight.version, name: 'Stale' }, 409)).message).toMatch(/version/i)
    expect(paths(await refused('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: renamed.profile.version, code: 'AQL-NEW', aqlCritical: '1' }, 400))).toEqual(['body/code', 'body/aqlCritical'])

    const moved = await ok('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: renamed.profile.version, isDefault: true })
    expect(moved).toMatchObject({ previousDefaultId: A.std, profile: { isDefault: true } })
    const after = await ok('keeper', 'GET', '/quality/aql/profiles')
    expect(profileIn(after, 'AQL-STD').isDefault).toBe(false)
    expect((await refused('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: moved.profile.version, active: false }, 409)).message).toContain("is the company's default")
    expect((await refused('keeper', 'PATCH', `/quality/aql/profiles/${A.exm}`, { version: profileIn(after, 'AQL-EXM').version, active: false }, 409)).message).toContain('1 active assignment')

    // AQL-STD back as the default; AQL-TIGHT is free: retired, then made active again.
    const back = await ok('keeper', 'PATCH', `/quality/aql/profiles/${A.std}`, { version: profileIn(after, 'AQL-STD').version, isDefault: true })
    expect(back.previousDefaultId).toBe(tight.id)
    const freed = profileIn(await ok('keeper', 'GET', '/quality/aql/profiles'), 'AQL-TIGHT')
    const retired = await ok('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: freed.version, active: false })
    expect(retired.profile.active).toBe(false)
    const again = await ok('keeper', 'PATCH', `/quality/aql/profiles/${tight.id}`, { version: retired.profile.version, active: true })
    expect(again.profile.active).toBe(true)
    expect((await events('quality.aql_profile_changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['DEFAULT_SET', 'RETIRED', 'REACTIVATED', 'EDITED']))
    expect((await audits('AqlProfile', tight.id)).length).toBeGreaterThanOrEqual(5)
  })
})

describe('assignments and the chain (QHS-021)', () => {
  it("a work order's plan: its customer P1's profile AQL-EXM (the style's old assignment ended long ago), for the office and the bench", async () => {
    const plan = await ok('keeper', 'GET', `/quality/aql/work-orders/${A.wo1}/plan?lotSize=2`)
    expect(plan).toMatchObject({ number: expect.any(String), named: false, profileId: A.exm, chain: { source: 'CUSTOMER', profile: { code: 'AQL-EXM' } } })
    expect(plan.plan).toMatchObject({ codeLetter: 'A', sampleSize: 2, hundredPercent: true })
    expect(plan.chain.steps.map((step: Json) => [step.source, step.profileCode])).toEqual([
      ['PLAN_VERSION', null],
      ['STYLE_CUSTOMER', null],
      ['STYLE', null],
      ['CUSTOMER', 'AQL-EXM'],
      ['COMPANY_DEFAULT', 'AQL-STD'],
    ])
    const bench = await ok('bench', 'GET', `/quality/aql/work-orders/${A.wo1}/plan?lotSize=2&profileId=${A.std}`)
    expect(bench).toMatchObject({ named: true, profileId: A.std })
    expect(paths(await refused('keeper', 'GET', `/quality/aql/work-orders/${A.wo1}/plan?lotSize=2&profileId=${newId()}`, undefined, 400))).toEqual(['query/profileId'])
  })

  it('assigns, replaces and ends; the chain takes the style of the customer, then the style, then the customer', async () => {
    const profiles = await ok('keeper', 'GET', '/quality/aql/profiles')
    const tight = profileIn(profiles, 'AQL-TIGHT')
    const style = await ok('keeper', 'POST', '/quality/aql/assignments', { profileId: tight.id, styleId: A.style }, 201)
    expect(style).toMatchObject({ replacedId: null, assignment: { profileCode: 'AQL-TIGHT', style: { id: A.style }, customer: null, active: true } })
    expect((await ok('keeper', 'GET', `/quality/aql/resolve?companyId=${A.company}&customerId=${A.brand}&styleId=${A.style}`)).chain).toMatchObject({ source: 'STYLE', profile: { code: 'AQL-TIGHT' } })
    expect((await refused('keeper', 'POST', '/quality/aql/assignments', { profileId: tight.id, styleId: A.style }, 409)).message).toContain('already assigned')

    const replaced = await ok('keeper', 'POST', '/quality/aql/assignments', { profileId: A.std, styleId: A.style }, 201)
    expect(replaced.replacedId).toBe(style.assignment.id)
    const rows = (await ok('keeper', 'GET', `/quality/aql/assignments?styleId=${A.style}`)).assignments as Json[]
    expect(rows.filter((row) => row.active).map((row) => row.profileCode)).toEqual(['AQL-STD'])
    expect(rows.find((row) => row.id === style.assignment.id)).toMatchObject({ active: false })

    const pair = await ok('keeper', 'POST', '/quality/aql/assignments', { profileId: tight.id, styleId: A.style, customerId: A.brand }, 201)
    expect((await ok('viewer', 'GET', `/quality/aql/resolve?companyId=${A.company}&customerId=${A.brand}&styleId=${A.style}`)).chain).toMatchObject({ source: 'STYLE_CUSTOMER', profile: { code: 'AQL-TIGHT' } })
    const ended = await ok('keeper', 'POST', `/quality/aql/assignments/${pair.assignment.id}/end`, { version: pair.assignment.version })
    expect(ended.assignment.active).toBe(false)
    expect((await refused('keeper', 'POST', `/quality/aql/assignments/${pair.assignment.id}/end`, { version: ended.assignment.version }, 409)).message).toContain('already ended')
    await ok('keeper', 'POST', `/quality/aql/assignments/${replaced.assignment.id}/end`, { version: replaced.assignment.version })
    expect((await ok('viewer', 'GET', `/quality/aql/resolve?companyId=${A.company}&customerId=${A.brand}&styleId=${A.style}`)).chain).toMatchObject({ source: 'CUSTOMER', profile: { code: 'AQL-EXM' } })
    expect((await events('quality.aql_assignment_changed')).map((event) => event.change)).toEqual(['ASSIGNED', 'REPLACED', 'ASSIGNED', 'ENDED', 'ENDED'])
  })

  it('refuses an assignment to no one, to a party that is no customer, and by a viewer', async () => {
    expect(paths(await refused('keeper', 'POST', '/quality/aql/assignments', { profileId: A.std }, 400))).toEqual(['body/customerId'])
    const [supplier] = await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND NOT ('CUSTOMER' = ANY (roles)) AND NOT ('BRAND' = ANY (roles)) LIMIT 1`, [A.tenant])
    expect(paths(await refused('keeper', 'POST', '/quality/aql/assignments', { profileId: A.std, customerId: supplier!.id }, 400))).toEqual(['body/customerId'])
    await refused('viewer', 'POST', '/quality/aql/assignments', { profileId: A.std, customerId: A.brand }, 403)
  })
})

describe("an inspection's Sample & AQL and its plan from a profile (QHS-013, QHS-021)", () => {
  it('the seeded inspection: on AQL-STD, frozen (a result and a measurement), the numbers are the profile\'s; office and bench', async () => {
    const view = await ok('keeper', 'GET', `/quality/aql/inspections/${A.seedInspection}`)
    expect(view).toMatchObject({ profile: { code: 'AQL-STD' }, frozen: true, matchesProfile: true, differences: [], fixedSample: false, mayApply: false })
    expect(view.frozenWords).toBe('The profile is frozen once counting starts: 1 check result, 1 measurement recorded.')
    expect(view.plan).toMatchObject({ codeLetter: 'A', sampleSize: 2, hundredPercent: true })
    expect(view.result).toMatchObject({ verdict: 'open', resultNow: 'PASS' })
    expect(view.chain.source).toBe('CUSTOMER')
    const bench = await ok('bench', 'GET', `/quality/aql/inspections/${A.seedInspection}`)
    expect(bench).toMatchObject({ frozen: true, mayApply: false })
    expect((await refused('bench', 'POST', `/quality/aql/inspections/${A.seedInspection}/profile`, { version: view.inspection.version }, 409)).message).toBe(view.frozenWords)
  })

  it('takes the chain\'s profile onto an open inspection: code letter, sample, acceptance numbers, with its event and audit', async () => {
    const inspectionId = await openInspection()
    const before = await ok('keeper', 'GET', `/quality/aql/inspections/${inspectionId}`)
    expect(before).toMatchObject({ profile: null, plan: null, matchesProfile: null, frozen: false, mayApply: true })
    expect(before.words).toBe('Lot 2 · level II → inspect 2 (typed by hand).')
    await refused('other', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: before.inspection.version }, 403)

    const applied = await ok('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: before.inspection.version })
    expect(applied).toMatchObject({ profile: { code: 'AQL-EXM' }, matchesProfile: true, inspection: { codeLetter: 'A', sampleSize: 2, inspectionLevel: 'II', aqlMajor: '1.5', aqlMinor: '2.5', acceptMajor: 0, acceptMinor: 0, version: before.inspection.version + 1 } })
    expect((await events('quality.inspection_sampling_set')).at(-1)).toEqual({ inspectionId, workOrderId: A.wo1, profileId: A.exm, source: 'CUSTOMER', codeLetter: 'A', lotSize: 2, sampleSize: 2, acceptMajor: 0, acceptMinor: 0 })
    const [audit] = (await audits('Inspection', inspectionId)).slice(-1)
    expect(audit).toMatchObject({ action: 'quality.aql.applyProfile', reason: null, after: { profileCode: 'AQL-EXM', source: 'CUSTOMER', codeLetter: 'A' }, before: { aqlProfileId: null } })

    // Another profile than the chain's: only with a reason, which the audit row keeps.
    expect(paths(await refused('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: applied.inspection.version, profileId: A.std }, 400))).toEqual(['body/reason'])
    expect(paths(await refused('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: applied.inspection.version, reason: 'Not needed here' }, 400))).toEqual(['body/reason'])
    const named = await ok('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: applied.inspection.version, profileId: A.std, reason: 'The customer agreed the company standard for this lot.' })
    expect(named).toMatchObject({ profile: { code: 'AQL-STD' }, inspection: { aqlMajor: '2.5', aqlMinor: '4.0' } })
    expect((await audits('Inspection', inspectionId)).at(-1)).toMatchObject({ reason: 'The customer agreed the company standard for this lot.', after: { source: 'NAMED', profileCode: 'AQL-STD' } })
    expect((await refused('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: applied.inspection.version }, 409)).message).toMatch(/version/i)
    const pieces = (await admin<{ n: number }>(`SELECT sum(quantity)::int AS n FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [A.wo1]))[0]!.n
    expect(paths(await refused('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: named.inspection.version, lotSize: pieces + 1 }, 400))).toEqual(['body/lotSize'])

    // Counting starts (a defect): the profile is frozen, by the API in words and by the database below it.
    await admin(`INSERT INTO "InspectionDefect" (id, "tenantId", "siteId", "workOrderId", "inspectionId", "defectClass", code, quantity) VALUES ($1, $2, $3, $4, $5, 'MINOR', 'STITCH-SKIP', 1)`, [newId(), A.tenant, A.site, A.wo1, inspectionId])
    expect((await refused('keeper', 'POST', `/quality/aql/inspections/${inspectionId}/profile`, { version: named.inspection.version }, 409)).message).toBe('The profile is frozen once counting starts: 1 defect line recorded.')
    await expect(admin(`UPDATE "Inspection" SET "aqlProfileId" = $1 WHERE id = $2`, [A.exm, inspectionId])).rejects.toThrow(/frozen once counting starts/)
    const counted = await ok('keeper', 'GET', `/quality/aql/inspections/${inspectionId}`)
    expect(counted).toMatchObject({ frozen: true, mayApply: false, counts: { critical: 0, major: 0, minor: 1 } })
    // AQL-STD at lot 2: minor accepts 0 (the whole lot, n 3 at B) — one minor fails it on the numbers alone.
    expect(counted.result).toMatchObject({ resultNow: 'FAIL', byCountsOnly: true, verdict: 'reject' })
    expect(counted.result.overrideWords).toContain('its release needs a second person')
  })

  it('an inspection out of reach is not found', async () => {
    await refused('keeperB', 'GET', `/quality/aql/inspections/${A.seedInspection}`, undefined, 404)
    await refused('keeper', 'GET', `/quality/aql/inspections/${newId()}`, undefined, 404)
  })
})
