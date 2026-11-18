import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { SUPERVISOR_REFUSAL_WORDS } from '@nexus/factory-domain/production-brand/words'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCalendar } from '../../../../../packages/factory-db/seed/calendar'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { routesFiles } from '../../core/autoload'
import { callerFor } from '../../core/command'
import { testAuthenticator } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { gateHandlers } from '../../modules/planning/milestones/follow'
import { brandKeeperHandler, keepOrder } from '../../modules/production/brand/keeper'
import { issueAnsweredHandler } from '../../modules/production/issues/answered'
import { issueClockOf, runIssueEscalation } from '../../modules/production/issues/escalate'
import { supervisorFollowsHandler } from '../../modules/production/supervisor/follows'
import { findMarkers, markersOf, twoBrandSessions, type Marker, type OfficeSession } from '../../modules/production/testing/two-brands'
import { urgencyWorld, type UrgencyWorld } from '../../modules/production/testing/urgency-world'
import { createWallSweep, type Finding } from '../../modules/production/testing/wall-sweep'
import { madeUpPdf } from '../../modules/shipping/documents/testing/compliance'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { freshGuard } from '../../platform/auth/portal/testing/portal'
import type { Answer } from '../../platform/auth/sessions/testing/harness'
import { createEmailRuntime, useEmail } from '../../platform/email-out/service'
import { storeGeneratedFile } from '../../platform/files/files'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import type { Gateway } from '../../platform/gateway/gateway'
import { useGateway } from '../../platform/gateway/service'
import { notificationsHandler } from '../../platform/notifications/fan-out'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { systemContext } from '../../platform/outbox/system'
import { partnerNotificationsHandler } from '../../platform/portal/notifications/fan-out'
import { drain, type World } from '../testing/world'

/**
 * B-PR-36 — GOLDEN FLOW PRODUCTION: TWO CUSTOMERS IN PRODUCTION (production plan §2 "Proof: … a golden flow with 2 brands", §3, §4,
 * Appendix F "B-PR-36 golden flow adds urgency, supervisor, note to N, brand bulk, escalation"; wall tests PW-00 … PW-18 end to end;
 * the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well.").
 *
 * The world (../../modules/production/testing/urgency-world.ts): the seeds up to shipping, the calendars, the production two-brand
 * harness — customer A = the seeds' P1 (SEED-SO-0002 and its harness order Urgent 1st and 2nd, quota 3), customer B = the threads'
 * second brand (SEED-SO-B001 set back to Regular and locked by us) — both portals on, urgency on. A's buyer and A's Production
 * person, B's Production person, signed in by code; the office people with two-factor: the owner, an admin, a planner, A's supervisor
 * (a production manager limited to A), A's backup (a production manager of every customer), the supervisor of one order (a production
 * manager limited to A); `office.p2` is every office permission limited to B. The worker's handlers the flow needs run in-process
 * (`settle`: the real relay over the gates, the keeper, the supervisor's follows, the issue answered, the office bell and the
 * customer's notices); the escalation cron's body and the keeper's nightly look are called directly — the scheduler never starts.
 *
 *   S    the limits: a production manager opens Gates & dates + Quality and the pause and resume asks for A (step-up)
 *   S1   A's supervisor and backup, another supervisor on one order: who follow the orders' and work orders' threads and are told;
 *        an ineligible person refused in words; a person limited to B reaches no pick list of A (PW-14)
 *   U1   A frees a place, marks two orders Urgent and drags its list; a third over the quota is "Urgent – asked" and accepted as
 *        urgent ("4 of 3 · 1 agreed with us"); B's backlog places, its rows and the office levers do not move; A's own marks tell
 *        A and B nothing; the supervisor is told (PW-11, PW-18, B-PR-32)
 *   U2   we set one back to Regular and lock it (step-up): A reads "Set to Regular by us: …", "Changed by us", is refused in those
 *        words, and is told; a planner may not
 *   N    a note to 3 records asking the supervisor (checked first), then one needing an answer: a task for the order's supervisor
 *        (PW-13)
 *   E    no answer: at raise + 1 working day (08:00 company time, the cron's clock) the backup, at raise + 2 the Owner and Admin —
 *        never a person limited to B (PW-17)
 *   M    A approves 2 and pauses 3 as one batch; the office sees one group and accepts it as one: three customer pauses (PW-12)
 *   Z1   A downloads the files zip of two orders: its Buyer gets the order confirmation, its Production person not (PW-12)
 *   H    A asks to resume one paused order; accepted, the pause is lifted (B-PR-27a)
 *   P    A reports a problem on two orders: ONE task; one office reply answers both; the other reads "Answered in <order>"
 *        (portal) and "answered in your order N" (bell) (B-PR-45, PW-15)
 *   G    a PP and a size-set approval: A approves the PP itself; we decide the size set for A, put it back once (refused twice),
 *        ask again (B-PR-30a/30b, B-PR-40)
 *   K    the stage and at-risk news: cutting starts on A's order (A told "Cutting"); the PP approval can no longer be put back; an
 *        order raised to At risk (A told, never our note) (B-PR-31)
 *   W    the wall: B's people and an office person limited to B see nothing of A by any door; the production unit sees every
 *        customer (the overview); A is never told who its supervisor is — the reply in its thread signs with its writer's name
 *   Z    no route answered 500 and no handler failed during the flow
 *   X    the B-PR-10 sweep again, on this world at the end (../../modules/production/testing/wall-sweep.ts): every route that reads
 *        a work order, reads and writes, as B with A's ids
 *
 * SQL reads ids and asserts. Three acts are not made through a route, each named where it is done: the world's set-up (back-dated
 * role assignments, as the PG tests do), the files the office shares (the platform's own store call) and the cutting floor's first
 * bundle (a copy of the seed's bundle: cutting itself is the floor's flow, not this one). Every name, address and number is made up.
 * Run with `node scripts/factory/golden-flow.mjs production` (long: alone, nice, one worker).
 */

let world: UrgencyWorld
const NS = 'pr36-golden-production'
type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
type Person = Office | Portal
type SessionName = 'office.all' | 'office.p1' | 'office.p2'

const LONG = 600_000
const SWEEP_TIMEOUT = 1_800_000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// The flow's own words of A's: none may ever reach B.
const LOCK_REASON = 'Made-up Alpha lock: we wait for the fabric of this order first.'
const NOTE_BODY = 'Made-up Alpha note: please check the lining shade before the cut.'
const ANSWER_NOTE = 'Made-up Alpha question: can the collar change still go in this week?'
const PAUSE_REASON = 'Made-up Alpha pause: our store opening moved by two weeks.'
const PROBLEM_BODY = 'Made-up Alpha problem: the zip colour on the jackets looks wrong.'
const REPLY_BODY = 'Made-up Alpha reply: we checked it, the zip colour is right on the bulk.'
const HEALTH_NOTE = 'Made-up Alpha raise: the lining ships late (office only).'
const DECIDE_REASON = 'Made-up Alpha decision: their buyer approved the size set on the phone.'
const PUT_BACK = 'Made-up Alpha put back: the size set photos were of another sample.'
const PUT_BACK_PP = 'Made-up Alpha put back: the PP sample photos were of another jacket.'
const CARE_NOTES = 'Made-up Alpha care notes.pdf'
const FLOW_WORDS = [LOCK_REASON, NOTE_BODY, ANSWER_NOTE, PAUSE_REASON, PROBLEM_BODY, REPLY_BODY, HEALTH_NOTE, DECIDE_REASON, PUT_BACK, PUT_BACK_PP, CARE_NOTES]

let owner: Office
let adminPerson: Office
let planner: Office
/** A's supervisor (its default), limited to A. */
let supervisor: Office
/** A's backup: a production manager of every customer (he also sets the limits and decides for the customer). */
let backup: Office
/** The supervisor of one order of A, limited to A. */
let orderSupervisor: Office
let buyerA: Portal
let productionA: Portal
let productionB: Portal

/** A's orders of the flow (the world's addOrder: CONFIRMED, one goods line of the harness jacket, its production state). */
const A = {} as Record<'u1' | 'u2' | 'u3' | 'n1' | 'p1' | 'p2' | 'p3' | 'q1' | 'q2' | 'g1', { readonly orderId: string; readonly number: string; readonly lineId: string }>
const B = {} as Record<'b1' | 'b2', { readonly orderId: string; readonly number: string; readonly lineId: string }>
/** The work orders of A's paused orders (made by the planner through the real route). */
const WO = {} as Record<'p1' | 'p2' | 'p3', { readonly id: string; readonly number: string }>
/** What later steps read of earlier ones. */
const G = {} as {
  holdBatch: string
  artwork: string[]
  ppRequest: string
  sizeSetRequest: string
  problemTask: string
}

interface Seen {
  readonly who: string
  readonly url: string
  readonly status: number
  readonly body: unknown
  /** The ids the request itself named (left out of the scan: a person may send any id). */
  readonly asked: readonly string[]
}
/** Every answer A's people got (the supervisor's name must never be in one) and B's people and `office.p2` got (nothing of A's). */
const seenByA: Seen[] = []
const seenByB: Seen[] = []
const sides = new Map<Person, 'A' | 'B'>()
const unexpected: ErrorReport[] = []

const T = () => world.ids.tenantId
const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(world.h.database, systemContext(T(), `pr36-${newId()}`))
const idsIn = (text: string): string[] => [...new Set((text.match(UUID) ?? []).map((id) => id.toLowerCase()))]
const pathOf = (body: Json): string => String(body.error?.issues?.at(-1)?.path ?? '')
/** The display name a harness user gets from its address (platform/auth/sessions/testing/harness addUser). */
const nameOf = (email: string): string => email.split('@')[0]!.replace(/\./g, ' ')

