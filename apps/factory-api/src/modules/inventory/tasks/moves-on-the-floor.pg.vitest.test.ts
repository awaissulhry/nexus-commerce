import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { systemContext } from '../../../platform/outbox/system'
import { runTimedTaskSources, warehouseTaskHandlers } from './handlers'

/**
 * Moves on the floor on the local stack (B-W2b-292; SCM-202, SCM-218, SCM-274; follow-ups WT1:01, WT1:02), through the app's
 * real routes on the whole made-up seed (packages/factory-db/seed: plant A1 with its goods-in dock A1-RCV, quarantine shelf
 * A1-QUA, the bulk rack and pick face of linings with their bin labels, the blocked damaged rack, the count bay frozen by a
 * running count; the warehouse lining SEED-LOT-W36-01, 100 m in the bulk rack):
 *   - in your hands, a move between bins by its two scans, its refusals in words (where from, the same place, too much, a
 *     blocked place, a frozen count line, another site's label, stock on hold only into quarantine), the undo within 2 minutes;
 *   - a receipt onto the dock makes its put-away (the receipts source), the put-away scan's suggestion, the put-away by scan
 *     doing the task, the undo asking it again;
 *   - a hold that asks the quarantine move makes a QUARANTINE task; the tablet's scan of a wrong place is refused, of the
 *     quarantine place confirms the hold's move (the same act as the office's confirm), which also closes a task;
 *   - the inbox: for me, my role, anyone, never another's; take, give back, done; the office's tasks by hand, change, cancel,
 *     its one-task read behind the worker gate; the queued steps; a due count's COUNT task and its cancel.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/tasks/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'moves-floor'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `moves-${run}-${++keys}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })

const A = { tenant: '', companyA: '', siteA1: '', siteB1: '', worker: '', otherWorker: '', device: '', floorRole: '', user: newId(), boss: newId() }
const P = { dock: '', quarantine: '', bulk: '', pickFace: '', countBay: '', damaged: '', b1Label: '' }
let lining = { itemId: '', lotId: '', colourId: null as string | null }
/** The lot received in the put-away section (no stock in a frozen count line: the quarantine move takes all of it). */
let received = { lotId: '', code: '' }
let SESSIONS: Record<string, SessionContext> = {}

const FLOOR: Permission[] = ['floor.work', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'inventory.receive']
const OFFICE: Permission[] = ['inventory.locations.view', 'inventory.locations.manage', 'inventory.stock.view', 'inventory.transfer', 'inventory.receive', 'inventory.reverse', 'inventory.tasks.manage', 'quality.holds.view', 'quality.holds.place', 'quality.holds.release', 'workorders.view', 'parties.view']

const call = (session: string, method: Method, url: string, payload?: unknown, key: string | null = method === 'GET' ? null : freshKey()): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
async function refused(response: Promise<LightMyRequestResponse>, status: number): Promise<Json> {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const caller = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as RequestContext)
const system = () => callerFor(database, systemContext(A.tenant, `moves-${run}`))
const handler = () => warehouseTaskHandlers()[0]!

/** The outbox's events of a type (newest last) as the worker hands them to a handler. */
async function outbox(type: string, subject?: string): Promise<EventEnvelope[]> {
  const rows = await admin<Json>(
    `SELECT id, type, version, context, "tenantId", "companyId", "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ${subject ? 'AND subject = $3' : ''} ORDER BY "occurredAt", id`,
    subject ? [A.tenant, type, subject] : [A.tenant, type],
  )
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}
const handle = async (event: EventEnvelope) => handler().handle(event, { caller: system(), attempt: 1 })
const lastOf = async (type: string, subject?: string) => (await outbox(type, subject)).at(-1)!
const stockAt = async (lotId: string, locationId: string): Promise<string> =>
  (await admin<{ q: string | null }>(`SELECT (COALESCE(SUM(CASE WHEN "toLocationId" = $2 THEN "baseQuantity" END), 0) - COALESCE(SUM(CASE WHEN "fromLocationId" = $2 THEN "baseQuantity" END), 0))::text AS q FROM "StockMove" WHERE "lotId" = $1`, [lotId, locationId]))[0]!.q ?? '0'
