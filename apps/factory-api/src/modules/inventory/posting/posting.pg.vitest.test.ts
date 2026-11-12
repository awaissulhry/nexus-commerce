import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lowStockFindings } from '../low-stock/alerts'

/**
 * B-W2b-314 — why is it this number, posting dates, low stock, adjustments above a value wait for a yes — on the local stack
 * with the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security,
 * grants and the …_warehouse_depth_w2b_guards and …_approvals_w2b_guards triggers are real), the seeds of one tenant up to
 * planning (the grey lining kept between 50 and 300 m at A1, the protector's reorder point 24) and, on top, made-up stock at
 * A1 (a grey lining lot of 200 m, a protector lot of 10 pieces) and made-up office people:
 *   - the warehouse rules (posting dates, the adjustment value, the low-stock alerts): in force and where from, a tighter rule
 *     saved, a looser one asks the reason and a fresh code, the value only with the cost grain;
 *   - a posting date apart from the entry time, within the back-dating days, never after today (SCM-196); the Movements read
 *     shows it and filters by it;
 *   - an adjustment above the value waits for a yes only when an approval rule says who; nobody approves their own; the yes
 *     posts it; a move of the stock before the yes makes it stale;
 *   - the balance bridge of a figure over a period (SCM-191); below the minimum: the tile and the alert rule's finder (SCM-281).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/posting`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'inventory-posting-w2b314'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  bin: idOf('inventory:location:A1-STORE-01'),
}
const PEOPLE = { keeper: newId(), warehouse: newId(), finance: newId() } as const
const NAMES = { keeper: 'Made-up Keeper', warehouse: 'Made-up Warehouse', finance: 'Made-up Finance' } as const

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (actorId: string, permissions: Permission[], companies: Grant['companies'] = 'all'): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants: [grant(permissions, companies)] })
const STOCK: Permission[] = ['inventory.stock.view', 'inventory.adjust', 'inventory.transfer', 'inventory.scrap', 'inventory.reverse', 'inventory.rules.manage', 'reasons.view', 'approvals.view', 'approvals.request', 'approvals.decide']
const SESSIONS: Record<string, SessionContext> = {
  /** Adjusts with a typed cost (the cost grain). */
  keeper: office(PEOPLE.keeper, [...STOCK, 'money.cost']),
  /** The warehouse template's view: no cost. */
  warehouse: office(PEOPLE.warehouse, STOCK),
  /** Keeps the adjustment value (the cost grain) and approves. */
  finance: office(PEOPLE.finance, ['inventory.stock.view', 'inventory.rules.manage', 'money.cost', 'approvals.view', 'approvals.decide']),
  viewer: office(newId(), ['inventory.stock.view']),
  'company-b': office(newId(), ['inventory.stock.view', 'inventory.rules.manage'], [idOf('company:B')]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b314-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)

const today = businessDate(new Date())
let liningLot: string
const lining = (direction: 'IN' | 'OUT', quantity: string, extra: Json = {}) => ({ siteId: A.siteA1, itemId: A.lining, itemColourId: A.liningGRY, lotId: liningLot, locationId: A.bin, direction, quantity, note: 'Made-up count correction', ...extra })
const onHand = async () =>
  (await one<{ n: string }>(
    `SELECT (coalesce(sum(CASE WHEN "toLocationId" = $2 THEN "baseQuantity" END), 0) - coalesce(sum(CASE WHEN "fromLocationId" = $2 THEN "baseQuantity" END), 0))::text AS n FROM "StockMove" WHERE "tenantId" = $1 AND "lotId" = $3`,
    [A.tenant, A.bin, liningLot],
  )).n

