import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../../packages/factory-db/src/testing/second-brand'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { syncDraftOperations } from '../../production/work-orders/store'

/**
 * B-OF-031 … B-OF-032 (order files tab, PR S2; design order-files-2026-11-22 13-backend §2, §4; Owner D2, D3) — "Ask for a file" on a
 * sales order, on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security and …_order_files_guards are real), every seed (Brand Alpha = the seeds' customer SEED-C1: SEED-SO-0002
 * with SEED-WO-0001 at plant A1 and the draft SEED-WO-0002; A1's team L1-A) and the second brand (Brand Beta, its order and a file).
 * Test sessions hold the role templates' grants (Sales holds no price grain).
 *
 *   S2.1  make / change / reassign / cancel and §2.1's people: a role of 3 holders → 3 Tasks, an Alpha-limited holder skipped on
 *         Beta's order (and alone: 409 NOBODY_WITH_ROLE); a Planner can be asked, and the Factory designer (S3.4, B-OF-016: its template
 *         keeps tasks); a
 *         person who cannot see the order, or does not see prices for a priced ask: 409 in words that name them; the floor only on a
 *         work order, never priced or body data (400); no new ask on a closed order (409); the brand wall (Beta's Owner: Alpha's order
 *         as an unknown one; Alpha's ask through Beta's order: "File ask not found."); the version (409); the Tasks follow a change,
 *         are cancelled with a reassign or a cancel; audit rows and file_ask.* events with ids only
 *         and the Restrict keys in words (lead, S2): a line a file ask lands on is never removed by an amendment, a step it names
 *         never leaves a draft's operations
 *   S2.2  answer / accept / ask again / chase: files of the record the ask lands on only (409 FILE_NOT_OF_TARGET, FILE_INFECTED); a
 *         held file arrives but the accept is refused (409 FILES_HELD) until the scan cleared it; the addressees' Tasks done and the
 *         asker's "Check: …" written, then done; asked again: OPEN, rounds 1, the Tasks open again; "Ask for an update" writes an
 *         office note mentioning the open Tasks' people — never a priced ask's words; a floor ask only moves its chase time
 *   S3    B-OF-035 the "Ask for a file…" window's choices: Sales reads them (people, office roles, the floor's teams and roles of the
 *         order's plants, lines, work orders and steps), never a floor worker's name; an Alpha-limited person on Beta's order: 404
 *
 * Every name and number is made up. Not run in the build (Owner rule: checks at the end). Run with
 * `node scripts/factory/run-pg-tests.mjs sales/file-asks/file-asks`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'of031-file-asks'
const sid = (key: string) => seedUuid(NS, key)
const firstSid = (key: string) => `00000000${sid(key).slice(8)}`
const T = sid('tenant')
const companyA = sid('company:A')
const SO2 = sid('production:sales-order:SO-0002')
const SO2_LINES = [sid('production:sales-order:SO-0002:10'), sid('production:sales-order:SO-0002:20')] as const
const WO1 = sid('production:work-order:WO-0001')
const WO1_SEW = sid('production:WO-0001:operation:20')
const WO2 = firstSid('production:work-order:WO-0002')
const WO2_PACK = firstSid('production:WO-0002:operation:40')
const TEAM_A1 = sid('people:team:A1:L1-A')
const AT = new Date('2026-11-22T08:00:00.000Z')

/** The people: role templates, all customers unless said (planners in three custom roles below). */
// S3 (B-OF-016): + the Factory designer.
const PEOPLE = { owner: newId(), sales: newId(), planner: newId(), betaOwner: newId(), p1: newId(), p2: newId(), p3: newId(), alphaOnly: newId(), designer: newId() } as const
type Person = keyof typeof PEOPLE
const SESSIONS: Record<string, SessionContext> = {}
function grantsOf(role: string, parties: Grant['parties'] = 'all'): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }]
}
/** Two custom office roles with the Planner's rights: THREE — p1, p2, p3 (every customer) and alphaOnly (Brand Alpha only); ALPHA — alphaOnly alone. */
const ROLES = { three: newId(), alpha: newId() } as const

