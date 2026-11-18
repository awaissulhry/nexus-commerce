import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { CUSTOMER_FEED_TYPES, NEVER_IN_CUSTOMER_FEED } from '@nexus/factory-domain/sales/customer-feed/kinds'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedHolds, type HoldsSeed } from '../../../../../../packages/factory-db/seed/holds'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { ensureThread, writeMessage, type MessageInput } from '../../../platform/threads/threads'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, type Marker, type ProductionTwoBrands } from '../../production/testing/two-brands'

/**
 * B-SA-060 (sales page plan R4, P9'; 13-backend B8; review C-1, BW-4, F-6; the Owner's rule 2026-11-16: "One brand must not be able
 * to see anything related to any other brand. But we, as the production unit, should be able to see it all.") — "All of
 * <Customer>", GET /sales/customers/:partyId/feed, on the local stack with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security is real), the core, files, production, numbering, reasons and holds
 * seeds and the production two-brand harness (Brand Alpha = the seeds' P1, Brand Beta = the threads' second brand, a work order each
 * and a mixed one made before the rule). Here also:
 *
 *   Alpha's conversations   its general conversation (Party), its two orders (the harness's and SEED-SO-0002): the customer's
 *                           messages, ours, office notes, a floor note, a message erased after a privacy request, a mail taken back
 *                           (held), a note written by the Alpha-limited reader, and a rider's measurements (behind their gate)
 *   never in it             notes on Alpha's work order, the mixed one, a hold of Alpha's, a hold of both brands, an NCR — through
 *                           the real route — and threads of a change request, a purchase order and a hold wrongly filed under Alpha
 *                           (rows past the guards: the feed reads by type, fails closed)
 *   Brand Beta              its order's and general conversation, and a project of Beta's that links Alpha's order (a row past the
 *                           project-link guard: the case 13-backend B8 names)
 *
 *   MERGE    one list newest first across the threads, exactly the messages of Alpha's customer-side threads (held ones out), the
 *            same in pages of 3 as in one page, no gap, no repeat; the views and the kinds narrow it.
 *   WALL     a person limited to Brand Beta asking for Alpha gets 404 "Customer not found." — word for word an unknown customer's; an
 *            every-customer reader of Alpha never meets a Beta thread (not even Beta's project that links Alpha's order); no work-order,
 *            hold or NCR note ever appears; a floor note says "From the floor", never a name; every answer Beta's person got names
 *            nothing of Alpha (the markers scan).
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/customer-feed`.
 */

const ns = 'sa060-feed'
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
/** all: every customer · p1: limited to Brand Alpha · p2: limited to Brand Beta · measure: every customer and a rider's measurements. */
const PEOPLE = { all: newId(), p1: newId(), p2: newId(), measure: newId() } as const
const grantOf = (permissions: readonly Permission[], parties: Grant['parties']): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })
const officeOf = (actorId: string, parties: Grant['parties'], more: readonly Permission[] = []): SessionContext => ({ audience: 'office', tenantId: ids.tenantId, actorId, grants: [grantOf([...PERMISSIONS, ...more], parties)] })
const SESSIONS: Record<string, SessionContext> = {
  'office.all': officeOf(PEOPLE.all, 'all'),
  'office.p1': officeOf(PEOPLE.p1, [ids.a]),
  'office.p2': officeOf(PEOPLE.p2, [ids.b]),
  'office.measure': officeOf(PEOPLE.measure, 'all', ['sales.measurements.view']),
}

/** Fixed instants of the made-up conversations (before anything the harness writes "now"). */
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0)
const at = (minute: number) => new Date(T0 + minute * 60_000)
const FLOOR_NAME = 'Madeup Floorperson'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let holdsSeed: HoldsSeed
let aMarkers: Marker[]
/** Alpha's made-up messages by name; Beta's and the internal records' message ids. */
const m: Record<string, string> = {}
const betaMessages: string[] = []
const internalMessages: string[] = []
const rows = { so2: '', holdA: '', holdBoth: '', ncrA: '', projectB: '', measurementThread: '', measurementMessage: '' }

