import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-W2b-283 — the product follow-ups on B-W2b-275's columns, through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the guards are real), seeded with the core,
 * numbering, compliance rules (markets IT, DE, FR, ES; DOC-LANGUAGE, USER-INFO-LANGUAGE on for every market; SEED-WO-0002 for
 * Italy; the brand certificate SEED-CERT-2162 resting on SEED-CERT-2161), styles-depth (product types) and sizes-depth
 * (points of measure) seeds:
 *
 *   FU1:01  a style's markets set on the Overview and read by the requirements gate
 *   FU1:02  the styles list's coverage asks the base certificate
 *   FU1:03  the measurement templates listed for pickers, and picked as a type's default
 *   FU1:04  "Changed by" on the product settings and a product type, without audit.read
 *   FU1:05  a point code that differs only in case refused in words (the API's check and the database's index)
 *
 * The final size check's band (FU1:05) is proven in modules/quality/final/final-plan.pg (its planted spec). Every code, name
 * and person is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/markets`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

const NS = 'followups-283'
const key = (name: string): string => seedUuid(NS, name)
const tenant = key('tenant')
const companyA = key('company:A')
const companyB = key('company:B')
const jacket = key('product:style:JKT-01')

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const managerId = newId()
const STYLES = ['product.styles.view', 'product.styles.manage']
const SESSIONS: Record<string, SessionContext> = {
  manager: { audience: 'office', tenantId: tenant, actorId: managerId, grants: [grant([...STYLES, 'product.settings.manage', 'compliance.certificates.view', 'compliance.certificates.manage'])] },
  // Reads the styles and the settings, no audit.read, no right to change.
  viewer: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'compliance.certificates.view'])] },
  companyB: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant([...STYLES, 'product.settings.manage'], [companyB])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `fu283-${randomBytes(4).toString('hex')}-${++serial}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json() as Json).error
}
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => {
  const rows = await admin<T>(sql, values)
  if (!rows[0]) throw new Error(`nothing for ${sql}`)
  return rows[0]
}

let wo2: { id: string; styleId: string }

