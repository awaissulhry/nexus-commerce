import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { REST_CARD } from '@nexus/factory-domain/production/dispatch/rules'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seed as seedSkills } from '../../../../../../packages/factory-db/seed/skills'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { FLOOR_MESSAGES } from './mywork-messages'
// ---- B-W2b-F53: this file fixes its clock on a day of the seeds' story, so it runs the seeds as written (seed-calendar)
await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())

/**
 * Open messages on my work orders (B-W2b-71; COL-036; design floor.mywork "For your work") through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations, on the factory-db seeds' plant A1: v1 published (SEED-WO-0001 sewn on
 * line L1 on the 17th). The clock is fixed at Tuesday 17 Nov 2026 09:00 UTC. Every name and word is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/dispatch/mywork-messages`.
 */

const NOW = new Date('2026-11-17T09:00:00.000Z')
const DAY = '2026-11-17'
const NS = 'w2b71-mywork'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const sew1 = idOf('site:A1:station:SEW-01')
const sew2 = idOf('site:A1:station:SEW-02')
const operator = idOf('worker:A1:operator')
const lead = idOf('worker:A1:lead')
const sewingTablet = newId()
const secondTablet = newId()
const shelfTablet = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let workOrder: string
let otherWorkOrder: string
let sewing: string

const OFFICE: Permission[] = ['production.dispatch.view', 'production.dispatch.manage', 'workorders.view', 'threads.read', 'threads.post', 'threads.manage']
const FOR_FLOOR = { forFloor: true }
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const floorGrant = (permissions: Permission[]): Grant[] => [{ permissions, companies: [companyA], sites: [siteA1], parties: 'all' }]
const officeUser = newId()
const SESSIONS: Record<string, SessionContext> = {
  supervisor: { audience: 'office', tenantId: T, actorId: officeUser, grants: [grant(OFFICE)] },
  readOnly: { audience: 'office', tenantId: T, actorId: officeUser, grants: [grant(['threads.read'])] },
  operatorTablet: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: sewingTablet, grants: floorGrant(['floor.work']) },
  otherStation: { audience: 'floor', tenantId: T, actorId: lead, siteId: siteA1, deviceId: secondTablet, grants: floorGrant(['floor.work']) },
  commenter: { audience: 'floor', tenantId: T, actorId: lead, siteId: siteA1, deviceId: secondTablet, grants: floorGrant(['production.scan']) },
  shelf: { audience: 'floor', tenantId: T, actorId: lead, siteId: siteA1, deviceId: shelfTablet, grants: floorGrant(['floor.work']) },
  noWork: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: sewingTablet, grants: floorGrant(['production.dispatch.view']) },
  // F-SA-247: a tablet of the other plant (site B1), for the one-work-order read.
  otherSite: { audience: 'floor', tenantId: T, actorId: operator, siteId: idOf('site:B1'), deviceId: newId(), grants: [{ permissions: ['floor.work'], companies: [idOf('company:B')], sites: [idOf('site:B1')], parties: 'all' }] },
}

