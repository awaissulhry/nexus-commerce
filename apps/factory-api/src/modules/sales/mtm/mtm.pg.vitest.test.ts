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
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * The made-to-measure office (B-W2b-358; B-W1-17, B-W1-18; SAL-276, SAL-291, SAL-292, SAL-300, SAL-303; MM1:01) on the local
 * stack, through the app's real routes: a throwaway PostgreSQL 17 database with every factory-db seed (the JACKET template —
 * chest, waist, sleeve, its rules CHEST_RANGE and WAIST_TO_CHEST, OFF as built —, SEED-JKT-01 flagged made to measure, SEED-JKT-02
 * not, the private rider SEED-R1 with its contact, company A's mail identity), FAKE files and mail (the harness), and office
 * people holding their role templates (sales, the production manager, the administrator, the owner, read-only). SEED-JKT-01's
 * brand is cleared (test data past its guards) so the private rider may order it. Every name, number and address is made up;
 * every time is taken relative to now (no test depends on today's date). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/mtm/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'mtm-358'
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
  app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `w2b358-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const S = { r1: '', jacket: '', jkt01: '', blk: '', jkt02: '', jkt02blk: '', q2: '', contact: '' }
const RIDER = 'Made-up rider 358'
const OLD_RIDER = 'Made-up old rider 358'
const values = { chest: '100', waist: '84', sleeve: '64', height: '178' }

beforeAll(async () => {
  h = await startHarness('mtm_w2b358')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (sales.mtm.record for sales, .review for the production manager).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b358-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  S.r1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R1'`, [T])).id
  S.contact = (await one<{ id: string }>(`SELECT id FROM "PartyContact" WHERE "partyId" = $1 AND email IS NOT NULL ORDER BY "createdAt", id LIMIT 1`, [S.r1])).id
  S.jacket = (await one<{ id: string }>(`SELECT id FROM "MeasurementTemplate" WHERE "tenantId" = $1 AND code = 'JACKET'`, [T])).id
  S.jkt01 = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [T])).id
  S.blk = (await one<{ id: string }>(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [S.jkt01])).id
  S.jkt02 = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [T])).id
  S.jkt02blk = (await one<{ id: string }>(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [S.jkt02])).id
  S.q2 = (await one<{ id: string }>(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0002'`, [T])).id
  // Test data past its guards: SEED-JKT-01 has no brand here, so the private rider may order it (B-W2b-294's private label).
  await force(`UPDATE "Style" SET "brandPartyId" = NULL WHERE id = $1`, [S.jkt01])
  // Company A's letterhead complete (c.c. art. 2250): the worksheet prints it.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const templateUrl = () => `/product/measurement-templates/${S.jacket}`
const jacket = async () => (await ok('owner', 'GET', templateUrl())).template
const JACKET_POINTS = (extra: Json[] = []) => [
  { code: 'chest', name: 'Chest', minValue: '70', maxValue: '150', howTo: 'Around the fullest part of the chest.' },
  { code: 'waist', name: 'Waist', minValue: '60', maxValue: '140', howTo: 'Around the natural waist.' },
  { code: 'sleeve', name: 'Sleeve', minValue: '50', maxValue: '80', howTo: 'Shoulder point to wrist, arm bent forward.' },
  ...extra,
]

describe('measurement templates (B-W1-17)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('reads the JACKET template page: points, B-W2b-248’s rules in words, what is measured with it; who may change it', async () => {
    const template = await jacket()
    expect(template).toMatchObject({ code: 'JACKET', rulesOn: false, status: 'ACTIVE', editable: true, styles: { madeToMeasure: 1 } })
    expect(template.points.map((point: Json) => [point.code, point.rules])).toEqual([['chest', 2], ['waist', 1], ['sleeve', 0]])
    expect(template.rulesSummary).toContain('Off (nothing is checked)')
    expect((await ok('reader', 'GET', templateUrl())).template).toMatchObject({ editable: false })
    await no('sales', 'PUT', `${templateUrl()}/points`, { version: template.version, points: JACKET_POINTS() }, 403)
  })

  it('saves the points whole (the height added), and REFUSES an archived point an active rule still checks', async () => {
    const before = await jacket()
    const refused = await no('owner', 'PUT', `${templateUrl()}/points`, { version: before.version, points: JACKET_POINTS().filter((point) => point.code !== 'chest') }, 400)
    expect(refused.message).toContain('change the rules first')
    expect(paths(refused)).toContain('template/rules/0/pointCode')
    const saved = (await ok('owner', 'PUT', `${templateUrl()}/points`, { version: before.version, points: JACKET_POINTS([{ code: 'height', name: 'Height', minValue: '140', maxValue: '210', required: false }]) })).template
    expect(saved.version).toBe(before.version + 1)
    expect(saved.points.map((point: Json) => [point.code, point.seq, point.status])).toEqual([['chest', 1, 'ACTIVE'], ['waist', 2, 'ACTIVE'], ['sleeve', 3, 'ACTIVE'], ['height', 4, 'ACTIVE']])
    await no('owner', 'PUT', `${templateUrl()}/points`, { version: before.version, points: JACKET_POINTS() }, 409)
    expect((await outbox('measurement_template.changed')).at(-1)).toEqual({ templateId: S.jacket, code: 'JACKET', change: 'POINTS' })
  })

  it('makes a template, changes its header, archives and restores it; a code twice and a measured template’s archive are refused', async () => {
    const made = (await ok('owner', 'POST', '/product/measurement-templates', { code: 'RACE_SUIT', name: 'Made-up race suit', productType: 'SUIT', points: [{ code: 'chest', name: 'Chest', minValue: '70', maxValue: '150' }, { code: 'inseam', name: 'Inseam' }] }, 201)).template
    expect(made).toMatchObject({ code: 'RACE_SUIT', rulesOn: false, version: 1, profiles: 0 })
    expect((await no('owner', 'POST', '/product/measurement-templates', { code: 'RACE_SUIT', name: 'Again', productType: 'SUIT', points: [{ code: 'chest', name: 'Chest' }] }, 409)).message).toContain('exists already')
    const renamed = (await ok('owner', 'PATCH', `/product/measurement-templates/${made.id}`, { version: made.version, name: 'Made-up race suit, two pieces' })).template
    const archived = (await ok('owner', 'POST', `/product/measurement-templates/${made.id}/archive`, { version: renamed.version })).template
    expect(archived.status).toBe('ARCHIVED')
    expect((await ok('owner', 'POST', `/product/measurement-templates/${made.id}/restore`, { version: archived.version })).template.status).toBe('ACTIVE')
    const measured = await jacket()
    expect((await no('owner', 'POST', `${templateUrl()}/archive`, { version: measured.version }, 409)).message).toContain('style(s) are measured with JACKET')
  })
})