async function addLot(itemId: string, colourId: string | null, quantity: string, uom: string): Promise<string> {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViStatus", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), false, 'NOT_REQUIRED', now() - interval '20 days')`,
    [lotId, A.tenant, A.companyA, A.siteA1, itemId, colourId, `T-${run}-${itemId.slice(-4)}`],
  )
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", note)
     VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $9, $11, now() - interval '30 days', 'Made-up opening stock')`,
    [newId(), A.tenant, A.companyA, A.siteA1, itemId, colourId, lotId, A.bin, quantity, uom, `w2b314-${run}-${lotId}`],
  )
  return lotId
}

beforeAll(async () => {
  db = await migratedDatabase('inventory_posting')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  await seedPlanning({ db: database, namespace: ns })
  for (const [person, userId] of Object.entries(PEOPLE) as Array<[keyof typeof PEOPLE, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, A.tenant, `w2b314-${person}-${run}@example.com`, NAMES[person]])
  }
  liningLot = await addLot(A.lining, A.liningGRY, '200.0000', 'M')
  await addLot(A.protector, null, '10.0000', 'PCS')
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the warehouse rules (ws-posting, ws-adjust, the low-stock alerts)', () => {
  it('reads what is in force and from where; the value only with the cost grain', async () => {
    const rules = await ok('warehouse', 'GET', `/inventory/rules?companyId=${A.companyA}`)
    expect(rules).toMatchObject({ companyId: A.companyA, version: 0, changedBy: null, mayChange: true, postingDates: { own: null, inForce: { days: null, source: 'DEFAULT' }, today, earliest: null }, lowStockAlerts: { inForce: { on: true, source: 'DEFAULT' } } })
    expect(rules.adjustmentApproval).toMatchObject({ inForce: { source: 'DEFAULT', set: false }, currency: 'EUR', approvalRules: { active: 0 }, held: expect.stringContaining('a cost') })
    expect(rules.adjustmentApproval.inForce.amount).toBeUndefined()
    expect((await ok('finance', 'GET', `/inventory/rules?companyId=${A.companyA}`)).adjustmentApproval).toMatchObject({ own: null, inForce: { amount: null }, held: null })
    await no('company-b', 'GET', `/inventory/rules?companyId=${A.companyA}`, undefined, 404)
  })

  it('saves a tighter rule at once; a looser one asks the reason, then a fresh code', async () => {
    const saved = await ok('warehouse', 'PUT', '/inventory/rules/posting-dates', { companyId: A.companyA, version: 0, backDatingDays: 3 })
    expect(saved).toMatchObject({ loosened: false, rules: { version: 1, changedBy: { name: NAMES.warehouse }, postingDates: { own: 3, inForce: { days: 3, source: 'COMPANY' }, earliest: plusCalendarDays(today, -3) } } })
    expect(await outbox('inventory.rules_changed')).toEqual([{ companyId: A.companyA, card: 'POSTING_DATES', fields: ['backDatingDays'], loosened: false }])
    // Saved as it is: kept as an attempt, nothing written or told.
    expect((await ok('warehouse', 'PUT', '/inventory/rules/posting-dates', { companyId: A.companyA, version: 1, backDatingDays: 3 })).rules.version).toBe(1)
    expect(paths(await no('warehouse', 'PUT', '/inventory/rules/posting-dates', { companyId: A.companyA, version: 1, backDatingDays: 10 }, 400))).toEqual(['body/reason'])
    // With the reason it asks a fresh code: this test process has no office sign-in, so the step-up cannot be proved (503);
    // the live check proves the 403 `stepUp` and the save after it. Nothing is saved either way.
    expect((await no('warehouse', 'PUT', '/inventory/rules/posting-dates', { companyId: A.companyA, version: 1, backDatingDays: null, reason: 'Year-end corrections' }, 503)).code).toBe('not_ready')
    expect((await ok('warehouse', 'GET', `/inventory/rules?companyId=${A.companyA}`)).postingDates.own).toBe(3)
    await no('warehouse', 'PUT', '/inventory/rules/posting-dates', { companyId: A.companyA, version: 0, backDatingDays: 2 }, 409)
    await no('viewer', 'PUT', '/inventory/rules/posting-dates', { companyId: A.companyA, version: 1, backDatingDays: 2 }, 403)
  })

  it('keeps the adjustment value with the cost grain only', async () => {
    // Sent without the cost grain: refused before the handler (the money filter), and without the value too.
    expect((await no('warehouse', 'PUT', '/inventory/rules/adjustment-approval', { companyId: A.companyA, version: 1, amount: 50000 }, 403)).message).toMatch(/money fields/)
    expect((await no('warehouse', 'PUT', '/inventory/rules/adjustment-approval', { companyId: A.companyA, version: 1 }, 403)).message).toMatch(/cost grain/)
    const saved = await ok('finance', 'PUT', '/inventory/rules/adjustment-approval', { companyId: A.companyA, version: 1, amount: 50000 })
    expect(saved).toMatchObject({ loosened: false, rules: { version: 2, adjustmentApproval: { own: 50000, inForce: { amount: 50000, source: 'COMPANY', set: true } } } })
    expect(paths(await no('finance', 'PUT', '/inventory/rules/adjustment-approval', { companyId: A.companyA, version: 2, amount: 90000 }, 400))).toEqual(['body/reason'])
  })
})

describe('a posting date apart from the entry time (SCM-196)', () => {
  it('posts within the back-dating days and refuses further back or after today, in words', async () => {
    const day = plusCalendarDays(today, -2)
    const { move } = await ok('keeper', 'POST', '/inventory/adjustments', lining('IN', '1', { postingDate: day, unitCost: '2.00' }), 201)
    expect(move).toMatchObject({ reason: 'ADJUSTMENT', postingDate: day, valued: true })
    expect((await one<{ d: string }>(`SELECT "postingDate"::text AS d FROM "StockMove" WHERE id = $1`, [move.id])).d).toBe(day)
    const back = await no('keeper', 'POST', '/inventory/adjustments', lining('IN', '1', { postingDate: plusCalendarDays(today, -5) }), 400)
    expect(back.issues).toEqual([{ path: 'body/postingDate', message: expect.stringContaining('goes back further than the warehouse rules allow (3 days back)') }])
    expect((await no('keeper', 'POST', '/inventory/adjustments', lining('IN', '1', { postingDate: plusCalendarDays(today, 1) }), 400)).issues[0].message).toContain('is after today')
    // The Movements read: the posting day beside the entry time, and a filter by it.
    const ledger = await ok('keeper', 'GET', `/inventory/ledger?siteId=${A.siteA1}&itemId=${A.lining}&backDated=true`)
    expect(ledger.moves.map((row: Json) => [row.id, row.postingDate, row.postingDay])).toEqual([[move.id, day, day]])
    expect((await ok('keeper', 'GET', `/inventory/ledger?siteId=${A.siteA1}&itemId=${A.lining}&postedFrom=${day}&postedTo=${day}`)).moves.map((row: Json) => row.id)).toEqual([move.id])
    expect(await ok('keeper', 'GET', `/inventory/posting/check?siteId=${A.siteA1}&day=${plusCalendarDays(today, -4)}`)).toMatchObject({ allowed: false, earliest: plusCalendarDays(today, -3), backDatingDays: { days: 3, source: 'COMPANY' }, problem: expect.stringContaining('goes back further') })
    expect(await ok('keeper', 'GET', `/inventory/posting/check?siteId=${A.siteA1}&day=${day}`)).toMatchObject({ allowed: true, problem: null, periodLock: null })
  })
})

describe('an adjustment above the value waits for a yes (STOCK_ADJUSTMENT)', () => {
  let ruleId: string

  it('posts as today while no approval rule says who approves, and below the value', async () => {
    // 300 m at 2.00 = 600.00 € > 500.00 €, but no rule is on: it posts.
    expect((await ok('keeper', 'POST', '/inventory/adjustments', lining('IN', '300', { unitCost: '2.00' }), 201)).move.valued).toBe(true)
    ruleId = newId()
    await admin(
      `INSERT INTO "ApprovalRule" (id, "tenantId", "companyId", kind, name, condition, "approverUserId", active, sequence) VALUES ($1, $2, $3, 'STOCK_ADJUSTMENT', 'Made-up: adjustments', '{"combinator":"and","rows":[]}', $4, true, 10)`,
      [ruleId, A.tenant, A.companyA, PEOPLE.finance],
    )
    // 10 m at 2.00 = 20.00 €: below the value, it posts.
    expect((await ok('keeper', 'POST', '/inventory/adjustments', lining('OUT', '10', { unitCost: '2.00' }), 201)).move.reason).toBe('ADJUSTMENT')
  })

  it('waits above the value (nothing posted), is never approved by who asked, and posts on the yes', async () => {
    const before = await onHand()
    const moves = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "tenantId" = $1`, [A.tenant])).n
    const { waiting } = await ok('keeper', 'POST', '/inventory/adjustments', lining('OUT', '280', { unitCost: '2.00', reasonCode: undefined }), 202)
    expect(waiting).toMatchObject({ status: 'PENDING', requestedBy: { id: PEOPLE.keeper, name: NAMES.keeper }, approver: { kind: 'PERSON', id: PEOPLE.finance, name: NAMES.finance }, direction: 'OUT', quantity: '280.0000', onHand: { from: before, to: (Number(before) - 280).toFixed(4) }, value: { amount: '560', currency: 'EUR' } })
    expect(waiting.words.en).toMatch(/^Waiting for approval by Made-up Finance since \d\d:\d\d$/)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "tenantId" = $1`, [A.tenant])).n).toBe(moves)
    expect(await onHand()).toBe(before)
    // The warehouse without the cost grain sees it without its value.
    const list = await ok('warehouse', 'GET', `/inventory/adjustments/waiting?siteId=${A.siteA1}&itemId=${A.lining}`)
    expect(list).toMatchObject({ count: 1, rows: [{ requestId: waiting.requestId, taskId: waiting.taskId }] })
    expect(list.rows[0].value).toBeUndefined()
    expect((await outbox('inventory.adjustment_request_changed')).map((payload) => payload.state)).toEqual(['WAITING'])

    const task = (await ok('finance', 'GET', `/approvals/tasks/${waiting.taskId}`)).task
    expect(task).toMatchObject({ kind: 'STOCK_ADJUSTMENT', status: 'PENDING', record: { type: 'StockAdjustment', id: waiting.requestId } })
    expect(paths(await no('keeper', 'POST', `/approvals/tasks/${waiting.taskId}/approve`, { version: task.version }, 403))).toContain('refusal/OWN_REQUEST')
    await ok('finance', 'POST', `/approvals/tasks/${waiting.taskId}/approve`, { version: task.version, comment: 'Counted twice' })
    const posted = await one<Json>(`SELECT id, reason::text AS reason, "baseQuantity"::text AS q, "createdById", "idempotencyKey" FROM "StockMove" WHERE "idempotencyKey" = $1`, [`inventory.adjust:approval:${waiting.taskId}:1`])
    expect(posted).toMatchObject({ reason: 'ADJUSTMENT', q: '280.0000', createdById: PEOPLE.finance })
    expect(await one<Json>(`SELECT "valueAmount", method::text AS method FROM "StockValuation" WHERE "moveId" = $1`, [posted.id])).toMatchObject({ valueAmount: -56000, method: 'MANUAL' })
    expect(await onHand()).toBe((Number(before) - 280).toFixed(4))
    expect((await ok('warehouse', 'GET', `/inventory/adjustments/waiting?siteId=${A.siteA1}`)).count).toBe(0)
    expect((await ok('warehouse', 'GET', `/inventory/adjustments/waiting?siteId=${A.siteA1}&status=APPROVED`)).rows[0]).toMatchObject({ requestId: waiting.requestId, words: { en: 'Approved and posted' } })
    expect((await outbox('inventory.adjustment_request_changed')).map((payload) => [payload.state, payload.moveId])).toEqual([['WAITING', null], ['POSTED', posted.id]])
  })

  it('goes stale when the stock moves before the yes, and refuses what the post would refuse', async () => {
    const { waiting } = await ok('keeper', 'POST', '/inventory/adjustments', lining('IN', '400', { unitCost: '2.00' }), 202)
    await ok('keeper', 'POST', '/inventory/adjustments', lining('IN', '1', { unitCost: '2.00' }), 201)
    const task = (await ok('finance', 'GET', `/approvals/tasks/${waiting.taskId}`)).task
    expect(task.recheck).toBe('CHANGED')
    expect(paths(await no('finance', 'POST', `/approvals/tasks/${waiting.taskId}/approve`, { version: task.version }, 409))).toContain('refusal/STALE')
    expect((await ok('warehouse', 'GET', `/inventory/adjustments/waiting?siteId=${A.siteA1}&status=STALE`)).count).toBe(1)
    // More out than the place holds: refused as the post refuses it, nothing asked.
    const asked = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ApprovalTask" WHERE "tenantId" = $1`, [A.tenant])).n
    await no('keeper', 'POST', '/inventory/adjustments', lining('OUT', '99999', { unitCost: '2.00' }), 409)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ApprovalTask" WHERE "tenantId" = $1`, [A.tenant])).n).toBe(asked)
    await admin(`UPDATE "ApprovalRule" SET active = false WHERE id = $1`, [ruleId])
  })
})

