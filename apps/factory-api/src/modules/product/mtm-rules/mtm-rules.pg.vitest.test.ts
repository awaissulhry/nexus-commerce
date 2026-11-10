import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { linkRuleChecks } from '../../sales/measure-link/checks'

/**
 * Made-to-measure rules (B-W2b-248; PRD-017, PRD-201, PRD-202, PRD-203, PRD-204) on the local stack, through the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-210's
 * guards are real), the core and sizes seeds (the JACKET template: chest, waist and sleeve with alteration limits, the base
 * size from the chest, WAIST_TO_CHEST and CHEST_RANGE, its rules OFF as built; SEED-JKT-01 made to measure on the EU jacket
 * scale in 50, 52, 54, its DRAFT revision 1 with the leather following the chest by 1 and the lining by 0.8; SEED-TRS-01 not
 * made to measure; the riders' profiles), sessions from the test authenticator. Every code, number and name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/mtm-rules`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seed: SizesDepthSeed

const NS = 'w2b248-mtm'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const otherTenant = newId()
const profileP1 = idOf('measurement:P1:rider:JACKET:1')

const KEEPER: Permission[] = ['product.styles.view', 'product.styles.manage', 'product.bom.view', 'product.bom.manage', 'sales.measurements.view']
interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  keeper: { tenantId: tenant, permissions: KEEPER, companies: 'all' },
  // The Owner's word: product.mtm.switch (no template holds it).
  owner: { tenantId: tenant, permissions: [...KEEPER, 'product.mtm.switch'], companies: 'all' },
  // Reads the library only: no BOM, no rider's measures.
  viewer: { tenantId: tenant, permissions: ['product.styles.view'], companies: 'all' },
  // Company A only: the tenant-wide JACKET template is not theirs to change.
  companyA: { tenantId: tenant, permissions: ['product.styles.view', 'product.styles.manage', 'product.mtm.switch'], companies: [companyA] },
  otherTenant: { tenantId: otherTenant, permissions: [...KEEPER, 'product.mtm.switch'], companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)

const rulesUrl = () => `/product/measurement-templates/${seed.templateIds.jacket}/mtm-rules`
const getRules = async (session = 'keeper'): Promise<Json> => (await ok(session, 'GET', rulesUrl())).rules
const words = (it: string, en: string) => ({ it, en })
/** The seed's two JACKET rules, as a PUT names them. */
const SEED_RULES = [
  { code: 'CHEST_RANGE', kind: 'RANGE', pointCode: 'chest', minValue: '88', maxValue: '116', severity: 'BLOCK', messageI18n: words('Torace fuori misura: misuralo di nuovo', 'Chest out of range: measure it again') },
  { code: 'WAIST_TO_CHEST', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'chest', minFactor: '0.6', maxFactor: '1.15', severity: 'WARN', messageI18n: words('Vita e torace non tornano', 'Waist and chest do not match') },
]
const check = async (body: Json, session = 'keeper'): Promise<Json> => (await ok(session, 'POST', '/product/made-to-measure/check', body)).check
const revisionVersion = async (revisionId: string): Promise<number> => (await one<{ version: number }>(`SELECT version FROM "StyleRevision" WHERE id = $1`, [revisionId])).version
const scaleUrl = (lineId: string, styleId = seed.jacket.styleId, revisionId = seed.jacket.revisionId) => `/product/styles/${styleId}/revisions/${revisionId}/bom/lines/${lineId}/mtm-scale`