let h: Harness
let app: FastifyInstance
let beta: SecondBrand
let alpha: string
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `of031-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: Person, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
/** A week from now (a due day after today in Rome, whatever the hour). */
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
const asks = (orderId: string) => `/sales/orders/${orderId}/file-asks`
const askRow = (id: string) => one<Json>(`SELECT status::text AS status, version, addressee::text AS addressee, "addresseeUserId", "addresseeRoleId", "taskIds"::text[] AS "taskIds", words, "dueOn"::text AS "dueOn", "fileIds"::text[] AS "fileIds", rounds, "lastReason", "checkTaskId", "lastChasedAt" FROM "FileAsk" WHERE id = $1`, [id])
const tasksOf = (ids: readonly string[]) => admin<Json>(`SELECT id, status::text AS status, "assigneeId", title, "recordType", "recordId", "dueDate"::text AS "dueDate", "createdById" FROM "Task" WHERE id = ANY($1::uuid[]) ORDER BY "assigneeId"`, [ids])
const outbox = (askId: string) => admin<Json>(`SELECT type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'file_ask.%' AND payload->>'askId' = $2 ORDER BY "occurredAt", id`, [T, askId])
const audits = (askId: string) => admin<Json>(`SELECT action, before, after, reason FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'FileAsk' AND "recordId" = $2 ORDER BY at, id`, [T, askId])

/** An ask on SEED-SO-0002 itself to `who`, with `extra`. */
const askBody = (who: Json, extra: Json = {}): Json => ({ words: 'Made-up: the signed order confirmation', fileKind: 'DOCUMENT', target: { type: 'SALES_ORDER' }, who, dueOn: NEXT_WEEK(), ...extra })
/** An ask on SEED-WO-0001 (plant A1) to A1's team L1-A for photos of step 20, with `extra`. */
const floorBody = (extra: Json = {}): Json => askBody({ kind: 'FLOOR_TEAM', teamId: TEAM_A1 }, { words: 'Made-up: photos of step 20', fileKind: 'PHOTO', target: { type: 'WORK_ORDER', workOrderId: WO1, operationId: WO1_SEW }, ...extra })
async function made(session: Person, orderId: string, body: Json): Promise<Json> {
  return ok(session, 'POST', asks(orderId), body, 201)
}

/** A file of `recordType` / `recordId` (an office upload, AVAILABLE unless `changes` say otherwise). */
async function fileOf(recordType: string, recordId: string, changes: Json = {}): Promise<string> {
  const id = randomUUID()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: PEOPLE.owner }, (client) =>
    client.storedFile.createMany({
      data: [
        seedFile(T, {
          id,
          companyId: companyA,
          recordType,
          recordId,
          kind: 'DOCUMENT',
          originalName: `Made-up ${id.slice(0, 8)}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 2048,
          storageKey: `t/${T}/c/${companyA}/2026/${randomUUID()}`,
          visibility: ['OFFICE'],
          partyId: null,
          status: 'AVAILABLE',
          availableAt: AT,
          storeAccountId: sid('files:account:r2'),
          createdAt: AT,
          updatedAt: AT,
          createdById: PEOPLE.owner,
          ...changes,
        }),
      ],
    }),
  )
  return id
}

/** A manual order of Brand Alpha typed by the Owner (two lines, nothing made yet): its id and lines. */
async function alphaOrder(ref: string): Promise<{ id: string; version: number; lines: { id: string; seq: number }[] }> {
  const lines = await admin<{ styleId: string; colourwayId: string; sizes: string[] }>(
    `SELECT l."styleId", l."colourwayId", (SELECT array_agg(s.size ORDER BY s.size) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) AS sizes
       FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' ORDER BY l.seq`,
    [T],
  )
  const body = { companyId: companyA, partyId: alpha, customerRef: ref, lines: lines.slice(0, 2).map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, unitPrice: '100', sizes: line.sizes.slice(0, 1).map((size) => ({ size, quantity: 2 })) })) }
  const order = (await ok('owner', 'POST', '/sales/orders/manual', body, 201)).order
  return { id: order.id, version: order.version, lines: await admin<{ id: string; seq: number }>(`SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [order.id]) }
}

/** A copy of Beta's order in `status`, planted (the owner, triggers off): its id. */
async function betaOrderIn(status: string): Promise<string> {
  const id = randomUUID()
  await force(
    `INSERT INTO "SalesOrder" SELECT * FROM jsonb_populate_record(NULL::"SalesOrder", (SELECT to_jsonb(o) || $1::jsonb FROM "SalesOrder" o WHERE o.id = $2))`,
    [JSON.stringify({ id, number: `T-OF031-${id.slice(0, 8)}`, customerSeq: null, status, closedAt: status === 'CLOSED' || status === 'CANCELLED' ? AT.toISOString() : null, cancelReason: status === 'CANCELLED' ? 'Made-up: withdrawn.' : null }), beta.salesOrderId],
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('of031_file_asks')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  beta = await seedSecondBrand({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  alpha = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [T])).id
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  const planner = templateOf('planner')!
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, 'custom.of031_three', 'Made-up three planners', $3::text[], ARRAY[]::text[])`, [ROLES.three, T, [...planner.permissions]])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, 'custom.of031_alpha', 'Made-up Alpha planner', $3::text[], ARRAY[]::text[])`, [ROLES.alpha, T, [...planner.permissions]])
  const assign = (person: Person, roleId: string, parties: readonly string[] = []) =>
    admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '30 days')`, [newId(), T, PEOPLE[person], roleId, [...parties]])
  const ROLE_OF: Partial<Record<Person, string>> = { owner: 'owner', sales: 'sales', planner: 'planner', betaOwner: 'owner', designer: 'designer' }
  for (const person of Object.keys(PEOPLE) as Person[]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `of031-${person}-${run}@example.com`, `Made-up ${person}`])
    const role = ROLE_OF[person]
    if (role) await assign(person, roleIds.get(role)!, person === 'betaOwner' ? [beta.partyId] : [])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: role ? grantsOf(role, person === 'betaOwner' ? [beta.partyId] : 'all') : grantsOf('planner', person === 'alphaOnly' ? [alpha] : 'all') }
  }
  for (const person of ['p1', 'p2', 'p3'] as const) await assign(person, ROLES.three)
  await assign('alphaOnly', ROLES.three, [alpha])
  await assign('alphaOnly', ROLES.alpha, [alpha])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// =================================================================================================================================
