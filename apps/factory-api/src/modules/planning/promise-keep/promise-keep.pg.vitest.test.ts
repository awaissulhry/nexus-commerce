import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanningDepth } from '../../../../../../packages/factory-db/seed/planning-depth'
import { seed as seedQuality } from '../../../../../../packages/factory-db/seed/quality'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Keeping promises (B-W2b-317; PLN-173, PLN-174, PLN-175, PLN-200) on the local stack with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, grants and the PromiseRecord /
 * PlanningException / Task triggers are real), the factory-db seeds up to the planning depth (SEED-SO-0001 promised and
 * re-promised, SEED-SO-0002 and its work orders, SEED-PO-0001's leather the plan counts on, run 1), the quality seed's
 * SEED-SO-0003 and certificates, the e-mail seed's sending identities. Every name, address and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/promise-keep`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'keep-a'
const tenant = seedUuid(ns, 'tenant')
const A: Record<string, string> = {}

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, grants: [grant(permissions)] })
const PLANNER: Permission[] = ['planning.promise.view', 'planning.promise.manage', 'planning.view', 'planning.exceptions.manage', 'orders.view', 'quotes.view', 'purchasing.view', 'purchasing.manage']
const SALES: Permission[] = ['planning.promise.view', 'orders.view', 'orders.manage', 'email.send', 'threads.read', 'threads.post', 'home.view', 'tasks.manage']
const SESSIONS: Record<string, SessionContext> = {}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `keep-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const one = async (sql: string, values: unknown[] = []): Promise<string> => (await admin<{ id: string }>(sql, values))[0]!.id
// node-postgres reads a date column as local midnight: its local parts are the day.
const dayOfRow = (value: Date | string): string => (value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value).slice(0, 10))
let today = ''

const lineOf = (list: Json, lineId: string | undefined): Json => (list.lines as Json[]).find((line) => line.id === lineId)!
const sizeOf = (line: Json, size: string): Json => (line.sizes as Json[]).find((entry) => entry.size === size)!

beforeAll(async () => {
  db = await migratedDatabase('promise_keep')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedAuth({ db: database, namespace: ns })
  await seedCalendar({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedEmail({ db: database, namespace: ns })
  await seedPlanningDepth({ db: database, namespace: ns })
  await seedQuality({ db: database, namespace: ns })
  await seedSales({ db: database, namespace: ns })
  A.site = await one(`SELECT id FROM "Site" WHERE code = 'A1'`)
  A.company = await one(`SELECT "companyId" AS id FROM "Site" WHERE id = $1`, [A.site])
  A.jkt02 = await one(`SELECT id FROM "Style" WHERE code = 'SEED-JKT-02'`)
  A.so1 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0001'`)
  A.so2 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0002'`)
  A.so3 = await one(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0003'`)
  const lineByColour = (orderId: string, colour: string) => one(`SELECT l.id FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 AND c.code = $2`, [orderId, colour])
  A.so1Blk = await lineByColour(A.so1, 'BLK')
  A.so1Red = await lineByColour(A.so1, 'RED')
  A.so2Blk = await lineByColour(A.so2, 'BLK')
  A.so2Red = await lineByColour(A.so2, 'RED')
  A.so3Line = await one(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [A.so3])
  A.po1 = await one(`SELECT id FROM "PurchaseOrder" WHERE number = 'SEED-PO-0001'`)
  A.po1Line10 = await one(`SELECT id FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 AND seq = 10`, [A.po1])
  // Sales is a real office user (the mail to the customer is sent from a person); the planners are other people.
  const member = await one(`SELECT id FROM "User" WHERE email = $1`, [`member.${ns}@example.com`])
  SESSIONS.planner = office(PLANNER)
  SESSIONS.planner2 = office(PLANNER)
  SESSIONS.sales = office(SALES, member)
  // One person with both the planner's and sales' rights: never decides their own re-promise.
  SESSIONS.both = office([...PLANNER, ...SALES])
  SESSIONS.viewer = office(['planning.view', 'planning.promise.view', 'orders.view'])
  today = businessDate(new Date(), 'Europe/Rome')
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 480_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('one promise history per line (PLN-173)', { timeout: 180_000 }, () => {
  it("W1's promise change keeps the first promise and writes every new date as a row with its reason", async () => {
    const order = (await admin<{ promiseDate: Date; originalPromiseDate: Date; version: number }>(`SELECT "promiseDate", "originalPromiseDate", version FROM "SalesOrder" WHERE id = $1`, [A.so3]))[0]!
    const first = dayOfRow(order.originalPromiseDate)
    const later = plusDays(dayOfRow(order.promiseDate), 7)
    await ok('sales', 'PUT', `/sales/orders/${A.so3}/promise`, { version: order.version, promiseDate: later, reason: 'MATERIAL_LATE: made-up hides batch late' }, key())
    const rows = await admin<{ size: string | null; promisedDate: Date; kind: string; reasonCode: string | null; reason: string | null; customerToldAt: Date | null }>(`SELECT size, "promisedDate", kind::text AS kind, "reasonCode", reason, "customerToldAt" FROM "PromiseRecord" WHERE "salesOrderLineId" = $1 ORDER BY "promisedAt", id`, [A.so3Line])
    expect(rows.map((row) => [row.size, dayOfRow(row.promisedDate), row.kind, row.reasonCode])).toEqual([
      [null, first, 'FIRST', null],
      [null, later, 'RE_PROMISE', 'MATERIAL_LATE'],
    ])
    expect(rows[1]!.reason).toBe('MATERIAL_LATE: made-up hides batch late')
    expect(rows[1]!.customerToldAt).toBeNull()

    const history = await ok('planner', 'GET', `/planning/promises/order-lines/${A.so3Line}/history`)
    expect(history).toMatchObject({ first, current: later, changes: 1, slips: 1, order: { number: 'SEED-SO-0003', originalPromiseDate: first } })
    expect(history.rows[0]).toMatchObject({ kind: 'FIRST', promisedDate: first })
    expect(history.rows[1]).toMatchObject({ kind: 'RE_PROMISE', promisedDate: later, reasonCode: 'MATERIAL_LATE', reasonWords: { en: 'Material delivery late' }, shiftDays: 7, promisedBy: { name: 'Seed Member' } })
    expect(history.rows[1].words).toMatch(/^Every size: re-promised \d{1,2} [A-Z][a-z]{2}( \d{4})? \(\+7 days\) · Material delivery late\.$/)

    // Back three days earlier: one more change, no more slips; the first promise stays.
    const version = (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [A.so3]))[0]!.version
    await ok('sales', 'PUT', `/sales/orders/${A.so3}/promise`, { version, promiseDate: plusDays(later, -3), reason: 'Ready earlier than planned' }, key())
    const again = await ok('planner', 'GET', `/planning/promises/order-lines/${A.so3Line}/history`)
    expect(again).toMatchObject({ first, current: plusDays(later, -3), changes: 2, slips: 1 })
    expect(again.rows[2]).toMatchObject({ reasonCode: 'EARLIER', shiftDays: -3 })
  })

  it('refuses (DB) to change or remove a promise row: the history is append-only', async () => {
    await expect(admin(`UPDATE "PromiseRecord" SET "promisedDate" = "promisedDate" + 1 WHERE "salesOrderLineId" = $1`, [A.so3Line])).rejects.toThrow()
    await expect(admin(`DELETE FROM "PromiseRecord" WHERE "salesOrderLineId" = $1`, [A.so3Line])).rejects.toThrow()
  })
})