type Json = Record<string, any>
const seenByB: { url: string; status: number; body: unknown }[] = []
let keys = 0
async function call(session: string, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `sa060-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push({ url: `${method} ${url}`, status: response.statusCode, body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${session} ${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(status)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const feedUrl = (partyId: string, query = '') => `/sales/customers/${partyId}/feed${query ? `?${query}` : ''}`

/** Every page of a feed, following nextCursor as the screen does. */
async function everyPage(session: string, partyId: string, query: string): Promise<{ pages: Json[]; entries: Json[] }> {
  const pages: Json[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 200; guard++) {
    const page = await ok(session, 'GET', feedUrl(partyId, [query, cursor ? `cursor=${encodeURIComponent(cursor)}` : ''].filter(Boolean).join('&')))
    pages.push(page)
    cursor = page.nextCursor
    if (!cursor) return { pages, entries: pages.flatMap((one) => one.entries as Json[]) }
  }
  throw new Error('the feed never ended')
}
const messageIds = (entries: readonly Json[]) => entries.map((entry) => entry.message.id as string)

/** Writes messages into a record's thread in one command of the office (the thread made from its record, as the app does). */
async function writeOn(record: { type: string; id: string }, messages: readonly (MessageInput & { name?: string })[]): Promise<string[]> {
  const office = callerFor(database, { audience: 'office', tenantId: w.tenantId, actorId: PEOPLE.all, grants: [], requestId: newId() })
  const { result } = await command(office, { name: 'threads.post', input: { record, n: messages.length } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, PEOPLE.all)
    const written: string[] = []
    for (const message of messages) written.push((await writeMessage(tools, thread, message)).id)
    return written
  })
  messages.forEach((message, index) => {
    if (message.name) m[message.name] = result[index]!
  })
  return result
}
const staff = { kind: 'USER' as const, id: PEOPLE.all, name: 'Madeup Officeperson' }
const buyer = { kind: 'PARTY' as const, id: null, name: 'Madeup Buyer' }

/** A thread and one message straight into the tables (the guards off for these rows, as the harness does). */
async function rawThread(recordType: string, partyId: string | null, companyId: string | null, message: { at: Date; body: string }): Promise<{ threadId: string; messageId: string }> {
  const threadId = newId()
  const messageId = newId()
  const token = randomBytes(16).toString('hex').replace(/[^a-z2-7]/g, 'a').slice(0, 26).padEnd(26, 'q')
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Thread" (id, "tenantId", "companyId", "partyId", "recordType", "recordId", "replyToken", "lastMessageAt", "createdAt", "updatedAt")
       VALUES (${sql(threadId)}, ${sql(w.tenantId)}, ${companyId ? sql(companyId) : 'NULL'}, ${partyId ? sql(partyId) : 'NULL'}, '${recordType}', ${sql(newId())}, '${token}', '${message.at.toISOString()}', '${message.at.toISOString()}', '${message.at.toISOString()}');
     INSERT INTO "Message" (id, "tenantId", "threadId", direction, audience, channel, "authorKind", "authorId", "authorName", "bodyText", at, "createdAt")
       VALUES (${sql(messageId)}, ${sql(w.tenantId)}, ${sql(threadId)}, 'INTERNAL_NOTE', 'OFFICE', 'APP', 'USER', ${sql(PEOPLE.all)}, 'Madeup Officeperson', '${message.body}', '${message.at.toISOString()}', '${message.at.toISOString()}');
     COMMIT;`,
  )
  return { threadId, messageId }
}