describe('S2.1 make: who becomes people (§2.1), the walls, the shape', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a role of 3 holders → 3 Tasks; its Alpha-limited holder is skipped on Beta’s order and counted on Alpha’s', async () => {
    const onBeta = await made('owner', beta.salesOrderId, askBody({ kind: 'OFFICE_ROLE', roleId: ROLES.three }))
    expect(onBeta).toMatchObject({ ask: { version: 1, status: 'OPEN' }, tasks: 3 })
    const row = await askRow(onBeta.ask.id)
    expect(row).toMatchObject({ status: 'OPEN', addressee: 'OFFICE_ROLE', addresseeRoleId: ROLES.three, addresseeUserId: null })
    const tasks = await tasksOf(row.taskIds)
    expect(tasks.map((task) => task.assigneeId).sort()).toEqual([PEOPLE.p1, PEOPLE.p2, PEOPLE.p3].sort())
    for (const task of tasks) expect(task).toMatchObject({ status: 'OPEN', recordType: 'SalesOrder', recordId: beta.salesOrderId, title: 'Carica: Made-up: the signed order confirmation', createdById: PEOPLE.owner })
    const onAlpha = await made('owner', SO2, askBody({ kind: 'OFFICE_ROLE', roleId: ROLES.three }))
    expect(onAlpha.tasks).toBe(4)
    // The event: ids only, the order's customer as the live party.
    expect(await outbox(onBeta.ask.id)).toEqual([{ type: 'file_ask.asked', payload: { askId: onBeta.ask.id, salesOrderId: beta.salesOrderId, workOrderId: null, status: 'OPEN', partyId: beta.partyId } }])
    expect((await audits(onBeta.ask.id)).map((entry) => entry.action)).toEqual(['files.fileAsk.make'])
  })

  it('nobody with the role reaches the order → 409 NOBODY_WITH_ROLE; more than 20 would be TOO_MANY_PEOPLE', async () => {
    const error = await no('owner', 'POST', asks(beta.salesOrderId), askBody({ kind: 'OFFICE_ROLE', roleId: ROLES.alpha }), 409)
    expect(paths(error)).toEqual(['fileAsk/NOBODY_WITH_ROLE'])
    expect(error.message).toBe('Nobody with this role can see this order.')
    // On Alpha's order the same role reaches its one holder.
    expect((await made('owner', SO2, askBody({ kind: 'OFFICE_ROLE', roleId: ROLES.alpha }))).tasks).toBe(1)
  })

  it('a person: a Planner can be asked (one Task); someone who cannot see the order, or no prices for a priced ask, is refused by name', async () => {
    const asked = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))
    expect(asked.tasks).toBe(1)
    // S3 (B-OF-016, Owner D6): the Factory designer keeps tasks now — the pattern maker can be asked for the pattern PDF on a line.
    const designer = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.designer }, { words: 'Made-up: the pattern PDF, size 50', target: { type: 'SALES_ORDER_LINE', lineId: SO2_LINES[0] } }))
    expect(designer.tasks).toBe(1)
    expect(await tasksOf((await askRow(designer.ask.id)).taskIds)).toEqual([expect.objectContaining({ assigneeId: PEOPLE.designer, status: 'OPEN' })])
    const row = await askRow(asked.ask.id)
    expect(await tasksOf(row.taskIds)).toEqual([expect.objectContaining({ assigneeId: PEOPLE.planner, status: 'OPEN', recordId: SO2 })])
    const blind = await no('owner', 'POST', asks(SO2), askBody({ kind: 'PERSON', userId: PEOPLE.betaOwner }), 409)
    expect(paths(blind)).toEqual(['fileAsk/PERSON_CANNOT_SEE'])
    expect(blind.message).toBe('Made-up betaOwner cannot see this order.')
    const noPrices = await no('owner', 'POST', asks(SO2), askBody({ kind: 'PERSON', userId: PEOPLE.sales }, { priced: true }), 409)
    expect(paths(noPrices)).toEqual(['fileAsk/PERSON_NO_PRICES'])
    // A priced ask's Task never carries its words.
    const priced = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.owner }, { priced: true, words: 'Made-up: the proforma with unit prices' }))
    const [task] = await tasksOf((await askRow(priced.ask.id)).taskIds)
    expect(task!.title).toBe('Carica: un file con prezzi')
  })

  it('Sales may ask, but never for a file with prices (403); body data only with the measurements right', async () => {
    expect((await made('sales', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))).tasks).toBe(1)
    const error = await no('sales', 'POST', asks(SO2), askBody({ kind: 'PERSON', userId: PEOPLE.owner }, { priced: true }), 403)
    expect(error.message).toBe('Shown to people who see prices.')
  })

  it('the floor: only on a work order, never prices or body data (400); a team of the work order’s plant gets no Task', async () => {
    expect(paths(await no('owner', 'POST', asks(SO2), askBody({ kind: 'FLOOR_TEAM', teamId: TEAM_A1 }), 400))).toEqual(['fileAsk/FLOOR_NEEDS_WORK_ORDER'])
    expect(paths(await no('owner', 'POST', asks(SO2), floorBody({ priced: true }), 400))).toEqual(['fileAsk/FLOOR_NO_PRICES'])
    expect(paths(await no('owner', 'POST', asks(SO2), floorBody({ who: { kind: 'STEP' }, bodyData: true }), 400))).toEqual(['fileAsk/FLOOR_NO_BODY_DATA'])
    expect(paths(await no('owner', 'POST', asks(SO2), floorBody({ who: { kind: 'STEP' }, target: { type: 'WORK_ORDER', workOrderId: WO1 } }), 400))).toEqual(['fileAsk/STEP_NEEDS_STEP'])
    const team = await made('owner', SO2, floorBody())
    expect(team).toMatchObject({ tasks: 0, ask: { status: 'OPEN' } })
    expect(await askRow(team.ask.id)).toMatchObject({ addressee: 'FLOOR_TEAM', taskIds: [] })
    expect((await made('owner', SO2, floorBody({ who: { kind: 'STEP' } }))).tasks).toBe(0)
    // Where it lands, by place: a line of another order, a work order not of this order, a step of another work order.
    expect(paths(await no('owner', 'POST', asks(beta.salesOrderId), askBody({ kind: 'PERSON', userId: PEOPLE.owner }, { target: { type: 'SALES_ORDER_LINE', lineId: SO2_LINES[0] } }), 400))).toEqual(['body/target/lineId'])
    expect(paths(await no('owner', 'POST', asks(beta.salesOrderId), floorBody(), 400))).toEqual(['body/target/workOrderId'])
    expect(paths(await no('owner', 'POST', asks(SO2), floorBody({ target: { type: 'WORK_ORDER', workOrderId: WO1, operationId: WO2_PACK } }), 400))).toEqual(['body/target/operationId'])
    // A line of this order takes the ask.
    expect((await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }, { target: { type: 'SALES_ORDER_LINE', lineId: SO2_LINES[1] } }))).ask.status).toBe('OPEN')
  })

  it('no new ask on a closed or cancelled order (409, L1); a due day before today and blank words are refused by place', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      const error = await no('owner', 'POST', asks(await betaOrderIn(status)), askBody({ kind: 'PERSON', userId: PEOPLE.owner }), 409)
      expect(paths(error), status).toEqual(['fileAsk/ORDER_CLOSED'])
      expect(error.message).toBe('This order is closed: no new asks.')
    }
    expect(paths(await no('owner', 'POST', asks(SO2), askBody({ kind: 'PERSON', userId: PEOPLE.owner }, { dueOn: '2026-01-02' }), 400))).toEqual(['body/dueOn'])
    expect(paths(await no('owner', 'POST', asks(SO2), askBody({ kind: 'PERSON', userId: PEOPLE.owner }, { words: '   ' }), 400))).toEqual(['body/words'])
  })

  it('the brand wall: Beta’s Owner gets Alpha’s order as an unknown one; Alpha’s ask through Beta’s order is not found', async () => {
    const unknown = await no('betaOwner', 'POST', asks(randomUUID()), askBody({ kind: 'PERSON', userId: PEOPLE.betaOwner }), 404)
    const alphas = await no('betaOwner', 'POST', asks(SO2), askBody({ kind: 'PERSON', userId: PEOPLE.betaOwner }), 404)
    expect(alphas.message).toBe(unknown.message)
    expect(alphas.message).toBe('Sales order not found.')
    const ask = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))
    for (const [method, tail, body] of [
      ['PATCH', '', { version: 1, words: 'Made-up: other words' }],
      ['POST', '/reassign', { version: 1, who: { kind: 'PERSON', userId: PEOPLE.owner } }],
      ['POST', '/cancel', { version: 1, reason: 'Made-up: not needed.' }],
    ] as const) {
      expect((await no('betaOwner', method, `${asks(SO2)}/${ask.ask.id}${tail}`, body, 404)).message, tail).toBe('Sales order not found.')
      expect((await no('owner', method, `${asks(beta.salesOrderId)}/${ask.ask.id}${tail}`, body, 404)).message, tail).toBe('File ask not found.')
    }
  })
})

