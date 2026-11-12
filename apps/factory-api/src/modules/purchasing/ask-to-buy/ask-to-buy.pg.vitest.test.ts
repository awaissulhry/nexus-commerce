import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedApprovals } from '../../../../../../packages/factory-db/seed/approvals'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedSourcing } from '../../../../../../packages/factory-db/seed/sourcing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Ask to buy (B-W2b-332; SCM-035, SCM-037) on the local stack, with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, the grants and the triggers are real), the
 * factory-db seeds up to planning, sourcing and the approval engine's (its rules all OFF; the seed's office people: the
 * Owner and a member). The member asks; the Owner is the approver a test rule names; a buyer drafts and refuses; a planner
 * asks from the shortage list; HR asks and sees only its own. Sessions from the test authenticator. Every name, number and
 * price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/ask-to-buy/`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'ask-to-buy-332'
const idOf = (key: string) => seedUuid(NS, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  owner: idOf('actor'),
  member: idOf('user:member'),
  leather: idOf('product:item:leather'),
  protector: idOf('product:item:protector'),
}
const OTHER_TENANT = seedUuid('ask-to-buy-332-b', 'tenant')

const ASK: Permission = 'purchasing.requests.ask'
const BUY: Permission[] = ['purchasing.view', 'purchasing.manage', 'money.cost', ASK, 'planning.view']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const PEOPLE = { buyer: newId(), planner: newId(), hr: newId() }
const office = (actorId: string, permissions: Permission[], tenantId = A.tenant): SessionContext => ({ audience: 'office', tenantId, actorId, grants: [grant(permissions)] })
const SESSIONS: Record<string, () => SessionContext> = {
  // The seed's member asks (an office person, no purchasing.view).
  member: () => office(A.member, [ASK, 'approvals.view', 'approvals.request', 'approvals.decide']),
  // The seed's Owner decides the requests a test rule names it for.
  owner: () => office(A.owner, [ASK, 'approvals.view', 'approvals.request', 'approvals.decide', 'purchasing.view']),
  buyer: () => office(PEOPLE.buyer, BUY),
  planner: () => office(PEOPLE.planner, [ASK, 'planning.view', 'planning.firm', 'purchasing.view']),
  hr: () => office(PEOPLE.hr, [ASK]),
  nobody: () => office(newId(), ['home.view']),
  otherTenant: () => office(newId(), BUY, OTHER_TENANT),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `ask332-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const today = () => businessDate(new Date())
const body = (over: Json = {}) => ({ siteId: A.siteA1, itemId: A.protector, quantity: '12', uom: 'PCS', needDate: addDays(today(), 10), reason: 'Scorta per le riparazioni (made-up).', ...over })

let ruleId: string

