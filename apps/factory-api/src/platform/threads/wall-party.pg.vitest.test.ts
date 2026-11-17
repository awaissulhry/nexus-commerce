import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedHolds, type HoldsSeed } from '../../../../../packages/factory-db/seed/holds'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import type { Log } from '../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { EVERY_PARTY_MARKER } from '../../modules/quality/wall'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, type Marker, type ProductionTwoBrands } from '../../modules/production/testing/two-brands'
import { fanOut } from '../notifications/fan-out'
import { systemContext } from '../outbox/system'
import { indexNewTenants, rebuildIndex, WALL_REREAD } from '../search/indexing'
import type { SearchIndexer } from '../search/indexer'
import { loadIndexers } from '../search/registry'
import { NOT_SHAREABLE_REFUSAL, resolveRecord } from './records'
import { ensureThread, writeMessage } from './threads'

/**
 * B-PR-08a part 2 (production plan §2 "office people limited to some brands get the same wall … in search, threads"; R-02, R-39;
 * wall test PW-05; threads lead T2 + T4, 2026-11-17; Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well.") on the local
 * stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security
 * and the one-customer guards are real), the core, files, production, numbering, reasons and holds seeds, and the production
 * two-brand harness (brand A = the seeds' P1, brand B = the threads' second brand, a work order each and a mixed one made before
 * the rule). Here also: holds through the real route (A's work order, B's, both, the mixed one), an NCR on A's work order and one
 * on the mixed one, a cut order cutting both brands' work orders, and three office PEOPLE of one role (every customer, limited to
 * A, limited to B) for mentions, owners and bells.
 *
 *   WALL PARTY   the WorkOrder, QualityHold and Nonconformance resolvers name the record's customer as a WALL party (several or none:
 *                every customer only), never as the share party: the thread row stays party-less, a portal reads it empty, a shared
 *                message is refused (409 refusal/NOT_SHAREABLE).
 *   OFFICE       a person limited to B neither reads, writes on, closes, is mentioned on, is chosen to answer, counts unread on, nor
 *                is told of A's work order, hold, NCR thread — nor of the mixed work order's or the hold of both (every customer
 *                only); always the answer an unknown record gets. A person limited to A reads A's; the factory reads all.
 *   SEARCH       the work order, cut order, inspection, hold, NCR and subcontract entries carry their customer, or everyParty for
 *                several or none; an office person limited to B finds no A work order, no two-brand cut order, no hold of both
 *                brands, no mixed work order, no message of A's work order thread. A tenant built before reads them again once.
 *
 * Every answer B's person got is scanned for A's names, codes, numbers and ids. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads/wall-party`.
 */

const ns = 'pr08-wall'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'home.view',
  'threads.read',
  'threads.post',
  'threads.manage',
  'files.read',
  'workorders.view',
  'workorders.manage',
  'quality.holds.view',
  'quality.holds.place',
  'quality.ncr.view',
  'quality.inspections.view',
  'production.cutting.view',
  'purchasing.view',
]
/** The office people of the wall (real users: a note's author, a mention, an owner and a bell need one). */
const PEOPLE = { all: newId(), p1: newId(), p2: newId() } as const
const grantOf = (permissions: readonly Permission[], parties: Grant['parties']): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })
const officeOf = (actorId: string, parties: Grant['parties']): SessionContext => ({ audience: 'office', tenantId: ids.tenantId, actorId, grants: [grantOf(PERMISSIONS, parties)] })
const SESSIONS: Record<string, SessionContext> = {
  'office.all': officeOf(PEOPLE.all, 'all'),
  'office.p1': officeOf(PEOPLE.p1, [ids.a]),
  'office.p2': officeOf(PEOPLE.p2, [ids.b]),
  'portal.p1': { audience: 'partner', tenantId: ids.tenantId, actorId: newId(), partyId: ids.a, grants: [grantOf(['threads.read', 'files.read'], 'all')] },
}
const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} }
/** The name of the harness's jacket of our own collection, which both brands' work orders make (their entries' title). */
const OWN_STYLE_NAME = 'Our own production jacket'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let holdsSeed: HoldsSeed
let indexers: readonly SearchIndexer[]
/** A's (and several customers') records: B must never meet them. */
const rows = { holdA: '', holdB: '', holdBoth: '', holdMixed: '', ncrA: '', ncrMixed: '', cutOrder: '', cutOrderNumber: 'T-PR08-CUT-AB' }
let aMarkers: Marker[]

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const seenByB: { url: string; status: number; body: unknown }[] = []
let keys = 0
async function call(session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `pr08-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, status: response.statusCode, body: Object.keys(body).length > 0 ? withoutEcho(url, body) : response.body })
  return { status: response.statusCode, body, raw: response.body }
}
/** An answer less what only repeats the caller's own request (the query a search answers, the records unread counts were asked for). */
function withoutEcho(url: string, body: Json): unknown {
  if (url.startsWith('/search')) return { results: body.results, counts: body.counts, total: body.total }
  if (url === '/threads/unread') return (body.counts as Json[] | undefined)?.map((row) => ({ newCount: row.newCount, lastAt: row.lastAt })) ?? body
  return body
}
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${session} ${method} ${url}: ${answer.raw}`).toBe(status)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const note = (session: string, type: string, id: string, body: string, mentions: string[] = [], status = 201) => ok(session, 'POST', `/threads/${type}/${id}/notes`, { body, mentions }, status)
const system = () => callerFor(database, systemContext(w.tenantId, `pr08-${newId()}`))
const search = async (session: string, q: string, type?: string): Promise<Json[]> =>
  (await ok(session, 'GET', `/search?q=${encodeURIComponent(q)}&limit=50${type ? `&type=${type}` : ''}`)).results as Json[]
