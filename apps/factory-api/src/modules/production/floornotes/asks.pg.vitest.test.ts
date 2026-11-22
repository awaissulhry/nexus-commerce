import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * B-OF-034 (order files tab, PR S2.4; design order-files-2026-11-22 13-backend §2; Owner D2; worker privacy W1, Statuto art. 4) — the
 * office's asks for files on the tablet, on the local stack with the app's real routes (a throwaway PostgreSQL 17 database from the
 * migrations; the runtime login: row-level security and …_order_files_guards are real; the seeds' SEED-WO-0001 at plant A1 for P1's
 * SEED-SO-0002, A1's team L1-A with the team leader E2 in it, the team leader's tablet at SEW-02):
 *
 *   - GET /production/floor-notes/asks: the team leader's tablet lists its team's ask (and its floor role's), never one of another
 *     team, never another plant's; what it reads names no worker, no price, no customer name (the customer's code)
 *   - the photo with `askId` (tile ASKED_FILE): in the note's own command the ask goes OPEN → ARRIVED with the note's files, answered
 *     by the floor (answeredById null), the asker's "Check: …" Task written; the answer says `ask.answered`
 *   - an ask closed meanwhile: the note and its photo post as any note, the ask is left as it is (`ask.answered` false)
 *   - the office's read of the order names "the floor", never the worker
 *
 * Every name and number is made up. Not run in the build (Owner rule: checks at the end). Run with
 * `node scripts/factory/run-pg-tests.mjs production/floornotes/asks`.
 */

type Json = Record<string, any>

const NS = 'of034-floor-asks'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const P1 = idOf('party:P1')
const SO2 = idOf('production:sales-order:SO-0002')
const WO1 = idOf('production:work-order:WO-0001')
const SEW = idOf('production:WO-0001:operation:20')
const TEAM_A1 = idOf('people:team:A1:L1-A')
const lead = idOf('worker:A1:lead')
const operator = idOf('worker:A1:operator')
const owner = idOf('actor')
const leadTablet = newId()
const otherTablet = newId()