// =================================================================================================================================
describe('S2.1 change, reassign, cancel', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('change: the words and the due day while OPEN; the open Tasks follow; a stale version is refused', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'OFFICE_ROLE', roleId: ROLES.three }))
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    const changed = await ok('owner', 'PATCH', `${asks(SO2)}/${ask.ask.id}`, { version: 1, words: 'Made-up: the countersigned confirmation', dueOn: due })
    expect(changed).toMatchObject({ ask: { version: 2, status: 'OPEN' } })
    const row = await askRow(ask.ask.id)
    expect(row).toMatchObject({ words: 'Made-up: the countersigned confirmation', dueOn: due })
    for (const task of await tasksOf(row.taskIds)) expect(task).toMatchObject({ title: 'Carica: Made-up: the countersigned confirmation', dueDate: due })
    expect((await outbox(ask.ask.id)).map((event) => event.payload.change ?? event.type)).toEqual(['file_ask.asked', 'WORDS', 'DUE'])
    await no('owner', 'PATCH', `${asks(SO2)}/${ask.ask.id}`, { version: 1, words: 'Made-up: stale' }, 409)
    expect(paths(await no('owner', 'PATCH', `${asks(SO2)}/${ask.ask.id}`, { version: 2 }, 400))).toEqual(['body/words'])
  })

  it('reassign: the open Tasks cancelled, new ones written for the new people; the same addressee is refused', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))
    const before = (await askRow(ask.ask.id)).taskIds
    const moved = await ok('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/reassign`, { version: 1, who: { kind: 'OFFICE_ROLE', roleId: ROLES.three }, reason: 'Made-up: the planner is away' })
    expect(moved).toMatchObject({ ask: { version: 2, status: 'OPEN' }, tasks: 4 })
    expect((await tasksOf(before)).map((task) => task.status)).toEqual(['CANCELLED'])
    const after = await askRow(ask.ask.id)
    expect(after).toMatchObject({ addressee: 'OFFICE_ROLE', addresseeRoleId: ROLES.three, addresseeUserId: null })
    expect((await tasksOf(after.taskIds)).every((task) => task.status === 'OPEN')).toBe(true)
    expect(paths(await no('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/reassign`, { version: 2, who: { kind: 'OFFICE_ROLE', roleId: ROLES.three } }, 400))).toEqual(['body/who'])
    // To the floor on an ask that lands on the order itself: refused (400).
    expect(paths(await no('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/reassign`, { version: 2, who: { kind: 'FLOOR_TEAM', teamId: TEAM_A1 } }, 400))).toEqual(['fileAsk/FLOOR_NEEDS_WORK_ORDER'])
    expect((await audits(ask.ask.id)).map((entry) => [entry.action, entry.reason])).toEqual([['files.fileAsk.make', null], ['files.fileAsk.reassign', 'Made-up: the planner is away']])
  })

  it('cancel: with a reason of 3 to 500; the open Tasks cancelled; then final (NOT_OPEN) — an ask is never deleted', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))
    expect(paths(await no('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/cancel`, { version: 1, reason: 'ab' }, 400))).toEqual(['body/reason'])
    expect(await ok('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/cancel`, { version: 1, reason: 'Made-up: we found it ourselves.' })).toMatchObject({ ask: { version: 2, status: 'CANCELLED' } })
    const row = await askRow(ask.ask.id)
    expect(row.status).toBe('CANCELLED')
    expect((await tasksOf(row.taskIds)).map((task) => task.status)).toEqual(['CANCELLED'])
    expect((await outbox(ask.ask.id)).at(-1)).toMatchObject({ type: 'file_ask.changed', payload: { change: 'CANCELLED', status: 'CANCELLED' } })
    expect(paths(await no('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/cancel`, { version: 2, reason: 'Made-up: again.' }, 409))).toEqual(['fileAsk/NOT_OPEN'])
    expect(paths(await no('owner', 'PATCH', `${asks(SO2)}/${ask.ask.id}`, { version: 2, words: 'Made-up: late words' }, 409))).toEqual(['fileAsk/NOT_OPEN'])
  })
})

// =================================================================================================================================
describe('S2.1 the Restrict keys in words (lead): a line or a step a file ask names stays', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an amendment that leaves out a line a file ask lands on is refused in words, before any write', async () => {
    const order = await alphaOrder(`PO-OF031-${run}`)
    await made('owner', order.id, askBody({ kind: 'PERSON', userId: PEOPLE.planner }, { target: { type: 'SALES_ORDER_LINE', lineId: order.lines[1]!.id } }))
    const review = await ok('owner', 'POST', `/sales/orders/${order.id}/amendments/preview`, { version: order.version, reason: 'Made-up: the customer dropped the second colour.', lines: [{ id: order.lines[0]!.id }] })
    expect(review.ok).toBe(false)
    expect(JSON.stringify(review.problems)).toContain(`Line ${order.lines[1]!.seq} is referred to by a file ask`)
  })

  it('a draft’s operations never lose a step a file ask names (409 in words)', async () => {
    // of-fx5s (W-04): the floor is never asked on a DRAFT work order; an ask to an office person names the draft's step here.
    await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }, { words: 'Made-up: photos of step 40', fileKind: 'PHOTO', target: { type: 'WORK_ORDER', workOrderId: WO2, operationId: WO2_PACK } }))
    const workOrder = await one<{ number: string; siteId: string; styleRevisionId: string }>(`SELECT number, "siteId", "styleRevisionId" FROM "WorkOrder" WHERE id = $1`, [WO2])
    const stored = await admin<Json>(`SELECT o.seq, o."routingSeq", o.code, o.name, o."standardMinutes"::text AS minutes, o."scanRequired", o."workCentreId", c.kind::text AS kind, c.code AS "centreCode" FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1 ORDER BY o.seq`, [WO2])
    // The routing without step 40 (the one the ask names): the sync would remove it.
    const planned = stored.filter((op) => op.seq !== 40).map((op) => ({ seq: op.seq, routingSeq: op.routingSeq, stepId: randomUUID(), code: op.code, name: op.name, standardMinutes: op.minutes, scanRequired: op.scanRequired, workCentreKind: op.kind, workCentreId: op.workCentreId, workCentreCode: op.centreCode }))
    const caller = callerFor(h.database, { audience: 'office', tenantId: T, actorId: PEOPLE.owner, requestId: `of031-${run}`, grants: grantsOf('owner') })
    const refusal = { doing: 'Changing the revision', then: 'change the revision', published: 'keep this revision, or cancel the work order and make a new one on the other revision' }
    await expect(command(caller, { name: 'production.testSync', input: {} }, async (tools) => syncDraftOperations(tools.tx, { id: WO2, number: workOrder.number, siteId: workOrder.siteId }, workOrder.styleRevisionId, planned, PEOPLE.owner, refusal))).rejects.toThrow(
      /Changing the revision would take away an operation of work order .* that a file ask names: Op 40 .*A file ask keeps the step it names, so that operation stays/,
    )
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "WorkOrderOperation" WHERE id = $1`, [WO2_PACK])).n).toBe(1)
  })
})

// =================================================================================================================================
describe('S2.2 answer, accept, ask again, chase', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const url = (askId: string, tail: string) => `${asks(SO2)}/${askId}/${tail}`
  const held = async (recordType: string, recordId: string): Promise<string> => {
    const id = await fileOf(recordType, recordId)
    await force(`UPDATE "StoredFile" SET status = 'QUARANTINED', "quarantineReason" = 'scan_pending', "scanStatus" = 'PENDING', "availableAt" = NULL WHERE id = $1`, [id])
    return id
  }

  it('answer: only files of the record the ask lands on; a file the scan found something in is refused', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))
    const lineFile = await fileOf('SalesOrderLine', SO2_LINES[0])
    expect(paths(await no('owner', 'POST', url(ask.ask.id, 'answer'), { version: 1, fileIds: [lineFile] }, 409))).toEqual(['fileAsk/FILE_NOT_OF_TARGET'])
    expect(paths(await no('owner', 'POST', url(ask.ask.id, 'answer'), { version: 1, fileIds: [beta.fileId] }, 409))).toEqual(['fileAsk/FILE_NOT_OF_TARGET'])
    const infected = await fileOf('SalesOrder', SO2)
    await force(`UPDATE "StoredFile" SET status = 'QUARANTINED', "quarantineReason" = 'scan_pending', "scanStatus" = 'INFECTED', "scannedAt" = now(), "scanEngine" = 'Made-up scanner', "scanFinding" = 'Made-up.Signature' WHERE id = $1`, [infected])
    expect(paths(await no('owner', 'POST', url(ask.ask.id, 'answer'), { version: 1, fileIds: [infected] }, 409))).toEqual(['fileAsk/FILE_INFECTED'])
    // Beta's Owner never reaches it.
    expect((await no('betaOwner', 'POST', url(ask.ask.id, 'answer'), { version: 1, fileIds: [lineFile] }, 404)).message).toBe('Sales order not found.')
  })

  it('answer with a held file → ARRIVED (Tasks done, the asker’s Check task); accept 409 FILES_HELD until the scan cleared it', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }))
    const uploadTasks = (await askRow(ask.ask.id)).taskIds
    const clean = await fileOf('SalesOrder', SO2)
    const waiting = await held('SalesOrder', SO2)
    expect(await ok('planner', 'POST', url(ask.ask.id, 'answer'), { version: 1, fileIds: [clean, waiting] })).toMatchObject({ ask: { version: 2, status: 'ARRIVED' } })
    const row = await askRow(ask.ask.id)
    expect(row.fileIds.sort()).toEqual([clean, waiting].sort())
    expect((await tasksOf(uploadTasks)).map((task) => task.status)).toEqual(['DONE'])
    const [check] = await tasksOf([row.checkTaskId])
    expect(check).toMatchObject({ assigneeId: PEOPLE.owner, status: 'OPEN', title: 'Controlla: Made-up: the signed order confirmation', recordId: SO2 })
    const refusal = await no('owner', 'POST', url(ask.ask.id, 'accept'), { version: 2 }, 409)
    expect(paths(refusal)).toEqual(['fileAsk/FILES_HELD'])
    expect(refusal.message).toBe('1 file is still being checked by the virus scan: accept once the check is done.')
    await force(`UPDATE "StoredFile" SET status = 'AVAILABLE', "scanStatus" = 'CLEAN', "quarantineReason" = NULL, "availableAt" = now(), "scannedAt" = now() WHERE id = $1`, [waiting])
    expect(await ok('owner', 'POST', url(ask.ask.id, 'accept'), { version: 2 })).toMatchObject({ ask: { version: 3, status: 'ACCEPTED' } })
    expect((await tasksOf([row.checkTaskId])).map((task) => task.status)).toEqual(['DONE'])
    expect((await outbox(ask.ask.id)).map((event) => [event.type, event.payload.decision ?? null])).toEqual([['file_ask.asked', null], ['file_ask.arrived', null], ['file_ask.decided', 'ACCEPTED']])
    // Final: nothing more.
    expect(paths(await no('owner', 'POST', url(ask.ask.id, 'ask-again'), { version: 3, reason: 'Made-up: late.' }, 409))).toEqual(['fileAsk/NOT_ARRIVED'])
  })

  it('ask again: OPEN with its reason, rounds 1, the addressees’ Tasks open again, the check task done, the files stay on the order', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'OFFICE_ROLE', roleId: ROLES.three }))
    const file = await fileOf('SalesOrder', SO2)
    await ok('p1', 'POST', url(ask.ask.id, 'answer'), { version: 1, fileIds: [file] })
    expect(paths(await no('owner', 'POST', url(ask.ask.id, 'ask-again'), { version: 2, reason: 'no' }, 400))).toEqual(['body/reason'])
    expect(await ok('owner', 'POST', url(ask.ask.id, 'ask-again'), { version: 2, reason: 'Made-up: the wrong size, we need 50.' })).toMatchObject({ ask: { version: 3, status: 'OPEN' } })
    const row = await askRow(ask.ask.id)
    expect(row).toMatchObject({ status: 'OPEN', fileIds: [], rounds: 1, lastReason: 'Made-up: the wrong size, we need 50.' })
    expect((await tasksOf(row.taskIds)).every((task) => task.status === 'OPEN')).toBe(true)
    expect((await tasksOf([row.checkTaskId])).map((task) => task.status)).toEqual(['DONE'])
    expect((await one<Json>(`SELECT status::text AS status, "recordId" FROM "StoredFile" WHERE id = $1`, [file]))).toEqual({ status: 'AVAILABLE', recordId: SO2 })
    // The second round arrives again.
    await ok('p2', 'POST', url(ask.ask.id, 'answer'), { version: 3, fileIds: [await fileOf('SalesOrder', SO2)] }, 200)
    expect((await askRow(ask.ask.id)).status).toBe('ARRIVED')
  })

  it('a priced ask: Sales can neither accept nor answer it (403); its chase note never carries its words', async () => {
    const ask = await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.owner }, { priced: true, words: 'Made-up: the proforma at 41.50 a jacket' }))
    expect((await no('sales', 'POST', url(ask.ask.id, 'chase'), { version: 1 }, 403)).message).toBe('Shown to people who see prices.')
    expect(await ok('owner', 'POST', url(ask.ask.id, 'chase'), { version: 1 })).toMatchObject({ ask: { version: 2, status: 'OPEN' } })
    const note = await one<Json>(
      `SELECT m."bodyText", m."mentionedUserIds"::text[] AS mentions FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1`,
      [SO2],
    )
    expect(note.bodyText).toMatch(/^Chiedi un aggiornamento: un file con prezzi, entro il /)
    expect(note.bodyText).not.toContain('41.50')
    expect(note.mentions).toEqual([PEOPLE.owner])
    expect((await askRow(ask.ask.id)).lastChasedAt).not.toBeNull()
    await ok('owner', 'POST', url(ask.ask.id, 'answer'), { version: 2, fileIds: [await fileOf('SalesOrder', SO2)] })
    expect((await no('sales', 'POST', url(ask.ask.id, 'accept'), { version: 3 }, 403)).message).toBe('Shown to people who see prices.')
  })

  it('chase a floor ask: its chase time only — no note, nobody named', async () => {
    const ask = await made('owner', SO2, floorBody())
    const notes = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1`, [SO2])).n
    const before = await notes()
    await ok('owner', 'POST', url(ask.ask.id, 'chase'), { version: 1 })
    expect(await notes()).toBe(before)
    expect((await askRow(ask.ask.id)).lastChasedAt).not.toBeNull()
    expect((await outbox(ask.ask.id)).at(-1)).toMatchObject({ type: 'file_ask.changed', payload: { change: 'CHASED', workOrderId: WO1 } })
    // The office answers a floor ask with a file of the work order, as anyone who adds files there may.
    expect(await ok('owner', 'POST', url(ask.ask.id, 'answer'), { version: 2, fileIds: [await fileOf('WorkOrder', WO1)] })).toMatchObject({ ask: { status: 'ARRIVED' } })
  })
})