// ---- calls ---------------------------------------------------------------------------------------------------------------------

/** A person's call through its own browser (cookies, CSRF, a fresh Idempotency-Key on a write); A's and B's answers are kept. */
async function call(person: Person, method: Method, url: string, body?: unknown): Promise<{ status: number; body: Json; answer: Answer }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send(method, url, body ?? {}, { headers: { 'idempotency-key': `pr36-${newId()}` } })
  const side = sides.get(person)
  const parsed = typeof answer.body === 'object' && answer.body !== null ? (answer.body as Json) : {}
  if (side) (side === 'A' ? seenByA : seenByB).push({ who: `${side} portal`, url, status: answer.status, body: typeof answer.body === 'string' ? '' : answer.body, asked: idsIn(`${url} ${JSON.stringify(body ?? null)}`) })
  return { status: answer.status, body: parsed, answer }
}
async function ok(person: Person, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 800)}`).toBe(status)
  return answer.body
}
/** An office person's write after a fresh step-up (overrides, the limits card). */
async function stepped(person: Office, method: Method, url: string, body: unknown, status = 200): Promise<Json> {
  await person.stepUp()
  return ok(person, method, url, body, status)
}
/** A call as an office test session (`office.p2`: every office permission, limited to B — its answers are kept for the scan). */
async function session(name: SessionName, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const response = await world.officeApp.inject({ method, url, headers: { 'x-test-session': name, ...(method === 'GET' ? {} : { 'idempotency-key': `pr36-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  let parsed: Json = {}
  try {
    parsed = response.json() as Json
  } catch {
    parsed = {}
  }
  if (name === 'office.p2') seenByB.push({ who: 'office.p2', url, status: response.statusCode, body: parsed, asked: idsIn(`${url} ${JSON.stringify(body ?? null)}`) })
  expect(response.statusCode, `${name} ${method} ${url}: ${response.body.slice(0, 800)}`).toBe(status)
  return parsed
}

// ---- the worker, in-process ----------------------------------------------------------------------------------------------------

/** The handlers this flow's events reach (background.ts runs them in the worker): gates, keeper, follows, answered, both bells. */
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
  readonly params: Json
  readonly actorId: string | null
  readonly groupKey: string | null
}
const NOTICE_COLUMNS = `id::text AS id, "partyId"::text AS "partyId", "eventType", "recordType", "recordId"::text AS "recordId", "recordLabel", "messageKey", params, "actorId"::text AS "actorId", "groupKey"`
const noticesOf = (userId: string) => admin<Notice>(`SELECT ${NOTICE_COLUMNS} FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id`, [userId])
const looked = new Map<string, number>()
/** The notices a customer's person got since the last look. */
async function fresh(person: Portal): Promise<Notice[]> {
  const all = await noticesOf(person.id)
  const from = looked.get(person.id) ?? 0
  looked.set(person.id, all.length)
  return all.slice(from)
}
const shortOf = (notice: Notice) => ({ messageKey: notice.messageKey, recordId: notice.recordId })
/** The office bell of a person, through the route. */
const bellOf = async (person: Office): Promise<Json[]> => (await ok(person, 'GET', '/notifications?limit=100')).items as Json[]
const keysOf = (items: readonly Json[]): string[] => items.map((item) => String(item.messageKey))

/** A's production list as A's buyer reads it, and one row of it. */
const listOfA = () => ok(buyerA, 'GET', '/portal/production')
const rowIn = (list: Json, orderId: string): Json => {
  const row = (list.items as Json[]).find((item) => item.id === orderId)
  expect(row, `order ${orderId} in the customer's list`).toBeDefined()
  return row!
}
const settingsVersion = async (partyId: string): Promise<number> => (await admin<{ version: number }>('SELECT version FROM "PortalSettings" WHERE "partyId" = $1', [partyId]))[0]?.version ?? 0
const followOf = (recordType: string, recordId: string, userId: string) =>
  admin<{ reason: string; muted: boolean }>('SELECT reason::text AS reason, muted FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3 AND "userId" = $4', [T(), recordType, recordId, userId]).then((rows) => rows[0] ?? null)
const outbox = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T(), type])
const holdsOf = (workOrderIds: readonly string[]) =>
  admin<{ workOrderId: string; kind: string; status: string; reasonCode: string; requestId: string | null; partyId: string | null; liftReason: string | null }>(
    'SELECT "workOrderId"::text AS "workOrderId", kind::text AS kind, status::text AS status, "reasonCode", "requestId"::text AS "requestId", "partyId"::text AS "partyId", "liftReason" FROM "WorkOrderHold" WHERE "workOrderId" = ANY($1::uuid[]) ORDER BY "placedAt", id',
    [[...workOrderIds]],
  )
const workOrderStatus = async (id: string): Promise<string> => (await one<{ status: string }>('SELECT status::text AS status FROM "WorkOrder" WHERE id = $1', [id])).status
const requestVersion = async (id: string): Promise<number> => (await one<{ version: number }>('SELECT version FROM "ApprovalRequest" WHERE id = $1', [id])).version

/** B's whole side as it stands: its production rows, its orders' office levers, its work orders and the mixed one's (PW-18). */
const brandBSide = async () => ({
  production: await admin('SELECT id::text AS id, urgency::text AS urgency, "urgentRank", "urgencyBatchId"::text AS "batchId", version FROM "BrandOrderProduction" WHERE "partyId" = $1 ORDER BY id', [world.ids.b]),
  orders: await admin('SELECT id::text AS id, priority, "priorityLevel"::text AS "priorityLevel", "backlogRank", version FROM "SalesOrder" WHERE "partyId" = $1 ORDER BY id', [world.ids.b]),
  workOrders: await admin('SELECT id::text AS id, priority, rush, status::text AS status, version FROM "WorkOrder" WHERE "partyId" = $1 OR id = $2 ORDER BY id', [world.ids.b, world.w.mixed.workOrderId]),
})
/** The office's own levers of A's orders: a customer's mark never writes them (L17). */
const leversOfA = () => admin('SELECT id::text AS id, priority, "priorityLevel"::text AS "priorityLevel", "backlogRank" FROM "SalesOrder" WHERE "partyId" = $1 ORDER BY id', [world.ids.a])
const placesOf = (backlog: Json, ids: readonly string[]): (number | null)[] => ids.map((orderId) => ((backlog.orders as Json[]).find((order) => order.id === orderId)?.position as number | undefined) ?? null)

/** The entries of a zip (its central directory), each inflated (modules/production/brand-portal/approve-zip.pg's reader). */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let end = bytes.length - 22
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) return out
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)
  for (let n = 0; n < count; n++) {
    const method = bytes.readUInt16LE(at + 10)
    const size = bytes.readUInt32LE(at + 20)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extra = bytes.readUInt16LE(at + 30)
    const comment = bytes.readUInt16LE(at + 32)
    const local = bytes.readUInt32LE(at + 42)
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(dataAt, dataAt + size)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    at += 46 + nameLength + extra + comment
  }
  return out
}
async function zipOf(person: Portal, orderIds: readonly string[]): Promise<string[]> {
  const { status, answer } = await call(person, 'POST', '/portal/production/files/zip', { orderIds })
  expect(status, `zip: ${answer.response.body.slice(0, 600)}`).toBe(200)
  expect(answer.response.headers['content-type']).toContain('application/zip')
  return [...unzip(answer.response.rawPayload).keys()]
}

/** A made-up picture: the PNG signature, then words (the office's photo with its question). */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('made-up picture of the production golden flow')])
/** A photo the office sends with its question: the platform's own store (an upload's end). */
async function photoOf(recordType: string, recordId: string): Promise<string> {
  return (await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType, recordId, kind: 'PHOTO', originalName: `Made-up ${recordType} photo.png`, contentType: 'image/png', body: PNG })).id
}
/** The owner asks customer A to approve a record (its photo with it, no mail): the request. */
async function askApproval(kind: string, recordType: string, recordId: string): Promise<Json> {
  return (await ok(owner, 'POST', '/approvals-out', { kind, recordType, recordId, question: `Made-up: please approve this ${kind.toLowerCase()}.`, fileIds: [await photoOf(recordType, recordId)], send: false }, 201)).request as Json
}
/** A DRAFT work order of an order's goods line, by the planner through the real route. */
async function workOrderOf(lineId: string): Promise<{ id: string; number: string }> {
  const made = await ok(planner, 'POST', '/production/work-orders', { siteId: world.w.siteId, lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] }, 201)
  return { id: made.workOrder.id as string, number: made.workOrder.number as string }
}

const log = { info() {}, warn() {}, error() {} }
const clockAt = (at: Date) => ({ now: () => new Date(at.getTime()) })

