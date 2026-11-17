import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { batchGroupKey } from '@nexus/factory-domain/notifications/rules'
import { heldForOtherCustomer, NAMES_NO_OTHER_CUSTOMER, NOTE_RECORDS_MAX, NOTE_WORDS, uniqueRecords, writeOrder } from '@nexus/factory-domain/production-brand/notes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { findMarkers, markersOf, productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from '../testing/two-brands'

/**
 * B-PR-43a — note to N records and ask the supervisor (production plan §1 "Ask the supervisor / Note to N", §3; lead pick L23;
 * review fixes R-47, R-48, R-58; threads agreements T5, T6; the Owner's point N4: "mention him to address a specific issue … for
 * that order or multiple orders at once"), and its wall test PW-13 (+ office.p2 never reads, on a P2 record, a note whose text
 * names P1 unless the writer ticked "This text names no other customer"). The Owner rule 2026-11-16: "One brand must not be able
 * to see anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the threads' guards are
 * real), the core, files, production and numbering seeds, the production two-brand harness (brand A = the seeds' P1 with its new
 * order and its work order; brand B = the threads' second brand with SEED-SO-B001 and its work order; a work order of no customer)
 * and its supervisor people (REAL users: supervisorA limited to A, backupA over every customer, officeB limited to B). A's
 * default supervisor is supervisorA, B's officeB (B-PR-42a's route).
 *
 *   - the check before Send and the write: one INTERNAL note on each record's own thread, one batch, threads' seams only; a
 *     person mentioned only where they read (named in the answer); "Ask the supervisor" adds each record's own supervisor; one
 *     audit row per customer; the bell folds the batch into one item per reader (T6);
 *   - PW-13: office.p2 over [P1 order, P1 work order, P2 order]: only P2's note is written, P1's records counted, never named;
 *   - R-47: a text naming customer A on B's order is held (check) and refused (write) until ticked; with the tick office.p2 reads
 *     it; the writer is told only names they may know;
 *   - refusals in words: none seen (404), none writable (403), a closed thread skipped, a record not writable skipped beside one
 *     that is, the limits (400); nothing ever reaches a portal.
 *
 * The tests run in order on one database. Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/notes/notes`.
 */