// =================================================================================================================================
describe('B-OF-035 the "Ask for a file…" window’s choices', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const choicesOf = (orderId: string) => `/sales/orders/${orderId}/file-asks/choices`

  it('Sales reads them: people, office roles, the floor’s teams and roles of the order’s plants, lines, work orders and steps', async () => {
    const choices = await ok('sales', 'GET', choicesOf(SO2))
    const people = (choices.people as Json[]).map((row) => row.id)
    for (const person of ['owner', 'planner', 'designer', 'p1', 'alphaOnly'] as const) expect(people, person).toContain(PEOPLE[person])
    // Beta's Owner reaches no Alpha order: never offered on it.
    expect(people).not.toContain(PEOPLE.betaOwner)
    expect((choices.officeRoles as Json[]).map((row) => row.id)).toContain(ROLES.three)
    expect((choices.teams as Json[]).find((row) => row.id === TEAM_A1)).toMatchObject({ siteId: sid('site:A1') })
    expect((choices.lines as Json[]).map((row) => row.id).sort()).toEqual([...SO2_LINES].sort())
    const workOrder = (choices.workOrders as Json[]).find((row) => row.id === WO1)!
    expect(workOrder).toMatchObject({ siteId: sid('site:A1') })
    expect((workOrder.steps as Json[]).map((step) => step.id)).toContain(WO1_SEW)
    // of-fx5s (W-04): each work order's status (a floor ask needs one on the floor); (W-08): each office role's reach, a number.
    expect(workOrder.status).toBe('IN_PROGRESS')
    expect((choices.workOrders as Json[]).find((row) => row.id === WO2)?.status).toBe('DRAFT')
    const reachOf = (roles: Json[], roleId: string): unknown => roles.find((row) => row.id === roleId)?.reach
    expect(reachOf(choices.officeRoles, ROLES.three)).toBe(4)
    expect(reachOf(choices.officeRoles, ROLES.alpha)).toBe(1)
    for (const role of choices.officeRoles as Json[]) expect(role.reach, role.name).toBeGreaterThan(0)
    // On Beta's order the Alpha-limited holder falls out (3), and the Alpha-only role reaches nobody: not offered.
    const onBeta = await ok('owner', 'GET', choicesOf(beta.salesOrderId))
    expect(reachOf(onBeta.officeRoles, ROLES.three)).toBe(3)
    expect(reachOf(onBeta.officeRoles, ROLES.alpha)).toBeUndefined()
    for (const role of choices.floorRoles as Json[]) expect(role.siteIds.length).toBeGreaterThan(0)
    expect(choices.truncated).toBe(false)
    // Never a floor worker's name, never a count per worker.
    const text = JSON.stringify(choices)
    for (const row of await admin<{ displayName: string }>(`SELECT "displayName" FROM "Worker" WHERE "tenantId" = $1`, [T])) expect(text).not.toContain(row.displayName)
    expect(text).not.toMatch(/"members?"|"count"/)
  })

  it('on Beta’s order Alpha’s planner gets the unknown order’s words; Beta’s Owner on Alpha’s order too', async () => {
    const unknown = await no('alphaOnly', 'GET', choicesOf(randomUUID()), undefined, 404)
    expect((await no('alphaOnly', 'GET', choicesOf(beta.salesOrderId), undefined, 404)).message).toBe(unknown.message)
    expect((await no('betaOwner', 'GET', choicesOf(SO2), undefined, 404)).message).toBe('Sales order not found.')
  })
})

