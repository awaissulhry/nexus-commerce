import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
import { batchGroupKey, orderChangeBatch } from '@nexus/factory-domain/notifications/rules'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
import { FLOOR_NOTE_MAX, noPriceIn } from '@nexus/factory-domain/sales/orders/change-notes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedOrderPage } from '../../../../../packages/factory-db/seed/order-page' // B-OP-071
import { seed as seedShipping } from '../../../../../packages/factory-db/seed/shipping' // B-OP-071
import { seed as seedSubcontract } from '../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { brandKeeperHandler } from '../../modules/production/brand/keeper'
import { issueAnsweredHandler } from '../../modules/production/issues/answered'
import { supervisorFollowsHandler } from '../../modules/production/supervisor/follows'
import { findMarkers, markersOf, type Marker } from '../../modules/production/testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../../modules/production/testing/urgency-world'
import { orderChangeNotesHandler } from '../../modules/sales/orders/change-notes'
import { forgetProgress } from '../../modules/sales/portal-orders/progress'
import { trackingNotesHandler } from '../../modules/shipping/own-transport/tracking-notes' // B-OP-071
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { freshGuard, mailedCode, portalBrowser } from '../../platform/auth/portal/testing/portal'
import type { Answer } from '../../platform/auth/sessions/testing/harness'
import { notificationsHandler } from '../../platform/notifications/fan-out'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { partnerNotificationsHandler } from '../../platform/portal/notifications/fan-out'
import { announce, drain, pdf, type World } from '../testing/world'

/**
 * B-SA-089 — GOLDEN FLOW SALES PAGE: ONE CHANGE OF A CUSTOMER'S ORDER, TOLD TO EVERYONE, BEHIND THE BRAND WALL (sales page plan §1
 * N3, §2 decisions 1–4, §6; lead picks R1, R2, R3, R7, R8, P17'; 14-change-flow §2.0 S1–S8; the Owner rule 2026-11-16: "One brand
 * must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And
 * manage it all as well.").
 *
 * The world (../../modules/production/testing/urgency-world.ts): the seeds up to shipping, the production two-brand harness — Brand
 * Alpha = the seeds' P1 (its private label: the seeds' jacket SEED-JKT-02), Brand Beta = the threads' second brand — both portals
 * on; plus the subcontracting seed (the workshop P2). Alpha's order of the flow: line 10, its private-label jacket in black, 4 of
 * size 50 and 4 of size 52, made by one work order the planner makes and releases; its second order: line 10 of the harness's
 * jacket of OUR OWN collection. People: Alpha's buyer, Beta's buyer and the workshop's person, signed in by code; the office people
 * with two-factor — Bea (Sales, every customer: she answers the customer), Sara (Sales, every customer: she follows the order),
 * Carla (planner: she follows the work order and applies the change), Dario (production manager limited to Alpha: Alpha's
 * supervisor, he follows by himself), Bruno (production manager: Alpha's backup, he follows nothing), Bice (Sales limited to Brand
 * Beta). `office.p2` is every office permission limited to Brand Beta. The worker's handlers the flow needs run in-process
 * (`settle`: the real relay — the order change's notes, both bells, the supervisor's follows, the keeper, an issue answered); the
 * scheduler never starts.
 *
 *   S0  the scene: the design ask switched on for Alpha (step-up), Alpha's supervisor and backup, the work order made and released,
 *       the workshop's job issued on it, Sara follows the order, Carla the work order; Dario follows both by himself
 *   S1  Alpha asks a size decrease (line 10, size 52: 4 → 1) while the line is released and not yet cut — the portal never takes a
 *       size change of a line already cut (its cut-off rule, unchanged by this plan, P6'): their own message in the order's
 *       conversation; Approvals and the order list it
 *   S2  cutting starts while the request waits: the floor's first bundle, 3 of size 52 (the database's floor reads 3)
 *   S3  after cutting started Alpha asks a DESIGN change of line 10 (its private label) with a sketch it uploads in the
 *       conversation: the impact says cutting started; their second message, the sketch attached; told it was received
 *   S4  the office answers the size change from the order's door: the order and its Changes read the request, the review window
 *       shows On the floor now and 2 extra pieces, Accept is held until their outcome is picked, then Accept with "keep as leftover
 *       for this customer": the amendment and a work-order change PROPOSED; the work order itself not touched
 *   S5  tell everyone: ONE system line (no price), ONE bell item per person (never the one who acted, never the backup who follows
 *       nothing, never Beta), a floor note with the customer's CODE and no names, the workshop told by its own job's number, the
 *       customer told (bell and live), our words in the conversation; Still to do waits on planning; who was told
 *   S6  Carla applies it with Lower to the order (never below the 3 cut): the cell at 3, Still to do closes, the closing line,
 *       the floor and the workshop told again, one bell item per person (never Carla); the extra pieces named in the office only; a
 *       new size change of the cut line is refused in the cut's words (a waiting design change holds no size ask)
 *   S7  the office answers the DESIGN change: one product style change for Alpha's own label, naming the request — no file copied,
 *       no work order held; the floor told to keep its revision; Still to do waits on product (its change order is product's
 *       flow, the golden product suite's)
 *   S8  a DESIGN ask on our own collection's jacket is held at Accept in words (Counter or Refuse only), refused in words the
 *       customer reads
 *   W   the wall at the end: nothing Beta's buyer, `office.p2` or Bice got names Alpha; Alpha's people never read who supervises,
 *       plans or follows, our work order, the workshop's job, the floor note or the system line; the workshop reads only its own
 *       job; nothing records who saw a floor note (R2)
 *   Z   no route answered 500 and no handler failed during the flow
 * And AT EVERY STEP (S0–S8): Beta's buyer and the people limited to Beta read Alpha's records as unknown (404) by every door, their
 * lists hold none of them, their bells nothing, every live message of the step reaches neither (the live wall, P17'), and every
 * answer they got is scanned for Alpha's markers (its names, codes, numbers, references, files, ids, the flow's own words).
 *
 * SQL reads ids and asserts. Four acts are not made through a route, each named where it is done: the world's set-up (orders typed
 * in the office scope as the harnesses do, back-dated role assignments, a made-up certificate of Alpha's jacket, the workshop's
 * portal on and its person), the floor's first bundle (cutting is the floor's flow), the workshop's job (a copy of the seeds' job,
 * issued: subcontracting is purchasing's flow) and nothing else. Every name, address and number is made up.
 * Run with `node scripts/factory/golden-flow.mjs sales-page` (long: alone, nice, one worker).
 *
 * B-OP-071 (order page plan, C07): after Z, the same world runs the order page's API flow, O0–OZ (its own head at the end of this
 * file): an office amend whose work orders follow or wait, an approval decided in place, the settlement share on a shared TD24, a
 * shipment made elsewhere for a held customer, tracking typed on it, its invoice naming the paper DDT, and a shared shipment of two
 * orders (after the N6 switch, B-OP-047) — the wall at every step, as above.
 */

let world: UrgencyWorld
const NS = 'sa89-golden-sales'
type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
type Person = Office | Portal
type Side = 'A' | 'B' | 'W'

const LONG = 600_000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// The flow's own words of Alpha's: none may ever reach Beta.
const SIZE_NOTE = 'Made-up Alpha note: our store takes fewer of the larger jacket this season.'
const SKETCH = 'Made-up Alpha stripe sketch.pdf'
const DESIGN_NOTE = 'Made-up Alpha design change: the reflective stripe moves from the back to both sleeves.'
const ACCEPT_ANSWER = 'Made-up Alpha answer: done, size 52 is one piece now.'
const REPLY = 'Made-up Alpha reply: the two pieces of size 52 already cut stay with you as leftover.'
const DESIGN_ANSWER = 'Made-up Alpha answer: we take the stripe to product for your jacket.'
const OWN_NOTE = 'Made-up Alpha design change: a darker lining on the shared jacket.'
const OWN_REFUSAL = 'Made-up Alpha refusal: this jacket is shared by many, we can offer a variant next season.'
const OVERRIDE = 'Made-up: the leather of this order arrives before it is cut.'
const FLOW_WORDS = [SIZE_NOTE, SKETCH, DESIGN_NOTE, ACCEPT_ANSWER, REPLY, DESIGN_ANSWER, OWN_NOTE, OWN_REFUSAL]

/** Every permission an office role can hold (the live wall's Beta-limited viewer), and every portal permission. */
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const PORTAL_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.partner === true).map((definition) => definition.name) as Permission[]

/** Bea answers the customer; Sara follows the order; Carla plans; Dario supervises Alpha; Bruno is Alpha's backup; Bice is limited to Beta. */
let bea: Office
let sara: Office
let carla: Office
let dario: Office
let bruno: Office
let bice: Office
let buyerA: Portal
let buyerB: Portal
let workshop: Portal

interface Order {
  readonly orderId: string
  readonly number: string
  readonly lineId: string
}
/** What later steps read of earlier ones. */
const G = {} as {
  X: Order
  Y: Order
  privateStyle: string
  wo: { id: string; number: string; cells: Record<string, string> }
  job: { id: string; number: string }
  sizeRequest: Json
  designRequest: Json
  ownRequest: Json
  sketch: string
  change: Json
  styleChange: { id: string; number: string }
  /** The correlations (= the bell batches) of the Accept, the apply and the design's Accept. */
  acceptBatch: string
  applyBatch: string
  designBatch: string
  /** The system lines and floor notes of the flow (their message ids). */
  lines: string[]
  floorNotes: string[]
  customerCode: string
}

// ---- calls: every answer of Alpha's, Beta's and the workshop's people is kept --------------------------------------------------

interface Seen {
  readonly who: string
  readonly url: string
  readonly status: number
  readonly body: unknown
  /** The ids the request itself named (left out of the scan: a person may send any id). */
  readonly asked: readonly string[]
}
const seen: Record<Side, Seen[]> = { A: [], B: [], W: [] }
const sides = new Map<Person, { side: Side; who: string }>()
const unexpected: ErrorReport[] = []

const T = () => world.ids.tenantId
const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const idsIn = (text: string): string[] => [...new Set((text.match(UUID) ?? []).map((id) => id.toLowerCase()))]
const pathOf = (body: Json): string => String(body.error?.issues?.at(-1)?.path ?? '')
const linesOfText = (text: string): string[] => text.split('\n')

/** A person's call through its own browser (cookies, CSRF, a fresh Idempotency-Key on a write); the answer kept by side. */
async function call(person: Person, method: Method, url: string, body?: unknown): Promise<{ status: number; body: Json; answer: Answer }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send(method, url, body ?? {}, { headers: { 'idempotency-key': `sa89-${newId()}` } })
  const parsed = typeof answer.body === 'object' && answer.body !== null ? (answer.body as Json) : {}
  const tag = sides.get(person)
  if (tag) seen[tag.side].push({ who: tag.who, url, status: answer.status, body: answer.body, asked: idsIn(`${url} ${JSON.stringify(body ?? null)}`) })
  return { status: answer.status, body: parsed, answer }
}
async function ok(person: Person, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 800)}`).toBe(status)
  return answer.body
}
/** An office person's write after a fresh step-up (the limits card). */
async function stepped(person: Office, method: Method, url: string, body: unknown, status = 200): Promise<Json> {
  await person.stepUp()
  return ok(person, method, url, body, status)
}
/** A call as `office.p2` (every office permission, limited to Brand Beta): its answers are kept for the scan. */
async function asBeta(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': 'office.p2', ...(method === 'GET' ? {} : { 'idempotency-key': `sa89-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  let parsed: Json = {}
  try {
    parsed = response.json() as Json
  } catch {
    parsed = {}
  }
  seen.B.push({ who: 'office.p2', url, status: response.statusCode, body: parsed, asked: idsIn(`${url} ${JSON.stringify(body ?? null)}`) })
  expect(response.statusCode, `office.p2 ${method} ${url}: ${response.body.slice(0, 800)}`).toBe(status)
  return parsed
}

// ---- the worker, in-process ----------------------------------------------------------------------------------------------------

/** The handlers this flow's events reach (background.ts runs them in the worker; golden-flow/daily/testing/day.ts lists them all). */
let handlers: readonly EventHandler[] = []
let worker: World
/** The worker's job after a step: the real relay hands every pending event of the tenant to the handlers (../testing/world drain). */
const settle = () => drain(worker, handlers)

// ---- reads ---------------------------------------------------------------------------------------------------------------------