type Json = Record<string, any>
const run = randomBytes(4).toString('hex')
let keys = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `mywork-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const messages = async (session = 'operatorTablet'): Promise<Json[]> => (await ok(session, 'GET', '/production/dispatch/mine/messages')).messages
const clearDay = () => admin(`DELETE FROM "DispatchAssignment" WHERE "tenantId" = $1`, [T])
const assign = (body: Json) => ok('supervisor', 'POST', '/production/dispatch/assignments', { date: DAY, ...body }, 201)
const move = (body: Json) => ok('supervisor', 'POST', '/production/dispatch/moves', { date: DAY, ...body })

/** A message of the thread by SQL: what the API's own write cannot make (an old note, another author, a mail). */
async function writeRaw(workOrderId: string, row: { kind?: string; authorId?: string | null; authorName?: string | null; direction?: string; channel?: string; audience?: string; text: string; at?: Date; forFloor?: boolean }) {
  const threadId = (await admin<{ id: string }>(`SELECT id FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = 'WorkOrder' AND "recordId" = $2`, [T, workOrderId]))[0]!.id
  await admin(
    `INSERT INTO "Message" (id, "tenantId", "threadId", direction, audience, channel, "authorKind", "authorId", "authorName", "bodyText", at, "forFloor")
     VALUES ($1, $2, $3, $4::"MessageDirection", $5::"MessageAudience", $6::"MessageChannel", $7::"MessageAuthorKind", $8, $9, $10, $11, $12)`,
    [newId(), T, threadId, row.direction ?? 'INTERNAL_NOTE', row.audience ?? 'OFFICE', row.channel ?? 'APP', row.kind ?? 'USER', row.authorId ?? (row.kind ? null : officeUser), row.authorName ?? 'Made-up Office Person', row.text, row.at ?? NOW, row.forFloor ?? true],
  )
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('mywork_messages')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedPeople({ db: database, namespace: NS })
  await seedSkills({ db: database, namespace: NS })
  for (const [id, station, name] of [
    [sewingTablet, sew1, 'Sewing tablet 1'],
    [secondTablet, sew2, 'Sewing tablet 2'],
    [shelfTablet, null, 'Warehouse tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [id, T, companyA, siteA1, station, name])
  }
  const operations = await admin<{ id: string; code: string; workOrderId: string }>(`SELECT o.id, o.code, o."workOrderId" FROM "WorkOrderOperation" o JOIN "WorkOrder" w ON w.id = o."workOrderId" WHERE o."tenantId" = $1 AND w.number = 'SEED-WO-0001' ORDER BY o.seq`, [T])
  sewing = operations.find((row) => row.code === 'SEED-SEW-ASM')!.id
  workOrder = operations[0]!.workOrderId
  otherWorkOrder = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0002'`, [T]))[0]!.id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "requireMfa", "updatedAt") VALUES ($1, $2, $3, 'Made-up Office Person', 'ACTIVE', false, now())`, [officeUser, T, `mywork-${run}@example.com`])
  // The team leader acknowledges the worker notice in force, as on a tablet (a copy of the operator's acknowledgement).
  await admin(
    `INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "deviceTime", "serverTime", "createdById")
     SELECT $1, "tenantId", "siteId", $2, "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", now(), now(), $2 FROM "WorkerNoticeAck" WHERE "workerId" = $3 LIMIT 1`,
    [newId(), lead, operator],
  )
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The day: the sewing of SEED-WO-0001 sits at SEW-01, and only there.
  await clearDay()
  await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
  vi.useRealTimers()
}, 60_000)

describe('the messages on my work orders', () => {
  it('has nothing before anyone wrote', async () => {
    expect(await ok('operatorTablet', 'GET', '/production/dispatch/mine/messages')).toEqual({ asOf: NOW.toISOString(), messages: [] })
  })

  it("lists the office's note on a work order in the station's queue, with where it comes from and never who", async () => {
    await ok('supervisor', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Use the reinforced thread on this order.', ...FOR_FLOOR }, 201)
    const [message, ...rest] = await messages()
    expect(rest).toEqual([])
    expect(message).toMatchObject({ workOrder: { id: workOrder, number: 'SEED-WO-0001' }, from: 'OFFICE', text: 'Use the reinforced thread on this order.', cut: false, at: NOW.toISOString() })
    // B-SA-053: + kind (a plain note) and check (null: only an order change's note opens before Start).
    expect(Object.keys(message!).sort()).toEqual(['at', 'check', 'cut', 'from', 'id', 'kind', 'text', 'workOrder'])
    expect(message).toMatchObject({ kind: 'NOTE', check: null })
    expect(JSON.stringify(message)).not.toContain('Made-up Office Person')
  })

  it("does not reach a tablet at no station that the day names for nothing, and a note on a work order off the lists reaches nobody", async () => {
    expect(await messages('shelf')).toEqual([])
    await ok('supervisor', 'POST', `/threads/WorkOrder/${otherWorkOrder}/notes`, { body: 'About a draft nobody works on.', ...FOR_FLOOR }, 201)
    expect((await messages()).map((message) => message.workOrder.id)).toEqual([workOrder])
  })

  it("reaches the person the day names, wherever the order is queued", async () => {
    await clearDay()
    await assign({ workerId: lead, workOrderOperationId: sewing })
    expect((await messages('shelf')).map((message) => message.workOrder.number)).toEqual(['SEED-WO-0001'])
    await clearDay()
    await move({ workOrderOperationId: sewing, from: REST_CARD, to: { stationId: sew1 } })
  })

  it('leaves out the reader\'s own comment, says "the floor" for another station\'s, and never names a worker', async () => {
    await writeRaw(workOrder, { kind: 'WORKER', authorId: operator, authorName: 'Made-up Operator', text: 'My own comment.', at: new Date(NOW.getTime() - 60_000) })
    await writeRaw(workOrder, { kind: 'WORKER', authorId: lead, authorName: 'Made-up Lead', text: 'A comment from next door.', at: new Date(NOW.getTime() - 120_000) })
    const list = await messages()
    expect(list.map((message) => message.text)).not.toContain('My own comment.')
    const floor = list.find((message) => message.text === 'A comment from next door.')!
    expect(floor.from).toBe('FLOOR')
    expect(JSON.stringify(list)).not.toContain('Made-up')
  })

  it("at a site that names no worker, leaves out this station's own comment", async () => {
    await writeRaw(workOrder, { kind: 'SYSTEM', authorName: 'SEW-01', text: 'This station wrote this.', at: new Date(NOW.getTime() - 180_000) })
    await writeRaw(workOrder, { kind: 'SYSTEM', authorName: 'SEW-02', text: 'The next station wrote this.', at: new Date(NOW.getTime() - 240_000) })
    const texts = (await messages()).map((message) => message.text)
    expect(texts).not.toContain('This station wrote this.')
    expect(texts).toContain('The next station wrote this.')
  })

  it('leaves out what is older than 14 days and sends the newest first', async () => {
    await writeRaw(workOrder, { text: 'Too old for the tablet.', at: new Date(NOW.getTime() - (FLOOR_MESSAGES.days + 1) * 24 * 60 * 60 * 1000) })
    await writeRaw(workOrder, { text: 'Just in time.', at: new Date(NOW.getTime() - (FLOOR_MESSAGES.days - 1) * 24 * 60 * 60 * 1000) })
    const list = await messages()
    const texts = list.map((message) => message.text)
    expect(texts).not.toContain('Too old for the tablet.')
    expect(texts.at(-1)).toBe('Just in time.')
    expect([...list.map((message) => message.at)].sort().reverse()).toEqual(list.map((message) => message.at))
  })

  it('cuts a long text and says so', async () => {
    await writeRaw(workOrder, { text: 'x'.repeat(FLOOR_MESSAGES.text + 50), at: new Date(NOW.getTime() + 1) })
    const [message] = await messages()
    expect(message).toMatchObject({ cut: true })
    expect(message!.text).toHaveLength(FLOOR_MESSAGES.text)
  })

  it('stops when the office closes the conversation, and comes back when it reopens it', async () => {
    const thread = (await ok('supervisor', 'GET', `/threads/WorkOrder/${workOrder}`)).thread
    await ok('supervisor', 'PUT', `/threads/WorkOrder/${workOrder}/status`, { status: 'CLOSED', version: thread.version })
    expect(await messages()).toEqual([])
    await ok('supervisor', 'PUT', `/threads/WorkOrder/${workOrder}/status`, { status: 'OPEN', version: thread.version + 1 })
    expect((await messages()).length).toBeGreaterThan(0)
  })

  it('keeps to the rules of a floor read: floor.work, the floor only, and nothing of the threads opens to the floor role', async () => {
    expect((await call('noWork', 'GET', '/production/dispatch/mine/messages')).statusCode).toBe(403)
    expect((await call('supervisor', 'GET', '/production/dispatch/mine/messages')).statusCode).toBe(403)
    expect((await call('operatorTablet', 'GET', `/threads/WorkOrder/${workOrder}`)).statusCode).toBe(403)
  })
})

describe('a note reaches the tablets only when a person ticks for the floor (B-W2b-F5)', () => {
  const texts = async () => (await messages()).map((message) => message.text)
  const thread = async () => (await ok('supervisor', 'GET', `/threads/WorkOrder/${workOrder}`)).messages as Json[]

  it('keeps a note with no tick in the office: the thread has it, a tablet does not', async () => {
    await ok('supervisor', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up office words, no tick.' }, 201)
    await ok('supervisor', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up office words, tick off.', forFloor: false }, 201)
    const seen = await texts()
    expect(seen).not.toContain('Made-up office words, no tick.')
    expect(seen).not.toContain('Made-up office words, tick off.')
    const written = (await thread()).filter((message) => /no tick|tick off/.test(message.body))
    expect(written.map((message) => message.forFloor)).toEqual([false, false])
  })

  it('sends a ticked note to the tablet, and the thread says it went there', async () => {
    const posted = await ok('supervisor', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up office words, ticked.', ...FOR_FLOOR }, 201)
    expect(posted.message.forFloor).toBe(true)
    expect((await messages()).find((message) => message.id === posted.message.id)).toMatchObject({ from: 'OFFICE', text: 'Made-up office words, ticked.' })
    expect((await thread()).find((row) => row.id === posted.message.id)?.forFloor).toBe(true)
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Message' AND "recordId" = $1`, [posted.message.id])
    expect(audit!.after.forFloor).toBe(true)
  })

  it("keeps out a note the column's default holds, and a system note on the thread", async () => {
    const threadId = (await admin<{ id: string }>(`SELECT id FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = 'WorkOrder' AND "recordId" = $2`, [T, workOrder]))[0]!.id
    await admin(
      `INSERT INTO "Message" (id, "tenantId", "threadId", direction, audience, channel, "authorKind", "authorId", "authorName", "bodyText", at) VALUES ($1, $2, $3, 'INTERNAL_NOTE', 'OFFICE', 'APP', 'USER', $4, 'Made-up Office Person', 'A note from before the tick.', $5)`,
      [newId(), T, threadId, officeUser, NOW],
    )
    await writeRaw(workOrder, { kind: 'SYSTEM', authorName: null, text: 'A note the system wrote for the office.', forFloor: false })
    const seen = await texts()
    expect(seen).toContain('Made-up office words, ticked.')
    expect(seen).not.toContain('A note from before the tick.')
    expect(seen).not.toContain('A note the system wrote for the office.')
  })

  it('still shows the comment of another station, written on the floor through its own route', async () => {
    const posted = await ok('commenter', 'POST', `/production/floor-notes/work-orders/${workOrder}`, { clientEventId: `f5-${run}`, tileCode: 'STITCHING_DIFFERS', note: 'Left sleeve' }, 201)
    const [row] = await admin<{ forFloor: boolean; authorKind: string }>(`SELECT "forFloor", "authorKind"::text AS "authorKind" FROM "Message" WHERE id = $1`, [posted.messageId])
    expect(row).toEqual({ forFloor: true, authorKind: 'WORKER' })
    const shown = (await messages()).find((message) => message.id === posted.messageId)
    expect(shown).toMatchObject({ from: 'FLOOR', text: expect.stringContaining('Left sleeve') })
  })

  it('takes the tick only from someone who may write here, and never from a tablet', async () => {
    const before = await texts()
    expect((await call('readOnly', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'I may only read.', ...FOR_FLOOR })).statusCode).toBe(403)
    expect((await call('operatorTablet', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'A tablet may not write here.', ...FOR_FLOOR })).statusCode).toBe(403)
    expect(await texts()).toEqual(before)
  })

  it('keeps a message append-only: the tick cannot be set or taken off afterwards, by anyone', async () => {
    await expect(admin(`UPDATE "Message" SET "forFloor" = false WHERE "tenantId" = $1 AND "forFloor"`, [T])).rejects.toThrow(/append-only/)
    await expect(admin(`UPDATE "Message" SET "forFloor" = true WHERE "tenantId" = $1 AND NOT "forFloor"`, [T])).rejects.toThrow(/append-only/)
  })
})