// ---- the end: the B-PR-10 sweep's own app (every routes file, the route spy first) --------------------------------------------

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const SCHEMA_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/prisma/schema', import.meta.url))
/** Every permission an office role can hold, money grains included (the sweep reads every field there is). */
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name)
let sweepSessions: Record<string, OfficeSession> = {}
let sweeper: ReturnType<typeof createWallSweep> | undefined
let sweepApp: FastifyInstance | undefined
let sweepFiles: string | undefined

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  world = await urgencyWorld('pr36_golden_prod', NS)
  await seedCalendar({ db: world.h.database, namespace: NS })
  worker = { h: world.h, tenant: world.tenant, retried: [] as string[] } as unknown as World
  handlers = [...gateHandlers(), brandKeeperHandler(), supervisorFollowsHandler(), issueAnsweredHandler(), notificationsHandler(), partnerNotificationsHandler({ cookieSecret: () => LOCAL_COOKIE_SECRET, clock: world.h.clock })]

  owner = await world.officePerson('oriana.owner@pr36-office.example.com', 'owner')
  adminPerson = await world.officePerson('adele.admin@pr36-office.example.com', 'admin')
  planner = await world.officePerson('pietro.planner@pr36-office.example.com', 'planner')
  supervisor = await world.officePerson('sofia.supervisor@pr36-office.example.com', 'production_manager', [world.ids.a])
  backup = await world.officePerson('bruno.backup@pr36-office.example.com', 'production_manager')
  orderSupervisor = await world.officePerson('olga.order@pr36-office.example.com', 'production_manager', [world.ids.a])
  buyerA = await world.portalPerson('alba.buyer@pr36-brand-alpha.example.com', world.ids.a, ['customer-buyer', 'customer-production', 'partner-approve'])
  productionA = await world.portalPerson('paolo.production@pr36-brand-alpha.example.com', world.ids.a, ['customer-production'])
  productionB = await world.portalPerson('bianca.production@pr36-brand-beta.example.com', world.ids.b, ['customer-production', 'partner-approve'])
  for (const person of [buyerA, productionA]) sides.set(person, 'A')
  sides.set(productionB, 'B')
  // World set-up (as the PG tests do): the portal and the office read roles on the harness clock (each sign-in moves it on), the
  // worker's handlers on the server clock — every person of the flow is a holder of their roles to both.
  const people = [owner, adminPerson, planner, supervisor, backup, orderSupervisor, buyerA, productionA, productionB].map((person) => person.id)
  await world.replica([{ sql: `UPDATE "RoleAssignment" SET "validFrom" = now() - interval '1 day' WHERE "userId" = ANY($1::uuid[])`, values: [people] }])

  for (const name of ['u1', 'u2', 'u3', 'n1', 'p1', 'p2', 'p3', 'q1', 'q2', 'g1'] as const) A[name] = await world.addOrder(world.ids.a, `PR36-${name.toUpperCase()}`, '2026-10-01')
  for (const name of ['b1', 'b2'] as const) B[name] = await world.addOrder(world.ids.b, `PR36-${name.toUpperCase()}`, '2026-10-02')
  // What the set-up wrote is the worker's first job; what it tells nobody is this flow's news.
  await settle()
  for (const person of [buyerA, productionA, productionB]) await fresh(person)
}, LONG)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  useErrorTracker(undefined)
  await sweepApp?.close()
  useFiles(undefined)
  useGateway(undefined)
  useEmail(undefined)
  if (sweepFiles) rmSync(sweepFiles, { recursive: true, force: true })
  await world?.close()
}, 120_000)