interface Notice {
  readonly id: string
  readonly partyId: string | null
  readonly eventType: string
  readonly recordType: string
  readonly recordId: string
  readonly recordLabel: string
  readonly messageKey: string
  readonly groupKey: string | null
}
const noticesOf = (userId: string) =>
  admin<Notice>(`SELECT id::text AS id, "partyId"::text AS "partyId", "eventType", "recordType", "recordId"::text AS "recordId", "recordLabel", "messageKey", "groupKey" FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId])
const looked = new Map<string, number>()
/** The notices a person got since the last look. */
async function fresh(person: Person): Promise<Notice[]> {
  const all = await noticesOf(person.id)
  const from = looked.get(person.id) ?? 0
  looked.set(person.id, all.length)
  return all.slice(from)
}
/** The office bell of a person, through the route. */
const bellOf = async (person: Office): Promise<Json[]> => (await ok(person, 'GET', '/notifications?limit=100')).items as Json[]
/** A person's bell items of one change of the order (its ONE group, B-SA-051). */
const itemsOfChange = async (person: Office, batch: string): Promise<Json[]> => (await bellOf(person)).filter((item) => item.group?.key === batchGroupKey(orderChangeBatch(batch, G.X.orderId), 'FOLLOWING'))

const followOf = (recordType: string, recordId: string, userId: string) =>
  admin<{ reason: string; muted: boolean }>('SELECT reason::text AS reason, muted FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3 AND "userId" = $4', [T(), recordType, recordId, userId]).then((rows) => rows[0] ?? null)
const settingsVersion = async (partyId: string): Promise<number> => (await admin<{ version: number }>('SELECT version FROM "PortalSettings" WHERE "partyId" = $1', [partyId]))[0]?.version ?? 0
const requestRow = (id: string) => one<{ status: string; version: number; amendmentId: string | null; askMessageId: string | null }>('SELECT status::text AS status, version, "amendmentId"::text AS "amendmentId", "askMessageId"::text AS "askMessageId" FROM "OrderChangeRequest" WHERE id = $1', [id])
const cellQuantity = async (cellId: string): Promise<number> => (await one<{ quantity: number }>('SELECT quantity FROM "WorkOrderSize" WHERE id = $1', [cellId])).quantity
const cutFloor = async (cellId: string): Promise<number> => Number((await one<{ floor: number }>('SELECT "factory_work_order_cell_floor"($1::uuid, $2::uuid) AS floor', [T(), cellId])).floor)
const lineSize = async (lineId: string, size: string): Promise<number> => (await one<{ quantity: number }>('SELECT quantity FROM "SalesOrderLineSize" WHERE "lineId" = $1 AND size = $2', [lineId, size])).quantity
/** The correlation of the command that wrote an event (the change's bell batch, B-SA-051). */
const correlationOf = async (type: string, key: string, value: string): Promise<string> =>
  (await one<{ correlationId: string }>(`SELECT "correlationId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND payload->>$3 = $4 ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [T(), type, key, value])).correlationId

interface NotesWritten {
  readonly messageId: string
  readonly stillToDo: number
  readonly people: number
  readonly floor: readonly { readonly workOrderId: string; readonly messageId: string }[]
  readonly workshops: readonly { readonly subcontractOrderId: string; readonly workOrderId: string }[]
}
/** What the handler `sales.orderChangeNotes` wrote for one change of one order (its own audit row: exactly one per change). */
async function notesOf(batch: string, orderId: string): Promise<NotesWritten> {
  const rows = await admin<{ after: NotesWritten }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderChangeNotes' AND "recordType" = 'SalesOrder' AND "recordId" = $2 AND "requestId" = $3 AND after->>'written' = 'true'`, [T(), orderId, batch])
  expect(rows, `the notes of change ${batch}`).toHaveLength(1)
  const written = rows[0]!.after
  G.lines.push(written.messageId)
  G.floorNotes.push(...written.floor.map((entry) => entry.messageId))
  return written
}
const messageOf = (id: string) =>
  one<{ body: string; direction: string; audience: string; authorKind: string; authorName: string | null; forFloor: boolean; partyId: string | null }>(
    'SELECT "bodyText" AS body, direction::text AS direction, audience::text AS audience, "authorKind"::text AS "authorKind", "authorName", "forFloor", "partyId"::text AS "partyId" FROM "Message" WHERE id = $1',
    [id],
  )
/** The office's Still to do of the order (B-SA-050), through the order page's read. */
async function stillToDo(): Promise<Json> {
  forgetProgress()
  return (await ok(bea, 'GET', `/sales/orders/${G.X.orderId}/production?parts=changes`)).changes.stillToDo as Json
}
const nameOfUser = async (userId: string): Promise<string> => (await one<{ name: string }>('SELECT "displayName" AS name FROM "User" WHERE id = $1', [userId])).name

// ---- the wall at every step --------------------------------------------------------------------------------------------------

/** The live wall's viewers: a person limited to Beta (every office permission), Beta's and Alpha's portal, an Alpha-limited office person. */
const officeViewer = (partyId: string): Actor => ({ audience: 'office', tenantId: T(), grants: [{ permissions: OFFICE_PERMISSIONS, companies: 'all', sites: 'all', parties: [partyId] }] })
const portalViewer = (partyId: string): Actor => ({ audience: 'partner', tenantId: T(), partyId, grants: [{ permissions: PORTAL_PERMISSIONS, companies: 'all', sites: 'all', parties: [partyId] }] })

interface OutboxRow {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly context: string
  readonly tenantId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly subject: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly source: string
  readonly occurredAt: Date
  readonly payload: Json
}
const envelopeOf = (row: OutboxRow): EventEnvelope =>
  ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }) as EventEnvelope
const outboxRows = (where = 'TRUE', values: unknown[] = []) =>
  admin<OutboxRow>(
    `SELECT id::text AS id, type, version, context, "tenantId"::text AS "tenantId", "companyId"::text AS "companyId", "siteId"::text AS "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND ${where} ORDER BY "occurredAt", id`,
    [T(), ...values],
  )
const liveOf = (row: OutboxRow) => {
  const definition = EVENT_CATALOGUE.find(row.type, row.version)
  return definition ? liveMessageFor(envelopeOf(row), definition) : null
}
const checkedEvents = new Set<string>()
/** P17': every live message written since the last look reaches neither a person limited to Beta nor Beta's portal. */
async function liveWall(step: string): Promise<number> {
  let checked = 0
  for (const row of await outboxRows()) {
    if (checkedEvents.has(row.id)) continue
    checkedEvents.add(row.id)
    const message = liveOf(row)
    // Beta's own records (the world's set-up wrote some) are Beta's to see.
    if (!message || (message.partyIds ?? []).includes(world.ids.b)) continue
    expect(liveViewFor(message, officeViewer(world.ids.b), EVENT_CATALOGUE), `${step}: ${row.type} live to a person limited to Brand Beta`).toBeNull()
    expect(partnerLiveViewFor(message, portalViewer(world.ids.b), EVENT_CATALOGUE), `${step}: ${row.type} live to Brand Beta's portal`).toBeNull()
    checked++
  }
  return checked
}

/** Alpha's markers now: its records (names, codes, numbers, references, files, threads, messages, work orders, ids), the flow's words, the flow's records. */
async function alphaMarkers(): Promise<Marker[]> {
  const records: Marker[] = [
    ...[...(G.lines ?? []), ...(G.floorNotes ?? [])].map((text) => ({ label: "Alpha's notes", text })),
    ...[G.sizeRequest?.id, G.designRequest?.id, G.ownRequest?.id, G.change?.id, G.styleChange?.id, G.styleChange?.number, G.job?.id, G.job?.number].filter((text): text is string => typeof text === 'string').map((text) => ({ label: "Alpha's records of the flow", text })),
    ...pageMarkers(), // B-OP-071: the order page's words and records
  ]
  return [...(await markersOf(world.h.db, world.ids.a)), ...FLOW_WORDS.map((text) => ({ label: "Alpha's flow words", text })), ...records]
}
const leaksIn = (entries: readonly Seen[], markers: readonly Marker[]): string[] =>
  entries.flatMap((entry) => {
    let text = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body ?? null)
    for (const id of entry.asked) text = text.replaceAll(id, '<asked>')
    return findMarkers(text, markers).map((hit) => `${entry.who} ${entry.url}: ${hit}`)
  })
let scannedB = 0

/** Alpha's records as Beta's people try them: every door unknown, every list without them. */
const portalDoors = (): string[] => [
  `/portal/sales-orders/${G.X.orderId}`,
  `/portal/sales-orders/${G.X.orderId}/progress`,
  `/portal/sales-orders/${G.X.orderId}/files`,
  `/portal/sales-orders/${G.X.orderId}/change-requests`,
  `/portal/sales-orders/${G.X.orderId}/change-requests/rules`,
  `/portal/threads/SalesOrder/${G.X.orderId}`,
  `/portal/sales-orders/${G.Y.orderId}`,
  `/portal/threads/SalesOrder/${G.Y.orderId}`,
]
const officeDoors = (): string[] => [
  `/sales/orders/${G.X.orderId}`,
  `/sales/orders/${G.X.orderId}/production`,
  `/sales/orders/${G.X.orderId}/milestones`,
  `/sales/orders/${G.X.orderId}/files`,
  `/threads/SalesOrder/${G.X.orderId}`,
  `/sales/orders/${G.Y.orderId}`,
  `/sales/customers/${world.ids.a}/feed`,
  ...(G.wo ? [`/production/work-orders/${G.wo.id}`, `/threads/WorkOrder/${G.wo.id}`] : []),
  ...[G.sizeRequest, G.designRequest, G.ownRequest].filter((request): request is Json => !!request).flatMap((request) => [`/sales/change-requests/${request.id}`, `/sales/change-requests/${request.id}/apply-plan`]),
  ...(G.change ? [`/production/work-order-changes/${G.change.id}`] : []),
  ...(G.lines ?? []).map((messageId) => `/sales/orders/${G.X.orderId}/told?messageId=${messageId}`),
  ...(G.styleChange ? [`/product/change-requests/${G.styleChange.id}`] : []),
]
const officeLists = (): string[] => [
  '/sales/orders?limit=100',
  '/sales/change-requests?status=ALL&limit=200',
  '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200',
  '/home/today?kind=WORK_ORDER_CHANGE&limit=200',
  '/production/work-orders?limit=200',
  `/production/work-order-changes?salesOrderId=${G.X.orderId}&status=ALL`,
]

/**
 * The wall at the end of a step: Beta's buyer and the two people limited to Beta (`office.p2`, Bice) read every door of Alpha's
 * records as unknown and lists without them; their bells hold nothing of Alpha; no live message of the step reaches them; and every
 * answer they got since the last look names nothing of Alpha.
 */
async function betaGetsNothing(step: string): Promise<void> {
  await ok(buyerB, 'GET', '/portal/sales-orders')
  await ok(buyerB, 'GET', '/portal/notifications?limit=50')
  for (const url of portalDoors()) expect((await call(buyerB, 'GET', url)).status, `${step}: Beta's buyer GET ${url}`).toBe(404)
  for (const url of officeLists()) {
    const list = await asBeta('GET', url)
    expect(JSON.stringify(list).includes(G.X.orderId), `${step}: ${url} lists Alpha's order`).toBe(false)
  }
  for (const url of officeDoors()) await asBeta('GET', url, undefined, 404)
  await ok(bice, 'GET', '/notifications?limit=100')
  for (const url of [`/sales/orders/${G.X.orderId}`, `/threads/SalesOrder/${G.X.orderId}`, ...(G.wo ? [`/production/work-orders/${G.wo.id}`] : [])]) expect((await call(bice, 'GET', url)).status, `${step}: Bice GET ${url}`).toBe(404)
  // Nothing of Alpha reached their bells; none of the step's live messages reached them.
  expect(await fresh(buyerB), `${step}: Beta's buyer's bell`).toEqual([])
  expect((await fresh(bice)).filter((notice) => notice.partyId === world.ids.a || JSON.stringify(notice).includes(G.X.orderId)), `${step}: Bice's bell`).toEqual([])
  await liveWall(step)
  // And no answer they got names anything of Alpha.
  const markers = await alphaMarkers()
  const fresher = seen.B.slice(scannedB)
  scannedB = seen.B.length
  expect(leaksIn(fresher, markers), `${step}: Alpha's markers in Beta's answers`).toEqual([])
}

// ---- the world's own set-up (not this flow's: named in the file's head) ------------------------------------------------------

/** An order of Alpha typed in the office scope, as the harness's addOrder: line 10 of its private-label jacket, black, 4 + 4 pieces. */
async function privateLabelOrder(label: string): Promise<Order> {
  const orderId = newId()
  const lineId = newId()
  const number = `T-SA89-${label}-${orderId.slice(-4)}`
  const black = seedUuid(NS, 'production:colourway:JKT-02:BLK')
  await world.h.database.withScope({ audience: 'office', tenantId: T(), actorId: newId() }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: orderId, companyId: world.w.companyId, partyId: world.ids.a, number, customerRef: `T-SA89-PO-${label}`, status: 'CONFIRMED', orderDate: new Date('2026-10-05T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up store' }, promiseDate: new Date('2026-12-20T00:00:00.000Z'), netAmount: 80_000, vatAmount: 17_600, grossAmount: 97_600 },
        select: { id: true },
      })
      await tx.salesOrderLine.create({ data: { id: lineId, companyId: world.w.companyId, orderId, partyId: world.ids.a, seq: 10, kind: 'SIZE_GRID', styleId: G.privateStyle, colourwayId: black, quantity: 8, unitPrice: '100.000000', netAmount: 80_000, vatRatePct: '22.00', vatAmount: 17_600 }, select: { id: true } })
      await tx.salesOrderLineSize.createMany({ data: (['50', '52'] as const).map((size) => ({ id: newId(), lineId, partyId: world.ids.a, size, quantity: 4 })) })
      await tx.brandOrderProduction.create({ data: { id: newId(), companyId: world.w.companyId, partyId: world.ids.a, salesOrderId: orderId, key: `brand-production:${orderId}`, waitingOn: 'US', waitingSince: world.h.clock.now(), createdById: newId() }, select: { id: true } })
    }),
  )
  return { orderId, number, lineId }
}

/** Alpha's private-label jacket is a category II PPE garment: a made-up certificate held by Alpha covers it (as seed/quality.ts SEED-CERT-0003). */
async function certificateOfThePrivateJacket(): Promise<void> {
  await world.h.database.withScope({ audience: 'office', tenantId: T(), actorId: newId() }, (client) =>
    client.$transaction(async (tx) => {
      const certificateId = newId()
      const at = world.h.clock.now()
      await tx.certificate.create({
        data: { id: certificateId, holderPartyId: world.ids.a, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'T-SA89-CERT-0001', notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '0000', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-15T00:00:00.000Z'), validTo: new Date('2031-01-14T00:00:00.000Z'), status: 'VALID', statusChangedAt: at, createdAt: at, updatedAt: at },
        select: { id: true },
      })
      await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: G.privateStyle, createdAt: at, updatedAt: at }, select: { id: true } })
    }),
  )
}

/** The workshop P2's person (its jobs), signed in by code — its portal switched on first (as the world does for both brands). */
async function workshopPerson(email: string): Promise<Portal> {
  const partyId = seedUuid(NS, 'party:P2')
  const id = newId()
  await world.h.database.withScope({ audience: 'office', tenantId: T(), actorId: newId() }, async (client) => {
    const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
    if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'SUBCONTRACTOR' }, select: { id: true } })
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T(), key: 'subcontractor-jobs' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(world.h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  freshGuard(world.h)
  const browser = await portalBrowser(world.h)
  world.h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await world.h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(world.h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return { id, browser }
}

/** The planner releases a work order: its checklist read first; a material short of stock is released over with a reason. */
async function release(workOrderId: string): Promise<Json> {
  const { workOrder } = await ok(carla, 'GET', `/production/work-orders/${workOrderId}`)
  const check = await ok(carla, 'GET', `/production/work-orders/${workOrderId}/release-check`)
  const blockers = (check.blockers ?? []) as Json[]
  expect(blockers.filter((entry) => !String(entry.path).startsWith('materials/')), JSON.stringify(blockers)).toEqual([])
  return (await ok(carla, 'POST', `/production/work-orders/${workOrderId}/release`, { version: workOrder.version, ...(blockers.length > 0 ? { materialOverride: { reason: OVERRIDE } } : {}) })).workOrder as Json
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  // As B-PR-36: ONE clock, started behind the database's (the sign-ins and the step-up move it on).
  world = await urgencyWorld('sa89_golden_sales', NS, { clockBehindMs: 8 * 60_000 })
  await seedSubcontract({ db: world.h.database, namespace: NS })
  worker = { h: world.h, tenant: world.tenant, retried: [] as string[] } as unknown as World
  handlers = [orderChangeNotesHandler(), notificationsHandler(), partnerNotificationsHandler({ cookieSecret: () => LOCAL_COOKIE_SECRET, clock: world.h.clock }), supervisorFollowsHandler(), brandKeeperHandler(), issueAnsweredHandler()]
  G.privateStyle = seedUuid(NS, 'production:style:JKT-02')
  G.lines = []
  G.floorNotes = []

  bea = await world.officePerson('bea.sales@sa89-office.example.com', 'sales')
  sara = await world.officePerson('sara.sales@sa89-office.example.com', 'sales')
  carla = await world.officePerson('carla.planner@sa89-office.example.com', 'planner')
  dario = await world.officePerson('dario.supervisor@sa89-office.example.com', 'production_manager', [world.ids.a])
  bruno = await world.officePerson('bruno.backup@sa89-office.example.com', 'production_manager')
  bice = await world.officePerson('bice.beta@sa89-office.example.com', 'sales', [world.ids.b])
  buyerA = await world.portalPerson('alba.buyer@sa89-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'partner-comment', 'partner-upload'])
  buyerB = await world.portalPerson('bruna.buyer@sa89-brand-beta.example.com', world.ids.b, ['customer-buyer', 'partner-comment', 'partner-upload'])
  workshop = await workshopPerson('rita.workshop@sa89-workshop-p2.example.com')
  sides.set(buyerA, { side: 'A', who: "Alpha's buyer" })
  sides.set(buyerB, { side: 'B', who: "Beta's buyer" })
  sides.set(bice, { side: 'B', who: 'Bice (limited to Beta)' })
  sides.set(workshop, { side: 'W', who: 'the workshop' })
  // World set-up (as B-PR-36): every person of the flow holds their roles on the harness clock and the server clock alike.
  const people = [bea, sara, carla, dario, bruno, bice, buyerA, buyerB, workshop].map((person) => person.id)
  await world.replica([{ sql: `UPDATE "RoleAssignment" SET "validFrom" = now() - interval '1 day' WHERE "userId" = ANY($1::uuid[])`, values: [people] }])

  await certificateOfThePrivateJacket()
  G.X = await privateLabelOrder('X')
  G.Y = await world.addOrder(world.ids.a, 'SA89-OWN', '2026-10-01')
  G.customerCode = (await one<{ code: string }>('SELECT code FROM "Party" WHERE id = $1', [world.ids.a])).code
  // What the set-up wrote is the worker's first job; what it tells nobody is this flow's news.
  await settle()
  for (const person of [buyerA, buyerB, bice, workshop]) await fresh(person)
}, LONG)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  useErrorTracker(undefined)
  await world?.close()
}, 120_000)

