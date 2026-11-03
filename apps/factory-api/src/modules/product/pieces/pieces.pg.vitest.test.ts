import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The pattern pieces of a style revision on the local stack (B-W2b-95; PRD-219, MES-055), with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security and the PatternPiece
 * guards of …_cutting_room_w2b_guards are real), the product seed's jacket (range 50 · 52 · 54; line 10 the HIDE-tracked
 * leather, 20 the lining, 30 the protector), four made-up leather grades, and sessions from the test authenticator. Every
 * code and name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/pieces`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'pieces-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const leatherItem = seedId('product:item:leather')
const protectorItem = seedId('product:item:protector')
const line = { leather: seedId('product:bom:JKT-01:1:10'), lining: seedId('product:bom:JKT-01:1:20'), protector: seedId('product:bom:JKT-01:1:30') }
const grade = { A: newId(), B: newId(), C: newId(), D: newId() }
const otherTenant = newId()

const BOM: Permission[] = ['product.bom.view', 'product.bom.manage', 'product.bom.release']
const STYLES: Permission[] = ['product.styles.view', 'product.styles.manage']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  maker: { tenantId: tenant, permissions: [...BOM, ...STYLES, 'product.routing.view', 'product.routing.manage', 'audit.read'], companies: 'all' },
  viewer: { tenantId: tenant, permissions: ['product.bom.view'], companies: 'all' },
  companyA: { tenantId: tenant, permissions: BOM, companies: [companyA] },
  stylesOnly: { tenantId: tenant, permissions: STYLES, companies: 'all' },
  otherTenant: { tenantId: otherTenant, permissions: BOM, companies: 'all' },
}
const ACTORS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: ACTORS[key]!, grants: [grant] }]
  }),
)
// A floor device holding even the BOM's permissions: these routes are the office's only.
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
const piecesUrl = (styleId: string, revisionId: string) => `${revisionUrl(styleId, revisionId)}/pieces`
const getPieces = async (styleId: string, revisionId: string, session = 'maker'): Promise<Json> => (await ok(session, 'GET', piecesUrl(styleId, revisionId))).pieces
const pieceNamed = (pieces: Json, name: string): Json => pieces.pieces.find((piece: Json) => piece.name === name)
const names = (pieces: Json): [number, string][] => pieces.pieces.map((piece: Json) => [piece.seq, piece.name])
const historyOf = async (recordType: string, id: string): Promise<any[]> => (await ok('maker', 'GET', `/audit/${recordType}/${id}`)).entries
const eventsOf = async (subject: string, type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])

beforeAll(async () => {
  db = await migratedDatabase('pieces')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'pieces-other'])
  // Four made-up grades (B-W2b-80's LeatherGrade): A is the best (sortOrder 1).
  for (const [index, code] of (['A', 'B', 'C', 'D'] as const).entries()) {
    await admin('INSERT INTO "LeatherGrade" (id, "tenantId", code, "labelIt", "labelEn", "usableShare", "sortOrder") VALUES ($1, $2, $3, $4, $5, $6, $7)', [grade[code], tenant, code, `Scelta ${code}`, `Grade ${code}`, String(90 - index * 15), index + 1])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the pattern pieces of a draft revision (PRD-219, MES-055)', () => {
  it('starts empty: the lines it may name (leather when tracked by hide), the grades in order, the range, and the leather line no piece names', async () => {
    const pieces = await getPieces(jacket, revision1, 'viewer')
    expect(pieces).toMatchObject({ revision: { id: revision1, revision: 1, status: 'DRAFT', version: 1 }, style: { id: jacket, code: 'SEED-JKT-01' }, pieces: [], editable: true })
    expect(pieces.sizes.map((size: Json) => size.code)).toEqual(['50', '52', '54'])
    expect(pieces.lines.map((entry: Json) => [entry.seq, entry.id, entry.leather])).toEqual([
      [10, line.leather, true],
      [20, line.lining, false],
      [30, line.protector, false],
    ])
    expect(pieces.grades.map((entry: Json) => entry.code)).toEqual(['A', 'B', 'C', 'D'])
    expect(pieces.issues).toEqual([{ code: 'LEATHER_LINE_NO_PIECES', pieceId: null, lineId: line.leather, message: expect.stringContaining('Line 10') }])
  })

  it('adds pieces at the end, each a write on the revision (version, audit row, event), sizes kept in the range order', async () => {
    let version = (await getPieces(jacket, revision1)).revision.version
    let pieces = (await ok('maker', 'POST', piecesUrl(jacket, revision1), { version, name: '  Front   left ', bomLineId: line.leather, minGradeId: grade.B, grain: 'ALONG' }, 201)).pieces
    expect(pieceNamed(pieces, 'Front left')).toMatchObject({ seq: 10, quantity: 1, bomLineId: line.leather, minGradeId: grade.B, grain: 'ALONG', sizes: [], note: null })
    expect(pieces.revision.version).toBe(version + 1)
    expect(pieces.issues).toEqual([])
    version = pieces.revision.version
    pieces = (await ok('maker', 'POST', piecesUrl(jacket, revision1), { version, name: 'Sleeve', quantity: 2, bomLineId: line.leather, minGradeId: grade.C, sizes: ['54', '52'], note: 'Size 50 has the one-piece sleeve (made up).' }, 201)).pieces
    version = pieces.revision.version
    pieces = (await ok('maker', 'POST', piecesUrl(jacket, revision1), { version, name: 'Body lining', bomLineId: line.lining }, 201)).pieces
    expect(names(pieces)).toEqual([
      [10, 'Front left'],
      [20, 'Sleeve'],
      [30, 'Body lining'],
    ])
    expect(pieceNamed(pieces, 'Sleeve')).toMatchObject({ quantity: 2, sizes: ['52', '54'], grain: 'ANY', minGradeId: grade.C })
    expect(pieceNamed(pieces, 'Body lining')).toMatchObject({ minGradeId: null, grain: 'ANY' })

    const front = pieceNamed(pieces, 'Front left')
    const history = await historyOf('PatternPiece', front.id)
    expect(history[0]).toMatchObject({ action: 'product.pieces.add', after: { revisionId: revision1, name: 'Front left', minGradeId: grade.B, grain: 'ALONG' } })
    const events = await eventsOf(jacket, 'style.pieces_changed')
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.at(-1)!.payload).toMatchObject({ styleId: jacket, code: 'SEED-JKT-01', revisionId: revision1, revision: 1, pieceIds: [pieceNamed(pieces, 'Body lining').id] })
  })

  it('refuses in words: a name twice (any case), a grade on a line that is not leather or with no line, a size outside the range, a retired grade newly set', async () => {
    const pieces = await getPieces(jacket, revision1)
    const version = pieces.revision.version
    const url = piecesUrl(jacket, revision1)
    const twice = await refused('maker', 'POST', url, { version, name: 'FRONT left' }, 400)
    expect(twice.issues).toEqual([{ path: 'body/name', message: expect.stringContaining('already has a piece called "FRONT left"') }])
    const lining = await refused('maker', 'POST', url, { version, name: 'Pocket bag', bomLineId: line.lining, minGradeId: grade.A }, 400)
    expect(lining.issues).toEqual([{ path: 'body/minGradeId', message: expect.stringContaining('is not leather') }])
    const noLine = await refused('maker', 'POST', url, { version, name: 'Collar', minGradeId: grade.A }, 400)
    expect(noLine.issues).toEqual([{ path: 'body/minGradeId', message: expect.stringContaining('choose the leather line') }])
    const outside = await refused('maker', 'POST', url, { version, name: 'Collar', sizes: ['48', '52'] }, 400)
    expect(outside.issues).toEqual([{ path: 'body/sizes', message: "Not in the style's range: 48." }])
    await admin('UPDATE "LeatherGrade" SET active = false WHERE id = $1', [grade.D])
    const retired = await refused('maker', 'POST', url, { version, name: 'Facing', bomLineId: line.leather, minGradeId: grade.D }, 400)
    expect(retired.issues).toEqual([{ path: 'body/minGradeId', message: 'Grade D is retired: choose a grade in use.' }])
    // The retired grade leaves the view's grades (no piece names it).
    expect((await getPieces(jacket, revision1)).grades.map((entry: Json) => entry.code)).toEqual(['A', 'B', 'C'])
    await admin('UPDATE "LeatherGrade" SET active = true WHERE id = $1', [grade.D])
    // Nothing was written: the revision's version is the same.
    expect((await getPieces(jacket, revision1)).revision.version).toBe(version)
  })

  it('refuses a stale version, a viewer, a person without the BOM, another tenant and the floor', async () => {
    const pieces = await getPieces(jacket, revision1)
    const front = pieceNamed(pieces, 'Front left')
    const url = `${piecesUrl(jacket, revision1)}/${front.id}`
    expect((await refused('maker', 'PATCH', url, { version: pieces.revision.version - 1, quantity: 3 }, 409)).code).toBe('conflict')
    expect((await refused('viewer', 'PATCH', url, { version: pieces.revision.version, quantity: 3 }, 403)).code).toBe('forbidden')
    expect((await refused('companyA', 'PATCH', url, { version: pieces.revision.version, quantity: 3 }, 403)).message).toBe('The BOM of a style for every company is changed only by a role over every company.')
    expect((await refused('stylesOnly', 'GET', piecesUrl(jacket, revision1), undefined, 403)).code).toBe('forbidden')
    expect((await refused('otherTenant', 'GET', piecesUrl(jacket, revision1), undefined, 404)).message).toBe('Style not found.')
    expect((await call('floor', 'GET', piecesUrl(jacket, revision1))).statusCode).toBe(403)
  })

  it('changes a cell (only what it names), and moving a graded piece off leather needs its grade cleared in the same write', async () => {
    let pieces = await getPieces(jacket, revision1)
    const front = pieceNamed(pieces, 'Front left')
    const url = `${piecesUrl(jacket, revision1)}/${front.id}`
    pieces = (await ok('maker', 'PATCH', url, { version: pieces.revision.version, name: 'Front left panel', quantity: 1, note: '  ' })).pieces
    expect(pieceNamed(pieces, 'Front left panel')).toMatchObject({ id: front.id, seq: 10, minGradeId: grade.B, note: null, version: front.version + 1 })
    const history = await historyOf('PatternPiece', front.id)
    expect(history[0]).toMatchObject({ action: 'product.pieces.update', before: { name: 'Front left' }, after: { name: 'Front left panel' } })
    expect(Object.keys(history[0].after)).toEqual(['name'])
    const off = await refused('maker', 'PATCH', url, { version: pieces.revision.version, bomLineId: line.lining }, 400)
    expect(off.issues).toEqual([{ path: 'body/bomLineId', message: expect.stringContaining('Clear the grade first') }])
    pieces = (await ok('maker', 'PATCH', url, { version: pieces.revision.version, bomLineId: line.lining, minGradeId: null })).pieces
    expect(pieceNamed(pieces, 'Front left panel')).toMatchObject({ bomLineId: line.lining, minGradeId: null })
    pieces = (await ok('maker', 'PATCH', url, { version: pieces.revision.version, bomLineId: line.leather, minGradeId: grade.B })).pieces
    expect(pieceNamed(pieces, 'Front left panel')).toMatchObject({ bomLineId: line.leather, minGradeId: grade.B })
  })

  it('reorders every piece (10, 20, 30), refusing an order that leaves one out', async () => {
    let pieces = await getPieces(jacket, revision1)
    const ids = (name: string) => pieceNamed(pieces, name).id
    const order = [ids('Body lining'), ids('Sleeve'), ids('Front left panel')]
    const url = `${piecesUrl(jacket, revision1)}/order`
    expect((await refused('maker', 'PUT', url, { version: pieces.revision.version, pieceIds: order.slice(1) }, 400)).issues[0].message).toContain('leaves out 1 piece')
    pieces = (await ok('maker', 'PUT', url, { version: pieces.revision.version, pieceIds: order })).pieces
    expect(names(pieces)).toEqual([
      [10, 'Body lining'],
      [20, 'Sleeve'],
      [30, 'Front left panel'],
    ])
  })

  it("changes several at once, all or none, naming each refused piece; removes several at once", async () => {
    let pieces = await getPieces(jacket, revision1)
    const id = (name: string) => pieceNamed(pieces, name).id
    const url = piecesUrl(jacket, revision1)
    const refusedChange = await refused('maker', 'POST', `${url}/change`, { version: pieces.revision.version, pieceIds: [id('Sleeve'), id('Body lining')], minGradeId: grade.A }, 400)
    expect(refusedChange.issues).toEqual([{ path: `body/pieces/${id('Body lining')}/minGradeId`, message: expect.stringMatching(/^Body lining: .*not leather/) }])
    expect(pieceNamed(await getPieces(jacket, revision1), 'Sleeve').minGradeId).toBe(grade.C)
    pieces = (await ok('maker', 'POST', `${url}/change`, { version: pieces.revision.version, pieceIds: [id('Sleeve'), id('Front left panel')], minGradeId: grade.A, grain: 'ACROSS' })).pieces
    expect(pieceNamed(pieces, 'Sleeve')).toMatchObject({ minGradeId: grade.A, grain: 'ACROSS' })
    expect(pieceNamed(pieces, 'Front left panel')).toMatchObject({ minGradeId: grade.A, grain: 'ACROSS' })
    // A piece to remove at once, with another one.
    pieces = (await ok('maker', 'POST', url, { version: pieces.revision.version, name: 'Spare 1' }, 201)).pieces
    pieces = (await ok('maker', 'POST', url, { version: pieces.revision.version, name: 'Spare 2' }, 201)).pieces
    pieces = (await ok('maker', 'POST', `${url}/remove`, { version: pieces.revision.version, pieceIds: [id('Spare 1'), pieceNamed(pieces, 'Spare 2').id] })).pieces
    expect(names(pieces).map(([, name]) => name)).toEqual(['Body lining', 'Sleeve', 'Front left panel'])
    expect((await refused('maker', 'POST', `${url}/remove`, { version: pieces.revision.version, pieceIds: [newId()] }, 404)).message).toBe('1 pattern piece(s) are not of this revision.')
  })

  it('holds the BOM: a line a piece is cut from is not removed, and a graded line does not turn into a material that is not leather (409 in words)', async () => {
    const bom = (await ok('maker', 'GET', `${revisionUrl(jacket, revision1)}/bom`)).bom
    const removeLine = await refused('maker', 'DELETE', `${revisionUrl(jacket, revision1)}/bom/lines/${line.leather}?version=${bom.revision.version}`, undefined, 409)
    expect(removeLine.message).toMatch(/^2 pattern piece\(s\) are cut from line 10 \("Sleeve", "Front left panel"\)/)
    expect(removeLine.issues.map((issue: Json) => issue.path)).toEqual(expect.arrayContaining([expect.stringMatching(/^pieces\/.+\/bomLineId$/)]))
    const toPieces = await refused('maker', 'PATCH', `${revisionUrl(jacket, revision1)}/bom/lines/${line.leather}`, { version: bom.revision.version, itemId: protectorItem, uom: 'PCS', qty: '2', sizeDependent: false, colourDependent: false }, 409)
    expect(toPieces.message).toMatch(/have a minimum leather grade \("Sleeve", "Front left panel"\) and SEED-PRO-300 is not leather/)
    // The protector's line names no piece: it goes as before.
    const removed = (await ok('maker', 'DELETE', `${revisionUrl(jacket, revision1)}/bom/lines/${line.protector}?version=${bom.revision.version}`)).bom
    expect(removed.lines.map((entry: Json) => entry.seq)).toEqual([10, 20])
    // Same material: no question asked.
    await ok('maker', 'PATCH', `${revisionUrl(jacket, revision1)}/bom/lines/${line.leather}`, { version: removed.revision.version, itemId: leatherItem })
  })
})

describe('frozen with the release, copied with the revision and with the style', () => {
  it('freezes the pieces with the release: read only, refused in words', async () => {
    const bom = (await ok('maker', 'GET', `${revisionUrl(jacket, revision1)}/bom`)).bom
    await ok('maker', 'POST', `${revisionUrl(jacket, revision1)}/release`, { version: bom.revision.version })
    const pieces = await getPieces(jacket, revision1)
    expect(pieces).toMatchObject({ editable: false, issues: [] })
    expect(pieces.pieces).toHaveLength(3)
    const refusal = await refused('maker', 'POST', piecesUrl(jacket, revision1), { version: pieces.revision.version, name: 'Late piece' }, 409)
    expect(refusal.message).toBe('Revision 1 is released: its pattern pieces are frozen. Change them in a new draft revision.')
  })

  it('copies them into the next draft with the new lines; a grade retired since is left off and named in the audit row', async () => {
    await admin('UPDATE "LeatherGrade" SET active = false WHERE id = $1', [grade.A])
    const draft = (await ok('maker', 'POST', `${revisionUrl(jacket, revision1)}/copy`, { changeNote: 'Pieces travel along (made up).' }, 201)).bom
    const pieces = await getPieces(jacket, draft.revision.id)
    expect(pieces.editable).toBe(true)
    expect(names(pieces)).toEqual([
      [10, 'Body lining'],
      [20, 'Sleeve'],
      [30, 'Front left panel'],
    ])
    const leatherLine = pieces.lines.find((entry: Json) => entry.seq === 10)
    const liningLine = pieces.lines.find((entry: Json) => entry.seq === 20)
    expect(leatherLine.id).not.toBe(line.leather)
    expect(pieceNamed(pieces, 'Sleeve')).toMatchObject({ bomLineId: leatherLine.id, minGradeId: null, sizes: ['52', '54'], quantity: 2, grain: 'ACROSS' })
    expect(pieceNamed(pieces, 'Body lining')).toMatchObject({ bomLineId: liningLine.id })
    const original = await getPieces(jacket, revision1)
    expect(pieceNamed(original, 'Sleeve').minGradeId).toBe(grade.A)
    const history = await historyOf('StyleRevision', draft.revision.id)
    expect(history.find((entry: Json) => entry.action === 'product.bom.copyRevision')).toMatchObject({ after: { pieces: { copied: 3, gradesCleared: ['Sleeve', 'Front left panel'], leftOut: [], linesCleared: [] } } })
    await admin('UPDATE "LeatherGrade" SET active = true WHERE id = $1', [grade.A])
  })

  it('copies them with the BOM when the style is copied', async () => {
    const copy = await ok('maker', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-PP', name: 'Seed jacket, pieces copy', parts: ['BOM'], fromRevisionId: revision1 }, 201)
    const pieces = await getPieces(copy.style.id, copy.revision.id)
    expect(names(pieces).map(([, name]) => name)).toEqual(['Body lining', 'Sleeve', 'Front left panel'])
    expect(pieceNamed(pieces, 'Front left panel')).toMatchObject({ minGradeId: grade.A, bomLineId: pieces.lines.find((entry: Json) => entry.seq === 10).id })
    // Without the BOM no piece travels.
    const bare = await ok('maker', 'POST', `/product/styles/${jacket}/duplicate`, { code: 'SEED-JKT-PR', name: 'Seed jacket, routing copy', parts: ['ROUTING'], fromRevisionId: revision1 }, 201)
    expect((await getPieces(bare.style.id, bare.revision.id)).pieces).toEqual([])
  })
})
