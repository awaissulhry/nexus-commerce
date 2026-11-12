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
import { warehouseTaskHandlers } from '../tasks/handlers'

/**
 * Pick lists by bin and substitutes with a yes on the local stack (B-W2b-298; SCM-212, MES-139; follow-up PK1:01), through the
 * app's real routes on the whole made-up seed (packages/factory-db/seed: plant A1's store A1-STORE with its bins, SEED-WO-0001 of
 * SEED-JKT-02 r1 — lining SEED-LIN-200 grey 13.23 m planned, 120 m in A1-STORE-01; protector SEED-PRO-300, a PPE component, 14
 * planned and none in stock; B-W2b-277's three made-up substitutes of the lining). Made up here, through the owner login: the
 * revision's alternates (lining SEED-LIN-210 "only when short", protector SEED-PRO-310 "with approval" and its certificate
 * check), their lots in the pick face and the bulk rack, office people and an approval rule for PPE substitutes.
 *   - the pick list by bin: the walk in the order of the site's bins, reserved before proposed, held stock said in words, the
 *     walk of several work orders, the PICK task naming the walk's first bin, the floor's walk of its own site only;
 *   - "Use a substitute": the dialog's answers with the work order's facts (only when short, outside its certificate, who would
 *     approve), the ask's refusals in words, approved at once when nobody's yes is needed, waiting for the rule's approver who is
 *     never the asker, the no with its words, the withdrawal;
 *   - the issue of an approved substitute with its own move (office and the tablet's queue), the pick list after it.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/pick-lists/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'pick-subs'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b298-${run}-${++keys}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })

const A = { tenant: '', companyA: '', siteA1: '', siteB1: '', worker: '', device: '', b1Device: '', b1Worker: '' }
const PEOPLE = { picker: newId(), approver: newId(), boss: newId() }
const W = { wo1: '', wo3: '', revision: '', line20: '', line30: '' }
const I = { lining: '', grey: '', liningAlt: '', protector: '', protectorAlt: '' }
const P = { store01: '', pickFace: '', bulk: '' }
const L = { altLining: '', altLiningQuarantine: '', altProtector: '' }
let SESSIONS: Record<string, SessionContext> = {}

const FLOOR: Permission[] = ['floor.work', 'inventory.issue', 'inventory.transfer']
const OFFICE: Permission[] = ['inventory.issue', 'inventory.stock.view', 'inventory.reserve', 'inventory.locations.view', 'workorders.view', 'approvals.view', 'approvals.request', 'approvals.decide', 'reasons.view']

const call = (session: string, method: Method, url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const system = () => callerFor(database, systemContext(A.tenant, `w2b298-${run}`))
const floorCaller = () => callerFor(database, { ...SESSIONS.tablet!, requestId: newId() } as RequestContext)

async function outbox(type: string, subject?: string): Promise<EventEnvelope[]> {
  const rows = await admin<Json>(
    `SELECT id, type, version, context, "tenantId", "companyId", "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ${subject ? 'AND subject = $3' : ''} ORDER BY "occurredAt", id`,
    subject ? [A.tenant, type, subject] : [A.tenant, type],
  )
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}

/** A made-up lot with OPENING stock at a place (the owner login: no screen makes opening stock of a lot). */
async function addLot(itemId: string, colourId: string | null, code: string, quantity: string, locationId: string, quality = 'RELEASED'): Promise<string> {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViStatus", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::"LotQualityStatus", CASE WHEN $8::text = 'QUARANTINE' THEN NULL ELSE now() END, false, 'NOT_REQUIRED', now() - interval '20 days')`,
    [lotId, A.tenant, A.companyA, A.siteA1, itemId, colourId, code, quality],
  )
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", note)
     SELECT $1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, i."baseUom", $9, $10, now() - interval '30 days', 'Made-up opening stock' FROM "Item" i WHERE i.id = $5`,
    [newId(), A.tenant, A.companyA, A.siteA1, itemId, colourId, lotId, locationId, quantity, `w2b298-${run}-${lotId}`],
  )
  return lotId
}

const ask = (extra: Json) => ({ workOrderId: W.wo1, reason: 'Made-up: the own material is late', ...extra })

beforeAll(async () => {
  db = await migratedDatabase('pick_bin_substitute')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  const a1 = await one<Json>(`SELECT s.id, s."tenantId", s."companyId" FROM "Site" s JOIN "Tenant" t ON t.id = s."tenantId" WHERE s.code = 'A1' ORDER BY t.slug LIMIT 1`)
  Object.assign(A, { tenant: a1.tenantId, companyA: a1.companyId, siteA1: a1.id, siteB1: (await one<Json>(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND code = 'B1'`, [a1.tenantId])).id })
  A.worker = (await one<Json>(`SELECT id FROM "Worker" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY "displayName", id LIMIT 1`, [A.tenant, A.siteA1])).id
  A.device = (await one<Json>(`SELECT id FROM "Device" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY id LIMIT 1`, [A.tenant, A.siteA1])).id
  const b1Device = await admin<Json>(`SELECT id FROM "Device" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY id LIMIT 1`, [A.tenant, A.siteB1])
  const b1Worker = await admin<Json>(`SELECT id FROM "Worker" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY id LIMIT 1`, [A.tenant, A.siteB1])
  A.b1Device = b1Device[0]?.id ?? newId()
  A.b1Worker = b1Worker[0]?.id ?? newId()
  const wo = await one<Json>(`SELECT id, "styleRevisionId" FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [A.tenant])
  Object.assign(W, { wo1: wo.id, revision: wo.styleRevisionId, wo3: (await one<Json>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0003'`, [A.tenant])).id })
  const lineOf = async (seq: number) => (await one<Json>(`SELECT id, "itemId" FROM "BomLine" WHERE "revisionId" = $1 AND seq = $2`, [W.revision, seq]))
  const l20 = await lineOf(20)
  const l30 = await lineOf(30)
  const item = async (code: string) => (await one<Json>(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2`, [A.tenant, code])).id as string
  Object.assign(W, { line20: l20.id, line30: l30.id })
  Object.assign(I, { lining: l20.itemId, protector: l30.itemId, liningAlt: await item('SEED-LIN-210'), protectorAlt: await item('SEED-PRO-310') })
  I.grey = (await one<Json>(`SELECT id FROM "ItemColour" WHERE "itemId" = $1 AND code = 'GRY'`, [I.lining])).id
  const place = async (code: string) => (await one<Json>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = $2`, [A.tenant, code])).id as string
  Object.assign(P, { store01: await place('A1-STORE-01'), pickFace: await place('A1-PF-01'), bulk: await place('A1-BULK-01') })
  // The released revision's alternates (no route writes a released BOM: its guard is off for this made-up set-up only).
  await admin(`SET session_replication_role = replica`)
  await admin(`INSERT INTO "BomLineAlternate" (id, "tenantId", "revisionId", "bomLineId", priority, "itemId", qty, "allowedWhen", "certificateCheck", note) VALUES ($1, $2, $3, $4, 1, $5, NULL, 'WHEN_SHORT', false, 'Made-up')`, [newId(), A.tenant, W.revision, W.line20, I.liningAlt])
  await admin(`INSERT INTO "BomLineAlternate" (id, "tenantId", "revisionId", "bomLineId", priority, "itemId", qty, "allowedWhen", "certificateCheck", note) VALUES ($1, $2, $3, $4, 1, $5, NULL, 'WITH_APPROVAL', true, 'Made-up')`, [newId(), A.tenant, W.revision, W.line30, I.protectorAlt])
  await admin(`SET session_replication_role = DEFAULT`)
  L.altLining = await addLot(I.liningAlt, null, `W298-LIN-${run}`, '30', P.bulk)
  L.altLiningQuarantine = await addLot(I.liningAlt, null, `W298-LINQ-${run}`, '10', P.bulk, 'QUARANTINE')
  L.altProtector = await addLot(I.protectorAlt, null, `W298-PRO-${run}`, '20', P.pickFace)
  const NAMES = { picker: 'Made-up Picker', approver: 'Made-up Approver', boss: 'Made-up Boss' }
  for (const [person, userId] of Object.entries(PEOPLE) as Array<[keyof typeof PEOPLE, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, A.tenant, `w2b298-${person}-${run}@example.com`, NAMES[person]])
  }
  const floor = (workerId: string, siteId: string, deviceId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: workerId, siteId, deviceId, grants: [grant(FLOOR, { companies: [A.companyA], sites: [siteId] })] })
  SESSIONS = {
    tablet: floor(A.worker, A.siteA1, A.device),
    b1tablet: floor(A.b1Worker, A.siteB1, A.b1Device),
    picker: { audience: 'office', tenantId: A.tenant, actorId: PEOPLE.picker, grants: [grant(OFFICE)] },
    approver: { audience: 'office', tenantId: A.tenant, actorId: PEOPLE.approver, grants: [grant(OFFICE)] },
    boss: { audience: 'office', tenantId: A.tenant, actorId: PEOPLE.boss, grants: [grant([...OFFICE, 'inventory.issue.over'])] },
    viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['inventory.stock.view'])] },
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the pick list by bin (SCM-212)', () => {
  it('walks the store in bin order, with the lot to take and its quality', async () => {
    const walk = await ok('picker', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`)
    expect(walk.workOrders).toHaveLength(1)
    const lining = walk.workOrders[0].lines.find((line: Json) => line.itemCode === 'SEED-LIN-200')
    // The seeded approved substitute (4 m) counts against what is still to pick of the line.
    expect(lining).toMatchObject({ colourCode: 'GRY', toIssue: '13.2300', substituted: '4.0000', toPick: '9.2300', covered: false })
    expect(lining.substitutes.map((sub: Json) => sub.status).sort()).toEqual(['APPROVED', 'WAITING'])
    const stops = walk.stops.filter((stop: Json) => stop.itemCode === 'SEED-LIN-200')
    expect(stops).toEqual([expect.objectContaining({ source: 'PROPOSED', lotCode: 'SEED-LOT-LIN-01', quantity: '9.2300', quality: 'RELEASED', issuable: true, location: expect.objectContaining({ code: 'A1-STORE-01', path: ['A1-STORE', 'A1-STORE-01'] }) })])
    // Turns follow the bin order; every place once, in order.
    expect(walk.stops.map((stop: Json) => stop.turn)).toEqual(walk.stops.map((_: Json, index: number) => index + 1))
    const ranks = walk.stops.map((stop: Json) => stop.location.rank)
    expect([...ranks].sort((a: number, b: number) => a - b)).toEqual(ranks)
    expect(JSON.stringify(walk)).not.toMatch(/standardCost|unitCost|valueAmount/)
  })

  it('reserved stock comes first and the PICK task names where the walk starts', async () => {
    const created = await ok('picker', 'POST', '/inventory/picking/pick-lists', { siteId: A.siteA1, workOrderIds: [W.wo1] }, 201)
    expect(created.results[0].outcome).toBe('CREATED')
    const walk = await ok('picker', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`)
    const lining = walk.stops.filter((stop: Json) => stop.itemCode === 'SEED-LIN-200')
    expect(lining.map((stop: Json) => [stop.source, stop.location.code])).toEqual([['RESERVED', 'A1-STORE-01']])
    // The task source (the worker's job on inventory.reserved): one PICK task, from the walk's first bin.
    const reserved = (await outbox('inventory.reserved')).filter((event) => (event.payload as Json).workOrderId === W.wo1).at(-1)!
    await warehouseTaskHandlers()[0]!.handle(reserved, { caller: system(), attempt: 1 })
    const task = await one<Json>(`SELECT kind::text, status::text, "fromLocationId", note FROM "WarehouseTask" WHERE "sourceType" = 'WorkOrder' AND "sourceId" = $1 AND status IN ('OPEN', 'TAKEN')`, [W.wo1])
    expect(task).toMatchObject({ kind: 'PICK', status: 'OPEN', fromLocationId: P.store01 })
    expect(task.note).toMatch(/^Pick list of SEED-WO-0001: \d+ places? by bin path, first A1-STORE-01$/)
    expect((await ok('picker', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`)).workOrders[0].task).toMatchObject({ status: 'OPEN' })
  })

  it('walks several work orders in one round; the tablet walks only its own site', async () => {
    const walk = await ok('picker', 'GET', `/inventory/pick-lists/walk?workOrderIds=${W.wo1},${W.wo3}`)
    expect(walk.workOrders.map((order: Json) => order.workOrder.number)).toEqual(['SEED-WO-0001', 'SEED-WO-0003'])
    expect(walk.places.map((place: Json) => place.code)).toEqual([...new Set(walk.stops.map((stop: Json) => stop.location.code))])
    expect((await ok('tablet', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`)).workOrders[0].workOrder.number).toBe('SEED-WO-0001')
    await no('b1tablet', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`, undefined, 404)
    await no('viewer', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`, undefined, 403)
    expect(paths(await no('picker', 'GET', '/inventory/pick-lists/walk?workOrderIds=nope', undefined, 400))).toEqual(['querystring/workOrderIds'])
  })

  // B-W2b-310 (follow-up FT2:01; design floor.pick sec:kit): the tablet stages the kit and checks it complete at its own site.
  it('the tablet stages the kit by the walk\'s version and is held checking it while a line is short; another site\'s tablet finds nothing', async () => {
    const before = (await ok('tablet', 'GET', `/inventory/pick-lists/work-orders/${W.wo3}`)).workOrders[0]
    expect(before.kit).toMatchObject({ version: expect.any(Number) })
    const staged = (await ok('tablet', 'POST', `/inventory/kits/${W.wo3}/stage`, { version: before.kit.version, locationId: P.store01 })).kit
    expect(staged).toMatchObject({ location: { code: 'A1-STORE-01' }, version: before.kit.version + 1 })
    const after = (await ok('tablet', 'GET', `/inventory/pick-lists/work-orders/${W.wo3}`)).workOrders[0]
    expect(after.kit).toMatchObject({ location: { code: 'A1-STORE-01' }, version: before.kit.version + 1 })
    // Kept on the work order's history; the record names the worker (no answer does).
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'WorkOrder' AND "recordId" = $1 AND action = 'inventory.kitStaged'`, [W.wo3])).n).toBeGreaterThanOrEqual(1)
    const short = after.lines.filter((line: Json) => !line.covered).length
    if (short > 0) expect(paths(await no('tablet', 'POST', `/inventory/kits/${W.wo3}/complete`, { version: after.kit.version }, 409))).toEqual(['kit/LINES_SHORT'])
    else {
      await ok('tablet', 'POST', `/inventory/kits/${W.wo3}/complete`, { version: after.kit.version })
      expect(await one<Json>(`SELECT "completedById" FROM "WorkOrderKit" WHERE id = $1`, [W.wo3])).toEqual({ completedById: A.worker })
    }
    await no('b1tablet', 'POST', `/inventory/kits/${W.wo3}/stage`, { version: after.kit.version, locationId: P.store01 }, 404)
    // Reading the kit record and opening it again stay the office's.
    expect((await call('tablet', 'GET', `/inventory/kits/${W.wo3}`)).statusCode).toBeGreaterThanOrEqual(403)
  })
})

describe('use a substitute (MES-139; PK1:01)', () => {
  let protectorSub: Json
  let ruleId = ''

  it("answers the dialog with the work order's facts: only when short, outside the certificate, nobody to approve", async () => {
    const options = await ok('picker', 'GET', `/inventory/substitutions/options?workOrderId=${W.wo1}&bomLineId=${W.line30}`)
    expect(options.line).toMatchObject({ seq: 30, toIssue: '14.0000', short: '14.0000', ownShort: true, material: { code: 'SEED-PRO-300', isPpeComponent: true } })
    const alternate = options.choices.find((choice: Json) => choice.kind === 'ALTERNATE')
    expect(alternate).toMatchObject({ item: { code: 'SEED-PRO-310' }, certificateRequired: true, certificate: null, refusal: { code: 'OUTSIDE_CERTIFICATE' }, mayAsk: false, max: '14.0000', stock: { onHand: '20.0000' } })
    expect(alternate.answer).toMatchObject({ may: false, held: expect.arrayContaining(['NEEDS_APPROVAL', 'NEEDS_CERTIFICATE_CHECK']) })
    const lining = await ok('picker', 'GET', `/inventory/substitutions/options?workOrderId=${W.wo1}&bomLineId=${W.line20}`)
    const whenShort = lining.choices.find((choice: Json) => choice.kind === 'ALTERNATE')
    expect(whenShort).toMatchObject({ refusal: { code: 'ONLY_WHEN_SHORT' }, mayAsk: false })
    // A quarantined lot is listed in words, never usable.
    expect(whenShort.stock.lots.find((lot: Json) => lot.lot?.code === `W298-LINQ-${run}`)).toMatchObject({ usable: false, words: expect.stringContaining('not used until quality releases it') })
    const own = lining.choices.find((choice: Json) => choice.kind === 'OWN_MATERIAL')
    expect(own).toMatchObject({ needsPerson: true, mayAsk: false, held: expect.stringContaining('no approval rule for substitutes is switched on') })
  })

  it('refuses in words: outside its certificate, only when short, not on the line, a lot not usable, more than is open', async () => {
    const protector = ask({ bomLineId: W.line30, toItemId: I.protectorAlt, toLotId: L.altProtector, quantity: '4' })
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', protector, 409))).toEqual(['refusal/OUTSIDE_CERTIFICATE'])
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.liningAlt, quantity: '2' }), 409))).toEqual(['refusal/ONLY_WHEN_SHORT'])
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.protectorAlt, quantity: '2' }), 409))).toEqual(['refusal/NOT_ON_THE_LINE'])
    // Made-up: the lining's alternate becomes "always" (the released BOM's guard off for this one update).
    await admin(`SET session_replication_role = replica`)
    await admin(`UPDATE "BomLineAlternate" SET "allowedWhen" = 'ALWAYS' WHERE "bomLineId" = $1`, [W.line20])
    await admin(`SET session_replication_role = DEFAULT`)
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.liningAlt, toLotId: L.altLiningQuarantine, quantity: '2' }), 409))).toEqual(['refusal/LOT_NOT_USABLE'])
    // 13.23 m still to issue, 8 m standing (the seed's waiting and approved substitutes): at most 5.23 m.
    const tooMuch = await no('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.liningAlt, quantity: '6' }), 409)
    expect(tooMuch.issues[0]).toMatchObject({ path: 'refusal/TOO_MUCH', message: expect.stringContaining('at most 5.2300 M') })
    // Another lot of the own material needs a person: no rule switched on, nobody could decide it.
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.lining, toLotId: L.altLining, quantity: '1' }), 400))).toEqual(['body/toLotId'])
    const ownLot = (await one<Json>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-W36'`, [A.tenant])).id
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.lining, toLotId: ownLot, quantity: '1' }), 409))).toEqual(['refusal/NO_APPROVER'])
    // Nothing was kept of any refused ask.
    expect(await one<Json>(`SELECT count(*)::int AS n FROM "MaterialSubstitution" WHERE "workOrderId" = $1 AND reason = 'Made-up: the own material is late'`, [W.wo1])).toMatchObject({ n: 0 })
  })

  it('approves at once what needs nobody (an ALWAYS alternate) when no rule asks; asked on the floor it names the worker', async () => {
    const asked = await ok('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.liningAlt, toLotId: L.altLining, quantity: '2', reasonCode: 'LATE' }), 201)
    expect(asked).toMatchObject({ approvedAtOnce: true, approval: { asked: false }, substitution: { status: 'APPROVED', kind: 'ALTERNATE', asked: 'OFFICE', replaces: { quantity: '2.0000', uom: 'M' }, ruleAnswer: { may: true, held: [] } } })
    const row = await one<Json>(`SELECT status::text, "decidedAt" IS NOT NULL AS decided, "decidedById", "approvalTaskId", "requestedById" FROM "MaterialSubstitution" WHERE id = $1`, [asked.substitution.id])
    expect(row).toEqual({ status: 'APPROVED', decided: true, decidedById: null, approvalTaskId: null, requestedById: PEOPLE.picker })
    expect((await outbox('inventory.substitution_changed', asked.substitution.id)).map((event) => (event.payload as Json).change)).toEqual(['ASKED', 'APPROVED'])
    const floor = await ok('tablet', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line20, toItemId: I.liningAlt, toLotId: L.altLining, quantity: '1' }), 201)
    expect(floor.substitution).toMatchObject({ status: 'APPROVED', asked: 'FLOOR' })
    expect(await one<Json>(`SELECT "requestedByWorkerId", "requestedById" FROM "MaterialSubstitution" WHERE id = $1`, [floor.substitution.id])).toEqual({ requestedByWorkerId: A.worker, requestedById: null })
    // The office withdraws the tablet's one.
    await ok('picker', 'POST', `/inventory/substitutions/${floor.substitution.id}/withdraw`, { version: floor.substitution.version, reason: 'Made-up: asked twice' })
    expect(paths(await no('picker', 'POST', `/inventory/substitutions/${floor.substitution.id}/withdraw`, { version: floor.substitution.version + 1, reason: 'again' }, 409))).toEqual(['refusal/NOT_WAITING'])
  })

  it('waits for the rule\'s approver, who is never the person who asked; the yes approves it', async () => {
    const certificate = await one<Json>(`SELECT id FROM "Certificate" WHERE "tenantId" = $1 AND number = 'SEED-CERT-0002'`, [A.tenant])
    await admin(`INSERT INTO "CertificateCoverage" (id, "tenantId", "certificateId", "itemId", status, "allowsMadeToMeasure") VALUES ($1, $2, $3, $4, 'ACTIVE', false)`, [newId(), A.tenant, certificate.id, I.protectorAlt])
    const protector = ask({ bomLineId: W.line30, toItemId: I.protectorAlt, toLotId: L.altProtector, quantity: '4' })
    expect(paths(await no('picker', 'POST', '/inventory/substitutions', protector, 409))).toEqual(['refusal/NO_APPROVER'])
    ruleId = newId()
    await admin(
      `INSERT INTO "ApprovalRule" (id, "tenantId", "companyId", kind, name, condition, "approverUserId", active, sequence) VALUES ($1, $2, $3, 'MATERIAL_SUBSTITUTION', 'Made-up: PPE substitutes', $4::jsonb, $5, true, 10)`,
      [ruleId, A.tenant, A.companyA, JSON.stringify({ combinator: 'and', rows: [{ field: 'ppeComponent', operator: 'eq', value: 'YES' }] }), PEOPLE.approver],
    )
    const options = await ok('picker', 'GET', `/inventory/substitutions/options?workOrderId=${W.wo1}&bomLineId=${W.line30}`)
    expect(options.choices.find((choice: Json) => choice.kind === 'ALTERNATE')).toMatchObject({ refusal: null, needsPerson: true, mayAsk: true, certificate: { number: 'SEED-CERT-0002' }, approval: { asks: true, approver: { kind: 'PERSON', name: 'Made-up Approver' } } })
    protectorSub = (await ok('picker', 'POST', '/inventory/substitutions', protector, 201)).substitution
    expect(protectorSub).toMatchObject({ status: 'WAITING', approval: { status: 'PENDING' }, ruleAnswer: { may: false, held: ['NEEDS_APPROVAL'] } })
    const taskId = protectorSub.approval.taskId
    const task = (await ok('picker', 'GET', `/approvals/tasks/${taskId}`)).task
    expect(task).toMatchObject({ kind: 'MATERIAL_SUBSTITUTION', record: { type: 'MaterialSubstitution', id: protectorSub.id }, requester: { kind: 'PERSON', id: PEOPLE.picker } })
    expect(paths(await no('picker', 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version }, 403))).toContain('refusal/OWN_REQUEST')
    // Not issued while it waits.
    expect(paths(await no('picker', 'POST', `/inventory/substitutions/${protectorSub.id}/issue`, {}, 409))).toEqual(['refusal/NOT_APPROVED'])
    await ok('approver', 'POST', `/approvals/tasks/${taskId}/approve`, { version: task.version, comment: 'Made-up: same protection class' })
    const record = await ok('picker', 'GET', `/inventory/substitutions/${protectorSub.id}`)
    expect(record).toMatchObject({ substitution: { status: 'APPROVED' }, decidedById: PEOPLE.approver, requestedById: PEOPLE.picker, mine: true, request: { status: 'APPROVED' } })
    const history = await ok('picker', 'GET', `/approvals/history/MaterialSubstitution/${protectorSub.id}`)
    expect(JSON.stringify(history)).toContain('APPROVED')
    // The approved substitute is on the pick list by bin: its lot in the pick face.
    const walk = await ok('picker', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`)
    expect(walk.stops.filter((stop: Json) => stop.source === 'SUBSTITUTE' && stop.itemCode === 'SEED-PRO-310')).toEqual([expect.objectContaining({ substitutionId: protectorSub.id, lotCode: `W298-PRO-${run}`, quantity: '4.0000', location: expect.objectContaining({ code: 'A1-PF-01' }) })])
  })

  it('a no refuses it with its words; the office withdraws a waiting one with its request', async () => {
    const asked = (await ok('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line30, toItemId: I.protectorAlt, toLotId: L.altProtector, quantity: '2' }), 201)).substitution
    const task = (await ok('approver', 'GET', `/approvals/tasks/${asked.approval.taskId}`)).task
    await ok('approver', 'POST', `/approvals/tasks/${asked.approval.taskId}/reject`, { version: task.version, reasonCode: 'NOT_NEEDED', reason: 'Made-up: the own protectors arrive tomorrow' })
    expect(await one<Json>(`SELECT status::text, "refuseReason", "decidedById" FROM "MaterialSubstitution" WHERE id = $1`, [asked.id])).toEqual({ status: 'REFUSED', refuseReason: 'NOT_NEEDED: Made-up: the own protectors arrive tomorrow', decidedById: PEOPLE.approver })
    const again = (await ok('picker', 'POST', '/inventory/substitutions', ask({ bomLineId: W.line30, toItemId: I.protectorAlt, toLotId: L.altProtector, quantity: '2' }), 201)).substitution
    await ok('picker', 'POST', `/inventory/substitutions/${again.id}/withdraw`, { version: again.version, reason: 'Made-up: not needed' })
    expect((await one<Json>(`SELECT status::text FROM "ApprovalTask" WHERE id = $1`, [again.approval.taskId])).status).toBe('WITHDRAWN')
    const list = await ok('picker', 'GET', `/inventory/substitutions?workOrderId=${W.wo1}&status=ALL`)
    expect(list.tiles).toEqual({ waiting: 1, approved: 3 })
    expect(JSON.stringify(list)).not.toContain(PEOPLE.picker)
  })

  it('issues an approved substitute with its own move; the tablet queues one and a second is refused in words', async () => {
    const issued = await ok('boss', 'POST', `/inventory/substitutions/${protectorSub.id}/issue`, { version: (await ok('picker', 'GET', `/inventory/substitutions/${protectorSub.id}`)).substitution.version }, 201)
    expect(issued).toMatchObject({ issued: '4.0000', substitution: { status: 'ISSUED' }, line: { toIssue: '0.0000' } })
    const moves = await admin<Json>(`SELECT reason::text, "itemId", "lotId", "workOrderId", "baseQuantity"::text AS q FROM "StockMove" WHERE id = ANY($1::uuid[])`, [issued.moveIds])
    expect(moves).toEqual([{ reason: 'ISSUE', itemId: I.protectorAlt, lotId: L.altProtector, workOrderId: W.wo1, q: '4.0000' }])
    const walk = await ok('picker', 'GET', `/inventory/pick-lists/work-orders/${W.wo1}`)
    expect(walk.workOrders[0].lines.find((line: Json) => line.itemCode === 'SEED-PRO-300')).toMatchObject({ substituted: '4.0000', toPick: '10.0000' })
    // The lining alternate approved at once, queued from the tablet (inventory.substitute.issue).
    const lining = (await ok('picker', 'GET', `/inventory/substitutions?workOrderId=${W.wo1}&status=APPROVED`)).substitutions.find((sub: Json) => sub.substitute.item.code === 'SEED-LIN-210')
    const event = { clientEventId: newId(), kind: 'inventory.substitute.issue' as const, payload: { substitutionId: lining.id } }
    const first = await applyQueued(floorCaller(), event, { key: `${A.device}.${event.clientEventId}` })
    expect(first).toMatchObject({ status: 'accepted', result: { type: 'MaterialSubstitution', id: lining.id } })
    const second = { ...event, clientEventId: newId() }
    expect(await applyQueued(floorCaller(), second, { key: `${A.device}.${second.clientEventId}` })).toMatchObject({ status: 'refused', refusal: { code: 'NOT_APPROVED' } })
    // A queued issue from the pick list (W1's issue by the lot's code at its stop).
    const pick = { clientEventId: newId(), kind: 'inventory.pick.issue' as const, payload: { workOrderId: W.wo1, code: 'SEED-LOT-LIN-01', quantity: '1' } }
    expect(await applyQueued(floorCaller(), pick, { key: `${A.device}.${pick.clientEventId}` })).toMatchObject({ status: 'accepted', result: { type: 'StockMove' } })
    // Another site's tablet does not find the substitute.
    await no('b1tablet', 'POST', `/inventory/substitutions/${lining.id}/issue`, {}, 404)
  })
})