beforeAll(async () => {
  db = await migratedDatabase('w2b248_mtm_rules')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seed = await seedSizesDepth({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'mtm-other'])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a template’s made-to-measure rules (PRD-201, PRD-202, PRD-203)', () => {
  it('reads the JACKET template’s rules, off as built, with its limits and base size rule; another tenant’s is not found', async () => {
    const rules = await getRules()
    expect(rules.template).toMatchObject({ code: 'JACKET', rulesOn: false, baseSizeRule: { points: ['chest'], tie: 'LARGER' } })
    expect(rules.rules.map((rule: Json) => [rule.code, rule.kind, rule.severity])).toEqual([
      ['CHEST_RANGE', 'RANGE', 'BLOCK'],
      ['WAIST_TO_CHEST', 'RATIO', 'WARN'],
    ])
    expect(rules.rules[1]).toMatchObject({ pointCode: 'waist', otherPointCode: 'chest', minFactor: '0.6', maxFactor: '1.15' })
    expect(rules.points.find((point: Json) => point.code === 'chest')).toMatchObject({ tolerance: '1', alterationMinus: '4', alterationPlus: '6', pointOfMeasure: { code: 'chest', bodyZone: 'UPPER' } })
    expect(rules.styles).toEqual({ measured: 1, madeToMeasure: 1 })
    expect(rules.summary).toBe('Off (nothing is checked) · 2 rules (1 blocking) · base size from chest · alteration limits on 3 points')
    expect(rules).toMatchObject({ editable: true, refusal: null, switchable: false })
    expect((await getRules('owner')).switchable).toBe(true)
    expect(await getRules('viewer')).toMatchObject({ editable: false, refusal: expect.stringMatching(/product\.styles\.manage/) })
    await refused('otherTenant', 'GET', rulesUrl(), undefined, 404)
  })

  it('saves the rules whole: one kept by its code and changed, one added, one removed, a point’s limits and the base size rule; audited; the event', async () => {
    const before = await getRules()
    const kept = before.rules.find((rule: Json) => rule.code === 'WAIST_TO_CHEST')
    const saved = (
      await ok('keeper', 'PUT', rulesUrl(), {
        version: before.template.version,
        baseSizeRule: { points: ['chest'], tie: 'SMALLER' },
        points: [{ code: 'sleeve', tolerance: '1', alterationMinus: '2', alterationPlus: '5.5' }],
        rules: [
          { ...SEED_RULES[1], maxFactor: '1.2' },
          { code: 'SLEEVE_RANGE', kind: 'RANGE', pointCode: 'sleeve', minValue: '50', maxValue: '80', severity: 'WARN', messageI18n: words('Manica insolita', 'Unusual sleeve') },
        ],
      })
    ).rules
    expect(saved.template).toMatchObject({ version: before.template.version + 1, baseSizeRule: { points: ['chest'], tie: 'SMALLER' } })
    expect(saved.rules.map((rule: Json) => rule.code)).toEqual(['SLEEVE_RANGE', 'WAIST_TO_CHEST'])
    expect(saved.rules.find((rule: Json) => rule.code === 'WAIST_TO_CHEST')).toMatchObject({ id: kept.id, maxFactor: '1.2' })
    expect(saved.points.find((point: Json) => point.code === 'sleeve')).toMatchObject({ alterationMinus: '2', alterationPlus: '5.5' })
    expect((await admin(`SELECT id FROM "MeasurementRule" WHERE id = $1`, [seed.ruleIds.chestRange])).length).toBe(0)
    const audit = await one(`SELECT "before", "after" FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'MeasurementTemplate' AND "recordId" = $2 ORDER BY at DESC, id DESC LIMIT 1`, [tenant, seed.templateIds.jacket])
    expect(audit.after).toMatchObject({ removed: ['CHEST_RANGE'], baseSizeRule: { points: ['chest'], tie: 'SMALLER' }, limits: [{ code: 'sleeve', alterationMinus: '2', alterationPlus: '5.5' }] })
    expect(audit.after.rules.map((rule: Json) => rule.code)).toEqual(['WAIST_TO_CHEST', 'SLEEVE_RANGE'])
    expect((await eventsOf('measurement_template.mtm_rules_changed')).at(-1)).toEqual({ templateId: seed.templateIds.jacket, code: 'JACKET', change: 'RULES' })
    // Saved again as it stands: nothing changes but the version, and no event.
    const events = (await eventsOf('measurement_template.mtm_rules_changed')).length
    const again = (await ok('keeper', 'PUT', rulesUrl(), { version: saved.template.version, baseSizeRule: saved.template.baseSizeRule, points: [], rules: saved.rules.map(({ id: _id, ...rule }: Json) => rule) })).rules
    expect(again.rules.map((rule: Json) => rule.id)).toEqual(saved.rules.map((rule: Json) => rule.id))
    expect((await eventsOf('measurement_template.mtm_rules_changed')).length).toBe(events)
  })

  it('REFUSES broken rules in words (no database refusal reaches a person), a stale version, and a person without the right', async () => {
    const current = await getRules()
    const broken = await refused(
      'keeper',
      'PUT',
      rulesUrl(),
      {
        version: current.template.version,
        baseSizeRule: { points: ['neck'], tie: 'LARGER' },
        points: [{ code: 'chest', tolerance: null, alterationMinus: '4.125', alterationPlus: null }],
        rules: [
          { code: 'NO_FACTOR', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'chest', severity: 'WARN', messageI18n: words('a', 'b') },
          { code: 'TWO_POINTS', kind: 'RANGE', pointCode: 'chest', otherPointCode: 'waist', maxValue: '120', severity: 'BLOCK', messageI18n: words('a', 'b') },
          { code: 'BLANK', kind: 'ORDER', pointCode: 'waist', otherPointCode: 'chest', severity: 'BLOCK', messageI18n: { it: '  ' } },
        ],
      },
      400,
    )
    expect(paths(broken)).toEqual(['body/rules/0/minFactor', 'body/rules/1/otherPointCode', 'body/rules/2/messageI18n/it', 'body/baseSizeRule/points/0', 'body/points/0/alterationMinus'])
    const stale = await refused('keeper', 'PUT', rulesUrl(), { version: current.template.version - 1, baseSizeRule: null, points: [], rules: [] }, 409)
    expect(stale.code).toBe('conflict')
    await refused('companyA', 'PUT', rulesUrl(), { version: current.template.version, baseSizeRule: null, points: [], rules: [] }, 403)
    await refused('viewer', 'PUT', rulesUrl(), { version: current.template.version, baseSizeRule: null, points: [], rules: [] }, 403)
    expect((await getRules()).template.version).toBe(current.template.version)
  })

  it('turning the rules on is the Owner’s word (product.mtm.switch); the state it is in already changes nothing', async () => {
    const current = await getRules()
    await refused('keeper', 'PUT', `${rulesUrl()}/switch`, { version: current.template.version, on: true }, 403)
    await refused('companyA', 'PUT', `${rulesUrl()}/switch`, { version: current.template.version, on: true }, 403)
    const on = (await ok('owner', 'PUT', `${rulesUrl()}/switch`, { version: current.template.version, on: true, reason: 'The first made-to-measure order (made-up).' })).rules
    expect(on.template).toMatchObject({ rulesOn: true, version: current.template.version + 1 })
    expect(on.summary).toMatch(/^On · /)
    expect((await eventsOf('measurement_template.mtm_rules_changed')).at(-1)).toMatchObject({ change: 'ON' })
    const audit = await one(`SELECT "before", "after", reason FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'MeasurementTemplate' AND "recordId" = $2 ORDER BY at DESC, id DESC LIMIT 1`, [tenant, seed.templateIds.jacket])
    expect(audit).toMatchObject({ before: { rulesOn: false }, after: { rulesOn: true }, reason: 'The first made-to-measure order (made-up).' })
    const same = (await ok('owner', 'PUT', `${rulesUrl()}/switch`, { version: on.template.version, on: true })).rules
    expect(same.template.version).toBe(on.template.version)
  })
})

