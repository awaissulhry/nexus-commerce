import { randomBytes } from 'node:crypto'
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
import { businessDate } from '@nexus/factory-domain/core/time'
import { scrapApprovalKey } from '@nexus/factory-domain/production/scrap/approval'
import { seed as seedPeople } from '../../../../../packages/factory-db/seed/people'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../auth/sessions/testing/harness'

/**
 * One approval engine (B-W2b-282; PLT-042, PLT-086, PLT-091, PLT-093, PLT-104, PLT-105) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_approvals_w2b_guards triggers are real), tenant A from EVERY seed (the approval rules all OFF, SEED-PO-0001 sent to a
 * supplier, SEED-Q-0002 waiting for a margin approval, SEED-ECO-0001, the SMV v2 of CUT, SEED-NCR-0002's decision, E1's
 * October timesheet, SEED-WI-0002 v3). Made-up office people with live role assignments (the approver rule and the deciders
 * read them) and test sessions holding the same template grants; a signed yes and an inspection plan through the harness's
 * real sign-in with two-factor (step-up). Every name and number is made up.
 *
 * Two parts: the engine (rules by condition, the ask, the inbox, the re-check at the yes, the no with its reason, the
 * withdrawal, the signature, the history) and "nobody approves their own request, the Owner included" (Owner answer Q3 = A)
 * tried on every existing approval the plan lists: quote, change order, SMV change, NCR decision, scrap, timesheet, inspection
 * plan version, work instruction version. Run with `node scripts/factory/run-pg-tests.mjs platform/approvals`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'approvals-282'
const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  owner: id('actor'),
  member: id('user:member'),
  operator: id('worker:A1:operator'),
  device: id('device:A1:cutting'),
  qcStation: id('site:A1:station:QC-01'),
}
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

const PEOPLE = { owner: newId(), buyer: newId(), finance: newId(), financeB: newId(), admin: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Person, { readonly role: string; readonly companies: 'all' | 'B' }> = {
  owner: { role: 'owner', companies: 'all' },
  buyer: { role: 'buyer', companies: 'all' },
  finance: { role: 'finance', companies: 'all' },
  financeB: { role: 'finance', companies: 'B' },
  admin: { role: 'admin', companies: 'all' },
  reader: { role: 'read_only', companies: 'all' },
}
const NAMES: Record<Person, string> = { owner: 'Made-up Owner', buyer: 'Made-up Buyer', finance: 'Made-up Finance', financeB: 'Made-up Finance B', admin: 'Made-up Admin', reader: 'Made-up Reader' }

function grantsOf(role: string, companies: 'all' | readonly string[], drop: readonly string[] = []): Grant[] {
  const template = templateOf(role)!
  const permissions = [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)].filter((permission) => !drop.includes(permission))
  return [{ permissions, companies, sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}
const sessionOf = (actorId: string, role: string, companies: 'all' | readonly string[] = 'all', drop: readonly string[] = []): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants: grantsOf(role, companies, drop) })

let h: Harness
let app: FastifyInstance
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
/** Moves test data past its own guards (the admin's session only), then back. */
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
const freshKey = () => `w2b282-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const lines = (recordId: string) => admin<Json>(`SELECT action::text AS action, "byId", "byWorkerId", words, "reasonCode", meaning::text AS meaning, "taskId" FROM "ApprovalEvent" WHERE "recordId" = $1 ORDER BY at, "createdAt", id`, [recordId])

interface SignedIn {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
async function signedIn(email: string, role: string): Promise<SignedIn> {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
async function as(person: SignedIn, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await person.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': freshKey() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

let supplierId: string
let itemId: string
let financeRoleId: string
let rule: Json
const need = businessDate(new Date(Date.now() + 40 * 86_400_000))

/** A new draft purchase order of company A to the seeded supplier: one line of 10 pieces at `price` each. */
async function draftOrder(session: string, price: string): Promise<{ id: string; version: number; lineId: string }> {
  const made = (await ok(session, 'POST', '/purchasing/orders', { companyId: A.companyA, siteId: A.siteA1, partyId: supplierId }, 201)).order
  const lined = (await ok(session, 'POST', `/purchasing/orders/${made.id}/lines`, { version: made.version, itemId, quantity: '10', needDate: need, unitPrice: price }, 201)).order
  return { id: lined.id, version: lined.version, lineId: lined.lines[0].id }
}
const ask = (session: string, recordId: string, note: string | null = null, status = 201) => ok(session, 'POST', '/approvals/requests', { kind: 'PURCHASE_ORDER', recordId, note }, status)

beforeAll(async () => {
  h = await startHarness('approvals_w2b282')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (approvals.* for every office template).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [A.tenant])).map((row) => [row.key, row.id]))
  financeRoleId = roleIds.get('finance')!
  for (const [person, { role, companies }] of Object.entries(ROLES) as Array<[Person, (typeof ROLES)[Person]]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], A.tenant, `w2b282-${person}-${run}@example.com`, NAMES[person]])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() - interval '30 days')`, [
      newId(),
      A.tenant,
      PEOPLE[person],
      roleIds.get(role),
      companies === 'all',
      companies === 'all' ? [] : [A.companyB],
    ])
    SESSIONS[person] = sessionOf(PEOPLE[person], role, companies === 'all' ? 'all' : [A.companyB])
  }
  // A buyer whose roles show no cost: the order's value (a cost) stays hidden from them.
  SESSIONS.buyerNoCost = sessionOf(newId(), 'buyer', 'all', ['money.cost'])
  // The seed's Owner (who asked or wrote the seeded domain approvals), holding every permission.
  SESSIONS.seedOwner = sessionOf(A.owner, 'owner')
  SESSIONS.floorless = { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [{ permissions: ['home.view'], companies: 'all', sites: 'all', parties: 'all' }] }
  supplierId = (await one<{ partyId: string }>(`SELECT "partyId" FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = 'SEED-PO-0001'`, [A.tenant])).partyId
  itemId = (await one<{ itemId: string }>(`SELECT l."itemId" FROM "PurchaseOrderLine" l JOIN "PurchaseOrder" o ON o.id = l."purchaseOrderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-PO-0002'`, [A.tenant])).itemId
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('approval rules by condition (PLT-086)', () => {
  it('lists the kinds and their facts; a money fact is held for a reader without its grain', async () => {
    const kinds = await ok('buyer', 'GET', '/approvals/kinds')
    const po = kinds.kinds.find((kind: Json) => kind.kind === 'PURCHASE_ORDER')
    expect(po).toMatchObject({ recordType: 'PurchaseOrder', askable: true, label: { en: 'Purchase order' } })
    // B-W2b-305 (SCM-080): + the revision and the value added since the last send.
    expect(po.fields.map((field: Json) => field.id)).toEqual(['orderValue', 'currency', 'lineCount', 'supplierStatus', 'supplierCode', 'siteCode', 'revision', 'valueIncrease'])
    expect(po.fields[0]).toMatchObject({ grain: 'cost', heldReason: null })
    // B-W2b-303: SALES_ORDER is registered now; a change of an approved order is not yet.
    expect(kinds.notRegistered).toContain('SALES_ORDER_CHANGE')
    const blind = await ok('buyerNoCost', 'GET', '/approvals/kinds')
    expect(blind.kinds[0].fields[0].heldReason).toBe('A money figure your roles do not show.')
  })

  it('lists the seeded rules, every one OFF, with the locked "Nobody approves their own request"; a threshold in money only with its grain', async () => {
    const list = await ok('owner', 'GET', '/approvals/rules')
    expect(list.rules.length).toBeGreaterThanOrEqual(5)
    expect(list.rules.every((entry: Json) => entry.active === false)).toBe(true)
    expect(list.fixed).toEqual([{ code: 'NO_SELF_APPROVAL', sentence: expect.objectContaining({ en: expect.stringContaining('Nobody approves their own request, the Owner included') }) }])
    const seeded = list.rules.find((entry: Json) => entry.kind === 'PURCHASE_ORDER')
    expect(seeded.sentence.en).toBe('Purchase order: order value over 5000 → Finance')
    expect(seeded).toMatchObject({ registered: true, canChange: true, approver: { kind: 'ROLE' } })
    const blind = (await ok('buyerNoCost', 'GET', '/approvals/rules')).rules.find((entry: Json) => entry.id === seeded.id)
    expect(blind.sentence.en).toBe('Purchase order: order value over … → Finance')
    expect(blind.condition.rows[0]).toMatchObject({ field: 'orderValue', value: null, held: true })
    // B-W2b-303: the seeded SALES_ORDER rule's kind is registered now; PRICE_CHANGE's is not yet.
    expect(list.rules.find((entry: Json) => entry.kind === 'SALES_ORDER')).toMatchObject({ registered: true })
    expect(list.rules.find((entry: Json) => entry.kind === 'PRICE_CHANGE')).toMatchObject({ registered: false })
  })

  it('writes a new rule OFF; refuses a fact the kind does not have, an approver who may not decide, a writer who does not keep rules', async () => {
    // The Owner keeps these rules: a threshold in cost needs the cost grain (the administrator sees no money).
    const body = { kind: 'PURCHASE_ORDER', companyId: A.companyA, name: 'Orders over 5,000 (made-up)', condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '5000' }] }, approver: { roleId: financeRoleId }, sequence: 5, dueHours: 24 }
    rule = (await ok('owner', 'POST', '/approvals/rules', body, 201)).rule
    expect(rule).toMatchObject({ active: false, sequence: 5, dueHours: 24, approver: { kind: 'ROLE', id: financeRoleId, name: 'Finance' }, changedBy: { id: PEOPLE.owner, me: true }, fired30Days: 0 })
    expect(paths(await no('owner', 'POST', '/approvals/rules', { ...body, active: true }, 400))).toEqual(['body'])
    expect(paths(await no('owner', 'POST', '/approvals/rules', { ...body, condition: { combinator: 'and', rows: [{ field: 'margin', operator: 'gt', value: '5' }] } }, 400))).toEqual(['body/condition/rows/0/field'])
    const readOnly = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'read_only'`, [A.tenant])).id
    expect(paths(await no('owner', 'POST', '/approvals/rules', { ...body, approver: { roleId: readOnly } }, 400))).toEqual(['body/approver/roleId'])
    expect(paths(await no('owner', 'POST', '/approvals/rules', { ...body, approver: { userId: PEOPLE.reader } }, 400))).toEqual(['body/approver/userId'])
    await no('buyer', 'POST', '/approvals/rules', body, 403)
    expect(await outbox('approval.rule_changed')).toContainEqual({ ruleId: rule.id, kind: 'PURCHASE_ORDER', change: 'CREATED', active: false })
  })

  it('no rule switched on: nothing needs a yes (as today) and nothing is written', async () => {
    const order = await draftOrder('buyer', '600')
    expect(await ask('buyer', order.id, null, 200)).toEqual({ asked: false, why: 'No approval rule asks for a yes on it: it goes on as it is.' })
    expect(await admin(`SELECT id FROM "ApprovalTask" WHERE "recordId" = $1`, [order.id])).toEqual([])
  })

  it('tests a draft against the latest orders and says who would approve; a person switches the rule on', async () => {
    await draftOrder('buyer', '650')
    const condition = { combinator: rule.condition.combinator, rows: rule.condition.rows.map((row: Json) => ({ field: row.field, operator: row.operator, value: row.value })) }
    const test = await ok('owner', 'POST', '/approvals/rules/test', { kind: 'PURCHASE_ORDER', companyId: A.companyA, condition, approver: { roleId: financeRoleId } })
    expect(test.tested).toBeGreaterThanOrEqual(3)
    expect(test.wouldAsk).toBeGreaterThanOrEqual(2)
    expect(test.approvers.map((entry: Json) => entry.id)).toContain(PEOPLE.finance)
    expect(test.approvers.map((entry: Json) => entry.id)).not.toContain(PEOPLE.financeB)
    expect(test.sentence.en).toBe('Purchase order: order value over 5000 → Finance')
    rule = (await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true })).rule
    expect(rule).toMatchObject({ active: true, version: 2 })
    expect(await outbox('approval.rule_changed')).toContainEqual({ ruleId: rule.id, kind: 'PURCHASE_ORDER', change: 'SWITCHED_ON', active: true })
    // The administrator keeps rules but sees no cost: no threshold in cost is changed by them.
    expect((await ok('admin', 'GET', `/approvals/rules/${rule.id}`)).rule).toMatchObject({ canChange: true, heldReason: 'This rule tests a money figure your roles do not show: someone who sees it changes the rule.' })
    expect(paths(await no('admin', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, condition: { combinator: 'and', rows: [] } }, 409))).toEqual(['body/condition'])
  })
})

let orderA: { id: string; version: number; lineId: string }
let firstTask: Json

describe('the request: the exact change, its fingerprint, the re-check at the yes (PLT-093)', () => {
  it('asks: the first matching rule names the approver; a small order asks nothing', async () => {
    const small = await draftOrder('buyer', '10')
    expect((await ask('buyer', small.id, null, 200)).asked).toBe(false)
    orderA = await draftOrder('buyer', '600')
    const asked = await ask('buyer', orderA.id, 'Leather for the spring run (made-up).')
    firstTask = asked.task
    expect(firstTask).toMatchObject({
      kind: 'PURCHASE_ORDER',
      status: 'PENDING',
      record: { type: 'PurchaseOrder', id: orderA.id },
      requester: { kind: 'PERSON', id: PEOPLE.buyer, me: true },
      approver: { kind: 'ROLE', id: financeRoleId, name: 'Finance', me: false },
      rule: { id: rule.id },
      changes: [{ field: 'status', from: 'DRAFT', to: 'SENT', grain: null }],
      recheck: 'CURRENT',
      recheckLine: { words: expect.stringMatching(/^Still current · checked /) },
      changeSize: { en: '1 field', it: '1 campo' },
      approve: { allowed: false },
    })
    expect(firstTask.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(firstTask.facts.find((fact: Json) => fact.field === 'orderValue')).toMatchObject({ value: '6000', grain: 'cost' })
    // The buyer asked it: their Approve is held, naming who may decide.
    expect(firstTask.approve.why).toBe(`You asked for this: nobody approves their own request, the Owner included. ${NAMES.finance} can approve it.`)
    expect(firstTask.deciders.map((entry: Json) => entry.id)).toEqual([PEOPLE.finance])
    expect(new Date(firstTask.dueAt).getTime() - new Date(firstTask.requestedAt).getTime()).toBe(24 * 3_600_000)
    expect(await lines(orderA.id)).toEqual([{ action: 'REQUESTED', byId: PEOPLE.buyer, byWorkerId: null, words: 'Leather for the spring run (made-up).', reasonCode: null, meaning: null, taskId: firstTask.id }])
    expect(await outbox('approval.requested')).toContainEqual(expect.objectContaining({ taskId: firstTask.id, approverRoleId: financeRoleId, requestedById: PEOPLE.buyer }))
    expect(paths(await no('buyer', 'POST', '/approvals/requests', { kind: 'PURCHASE_ORDER', recordId: orderA.id }, 409))).toEqual(['recordId'])
    // Without the cost grain the value is left out.
    expect((await ok('buyerNoCost', 'GET', `/approvals/tasks/${firstTask.id}`)).task.facts.map((fact: Json) => fact.field)).not.toContain('orderValue')
  })

  it('the inbox: waiting for finance, asked by the buyer; out of reach for finance of company B and for a reader of nothing', async () => {
    const waiting = await ok('finance', 'GET', '/approvals/tasks?tile=WAITING_FOR_ME')
    const row = waiting.rows.find((entry: Json) => entry.id === firstTask.id)
    expect(row).toMatchObject({ approve: { allowed: true, why: null }, recheck: 'CURRENT', approver: { me: true }, overdue: false })
    expect(waiting.tiles.find((tile: Json) => tile.tile === 'WAITING_FOR_ME').count).toBeGreaterThanOrEqual(1)
    const mine = await ok('buyer', 'GET', '/approvals/tasks?tile=ASKED_BY_ME')
    expect(mine.rows.map((entry: Json) => entry.id)).toContain(firstTask.id)
    expect((await ok('buyer', 'GET', '/approvals/tasks?tile=WAITING_FOR_ME')).rows.map((entry: Json) => entry.id)).not.toContain(firstTask.id)
    await no('financeB', 'GET', `/approvals/tasks/${firstTask.id}`, undefined, 404)
    expect((await ok('financeB', 'GET', '/approvals/tasks?tile=WAITING_FOR_ME')).rows.map((entry: Json) => entry.id)).not.toContain(firstTask.id)
    await no('floorless', 'GET', '/approvals/tasks', undefined, 403)
    // The reader sees it (purchasing.view over the company), decides nothing.
    expect((await ok('reader', 'GET', `/approvals/tasks/${firstTask.id}`)).task.approve.allowed).toBe(false)
    await no('reader', 'POST', `/approvals/tasks/${firstTask.id}/approve`, { version: firstTask.version }, 403)
  })

  it('nobody approves their own request (the generic command): the buyer is refused in words naming who can', async () => {
    const own = await no('buyer', 'POST', `/approvals/tasks/${firstTask.id}/approve`, { version: firstTask.version }, 403)
    expect(own.issues[0]).toEqual({ path: 'refusal/OWN_REQUEST', message: `You asked for this: nobody approves their own request, the Owner included. ${NAMES.finance} can approve it.` })
    expect(paths(await no('buyer', 'POST', `/approvals/tasks/${firstTask.id}/reject`, { version: firstTask.version, reasonCode: 'OVER_BUDGET', reason: 'x' }, 403))).toEqual(['refusal/OWN_REQUEST'])
  })

  it('the order changed after the request: the yes is refused "it changed since you looked" and the request is STALE', async () => {
    const order = (await ok('buyer', 'GET', `/purchasing/orders/${orderA.id}`)).order
    await ok('buyer', 'PATCH', `/purchasing/orders/${orderA.id}/lines/${orderA.lineId}`, { version: order.version, quantity: '12' })
    const seen = (await ok('finance', 'GET', `/approvals/tasks/${firstTask.id}`)).task
    expect(seen).toMatchObject({ recheck: 'CHANGED', approve: { allowed: false } })
    expect(seen.recheckLine.changed).toEqual([{ field: 'orderValue', label: { en: 'order value', it: "valore dell'ordine" }, was: '6000', now: '7200', grain: 'cost' }])
    const stale = await no('finance', 'POST', `/approvals/tasks/${firstTask.id}/approve`, { version: seen.version }, 409)
    expect(stale.issues[0].path).toBe('refusal/STALE')
    expect(stale.message).toMatch(/^It changed since you looked/)
    const after = (await ok('finance', 'GET', `/approvals/tasks/${firstTask.id}`)).task
    expect(after).toMatchObject({ status: 'STALE', version: 2, decided: null })
    expect(after.staleAt).not.toBeNull()
    expect((await lines(orderA.id)).map((entry) => [entry.action, entry.byId])).toEqual([
      ['REQUESTED', PEOPLE.buyer],
      ['STALE', null],
    ])
    expect(await outbox('approval.stale')).toContainEqual(expect.objectContaining({ taskId: firstTask.id }))
    expect(paths(await no('finance', 'POST', `/approvals/tasks/${firstTask.id}/approve`, { version: after.version }, 409))).toEqual(['refusal/NOT_PENDING'])
  })

  it('asked again and approved by finance with a comment (PLT-091)', async () => {
    const second = (await ask('buyer', orderA.id, 'Twelve pieces now.')).task
    expect(second.facts.find((fact: Json) => fact.field === 'orderValue').value).toBe('7200')
    const approved = (await ok('finance', 'POST', `/approvals/tasks/${second.id}/approve`, { version: second.version, comment: 'Within the season budget.' })).task
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2, decided: { by: { id: PEOPLE.finance, me: true }, comment: 'Within the season budget.', stepUpAt: null }, approve: { allowed: false } })
    expect(await outbox('approval.decided')).toContainEqual({ taskId: second.id, kind: 'PURCHASE_ORDER', recordType: 'PurchaseOrder', recordId: orderA.id, status: 'APPROVED', meaning: null, requestedById: PEOPLE.buyer, decidedById: PEOPLE.finance })
    expect((await ok('finance', 'GET', '/approvals/tasks?tile=DECIDED_7_DAYS')).rows.map((row: Json) => row.id)).toContain(second.id)
    expect((await ok('owner', 'GET', `/approvals/rules/${rule.id}`)).rule.fired30Days).toBe(2)
  })
})

describe('the Owner asks, never decides; a no needs a reason and words; taking a request back (PLT-042, PLT-091)', () => {
  let ownerTask: Json

  it('the Owner holds every permission and is still refused on their own request, on the route and in the database', async () => {
    const order = await draftOrder('owner', '700')
    ownerTask = (await ask('owner', order.id)).task
    expect(paths(await no('owner', 'POST', `/approvals/tasks/${ownerTask.id}/approve`, { version: ownerTask.version }, 403))).toEqual(['refusal/OWN_REQUEST'])
    // Any other path: the runtime login writing the yes itself is refused by the database, the Owner included.
    await expect(
      h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: PEOPLE.owner }, (client) =>
        client.approvalTask.update({ where: { id: ownerTask.id }, data: { status: 'APPROVED', decidedAt: new Date(), decidedById: PEOPLE.owner, version: 2 } }),
      ),
    ).rejects.toThrow(/nobody approves their own request/)
  })

  it('a no needs a reason of the list and words; finance rejects with OVER_BUDGET', async () => {
    expect(paths(await no('finance', 'POST', `/approvals/tasks/${ownerTask.id}/reject`, { version: ownerTask.version, reasonCode: 'OVER_BUDGET' }, 400))).toContain('body/reason')
    expect(paths(await no('finance', 'POST', `/approvals/tasks/${ownerTask.id}/reject`, { version: ownerTask.version, reasonCode: 'NOT_A_REASON', reason: 'No.' }, 400))).toEqual(['body/reasonCode'])
    const rejected = (await ok('finance', 'POST', `/approvals/tasks/${ownerTask.id}/reject`, { version: ownerTask.version, reasonCode: 'OVER_BUDGET', reason: 'Not this month (made-up).' })).task
    expect(rejected).toMatchObject({ status: 'REJECTED', decided: { by: { id: PEOPLE.finance }, reasonCode: 'OVER_BUDGET', reason: 'Not this month (made-up).', comment: null } })
    expect(rejected.decided.reasonLabel.en.length).toBeGreaterThan(0)
    expect(rejected.history.map((entry: Json) => [entry.action, entry.reasonCode])).toEqual([
      ['REJECTED', 'OVER_BUDGET'],
      ['REQUESTED', null],
    ])
  })

  it('only the person who asked takes it back', async () => {
    const order = await draftOrder('buyer', '800')
    const task = (await ask('buyer', order.id)).task
    expect(paths(await no('finance', 'POST', `/approvals/tasks/${task.id}/withdraw`, { version: task.version }, 403))).toEqual(['refusal/NOT_REQUESTER'])
    const withdrawn = (await ok('buyer', 'POST', `/approvals/tasks/${task.id}/withdraw`, { version: task.version, note: 'Ordered elsewhere.' })).task
    expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', withdrawn: { by: { id: PEOPLE.buyer } } })
    expect(await outbox('approval.withdrawn')).toContainEqual(expect.objectContaining({ taskId: task.id }))
  })

  it('a rule that names the person asking is skipped: none left is refused in words; another person asks it', async () => {
    rule = (await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: false })).rule
    const named = (await ok('owner', 'POST', '/approvals/rules', { kind: 'PURCHASE_ORDER', companyId: null, name: 'The buyer checks big orders (made-up)', condition: { combinator: 'and', rows: [] }, approver: { userId: PEOPLE.buyer }, sequence: 1 }, 201)).rule
    await ok('owner', 'PUT', `/approvals/rules/${named.id}`, { version: named.version, active: true })
    const order = await draftOrder('buyer', '900')
    expect(paths(await no('buyer', 'POST', '/approvals/requests', { kind: 'PURCHASE_ORDER', recordId: order.id }, 409))).toEqual(['approver'])
    const byOwner = (await ask('owner', order.id)).task
    expect(byOwner.approver).toMatchObject({ kind: 'PERSON', id: PEOPLE.buyer })
    const back = (await ok('owner', 'GET', `/approvals/rules/${named.id}`)).rule
    await ok('owner', 'PUT', `/approvals/rules/${named.id}`, { version: back.version, active: false })
  })
})

describe('a signature with its meaning and a fresh step-up (PLT-105)', () => {
  it('asks the step-up where the rule says; signs APPROVED with the meaning, and the history says so', async () => {
    rule = (await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: true, signatureMeaning: 'RELEASED', requireStepUp: true })).rule
    expect(rule.sentence.en).toBe("Purchase order: order value over 5000 → Finance, signed 'Released'")
    const order = await draftOrder('buyer', '1000')
    const task = (await ask('buyer', order.id)).task
    expect(task).toMatchObject({ signatureMeaning: 'RELEASED', requireStepUp: true })
    // A session without a fresh code: refused with the step-up.
    expect(paths(await no('finance', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version }, 403))).toEqual(['stepUp'])
    // A finance person signed in for real, with two-factor and a fresh code (the clock a little before the server's).
    h.clock.set(new Date(Date.now() - 4 * 60_000))
    const signer = await signedIn(`w2b282-signer-${run}@example.com`, 'finance')
    await stepUp(h, signer.browser, signer.secret)
    const signed = (await as(signer, 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: null })).task
    expect(signed).toMatchObject({ status: 'APPROVED', signatureMeaning: 'RELEASED', decided: { by: { id: signer.id } } })
    expect(signed.decided.stepUpAt).not.toBeNull()
    expect(signed.history.map((entry: Json) => [entry.action, entry.meaning])).toEqual([
      ['SIGNED', 'RELEASED'],
      ['APPROVED', 'RELEASED'],
      ['REQUESTED', null],
    ])
    rule = (await ok('owner', 'GET', `/approvals/rules/${rule.id}`)).rule
    rule = (await ok('owner', 'PUT', `/approvals/rules/${rule.id}`, { version: rule.version, active: false, signatureMeaning: null, requireStepUp: false })).rule
  })
})

describe('the history on the record (PLT-104)', () => {
  it('a purchase order: every request line, newest first', async () => {
    const history = await ok('buyer', 'GET', `/approvals/history/PurchaseOrder/${orderA.id}`)
    expect(history.lines.map((entry: Json) => entry.action)).toEqual(['APPROVED', 'REQUESTED', 'STALE', 'REQUESTED'])
    expect(history.lines[0]).toMatchObject({ source: 'ApprovalEvent', by: { kind: 'PERSON', id: PEOPLE.finance, name: NAMES.finance }, words: 'Within the season budget.' })
    expect(history.lines[2].by).toEqual({ kind: 'SYSTEM', id: null, name: 'Nexus', me: false })
    const page = await ok('buyer', 'GET', `/approvals/history/PurchaseOrder/${orderA.id}?limit=3`)
    expect(page.nextCursor).toBe('o:3')
    expect((await ok('buyer', 'GET', `/approvals/history/PurchaseOrder/${orderA.id}?limit=3&cursor=o:3`)).lines).toHaveLength(1)
  })

  it('the domain approvals through the same registry: a quote, a change order (with a line a step wrote here)', async () => {
    const q1 = await one<{ id: string }>(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0001'`, [A.tenant])
    const quote = await ok('owner', 'GET', `/approvals/history/Quote/${q1.id}`)
    expect(quote.lines.map((entry: Json) => [entry.source, entry.action])).toEqual([
      ['QuoteApproval', 'APPROVED'],
      ['QuoteApproval', 'REQUESTED'],
    ])
    // The W1 seed no longer approves its own request (B-W2b-282): the member decided it, the Owner asked it.
    expect(quote.lines[0].by.id).toBe(A.member)
    expect(quote.lines[1].by.id).toBe(A.owner)
    const eco = await ok('owner', 'GET', `/approvals/history/ChangeOrder/${firstId('changes:order:JKT-02:1')}`)
    expect(eco.lines.map((entry: Json) => entry.source)).toEqual(expect.arrayContaining(['ApprovalEvent', 'ChangeApproval']))
    expect(eco.lines.find((entry: Json) => entry.source === 'ApprovalEvent').action).toBe('COMMENTED')
    await no('owner', 'GET', `/approvals/history/Nothing/${q1.id}`, undefined, 404)
    // A reader without the quote's own view permission does not read its history.
    await no('finance', 'GET', `/approvals/history/ChangeOrder/${firstId('changes:order:JKT-02:1')}`, undefined, 404)
  })
})