let rev1 = ''
let rev2 = ''

describe('rider profiles: who measured and where (SAL-291)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('records revision 1 measured by an office person of ours in the showroom, WAITING for the review', async () => {
    const recorded = await ok('sales', 'POST', '/sales/mtm/profiles', { partyId: S.r1, contactId: S.contact, riderName: RIDER, garmentType: 'JACKET', measurements: values, takenAt: ago(1), measuredByUserId: PEOPLE.sales, measuredPlace: 'Made-up showroom', privacyNoticeRef: 'Made-up notice v1', privacyNoticeAt: ago(2) }, 201)
    rev1 = recorded.profile.id
    expect(recorded.profile).toMatchObject({ revision: 1, takenBy: 'Made-up sales', measuredBy: { id: PEOPLE.sales, name: 'Made-up sales' }, measuredPlace: 'Made-up showroom', review: { status: 'WAITING', by: null } })
    expect(recorded.profile.measurements).toEqual({ chest: { value: '100', unit: 'cm' }, waist: { value: '84', unit: 'cm' }, sleeve: { value: '64', unit: 'cm' }, height: { value: '178', unit: 'cm' } })
    expect(recorded.checks).toMatchObject({ on: false, warnings: [] })
    expect((await outbox('measurement_profile.recorded')).at(-1)).toEqual({ profileId: rev1, partyId: S.r1, garmentType: 'JACKET', revision: 1, supersedesId: null })
  })

  it('REFUSES a value outside its range until confirmed, the same rider twice, a measure in the future, a partner’s user as the measurer', async () => {
    const body = { partyId: S.r1, riderName: `${RIDER} B`, garmentType: 'JACKET', measurements: { ...values, chest: '160' }, takenAt: ago(1), takenBy: 'Made-up dealer fitter', privacyNoticeRef: 'Made-up notice v1', privacyNoticeAt: ago(2) }
    const outside = await no('sales', 'POST', '/sales/mtm/profiles', body, 400)
    expect(outside.issues).toEqual([{ path: 'body/measurements/chest', message: 'Chest 160 cm is outside 70–150 cm: check it, then confirm it (confirmedOutside).' }])
    expect((await no('sales', 'POST', '/sales/mtm/profiles', { ...body, riderName: RIDER, measurements: values }, 409)).message).toContain('record a new revision of them')
    expect(paths(await no('sales', 'POST', '/sales/mtm/profiles', { ...body, measurements: values, takenAt: new Date(Date.now() + 3_600_000).toISOString() }, 400))).toEqual(['body/takenAt'])
    expect(paths(await no('sales', 'POST', '/sales/mtm/profiles', { ...body, measurements: values, measuredByUserId: newId() }, 400))).toEqual(['body/measuredByUserId'])
    await no('reader', 'POST', '/sales/mtm/profiles', body, 403)
  })

  it('lists the newest revision per rider with the tiles; the record shows the review the caller may make', async () => {
    const list = await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}`)
    expect(list.rows.find((row: Json) => row.riderName === RIDER)).toMatchObject({ id: rev1, revision: 1, review: { status: 'WAITING' }, measuredPlace: 'Made-up showroom', old: false, openUnits: 0 })
    expect(list.tiles).toMatchObject({ waitingReview: 2, needMore: 0, outsideRange: null })
    expect((await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}&review=WAITING&q=358`)).rows.map((row: Json) => row.riderName)).toEqual([RIDER])
    await no('reader', 'GET', '/sales/mtm/profiles', undefined, 403)
    const record = (await ok('pm', 'GET', `/sales/mtm/profiles/${rev1}`)).profile
    expect(record).toMatchObject({ latestId: rev1, riderName: RIDER, template: { code: 'JACKET', rulesOn: false }, review: { may: { confirm: true, askMore: true }, why: null, mailTo: true, outside: [] } })
    expect((await ok('sales', 'GET', `/sales/mtm/profiles/${rev1}`)).profile.review).toMatchObject({ may: { confirm: false, askMore: false }, why: expect.stringContaining('sales.mtm.review') })
  })
})

