import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { approvalSha256, type CheckContent, type SamplingDraft } from '@nexus/factory-domain/quality/plans/rules'
import { STARTER_PLANS } from '@nexus/factory-domain/quality/plans/starter'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { inspectionPlans } from '../../../platform/exports/sources/inspection-plans'
import { systemContext } from '../../../platform/outbox/system'
import planIndexer from '../../../platform/search/indexers/inspection-plan'
import { rebuildIndex } from '../../../platform/search/indexing'

/**
 * Inspection plans (B-W2b-92; QHS-008 templates, QHS-009 check types, QHS-016 versions approved by a second person and
 * frozen on each record) through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security and the …_inspection_plans_w2b_guards triggers are real), tenant A from EVERY seed
 * (B-W2b-76's FIN-JACKET v1 APPROVED + v2 DRAFT, INC-LEATHER v1, INL-FIRST v1 with the records that ran on them and
 * three rules). Approvals are signed by real office people with a fresh code (the harness's sign-in and step-up).
 * Made-up words only.
 *   - the Plans grid, the plan record with its versions, the comparison and "applies to", the records on a version;
 *   - the starter set; a new plan blank, from the starter set or a copy; name, owner and chips;
 *   - the builder's save of a draft (checks kept, added, removed, in order; sampling), asking for approval;
 *   - approval: never the author nor an editor; the version in force retired in the same command; the signature over the
 *     content; a record keeps the version it ran on;
 *   - the next draft, retiring, the printable checklist, the version a record runs on (office and floor);
 *   - the search entries and the export of the grid.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/plans`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'plans-a'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  brandP1: id('party:P1'),
  final: firstId('inspection-plans:plan:FIN-JACKET'),
  incoming: id('inspection-plans:plan:INC-LEATHER'),
  inLine: id('inspection-plans:plan:INL-FIRST'),
  vFinal1: id('inspection-plans:version:FIN-JACKET:1'),
  vFinal2: firstId('inspection-plans:version:FIN-JACKET:2'),
  vIncoming1: id('inspection-plans:version:INC-LEATHER:1'),
  inspection: id('inspection-plans:inspection:WO-0001'),
  operator: id('worker:A1:operator'),
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

let h: Harness
let app: FastifyInstance
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP: Permission[] = ['quality.plans.view', 'quality.plans.manage']
const keeperId = newId()
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: A.tenant, actorId: keeperId, grants: [grant(KEEP)] },
  viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['quality.plans.view'])] },
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(KEEP, { companies: [A.companyB] })] },
  nobody: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['sites.view'])] },
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: id('device:A1:cutting'), grants: [grant(['floor.work'], { companies: [A.companyA], sites: [A.siteA1] })] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `plans-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const approve = async (person: Person, planId: string, versionId: string, status = 200) => {
  await stepUp(h, person.browser, person.secret)
  const { version } = await as(person, 'GET', `/quality/plans/${planId}/versions/${versionId}`)
  return as(person, 'POST', `/quality/plans/${planId}/versions/${versionId}/approve`, { version: version.version }, status)
}

const ce = { code: 'CE_MARK', labelIt: 'Marcatura CE', labelEn: 'CE marking', type: 'PASS_FAIL', checkClass: 'CRITICAL' }
const chest = { code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Chest half', type: 'MEASUREMENT', checkClass: 'MAJOR', nominal: '58', tolerance: '1', uom: 'CM' }
const read = { code: 'READ', labelIt: 'Leggere la scheda', labelEn: 'Read the sheet', type: 'INSTRUCTION' }
const shade = { code: 'SHADE', labelIt: 'Tono', labelEn: 'Shade', labelI18n: { ro: 'Nuanță' }, type: 'CHOICE', checkClass: 'MAJOR', choices: ['A', 'B', 'C'] }

let qa1: Person
let qa2: Person
let manager: Person
const refs: Record<string, string> = {}

beforeAll(async () => {
  h = await startHarness('quality_plans')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (quality.plans.* for the quality inspector and the production manager).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  qa1 = await signedIn('qa.one@example.com', 'quality_inspector')
  qa2 = await signedIn('qa.two@example.com', 'quality_inspector')
  manager = await signedIn('pm.one@example.com', 'production_manager')
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "updatedAt") VALUES ($1, $2, 'keeper@example.com', 'Plan Keeper', 'ACTIVE', now())`, [keeperId, A.tenant])
  refs.style = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND ("companyId" = $2 OR "companyId" IS NULL) ORDER BY code LIMIT 1`, [A.tenant, A.companyA]))[0]!.id
  refs.supplier = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND 'SUPPLIER' = ANY (roles) ORDER BY code LIMIT 1`, [A.tenant]))[0]!.id
  refs.operation = (await admin<{ id: string }>(`SELECT id FROM "Operation" WHERE "tenantId" = $1 AND ("companyId" = $2 OR "companyId" IS NULL) ORDER BY code LIMIT 1`, [A.tenant, A.companyA]))[0]!.id
  refs.invited = (await admin<{ id: string }>(`SELECT id FROM "User" WHERE "tenantId" = $1 AND status = 'INVITED' LIMIT 1`, [A.tenant]))[0]!.id
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('the Plans grid and the plan record (QHS-008)', () => {
  it('every plan of the companies the caller reaches, in stage order, with what it runs on and what ran on it', async () => {
    const grid = await ok('keeper', 'GET', '/quality/plans')
    expect(grid.plans.map((plan: Json) => [plan.code, plan.stage, plan.status, plan.approved?.number ?? null, plan.draft?.number ?? null, plan.usedBy])).toEqual([
      ['INC-LEATHER', 'INCOMING', 'APPROVED', 1, null, 2],
      ['INL-FIRST', 'IN_LINE', 'APPROVED', 1, null, 1],
      ['FIN-JACKET', 'FINAL', 'APPROVED', 1, 2, 1],
    ])
    const final = grid.plans.find((plan: Json) => plan.code === 'FIN-JACKET')
    expect(final.appliesTo).toEqual([{ kind: 'CATEGORY', value: 'JACKET', label: 'Jackets', kindWords: { it: 'Categoria', en: 'Category' } }])
    expect(final.stageWords).toEqual({ it: 'Finale', en: 'Final' })
    expect(grid.counts.byStage).toMatchObject({ INCOMING: 1, IN_LINE: 1, FINAL: 1, CUTTING: 0 })
    expect(grid).toMatchObject({ truncated: false, canManage: true, canApprove: false })
    expect((await ok('keeper', 'GET', '/quality/plans?stage=FINAL')).plans.map((plan: Json) => plan.code)).toEqual(['FIN-JACKET'])
    expect((await ok('keeper', 'GET', '/quality/plans?q=leather')).plans.map((plan: Json) => plan.code)).toEqual(['INC-LEATHER'])
    expect((await ok('keeper', 'GET', '/quality/plans?status=DRAFT')).plans).toEqual([])
    // Another company's keeper sees none of company A's plans; a person without the right is refused.
    expect((await ok('companyB', 'GET', '/quality/plans')).plans).toEqual([])
    expect((await refused('nobody', 'GET', '/quality/plans', undefined, 403)).code).toBe('forbidden')
  })

  it('the record: versions, the draft the builder opens compared with the approved one, applies to, what the caller may do', async () => {
    const record = await ok('keeper', 'GET', `/quality/plans/${A.final}`)
    expect(record.versions.map((version: Json) => [version.number, version.status, version.checks, version.usedBy.records])).toEqual([[2, 'DRAFT', 1, 0], [1, 'APPROVED', 3, 1]])
    expect(record.current).toMatchObject({ number: 2, status: 'DRAFT', changeNote: 'Adds the reflective panels.', problems: [], submitted: null })
    expect(record.current.checks.map((check: Json) => [check.code, check.type, check.checkClass, check.mandatory])).toEqual([['CE_MARK', 'PASS_FAIL', 'CRITICAL', true]])
    expect(record.comparison).toMatchObject({ fromNumber: 1, toNumber: 2, added: [], removed: [{ code: 'CHEST' }, { code: 'READ' }], same: false })
    expect(record.preview.subject).toBe('styles')
    expect(record.preview.count).toBeLessThanOrEqual(record.preview.outOf)
    expect(record.rules).toBe(0)
    expect(record.may).toEqual({ manage: true, approve: false, approveHeld: 'Approving a plan version needs quality.plans.approve for this company.' })
    // Another company's plan is not said to exist.
    expect((await refused('companyB', 'GET', `/quality/plans/${A.final}`, undefined, 404)).message).toBe('Inspection plan not found.')
    const incoming = await ok('keeper', 'GET', `/quality/plans/${A.incoming}`)
    expect(incoming.rules).toBe(1)
    expect(incoming.preview.subject).toBe('materials')
    expect(incoming.current.sampling).toMatchObject({ samplingMethod: 'AQL_PROFILE', profile: { code: 'AQL-STD', inspectionLevel: 'II' }, frequency: 'EVERY_LOT', words: { sample: { en: 'AQL profile AQL-STD (Company standard)' }, frequency: { it: 'Ogni lotto' } } })
  })

  it('one version with the records that ran on it (QHS-016)', async () => {
    const v1 = await ok('keeper', 'GET', `/quality/plans/${A.final}/versions/${A.vFinal1}`)
    expect(v1.version.usedBy).toEqual({ final: 1, incoming: 0, inProcess: 0, records: 1 })
    expect(v1.records.map((row: Json) => [row.kind, row.number])).toEqual([['FINAL', 'SEED-INS-0009']])
    expect(v1.version.checks.find((check: Json) => check.code === 'CHEST')).toMatchObject({ nominal: '58.000', tolerance: '1.000', uom: 'CM', spec: { en: '58.000 ± 1.000 cm' } })
    expect(v1.comparison.fromNumber).toBeNull()
    const incoming = await ok('keeper', 'GET', `/quality/plans/${A.incoming}/versions/${A.vIncoming1}`)
    expect(incoming.records.map((row: Json) => [row.kind, row.number]).sort()).toEqual([['INCOMING', 'SEED-IIN-0001'], ['INCOMING', 'SEED-IIN-0002']])
    expect((await refused('keeper', 'GET', `/quality/plans/${A.incoming}/versions/${A.vFinal1}`, undefined, 404)).message).toBe('Plan version not found.')
  })
})

describe('the starter set and new plans', () => {
  it('adds the leather-apparel plans the company lacks, each a draft by the person who adds it; then nothing', async () => {
    const before = await ok('keeper', 'GET', `/quality/plans/starter?companyId=${A.companyA}`)
    expect(before.plans.filter((plan: Json) => plan.missing).map((plan: Json) => plan.code)).toEqual(['CUT-PANELS', 'EOL-GARMENT', 'RET-GARMENT'])
    expect(paths(await refused('keeper', 'POST', '/quality/plans/starter', { companyId: A.companyA, codes: ['NOPE'] }, 400))).toEqual(['body/codes/0'])
    const { added } = await ok('keeper', 'POST', '/quality/plans/starter', { companyId: A.companyA, language: 'it' })
    expect(added.map((plan: Json) => plan.code)).toEqual(['CUT-PANELS', 'EOL-GARMENT', 'RET-GARMENT'])
    const cut = await ok('keeper', 'GET', `/quality/plans/${added[0].planId}`)
    expect(cut.plan).toMatchObject({ name: 'Controllo al taglio', stage: 'CUTTING', status: 'DRAFT', owner: { id: keeperId, name: 'Plan Keeper' } })
    expect(cut.current).toMatchObject({ number: 1, status: 'DRAFT', author: { id: keeperId }, problems: [] })
    expect(cut.current.checks.map((check: Json) => check.code)).toEqual(STARTER_PLANS.find((plan) => plan.code === 'CUT-PANELS')!.checks.map((check) => check.code))
    expect((await ok('keeper', 'POST', '/quality/plans/starter', { companyId: A.companyA })).added).toEqual([])
    expect((await events('inspection_plan.changed')).filter((payload) => payload.change === 'CREATED').map((payload) => payload.code)).toEqual(['CUT-PANELS', 'EOL-GARMENT', 'RET-GARMENT'])
  })

  it('a new plan: blank, from a starter plan of its stage, or a copy; the code fixed and once per company', async () => {
    const blank = await ok('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'fin-trousers', stage: 'FINAL', name: 'Final, trousers', ownerId: keeperId, appliesTo: [{ kind: 'CATEGORY', value: 'TROUSERS' }, { kind: 'CUSTOMER', value: A.brandP1 }] }, 201)
    expect(blank.plan).toMatchObject({ code: 'FIN-TROUSERS', status: 'DRAFT', latestNumber: 1 })
    expect(blank.plan.appliesTo.map((chip: Json) => [chip.kind, chip.label.length > 1])).toEqual([['CATEGORY', true], ['CUSTOMER', true]])
    expect(blank.current).toMatchObject({ checks: [], problems: [{ path: 'checks' }] })
    refs.trousers = blank.plan.id
    const copy = await ok('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'FIN-VEST', stage: 'FINAL', name: 'Final, vests', startFrom: { kind: 'COPY', versionId: A.vFinal1 } }, 201)
    expect(copy.current.checks.map((check: Json) => check.code)).toEqual(['CE_MARK', 'CHEST', 'READ'])
    const starter = await ok('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'INL-GLOVES', stage: 'IN_LINE', name: 'First piece, gloves', startFrom: { kind: 'STARTER', code: 'INL-FIRST' } }, 201)
    expect(starter.current.sampling).toMatchObject({ samplingMethod: 'FIXED', fixedSampleSize: 1, frequency: 'FIRST_PIECE' })
    expect(paths(await refused('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'X-1', stage: 'FINAL', name: 'x', startFrom: { kind: 'STARTER', code: 'INL-FIRST' } }, 400))).toEqual(['body/startFrom/code'])
    expect(paths(await refused('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'FIN-JACKET', stage: 'FINAL', name: 'Again' }, 409))).toEqual(['refusal/CODE_TAKEN', 'body/code'])
    expect(paths(await refused('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'BAD ONE', stage: 'FINAL', name: '' }, 400))).toEqual(['body/code', 'body/name'])
    expect(paths(await refused('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'X-2', stage: 'FINAL', name: 'x', ownerId: refs.invited, appliesTo: [{ kind: 'SUPPLIER', value: A.brandP1 }, { kind: 'STYLE', value: newId() }] }, 400))).toEqual(['body/appliesTo/0/value', 'body/appliesTo/1/value', 'body/ownerId'])
    expect((await refused('companyB', 'POST', '/quality/plans', { companyId: A.companyA, code: 'X-3', stage: 'FINAL', name: 'x' }, 403)).message).toMatch(/quality.plans.manage/)
    expect((await refused('viewer', 'POST', '/quality/plans', { companyId: A.companyA, code: 'X-4', stage: 'FINAL', name: 'x' }, 403)).code).toBe('forbidden')
  })

  it('name, owner and where it applies change at the version read; code and stage never', async () => {
    const record = await ok('keeper', 'GET', `/quality/plans/${refs.trousers}`)
    const changed = await ok('keeper', 'PATCH', `/quality/plans/${refs.trousers}`, { version: record.plan.version, name: 'Final, trousers and suits', ownerId: null, appliesTo: [{ kind: 'CATEGORY', value: 'TROUSERS' }, { kind: 'CATEGORY', value: 'SUIT' }, { kind: 'STYLE', value: refs.style }, { kind: 'OPERATION', value: refs.operation }, { kind: 'SUPPLIER', value: refs.supplier }] })
    expect(changed.plan).toMatchObject({ name: 'Final, trousers and suits', owner: null })
    expect(changed.plan.appliesTo.map((chip: Json) => chip.label).every((label: string) => label !== '?')).toBe(true)
    expect((await refused('keeper', 'PATCH', `/quality/plans/${refs.trousers}`, { version: record.plan.version, name: 'Stale' }, 409)).code).toBe('conflict')
    expect((await refused('keeper', 'PATCH', `/quality/plans/${refs.trousers}`, { version: changed.plan.version, code: 'OTHER' }, 400)).code).toBe('validation_failed')
    expect((await events('inspection_plan.changed')).filter((payload) => payload.change === 'EDITED' && payload.planId === refs.trousers)).toHaveLength(1)
  })
})

describe('the builder (QHS-009) and asking for approval', () => {
  it('saves the whole list in its order: codes kept are changed in place, new ones added, the rest removed; sampling', async () => {
    const record = await ok('keeper', 'GET', `/quality/plans/${refs.trousers}`)
    const v1 = record.current
    const saved = await ok('keeper', 'PUT', `/quality/plans/${refs.trousers}/versions/${v1.id}`, { version: v1.version, changeNote: 'First list.', checks: [ce, chest, read, shade], sampling: { samplingMethod: 'FIXED', fixedSampleSize: 5, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 10, stopAtReject: true } })
    expect(saved.version.checks.map((check: Json) => [check.code, check.sortOrder, check.mandatory])).toEqual([['CE_MARK', 10, true], ['CHEST', 20, true], ['READ', 30, false], ['SHADE', 40, true]])
    expect(saved.version).toMatchObject({ changeNote: 'First list.', problems: [], sampling: { samplingMethod: 'FIXED', fixedSampleSize: 5, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 10, stopAtReject: true, words: { frequency: { en: 'Every 10th bundle' } } } })
    const ceId = saved.version.checks[0].id
    const again = await ok('keeper', 'PUT', `/quality/plans/${refs.trousers}/versions/${v1.id}`, { version: saved.version.version, checks: [{ ...chest, tolerance: '0.5' }, ce, shade] })
    expect(again.version.checks.map((check: Json) => [check.code, check.sortOrder, check.tolerance])).toEqual([['CHEST', 10, '0.500'], ['CE_MARK', 20, null], ['SHADE', 30, null]])
    expect(again.version.checks[1].id).toBe(ceId)
    expect(again.version.changeNote).toBe('First list.')
    // Refused in words, every problem at once; a stale save; an approved version is frozen.
    expect(paths(await refused('keeper', 'PUT', `/quality/plans/${refs.trousers}/versions/${v1.id}`, { version: again.version.version, checks: [{ ...chest, tolerance: null }, { ...read, mandatory: true }, ce, ce], sampling: { samplingMethod: 'FIXED' } }, 400))).toEqual(['body/checks/0/nominal', 'body/checks/1/type', 'body/checks/3/code', 'body/sampling/fixedSampleSize'])
    expect(paths(await refused('keeper', 'PUT', `/quality/plans/${refs.trousers}/versions/${v1.id}`, { version: again.version.version, sampling: { samplingMethod: 'AQL_PROFILE', aqlProfileId: newId() } }, 400))).toEqual(['body/sampling/aqlProfileId'])
    expect((await refused('keeper', 'PUT', `/quality/plans/${refs.trousers}/versions/${v1.id}`, { version: saved.version.version, changeNote: 'stale' }, 409)).code).toBe('conflict')
    expect(paths(await refused('keeper', 'PUT', `/quality/plans/${A.final}/versions/${A.vFinal1}`, { version: 1, changeNote: 'x' }, 409))).toEqual(['refusal/NOT_DRAFT'])
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "InspectionPlanCheck" WHERE "planVersionId" = $1`, [A.vFinal1]))[0]!.n).toBe(3)
  })

  it('asks for approval only when the draft is approvable; a later save takes the ask back', async () => {
    const empty = await ok('keeper', 'POST', '/quality/plans', { companyId: A.companyA, code: 'EOL-EMPTY', stage: 'END_OF_LINE', name: 'Nothing yet' }, 201)
    const notReady = await refused('keeper', 'POST', `/quality/plans/${empty.plan.id}/versions/${empty.current.id}/submit`, { version: empty.current.version }, 409)
    expect(paths(notReady)).toEqual(['refusal/NOT_READY', 'version/checks'])
    const record = await ok('keeper', 'GET', `/quality/plans/${refs.trousers}`)
    const { version } = await ok('keeper', 'POST', `/quality/plans/${refs.trousers}/versions/${record.current.id}/submit`, { version: record.current.version, note: 'Ready for a look.' })
    expect(version.submitted).toMatchObject({ by: { id: keeperId, name: 'Plan Keeper' }, note: 'Ready for a look.' })
    const grid = await ok('keeper', 'GET', '/quality/plans?stage=FINAL')
    expect(grid.plans.find((plan: Json) => plan.id === refs.trousers).draft.submitted).toBe(true)
    expect(grid.counts.waitingApproval).toBe(1)
    const resaved = await ok('keeper', 'PUT', `/quality/plans/${refs.trousers}/versions/${version.id}`, { version: version.version, changeNote: 'One more look.' })
    expect(resaved.version.submitted).toBeNull()
    expect((await events('inspection_plan.changed')).filter((payload) => payload.change === 'SUBMITTED').map((payload) => payload.code)).toEqual(['FIN-TROUSERS'])
  })
})

describe('approval by a second person (QHS-016)', () => {
  it('never the author, never someone who changed the draft; another person signs with a fresh code', async () => {
    const made = await as(qa1, 'POST', '/quality/plans', { companyId: A.companyA, code: 'CUT-QA', stage: 'CUTTING', name: 'Cutting, by quality', startFrom: { kind: 'STARTER', code: 'CUT-PANELS' } }, 201)
    const planId = made.plan.id
    const draftId = made.current.id
    expect(made.may.approveHeld).toBe('You wrote version 1: a second person approves it (QHS-016).')
    // Without a fresh code: the step-up first.
    const noCode = await qa1.browser.send('POST', `/quality/plans/${planId}/versions/${draftId}/approve`, { version: made.current.version }, { headers: { 'idempotency-key': freshKey() } })
    expect(noCode.status).toBe(403)
    const own = await approve(qa1, planId, draftId, 409)
    expect(own.error.issues[0]).toEqual({ path: 'refusal/AUTHOR', message: 'You wrote version 1: a second person approves it (QHS-016).' })
    // qa2 changes the draft: then qa2 is no second person either.
    const { version } = await as(qa2, 'GET', `/quality/plans/${planId}/versions/${draftId}`)
    await as(qa2, 'PUT', `/quality/plans/${planId}/versions/${draftId}`, { version: version.version, changeNote: 'Notches checked too.' })
    expect((await approve(qa2, planId, draftId, 409)).error.issues[0].path).toBe('refusal/EDITOR')
    // The production manager approves: frozen with its checks, the signature over what was approved.
    const approved = await approve(manager, planId, draftId)
    expect(approved).toMatchObject({ version: { number: 1, status: 'APPROVED', approvedBy: { id: manager.id } }, retired: null })
    const view = approved.version
    const sampling: SamplingDraft = { samplingMethod: view.sampling.samplingMethod, aqlProfileId: view.sampling.aqlProfileId, fixedSampleSize: view.sampling.fixedSampleSize, frequency: view.sampling.frequency, frequencyValue: view.sampling.frequencyValue, stopAtReject: view.sampling.stopAtReject }
    const checks: CheckContent[] = view.checks.map((check: Json) => ({ code: check.code, labelIt: check.labelIt, labelEn: check.labelEn, labelI18n: check.labelI18n, type: check.type, checkClass: check.checkClass, mandatory: check.mandatory, photoRequired: check.photoRequired, nominal: check.nominal, tolerance: check.tolerance, uom: check.uom, choices: check.choices }))
    expect(view.approvalSha256).toBe(approvalSha256({ planId, planCode: 'CUT-QA', stage: 'CUTTING', versionId: draftId, number: 1, approvedById: manager.id, approvedAt: view.approvedAt, sampling, checks }))
    // Frozen: the database refuses a check change, and the route says why.
    await expect(admin(`UPDATE "InspectionPlanCheck" SET "labelEn" = 'changed' WHERE "planVersionId" = $1`, [draftId])).rejects.toThrow(/checks change only while it is DRAFT/)
    expect(paths(await approve(manager, planId, draftId, 409).then((answer) => answer.error))).toEqual(['refusal/NOT_DRAFT'])
    // A person without the right is refused before anything is read.
    expect((await refused('viewer', 'POST', `/quality/plans/${planId}/versions/${draftId}/approve`, { version: 1 }, 403)).code).toBe('forbidden')
  })

  it('approving the next version retires the one in force in the same command; a record keeps the version it ran on', async () => {
    const answer = await approve(manager, A.final, A.vFinal2)
    expect(answer).toMatchObject({ version: { id: A.vFinal2, status: 'APPROVED' }, retired: { id: A.vFinal1, number: 1 } })
    const rows = await admin<{ id: string; status: string; retiredById: string | null }>(`SELECT id, status::text, "retiredById" FROM "InspectionPlanVersion" WHERE "planId" = $1 ORDER BY number`, [A.final])
    expect(rows).toEqual([{ id: A.vFinal1, status: 'RETIRED', retiredById: manager.id }, { id: A.vFinal2, status: 'APPROVED', retiredById: null }])
    // SEED-INS-0009 ran on v1 and keeps it; the database refuses to move it.
    expect((await admin<{ planVersionId: string }>(`SELECT "planVersionId" FROM "Inspection" WHERE id = $1`, [A.inspection]))[0]!.planVersionId).toBe(A.vFinal1)
    await expect(admin(`UPDATE "Inspection" SET "planVersionId" = $2 WHERE id = $1`, [A.inspection, A.vFinal2])).rejects.toThrow(/plan version/)
    expect((await events('inspection_plan.version_approved')).find((payload) => payload.versionId === A.vFinal2)).toEqual({ planId: A.final, code: 'FIN-JACKET', stage: 'FINAL', versionId: A.vFinal2, number: 2, retiredVersionId: A.vFinal1 })
    const audit = await admin<{ action: string; recordId: string }>(`SELECT action, "recordId" FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" IN ($2, $3) AND action IN ('quality.approvePlanVersion', 'quality.retirePlanVersion') ORDER BY at, id`, [A.tenant, A.vFinal1, A.vFinal2])
    expect(audit).toEqual([{ action: 'quality.retirePlanVersion', recordId: A.vFinal1 }, { action: 'quality.approvePlanVersion', recordId: A.vFinal2 }])
  })
})

describe('the next draft and retiring', () => {
  it('drafts the next version from the one in force (codes kept); one draft at a time', async () => {
    const record = await ok('keeper', 'GET', `/quality/plans/${A.final}`)
    const { version } = await ok('keeper', 'POST', `/quality/plans/${A.final}/versions`, { version: record.plan.version, changeNote: 'Adds the zips.' }, 201)
    expect(version).toMatchObject({ number: 3, status: 'DRAFT', changeNote: 'Adds the zips.', author: { id: keeperId } })
    expect(version.checks.map((check: Json) => check.code)).toEqual(['CE_MARK'])
    const after = await ok('keeper', 'GET', `/quality/plans/${A.final}`)
    expect(paths(await refused('keeper', 'POST', `/quality/plans/${A.final}/versions`, { version: after.plan.version }, 409))).toEqual(['refusal/DRAFT_EXISTS'])
    expect((await refused('keeper', 'POST', `/quality/plans/${A.final}/versions`, { version: record.plan.version }, 409)).code).toBe('conflict')
    refs.v3 = version.id
  })

  it('retires a draft nobody wants with the reason; never the version in force while a rule uses the plan', async () => {
    const { version } = await ok('keeper', 'GET', `/quality/plans/${A.final}/versions/${refs.v3}`)
    expect(paths(await refused('keeper', 'POST', `/quality/plans/${A.final}/versions/${refs.v3}/retire`, { version: version.version, reason: '  ' }, 400))).toEqual(['body/reason'])
    const retired = await ok('keeper', 'POST', `/quality/plans/${A.final}/versions/${refs.v3}/retire`, { version: version.version, reason: 'Not needed after all.' })
    expect(retired.version).toMatchObject({ status: 'RETIRED', retiredBy: { id: keeperId } })
    expect((await admin<{ reason: string }>(`SELECT reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'quality.retirePlanVersion'`, [refs.v3]))[0]!.reason).toBe('Not needed after all.')
    expect(paths(await refused('keeper', 'POST', `/quality/plans/${A.final}/versions/${refs.v3}/retire`, { version: retired.version.version, reason: 'again' }, 409))).toEqual(['refusal/ALREADY_RETIRED'])
    const inForce = (await ok('keeper', 'GET', `/quality/plans/${A.incoming}/versions/${A.vIncoming1}`)).version
    const incoming = await refused('keeper', 'POST', `/quality/plans/${A.incoming}/versions/${A.vIncoming1}/retire`, { version: inForce.version, reason: 'Old' }, 409)
    expect(incoming.issues[0]).toEqual({ path: 'refusal/RULES_USE_PLAN', message: '1 rule of "When inspections are created" uses INC-LEATHER: switch it off or point it to another plan first, or approve a new version instead.' })
  })
})

describe('the printable checklist and the version a record runs on', () => {
  it('prints a version in Italian or English; a retired version says it is not in force', async () => {
    const page = await ok('keeper', 'GET', `/quality/plans/${A.final}/versions/${A.vFinal1}/checklist?language=it`)
    expect(page.title).toBe('FIN-JACKET · Final inspection, jackets')
    expect(page.notInForce).toBe('Versione ritirata: non è quella in vigore. Non usarla per un controllo.')
    expect(page.rows.map((row: Json) => [row.code, row.label, row.critical, row.takesResult])).toEqual([['CE_MARK', 'Marcatura CE', true, true], ['CHEST', 'Mezzo torace', false, true], ['READ', 'Leggere la scheda', false, false]])
    expect(page.rows[1].spec).toBe('58.000 ± 1.000 cm')
    expect(page.languages.slice(0, 2)).toEqual(['it', 'en'])
    const current = await ok('keeper', 'GET', `/quality/plans/${A.final}/versions/${A.vFinal2}/checklist?language=en`)
    expect(current.notInForce).toBeNull()
    expect(current.lines.find((line: Json) => line.label === 'Approved by').value).toContain('pm one')
    expect(paths(await refused('keeper', 'GET', `/quality/plans/${A.final}/versions/${A.vFinal2}/checklist?language=xx`, undefined, 400))).toEqual(['querystring/language'])
  })

  it('any office or floor screen reads the frozen version a record names, in its language', async () => {
    const floor = await ok('floor', 'GET', `/quality/plan-versions/${A.vFinal1}?language=en`)
    expect(floor).toMatchObject({ plan: { code: 'FIN-JACKET', stage: 'FINAL' }, version: { number: 1, status: 'RETIRED' }, language: 'en' })
    expect(floor.checks.map((check: Json) => [check.code, check.label, check.missing])).toEqual([['CE_MARK', 'CE marking', false], ['CHEST', 'Chest half', false], ['READ', 'Read the sheet', false]])
    const office = await ok('viewer', 'GET', `/quality/plan-versions/${A.vFinal2}?language=ro`)
    expect(office.checks.map((check: Json) => [check.label, check.missing])).toEqual([['CE marking', true]])
    expect((await refused('floor', 'GET', `/quality/plan-versions/${newId()}`, undefined, 404)).message).toBe('Plan version not found.')
  })
})

describe('search and export', () => {
  it('every plan is found by its code, scoped to its company, with its state; never a check word or a person', async () => {
    const system = callerFor(h.database, systemContext(A.tenant, 'plans-search-test'))
    await rebuildIndex(system, [planIndexer], { recordTypes: ['InspectionPlan'], key: `plans-rebuild-${newId()}` })
    const entries = await admin<{ number: string; status: string; companyId: string; siteId: string | null; viewPermission: string; searchText: string }>(`SELECT number, status, "companyId", "siteId", "viewPermission", "searchText" FROM "SearchEntry" WHERE "tenantId" = $1 AND "recordType" = 'InspectionPlan' ORDER BY number`, [A.tenant])
    expect(entries.map((entry) => entry.number)).toEqual((await admin<{ code: string }>(`SELECT code FROM "InspectionPlan" WHERE "tenantId" = $1 ORDER BY code`, [A.tenant])).map((row) => row.code))
    expect(entries.find((entry) => entry.number === 'FIN-JACKET')).toMatchObject({ status: 'APPROVED', companyId: A.companyA, siteId: null, viewPermission: 'quality.plans.view' })
    expect(entries.find((entry) => entry.number === 'EOL-EMPTY')!.status).toBe('DRAFT')
    for (const entry of entries) expect(entry.searchText).not.toMatch(/marcatura|keeper/)
  })

  it('exports the Plans grid as the screen shows it, in the person\'s language', async () => {
    const caller = callerFor(h.database, { audience: 'office', tenantId: A.tenant, actorId: keeperId, companyId: A.companyA, grants: [grant(KEEP)], requestId: 'plans-export-test' })
    const page = await inspectionPlans.read(caller, inspectionPlans.query(new URLSearchParams('stage=FINAL')), null, 500)
    const words = (code: string) => (inspectionPlans.words!.it as Record<string, string>)[code] ?? code
    const rows = page.rows as Json[]
    expect(rows.map((row) => row.code)).toEqual(['FIN-JACKET', 'FIN-TROUSERS', 'FIN-VEST'])
    const jacket = rows[0]!
    expect(['code', 'stage', 'version', 'status', 'appliesTo', 'usedBy'].map((column) => inspectionPlans.columns[column]!.value(jacket, words))).toEqual(['FIN-JACKET', 'Finale', 'v2', 'Approvato', 'Giacche', 1])
    expect(inspectionPlans.columns.appliesTo!.value(rows[2]!, words)).toBe('Tutto della sua fase')
    expect(Object.keys(inspectionPlans.words!.it).sort()).toEqual(Object.keys(inspectionPlans.words!.en).sort())
  })
})