// ---- B-SA-053 (sales page plan P8', R2; 14-change-flow §5.3): an order change's note for the floor -------------------------------
describe('an order change reaches the floor as its own kind, the newest of each work order, STOP while held, else CHECK (B-SA-053)', () => {
  /** The system's own floor note, as modules/sales/orders/change-notes.ts writes it (SYSTEM, no name, for the floor). */
  async function orderChange(text: string, at: Date): Promise<string> {
    const threadId = (await admin<{ id: string }>(`SELECT id FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = 'WorkOrder' AND "recordId" = $2`, [T, workOrder]))[0]!.id
    const id = newId()
    await admin(
      `INSERT INTO "Message" (id, "tenantId", "threadId", direction, audience, channel, "authorKind", "authorId", "authorName", "bodyText", at, "forFloor") VALUES ($1, $2, $3, 'INTERNAL_NOTE', 'OFFICE', 'APP', 'SYSTEM', NULL, NULL, $4, $5, true)`,
      [id, T, threadId, text, at],
    )
    return id
  }
  /** The work order's state, set as a hold would leave it (the database's rules off for the set-up only). */
  async function statusOf(status: string): Promise<void> {
    await db.admin.query('BEGIN')
    try {
      await db.admin.query("SET LOCAL session_replication_role = 'replica'")
      await db.admin.query(`UPDATE "WorkOrder" SET status = $2::"WorkOrderStatus" WHERE id = $1`, [workOrder, status])
      await db.admin.query('COMMIT')
    } catch (error) {
      await db.admin.query('ROLLBACK')
      throw error
    }
  }

  it("lists only the newest order-change note of the work order, from the office, as CHECK; a plain note and a station's comment stay notes", async () => {
    const older = await orderChange("Modifica d'ordine su SEED-WO-0001 (P1): taglia 52 ora 3 (erano 4).", new Date(NOW.getTime() + 10_000))
    const newer = await orderChange('SEED-WO-0001 cambiato: taglia 52 3.', new Date(NOW.getTime() + 20_000))
    await writeRaw(workOrder, { kind: 'SYSTEM', authorName: 'SEW-02', text: 'A station said this after the change.', at: new Date(NOW.getTime() + 30_000) })
    const list = await messages()
    expect(list.map((message) => message.id)).not.toContain(older)
    const shown = list.find((message) => message.id === newer)
    expect(shown).toMatchObject({ kind: 'ORDER_CHANGE', check: 'CHECK', from: 'OFFICE', workOrder: { id: workOrder, number: 'SEED-WO-0001' } })
    expect(list.filter((message) => message.kind === 'ORDER_CHANGE')).toHaveLength(1)
    expect(list.find((message) => message.text === 'A station said this after the change.')).toMatchObject({ kind: 'NOTE', check: null, from: 'FLOOR' })
  })

  it('reads STOP while the work order is held, and CHECK again once it is not (never stored)', async () => {
    const [before] = await admin<{ status: string }>(`SELECT status::text AS status FROM "WorkOrder" WHERE id = $1`, [workOrder])
    await statusOf('ON_HOLD')
    try {
      expect((await messages()).find((message) => message.kind === 'ORDER_CHANGE')).toMatchObject({ check: 'STOP' })
    } finally {
      await statusOf(before!.status)
    }
    expect((await messages()).find((message) => message.kind === 'ORDER_CHANGE')).toMatchObject({ check: 'CHECK' })
  })

  it('records nothing about who or which station saw it (R2): the read writes no row and no route takes a "seen"', async () => {
    const count = async () => Number((await admin<{ n: string }>(`SELECT (SELECT count(*) FROM "AuditLog" WHERE "tenantId" = $1) + (SELECT count(*) FROM "OutboxEvent" WHERE "tenantId" = $1) AS n`, [T]))[0]!.n)
    const rows = await count()
    await messages()
    await messages('otherStation')
    expect(await count()).toBe(rows)
    const id = (await messages()).find((message) => message.kind === 'ORDER_CHANGE')!.id
    for (const url of [`/production/dispatch/mine/messages/${id}/seen`, `/production/dispatch/mine/messages/seen`]) {
      expect([404, 405], url).toContain((await call('operatorTablet', 'POST', url, { messageId: id })).statusCode)
    }
    expect(JSON.stringify(await messages())).not.toMatch(/seen|shown|offline/i)
  })
})