describe('the factory review (SAL-292)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('asks the rider for more, in words mailed from the company (FAKE); words are required', async () => {
    expect(paths(await no('pm', 'POST', `/sales/mtm/profiles/${rev1}/review`, { decision: 'NEED_MORE', note: ' ' }, 400))).toEqual(['body/note'])
    await no('sales', 'POST', `/sales/mtm/profiles/${rev1}/review`, { decision: 'CONFIRM' }, 403)
    const asked = await ok('pm', 'POST', `/sales/mtm/profiles/${rev1}/review`, { decision: 'NEED_MORE', note: 'Measure the sleeve again with the arm bent.', companyId: companyA, language: 'en' })
    expect(asked).toMatchObject({ mailed: true, delivery: 'SENT', profile: { review: { status: 'NEED_MORE', by: { id: PEOPLE.pm }, note: 'Measure the sleeve again with the arm bent.' } } })
    const mail = await one(`SELECT "templateKey", status::text, "recordType", "recordId", subject FROM "EmailOutbound" WHERE "tenantId" = $1 AND "recordId" = $2`, [T, rev1])
    expect(mail).toMatchObject({ templateKey: 'mtm.need_more', status: 'SENT', recordType: 'MeasurementProfile', subject: `${RIDER}'s measurements: we need a little more` })
    expect((await outbox('measurement_profile.reviewed')).at(-1)).toEqual({ profileId: rev1, partyId: S.r1, revision: 1, status: 'NEED_MORE', mailed: true, ordersGoneOn: 0 })
  })

  it('the answer is a new revision; nobody confirms the measures they took (the administrator measured it), someone else does', async () => {
    const recorded = await ok('admin', 'POST', `/sales/mtm/profiles/${rev1}/revisions`, { measurements: { ...values, sleeve: '65.5' }, takenAt: ago(0.5), measuredByUserId: PEOPLE.admin, measuredPlace: 'Made-up showroom' }, 201)
    rev2 = recorded.profile.id
    expect(recorded.profile).toMatchObject({ revision: 2, supersedesId: rev1, privacyNoticeRef: 'Made-up notice v1', review: { status: 'WAITING' } })
    expect((await no('admin', 'POST', `/sales/mtm/profiles/${rev2}/review`, { decision: 'CONFIRM' }, 409)).message).toBe('You measured this revision: someone else confirms it (nobody confirms their own measures).')
    expect((await no('pm', 'POST', `/sales/mtm/profiles/${rev1}/review`, { decision: 'CONFIRM' }, 409)).message).toBe('Revision 1 is not the newest (revision 2 is): review the newest.')
    const record = (await ok('admin', 'GET', `/sales/mtm/profiles/${rev2}`)).profile
    expect(record.review).toMatchObject({ may: { confirm: false, askMore: true } })
    expect(record.revisions.map((revision: Json) => [revision.revision, revision.review.status])).toEqual([[2, 'WAITING'], [1, 'NEED_MORE']])
  })
})

