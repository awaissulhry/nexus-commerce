import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth, type AuthSeed } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPeople, type PeopleSeed } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPortalAuth } from '../../../../../../packages/factory-db/seed/portal-auth'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { structureHandlers } from './handlers'
import { keepStructuresInCommand } from './keep'

/**
 * owb-ss6 — order structures and their rules, on the local stack with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security and the structure guards are real), the factory-db seeds of one
 * tenant up to the people and production (P1's SEED-SO-0002 at plant A1, a made-up JACKET in two colours; team L1-A of company A,
 * L1-B of company B; the office users Seed Owner and Seed Member), office sessions from the test authenticator, each on company A's
 * screen. Every name and code is made up. Written, not run in the build (Owner rule: checks at the end). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/structures`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let auth: AuthSeed
let people: PeopleSeed
let production: ProductionSeed

const NS = 'owb-ss6-structures'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), party: idOf('party:P1') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T.tenant, actorId: newId(), companyId: T.companyA, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  // The production manager keeps the structures; sales keeps the rules and one order by hand (plan.md § 5 D).
  manager: office(['orders.view', 'workorders.view', 'production.structures.manage']),
  sales: office(['orders.view', 'production.structures.rules']),
  teams: office(['orders.view', 'workorders.view', 'production.teams.assign']),
  designer: office(['orders.view.own', 'files.read']),
  floor: { audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteA1, deviceId: newId(), grants: [] } as SessionContext,
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `t-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))

/** A structure of company A made by the production manager; its row. */
const newStructure = (name: string, teamIds: string[] = [], peopleUserIds: string[] = []) => ok('manager', 'POST', '/production/order-structures', { name: `${name} ${run}`, teamIds, peopleUserIds }, 201)
/** A rule made by sales; its row. */
const newRule = (body: { partyId: string | null; category: string | null; structureId: string; place?: number }) => ok('sales', 'POST', '/production/structure-rules', body, 201)
/** Every open rule of the tenant closed (by the owner): each test starts from an empty list. */
const closeAllRules = () => admin(`UPDATE "OrderStructureRule" SET "closedAt" = now(), "closedById" = $1, version = version + 1 WHERE "closedAt" IS NULL`, [auth.ownerId])

/** A new open team of plant A1 (company A) that takes orders; its id. */
async function newTeam(code: string): Promise<string> {
  const id = newId()
  await admin(`INSERT INTO "Team" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, $5, $6)`, [id, T.tenant, T.companyA, T.siteA1, code, `Made-up team ${code}`])
  return id
}

/** Planted by the owner with the triggers off (as a fixture, never as the app writes). */
async function planted(work: () => Promise<void>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await work()
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}

/** Another CONFIRMED order of P1, a copy of SEED-SO-0002 and its lines (the made-up JACKET) under a new number. */
async function anotherOrder(): Promise<string> {
  const id = newId()
  await planted(async () => {
    await db.admin.query(`INSERT INTO "SalesOrder" SELECT * FROM jsonb_populate_record(NULL::"SalesOrder", (SELECT to_jsonb(o) || $1::jsonb FROM "SalesOrder" o WHERE o.id = $2::uuid))`, [JSON.stringify({ id, number: `T-SO-${id.slice(0, 8)}`, customerSeq: null, status: 'CONFIRMED' }), production.salesOrderId])
    await db.admin.query(
      `INSERT INTO "SalesOrderLine" SELECT (jsonb_populate_record(NULL::"SalesOrderLine", to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'orderId', $1::uuid))).* FROM "SalesOrderLine" l WHERE l."orderId" = $2::uuid`,
      [id, production.salesOrderId],
    )
  })
  return id
}
const setStatus = (orderId: string, status: string) => planted(async () => { await db.admin.query(`UPDATE "SalesOrder" SET status = $2 WHERE id = $1`, [orderId, status]) })
const printFirst = (orderId: string) => admin(`INSERT INTO "OrderPrint" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, pages, cards) VALUES ($1, $2, $3, $4, $5, 'FIRST', '[]', '[]')`, [newId(), T.tenant, T.companyA, T.party, orderId])