describe('why is it this number (SCM-191)', () => {
  it('bridges a figure from its start balance through each kind of move to its end, every step a link to its moves', async () => {
    const from = plusCalendarDays(today, -1)
    const why = await ok('viewer', 'GET', `/inventory/why?siteId=${A.siteA1}&itemId=${A.lining}&itemColourId=${A.liningGRY}&lotId=${liningLot}&locationId=${A.bin}&from=${from}`)
    // The opening (30 days ago) and the move dated two days back count before the period.
    expect(why).toMatchObject({ basis: 'POSTING', period: { from, to: today }, start: '201.0000', addsUp: true, gap: '0.0000', uom: 'M', location: { id: A.bin } })
    expect(why.end).toBe(why.onHandNow)
    expect(why.end).toBe(await onHand())
    expect(why.steps.map((step: Json) => step.reason)).toEqual(['ADJUSTMENT'])
    expect(why.steps[0]).toMatchObject({ sign: '±', before: '201.0000', after: why.end, link: { path: '/inventory/ledger', query: { siteId: A.siteA1, itemId: A.lining, reasons: 'ADJUSTMENT', postedFrom: from, postedTo: today, locationId: A.bin } } })
    // Today's moves: +300, −10, −280 (on the yes), +1; the one dated two days back is in the start.
    expect(why).toMatchObject({ moves: 4, steps: [{ moves: 4, net: '11.0000' }] })
    expect(why.last).toHaveLength(4)
    expect(why.words.en).toMatch(/^201 m on \d+ \w+ \d{4} \+ [\d,.]+ m adjustments = [\d,.]+ m on \d+ \w+ \d{4} ✓$/)
    // The link lists the step's moves: the Movements grid with the same filter.
    const listed = await ok('viewer', 'GET', `/inventory/ledger?${new URLSearchParams(why.steps[0].link.query).toString()}`)
    expect(listed.moves).toHaveLength(why.steps[0].moves)
    // By the day the moves happened, the back-dated one falls inside the period.
    const entry = await ok('viewer', 'GET', `/inventory/why?siteId=${A.siteA1}&itemId=${A.lining}&lotId=${liningLot}&locationId=${A.bin}&from=${from}&basis=ENTRY`)
    expect(entry).toMatchObject({ start: '200.0000', end: why.end, addsUp: true })
    await no('company-b', 'GET', `/inventory/why?siteId=${A.siteA1}&itemId=${A.lining}`, undefined, 404)
    expect(paths(await no('viewer', 'GET', `/inventory/why?siteId=${A.siteA1}&itemId=${A.lining}&from=${today}&to=${from}`, undefined, 400))).toEqual(['querystring/from'])
  })
})