let quoteId = ''
let unitLine = ''

const newQuote = async () => (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: S.r1 }, 201)).quote
const quoteVersion = async (id: string) => (await one<{ version: number }>(`SELECT version FROM "Quote" WHERE id = $1`, [id])).version

describe('a quote’s made-to-measure unit (MM1:01, PRD-017; switched off per template)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('W1’s PATCH of SEED-Q-0002 (a seeded unit) no longer answers 500: the unit is one piece', async () => {
    const version = await quoteVersion(S.q2)
    const patched = await ok('sales', 'PATCH', `/sales/quotes/${S.q2}`, { version, changeNote: 'Made-up change note: the money is refreshed.' })
    const unit = patched.quote.lines.find((line: Json) => line.kind === 'MADE_TO_MEASURE')
    expect(unit).toMatchObject({ quantity: 1 })
    expect(unit.netAmount).toBeGreaterThan(0)
  })

  it('REFUSES a unit while made-to-measure has not started for the template, or of a style not flagged', async () => {
    const quote = await newQuote()
    quoteId = quote.id
    const body = { version: quote.version, styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: rev2 }
    const off = await no('sales', 'POST', `/sales/quotes/${quoteId}/lines/made-to-measure`, body, 409)
    expect(off.message).toBe('Made-to-measure has not started for measurement template JACKET: its rules stay off until the Owner starts them (GATE-MTM).')
    // W1's route: a unit is one size with one piece (its base size).
    expect(paths(await no('sales', 'POST', `/sales/quotes/${quoteId}/lines`, { ...body, kind: 'MADE_TO_MEASURE', sizes: [{ size: '52', quantity: 2 }] }, 400))).toEqual(['body/sizes'])
    // The Owner starts made-to-measure for JACKET (B-W2b-248's switch).
    const rules = (await ok('owner', 'GET', `${templateUrl()}/mtm-rules`)).rules
    await ok('owner', 'PUT', `${templateUrl()}/mtm-rules/switch`, { version: rules.template.version, on: true, reason: 'Made-up first made-to-measure order.' })
    expect((await no('sales', 'POST', `/sales/quotes/${quoteId}/lines/made-to-measure`, { ...body, styleId: S.jkt02, colourwayId: S.jkt02blk }, 409)).message).toBe('SEED-JKT-02 is not made to measure: a person flags the style first (PRD-017).')
    expect((await no('sales', 'POST', `/sales/quotes/${quoteId}/lines/made-to-measure`, { ...body, measurementProfileId: rev1 }, 409)).message).toContain('is not the newest (revision 2 is)')
  })

  it('takes the unit once started: one piece, the base size the measures point to, priced and costed; the profile’s customer only', async () => {
    const version = await quoteVersion(quoteId)
    const added = await ok('sales', 'POST', `/sales/quotes/${quoteId}/lines/made-to-measure`, { version, styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: rev2, unitPrice: '610' }, 201)
    const unit = added.quote.lines.find((line: Json) => line.kind === 'MADE_TO_MEASURE')
    unitLine = unit.id
    // The private rider's quote is VAT included: 610 with 22 % VAT is 500 net.
    expect(unit).toMatchObject({ quantity: 1, unitPrice: '610' })
    expect(unit.netAmount).toBe(50_000)
    const row = await one(`SELECT "measurementProfileId", "baseSize", quantity FROM "QuoteLine" WHERE id = $1`, [unitLine])
    expect(row).toMatchObject({ measurementProfileId: rev2, quantity: 1 })
    expect(['50', '52', '54']).toContain(row.baseSize)
    const changed = await ok('sales', 'PATCH', `/sales/quotes/${quoteId}/lines/${unitLine}/made-to-measure`, { version: await quoteVersion(quoteId), baseSize: '54', note: 'Room for a back protector.' })
    expect(changed.quote.lines.find((line: Json) => line.id === unitLine)).toMatchObject({ note: 'Room for a back protector.' })
    expect((await one(`SELECT "baseSize" FROM "QuoteLine" WHERE id = $1`, [unitLine])).baseSize).toBe('54')
    expect(paths(await no('sales', 'PATCH', `/sales/quotes/${quoteId}/lines/${unitLine}/made-to-measure`, { version: await quoteVersion(quoteId), baseSize: '62' }, 400))).toEqual(['body/baseSize'])
    // Another customer's profile (SEED-C1's team rider).
    const other = sid('measurement:P1:rider:JACKET:1')
    expect(paths(await no('sales', 'POST', `/sales/quotes/${quoteId}/lines/made-to-measure`, { version: await quoteVersion(quoteId), styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: other }, 400))).toEqual(['body/measurementProfileId'])
  })

  it('an out-of-chart size on a size-grid line becomes a unit after it (SAL-276); a size of the chart is refused', async () => {
    const grid = await ok('sales', 'POST', `/sales/quotes/${quoteId}/lines`, { version: await quoteVersion(quoteId), styleId: S.jkt01, colourwayId: S.blk, sizes: [{ size: '52', quantity: 2 }] }, 201)
    const line = grid.quote.lines.find((entry: Json) => entry.kind === 'SIZE_GRID')
    expect((await no('sales', 'POST', `/sales/quotes/${quoteId}/lines/${line.id}/out-of-chart`, { version: await quoteVersion(quoteId), size: '52', measurementProfileId: rev2 }, 409)).message).toContain('is in SEED-JKT-01')
    const made = await ok('sales', 'POST', `/sales/quotes/${quoteId}/lines/${line.id}/out-of-chart`, { version: await quoteVersion(quoteId), size: '62', measurementProfileId: rev2 }, 201)
    const unit = made.quote.lines.find((entry: Json) => entry.seq === line.seq + 1)
    expect(unit).toMatchObject({ kind: 'MADE_TO_MEASURE', quantity: 1, unitPrice: line.unitPrice })
    expect(unit.description).toContain('size 62 out of the chart, made to measure')
  })

  it('reads the units with their findings; the send checks say the measures wait for the review', async () => {
    const made = (await ok('sales', 'GET', `/sales/quotes/${quoteId}/made-to-measure`)).made
    expect(made.units).toHaveLength(2)
    expect(made.units[0]).toMatchObject({ profile: { id: rev2, revision: 2, latestRevision: 2, review: 'WAITING' }, baseSize: '54' })
    expect(made.units[0].findings.map((finding: Json) => finding.code)).toContain('MTM_NOT_CONFIRMED')
    const checks = await ok('sales', 'GET', `/sales/quotes/${quoteId}/send-check`)
    expect(checks.checks.filter((check: Json) => String(check.code).startsWith('MTM_')).map((check: Json) => [check.code, check.severity])).toContainEqual(['MTM_NOT_CONFIRMED', 'WARNING'])
  })
})