const floorGrant = (permissions: Permission[]): Grant[] => [{ permissions, companies: [companyA], sites: [siteA1], parties: 'all' }]
const SESSIONS: Record<string, SessionContext> = {
  // The team leader at SEW-02, on the scans' permission (a photo or a comment from the floor).
  leadTablet: { audience: 'floor', tenantId: T, actorId: lead, siteId: siteA1, deviceId: leadTablet, grants: floorGrant(['production.scan']) },
  otherSite: { audience: 'floor', tenantId: T, actorId: operator, siteId: idOf('site:B1'), deviceId: otherTablet, grants: [{ permissions: ['production.scan'], companies: [idOf('company:B')], sites: [idOf('site:B1')], parties: 'all' }] },
  // An office reader of the order and its files.
  office: { audience: 'office', tenantId: T, actorId: owner, grants: [{ permissions: ['orders.view', 'files.read', 'workorders.view', 'threads.read'], companies: 'all', sites: 'all', parties: 'all' }] },
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `of034-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const asksOnTablet = async (session = 'leadTablet'): Promise<Json[]> => (await ok(session, 'GET', '/production/floor-notes/asks')).asks
const askRow = async (id: string) => (await admin<Json>(`SELECT status::text AS status, "fileIds"::text[] AS "fileIds", "answeredAt", "answeredById", "checkTaskId", version FROM "FileAsk" WHERE id = $1`, [id]))[0]!
const office = () => ({ audience: 'office' as const, tenantId: T, actorId: owner })

/** An ask on SEED-WO-0001 (plant A1) written as the asks' commands write it (the office scope: the guard is real); its id. */
async function floorAsk(extra: Json): Promise<string> {
  const id = newId()
  await database.withScope(office(), (client) =>
    client.fileAsk.create({
      data: { id, companyId: companyA, partyId: P1, siteId: siteA1, salesOrderId: SO2, target: 'WORK_ORDER', workOrderId: WO1, workOrderOperationId: SEW, words: 'Made-up: photos of the sewn body', fileKind: 'PHOTO', addressee: 'FLOOR_TEAM', addresseeTeamId: TEAM_A1, dueOn: new Date('2026-11-20T00:00:00.000Z'), askedById: owner, ...extra },
      select: { id: true },
    }),
  )
  return id
}

/** A photo the tablet took and confirmed: a PHOTO file of SEED-WO-0001 shared with A1's floor (no office person made it). */
async function photo(): Promise<string> {
  const id = newId()
  const at = new Date()
  await database.withScope(office(), (client) =>
    client.storedFile.createMany({
      data: [
        seedFile(T, {
          id,
          companyId: companyA,
          recordType: 'WorkOrder',
          recordId: WO1,
          kind: 'PHOTO',
          originalName: `Made-up photo ${id.slice(0, 8)}.jpg`,
          contentType: 'image/jpeg',
          sizeBytes: 4096,
          storageKey: `t/${T}/c/${companyA}/2026/${newId()}`,
          visibility: ['OFFICE', 'FLOOR'],
          floorSiteId: siteA1,
          partyId: null,
          status: 'AVAILABLE',
          availableAt: at,
          storeAccountId: idOf('files:account:r2'),
          createdAt: at,
          updatedAt: at,
          createdById: null,
        }),
      ],
    }),
  )
  return id
}

const note = (extra: Json): Json => ({ clientEventId: `of034-${run}-${++keys}`, tileCode: 'ASKED_FILE', workOrderOperationId: SEW, ...extra })

beforeAll(async () => {
  db = await migratedDatabase('floor_asks')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedPeople({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Made-up sewing tablet 2', 'TABLET', 'ACTIVE', now())`, [leadTablet, T, companyA, siteA1, idOf('site:A1:station:SEW-02')])
  // Plant B1's tablet, at no station.
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, NULL, 'Made-up B1 tablet', 'TABLET', 'ACTIVE', now())`, [otherTablet, T, idOf('company:B'), idOf('site:B1')])
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
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-OF-034 the office’s asks for files on the tablet', () => {
  it('the team leader’s tablet lists its team’s ask and its floor role’s; another team’s and another plant’s never', async () => {
    const team = await floorAsk({})
    const [held] = await admin<{ roleId: string }>(`SELECT "roleId" FROM "WorkerRole" WHERE "tenantId" = $1 AND "workerId" = $2 AND "siteId" = $3 AND "endedAt" IS NULL LIMIT 1`, [T, lead, siteA1])
    expect(held, 'the team leader holds a floor role at A1 (seed/floor-auth.ts)').toBeDefined()
    const role = await floorAsk({ addressee: 'FLOOR_ROLE', addresseeTeamId: null, addresseeRoleId: held!.roleId, workOrderOperationId: null })
    const listed = await asksOnTablet()
    const ids = listed.map((row) => row.askId)
    expect(ids).toContain(team)
    expect(ids).toContain(role)
    const shown = listed.find((row) => row.askId === team)!
    expect(shown).toMatchObject({ words: 'Made-up: photos of the sewn body', fileKind: 'PHOTO', dueOn: '2026-11-20', workOrder: { id: WO1 }, step: { id: SEW, seq: 20 }, askedAgain: null, chasedAt: null })
    expect(shown.lateDays).toBeGreaterThan(0)
    // The customer's code at most, never its name; no worker, no price, no person.
    const text = JSON.stringify(listed)
    for (const word of [lead, operator, owner, 'answeredBy', 'priced']) expect(text).not.toContain(word)
    // Another plant's tablet reads none of A1's asks.
    expect((await asksOnTablet('otherSite')).map((row) => row.askId)).not.toContain(team)
  })

  it('an ask to another team is not this tablet’s', async () => {
    // B1's team cannot be asked on A1's work order (the guard: a team of the work order's site), so another A1 team stands in.
    const other = newId()
    await admin(`INSERT INTO "Team" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, $5, 'Made-up other team')`, [other, T, companyA, siteA1, `T-OF034-${run}`])
    const ask = await floorAsk({ addresseeTeamId: other })
    expect((await asksOnTablet()).map((row) => row.askId)).not.toContain(ask)
  })

  it('the photo with askId answers the ask in the note’s own command: ARRIVED, by the floor, the asker’s check task', async () => {
    const ask = await floorAsk({})
    const file = await photo()
    const posted = await ok('leadTablet', 'POST', `/production/floor-notes/work-orders/${WO1}`, note({ askId: ask, fileIds: [file] }), 201)
    expect(posted).toMatchObject({ files: 1, ask: { id: ask, answered: true } })
    const row = await askRow(ask)
    expect(row).toMatchObject({ status: 'ARRIVED', fileIds: [file], answeredById: null, version: 2 })
    expect(row.answeredAt).not.toBeNull()
    const [check] = await admin<Json>(`SELECT "assigneeId", status::text AS status, "recordType", "recordId", "createdById", title FROM "Task" WHERE id = $1`, [row.checkTaskId])
    expect(check).toMatchObject({ assigneeId: owner, status: 'OPEN', recordType: 'SalesOrder', recordId: SO2, createdById: null })
    const [audit] = await admin<Json>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'FileAsk' AND "recordId" = $2 AND action = 'files.fileAsk.answer'`, [T, ask])
    expect(audit!.after).toMatchObject({ by: 'FLOOR', status: 'ARRIVED' })
    expect(JSON.stringify(audit!.after)).not.toContain(lead)
    const [event] = await admin<Json>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'file_ask.arrived' AND payload->>'askId' = $2`, [T, ask])
    expect(event!.payload).toEqual({ askId: ask, salesOrderId: SO2, workOrderId: WO1, status: 'ARRIVED', partyId: P1 })
    // It leaves the tablet's list.
    expect((await asksOnTablet()).map((entry) => entry.askId)).not.toContain(ask)
    // The office reads "the floor", never the worker.
    const list = await ok('office', 'GET', `/sales/orders/${SO2}/files`)
    const arrived = (list.asks as Json[]).find((entry) => entry.id === ask)!
    expect(arrived.answered.by).toEqual({ kind: 'FLOOR' })
    expect(JSON.stringify(list.asks)).not.toContain(lead)
  })

  it('an ask closed meanwhile: the note and the photo post as any note, the ask stays as it is', async () => {
    const ask = await floorAsk({})
    await database.withScope(office(), (client) => client.fileAsk.update({ where: { id: ask }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: owner, cancelReason: 'Made-up: found it in the office.', version: 2 }, select: { id: true } }))
    const file = await photo()
    const posted = await ok('leadTablet', 'POST', `/production/floor-notes/work-orders/${WO1}`, note({ askId: ask, fileIds: [file] }), 201)
    expect(posted).toMatchObject({ files: 1, ask: { id: ask, answered: false } })
    expect(await askRow(ask)).toMatchObject({ status: 'CANCELLED', fileIds: [], version: 2 })
    const [message] = await admin<Json>(`SELECT "attachmentFileIds"::text[] AS files FROM "Message" WHERE id = $1`, [posted.messageId])
    expect(message!.files).toEqual([file])
  })

  it('a photo for an ask needs its photo (400); a plain note answers no ask', async () => {
    const ask = await floorAsk({})
    const refused = await call('leadTablet', 'POST', `/production/floor-notes/work-orders/${WO1}`, note({ askId: ask }))
    expect(refused.statusCode, refused.body).toBe(400)
    const plain = await ok('leadTablet', 'POST', `/production/floor-notes/work-orders/${WO1}`, note({ tileCode: 'DAMAGED' }), 201)
    expect(plain.ask).toBeNull()
    expect((await askRow(ask)).status).toBe('OPEN')
  })
})