beforeAll(async () => {
  db = await migratedDatabase('product_fu_283')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  await seedStylesDepth({ db: database, namespace: NS })
  await seedSizesDepth({ db: database, namespace: NS })
  // The manager is a real office person (the name "Changed by" shows); made up.
  await database.withScope({ audience: 'office', tenantId: tenant, actorId: managerId }, (client) =>
    client.user.create({ data: { id: managerId, email: `manager.283.${randomBytes(3).toString('hex')}@example.test`, displayName: 'Demo Manager 283', status: 'INVITED', requireMfa: false, passwordHash: null }, select: { id: true } }),
  )
  wo2 = await one<{ id: string; styleId: string }>(`SELECT id, "styleId" FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0002'`, [tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const marketsOf = async (styleId: string, session = 'manager'): Promise<Json> => (await ok(session, 'GET', `/product/styles/${styleId}/markets`)).markets
const setMarkets = async (styleId: string, marketCodes: string[], session = 'manager'): Promise<Json> => {
  const now = await marketsOf(styleId)
  return (await ok(session, 'PUT', `/product/styles/${styleId}/markets`, { version: now.style.version, marketCodes })).markets
}
const releaseCheck = async (): Promise<Json> => (await ok('viewer', 'GET', `/compliance/gates/check?gate=WORK_ORDER_RELEASE&subjectType=WorkOrder&subjectId=${wo2.id}`)).decisions[0]
const lineOf = (decision: Json, code: string): Json => decision.lines.find((line: Json) => line.requirement.code === code)

describe('the markets a style is sold in (FU1:01)', () => {
  it('reads every market with none picked, sets a list in the markets’ order, audits it and says style.updated', async () => {
    const before = await marketsOf(jacket)
    expect(before).toMatchObject({ marketCodes: [], standing: 'EVERY_MARKET', mayChange: true, refusal: null })
    expect(before.markets.map((market: Json) => market.code)).toEqual(expect.arrayContaining(['IT', 'DE', 'FR', 'ES']))
    expect(before.markets.every((market: Json) => market.offered && !market.picked)).toBe(true)
    expect((await marketsOf(jacket, 'viewer')).mayChange).toBe(false)

    const after = await setMarkets(jacket, ['de', 'IT'])
    expect(after).toMatchObject({ marketCodes: ['IT', 'DE'], standing: 'SOLD_THERE', style: { version: before.style.version + 1 } })
    expect(after.markets.find((market: Json) => market.code === 'DE')).toMatchObject({ picked: true, offered: true })
    expect((await one<{ marketCodes: string[] }>(`SELECT "marketCodes" FROM "Style" WHERE id = $1`, [jacket])).marketCodes).toEqual(['IT', 'DE'])
    const audit = await one<{ action: string; after: Json }>(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'Style' AND "recordId" = $1 AND action = 'product.styles.setMarkets' ORDER BY at DESC, id DESC LIMIT 1`, [jacket])
    expect(audit.after).toMatchObject({ marketCodes: ['IT', 'DE'], added: ['IT', 'DE'], removed: [] })
    const event = await one<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'style.updated' ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [jacket])
    expect(event.payload.fields).toEqual(['marketCodes'])

    // The same list again changes nothing: no command, no version bump.
    const again = (await ok('manager', 'PUT', `/product/styles/${jacket}/markets`, { version: after.style.version, marketCodes: ['DE', 'IT'] })).markets
    expect(again.style.version).toBe(after.style.version)
    // Back to every market.
    expect((await setMarkets(jacket, [])).standing).toBe('EVERY_MARKET')
  })

  it('refuses in words: an unknown market, one twice, a reader, a stale version, another company’s manager', async () => {
    const now = await marketsOf(jacket)
    const unknown = await refused('manager', 'PUT', `/product/styles/${jacket}/markets`, { version: now.style.version, marketCodes: ['IT', 'XX'] }, 400)
    expect(unknown.issues).toEqual([{ path: 'body/marketCodes/1', message: 'There is no market XX in Compliance › Rules & markets: add it there first.' }])
    const twice = await refused('manager', 'PUT', `/product/styles/${jacket}/markets`, { version: now.style.version, marketCodes: ['IT', 'it'] }, 400)
    expect(twice.issues[0]).toMatchObject({ path: 'body/marketCodes/1', message: 'Market IT is named twice: name each market once.' })
    await refused('viewer', 'PUT', `/product/styles/${jacket}/markets`, { version: now.style.version, marketCodes: ['IT'] }, 403)
    await refused('manager', 'PUT', `/product/styles/${jacket}/markets`, { version: now.style.version - 1, marketCodes: ['IT'] }, 409)
    const style = await one<{ companyId: string | null }>(`SELECT "companyId" FROM "Style" WHERE id = $1`, [jacket])
    if (style.companyId === companyA) await refused('companyB', 'GET', `/product/styles/${jacket}/markets`, undefined, 404)
    // Nothing was written.
    expect((await one<{ marketCodes: string[] }>(`SELECT "marketCodes" FROM "Style" WHERE id = $1`, [jacket])).marketCodes).toEqual([])
  })

  it('follows the edit rule (a detail of the style): a blocked state holds the pick, in words', async () => {
    const style = await one<{ lifecycle: string; companyId: string | null }>(`SELECT lifecycle::text AS lifecycle, "companyId" FROM "Style" WHERE id = $1`, [jacket])
    const settings = (await ok('manager', 'GET', `/product/settings${style.companyId ? `?companyId=${style.companyId}` : ''}`)).settings
    const blocked = (await ok('manager', 'PUT', '/product/settings', { companyId: style.companyId, ...(settings.exists ? { version: settings.version } : {}), editRules: { [style.lifecycle]: 'BLOCKED' }, reason: 'Made up: blocked for the test.' })).settings
    const held = await marketsOf(jacket)
    expect(held.refusal).toMatchObject({ code: 'EDIT_BLOCKED' })
    const refusal = await refused('manager', 'PUT', `/product/styles/${jacket}/markets`, { version: held.style.version, marketCodes: ['IT'] }, 409)
    expect(refusal.issues[0].path).toBe('refusal/EDIT_BLOCKED')
    await ok('manager', 'PUT', '/product/settings', { companyId: style.companyId, version: blocked.version, editRules: { [style.lifecycle]: null } })
    expect((await marketsOf(jacket)).refusal).toBeNull()
  })

  it('the requirements gate: a market the style names checks its languages; another, or none named, waits as before', async () => {
    // None named (every market): the every-market language rules wait at the gate, as B-W2b-254 decided.
    let decision = await releaseCheck()
    expect(lineOf(decision, 'USER-INFO-LANGUAGE')).toMatchObject({ state: 'NOT_NEEDED' })
    expect(lineOf(decision, 'USER-INFO-LANGUAGE').message).toContain('is not set to sell in Italy')
    // Sold in Italy (SEED-WO-0002 goes there): the Italian user information is asked and blocks the release (the seed's
    // override of SEED-WO-0002's release lets that one line pass while it is in force: OVERRIDDEN is a missing line).
    await setMarkets(wo2.styleId, ['IT'])
    decision = await releaseCheck()
    const userInfo = lineOf(decision, 'USER-INFO-LANGUAGE')
    expect(userInfo).toMatchObject({ blocks: true })
    expect(['MISSING', 'OVERRIDDEN']).toContain(userInfo.state)
    expect(userInfo.message).not.toContain('is not set to sell')
    expect(lineOf(decision, 'DOC-LANGUAGE').state).not.toBe('NOT_NEEDED')
    // Sold in Germany only: goods going to Italy are not checked against Italy's languages (not sold there).
    await setMarkets(wo2.styleId, ['DE'])
    decision = await releaseCheck()
    expect(lineOf(decision, 'USER-INFO-LANGUAGE')).toMatchObject({ state: 'NOT_NEEDED' })
    await setMarkets(wo2.styleId, [])
    expect(lineOf(await releaseCheck(), 'USER-INFO-LANGUAGE')).toMatchObject({ state: 'NOT_NEEDED' })
  })
})

describe('the styles list asks the base certificate (FU1:02)', () => {
  it("a brand certificate whose base is suspended no longer shows the style covered", async () => {
    const certificate = (number: string) => one<{ id: string }>(`SELECT id FROM "Certificate" WHERE "tenantId" = $1 AND number = $2`, [tenant, number])
    const ownBrand = (await certificate('SEED-CERT-2162')).id
    const base = (await certificate('SEED-CERT-2161')).id
    const rowOf = async (): Promise<Json> => (await ok('manager', 'GET', '/product/styles?status=ALL&q=JKT-01&limit=200')).styles.find((row: Json) => row.id === jacket)
    expect((await rowOf()).coverage).toMatchObject({ state: 'ALL_COVERED' })
    // The brand's certificate covers the jacket; the jacket's own certificate is suspended, so only the brand's is left.
    const own = (await ok('manager', 'GET', `/compliance/certificates/${ownBrand}`)).certificate
    await ok('manager', 'POST', `/compliance/certificates/${ownBrand}/coverage`, { version: own.version, styleId: jacket }, 201)
    const jacketCertificate = await one<{ id: string; version: number }>(`SELECT c.id, c.version FROM "Certificate" c JOIN "CertificateCoverage" v ON v."certificateId" = c.id WHERE v."styleId" = $1 AND c.id <> $2 AND c.status = 'VALID' LIMIT 1`, [jacket, ownBrand])
    await ok('manager', 'POST', `/compliance/certificates/${jacketCertificate.id}/suspend`, { version: jacketCertificate.version, reason: 'Made up: suspended for the test.' })
    expect((await rowOf()).coverage).toMatchObject({ state: 'ALL_COVERED' })
    // The factory's base certificate suspended: the brand's covers nothing, as the real gates say.
    const factory = (await ok('manager', 'GET', `/compliance/certificates/${base}`)).certificate
    await ok('manager', 'POST', `/compliance/certificates/${base}/suspend`, { version: factory.version, reason: 'Made up: the base is suspended.' })
    const row = await rowOf()
    expect(row.coverage).toMatchObject({ state: 'GAPS', covered: 0 })
    expect(row.coverage.notCovered).toBe(row.coverage.cells)
  })
})

describe('the measurement templates for pickers (FU1:03)', () => {
  it('lists them by kind of garment and company; a type picks one as its default', async () => {
    const all = await ok('viewer', 'GET', '/product/measurement-templates')
    const jacketTemplate = all.templates.find((template: Json) => template.code === 'JACKET')
    expect(jacketTemplate).toMatchObject({ productType: 'JACKET', status: 'ACTIVE', rulesOn: false })
    expect(jacketTemplate.points).toBeGreaterThan(0)
    expect(all.more).toBe(false)
    const trousers = await ok('viewer', 'GET', '/product/measurement-templates?productType=TROUSERS')
    expect(trousers.templates.every((template: Json) => template.productType === 'TROUSERS')).toBe(true)
    expect((await ok('viewer', 'GET', '/product/measurement-templates?status=ARCHIVED')).templates.every((template: Json) => template.status === 'ARCHIVED')).toBe(true)
    expect((await ok('viewer', 'GET', `/product/measurement-templates?companyId=${companyA}&q=jack`)).templates.map((template: Json) => template.code)).toContain('JACKET')
    await refused('companyB', 'GET', `/product/measurement-templates?companyId=${companyA}`, undefined, 404)
    await refused('viewer', 'GET', '/product/measurement-templates?status=GONE', undefined, 400)

    const type = await one<{ id: string; version: number; measurementTemplateId: string | null }>(`SELECT id, version, "measurementTemplateId" FROM "ProductTypeProfile" WHERE "tenantId" = $1 AND code = 'SEED-PT-JKT'`, [tenant])
    const cleared = type.measurementTemplateId === null ? null : (await ok('manager', 'PATCH', `/product/types/${type.id}`, { version: type.version, measurementTemplateId: null })).type
    const picked = (await ok('manager', 'PATCH', `/product/types/${type.id}`, { version: cleared?.version ?? type.version, measurementTemplateId: jacketTemplate.id })).type
    expect(picked.own.measurementTemplateId).toBe(jacketTemplate.id)
    expect(picked.refs.measurementTemplate).toMatchObject({ id: jacketTemplate.id, code: 'JACKET' })
  })
})

describe('who changed the settings and a type (FU1:04)', () => {
  it('writes updatedById; "Changed by" is in the answer, also for a reader without audit.read', async () => {
    const before = (await ok('viewer', 'GET', `/product/settings?companyId=${companyB}`)).settings
    const saved = (await ok('manager', 'PUT', '/product/settings', { companyId: companyB, ...(before.exists ? { version: before.version } : {}), consumptionTolerance: 'WARN_ABOVE', consumptionTolerancePct: '7.5' })).settings
    expect(saved.changedBy).toEqual({ id: managerId, name: 'Demo Manager 283' })
    expect((await one<{ updatedById: string | null }>(`SELECT "updatedById" FROM "ProductSettings" WHERE id = $1`, [companyB])).updatedById).toBe(managerId)
    expect((await ok('viewer', 'GET', `/product/settings?companyId=${companyB}`)).settings.changedBy).toEqual({ id: managerId, name: 'Demo Manager 283' })
    // A person this tenant does not know (a session without a user row) is named by nobody.
    const other = (await ok('companyB', 'PUT', '/product/settings', { companyId: companyB, version: saved.version, consumptionTolerancePct: '8' })).settings
    expect(other.changedBy).toBeNull()

    const created = (await ok('manager', 'POST', '/product/types', { companyId: companyA, code: 'DEMO-PT-283', name: 'Demo type 283', productType: 'JACKET' }, 201)).type
    expect(created.changedBy).toEqual({ id: managerId, name: 'Demo Manager 283' })
    const archived = (await ok('manager', 'POST', `/product/types/${created.id}/archive`, { version: created.version })).type
    expect(archived.changedBy).toEqual({ id: managerId, name: 'Demo Manager 283' })
    const listed = (await ok('viewer', 'GET', `/product/types?status=ALL&companyId=${companyA}`)).types.find((type: Json) => type.id === created.id)
    expect(listed.changedBy).toEqual({ id: managerId, name: 'Demo Manager 283' })
    expect((await one<{ updatedById: string | null }>(`SELECT "updatedById" FROM "ProductTypeProfile" WHERE id = $1`, [created.id])).updatedById).toBe(managerId)
  })
})

describe('a point code is one code whatever its letter case (FU1:05)', () => {
  const point = (code: string) => ({ code, name: `Demo ${code}`, kind: 'BODY', bodyZone: 'UPPER', uom: 'CM' })

  it('refuses another case in words, from the API and from the database’s index (two writes at once)', async () => {
    await ok('manager', 'POST', '/product/points-of-measure', point('DEMO_CASE_W'), 201)
    const refusal = await refused('manager', 'POST', '/product/points-of-measure', point('demo_case_w'), 409)
    expect(refusal.message).toBe('The point of measure code demo_case_w is taken (whatever the letter case).')
    // Two writes at once: one is made, the other refused in the same words (the API's check or the database's index).
    const answers = await Promise.all([call('manager', 'POST', '/product/points-of-measure', point('DEMO_RACE_W')), call('manager', 'POST', '/product/points-of-measure', point('demo_race_w'))])
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 409])
    expect(answers.find((answer) => answer.statusCode === 409)!.json().error.message).toMatch(/^The point of measure code (demo_race_w|DEMO_RACE_W) is taken \(whatever the letter case\)\.$/)
    // The database's own answer, past the API's check: a unique violation the API maps to its 409 (Prisma P2002).
    const error = await database
      .withScope({ audience: 'office', tenantId: tenant, actorId: managerId }, (client) =>
        client.pointOfMeasure.create({ data: { id: newId(), code: 'Demo_Case_W', name: 'Demo past the API', kind: 'BODY', bodyZone: 'UPPER', uom: 'CM' }, select: { id: true } }),
      )
      .then(() => null, (caught: unknown) => caught as { code?: string })
    expect(error?.code).toBe('P2002')
    expect((await admin<{ count: string }>(`SELECT count(*)::text AS count FROM "PointOfMeasure" WHERE "tenantId" = $1 AND lower(code) IN ('demo_case_w', 'demo_race_w')`, [tenant]))[0]!.count).toBe('2')
  })
})
