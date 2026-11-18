import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { workOrders as workOrderExport } from '../../../platform/exports/sources/work-orders'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'
import { OWN_STYLE_CODE } from '../testing/two-brands' // B-SA-074

/**
 * B-PR-03 (production plan §2, the brand wall; 06-tree §0.6 PW-02 (list, counts, export) and PW-03 (the record and every
 * route of it), and PW-06's Floor now WIP; the step's wall test: "office.p2: P1's work order 404; list, counts and export hold
 * no P1 row; traveller 404; office.all sees both; a legacy mixed work order only for office.all") on
 * the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so
 * row-level security and the one-customer guards are real), the core, files, production and numbering seeds, and the
 * production two-brand harness (../testing/two-brands.ts: brand A = the seeds' P1, brand B = the threads' second brand, a work
 * order each and a mixed one made before the rule). Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well." Every refusal
 * toward a person limited to B is the one a missing record gets, and every answer B's person got is scanned for A's names,
 * codes, numbers and ids. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/work-orders/brand-wall`.
 */

const ns = 'pr03-wall'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.release']
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
/** What must never reach brand B: A's markers and the mixed work order (it holds a cell of A's). */
let aMarkers: Marker[]

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
interface Seen {
  readonly url: string
  readonly status: number
  readonly body: unknown
}
const seenByB: Seen[] = []
async function call(session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, status: response.statusCode, body: Object.keys(body).length > 0 ? body : response.body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, answer.raw).toBe(status)
  return answer.body
}
const listIds = async (session: string, query = '') => ((await ok(session, 'GET', `/production/work-orders?limit=200${query}`)).workOrders as Json[]).map((row) => row.id as string)
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const callerOf = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)
const exportRows = async (session: string, address: string) => {
  const caller = callerOf(session)
  const page = await workOrderExport.read(caller, workOrderExport.query(new URLSearchParams(address)), null, 200)
  return page.rows as Json[]
}

beforeAll(async () => {
  db = await migratedDatabase('pr03_brand_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  expect(w.b.partyId).toBe(ids.b)
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the production unit sees and manages it all (office.all)', { timeout: 60_000 }, () => {
  it('lists both customers’ work orders and the mixed one; each row names its customer and its orders with their customer PO', async () => {
    const { workOrders } = await ok('office.all', 'GET', '/production/work-orders?limit=200')
    const row = (id: string) => (workOrders as Json[]).find((entry) => entry.id === id)!
    const alphaOrder = (await admin<{ number: string; customerRef: string }>(`SELECT number, "customerRef" FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId]))[0]!
    expect(row(w.a.workOrderId)).toMatchObject({ partyId: w.a.partyId, customer: { id: w.a.partyId, code: 'SEED-C1', name: 'Seed Racing' }, mixedCustomers: false, orders: [{ id: w.a.salesOrderId, number: alphaOrder.number, customerRef: alphaOrder.customerRef }] })
    expect(row(w.b.workOrderId)).toMatchObject({ partyId: w.b.partyId, customer: { id: w.b.partyId, code: 'SEED-C2B', name: 'Seed Brand Two' }, mixedCustomers: false, orders: [{ id: w.second.salesOrderId, number: 'SEED-SO-B001', customerRef: 'SEED-B-PO-1' }] })
    expect(row(w.mixed.workOrderId)).toMatchObject({ partyId: null, customer: null, mixedCustomers: true })
    expect(row(w.mixed.workOrderId).orders.map((order: Json) => order.id).sort()).toEqual([w.a.salesOrderId, w.second.salesOrderId].sort())
    // The customer filter.
    const ofB = await listIds('office.all', `&partyId=${w.b.partyId}`)
    expect(ofB).toContain(w.b.workOrderId)
    expect(ofB).not.toContain(w.a.workOrderId)
    expect(ofB).not.toContain(w.mixed.workOrderId)
  })

  it('opens each record, the mixed one too, with its customer; counts and the export hold them all', async () => {
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder).toMatchObject({ partyId: w.a.partyId, customer: { id: w.a.partyId, code: 'SEED-C1' }, mixedCustomers: false })
    expect((await ok('office.all', 'GET', `/production/work-orders/${w.mixed.workOrderId}`)).workOrder).toMatchObject({ partyId: null, customer: null, mixedCustomers: true })
    const drafts = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkOrder" WHERE "tenantId" = $1 AND status = 'DRAFT'`, [w.tenantId]))[0]!.n
    expect((await ok('office.all', 'GET', '/production/work-orders/counts')).counts.draft).toBe(drafts)
    expect((await ok('office.all', 'GET', `/production/work-orders/counts?partyId=${w.b.partyId}`)).counts.draft).toBe(1)
    const rows = await exportRows('office.all', 'view=all')
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId]))
    const customer = workOrderExport.columns.customer!.value(rows.find((row) => row.id === w.a.workOrderId), (code: string) => code) as string
    expect(customer).toMatch(/^Seed Racing · T-PR03-SO-\w+ \(T-PR03-PO-\w+\)$/)
    expect((await exportRows('office.all', `view=all&party=${w.b.partyId}`)).map((row) => row.id)).toEqual([w.b.workOrderId])
    expect(() => workOrderExport.query(new URLSearchParams('view=all&party=not-an-id'))).toThrow(/Not a customer/)
  })
})

