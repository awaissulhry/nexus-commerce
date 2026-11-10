import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedChanges } from '../../../../../../packages/factory-db/seed/changes'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedCutting } from '../../../../../../packages/factory-db/seed/cutting'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedInstructions } from '../../../../../../packages/factory-db/seed/instructions'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seed as seedStylesDepth } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Change requests and change orders (B-W2b-226; PRD-169, PRD-170, PRD-175, PRD-259, MES-006) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the floor's insert-only grant
 * and B-W2b-212's …_changes_samples_w2b_guards are real), on the seeds up to the change orders: SEED-JKT-02 (released revision 1,
 * IN_PRODUCTION under the tenant-wide rule "needs a change order", SEED-WO-0001 in progress and SEED-WO-0002 a draft at plant
 * A1), the brand P1 (SEED-C1), and SEED-ECO-0001 (a draft). Made up here: a production manager, a quality inspector and a sales
 * person with their system roles; every word and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/changes`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const NS = 'w2b226-changes'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const P1 = idOf('party:P1')

const PEOPLE = { manager: newId(), quality: newId(), sales: newId() } as const
const ROLES = { manager: 'production_manager', quality: 'quality_inspector', sales: 'sales' } as const
const MANAGE: Permission[] = [
  'product.changes.view',
  'product.changes.request',
  'product.changes.manage',
  'product.changes.approve',
  'product.styles.view',
  'product.styles.manage',
  'product.bom.view',
  'product.bom.manage',
  'product.bom.release',
  'product.routing.view',
  'product.routing.manage',
  'workorders.view',
  'files.upload',
  'files.read',
  'threads.read',
  'home.view',
] as Permission[]
const grant = (permissions: Permission[], sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies: 'all', sites, parties: 'all' })
const office = (actorId: string, permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions)] })
const floorAt = (siteId: string): SessionContext => ({ audience: 'floor', tenantId: T, actorId: newId(), siteId, deviceId: newId(), grants: [grant(['floor.work', 'production.scan'] as Permission[], [siteId])] })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(PEOPLE.manager, MANAGE),
  quality: office(PEOPLE.quality, ['product.changes.view', 'product.changes.request', 'product.changes.approve', 'workorders.view', 'home.view'] as Permission[]),
  sales: office(PEOPLE.sales, ['product.changes.view', 'product.changes.request', 'home.view'] as Permission[]),
  viewer: office(newId(), ['product.changes.view'] as Permission[]),
  floor: floorAt(siteA1),
  floorB1: floorAt(siteB1),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `c-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const styleOf = async (code: string): Promise<string> => (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code])).id
const workOrderOf = async (number: string): Promise<string> => (await one('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number])).id
const revisionRow = async (styleId: string, revision: number): Promise<Json> => one('SELECT id, version, status::text AS status FROM "StyleRevision" WHERE "styleId" = $1 AND revision = $2', [styleId, revision])

/** The worker's fan-out over the outbox rows of these types since the mark; the notifications made. */
let mark = new Date(0)
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [T, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(T, `test-${row.id}`)), envelope)
  }
  mark = new Date()
  return made
}
const noticesOf = async (person: keyof typeof PEOPLE): Promise<Json[]> => admin(`SELECT "messageKey", category, "recordType", params FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id`, [PEOPLE[person]])

let jacket2 = ''
let wo1 = ''

