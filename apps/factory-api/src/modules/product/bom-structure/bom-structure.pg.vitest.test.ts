import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The structure of a style revision's BOM on the local stack (B-W2b-223; PRD-077, PRD-078, PRD-087, PRD-106), with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security and
 * B-W2b-211's …_bom_options_w2b_guards are real), B-W2b-211's options seed (SEED-JKT-05 revision 1 DRAFT: the shell with its
 * thread grouped under it, the lining and the protector with alternates, the liner sub-assembly SEED-LNR-01 revision 1
 * RELEASED only with the liner option, the brand's label sent by the brand), and sessions from the test authenticator.
 * Every code and name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/bom-structure`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let S: OptionsSeed

const NS = 'bom-structure-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const blockedItem = newId()

const BOM: Permission[] = ['product.bom.view', 'product.bom.manage', 'product.bom.release']
const PEOPLE: Record<string, { tenantId: string; permissions: readonly Permission[]; companies: ScopeSet }> = {
  maker: {
    tenantId: tenant,
    permissions: [...BOM, 'product.styles.view', 'product.styles.manage', 'product.routing.view', 'product.routing.manage', 'product.materials.view', 'audit.read'],
    companies: 'all',
  },
  viewer: { tenantId: tenant, permissions: ['product.bom.view'], companies: 'all' },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: newId(), grants: [grant] }]
  }),
)
SESSIONS.floor = { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1'), deviceId: newId(), grants: [{ permissions: [...BOM, 'floor.work'], companies: [companyA], sites: [seedId('site:A1')], parties: 'all' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
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
const revisionUrl = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}`
const structureOf = async (styleId: string, revisionId: string, session = 'maker'): Promise<Json> => (await ok(session, 'GET', `${revisionUrl(styleId, revisionId)}/bom/structure`)).structure
const lineOf = (structure: Json, seq: number): Json => structure.lines.find((line: Json) => line.seq === seq)
const eventsOf = async (subject: string, type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])