const num = (value: string | number) => Number(value)
const taskRow = async (id: string) => (await admin<Json>(`SELECT status::text, "takenByWorkerId", "doneByWorkerId", "doneById", "cancelReason", "toLocationId", "fromLocationId", kind::text, version FROM "WarehouseTask" WHERE id = $1`, [id]))[0]!

beforeAll(async () => {
  db = await migratedDatabase('moves_on_the_floor')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  const site = async (code: string) => (await admin<Json>(`SELECT s.id, s."tenantId", s."companyId" FROM "Site" s JOIN "Tenant" t ON t.id = s."tenantId" WHERE s.code = $1 ORDER BY t.slug LIMIT 1`, [code]))[0]!
  const a1 = await site('A1')
  Object.assign(A, { tenant: a1.tenantId, companyA: a1.companyId, siteA1: a1.id, siteB1: (await admin<Json>(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND code = 'B1'`, [a1.tenantId]))[0]!.id })
  const place = async (code: string) => (await admin<Json>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = $2`, [A.tenant, code]))[0]!.id as string
  Object.assign(P, { dock: await place('A1-RCV'), quarantine: await place('A1-QUA'), bulk: await place('A1-BULK-01'), pickFace: await place('A1-PF-01'), countBay: await place('A1-CNT-01'), damaged: await place('A1-DMG-01') })
  // The damaged rack stays blocked whatever the day; a label at B1 for the "another site" refusal.
  await admin(`UPDATE "Location" SET "blockedUntil" = NULL WHERE id = $1`, [P.damaged])
  const b1 = (await admin<Json>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND "siteId" = $2 AND kind = 'WAREHOUSE' ORDER BY code LIMIT 1`, [A.tenant, A.siteB1]))[0]!
  await admin(`UPDATE "Location" SET "labelCode" = 'BIN-B1-ELSEWHERE' WHERE id = $1`, [b1.id])
  P.b1Label = 'BIN-B1-ELSEWHERE'
  const workers = await admin<Json>(`SELECT id FROM "Worker" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY "displayName", id`, [A.tenant, A.siteA1])
  A.worker = workers[0]!.id
  A.otherWorker = workers[1]!.id
  A.device = (await admin<Json>(`SELECT id FROM "Device" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY id LIMIT 1`, [A.tenant, A.siteA1]))[0]!.id
  A.floorRole = (await admin<Json>(`SELECT "roleId" FROM "WorkerRole" WHERE "workerId" = $1 AND "endedAt" IS NULL LIMIT 1`, [A.worker]))[0]!.roleId
  const lot = (await admin<Json>(`SELECT id, "itemId", "itemColourId" FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-W36-01'`, [A.tenant]))[0]!
  lining = { itemId: lot.itemId, lotId: lot.id, colourId: lot.itemColourId }

  const floor = (workerId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: workerId, siteId: A.siteA1, deviceId: A.device, grants: [grant(FLOOR, { companies: [A.companyA], sites: [A.siteA1] })] })
  SESSIONS = {
    tablet: floor(A.worker),
    colleague: floor(A.otherWorker),
    // A sewing-line tablet person: works, but holds no move right.
    sewer: { ...floor(A.otherWorker), grants: [grant(['floor.work', 'production.scan'], { companies: [A.companyA], sites: [A.siteA1] })] },
    warehouse: { audience: 'office', tenantId: A.tenant, actorId: A.user, grants: [grant(OFFICE)] },
    boss: { audience: 'office', tenantId: A.tenant, actorId: A.boss, grants: [grant(OFFICE)] },
    viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['inventory.stock.view', 'inventory.locations.view'])] },
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('move between bins by two scans (SCM-218)', () => {
  let moveId = ''

  it('shows what is in your hands: where it lies, its quality state, whole or in part', async () => {
    const { hand, tasks } = await ok(call('tablet', 'GET', '/inventory/bin-moves/scan?code=seed-lot-w36-01'))
    expect(hand).toMatchObject({ kind: 'LOT', label: 'Lot SEED-LOT-W36-01', quality: 'RELEASED', whole: false, uom: 'M' })
    expect(hand.lying).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'A1-BULK-01', onHand: expect.any(String) }), expect.objectContaining({ code: 'A1-CNT-01' })]))
    expect(Array.isArray(tasks)).toBe(true)
    expect(JSON.stringify(hand)).not.toMatch(/cost|price|value/i)
    await refused(call('tablet', 'GET', '/inventory/bin-moves/scan?code=NO-SUCH-LABEL'), 404)
    await refused(call('sewer', 'GET', '/inventory/bin-moves/scan?code=SEED-LOT-W36-01'), 403)
  })

  it('refuses in words: where from, the same place, too much, a blocked place, a frozen line, another site, an unknown label', async () => {
    const body = { code: 'SEED-LOT-W36-01', placeCode: 'BIN-A1-PF-01', quantity: '12.5' }
    expect(paths(await refused(call('tablet', 'POST', '/inventory/bin-moves', body), 409))).toContain('refusal/NAME_THE_PLACE')
    expect(paths(await refused(call('tablet', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.bulk, placeCode: 'BIN-A1-BULK-01' }), 409))).toContain('refusal/SAME_PLACE')
    expect(paths(await refused(call('tablet', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.bulk, quantity: '100000' }), 400))).toContain('refusal/TOO_MUCH')
    const blocked = await refused(call('tablet', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.bulk, placeCode: 'BIN-A1-DMG-01' }), 409)
    expect(paths(blocked)).toContain('warehouse/LOCATION_BLOCKED')
    expect(blocked.message).toBe('Location A1-DMG-01 is blocked (damage): nothing moves in or out of it until it is unblocked.')
    const frozen = await refused(call('tablet', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.countBay, quantity: '1' }), 409)
    expect(paths(frozen)).toContain('warehouse/COUNT_FROZEN')
    expect(frozen.message).toMatch(/^Count \S+ is counting this material at A1-CNT-01/)
    const elsewhere = await refused(call('tablet', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.bulk, placeCode: P.b1Label }), 400)
    expect(elsewhere.issues).toEqual([{ path: 'body/placeCode', message: 'No place of this site carries label BIN-B1-ELSEWHERE.' }])
    // The office reads every site, but the place must be of the stock's site all the same.
    expect(paths(await refused(call('warehouse', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.bulk, placeCode: P.b1Label }), 400))).toEqual(['body/placeCode'])
    // A tablet's write needs its Idempotency-Key.
    await refused(call('tablet', 'POST', '/inventory/bin-moves', { ...body, fromLocationId: P.bulk }, null), 400)
  })

  // B-W2b-383 (XF8:02): a queued move the office refuses keeps its own code and words and is final (REFUSED on the tablet,
  // never sent again): too much (a 400), a blocked place and a frozen count line (the database's 409s).
  it('a queued move refused by the office keeps its refusal, final: too much, a blocked place, a frozen line', async () => {
    const queued = (payload: Json, n: number) => applyQueued(caller('tablet'), { clientEventId: newId(), kind: 'inventory.binMove', payload: { code: 'SEED-LOT-W36-01', placeCode: 'BIN-A1-PF-01', ...payload } }, { key: `q383-${run}-${n}` })
    expect(await queued({ fromLocationId: P.bulk, quantity: '100000' }, 1)).toMatchObject({ status: 'refused', refusal: { code: 'TOO_MUCH', final: true, message: expect.not.stringContaining('refusal/') } })
    expect(await queued({ fromLocationId: P.bulk, quantity: '1', placeCode: 'BIN-A1-DMG-01' }, 2)).toMatchObject({ status: 'refused', refusal: { code: 'LOCATION_BLOCKED', final: true, message: 'Location A1-DMG-01 is blocked (damage): nothing moves in or out of it until it is unblocked.' } })
    expect(await queued({ fromLocationId: P.countBay, quantity: '1' }, 3)).toMatchObject({ status: 'refused', refusal: { code: 'COUNT_FROZEN', final: true } })
  })

  it('moves part of the lot from the bulk rack onto the pick face, the label being the confirmation', async () => {
    const bulk = num(await stockAt(lining.lotId, P.bulk))
    const answer = await ok(call('tablet', 'POST', '/inventory/bin-moves', { code: 'SEED-LOT-W36-01', fromLocationId: P.bulk, placeCode: 'bin-a1-pf-01', quantity: '12.5' }), 201)
    expect(answer.moves).toEqual([expect.objectContaining({ fromLocationId: P.bulk, toLocationId: P.pickFace, quantity: '12.5000', uom: 'M' })])
    expect(answer).toMatchObject({ from: { code: 'A1-BULK-01' }, to: { code: 'A1-PF-01' } })
    expect(num(await stockAt(lining.lotId, P.bulk))).toBe(bulk - 12.5)
    expect(num(await stockAt(lining.lotId, P.pickFace))).toBeGreaterThanOrEqual(12.5)
    const [row] = await admin<Json>(`SELECT reason::text, "createdById", "deviceId", reference FROM "StockMove" WHERE id = $1`, [answer.moveIds[0]])
    expect(row).toEqual({ reason: 'TRANSFER', createdById: A.worker, deviceId: A.device, reference: 'Bin move' })
    moveId = answer.moveIds[0]
  })

  it('undoes it within 2 minutes, only by who made it, once', async () => {
    expect(paths(await refused(call('warehouse', 'POST', `/inventory/bin-moves/${moveId}/undo`), 409))).toContain('refusal/NOT_YOURS')
    expect(paths(await refused(call('colleague', 'POST', `/inventory/bin-moves/${moveId}/undo`), 409))).toContain('refusal/NOT_YOURS')
    const bulk = num(await stockAt(lining.lotId, P.bulk))
    const undone = await ok(call('tablet', 'POST', `/inventory/bin-moves/${moveId}/undo`), 201)
    expect(undone.undoneIds).toEqual([moveId])
    expect(num(await stockAt(lining.lotId, P.bulk))).toBe(bulk + 12.5)
    expect(paths(await refused(call('tablet', 'POST', `/inventory/bin-moves/${moveId}/undo`), 409))).toContain('refusal/UNDONE')
    // Only a move made by scan is undone here (an office transfer is the office's reversal).
    const transfer = await ok(call('warehouse', 'POST', '/inventory/transfers', { siteId: A.siteA1, itemId: lining.itemId, lotId: lining.lotId, fromLocationId: P.bulk, toLocationId: P.pickFace, quantity: '1' }), 201)
    expect(paths(await refused(call('warehouse', 'POST', `/inventory/bin-moves/${transfer.move.id}/undo`), 409))).toContain('refusal/NOT_A_MOVE')
  })
})