const found = (results: readonly Json[]) => results.map((row) => `${row.recordType}:${row.recordId}`)

/** The worker's fan-out of the thread events since `since` (oldest first). */
async function fanOutSince(since: Date, override?: (payload: Json) => Json): Promise<void> {
  const events = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [w.tenantId, ['thread.user_mentioned', 'thread.message_posted'], since])
  for (const row of events) {
    const payload = override ? override(row.payload) : row.payload
    const envelope = { eventId: override ? newId() : row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload }
    await fanOut(callerFor(database, systemContext(w.tenantId, `pr08-fan-${row.id}`)), envelope)
  }
}
const bells = async (userId: string, recordId: string) => (await admin<{ category: string }>(`SELECT category FROM "Notification" WHERE "userId" = $1 AND "recordId" = $2 ORDER BY category`, [userId, recordId])).map((row) => row.category)

beforeAll(async () => {
  db = await migratedDatabase('pr08_wall_party')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  holdsSeed = await seedHolds({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])

  // Three office people of one made-up role: every customer, limited to A, limited to B (RoleAssignment.partyIds).
  const roleId = newId()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience, permissions) VALUES ($1, $2, 'custom.pr08_wall', 'Made-up production office', 'OFFICE', $3)`, [roleId, w.tenantId, PERMISSIONS])
  for (const [key, userId, parties] of [['all', PEOPLE.all, []], ['p1', PEOPLE.p1, [w.a.partyId]], ['p2', PEOPLE.p2, [w.b.partyId]]] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [userId, w.tenantId, `pr08-${key}@example.com`, `Made-up office ${key}`, 'ACTIVE'])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5, $6)', [newId(), w.tenantId, userId, roleId, parties, new Date('2026-01-01T00:00:00.000Z')])
  }

  // Holds through the real route: A's work order, B's, both (several customers), the mixed one (no customer).
  const place = async (subjectIds: string[]) => (await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds, reasonCode: 'QUALITY_CHECK' }, 201)).hold.id as string
  rows.holdA = await place([w.a.workOrderId])
  rows.holdB = await place([w.b.workOrderId])
  rows.holdBoth = await place([w.a.workOrderId, w.b.workOrderId])
  rows.holdMixed = await place([w.mixed.workOrderId])
  // An NCR on A's work order and one on the mixed work order (SEED-NCR-0001 copied), and a cut order cutting a cell of A's work
  // order and one of B's (the database's rules off for these statements, as the harness does).
  rows.ncrA = newId()
  rows.ncrMixed = newId()
  rows.cutOrder = newId()
  const ncr = (id: string, number: string, workOrderId: string) =>
    `INSERT INTO "Nonconformance" SELECT (jsonb_populate_record(NULL::"Nonconformance", to_jsonb(n) || jsonb_build_object('id', ${sql(id)}, 'number', '${number}', 'title', 'Made-up seam check', 'workOrderId', ${sql(workOrderId)}, 'styleId', ${sql(w.styleId)}, 'colourwayId', NULL, 'sourceType', NULL, 'sourceId', NULL))).* FROM "Nonconformance" n WHERE n.id = ${sql(holdsSeed.openNcrId)};`
  const item = (await admin<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 ORDER BY code LIMIT 1`, [w.tenantId]))[0]!.id
  const cell = async (workOrderId: string) => (await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY size LIMIT 1`, [workOrderId]))[0]!.id
  const line = (seq: number, workOrderId: string, cellId: string) =>
    `INSERT INTO "CutOrderLine" (id, "tenantId", "siteId", "cutOrderId", seq, "workOrderId", "workOrderSizeId", quantity) VALUES (${sql(newId())}, ${sql(w.tenantId)}, ${sql(w.siteId)}, ${sql(rows.cutOrder)}, ${seq}, ${sql(workOrderId)}, ${sql(cellId)}, 1);`
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     ${ncr(rows.ncrA, 'T-PR08-NCR-A', w.a.workOrderId)}
     ${ncr(rows.ncrMixed, 'T-PR08-NCR-MIX', w.mixed.workOrderId)}
     INSERT INTO "CutOrder" (id, "tenantId", "companyId", "siteId", number, kind, "itemId", status) VALUES (${sql(rows.cutOrder)}, ${sql(w.tenantId)}, ${sql(w.companyId)}, ${sql(w.siteId)}, '${rows.cutOrderNumber}', 'FABRIC', ${sql(item)}, 'PLANNED');
     ${line(1, w.a.workOrderId, await cell(w.a.workOrderId))}
     ${line(2, w.b.workOrderId, await cell(w.b.workOrderId))}
     COMMIT;`,
  )
  // A note on each thread through the route (the factory writes everywhere), one naming words only A's thread holds.
  for (const [type, id] of [['WorkOrder', w.a.workOrderId], ['WorkOrder', w.b.workOrderId], ['WorkOrder', w.mixed.workOrderId], ['QualityHold', rows.holdA], ['QualityHold', rows.holdBoth], ['Nonconformance', rows.ncrA]] as const) {
    await note('office.all', type, id, type === 'WorkOrder' && id === w.a.workOrderId ? 'Alphaseam lining question for the cutting room' : 'Made-up internal note')
  }
  indexers = await loadIndexers(fileURLToPath(new URL('../..', import.meta.url)))
  await rebuildIndex(system(), indexers, { recordTypes: null, key: `pr08-rebuild-${newId()}` })

  const numbers = await admin<{ text: string }>(
    `SELECT number AS text FROM "QualityHold" WHERE id IN ($1, $2, $3) AND number IS NOT NULL
     UNION ALL SELECT id::text FROM "QualityHold" WHERE id IN ($1, $2, $3)
     UNION ALL SELECT number FROM "Nonconformance" WHERE id IN ($4, $5)
     UNION ALL SELECT id::text FROM "Nonconformance" WHERE id IN ($4, $5)`,
    [rows.holdA, rows.holdBoth, rows.holdMixed, rows.ncrA, rows.ncrMixed],
  )
  aMarkers = [
    ...(await markersOf(db, w.a.partyId)),
    { label: 'mixed work order', text: w.mixed.number },
    { label: 'mixed work order', text: w.mixed.workOrderId },
    { label: 'cut order of both', text: rows.cutOrderNumber },
    { label: 'cut order of both', text: rows.cutOrder },
    { label: "A's thread words", text: 'Alphaseam' },
    ...numbers.map((row) => ({ label: 'quality record of A', text: row.text })),
  ]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-08a part 2: the wall party of a work order, hold and NCR (never a share party)', { timeout: 60_000 }, () => {
  it("each resolver names the record's customer as its WALL party (several or none: every customer only); the share party stays none", async () => {
    const scopeOf = (type: string, id: string) => system().withClient((client) => resolveRecord(client, type, id))
    const wall = async (type: string, id: string) => {
      const scope = await scopeOf(type, id)
      expect(scope?.partyId, `${type} ${id}`).toBeNull()
      return scope?.wallPartyId
    }
    expect(await wall('WorkOrder', w.a.workOrderId)).toBe(w.a.partyId)
    expect(await wall('WorkOrder', w.b.workOrderId)).toBe(w.b.partyId)
    expect(await wall('WorkOrder', w.mixed.workOrderId)).toBe(EVERY_PARTY_MARKER)
    expect(await wall('QualityHold', rows.holdA)).toBe(w.a.partyId)
    expect(await wall('QualityHold', rows.holdBoth)).toBe(EVERY_PARTY_MARKER)
    expect(await wall('QualityHold', rows.holdMixed)).toBe(EVERY_PARTY_MARKER)
    // A hide's hold names no customer: its company and site only.
    expect(await wall('QualityHold', holdsSeed.holdId)).toBeNull()
    expect(await wall('Nonconformance', rows.ncrA)).toBe(w.a.partyId)
    expect(await wall('Nonconformance', rows.ncrMixed)).toBe(EVERY_PARTY_MARKER)
    // Every thread made by the notes above stays party-less.
    expect(await admin(`SELECT "recordType", "partyId" FROM "Thread" WHERE "recordId" = ANY($1) AND "partyId" IS NOT NULL`, [[w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId, rows.holdA, rows.holdBoth, rows.ncrA]])).toEqual([])
  })

  it("PW-05: the portal reads A's work order thread empty, also A's own; a shared message on it is refused in words (409)", async () => {
    expect(await ok('portal.p1', 'GET', `/threads/WorkOrder/${w.a.workOrderId}`)).toMatchObject({ thread: null, messages: [], nextCursor: null })
    let refused: unknown = null
    try {
      await command(callerFor(database, { ...SESSIONS['office.all']!, requestId: newId() } as never), { name: 'email.send', input: { recordType: 'WorkOrder', recordId: w.a.workOrderId } }, async (tools) => {
        const { thread } = await ensureThread(tools, { type: 'WorkOrder', id: w.a.workOrderId }, PEOPLE.all)
        await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: PEOPLE.all, name: 'Made-up office all' }, bodyText: 'Made-up words for the customer.' })
        return null
      })
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(DomainError)
    expect(refused).toMatchObject({ code: 'conflict', message: NOT_SHAREABLE_REFUSAL.en, issues: [{ path: 'refusal/NOT_SHAREABLE' }] })
    expect((await admin(`SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.audience = 'PARTNER'`, [w.a.workOrderId]))[0]!.n).toBe(0)
  })
})