beforeAll(async () => {
  db = await migratedDatabase('bom_structure')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  S = await seedOptions({ db: database, namespace: NS })
  // A made-up zip refused for use (B-W2b-206's approval: BLOCKED with who, when and why).
  await admin(
    `INSERT INTO "Item" (id, "tenantId", code, name, kind, sourcing, tracking, "baseUom", "purchaseUom", "consumptionUom", approval, "approvedAt", "approvedById", "approvalNote", "createdAt", "updatedAt")
     VALUES ($1, $2, 'BS-TRM-901', 'Made-up nickel zip', 'TRIM', 'BUY', 'NONE', 'PCS', 'PCS', 'PCS', 'BLOCKED', now(), $3, 'Nickel release above the limit (made-up).', now(), now())`,
    [blockedItem, tenant, newId()],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 240_000)

describe('the structure of a draft BOM (PRD-077, PRD-078, PRD-087)', () => {
  it('reads sections, group rows, the sub-assembly tree and the BOM check', async () => {
    const structure = await structureOf(S.jacketStyleId, S.jacketRevisionId, 'viewer')
    expect(structure).toMatchObject({ revision: { status: 'DRAFT' }, style: { code: 'SEED-JKT-05' }, editable: true, outputQuantity: 1, outputUom: 'PCS', levels: 2 })
    expect(structure.lines.map((line: Json) => [line.seq, line.section, line.filed, line.depth])).toEqual([
      [10, 'SHELL', true, 0],
      [15, 'THREAD', true, 1],
      [20, 'LINING', true, 0],
      [30, 'PROTECTION', true, 0],
      [40, 'INSULATION', true, 0],
      [50, 'LABELS', true, 0],
    ])
    expect(lineOf(structure, 10).groupedLineIds).toEqual([S.bomLineIds.thread])
    expect(lineOf(structure, 40).subAssembly).toMatchObject({ style: { code: 'SEED-LNR-01' }, revision: { revision: 1, status: 'RELEASED' } })
    expect(lineOf(structure, 50)).toMatchObject({ customerSuppliedByPartyId: seedId('party:P1'), sourceKey: 'branding:brand-label' })
    expect(structure.sections.map((section: Json) => section.section)).toEqual(['SHELL', 'LINING', 'INSULATION', 'PROTECTION', 'THREAD', 'LABELS'])
    expect(structure.tree).toEqual([expect.objectContaining({ level: 1, lineId: S.bomLineIds.liner, seq: 40, lines: 2, subAssemblies: 0 })])
    expect(structure.check).toMatchObject({ checked: true, blockers: [], releasable: true })
    const check = (await ok('viewer', 'GET', `${revisionUrl(S.jacketStyleId, S.jacketRevisionId)}/bom/check`)).check
    expect(check).toEqual(structure.check)
  })

  it('files and groups one line, refuses itself and a circle in words, and keeps a group row while lines are under it', async () => {
    const url = revisionUrl(S.jacketStyleId, S.jacketRevisionId)
    let structure = await structureOf(S.jacketStyleId, S.jacketRevisionId)
    const before = (await eventsOf(S.jacketStyleId, 'style.bom_changed')).length
    structure = (await ok('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.lining}/structure`, { version: structure.revision.version, section: 'INSULATION', parentLineId: S.bomLineIds.shell })).structure
    expect(lineOf(structure, 20)).toMatchObject({ section: 'INSULATION', parentLineId: S.bomLineIds.shell, depth: 1 })
    expect((await eventsOf(S.jacketStyleId, 'style.bom_changed')).slice(before).map((event) => event.payload.lineIds)).toEqual([[S.bomLineIds.lining]])

    let error = await refused('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.shell}/structure`, { version: structure.revision.version, parentLineId: S.bomLineIds.lining }, 400)
    expect(error.issues).toEqual([{ path: 'body/parentLineId', message: 'Line 10 cannot be grouped under line 20: line 20 is grouped under it (a circle). Ungroup line 20 first.' }])
    error = await refused('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.shell}/structure`, { version: structure.revision.version, parentLineId: S.bomLineIds.shell }, 400)
    expect(error.issues[0].message).toBe('Line 10 cannot be grouped under itself.')
    // W1's DELETE of a group row: refused in words (the key's Restrict was a 500).
    error = await refused('maker', 'DELETE', `${url}/bom/lines/${S.bomLineIds.shell}?version=${structure.revision.version}`, undefined, 409)
    expect(error.message).toBe('Line 10 is the group row of lines 15, 20: ungroup them (or remove them) first.')

    // The list's selection: two lines filed and ungrouped at once; a selection under one of its own lines is refused.
    structure = (await ok('maker', 'POST', `${url}/bom/structure/change`, { version: structure.revision.version, lineIds: [S.bomLineIds.lining, S.bomLineIds.thread], section: 'LINING', parentLineId: null })).structure
    expect([lineOf(structure, 15), lineOf(structure, 20)].map((line) => [line.section, line.parentLineId])).toEqual([
      ['LINING', null],
      ['LINING', null],
    ])
    error = await refused('maker', 'POST', `${url}/bom/structure/change`, { version: structure.revision.version, lineIds: [S.bomLineIds.lining, S.bomLineIds.thread], parentLineId: S.bomLineIds.thread }, 400)
    expect(error.issues[0].message).toBe('Line 15 is in the selection: a line is not grouped under itself.')
    // Back as seeded: the thread under the shell, in its section; the lining in its own.
    structure = (await ok('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.thread}/structure`, { version: structure.revision.version, section: 'THREAD', parentLineId: S.bomLineIds.shell })).structure
    structure = (await ok('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.lining}/structure`, { version: structure.revision.version, section: 'LINING' })).structure
    expect(lineOf(structure, 15)).toMatchObject({ section: 'THREAD', depth: 1 })

    // Office only, product.bom.manage over the style's company.
    await refused('viewer', 'PUT', `${url}/bom/lines/${S.bomLineIds.lining}/structure`, { version: structure.revision.version, section: 'OTHER' }, 403)
    expect((await call('floor', 'GET', `${url}/bom/structure`)).statusCode).toBe(403)
    await refused('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.lining}/structure`, { version: structure.revision.version }, 400)
  })

  it("says the database's sub-assembly rules in words: not a component we make, its own style, a circle of styles", async () => {
    const url = revisionUrl(S.jacketStyleId, S.jacketRevisionId)
    let structure = await structureOf(S.jacketStyleId, S.jacketRevisionId)
    let error = await refused('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.lining}/structure`, { version: structure.revision.version, subAssembly: { styleId: S.linerStyleId, revisionId: S.linerRevisionId } }, 400)
    expect(error.issues[0]).toMatchObject({ path: 'body/subAssembly/styleId', message: expect.stringMatching(/^Line 20 takes SEED-LIN-200 \(lining, bought\): a sub-assembly line takes the COMPONENT we make/) })
    error = await refused('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.liner}/structure`, { version: structure.revision.version, subAssembly: { styleId: S.jacketStyleId, revisionId: S.jacketRevisionId } }, 400)
    expect(error.issues[0].message).toMatch(/never its own sub-assembly/)

    // The liner's next draft takes the jacket: SEED-LNR-01 would be inside its own sub-assemblies.
    const linerDraft = (await ok('maker', 'POST', `${revisionUrl(S.linerStyleId, S.linerRevisionId)}/copy`, { changeNote: 'Next liner' }, 201)).bom
    const added = (await ok('maker', 'POST', `${revisionUrl(S.linerStyleId, linerDraft.revision.id)}/bom/lines`, { version: linerDraft.revision.version, itemId: S.itemIds.linerComponent, qty: '1', uom: 'PCS' }, 201)).bom
    const componentLine = added.lines.find((line: Json) => line.item.id === S.itemIds.linerComponent)
    error = await refused('maker', 'PUT', `${revisionUrl(S.linerStyleId, linerDraft.revision.id)}/bom/lines/${componentLine.id}/structure`, { version: added.revision.version, subAssembly: { styleId: S.jacketStyleId, revisionId: S.jacketRevisionId } }, 400)
    expect(error.issues).toEqual([{ path: 'body/subAssembly', message: 'Line 30 cannot take SEED-JKT-05 revision 1: SEED-LNR-01 would be inside its own sub-assemblies (a circle).' }])
    // The liner's draft copy kept its sections (B-W2b-211's columns travel with W1's copy).
    expect((await structureOf(S.linerStyleId, linerDraft.revision.id)).lines.map((line: Json) => [line.seq, line.section, line.filed])).toEqual([
      [10, 'LINING', true],
      [20, 'INSULATION', true],
      [30, 'OTHER', false],
    ])
    // W1's line routes answer the database's line rules in words: a blocked material, a sub-assembly line's component.
    error = await refused('maker', 'POST', `${url}/bom/lines`, { version: structure.revision.version, itemId: blockedItem, qty: '1', uom: 'PCS' }, 400)
    expect(error.issues).toEqual([{ path: 'body/itemId', message: 'BS-TRM-901 is blocked (refused for use); choose another material. Why: Nickel release above the limit (made-up).' }])
    structure = await structureOf(S.jacketStyleId, S.jacketRevisionId)
    error = await refused('maker', 'PATCH', `${url}/bom/lines/${S.bomLineIds.liner}`, { version: structure.revision.version, itemId: S.itemIds.wadding, uom: 'M2', qty: '1' }, 400)
    expect(error.issues[0]).toMatchObject({ path: 'body/itemId', message: expect.stringMatching(/a sub-assembly line takes the COMPONENT we make.*\(It takes a sub-assembly: clear it first/) })
  })

  it('refuses the release while a sub-assembly is a draft (PRD-106), in words, then releases on its released revision', async () => {
    const url = revisionUrl(S.jacketStyleId, S.jacketRevisionId)
    const linerDraft = (await admin<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND status = $2', [S.linerStyleId, 'DRAFT']))[0]!
    let structure = await structureOf(S.jacketStyleId, S.jacketRevisionId)
    structure = (await ok('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.liner}/structure`, { version: structure.revision.version, subAssembly: { styleId: S.linerStyleId, revisionId: linerDraft.id } })).structure
    expect(structure.check.releasable).toBe(false)
    expect(structure.check.blockers).toEqual([
      expect.objectContaining({
        code: 'SUB_ASSEMBLY_NOT_RELEASED',
        severity: 'BLOCKER',
        cell: { lineId: S.bomLineIds.liner, column: 'subAssembly', size: null, colourwayId: null, alternateId: null, stepId: null },
        message: 'Line 40 (SEED-CMP-500): it takes sub-assembly SEED-LNR-01 revision 2, which is a draft. Release SEED-LNR-01 revision 2 first, or take its released revision (no draft part under a released parent).',
      }),
    ])
    const error = await refused('maker', 'POST', `${url}/release`, { version: structure.revision.version }, 409)
    expect(error).toMatchObject({ code: 'invalid_state', message: 'The BOM is not ready to release: 1 problem(s) to fix first.', issues: [{ path: `lines/${S.bomLineIds.liner}/subAssembly`, message: structure.check.blockers[0].message }] })
    expect((await admin('SELECT status FROM "StyleRevision" WHERE id = $1', [S.jacketRevisionId]))[0]).toEqual({ status: 'DRAFT' })

    structure = (await ok('maker', 'PUT', `${url}/bom/lines/${S.bomLineIds.liner}/structure`, { version: structure.revision.version, subAssembly: { styleId: S.linerStyleId, revisionId: S.linerRevisionId } })).structure
    const released = (await ok('maker', 'POST', `${url}/release`, { version: structure.revision.version })).bom
    expect(released.revision.status).toBe('RELEASED')
    expect(await structureOf(S.jacketStyleId, S.jacketRevisionId)).toMatchObject({ editable: false, check: { checked: false, blockers: [], releasable: false } })
  })

  it('a blocked alternate stops the release in words; W1 copy and duplicate carry the structure, the alternates and the offers', async () => {
    const copy = (await ok('maker', 'POST', `${revisionUrl(S.jacketStyleId, S.jacketRevisionId)}/copy`, {}, 201)).bom
    const structure = await structureOf(S.jacketStyleId, copy.revision.id)
    expect(structure.lines.map((line: Json) => [line.seq, line.section, line.depth, line.alternates, line.issueToSubcontract])).toEqual([
      [10, 'SHELL', 0, 0, false],
      [15, 'THREAD', 1, 0, true],
      [20, 'LINING', 0, 1, false],
      [30, 'PROTECTION', 0, 1, false],
      [40, 'INSULATION', 0, 0, false],
      [50, 'LABELS', 0, 0, false],
    ])
    expect(lineOf(structure, 40)).toMatchObject({ optionValueId: S.valueIds.linerYes, subAssembly: { revision: { id: S.linerRevisionId } } })
    expect(lineOf(structure, 50)).toMatchObject({ customerSuppliedByPartyId: seedId('party:P1'), sourceKey: 'branding:brand-label' })
    expect(structure.check.blockers).toEqual([])

    // The second protector is blocked meanwhile: the check and the release say so (the database would refuse it at release).
    await admin('UPDATE "Item" SET approval = $2, "approvedAt" = now(), "approvedById" = $3, "approvalNote" = $4 WHERE id = $1', [S.itemIds.protector2, 'BLOCKED', newId(), 'Failed the impact test (made-up).'])
    const check = (await ok('maker', 'GET', `${revisionUrl(S.jacketStyleId, copy.revision.id)}/bom/check`)).check
    expect(check.blockers.map((item: Json) => [item.code, item.message])).toEqual([['ALTERNATE_BLOCKED', 'Line 30 (SEED-PRO-300): alternate 1 (SEED-PRO-310) is a blocked material; remove it or take another one.']])
    const error = await refused('maker', 'POST', `${revisionUrl(S.jacketStyleId, copy.revision.id)}/release`, { version: copy.revision.version }, 409)
    expect(error.issues.map((issue: Json) => issue.path)).toEqual([`lines/${lineOf(structure, 30).id}/alternates/${check.blockers[0].cell.alternateId}`])

    // Duplicate with the BOM and the routing: the offers first, then the structure; the blocked alternate is left out.
    const { style: copied } = await ok('maker', 'POST', `/product/styles/${S.jacketStyleId}/duplicate`, { code: 'BS-JKT-06', name: 'Made-up copy', parts: ['BOM', 'ROUTING'], fromRevisionId: S.jacketRevisionId }, 201)
    const offers = await admin<{ n: string }>('SELECT count(*)::text AS n FROM "StyleOptionGroup" WHERE "styleId" = $1 AND status = $2', [copied.id, 'ACTIVE'])
    expect(offers[0]!.n).toBe('4')
    const revision = (await admin<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1', [copied.id]))[0]!
    const duplicated = await structureOf(copied.id, revision.id)
    expect([lineOf(duplicated, 15).depth, lineOf(duplicated, 30).alternates, lineOf(duplicated, 40).optionValueId, lineOf(duplicated, 40).subAssembly?.style.code]).toEqual([1, 0, S.valueIds.linerYes, 'SEED-LNR-01'])
    const audit = await admin<{ after: Json }>('SELECT "after" FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND "after" ? $3', ['StyleRevision', revision.id, 'structure'])
    expect(audit[0]!.after.structure).toMatchObject({ lines: 6, alternates: 1, alternatesLeftOut: [{ seq: 30, priority: 1, code: 'SEED-PRO-310' }] })
    await admin('UPDATE "Item" SET approval = $2, "approvedAt" = NULL, "approvedById" = NULL, "approvalNote" = NULL WHERE id = $1', [S.itemIds.protector2, 'PENDING'])
  })
})

describe('the multi-level explosion and where a sub-assembly is used (PRD-078)', () => {
  it("walks the liner's own BOM when the liner option is chosen, in its size and only colourway", async () => {
    const url = `${revisionUrl(S.jacketStyleId, S.jacketRevisionId)}/bom/explosion`
    const without = (await ok('viewer', 'GET', `${url}?sizes=52`)).explosion
    expect(without).toMatchObject({ colourway: { code: 'BLK' }, options: [], outputQuantity: 1, outputUom: 'PCS' })
    expect(without.sizes[0].subAssemblies).toEqual([])
    const withLiner = (await ok('viewer', 'GET', `${url}?sizes=52,54&options=${S.valueIds.linerYes}`)).explosion
    const size54 = withLiner.sizes.find((entry: Json) => entry.size === '54')
    expect(size54.subAssemblies).toEqual([expect.objectContaining({ level: 1, lineId: S.bomLineIds.liner, quantity: '1', size: '54', batches: '1', subAssembly: expect.objectContaining({ style: expect.objectContaining({ code: 'SEED-LNR-01' }) }) })])
    expect(size54.materials.filter((row: Json) => row.level === 2).map((row: Json) => [row.item.code, row.quantity, row.via])).toEqual([
      ['SEED-LIN-200', '1.26', [S.bomLineIds.liner]],
      ['SEED-TXT-520', '0.864', [S.bomLineIds.liner]],
    ])
    expect(size54.materials.find((row: Json) => row.item.code === 'SEED-LBL-540')).toMatchObject({ level: 1, customerSupplied: true })
    expect(size54.byMaterial.find((row: Json) => row.item.code === 'SEED-LIN-200')).toMatchObject({ quantity: '3.15', levels: [1, 2] })
    expect(size54.problems).toEqual([])
    const error = await refused('viewer', 'GET', `${url}?sizes=58`, undefined, 400)
    expect(error.issues[0].message).toMatch(/Not in the style's range \(50, 52, 54\): 58/)
  })

  it('lists the revisions of other styles that take the liner', async () => {
    const usedIn = (await ok('viewer', 'GET', `/product/styles/${S.linerStyleId}/used-in`)).usedIn
    expect(usedIn.style.code).toBe('SEED-LNR-01')
    expect(usedIn.usedIn.map((row: Json) => [row.style.code, row.revision.revision, row.seq, row.takes.revision])).toEqual([
      ['BS-JKT-06', 1, 40, 1],
      ['SEED-JKT-05', 1, 40, 1],
      ['SEED-JKT-05', 2, 40, 1],
    ])
  })
})
