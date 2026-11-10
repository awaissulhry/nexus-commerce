import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedStylesDepth, type StylesDepthSeed } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { toleranceForCutOrder } from '../../production/lays/consumption-tolerance'

/**
 * The style lifecycle, the edit rule per state, product types and the product settings (B-W2b-221; PRD-007, PRD-008, PRD-105,
 * PRD-182) through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and B-W2b-206's Style_w2b4_depth and ProductTypeProfile_check are real), seeded with the core and styles-depth seeds:
 * SEED-JKT-01 (the brand P1's, DEVELOPMENT, draft revision 1, type "Seed jacket"), SEED-JKT-02 (released revision 1,
 * IN_PRODUCTION, type "Seed touring jacket" under it), the tenant-wide edit rules free, free, new revision, new revision, change
 * order, change order, blocked, and company A's tolerance (warn above 3 %, leather above 5 %, textiles may differ). Made up here: a
 * style of the touring type, a gloves type, the settings of company B. Every W1 write asks the rule in words before the database.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/lifecycle`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'lifecycle-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA1 = seedId('site:A1')
const user = newId()

const MANAGE: Permission[] = [
  'product.styles.view',
  'product.styles.manage',
  'product.styles.lifecycle',
  'product.settings.manage',
  'product.bom.view',
  'product.bom.manage',
  'product.bom.release',
  'product.routing.view',
  'product.routing.manage',
]
const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(MANAGE)]),
  styles: office([grant(['product.styles.view', 'product.styles.manage'])]),
  viewer: office([grant(['product.styles.view'])]),
  companyB: office([grant(MANAGE, [companyB])]),
  floor: { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [grant(['floor.work', ...MANAGE], [companyA])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: StylesDepthSeed

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const lifecycleOf = async (styleId: string): Promise<Json> => (await ok('viewer', 'GET', `/product/styles/${styleId}/lifecycle`)).lifecycle
const versionOf = async (styleId: string): Promise<number> => (await lifecycleOf(styleId)).style.version
const move = async (styleId: string, body: Json, session = 'manager', status = 200) => {
  const payload = { version: await versionOf(styleId), ...body }
  return status === 200 ? (await ok(session, 'POST', `/product/styles/${styleId}/lifecycle`, payload)).lifecycle : refused(session, 'POST', `/product/styles/${styleId}/lifecycle`, payload, status)
}
const patchStyle = async (styleId: string, body: Json, session = 'manager', status = 200) => {
  const payload = { version: await versionOf(styleId), ...body }
  return status === 200 ? (await ok(session, 'PATCH', `/product/styles/${styleId}`, payload)).style : refused(session, 'PATCH', `/product/styles/${styleId}`, payload, status)
}
const tenantSettings = async (): Promise<Json> => (await ok('viewer', 'GET', '/product/settings')).settings

beforeAll(async () => {
  db = await migratedDatabase('product_lifecycle')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seeded = await seedStylesDepth({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the lifecycle read (PRD-007, PRD-182)', () => {
  it('says where the style is, where it may go and what may change in it under the tenant-wide rule', async () => {
    const view = await lifecycleOf(seeded.styleIds.jkt02)
    expect(view.style).toMatchObject({ code: 'SEED-JKT-02', status: 'ACTIVE', lifecycle: 'IN_PRODUCTION', changedAt: '2026-11-01T08:00:00.000Z' })
    expect(view.releasedRevision).toMatchObject({ revision: 1 })
    expect(view.draftRevision).toBeNull()
    expect(view.moves).toEqual([
      { to: 'PHASE_OUT', backward: false, allowed: true, refusal: null },
      { to: 'DISCONTINUED', backward: false, allowed: true, refusal: null },
    ])
    expect(view.editRule).toMatchObject({ state: 'IN_PRODUCTION', rule: 'CHANGE_ORDER', source: 'TENANT' })
    const kinds = Object.fromEntries(view.editRule.kinds.map((entry: Json) => [entry.kind, entry.refusal?.code ?? null]))
    expect(kinds).toEqual({ DETAILS: null, SPEC: 'NEEDS_CHANGE_ORDER', NEW_REVISION: 'NEEDS_CHANGE_ORDER', DRAFT: null, RELEASE: null })
    expect(view.rules.map((entry: Json) => entry.rule)).toEqual(['FREE', 'FREE', 'NEW_REVISION', 'NEW_REVISION', 'CHANGE_ORDER', 'CHANGE_ORDER', 'BLOCKED'])
    await refused('floor', 'GET', `/product/styles/${seeded.styleIds.jkt02}/lifecycle`, undefined, 403)
    await refused('viewer', 'GET', `/product/styles/${newId()}/lifecycle`, undefined, 404)
  })
})

describe('every W1 write asks the edit rule (PRD-182)', () => {
  it('in production under "change order": a typo passes; the spec, a colourway and a new revision are refused in words', async () => {
    const style = seeded.styleIds.jkt02
    expect(await patchStyle(style, { name: 'Seed production jacket, fixed' })).toMatchObject({ name: 'Seed production jacket, fixed' })
    const spec = await patchStyle(style, { hsCode: '62019300' }, 'manager', 409)
    expect(refusal(spec)).toBe('refusal/NEEDS_CHANGE_ORDER')
    expect(spec.message).toBe('Style SEED-JKT-02 is in production: its spec changes only through a change order approved by someone other than its author, with a new revision.')
    expect(refusal(await refused('manager', 'POST', `/product/styles/${style}/colourways`, { code: 'GRN', name: 'Green' }, 409))).toBe('refusal/NEEDS_CHANGE_ORDER')
    const revision = await refused('manager', 'POST', `/product/styles/${style}/revisions`, { changeNote: 'A new zip' }, 409)
    expect(refusal(revision)).toBe('refusal/NEEDS_CHANGE_ORDER')
    expect(revision.message).toContain('New change order')
    const copy = await refused('manager', 'POST', `/product/styles/${style}/revisions/${(await lifecycleOf(style)).releasedRevision.id}/copy`, {}, 409)
    expect(refusal(copy)).toBe('refusal/NEEDS_CHANGE_ORDER')
    const tracking = await refused('manager', 'PUT', `/product/styles/${style}/garment-tracking`, { version: await versionOf(style), tracking: 'SERIAL' }, 409)
    expect(refusal(tracking)).toBe('refusal/NEEDS_CHANGE_ORDER')
    expect((await admin(`SELECT "hsCode", (SELECT count(*)::int FROM "StyleRevision" WHERE "styleId" = $1) AS revisions FROM "Style" WHERE id = $1`, [style]))[0]).toMatchObject({ revisions: 1 })
  })

  it('with the rule lowered to "new revision": the spec waits for a new revision, then goes with it', async () => {
    const before = await tenantSettings()
    const changed = (await ok('manager', 'PUT', '/product/settings', { companyId: null, version: before.version, editRules: { IN_PRODUCTION: 'NEW_REVISION' }, reason: 'Small factory: no change orders yet' })).settings
    expect(changed.editRules.find((entry: Json) => entry.state === 'IN_PRODUCTION')).toEqual({ state: 'IN_PRODUCTION', own: 'NEW_REVISION', rule: 'NEW_REVISION', source: 'TENANT' })
    const style = seeded.styleIds.jkt02
    const spec = await patchStyle(style, { hsCode: '62019300' }, 'manager', 409)
    expect(refusal(spec)).toBe('refusal/NEEDS_NEW_REVISION')
    expect(spec.message).toBe('Style SEED-JKT-02 is in production: its spec changes only with a new revision. Start a new revision first; the change goes out with it.')
    const { revision } = await ok('manager', 'POST', `/product/styles/${style}/revisions`, { changeNote: 'Customs code' }, 201)
    expect(revision).toMatchObject({ revision: 2, status: 'DRAFT' })
    expect(await patchStyle(style, { hsCode: '62019300' })).toMatchObject({ hsCode: '62019300' })
    expect((await lifecycleOf(style)).draftRevision).toMatchObject({ revision: 2 })
    expect(await events('product_settings.changed')).toEqual([{ companyId: null, fields: ['editRuleInProduction'] }])
  })

  it('says the database\'s own style rules in words: the brand of a style sold under our name, a type of another kind', async () => {
    const style = seeded.styleIds.jkt01
    await admin(`UPDATE "Style" SET "soldUnderOurName" = true WHERE id = $1`, [style])
    const brand = await patchStyle(style, { brandPartyId: null }, 'manager', 409)
    expect(brand.message).toBe('Style SEED-JKT-01 is made for its brand and sold under our name: its brand stays while it is (a style of our own collection is a new style).')
    await admin(`UPDATE "Style" SET "soldUnderOurName" = false WHERE id = $1`, [style])
    const kind = await patchStyle(style, { productType: 'VEST' }, 'manager', 409)
    expect(kind.message).toBe('Style SEED-JKT-01 has product type SEED-PT-JKT, a type of jacket: take the type off (or give it a type of vest) before it becomes vest.')
  })
})

describe('the moves, one command each (PRD-007)', () => {
  it('moves forward, back with the reason, and into production only from approved with a released revision', async () => {
    const style = seeded.styleIds.jkt01
    const sampling = await move(style, { to: 'SAMPLING' })
    expect(sampling.style).toMatchObject({ lifecycle: 'SAMPLING', changedById: user })
    expect(sampling.editRule).toMatchObject({ rule: 'NEW_REVISION', source: 'TENANT' })
    // Its draft revision 1 is open: its spec still changes, with it.
    expect(await patchStyle(style, { hsCode: '62019300' })).toMatchObject({ hsCode: '62019300' })
    const back = await move(style, { to: 'DEVELOPMENT' }, 'manager', 409)
    expect(refusal(back)).toBe('refusal/REASON_NEEDED')
    expect(back.message).toBe('Moving style SEED-JKT-01 back from in sampling to in development: say why.')
    expect((await move(style, { to: 'DEVELOPMENT', reason: 'The fit sample failed' })).style.lifecycle).toBe('DEVELOPMENT')
    expect((await move(style, { to: 'APPROVED' })).style.lifecycle).toBe('APPROVED')
    const production = await move(style, { to: 'IN_PRODUCTION' }, 'manager', 409)
    expect(refusal(production)).toBe('refusal/NEEDS_RELEASED_REVISION')
    expect(production.message).toBe('Style SEED-JKT-01 has no released revision: release its BOM and routing before it goes into production.')
    expect(refusal(await move(style, { to: 'APPROVED' }, 'manager', 409))).toBe('refusal/SAME_STATE')
    // A stale version, a viewer, another company's manager.
    await refused('manager', 'POST', `/product/styles/${style}/lifecycle`, { version: 1, to: 'SAMPLING' }, 409)
    await refused('styles', 'POST', `/product/styles/${style}/lifecycle`, { version: await versionOf(style), to: 'SAMPLING' }, 403)
    await refused('companyB', 'POST', `/product/styles/${style}/lifecycle`, { version: await versionOf(style), to: 'SAMPLING' }, 403)
    const moved = (await events('style.lifecycle_changed')).filter((event) => event.styleId === style)
    expect(moved.map((event) => [event.from, event.to])).toEqual([
      ['DEVELOPMENT', 'SAMPLING'],
      ['SAMPLING', 'DEVELOPMENT'],
      ['DEVELOPMENT', 'APPROVED'],
    ])
    const audit = await admin(`SELECT reason, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'product.styles.moveLifecycle' ORDER BY at`, [style])
    expect(audit[1]).toMatchObject({ reason: 'The fit sample failed', before: { lifecycle: 'SAMPLING' }, after: { lifecycle: 'DEVELOPMENT' } })
  })

  it('phases out with the replacing style, and a style in production never goes back to development', async () => {
    const style = seeded.styleIds.jkt02
    const back = await move(style, { to: 'DEVELOPMENT', reason: 'Redesign' }, 'manager', 409)
    expect(refusal(back)).toBe('refusal/MOVE_NOT_ALLOWED')
    expect(back.message).toBe('Style SEED-JKT-02 is in production: it can be moved to being phased out, discontinued, not in development. A style in production changes through a new revision, not by going back.')
    const out = await move(style, { to: 'PHASE_OUT', replacedById: seeded.styleIds.jkt01 })
    expect(out).toMatchObject({ style: { lifecycle: 'PHASE_OUT' }, replacedBy: { id: seeded.styleIds.jkt01, code: 'SEED-JKT-01' } })
    expect((await lifecycleOf(seeded.styleIds.jkt01)).replaces).toEqual([{ id: style, code: 'SEED-JKT-02', name: 'Seed production jacket, fixed' }])
    const self = await refused('manager', 'PUT', `/product/styles/${style}/replaced-by`, { version: await versionOf(style), replacedById: style }, 409)
    expect(refusal(self)).toBe('refusal/REPLACEMENT_SELF')
    // Back into production: the replacing style is cleared in the same update (the database allows it only while phased out).
    const again = await move(style, { to: 'IN_PRODUCTION', reason: 'Orders came back' })
    expect(again).toMatchObject({ style: { lifecycle: 'IN_PRODUCTION' }, replacedBy: null })
    const named = await refused('manager', 'PUT', `/product/styles/${style}/replaced-by`, { version: await versionOf(style), replacedById: seeded.styleIds.jkt01 }, 409)
    expect(refusal(named)).toBe('refusal/REPLACEMENT_NOT_HERE')
  })
})

describe('product types (PRD-008)', () => {
  it('lists the types with what they inherit; a style of the child type misses its required attributes', async () => {
    const { types } = await ok('viewer', 'GET', '/product/types?status=ALL')
    const touring = types.find((type: Json) => type.id === seeded.profileIds.touring)
    expect(touring).toMatchObject({ code: 'SEED-PT-JKT-TOUR', parent: { id: seeded.profileIds.jacket }, own: { requiredAttributes: ['ppeClass'], defaultSizeScaleId: null, defaultPpeClass: 'AA' } })
    expect(touring.effective.requiredAttributes.map((entry: Json) => entry.name)).toEqual(['gender', 'hsCode', 'originCountry', 'ppeClass'])
    expect(touring.effective.defaults.defaultSizeScaleId.fromTypeId).toBe(seeded.profileIds.jacket)
    expect(touring.effective.defaults.defaultPpeClass).toEqual({ value: 'AA', fromTypeId: seeded.profileIds.touring })
    expect(touring.refs.sizeScale).toMatchObject({ code: expect.any(String) })
    expect(types.find((type: Json) => type.id === seeded.profileIds.vest)).toMatchObject({ status: 'ARCHIVED' })
    const { styleType } = await ok('viewer', 'GET', `/product/styles/${seeded.styleIds.jkt02}/type`)
    expect(styleType.type).toMatchObject({ id: seeded.profileIds.touring })
    expect(styleType.missing).toEqual(expect.arrayContaining(['gender']))
    expect(styleType.missing).not.toContain('hsCode')
  })

  it('a new style of a type takes what it leaves out from the type; a type of another kind is refused in words', async () => {
    // The seed's touring type pairs class AA with its parent's EN 17092-4 (a class A part): the style names its own standard.
    const created = await ok('manager', 'POST', '/product/styles', { code: 'TEST-TOUR-01', name: 'Test touring jacket', productType: 'JACKET', productTypeProfileId: seeded.profileIds.touring, ppeStandard: 'EN 17092-3:2020', sizes: ['50', '52'] }, 201)
    const jacket = (await ok('viewer', 'GET', `/product/types/${seeded.profileIds.jacket}`)).type
    expect(created.style).toMatchObject({ code: 'TEST-TOUR-01', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA', sizes: ['50', '52'], sizeScale: { id: jacket.own.defaultSizeScaleId } })
    const view = await lifecycleOf(created.style.id)
    expect(view.style).toMatchObject({ lifecycle: 'CONCEPT', changedAt: null })
    expect(view.editRule).toMatchObject({ rule: 'FREE', source: 'TENANT' })
    expect((await ok('viewer', 'GET', `/product/styles/${created.style.id}/type`)).styleType).toMatchObject({
      type: { id: seeded.profileIds.touring },
      differs: [{ field: 'ppeStandard', style: 'EN 17092-3:2020', type: 'EN 17092-4:2020' }],
    })
    const kind = await refused('manager', 'POST', '/product/styles', { code: 'TEST-TRS-01', name: 'Test trousers', productType: 'TROUSERS', productTypeProfileId: seeded.profileIds.jacket }, 400)
    expect(kind.issues).toEqual([{ path: 'body/productTypeProfileId', message: 'Product type SEED-PT-JKT is a type of jacket, not trousers.' }])
    const archived = await refused('manager', 'POST', '/product/styles', { code: 'TEST-VST-01', name: 'Test vest', productType: 'VEST', companyId: companyA, productTypeProfileId: seeded.profileIds.vest }, 400)
    expect(archived.issues[0].message).toBe('Product type SEED-PT-VEST is archived.')
    const noScale = await refused('manager', 'POST', '/product/styles', { code: 'TEST-VST-02', name: 'Test vest', productType: 'VEST' }, 400)
    expect(noScale.issues).toEqual([{ path: 'body/sizeScaleId', message: 'Pick a size scale (or a product type that gives one).' }])
    // A copy keeps its source's type.
    const copy = await ok('manager', 'POST', `/product/styles/${created.style.id}/duplicate`, { code: 'TEST-TOUR-02', name: 'Test touring jacket, copy' }, 201)
    expect((await ok('viewer', 'GET', `/product/styles/${copy.style.id}/type`)).styleType.type).toMatchObject({ id: seeded.profileIds.touring })
  })

  it('keeps types: W1\'s PPE rules on the inherited defaults, no circle, a kind that stays while used, archive and restore', async () => {
    const gloves = await refused('manager', 'POST', '/product/types', { code: 'TEST-PT-GLV', name: 'Test gloves', productType: 'GLOVES', defaultPpeCategory: 'CATEGORY_II', defaultPpeStandard: 'EN 17092-4:2020' }, 400)
    expect(gloves.issues).toEqual([{ path: 'body/defaultPpeStandard', message: 'Rider gloves are made to EN 13594, not EN 17092.' }])
    const made = await ok('manager', 'POST', '/product/types', { code: 'TEST-PT-GLV', name: 'Test gloves', productType: 'GLOVES', requiredAttributes: ['gender'], defaultPpeCategory: 'CATEGORY_II', defaultPpeStandard: 'EN 13594:2015', defaultPpeClass: '1KP' }, 201)
    expect(made.type).toMatchObject({ code: 'TEST-PT-GLV', companyId: null, status: 'ACTIVE', styles: 0 })
    const child = await refused('manager', 'POST', '/product/types', { code: 'TEST-PT-X', name: 'Wrong child', productType: 'TROUSERS', parentId: seeded.profileIds.jacket }, 400)
    expect(child.issues[0]).toEqual({ path: 'body/parentId', message: 'SEED-PT-JKT is a type of jacket, not trousers.' })
    const jacket = (await ok('viewer', 'GET', `/product/types/${seeded.profileIds.jacket}`)).type
    const circle = await refused('manager', 'PATCH', `/product/types/${seeded.profileIds.jacket}`, { version: jacket.version, parentId: seeded.profileIds.touring }, 400)
    expect(circle.issues[0]).toEqual({ path: 'body/parentId', message: 'SEED-PT-JKT-TOUR is this type or one of its children: no circle of types.' })
    const kind = await refused('manager', 'PATCH', `/product/types/${seeded.profileIds.jacket}`, { version: jacket.version, productType: 'VEST' }, 409)
    expect(kind.message).toMatch(/^Product type SEED-PT-JKT has \d+ style\(s\) and 1 child type\(s\) of jacket: its kind of garment stays/)
    const renamed = (await ok('manager', 'PATCH', `/product/types/${made.type.id}`, { version: made.type.version, name: 'Test rider gloves', requiredAttributes: ['gender', 'hsCode'] })).type
    expect(renamed).toMatchObject({ name: 'Test rider gloves', own: { requiredAttributes: ['gender', 'hsCode'] } })
    const archived = (await ok('manager', 'POST', `/product/types/${made.type.id}/archive`, { version: renamed.version, reason: 'Not made any more' })).type
    expect(archived.status).toBe('ARCHIVED')
    await refused('companyB', 'POST', `/product/types/${made.type.id}/restore`, { version: archived.version }, 403)
    expect((await ok('manager', 'POST', `/product/types/${made.type.id}/restore`, { version: archived.version })).type.status).toBe('ACTIVE')
    expect((await events('product_type.changed')).map((event) => event.change)).toEqual(['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'])
  })

  it('a style\'s type is its spec: set under its edit rule, of its kind', async () => {
    const style = seeded.styleIds.jkt01 // APPROVED (new revision), its draft revision 1 open
    const wrong = await refused('manager', 'PUT', `/product/styles/${style}/type`, { version: await versionOf(style), typeId: seeded.profileIds.vest }, 400)
    expect(wrong.issues[0].message).toBe('Product type SEED-PT-VEST is archived.')
    const set = (await ok('styles', 'PUT', `/product/styles/${style}/type`, { version: await versionOf(style), typeId: seeded.profileIds.touring })).styleType
    expect(set.type).toMatchObject({ id: seeded.profileIds.touring })
    expect(set.differs).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'ppeStandard', type: 'EN 17092-4:2020' })]))
    // Discontinued: blocked.
    await move(style, { to: 'DISCONTINUED' })
    const blocked = await refused('manager', 'PUT', `/product/styles/${style}/type`, { version: await versionOf(style), typeId: seeded.profileIds.jacket }, 409)
    expect(refusal(blocked)).toBe('refusal/EDIT_BLOCKED')
    expect(blocked.message).toBe('Style SEED-JKT-01 is discontinued: nothing of it changes in this state (its edit rule is "blocked"). Move it to another state first.')
    expect(refusal(await patchStyle(style, { name: 'A typo' }, 'manager', 409))).toBe('refusal/EDIT_BLOCKED')
    const draft = (await lifecycleOf(style)).draftRevision
    expect(refusal(await refused('manager', 'POST', `/product/styles/${style}/revisions/${draft.id}/bom/lines`, { version: 1, itemId: newId(), qty: '1', uom: 'PCS' }, 409))).toBe('refusal/EDIT_BLOCKED')
    expect((await move(style, { to: 'DEVELOPMENT', reason: 'Reworked for next season' })).editRule.rule).toBe('FREE')
  })
})

describe('the product settings (PRD-182, PRD-105)', () => {
  it('reads each value with its own and the one in force; a company row follows the tenant-wide one', async () => {
    const a = (await ok('viewer', 'GET', `/product/settings?companyId=${companyA}`)).settings
    expect(a).toMatchObject({ companyId: companyA, exists: true, tolerance: { own: { rule: 'WARN_ABOVE', percent: '3' }, rule: 'WARN_ABOVE', percent: '3', source: 'COMPANY' } })
    expect(a.editRules.find((entry: Json) => entry.state === 'DISCONTINUED')).toEqual({ state: 'DISCONTINUED', own: null, rule: 'BLOCKED', source: 'TENANT' })
    const kinds = Object.fromEntries(a.tolerance.byKind.map((entry: Json) => [entry.kind, [entry.rule, entry.percent, entry.source, entry.byKind]]))
    expect(kinds.LEATHER).toEqual(['WARN_ABOVE', '5', 'COMPANY', true])
    expect(kinds.TEXTILE).toEqual(['MAY_DIFFER', null, 'COMPANY', true])
    expect(kinds.LINING).toEqual(['WARN_ABOVE', '3', 'COMPANY', false])
    const b = (await ok('viewer', 'GET', `/product/settings?companyId=${companyB}`)).settings
    expect(b).toMatchObject({ exists: false, version: null, tolerance: { rule: 'MAY_DIFFER', source: 'TENANT' } })
  })

  it('makes a company row, refuses a percent without its rule, and needs a grant over every company for the tenant-wide row', async () => {
    const bad = await refused('companyB', 'PUT', '/product/settings', { companyId: companyB, consumptionTolerance: 'WARN_ABOVE' }, 400)
    expect(bad.issues).toEqual([{ path: 'body/consumptionTolerancePct', message: 'Warn above which percent? A number above 0 and at most 100.' }])
    const made = (await ok('companyB', 'PUT', '/product/settings', { companyId: companyB, consumptionTolerance: 'MATCH', consumptionToleranceByKind: { LEATHER: { rule: 'WARN_ABOVE', percent: '4.5' } }, editRules: { SAMPLING: 'FREE' } })).settings
    expect(made).toMatchObject({ exists: true, version: 1, tolerance: { rule: 'MATCH', source: 'COMPANY' } })
    expect(made.editRules.find((entry: Json) => entry.state === 'SAMPLING')).toEqual({ state: 'SAMPLING', own: 'FREE', rule: 'FREE', source: 'COMPANY' })
    await refused('companyB', 'PUT', '/product/settings', { companyId: companyB, consumptionTolerance: 'MAY_DIFFER' }, 400)
    const cleared = (await ok('companyB', 'PUT', '/product/settings', { companyId: companyB, version: 1, consumptionTolerance: null, consumptionToleranceByKind: null })).settings
    expect(cleared.tolerance).toMatchObject({ own: { rule: null }, rule: 'MAY_DIFFER', source: 'TENANT' })
    await refused('companyB', 'PUT', '/product/settings', { companyId: null, version: (await tenantSettings()).version, editRules: { CONCEPT: 'BLOCKED' } }, 403)
    await refused('styles', 'PUT', '/product/settings', { companyId: companyB, version: 2, editRules: { CONCEPT: 'BLOCKED' } }, 403)
    // B-W2b-239: the read says whether the caller may change the row (the Product settings screen draws text otherwise).
    expect((await ok('companyB', 'GET', `/product/settings?companyId=${companyB}`)).settings.mayChange).toBe(true)
    expect((await ok('companyB', 'GET', '/product/settings')).settings.mayChange).toBe(false)
    expect((await ok('manager', 'GET', '/product/settings')).settings.mayChange).toBe(true)
    expect((await tenantSettings()).mayChange).toBe(false)
  })

  it('the cutting table (a floor session) reads the tolerance of the cut order\'s material for its company', async () => {
    const [leather] = await admin<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND kind = 'LEATHER' ORDER BY code LIMIT 1`, [tenant])
    const [lining] = await admin<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND kind = 'LINING' ORDER BY code LIMIT 1`, [tenant])
    const floor = { audience: 'floor' as const, tenantId: tenant, actorId: newId(), siteId: siteA1 }
    const read = (itemId: string) => database.withScope(floor, (client) => client.$transaction((tx) => toleranceForCutOrder(tx, tenant, { companyId: companyA, itemId })))
    expect(await read(leather!.id)).toEqual({ rule: 'WARN_ABOVE', percent: '5', source: 'COMPANY', byKind: true })
    expect(await read(lining!.id)).toEqual({ rule: 'WARN_ABOVE', percent: '3', source: 'COMPANY', byKind: false })
  })
})