describe('B-PR-36 golden flow production: two customers', { timeout: LONG }, () => {
  it('S the limits: a production manager opens Gates & dates + Quality and the pause and resume asks for customer A (step-up)', async () => {
    const card = await ok(backup, 'GET', `/partners/${world.ids.a}/production`)
    expect(card.mayManage).toBe(true)
    const changed = await stepped(backup, 'PUT', `/partners/${world.ids.a}/production`, { productionLevel: 'QUALITY', productionAskKinds: ['HOLD', 'RESUME'], version: card.production.version })
    expect(changed.production).toMatchObject({ level: 'QUALITY', askKinds: ['HOLD', 'RESUME'], urgency: { on: true, max: 3 } })
    expect(changed.production.openAsks).toEqual(expect.arrayContaining(['RUSH', 'HOLD', 'RESUME']))
    // The production unit manages every customer; a person limited to B never reaches A's card.
    await session('office.p2', 'GET', `/partners/${world.ids.a}/production`, undefined, 404)
  })

  it('S1 A’s supervisor and backup, another supervisor on one order: they follow the threads and are told; refused in words; B reaches no pick list of A (PW-14)', async () => {
    const pick = await ok(planner, 'GET', `/production/supervisors?partyId=${world.ids.a}`)
    const picked = (pick.people as Json[]).map((person) => person.id as string)
    expect(picked).toEqual(expect.arrayContaining([supervisor.id, backup.id, orderSupervisor.id]))
    // The planner cannot open measurement sheets: neither on the list nor named (refused in words).
    expect(picked).not.toContain(planner.id)
    const url = `/production/brands/${world.ids.a}/supervisor`
    const refused = await call(planner, 'PUT', url, { supervisorId: planner.id, backupId: null, version: await settingsVersion(world.ids.a) })
    expect(refused.status).toBe(400)
    expect((refused.body.error.issues as Json[]).map((issue) => issue.message)).toContain(SUPERVISOR_REFUSAL_WORDS.NO_MEASUREMENTS.en)
    // PW-14: a person limited to B reaches no pick list and no supervisor of A.
    expect((await session('office.p2', 'GET', `/production/supervisors?partyId=${world.ids.a}`, undefined, 404)).error.message).toBe('Customer not found.')

    const { customer } = await ok(planner, 'PUT', url, { supervisorId: supervisor.id, backupId: backup.id, version: await settingsVersion(world.ids.a) })
    expect(customer).toMatchObject({ partyId: world.ids.a, supervisor: { id: supervisor.id, active: true }, backup: { id: backup.id, active: true } })
    const many = await ok(planner, 'POST', '/production/orders/supervisor', { orderIds: [A.n1.orderId], supervisorId: orderSupervisor.id })
    expect((many.changed as Json[]).map((row) => row.orderId)).toEqual([A.n1.orderId])
    expect((await outbox('brand_production.supervisor_changed')).map((row) => [row.payload.partyId, row.payload.scope])).toEqual([
      [world.ids.a, 'BRAND'],
      [world.ids.a, 'ORDER'],
    ])
    // A work order's supervisor is its order's (here the customer's default).
    expect((await ok(planner, 'GET', `/production/work-orders/${world.w.a.workOrderId}`)).workOrder.supervisor).toMatchObject({ id: supervisor.id, from: 'BRAND' })

    await settle()
    // They follow (reason ASSIGNEE): the customer's supervisor its orders and their work orders, the order's own supervisor that
    // order — no longer the customer's supervisor there.
    expect(await followOf('SalesOrder', world.w.a.salesOrderId, supervisor.id)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('WorkOrder', world.w.a.workOrderId, supervisor.id)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect(await followOf('SalesOrder', A.n1.orderId, orderSupervisor.id)).toEqual({ reason: 'ASSIGNEE', muted: false })
    expect((await followOf('SalesOrder', A.n1.orderId, supervisor.id))?.reason ?? null).not.toBe('ASSIGNEE')
    // And are told, in their bell.
    expect(keysOf(await bellOf(supervisor))).toContain('notifications.production.supervisorOfOrders')
    expect(keysOf(await bellOf(backup))).toContain('notifications.production.backupOfCustomer')
    expect(keysOf(await bellOf(orderSupervisor))).toContain('notifications.production.supervisorOfOrder')
  })

  it('U1 urgency: A frees a place, marks two orders Urgent, drags its list; a third over the quota is "Urgent – asked", accepted as urgent; B’s places never move (PW-11, PW-18)', async () => {
    await settle()
    const bBefore = await brandBSide()
    const leversBefore = await leversOfA()
    const backlogBefore = await session('office.all', 'GET', `/planning/backlog?companyId=${world.w.companyId}`)
    const beta = [B.b1.orderId, B.b2.orderId, world.w.b.salesOrderId]
    const betaPlaces = placesOf(backlogBefore, beta)
    expect(betaPlaces.some((place) => place !== null), "B's orders are in the backlog").toBe(true)
    const [so2] = world.w.production.urgent

    // Back to Regular is always free: one place of A's three is free again.
    const freed = await ok(buyerA, 'POST', '/portal/production/urgency', { orderIds: [world.w.a.salesOrderId], urgency: 'REGULAR' })
    expect(freed.results.map((row: Json) => [row.orderId, row.outcome, row.done])).toEqual([[world.w.a.salesOrderId, 'DONE', true]])
    // Two orders Urgent inside the quota: at once.
    const marked = await ok(buyerA, 'POST', '/portal/production/urgency', { orderIds: [A.u1.orderId, A.u2.orderId], urgency: 'URGENT' })
    expect(marked.results.map((row: Json) => [row.orderId, row.outcome, row.done, row.urgentRank])).toEqual([
      [A.u1.orderId, 'DONE', true, 2],
      [A.u2.orderId, 'DONE', true, 3],
    ])
    expect(marked.use).toMatchObject({ used: 3, max: 3, agreed: 0, left: 0, over: false, words: { en: '3 of 3 urgent used' } })
    // The drag: only inside its own Urgent list, every urgent order named.
    const dragged = await ok(buyerA, 'PUT', '/portal/production/urgent-order', { orderIds: [so2, A.u2.orderId, A.u1.orderId] })
    expect(dragged.results.map((row: Json) => [row.orderId, row.urgentRank])).toEqual([
      [so2, 1],
      [A.u2.orderId, 2],
      [A.u1.orderId, 3],
    ])
    // A customer's mark never writes the office's priority, level or rank.
    expect(await leversOfA()).toEqual(leversBefore)
    // A third over the quota: "Urgent – asked", a request we answer.
    const over = await ok(buyerA, 'POST', '/portal/production/urgency', { orderIds: [A.u3.orderId], urgency: 'URGENT' })
    expect(over.results[0]).toMatchObject({ orderId: A.u3.orderId, outcome: 'ASK_OVER_QUOTA', done: false, words: { en: 'You have used your 3 urgent marks: sent to us as "Urgent – asked": we answer you.' } })
    const rush = over.results[0].asked.requestId as string
    expect(typeof over.askBatchId).toBe('string')
    expect(await one('SELECT kind::text AS kind, status::text AS status, "partyId"::text AS "partyId" FROM "OrderChangeRequest" WHERE id = $1', [rush])).toEqual({ kind: 'RUSH', status: 'OPEN', partyId: world.ids.a })
    expect(rowIn(await listOfA(), A.u3.orderId).urgency).toMatchObject({ asked: true, askedWords: { en: 'Urgent – asked' } })
    // The planner accepts it as urgent (not "and rush the floor").
    const accepted = await ok(planner, 'POST', `/production/brand-requests/${rush}/accept`, { version: 1, answer: 'Made-up: agreed, we move it up.' })
    expect(accepted.request).toMatchObject({ kind: 'RUSH', status: 'ACCEPTED' })
    expect(accepted.done.urgency).toMatchObject({ urgency: 'URGENT', urgentRank: 4, use: { used: 4, max: 3, agreed: 1, over: true, words: { en: '4 of 3 · 1 agreed with us' } } })

    // A reads its own list only: "4 of 3 · 1 agreed with us", its order; "Changed by us" (never who) on ours.
    const list = await listOfA()
    expect(list.urgentUse.words.en).toBe('4 of 3 · 1 agreed with us')
    expect([so2, A.u2.orderId, A.u1.orderId, A.u3.orderId].map((orderId) => rowIn(list, orderId).urgency?.urgentRank ?? null)).toEqual([1, 2, 3, 4])
    expect(rowIn(list, A.u3.orderId).urgency).toMatchObject({ code: 'URGENT', asked: false, byUs: true, byUsWords: { en: 'Changed by us' } })
    expect(rowIn(list, world.w.a.salesOrderId).urgency).toMatchObject({ code: 'REGULAR', urgentRank: null })

    await settle()
    // PW-18: B's places in our backlog, its rows and its office levers are exactly as before; A's urgent orders take A's own places.
    expect(await brandBSide()).toEqual(bBefore)
    const backlogAfter = await session('office.all', 'GET', `/planning/backlog?companyId=${world.w.companyId}`)
    expect(placesOf(backlogAfter, beta)).toEqual(betaPlaces)
    expect(((backlogAfter.orders as Json[]).find((order) => order.id === A.u2.orderId)?.customerUrgency as Json | null | undefined)?.urgentRank).toBe(2)
    for (const orderId of beta) expect((backlogAfter.orders as Json[]).find((order) => order.id === orderId)?.customerUrgency ?? null, orderId).toBeNull()
    // Every urgency event names A only; A's own marks tell nobody (not A, not B).
    for (const row of await outbox('brand_production.urgency_changed')) expect(row.payload.partyId === world.ids.a || row.payload.partyId === world.ids.b).toBe(true)
    expect((await outbox('brand_production.urgency_changed')).filter((row) => (row.payload.orderIds as string[]).some((id) => [A.u1.orderId, A.u2.orderId, A.u3.orderId].includes(id))).every((row) => row.payload.partyId === world.ids.a)).toBe(true)
    expect((await fresh(buyerA)).filter((notice) => notice.eventType === 'brand_production.urgency_changed')).toEqual([])
    expect(await fresh(productionB)).toEqual([])
    // B-PR-32: the office is told through the customer's supervisor (and backup) first, not every planner.
    expect(keysOf(await bellOf(supervisor)).some((key) => key.startsWith('notifications.production.customerUrgent'))).toBe(true)
    expect(keysOf(await bellOf(planner)).some((key) => key.startsWith('notifications.production.customerUrgent'))).toBe(false)
  })

  it('U2 we set one back to Regular and lock it (step-up): A reads why and "Changed by us", is refused in those words and told; a planner may not', async () => {
    const url = '/production/brand-orders/urgency/regular'
    const body = { orderIds: [A.u1.orderId], reason: LOCK_REASON, lock: true }
    // production.brand.override: not the planner's.
    expect((await call(planner, 'POST', url, body)).status).toBe(403)
    const bBefore = await brandBSide()
    const locked = await stepped(owner, 'POST', url, body)
    expect(locked.results.map((row: Json) => [row.orderId, row.outcome, row.done])).toEqual([[A.u1.orderId, 'DONE', true]])
    const [so2] = world.w.production.urgent
    const list = await listOfA()
    expect(rowIn(list, A.u1.orderId).urgency).toMatchObject({ code: 'REGULAR', urgentRank: null, byUs: true, byUsWords: { en: 'Changed by us' }, locked: true, lockWords: { en: `Set to Regular by us: ${LOCK_REASON}` } })
    // Its own list is renumbered 1..n.
    expect([so2, A.u2.orderId, A.u3.orderId].map((orderId) => rowIn(list, orderId).urgency?.urgentRank ?? null)).toEqual([1, 2, 3])
    const again = await call(buyerA, 'POST', '/portal/production/urgency', { orderIds: [A.u1.orderId], urgency: 'URGENT' })
    expect(again.status).toBe(409)
    expect(again.body.error.issues[0]).toEqual({ path: 'body/orderIds/0/LOCKED', message: `Set to Regular by us: ${LOCK_REASON}` })
    await settle()
    expect((await fresh(buyerA)).filter((notice) => notice.eventType === 'brand_production.urgency_changed').map(shortOf)).toEqual([{ messageKey: 'portal.production.locked', recordId: A.u1.orderId }])
    expect(await fresh(productionB)).toEqual([])
    expect(await brandBSide()).toEqual(bBefore)
  })

  it('N a note to 3 records asking the supervisor (checked first), then one needing an answer: a task for that order’s supervisor (PW-13)', async () => {
    const records = [
      { type: 'SalesOrder', id: world.w.a.salesOrderId },
      { type: 'WorkOrder', id: world.w.a.workOrderId },
      { type: 'SalesOrder', id: A.n1.orderId },
    ]
    const check = await ok(planner, 'POST', '/production/notes/check', { records, body: NOTE_BODY, askSupervisor: true })
    expect(check.held).toBe(false)
    expect((check.records as Json[]).map((record) => [record.id, record.canWrite, record.supervisor])).toEqual(records.map((record) => [record.id, true, 'SOMEONE_ELSE']))
    // PW-13: a person limited to B checks nothing of A's (not found, never named).
    await session('office.p2', 'POST', '/production/notes/check', { records, body: NOTE_BODY, askSupervisor: true }, 404)

    const batch = await ok(planner, 'POST', '/production/notes', { records, body: NOTE_BODY, askSupervisor: true })
    expect((batch.written as Json[]).map((row) => [row.id, row.supervisorAsked])).toEqual(records.map((record) => [record.id, true]))
    for (const row of batch.written as Json[]) {
      expect(await one('SELECT direction::text AS direction, audience::text AS audience, "partyId" FROM "Message" WHERE id = $1', [row.messageId]), row.id).toEqual({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', partyId: null })
    }
    // One record needs an answer: an issue, ONE task for its own supervisor, due in 1 working day at 08:00.
    const asked = await ok(planner, 'POST', '/production/notes', { records: [{ type: 'SalesOrder', id: A.n1.orderId }], body: ANSWER_NOTE, askSupervisor: true, needsAnswer: true })
    const issueId = asked.written[0].issueId as string
    expect(typeof issueId).toBe('string')
    expect(asked.issues.tasks).toHaveLength(1)
    expect(asked.issues.tasks[0]).toMatchObject({ assigned: true })
    const issue = await one('SELECT source::text AS source, status::text AS status, "taskId"::text AS "taskId", "partyId"::text AS "partyId" FROM "ProductionIssue" WHERE id = $1', [issueId])
    expect(issue).toMatchObject({ source: 'OFFICE', status: 'OPEN', partyId: world.ids.a })
    expect(await one('SELECT "assigneeId"::text AS "assigneeId", "recordType", "recordId"::text AS "recordId", "dueTime", status::text AS status FROM "Task" WHERE id = $1', [issue.taskId])).toEqual({
      assigneeId: orderSupervisor.id,
      recordType: 'SalesOrder',
      recordId: A.n1.orderId,
      dueTime: '08:00',
      status: 'OPEN',
    })
    await settle()
    // Each supervisor is told of the notes that ask him (one grouped bell item per batch); the order's own of his task.
    expect((await bellOf(supervisor)).some((item) => item.eventType === 'thread.user_mentioned')).toBe(true)
    const own = await bellOf(orderSupervisor)
    expect(own.some((item) => item.eventType === 'thread.user_mentioned')).toBe(true)
    expect(own.some((item) => item.eventType === 'task.assigned')).toBe(true)
    // The notes stay ours: A's conversation of that order holds none of them.
    const thread = await ok(buyerA, 'GET', `/portal/threads/SalesOrder/${world.w.a.salesOrderId}`)
    expect(JSON.stringify(thread)).not.toContain(NOTE_BODY)
    expect((await fresh(buyerA)).filter((notice) => notice.eventType.startsWith('production_issue.') || notice.eventType.startsWith('thread.'))).toEqual([])
  })

  it('E no answer: at raise + 1 working day (08:00, the cron’s clock) the backup, at raise + 2 the Owner and Admin; never a person limited to B (PW-17)', async () => {
    const issue = await one<{ id: string; raisedAt: Date; taskId: string }>(
      `SELECT id::text AS id, "raisedAt", "taskId"::text AS "taskId" FROM "ProductionIssue" WHERE "tenantId" = $1 AND "salesOrderId" = $2 AND source = 'OFFICE' ORDER BY "raisedAt" DESC LIMIT 1`,
      [T(), A.n1.orderId],
    )
    const clock = await world.h.database.withScope({ audience: 'office', tenantId: T(), actorId: newId() }, (client) => issueClockOf(client, world.w.companyId, new Date(issue.raisedAt)))
    expect(clock).not.toBeNull()
    const step = async () => (await one<{ step: number }>('SELECT "escalationStep" AS step FROM "ProductionIssue" WHERE id = $1', [issue.id])).step
    const escalationTasks = () =>
      admin<{ assigneeId: string | null; status: string }>(
        `SELECT "assigneeId"::text AS "assigneeId", status::text AS status FROM "Task" WHERE "tenantId" = $1 AND "recordId" = $2 AND "createdById" IS NULL AND title LIKE ANY (ARRAY['Senza risposta%', 'No answer after%']) ORDER BY "createdAt", id`,
        [T(), A.n1.orderId],
      )
    // A minute before 08:00 on the due day: nothing of this issue moves.
    await runIssueEscalation({ database: world.h.database, log, clock: clockAt(new Date(clock!.backupAt.getTime() - 60_000)) })
    expect(await step()).toBe(0)
    // Step 1: the customer's backup (he reads the thread and holds tasks), never the supervisor again.
    await runIssueEscalation({ database: world.h.database, log, clock: clockAt(new Date(clock!.backupAt.getTime() + 60_000)) })
    expect(await step()).toBe(1)
    expect((await escalationTasks()).map((task) => task.assigneeId)).toEqual([backup.id])
    // Step 2: the Owner and the Admin (every holder of those roles).
    await runIssueEscalation({ database: world.h.database, log, clock: clockAt(new Date(clock!.ownerAt.getTime() + 60_000)) })
    expect(await step()).toBe(2)
    const assignees = (await escalationTasks()).map((task) => task.assigneeId)
    expect(assignees).toEqual(expect.arrayContaining([backup.id, owner.id, adminPerson.id]))
    // The order's own supervisor holds the issue's task already: told, never a second task. PW-17: every escalation of this issue
    // names A only.
    expect(assignees).not.toContain(orderSupervisor.id)
    const escalated = (await outbox('production_issue.escalated')).filter((row) => row.payload.issueId === issue.id)
    expect(escalated.map((row) => row.payload.step)).toEqual([1, 2])
    for (const row of escalated) expect(row.payload.partyId).toBe(world.ids.a)
    await settle()
    expect(keysOf(await bellOf(backup))).toContain('notifications.production.issueEscalatedBackup')
    expect(keysOf(await bellOf(owner))).toContain('notifications.production.issueEscalatedOwner')
    expect(keysOf(await bellOf(adminPerson))).toContain('notifications.production.issueEscalatedOwner')
    // An office issue is the office's: the customer is told nothing of it.
    expect((await fresh(buyerA)).filter((notice) => notice.eventType.startsWith('production_issue.') || notice.eventType.startsWith('task.'))).toEqual([])
  })

  it('M A approves 2 and pauses 3 as one batch; the office sees one group and accepts it as one: three customer pauses (PW-12)', async () => {
    for (const name of ['p1', 'p2', 'p3'] as const) WO[name] = await workOrderOf(A[name].lineId)
    G.artwork = [(await askApproval('ARTWORK', 'SalesOrder', A.p1.orderId)).id as string, (await askApproval('ARTWORK', 'SalesOrder', A.p2.orderId)).id as string]
    // Approve N: one review list, each item with its file, one typed name; it cannot be undone (the list says so before Send).
    const review = await ok(buyerA, 'GET', `/portal/production/approvals?orderIds=${A.p1.orderId},${A.p2.orderId}`)
    expect((review.items as Json[]).map((item) => item.requestId).sort()).toEqual([...G.artwork].sort())
    expect(review.notFound).toBe(0)
    expect(review.undo).toBeTruthy()
    for (const item of review.items as Json[]) expect(item.may.approve, item.requestId).toBe(true)
    const approved = await ok(buyerA, 'POST', '/portal/production/approvals/answer', { items: (review.items as Json[]).map((item) => ({ requestId: item.requestId, version: item.version })), typedName: 'Alba Buyer' })
    expect(approved).toMatchObject({ notFound: 0, replayed: false })
    expect((approved.results as Json[]).map((row) => row.status)).toEqual(['APPROVED', 'APPROVED'])
    for (const requestId of G.artwork) expect(await one('SELECT status::text AS status, "answeredByUserId"::text AS by, "typedName" FROM "ApprovalRequest" WHERE id = $1', [requestId])).toEqual({ status: 'APPROVED', by: buyerA.id, typedName: 'Alba Buyer' })

    // Ask N: one pause per order, one batch, one kind.
    const asked = await ok(buyerA, 'POST', '/portal/production/asks', { orderIds: [A.p1.orderId, A.p2.orderId, A.p3.orderId], kind: 'HOLD', reason: PAUSE_REASON })
    expect(asked).toMatchObject({ kind: 'HOLD', notFound: 0, replayed: false })
    expect((asked.results as Json[]).map((row) => [row.orderId, row.done, row.words.en])).toEqual([A.p1, A.p2, A.p3].map((order) => [order.orderId, true, 'Asked: we answer you.']))
    G.holdBatch = asked.batchId as string
    const requests = await admin<{ id: string; orderId: string; kind: string; status: string; batchId: string }>(
      'SELECT id::text AS id, "orderId"::text AS "orderId", kind::text AS kind, status::text AS status, "batchId"::text AS "batchId" FROM "OrderChangeRequest" WHERE "batchId" = $1 ORDER BY "createdAt", id',
      [G.holdBatch],
    )
    expect(requests.map((row) => [row.kind, row.status])).toEqual([
      ['HOLD', 'OPEN'],
      ['HOLD', 'OPEN'],
      ['HOLD', 'OPEN'],
    ])
    expect((await outbox('order_change_request.batch_asked')).map((row) => row.payload).filter((payload) => payload.batchId === G.holdBatch)).toEqual([{ batchId: G.holdBatch, partyId: world.ids.a, kind: 'HOLD', count: 3 }])

    // Home › Approvals: ONE row for the batch; a person limited to B reaches none of it.
    const today = await ok(planner, 'GET', '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')
    const rows = (today.items as Json[]).filter((item) => String(item.key).endsWith(`:batch:${G.holdBatch}`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ words: { sentence: { key: 'ORDER_CHANGE_REQUEST.BATCH_HOLD', params: { count: 3 } } } })
    const items = requests.map((row) => ({ requestId: row.id, version: 1 }))
    await session('office.p2', 'POST', `/production/brand-requests/batches/${G.holdBatch}/accept`, { items }, 404)
    // Accepted as one: each request through its kind's own accept — a customer pause on each work order.
    const accepted = await ok(planner, 'POST', `/production/brand-requests/batches/${G.holdBatch}/accept`, { items, answer: 'Made-up: agreed, paused from today.' })
    expect((accepted.results as Json[]).map((row) => [row.orderId, row.done, row.problem])).toEqual(requests.map((row) => [row.orderId, true, null]))
    expect((accepted.requests as Json[]).map((row) => row.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED'])
    const holds = await holdsOf([WO.p1.id, WO.p2.id, WO.p3.id])
    expect(holds.map((hold) => [hold.workOrderId, hold.kind, hold.status, hold.reasonCode, hold.partyId].join(' ')).sort()).toEqual([WO.p1, WO.p2, WO.p3].map((workOrder) => [workOrder.id, 'BRAND', 'ACTIVE', 'CUSTOMER_PAUSE', world.ids.a].join(' ')).sort())
    for (const workOrder of [WO.p1, WO.p2, WO.p3]) expect(await workOrderStatus(workOrder.id)).toBe('ON_HOLD')

    await settle()
    // A reads its pause; its supervisor was told of the batch ask.
    expect(rowIn(await listOfA(), A.p1.orderId).marks).toMatchObject({ paused: true })
    expect((rowIn(await listOfA(), A.p1.orderId).marks.words as Json[]).map((words) => words.en)).toContain('Paused at your request')
    expect(keysOf(await bellOf(supervisor)).some((key) => key.startsWith('notifications.production.customerAsked'))).toBe(true)
    expect((await fresh(buyerA)).some((notice) => notice.messageKey === 'portal.production.hold_accepted')).toBe(true)
    expect(await fresh(productionB)).toEqual([])
  })

  it('Z1 A downloads the files zip of two orders: its Buyer gets the order confirmation, its Production person not (PW-12); B gets nothing of A', async () => {
    // The office shares a PDF on the order (the platform's store, as the order's files panel shares it) and makes its confirmation.
    await storeGeneratedFile(world.h.files, system(), { companyId: world.w.companyId, recordType: 'SalesOrder', recordId: A.p1.orderId, kind: 'DOCUMENT', originalName: CARE_NOTES, contentType: 'application/pdf', body: madeUpPdf(CARE_NOTES), visibility: ['OFFICE', 'PARTNER'], partyId: world.ids.a })
    const confirmation = await ok(owner, 'POST', `/sales/orders/${A.p1.orderId}/confirmation`, { language: 'en' }, 201)
    expect(typeof confirmation.fileId).toBe('string')
    const ofBuyer = await zipOf(buyerA, [A.p1.orderId, A.p2.orderId])
    const ofProduction = await zipOf(productionA, [A.p1.orderId, A.p2.orderId])
    expect(ofProduction[0]).toBe('index.csv')
    expect(ofProduction).toContain(`${A.p1.number}/${CARE_NOTES}`)
    // The Buyer sees prices: the same files and the order's confirmation; the Production person never a confirmation.
    for (const name of ofProduction) expect(ofBuyer).toContain(name)
    const extra = ofBuyer.filter((name) => !ofProduction.includes(name))
    expect(extra).toHaveLength(1)
    expect(extra[0]!.startsWith(`${A.p1.number}/`)).toBe(true)
    // B: none of A's orders is its own — not found, nothing named.
    expect((await call(productionB, 'POST', '/portal/production/files/zip', { orderIds: [A.p1.orderId] })).status).toBe(404)
  })

  it('H A asks to resume one paused order; accepted, the pause is lifted and the work order goes back (B-PR-27a)', async () => {
    const rules = await ok(buyerA, 'GET', `/portal/sales-orders/${A.p3.orderId}/change-requests/rules`)
    const asks = new Map((rules.asks as Json[]).map((entry) => [entry.kind as string, entry]))
    expect(asks.get('RESUME')).toMatchObject({ verdict: { possible: true } })
    expect(asks.get('HOLD')).toMatchObject({ verdict: { possible: false, code: 'PAUSED' } })
    const resume = (await ok(buyerA, 'POST', `/portal/sales-orders/${A.p3.orderId}/change-requests`, { kind: 'RESUME' }, 201)).request as Json
    const accepted = await ok(planner, 'POST', `/production/brand-requests/${resume.id}/accept`, { version: 1, answer: 'Made-up: going on from tomorrow.' })
    expect(accepted.request).toMatchObject({ kind: 'RESUME', status: 'ACCEPTED' })
    expect(accepted.done).toMatchObject({ kind: 'RESUME', paused: [], resumed: [{ id: WO.p3.id, changed: true }] })
    expect((await holdsOf([WO.p3.id])).map((hold) => [hold.kind, hold.status, hold.liftReason])).toEqual([['BRAND', 'LIFTED', `Resumed at the customer's request (${A.p3.number}).`]])
    expect(await workOrderStatus(WO.p3.id)).toBe('DRAFT')
    // The other two stay paused.
    for (const workOrder of [WO.p1, WO.p2]) expect(await workOrderStatus(workOrder.id)).toBe('ON_HOLD')
    await settle()
    expect(rowIn(await listOfA(), A.p3.orderId).marks).toMatchObject({ paused: false })
    expect(((await ok(buyerA, 'GET', `/portal/sales-orders/${A.p3.orderId}/change-requests/rules`)).asks as Json[]).find((entry) => entry.kind === 'RESUME')).toMatchObject({ verdict: { possible: false, code: 'NOT_PAUSED' } })
    expect((await fresh(buyerA)).filter((notice) => notice.recordId === A.p3.orderId).map((notice) => notice.messageKey)).toContain('portal.production.resume_accepted')
    expect(await fresh(productionB)).toEqual([])
  })

  it('P A reports a problem on two orders: ONE task; one office reply answers both; the other reads "Answered in <order>" and "answered in your order N" (PW-15)', async () => {
    const reported = await ok(buyerA, 'POST', '/portal/production/problems', { orderIds: [A.q1.orderId, A.q2.orderId], body: PROBLEM_BODY })
    expect((reported.results as Json[]).map((row) => [row.orderId, row.done, row.problem?.state])).toEqual([
      [A.q1.orderId, true, 'WAITING_ON_US'],
      [A.q2.orderId, true, 'WAITING_ON_US'],
    ])
    const issues = await admin<{ id: string; taskId: string; batchId: string; source: string; status: string }>(
      'SELECT id::text AS id, "taskId"::text AS "taskId", "batchId"::text AS "batchId", source::text AS source, status::text AS status FROM "ProductionIssue" WHERE "salesOrderId" = ANY($1::uuid[]) ORDER BY "raisedAt", id',
      [[A.q1.orderId, A.q2.orderId]],
    )
    expect(issues.map((issue) => [issue.source, issue.status, issue.batchId])).toEqual([
      ['BRAND', 'OPEN', reported.batchId],
      ['BRAND', 'OPEN', reported.batchId],
    ])
    // ONE task for the batch, on its first order, for that order's supervisor (the customer's default here).
    expect(new Set(issues.map((issue) => issue.taskId)).size).toBe(1)
    G.problemTask = issues[0]!.taskId
    expect(await one('SELECT "assigneeId"::text AS "assigneeId", "recordId"::text AS "recordId", status::text AS status FROM "Task" WHERE id = $1', [G.problemTask])).toEqual({ assigneeId: supervisor.id, recordId: A.q1.orderId, status: 'OPEN' })
    // Issue events are office news only: no partner reads them.
    for (const row of await outbox('production_issue.raised')) if (issues.some((issue) => issue.id === row.payload.issueId)) expect(row.payload.partyId).toBe(world.ids.a)

    // "Answer N" of one customer's orders is not built (threads T11): we answer in the first order's conversation, as the plan's
    // fallback; it answers every problem of the batch.
    const reply = await ok(planner, 'POST', `/threads/SalesOrder/${A.q1.orderId}/replies`, { body: REPLY_BODY }, 201)
    expect(reply.message).toBeDefined()
    await settle()
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "ProductionIssue" WHERE id = ANY($1::uuid[]) ORDER BY "raisedAt", id', [issues.map((issue) => issue.id)])).map((row) => row.status)).toEqual(['ANSWERED', 'ANSWERED'])
    expect((await one<{ status: string }>('SELECT status::text AS status FROM "Task" WHERE id = $1', [G.problemTask])).status).toBe('DONE')
    for (const row of (await outbox('production_issue.answered')).filter((entry) => issues.some((issue) => issue.id === entry.payload.issueId))) expect(row.payload).toMatchObject({ partyId: world.ids.a, source: 'BRAND', answeredInOrderId: A.q1.orderId })

    // The customer's page: answered on the first, "Answered in <the first order>" on the other.
    const list = await listOfA()
    expect(rowIn(list, A.q1.orderId).problem.state).toBe('ANSWERED')
    expect(rowIn(list, A.q2.orderId).problem).toMatchObject({ state: 'ANSWERED_IN', inOrder: { id: A.q1.orderId, number: A.q1.number }, words: { en: `Answered in ${A.q1.number}` } })
    // Its bell: one group, by its own numbers ("in the conversation of your order N"), never our series.
    const told = (await fresh(buyerA)).filter((notice) => notice.eventType === 'production_issue.answered')
    expect(told.map((notice) => `${notice.messageKey} ${notice.recordId}`).sort()).toEqual([`portal.production.problem_answered ${A.q1.orderId}`, `portal.production.problem_answered_in ${A.q2.orderId}`].sort())
    expect(told.find((notice) => notice.messageKey === 'portal.production.problem_answered_in')!.params).toMatchObject({ yourKind: 'ORDER' })
    expect(new Set(told.map((notice) => notice.groupKey)).size).toBe(1)
    for (const notice of told) expect(notice.actorId).toBeNull()
    const bell = await ok(buyerA, 'GET', '/portal/notifications?limit=50')
    const group = (bell.items as Json[]).find((item) => (item.group.ids as string[]).includes(told[0]!.id))!
    expect(group.sentence.en).toMatch(/your order \d+/)
    expect(`${group.sentence.en} ${group.sentence.it}`).not.toContain(A.q1.number)
    // The reply in its conversation signs with its writer's name (as today), never an id.
    const thread = await ok(buyerA, 'GET', `/portal/threads/SalesOrder/${A.q1.orderId}`)
    const ours = (thread.messages as Json[]).find((message) => message.body === REPLY_BODY)!
    expect(ours).toMatchObject({ side: 'COMPANY', author: { name: nameOf('pietro.planner@pr36-office.example.com'), mine: false } })
    expect(ours.author.id).toBeUndefined()
    expect(await fresh(productionB)).toEqual([])
  })

  it('G a PP and a size-set approval: A approves the PP; we decide the size set for A (step-up, never the asker), put it back once, ask again (B-PR-30a/30b, B-PR-40)', async () => {
    const blk = (await one<{ colourwayId: string }>('SELECT "colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [A.g1.lineId])).colourwayId
    const roundOf = async (kind: 'PRE_PRODUCTION' | 'SIZE_SET'): Promise<Json> => {
      const { round } = await ok(owner, 'POST', '/sales/samples/rounds', { styleId: world.w.styleId, companyId: world.w.companyId, kind, partyId: world.ids.a, cells: [{ colourwayId: blk, size: '50', quantity: 1 }], instructions: `Made-up ${kind} round.` }, 201)
      return (await ok(owner, 'POST', `/sales/samples/rounds/${round.id}/move`, { version: round.version, to: 'UNDER_REVIEW' })).round as Json
    }
    const pp = await roundOf('PRE_PRODUCTION')
    const sizeSet = await roundOf('SIZE_SET')
    const ppGate = (await ok(owner, 'POST', '/planning/milestones/gates', { salesOrderId: A.g1.orderId, kind: 'PP_SAMPLE', sampleRoundId: pp.id }, 201)).gate as Json
    const sizeGate = (await ok(owner, 'POST', '/planning/milestones/gates', { salesOrderId: A.g1.orderId, kind: 'SIZE_SET', sampleRoundId: sizeSet.id }, 201)).gate as Json
    expect([ppGate.state, sizeGate.state]).toEqual(['WAITING', 'WAITING'])
    const ppRequest = await askApproval('SAMPLE', 'SampleRound', pp.id)
    const sizeRequest = await askApproval('SAMPLE', 'SampleRound', sizeSet.id)
    G.ppRequest = ppRequest.id as string
    G.sizeSetRequest = sizeRequest.id as string

    // A approves the PP sample itself; the round's event passes its gate (the worker).
    await ok(buyerA, 'POST', `/portal/approvals/${G.ppRequest}/answer`, { decision: 'APPROVED', typedName: 'Alba Buyer', version: ppRequest.version })
    expect(await one('SELECT stage::text AS stage, decision::text AS decision, "decidedVia"::text AS via, "decidedById"::text AS by FROM "SampleRound" WHERE id = $1', [pp.id])).toEqual({ stage: 'DECIDED', decision: 'APPROVED', via: 'PORTAL', by: buyerA.id })
    await settle()
    expect((await one<{ passedAt: Date | null }>('SELECT "passedAt" FROM "OrderGate" WHERE id = $1', [ppGate.id])).passedAt).not.toBeNull()

    // The size set decided for A: step-up, never the person who asked; a person limited to B reaches nothing of it.
    const url = `/approvals-out/${G.sizeSetRequest}/decide-for-party`
    const body = { version: sizeRequest.version, decision: 'APPROVED', typedName: 'Bruno Backup', reason: DECIDE_REASON }
    expect(pathOf(await stepped(owner, 'POST', url, body, 403))).toBe('refusal/OWN_ASK')
    await session('office.p2', 'POST', url, body, 404)
    const decided = await stepped(backup, 'POST', url, body)
    expect(decided.override).toEqual({ outcome: 'DONE', taskId: null, words: null })
    expect(decided.request).toMatchObject({ status: 'APPROVED', decidedForParty: { reason: DECIDE_REASON }, answer: { via: 'OFFICE', typedName: 'Bruno Backup' }, reversed: null })
    await settle()
    expect((await one<{ passedAt: Date | null }>('SELECT "passedAt" FROM "OrderGate" WHERE id = $1', [sizeGate.id])).passedAt).not.toBeNull()
    // A reads why, never who of us.
    const page = await ok(buyerA, 'GET', `/portal/approvals/${G.sizeSetRequest}`)
    expect(page.request).toMatchObject({ status: 'APPROVED', decidedForYou: `Decided by us for you: ${DECIDE_REASON}`, reversed: null })
    expect(JSON.stringify(page)).not.toMatch(/bruno|Bruno Backup/i)

    // Put back once, with a reason A reads: the round under review again, the gate waits again; a second time refused.
    const reverseUrl = `/approvals-out/${G.sizeSetRequest}/reverse`
    const version = await requestVersion(G.sizeSetRequest)
    await session('office.p2', 'POST', reverseUrl, { version, reason: PUT_BACK }, 404)
    const reversed = await stepped(backup, 'POST', reverseUrl, { version, reason: PUT_BACK })
    expect(reversed).toMatchObject({ override: { outcome: 'DONE', taskId: null }, effects: ['ROUND_UNDER_REVIEW', 'GATE_WAITING'] })
    expect(await one('SELECT stage::text AS stage, decision::text AS decision FROM "SampleRound" WHERE id = $1', [sizeSet.id])).toEqual({ stage: 'UNDER_REVIEW', decision: null })
    expect(await one('SELECT "passedAt", "passedById" FROM "OrderGate" WHERE id = $1', [sizeGate.id])).toEqual({ passedAt: null, passedById: null })
    expect(pathOf(await stepped(backup, 'POST', reverseUrl, { version: await requestVersion(G.sizeSetRequest), reason: PUT_BACK }, 409))).toBe('refusal/REVERSED')
    const back = await ok(buyerA, 'GET', `/portal/approvals/${G.sizeSetRequest}`)
    expect(back.request.reversed).toMatchObject({ words: `Put back by us: ${PUT_BACK}` })
    // A is asked again: a new request on the round.
    const again = await askApproval('SAMPLE', 'SampleRound', sizeSet.id)
    expect(again.status).toBe('OPEN')
    expect(await one('SELECT "approvalRequestId"::text AS request FROM "SampleRound" WHERE id = $1', [sizeSet.id])).toEqual({ request: again.id })
    await settle()
    // A was told its gate passed (level Gates & dates); B nothing.
    expect((await fresh(buyerA)).some((notice) => notice.messageKey === 'portal.production.gate_passed' && notice.recordId === A.g1.orderId)).toBe(true)
    expect(await fresh(productionB)).toEqual([])
  })

  it('K the stage and at-risk news: cutting starts on A’s order (told "Cutting"); the PP approval can no longer be put back; an order raised At risk (told, never our note)', async () => {
    const alpha = world.w.a.salesOrderId
    // The keeper's nightly look writes the order's stage first (Preparing: nothing cut).
    await keepOrder(system(), alpha, { what: 'nightly' })
    expect(rowIn(await listOfA(), alpha).stage?.code).toBe('PREPARING')
    // The cutting floor's first bundle on A's work order (a copy of the seed's: cutting is the floor's flow), then the keeper on
    // its event, as the worker runs it.
    const seedBundle = (await one<{ id: string }>(`SELECT b.id::text AS id FROM "Bundle" b JOIN "WorkOrder" o ON o.id = b."workOrderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-WO-0001' ORDER BY b.id LIMIT 1`, [T()])).id
    const cell = (await one<{ id: string }>(`SELECT id::text AS id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = '50'`, [world.w.a.workOrderId])).id
    const bundle = newId()
    await world.replica([
      {
        sql: `INSERT INTO "Bundle" SELECT (jsonb_populate_record(NULL::"Bundle", to_jsonb(b) || jsonb_build_object('id', $1::text, 'workOrderId', $2::text, 'workOrderSizeId', $3::text, 'code', $4::text, 'replacedCodes', '[]'::jsonb, 'clientEventId', NULL, 'status', 'ACTIVE'))).* FROM "Bundle" b WHERE b.id = $5::uuid`,
        values: [bundle, world.w.a.workOrderId, cell, `T-PR36-BN-${bundle.slice(-8)}`, seedBundle],
      },
    ])
    const kept = await keepOrder(system(), alpha, { what: 'production.bundle_created', health: false })
    expect(kept.told).toContain('brand_production.stage_reached')
    await settle()
    expect(rowIn(await listOfA(), alpha).stage?.code).toBe('CUTTING')
    expect((await fresh(buyerA)).filter((notice) => notice.eventType === 'brand_production.stage_reached').map(shortOf)).toEqual([{ messageKey: 'portal.production.cutting', recordId: alpha }])
    // Cutting started on A's lines of the style: the PP approval can no longer be put back (refused in words).
    const refused = await stepped(backup, 'POST', `/approvals-out/${G.ppRequest}/reverse`, { version: await requestVersion(G.ppRequest), reason: PUT_BACK_PP }, 409)
    expect(pathOf(refused)).toBe('refusal/CUT')
    expect(refused.error.message).toMatch(/Cutting started on|Il taglio è iniziato il/)

    // At risk, raised by a person with a reason code: A reads the chip and the reason, never our note.
    const health = await ok(planner, 'GET', `/production/brand-orders/${A.q2.orderId}/health`)
    expect(['ON_TRACK', 'NO_DATE']).toContain(health.health.computed)
    const raised = await ok(planner, 'PUT', `/production/brand-orders/${A.q2.orderId}/health`, { reasonCode: 'MATERIAL_LATE', note: HEALTH_NOTE })
    expect(raised.health).toMatchObject({ orderId: A.q2.orderId, health: 'AT_RISK', reasonCode: 'MATERIAL_LATE' })
    await settle()
    const list = await listOfA()
    expect(rowIn(list, A.q2.orderId).health).toMatchObject({ code: 'AT_RISK', reason: { code: 'MATERIAL_LATE' } })
    expect(JSON.stringify(list)).not.toContain(HEALTH_NOTE)
    expect((await fresh(buyerA)).filter((notice) => notice.eventType === 'brand_production.health_changed').map(shortOf)).toEqual([{ messageKey: 'portal.production.at_risk', recordId: A.q2.orderId }])
    // Production news is a daily summary: none of A's production notices was mailed at once; every one by its own numbers.
    const all = await noticesOf(buyerA.id)
    const production = all.filter((notice) => notice.messageKey.startsWith('portal.production.'))
    expect(production.length).toBeGreaterThan(5)
    for (const notice of production) {
      expect(notice.partyId, notice.messageKey).toBe(world.ids.a)
      expect(notice.actorId, notice.messageKey).toBeNull()
      expect(notice.recordLabel, notice.messageKey).not.toMatch(/SO-|T-URG-|WO-/)
    }
    const mailed = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE "notificationId" = ANY($1::uuid[]) AND channel = 'EMAIL'`, [production.map((notice) => notice.id)])
    expect(mailed.n).toBe(0)
    expect(await fresh(productionB)).toEqual([])
  })

  it('W the wall: B’s people and an office person limited to B see nothing of A by any door; the production unit sees it all; A is never told who supervises', async () => {
    // B's own production page: its own orders only.
    const listB = await ok(productionB, 'GET', '/portal/production')
    const ofA = await admin<{ id: string }>('SELECT id::text AS id FROM "SalesOrder" WHERE "partyId" = $1', [world.ids.a])
    for (const item of listB.items as Json[]) expect(ofA.map((row) => row.id)).not.toContain(item.id)
    // Every door with A's ids: not found, never named (the words of an unknown id).
    expect((await call(productionB, 'GET', `/portal/production/${world.w.a.salesOrderId}`)).status).toBe(404)
    expect((await call(productionB, 'GET', `/portal/production/${A.p1.orderId}/quality`)).status).toBe(404)
    for (const [method, url, body] of [
      ['POST', '/portal/production/urgency', { orderIds: [A.u2.orderId], urgency: 'REGULAR' }],
      ['PUT', '/portal/production/urgent-order', { orderIds: [A.u2.orderId] }],
      ['POST', '/portal/production/asks', { orderIds: [A.p1.orderId], kind: 'RESUME' }],
      ['POST', '/portal/production/problems', { orderIds: [A.q1.orderId], body: 'Made-up: a try at another order.' }],
      ['POST', '/portal/production/files/zip', { orderIds: [A.p2.orderId] }],
    ] as const) {
      const answer = await call(productionB, method, url, body)
      expect([404, 409], `${method} ${url}: ${JSON.stringify(answer.body).slice(0, 300)}`).toContain(answer.status)
    }
    expect((await call(productionB, 'GET', `/portal/production/approvals?orderIds=${A.p1.orderId}`)).status).toBe(404)
    expect((await call(productionB, 'POST', '/portal/production/approvals/answer', { items: [{ requestId: G.artwork[0]!, version: 1 }], typedName: 'Bianca Production' })).status).toBe(404)
    expect((await call(productionB, 'GET', `/portal/approvals/${G.ppRequest}`)).status).toBe(404)
    expect((await call(productionB, 'GET', `/portal/threads/SalesOrder/${A.q1.orderId}`)).status).toBe(404)
    await ok(productionB, 'GET', '/portal/notifications?limit=50')
    await ok(productionB, 'GET', '/portal/approvals?state=OPEN')
    // A's state did not move by any of B's calls.
    expect(rowIn(await listOfA(), A.u2.orderId).urgency).toMatchObject({ code: 'URGENT', urgentRank: 2 })

    // An office person limited to B: lists hold only B; A's records are not found.
    const overviewB = await session('office.p2', 'GET', '/production/overview')
    expect((overviewB.customers as Json[]).map((row) => row.customer.id)).toEqual([world.ids.b])
    await session('office.p2', 'GET', '/production/work-orders?limit=200')
    await session('office.p2', 'GET', `/production/work-orders/${WO.p1.id}`, undefined, 404)
    await session('office.p2', 'GET', `/production/brands/${world.ids.a}/urgency`, undefined, 404)
    await session('office.p2', 'GET', '/production/brand-requests?status=ALL')
    await session('office.p2', 'GET', '/home/today?kind=ORDER_CHANGE_REQUEST&limit=200')
    await session('office.p2', 'GET', `/production/overview?partyId=${world.ids.a}`, undefined, 404)
    // The production unit sees every customer; "Only mine" of A's supervisor holds A only.
    const overview = await session('office.all', 'GET', '/production/overview')
    expect(overview.everyCustomer).toBe(true)
    const customers = (overview.customers as Json[]).map((row) => row.customer.id as string)
    expect(customers).toEqual(expect.arrayContaining([world.ids.a, world.ids.b]))
    expect(((await ok(supervisor, 'GET', '/production/overview?supervisor=me')).customers as Json[]).map((row) => row.customer.id)).toEqual([world.ids.a])

    // T00: nothing B's people or the person limited to B got names anything of A — its names, codes, numbers, references, files,
    // ids, and the flow's own words (notes, reasons, the problem, our reply, our note on a raise).
    const aMarkers: Marker[] = [
      ...(await markersOf(world.h.db, world.ids.a)),
      ...FLOW_WORDS.map((text) => ({ label: "A's flow words", text })),
      ...G.artwork.map((text) => ({ label: "A's approval", text })),
      { label: "A's approval", text: G.ppRequest },
      { label: "A's approval", text: G.sizeSetRequest },
    ]
    expect(seenByB.length).toBeGreaterThan(20)
    const leaks = seenByB.flatMap((seen) => {
      let text = typeof seen.body === 'string' ? seen.body : JSON.stringify(seen.body ?? null)
      for (const id of seen.asked) text = text.replaceAll(id, '<asked>')
      return findMarkers(text, aMarkers).map((hit) => `${seen.who} ${seen.url}: ${hit}`)
    })
    expect(leaks).toEqual([])

    // A is never told who its supervisor is (nor the backup, nor the order's own): no name, address or id of theirs in anything
    // A's people got; its production reads carry no supervisor field. The reply in its thread signed with its writer's name (P).
    const supervisors: Marker[] = (
      await admin<{ id: string; email: string; name: string }>('SELECT id::text AS id, email, "displayName" AS name FROM "User" WHERE id = ANY($1::uuid[])', [[supervisor.id, backup.id, orderSupervisor.id]])
    ).flatMap((row) => [
      { label: 'supervisor id', text: row.id },
      { label: 'supervisor address', text: row.email },
      { label: 'supervisor name', text: row.name },
    ])
    expect(seenByA.length).toBeGreaterThan(20)
    expect(seenByA.flatMap((seen) => findMarkers(seen.body, supervisors).map((hit) => `${seen.url}: ${hit}`))).toEqual([])
    for (const seen of seenByA.filter((entry) => entry.url.startsWith('/portal/production'))) expect(JSON.stringify(seen.body), seen.url).not.toMatch(/"(supervisor|supervisorId|assignee|assigneeId|backupId)"/)
  })

  it('Z no route answered 500 and no handler failed during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(worker.retried).toEqual([])
  })

  // ---- X: the B-PR-10 sweep again, on this world ----------------------------------------------------------------------------------

  it('X1 the B-PR-10 sweep, again at the end: every GET that reads a work order, as B with A’s ids — as unknown, empty or 403 EVERY_PARTY, never a word of A', async () => {
    // From here on outside calls are not this flow's (the sweep's own set-up, as brand-wall.pg): no 500 is counted any more.
    useErrorTracker(undefined)
    sweepFiles = mkdtempSync(join(tmpdir(), 'factory-pr36-sweep-'))
    const noGateway = new Proxy({}, { get: () => () => { throw new Error('the sweep has no gateway') } }) as Gateway
    const files = createFilesRuntime({ gateway: noGateway, local: localFileStore({ root: sweepFiles, environment: 'test' }) })
    useFiles(files)
    useGateway(noGateway)
    useEmail(createEmailRuntime({ gateway: noGateway, fake: null, webOrigin: 'http://localhost:3901', files: files.storage }))
    sweepSessions = twoBrandSessions(T(), world.ids.a, world.ids.b, OFFICE_PERMISSIONS)
    sweeper = createWallSweep({ ids: world.ids, sessions: sweepSessions, reportPrefix: process.env.FACTORY_PR36_SWEEP_REPORT })
    const plugins: FastifyPluginAsync[] = [sweeper.routeSpy]
    for (const file of routesFiles(SRC)) plugins.push(((await import(pathToFileURL(file).href)) as { default: FastifyPluginAsync }).default)
    sweepApp = await buildApp(
      { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 1_000_000, perAddressMax: 1_000_000, timeWindowMs: 60_000 } },
      { database: world.h.database, officeAuth: world.h.auth, routes: plugins, authenticate: testAuthenticator((request) => sweepSessions[String(request.headers['x-test-session'])] ?? null) },
    )
    // A's markers now hold every record the flow made (its orders, work orders, requests, issues, files) and the flow's words.
    await sweeper.prepare({ db: world.h.db, app: sweepApp, w: world.w, srcRoot: SRC, schemaDir: SCHEMA_DIR, markers: FLOW_WORDS.map((text) => ({ label: "A's flow words", text })) })
    expect(sweeper.walked().length).toBeGreaterThan(0)
    const findings: Finding[] = []
    for (const route of sweeper.swept('read')) for (const variant of sweeper.variantsOf(route)) findings.push(...(await sweeper.sweep(route, variant)))
    const reads = sweeper.called.filter((entry) => entry.route.startsWith('GET '))
    sweeper.report('reads', { findings, failures: sweeper.failures, called: reads, unresolved: sweeper.unresolved() })
    console.log(`B-PR-36 GET sweep: ${reads.length} calls; ${reads.filter((entry) => entry.named > 0 && entry.all !== null && entry.all >= 200 && entry.all < 300).length} named A's records the production unit reads`)
    expect(findings).toEqual([])
  }, SWEEP_TIMEOUT)

  it('X2 the B-PR-10 sweep, again at the end (PW-10): every write that reads a work order, as B with A’s ids, is refused as unknown and writes no row about A', async () => {
    expect(sweeper, 'X1 set the sweep up').toBeDefined()
    const findings: Finding[] = []
    for (const route of sweeper!.swept('write')) findings.push(...(await sweeper!.sweep(route)))
    sweeper!.report('writes', { findings, failures: sweeper!.failures, called: sweeper!.called.filter((entry) => !entry.route.startsWith('GET ')), unresolved: sweeper!.unresolved() })
    expect(findings).toEqual([])
  }, SWEEP_TIMEOUT)
})