describe('below the minimum (SCM-281)', () => {
  it('counts the tile, lists the numbers, and the alert rule finds it unless the warehouse rules switch it off', async () => {
    const list = await ok('viewer', 'GET', `/inventory/low-stock?siteId=${A.siteA1}&below=false`)
    const protector = list.rows.find((row: Json) => row.item.id === A.protector)
    expect(protector).toMatchObject({ basis: 'REORDER_POINT', minimum: '24.0000', onHand: '10.0000' })
    expect(protector.position).toBe((Number(protector.onHand) + Number(protector.onOrder) - Number(protector.reserved)).toFixed(4))
    expect(protector.below).toBe(Number(protector.position) <= 24)
    const liningRow = list.rows.find((row: Json) => row.item.id === A.lining)
    expect(liningRow).toMatchObject({ basis: 'MIN_MAX', minimum: '50.0000', colour: { id: A.liningGRY } })
    const below = list.rows.filter((row: Json) => row.below)
    expect(list).toMatchObject({ count: below.length, alerts: { on: true, source: 'DEFAULT' } })
    expect((await ok('viewer', 'GET', `/inventory/low-stock?siteId=${A.siteA1}`)).rows).toHaveLength(below.length)

    const find = () => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction((tx) => lowStockFindings(tx as never, { companyId: A.companyA, siteId: null }, new Date())))
    const found = await find()
    expect(found.map((finding) => finding.recordId).sort()).toEqual(below.map((row: Json) => row.item.id).sort())
    if (protector.below) {
      expect(found.find((finding) => finding.recordId === A.protector)).toMatchObject({ recordType: 'Item', subKey: `${A.siteA1}|-`, scope: { companyId: A.companyA, siteId: A.siteA1 }, facts: { minimum: '24', unit: 'pz', basis: 'REORDER_POINT' } })
    }
    const rules = await ok('warehouse', 'GET', `/inventory/rules?companyId=${A.companyA}`)
    expect((await ok('warehouse', 'PUT', '/inventory/rules/low-stock-alerts', { companyId: A.companyA, version: rules.version, on: false })).rules.lowStockAlerts).toEqual({ own: false, inForce: { on: false, source: 'COMPANY' } })
    expect(await find()).toEqual([])
  })
})