beforeAll(async () => {
  h = await startHarness('product_changes')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  const roles = await seedRoles({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedCutting({ db: h.database, namespace: NS })
  await seedInstructions({ db: h.database, namespace: NS })
  await seedSizesDepth({ db: h.database, namespace: NS })
  await seedSales({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  await seedStylesDepth({ db: h.database, namespace: NS })
  await seedChanges({ db: h.database, namespace: NS })
  for (const [person, role] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as keyof typeof PEOPLE]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `w2b226-${person}-${run}@example.test`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, userId, roles.roleIds[role]])
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  jacket2 = await styleOf('SEED-JKT-02')
  wo1 = await workOrderOf('SEED-WO-0001')
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let floorRequest = ''
let customerRequest = ''

describe('a spec problem from the floor (PRD-259)', () => {
  it('inserts a request of its site it cannot read back; a resend answers the first; the office sees it unnumbered', async () => {
    const clientEventId = newId()
    const body = { clientEventId, workOrderId: wo1, problem: 'WRONG_MEASUREMENT', note: 'Sleeve 2 cm longer than the card (made-up)' }
    const first = await ok('floor', 'POST', '/product/floor/change-requests', body, 201)
    floorRequest = first.changeRequest.id
    expect(first.replayed).toBe(false)
    const again = await call('floor', 'POST', '/product/floor/change-requests', body)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toMatchObject({ changeRequest: { id: floorRequest }, replayed: true })
    expect(await one('SELECT count(*)::int AS n FROM "ChangeRequest" WHERE "tenantId" = $1 AND "source" = \'FLOOR\' AND "workOrderId" = $2 AND "createdById" IS NULL', [T, wo1])).toMatchObject({ n: 2 })
    // The floor reads no request (no audience); another site's tablet does not find the work order.
    expect(await no('floor', 'GET', `/product/change-requests/${floorRequest}`, undefined, 403)).toMatchObject({ code: 'forbidden' })
    await no('floorB1', 'POST', '/product/floor/change-requests', { ...body, clientEventId: newId() }, 404)
    const { changeRequest } = await ok('manager', 'GET', `/product/change-requests/${floorRequest}`)
    expect(changeRequest).toMatchObject({ number: null, source: 'FLOOR', status: 'OPEN', siteId: siteA1, title: 'Spec problem: wrong measurement', workOrder: { number: 'SEED-WO-0001' }, revision: { revision: 1 }, createdById: null })
    expect(changeRequest.reason).toContain('work order SEED-WO-0001')
    expect(changeRequest.made).toMatchObject({ cut: expect.any(Object), worked: expect.any(Object) })
  })

  it('adds its photo through the file store while nobody decided it; from the queue too', async () => {
    const bytes = Buffer.from(`made-up photo ${run}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const announced = await ok('floor', 'POST', `/product/floor/change-requests/${floorRequest}/photos`, { originalName: 'sleeve.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length, sha256 }, 201)
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })).statusCode).toBe(200)
    expect((await ok('floor', 'POST', `/product/floor/change-requests/${floorRequest}/photos/${announced.file.id}/complete`)).file).toMatchObject({ status: 'AVAILABLE', kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'] })
    expect((await ok('manager', 'GET', `/product/change-requests/${floorRequest}`)).changeRequest).toMatchObject({ photos: 1, photosList: [expect.objectContaining({ originalName: 'sleeve.jpg' })] })
    await no('floorB1', 'POST', `/product/floor/change-requests/${floorRequest}/photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 3, sha256 }, 404)
    // The tablet's queue: the same command, the request's id as the answer.
    const floor = SESSIONS.floor as Extract<SessionContext, { audience: 'floor' }>
    const caller = callerFor(h.database, { ...floor, requestId: `queue-${run}` })
    const applied = await applyQueued(caller, { clientEventId: newId(), kind: 'product.change.report', payload: { workOrderId: wo1, problem: 'UNCLEAR' } }, { key: `q-${run}` })
    expect(applied).toMatchObject({ status: 'accepted', result: { type: 'ChangeRequest' } })
    const refused = await applyQueued(caller, { clientEventId: newId(), kind: 'product.change.report', payload: { workOrderId: wo1, problem: 'SMELLS' } }, { key: `q2-${run}` })
    expect(refused.status).toBe('refused')
  })
})

describe('change requests in the office (PRD-169, MES-006)', () => {
  it('raises a customer request numbered at once; refuses a request without its customer or about another style’s work order', async () => {
    const raised = await ok('sales', 'POST', '/product/change-requests', { styleId: jacket2, companyId: companyA, source: 'CUSTOMER', partyId: P1, title: 'Longer back panel', reason: 'The brand asks 1 cm more from size 52 (made-up).', priority: 'HIGH' }, 201)
    customerRequest = raised.changeRequest.id
    expect(raised.changeRequest).toMatchObject({ source: 'CUSTOMER', status: 'OPEN', party: { code: 'SEED-C1' }, createdById: PEOPLE.sales, number: expect.stringMatching(/^CR-/) })
    expect((await no('sales', 'POST', '/product/change-requests', { styleId: jacket2, companyId: companyA, source: 'CUSTOMER', title: 'x', reason: 'y' }, 400)).issues[0].path).toBe('body/partyId')
    const jacket1 = await styleOf('SEED-JKT-01')
    expect((await no('sales', 'POST', '/product/change-requests', { styleId: jacket1, source: 'OFFICE', workOrderId: wo1, title: 'x', reason: 'y' }, 400)).issues[0].path).toBe('body/workOrderId')
    await no('viewer', 'POST', '/product/change-requests', { styleId: jacket2, companyId: companyA, source: 'OFFICE', title: 'x', reason: 'y' }, 403)
  })

  it('shows a work order’s pop-up: what is cut and worked, the requests about it', async () => {
    const view = await ok('quality', 'GET', `/product/change-requests/work-orders/${wo1}`)
    expect(view.workOrder).toMatchObject({ number: 'SEED-WO-0001', style: { code: 'SEED-JKT-02' }, revision: { revision: 1 } })
    expect(view.made.cut.bundles).toBeGreaterThanOrEqual(0)
    expect(view.requests.map((row: Json) => row.source)).toContain('FLOOR')
  })

  it('triages: a rejection says why; the floor request is numbered when first taken up', async () => {
    const before = (await ok('manager', 'GET', `/product/change-requests/${floorRequest}`)).changeRequest
    expect(refusal(await no('manager', 'POST', `/product/change-requests/${floorRequest}/move`, { version: before.version, to: 'REJECTED' }, 409))).toBe('refusal/REASON_NEEDED')
    await no('sales', 'POST', `/product/change-requests/${floorRequest}/move`, { version: before.version, to: 'IN_REVIEW' }, 403)
    const reviewed = (await ok('manager', 'POST', `/product/change-requests/${floorRequest}/move`, { version: before.version, to: 'IN_REVIEW' })).changeRequest
    expect(reviewed).toMatchObject({ status: 'IN_REVIEW', number: expect.stringMatching(/^CR-/) })
    const accepted = (await ok('manager', 'POST', `/product/change-requests/${customerRequest}/move`, { version: (await ok('manager', 'GET', `/product/change-requests/${customerRequest}`)).changeRequest.version, to: 'ACCEPTED' })).changeRequest
    expect(accepted).toMatchObject({ status: 'ACCEPTED', decidedById: PEOPLE.manager })
    const list = await ok('manager', 'GET', '/product/change-requests?tile=ACCEPTED_FREE')
    expect(list.rows.map((row: Json) => row.id)).toContain(customerRequest)
    expect(list.counts.TO_TRIAGE).toBeGreaterThanOrEqual(1)
    // A notification to who triages, the style's owner; the decision to whoever raised it.
    expect(await fanOutSince(['change_request.raised', 'change_request.changed'])).toBeGreaterThan(0)
    expect((await noticesOf('manager')).map((row) => row.messageKey)).toContain('notifications.changes.requestRaised')
    expect((await noticesOf('sales')).map((row) => row.messageKey)).toContain('notifications.changes.requestAccepted')
  })
})

let order: Json
const orderOf = async (id: string): Promise<Json> => (await ok('manager', 'GET', `/product/change-orders/${id}`)).changeOrder

describe('a change order with one approval stage (PRD-170, MES-006)', () => {
  it('under "needs a change order" a new revision is refused in words that lead to a change order', async () => {
    const rev1 = await revisionRow(jacket2, 1)
    const error = await no('manager', 'POST', `/product/styles/${jacket2}/revisions/${rev1.id}/copy`, { changeNote: 'Direct' }, 409)
    expect(refusal(error)).toBe('refusal/NEEDS_CHANGE_ORDER')
    expect(error.message).toContain('New change order')
  })

  it('writes the draft: requests carried, its revision started from the change order, lines and work in progress', async () => {
    order = (await ok('manager', 'POST', '/product/change-orders', { styleId: jacket2, companyId: companyA, title: 'Longer back panel', reason: 'The brand and the floor both found it short (made-up).', requestIds: [customerRequest, floorRequest] }, 201)).changeOrder
    expect(order).toMatchObject({ status: 'DRAFT', number: expect.stringMatching(/^ECO-/), fromRevision: { revision: 1, status: 'RELEASED' }, toRevision: null, authorId: PEOPLE.manager, requests: 2 })
    expect(order.actions.submit.refusal.code).toBe('NO_DRAFT_REVISION')
    order = (await ok('manager', 'POST', `/product/change-orders/${order.id}/draft-revision`, { version: order.version })).changeOrder
    expect(order.toRevision).toMatchObject({ revision: 2, status: 'DRAFT' })
    expect(order.compare).toMatchObject({ styleId: jacket2, from: order.fromRevision.id, to: order.toRevision.id })
    // The redline is edited in W1's own BOM while the change order is a draft.
    const line = await one('SELECT id FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [order.toRevision.id])
    const draft = await revisionRow(jacket2, 2)
    await ok('manager', 'PATCH', `/product/styles/${jacket2}/revisions/${draft.id}/bom/lines/${line.id}`, { version: draft.version, wastagePct: '9' })
    order = (await ok('manager', 'POST', `/product/change-orders/${order.id}/lines`, { version: order.version, recordType: 'BomLine', recordId: line.id, field: 'wastagePct', before: '5', after: '9', note: 'More leather (made-up).' })).changeOrder
    expect(refusal(await no('manager', 'POST', `/product/change-orders/${order.id}/lines`, { version: order.version, recordType: 'bomLine', recordId: line.id, after: 1 }, 409))).toBe('refusal/LINE_INVALID')
    order = (await ok('manager', 'PUT', `/product/change-orders/${order.id}/work-in-progress`, { version: order.version, lines: [{ workOrderId: wo1, disposition: 'REWORK' }] })).changeOrder
    expect(order.lines).toHaveLength(1)
    expect(order.workInProgress).toEqual([expect.objectContaining({ workOrder: expect.objectContaining({ number: 'SEED-WO-0001', revision: 1 }), disposition: 'REWORK' })])
    expect(order.openWorkOrders.map((row: Json) => row.number)).toContain('SEED-WO-0002')
  })

  it('names approvers: never the author, only someone who may approve; then submits and freezes the draft', async () => {
    expect(refusal(await no('manager', 'PUT', `/product/change-orders/${order.id}/approvers`, { version: order.version, approvers: [{ userId: PEOPLE.manager }] }, 409))).toBe('refusal/OWN_APPROVAL')
    expect(refusal(await no('manager', 'PUT', `/product/change-orders/${order.id}/approvers`, { version: order.version, approvers: [{ userId: PEOPLE.sales }] }, 409))).toBe('refusal/APPROVER_CANNOT')
    order = (await ok('manager', 'PUT', `/product/change-orders/${order.id}/approvers`, { version: order.version, approvers: [{ userId: PEOPLE.quality, required: true }] })).changeOrder
    expect(order.approvalsList).toEqual([expect.objectContaining({ approverId: PEOPLE.quality, approverName: 'Made-up quality', required: true, decision: null })])
    order = (await ok('manager', 'POST', `/product/change-orders/${order.id}/submit`, { version: order.version })).changeOrder
    expect(order).toMatchObject({ status: 'SUBMITTED', approvals: { approved: 0, required: 1 } })
    // The approver is asked (PRD-175), while it waits.
    expect(await fanOutSince(['change_order.changed'])).toBeGreaterThan(0)
    expect((await noticesOf('quality')).map((row) => [row.messageKey, row.category])).toContainEqual(['notifications.changes.approvalAsked', 'APPROVAL'])
    // What it says is fixed: its lines, and its draft revision in W1's BOM.
    expect(refusal(await no('manager', 'PUT', `/product/change-orders/${order.id}/work-in-progress`, { version: order.version, lines: [] }, 409))).toBe('refusal/ORDER_NOT_DRAFT')
    const line = await one('SELECT id FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [order.toRevision.id])
    const draft = await revisionRow(jacket2, 2)
    expect(refusal(await no('manager', 'PATCH', `/product/styles/${jacket2}/revisions/${draft.id}/bom/lines/${line.id}`, { version: draft.version, wastagePct: '10' }, 409))).toBe('refusal/DRAFT_UNDER_CHANGE_ORDER')
    // Released only once approved, also through W1's own release.
    expect(refusal(await no('manager', 'POST', `/product/styles/${jacket2}/revisions/${draft.id}/release`, { version: draft.version }, 409))).toBe('refusal/NOT_APPROVED')
    expect((await ok('quality', 'GET', '/product/change-orders?tile=MINE_TO_APPROVE')).rows.map((row: Json) => row.id)).toEqual([order.id])
  })

  it('is decided by the named approver only, a rejection with why; the database keeps the four eyes', async () => {
    expect(refusal(await no('manager', 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'APPROVED' }, 409))).toBe('refusal/OWN_APPROVAL')
    expect(refusal(await no('quality', 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'REJECTED' }, 409))).toBe('refusal/REASON_NEEDED')
    // Past the API: the database refuses the author as an approver, for every login.
    await expect(h.db.admin.query(`UPDATE "ChangeApproval" SET "approverId" = $1 WHERE "changeOrderId" = $2`, [PEOPLE.manager, order.id])).rejects.toThrow(/never its author/)
    order = (await ok('quality', 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'APPROVED' })).changeOrder
    expect(order).toMatchObject({ status: 'APPROVED', approvals: { approved: 1, required: 1 } })
    expect(order.requestsList.map((row: Json) => row.status)).toEqual(['ACCEPTED', 'ACCEPTED'])
    expect(refusal(await no('quality', 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'APPROVED' }, 409))).toBe('refusal/ORDER_MOVE')
  })

  it('releases its revision through W1’s release: the old one obsolete, the order released, its requests done; people told', async () => {
    order = (await ok('manager', 'POST', `/product/change-orders/${order.id}/release`, { version: order.version })).changeOrder
    expect(order).toMatchObject({ status: 'RELEASED', releasedById: PEOPLE.manager, toRevision: { revision: 2, status: 'RELEASED' }, fromRevision: { status: 'OBSOLETE' } })
    expect(order.requestsList.map((row: Json) => row.status)).toEqual(['DONE', 'DONE'])
    expect((await revisionRow(jacket2, 2)).status).toBe('RELEASED')
    // The floor's banner reads the decision for WO-0001: rework to the new pages.
    expect((await ok('floor', 'GET', `/production/work-orders/${wo1}/spec/newer`)).spec.newer).toMatchObject({ banner: true, newPages: true, decision: { disposition: 'REWORK', changeOrder: order.number } })
    expect(await fanOutSince(['change_order.changed'])).toBeGreaterThan(0)
    // The author hears the decision; the approver, who follows the change order, its release.
    expect((await noticesOf('manager')).map((row) => row.messageKey)).toContain('notifications.changes.orderDecided')
    expect((await noticesOf('quality')).map((row) => row.messageKey)).toContain('notifications.changes.orderReleased')
    expect((await ok('manager', 'GET', '/product/change-orders?tile=RELEASED_THIS_MONTH')).rows.map((row: Json) => row.id)).toContain(order.id)
    expect(refusal(await no('manager', 'POST', `/product/change-orders/${order.id}/cancel`, { version: order.version, reason: 'Too late' }, 409))).toBe('refusal/ORDER_MOVE')
  })

  it('cancels a draft with why; a change order needs a released revision', async () => {
    const draft = (await ok('manager', 'POST', '/product/change-orders', { styleId: jacket2, companyId: companyA, title: 'Shorter cuff', reason: 'Made-up.' }, 201)).changeOrder
    await no('manager', 'POST', `/product/change-orders/${draft.id}/cancel`, { version: draft.version, reason: ' ' }, 400)
    const cancelled = (await ok('manager', 'POST', `/product/change-orders/${draft.id}/cancel`, { version: draft.version, reason: 'Merged into the next season (made-up).' })).changeOrder
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Merged into the next season (made-up).' })
    const jacket1 = await styleOf('SEED-JKT-01')
    expect(refusal(await no('manager', 'POST', '/product/change-orders', { styleId: jacket1, companyId: companyA, title: 'x', reason: 'y' }, 409))).toBe('refusal/NO_RELEASED_REVISION')
    expect((await orderOf(order.id)).status).toBe('RELEASED')
  })
})

// B-W2b-244 (Changes & versions, SCR-117): the screens' two reads (./screens.ts) and the list's Reason column.
describe('Changes & versions: released versions and the approver picker', () => {
  it('lists the released revisions newest first with the change order that released each and the revision it replaced', async () => {
    const { rows, complete } = await ok('viewer', 'GET', `/product/released-versions?styleId=${jacket2}`)
    expect(complete).toBe(true)
    expect(rows[0]).toMatchObject({ style: { id: jacket2, code: 'SEED-JKT-02' }, revision: { revision: 2, status: 'RELEASED' }, previous: { revision: 1 }, releasedById: PEOPLE.manager, changeOrder: { id: order.id, number: order.number } })
    expect(rows.map((row: Json) => row.revision.revision)).toEqual([...rows].sort((a: Json, b: Json) => b.releasedAt.localeCompare(a.releasedAt)).map((row: Json) => row.revision.revision))
    expect((await ok('viewer', 'GET', `/product/released-versions?q=${encodeURIComponent(order.number)}`)).rows.map((row: Json) => row.revision.id)).toEqual([order.toRevision.id])
    await no('floor', 'GET', '/product/released-versions', undefined, 403)
  })

  it('offers as approvers the people who may approve over the company, never the author; only to who writes change orders', async () => {
    const draft = (await ok('manager', 'POST', '/product/change-orders', { styleId: jacket2, companyId: companyA, title: 'Pocket flap (made-up)', reason: 'Made-up.' }, 201)).changeOrder
    expect(draft.reason).toBe('Made-up.')
    const { people, authorId } = await ok('manager', 'GET', `/product/change-orders/${draft.id}/approver-options`)
    expect(authorId).toBe(PEOPLE.manager)
    const ids = people.map((person: Json) => person.id)
    expect(ids).toContain(PEOPLE.quality)
    expect(ids).not.toContain(PEOPLE.manager)
    expect(ids).not.toContain(PEOPLE.sales)
    expect(people.find((person: Json) => person.id === PEOPLE.quality)).toEqual({ id: PEOPLE.quality, name: 'Made-up quality' })
    await no('quality', 'GET', `/product/change-orders/${draft.id}/approver-options`, undefined, 403)
    expect((await ok('viewer', 'GET', '/product/change-orders?status=DRAFT')).rows.find((row: Json) => row.id === draft.id)).toMatchObject({ reason: 'Made-up.' })
  })
})