// ---- F-SA-247 (R2; 14-change-flow §5.3): one work order in hand — the operation and cutting screens read its notes before a Start -------
describe("one work order in hand: its notes at the tablet's own site, whatever its lists say (F-SA-247)", () => {
  const inHand = async (workOrderId: string, session = 'operatorTablet'): Promise<Json[]> => (await ok(session, 'GET', `/production/dispatch/mine/messages?workOrderId=${workOrderId}`)).messages

  it("reads a work order the tablet's queue and day do not list, and only that work order, in the same shape", async () => {
    await ok('supervisor', 'POST', `/threads/WorkOrder/${otherWorkOrder}/notes`, { body: 'A bundle of this one is worked off the plan (F-SA-247).', ...FOR_FLOOR }, 201)
    expect((await messages()).map((message) => message.text)).not.toContain('A bundle of this one is worked off the plan (F-SA-247).')
    const list = await inHand(otherWorkOrder)
    expect(list.map((message) => message.text)).toContain('A bundle of this one is worked off the plan (F-SA-247).')
    expect(new Set(list.map((message) => message.workOrder.id))).toEqual(new Set([otherWorkOrder]))
    expect(list.find((message) => message.text === 'A bundle of this one is worked off the plan (F-SA-247).')).toMatchObject({ workOrder: { id: otherWorkOrder, number: 'SEED-WO-0002' }, from: 'OFFICE', kind: 'NOTE', check: null })
    expect(Object.keys(list[0]!).sort()).toEqual(['at', 'check', 'cut', 'from', 'id', 'kind', 'text', 'workOrder'])
    expect(JSON.stringify(list)).not.toContain('Made-up')
  })

  it("lists the work order's newest order change as on the lists (CHECK), and leaves out this station's own comment", async () => {
    const own = (await inHand(workOrder)).map((message) => message.id)
    const fromLists = (await messages()).filter((message) => message.workOrder.id === workOrder).map((message) => message.id)
    expect(own).toEqual(fromLists)
    expect((await inHand(workOrder)).filter((message) => message.kind === 'ORDER_CHANGE')).toHaveLength(1)
    expect((await inHand(workOrder)).find((message) => message.kind === 'ORDER_CHANGE')).toMatchObject({ check: 'CHECK' })
    expect((await inHand(workOrder)).map((message) => message.text)).not.toContain('This station wrote this.')
  })

  it("reads nothing for an unknown work order or one of another site: never a refusal that would say it exists", async () => {
    expect(await inHand(newId())).toEqual([])
    expect(await inHand(workOrder, 'otherSite')).toEqual([])
  })

  it('keeps the rules of a floor read: a malformed id is refused in words, floor.work and the floor only', async () => {
    const malformed = await call('operatorTablet', 'GET', '/production/dispatch/mine/messages?workOrderId=not-an-id')
    expect(malformed.statusCode).toBe(400)
    expect(((malformed.json().error?.issues ?? []) as Json[]).map((issue) => issue.path)).toEqual(['querystring/workOrderId'])
    expect((await call('noWork', 'GET', `/production/dispatch/mine/messages?workOrderId=${workOrder}`)).statusCode).toBe(403)
    expect((await call('supervisor', 'GET', `/production/dispatch/mine/messages?workOrderId=${workOrder}`)).statusCode).toBe(403)
  })

  it('records nothing about who or which tablet read it (R2): the read writes no row', async () => {
    const count = async () => Number((await admin<{ n: string }>(`SELECT (SELECT count(*) FROM "AuditLog" WHERE "tenantId" = $1) + (SELECT count(*) FROM "OutboxEvent" WHERE "tenantId" = $1) AS n`, [T]))[0]!.n)
    const rows = await count()
    await inHand(workOrder)
    await inHand(otherWorkOrder, 'otherStation')
    expect(await count()).toBe(rows)
  })
})
// ---- end F-SA-247