beforeAll(async () => {
  db = await migratedDatabase('ask_to_buy')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [NS, 'ask-to-buy-332-b']) await seedCore({ db: database, namespace })
  await seedPlanning({ db: database, namespace: NS }) // production, inventory, supply and sales come with it
  await seedSourcing({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedApprovals({ db: database, namespace: NS }) // auth, roles, reasons and the engine's rules (all OFF)
  // A test rule, OFF until a test switches it on: every request to buy asks the Owner for a yes.
  ruleId = newId()
  await admin(`INSERT INTO "ApprovalRule" (id, "tenantId", kind, name, condition, "approverUserId", sequence, active, version) VALUES ($1, $2, 'PURCHASE_REQUEST', 'Every request to buy (made-up)', '{"combinator":"and","rows":[]}'::jsonb, $3, 1, false, 1)`, [ruleId, A.tenant, A.owner])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const switchRule = async (active: boolean) => admin(`UPDATE "ApprovalRule" SET active = $2, version = version + 1 WHERE id = $1`, [ruleId, active])

let first: Json

describe('Ask to buy from anyone in the office (SCM-035)', { timeout: 120_000 }, () => {
  it('offers the sites one may ask for, the materials we buy (never a finished product) with their units and colours, the open work orders', async () => {
    const options = await ok('hr', 'GET', '/purchasing/ask-to-buy/options')
    expect(options.sites.map((site: Json) => site.id)).toContain(A.siteA1)
    expect(options.materials.length).toBeGreaterThan(0)
    expect(options.materials.every((item: Json) => item.kind !== 'FINISHED')).toBe(true)
    const protector = options.materials.find((item: Json) => item.id === A.protector)
    expect(protector.units).toContain('PCS')
    const leather = options.materials.find((item: Json) => item.id === A.leather)
    expect(leather.colours.length).toBeGreaterThan(0)
    expect(JSON.stringify(options)).not.toMatch(/standardCost|unitPrice/)
    await no('nobody', 'GET', '/purchasing/ask-to-buy/options', undefined, 403)
  })

  it('refuses in words what cannot be bought or asked: quantity, a past day, the unit, a finished product, a closed work order, an unknown site', async () => {
    expect(paths(await no('member', 'POST', '/purchasing/ask-to-buy', body({ quantity: '0' }), 400))).toEqual(['body/quantity'])
    expect(paths(await no('member', 'POST', '/purchasing/ask-to-buy', body({ needDate: addDays(today(), -1) }), 400))).toEqual(['body/needDate'])
    expect(paths(await no('member', 'POST', '/purchasing/ask-to-buy', body({ reason: '   ' }), 400))).toEqual(['body/reason'])
    expect(paths(await no('member', 'POST', '/purchasing/ask-to-buy', body({ uom: 'HIDE' }), 400))).toEqual(['body/uom'])
    const finished = await admin<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND kind = 'FINISHED' LIMIT 1`, [A.tenant])
    if (finished[0]) expect(paths(await no('member', 'POST', '/purchasing/ask-to-buy', body({ itemId: finished[0].id }), 400))).toEqual(['body/itemId'])
    const closed = await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND status IN ('CLOSED', 'CANCELLED', 'COMPLETED') LIMIT 1`, [A.tenant])
    if (closed[0]) expect(paths(await no('member', 'POST', '/purchasing/ask-to-buy', body({ workOrderId: closed[0].id }), 400))).toEqual(['body/workOrderId'])
    await no('member', 'POST', '/purchasing/ask-to-buy', body({ siteId: newId() }), 404)
    await no('nobody', 'POST', '/purchasing/ask-to-buy', body(), 403)
    expect(await admin(`SELECT id FROM "PurchaseRequest" WHERE "tenantId" = $1 AND "requestedById" = $2`, [A.tenant, A.member])).toEqual([])
  })

  it('no rule switched on: the request waits for the buyers (OPEN), told by purchase_requests.asked; a resend answers the same', async () => {
    const payload = body({ description: 'Taglia L (made-up)', note: 'Not read: no rule asks a yes.' })
    const once = key()
    const send = () => app.inject({ method: 'POST', url: '/purchasing/ask-to-buy', headers: { 'x-test-session': 'member', 'idempotency-key': once }, payload })
    const sent = await send()
    expect(sent.statusCode, sent.body).toBe(201)
    const answer = sent.json() as Json
    first = answer.request
    expect(answer.approval).toEqual({ asked: false, taskId: null, approverRoleId: null, approverUserId: null, dueAt: null })
    expect(first).toMatchObject({ source: 'OFFICE', status: 'OPEN', quantity: '12.0000', uom: 'PCS', mine: true, description: 'Taglia L (made-up)', requestedBy: { id: A.member }, cancel: { allowed: true, why: null } })
    expect(first.requestedBy.name).not.toBe('')
    const again = await send()
    expect(again.json().request.id).toBe(first.id)
    expect(await outbox('purchase_requests.asked')).toContainEqual({ purchaseRequestId: first.id, siteId: A.siteA1, source: 'OFFICE', status: 'OPEN', workOrderId: null, approvalTaskId: null, requestedById: A.member })
    expect(await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.askToBuy.asked'`, [first.id])).toEqual({ n: 1 })
  })

  it('the buyers see it in their queue as the kind ASKED (who asked, why), bought in the supplier’s unit and steps; HR sees only its own', async () => {
    const queue = (await ok('buyer', 'GET', '/purchasing/requests?kind=ASKED')).requests as Json[]
    const row = queue.find((entry) => entry.refId === first.id)!
    expect(row).toMatchObject({ id: `asked:${first.id}`, kind: 'ASKED', status: 'OPEN', item: { id: A.protector }, asked: { source: 'OFFICE', status: 'OPEN', quantity: '12.0000', uom: 'PCS', reason: 'Scorta per le riparazioni (made-up).', requestedBy: { id: A.member } } })
    expect(Number(row.quantity)).toBeGreaterThanOrEqual(12)
    const detail = await ok('buyer', 'GET', `/purchasing/requests/asked/${first.id}`)
    expect(detail.request.asked.purchaseRequestId).toBe(first.id)
    // HR asks too and sees only its own; it cannot open the buyers' queue.
    const mine = await ok('hr', 'POST', '/purchasing/ask-to-buy', body({ quantity: '2', reason: 'Guanti per il nuovo addetto (made-up).' }), 201)
    const hrList = (await ok('hr', 'GET', '/purchasing/ask-to-buy?status=ALL')).requests as Json[]
    expect(hrList.map((entry) => entry.id)).toEqual([mine.request.id])
    await no('hr', 'GET', `/purchasing/ask-to-buy/${first.id}`, undefined, 404)
    await no('hr', 'GET', '/purchasing/requests', undefined, 403)
    const buyerList = (await ok('buyer', 'GET', '/purchasing/ask-to-buy')).requests.map((entry: Json) => entry.id)
    expect(buyerList).toEqual(expect.arrayContaining([first.id, mine.request.id]))
    await no('otherTenant', 'GET', `/purchasing/ask-to-buy/${first.id}`, undefined, 404)
  })
})

describe('a yes first when a PURCHASE_REQUEST rule holds (nobody approves their own request)', { timeout: 120_000 }, () => {
  let waiting: Json
  it('asks the approver: PENDING_APPROVAL with its task; held in the queue and counted as waiting', async () => {
    await switchRule(true)
    const answer = await ok('member', 'POST', '/purchasing/ask-to-buy', body({ quantity: '30', note: 'Per la commessa di prova (made-up).' }), 201)
    waiting = answer.request
    expect(answer.approval).toMatchObject({ asked: true, approverUserId: A.owner })
    expect(waiting).toMatchObject({ status: 'PENDING_APPROVAL', approvalTaskId: answer.approval.taskId })
    const row = (await ok('buyer', 'GET', '/purchasing/requests?status=WAITING_APPROVAL')).requests.find((entry: Json) => entry.refId === waiting.id)
    expect(row).toMatchObject({ status: 'WAITING_APPROVAL', hold: { code: 'WAITING_APPROVAL' } })
    expect((await ok('buyer', 'GET', '/purchasing/requests/counts')).waitingApproval).toBeGreaterThanOrEqual(1)
    // Drafting it is held: it waits for its yes.
    await no('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'ASKED', id: waiting.id, version: waiting.version }] }, 409)
  })

  it('the person who asked cannot approve it; the approver’s yes sends it to the buyers (OPEN)', async () => {
    const error = await no('member', 'POST', `/approvals/tasks/${waiting.approvalTaskId}/approve`, { version: 1 }, 403)
    expect(error.code).toMatch(/OWN_REQUEST|forbidden/i)
    const task = await one<{ version: number }>(`SELECT version FROM "ApprovalTask" WHERE id = $1`, [waiting.approvalTaskId])
    await ok('owner', 'POST', `/approvals/tasks/${waiting.approvalTaskId}/approve`, { version: task.version })
    const now = (await ok('member', 'GET', `/purchasing/ask-to-buy/${waiting.id}`)).request
    expect(now.status).toBe('OPEN')
    expect(await outbox('purchase_requests.status_changed')).toContainEqual({ purchaseRequestId: waiting.id, siteId: A.siteA1, from: 'PENDING_APPROVAL', to: 'OPEN', purchaseOrderId: null, requestedById: A.member })
    const read = await ok('member', 'GET', `/purchasing/ask-to-buy/${waiting.id}`)
    expect(read.approval).toMatchObject({ status: 'APPROVED', approver: expect.any(String) })
  })

  it('the approver’s no refuses it with the reason; the asker may take back another that still waits (its task withdrawn with it)', async () => {
    const refused = (await ok('member', 'POST', '/purchasing/ask-to-buy', body({ quantity: '5' }), 201)).request
    const task = await one<{ version: number }>(`SELECT version FROM "ApprovalTask" WHERE id = $1`, [refused.approvalTaskId])
    await ok('owner', 'POST', `/approvals/tasks/${refused.approvalTaskId}/reject`, { version: task.version, reasonCode: 'OVER_BUDGET', reason: 'Fuori budget questo mese (made-up).' })
    const after = (await ok('member', 'GET', `/purchasing/ask-to-buy/${refused.id}`)).request
    expect(after).toMatchObject({ status: 'REJECTED', rejected: { reason: 'Fuori budget questo mese (made-up).' }, cancel: { allowed: false } })

    const back = (await ok('member', 'POST', '/purchasing/ask-to-buy', body({ quantity: '7' }), 201)).request
    const taken = (await ok('member', 'POST', '/purchasing/ask-to-buy/cancel', { requests: [{ id: back.id, version: back.version }], reason: 'Trovate in magazzino (made-up).' })).requests[0]
    expect(taken).toMatchObject({ status: 'CANCELLED', cancelled: { reason: 'Trovate in magazzino (made-up).' } })
    expect(await one(`SELECT status::text AS status FROM "ApprovalTask" WHERE id = $1`, [back.approvalTaskId])).toEqual({ status: 'WITHDRAWN' })
    // Not in the queue any more; and it changes no more.
    expect((await ok('buyer', 'GET', '/purchasing/requests?status=ALL&kind=ASKED')).requests.map((entry: Json) => entry.refId)).not.toContain(back.id)
    await no('member', 'POST', '/purchasing/ask-to-buy/cancel', { requests: [{ id: back.id, version: taken.version }], reason: 'Again.' }, 409)
    await switchRule(false)
  })
})

describe('the buyer drafts it, or refuses it with the reason', { timeout: 120_000 }, () => {
  it('drafts an asked request with the others ("Draft POs for n"): CONVERTED with its purchase order line; a stale version refuses the batch', async () => {
    const asked = (await ok('member', 'POST', '/purchasing/ask-to-buy', body({ quantity: '9' }), 201)).request
    await no('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'ASKED', id: asked.id, version: asked.version + 1 }] }, 409)
    const preview = await ok('buyer', 'POST', '/purchasing/requests/preview', { requests: [{ kind: 'ASKED', id: asked.id, version: asked.version }] })
    expect(preview.held).toEqual([])
    expect(preview.cards[0].lines[0].requestId).toBe(`asked:${asked.id}`)
    const converted = await ok('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'ASKED', id: asked.id, version: asked.version }] })
    const line = converted.lines[0]
    const after = (await ok('member', 'GET', `/purchasing/ask-to-buy/${asked.id}`)).request
    expect(after).toMatchObject({ status: 'CONVERTED', converted: { purchaseOrder: { id: line.purchaseOrderId } } })
    expect(await one(`SELECT "purchaseOrderLineId" AS line, "convertedById" AS by FROM "PurchaseRequest" WHERE id = $1`, [asked.id])).toEqual({ line: line.purchaseOrderLineId, by: PEOPLE.buyer })
    expect(await outbox('purchase_requests.status_changed')).toContainEqual({ purchaseRequestId: asked.id, siteId: A.siteA1, from: 'OPEN', to: 'CONVERTED', purchaseOrderId: line.purchaseOrderId, requestedById: A.member })
    const row = (await ok('buyer', 'GET', '/purchasing/requests?status=CONVERTED&kind=ASKED')).requests.find((entry: Json) => entry.refId === asked.id)
    expect(row.asked.purchaseOrder.id).toBe(line.purchaseOrderId)
    // Drafted once: a second conversion is held.
    await no('buyer', 'POST', '/purchasing/requests/convert', { requests: [{ kind: 'ASKED', id: asked.id, version: after.version }] }, 409)
    // Its line stays on the draft: removing it is refused in words (the database keeps the request's line), never a 500.
    const order = (await ok('buyer', 'GET', `/purchasing/orders/${line.purchaseOrderId}`)).order
    const removal = await call('buyer', 'DELETE' as Method, `/purchasing/orders/${line.purchaseOrderId}/lines/${line.purchaseOrderLineId}?version=${order.version}`)
    expect(removal.statusCode, removal.body).toBe(409)
    expect(paths(removal.json().error)).toEqual(['refusal/LINE_ASKED'])
  })

  it('refuses an open request with the reason (the buyer only); the asker cannot', async () => {
    await no('member', 'POST', '/purchasing/ask-to-buy/reject', { requests: [{ id: first.id, version: first.version }], reason: 'x' }, 403)
    await no('planner', 'POST', '/purchasing/ask-to-buy/reject', { requests: [{ id: first.id, version: first.version }], reason: 'x' }, 403)
    const refused = (await ok('buyer', 'POST', '/purchasing/ask-to-buy/reject', { requests: [{ id: first.id, version: first.version }], reason: 'Già ordinato su PO-1 (made-up).' })).requests[0]
    expect(refused).toMatchObject({ status: 'REJECTED', rejected: { reason: 'Già ordinato su PO-1 (made-up).' } })
    const row = (await ok('buyer', 'GET', '/purchasing/requests?status=SET_ASIDE&kind=ASKED')).requests.find((entry: Json) => entry.refId === first.id)
    expect(row.asked.rejected.reason).toBe('Già ordinato su PO-1 (made-up).')
    // Someone else's request: one who sees it but neither asked nor buys may not take it back.
    const other = (await ok('member', 'POST', '/purchasing/ask-to-buy', body({ quantity: '3' }), 201)).request
    await no('planner', 'POST', '/purchasing/ask-to-buy/cancel', { requests: [{ id: other.id, version: other.version }], reason: 'x' }, 409)
    expect((await ok('buyer', 'POST', '/purchasing/ask-to-buy/cancel', { requests: [{ id: other.id, version: other.version }], reason: 'Doppione (made-up).' })).requests[0].status).toBe('CANCELLED')
  })
})

describe('buy from a shortage (SCM-037)', { timeout: 120_000 }, () => {
  let shortage: Json
  it('a planner asks a line of the shortage list: the work order, the material, what is short, by when, kept as seen; once', async () => {
    // The seeds' run 1 has a firm red order covering WO-0001's red leather: made planned again, the work order is short.
    const plan = await ok('planner', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`)
    for (const line of plan.lines as Json[]) if (line.firm) await ok('planner', 'POST', `/planning/requirements/${line.id}/unfirm`, { version: line.version })
    const list = await ok('planner', 'GET', `/planning/shortages?siteId=${A.siteA1}`)
    expect(list.rows.length).toBeGreaterThan(0)
    shortage = list.rows[0]
    const answer = await ok('planner', 'POST', '/purchasing/ask-to-buy/from-shortage', { siteId: A.siteA1, workOrderId: shortage.workOrder.id, itemId: shortage.material.itemId, itemColourId: shortage.material.itemColourId, reason: `Mancanza per ${shortage.workOrder.number} (made-up).` }, 201)
    expect(answer.draft).toBeNull()
    expect(answer.approval.asked).toBe(false)
    expect(answer.request).toMatchObject({ source: 'SHORTAGE', status: 'OPEN', workOrder: { id: shortage.workOrder.id }, quantity: shortage.short, shortage: { word: shortage.word, short: shortage.short, workOrderNumber: shortage.workOrder.number } })
    expect(answer.request.needDate >= today()).toBe(true)
    const again = await no('planner', 'POST', '/purchasing/ask-to-buy/from-shortage', { siteId: A.siteA1, workOrderId: shortage.workOrder.id, itemId: shortage.material.itemId, itemColourId: shortage.material.itemColourId, reason: 'Again.' }, 409)
    expect(again.message).toMatch(/asked already/)
    // Drafting at once is the buyer's.
    await no('planner', 'POST', '/purchasing/ask-to-buy/from-shortage', { siteId: A.siteA1, workOrderId: shortage.workOrder.id, itemId: shortage.material.itemId, itemColourId: shortage.material.itemColourId, reason: 'x', then: 'DRAFT' }, 403)
    // Reading the shortage list needs planning.
    await no('hr', 'POST', '/purchasing/ask-to-buy/from-shortage', { siteId: A.siteA1, workOrderId: shortage.workOrder.id, itemId: shortage.material.itemId, reason: 'x' }, 403)
    // Not short: refused in words.
    const gone = await no('planner', 'POST', '/purchasing/ask-to-buy/from-shortage', { siteId: A.siteA1, workOrderId: shortage.workOrder.id, itemId: A.protector, itemColourId: null, reason: 'x' }, 409)
    expect(gone.message).toMatch(/not short of this material/)
    // Taken back, so the buyer may draft it in one step below.
    await ok('planner', 'POST', '/purchasing/ask-to-buy/cancel', { requests: [{ id: answer.request.id, version: answer.request.version }], reason: 'Lo prepara il buyer (made-up).' })
  })

  it('a buyer drafts the shortage in one step: the request written and drafted into a purchase order line in the same command', async () => {
    const answer = await ok('buyer', 'POST', '/purchasing/ask-to-buy/from-shortage', { siteId: A.siteA1, workOrderId: shortage.workOrder.id, itemId: shortage.material.itemId, itemColourId: shortage.material.itemColourId, reason: 'Subito (made-up).', then: 'DRAFT' }, 201)
    expect(answer.approval).toBeNull()
    expect(answer.request).toMatchObject({ source: 'SHORTAGE', status: 'CONVERTED', converted: { purchaseOrder: { id: answer.draft.purchaseOrderId, status: 'DRAFT' } } })
    const line = await one<{ itemId: string; status: string }>(`SELECT l."itemId", o.status::text AS status FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" o ON o.id = l."purchaseOrderId" WHERE l.id = $1`, [answer.draft.purchaseOrderLineId])
    expect(line).toEqual({ itemId: shortage.material.itemId, status: 'DRAFT' })
    expect(await outbox('purchase_requests.converted')).toContainEqual(expect.objectContaining({ purchaseOrderId: answer.draft.purchaseOrderId, requests: 1 }))
  })
})