const ns = 'pr2l-notes'
const ids = twoBrandIds(ns)
const people = supervisorPeopleIds(ns)
const PERMISSIONS: Permission[] = ['workorders.view', 'production.brand.manage', 'threads.read', 'threads.post', 'threads.manage']
const grant = (permissions: Permission[], parties: 'all' | string[]) => ({ permissions, companies: 'all' as const, sites: 'all' as const, parties })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // Reads every customer's threads, writes only on B's.
  'office.mixed': { audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants: [grant(['threads.read'], 'all'), grant(['threads.post'], [ids.b])] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let nameA = ''

type Json = Record<string, any>
async function call(session: string, url: string, payload: unknown, method: 'POST' | 'GET' | 'PUT' = 'POST'): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, url: string, payload?: unknown, method: 'POST' | 'GET' | 'PUT' = 'POST'): Promise<Json> {
  const answer = await call(session, url, payload, method)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T | undefined> => (await admin<T>(sql, values))[0]

const SO = (id: string) => ({ type: 'SalesOrder', id })
const WO = (id: string) => ({ type: 'WorkOrder', id })
const numberOf = async (table: 'SalesOrder' | 'WorkOrder', id: string) => (await one<{ number: string }>(`SELECT number FROM "${table}" WHERE id = $1`, [id]))!.number
/** The messages of a batch: where, what kind, who it mentions. */
const messagesOf = (messageIds: readonly string[]) =>
  admin<{ id: string; recordType: string; recordId: string; direction: string; audience: string; partyId: string | null; mentionedUserIds: string[]; bodyText: string }>(
    `SELECT m.id, t."recordType", t."recordId", m.direction::text AS direction, m.audience::text AS audience, m."partyId", m."mentionedUserIds", m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE m.id = ANY($1::uuid[])`,
    [messageIds],
  )
const messageCount = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Message" WHERE "tenantId" = $1`, [ids.tenantId]))!.n
const settingsVersion = async (partyId: string) => (await one<{ version: number }>(`SELECT version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId]))?.version ?? 0

beforeAll(async () => {
  db = await migratedDatabase('pr2l_notes')
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
  expect(await supervisorPeople({ database, namespace: ns }, w)).toEqual(people)
  await ok('office.all', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) }, 'PUT')
  await ok('office.all', `/production/brands/${ids.b}/supervisor`, { supervisorId: people.officeB, backupId: null, version: await settingsVersion(ids.b) }, 'PUT')
  nameA = (await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [ids.a]))!.name
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-43a the rules', () => {
  it('a record picked twice is written once; held only with another customer’s name and no tick; written in type and id order; words in both languages', () => {
    expect(uniqueRecords([SO('b'), SO('a'), SO('b'), WO('a')])).toEqual([SO('b'), SO('a'), WO('a')])
    expect(heldForOtherCustomer([{ namesOther: [1] }, { namesOther: [] }], false)).toEqual([{ namesOther: [1] }])
    expect(heldForOtherCustomer([{ namesOther: [1] }], true)).toEqual([])
    expect(writeOrder([WO('a'), SO('c'), SO('b')])).toEqual([SO('b'), SO('c'), WO('a')])
    expect(NOTE_RECORDS_MAX).toBe(100)
    for (const words of [...Object.values(NOTE_WORDS), NAMES_NO_OTHER_CUSTOMER]) {
      expect(words.en).toBeTruthy()
      expect(words.it).toBeTruthy()
    }
  })
})

describe('B-PR-43a note to N records and ask the supervisor', { timeout: 120_000 }, () => {
  let batch: Json

  it('the check before Send: the records seen, two customers, who cannot read which record; nothing is held, nothing written', async () => {
    const before = await messageCount()
    const check = await ok('office.all', '/production/notes/check', { records: [SO(w.a.salesOrderId), WO(w.a.workOrderId), SO(w.b.salesOrderId)], body: 'Made-up: please check the cut plan before Thursday.', mentions: [people.supervisorA], askSupervisor: true })
    expect(check.records.map((record: Json) => [record.type, record.id, record.canWrite])).toEqual([
      ['SalesOrder', w.a.salesOrderId, true],
      ['WorkOrder', w.a.workOrderId, true],
      ['SalesOrder', w.b.salesOrderId, true],
    ])
    expect(check.records[1]).toMatchObject({ label: await numberOf('WorkOrder', w.a.workOrderId), customer: { id: ids.a }, supervisor: 'SOMEONE_ELSE' })
    expect(check).toMatchObject({ unknown: 0, customers: 2, noSupervisor: [], namesOtherCustomer: [], held: false })
    // supervisorA (limited to A) cannot read B's order: not mentioned there; the note is still written.
    expect(check.people).toEqual([{ userId: people.supervisorA, name: 'T Supervisor Alpha', cannotRead: [{ type: 'SalesOrder', id: w.b.salesOrderId, label: 'SEED-SO-B001' }] }])
    expect(await messageCount()).toBe(before)
  })

  it('the write: one INTERNAL note on each record’s own thread, one batch; each person mentioned only where they read; each record’s own supervisor asked; one audit row per customer', async () => {
    batch = await ok('office.all', '/production/notes', { records: [SO(w.a.salesOrderId), WO(w.a.workOrderId), SO(w.b.salesOrderId)], body: 'Made-up: please check the cut plan before Thursday.', mentions: [people.supervisorA], askSupervisor: true })
    expect(batch.written.map((entry: Json) => [entry.type, entry.id]).sort()).toEqual([['SalesOrder', w.a.salesOrderId], ['SalesOrder', w.b.salesOrderId], ['WorkOrder', w.a.workOrderId]].sort())
    const of = (id: string) => batch.written.find((entry: Json) => entry.id === id)
    expect(of(w.a.salesOrderId)).toMatchObject({ mentioned: [people.supervisorA], supervisorAsked: true })
    expect(of(w.a.workOrderId)).toMatchObject({ mentioned: [people.supervisorA], supervisorAsked: true })
    expect(of(w.b.salesOrderId)).toMatchObject({ mentioned: [people.officeB], supervisorAsked: true, label: 'SEED-SO-B001' })
    expect(batch.notMentioned).toEqual([{ userId: people.supervisorA, records: [{ type: 'SalesOrder', id: w.b.salesOrderId, label: 'SEED-SO-B001' }] }])
    expect(batch).toMatchObject({ skipped: [], unknown: 0 })
    // Every note is an office note in its record's own thread: no party, never shared; a work order's thread stays party-less.
    const messages = await messagesOf(batch.written.map((entry: Json) => entry.messageId))
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', partyId: null, bodyText: 'Made-up: please check the cut plan before Thursday.' })
    expect(messages.find((message) => message.recordId === w.b.salesOrderId)!.mentionedUserIds).toEqual([people.officeB])
    expect(await one(`SELECT "partyId" FROM "Thread" WHERE "recordType" = 'WorkOrder' AND "recordId" = $1`, [w.a.workOrderId])).toEqual({ partyId: null })
    // One batch on every thread event (threads T6, B-TH-045).
    const posted = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'batchId' = $2`, [ids.tenantId, batch.batchId])
    expect(posted).toHaveLength(3)
    const mentioned = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.user_mentioned' AND payload->>'batchId' = $2`, [ids.tenantId, batch.batchId])
    expect(mentioned.map((event) => event.payload.userId).sort()).toEqual([people.supervisorA, people.supervisorA, people.officeB].sort())
    // R-48: one production.notesBatch row per customer, each naming only its own records.
    const rows = await admin<{ recordType: string; recordId: string; after: Json }>(`SELECT "recordType", "recordId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.notesBatch' AND after->>'batchId' = $2`, [ids.tenantId, batch.batchId])
    expect(rows.map((row) => [row.recordType, row.recordId]).sort()).toEqual([['Party', ids.a], ['Party', ids.b]].sort())
    expect(JSON.stringify(rows.find((row) => row.recordId === ids.a))).not.toContain(w.b.salesOrderId)
    expect(JSON.stringify(rows.find((row) => row.recordId === ids.b))).not.toContain(w.a.salesOrderId)
  })

  it('T6: each reader’s bell folds the batch into ONE item — supervisorA’s two mentions share one group; officeB is told only of B’s', async () => {
    const system = callerFor(database, systemContext(ids.tenantId, newId()))
    const events = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.user_mentioned' AND payload->>'batchId' = $2 ORDER BY "occurredAt", id`, [ids.tenantId, batch.batchId])
    for (const row of events) await fanOut(system, { eventId: row.id, type: row.type, version: row.version, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, payload: row.payload })
    const told = await admin<{ userId: string; recordId: string; groupKey: string }>(`SELECT "userId", "recordId", "groupKey" FROM "Notification" WHERE "tenantId" = $1 AND "eventId" = ANY($2::uuid[])`, [ids.tenantId, events.map((row) => row.id)])
    const his = told.filter((row) => row.userId === people.supervisorA)
    expect(his.map((row) => row.recordId).sort()).toEqual([w.a.salesOrderId, w.a.workOrderId].sort())
    expect(new Set(his.map((row) => row.groupKey))).toEqual(new Set([batchGroupKey(batch.batchId, 'MENTION')]))
    expect(told.filter((row) => row.userId === people.officeB).map((row) => row.recordId)).toEqual([w.b.salesOrderId])
  })

  it('PW-13: office.p2 over [P1 order, P1 work order, P2 order]: only P2’s note is written; P1’s records are counted, never named; P1 alone is not found', async () => {
    const before = await messageCount()
    const check = await ok('office.p2', '/production/notes/check', { records: [SO(w.a.salesOrderId), WO(w.a.workOrderId), SO(w.b.salesOrderId)], body: 'Made-up: please check the trims.', mentions: [people.supervisorA] })
    expect(check.records.map((record: Json) => record.id)).toEqual([w.b.salesOrderId])
    expect(check.unknown).toBe(2)
    const answer = await ok('office.p2', '/production/notes', { records: [SO(w.a.salesOrderId), WO(w.a.workOrderId), SO(w.b.salesOrderId)], body: 'Made-up: please check the trims.', mentions: [people.supervisorA] })
    expect(answer.written.map((entry: Json) => entry.id)).toEqual([w.b.salesOrderId])
    expect(answer.unknown).toBe(2)
    // The mention is refused per record: supervisorA reads none of B.
    expect(answer.written[0].mentioned).toEqual([])
    expect(answer.notMentioned).toEqual([{ userId: people.supervisorA, records: [{ type: 'SalesOrder', id: w.b.salesOrderId, label: 'SEED-SO-B001' }] }])
    expect(await messageCount()).toBe(before + 1)
    const markers = await markersOf(db, ids.a)
    for (const text of [JSON.stringify(check), JSON.stringify(answer)]) {
      expect(text).not.toContain(w.a.salesOrderId)
      expect(text).not.toContain(w.a.workOrderId)
      expect(findMarkers(text, markers)).toEqual([])
    }
    for (const records of [[SO(w.a.salesOrderId)], [WO(w.a.workOrderId), WO(w.mixed.workOrderId)], [SO(newId())]]) {
      const refused = await call('office.p2', '/production/notes', { records, body: 'Made-up: hello.' })
      expect(refused.status, refused.raw).toBe(404)
      expect(refused.body.error.message).toBe(NOTE_WORDS.NONE_FOUND.en)
    }
    expect(await messageCount()).toBe(before + 1)
  })

  it('R-47: a text naming customer A on B’s order is held — the check names the record, the write refuses without the tick and writes nothing; with the tick it is written and office.p2 reads it; the same text on A’s own order is not held', async () => {
    const body = `Made-up: the hides for ${nameA} arrive Thursday.`
    const records = [SO(w.b.salesOrderId)]
    const check = await ok('office.all', '/production/notes/check', { records, body })
    expect(check.namesOtherCustomer).toEqual([{ type: 'SalesOrder', id: w.b.salesOrderId, label: 'SEED-SO-B001', names: [nameA] }])
    expect(check.held).toBe(true)
    expect((await ok('office.all', '/production/notes/check', { records, body, namesNoOtherCustomer: true })).held).toBe(false)
    // office.p2 writing the same words is held too, but is never told A's name (a customer it does not reach).
    const theirs = await ok('office.p2', '/production/notes/check', { records, body })
    expect(theirs.namesOtherCustomer).toEqual([{ type: 'SalesOrder', id: w.b.salesOrderId, label: 'SEED-SO-B001', names: [] }])
    expect(theirs.held).toBe(true)
    const before = await messageCount()
    const refused = await call('office.all', '/production/notes', { records: [SO(w.a.salesOrderId), ...records], body })
    expect(refused.status, refused.raw).toBe(409)
    expect(refused.body.error.message).toBe(NOTE_WORDS.NAMES_OTHER_CUSTOMER.en)
    expect(refused.body.error.issues).toEqual([
      { path: 'refusal/NAMES_OTHER_CUSTOMER', message: NOTE_WORDS.NAMES_OTHER_CUSTOMER.en },
      { path: 'body/records/1', message: `SEED-SO-B001: ${NOTE_WORDS.NAMES_OTHER_CUSTOMER_ON.en}` },
    ])
    expect(await messageCount()).toBe(before)
    // Without the tick office.p2 never reads, on B's order, a note naming A: nothing was written. With it, the writer confirmed.
    const written = await ok('office.all', '/production/notes', { records, body, namesNoOtherCustomer: true })
    expect(written.written).toHaveLength(1)
    const thread = await ok('office.p2', `/threads/SalesOrder/${w.b.salesOrderId}?limit=50`, undefined, 'GET')
    expect(thread.messages.some((message: Json) => message.id === written.written[0].messageId)).toBe(true)
    // On A's own order its own name is no other customer's.
    expect((await ok('office.all', '/production/notes/check', { records: [SO(w.a.salesOrderId)], body })).held).toBe(false)
  })

  it('refusals in words: seen but none writable (403); one not writable is skipped beside one that is; a closed thread is skipped; the limits (400)', async () => {
    const none = await call('office.mixed', '/production/notes', { records: [SO(w.a.salesOrderId)], body: 'Made-up: hello.' })
    expect(none.status, none.raw).toBe(403)
    expect(none.body.error.message).toBe(NOTE_WORDS.CANNOT_POST.en)
    const mixed = await ok('office.mixed', '/production/notes', { records: [SO(w.a.salesOrderId), SO(w.b.salesOrderId)], body: 'Made-up: hello.' })
    expect(mixed.written.map((entry: Json) => entry.id)).toEqual([w.b.salesOrderId])
    expect(mixed.skipped).toEqual([{ type: 'SalesOrder', id: w.a.salesOrderId, label: await numberOf('SalesOrder', w.a.salesOrderId), why: NOTE_WORDS.CANNOT_POST.en }])
    // A closed thread: skipped with why (reopen it to write).
    const read = await ok('office.all', `/threads/WorkOrder/${w.a.workOrderId}?limit=1`, undefined, 'GET')
    await ok('office.all', `/threads/WorkOrder/${w.a.workOrderId}/status`, { status: 'CLOSED', version: read.thread.version, reason: 'Made-up: closed for the test.' }, 'PUT')
    const closed = await ok('office.all', '/production/notes', { records: [WO(w.a.workOrderId)], body: 'Made-up: hello.' })
    expect(closed.written).toEqual([])
    expect(closed.skipped).toEqual([{ type: 'WorkOrder', id: w.a.workOrderId, label: await numberOf('WorkOrder', w.a.workOrderId), why: NOTE_WORDS.THREAD_CLOSED.en }])
    const again = await ok('office.all', `/threads/WorkOrder/${w.a.workOrderId}?limit=1`, undefined, 'GET')
    await ok('office.all', `/threads/WorkOrder/${w.a.workOrderId}/status`, { status: 'OPEN', version: again.thread.version }, 'PUT')
    // The limits and the note itself.
    expect((await call('office.all', '/production/notes', { records: Array.from({ length: 101 }, () => SO(newId())), body: 'Made-up.' })).status).toBe(400)
    expect((await call('office.all', '/production/notes', { records: [SO(w.a.salesOrderId)], body: 'Made-up.', mentions: Array.from({ length: 21 }, () => newId()) })).status).toBe(400)
    expect((await call('office.all', '/production/notes', { records: [SO(w.a.salesOrderId)], body: '   ' })).status).toBe(400)
    const nobody = await call('office.all', '/production/notes', { records: [SO(w.a.salesOrderId)], body: 'Made-up.', mentions: [newId()] })
    expect(nobody.status, nobody.raw).toBe(400)
    expect(nobody.body.error.issues).toEqual([{ path: 'body/mentions/0', message: NOTE_WORDS.NOT_A_PERSON.en }])
  })

  it('nothing reaches a portal: the customer’s own session reads none of the batch’s notes', async () => {
    const messageIds = batch.written.map((entry: Json) => entry.messageId)
    for (const partyId of [ids.a, ids.b]) {
      const rows = await database.withScope({ audience: 'partner', tenantId: ids.tenantId, actorId: newId(), partyId }, (client) => client.message.findMany({ where: { id: { in: messageIds } }, select: { id: true } }))
      expect(rows).toEqual([])
    }
    // The supervisor person ids are office people only: none is a portal person of either customer.
    expect(await admin(`SELECT id FROM "User" WHERE id = ANY($1::uuid[]) AND audience = 'PARTNER'`, [[people.supervisorA, people.officeB]])).toEqual([])
    expect(seedUuid(ns, 'tenant')).toBe(ids.tenantId)
  })
})
