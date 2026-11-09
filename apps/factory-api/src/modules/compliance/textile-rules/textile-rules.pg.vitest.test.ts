import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { compositionFor } from '../../sales/portal-ordering/composition'
import { useTextileRulesClock } from './switches'

/**
 * The textile, leather and origin checks (B-W2b-208) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login, so row-level security and the product guards are real),
 * seeded with the core, pricing and compliance seeds (the seed jacket SEED-JKT-01: cowhide, a polyester lining and two
 * protectors, cut, sewn, inspected and packed in-house, label SEED-LBL-JKT-01 r1 ACTIVE on its draft revision 1; the brand
 * P1's price list prices it). A made-up "eco-leather" jacket beside it: a polyurethane-coated fabric named "Ecopelle", a
 * nylon lining, sewn by a workshop whose pieces go to Romania. The customer's catalogue is read as the portal reads it
 * (compositionFor in the office scope as the person). Every name, code, weight and country is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/compliance/textile-rules`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'PUT'

const NS = 'textile-rules-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteB = seedId('site:B1')
const brand = seedId('party:P1')
const supplier = seedId('party:P2')
const jacket = seedId('product:style:JKT-01')
const jacketRev1 = seedId('product:revision:JKT-01:1')
const seedLabel = seedId('compliance:label:JKT-01:1')
const lining = seedId('product:item:lining')
const otherTenant = newId()
const user = newId()

// The made-up eco jacket of company A.
const eco = newId()
const ecoRev = newId()
const ecoBlack = newId()
const shell = newId()
const nylon = newId()
const workshop = newId()
const cutOp = newId()
const sewOp = newId()

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.textileRules.manage'
const clock: Clock = { now: () => new Date('2026-11-09T09:00:00.000Z') }
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(tenant, [grant([VIEW, MANAGE])]),
  viewer: office(tenant, [grant([VIEW])]),
  companyB: office(tenant, [grant([VIEW, MANAGE], [companyB])]),
  otherTenant: office(otherTenant, [grant([VIEW, MANAGE])]),
  nobody: office(tenant, [grant(['product.styles.view'])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteB, deviceId: newId(), grants: [grant(['floor.work', VIEW, MANAGE], [companyB])] },
  partner: { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: brand, grants: [grant([VIEW, MANAGE, 'portal.catalogue.view'])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'PUT' ? { 'idempotency-key': newId() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const resultOf = (checks: Json, key: string): Json => checks.results.find((result: Json) => result.key === key)
const outcomes = (checks: Json) => Object.fromEntries(checks.results.map((result: Json) => [result.key, result.outcome]))
const asPerson = <T>(work: (client: Parameters<Parameters<FactoryDatabase['withScope']>[1]>[0]) => Promise<T>) => database.withScope({ audience: 'office', tenantId: tenant, actorId: user }, work)

beforeAll(async () => {
  db = await migratedDatabase('textile_rules')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedPricing({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'textile-rules-other'])
  useTextileRulesClock(clock)

  const scale = seedId('product:size-scale:EU-JKT')
  await admin(
    `INSERT INTO "Style" (id, "tenantId", "companyId", code, name, "nameI18n", "productType", "sizeScaleId", sizes, "baseSize", "ppeCategory", "originCountry", "netMassKg", status)
     VALUES ($1, $2, $3, 'TEST-ECO-01', 'Test eco jacket', '{"it": "Giacca in ecopelle"}', 'JACKET', $4, ARRAY['50','52'], '52', 'NOT_PPE', 'IT', 0.600, 'DRAFT')`,
    [eco, tenant, companyA, scale],
  )
  await admin(`INSERT INTO "Colourway" (id, "tenantId", "styleId", code, name) VALUES ($1, $2, $3, 'BLK', 'Black')`, [ecoBlack, tenant, eco])
  await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status) VALUES ($1, $2, $3, 1, 'DRAFT')`, [ecoRev, tenant, eco])
  const item = `INSERT INTO "Item" (id, "tenantId", "companyId", code, name, kind, "baseUom", "purchaseUom", "consumptionUom", composition, attributes) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, $8, $9)`
  await admin(item, [shell, tenant, companyA, 'TEST-ECO-PU', 'Ecopelle PU', 'TEXTILE', 'M2', JSON.stringify([{ fibre: 'polyurethane', percent: '100' }]), JSON.stringify({ weight: '300 g/m2' })])
  await admin(item, [nylon, tenant, companyA, 'TEST-NYL-01', 'Nylon lining', 'LINING', 'M', JSON.stringify([{ fibre: 'nylon', percent: '100' }]), JSON.stringify({ weight: '100 g/m' })])
  const line = `INSERT INTO "BomLine" (id, "tenantId", "styleId", "revisionId", seq, "itemId", qty, uom) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
  await admin(line, [newId(), tenant, eco, ecoRev, 10, shell, '1.5', 'M2'])
  await admin(line, [newId(), tenant, eco, ecoRev, 20, nylon, '1.2', 'M'])
  // The workshop is established in Italy and works in Romania: its default delivery address is there.
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles, country) VALUES ($1, $2, 'TEST-WS-RO', 'ORGANISATION', 'Test Workshop S.r.l.', ARRAY['SUBCONTRACTOR']::"PartyRole"[], 'IT')`, [workshop, tenant])
  await admin(
    `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, line1, "postalCode", city, country, "isDefaultShipTo") VALUES ($1, $2, $3, ARRAY['SHIP_TO']::"PartyAddressKind"[], 'Strada Test 1', '000000', 'Testville', 'RO', true)`,
    [newId(), tenant, workshop],
  )
  const op = `INSERT INTO "Operation" (id, "tenantId", code, name, "workCentreKind", "standardMinutes") VALUES ($1, $2, $3, $3, $4, 10)`
  await admin(op, [cutOp, tenant, 'TEST-CUT', 'CUTTING'])
  await admin(op, [sewOp, tenant, 'TEST-SEW', 'SEWING'])
  const step = `INSERT INTO "RoutingOperation" (id, "tenantId", "styleId", "revisionId", seq, "operationId", code, name, "workCentreKind", "standardMinutes", "supplierId") VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 10, $9)`
  await admin(step, [newId(), tenant, eco, ecoRev, 10, cutOp, 'TEST-CUT', 'CUTTING', null])
  await admin(step, [newId(), tenant, eco, ecoRev, 20, sewOp, 'TEST-SEW', 'SEWING', workshop])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  useTextileRulesClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the checks of the seed jacket (PRD-338, PRD-339, PRD-345)', () => {
  it('computes the lining from the BOM, finds the leather, and passes the label; the three open checks are OFF and say why', async () => {
    const { checks } = await ok('viewer', 'GET', `/compliance/textile-rules/styles/${jacket}`)
    expect(checks).toMatchObject({
      style: { id: jacket, code: 'SEED-JKT-01' },
      revision: { id: jacketRev1, revision: 1, status: 'DRAFT' },
      size: '52',
      label: { id: seedLabel, code: 'SEED-LBL-JKT-01', revision: 1, status: 'ACTIVE', languages: ['it', 'en'] },
      switches: [{ rule: 'textileShare', on: false }, { rule: 'careLabel', on: false }, { rule: 'madeInItaly', on: false }],
      asOf: '2026-11-09T09:00:00.000Z',
    })
    expect(outcomes(checks)).toEqual({ composition: 'PASS', fibreNames: 'PASS', animalOrigin: 'PASS', textileShare: 'OFF', careLabel: 'OFF', madeInItaly: 'OFF', leatherNaming: 'PASS' })
    expect(checks.composition).toEqual([
      {
        colourways: ['BLK', 'RED'],
        parts: [{ component: 'LINING', part: 'lining', words: { en: 'lining', it: 'fodera' }, fibres: [{ fibre: 'polyester', annex: true, percent: '100', names: { en: 'polyester', it: 'poliestere' } }], basis: 'ONE_COMPOSITION', materials: ['SEED-LIN-200'] }],
        findings: [],
      },
    ])
    expect(checks.animalOrigin).toMatchObject({ needed: true, materials: [{ code: 'SEED-LEA-100' }], phrases: [{ language: 'it', text: 'Contiene parti non tessili di origine animale' }, { language: 'en' }] })
    expect(resultOf(checks, 'animalOrigin').words).toContain('Added because the BOM has SEED-LEA-100')
    expect(resultOf(checks, 'textileShare')).toMatchObject({ on: false, switchable: true, outcome: 'OFF', words: expect.stringContaining('Q10'), findings: [], law: [{ law: 'Reg. (EU) 1007/2011 art. 2(2)(a)' }] })
    // Switched off, the values are still there: no weight on the cowhide, no net mass.
    expect(checks.textileShare[0]).toMatchObject({ pct: null, applies: null, basis: 'BOM', missing: expect.arrayContaining([expect.objectContaining({ code: 'SEED-LEA-100' })]) })
    // Every in-house step at the tenant's plants (the style is for every company), all in Italy.
    expect(checks.origin).toMatchObject({ madeInItaly: 'ALLOWED', fullMadeInItaly: 'ALLOWED', styleOrigin: null })
    expect(checks.origin.steps.map((step: Json) => [step.seq, step.where, step.country, step.makesUp])).toEqual([
      [10, 'IN_HOUSE', 'IT', false],
      [20, 'IN_HOUSE', 'IT', true],
      [30, 'IN_HOUSE', 'IT', false],
      [40, 'IN_HOUSE', 'IT', false],
    ])
    expect(checks.care.missingGroups).toEqual(['DRYING'])
    expect(checks.care.entries[0]).toEqual({ symbol: 'wash-not', group: 'WASHING', words: [{ language: 'it', text: 'Non lavare', typed: false }, { language: 'en', text: 'Do not wash', typed: false }] })
    for (const result of checks.results) expect(result.law.length).toBeGreaterThan(0)
  })

  it('reads another size, and refuses a size, revision or site that is not the style\'s', async () => {
    expect((await ok('viewer', 'GET', `/compliance/textile-rules/styles/${jacket}?size=50&revisionId=${jacketRev1}`)).checks.size).toBe('50')
    expect(await refused('viewer', 'GET', `/compliance/textile-rules/styles/${jacket}?size=99`, undefined, 400)).toMatchObject({ code: 'validation_failed', issues: [{ path: 'querystring/size' }] })
    expect(await refused('viewer', 'GET', `/compliance/textile-rules/styles/${jacket}?revisionId=${ecoRev}`, undefined, 400)).toMatchObject({ issues: [{ path: 'querystring/revisionId' }] })
    expect(await refused('viewer', 'GET', `/compliance/textile-rules/styles/${eco}?siteId=${siteB}`, undefined, 400)).toMatchObject({ issues: [{ path: 'querystring/siteId' }] })
  })

  it('is office only, with the view permission over the style\'s company; another tenant or company sees nothing', async () => {
    await refused('nobody', 'GET', `/compliance/textile-rules/styles/${jacket}`, undefined, 403)
    await refused('floor', 'GET', `/compliance/textile-rules/styles/${jacket}`, undefined, 403)
    await refused('partner', 'GET', `/compliance/textile-rules/styles/${jacket}`, undefined, 403)
    await refused('otherTenant', 'GET', `/compliance/textile-rules/styles/${jacket}`, undefined, 404)
    await refused('companyB', 'GET', `/compliance/textile-rules/styles/${eco}`, undefined, 404)
    await refused('viewer', 'GET', '/compliance/textile-rules/styles/not-a-style', undefined, 404)
  })
})

describe('the switches (Owner 2026-11-09: open lines and claims built switched off)', () => {
  it('switches a check on with a reason, once, for the whole factory, audited with its event', async () => {
    const { switches } = await ok('viewer', 'GET', '/compliance/textile-rules/switches')
    expect(switches.map((entry: Json) => [entry.rule, entry.on, entry.changedAt])).toEqual([['textileShare', false, null], ['careLabel', false, null], ['madeInItaly', false, null]])
    expect(switches[2].words.off).toContain('Q23')

    const answer = await ok('manager', 'PUT', '/compliance/textile-rules/switches/madeInItaly', { on: true, reason: 'A brand asks for Made in Italy on the label.' })
    expect(answer.switch).toMatchObject({ rule: 'madeInItaly', on: true, reason: 'A brand asks for Made in Italy on the label.', changedAt: '2026-11-09T09:00:00.000Z' })
    expect(await refused('manager', 'PUT', '/compliance/textile-rules/switches/madeInItaly', { on: true, reason: 'Again.' }, 409)).toMatchObject({ code: 'invalid_state', message: 'The check "Made in Italy" is already on.' })
    await ok('manager', 'PUT', '/compliance/textile-rules/switches/textileShare', { on: true, reason: 'The eco jacket is mostly textile.' })

    expect(await admin('SELECT action, "recordType", before, after, reason FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [tenant])).toEqual([
      { action: 'compliance.textileRules.switch', recordType: 'Tenant', before: { rule: 'madeInItaly', on: false }, after: { rule: 'madeInItaly', on: true }, reason: 'A brand asks for Made in Italy on the label.' },
      { action: 'compliance.textileRules.switch', recordType: 'Tenant', before: { rule: 'textileShare', on: false }, after: { rule: 'textileShare', on: true }, reason: 'The eco jacket is mostly textile.' },
    ])
    expect((await admin('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [tenant])).map((event) => [event.type, event.payload])).toEqual([
      ['textile_rule.switched', { rule: 'madeInItaly', on: true }],
      ['textile_rule.switched', { rule: 'textileShare', on: true }],
    ])
    const after = (await ok('viewer', 'GET', '/compliance/textile-rules/switches')).switches
    expect(after.map((entry: Json) => [entry.rule, entry.on])).toEqual([['textileShare', true], ['careLabel', false], ['madeInItaly', true]])
  })

  it('refuses a switch without a reason, of an unknown check, without the permission or a grant over every company', async () => {
    await refused('manager', 'PUT', '/compliance/textile-rules/switches/careLabel', { on: true, reason: '' }, 400)
    await refused('manager', 'PUT', '/compliance/textile-rules/switches/composition', { on: false, reason: 'Not a switch.' }, 404)
    await refused('viewer', 'PUT', '/compliance/textile-rules/switches/careLabel', { on: true, reason: 'No right.' }, 403)
    expect(await refused('companyB', 'PUT', '/compliance/textile-rules/switches/careLabel', { on: true, reason: 'One company only.' }, 403)).toMatchObject({ message: expect.stringContaining('every company') })
    await refused('floor', 'PUT', '/compliance/textile-rules/switches/careLabel', { on: true, reason: 'Floor.' }, 403)
  })
})

describe('the eco jacket: leather words, the 80 % rule and Made in Italy switched on (PRD-340, PRD-344, PRD-345)', () => {
  it('fails the leather words, weighs it textile, and refuses "Made in Italy" for its sewing in Romania', async () => {
    const { checks } = await ok('viewer', 'GET', `/compliance/textile-rules/styles/${eco}`)
    expect(outcomes(checks)).toMatchObject({ composition: 'UNKNOWN', animalOrigin: 'UNKNOWN', textileShare: 'PASS', careLabel: 'OFF', madeInItaly: 'FAIL', leatherNaming: 'FAIL' })
    expect(resultOf(checks, 'leatherNaming').findings).toEqual([
      expect.objectContaining({ path: 'materials/TEST-ECO-PU/name', severity: 'FAIL', message: expect.stringContaining('"ecopelle"') }),
      expect.objectContaining({ path: 'style/name', severity: 'FAIL' }),
    ])
    // 1.5 m² × 300 g/m² + 1.2 m × 100 g/m = 570 g of 600 g.
    expect(checks.textileShare).toEqual([expect.objectContaining({ colourways: ['BLK'], pct: '95', applies: true, basis: 'NET_MASS', textileGrams: '570', garmentGrams: '600' })])
    expect(resultOf(checks, 'textileShare').words).toBe('Textile share 95 % by weight: textile labelling applies.')
    expect(checks.composition[0].parts.map((part: Json) => [part.component, part.fibres])).toEqual([
      ['SHELL', [{ fibre: 'polyurethane', annex: true, percent: '100', names: { en: 'polyurethane' } }]],
      ['LINING', [{ fibre: 'polyamide', annex: true, percent: '100', names: { en: 'polyamide', it: 'poliammide' } }]],
    ])
    expect(resultOf(checks, 'composition').words).toBe('Revision 1 names no label yet: the BOM gives outer fabric 100 % polyurethane; lining 100 % polyamide.')
    expect(checks.origin).toMatchObject({ madeInItaly: 'NOT_ALLOWED', fullMadeInItaly: 'NOT_ALLOWED', styleOrigin: 'IT' })
    expect(checks.origin.steps[1]).toMatchObject({ seq: 20, where: 'WORKSHOP', country: 'RO', makesUp: true, places: [{ code: 'TEST-WS-RO', name: 'Test Workshop S.r.l.', country: 'RO' }] })
    expect(resultOf(checks, 'madeInItaly').findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'steps/20', severity: 'FAIL' }), expect.objectContaining({ path: 'style/originCountry', severity: 'FAIL' })]),
    )
  })
})

describe("the customer's catalogue before purchase (PRD-341)", () => {
  const read = (partyId: string, language: string) => asPerson((client) => compositionFor(client, { companyId: companyA, partyId, day: '2026-11-02', styleId: jacket, language }))

  it('offers nothing outside the catalogue, then gives the BOM, then the active label of the released revision, in the language asked', async () => {
    await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [jacket])
    expect(await read(supplier, 'it')).toBe(null)
    expect(await read(brand, 'it')).toMatchObject({ styleId: jacket, revision: null, source: null, groups: [] })

    // Revision 1 released without its label: the fibres come from the BOM, with the official Italian names.
    await admin(`UPDATE "StyleRevision" SET "labelTemplateId" = NULL WHERE id = $1`, [jacketRev1])
    await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = '2026-11-01T08:00:00Z' WHERE id = $1`, [jacketRev1])
    expect(await read(brand, 'it')).toEqual({
      styleId: jacket,
      revision: 1,
      source: 'BOM',
      language: 'it',
      groups: [{ colourways: ['BLK', 'RED'], parts: [{ part: 'fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] }] }],
      animalOrigin: 'Contiene parti non tessili di origine animale',
      words: 'From the materials of revision 1.',
    })

    // Revision 2 names the active label: the label's words, in English.
    const rev2 = newId()
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status, "labelTemplateId") VALUES ($1, $2, $3, 2, 'DRAFT', $4)`, [rev2, tenant, jacket, seedLabel])
    await admin(`INSERT INTO "BomLine" (id, "tenantId", "styleId", "revisionId", seq, "itemId", qty, uom) VALUES ($1, $2, $3, $4, 20, $5, 1.8, 'M')`, [newId(), tenant, jacket, rev2, lining])
    await admin(`UPDATE "StyleRevision" SET status = 'OBSOLETE' WHERE id = $1`, [jacketRev1])
    await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = '2026-11-02T08:00:00Z' WHERE id = $1`, [rev2])
    expect(await read(brand, 'en')).toEqual({
      styleId: jacket,
      revision: 2,
      source: 'LABEL',
      language: 'en',
      groups: [{ colourways: [], parts: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }] }],
      animalOrigin: 'Contains non-textile parts of animal origin',
      words: "As on the garment's label (revision 2).",
    })
  })

  it('is the customer portal\'s route: an office or a partner session without a portal session is refused', async () => {
    await refused('viewer', 'GET', `/portal/catalogue/${jacket}/composition`, undefined, 403)
    await refused('partner', 'GET', `/portal/catalogue/${jacket}/composition`, undefined, 401)
  })
})

describe("the label builder's words", () => {
  it('gives the official fibre names, the care words, the phrases and the parts', async () => {
    const { vocabulary } = await ok('viewer', 'GET', '/compliance/textile-rules/vocabulary')
    expect(vocabulary.fibres.find((fibre: Json) => fibre.key === 'polyamide')).toMatchObject({ names: { en: 'polyamide', it: 'poliammide' }, brands: ['cordura'] })
    expect(vocabulary.care.find((entry: Json) => entry.symbol === 'iron-not')).toEqual({ symbol: 'iron-not', group: 'IRONING', words: { it: 'Non stirare', en: 'Do not iron' } })
    expect(vocabulary.animalOrigin.map((phrase: Json) => phrase.language)).toEqual(['it', 'en', 'de', 'fr', 'es'])
    expect(vocabulary.components.map((component: Json) => component.component)).toEqual(['SHELL', 'LINING', 'PADDING', 'MEMBRANE'])
    await refused('nobody', 'GET', '/compliance/textile-rules/vocabulary', undefined, 403)
  })
})