// ---- of-fx5s (W-04, the look-only walk): the floor is asked only on a work order on the floor (released, not finished) ----------
describe('of-fx5s W-04: a floor ask needs a released work order that is still running', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const NOT_ON_FLOOR = 'This work order is not on the floor: a floor ask needs a released work order that is still running.'
  const statusOf = async (workOrderId: string): Promise<string> => (await one<{ status: string }>(`SELECT status::text AS status FROM "WorkOrder" WHERE id = $1`, [workOrderId])).status
  const refusedOffFloor = async (method: Method, url: string, body: unknown, label: string) => {
    const error = await no('owner', method, url, body, 409)
    expect(paths(error), label).toEqual(['fileAsk/WORK_ORDER_NOT_ON_FLOOR'])
    expect(error.message, label).toBe(NOT_ON_FLOOR)
  }

  it('on a DRAFT work order: a team, a step and a floor role are refused in words (409); an office person may still be asked there', async () => {
    expect(await statusOf(WO2)).toBe('DRAFT')
    const onDraft = { target: { type: 'WORK_ORDER', workOrderId: WO2, operationId: WO2_PACK } }
    const floorRole = await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND audience = 'FLOOR' AND "archivedAt" IS NULL ORDER BY key LIMIT 1`, [T])
    expect(floorRole, 'a floor role of the seeds').toBeDefined()
    for (const who of [{ kind: 'FLOOR_TEAM', teamId: TEAM_A1 }, { kind: 'STEP' }, { kind: 'FLOOR_ROLE', roleId: floorRole.id }]) await refusedOffFloor('POST', asks(SO2), floorBody({ who, ...onDraft }), who.kind)
    expect((await made('owner', SO2, askBody({ kind: 'PERSON', userId: PEOPLE.planner }, { fileKind: 'PHOTO', ...onDraft }))).ask.status).toBe('OPEN')
  })

  it('on a running one it passes (WO-0001, IN_PROGRESS); once COMPLETED a floor ask is neither made, changed nor reassigned to the floor — to the office it may be', async () => {
    expect(await statusOf(WO1)).toBe('IN_PROGRESS')
    const ask = await made('owner', SO2, floorBody())
    expect(ask).toMatchObject({ tasks: 0, ask: { status: 'OPEN' } })
    await force(`UPDATE "WorkOrder" SET status = 'COMPLETED' WHERE id = $1`, [WO1])
    try {
      await refusedOffFloor('POST', asks(SO2), floorBody(), 'make')
      await refusedOffFloor('PATCH', `${asks(SO2)}/${ask.ask.id}`, { version: 1, words: 'Made-up: other photos' }, 'change')
      await refusedOffFloor('POST', `${asks(SO2)}/${ask.ask.id}/reassign`, { version: 1, who: { kind: 'STEP' } }, 'reassign')
      expect((await askRow(ask.ask.id)).version).toBe(1)
      // To an office person the work order's state does not matter.
      expect(await ok('owner', 'POST', `${asks(SO2)}/${ask.ask.id}/reassign`, { version: 1, who: { kind: 'PERSON', userId: PEOPLE.planner } })).toMatchObject({ ask: { version: 2, status: 'OPEN' }, tasks: 1 })
    } finally {
      await force(`UPDATE "WorkOrder" SET status = 'IN_PROGRESS' WHERE id = $1`, [WO1])
    }
  })
})
// ---- end of-fx5s