describe('the one check of a measurement set (PRD-017, PRD-201 … PRD-204)', () => {
  beforeAll(async () => {
    const current = await getRules()
    await ok('keeper', 'PUT', rulesUrl(), { version: current.template.version, baseSizeRule: { points: ['chest'], tie: 'LARGER' }, points: [], rules: SEED_RULES })
    expect((await getRules()).template.rulesOn).toBe(true)
  })

  it('a rider’s profile against SEED-JKT-01: base size 52 suggested, within its limits, the BOM scaled from size 52', async () => {
    // P1's rider: chest 100 (the top of 50 and the bottom of 52: the larger), waist 84, sleeve 64.5.
    const result = await check({ styleId: seed.jacket.styleId, measurementProfileId: profileP1 })
    expect(result).toMatchObject({ verdict: 'OK', rulesOn: true, template: { code: 'JACKET' }, style: { code: 'SEED-JKT-01', mtmAllowed: true, revision: { revision: 1, status: 'DRAFT' } }, profile: { revision: 1, garmentType: 'JACKET' } })
    expect(result.rules.map((rule: Json) => [rule.code, rule.outcome])).toEqual([
      ['CHEST_RANGE', 'PASSED'],
      ['WAIST_TO_CHEST', 'PASSED'],
    ])
    expect(result.baseSize).toMatchObject({ size: '52', how: 'INSIDE', tie: true, used: '52', typed: null })
    expect(result.alterations.map((row: Json) => [row.code, row.outcome, row.difference])).toEqual([
      ['chest', 'WITHIN', '-2'],
      ['waist', 'NO_BASE_MEASURE', null],
      ['sleeve', 'NO_BASE_MEASURE', null],
    ])
    const lines = Object.fromEntries(result.consumption.map((row: Json) => [row.seq, [row.baseQty, row.unitQty]]))
    // Leather 45 × (1 + 1 × (100 ÷ 102 − 1)); lining 1.8 × (1 + 0.8 × (100 ÷ 102 − 1)); the protector is not marked.
    expect(lines).toMatchObject({ 10: ['45', '44.1176'], 20: ['1.8', '1.7718'], 30: ['2', '2'] })
    expect(result).toMatchObject({ certificate: null, consumptionHidden: false, insideCertifiedRange: true, blocks: [], warnings: [] })
    expect(result.notes).toContain('The certificate is asked for a colourway: name one to have it checked.')
  })

  it('typed measures: a BLOCK rule, an alteration beyond its limit and the certificate block; a WARN rule and a typed base size warn', async () => {
    const result = await check({
      styleId: seed.jacket.styleId,
      measurements: { chest: { value: '120', unit: 'cm' }, waist: { value: '150', unit: 'cm' }, sleeve: { value: '64', unit: 'cm' } },
      baseSize: '52',
      colourwayId: seed.jacket.colourwayIds[0],
    })
    expect(result.verdict).toBe('BLOCK')
    expect(result.blocks.map((finding: Json) => [finding.kind, finding.ref])).toEqual([
      ['RULE', 'CHEST_RANGE'],
      ['ALTERATION', 'chest'],
      ['CERTIFICATE', 'no_certificate'],
    ])
    expect(result.blocks[0]).toMatchObject({ words: { it: 'Torace fuori misura: misuralo di nuovo' }, message: 'Chest out of range: measure it again (Chest 120 cm is outside 88–116 cm.)' })
    expect(result.blocks[1].message).toBe('Chest 120 cm is +18 cm from size 52 (102): beyond its limits −4/+6. A pattern maker reviews the unit: it is outside the certified range of the basic model.')
    expect(result.warnings.map((finding: Json) => [finding.kind, finding.ref])).toEqual([
      ['RULE', 'WAIST_TO_CHEST'],
      ['BASE_SIZE', '52'],
    ])
    expect(result.baseSize).toMatchObject({ size: '54', how: 'NEAREST', used: '52', typed: '52' })
    expect(result.certificate).toMatchObject({ allowed: false, outcome: 'refused', certificateNumber: null })
    expect(result.insideCertifiedRange).toBe(false)
  })

  it('PRD-017: a style not made to measure takes no made-to-measure unit (its own words, beside the template’s)', async () => {
    const result = await check({ styleId: seed.trousers.styleId, templateId: seed.templateIds.trousers, measurements: { outseam: { value: '100', unit: 'cm' }, inseam: { value: '104', unit: 'cm' } } })
    expect(result.style).toMatchObject({ code: 'SEED-TRS-01', mtmAllowed: false })
    expect(result.blocks.map((finding: Json) => finding.kind)).toEqual(['STYLE_NOT_MTM', 'NO_TEMPLATE'])
    // The TROUSERS rules are off: the inseam longer than the outseam is not checked.
    expect(result).toMatchObject({ rulesOn: false, rules: [], verdict: 'BLOCK' })
  })

  it('who may: a profile’s measures need sales.measurements.view, the consumption product.bom.view; rules off check nothing', async () => {
    await refused('viewer', 'POST', '/product/made-to-measure/check', { styleId: seed.jacket.styleId, measurementProfileId: profileP1 }, 404)
    await refused('otherTenant', 'POST', '/product/made-to-measure/check', { styleId: seed.jacket.styleId, measurements: {} }, 404)
    const seen = await check({ styleId: seed.jacket.styleId, measurements: { chest: { value: '100', unit: 'cm' } } }, 'viewer')
    expect(seen).toMatchObject({ consumption: null, consumptionHidden: true, baseSize: { size: '52' } })
    const current = await getRules()
    await ok('owner', 'PUT', `${rulesUrl()}/switch`, { version: current.template.version, on: false })
    const off = await check({ templateId: seed.templateIds.jacket, measurements: { chest: { value: '200', unit: 'cm' } } })
    expect(off).toMatchObject({ rulesOn: false, rules: [], verdict: 'OK', style: null, baseSize: { size: null } })
    const back = await getRules()
    await ok('owner', 'PUT', `${rulesUrl()}/switch`, { version: back.template.version, on: true })
  })

  it('REFUSES a check that names neither a style nor a template, both measures and a profile, a base size outside the range', async () => {
    expect(paths(await refused('keeper', 'POST', '/product/made-to-measure/check', { measurements: {} }, 400))).toEqual(['body/styleId'])
    expect(paths(await refused('keeper', 'POST', '/product/made-to-measure/check', { styleId: seed.jacket.styleId, measurements: {}, measurementProfileId: profileP1 }, 400))).toEqual(['body/measurements'])
    expect(paths(await refused('keeper', 'POST', '/product/made-to-measure/check', { styleId: seed.jacket.styleId, measurements: {}, baseSize: '48' }, 400))).toEqual(['body/baseSize'])
    expect(paths(await refused('keeper', 'POST', '/product/made-to-measure/check', { templateId: seed.templateIds.jacket, measurements: { chest: { value: 'big', unit: 'cm' } } }, 400))).toEqual(['body/measurements/chest/value'])
  })
})

