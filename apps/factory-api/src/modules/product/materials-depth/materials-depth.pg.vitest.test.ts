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

/**
 * Materials in depth (B-W2b-238; PRD-029 properties per kind, PRD-033 fibres, PRD-035 approval, PRD-036 where used) through the
 * app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and
 * B-W2b-206's Item_w2b4_depth, BomLine_material_approval and StyleRevision_blocked_material triggers are real), seeded with the
 * core and styles-depth seeds: SEED-JKT-01 revision 1 DRAFT and SEED-JKT-02 revision 1 RELEASED name the leather SEED-LEA-100
 * (per colourway BLK/RED on JKT-01), the lining SEED-LIN-200 (CONDITIONAL, grey) and the protector SEED-PRO-300 (APPROVED, typed
 * EN 1621-1 level 2); SEED-WO-0001 (in progress) and SEED-WO-0002 (draft) make JKT-02 in company A; the zip SEED-TRM-900
 * (BLOCKED) and the polybag SEED-PKG-910 are on no BOM. Made up here: one person's display name.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/materials-depth`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'materials-depth-api'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyB = seedId('company:B')
const leather = seedId('product:item:leather')
const lining = seedId('product:item:lining')
const protector = seedId('product:item:protector')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const jkt01 = seedId('product:style:JKT-01')
const jkt01r1 = seedId('product:revision:JKT-01:1')
const user = newId()

const LIBRARY: Permission[] = ['product.materials.view', 'product.materials.manage', 'product.styles.view', 'product.bom.view', 'product.bom.manage', 'workorders.view']
const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  quality: office([grant([...LIBRARY, 'product.materials.approve'])]),
  library: office([grant(LIBRARY)]),
  viewer: office([grant(['product.materials.view', 'product.styles.view'])]),
  materialsOnly: office([grant(['product.materials.view'])]),
  companyB: office([grant(['product.materials.view', 'product.styles.view', 'workorders.view', 'product.materials.approve'], [companyB])]),
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
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const depthOf = async (materialId: string, session = 'viewer'): Promise<Json> => (await ok(session, 'GET', `/product/materials/${materialId}/depth`)).depth

beforeAll(async () => {
  db = await migratedDatabase('materials_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seeded = await seedStylesDepth({ db: database, namespace: NS })
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [user, tenant, `w2b238-${user}@example.test`, 'Made-up quality lead'])
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

describe('the properties of its kind (PRD-029) and its fibres (PRD-033)', () => {
  it('reads the protector’s typed properties and writes a lining’s, refusing in words', async () => {
    const pro = await depthOf(protector, 'library')
    expect(pro.properties).toEqual({ shape: 'PROTECTOR', keys: ['standard', 'type', 'level', 'size'], values: { standard: 'EN 1621-1:2012', type: 'shoulder', level: '2', size: 'A' } })
    expect(pro.approval).toMatchObject({ approval: 'APPROVED' })
    expect(pro.reach).toMatchObject({ styles: 2, draftRevisions: 1, releasedRevisions: 1, openWorkOrders: 2 })
    // A reader without workorders.view: the open work orders are not counted (null, never 0).
    expect((await depthOf(protector)).reach.openWorkOrders).toBeNull()

    const lin = await depthOf(lining)
    expect(lin.properties.shape).toBe('TEXTILE')
    const version = lin.material.version
    const written = (await ok('library', 'PUT', `/product/materials/${lining}/properties`, { version, properties: { weightGsm: '120.50', widthCm: '150', construction: ' woven ' } })).depth
    expect(written.properties.values).toEqual({ weightGsm: '120.5', widthCm: '150', construction: 'woven' })
    expect(written.material.version).toBe(version + 1)
    expect((await events('material.updated')).at(-1)).toMatchObject({ itemId: lining, fields: ['properties'] })

    // Another kind's field, a wrong number, a stale version, a viewer, the leather (no typed properties).
    expect((await refused('library', 'PUT', `/product/materials/${lining}/properties`, { version: version + 1, properties: { level: '2' } }, 400)).issues[0]).toMatchObject({ path: 'body/properties/level', message: expect.stringMatching(/textile material has no "level"/) })
    expect((await refused('library', 'PUT', `/product/materials/${lining}/properties`, { version: version + 1, properties: { weightGsm: '-3' } }, 400)).issues[0].path).toBe('body/properties/weightGsm')
    expect((await refused('library', 'PUT', `/product/materials/${lining}/properties`, { version, properties: null }, 409)).code).toBe('conflict')
    await refused('viewer', 'PUT', `/product/materials/${lining}/properties`, { version: version + 1, properties: null }, 403)
    expect((await refused('library', 'PUT', `/product/materials/${leather}/properties`, { version: (await depthOf(leather)).material.version, properties: { weightGsm: '900' } }, 400)).issues[0].message).toMatch(/Other attributes/)

    // A kind change that would drop the typed properties: W1's PATCH refuses it in words (no bare 500 from the database).
    const kindRefused = await refused('library', 'PATCH', `/product/materials/${lining}`, { version: version + 1, kind: 'TRIM' }, 409)
    expect(kindRefused.message).toMatch(/clear them on Properties & grades before it becomes a trim material/)
    // Cleared all at once.
    expect((await ok('library', 'PUT', `/product/materials/${lining}/properties`, { version: version + 1, properties: { weightGsm: '120' } })).depth.properties.values).toEqual({ weightGsm: '120' })
  })

  it('reads every fibre of the composition against Annex I', async () => {
    const version = (await depthOf(lining)).material.version
    await ok('library', 'PATCH', `/product/materials/${lining}`, { version, composition: [{ fibre: 'nylon', percent: '80' }, { fibre: 'elastane', percent: '20' }] })
    const fibres = (await depthOf(lining)).fibres
    expect(fibres).toEqual([
      expect.objectContaining({ fibre: 'nylon', annexFibre: 'polyamide', finding: 'NOT_OFFICIAL' }),
      expect.objectContaining({ fibre: 'elastane', annexFibre: 'elastane', finding: null, official: { it: 'elastan', en: 'elastane' } }),
    ])
  })
})

describe('the approval (PRD-035)', () => {
  it('blocks with why, names who and when, holds the draft revision’s new lines and its release, and goes back', async () => {
    const before = await depthOf(lining)
    expect(before.approval.approval).toBe('CONDITIONAL')
    expect(before.reach).toMatchObject({ draftRevisions: 1, releasedRevisions: 1 })
    expect(before.consequences).toEqual(['No new BOM line takes it.', expect.stringContaining('1 draft revision(s)'), expect.stringContaining('1 released revision(s) keep it')])
    const url = `/product/materials/${lining}/approval`

    expect((await refused('quality', 'PUT', url, { version: before.material.version, approval: 'BLOCKED' }, 400)).issues).toEqual([{ path: 'body/note', message: expect.stringContaining('blocked') }])
    await refused('library', 'PUT', url, { version: before.material.version, approval: 'BLOCKED', note: 'x' }, 403)
    // A grant over company B only cannot decide a material of every company.
    expect((await refused('companyB', 'PUT', url, { version: before.material.version, approval: 'BLOCKED', note: 'x' }, 403)).message).toMatch(/every company/)

    const blocked = (await ok('quality', 'PUT', url, { version: before.material.version, approval: 'BLOCKED', note: ' Lab test failed: nickel above the limit (made-up). ' })).depth
    expect(blocked.approval).toMatchObject({ approval: 'BLOCKED', note: 'Lab test failed: nickel above the limit (made-up).', decidedBy: { id: user, name: 'Made-up quality lead' } })
    expect(blocked.approval.decidedAt).toEqual(expect.any(String))
    expect((await events('material.approval_changed')).at(-1)).toEqual({ itemId: lining, code: 'SEED-LIN-200', approval: 'BLOCKED', previous: 'CONDITIONAL' })
    const audit = (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2 AND action = 'product.materialsDepth.decideApproval' ORDER BY at DESC LIMIT 1`, [tenant, lining]))[0]!
    expect(audit.after).toMatchObject({ approval: 'BLOCKED', reached: { draftRevisions: 1, releasedRevisions: 1, openWorkOrders: 2 } })

    // The same decision and note again: said.
    expect((await refused('quality', 'PUT', url, { version: blocked.material.version, approval: 'BLOCKED', note: 'Lab test failed: nickel above the limit (made-up).' }, 409)).message).toMatch(/blocked already/)

    // The style's Compliance tab lists it first; the draft revision is not releasable.
    const approvals = (await ok('library', 'GET', `/product/styles/${jkt01}/revisions/${jkt01r1}/material-approvals`)).approvals
    expect(approvals.materials[0]).toMatchObject({ itemId: lining, approval: 'BLOCKED', lines: [20], alternateOnly: false })
    expect(approvals).toMatchObject({ counts: { blocked: 1, approved: 2 }, releasable: false })
    // A new BOM line naming it: refused in words (B-W2b-223's guard before the database's).
    const revisionVersion = (await admin<{ version: number }>(`SELECT version FROM "StyleRevision" WHERE id = $1`, [jkt01r1]))[0]!.version
    const line = await refused('library', 'POST', `/product/styles/${jkt01}/revisions/${jkt01r1}/bom/lines`, { version: revisionVersion, itemId: lining, placement: 'Pocket bags', uom: 'M', qty: '0.2' }, 400)
    expect(JSON.stringify(line)).toMatch(/blocked/)

    // Another note on the same decision keeps who and when; approved again; back to pending clears them.
    const renoted = (await ok('quality', 'PUT', url, { version: blocked.material.version, approval: 'BLOCKED', note: 'Nickel above the limit; supplier retests (made-up).' })).depth
    expect(renoted.approval.decidedAt).toBe(blocked.approval.decidedAt)
    const approved = (await ok('quality', 'PUT', url, { version: renoted.material.version, approval: 'APPROVED' })).depth
    expect(approved.approval).toMatchObject({ approval: 'APPROVED', note: null })
    const pending = (await ok('quality', 'PUT', url, { version: approved.material.version, approval: 'PENDING', note: 'New supplier (made-up).' })).depth
    expect(pending.approval).toMatchObject({ approval: 'PENDING', decidedAt: null, decidedBy: null, note: 'New supplier (made-up).' })
    // Archived: read only until reactivated.
    await ok('library', 'POST', `/product/materials/${seeded.packagingItemId}/archive`, { version: (await depthOf(seeded.packagingItemId)).material.version })
    expect((await refused('quality', 'PUT', `/product/materials/${seeded.packagingItemId}/approval`, { version: (await depthOf(seeded.packagingItemId)).material.version, approval: 'BLOCKED', note: 'x' }, 409)).message).toMatch(/archived/)
  })
})

describe('where used (PRD-036) and the list (Approval, Used in, Not used in any BOM)', () => {
  it('lists every line and revision with its colours and open work orders, by colour, within what the person reads', async () => {
    const used = (await ok('library', 'GET', `/product/materials/${leather}/where-used`)).whereUsed
    expect(used.summary).toMatchObject({ styles: 2, draftRevisions: 1, releasedRevisions: 1, obsoleteRevisions: 0, lines: 2, alternates: 0, openWorkOrders: 2 })
    expect(used.rows.map((row: Json) => `${row.style.code} r${row.revision.revision} ${row.revision.status} ${row.seq}`)).toEqual(['SEED-JKT-01 r1 DRAFT 10', 'SEED-JKT-02 r1 RELEASED 10'])
    const draft = used.rows[0]
    expect(draft.colourways.map((entry: Json) => `${entry.colourwayCode}:${entry.colour.code}`).sort()).toEqual(['BLK:BLK', 'RED:RED'])
    expect(draft.openWorkOrders).toEqual([])
    expect(used.rows[1].openWorkOrders.map((order: Json) => order.number).sort()).toEqual(['SEED-WO-0001', 'SEED-WO-0002'])
    const blackCount = used.colours.find((entry: Json) => entry.colour.id === leatherBLK).lines
    expect(blackCount).toBeGreaterThanOrEqual(1)

    const black = (await ok('library', 'GET', `/product/materials/${leather}/where-used?itemColourId=${leatherBLK}`)).whereUsed
    expect(black.rows).toHaveLength(blackCount)
    expect(black.rows.every((row: Json) => row.colour?.id === leatherBLK || row.colourways.some((entry: Json) => entry.colour.id === leatherBLK))).toBe(true)
    expect(black.itemColourId).toBe(leatherBLK)
    expect((await refused('library', 'GET', `/product/materials/${leather}/where-used?itemColourId=${newId()}`, undefined, 400)).issues[0].path).toBe('querystring/itemColourId')

    // Company B reads the tenant-wide styles but not company A's work orders; without product.styles.view: no row.
    const b = (await ok('companyB', 'GET', `/product/materials/${leather}/where-used`)).whereUsed
    expect(b.rows).toHaveLength(2)
    expect(b.rows[1].openWorkOrders).toEqual([])
    const none = (await ok('materialsOnly', 'GET', `/product/materials/${leather}/where-used`)).whereUsed
    expect(none).toMatchObject({ stylesAllowed: false, workOrdersAllowed: false, rows: [], summary: { styles: 0, openWorkOrders: null } })
  })

  it('shows Approval and Used in on the list and filters what no current BOM names', async () => {
    const all = (await ok('viewer', 'GET', '/product/materials?status=ALL&limit=200')).materials as Json[]
    const row = (id: string) => all.find((entry) => entry.id === id)!
    expect(row(leather)).toMatchObject({ approval: 'APPROVED', usedInStyles: 2 })
    expect(row(seeded.blockedItemId)).toMatchObject({ approval: 'BLOCKED', usedInStyles: 0 })

    const unused = (await ok('viewer', 'GET', '/product/materials?used=false&limit=200')).materials as Json[]
    expect(unused.map((entry) => entry.id)).toContain(seeded.blockedItemId)
    expect(unused.map((entry) => entry.id)).not.toContain(leather)
    const usedRows = (await ok('viewer', 'GET', '/product/materials?used=true&limit=200')).materials as Json[]
    expect(usedRows.map((entry) => entry.id)).toEqual(expect.arrayContaining([leather, lining, protector]))
    expect(usedRows.map((entry) => entry.id)).not.toContain(seeded.blockedItemId)
    // Without product.styles.view the column says nothing (null), never 0.
    expect(((await ok('materialsOnly', 'GET', '/product/materials?limit=200')).materials as Json[]).find((entry) => entry.id === leather)).toMatchObject({ usedInStyles: null })
  })
})