describe('orders at risk (PLN-174)', { timeout: 300_000 }, () => {
  it('lists the open lines with their first and current promise, the planned finish, slack, risk and the tiles', async () => {
    // SEED-SO-0001 BLK size 50 was promised for yesterday (made-up, after the order's date): it is late now.
    await admin(
      `INSERT INTO "PromiseRecord" (id, "tenantId", "salesOrderLineId", "partyId", size, "promisedDate", kind, "reasonCode", "promisedById", "promisedAt")
       SELECT $1, l."tenantId", l.id, l."partyId", '50', $2::date, 'RE_PROMISE', 'PLANNING', o."createdById", now() - interval '1 hour' FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE l.id = $3`,
      [newId(), plusDays(today, -1), A.so1Blk],
    )
    // The certificate of SEED-JKT-02 covers sizes 50 and 52 only: SEED-SO-0002's size 54 has no valid certificate.
    await admin(`UPDATE "CertificateCoverage" SET sizes = ARRAY['50','52'] WHERE "styleId" = $1`, [A.jkt02])

    const list = await ok('planner', 'GET', `/planning/promises?siteId=${A.site}`)
    expect(list).toMatchObject({ site: { id: A.site, code: 'A1' }, today, complete: true })
    // SEED-SO-0001 RED: the first promise kept (18 Dec in the seed), size 52 re-promised later (a slip).
    const red = lineOf(list, A.so1Red)
    expect(red).toMatchObject({ order: { number: 'SEED-SO-0001' }, style: { code: expect.any(String) }, colourway: { code: 'RED' } })
    expect(sizeOf(red, '52').current > sizeOf(red, '52').first).toBe(true)
    expect(red.changes).toMatchObject({ count: 1, slips: 1 })
    // The late size makes the line late, and puts it in the At risk tile.
    const blk = lineOf(list, A.so1Blk)
    expect(sizeOf(blk, '50')).toMatchObject({ current: plusDays(today, -1), risk: 'LATE' })
    expect(blk.risk).toBe('LATE')
    expect(blk.tiles).toContain('AT_RISK')
    expect(blk.words).toMatch(/^SEED-SO-0001 line \d+ is late: promised /)
    // SEED-SO-0002 BLK: 54 has no valid certificate through its promised day.
    const so2 = lineOf(list, A.so2Blk)
    expect(sizeOf(so2, '54').certificate).toMatchObject({ state: 'MISSING' })
    expect(so2.tiles).toContain('NO_CERTIFICATE')
    expect(so2.order.backlogPosition).toBe(1)
    // Every open size: its risk is the rule's (promise against the planned finish), its slack the days between.
    for (const line of list.lines as Json[]) {
      for (const size of line.sizes as Json[]) {
        if (size.open === 0) continue
        const expected = size.current === null ? 'NOT_PROMISED' : size.current < today ? 'LATE' : size.finish === null || size.finish > size.current ? 'AT_RISK' : 'ON_TIME'
        expect(size.risk, `${line.order.number} ${size.size}`).toBe(expected)
        if (size.current && size.finish) expect(size.slackDays).toBe(Math.round((Date.parse(size.current) - Date.parse(size.finish)) / 86_400_000))
      }
    }
    // The tiles count the lines in them; the risk counts add up to the lines.
    expect(list.tiles.AT_RISK).toBe((list.lines as Json[]).filter((line) => line.risk === 'AT_RISK' || line.risk === 'LATE').length)
    expect(list.tiles.NO_CERTIFICATE).toBeGreaterThanOrEqual(1)
    expect(Object.values(list.counts as Record<string, number>).reduce((sum, count) => sum + count, 0)).toBe((list.lines as Json[]).filter((line) => line.risk !== null).length)
    // Late first.
    expect(list.lines[0].risk).toBe('LATE')
    // A saved filter, and no person in the list.
    const atRisk = await ok('planner', 'GET', `/planning/promises?siteId=${A.site}&tile=AT_RISK`)
    expect((atRisk.lines as Json[]).every((line) => line.tiles.includes('AT_RISK'))).toBe(true)
    expect(JSON.stringify(list)).not.toMatch(/promisedBy|proposedBy|displayName/)
  })

  it('refuses a reader without promise dates and an unknown site', async () => {
    await refused('viewer', 'GET', `/planning/promises?siteId=${newId()}`, undefined, 404)
    SESSIONS.plain = office(['planning.view', 'orders.view'])
    await refused('plain', 'GET', `/planning/promises?siteId=${A.site}`, undefined, 403)
  })
})