beforeAll(async () => {
  db = await migratedDatabase('sa060_customer_feed')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  holdsSeed = await seedHolds({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])
  rows.so2 = seedUuid(ns, 'production:sales-order:SO-0002')
  for (const [key, userId] of Object.entries(PEOPLE)) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [userId, w.tenantId, `sa060-${key}@example.com`, `Madeup office ${key}`, 'ACTIVE'])
  }

  // ---- never in the feed: the internal records' notes through the real route (the factory writes everywhere) -----------------
  const place = async (subjectIds: string[]) => (await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds, reasonCode: 'QUALITY_CHECK' }, 201)).hold.id as string
  rows.holdA = await place([w.a.workOrderId])
  rows.holdBoth = await place([w.a.workOrderId, w.b.workOrderId])
  rows.ncrA = newId()
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Nonconformance" SELECT (jsonb_populate_record(NULL::"Nonconformance", to_jsonb(n) || jsonb_build_object('id', ${sql(rows.ncrA)}, 'number', 'T-SA060-NCR-A', 'title', 'Madeup seam check', 'workOrderId', ${sql(w.a.workOrderId)}, 'styleId', ${sql(w.styleId)}, 'colourwayId', NULL, 'sourceType', NULL, 'sourceId', NULL))).* FROM "Nonconformance" n WHERE n.id = ${sql(holdsSeed.openNcrId)};
     COMMIT;`,
  )
  for (const [type, id] of [['WorkOrder', w.a.workOrderId], ['WorkOrder', w.mixed.workOrderId], ['QualityHold', rows.holdA], ['QualityHold', rows.holdBoth], ['Nonconformance', rows.ncrA]] as const) {
    const posted = await ok('office.all', 'POST', `/threads/${type}/${id}/notes`, { body: `Alphaseam internal note on the ${type}`, mentions: [] }, 201)
    internalMessages.push(posted.message.id as string)
  }
  // Threads of types the feed never reads, wrongly filed under Alpha (rows past the guards): read by type, so never listed.
  for (const [index, type] of ['OrderChangeRequest', 'PurchaseOrder', 'QualityHold', 'WorkOrder'].entries()) {
    internalMessages.push((await rawThread(type, w.a.partyId, w.companyId, { at: at(90 + index), body: `Alphaseam filed under ${type}` })).messageId)
  }

  // ---- Alpha's conversations ------------------------------------------------------------------------------------------------
  await writeOn({ type: 'Party', id: w.a.partyId }, [
    { name: 'p1', direction: 'INBOUND', channel: 'PORTAL', author: buyer, bodyText: 'Alpha general: a question about the new season', at: at(5) },
    { name: 'p2', direction: 'INTERNAL_NOTE', channel: 'APP', author: staff, bodyText: 'Office note on the general conversation', at: at(25) },
    { name: 'p3', direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'Madeup Rider' }, bodyText: 'Madeup: my home address is …', at: at(45) },
  ])
  await writeOn({ type: 'SalesOrder', id: w.a.salesOrderId }, [
    { name: 'o1', direction: 'OUTBOUND', channel: 'EMAIL', author: staff, bodyText: 'Your order ships next week', at: at(10) },
    { name: 'o2', direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'WORKER', id: newId(), name: FLOOR_NAME }, bodyText: 'From the cutting table: seam check done', at: at(30) },
    { name: 'o3', direction: 'OUTBOUND', channel: 'EMAIL', author: staff, bodyText: 'A mail taken back in its 10 seconds', at: at(50) },
    { name: 'o4', direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: PEOPLE.p1, name: 'Madeup office p1' }, bodyText: 'My own note on this order', at: at(55) },
  ])
  await writeOn({ type: 'SalesOrder', id: rows.so2 }, [
    { name: 's1', direction: 'INBOUND', channel: 'PORTAL', author: buyer, bodyText: 'A question on the second order', at: at(15) },
    // The same instant as p2 in another thread: the id decides, never lost at a page edge.
    { name: 's3', direction: 'INBOUND', channel: 'PORTAL', author: buyer, bodyText: 'Another question at the same minute', at: at(25) },
    { name: 's2', direction: 'OUTBOUND', channel: 'PORTAL', author: staff, bodyText: 'Our answer on the second order', at: at(35) },
  ])
  // p3 erased after a privacy request (the erasure blanks the name and the words; its record names it); o3 taken back (held).
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     UPDATE "Message" SET "authorName" = NULL, "bodyText" = '', "bodyHtml" = NULL WHERE id = ${sql(m.p3!)};
     INSERT INTO "ErasureRecord" (id, "tenantId", "companyId", "sweepId", "recordType", "recordId", method, "erasedFields", "keptFields", "erasedAt")
       VALUES (${sql(newId())}, ${sql(w.tenantId)}, ${sql(w.companyId)}, ${sql(newId())}, 'Message', ${sql(m.p3!)}, 'ANONYMISED', '{authorName,bodyText,bodyHtml}', '{}', now());
     UPDATE "Message" SET held = true WHERE id = ${sql(m.o3!)};
     COMMIT;`,
  )
  // A rider's measurements of Alpha (a row past the guards): behind sales.measurements.view.
  const measurement = await rawThread('MeasurementProfile', w.a.partyId, null, { at: at(60), body: 'Madeup fitting note' })
  rows.measurementThread = measurement.threadId
  rows.measurementMessage = measurement.messageId

  // ---- Brand Beta -----------------------------------------------------------------------------------------------------------
  betaMessages.push(...(await writeOn({ type: 'SalesOrder', id: w.b.salesOrderId }, [{ direction: 'INBOUND', channel: 'PORTAL', author: buyer, bodyText: 'Betaword: a question on our order', at: at(20) }])))
  betaMessages.push(...(await writeOn({ type: 'Party', id: w.b.partyId }, [{ direction: 'INTERNAL_NOTE', channel: 'APP', author: staff, bodyText: 'Betaword: office note on Beta', at: at(40) }])))
  // Beta's project that links Alpha's order (the project link's guard refuses such a row today: a row past the guards).
  rows.projectB = newId()
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Project" (id, "tenantId", "companyId", number, name, "leadId", "partyId", "targetDate")
       VALUES (${sql(rows.projectB)}, ${sql(w.tenantId)}, ${sql(w.companyId)}, 'T-SA060-PRJ-B', 'Betaword capsule', ${sql(PEOPLE.all)}, ${sql(w.b.partyId)}, '2026-12-31');
     INSERT INTO "ProjectLink" (id, "tenantId", "projectId", "partyId", "recordType", "recordId", key)
       VALUES (${sql(newId())}, ${sql(w.tenantId)}, ${sql(rows.projectB)}, ${sql(w.b.partyId)}, 'SalesOrder', ${sql(w.a.salesOrderId)}, 'link:${rows.projectB}:SalesOrder:${w.a.salesOrderId}');
     COMMIT;`,
  )
  betaMessages.push(
    ...(await writeOn({ type: 'Project', id: rows.projectB }, [
      { direction: 'INBOUND', channel: 'PORTAL', author: buyer, bodyText: 'Betaword: about the capsule and the linked order', at: at(65) },
      { direction: 'INTERNAL_NOTE', channel: 'APP', author: staff, bodyText: 'Betaword: office note on the capsule', at: at(66) },
    ])),
  )

  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: "Alpha's internal notes", text: 'Alphaseam' }, { label: 'mixed work order', text: w.mixed.number }]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

/** Alpha's messages the every-customer reader may read, as the database holds them: the customer-side threads, held mail out, newest first. */
async function expectedFor(partyId: string, types: readonly string[]): Promise<string[]> {
  return (
    await admin<{ id: string }>(
      `SELECT m.id FROM "Message" m JOIN "Thread" t ON t.id = m."threadId"
        WHERE t."tenantId" = $1 AND t."partyId" = $2 AND t."recordType" = ANY($3) AND t."lastMessageAt" IS NOT NULL AND m.held = false
        ORDER BY m.at DESC, m.id DESC`,
      [w.tenantId, partyId, types],
    )
  ).map((row) => row.id)
}
const everyTypeBut = (...left: string[]) => Object.keys(CUSTOMER_FEED_TYPES).filter((type) => !left.includes(type))

describe('B-SA-060 the merge: one list newest first, in pages without gaps or repeats', { timeout: 120_000 }, () => {
  it('Alpha’s messages of every customer-side thread, exactly as the database orders them (the measurements behind their gate)', async () => {
    const one = await ok('office.all', 'GET', feedUrl(w.a.partyId))
    expect(one.customer).toMatchObject({ id: w.a.partyId })
    const expected = await expectedFor(w.a.partyId, everyTypeBut('MeasurementProfile'))
    const { entries } = await everyPage('office.all', w.a.partyId, '')
    expect(messageIds(entries)).toEqual(expected)
    // The made-up ones in their order across three threads (the same minute: the id decides); the held mail is not there.
    const mine = messageIds(entries).filter((id) => Object.values(m).includes(id))
    const tie = [m.p2!, m.s3!].sort().reverse()
    expect(mine).toEqual([m.o4, m.p3, m.s2, m.o2, ...tie, m.s1, m.o1, m.p1])
    expect(messageIds(entries)).not.toContain(m.o3)
    // The rider's measurements: not shown without the right, counted; shown with it.
    expect(messageIds(entries)).not.toContain(rows.measurementMessage)
    expect(one.threadsNotShown).toBeGreaterThanOrEqual(1)
    const measure = await ok('office.measure', 'GET', feedUrl(w.a.partyId))
    expect(messageIds(measure.entries)).toContain(rows.measurementMessage)
    expect(measure.threadsNotShown).toBe(one.threadsNotShown - 1)
    expect(one.olderThreads).toBe(0)
  })

  it('pages of 3 give the same list as one page: no gap, no repeat, every page full but the last', async () => {
    const single = await everyPage('office.all', w.a.partyId, '')
    const paged = await everyPage('office.all', w.a.partyId, 'limit=3')
    expect(messageIds(paged.entries)).toEqual(messageIds(single.entries))
    expect(new Set(messageIds(paged.entries)).size).toBe(paged.entries.length)
    for (const page of paged.pages.slice(0, -1)) expect(page.entries).toHaveLength(3)
    expect(paged.pages.length).toBeGreaterThanOrEqual(3)
    // Pages of 30 at most.
    expect((await call('office.all', 'GET', feedUrl(w.a.partyId, 'limit=31'))).status).toBe(400)
  })

  it('the view and the kinds narrow it: shared only, office notes only, the general conversation only', async () => {
    const all = messageIds((await everyPage('office.all', w.a.partyId, '')).entries)
    const shared = (await everyPage('office.all', w.a.partyId, 'audience=PARTNER')).entries
    const notes = (await everyPage('office.all', w.a.partyId, 'audience=OFFICE')).entries
    expect(shared.every((entry) => entry.message.audience === 'PARTNER')).toBe(true)
    expect(notes.every((entry) => entry.message.audience === 'OFFICE')).toBe(true)
    expect([...messageIds(shared), ...messageIds(notes)].sort()).toEqual([...all].sort())
    expect(messageIds(shared)).toEqual(expect.arrayContaining([m.p1, m.o1, m.s1, m.s2, m.s3]))
    expect(messageIds(notes)).toEqual(expect.arrayContaining([m.p2, m.o2, m.o4]))
    const general = (await everyPage('office.all', w.a.partyId, 'kinds=GENERAL')).entries
    expect(new Set(general.map((entry) => entry.record.type))).toEqual(new Set(['Party']))
    expect(messageIds(general)).toEqual(await expectedFor(w.a.partyId, ['Party']))
    const orders = (await everyPage('office.all', w.a.partyId, 'kinds=ORDERS')).entries
    expect(orders.every((entry) => entry.record.kind === 'ORDERS')).toBe(true)
    expect(messageIds(orders)).toEqual(expect.arrayContaining([m.o1, m.o2, m.o4, m.s1, m.s2, m.s3]))
  })

  it('each entry names its record: the order’s number and the customer’s own number, its kind; the message as its thread shows it', async () => {
    const { entries } = await everyPage('office.all', w.a.partyId, '')
    const byId = new Map(entries.map((entry) => [entry.message.id as string, entry]))
    const order = (await admin<{ number: string; customerSeq: number | null }>('SELECT number, "customerSeq" FROM "SalesOrder" WHERE id = $1', [w.a.salesOrderId]))[0]!
    expect(byId.get(m.o1!)!.record).toEqual({ type: 'SalesOrder', id: w.a.salesOrderId, label: order.number, ownNumber: order.customerSeq, companyId: w.companyId, kind: 'ORDERS' })
    expect(byId.get(m.p1!)!.record).toMatchObject({ type: 'Party', id: w.a.partyId, kind: 'GENERAL', ownNumber: null })
    expect(byId.get(m.p1!)!.message).toMatchObject({ direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', body: 'Alpha general: a question about the new season', author: { kind: 'PARTY', name: 'Madeup Buyer' } })
    // Erased after a privacy request: said so, never an empty card.
    expect(byId.get(m.p3!)!.message).toMatchObject({ erased: true, body: '' })
  })
})

describe('B-SA-060 what is new to the reader (the feed never moves a mark)', { timeout: 120_000 }, () => {
  it('after the reader’s own mark and not their own message; reading the feed changes no mark', async () => {
    await ok('office.p1', 'POST', `/threads/SalesOrder/${w.a.salesOrderId}/read`, { messageId: m.o2 })
    const marks = async () => (await admin<{ n: string }>('SELECT count(*)::text AS n FROM "ThreadRead" WHERE "userId" = $1', [PEOPLE.p1]))[0]!.n
    const before = await marks()
    const { entries } = await everyPage('office.p1', w.a.partyId, '')
    const isNew = new Map(entries.map((entry) => [entry.message.id as string, entry.new as boolean]))
    expect([isNew.get(m.o1!), isNew.get(m.o2!)]).toEqual([false, false])
    // Their own note is never new; the other conversations, never read by them, are.
    expect(isNew.get(m.o4!)).toBe(false)
    expect([isNew.get(m.s1!), isNew.get(m.p2!), isNew.get(m.p1!)]).toEqual([true, true, true])
    expect(await marks()).toBe(before)
  })
})

describe('B-SA-060 THE WALL', { timeout: 180_000 }, () => {
  it('a person limited to Brand Beta asking for Alpha gets 404 "Customer not found." — word for word an unknown customer', async () => {
    const alpha = await call('office.p2', 'GET', feedUrl(w.a.partyId))
    const unknown = await call('office.p2', 'GET', feedUrl(newId()))
    expect(alpha.status).toBe(404)
    expect(alpha.body.error.message).toBe('Customer not found.')
    const words = (answer: { status: number; body: Json }) => ({ status: answer.status, code: answer.body.error?.code, message: answer.body.error?.message, issues: answer.body.error?.issues })
    expect(words(alpha)).toEqual(words(unknown))
    // A cursor or a view changes nothing; a person limited to Alpha gets the same on Beta.
    expect(words(await call('office.p2', 'GET', feedUrl(w.a.partyId, 'audience=PARTNER&kinds=ORDERS')))).toEqual(words(unknown))
    expect((await call('office.p1', 'GET', feedUrl(w.b.partyId))).status).toBe(404)
    // A supplier-only party is no customer: the same words.
    const supplier = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND NOT ('CUSTOMER' = ANY(roles::text[])) AND NOT ('BRAND' = ANY(roles::text[])) ORDER BY code LIMIT 1`, [w.tenantId]))[0]
    if (supplier) expect(words(await call('office.all', 'GET', feedUrl(supplier.id)))).toEqual(words(unknown))
  })

  it('an every-customer reader of Alpha never meets a Beta thread, not even Beta’s project that links Alpha’s order', async () => {
    const { pages, entries } = await everyPage('office.all', w.a.partyId, '')
    for (const id of betaMessages) expect(messageIds(entries)).not.toContain(id)
    expect(entries.every((entry) => entry.record.id !== rows.projectB && entry.record.id !== w.b.salesOrderId && entry.record.id !== w.b.partyId)).toBe(true)
    expect(JSON.stringify(pages)).not.toContain('Betaword')
    expect(JSON.stringify(pages)).not.toContain('T-SA060-PRJ-B')
    // Beta's own feed holds them (the project is Beta's conversation) — read by Beta's person, and it names nothing of Alpha.
    const beta = await everyPage('office.p2', w.b.partyId, '')
    expect(messageIds(beta.entries)).toEqual(expect.arrayContaining(betaMessages))
    expect(beta.entries.every((entry) => entry.message.id !== m.o1)).toBe(true)
  })

  it('no work-order, hold or NCR note ever appears — a mixed work order’s included; no record of those types, whoever reads', async () => {
    for (const session of ['office.all', 'office.p1', 'office.measure']) {
      const { pages, entries } = await everyPage(session, w.a.partyId, '')
      for (const id of internalMessages) expect(messageIds(entries), session).not.toContain(id)
      for (const entry of entries) {
        expect(NEVER_IN_CUSTOMER_FEED, session).not.toContain(entry.record.type)
        expect(Object.keys(CUSTOMER_FEED_TYPES), session).toContain(entry.record.type)
      }
      expect(JSON.stringify(pages), session).not.toContain('Alphaseam')
      expect(JSON.stringify(pages), session).not.toContain(w.mixed.number)
    }
    // `include=work` is no term of this read (review BW-4): refused in words, never read.
    expect((await call('office.all', 'GET', feedUrl(w.a.partyId, 'include=work'))).status).toBe(400)
  })

  it('a floor note says it is from the floor, never who: no id, no name', async () => {
    const { pages, entries } = await everyPage('office.all', w.a.partyId, '')
    const floor = entries.find((entry) => entry.message.id === m.o2)!
    expect(floor.message.author).toMatchObject({ kind: 'WORKER', name: null })
    expect(floor.message.author.id ?? null).toBeNull()
    expect(floor.message.authorHidden).toBe(true)
    expect(JSON.stringify(pages)).not.toContain(FLOOR_NAME)
  })

  it('every answer Brand Beta’s person got names nothing of Alpha (the markers scan)', async () => {
    await everyPage('office.p2', w.b.partyId, '')
    await everyPage('office.p2', w.b.partyId, 'audience=OFFICE')
    await call('office.p2', 'GET', feedUrl(w.a.partyId))
    const hits = seenByB.flatMap((seen) => findMarkers(seen.body, aMarkers).map((marker) => `${seen.url} → ${marker}`))
    expect(hits).toEqual([])
    expect(seenByB.length).toBeGreaterThan(2)
  })
})