describe('a person limited to customer B (office.p2) never meets customer A', { timeout: 60_000 }, () => {
  it('A’s work order and the mixed one are not found on every work order route, reads and writes, as an unknown one', async () => {
    const unknown = newId()
    for (const workOrderId of [w.a.workOrderId, w.mixed.workOrderId, unknown]) {
      for (const [method, path, payload] of [
        ['GET', '', undefined],
        ['GET', '/release-check', undefined],
        ['GET', '/spec/compare', undefined],
        ['GET', '/traveller', undefined],
        ['PATCH', '', { note: 'B was here' }],
        ['PUT', '/cells', { cells: [{ salesOrderLineId: w.a.salesOrderLineId, size: '54', quantity: 1 }] }],
        ['POST', '/release', {}],
        ['POST', '/start', {}],
        ['POST', '/cancel', { reason: 'B was here' }],
        ['POST', '/split/preview', { cells: [{ cellId: newId(), quantity: 1 }] }],
      ] as const) {
        const answer = await call('office.p2', method, `/production/work-orders/${workOrderId}${path}`, payload)
        expect(answer.status, `${method} ${path}: ${answer.raw}`).toBe(404)
        expect(answer.body.error).toMatchObject({ code: 'not_found', message: 'Work order not found.' })
      }
    }
    // Nothing was written to A's work order.
    expect((await admin(`SELECT note, status FROM "WorkOrder" WHERE id = $1`, [w.a.workOrderId]))[0]).toEqual({ note: null, status: 'DRAFT' })
    // Travellers of several: the whole request is refused as for an unknown id (the asked id is the caller's own word).
    const many = await call('office.p2', 'GET', `/production/work-orders/travellers?ids=${w.b.workOrderId},${w.a.workOrderId}`)
    const none = await call('office.p2', 'GET', `/production/work-orders/travellers?ids=${w.b.workOrderId},${unknown}`)
    expect([many.status, none.status]).toEqual([404, 404])
    expect(many.body.error.message.replace(w.a.workOrderId, '<id>')).toBe(none.body.error.message.replace(unknown, '<id>'))
    seenByB.splice(seenByB.findIndex((entry) => entry.url.includes('/travellers?')), 2)
    // B's own traveller prints.
    expect((await call('office.p2', 'GET', `/production/work-orders/${w.b.workOrderId}/traveller`)).status).toBe(200)
  })

  it('the list, its customer filter, the counts, the readiness, the floor’s WIP and the export hold only B’s', async () => {
    const listed = await listIds('office.p2')
    expect(listed).toContain(w.b.workOrderId)
    expect(listed).not.toContain(w.a.workOrderId)
    expect(listed).not.toContain(w.mixed.workOrderId)
    expect(await listIds('office.p2', `&partyId=${w.a.partyId}`)).toEqual([])
    const ofB = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkOrder" WHERE "partyId" = $1 AND status = 'DRAFT'`, [w.b.partyId]))[0]!.n
    expect((await ok('office.p2', 'GET', '/production/work-orders/counts')).counts).toMatchObject({ draft: ofB, released: 0, inProgress: 0 })
    expect(Object.values((await ok('office.p2', 'GET', `/production/work-orders/counts?partyId=${w.a.partyId}`)).counts).every((n) => n === 0)).toBe(true)
    const asked = `/production/work-orders/readiness?ids=${[w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId].join(',')}`
    const readinessOf = async (session: string) => ((await ok(session, 'GET', asked)).workOrders as Json[]).map((row) => row.workOrderId as string).sort()
    expect(await readinessOf('office.all')).toEqual([w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId].sort())
    expect(await readinessOf('office.p2')).toEqual([w.b.workOrderId])
    // The floor's WIP (open work orders): A's seeded work order is in progress; B (its own only a draft) sees none of A's.
    const wipOf = async (session: string, query = '') => ((await ok(session, 'GET', `/production/scans/wip${query}`)).workOrders as Json[]).map((row) => row.workOrder.id as string)
    const ofA = await wipOf('office.all', `?partyId=${w.a.partyId}`)
    expect(ofA.length).toBeGreaterThan(0)
    expect(await wipOf('office.all')).toEqual(expect.arrayContaining(ofA))
    expect(await wipOf('office.all', `?partyId=${w.b.partyId}`)).toEqual([])
    expect(await wipOf('office.p2')).toEqual([])
    // The export reads the same walled list.
    expect((await exportRows('office.p2', 'view=all')).map((row) => row.id)).toEqual([w.b.workOrderId])
    expect(await exportRows('office.p2', `view=all&party=${w.a.partyId}`)).toEqual([])
  })

  it('cannot make a work order of A’s order lines, nor read their open lines; the bulk edit and Release N find no A row', async () => {
    const made = await call('office.p2', 'POST', '/production/work-orders', { siteId: w.siteId, lines: [{ salesOrderLineId: w.a.salesOrderLineId, sizes: [{ size: '54', quantity: 1 }] }] })
    expect(made.status, made.raw).toBe(404)
    expect(made.body.error.message).toBe('Sales order line not found.')
    const open = await call('office.p2', 'GET', `/production/work-orders/open-lines?salesOrderId=${w.a.salesOrderId}`)
    expect(open.status).toBe(404)
    expect(open.body.error.message).toBe('Sales order not found.')
    const before = (await admin<{ version: number; priority: number }>(`SELECT version, priority FROM "WorkOrder" WHERE id = $1`, [w.a.workOrderId]))[0]!
    for (const listKey of ['production.work-orders', 'production.work-orders.release']) {
      const changes = listKey === 'production.work-orders' ? { priority: 7 } : { status: 'RELEASED' }
      const unknown = newId()
      const preview = await ok('office.p2', 'POST', '/views/bulk/preview', { listKey, ids: [w.a.workOrderId, w.mixed.workOrderId, unknown], changes })
      // Each row answers as an unknown id does: only the asked id (the caller's own word) differs.
      const [ofA, ofMixed, ofUnknown] = (preview.rows as Json[]).map(({ id: _id, ...row }) => row)
      expect(ofA).toEqual(ofUnknown)
      expect(ofMixed).toEqual(ofUnknown)
      expect(ofUnknown!.refusal?.code).toBe('missing')
      const applied = await ok('office.p2', 'POST', '/views/bulk/apply', { listKey, rows: [{ id: w.a.workOrderId, version: before.version, changes }] })
      expect((applied.results as Json[]).map((row) => [row.ok, row.refusal?.code])).toEqual([[false, 'missing']])
    }
    expect((await admin(`SELECT version, priority FROM "WorkOrder" WHERE id = $1`, [w.a.workOrderId]))[0]).toEqual(before)
  })

  it('B’s person still works on B’s own work order (the wall takes nothing away from its customer)', async () => {
    const record = (await ok('office.p2', 'GET', `/production/work-orders/${w.b.workOrderId}`)).workOrder
    expect(record).toMatchObject({ partyId: w.b.partyId, customer: { id: w.b.partyId }, mixedCustomers: false })
    const patched = await ok('office.p2', 'PATCH', `/production/work-orders/${w.b.workOrderId}`, { version: record.version, note: 'Beta note' })
    expect(patched.workOrder.note).toBe('Beta note')
  })

  it('no answer B’s person got names A: not its names, code, orders, references, work orders or ids (T00 scan)', () => {
    expect(seenByB.length).toBeGreaterThan(30)
    // The bulk frame echoes each id the caller asked, exactly as for an unknown id (asserted above): the caller's own word.
    const asked = (entry: Seen) => (entry.url.startsWith('POST /views/bulk/') ? JSON.parse(JSON.stringify(entry.body).replaceAll(w.a.workOrderId, '<asked>').replaceAll(w.mixed.workOrderId, '<asked>')) : entry.body)
    const found = seenByB.flatMap((entry) => findMarkers(asked(entry), aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})

describe('symmetric: a person limited to customer A (office.p1)', { timeout: 60_000 }, () => {
  it('sees A’s work order, never B’s nor the mixed one', async () => {
    const listed = await listIds('office.p1')
    expect(listed).toContain(w.a.workOrderId)
    expect(listed).not.toContain(w.b.workOrderId)
    expect(listed).not.toContain(w.mixed.workOrderId)
    expect((await call('office.p1', 'GET', `/production/work-orders/${w.b.workOrderId}`)).status).toBe(404)
    expect((await call('office.p1', 'GET', `/production/work-orders/${w.mixed.workOrderId}`)).status).toBe(404)
    expect((await ok('office.p1', 'GET', `/production/work-orders/${w.a.workOrderId}`)).workOrder.customer).toMatchObject({ id: w.a.partyId })
  })
})

// ── B-SA-074 (sales page plan N7, N8, R9; review OW-4): the work orders' small pictures in ONE read ─────────────────────────────────
/**
 * POST /production/work-orders/pictures {workOrderIds 1–200} through the office's one picture helper (product/images/small-pictures.ts):
 * each work order's ONE style and its main picture, walled exactly as the list above — A's work order and the mixed one made before
 * the rule are simply absent for B's person, as an unknown id (the same words, no count); the production unit reads all of them.
 * The pictures (made-up rows, the files seed's bench photo copied): our own jacket (A's, B's and the mixed work order make it) and
 * A's private-label jacket of the seeds' SEED-WO-0001. The readers hold files.read beside the work-order rights (a picture's file);
 * without it the style stays, never its file.
 */
describe('B-SA-074 — the work orders’ pictures: absent for every work order the reader does not reach', { timeout: 60_000 }, () => {
  const pictureSessions = twoBrandSessions(ids.tenantId, ids.a, ids.b, [...PERMISSIONS, 'files.read'])
  SESSIONS['pictures.all'] = pictureSessions['office.all']
  SESSIONS['pictures.p1'] = pictureSessions['office.p1']
  SESSIONS['pictures.p2'] = pictureSessions['office.p2']
  SESSIONS['partner.b'] = { audience: 'partner', tenantId: ids.tenantId, actorId: newId(), partyId: ids.b, grants: [{ permissions: [...PERMISSIONS, 'files.read'], companies: 'all', sites: 'all', parties: [ids.b] }] } as unknown as SessionContext
  const files = { own: newId(), alpha: newId() }
  let seeded = { workOrderId: '', styleId: '', styleCode: '' }
  const lit = (value: string): string => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`not an id: ${value}`)
    return `'${value}'`
  }
  const pictures = async (session: string, workOrderIds: readonly string[]): Promise<Json[]> => {
    const answer = await ok(session, 'POST', '/production/work-orders/pictures', { workOrderIds })
    expect(Date.parse(answer.asOf as string)).not.toBeNaN()
    return answer.pictures as Json[]
  }

  beforeAll(async () => {
    const row = (await admin<{ id: string; styleId: string; code: string }>(`SELECT w.id, w."styleId", s.code FROM "WorkOrder" w JOIN "Style" s ON s.id = w."styleId" WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0001'`, [w.tenantId]))[0]!
    seeded = { workOrderId: row.id, styleId: row.styleId, styleCode: row.code }
    const source = (await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND status = 'AVAILABLE' AND "contentType" = 'image/jpeg' ORDER BY id LIMIT 1`, [w.tenantId]))[0]!.id
    // A style's main picture: the bench photo's row copied onto the style (its bytes are never read here: no small preview yet).
    const picture = (fileId: string, styleId: string, name: string) => `
      INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', ${lit(fileId)}, 'recordType', 'Style', 'recordId', ${lit(styleId)}, 'originalName', '${name}', 'storageKey', f."storageKey" || '-' || ${lit(fileId)}, 'visibility', jsonb_build_array('OFFICE'), 'floorSiteId', NULL, 'partyId', NULL, 'thumbnailKey', NULL))).* FROM "StoredFile" f WHERE f.id = ${lit(source)};
      INSERT INTO "StyleImage" (id, "tenantId", "styleId", "fileId", kind, seq, "isMain") VALUES (${lit(newId())}, ${lit(w.tenantId)}, ${lit(styleId)}, ${lit(fileId)}, 'PHOTO', 0, true);`
    await db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${picture(files.own, w.styleId, 'Made-up own jacket.jpg')} ${picture(files.alpha, seeded.styleId, 'Made-up private jacket.jpg')} COMMIT;`)
  })

  it('the production unit reads every work order’s style picture, the mixed one too, in the asked order; an unknown id is absent', async () => {
    const asked = [w.b.workOrderId, seeded.workOrderId, w.mixed.workOrderId, newId(), w.a.workOrderId]
    const answer = await pictures('pictures.all', asked)
    expect(answer.map((picture) => picture.id)).toEqual([w.b.workOrderId, seeded.workOrderId, w.mixed.workOrderId, w.a.workOrderId])
    const of = (id: string) => answer.find((picture) => picture.id === id)!
    for (const id of [w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId]) expect(of(id)).toMatchObject({ styleId: w.styleId, styleCode: OWN_STYLE_CODE, styleCount: 1, fileId: files.own, contentType: 'image/jpeg', small: null })
    expect(of(seeded.workOrderId)).toMatchObject({ styleId: seeded.styleId, styleCode: seeded.styleCode, styleCount: 1, fileId: files.alpha, small: null })
    // The one shape of the office's picture part (the sales lists' too).
    expect(Object.keys(of(w.b.workOrderId)).sort()).toEqual(['contentType', 'fileId', 'id', 'small', 'styleCode', 'styleCount', 'styleId', 'styleName'])
  })

  it('B’s person: only B’s work order; A’s, the seeds’ A work order and the mixed one answer as an unknown id — nothing of A', async () => {
    const asked = [w.a.workOrderId, seeded.workOrderId, w.mixed.workOrderId, w.b.workOrderId, newId()]
    const answer = await pictures('pictures.p2', asked)
    expect(answer.map((picture) => picture.id)).toEqual([w.b.workOrderId])
    expect(answer[0]).toMatchObject({ styleCode: OWN_STYLE_CODE, fileId: files.own })
    const text = JSON.stringify(answer)
    for (const other of [w.a.workOrderId, seeded.workOrderId, w.mixed.workOrderId, w.mixed.number, seeded.styleId, seeded.styleCode, files.alpha]) expect(text, other).not.toContain(other)
    expect(findMarkers(answer, aMarkers)).toEqual([])
    // Word for word: A's id, the mixed one and an unknown one get the same answer (the time aside) — no count, no error.
    const words = async (workOrderIds: string[]) => ({ ...(await ok('pictures.p2', 'POST', '/production/work-orders/pictures', { workOrderIds })), asOf: '<time>' })
    const unknown = await words([newId()])
    expect(unknown).toEqual({ pictures: [], asOf: '<time>' })
    expect(await words([w.a.workOrderId])).toEqual(unknown)
    expect(await words([w.mixed.workOrderId])).toEqual(unknown)
    expect(await words([seeded.workOrderId])).toEqual(unknown)
  })

  it('symmetric: A’s person gets A’s work orders with A’s own picture, never B’s nor the mixed one', async () => {
    const answer = await pictures('pictures.p1', [w.b.workOrderId, w.mixed.workOrderId, w.a.workOrderId, seeded.workOrderId])
    expect(answer.map((picture) => picture.id)).toEqual([w.a.workOrderId, seeded.workOrderId])
    expect(answer[1]).toMatchObject({ styleCode: seeded.styleCode, fileId: files.alpha })
    expect(JSON.stringify(answer)).not.toContain(w.b.workOrderId)
    expect(JSON.stringify(answer)).not.toContain(w.mixed.workOrderId)
  })

  it('without files.read: the style of the reader’s own work order, never its file or an address', async () => {
    const answer = await pictures('office.p2', [w.b.workOrderId, w.a.workOrderId])
    expect(answer).toEqual([{ id: w.b.workOrderId, styleId: w.styleId, styleCode: OWN_STYLE_CODE, styleName: expect.any(String), styleCount: 1, fileId: null, contentType: null, small: null }])
  })

  it('the ids: 1–200, each once, uuids (400 in words); office only — a portal person is refused by audience', async () => {
    expect((await pictures('pictures.all', [w.b.workOrderId, ...Array.from({ length: 199 }, () => newId())])).map((picture) => picture.id)).toEqual([w.b.workOrderId])
    for (const body of [{ workOrderIds: Array.from({ length: 201 }, () => newId()) }, { workOrderIds: [] }, { workOrderIds: ['not-an-id'] }, { orderIds: [w.b.workOrderId] }]) expect((await call('pictures.all', 'POST', '/production/work-orders/pictures', body)).status).toBe(400)
    const twice = await call('pictures.all', 'POST', '/production/work-orders/pictures', { workOrderIds: [w.b.workOrderId, w.b.workOrderId] })
    expect(twice.status).toBe(400)
    expect(twice.body.error.message).toBe('Each id once: the same record was asked twice.')
    expect((await call('partner.b', 'POST', '/production/work-orders/pictures', { workOrderIds: [w.b.workOrderId] })).status).toBe(403)
  })
})
// ── end B-SA-074