let orderId = ''

describe('the order waits for the factory review (SAL-292)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an accepted quote with a unit whose measures wait makes a waiting order; the review’s CONFIRM lets it go on', async () => {
    const version = await one<{ id: string }>(`SELECT id FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1`, [quoteId])
    const accepted = await one<{ billTo: Json; shipTo: Json }>(`SELECT v."billTo", v."shipTo" FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0001'`, [T])
    // Test data past its guards: the version accepted (the customer's yes is B-W1-24's link).
    await force(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "billTo" = $2, "shipTo" = $3 WHERE id = $1`, [version.id, accepted.billTo, accepted.shipTo])
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [quoteId])
    const made = await ok('sales', 'POST', '/sales/orders', { quoteVersionId: version.id, customerRef: 'PO-358-1' }, 201)
    orderId = made.order.id
    expect((await one(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [orderId])).status).toBe('PENDING_APPROVAL')
    expect((await ok('sales', 'GET', `/sales/orders/${orderId}/made-to-measure`)).made).toMatchObject({ kind: 'ORDER', waitsForReview: true })
    const confirmed = await ok('pm', 'POST', `/sales/mtm/profiles/${rev2}/review`, { decision: 'CONFIRM', note: 'Pattern from 54, longer sleeves.' })
    expect(confirmed).toMatchObject({ mailed: false, profile: { review: { status: 'CONFIRMED', by: { id: PEOPLE.pm } } }, ordersGoneOn: [{ id: orderId, number: made.order.number }] })
    expect((await one(`SELECT status::text FROM "SalesOrder" WHERE id = $1`, [orderId])).status).toBe('CONFIRMED')
    expect((await outbox('sales_order.status_changed')).filter((row) => row.orderId === orderId)).toEqual([{ orderId, number: made.order.number, from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' }])
    expect((await ok('sales', 'GET', `/sales/orders/${orderId}/made-to-measure`)).made).toMatchObject({ waitsForReview: false })
    expect((await no('pm', 'POST', `/sales/mtm/profiles/${rev2}/review`, { decision: 'NEED_MORE', note: 'Again.' }, 409)).message).toContain('is confirmed: its review does not change')
  })
})

describe('a repeat order from the saved profile (SAL-300) and the worksheet (SAL-303)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('repeats the newest unit on the newest revision; measures older than 12 months are asked again first', async () => {
    const facts = (await ok('sales', 'GET', `/sales/mtm/profiles/${rev1}/repeat`)).repeat
    expect(facts).toMatchObject({ latest: { id: rev2, revision: 2, old: false, review: 'CONFIRMED' }, reMeasure: null })
    expect(facts.earlier.map((unit: Json) => unit.kind)).toEqual(expect.arrayContaining(['QUOTE', 'ORDER']))
    const draft = await newQuote()
    const repeated = await ok('sales', 'POST', `/sales/mtm/profiles/${rev2}/repeat`, { quoteId: draft.id, version: draft.version }, 201)
    expect(repeated.quote.lines.find((line: Json) => line.id === repeated.lineId)).toMatchObject({ kind: 'MADE_TO_MEASURE', quantity: 1 })
    // An old rider: measured 400 days ago, one unit already.
    const old = await ok('sales', 'POST', '/sales/mtm/profiles', { partyId: S.r1, riderName: OLD_RIDER, garmentType: 'JACKET', measurements: values, takenAt: ago(400), takenBy: 'Made-up dealer fitter', privacyNoticeRef: 'Made-up notice v1', privacyNoticeAt: ago(401) }, 201)
    await ok('sales', 'POST', `/sales/quotes/${draft.id}/lines/made-to-measure`, { version: await quoteVersion(draft.id), styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: old.profile.id }, 201)
    expect((await ok('sales', 'GET', `/sales/mtm/profiles/${old.profile.id}/repeat`)).repeat).toMatchObject({ latest: { old: true, months: 13 }, reMeasure: expect.stringContaining('ask for a new measure first') })
    expect(paths(await no('sales', 'POST', `/sales/mtm/profiles/${old.profile.id}/repeat`, { quoteId: draft.id, version: await quoteVersion(draft.id) }, 409))).toEqual(['body/measuredOk'])
    await ok('sales', 'POST', `/sales/mtm/profiles/${old.profile.id}/repeat`, { quoteId: draft.id, version: await quoteVersion(draft.id), measuredOk: true }, 201)
    expect((await ok('sales', 'GET', `/sales/mtm/profiles?partyId=${S.r1}&old=true`)).rows.map((row: Json) => row.riderName)).toEqual([OLD_RIDER])
  })

  it('keeps a worksheet version of the revision (an office PDF of the profile); the same contents give it back; opening it is recorded', async () => {
    const made = await ok('sales', 'POST', `/sales/mtm/profiles/${rev2}/worksheets`, { companyId: companyA, language: 'en' })
    expect(made.worksheet).toMatchObject({ version: 1, made: true })
    const document = await one(`SELECT kind::text, "recordType", "recordId", "companyId", "siteId", number, "fileId" FROM "GeneratedDocument" WHERE id = $1`, [made.worksheet.id])
    expect(document).toMatchObject({ kind: 'MTM_WORKSHEET', recordType: 'MeasurementProfile', recordId: rev2, companyId: companyA, siteId: null, number: 'JACKET r2 v1' })
    expect(await one(`SELECT "recordType", "recordId", visibility::text[] AS visibility, "contentType" FROM "StoredFile" WHERE id = $1`, [document.fileId])).toMatchObject({ recordType: 'MeasurementProfile', recordId: rev2, visibility: ['OFFICE'], contentType: 'application/pdf' })
    expect((await ok('sales', 'POST', `/sales/mtm/profiles/${rev2}/worksheets`, { companyId: companyA, language: 'en' })).worksheet).toMatchObject({ id: made.worksheet.id, made: false })
    const opened = await ok('sales', 'POST', `/sales/mtm/profiles/${rev2}/worksheets/${made.worksheet.id}/open`)
    expect(opened.download.url).toBeTruthy()
    expect((await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND action = 'mtm.worksheetOpened'`, [rev2])).n).toBe(1)
    await no('pm', 'POST', `/sales/mtm/profiles/${rev2}/worksheets`, { companyId: companyA }, 403)
    expect((await outbox('mtm_worksheet.made')).at(-1)).toMatchObject({ profileId: rev2, version: 1 })
  })
})