describe('B-SA-089 golden flow sales page: one change of Alpha’s order told to everyone, Beta gets nothing', { timeout: LONG }, () => {
  it('S0 the scene: the design ask on for Alpha, its supervisor and backup, the work order made and released, the workshop’s job issued, who follows', async () => {
    // The limits card: a production manager opens the design ask for Alpha (step-up; B-SA-005b lets the switch hold DESIGN).
    const card = await ok(bruno, 'GET', `/partners/${world.ids.a}/production`)
    expect(card.mayManage).toBe(true)
    const changed = await stepped(bruno, 'PUT', `/partners/${world.ids.a}/production`, { productionAskKinds: ['DESIGN'], version: card.production.version })
    expect(changed.production.askKinds).toEqual(['DESIGN'])
    // A person limited to Beta reaches neither the card nor the switch.
    await asBeta('GET', `/partners/${world.ids.a}/production`, undefined, 404)
    // Alpha's supervisor (limited to Alpha) and backup.
    const supervisor = await ok(carla, 'PUT', `/production/brands/${world.ids.a}/supervisor`, { supervisorId: dario.id, backupId: bruno.id, version: await settingsVersion(world.ids.a) })
    expect(supervisor.customer).toMatchObject({ partyId: world.ids.a, supervisor: { id: dario.id }, backup: { id: bruno.id } })

    // The work order of line 10, made and released by the planner (every open size: 4 of 50, 4 of 52).
    const made = (await ok(carla, 'POST', '/production/work-orders', { siteId: world.w.siteId, lines: [{ salesOrderLineId: G.X.lineId }] }, 201)).workOrder as Json
    const released = await release(made.id as string)
    expect(released.status).toBe('RELEASED')
    const cells = Object.fromEntries((released.cells as Json[]).map((cell) => [cell.size as string, cell.id as string]))
    expect((released.cells as Json[]).map((cell) => [cell.size, cell.quantity]).sort()).toEqual([
      ['50', 4],
      ['52', 4],
    ])
    G.wo = { id: released.id as string, number: released.number as string, cells }

    // The workshop's job of the work order, out at the workshop (a copy of the seeds' job, issued: subcontracting is purchasing's
    // flow, not this one).
    G.job = { id: newId(), number: `T-SA89-SC-${G.wo.id.slice(-4)}` }
    await world.replica([
      {
        sql: `INSERT INTO "SubcontractOrder" SELECT * FROM jsonb_populate_record(NULL::"SubcontractOrder", (SELECT to_jsonb(r) || $1::jsonb FROM "SubcontractOrder" r WHERE r.id = $2::uuid))`,
        values: [JSON.stringify({ id: G.job.id, number: G.job.number, workOrderId: G.wo.id, status: 'ISSUED', version: 1 }), seedUuid(NS, 'subcontract:SC-0001')],
      },
    ])

    // Who follows: Sara the order, Carla the work order (each by their own choice); a person limited to Beta cannot follow it.
    await ok(sara, 'PUT', `/threads/SalesOrder/${G.X.orderId}/followers/me`, { following: true })
    await ok(carla, 'PUT', `/threads/WorkOrder/${G.wo.id}/followers/me`, { following: true })
    expect((await call(bice, 'PUT', `/threads/SalesOrder/${G.X.orderId}/followers/me`, { following: true })).status).toBe(404)
    await settle()
    // Dario follows the order and its work order by himself (B-PR-42b); Bruno, the backup, follows nothing; Bice nothing.
    expect(await followOf('SalesOrder', G.X.orderId, dario.id)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('WorkOrder', G.wo.id, dario.id)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('SalesOrder', G.X.orderId, sara.id)).toMatchObject({ muted: false })
    expect(await followOf('WorkOrder', G.wo.id, carla.id)).toMatchObject({ muted: false })
    expect(await followOf('SalesOrder', G.X.orderId, bruno.id)).toBeNull()
    expect(await followOf('WorkOrder', G.wo.id, bruno.id)).toBeNull()
    expect(await followOf('SalesOrder', G.X.orderId, bice.id)).toBeNull()

    // The customer's own rules: line 10 may change, the design ask is open.
    const rules = await ok(buyerA, 'GET', `/portal/sales-orders/${G.X.orderId}/change-requests/rules`)
    expect((rules.lines as Json[]).find((line) => line.lineId === G.X.lineId)!.change).toMatchObject({ possible: true, code: 'FREE' })
    expect(rules.design).toMatchObject({ open: true, verdict: { possible: true, code: 'FREE' } })
    await betaGetsNothing('S0')
  })

  it('S1 Alpha asks a size decrease of line 10 (52: 4 → 1) while it is released and not yet cut: its own message in the order’s conversation; Approvals and the order list it', async () => {
    const ask = { kind: 'CHANGE', cells: [{ lineId: G.X.lineId, size: '52', quantity: 1 }], note: SIZE_NOTE }
    const impact = await ok(buyerA, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests/impact`, ask)
    expect(impact.impact).toMatchObject({ kind: 'CHANGE', blocked: false })
    // Beta's buyer asks nothing on Alpha's order: not found, nothing written.
    expect((await call(buyerB, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests`, ask)).status).toBe(404)
    expect(await admin('SELECT id FROM "OrderChangeRequest" WHERE "orderId" = $1', [G.X.orderId])).toEqual([])

    const asked = (await ok(buyerA, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests`, ask, 201)).request as Json
    expect(asked).toMatchObject({ kind: 'CHANGE', status: 'OPEN', mine: true, note: SIZE_NOTE })
    expect((asked.cells as Json[]).map((cell) => [cell.seq, cell.size, cell.before, cell.asked])).toEqual([[10, '52', 4, 1]])
    G.sizeRequest = asked
    // Their ask is their own message in the order's conversation (B-SA-048): INBOUND, by the asking person, named by the request.
    const { askMessageId } = await requestRow(asked.id as string)
    expect(askMessageId).toBeTruthy()
    expect(asked.askMessageId).toBe(askMessageId)
    expect(await messageOf(askMessageId!)).toMatchObject({ direction: 'INBOUND', audience: 'PARTNER', authorKind: 'PARTY', partyId: world.ids.a, forFloor: false })
    expect((await messageOf(askMessageId!)).body).toContain('52 4 → 1')
    const theirs = await ok(buyerA, 'GET', `/portal/threads/SalesOrder/${G.X.orderId}`)
    expect((theirs.messages as Json[]).find((message) => message.id === askMessageId)).toMatchObject({ side: 'PARTNER', channel: 'PORTAL', author: { mine: true } })
    await settle()

    // The office: the order's Changes list it waiting on us; Home › Approvals for who answers (Bea), with its words.
    const office = await ok(bea, 'GET', `/threads/SalesOrder/${G.X.orderId}`)
    expect((office.messages as Json[]).find((message) => message.id === askMessageId)).toMatchObject({ direction: 'INBOUND', audience: 'PARTNER', author: { kind: 'PARTY' } })
    const approvals = await ok(bea, 'GET', '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')
    expect((approvals.items as Json[]).filter((item) => item.record?.label === G.X.number)).toHaveLength(1)
    const list = await ok(bea, 'GET', `/sales/change-requests?orderId=${G.X.orderId}`)
    expect((list.items as Json[]).map((item) => [item.id, item.kind, item.mayAnswer])).toEqual([[asked.id, 'CHANGE', true]])
    await betaGetsNothing('S1')
  })

  it('S2 cutting starts while the request waits: the floor’s first bundle, 3 of size 52', async () => {
    await ok(carla, 'POST', `/production/work-orders/${G.wo.id}/start`, { version: (await ok(carla, 'GET', `/production/work-orders/${G.wo.id}`)).workOrder.version })
    // The cutting floor's first bundle on the cell of size 52 (cutting is the floor's flow, not this one: the row as the cutting
    // tablet leaves it, written with the database's rules off for this one statement).
    await world.replica([
      {
        sql: `INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) SELECT $1::uuid, "tenantId", "siteId", $2::uuid, $3::uuid, $4::text, $5::int FROM "WorkOrderSize" WHERE id = $3::uuid`,
        values: [newId(), G.wo.id, G.wo.cells['52'], `T-SA89-BN-${G.wo.id.slice(-6)}`, 3],
      },
    ])
    forgetProgress()
    // What is already cut, as the database's own floor reads it (the cell guard and Lower to the order read the same).
    expect(await cutFloor(G.wo.cells['52']!)).toBe(3)
    expect(await cutFloor(G.wo.cells['50']!)).toBe(0)
    expect((await requestRow(G.sizeRequest.id as string)).status).toBe('OPEN')
    await betaGetsNothing('S2')
  })

  it('S3 after cutting started Alpha asks a DESIGN change of line 10 (its private label) with a sketch: the impact says cutting started; their second message, the sketch attached; told it was received', async () => {
    // The sketch, uploaded in the order's conversation (announced, its bytes sent to the store, completed).
    const body = pdf('Made-up Alpha stripe sketch')
    const announced = await ok(buyerA, 'POST', `/portal/threads/SalesOrder/${G.X.orderId}/files`, announce(SKETCH, body), 201)
    const sent = await world.h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
    expect(sent.statusCode, sent.body).toBe(200)
    expect((await ok(buyerA, 'POST', `/portal/threads/SalesOrder/${G.X.orderId}/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
    G.sketch = announced.file.id as string

    const ask = { kind: 'DESIGN', note: DESIGN_NOTE, lineIds: [G.X.lineId], fileIds: [G.sketch] }
    // The impact before Send: how far line 10 is made — cutting has started on it.
    const impact = await ok(buyerA, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests/impact`, ask)
    expect(impact.impact).toMatchObject({ kind: 'DESIGN', blocked: false })
    expect((impact.impact.notes as Json[]).map((note) => note.en)).toContain('Cutting has started on line 10: the change may cost extra or apply to the next order')
    // A waiting size change holds no design ask (each kind waits on its own lane).
    const asked = (await ok(buyerA, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests`, ask, 201)).request as Json
    expect(asked).toMatchObject({ kind: 'DESIGN', status: 'OPEN', note: DESIGN_NOTE, fileIds: [G.sketch], kindWords: { en: 'Design change request' } })
    G.designRequest = asked
    // Their second message in the order's conversation, the sketch attached; the size ask's before it.
    const { askMessageId } = await requestRow(asked.id as string)
    expect(asked.askMessageId).toBe(askMessageId)
    const theirs = await ok(buyerA, 'GET', `/portal/threads/SalesOrder/${G.X.orderId}`)
    const design = (theirs.messages as Json[]).find((message) => message.id === askMessageId)!
    expect(design).toMatchObject({ side: 'PARTNER', author: { mine: true } })
    expect((design.attachments as Json[]).map((file) => file.id)).toEqual([G.sketch])
    expect(design.body).toContain(DESIGN_NOTE)
    const asks = (theirs.messages as Json[]).filter((message) => message.side === 'PARTNER').map((message) => message.id)
    expect(asks).toEqual(expect.arrayContaining([G.sizeRequest.askMessageId, askMessageId]))
    // Beta's buyer reaches neither the conversation nor the sketch, and asks nothing on the order.
    expect((await call(buyerB, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests`, ask)).status).toBe(404)
    await settle()
    // The customer is told it was received, by its own order number (B-SA-046).
    expect((await fresh(buyerA)).some((notice) => notice.messageKey === 'portal.order.design_received' && notice.partyId === world.ids.a)).toBe(true)
    await betaGetsNothing('S3')
  })

  it('S4 the office answers the size change from the order’s door: On the floor now, 2 extra pieces held until their outcome is picked, Accept with “keep as leftover”; the work order not touched yet', async () => {
    const request = G.sizeRequest
    // The order page's door: the order names both waiting requests; its Changes part lists them.
    const order = await ok(bea, 'GET', `/sales/orders/${G.X.orderId}`)
    const ids = order.order.live.ids as Json
    expect(ids.requestIds).toEqual(expect.arrayContaining([request.id, G.designRequest.id]))
    forgetProgress()
    const changes = (await ok(bea, 'GET', `/sales/orders/${G.X.orderId}/production?parts=changes`)).changes as Json
    expect((changes.openRequests as Json[]).map((row) => row.kind).sort()).toEqual(['CHANGE', 'DESIGN'])

    // The review window: the record's preview and the apply plan (the same reads as Home › Approvals' window).
    const record = await ok(bea, 'GET', `/sales/change-requests/${request.id}`)
    expect(record.request).toMatchObject({ kind: 'CHANGE', status: 'OPEN', mayAnswer: true, askMessageId: request.askMessageId })
    expect(record.preview.workOrders).toMatchObject({ extra: [{ workOrderSizeId: G.wo.cells['52'], salesOrderLineId: G.X.lineId, size: '52', count: 2 }], needsOutcome: true })
    const plan = await ok(bea, 'GET', `/sales/change-requests/${request.id}/apply-plan`)
    expect((plan.floor.cells as Json[]).find((cell) => cell.size === '52')).toMatchObject({ lineId: G.X.lineId, seq: 10, ordered: 4, asked: 1, inWorkOrders: 4, cut: 3 })
    expect(plan.extra).toMatchObject({ total: 2, chosen: null, needsOutcome: true, pieces: [{ lineId: G.X.lineId, size: '52', count: 2 }] })
    expect((plan.extra.outcomes as Json[]).map((outcome) => outcome.outcome).sort()).toEqual(['CHARGE', 'LEFTOVER', 'SCRAP'])
    expect((plan.extra.outcomes as Json[]).find((outcome) => outcome.outcome === 'LEFTOVER')).toMatchObject({ mayChoose: true })
    const lower = (plan.next as Json[]).find((step) => step.kind === 'LOWER_TO_ORDER')!
    expect(lower).toMatchObject({ team: 'PLANNER', workOrder: { id: G.wo.id, number: G.wo.number }, person: { id: dario.id } })
    expect((plan.next as Json[]).map((step) => step.kind)).toEqual(expect.arrayContaining(['AMEND', 'LOWER_TO_ORDER', 'TELL_WORKSHOP']))

    // A person limited to Beta answers nothing of it (as unknown); nothing is written.
    await asBeta('POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, extraOutcome: 'LEFTOVER' }, 404)
    // Accept stays held until the extra pieces' outcome is picked (Round 4: they start unpicked); nothing is written meanwhile.
    const held = await call(bea, 'POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, answer: ACCEPT_ANSWER })
    expect(held.status).toBe(409)
    expect(held.body.error.issues).toEqual([{ path: 'refusal/EXTRA_OUTCOME', message: 'Choose what happens to the 2 extra pieces' }])
    expect(await requestRow(request.id as string)).toMatchObject({ status: 'OPEN', version: request.version })
    expect(await lineSize(G.X.lineId, '52')).toBe(4)
    expect(await admin('SELECT id FROM "WorkOrderChange" WHERE "salesOrderId" = $1', [G.X.orderId])).toEqual([])

    // Accept, keeping the 2 cut pieces as leftover for this customer: ONE command — the amendment and a PROPOSED work-order change.
    const accepted = await ok(bea, 'POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, answer: ACCEPT_ANSWER, extraOutcome: 'LEFTOVER' })
    expect(accepted.request).toMatchObject({ status: 'ACCEPTED', answer: ACCEPT_ANSWER, amendment: { revision: expect.any(Number) }, mayAnswer: false })
    expect(accepted.workOrders).toMatchObject({ proposed: [{ kind: 'LOWER_TO_ORDER', workOrderId: G.wo.id, number: G.wo.number }], extra: [{ size: '52', count: 2 }], extraOutcome: 'LEFTOVER' })
    expect(await lineSize(G.X.lineId, '52')).toBe(1)
    expect(await lineSize(G.X.lineId, '50')).toBe(4)
    // The work order itself is not touched by Accept: the planner applies the change.
    expect(await cellQuantity(G.wo.cells['52']!)).toBe(4)
    G.acceptBatch = await correlationOf('order_change_request.answered', 'requestId', request.id as string)
    await betaGetsNothing('S4')
  })

  it('S5 tell everyone: ONE system line, ONE bell item per person, a floor note with the code and no names, the workshop told, the customer told; Still to do waits on planning; who was told', async () => {
    await settle()
    const notes = await notesOf(G.acceptBatch, G.X.orderId)
    const [beaName, saraName, carlaName, darioName, brunoName] = await Promise.all([bea, sara, carla, dario, bruno].map((person) => nameOfUser(person.id)))
    const party = await one<{ legalName: string; tradeName: string | null }>('SELECT "legalName", "tradeName" FROM "Party" WHERE id = $1', [world.ids.a])

    // ONE system line on the order's conversation: office only, never for the floor, in the company's language, no price.
    const line = await messageOf(notes.messageId)
    expect(line).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', authorKind: 'SYSTEM', authorName: null, forFloor: false })
    const text = linesOfText(line.body)
    expect(text[0]).toMatch(new RegExp(`^Modifica accettata · ${beaName} · \\d\\d:\\d\\d$`))
    expect(text[1]).toContain('ha chiesto (portale, ')
    expect(text[1]).toContain('riga 10 · 52 4 → 1')
    expect(text.find((entry) => entry.startsWith('Fatto: '))).toMatch(/^Fatto: ordine modificato \(revisione \d+\)/)
    expect(text.find((entry) => entry.startsWith('Prossimi: '))).toContain(`${G.wo.number} (inviato alla pianificazione)`)
    expect(text.find((entry) => entry.startsWith('Avvisati: '))).toBe(`Avvisati: 3 persone in ufficio · il reparto di ${G.wo.number} · il terzista di ${G.wo.number}`)
    expect(noPriceIn(line.body)).toBe(true)
    expect(notes).toMatchObject({ stillToDo: 1, people: 3, floor: [{ workOrderId: G.wo.id }], workshops: [{ subcontractOrderId: G.job.id, workOrderId: G.wo.id }] })
    const posted = (await outboxRows(`type = 'thread.message_posted' AND payload->>'messageId' = $2`, [notes.messageId]))[0]!
    expect(posted.payload).toMatchObject({ causedById: bea.id, orderId: G.X.orderId, stillToDo: 1 })
    // Bea reads it in the order's conversation (office), as the one line of the change.
    const thread = await ok(bea, 'GET', `/threads/SalesOrder/${G.X.orderId}`)
    expect((thread.messages as Json[]).filter((message) => message.id === notes.messageId)).toHaveLength(1)
    expect((thread.messages as Json[]).find((message) => message.id === notes.messageId)).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', author: { kind: 'SYSTEM' } })

    // The floor note on the work order: for the floor, the customer's CODE (never its name), no person, no price, what a tablet shows.
    const floor = await messageOf(notes.floor[0]!.messageId)
    expect(floor).toMatchObject({ direction: 'INTERNAL_NOTE', authorKind: 'SYSTEM', authorName: null, forFloor: true })
    expect(floor.body).toBe(`Modifica d'ordine su ${G.wo.number} (${G.customerCode}): taglia 52 ora 1 (erano 4).`)
    for (const word of [party.legalName, party.tradeName, beaName, saraName, carlaName, darioName, brunoName].filter((entry): entry is string => !!entry)) expect(floor.body).not.toContain(word)
    expect(noPriceIn(floor.body)).toBe(true)
    expect(floor.body.length).toBeLessThanOrEqual(FLOOR_NOTE_MAX)
    expect((await outboxRows(`type = 'production.floor_note_posted' AND payload->>'messageId' = $2`, [notes.floor[0]!.messageId])).map((row) => row.payload)).toEqual([
      expect.objectContaining({ workOrderId: G.wo.id, number: G.wo.number, salesOrderId: G.X.orderId, changes: ['SIZES'] }),
    ])
    const woThread = await ok(carla, 'GET', `/threads/WorkOrder/${G.wo.id}`)
    expect((woThread.messages as Json[]).find((message) => message.id === notes.floor[0]!.messageId)).toMatchObject({ forFloor: true, author: { kind: 'SYSTEM', name: null } })

    // ONE bell item per person for the change (its one group): Dario (the order and the work order), Sara (the order), Carla (the
    // work order's note); never Bea who acted, never Bruno who follows nothing, never Bice.
    for (const person of [dario, sara, carla]) expect(await itemsOfChange(person, G.acceptBatch), `bell of ${await nameOfUser(person.id)}`).toHaveLength(1)
    expect((await itemsOfChange(carla, G.acceptBatch))[0]).toMatchObject({ messageKey: 'notifications.following.orderChange' })
    for (const person of [bea, bruno, bice]) expect(await itemsOfChange(person, G.acceptBatch), `bell of ${await nameOfUser(person.id)}`).toEqual([])
    // The planner is asked to decide the work-order change (its own Approvals bell, B-SA-041).
    expect((await bellOf(carla)).some((item) => item.messageKey === 'notifications.production.workOrderChangeProposed')).toBe(true)

    // The workshop is told by its own job's number only — never the customer, the order or a price.
    const told = (await fresh(workshop)).filter((notice) => notice.recordType === 'SubcontractOrder')
    expect(told.map((notice) => [notice.messageKey, notice.recordId, notice.recordLabel])).toEqual([['portal.job.order_changed', G.job.id, G.job.number]])
    const workshopBell = await ok(workshop, 'GET', '/portal/notifications?limit=50')
    const shown = (workshopBell.items as Json[]).find((item) => (item.group?.ids as string[] | undefined)?.includes(told[0]!.id))!
    expect(shown.sentence.en).toBe(`Order changed — check quantities: ${G.job.number}`)

    // The customer is told (its bell, and live on its order page: B-SA-055) and reads the answer — never who answered.
    expect((await fresh(buyerA)).some((notice) => notice.messageKey === 'portal.order.change_accepted')).toBe(true)
    const answered = (await outboxRows(`type = 'order_change_request.answered' AND payload->>'requestId' = $2`, [G.sizeRequest.id]))[0]!
    expect(partnerLiveViewFor(liveOf(answered)!, portalViewer(world.ids.a), EVENT_CATALOGUE)?.fields).toEqual({ requestId: G.sizeRequest.id, orderId: G.X.orderId, kind: 'CHANGE', answer: 'ACCEPTED' })
    expect(partnerLiveViewFor(liveOf(answered)!, portalViewer(world.ids.b), EVENT_CATALOGUE)).toBeNull()
    // The order's own live message reaches a person limited to Alpha (P17': the order names its customer), never one limited to Beta.
    const amended = (await outboxRows(`type = 'sales_order.amended' AND "correlationId" = $2`, [G.acceptBatch]))[0]!
    expect(liveViewFor(liveOf(amended)!, officeViewer(world.ids.a), EVENT_CATALOGUE)).not.toBeNull()
    expect(liveViewFor(liveOf(amended)!, officeViewer(world.ids.b), EVENT_CATALOGUE)).toBeNull()
    const mine = (await ok(buyerA, 'GET', `/portal/sales-orders/${G.X.orderId}/change-requests`)).items as Json[]
    const theirs = mine.find((item) => item.id === G.sizeRequest.id)!
    expect(theirs).toMatchObject({ status: 'ACCEPTED', answer: ACCEPT_ANSWER })
    expect('answeredBy' in theirs).toBe(false)
    // Our words in the conversation too (the window's "Tell the customer"), about their request; the customer reads them.
    const reply = await ok(bea, 'POST', `/threads/SalesOrder/${G.X.orderId}/replies`, { body: REPLY, about: { kind: 'OrderChangeRequest', id: G.sizeRequest.id } }, 201)
    expect(reply.message).toMatchObject({ direction: 'OUTBOUND', about: { kind: 'OrderChangeRequest', id: G.sizeRequest.id } })
    const conversation = await ok(buyerA, 'GET', `/portal/threads/SalesOrder/${G.X.orderId}`)
    expect((conversation.messages as Json[]).find((message) => message.body === REPLY)).toMatchObject({ side: 'COMPANY', author: { mine: false } })
    // Never the office's: no system line, no floor note, no work order in the customer's conversation.
    expect(JSON.stringify(conversation)).not.toContain('Avvisati')
    expect(JSON.stringify(conversation)).not.toContain(G.wo.number)
    await settle()

    // Still to do (computed from the records): the work-order change waits on planning; the workshop was told (closed).
    const still = await stillToDo()
    expect(still).toMatchObject({ count: 1, workOrdersLeftOut: 0 })
    expect(still.rows).toEqual([expect.objectContaining({ kind: 'WORK_ORDER_CHANGE', ref: expect.objectContaining({ type: 'WorkOrderChange', number: G.wo.number }), waitingOn: 'PLANNER', requestId: G.sizeRequest.id })])
    // Home › Approvals of the planner: one row for the change; a person limited to Beta none (betaGetsNothing lists it).
    const approvals = await ok(carla, 'GET', '/home/today?kind=WORK_ORDER_CHANGE&limit=50')
    G.change = ((await ok(carla, 'GET', `/production/work-order-changes?salesOrderId=${G.X.orderId}`)).items as Json[])[0]!
    expect((approvals.items as Json[]).some((item) => item.record?.id === G.wo.id || String(item.key).includes(G.change.id))).toBe(true)

    // Who was told (B-SA-056): office people by name and why, the floor by when and which work order, the workshop by its job —
    // never who read it; never Bea, Bruno or Bice.
    const whoWasTold = await ok(bea, 'GET', `/sales/orders/${G.X.orderId}/told?batchId=${encodeURIComponent(G.acceptBatch)}`)
    expect(whoWasTold.change).toMatchObject({ batchId: G.acceptBatch, messageId: notes.messageId })
    const byWhy = Object.fromEntries((whoWasTold.people.groups as Json[]).map((group) => [group.why, (group.people as Json[]).map((person) => person.id)]))
    expect(byWhy).toEqual({ SUPERVISOR: [dario.id], FOLLOWS_ORDER: [sara.id], FOLLOWS_WORK_ORDER: [carla.id] })
    expect(whoWasTold.people.count).toBe(3)
    expect(whoWasTold.floor).toMatchObject({ workOrders: [{ id: G.wo.id, number: G.wo.number }], leftOut: 0 })
    expect(whoWasTold.floor.at).not.toBeNull()
    expect(whoWasTold.workshop).toMatchObject({ subcontractOrders: [{ id: G.job.id, number: G.job.number }], waiting: 0, leftOut: 0 })
    expect(whoWasTold.workshop.subcontractOrders[0].toldAt).not.toBeNull()
    expect(JSON.stringify(whoWasTold)).not.toMatch(/"(read|readAt|seen|seenAt|shown|offline)"/)
    expect((await ok(bea, 'GET', `/sales/orders/${G.X.orderId}/told?messageId=${notes.messageId}`)).change).toEqual(whoWasTold.change)
    await betaGetsNothing('S5')
  })

  it('S6 the planner applies it with Lower to the order (never below the 3 cut): Still to do closes, the closing line, the floor and the workshop told again; a new size change of the cut line is refused', async () => {
    const change = G.change
    expect(change).toMatchObject({ status: 'PROPOSED', kind: 'LOWER_TO_ORDER', partyId: world.ids.a, workOrder: { id: G.wo.id }, requestId: G.sizeRequest.id, extraOutcome: 'LEFTOVER', mayDecide: true, proposedBy: { id: bea.id } })
    expect(change.cells).toMatchObject([{ size: '52', from: 4, to: 1, workOrderSizeId: G.wo.cells['52'] }])
    expect(change.extra).toMatchObject([{ size: '52', count: 2 }])
    // Sales reads it on the order but decides nothing (workorders.manage); a person limited to Beta does not reach it.
    expect((await call(bea, 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version })).status).toBe(403)
    await asBeta('POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version }, 404)
    expect(await cellQuantity(G.wo.cells['52']!)).toBe(4)

    // Applied by the planner: production's Lower to the order — the cell goes down to what is already cut (3), never below it.
    const applied = await ok(carla, 'POST', `/production/work-order-changes/${change.id}/apply`, { version: change.version })
    expect(applied).toMatchObject({ change: { status: 'APPLIED', decidedBy: { id: carla.id }, lastError: null }, workOrder: { id: G.wo.id, status: 'IN_PROGRESS' }, reprint: { traveller: true } })
    expect(await cellQuantity(G.wo.cells['52']!)).toBe(3)
    expect(await cellQuantity(G.wo.cells['50']!)).toBe(4)
    G.applyBatch = await correlationOf('work_order_change.applied', 'changeId', change.id as string)
    await settle()

    // Its system line closes the change: "carried out: nothing left to do"; no price.
    const notes = await notesOf(G.applyBatch, G.X.orderId)
    const line = await messageOf(notes.messageId)
    const text = linesOfText(line.body)
    expect(text[0]).toMatch(new RegExp(`^Ordine di lavoro cambiato · ${await nameOfUser(carla.id)} · \\d\\d:\\d\\d$`))
    expect(text.find((entry) => entry.startsWith('Fatto: '))).toContain(`${G.wo.number} cambiato`)
    expect(text.find((entry) => entry.startsWith('Avvisati: '))).toContain(`il terzista di ${G.wo.number}`)
    expect(text.at(-1)).toMatch(/^Modifica del .+ eseguita: non resta nulla da fare\.$/)
    expect(noPriceIn(line.body)).toBe(true)
    expect(notes.stillToDo).toBe(0)
    // Still to do is empty: every row closed by its record.
    expect(await stillToDo()).toEqual({ rows: [], count: 0, workOrdersLeftOut: 0 })

    // The floor told the new figures on the work order; the workshop told again by its job's number; one bell item each, never Carla.
    const floor = await messageOf(notes.floor[0]!.messageId)
    expect(floor).toMatchObject({ forFloor: true, authorKind: 'SYSTEM', authorName: null })
    expect(floor.body.startsWith(`${G.wo.number} cambiato: taglia `)).toBe(true)
    expect(floor.body).toContain('52')
    expect((await fresh(workshop)).filter((notice) => notice.recordType === 'SubcontractOrder').map((notice) => [notice.messageKey, notice.recordId])).toEqual([['portal.job.order_changed', G.job.id]])
    for (const person of [dario, sara]) expect(await itemsOfChange(person, G.applyBatch), `bell of ${await nameOfUser(person.id)}`).toHaveLength(1)
    for (const person of [carla, bruno, bice]) expect(await itemsOfChange(person, G.applyBatch), `bell of ${await nameOfUser(person.id)}`).toEqual([])

    // The extra pieces are named honestly, in the office only (B-SA-043): 2 of size 52 made beyond what the order now wants.
    forgetProgress()
    const lines = (await ok(bea, 'GET', `/sales/orders/${G.X.orderId}/production?parts=lines`)).lines as Json[]
    expect((lines.find((entry) => entry.lineId === G.X.lineId)!.sizes as Json[]).find((size) => size.size === '52')).toMatchObject({ madeExtra: 2 })
    // The customer's progress never counts above what it ordered.
    const progress = await ok(buyerA, 'GET', `/portal/sales-orders/${G.X.orderId}/progress`)
    for (const entry of progress.lines as Json[]) for (const size of entry.sizes as Json[]) expect(size.cut ?? 0, `size ${size.size}`).toBeLessThanOrEqual(size.ordered)
    expect(JSON.stringify(progress)).not.toMatch(/madeExtra|Made extra|Pezzi in più|more than ordered|in più dell'ordine/) // B-OO-015: the office's words, never the portal's

    // A new size change of the cut line is refused in the cut's words (the portal's cut-off, unchanged); the design change still
    // waiting holds no size ask of the order.
    const rules = await ok(buyerA, 'GET', `/portal/sales-orders/${G.X.orderId}/change-requests/rules`)
    const verdict = (rules.lines as Json[]).find((entry) => entry.lineId === G.X.lineId)!.change as Json
    expect(verdict).toMatchObject({ possible: false, code: 'CUT' })
    expect(verdict.words.en).toMatch(/^Not possible: cutting started on /)
    const refused = await call(buyerA, 'POST', `/portal/sales-orders/${G.X.orderId}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: G.X.lineId, size: '50', quantity: 3 }] })
    expect(refused.status).toBe(409)
    expect(pathOf(refused.body)).toBe('body/cells/0/CUT')
    await betaGetsNothing('S6')
  })

  it('S7 the office answers the DESIGN change: one style change for Alpha’s own label (no file copied, no work order held), the floor told to keep its revision, Still to do waits on product', async () => {
    const request = G.designRequest
    const record = await ok(bea, 'GET', `/sales/change-requests/${request.id}`)
    expect(record.request).toMatchObject({ kind: 'DESIGN', status: 'OPEN', mayAnswer: true, fileIds: [G.sketch] })
    expect(record.preview.problems).toEqual([])
    const before = await ok(bea, 'GET', `/sales/change-requests/${request.id}/apply-plan`)
    expect((before.next as Json[]).filter((step) => step.kind === 'STYLE_CHANGE').map((step) => step.state)).toEqual(['TO_DO'])
    await asBeta('POST', `/sales/change-requests/${request.id}/accept`, { version: request.version }, 404)

    const accepted = await ok(bea, 'POST', `/sales/change-requests/${request.id}/accept`, { version: request.version, answer: DESIGN_ANSWER })
    expect(accepted.request).toMatchObject({ kind: 'DESIGN', status: 'ACCEPTED', answer: DESIGN_ANSWER })
    expect(accepted.styleChanges).toHaveLength(1)
    expect(accepted.styleChanges[0]).toMatchObject({ number: expect.stringMatching(/^CR-/), style: { id: G.privateStyle, code: 'SEED-JKT-02' } })
    G.styleChange = { id: accepted.styleChanges[0].id as string, number: accepted.styleChanges[0].number as string }
    const raised = await one('SELECT source::text AS source, "partyId"::text AS party, "orderChangeRequestId"::text AS asked, "styleId"::text AS style, status::text AS status FROM "ChangeRequest" WHERE id = $1', [G.styleChange.id])
    expect(raised).toEqual({ source: 'CUSTOMER', party: world.ids.a, asked: request.id, style: G.privateStyle, status: 'OPEN' })
    // The customer's sketch stays on the request and the order: no file is copied onto the style change (BW-3); no work order is held (BW-9).
    expect(await admin('SELECT id FROM "StoredFile" WHERE "recordType" = $1 AND "recordId" = $2', ['ChangeRequest', G.styleChange.id])).toEqual([])
    expect((await ok(carla, 'GET', `/production/work-orders/${G.wo.id}`)).workOrder.status).toBe('IN_PROGRESS')
    expect(await admin('SELECT id FROM "WorkOrderHold" WHERE "workOrderId" = $1', [G.wo.id])).toEqual([])
    G.designBatch = await correlationOf('order_change_request.answered', 'requestId', request.id as string)
    await settle()

    // One system line naming the style change for product; the floor keeps to its revision until the office decides.
    const notes = await notesOf(G.designBatch, G.X.orderId)
    const text = linesOfText((await messageOf(notes.messageId)).body)
    expect(text[0]).toMatch(new RegExp(`^Modifica accettata · ${await nameOfUser(bea.id)} · \\d\\d:\\d\\d$`))
    expect(text[1]).toContain('modifica del design di riga 10')
    expect(text.find((entry) => entry.startsWith('Prossimi: '))).toContain(`${G.styleChange.number} (prodotto)`)
    const floor = await messageOf(notes.floor[0]!.messageId)
    expect(floor).toMatchObject({ forFloor: true, authorKind: 'SYSTEM', authorName: null })
    expect(floor.body).toBe(`In arrivo una modifica del design (${G.styleChange.number}): segui la revisione 1 finché l'ufficio non decide.`)
    // A design change moves no quantity: the workshop is not told again.
    expect(notes.workshops).toEqual([])
    expect((await fresh(workshop)).filter((notice) => notice.recordType === 'SubcontractOrder')).toEqual([])
    for (const person of [dario, sara, carla]) expect(await itemsOfChange(person, G.designBatch), `bell of ${await nameOfUser(person.id)}`).toHaveLength(1)
    for (const person of [bea, bruno, bice]) expect(await itemsOfChange(person, G.designBatch), `bell of ${await nameOfUser(person.id)}`).toEqual([])
    // Still to do: the style change waits on product (its change order is product's flow, the golden product suite's).
    const still = await stillToDo()
    expect(still.rows).toEqual([expect.objectContaining({ kind: 'STYLE_CHANGE', ref: expect.objectContaining({ type: 'ChangeRequest', id: G.styleChange.id }), waitingOn: 'PRODUCT', requestId: request.id })])
    // The customer reads it accepted; told.
    expect(((await ok(buyerA, 'GET', `/portal/sales-orders/${G.X.orderId}/change-requests`)).items as Json[]).find((item) => item.id === request.id)).toMatchObject({ status: 'ACCEPTED', answer: DESIGN_ANSWER })
    expect((await fresh(buyerA)).some((notice) => notice.eventType === 'order_change_request.answered')).toBe(true)
    await betaGetsNothing('S7')
  })

  it('S8 a DESIGN ask on our own collection’s jacket is held at Accept in words (Counter or Refuse only), then refused in words the customer reads', async () => {
    const asked = (await ok(buyerA, 'POST', `/portal/sales-orders/${G.Y.orderId}/change-requests`, { kind: 'DESIGN', note: OWN_NOTE, lineIds: [G.Y.lineId] }, 201)).request as Json
    expect(asked).toMatchObject({ kind: 'DESIGN', status: 'OPEN' })
    G.ownRequest = asked
    await settle()
    // The record says it first; Accept is held in words; no style change is raised; it still waits.
    const record = await ok(bea, 'GET', `/sales/change-requests/${asked.id}`)
    expect((record.preview.problems as Json[]).map((problem) => problem.path)).toEqual(['request/OWN_COLLECTION'])
    const plan = await ok(bea, 'GET', `/sales/change-requests/${asked.id}/apply-plan`)
    expect((plan.next as Json[]).find((step) => step.kind === 'STYLE_CHANGE')).toMatchObject({ state: 'NOT_POSSIBLE' })
    const held = await call(bea, 'POST', `/sales/change-requests/${asked.id}/accept`, { version: asked.version })
    expect(held.status).toBe(409)
    expect(pathOf(held.body)).toBe('request/OWN_COLLECTION')
    expect(held.body.error.message).toMatch(/^This style is in our own collection: a style change would change other customers’ orders\./)
    expect(await admin('SELECT id FROM "ChangeRequest" WHERE "orderChangeRequestId" = $1', [asked.id])).toEqual([])
    expect((await requestRow(asked.id as string)).status).toBe('OPEN')

    // Refused with words the customer reads (never who answered).
    const refused = await ok(bea, 'POST', `/sales/change-requests/${asked.id}/refuse`, { version: asked.version, answer: OWN_REFUSAL })
    expect(refused.request).toMatchObject({ status: 'REFUSED', answer: OWN_REFUSAL })
    await settle()
    const theirs = ((await ok(buyerA, 'GET', `/portal/sales-orders/${G.Y.orderId}/change-requests`)).items as Json[]).find((item) => item.id === asked.id)!
    expect(theirs).toMatchObject({ status: 'REFUSED', answer: OWN_REFUSAL })
    expect('answeredBy' in theirs).toBe(false)
    // One short line on that order's conversation; the floor told nothing (no work order makes it).
    const batch = await correlationOf('order_change_request.answered', 'requestId', asked.id as string)
    const rows = await admin<{ after: NotesWritten }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderChangeNotes' AND "recordId" = $2 AND "requestId" = $3 AND after->>'written' = 'true'`, [T(), G.Y.orderId, batch])
    expect(rows).toHaveLength(1)
    G.lines.push(rows[0]!.after.messageId)
    expect(linesOfText((await messageOf(rows[0]!.after.messageId)).body)[0]).toMatch(new RegExp(`^Rifiutata · ${await nameOfUser(bea.id)} · \\d\\d:\\d\\d$`))
    expect(rows[0]!.after.floor).toEqual([])
    await betaGetsNothing('S8')
  })

  it('W the wall at the end: nothing Beta’s people got names Alpha; Alpha never reads who supervises, plans or follows, our work order, the workshop’s job or our notes; the workshop reads only its job; nothing records who saw a floor note', async () => {
    // T00 again, over EVERY answer of the flow with Alpha's markers as they stand now (its records, the flow's records and words).
    const markers = await alphaMarkers()
    expect(seen.B.length).toBeGreaterThan(100)
    expect(leaksIn(seen.B, markers)).toEqual([])
    // Every live message of the flow reached neither a person limited to Beta nor Beta's portal.
    await liveWall('W')

    // Alpha's people never read our people (Bea signs her own reply, as today), our work order, the workshop's job or our notes.
    const office: Marker[] = (
      await admin<{ id: string; email: string; name: string }>('SELECT id::text AS id, email, "displayName" AS name FROM "User" WHERE id = ANY($1::uuid[])', [[sara.id, carla.id, dario.id, bruno.id, bice.id]])
    ).flatMap((row) => [
      { label: 'office person id', text: row.id },
      { label: 'office person address', text: row.email },
      { label: 'office person name', text: row.name },
    ])
    const ours: Marker[] = [
      { label: 'our work order', text: G.wo.number },
      { label: 'our work order', text: G.wo.id },
      { label: "the workshop's job", text: G.job.number },
      { label: "the workshop's job", text: G.job.id },
      { label: 'our work-order change', text: G.change.id },
      ...[...G.lines, ...G.floorNotes].map((text) => ({ label: 'our note', text })),
    ]
    for (const id of [...G.lines, ...G.floorNotes]) ours.push({ label: 'our note text', text: linesOfText((await messageOf(id)).body)[0]! })
    expect(seen.A.length).toBeGreaterThan(10)
    expect(leaksIn(seen.A, [...office, ...ours])).toEqual([])

    // The workshop read only its own job: nothing of Alpha (its names, its order, our work order) in any answer it got.
    expect(seen.W.length).toBeGreaterThan(0)
    expect(leaksIn(seen.W, await markersOf(world.h.db, world.ids.a))).toEqual([])

    // R2: nothing records who or which station saw a floor note — no "seen" event of any kind, no read state in Who was told.
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE '%seen%'`, [T()])).toEqual([])
    const woThread = await ok(carla, 'GET', `/threads/WorkOrder/${G.wo.id}`)
    for (const id of G.floorNotes) expect(JSON.stringify((woThread.messages as Json[]).find((message) => message.id === id) ?? null)).not.toMatch(/"(seen|seenAt|seenBy|readBy|shown)"/)
  })

  it('Z no route answered 500 and no handler failed during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(worker.retried).toEqual([])
  })
})

// ── B-OP-071 (order page plan, set C · C07; 13-backend §13): the order page's API flow, two brands ─────────────────────────────────
/**
 * The order page's API flow in the same world, after the sales page's (S0–Z): every act the order page makes on Alpha's orders,
 * each step ending with the brand wall (`pageWall`: Beta's buyer, `office.p2` and Bice read none of it by any door, their lists hold
 * none of it, then `betaGetsNothing`: bells, live messages and every answer they got scanned for Alpha's markers, the order page's
 * words and records among them). Three more office people: Olga (the Owner: every right), Fina (Finance: she decides the yes) and
 * Wanda (the warehouse: shipping.manage and shipping.ddt.issue, never shipping.holds.release). Lane rule (Sales = no price): every
 * act with prices is the Owner's or Finance's; Sales (Bea) keeps the no-price acts (O1's quantity change: the DRAFT follows, D1).
 *
 *   O0  the scene: Olga and Wanda; the shipping seed's ids (SEED-SO-0002's free black 52, SEED-SO-0003's free jacket); the order
 *       page seed's SEED-SH-0004 (two of Alpha's orders on one DRAFT, made past the guards); the tracking notes join the worker
 *   O1  an office amend under Sales (Bea, no workorders.manage): the preview says what each work order does — the DRAFT follows in
 *       the click, the RELEASED one waits in words; the amend does exactly that; Sales may not apply the waiting one; Carla applies
 *       it on its own page (Lower to the order, the reprint mark); the floor note names the work order and no person
 *   O2  an approval decided in place: a made-up SALES_ORDER rule holds the order Olga types with its prices (PENDING_APPROVAL); the
 *       order read lists the request — held for its asker (her own request, the Owner included), allowed for Fina; Fina's yes in
 *       place confirms it
 *   O3  the settlement share on a shared TD24 (two of Alpha's orders on one issued monthly invoice, partly paid, its freight apart:
 *       the world's set-up, as B-OP-022's): each order reads its own share, the same as its row in Sales › Orders
 *   O4  a shipment made elsewhere of SEED-SO-0002's free black 52 while Alpha is on a credit hold: Wanda is refused in words and
 *       nothing is written; Olga (the hold-release right) records it with a reason: SHIPPED, made elsewhere with its paper DDT, the
 *       override recorded; a Nexus DDT of it refused in words; the hold released again
 *   O5  tracking typed on it from the order page (number and link): the office line on the order's thread; the portal and the
 *       tracking page show the number and its link; corrected; cleared
 *   O6  its invoice names the paper DDT (B-OP-033): the shipment waits in "shipped, not invoiced"; the draft's DDT reference
 *   O8  several orders on one shipment (B-OP-047: N6 on): one shipment made for two of Alpha's orders through the API
 *       (SEED-SO-0002's black 52 moved off SEED-SH-0004, SEED-SO-0003's free jacket): both orders' reads carry it with both orders;
 *       the DDT names one order reference per order; its freight once, each order its share
 *   OW  the wall at the end: nothing Beta's people got names Alpha; Alpha's buyer never reads Olga's, Fina's or Wanda's names
 *   OZ  no route answered 500 and no handler failed during the order page's flow
 *
 * Not through a route, each named where it is done: the people's back-dated roles and the two seeds (the world's set-up), the shared
 * TD24 of O3 (an ISSUED monthly invoice is money's flow: as B-OP-022's rows) and the quality desk's release of O4's black 52 (quality
 * is the quality suite's flow; the seeds date theirs in the story's days to come, after "now": a copy dated an hour before).
 * Invoices per order of a shared shipment that LEFT are B-OP-045's (candidates.pg: one per order, the freight on the first order's):
 * here the shared shipment stays a DRAFT, its second order's jacket being serial-tracked (Q31: its serial is packed at PACKED).
 * The made-elsewhere body is B-OP-032's contract (shipping/elsewhere/contract.ts `elsewhereBody`), its hold reason `holdReason`.
 */


// The order page's own words of Alpha's: none may ever reach Beta.
const AMEND_REASON = 'Made-up Alpha amend: the store wants one jacket of 50 and two of 52 fewer.'
const APPROVAL_PO = 'T-OP71-PO-YES'
const HOLD_WORDS = 'Made-up Alpha hold: two invoices overdue.'
const HOLD_REASON = 'Made-up Alpha override: the goods left with the driver before the hold was placed.'
const ELSEWHERE_NOTE = 'Made-up Alpha delivery: taken by the courier from the second warehouse.'
const PAPER_DDT = 'T-OP71-DDT-0001'
const TRACKING = ['T-OP71-TRK-0001', 'T-OP71-TRK-0002'] as const
const LINKS = ['https://track.example.com/T-OP71-TRK-0001', 'https://track.example.com/T-OP71-TRK-0002'] as const
const PAGE_WORDS = [AMEND_REASON, APPROVAL_PO, HOLD_WORDS, HOLD_REASON, ELSEWHERE_NOTE, PAPER_DDT, ...TRACKING, ...LINKS]

/** The Owner, Finance and the warehouse (O0). */
let olga: Office
let fina: Office
let wanda: Office

/** The order page's records of the flow (filled as the steps make them). */
const P = {} as {
  so2: string
  so3: string
  /** SEED-SO-0002's black 52 (WO-0001's cell: one garment released and on no shipment) and SEED-SO-0003's jacket (one free). */
  blk52: string
  jacket: string
  siteA1: string
  /** SEED-SH-0004 and its SEED-SO-0002 line and cell (the order page seed). */
  sh4: string
  sh4Line: string
  sh4Cell: string
  am: Order
  released: { id: string; number: string; cell: string }
  draft: { id: string; number: string; cell: string }
  changeId: string
  approvalOrder: string
  taskId: string
  money: { o1: string; o2: string; l1: string; l2: string; invoice: string; payment: string }
  elsewhere: { id: string; number: string }
  invoiceId: string
  shared: { id: string; number: string }
  /** Where Alpha's buyer's answers stood when the order page's flow began (OW). */
  seenA: number
  unexpected: number
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
/** Every id of the order page's records made so far (doors, lists and markers). */
const pageIds = (): string[] =>
  [P.am?.orderId, P.released?.id, P.draft?.id, P.changeId, P.approvalOrder, P.taskId, P.money?.o1, P.money?.o2, P.money?.invoice, P.elsewhere?.id, P.invoiceId, P.shared?.id].filter(isText)
function pageMarkers(): Marker[] {
  return [
    ...PAGE_WORDS.map((text) => ({ label: "Alpha's order page words", text })),
    ...pageIds().map((text) => ({ label: "Alpha's order page records", text })),
    ...[P.am?.number, P.released?.number, P.draft?.number, P.elsewhere?.number, P.shared?.number].filter(isText).map((text) => ({ label: "Alpha's order page numbers", text })),
  ]
}

/** "<number> is released: production applies the change …" (B-OP-012's words, for a reader of work orders). */
const PRODUCTION = (number: string) => ({ en: `${number} is released: production applies the change (a planner or a production manager).`, it: `${number} è rilasciato: la modifica la applica la produzione (un pianificatore o un responsabile di produzione).` })
const orderVersion = async (orderId: string): Promise<number> => (await one<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [orderId])).version
const shipmentVersion = async (shipmentId: string): Promise<number> => (await one<{ version: number }>('SELECT version FROM "Shipment" WHERE id = $1', [shipmentId])).version
const numberOfOrder = async (orderId: string): Promise<string> => (await one<{ number: string }>('SELECT number FROM "SalesOrder" WHERE id = $1', [orderId])).number
/** The day in Rome of an instant (a paper DDT is dated by the plant's day). */
const romeDay = (at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
/** The system lines on an order's thread that name a text (office-only lines of the shipping handlers). */
const systemLinesOn = (orderId: string, text: string) =>
  admin<{ body: string; audience: string; direction: string }>(
    `SELECT m."bodyText" AS body, m.audience::text AS audience, m.direction::text AS direction FROM "Message" m JOIN "Thread" t ON t.id = m."threadId"
      WHERE t."tenantId" = $1 AND t."recordType" = 'SalesOrder' AND t."recordId" = $2 AND m."authorKind" = 'SYSTEM' AND m."bodyText" LIKE '%' || $3 || '%' ORDER BY m.at, m.id`,
    [T(), orderId, text],
  )
/** The tracking page of a link (the customer's phone: no sign-in, the link's token). */
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')
async function trackingPage(token: string): Promise<Json> {
  const answer = await world.h.app.inject({ method: 'GET', url: '/link/tracking', headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0' } })
  expect(answer.statusCode, answer.body).toBe(200)
  return answer.json() as Json
}

/** A shipment made elsewhere of SEED-SO-0002's black 52 (B-OP-032's body): a carrier booked by hand, the paper DDT that went with the goods. */
const elsewhereBody = (shippedAt: Date, more: Json = {}): Json => ({
  salesOrderId: P.so2,
  siteId: P.siteA1,
  lines: [{ workOrderSizeId: P.blk52, quantity: 1 }],
  transportBy: 'CARRIER',
  carrierName: 'Made-up Courier',
  externalDdt: { number: PAPER_DDT, date: romeDay(shippedAt) },
  ddtRequired: true,
  shippedAt: shippedAt.toISOString(),
  internalNote: ELSEWHERE_NOTE,
  ...more,
})
/** R-9: a person with shipping.holds.release records it while the customer is on hold, with a reason. */
const holdOverride = (reason: string): Json => ({ holdReason: reason })

/**
 * The wall at the end of an order page step: Beta's buyer, `office.p2` and Bice read every door of the order page's records of
 * Alpha's as unknown (the orders, their money, shipments, work orders, the change, the request for a yes, the invoices, the file
 * previews) and lists without them; then the whole wall of `betaGetsNothing` (bells, live messages, every answer scanned).
 */
async function pageWall(step: string): Promise<void> {
  const orders = [P.am?.orderId, P.approvalOrder, P.money?.o1, P.money?.o2, P.so2, P.so3].filter(isText)
  for (const id of orders) {
    for (const url of [`/portal/sales-orders/${id}`, `/portal/sales-orders/${id}/shipments`]) expect((await call(buyerB, 'GET', url)).status, `${step}: Beta's buyer GET ${url}`).toBe(404)
    for (const url of [`/sales/orders/${id}`, `/invoicing/orders/${id}/settlement`, `/threads/SalesOrder/${id}`]) await asBeta('GET', url, undefined, 404)
    expect((await call(bice, 'GET', `/sales/orders/${id}`)).status, `${step}: Bice GET order ${id}`).toBe(404)
  }
  // The order's file previews (B-OP-050): Alpha's order is unknown, whatever file is asked.
  await asBeta('POST', `/sales/orders/${P.so2}/files/previews`, { fileIds: [newId()] }, 404)
  const doors = [
    ...[P.released?.id, P.draft?.id].filter(isText).map((id) => `/production/work-orders/${id}`),
    ...(P.changeId ? [`/production/work-order-changes/${P.changeId}`] : []),
    ...(P.taskId ? [`/approvals/tasks/${P.taskId}`] : []),
    ...[P.elsewhere?.id, P.shared?.id, P.sh4].filter(isText).flatMap((id) => [`/shipping/shipments/${id}`, `/shipping/shipments/${id}/orders/candidates`]),
    ...[P.money?.invoice, P.invoiceId].filter(isText).map((id) => `/invoicing/invoices/${id}`),
  ]
  for (const url of doors) await asBeta('GET', url, undefined, 404)
  const ids = pageIds()
  for (const url of ['/shipping/shipments', '/approvals/tasks?status=ALL', '/invoicing/invoices']) {
    const text = JSON.stringify(await asBeta('GET', url))
    for (const id of ids) expect(text.includes(id), `${step}: ${url} lists ${id}`).toBe(false)
  }
  const transit = JSON.stringify(await ok(buyerB, 'GET', '/portal/sales-orders/in-transit'))
  for (const id of ids) expect(transit.includes(id), `${step}: Beta's On the way lists ${id}`).toBe(false)
  await betaGetsNothing(step)
}

describe('B-OP-071 golden flow order page: the order page’s acts on Alpha’s orders, Beta gets nothing', { timeout: LONG }, () => {
  beforeAll(async () => {
    P.seenA = seen.A.length
    P.unexpected = unexpected.length
    olga = await world.officePerson('olga.owner@sa89-office.example.com', 'owner')
    fina = await world.officePerson('fina.finance@sa89-office.example.com', 'finance')
    wanda = await world.officePerson('wanda.warehouse@sa89-office.example.com', 'warehouse')
    // World set-up (as S0's): their roles hold on the harness clock and the server clock alike.
    await world.replica([{ sql: `UPDATE "RoleAssignment" SET "validFrom" = now() - interval '1 day' WHERE "userId" = ANY($1::uuid[])`, values: [[olga.id, fina.id, wanda.id]] }])
    // The worker's tracking notes (B-OP-030) join the in-process handlers.
    handlers = [...handlers, trackingNotesHandler()]
  }, LONG)

  it('O0 the scene: the shipping seed’s free garments of Alpha’s two seeded orders; the order page seed’s shared DRAFT; nothing told', async () => {
    // Both seeds are idempotent: the shipping seed ran with the world (its ids read again), the order page seed is the world's set-up.
    const shipping = await seedShipping({ db: world.h.database, namespace: NS })
    const page = await seedOrderPage({ db: world.h.database, namespace: NS })
    P.so2 = shipping.quality.production.salesOrderId
    P.so3 = shipping.quality.serialSalesOrderId
    P.blk52 = shipping.quality.production.cellIds['BLK-52']
    P.jacket = shipping.quality.serialCellId
    P.siteA1 = seedUuid(NS, 'site:A1')
    P.sh4 = page.sharedShipmentId
    P.sh4Line = page.lineIds[0]
    P.sh4Cell = page.cellIds[0]
    expect(page.salesOrderIds).toEqual([P.so2, P.so3])
    // Both seeded orders are Alpha's.
    expect(new Set((await admin<{ partyId: string }>('SELECT "partyId"::text AS "partyId" FROM "SalesOrder" WHERE id = ANY($1::uuid[])', [[P.so2, P.so3]])).map((row) => row.partyId))).toEqual(new Set([world.ids.a]))
    await settle()
    for (const person of [buyerA, buyerB, bice, workshop]) await fresh(person)
    await pageWall('O0')
  })

  it('O1 an office amend under Sales: the DRAFT work order follows in the click, the RELEASED one waits in words; Carla applies it on its own page (reprint); the floor note names no person', async () => {
    // A new order of Alpha's private-label jacket (4 of 50, 4 of 52), its two work orders: size 50 RELEASED, size 52 a DRAFT.
    P.am = await privateLabelOrder('AM')
    const make = async (size: '50' | '52'): Promise<Json> => (await ok(carla, 'POST', '/production/work-orders', { siteId: world.w.siteId, lines: [{ salesOrderLineId: P.am.lineId, sizes: [{ size, quantity: 4 }] }] }, 201)).workOrder as Json
    const released = await release((await make('50')).id as string)
    expect(released.status).toBe('RELEASED')
    const draft = await make('52')
    expect(draft.status).toBe('DRAFT')
    const cellOf = (workOrder: Json, size: string): string => (workOrder.cells as Json[]).find((cell) => cell.size === size)!.id as string
    P.released = { id: released.id as string, number: released.number as string, cell: cellOf(released, '50') }
    P.draft = { id: draft.id as string, number: draft.number as string, cell: cellOf(draft, '52') }

    // The Lines edit's preview (B-OP-013): what each work order will do — in Bea's click, or waiting for production.
    const amend = { version: await orderVersion(P.am.orderId), reason: AMEND_REASON, lines: [{ id: P.am.lineId, sizes: [{ size: '50', quantity: 3 }, { size: '52', quantity: 2 }] }] }
    const preview = await ok(bea, 'POST', `/sales/orders/${P.am.orderId}/amendments/preview`, amend)
    expect(preview).toMatchObject({ ok: true, workOrders: { extra: [], needsOutcome: false } })
    const plan = preview.workOrders.plan as Json[]
    expect(plan.find((row) => row.workOrderId === P.draft.id)).toMatchObject({ route: 'SET_DRAFT_CELLS', appliesNow: true })
    expect(plan.find((row) => row.workOrderId === P.released.id)).toMatchObject({ route: 'LOWER_RELEASED', appliesNow: false, reprint: true, held: PRODUCTION(P.released.number) })
    // A person limited to Beta amends nothing of it (as unknown); nothing is written.
    await asBeta('POST', `/sales/orders/${P.am.orderId}/amendments`, amend, 404)

    // Apply: the amendment lands; the DRAFT follows in the same command; the RELEASED one waits, PROPOSED, with its words.
    const applied = await ok(bea, 'POST', `/sales/orders/${P.am.orderId}/amendments`, amend, 201)
    expect(applied.workOrders.applied).toEqual([{ changeId: expect.any(String), workOrderId: P.draft.id, number: P.draft.number, route: 'SET_DRAFT_CELLS', reprint: false }])
    expect(applied.workOrders.waiting).toEqual([{ changeId: expect.any(String), workOrderId: P.released.id, number: P.released.number, words: PRODUCTION(P.released.number) }])
    expect(await lineSize(P.am.lineId, '50')).toBe(3)
    expect(await lineSize(P.am.lineId, '52')).toBe(2)
    expect(await cellQuantity(P.draft.cell)).toBe(2)
    expect(await cellQuantity(P.released.cell)).toBe(4)
    P.changeId = applied.workOrders.waiting[0].changeId as string
    await settle()

    // The waiting one, on the work order's own page: Sales may not apply it (workorders.manage); a person limited to Beta does not
    // reach it; Carla applies it — Lower to the order, the traveller to reprint.
    const change = (await ok(carla, 'GET', `/production/work-order-changes/${P.changeId}`)).change as Json
    expect(change).toMatchObject({ status: 'PROPOSED', kind: 'LOWER_TO_ORDER', partyId: world.ids.a, workOrder: { id: P.released.id }, mayDecide: true, proposedBy: { id: bea.id } })
    expect((await call(bea, 'POST', `/production/work-order-changes/${P.changeId}/apply`, { version: change.version })).status).toBe(403)
    await asBeta('POST', `/production/work-order-changes/${P.changeId}/apply`, { version: change.version }, 404)
    expect(await cellQuantity(P.released.cell)).toBe(4)
    const done = await ok(carla, 'POST', `/production/work-order-changes/${P.changeId}/apply`, { version: change.version })
    expect(done).toMatchObject({ change: { status: 'APPLIED', decidedBy: { id: carla.id }, lastError: null }, workOrder: { id: P.released.id, status: 'RELEASED' }, reprint: { traveller: true } })
    expect(await cellQuantity(P.released.cell)).toBe(3)
    const batch = await correlationOf('work_order_change.applied', 'changeId', P.changeId)
    await settle()

    // The floor told the new figures on the work order: the work order's number, never a person's name.
    const notes = await notesOf(batch, P.am.orderId)
    expect(notes.floor.map((entry) => entry.workOrderId)).toEqual([P.released.id])
    const floor = await messageOf(notes.floor[0]!.messageId)
    expect(floor).toMatchObject({ forFloor: true, authorKind: 'SYSTEM', authorName: null })
    expect(floor.body.startsWith(`${P.released.number} cambiato: taglia `)).toBe(true)
    expect(floor.body).toContain('50')
    for (const person of [bea, carla]) expect(floor.body).not.toContain(await nameOfUser(person.id))
    expect(noPriceIn((await messageOf(notes.messageId)).body)).toBe(true)
    await pageWall('O1')
  })

  it('O2 an approval decided in place: the request held for its asker (the Owner included), allowed for Finance; its yes on the order page confirms it', async () => {
    // Lane rule (Sales = no price): an order typed with its prices is the Owner's here, its yes Finance's (Fina).
    // A made-up rule: every order typed for company A waits for Finance's yes (switched off again at the end of the step).
    const financeRole = await one<{ id: string }>(`SELECT id::text AS id FROM "Role" WHERE "tenantId" = $1 AND key = 'finance'`, [T()])
    const rule = (await stepped(olga, 'POST', '/approvals/rules', { kind: 'SALES_ORDER', companyId: world.w.companyId, name: 'Made-up: every typed order waits for Finance', condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '1' }] }, approver: { roleId: financeRole.id }, sequence: 3, dueHours: 24 }, 201)).rule as Json
    await stepped(olga, 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })
    const typed = { companyId: world.w.companyId, partyId: world.ids.a, customerRef: APPROVAL_PO, lines: [{ styleId: G.privateStyle, colourwayId: seedUuid(NS, 'production:colourway:JKT-02:BLK'), unitPrice: '100', sizes: [{ size: '50', quantity: 2 }] }] }
    const waiting = (await ok(olga, 'POST', '/sales/orders/manual', typed, 201)).order as Json
    expect(waiting.status).toBe('PENDING_APPROVAL')
    P.approvalOrder = waiting.id as string
    await settle()

    // The asker reads her own request held (nobody approves their own request, the Owner included) and may take it back.
    const asker = (await ok(olga, 'GET', `/sales/orders/${P.approvalOrder}`)).order as Json
    const own = (asker.openApprovals as Json[]).find((row) => row.kind === 'SALES_ORDER')!
    expect(own).toMatchObject({ requester: { me: true }, approve: { allowed: false }, reject: { allowed: false }, withdraw: { allowed: true, why: null } })
    expect(asker.live.ids.approvalTaskIds).toContain(own.taskId)
    P.taskId = own.taskId as string
    expect([403, 409]).toContain((await call(olga, 'POST', `/approvals/tasks/${P.taskId}/approve`, { version: own.version, comment: null })).status)
    // Bice decides nothing of it; a person limited to Beta reads neither the order nor the request.
    expect([403, 404]).toContain((await call(bice, 'POST', `/approvals/tasks/${P.taskId}/approve`, { version: own.version, comment: null })).status)
    await asBeta('GET', `/approvals/tasks/${P.taskId}`, undefined, 404)

    // Finance reads it allowed, and says yes in place (a step-up first when the rule asks one).
    const approver = (await ok(fina, 'GET', `/sales/orders/${P.approvalOrder}`)).order as Json
    const row = (approver.openApprovals as Json[]).find((entry) => entry.taskId === P.taskId)!
    expect(row).toMatchObject({ kind: 'SALES_ORDER', requester: { me: false }, approver: { me: true }, approve: { allowed: true, why: null }, reject: { allowed: true, why: null }, withdraw: { allowed: false } })
    if (row.requireStepUp) await fina.stepUp()
    await ok(fina, 'POST', `/approvals/tasks/${P.taskId}/approve`, { version: row.version, comment: 'Made-up: confirmed from the order page.' })
    const after = (await ok(fina, 'GET', `/sales/orders/${P.approvalOrder}`)).order as Json
    expect(after).toMatchObject({ status: 'CONFIRMED', openApprovals: [], openApprovalsHidden: 0 })
    expect((await ok(olga, 'GET', `/sales/orders/${P.approvalOrder}`)).order.openApprovals).toEqual([])

    const current = (await ok(olga, 'GET', `/approvals/rules/${rule.id}`)).rule as Json
    await stepped(olga, 'PUT', `/approvals/rules/${rule.id}`, { version: current.version, active: false })
    await settle()
    await pageWall('O2')
  })

  it('O3 the settlement share on a shared TD24: each order reads its own share, the same as its row in Sales › Orders; the freight in no order', async () => {
    // The world's set-up (money's flow, as B-OP-022's rows): Alpha's monthly TD24 bills two of its orders and the freight, partly paid.
    //   O1 2 jackets, net 200.00 + VAT 44.00 · O2 6 jackets, net 600.00 + VAT 132.00 · freight 10.00 net (12.20) · gross 988.20
    //   300.00 paid on the TD24: O1's share 75.00 (200 of 800), O2's 225.00
    const fx = { o1: newId(), o2: newId(), l1: newId(), l2: newId(), invoice: newId(), payment: newId() }
    const black = seedUuid(NS, 'production:colourway:JKT-02:BLK')
    const company = world.w.companyId
    const order = (id: string, number: string, net: number, vat: number) => ({
      sql: `INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, status, "orderDate", "taxMode", "billTo", "shipTo", "netAmount", "vatAmount", "grossAmount") VALUES ($1, $2, $3, $4, $5, 'SHIPPED', '2026-11-02', 'IT_B2B', '{}'::jsonb, '{}'::jsonb, $6, $7, $8)`,
      values: [id, T(), company, world.ids.a, number, net, vat, net + vat],
    })
    const line = (id: string, orderId: string, quantity: number, net: number, vat: number) => ({
      sql: `INSERT INTO "SalesOrderLine" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, "styleId", "colourwayId", quantity, "unitPrice", "netAmount", "vatRatePct", "vatAmount") VALUES ($1, $2, $3, $4, $5, 10, 'SIZE_GRID', $6, $7, $8, 100, $9, 22, $10)`,
      values: [id, T(), company, orderId, world.ids.a, G.privateStyle, black, quantity, net, vat],
    })
    const invoiceLine = (seq: number, kind: 'GOODS' | 'CHARGE', net: number, quantity: number, orderLineId: string | null) => ({
      sql: `INSERT INTO "InvoiceLine" (id, "tenantId", "invoiceId", "buyerPartyId", "partyId", seq, kind, description, quantity, "unitPrice", "netAmount", "vatRatePct", "salesOrderLineId", "chargeKind") VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, 22, $11, $12)`,
      values: [newId(), T(), fx.invoice, world.ids.a, seq, kind, `T-OP71 line ${seq} (made up)`, quantity, net / quantity / 100, net, orderLineId, kind === 'CHARGE' ? 'FREIGHT' : null],
    })
    await world.replica([
      order(fx.o1, 'T-OP71-SO-1', 20_000, 4_400),
      order(fx.o2, 'T-OP71-SO-2', 60_000, 13_200),
      line(fx.l1, fx.o1, 2, 20_000, 4_400),
      line(fx.l2, fx.o2, 6, 60_000, 13_200),
      {
        sql: `INSERT INTO "Invoice" (id, "tenantId", "companyId", "buyerPartyId", "partyId", "docType", status, number, year, "issueDate", "issuedAt", "billTo", "netTotal", "vatTotal", "grossTotal", "vatSummary") VALUES ($1, $2, $3, $4, $4, 'TD24', 'ISSUED', 'T-OP71-TD24-1', 2026, '2026-11-05', '2026-11-05T09:00:00Z', '{}'::jsonb, 81000, 17820, 98820, '[{"rate":"22.00","nature":null,"legalRef":null,"taxable":81000,"vat":17820,"rounding":0}]'::jsonb)`,
        values: [fx.invoice, T(), company, world.ids.a],
      },
      invoiceLine(1, 'GOODS', 20_000, 2, fx.l1),
      invoiceLine(2, 'GOODS', 60_000, 6, fx.l2),
      invoiceLine(3, 'CHARGE', 1_000, 1, null),
      { sql: `INSERT INTO "Payment" (id, "tenantId", "companyId", "partyId", amount, "receivedOn", "externalRef") VALUES ($1, $2, $3, $4, 30000, '2026-11-10', 'T-OP71-TRN-1')`, values: [fx.payment, T(), company, world.ids.a] },
      { sql: `INSERT INTO "PaymentAllocation" (id, "tenantId", "companyId", "partyId", "paymentId", "invoiceId", amount) VALUES ($1, $2, $3, $4, $5, $6, 30000)`, values: [newId(), T(), company, world.ids.a, fx.payment, fx.invoice] },
    ])
    P.money = fx

    // Each order's Money: its own share, the same paid and still to pay as its row in Sales › Orders.
    const settlementOf = async (orderId: string): Promise<Json> => (await ok(olga, 'GET', `/invoicing/orders/${orderId}/settlement`)).settlement as Json
    const list = (await ok(olga, 'GET', `/sales/orders?ids=${fx.o1},${fx.o2}`)).orders as Json[]
    for (const orderId of [fx.o1, fx.o2]) {
      const row = list.find((entry) => entry.id === orderId)!
      const { thisOrder } = await settlementOf(orderId)
      expect([thisOrder.paid, thisOrder.stillToPay], orderId).toEqual([row.paid, row.balance])
    }
    expect((await settlementOf(fx.o1)).thisOrder).toEqual({ paid: 7500, stillToPay: 16900, invoicedShare: 24400, depositsPaid: 0, writtenOff: 0 })
    expect((await settlementOf(fx.o2)).thisOrder).toEqual({ paid: 22500, stillToPay: 50700, invoicedShare: 73200, depositsPaid: 0, writtenOff: 0 })
    // The shared invoice beside it: its whole, this order's share and what of it is open, the freight apart, the other order it bills.
    const first = ((await settlementOf(fx.o1)).invoices as Json[]).find((invoice) => invoice.id === fx.invoice)!
    expect(first).toMatchObject({ docType: 'TD24', grossTotal: 98820, paidAmount: 30000, share: 24400, openShare: 16900, freight: 1220, otherOrders: [{ id: fx.o2, number: 'T-OP71-SO-2' }], otherOrdersHidden: 0 })
    const second = ((await settlementOf(fx.o2)).invoices as Json[]).find((invoice) => invoice.id === fx.invoice)!
    expect(second).toMatchObject({ share: 73200, openShare: 50700, freight: 1220, otherOrders: [{ id: fx.o1, number: 'T-OP71-SO-1' }] })
    expect(first.share + second.share + first.freight).toBe(first.grossTotal)
    await pageWall('O3')
  })

  it('O4 a shipment made elsewhere while Alpha is on hold: the warehouse is refused in words; the Owner records it with a reason; no Nexus DDT of it', async () => {
    // The world's set-up: the quality desk released one more black 52 of SEED-SO-0002 two hours ago (quality's flow, the quality
    // suite's): a copy of the seeds' release of that cell, of one garment (the seeds date theirs in the story's days to come).
    const source = await one<{ id: string }>('SELECT id::text AS id FROM "QualityRelease" WHERE "workOrderSizeId" = $1 ORDER BY "releasedAt", id LIMIT 1', [P.blk52])
    const releasedAt = new Date(world.h.clock.now().getTime() - 2 * 60 * 60_000)
    await world.replica([
      {
        sql: `INSERT INTO "QualityRelease" SELECT * FROM jsonb_populate_record(NULL::"QualityRelease", (SELECT to_jsonb(r) || $1::jsonb FROM "QualityRelease" r WHERE r.id = $2::uuid))`,
        values: [JSON.stringify({ id: newId(), number: 'T-OP71-REL-0001', quantity: 1, releasedAt: releasedAt.toISOString(), createdAt: releasedAt.toISOString() }), source.id],
      },
    ])
    // Alpha goes on a credit hold for company A (finance's act, here the Owner's).
    const placed = (await stepped(olga, 'POST', `/parties/${world.ids.a}/holds`, { companyId: world.w.companyId, reason: 'CREDIT', words: HOLD_WORDS }, 201)).holds as Json
    expect(placed.onHold).toBe(true)
    const hold = (placed.holds as Json[]).find((row) => row.inForce && row.reason === 'CREDIT')!

    // The dialog's preview names the hold; the warehouse's record is refused in words, nothing written, her reason changes nothing.
    const shippedAt = new Date(world.h.clock.now().getTime() - 60 * 60_000)
    const preview = await ok(wanda, 'POST', '/shipping/shipments/elsewhere/preview', elsewhereBody(shippedAt))
    expect(preview.holds).toMatchObject({ held: true, mayRelease: false })
    // The seeds' free black 52 and the one released two hours ago: two on no shipment.
    expect(preview.lines).toEqual([expect.objectContaining({ workOrderSizeId: P.blk52, quantity: 1, shippable: 2, serialTracked: false })])
    expect(new Date(preview.earliest as string).getTime()).toBeLessThanOrEqual(shippedAt.getTime())
    const refused = await call(wanda, 'POST', '/shipping/shipments/elsewhere', elsewhereBody(shippedAt))
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('refusal/HELD')
    expect([403, 409]).toContain((await call(wanda, 'POST', '/shipping/shipments/elsewhere', elsewhereBody(shippedAt, holdOverride(HOLD_REASON)))).status)
    // The Owner may release holds, but says why first.
    expect(pathOf((await call(olga, 'POST', '/shipping/shipments/elsewhere', elsewhereBody(shippedAt))).body)).toBe('refusal/REASON_REQUIRED')
    expect(await admin('SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND "externalDdtNumber" = $2', [T(), PAPER_DDT])).toEqual([])
    // A person limited to Beta records nothing on Alpha's order (as unknown).
    await asBeta('POST', '/shipping/shipments/elsewhere', elsewhereBody(shippedAt, holdOverride(HOLD_REASON)), 404)

    // The Owner holds the hold-release right: with her reason it is recorded — SHIPPED, made elsewhere, its paper DDT.
    const recorded = (await ok(olga, 'POST', '/shipping/shipments/elsewhere', elsewhereBody(shippedAt, holdOverride(HOLD_REASON)), 201)).shipment as Json
    expect(recorded).toMatchObject({ status: 'SHIPPED', salesOrderId: P.so2, externalDdt: { number: PAPER_DDT } })
    P.elsewhere = { id: recorded.id as string, number: recorded.number as string }
    const order = (await ok(olga, 'GET', `/sales/orders/${P.so2}`)).order as Json
    expect((order.chain.shipments as Json[]).find((row) => row.id === P.elsewhere.id)).toMatchObject({ origin: 'ELSEWHERE', externalDdt: { number: PAPER_DDT } })
    // The override recorded: its audit names the reason; an office-only line on the order's thread.
    const audit = await admin<{ after: Json; reason: string | null }>(`SELECT after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'shipping.recordedElsewhere' AND "recordId" = $2`, [T(), P.elsewhere.id])
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after.holds).toMatchObject({ reason: HOLD_REASON })
    expect(audit[0]!.reason).toBe(HOLD_REASON)
    await settle()
    const lines = await systemLinesOn(P.so2, HOLD_REASON)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ audience: 'OFFICE', direction: 'INTERNAL_NOTE' })
    expect(lines[0]!.body).toContain(P.elsewhere.number)
    // No system hold is synced onto it (it left already).
    expect(await admin('SELECT 1 FROM "ShipmentHold" WHERE "shipmentId" = $1', [P.elsewhere.id])).toEqual([])
    // Nexus issues no second fiscal number: its DDT is refused in words naming the paper DDT.
    const ddt = await call(wanda, 'POST', `/shipping/shipments/${P.elsewhere.id}/ddt`, {})
    expect(ddt.status).toBe(409)
    expect(pathOf(ddt.body)).toBe('refusal/NEXUS_DDT')
    expect(ddt.body.error.message).toContain(PAPER_DDT)
    // The same paper DDT is never recorded twice for the customer (R-10), in words that name no customer.
    const twice = await call(olga, 'POST', '/shipping/shipments/elsewhere', elsewhereBody(shippedAt, holdOverride(HOLD_REASON)))
    expect(twice.status).toBe(409)
    expect(twice.body.error.message).not.toMatch(/Alpha|Beta/)

    // The hold released again (the paper of the next steps is not held).
    const released = (await stepped(olga, 'POST', `/parties/${world.ids.a}/holds/${hold.id}/release`, { version: hold.version, words: 'Made-up: both invoices paid.' })).holds as Json
    expect(released.onHold).toBe(false)
    await settle()
    await pageWall('O4')
  })

  it('O5 tracking typed on it from the order page: the office line; the portal and the tracking page show the number and its link; corrected; cleared', async () => {
    const put = async (body: Json): Promise<Json> => ok(wanda, 'PUT', `/shipping/shipments/${P.elsewhere.id}/own-transport/tracking`, { version: await shipmentVersion(P.elsewhere.id), ...body })
    const portalRow = async (): Promise<Json> => ((await ok(buyerA, 'GET', `/portal/sales-orders/${P.so2}/shipments`)).shipments as Json[]).find((row) => row.number === P.elsewhere.number)!
    // A person limited to Beta types nothing on it (as unknown).
    await asBeta('PUT', `/shipping/shipments/${P.elsewhere.id}/own-transport/tracking`, { version: await shipmentVersion(P.elsewhere.id), trackingNumber: TRACKING[0] }, 404)

    await put({ trackingNumber: TRACKING[0], trackingUrl: LINKS[0] })
    await settle()
    // ONE office-only line on the order's thread (B-OP-030), never the customer's.
    const office = await systemLinesOn(P.so2, TRACKING[0])
    expect(office).toHaveLength(1)
    expect(office[0]).toMatchObject({ audience: 'OFFICE', direction: 'INTERNAL_NOTE' })
    // The customer's own shipment and "On the way" carry the number and its link (no live tracking: the carrier was booked by hand).
    expect(await portalRow()).toMatchObject({ typedTrackingNumber: TRACKING[0], typedTrackingUrl: LINKS[0] })
    const transit = await ok(buyerA, 'GET', '/portal/sales-orders/in-transit')
    expect((transit.items as Json[]).find((row) => row.number === P.elsewhere.number)).toMatchObject({ typedTrackingNumber: TRACKING[0], typedTrackingUrl: LINKS[0] })
    // The tracking page of a link made for it (not mailed here).
    const made = await ok(wanda, 'POST', `/shipping/shipments/${P.elsewhere.id}/tracking-links`, { send: false }, 201)
    const token = tokenOf(made.url as string)
    expect((await trackingPage(token)).shipment).toMatchObject({ number: P.elsewhere.number, typedTrackingNumber: TRACKING[0], typedTrackingUrl: LINKS[0] })

    // Corrected: the new number and link everywhere, one more office line.
    await put({ trackingNumber: TRACKING[1], trackingUrl: LINKS[1] })
    await settle()
    expect(await systemLinesOn(P.so2, TRACKING[1])).toHaveLength(1)
    expect(await portalRow()).toMatchObject({ typedTrackingNumber: TRACKING[1], typedTrackingUrl: LINKS[1] })
    expect((await trackingPage(token)).shipment).toMatchObject({ typedTrackingNumber: TRACKING[1], typedTrackingUrl: LINKS[1] })
    // Cleared: the number and its link go together.
    await put({ trackingNumber: null })
    await settle()
    expect(await portalRow()).toMatchObject({ typedTrackingNumber: null, typedTrackingUrl: null })
    expect((await trackingPage(token)).shipment).toMatchObject({ typedTrackingNumber: null, typedTrackingUrl: null })
    await pageWall('O5')
  })

  it('O6 its invoice names the paper DDT: the shipment waits in “shipped, not invoiced”; the draft’s DDT reference (B-OP-033)', async () => {
    const queue = await ok(olga, 'GET', '/invoicing/shipped-not-invoiced')
    const row = (queue.customers as Json[]).flatMap((customer) => (customer.shipments ?? []) as Json[]).find((entry) => entry.shipmentId === P.elsewhere.id)
    expect(row).toMatchObject({ number: P.elsewhere.number, paperDdt: { number: PAPER_DDT } })
    const drafted = (await ok(olga, 'POST', '/invoicing/invoices/from-shipment', { shipmentId: P.elsewhere.id }, 201)).invoice as Json
    // TD24 when Alpha's terms defer its invoices, else TD01: by the order's terms, never chosen here.
    expect(['TD01', 'TD24']).toContain(drafted.docType)
    expect(drafted.documentRefs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'DDT', number: PAPER_DDT })]))
    P.invoiceId = drafted.id as string
    await asBeta('POST', '/invoicing/invoices/from-shipment', { shipmentId: P.elsewhere.id }, 404)
    await settle()
    await pageWall('O6')
  })

  it('O8 several orders on one shipment (B-OP-047): one shipment for two of Alpha’s orders, through the API — on both orders’ reads, one DDT reference per order, its freight once', async () => {
    // Both orders on one new DRAFT (the first = its order); another customer's order is never offered.
    const made = (await ok(wanda, 'POST', '/shipping/shipments', { salesOrderId: P.so2, salesOrderIds: [P.so2, P.so3], siteId: P.siteA1 }, 201)).shipment as Json
    P.shared = { id: made.id as string, number: made.number as string }
    // SEED-SO-0002's black 52 comes off SEED-SH-0004 (a DRAFT's lines change) onto it, with SEED-SO-0003's free jacket.
    await ok(wanda, 'DELETE', `/shipping/shipments/${P.sh4}/lines/${P.sh4Line}?version=${await shipmentVersion(P.sh4)}`)
    await ok(wanda, 'POST', `/shipping/shipments/${P.shared.id}/lines`, { version: await shipmentVersion(P.shared.id), lines: [{ workOrderSizeId: P.sh4Cell, quantity: 1 }, { workOrderSizeId: P.jacket, quantity: 1 }] })
    const candidates = await ok(wanda, 'GET', `/shipping/shipments/${P.shared.id}/orders/candidates`)
    const betaOrders = (await admin<{ id: string }>('SELECT id::text AS id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2', [T(), world.ids.b])).map((row) => row.id)
    for (const id of betaOrders) expect(JSON.stringify(candidates)).not.toContain(id)
    // B-OP-047: no order is held by the old hold any more (each verdict is its real reasons, or none).
    expect(JSON.stringify(candidates)).not.toContain('MULTI_ORDER_OFF')
    const changed = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'shipment.orders_changed' AND subject = $2 ORDER BY "occurredAt", id`, [T(), P.shared.id])
    expect(changed.at(-1)!.payload.salesOrderIds).toEqual([P.so2, P.so3])

    // On both orders' reads, with every order it carries, the first first.
    for (const orderId of [P.so2, P.so3]) {
      const { order } = await ok(olga, 'GET', `/sales/orders/${orderId}`)
      expect(((order.chain.shipments as Json[]).find((row) => row.id === P.shared.id)!.orders as Json[]).map((ref) => ref.id), orderId).toEqual([P.so2, P.so3])
    }
    // Its DDT names one order reference per order (B-OP-042), each line under its order.
    const ddt = await ok(wanda, 'POST', `/shipping/shipments/${P.shared.id}/ddt/preview`, {})
    expect((ddt.draft.documentRefs as Json[]).filter((ref) => ref.kind === 'SALES_ORDER').map((ref) => ref.number)).toEqual([await numberOfOrder(P.so2), await numberOfOrder(P.so3)])
    // Its freight once, on the shipment; each order carries its share in its margin, the two shares the one freight.
    await ok(olga, 'PUT', `/shipping/shipments/${P.shared.id}/freight`, { version: await shipmentVersion(P.shared.id), freightCharge: 1500 })
    const shares: number[] = []
    for (const orderId of [P.so2, P.so3]) {
      const margins = await ok(olga, 'GET', `/costing/margins/orders/${orderId}/documents`)
      shares.push(((margins.freight.rows as Json[]).find((row) => row.shipment.id === P.shared.id)!.charge as number) ?? 0)
    }
    expect(shares.every((share) => share > 0)).toBe(true)
    expect(Math.abs(shares[0]! + shares[1]! - 1500)).toBeLessThanOrEqual(1)
    await settle()
    await pageWall('O8')
  })

  it('OW the wall at the end: nothing Beta’s people got names Alpha; Alpha’s buyer never reads the Owner’s, Finance’s or the warehouse’s names', async () => {
    const markers = await alphaMarkers()
    expect(leaksIn(seen.B, markers)).toEqual([])
    await liveWall('OW')
    const people: Marker[] = (await admin<{ id: string; email: string; name: string }>('SELECT id::text AS id, email, "displayName" AS name FROM "User" WHERE id = ANY($1::uuid[])', [[olga.id, fina.id, wanda.id, carla.id]])).flatMap((row) => [
      { label: 'office person id', text: row.id },
      { label: 'office person address', text: row.email },
      { label: 'office person name', text: row.name },
    ])
    const theirs = seen.A.slice(P.seenA)
    expect(theirs.length).toBeGreaterThan(0)
    expect(leaksIn(theirs, people)).toEqual([])
  })

  it('OZ no route answered 500 and no handler failed during the order page’s flow', async () => {
    await settle()
    expect(unexpected.slice(P.unexpected).map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(worker.retried).toEqual([])
  })
})
// ── end B-OP-071 ──