const handler = () => structureHandlers().find((entry) => entry.name === 'production.structuresAtConfirm')!
const systemCaller = () => callerFor(database, systemContext(T.tenant, newId()))
const envelope = (type: string, payload: Json) => ({ eventId: newId(), type, version: 1, tenantId: T.tenant, payload }) as never
const teamRows = (orderId: string) => admin(`SELECT "teamId"::text AS team, "inCharge" AS "inCharge", "basketShare" AS share, "givenBy"::text AS "givenBy", "createdById" AS by FROM "OrderTeam" WHERE "salesOrderId" = $1 AND "endedAt" IS NULL ORDER BY "inCharge" DESC`, [orderId])

beforeAll(async () => {
  db = await migratedDatabase('owb_ss6_structures')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  auth = await seedAuth({ db: database, namespace: NS })
  await seedPortalAuth({ db: database, namespace: NS })
  production = await seedProduction({ db: database, namespace: NS })
  people = await seedPeople({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('order structures (6.2): the production manager keeps them', () => {
  it('a structure with its team (face and picture) and its office people; one audit row', async () => {
    const row = await newStructure('Made-up race team', [people.teamIds.a], [auth.memberId])
    expect(row).toMatchObject({ teams: [{ id: people.teamIds.a, picture: { kind: expect.any(String) } }], people: [{ userId: auth.memberId, name: 'Seed Member' }], note: null, closed: false, usedByRules: 0, version: 1 })
    const audit = await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'OrderStructure' AND "recordId" = $1`, [row.id])
    expect(audit).toEqual([{ action: 'production.createOrderStructure' }])
    const changed = await ok('manager', 'PATCH', `/production/order-structures/${row.id}`, { version: 1, note: 'Made-up note.' })
    expect(changed).toMatchObject({ note: 'Made-up note.', version: 2 })
    // A stale version is a 409.
    expect((await call('manager', 'PATCH', `/production/order-structures/${row.id}`, { version: 1, note: 'Again' })).statusCode).toBe(409)
  })

  it('refused in words: a name an open structure has, a team of another company, a person who is not an office user', async () => {
    const first = await newStructure('Made-up gloves way')
    expect(pathsOf(await no('manager', 'POST', '/production/order-structures', { name: first.name.toUpperCase(), teamIds: [], peopleUserIds: [] }, 409))).toContain('refusal/NAME_TAKEN')
    expect(pathsOf(await no('manager', 'POST', '/production/order-structures', { name: `Other ${run}`, teamIds: [people.teamIds.b], peopleUserIds: [] }, 409))).toContain('refusal/TEAM_NOT_OPEN')
    expect(pathsOf(await no('manager', 'POST', '/production/order-structures', { name: `Third ${run}`, teamIds: [], peopleUserIds: [auth.invitedId] }, 409))).toContain('refusal/PERSON_NOT_OFFICE')
  })

  it('sales reads the structures and may write rules, not structures (403); the designer and the floor have no route', async () => {
    const read = await ok('sales', 'GET', '/production/order-structures')
    expect(read.may).toEqual({ manage: false })
    expect(read.structures.length).toBeGreaterThan(0)
    expect((await call('sales', 'POST', '/production/order-structures', { name: `Sales ${run}`, teamIds: [], peopleUserIds: [] })).statusCode).toBe(403)
    expect((await call('designer', 'GET', '/production/order-structures')).statusCode).toBe(403)
    expect((await call('designer', 'GET', '/production/structure-rules')).statusCode).toBe(403)
    expect((await call('floor', 'GET', '/production/order-structures')).statusCode).toBe(403)
    expect((await call('floor', 'GET', '/production/structure-rules')).statusCode).toBe(403)
    // The production manager keeps the structures, not the rules.
    const structure = await newStructure('Made-up manager way')
    expect((await call('manager', 'POST', '/production/structure-rules', { partyId: T.party, category: 'VEST', structureId: structure.id })).statusCode).toBe(403)
  })
})

describe('structure rules (6.2): sales keeps the list', () => {
  it('two identical open rules: the second is refused in words (before the database’s partial unique)', async () => {
    await closeAllRules()
    const structure = await newStructure('Made-up twin way')
    await newRule({ partyId: T.party, category: 'GLOVES', structureId: structure.id })
    const refused = await no('sales', 'POST', '/production/structure-rules', { partyId: T.party, category: 'GLOVES', structureId: structure.id }, 409)
    expect(pathsOf(refused)).toContain('refusal/SAME_ORDERS')
    expect(refused.message).toContain('Rule 1 is for exactly these orders')
    // Any customer with any category, twice: refused too.
    await newRule({ partyId: null, category: null, structureId: structure.id })
    expect(pathsOf(await no('sales', 'POST', '/production/structure-rules', { partyId: null, category: null, structureId: structure.id }, 409))).toContain('refusal/SAME_ORDERS')
  })

  it('the order of the rules is kept: a place given, rulePlace otherwise, a move of the whole list; a partial list is refused', async () => {
    await closeAllRules()
    const structure = await newStructure('Made-up order way')
    const gloves = await newRule({ partyId: T.party, category: 'GLOVES', structureId: structure.id })
    const vest = await newRule({ partyId: null, category: 'VEST', structureId: structure.id, place: 1 })
    let list = await ok('sales', 'GET', '/production/structure-rules')
    expect(list.rules.filter((rule: Json) => !rule.closed).map((rule: Json) => [rule.id, rule.sortOrder])).toEqual([[vest.id, 1], [gloves.id, 2]])
    expect(list.may).toEqual({ write: true })
    await ok('sales', 'PUT', '/production/structure-rules/order', { ids: [gloves.id, vest.id] })
    list = await ok('sales', 'GET', '/production/structure-rules')
    expect(list.rules.filter((rule: Json) => !rule.closed).map((rule: Json) => [rule.id, rule.sortOrder])).toEqual([[gloves.id, 1], [vest.id, 2]])
    expect(pathsOf(await no('sales', 'PUT', '/production/structure-rules/order', { ids: [gloves.id] }, 409))).toContain('refusal/ORDER_NOT_WHOLE')
    // A broad rule for P1 is placed above the first rule that would take all its orders? None takes P1 · any: it goes last.
    const broad = await newRule({ partyId: T.party, category: null, structureId: structure.id })
    expect(broad.sortOrder).toBe(3)
    // Moved to the top, it takes P1's gloves whole: that rule is "Never used", and the list counts it.
    await ok('sales', 'PUT', '/production/structure-rules/order', { ids: [broad.id, gloves.id, vest.id] })
    list = await ok('sales', 'GET', '/production/structure-rules')
    expect(list.rules.find((rule: Json) => rule.id === gloves.id)).toMatchObject({ dead: true, deadBecause: { ruleId: broad.id } })
    expect(list.neverUsed).toBe(1)
    // A new P1 · SUIT rule is placed above the broad rule (it would take all its orders), so it is used.
    const suit = await newRule({ partyId: T.party, category: 'SUIT', structureId: structure.id })
    expect(suit).toMatchObject({ sortOrder: 1, dead: false })
    const audit = await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'OrderStructureRule' AND action = 'production.moveStructureRule'`)
    expect(audit[0]!.n).toBeGreaterThan(0)
  })

  it('a closed structure flags its rules (the rule stays); a rule of a closed structure is not opened again', async () => {
    await closeAllRules()
    const structure = await newStructure('Made-up closing way')
    const rule = await newRule({ partyId: T.party, category: 'TROUSERS', structureId: structure.id })
    const closed = await ok('manager', 'POST', `/production/order-structures/${structure.id}/close`, { version: structure.version })
    expect(closed.closed).toBe(true)
    const list = await ok('sales', 'GET', '/production/structure-rules')
    expect(list.rules.find((row: Json) => row.id === rule.id)).toMatchObject({ closed: false, structure: { id: structure.id, closed: true } })
    // A new rule may not give a closed structure.
    expect(pathsOf(await no('sales', 'POST', '/production/structure-rules', { partyId: T.party, category: 'VEST', structureId: structure.id }, 409))).toContain('refusal/STRUCTURE_NOT_OPEN')
    const shut = await ok('sales', 'POST', `/production/structure-rules/${rule.id}/close`, {})
    expect(shut.closed).toBe(true)
    expect(pathsOf(await no('sales', 'POST', `/production/structure-rules/${rule.id}/reopen`, {}, 409))).toContain('refusal/STRUCTURE_NOT_OPEN')
    await ok('manager', 'POST', `/production/order-structures/${structure.id}/reopen`, {})
    const reopened = await ok('sales', 'POST', `/production/structure-rules/${rule.id}/reopen`, {})
    expect(reopened).toMatchObject({ closed: false, structure: { closed: false } })
  })

  it('Try an order: the winner, and why each other rule does not win', async () => {
    await closeAllRules()
    const structure = await newStructure('Made-up try way')
    const gloves = await newRule({ partyId: T.party, category: 'GLOVES', structureId: structure.id })
    const won = await ok('sales', 'POST', '/production/structure-rules/try', { partyId: T.party, category: 'GLOVES' })
    expect(won.winner).toMatchObject({ ruleId: gloves.id, structureId: structure.id })
    expect(won.winner.words).toContain('Rule 1 wins')
    const none = await ok('sales', 'POST', '/production/structure-rules/try', { partyId: T.party, category: 'JACKET' })
    expect(none.winner).toEqual({ ruleId: null, structureId: null, words: 'No rule fits → The normal way' })
    expect(none.others).toEqual([{ ruleId: gloves.id, words: expect.stringContaining('another category') }])
    // The customer page reads the rules naming P1.
    const customer = await ok('sales', 'GET', `/production/customers/${T.party}/structure-rules`)
    expect(customer.rules.map((rule: Json) => rule.id)).toContain(gloves.id)
    expect(customer.may).toEqual({ write: true })
  })
})

describe('one order (6.3): by hand, back to the rules, kept at the first print', () => {
  it('by hand wins over a rule; DELETE goes back to the rules; refused after the print; a kept line never changes', async () => {
    await closeAllRules()
    const jackets = await newStructure('Made-up jackets way', [people.teamIds.a])
    const show = await newStructure('Made-up show way')
    const rule = await newRule({ partyId: T.party, category: 'JACKET', structureId: jackets.id })
    const orderId = await anotherOrder()
    const live = await ok('sales', 'GET', `/production/orders/${orderId}/structure`)
    expect(live).toMatchObject({ orderId, printed: false, byHand: null, may: { change: true } })
    expect(live.lines.length).toBeGreaterThan(0)
    for (const line of live.lines) expect(line).toMatchObject({ structure: { id: jackets.id }, rule: { id: rule.id }, from: 'RULE', kept: false })
    expect(JSON.stringify(live.lines)).not.toMatch(/400\.000000|unitPrice/)
    // By hand: a structure, then the normal way; one open row at a time, the ended one kept.
    const byHand = await ok('sales', 'PUT', `/production/orders/${orderId}/structure`, { structureId: show.id, why: 'A made-up show piece.' })
    expect(byHand.byHand).toMatchObject({ structureId: show.id, why: 'A made-up show piece.' })
    for (const line of byHand.lines) expect(line).toMatchObject({ structure: { id: show.id }, rule: null, from: 'ORDER' })
    const normal = await ok('sales', 'PUT', `/production/orders/${orderId}/structure`, { structureId: null, why: 'Made as before (made up).' })
    for (const line of normal.lines) expect(line).toMatchObject({ structure: null, rule: null, from: 'ORDER' })
    expect(await admin(`SELECT count(*)::int AS n, count(*) FILTER (WHERE "endedAt" IS NULL)::int AS open FROM "OrderStructureOverride" WHERE "salesOrderId" = $1`, [orderId])).toEqual([{ n: 2, open: 1 }])
    // Back to the rules.
    const back = await ok('sales', 'DELETE', `/production/orders/${orderId}/structure`)
    expect(back.byHand).toBeNull()
    for (const line of back.lines) expect(line).toMatchObject({ structure: { id: jackets.id }, from: 'RULE' })
    // The production manager sees the order (orders.view) but does not choose its structure; the designer and the floor do not reach it.
    expect((await ok('manager', 'GET', `/production/orders/${orderId}/structure`)).may).toEqual({ change: false })
    expect((await call('manager', 'PUT', `/production/orders/${orderId}/structure`, { structureId: null, why: 'Made-up why' })).statusCode).toBe(403)
    expect((await call('designer', 'GET', `/production/orders/${orderId}/structure`)).statusCode).toBe(404)
    expect((await call('floor', 'GET', `/production/orders/${orderId}/structure`)).statusCode).toBe(403)
    // After the first print: nothing changes by hand any more.
    await ok('sales', 'PUT', `/production/orders/${orderId}/structure`, { structureId: show.id, why: 'Before the print (made up).' })
    await printFirst(orderId)
    const printed = await ok('sales', 'GET', `/production/orders/${orderId}/structure`)
    expect(printed).toMatchObject({ printed: true, may: { change: false } })
    expect(pathsOf(await no('sales', 'PUT', `/production/orders/${orderId}/structure`, { structureId: null, why: 'After the print' }, 409))).toContain('refusal/PRINTED')
    expect(pathsOf(await no('sales', 'DELETE', `/production/orders/${orderId}/structure`, undefined, 409))).toContain('refusal/PRINTED')
    // A line kept at the print (the print command writes it: planted here) keeps its structure whatever the rules do after.
    const line = live.lines[0]
    await admin(
      `INSERT INTO "OrderLineStructureKept" (id, "tenantId", "companyId", "partyId", "salesOrderId", "salesOrderLineId", "structureId", "ruleId", "keptFrom", snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RULE', $9::jsonb)`,
      [newId(), T.tenant, T.companyA, T.party, orderId, line.salesOrderLineId, jackets.id, rule.id, JSON.stringify({ steps: null, teams: [], people: [] })],
    )
    await ok('sales', 'POST', `/production/structure-rules/${rule.id}/close`, {})
    const kept = await ok('sales', 'GET', `/production/orders/${orderId}/structure`)
    expect(kept.lines.find((entry: Json) => entry.salesOrderLineId === line.salesOrderLineId)).toMatchObject({ structure: { id: jackets.id }, rule: { id: rule.id }, from: 'RULE', kept: true })
  })
})

describe('at Confirm (6.4 a): the structures give the teams and the people', () => {
  it('a confirmed order takes the teams of its rule (givenBy RULE, one in charge) and the structure’s office people; a repeat changes nothing', async () => {
    await closeAllRules()
    const team = await newTeam(`T-${run}-C`)
    const structure = await newStructure('Made-up confirm way', [team], [auth.memberId])
    await newRule({ partyId: T.party, category: 'JACKET', structureId: structure.id })
    const orderId = await anotherOrder()
    await handler().handle(envelope('sales_order.created', { orderId, number: 'T-SO', quoteId: null, versionId: null, partyId: T.party, depositRequestIds: [] }), { caller: systemCaller(), attempt: 1 })
    expect(await teamRows(orderId)).toEqual([{ team, inCharge: true, share: null, givenBy: 'RULE', by: null }])
    expect(await admin(`SELECT "userId"::text AS "user" FROM "RecordFollower" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND "userId" = $2`, [orderId, auth.memberId])).toEqual([{ user: auth.memberId }])
    // A repeat (or a late event) changes nothing.
    await handler().handle(envelope('sales_order.created', { orderId, number: 'T-SO', quoteId: null, versionId: null, partyId: T.party, depositRequestIds: [] }), { caller: systemCaller(), attempt: 2 })
    expect(await teamRows(orderId)).toHaveLength(1)
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action = 'production.structuresAtConfirm'`, [orderId])
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ structures: [structure.id], mode: 'ONE' })
  })

  it('an order with teams given by hand is not touched; nor one printed', async () => {
    await closeAllRules()
    const team = await newTeam(`T-${run}-H`)
    const structure = await newStructure('Made-up untouched way', [team])
    await newRule({ partyId: T.party, category: 'JACKET', structureId: structure.id })
    const byHand = await anotherOrder()
    await ok('teams', 'PUT', `/production/orders/${byHand}/teams`, { version: 1, rows: [{ teamId: people.teamIds.a, inCharge: true, basketShare: null }] })
    await handler().handle(envelope('sales_order.created', { orderId: byHand, number: 'T-SO', quoteId: null, versionId: null, partyId: T.party, depositRequestIds: [] }), { caller: systemCaller(), attempt: 1 })
    expect(await teamRows(byHand)).toEqual([expect.objectContaining({ team: people.teamIds.a, givenBy: 'USER' })])
    const printed = await anotherOrder()
    await printFirst(printed)
    await handler().handle(envelope('sales_order.created', { orderId: printed, number: 'T-SO', quoteId: null, versionId: null, partyId: T.party, depositRequestIds: [] }), { caller: systemCaller(), attempt: 1 })
    expect(await teamRows(printed)).toEqual([])
  })

  it('an order made waiting for a yes takes its teams when it moves PENDING_APPROVAL → CONFIRMED (no other move)', async () => {
    await closeAllRules()
    const team = await newTeam(`T-${run}-Y`)
    const structure = await newStructure('Made-up yes way', [team])
    await newRule({ partyId: T.party, category: null, structureId: structure.id })
    const orderId = await anotherOrder()
    await setStatus(orderId, 'PENDING_APPROVAL')
    await handler().handle(envelope('sales_order.created', { orderId, number: 'T-SO', quoteId: null, versionId: null, partyId: T.party, depositRequestIds: [] }), { caller: systemCaller(), attempt: 1 })
    expect(await teamRows(orderId)).toEqual([])
    await setStatus(orderId, 'CONFIRMED')
    await handler().handle(envelope('sales_order.status_changed', { orderId, number: 'T-SO', from: 'CONFIRMED', to: 'IN_PRODUCTION', by: 'system', partyId: T.party }), { caller: systemCaller(), attempt: 1 })
    expect(await teamRows(orderId)).toEqual([])
    await handler().handle(envelope('sales_order.status_changed', { orderId, number: 'T-SO', from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person', partyId: T.party }), { caller: systemCaller(), attempt: 1 })
    expect(await teamRows(orderId)).toEqual([expect.objectContaining({ team, givenBy: 'RULE', inCharge: true })])
  })
})

describe('at the first print (6.4 b): the order keeps each line’s structure', () => {
  it('one kept row per made line, from its rule, with its teams and people named; a rule change after it changes nothing; a replay adds nothing', async () => {
    await closeAllRules()
    const team = await newTeam(`T-${run}-K`)
    const structure = await newStructure('Made-up kept way', [team], [auth.memberId])
    const rule = await newRule({ partyId: T.party, category: 'JACKET', structureId: structure.id })
    const orderId = await anotherOrder()
    // The print command calls it inside its own command (print-start/start.ts); here a system command of its own.
    const keep = () => command(systemCaller(), { name: 'test.keepStructures', input: { orderId } }, (tools) => keepStructuresInCommand(tools.tx, { id: orderId, companyId: T.companyA, partyId: T.party }, null, tools.now))
    const first = (await keep()).result
    expect(first).toBeGreaterThan(0)
    const kept = await admin(`SELECT "keptFrom"::text AS "from", "structureId"::text AS structure, "ruleId"::text AS rule, snapshot FROM "OrderLineStructureKept" WHERE "salesOrderId" = $1`, [orderId])
    expect(kept).toHaveLength(first)
    expect(kept[0]).toMatchObject({ from: 'RULE', structure: structure.id, rule: rule.id })
    expect(kept[0]!.snapshot).toMatchObject({ teams: [{ id: team }], people: [{ id: auth.memberId }] })
    // The rule closes after the print: the order keeps what it took, and keeping again adds nothing.
    await closeAllRules()
    expect((await keep()).result).toBe(0)
    expect(await admin(`SELECT count(*)::int AS n FROM "OrderLineStructureKept" WHERE "salesOrderId" = $1 AND "ruleId" = $2`, [orderId, rule.id])).toEqual([{ n: first }])
  })
})