describe('nobody approves their own request on any existing approval, the Owner included (PLT-042, Owner answer Q3 = A)', () => {
  it('a quote: the person who asked for the margin approval, holding every permission', async () => {
    // SEED-Q-0002 (a draft) made to wait for a margin approval the seed Owner asked (test data past the guards).
    const draft = await one<{ quoteId: string; versionId: string; partyId: string }>(
      `SELECT q.id AS "quoteId", v.id AS "versionId", q."partyId" FROM "Quote" q JOIN "QuoteVersion" v ON v."quoteId" = q.id WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0002' ORDER BY v.revision DESC LIMIT 1`,
      [A.tenant],
    )
    await force(`UPDATE "QuoteVersion" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [draft.versionId])
    await force(`UPDATE "Quote" SET status = 'PENDING_APPROVAL' WHERE id = $1`, [draft.quoteId])
    await force(
      `INSERT INTO "QuoteApproval" (id, "tenantId", "versionId", "partyId", reasons, details, "requestNote", status, "createdAt", "updatedAt", "createdById")
       VALUES ($1, $2, $3, $4, ARRAY['MARGIN_FLOOR']::"QuoteApprovalReason"[], '{}'::jsonb, 'Asked by the Owner (made-up).', 'PENDING', now(), now(), $5)`,
      [newId(), A.tenant, draft.versionId, draft.partyId, A.owner],
    )
    const pending = { quoteId: draft.quoteId, version: (await one<{ version: number }>(`SELECT version FROM "Quote" WHERE id = $1`, [draft.quoteId])).version }
    SESSIONS.quoteAsker = sessionOf(A.owner, 'owner')
    const error = await no('quoteAsker', 'POST', `/sales/quotes/${pending.quoteId}/approval/approve`, { version: pending.version }, 403)
    expect(error.message).toBe('You asked for this approval: another approver decides.')
    await no('quoteAsker', 'POST', `/sales/quotes/${pending.quoteId}/approval/reject`, { version: pending.version, reason: 'x' }, 403)
  })

  it('a change order: its author (the seed Owner)', async () => {
    const order = await one<{ id: string; version: number; authorId: string }>(`SELECT id, version, "authorId" FROM "ChangeOrder" WHERE id = $1`, [firstId('changes:order:JKT-02:1')])
    expect(order.authorId).toBe(A.owner)
    expect(paths(await no('seedOwner', 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'APPROVED' }, 409))).toEqual(['refusal/OWN_APPROVAL'])
  })

  it('an SMV change: who proposed it', async () => {
    const version = await one<{ id: string; version: number; proposedById: string; operationId: string }>(`SELECT id, version, "proposedById", "operationId" FROM "OperationTimeVersion" WHERE id = $1`, [firstId('instructions:smv:CUT:2')])
    expect(version.proposedById).toBe(A.owner)
    const error = await no('seedOwner', 'POST', `/product/operations/${version.operationId}/minutes/versions/${version.id}/approve`, { version: version.version }, 403)
    expect(error.message).toMatch(/proposed|own/i)
  })

  it('an NCR decision that needs a yes: who decided it', async () => {
    const decisionId = firstId('holds:ncr:NCR-0002:decision:1')
    await admin(`UPDATE "NcrDispositionLine" SET "approvalRequired" = true WHERE id = $1`, [decisionId])
    const decision = await one<{ version: number; decidedById: string }>(`SELECT version, "decidedById" FROM "NcrDispositionLine" WHERE id = $1`, [decisionId])
    expect(decision.decidedById).toBe(A.owner)
    const error = await no('seedOwner', 'POST', `/quality/ncr/${id('holds:ncr:NCR-0002')}/decisions/${decisionId}/approve`, { version: decision.version }, 409)
    expect(error.message).toBe('You decided this: another person approves it (four eyes).')
  })

  it('a work instruction version: its author', async () => {
    const draft = await one<{ version: number; authorId: string }>(`SELECT version, "authorId" FROM "WorkInstructionVersion" WHERE id = $1`, [firstId('instructions:wi:2:v3')])
    expect(draft.authorId).toBe(A.owner)
    expect(paths(await no('seedOwner', 'POST', `/production/instructions/${id('instructions:wi:2')}/versions/${firstId('instructions:wi:2:v3')}/publish`, { version: draft.version }, 409))).toEqual(['refusal/OWN_DRAFT'])
  })

  it('scrap above the limit and a timesheet: the Owner is the floor worker’s office account and the employee', async () => {
    const people = await seedPeople({ db: h.database, namespace: NS })
    const production = await seedProduction({ db: h.database, namespace: NS })
    // The Owner is E1, the operator: one office account for the worker and the employee (the link guard wants both).
    await force(`UPDATE "Employee" SET "userId" = $2 WHERE id = $1`, [people.employeeIds.e1, A.owner])
    await force(`UPDATE "Worker" SET "userId" = $2 WHERE id = $1`, [A.operator, A.owner])
    // Scrap: the site's limit is 1 garment; the operator's report scraps 2, so it waits for a yes.
    await ok('seedOwner', 'POST', `/production/settings/${A.siteA1}/floor-rules`, { scrapApprovalLimit: 1, reason: 'Leather is dear (made-up).' })
    const scanId = newId()
    await h.database.withScope({ audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1 }, (client) =>
      client.$transaction(async (tx) => {
        await tx.operationScan.create({
          data: {
            id: scanId,
            siteId: A.siteA1,
            workOrderId: production.workOrderId,
            workOrderOperationId: production.operationIds.qc,
            bundleId: production.bundleIds[1],
            kind: 'REPORT',
            goodQuantity: 0,
            scrapQuantity: 2,
            scrapReason: 'STAIN',
            workerId: A.operator,
            stationId: A.qcStation,
            deviceId: A.device,
            clientScanId: `w2b282-${run}-scrap`,
            deviceTime: new Date(),
            serverTime: new Date(),
            createdById: A.operator,
          },
          select: { id: true },
        })
        await tx.operationScanDefect.create({ data: { id: newId(), siteId: A.siteA1, scanId, kind: 'SCRAP', reasonCode: 'STAIN', quantity: 2, createdById: A.operator }, select: { id: true } })
        // The scans' hook in the report's own command: the WAITING row with the limit in force.
        await tx.scrapApproval.create({ data: { id: newId(), siteId: A.siteA1, scanId, limitPieces: 1, key: scrapApprovalKey(scanId), createdById: A.operator }, select: { id: true } })
      }),
    )
    expect((await one<{ status: string }>(`SELECT status::text AS status FROM "ScrapApproval" WHERE "scanId" = $1`, [scanId])).status).toBe('WAITING')
    expect(paths(await no('seedOwner', 'POST', `/production/scrap/over-limit/${scanId}/approve`, {}, 409))).toEqual(['refusal/SELF_DECISION'])
    // The scan's history reads the domain table.
    expect((await ok('seedOwner', 'GET', `/approvals/history/OperationScan/${scanId}`)).lines).toMatchObject([{ source: 'ScrapApproval', action: 'REQUESTED', by: { kind: 'WORKER', id: A.operator } }])
    // Timesheet: E1's October timesheet, with the site's attendance switched on (the people seed keeps it off).
    const notice = await one<{ id: string }>(`SELECT id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'PUBLISHED' LIMIT 1`, [A.tenant, A.companyA])
    const dpia = await one<{ id: string }>(`SELECT id FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'STORED' LIMIT 1`, [A.tenant, A.companyA])
    await admin(
      `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ATTENDANCE', 'NOT_REQUIRED', 'SAMPLE - made-up counsel opinion (art. 4 c.2)', $5, $6, now() - interval '400 days', $7, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, notice.id, dpia.id, A.owner],
    )
    const sheetId = firstId('time:timesheet:A1:operator:2026-10')
    const sheet = await one<{ version: number }>(`SELECT version FROM "TimesheetApproval" WHERE id = $1`, [sheetId])
    expect(paths(await no('seedOwner', 'POST', `/people/timesheets/${sheetId}/lead-approve`, { version: sheet.version }, 409))).toContain('holds/OWN_TIMESHEET')
    expect(paths(await no('seedOwner', 'POST', `/people/timesheets/${sheetId}/hr-approve`, { version: sheet.version }, 409))).toContain('holds/OWN_TIMESHEET')
  })

  it('an inspection plan version: its author, signed in for real with a fresh code', async () => {
    h.clock.set(new Date(Date.now() - 4 * 60_000))
    const author = await signedIn(`w2b282-plan-author-${run}@example.com`, 'owner')
    const made = await as(author, 'POST', '/quality/plans', { companyId: A.companyA, code: `W2B282-${run}`.toUpperCase().slice(0, 20), stage: 'CUTTING', name: 'Cutting, by the Owner (made-up)', startFrom: { kind: 'STARTER', code: 'CUT-PANELS' } }, 201)
    await stepUp(h, author.browser, author.secret)
    const { version } = await as(author, 'GET', `/quality/plans/${made.plan.id}/versions/${made.current.id}`)
    const own = await as(author, 'POST', `/quality/plans/${made.plan.id}/versions/${made.current.id}/approve`, { version: version.version }, 409)
    expect(own.error.issues[0].path).toBe('refusal/AUTHOR')
  })
})