describe('B-PR-08a part 2: an office person limited to B meets none of A’s production threads (PW-05)', { timeout: 60_000 }, () => {
  const walled = (): [string, string][] => [
    ['WorkOrder', w.a.workOrderId],
    ['WorkOrder', w.mixed.workOrderId],
    ['QualityHold', rows.holdA],
    ['QualityHold', rows.holdBoth],
    ['Nonconformance', rows.ncrA],
  ]

  it('reads, writes, closes and lists who to mention exactly as for an unknown record; its own work order and hold as before', async () => {
    for (const [type, id] of walled()) {
      const unknown = newId()
      for (const [method, path, payload] of [
        ['GET', '', undefined],
        ['GET', '/people', undefined],
        ['GET', '/timeline', undefined],
        ['POST', '/notes', { body: 'A made-up note from B' }],
      ] as const) {
        const theirs = await call('office.p2', method, `/threads/${type}/${id}${path}`, payload)
        const none = await call('office.p2', method, `/threads/${type}/${unknown}${path}`, payload)
        expect([theirs.status, none.status], `${type} ${method} ${path}: ${theirs.raw}`).toEqual([404, 404])
        expect(theirs.body.error?.message, `${type} ${path}`).toBe(none.body.error?.message)
      }
      const version = (await admin<{ version: number }>(`SELECT version FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2`, [type, id]))[0]!.version
      const close = await call('office.p2', 'PUT', `/threads/${type}/${id}/status`, { status: 'CLOSED', version })
      expect(close.status, close.raw).toBe(404)
      expect(close.body.error?.message).toBe('This record has no thread.')
      // Unread counts: A's thread counts nothing (as a record without a thread), though the factory wrote on it.
      expect((await ok('office.p2', 'POST', '/threads/unread', { records: [{ recordType: type, recordId: id }] })).counts).toEqual([{ recordType: type, recordId: id, newCount: 0, lastAt: null }])
    }
    // No note of B's got into any of them.
    expect(await admin(`SELECT m.id FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE m."authorId" = $1`, [PEOPLE.p2])).toEqual([])
    // B's own work order and hold: read, written, counted as before.
    expect((await ok('office.p2', 'GET', `/threads/WorkOrder/${w.b.workOrderId}`)).messages.length).toBe(1)
    await note('office.p2', 'WorkOrder', w.b.workOrderId, 'A made-up note from B on its own work order')
    await note('office.p2', 'QualityHold', rows.holdB, 'A made-up note from B on its own hold')
    expect((await ok('office.p2', 'POST', '/threads/unread', { records: [{ recordType: 'WorkOrder', recordId: w.b.workOrderId }] })).counts[0]).toMatchObject({ newCount: 1 })
    // The hide's hold names no customer: every office person of the site reads it.
    await note('office.p2', 'QualityHold', holdsSeed.holdId, 'A made-up note on the hide hold')
  })

  it('symmetric: A’s person reads A’s threads, not B’s nor the mixed one nor the hold of both; the factory reads them all', async () => {
    await ok('office.p1', 'GET', `/threads/WorkOrder/${w.a.workOrderId}`)
    await ok('office.p1', 'GET', `/threads/QualityHold/${rows.holdA}`)
    await ok('office.p1', 'GET', `/threads/Nonconformance/${rows.ncrA}`)
    for (const [type, id] of [['WorkOrder', w.b.workOrderId], ['WorkOrder', w.mixed.workOrderId], ['QualityHold', rows.holdBoth], ['QualityHold', rows.holdB]] as const) {
      expect((await call('office.p1', 'GET', `/threads/${type}/${id}`)).status, `${type} ${id}`).toBe(404)
    }
    for (const [type, id] of [...walled(), ['WorkOrder', w.b.workOrderId] as [string, string]]) expect((await ok('office.all', 'GET', `/threads/${type}/${id}`)).messages.length, `${type} ${id}`).toBeGreaterThan(0)
  })

  it('cannot be mentioned on A’s threads nor chosen to answer them, and is left out of who to mention; A’s person can', async () => {
    const refused = await call('office.all', 'POST', `/threads/WorkOrder/${w.a.workOrderId}/notes`, { body: 'Made-up question', mentions: [PEOPLE.p2] })
    expect(refused.status, refused.raw).toBe(400)
    expect(refused.body.error?.issues).toEqual([{ path: 'body/mentions/0', message: "This person cannot read this record's thread." }])
    const onBoth = await call('office.all', 'POST', `/threads/QualityHold/${rows.holdBoth}/notes`, { body: 'Made-up question', mentions: [PEOPLE.p1] })
    expect(onBoth.status, onBoth.raw).toBe(400)
    await note('office.all', 'WorkOrder', w.a.workOrderId, 'Made-up question for A', [PEOPLE.p1])
    const people = async (type: string, id: string) => ((await ok('office.all', 'GET', `/threads/${type}/${id}/people`)).people as Json[]).map((person) => person.id).filter((person) => Object.values(PEOPLE).includes(person)).sort()
    expect(await people('WorkOrder', w.a.workOrderId)).toEqual([PEOPLE.all, PEOPLE.p1].sort())
    expect(await people('WorkOrder', w.b.workOrderId)).toEqual([PEOPLE.all, PEOPLE.p2].sort())
    expect(await people('QualityHold', rows.holdBoth)).toEqual([PEOPLE.all])
    expect(await people('WorkOrder', w.mixed.workOrderId)).toEqual([PEOPLE.all])
    // Who answers the conversation: an office person who reaches its customer.
    const owner = await call('office.all', 'PUT', `/threads/WorkOrder/${w.a.workOrderId}/owner`, { ownerId: PEOPLE.p2 })
    expect(owner.status, owner.raw).toBe(400)
    await ok('office.all', 'PUT', `/threads/WorkOrder/${w.a.workOrderId}/owner`, { ownerId: PEOPLE.p1 })
  })

  it('is never told of A’s threads: no bell for a follow or a mention made before the rule; A’s person is told', async () => {
    const since = new Date()
    // Both follow A's work order (B's row made before the wall), then the factory writes a note on it.
    for (const userId of [PEOPLE.p1, PEOPLE.p2]) {
      await admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'WorkOrder', $3, $4, 'CHOSE') ON CONFLICT DO NOTHING`, [newId(), w.tenantId, w.a.workOrderId, userId])
    }
    await note('office.all', 'WorkOrder', w.a.workOrderId, 'Made-up news for the followers')
    await fanOutSince(since)
    expect(await bells(PEOPLE.p1, w.a.workOrderId)).toContain('FOLLOWING')
    expect(await bells(PEOPLE.p2, w.a.workOrderId)).toEqual([])
    // A mention of B on A's thread made before the rule (the event as it would have been written) tells B nothing.
    const mark = new Date()
    await note('office.all', 'WorkOrder', w.a.workOrderId, 'Made-up second question for A', [PEOPLE.p1])
    await fanOutSince(mark, (payload) => (payload.userId ? { ...payload, userId: PEOPLE.p2 } : payload))
    expect(await bells(PEOPLE.p2, w.a.workOrderId)).toEqual([])
  })
})

describe('B-PR-08a part 2: search honours the brand (R-39)', { timeout: 120_000 }, () => {
  it('each entry carries its customer, or everyParty for several or none (naming none of them)', async () => {
    const entry = async (type: string, id: string) => (await admin<{ partyId: string | null; everyParty: boolean }>(`SELECT "partyId", "everyParty" FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2`, [type, id]))[0]
    expect(await entry('WorkOrder', w.a.workOrderId)).toEqual({ partyId: w.a.partyId, everyParty: false })
    expect(await entry('WorkOrder', w.b.workOrderId)).toEqual({ partyId: w.b.partyId, everyParty: false })
    expect(await entry('WorkOrder', w.mixed.workOrderId)).toEqual({ partyId: null, everyParty: true })
    expect(await entry('CutOrder', rows.cutOrder)).toEqual({ partyId: null, everyParty: true })
    expect(await entry('QualityHold', rows.holdA)).toEqual({ partyId: w.a.partyId, everyParty: false })
    expect(await entry('QualityHold', rows.holdBoth)).toEqual({ partyId: null, everyParty: true })
    expect(await entry('QualityHold', holdsSeed.holdId)).toEqual({ partyId: null, everyParty: false })
    expect(await entry('Nonconformance', rows.ncrA)).toEqual({ partyId: w.a.partyId, everyParty: false })
    expect(await entry('Nonconformance', rows.ncrMixed)).toEqual({ partyId: null, everyParty: true })
    // A's work order thread's messages are A's (the thread itself stays party-less).
    const messages = await admin<{ partyId: string | null; everyParty: boolean }>(
      `SELECT e."partyId", e."everyParty" FROM "SearchEntry" e JOIN "Message" m ON m.id = e."recordId" JOIN "Thread" t ON t.id = m."threadId" WHERE e."recordType" = 'Message' AND t."recordId" = $1`,
      [w.a.workOrderId],
    )
    expect(messages.length).toBeGreaterThan(0)
    for (const row of messages) expect(row).toEqual({ partyId: w.a.partyId, everyParty: false })
  })

  it("office.p2 finds no A work order, no two-brand cut order, no hold of both brands, no mixed work order, no A message; finds B's own", async () => {
    const theirs = [`WorkOrder:${w.a.workOrderId}`, `WorkOrder:${w.mixed.workOrderId}`, `CutOrder:${rows.cutOrder}`, `QualityHold:${rows.holdA}`, `QualityHold:${rows.holdBoth}`, `QualityHold:${rows.holdMixed}`, `Nonconformance:${rows.ncrA}`, `Nonconformance:${rows.ncrMixed}`]
    const holdNumbers = await admin<{ id: string; number: string }>(`SELECT id, number FROM "QualityHold" WHERE id IN ($1, $2, $3, $4)`, [rows.holdA, rows.holdB, rows.holdBoth, rows.holdMixed])
    const queries = [w.a.workOrderNumber, w.mixed.number, rows.cutOrderNumber, 'T-PR08-NCR', ...holdNumbers.flatMap((row) => (row.number ? [row.number] : [])), OWN_STYLE_NAME]
    for (const q of queries) expect(found(await search('office.p2', q)).filter((hit) => theirs.includes(hit)), q).toEqual([])
    expect(found(await search('office.p2', 'Alphaseam', 'Message'))).toEqual([])
    // B's own: its work order, its hold.
    expect(found(await search('office.p2', w.b.workOrderNumber))).toContain(`WorkOrder:${w.b.workOrderId}`)
    const holdB = holdNumbers.find((row) => row.id === rows.holdB)!.number
    expect(holdB).toBeTruthy()
    expect(found(await search('office.p2', holdB))).toContain(`QualityHold:${rows.holdB}`)
    // Both brands' work orders make our own collection's jacket: B finds its own by the style's name, never A's or the mixed one.
    expect(found(await search('office.p2', OWN_STYLE_NAME))).toContain(`WorkOrder:${w.b.workOrderId}`)
  })

  it('A’s person finds A’s own, never what mixes customers; the factory finds it all', async () => {
    expect(found(await search('office.p1', w.a.workOrderNumber))).toContain(`WorkOrder:${w.a.workOrderId}`)
    expect(found(await search('office.p1', 'Alphaseam', 'Message')).length).toBe(1)
    expect(found(await search('office.p1', rows.cutOrderNumber))).not.toContain(`CutOrder:${rows.cutOrder}`)
    expect(found(await search('office.p1', w.mixed.number))).not.toContain(`WorkOrder:${w.mixed.workOrderId}`)
    expect(found(await search('office.all', w.a.workOrderNumber))).toContain(`WorkOrder:${w.a.workOrderId}`)
    expect(found(await search('office.all', w.mixed.number))).toContain(`WorkOrder:${w.mixed.workOrderId}`)
    expect(found(await search('office.all', rows.cutOrderNumber))).toContain(`CutOrder:${rows.cutOrder}`)
    expect(found(await search('office.all', 'Alphaseam', 'Message')).length).toBe(1)
  })

  it('a tenant whose index was built before these entries carried their customer reads them again, once, at the worker’s start', async () => {
    const stale = async () => admin(`UPDATE "SearchEntry" SET "partyId" = NULL, "everyParty" = false WHERE "recordType" IN ('WorkOrder', 'CutOrder') AND "recordId" IN ($1, $2)`, [w.a.workOrderId, rows.cutOrder])
    const entry = async (type: string, id: string) => (await admin<{ partyId: string | null; everyParty: boolean }>(`SELECT "partyId", "everyParty" FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2`, [type, id]))[0]
    await stale()
    expect(await indexNewTenants({ database, indexers, log: quiet })).toMatchObject({ indexed: 0, failed: 0 })
    expect(await entry('WorkOrder', w.a.workOrderId)).toEqual({ partyId: w.a.partyId, everyParty: false })
    expect(await entry('CutOrder', rows.cutOrder)).toEqual({ partyId: null, everyParty: true })
    const marked = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'search.rebuild' AND "idempotencyKey" LIKE $1`, [`${WALL_REREAD.key}-%`])
    expect(marked[0]!.n).toBeGreaterThan(0)
    // Once: a later start reads nothing again (what an event or a rebuild changes since is theirs to keep).
    await stale()
    await indexNewTenants({ database, indexers, log: quiet })
    expect(await entry('WorkOrder', w.a.workOrderId)).toEqual({ partyId: null, everyParty: false })
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'search.rebuild' AND "idempotencyKey" LIKE $1`, [`${WALL_REREAD.key}-%`]))[0]!.n).toBe(marked[0]!.n)
    await rebuildIndex(system(), indexers, { recordTypes: ['WorkOrder', 'CutOrder'], key: `pr08-mend-${newId()}` })
    expect(await entry('WorkOrder', w.a.workOrderId)).toEqual({ partyId: w.a.partyId, everyParty: false })
  })
})

describe('T00: nothing of A in any answer B’s person got', () => {
  it('scans every answer office.p2 got for A’s names, codes, numbers, ids and thread words', () => {
    expect(seenByB.length).toBeGreaterThan(20)
    const hits = seenByB.flatMap((seen) => findMarkers(seen.body, aMarkers).map((marker) => `${seen.url} → ${marker}`))
    expect(hits).toEqual([])
  })
})
