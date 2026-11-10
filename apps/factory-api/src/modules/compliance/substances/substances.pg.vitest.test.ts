import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedComplianceRules } from '../../../../../../packages/factory-db/seed/compliance-rules'
import { seed as seedQualityLab } from '../../../../../../packages/factory-db/seed/quality-lab'
import { seed as seedSubstances, type SubstancesSeed } from '../../../../../../packages/factory-db/seed/substances'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { useImporters } from '../../../platform/imports/registry'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { substancesGuarded, useSubstancesClock } from './common'
import { substanceRulesImportAdapter, substancesImportAdapter } from './importer'

/**
 * Restricted substances and their rules (B-W2b-250) on the local stack, through the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-217's guards are real), the
 * core, compliance rules (markets IT, DE, FR, ES on) and substances seeds (ten substances, nine rules with CMR and PFAS off,
 * two Candidate List versions, four profiles, five declaration requests of P2 and P1), sessions from the test
 * authenticator, the files on the local store behind the FAKE R2 account, and the import engine. Every name, code, answer
 * and person is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/substances`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

const NS = 'w2b250-substances'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyB = idOf('company:B')
const partyP1 = idOf('party:P1')

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.substances.manage'
const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const QUALITY: Permission[] = [VIEW, MANAGE, 'product.styles.view', 'product.materials.view', ...IMPORTS]
const clock: Clock = { now: () => new Date('2026-11-10T09:00:00.000Z') }

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  quality: { permissions: QUALITY, companies: 'all' },
  viewer: { permissions: [VIEW, 'product.styles.view'], companies: 'all' },
  // Company B only: a tenant-wide row is not theirs to keep.
  companyB: { permissions: [VIEW, MANAGE], companies: [companyB] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seed: SubstancesSeed

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const ruleOf = (rules: Json[], key: string): Json => rules.find((rule) => rule.key === key)!
const verdictOf = (rules: Json[], key: string): Json => rules.find((rule) => rule.key === key)!

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
async function importSheet(importerKey: string, body: Buffer): Promise<{ job: Json; rows: Json[] }> {
  const started = await call('quality', 'POST', '/imports', { importerKey, file: { originalName: 'sostanze.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, companyId: null })
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
  expect((await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
  expect((await call('quality', 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
  await planImport(system(), job.id, { lastAttempt: true })
  return { job: (await ok('quality', 'GET', `/imports/${job.id}`)).job, rows: (await ok('quality', 'GET', `/imports/${job.id}/rows`)).rows }
}
async function applySheet(job: Json): Promise<Json> {
  await ok('quality', 'POST', `/imports/${job.id}/apply`, { version: job.version })
  await applyPlan(system(), job.id, { lastAttempt: true })
  return (await ok('quality', 'GET', `/imports/${job.id}`)).job
}

beforeAll(async () => {
  db = await migratedDatabase('w2b250_substances')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-substances-test-'))
  await seedCore({ db: database, namespace: NS })
  await seedComplianceRules({ db: database, namespace: NS })
  seed = await seedSubstances({ db: database, namespace: NS })
  // W1's lab results: the leather's lot with its chromium VI report (PASS).
  await seedQualityLab({ db: database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // The import engine checks the roles the person holds: the quality person as a user with a custom role over every company.
  const roleId = newId()
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'quality.250@example.com', 'Quality 250', 'ACTIVE')`, [IDS.quality, tenant])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, 'custom.quality250', 'Quality 250', $3, '{}')`, [roleId, tenant, QUALITY])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', '{}', now() - interval '1 day')`, [newId(), tenant, IDS.quality, roleId])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([substancesImportAdapter, substanceRulesImportAdapter])
  useSubstancesClock(clock)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useSubstancesClock(undefined)
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the substance list (PRD-318)', () => {
  it('lists the substances with the rules that restrict them, by id or by group', async () => {
    const { substances, mayManage } = await ok('viewer', 'GET', '/compliance/substances')
    expect(mayManage).toBe(false)
    expect(substances).toHaveLength(10)
    const benzidine = substances.find((substance: Json) => substance.casNumber === '92-87-5')
    expect(benzidine).toMatchObject({ groupCode: 'AZO_AMINES', lists: ['REACH_ANNEX_XVII'], annexXviiEntries: ['43'] })
    expect(benzidine.rules.map((rule: Json) => [rule.key, rule.limit, rule.sourceWords])).toEqual([['REACH-XVII-43', 'at most 30 mg/kg', 'REACH Annex XVII entry 43']])
    const dmf = substances.find((substance: Json) => substance.casNumber === '68-12-2')
    expect(dmf.svhcListVersion).toMatchObject({ publishedOn: '2026-07-01' })
    expect(dmf.rules.map((rule: Json) => [rule.key, rule.sourceWords])).toEqual([['SEED-P1-RSL-DMF', 'Brand RSL: Seed brand RSL 2026, line 14 (made-up)']])
    expect((await ok('viewer', 'GET', '/compliance/substances?list=SVHC')).substances.map((substance: Json) => substance.casNumber).sort()).toEqual(['117-81-7', '335-67-1', '50-32-8', '68-12-2'])
    expect((await ok('viewer', 'GET', '/compliance/substances?q=nickel')).substances.map((substance: Json) => substance.casNumber)).toEqual(['7440-02-0'])
  })

  it('loads the starter list once: what is missing, tenant-wide; refused to a viewer and to a role over one company', async () => {
    await refused('viewer', 'POST', '/compliance/substances/starter', {}, 403)
    const narrow = await refused('companyB', 'POST', '/compliance/substances/starter', {}, 403)
    expect(narrow.message).toMatch(/kept only by a role over every company/)
    const loaded = await ok('quality', 'POST', '/compliance/substances/starter', {})
    // 34 starter substances: the seed has 7 of them (Cr VI, nickel, DMFu, NPE, 4-aminobiphenyl, benzidine, BaP); every rule key is seeded.
    expect(loaded).toMatchObject({ substances: { added: 27, kept: 7 }, rules: { added: 0, kept: 8 } })
    expect(loaded.addedSubstances).toContain('95-53-4')
    expect((await ok('quality', 'POST', '/compliance/substances/starter', {})).substances.added).toBe(0)
    const azo = await ok('viewer', 'GET', `/compliance/substances/rules/${seed.ruleIds.azo}`)
    expect(azo.rule).toMatchObject({ key: 'REACH-XVII-43', members: 22, test: 'AZO', declaration: 'RSL', evidence: 'EITHER' })
    expect(azo.substances).toHaveLength(22)
    expect(azo.testPlans.map((plan: Json) => plan.test)).toEqual(['AZO'])
    expect((await eventsOf('compliance_substances.substance_changed')).filter((payload) => payload.by === 'STARTER')).toHaveLength(27)
  })

  it('adds, edits and archives a company substance; a CAS number is given once and taken once among the ACTIVE ones', async () => {
    const bad = await refused('companyB', 'POST', '/compliance/substances', { companyId: companyB, casNumber: '7439-92-2', name: 'Lead', lists: ['CUSTOMER_RSL'] }, 400)
    expect(paths(bad)).toEqual(['body/casNumber'])
    expect(paths(await refused('companyB', 'POST', '/compliance/substances', { companyId: companyB, name: 'Lead', lists: ['CUSTOMER_RSL'], annexXviiEntries: ['63'] }, 400))).toEqual(['body/annexXviiEntries'])
    await refused('companyB', 'POST', '/compliance/substances', { name: 'Lead', lists: ['CUSTOMER_RSL'] }, 403)
    const { substance } = await ok('companyB', 'POST', '/compliance/substances', { companyId: companyB, casNumber: '7439-92-1', name: 'Lead', lists: ['CUSTOMER_RSL'], note: 'Made-up brand line.' })
    expect(substance).toMatchObject({ companyId: companyB, casNumber: '7439-92-1', lists: ['CUSTOMER_RSL'], status: 'ACTIVE', version: 1 })
    const twin = await refused('quality', 'POST', '/compliance/substances', { casNumber: '7439-92-1', name: 'Lead again', lists: ['REACH_ANNEX_XVII'], annexXviiEntries: ['63'] }, 409)
    expect(twin.message).toBe('CAS 7439-92-1 is on the list already (Lead): edit that substance.')
    const edited = await ok('companyB', 'PATCH', `/compliance/substances/${substance.id}`, { version: 1, lists: ['REACH_ANNEX_XVII', 'CUSTOMER_RSL'], annexXviiEntries: ['63'], ecNumber: '231-100-4' })
    expect(edited.substance).toMatchObject({ lists: ['REACH_ANNEX_XVII', 'CUSTOMER_RSL'], annexXviiEntries: ['63'], ecNumber: '231-100-4', version: 2 })
    expect((await refused('companyB', 'PATCH', `/compliance/substances/${substance.id}`, { version: 2, casNumber: '7439-97-6' }, 409)).message).toMatch(/given once \(7439-92-1\)/)
    await refused('companyB', 'PATCH', `/compliance/substances/${substance.id}`, { version: 1, note: 'stale' }, 409)
    expect((await ok('companyB', 'PATCH', `/compliance/substances/${substance.id}`, { version: 2, status: 'ARCHIVED' })).substance.status).toBe('ARCHIVED')
    expect((await ok('viewer', 'GET', '/compliance/substances?status=ARCHIVED')).substances.map((row: Json) => row.casNumber)).toEqual(['7439-92-1'])
    // A role over company B does not see company A's own rows; tenant-wide rows are everyone's.
    expect((await ok('companyB', 'GET', '/compliance/substances?q=lead&status=ALL')).substances).toHaveLength(1)
  })

  it('answers a database refusal of the substances guards as a 409 in words, never a 500', async () => {
    const office = { audience: 'office', tenantId: tenant, actorId: IDS.quality! } as const
    const failing = substancesGuarded(() =>
      database.withScope(office, (client) => client.restrictedSubstance.create({ data: { id: newId(), name: 'Bad digit', casNumber: '50-32-7', lists: ['SVHC'] }, select: { id: true } })),
    )
    await expect(failing).rejects.toBeInstanceOf(DomainError)
    await expect(failing).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/^Restricted substance .* has a CAS number \(N…N-NN-R\) and an EC number \(NNN-NNN-R\) with their check digits right/) })
  })
})

describe('the rules over the list (PRD-320 … PRD-325, PRD-329)', () => {
  it('lists the rules with their limits, evidence and switch; CMR and PFAS are off with the Owner question', async () => {
    const { rules } = await ok('viewer', 'GET', '/compliance/substances/rules')
    expect(rules.map((rule: Json) => rule.key)).toHaveLength(9)
    expect(ruleOf(rules, 'REACH-XVII-47')).toMatchObject({ code: 'CR6', limit: 'below 3 mg/kg', evidence: 'TEST', test: 'CR_VI', declaration: 'CR6', switchedOn: true })
    expect(ruleOf(rules, 'REACH-XVII-27')).toMatchObject({ limit: 'at most 0.5 µg/cm²/week', unitWords: 'µg/cm²/week', materialKinds: ['TRIM', 'HARDWARE'] })
    expect(ruleOf(rules, 'REACH-XVII-72')).toMatchObject({ switchedOn: false, exemptPpe: true, exemptNaturalLeather: true, offReason: expect.stringContaining('Q23') })
    expect(ruleOf(rules, 'SEED-P1-RSL-DMF')).toMatchObject({ source: 'CUSTOMER', customer: { id: partyP1, code: 'SEED-C1' }, substance: { casNumber: '68-12-2' } })
    expect((await ok('viewer', 'GET', '/compliance/substances/rules?switchedOn=false')).rules.map((rule: Json) => rule.key)).toEqual(['REACH-XVII-72', 'REACH-XVII-79'])
  })

  it('adds a brand rule, edits its limit, switches it off with the reason and back on, and archives it', async () => {
    await refused('viewer', 'POST', '/compliance/substances/rules', { key: 'X', code: 'OTHER', name: 'X', evidence: 'TEST', legalReference: 'X', substanceGroup: 'X' }, 403)
    const noBrand = await refused('quality', 'POST', '/compliance/substances/rules', { key: 'SEED-C1-NI', code: 'NICKEL', name: 'Nickel, the brand\'s limit', evidence: 'TEST', legalReference: 'Seed brand RSL 2026, line 2 (made-up)', substanceId: seed.substanceIds.nickel, source: 'CUSTOMER' }, 400)
    expect(paths(noBrand)).toEqual(['body/customerPartyId'])
    const created = await ok('quality', 'POST', '/compliance/substances/rules', {
      key: 'SEED-C1-NI',
      code: 'NICKEL',
      name: "Nickel, the brand's limit",
      evidence: 'TEST',
      legalReference: 'Seed brand RSL 2026, line 2 (made-up)',
      substanceId: seed.substanceIds.nickel,
      materialKinds: ['TRIM'],
      limitValue: '0.2',
      limitUnit: 'UG_CM2_WEEK',
      limitBound: 'AT_MOST',
      source: 'CUSTOMER',
      customerPartyId: partyP1,
    })
    const rule = created.rule
    expect(rule).toMatchObject({ key: 'SEED-C1-NI', limit: 'at most 0.2 µg/cm²/week', switchedOn: true, version: 1 })
    expect((await refused('quality', 'POST', '/compliance/substances/rules', { key: 'SEED-C1-NI', code: 'OTHER', name: 'Twin', evidence: 'TEST', legalReference: 'X', substanceGroup: 'X' }, 409)).message).toMatch(/key SEED-C1-NI exists already/)
    const edited = await ok('quality', 'PATCH', `/compliance/substances/rules/${rule.id}`, { version: 1, limitValue: '0.28', testMethod: 'EN 1811' })
    expect(edited.rule).toMatchObject({ limit: 'at most 0.28 µg/cm²/week', testMethod: 'EN 1811', version: 2 })
    const noReason = await refused('quality', 'PUT', `/compliance/substances/rules/${rule.id}/switch`, { version: 2, on: false }, 400)
    expect(noReason.message).toMatch(/Say why rule SEED-C1-NI is switched off/)
    const off = await ok('quality', 'PUT', `/compliance/substances/rules/${rule.id}/switch`, { version: 2, on: false, reason: 'The brand has no nickel trims this season (made-up).' })
    expect(off.rule).toMatchObject({ switchedOn: false, offReason: 'The brand has no nickel trims this season (made-up).', switchedBy: { id: IDS.quality } })
    expect((await refused('quality', 'PUT', `/compliance/substances/rules/${rule.id}/switch`, { version: 3, on: false, reason: 'again' }, 409)).message).toBe('Rule SEED-C1-NI is already off.')
    const on = await ok('quality', 'PUT', `/compliance/substances/rules/${rule.id}/switch`, { version: 3, on: true })
    expect(on.rule).toMatchObject({ switchedOn: true, offReason: null })
    expect((await ok('quality', 'PATCH', `/compliance/substances/rules/${rule.id}`, { version: 4, status: 'ARCHIVED' })).rule.status).toBe('ARCHIVED')
    expect((await eventsOf('compliance_substances.rule_changed')).filter((payload) => payload.ruleId === rule.id).map((payload) => payload.change)).toEqual(['CREATED', 'EDITED', 'SWITCHED', 'SWITCHED', 'ARCHIVED'])
  })
})

describe('the Candidate List versions (PRD-326)', () => {
  it('lists them newest first and records a new, longer one; a day twice or in the future is refused', async () => {
    const { versions } = await ok('viewer', 'GET', '/compliance/substances/svhc-versions')
    expect(versions.map((version: Json) => [version.publishedOn, version.entryCount, version.grewBy, version.newest])).toEqual([
      ['2026-07-01', 253, 3, true],
      ['2026-01-15', 250, null, false],
    ])
    expect((await refused('quality', 'POST', '/compliance/substances/svhc-versions', { publishedOn: '2026-12-01', entryCount: 256, source: 'Made-up update' }, 400)).issues[0].path).toBe('body/publishedOn')
    await refused('companyB', 'POST', '/compliance/substances/svhc-versions', { publishedOn: '2026-10-30', entryCount: 256, source: 'Made-up update' }, 403)
    const added = await ok('quality', 'POST', '/compliance/substances/svhc-versions', { publishedOn: '2026-10-30', entryCount: 256, source: 'Seed Candidate List, October update (made-up count)', sourceUrl: 'https://echa.europa.eu/candidate-list-table' })
    expect(added.version).toMatchObject({ publishedOn: '2026-10-30', grewBy: 3, newest: true })
    expect((await refused('quality', 'POST', '/compliance/substances/svhc-versions', { publishedOn: '2026-10-30', entryCount: 257, source: 'Twin' }, 409)).message).toBe('The Candidate List version of 2026-10-30 is recorded already.')
    expect(await eventsOf('compliance_substances.svhc_version_added')).toEqual([{ versionId: added.version.id, publishedOn: '2026-10-30', entryCount: 256, grewBy: 3 }])
    expect((await ok('quality', 'PATCH', `/compliance/substances/svhc-versions/${added.version.id}`, { version: 1, note: 'Three more entries (made-up).' })).version.note).toBe('Three more entries (made-up).')
  })
})

describe('the evaluator per material and per style (PRD-320 … PRD-326, PRD-329)', () => {
  it("says which rule applies to the leather, what it needs and whether it is met, without writing anything", async () => {
    const before = await admin(`SELECT version FROM "MaterialComplianceProfile" WHERE id = $1`, [seed.itemIds.leather])
    const evaluation = await ok('viewer', 'GET', `/compliance/substances/materials/${seed.itemIds.leather}/evaluation`)
    expect(evaluation.markets).toEqual(['DE', 'ES', 'FR', 'IT'])
    expect(evaluation.uses.map((use: Json) => use.code)).toEqual(['SEED-JKT-01', 'SEED-JKT-02'])
    expect(verdictOf(evaluation.rules, 'REACH-XVII-47')).toMatchObject({ status: 'MET', metBy: 'TEST', proof: { kind: 'TEST', test: 'CR_VI', verdict: 'PASS' } })
    expect(verdictOf(evaluation.rules, 'REACH-XVII-43')).toMatchObject({ status: 'MISSING', needs: { test: 'AZO', declaration: 'RSL' } })
    expect(verdictOf(evaluation.rules, 'SEED-P1-RSL-DMF')).toMatchObject({ status: 'MISSING', styleIds: expect.arrayContaining([]) })
    expect(verdictOf(evaluation.rules, 'REACH-XVII-27')).toMatchObject({ status: 'NOT_APPLICABLE', why: 'MATERIAL_KIND' })
    expect(verdictOf(evaluation.rules, 'REACH-XVII-72')).toMatchObject({ status: 'NOT_APPLICABLE', why: 'SWITCHED_OFF' })
    expect(evaluation.testsNeeded).toEqual(['CR_VI'])
    expect(evaluation.declarationsNeeded).toEqual(['REACH_SVHC', 'RSL'])
    // Its SVHC answer is of the January list; the October list (recorded above) is longer: asked again in SEED-SD-0001.
    expect(evaluation.svhc).toMatchObject({ aboveThreshold: false, source: 'DECLARATION', current: false, grewBy: 6, request: { number: 'SEED-SD-0002' }, asked: { number: 'SEED-SD-0001', status: 'SENT' } })
    expect(evaluation.state).toBe('INCOMPLETE')
    expect(evaluation.stateReason).toMatch(/SVHC: answered against the list of 2026-01-15; the Candidate List of 2026-10-30 is longer by 6: ask again\.$/)
    expect(evaluation.profile).toMatchObject({ state: 'INCOMPLETE', version: 1 })
    expect(evaluation.mayEvaluate).toBe(false)
    expect(await admin(`SELECT version FROM "MaterialComplianceProfile" WHERE id = $1`, [seed.itemIds.leather])).toEqual(before)
    await refused('viewer', 'GET', `/compliance/substances/materials/${newId()}/evaluation`, undefined, 404)
  })

  it('writes the profiles in one command; a failing lab test blocks the material; refused to a viewer and to a role over one company', async () => {
    await refused('viewer', 'POST', '/compliance/substances/materials/evaluate', { itemIds: [seed.itemIds.leather] }, 403)
    expect((await refused('companyB', 'POST', '/compliance/substances/materials/evaluate', { itemIds: [seed.itemIds.leather] }, 403)).message).toMatch(/material for every company/)
    const first = await ok('quality', 'POST', '/compliance/substances/materials/evaluate', { itemIds: [seed.itemIds.leather, seed.itemIds.protector, seed.itemIds.zip, seed.itemIds.lining] })
    const byId = new Map<string, Json>(first.profiles.map((profile: Json) => [profile.itemId, profile]))
    expect(byId.get(seed.itemIds.leather)).toMatchObject({ state: 'INCOMPLETE', previousState: 'INCOMPLETE', testsNeeded: ['CR_VI'], svhcAboveThreshold: false })
    // The protector: DEHP above 0.1 % w/w per SEED-SD-0002 (the art. 33 duty); its PAH evidence is missing.
    expect(byId.get(seed.itemIds.protector)).toMatchObject({ state: 'INCOMPLETE', previousState: 'COMPLETE', svhcAboveThreshold: true })
    // The zip: not in a current BOM; nickel release asked in SEED-SD-0003, overdue: missing, not blocked by hand any more.
    expect(byId.get(seed.itemIds.zip)).toMatchObject({ state: 'INCOMPLETE', previousState: 'BLOCKED' })
    expect(byId.get(seed.itemIds.zip)!.stateReason).toMatch(/REACH Annex XVII entry 27: Missing: a supplier's NICKEL declaration or a passing NICKEL test\. Asked in SEED-SD-0003, due 2026-11-05 \(overdue\)\./)
    expect(byId.get(seed.itemIds.lining)!.stateReason).toMatch(/SVHC: no answer above 0\.1 % w\/w yet\.$/)
    const [protector] = await admin(`SELECT "svhcSubstanceIds", "svhcListVersionId", "evaluatedAt", state FROM "MaterialComplianceProfile" WHERE id = $1`, [seed.itemIds.protector])
    expect(protector).toMatchObject({ svhcSubstanceIds: [seed.substanceIds.dehp], svhcListVersionId: seed.listVersionIds.v1, state: 'INCOMPLETE' })
    expect(protector!.evaluatedAt.toISOString()).toBe('2026-11-10T09:00:00.000Z')
    expect((await eventsOf('compliance_substances.profile_evaluated')).map((payload) => payload.itemId).sort()).toEqual([seed.itemIds.leather, seed.itemIds.protector, seed.itemIds.zip, seed.itemIds.lining].sort())

    // A failing azo test of the leather's lot (made-up), recorded as B-W2b-256 will record it.
    await admin(
      `INSERT INTO "LabResult" (id, "tenantId", "companyId", "siteId", "itemId", "lotId", test, method, "valueMgKg", "belowDetectionLimit", unit, "limitMgKg", verdict, lab, "testedOn", evidence, "fileId", "createdAt")
       SELECT $1, "tenantId", "companyId", "siteId", "itemId", "lotId", 'AZO', 'EN ISO 17234-1', 45, false, 'mg/kg', 30, 'FAIL', lab, "testedOn", evidence, "fileId", now()
         FROM "LabResult" WHERE "itemId" = $2 AND test = 'CR_VI' LIMIT 1`,
      [newId(), seed.itemIds.leather],
    )
    const second = await ok('quality', 'POST', '/compliance/substances/materials/evaluate', { itemIds: [seed.itemIds.leather] })
    expect(second.profiles[0]).toMatchObject({ state: 'BLOCKED', previousState: 'INCOMPLETE', changed: true })
    expect(second.profiles[0].stateReason).toMatch(/^REACH Annex XVII entry 43: Failed: the AZO test of \d{4}-\d{2}-\d{2} is not within the limit \(at most 30 mg\/kg\)\./)
    const audit = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'MaterialComplianceProfile' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [seed.itemIds.leather])
    expect(audit[0]).toMatchObject({ before: { state: 'INCOMPLETE' }, after: { state: 'BLOCKED' } })
  })

  it('evaluates a style per component in its own context and rolls the SVHCs up per component (REACH art. 33)', async () => {
    const jacket = idOf('product:style:JKT-01')
    const evaluation = await ok('viewer', 'GET', `/compliance/substances/styles/${jacket}/evaluation`)
    expect(evaluation.style).toMatchObject({ code: 'SEED-JKT-01', productType: 'JACKET', ppeCategory: 'CATEGORY_II' })
    const codes = evaluation.components.map((component: Json) => component.material.code)
    expect(codes).toEqual(expect.arrayContaining(['SEED-LEA-100', 'SEED-LIN-200', 'SEED-PRO-300']))
    const protector = evaluation.components.find((component: Json) => component.material.code === 'SEED-PRO-300')
    expect(protector.svhc).toMatchObject({ aboveThreshold: true, substances: [{ casNumber: '117-81-7' }] })
    expect(protector.rules.map((verdict: Json) => verdict.key)).toEqual(expect.arrayContaining(['REACH-XVII-50']))
    const leather = evaluation.components.find((component: Json) => component.material.code === 'SEED-LEA-100')
    expect(leather.state).toBe('BLOCKED')
    expect(evaluation.svhc).toMatchObject({ article33: 'YES', substances: [{ casNumber: '117-81-7' }] })
    expect(evaluation.svhc.newestVersion).toMatchObject({ publishedOn: '2026-10-30' })
    expect(evaluation.summary.blocked).toBe(1)
    // The PFAS screening applies only where it is switched on and a market or kind needs it: off, it says so per component.
    expect(protector.notApplicable.find((entry: Json) => entry.key === 'REACH-XVII-79')).toMatchObject({ why: 'SWITCHED_OFF' })
    await refused('viewer', 'GET', `/compliance/substances/styles/${jacket}/evaluation?revisionId=${newId()}`, undefined, 400)
  })
})

describe('the imports of the list and its rules (PRD-318)', () => {
  it('dry-runs and applies a substance sheet: a list added, a new substance, a bad check digit and an unknown list version refused', async () => {
    const { job, rows } = await importSheet(
      'compliance.substances',
      csv(['CAS;Nome;Liste;Voci allegato XVII;Inclusa il', '117-81-7;;AFIRM;;', '68-12-3;Wrong digit;SVHC;;', '7440-43-9;Cadmium;Annex XVII;23;', '123-91-1;1,4-Dioxane;SVHC;;2026-03-03']),
    )
    expect(rows.map((row: Json) => [row.rowNumber, row.action])).toEqual([
      [2, 'UPDATE'],
      [3, 'ERROR'],
      [4, 'CREATE'],
      [5, 'ERROR'],
    ])
    expect(rows[1]!.errors[0]).toMatchObject({ column: 'identifier' })
    expect(rows[3]!.errors[0].message).toMatch(/No Candidate List version of 2026-03-03 is recorded/)
    const applied = await applySheet(job)
    expect(applied.status).toBe('APPLIED')
    const dehp = (await ok('viewer', 'GET', '/compliance/substances?q=117-81-7')).substances[0]
    expect(dehp.lists).toEqual(['REACH_ANNEX_XVII', 'SVHC', 'AFIRM_RSL'])
    expect((await ok('viewer', 'GET', '/compliance/substances?q=7440-43-9')).substances[0]).toMatchObject({ name: 'Cadmium', lists: ['REACH_ANNEX_XVII'], annexXviiEntries: ['23'], companyId: null })
    expect((await eventsOf('compliance_substances.substance_changed')).filter((payload) => payload.by === 'IMPORT').map((payload) => payload.change)).toEqual(['EDITED', 'CREATED'])
  })

  it('dry-runs and applies a rule sheet: a brand rule comes in on, an industry rule off with the reason, a known one changes', async () => {
    const { job, rows } = await importSheet(
      'compliance.substanceRules',
      csv([
        'Chiave;Tipo;Nome;Sostanza;Limite;Unità;Al limite;Evidenza;Fonte;Marchio;Riferimento;Metodo',
        "SEED-C1-RSL-CD;OTHER;Cadmium in trims, the brand's limit;7440-43-9;40;mg/kg;al massimo;dichiarazione;cliente;SEED-C1;Seed brand RSL 2026, line 3 (made-up);",
        'AFIRM-TEST-NPE;NPE;NPE in textiles (made-up industry line);Nonylphenol ethoxylates;100;ppm;sotto;either;afirm;;Made-up industry RSL 2026;',
        'REACH-XVII-43;;;;;;;;;;;EN ISO 14362-1',
        'NOPE-1;OTHER;No such substance;99-99-9;;;;test;legge;;Nothing;',
      ]),
    )
    expect(rows.map((row: Json) => [row.rowNumber, row.action])).toEqual([
      [2, 'CREATE'],
      [3, 'CREATE'],
      [4, 'UPDATE'],
      [5, 'ERROR'],
    ])
    await applySheet(job)
    const { rules } = await ok('viewer', 'GET', '/compliance/substances/rules?status=ALL')
    expect(ruleOf(rules, 'SEED-C1-RSL-CD')).toMatchObject({ switchedOn: true, source: 'CUSTOMER', customer: { code: 'SEED-C1' }, limit: 'at most 40 mg/kg', substance: { casNumber: '7440-43-9' } })
    expect(ruleOf(rules, 'AFIRM-TEST-NPE')).toMatchObject({ switchedOn: false, source: 'INDUSTRY', limit: 'below 100 mg/kg', offReason: expect.stringContaining('question 5 A') })
    expect(ruleOf(rules, 'REACH-XVII-43')).toMatchObject({ testMethod: 'EN ISO 14362-1', limit: 'at most 30 mg/kg' })
  })
})