describe('a BOM line marked to scale (PRD-204)', () => {
  const protectorLine = () => idOf('product:bom:JKT-01:1:30')

  it('marks the protector line to follow the sleeve, then unmarks it; audited on the line; style.bom_changed', async () => {
    const marked = await ok('keeper', 'PUT', scaleUrl(protectorLine()), { version: await revisionVersion(seed.jacket.revisionId), pointCode: 'sleeve', factor: '0.50' })
    expect(marked).toMatchObject({ line: { id: protectorLine(), seq: 30, scale: { pointId: seed.templatePointIds.sleeve, pointCode: 'sleeve', factor: '0.5' } }, revision: { id: seed.jacket.revisionId } })
    expect(await one(`SELECT "mtmScalePointId", "mtmScaleFactor"::text AS factor FROM "BomLine" WHERE id = $1`, [protectorLine()])).toEqual({ mtmScalePointId: seed.templatePointIds.sleeve, factor: '0.5000' })
    expect((await eventsOf('style.bom_changed')).at(-1)).toMatchObject({ styleId: seed.jacket.styleId, lineIds: [protectorLine()] })
    const audit = await one(`SELECT "after" FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'BomLine' AND "recordId" = $2 ORDER BY at DESC, id DESC LIMIT 1`, [tenant, protectorLine()])
    expect(audit.after).toEqual({ mtmScale: { pointCode: 'sleeve', factor: '0.5' } })
    const result = await check({ styleId: seed.jacket.styleId, measurements: { chest: { value: '102', unit: 'cm' }, sleeve: { value: '64', unit: 'cm' } } })
    expect(result.consumption.find((row: Json) => row.seq === 30)).toMatchObject({ unitQty: '2', detail: 'Size 52 gives no body measure for Sleeve: its quantity.' })
    const cleared = await ok('keeper', 'PUT', scaleUrl(protectorLine()), { version: marked.revision.version, pointCode: null, factor: null })
    expect(cleared.line.scale).toBeNull()
    expect(await one(`SELECT "mtmScalePointId", "mtmScaleFactor" FROM "BomLine" WHERE id = $1`, [protectorLine()])).toEqual({ mtmScalePointId: null, mtmScaleFactor: null })
  })

  it('REFUSES a factor out of range, a lone point, a point of another template, a stale version, a released revision and a person without the right', async () => {
    const version = await revisionVersion(seed.jacket.revisionId)
    expect(paths(await refused('keeper', 'PUT', scaleUrl(protectorLine()), { version, pointCode: 'sleeve', factor: '11' }, 400))).toEqual(['body/factor'])
    expect(paths(await refused('keeper', 'PUT', scaleUrl(protectorLine()), { version, pointCode: 'sleeve', factor: null }, 400))).toEqual(['body/factor'])
    expect(paths(await refused('keeper', 'PUT', scaleUrl(protectorLine()), { version, pointCode: 'inseam', factor: '1' }, 400))).toEqual(['body/pointCode'])
    expect((await refused('keeper', 'PUT', scaleUrl(protectorLine()), { version: version - 1, pointCode: 'sleeve', factor: '1' }, 409)).code).toBe('conflict')
    // SEED-TRS-01's revision 1 is RELEASED: its BOM is frozen (refused before any line is read).
    const frozen = await refused('keeper', 'PUT', scaleUrl(newId(), seed.trousers.styleId, seed.trousers.revisionId), { version: await revisionVersion(seed.trousers.revisionId), pointCode: 'inseam', factor: '1' }, 409)
    expect(frozen.code).toBe('invalid_state')
    await refused('viewer', 'PUT', scaleUrl(protectorLine()), { version, pointCode: 'sleeve', factor: '1' }, 403)
    expect(await revisionVersion(seed.jacket.revisionId)).toBe(version)
  })
})

describe('the measurement link calls the same rules (B-W2b-171, sales/measure-link/checks.ts)', () => {
  it('a broken BLOCK rule at its point in the rider’s language, a WARN rule said; nothing while the rules are off', async () => {
    const system = callerFor(database, systemContext(tenant, newId()))
    const on = await system.withClient((client) => linkRuleChecks(client, 'JACKET', { chest: { value: '140', unit: 'cm' }, waist: { value: '170', unit: 'cm' } }, 'it'))
    expect(on).toEqual({
      on: true,
      blocks: [{ path: 'body/values/chest', message: 'Torace fuori misura: misuralo di nuovo' }],
      warnings: [{ code: 'WAIST_TO_CHEST', pointCode: 'waist', message: 'Vita e torace non tornano' }],
    })
    const off = await system.withClient((client) => linkRuleChecks(client, 'TROUSERS', { outseam: { value: '80', unit: 'cm' }, inseam: { value: '90', unit: 'cm' } }, 'it'))
    expect(off).toEqual({ on: false, blocks: [], warnings: [] })
    expect(await system.withClient((client) => linkRuleChecks(client, 'NO_SUCH_TYPE', {}, 'en'))).toEqual({ on: false, blocks: [], warnings: [] })
  })
})