describe('the re-promise workflow (PLN-175)', { timeout: 300_000 }, () => {
  let proposalId = ''

  it('the draft: dates per size from the plan, the reasons, the message in the customer language', async () => {
    const draft = await ok('planner', 'GET', `/planning/promises/order-lines/${A.so2Blk}/re-promise`)
    expect(draft).toMatchObject({ order: { number: 'SEED-SO-0002' }, line: { id: A.so2Blk }, may: { propose: true }, waiting: null })
    expect(draft.reasons.map((reason: Json) => reason.code)).toContain('MATERIAL_LATE')
    expect(['it', 'en']).toContain(draft.language)
    expect(draft.plan.length).toBeGreaterThan(0)
  })

  it('planning proposes; it waits for sales as a task on the order', async () => {
    const body = { sizes: [{ size: '52', date: plusDays(today, 30) }], reasonCode: 'MATERIAL_LATE', reason: 'Made-up: the tannery moved the batch' }
    const { proposal } = await ok('planner', 'POST', `/planning/promises/order-lines/${A.so2Blk}/re-promise`, body, key())
    proposalId = proposal.id
    expect(proposal).toMatchObject({ state: 'WAITING', order: { number: 'SEED-SO-0002' }, reasonCode: 'MATERIAL_LATE', sizes: [{ size: '52', to: plusDays(today, 30) }], task: { status: 'OPEN' }, may: { withdraw: true, accept: false } })
    expect(proposal.message.body).toMatch(proposal.message.language === 'it' ? /taglia 52: .+ → / : /size 52: .+ → /)
    expect(proposal.message.body).not.toContain('tannery moved')
    const task = (await admin<{ status: string; recordType: string; recordId: string; title: string }>(`SELECT status::text AS status, "recordType", "recordId", title FROM "Task" WHERE id = $1`, [proposalId]))[0]!
    expect(task).toMatchObject({ status: 'OPEN', recordType: 'SalesOrder', recordId: A.so2, title: expect.stringMatching(/^Accept the new date: SEED-SO-0002 line \d+$/) })
    // One waits per line.
    const again = await refused('planner', 'POST', `/planning/promises/order-lines/${A.so2Blk}/re-promise`, body, 409)
    expect(again.message).toMatch(/already waits for sales/)
    // The tile and the waiting line.
    const list = await ok('planner', 'GET', `/planning/promises?siteId=${A.site}&tile=REPROMISE_WAITING`)
    expect(lineOf(list, A.so2Blk).waiting).toMatchObject({ proposalId })
    const waiting = await ok('sales', 'GET', `/planning/promises/re-promises?siteId=${A.site}`)
    expect(waiting.proposals.map((entry: Json) => entry.id)).toContain(proposalId)
    expect((waiting.proposals as Json[]).find((entry) => entry.id === proposalId)!.may).toMatchObject({ accept: true, tell: true, decline: true, withdraw: false })
  })

  it('refuses a person without sales rights, a date that is not new, and a size with no certificate', async () => {
    await refused('viewer', 'POST', `/planning/promises/re-promises/${proposalId}/accept`, { tell: false }, 403)
    const same = await refused('planner', 'POST', `/planning/promises/order-lines/${A.so2Red}/re-promise`, { sizes: [{ size: '50', date: plusDays(today, -1) }], reasonCode: 'CAPACITY' }, 400)
    expect(same.issues.map((issue: Json) => issue.path)).toContain('body/sizes/0/date')
    const uncertified = await refused('planner', 'POST', `/planning/promises/order-lines/${A.so2Blk}/re-promise`, { sizes: [{ size: '54', date: plusDays(today, 40) }], reasonCode: 'CAPACITY' }, 409)
    expect(uncertified.issues[0].path).toBe('body/sizes/0/date')
  })

  it('nobody decides their own re-promise; only the planner who proposed it takes it back', async () => {
    const { proposal } = await ok('both', 'POST', `/planning/promises/order-lines/${A.so2Red}/re-promise`, { sizes: [{ size: '52', date: plusDays(today, 35) }], reasonCode: 'CAPACITY' }, key())
    expect(proposal.may).toMatchObject({ accept: false, decline: false, withdraw: true })
    const own = await refused('both', 'POST', `/planning/promises/re-promises/${proposal.id}/accept`, { tell: false }, 409)
    expect(own.message).toBe('Nobody decides their own re-promise: another person of sales gives the word.')
    await refused('both', 'POST', `/planning/promises/re-promises/${proposal.id}/decline`, { reason: 'No' }, 409)
    const other = await refused('planner2', 'POST', `/planning/promises/re-promises/${proposal.id}/withdraw`, {}, 409)
    expect(other.message).toMatch(/Only the person who proposed it/)
    const withdrawn = await ok('both', 'POST', `/planning/promises/re-promises/${proposal.id}/withdraw`, {}, key())
    expect(withdrawn.proposal).toMatchObject({ state: 'WITHDRAWN', task: { status: 'CANCELLED' } })
  })

  it('sales accepts and tells the customer: the rows, the line date, the mail on the order thread, the task done', async () => {
    const accepted = await ok('sales', 'POST', `/planning/promises/re-promises/${proposalId}/accept`, { tell: true }, key())
    expect(accepted).toMatchObject({ told: true, outboundId: expect.any(String), proposal: { state: 'ACCEPTED', decision: { decision: 'ACCEPTED', told: true }, task: { status: 'DONE' } } })
    const reprom = (accepted.written as Json[]).find((row) => row.size === '52')!
    expect(reprom).toMatchObject({ kind: 'RE_PROMISE', promisedDate: plusDays(today, 30), reasonCode: 'MATERIAL_LATE' })
    // The row says when the customer was told; its plan version names the site's working plan.
    const row = (await admin<{ customerToldAt: Date | null; siteId: string | null }>(`SELECT "customerToldAt", "siteId" FROM "PromiseRecord" WHERE id = $1`, [reprom.id]))[0]!
    expect(row.customerToldAt).not.toBeNull()
    // The line's date (W1) follows its latest size, through W1's change: the order's history and the portal read it.
    expect(accepted.lineDate).toBe(plusDays(today, 30))
    const line = (await admin<{ promiseDate: Date }>(`SELECT "promiseDate" FROM "SalesOrderLine" WHERE id = $1`, [A.so2Blk]))[0]!
    expect(dayOfRow(line.promiseDate)).toBe(plusDays(today, 30))
    const moved = await admin<{ reason: string }>(`SELECT reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'orders.changePromise' ORDER BY at DESC LIMIT 1`, [A.so2])
    expect(moved[0]!.reason).toBe('MATERIAL_LATE: re-promise accepted')
    // The message: an outbound mail on the order's thread, queued for the worker (the FAKE provider here).
    const mail = (await admin<{ status: string; recordType: string }>(`SELECT o.status::text AS status, t."recordType" FROM "EmailOutbound" o JOIN "Thread" t ON t.id = o."threadId" WHERE o.id = $1`, [accepted.outboundId]))[0]!
    expect(mail).toEqual({ status: 'QUEUED', recordType: 'SalesOrder' })
    // Decided once.
    await refused('sales', 'POST', `/planning/promises/re-promises/${proposalId}/accept`, { tell: false }, 409)
    const history = await ok('sales', 'GET', `/planning/promises/order-lines/${A.so2Blk}/history`)
    expect((history.rows as Json[]).some((entry) => entry.id === reprom.id && entry.customerToldAt !== null && entry.promisedBy?.name === 'Seed Member')).toBe(true)
    expect(history.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposalId, state: 'ACCEPTED', told: true })]))
  })

  it('sales declines with its words; nothing is promised', async () => {
    const before = await admin(`SELECT id FROM "PromiseRecord" WHERE "salesOrderLineId" = $1`, [A.so2Red])
    const { proposal } = await ok('planner', 'POST', `/planning/promises/order-lines/${A.so2Red}/re-promise`, { sizes: [{ size: '50', date: plusDays(today, 45) }], reasonCode: 'CAPACITY' }, key())
    const declined = await ok('sales', 'POST', `/planning/promises/re-promises/${proposal.id}/decline`, { reason: 'Made-up: the customer cannot take it later' }, key())
    expect(declined.proposal).toMatchObject({ state: 'DECLINED', decision: { decision: 'DECLINED', reason: 'Made-up: the customer cannot take it later' }, task: { status: 'CANCELLED' } })
    expect(await admin(`SELECT id FROM "PromiseRecord" WHERE "salesOrderLineId" = $1`, [A.so2Red])).toHaveLength(before.length)
  })

  it('a promise that changed since the proposal makes it stale (propose again)', async () => {
    const { proposal } = await ok('planner', 'POST', `/planning/promises/order-lines/${A.so2Red}/re-promise`, { sizes: [{ size: '52', date: plusDays(today, 20) }], reasonCode: 'CAPACITY' }, key())
    // The planner records size 52 apart meanwhile (B-W2b-301's record).
    await ok('planner', 'POST', `/planning/promise/order-lines/${A.so2Red}`, { sizes: [{ size: '52', date: plusDays(today, 25) }], reasonCode: 'CAPACITY' }, key())
    const stale = await refused('sales', 'POST', `/planning/promises/re-promises/${proposal.id}/accept`, { tell: false }, 409)
    expect(stale.message).toBe('The promise changed since this re-promise was proposed: propose it again from the dates now.')
  })
})