describe('put away by scan (SCM-202) and the receipt that asks it', () => {
  let order = { id: '', line: '' }
  let task: Json

  it('a receipt onto the dock makes a put-away per lot, to the suggested bin', async () => {
    const supplier = (await admin<Json>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND 'SUPPLIER' = ANY(roles) ORDER BY code LIMIT 1`, [A.tenant]))[0]!.id
    order = { id: newId(), line: newId() }
    await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, $5, $6, current_date, $7)`, [order.id, A.tenant, A.companyA, A.siteA1, `T-PO-${run}`, supplier, A.user])
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate") VALUES ($1, $2, $3, $4, $5, 10, $6, $7, 40, 'M', 40, '2.500000', 10000, current_date + 20)`,
      [order.line, A.tenant, order.id, supplier, A.siteA1, lining.itemId, lining.colourId],
    )
    await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = 10000, version = 2 WHERE id = $1`, [order.id, A.user])
    // A delivery the office asked the floor to take in (by hand); the receipt does it.
    const receive = (await ok(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'RECEIVE', source: { type: 'PurchaseOrder', id: order.id }, note: 'The lining truck' }), 201)).task
    const receipt = await ok(call('warehouse', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: `DDT-${run}`, supplierDdtDate: '2026-11-11', lines: [{ purchaseOrderLineId: order.line, lots: [{ quantity: '40' }] }] }), 201)
    const lotId = receipt.receipt.lines[0].lots[0].id
    received = { lotId, code: receipt.receipt.lines[0].lots[0].code }
    expect(num(await stockAt(lotId, P.dock))).toBe(40)
    const posted = await lastOf('inventory.receipt_posted', receipt.receipt.id)
    await handle(posted)
    await handle(posted) // the job again: nothing twice
    const { tasks } = await ok(call('warehouse', 'GET', `/inventory/tasks?sourceType=GoodsReceipt&sourceId=${receipt.receipt.id}`))
    expect(tasks).toHaveLength(1)
    task = tasks[0]
    // The seed's put-away default for linings is the bulk rack.
    expect(task).toMatchObject({ kind: 'PUT_AWAY', status: 'OPEN', from: { code: 'A1-RCV' }, to: { code: 'A1-BULK-01' }, quantity: '40.0000', uom: 'M', lot: { id: lotId } })
    expect((await taskRow(receive.id))).toMatchObject({ status: 'DONE', doneById: A.user })
    const changed = await outbox('inventory.warehouse_task_changed', task.id)
    expect(changed.map((event) => (event.payload as Json).change)).toEqual(['CREATED'])
    expect(JSON.stringify(changed.map((event) => event.payload))).not.toContain(A.worker)
  })

  it('suggests the bin, puts part away (the task taken), the rest does it; the undo asks it again', async () => {
    const lot = (await admin<Json>(`SELECT code FROM "Lot" WHERE id = $1`, [task.lot.id]))[0]!.code
    const scan = await ok(call('tablet', 'GET', `/inventory/putaway/scan?code=${lot}`))
    expect(scan).toMatchObject({ from: { code: 'A1-RCV' }, suggestion: { location: { code: 'A1-BULK-01' }, why: 'DEFAULT' } })
    expect(scan.tasks.map((entry: Json) => entry.id)).toContain(task.id)
    const first = await ok(call('tablet', 'POST', '/inventory/putaway', { code: lot, placeCode: 'BIN-A1-BULK-01', quantity: '15', taskId: task.id }), 201)
    expect(first.tasks).toEqual([expect.objectContaining({ id: task.id, status: 'TAKEN' })])
    expect(paths(await refused(call('tablet', 'POST', `/inventory/tasks/${task.id}/done`, {}), 409))).toContain('refusal/STILL_THERE')
    const rest = await ok(call('tablet', 'POST', '/inventory/putaway', { code: lot, placeCode: 'BIN-A1-BULK-01' }), 201)
    expect(rest.tasks).toEqual([expect.objectContaining({ id: task.id, status: 'DONE' })])
    expect(await taskRow(task.id)).toMatchObject({ status: 'DONE', takenByWorkerId: A.worker, doneByWorkerId: A.worker })
    const undone = await ok(call('tablet', 'POST', `/inventory/bin-moves/${rest.moveIds[0]}/undo`), 201)
    expect(undone.tasks).toEqual([expect.objectContaining({ kind: 'PUT_AWAY', status: 'OPEN', from: expect.objectContaining({ code: 'A1-RCV' }), note: 'Asked again: the move that did it was undone.' })])
  })

  it('the put-away asked again is done when its goods leave the dock', async () => {
    const open = (await ok(call('warehouse', 'GET', `/inventory/tasks?kind=PUT_AWAY&siteId=${A.siteA1}`))).tasks.filter((entry: Json) => entry.lot?.id === received.lotId)
    expect(open).toHaveLength(1)
    await ok(call('tablet', 'POST', '/inventory/putaway', { code: received.code, placeCode: 'BIN-A1-BULK-01' }), 201)
    expect((await taskRow(open[0].id)).status).toBe('DONE')
    expect(num(await stockAt(received.lotId, P.dock))).toBe(0)
  })
})

describe('the quarantine move a hold asks (WT1:01, QHS-078)', () => {
  let hold: Json
  let task: Json

  it('is a QUARANTINE task to the quarantine place, in the tablet’s inbox', async () => {
    hold = (await ok(call('warehouse', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [received.lotId], reasonCode: 'SUPPLIER_CHECK', reasonNote: 'Made-up shade complaint', askQuarantine: true }), 201)).hold
    await handle(await lastOf('quality.hold_placed', hold.id))
    const { tasks } = await ok(call('warehouse', 'GET', `/inventory/tasks?sourceType=QualityHold&sourceId=${hold.id}`))
    expect(tasks).toEqual([expect.objectContaining({ kind: 'QUARANTINE', status: 'OPEN', to: expect.objectContaining({ code: 'A1-QUA' }), lot: expect.objectContaining({ id: received.lotId }) })])
    task = tasks[0]
    const inbox = await ok(call('tablet', 'GET', '/inventory/tasks/inbox'))
    expect(inbox.tasks.map((entry: Json) => entry.id)).toContain(task.id)
    expect(inbox.counts.QUARANTINE).toBeGreaterThanOrEqual(1)
    // Stock on hold moves only into quarantine.
    const shelf = await refused(call('tablet', 'POST', '/inventory/bin-moves', { code: received.code, placeCode: 'BIN-A1-PF-01', quantity: '1' }), 409)
    expect(shelf.message).toBe(`Lot ${received.code} is on a quality hold: it moves only into a quarantine place until quality releases it.`)
    // A tap is not the confirmation; a sewing tablet may not move it.
    expect(paths(await refused(call('tablet', 'POST', `/inventory/tasks/${task.id}/done`, {}), 409))).toContain('refusal/SCAN_THE_PLACE')
    await refused(call('sewer', 'POST', `/inventory/tasks/${task.id}/done`, { placeCode: 'A1-QUA' }), 403)
  })

  it('a scan of another place is refused; the quarantine place confirms the hold’s move and closes the task', async () => {
    const wrong = await refused(call('tablet', 'POST', `/inventory/tasks/${task.id}/done`, { placeCode: 'BIN-A1-BULK-01' }), 400)
    expect(wrong.issues).toEqual([{ path: 'body/placeCode', message: 'A1-BULK-01 is not a quarantine place: scan the label of the quarantine place (A1-QUA).' }])
    const answer = await ok(call('tablet', 'POST', `/inventory/tasks/${task.id}/done`, { placeCode: 'a1-qua', version: task.version }))
    expect(answer.task).toMatchObject({ id: task.id, status: 'DONE' })
    expect(answer.moved.length).toBeGreaterThan(0)
    expect(num(await stockAt(received.lotId, P.bulk))).toBe(0)
    expect(num(await stockAt(received.lotId, P.quarantine))).toBe(40)
    const [row] = await admin<Json>(`SELECT quarantine::text, "quarantineLocationId" FROM "QualityHold" WHERE id = $1`, [hold.id])
    expect(row).toEqual({ quarantine: 'MOVED', quarantineLocationId: P.quarantine })
    expect(await taskRow(task.id)).toMatchObject({ status: 'DONE', doneByWorkerId: A.worker })
    // The hold's change makes nothing more.
    await handle(await lastOf('quality.hold_changed', hold.id))
    expect((await ok(call('warehouse', 'GET', `/inventory/tasks?status=ALL&sourceType=QualityHold&sourceId=${hold.id}`))).tasks).toHaveLength(1)
  })

  it('the office’s confirm is the same act: refused in the database’s words while part of the stock is in a frozen count line', async () => {
    const second = (await ok(call('warehouse', 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [lining.lotId], reasonCode: 'SUPPLIER_CHECK', reasonNote: 'Made-up second check', askQuarantine: true }), 201)).hold
    await handle(await lastOf('quality.hold_placed', second.id))
    const [open] = (await ok(call('warehouse', 'GET', `/inventory/tasks?sourceType=QualityHold&sourceId=${second.id}`))).tasks
    expect(open).toMatchObject({ kind: 'QUARANTINE', status: 'OPEN' })
    // The lot also lies in the count bay, frozen by the running count: the move waits for the count, in its words.
    const frozen = await refused(call('warehouse', 'POST', `/quality/holds/${second.id}/quarantine/confirm`, { version: second.version, placeCode: 'A1-QUA' }), 409)
    expect(paths(frozen)).toContain('warehouse/COUNT_FROZEN')
    expect((await taskRow(open.id)).status).toBe('OPEN')
  })
})

describe('the inbox and its steps (SCM-274, WT1:02)', () => {
  let forRole: Json
  let forOther: Json
  let forAnyone: Json

  it('the office hands out tasks; the inbox shows mine, my role’s and anyone’s, never another’s', async () => {
    forRole = (await ok(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'MOVE', itemId: lining.itemId, lotId: lining.lotId, fromLocationId: P.quarantine, toLocationId: P.pickFace, assignedRoleId: A.floorRole, note: 'Made-up move' }), 201)).task
    forOther = (await ok(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'COUNT', fromLocationId: P.pickFace, assignedWorkerId: A.otherWorker }), 201)).task
    forAnyone = (await ok(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'PICK', dueAt: '2026-11-12T06:00:00.000Z' }), 201)).task
    expect(forOther).toMatchObject({ assigned: 'PERSON' })
    expect(JSON.stringify(forOther)).not.toContain(A.otherWorker)
    const mine = await ok(call('tablet', 'GET', '/inventory/tasks/inbox'))
    const ids = mine.tasks.map((entry: Json) => entry.id)
    expect(ids).toEqual(expect.arrayContaining([forRole.id, forAnyone.id]))
    expect(ids).not.toContain(forOther.id)
    expect(mine.tasks.find((entry: Json) => entry.id === forRole.id)).toMatchObject({ audience: 'ROLE', mine: false })
    const theirs = await ok(call('colleague', 'GET', '/inventory/tasks/inbox'))
    expect(theirs.tasks.find((entry: Json) => entry.id === forOther.id)).toMatchObject({ audience: 'MINE' })
    // Refusals in the office: a role of the office, both a role and a person, a place of another site.
    const role = (await admin<Json>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND audience = 'OFFICE' LIMIT 1`, [A.tenant]))[0]!.id
    expect(paths(await refused(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'MOVE', assignedRoleId: role }), 400))).toEqual(['body/assignedRoleId'])
    expect(paths(await refused(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'MOVE', assignedRoleId: A.floorRole, assignedWorkerId: A.worker }), 400))).toEqual(['body/assignedWorkerId'])
    expect(paths(await refused(call('warehouse', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'MOVE', fromLocationId: (await admin<Json>(`SELECT id FROM "Location" WHERE "siteId" = $1 LIMIT 1`, [A.siteB1]))[0]!.id }), 400))).toEqual(['body/fromLocationId'])
    await refused(call('viewer', 'POST', '/inventory/tasks', { siteId: A.siteA1, kind: 'MOVE' }), 403)
  })

  it('takes, gives back and does a task; refuses another’s, a stale version and a done one', async () => {
    const taken = (await ok(call('tablet', 'POST', `/inventory/tasks/${forAnyone.id}/take`, { version: forAnyone.version }))).task
    expect(taken).toMatchObject({ status: 'TAKEN', mine: true })
    expect(paths(await refused(call('colleague', 'POST', `/inventory/tasks/${forAnyone.id}/take`, {}), 409))).toContain('refusal/TAKEN_BY_OTHER')
    expect(paths(await refused(call('colleague', 'POST', `/inventory/tasks/${forAnyone.id}/give-back`, {}), 409))).toContain('refusal/NOT_YOURS')
    expect((await ok(call('colleague', 'GET', '/inventory/tasks/inbox'))).tasks.map((entry: Json) => entry.id)).not.toContain(forAnyone.id)
    await refused(call('tablet', 'POST', `/inventory/tasks/${forAnyone.id}/give-back`, { version: forAnyone.version }), 409)
    const back = (await ok(call('tablet', 'POST', `/inventory/tasks/${forAnyone.id}/give-back`, { version: taken.version }))).task
    expect(back).toMatchObject({ status: 'OPEN', mine: false })
    const done = (await ok(call('tablet', 'POST', `/inventory/tasks/${forAnyone.id}/done`, {}))).task
    expect(done.status).toBe('DONE')
    expect(paths(await refused(call('tablet', 'POST', `/inventory/tasks/${forAnyone.id}/done`, {}), 409))).toContain('refusal/DONE')
    expect(paths(await refused(call('tablet', 'POST', `/inventory/tasks/${forOther.id}/take`, {}), 409))).toContain('refusal/NOT_FOR_YOU')
    // The office's one task: who did it is a person while the site's PERFORMANCE gate is closed.
    const record = await ok(call('warehouse', 'GET', `/inventory/tasks/${forAnyone.id}`))
    expect(record.doneBy).toEqual({ id: null, name: null, worker: true, hidden: true })
  })

  it('the queue applies the steps as the task stands when they arrive', async () => {
    const take = await applyQueued(caller('colleague'), { clientEventId: newId(), kind: 'inventory.task.take', payload: { taskId: forOther.id } }, { key: `q-${run}-1` })
    expect(take).toMatchObject({ status: 'accepted', result: { type: 'WarehouseTask', id: forOther.id } })
    const done = await applyQueued(caller('colleague'), { clientEventId: newId(), kind: 'inventory.task.done', payload: { taskId: forOther.id } }, { key: `q-${run}-2` })
    expect(done.status).toBe('accepted')
    const again = await applyQueued(caller('colleague'), { clientEventId: newId(), kind: 'inventory.task.done', payload: { taskId: forOther.id } }, { key: `q-${run}-3` })
    expect(again).toMatchObject({ status: 'refused', refusal: expect.objectContaining({ code: 'DONE' }) })
  })

  it('the office changes and cancels an open task with the reason', async () => {
    const changed = (await ok(call('warehouse', 'PATCH', `/inventory/tasks/${forRole.id}`, { version: forRole.version, assignedWorkerId: A.worker, dueAt: '2026-11-13T08:00:00.000Z' }))).task
    expect(changed).toMatchObject({ assigned: 'PERSON', assignedRoleId: null, dueAt: '2026-11-13T08:00:00.000Z' })
    await refused(call('warehouse', 'PATCH', `/inventory/tasks/${forRole.id}`, { version: forRole.version, note: 'stale' }), 409)
    const cancelled = (await ok(call('warehouse', 'POST', `/inventory/tasks/${forRole.id}/cancel`, { version: changed.version, reason: 'Moved by the office already (test).' }))).task
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Moved by the office already (test).' })
    expect(paths(await refused(call('warehouse', 'POST', `/inventory/tasks/${forRole.id}/cancel`, { version: cancelled.version, reason: 'again' }), 409))).toContain('refusal/CANCELLED')
    const list = await ok(call('viewer', 'GET', `/inventory/tasks?siteId=${A.siteA1}&status=ALL`))
    expect(list.tasks.length).toBeGreaterThan(3)
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${A.worker}|${A.otherWorker}`))
  })
})

describe('a due count makes its COUNT task', () => {
  it('opens one while the schedule is due and cancels it once it is not', async () => {
    const [schedule] = await admin<Json>(`SELECT id FROM "CountSchedule" WHERE "tenantId" = $1 AND active ORDER BY id LIMIT 1`, [A.tenant])
    await admin(`UPDATE "CountSchedule" SET "nextDueOn" = current_date - 1 WHERE id = $1`, [schedule!.id])
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const first = await runTimedTaskSources({ database, log })
    expect(first.failed).toBe(0)
    const tasks = (await ok(call('warehouse', 'GET', `/inventory/tasks?sourceType=CountSchedule&sourceId=${schedule!.id}`))).tasks
    expect(tasks).toEqual([expect.objectContaining({ kind: 'COUNT', status: 'OPEN' })])
    await runTimedTaskSources({ database, log })
    expect((await ok(call('warehouse', 'GET', `/inventory/tasks?sourceType=CountSchedule&sourceId=${schedule!.id}`))).tasks).toHaveLength(1)
    await admin(`UPDATE "CountSchedule" SET "nextDueOn" = current_date + 30 WHERE id = $1`, [schedule!.id])
    await runTimedTaskSources({ database, log })
    expect(await taskRow(tasks[0].id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'No longer due: the count schedule moved on or was retired.' })
  })
})