describe('a late supplier date replans what it feeds (PLN-200)', { timeout: 300_000 }, () => {
  let exceptionId = ''

  it("the supplier's later date opens a 'Supply too late' exception now, with its fixes", async () => {
    const version = (await admin<{ version: number }>(`SELECT version FROM "PurchaseOrder" WHERE id = $1`, [A.po1]))[0]!.version
    await ok('planner', 'POST', `/purchasing/orders/${A.po1}/lines/${A.po1Line10}/supplier-date`, { version, date: plusDays(today, 40), source: 'SUPPLIER', reason: 'Made-up: the tannery moved the batch', supplierContactName: 'Made-up Contact' }, key())
    const checked = await ok('planner', 'POST', '/planning/exceptions/supply-late/check', { purchaseOrderId: A.po1 }, key())
    expect(checked).toMatchObject({ checked: true, siteId: A.site })
    expect(checked.raised + checked.stillOpen).toBeGreaterThanOrEqual(1)
    const late = (checked.view.exceptions as Json[]).find((entry) => entry.purchaseOrderLineId === A.po1Line10)!
    expect(late).toMatchObject({ foundBy: 'SUPPLIER_DATE', supplyDate: plusDays(today, 40), status: 'NEW' })
    expect(late.daysLate).toBeGreaterThan(0)
    expect(late.fixes.chase).toMatchObject({ purchaseOrder: { number: 'SEED-PO-0001' }, line: { id: A.po1Line10, seq: 10 }, supplyDate: plusDays(today, 40) })
    expect(late.fixes.chase.words).toMatch(/^Chase SEED-PO-0001 line 10: /)
    expect(late.fixes.repromise.length).toBeGreaterThanOrEqual(1)
    for (const fix of late.fixes.repromise as Json[]) expect(fix.words).toMatch(/^SEED-SO-\d+ line \d+ /)
    expect(Array.isArray(late.fixes.move) && Array.isArray(late.fixes.buyElsewhere)).toBe(true)
    exceptionId = late.id
    const list = await ok('viewer', 'GET', `/planning/exceptions/supply-late?siteId=${A.site}`)
    expect(list.tile).toBeGreaterThanOrEqual(1)
    const one_ = await ok('viewer', 'GET', `/planning/exceptions/${exceptionId}/fixes`)
    expect(one_).toMatchObject({ id: exceptionId, foundBy: 'SUPPLIER_DATE' })
    // The run's queue shows it too (B-W2a-22's list).
    const queue = await ok('planner', 'GET', `/planning/exceptions?siteId=${A.site}`)
    expect((queue.exceptions as Json[]).some((entry) => entry.id === exceptionId && entry.kind === 'SUPPLY_LATE')).toBe(true)
  })

  it('refuses a check without exception rights and the fixes of another kind', async () => {
    await refused('viewer', 'POST', '/planning/exceptions/supply-late/check', { purchaseOrderId: A.po1 }, 403)
    const short = await one(`SELECT id FROM "PlanningException" WHERE kind = 'SHORT' LIMIT 1`)
    await refused('viewer', 'GET', `/planning/exceptions/${short}/fixes`, undefined, 404)
  })

  it('the date back in time clears it', async () => {
    const version = (await admin<{ version: number }>(`SELECT version FROM "PurchaseOrder" WHERE id = $1`, [A.po1]))[0]!.version
    await ok('planner', 'POST', `/purchasing/orders/${A.po1}/lines/${A.po1Line10}/supplier-date`, { version, date: plusDays(today, 1), source: 'SUPPLIER', reason: 'Made-up: the batch is back on time', supplierContactName: 'Made-up Contact' }, key())
    const checked = await ok('planner', 'POST', '/planning/exceptions/supply-late/check', { purchaseOrderId: A.po1 }, key())
    expect(checked.cleared).toBeGreaterThanOrEqual(1)
    const row = (await admin<{ status: string; resolution: string }>(`SELECT status::text AS status, resolution::text AS resolution FROM "PlanningException" WHERE id = $1`, [exceptionId]))[0]!
    expect(row).toEqual({ status: 'RESOLVED', resolution: 'CLEARED' })
  })
})
