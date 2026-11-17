import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
import { PARTNER_LIVE_EVENTS, partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
import { ISSUE_WORDS, PROBLEM_WORDS } from '@nexus/factory-domain/production-brand/issues'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command, type CommandCaller, type CommandTx } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { personReads } from '../../../platform/threads/followers'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { forgetProgress } from '../../sales/portal-orders/progress'
import { findMarkers, markersOf, productionTwoBrands, supervisorPeople, supervisorPeopleIds, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'
import { issueAnswered, ISSUE_ANSWERED_EVENTS } from './answered'
import { issueClockOf, runIssueEscalation, ISSUE_ESCALATION_CRON, issueEscalationCron } from './escalate'
import { issueDueOn, issueEscalationTaskId } from './raise'
// F-PR-05b: the bell's words of an issue's task.
import { sentenceOf } from '@nexus/factory-domain/notifications/rules'
import { ruleContext } from '../../../platform/notifications/fan-out'
import { ASSIGNMENT_RULES } from '../../../platform/notifications/rules/assignments'
import { issueBellOf } from './bell'

/**
 * B-PR-45 — the customer reports a problem, issues escalate, the office's issue list (production plan §1 "Report a problem on one
 * or many orders: it lands in each order's thread and reaches that order's supervisor as ONE task per batch. The brand sees
 * 'Waiting on us since …' until we really reply in the thread", §3 "Issues", §7.12; L24, L25; R-41, R-42, R-43, R-44, R-48),
 * with its wall tests PW-17 (brand B reports on brand A's id: neither acted on nor named; issue and escalation tasks go only to
 * people who read that order; the brand sees only its own reports, never who) and PW-15 (the brand's read and answers name no
 * person; production_issue.* has no partner live entry). The Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On the local stack, through the real app and the real portal sign-in by code: the seeds up to shipping, the production two-brand
 * harness (brand A = the seeds' P1, brand B = the threads' second brand with SEED-SO-B001 and its open BRAND issue raised on
 * 29 Oct, before this step — the scan must escalate it too), B's two more orders in production (B2, B4) and one cancelled (B3),
 * the supervisor people (REAL users: supervisorA limited to A, backupA over every customer, officeB limited to B), the production
 * managers pmA (limited to A) and pmB (limited to B) and an administrator over every customer, each with a made-up role that
 * lets them hold tasks and read the threads of the customers they reach. A's default supervisor is supervisorA (backup backupA),
 * B's officeB (no backup: B's step 1 goes to the production managers). Portal people: B's Production person and B's Viewer (no
 * portal.comment), A's Production person.
 *
 * The tests run in order on one database. Every name is made up. Run with
 * `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/issues/issues`.
 */

let h: Harness
let officeApp: FastifyInstance
let w: ProductionTwoBrands
let tenant: TestTenant
let system: CommandCaller
const NS = 'pr45-issues'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const companyA = seedUuid(NS, 'company:A')
const actorId = seedUuid(NS, 'actor')
const people = supervisorPeopleIds(NS)
const fixed = (key: string) => `ffffffff${seedUuid(NS, `pr45:${key}`).slice(8)}`
const staff = { pmA: fixed('user:pmA'), pmB: fixed('user:pmB'), adminAll: fixed('user:adminAll') }
const STAFF_NAMES = { pmA: 'T Production Manager Alpha', pmB: 'T Production Manager Beta', adminAll: 'T Administrator All' }

const OFFICE_PERMISSIONS: Permission[] = ['workorders.view', 'orders.view', 'production.brand.manage', 'sales.measurements.view', 'threads.read', 'threads.post', 'threads.manage', 'home.view', 'tasks.manage']
const grant = (permissions: Permission[], parties: 'all' | string[]) => ({ permissions, companies: 'all' as const, sites: 'all' as const, parties })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS),
  // B's supervisor himself (his own tasks: "mine"), and a person with neither workorders.view nor orders.view.
  'office.officeB': { audience: 'office', tenantId: T, actorId: people.officeB, grants: [grant(OFFICE_PERMISSIONS, [ids.b])] },
  'office.none': { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['home.view', 'tasks.manage'], 'all')] },
}

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R | undefined> => (await admin<R>(sql, values))[0]
async function replica(statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query('SET LOCAL session_replication_role = replica')
    for (const statement of statements) await h.db.admin.query(statement.sql, statement.values ?? [])
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const officeScope = () => ({ audience: 'office' as const, tenantId: T, actorId })

// ---- the office's calls (test sessions) --------------------------------------------------------------------------------------
async function call(session: string, url: string, payload?: unknown, method: 'POST' | 'GET' | 'PUT' = 'GET'): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = method === 'GET' ? { 'x-test-session': session } : { 'x-test-session': session, 'idempotency-key': newId() }
  const response = await officeApp.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, url: string, payload?: unknown, method: 'POST' | 'GET' | 'PUT' = 'GET'): Promise<Json> {
  const answer = await call(session, url, payload, method)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
const settingsVersion = async (partyId: string) => (await one<{ version: number }>(`SELECT version FROM "PortalSettings" WHERE "partyId" = $1`, [partyId]))?.version ?? 0
const taskOf = (taskId: string) =>
  one<Json>(`SELECT id, "partyId", "recordType", "recordId", "recordLabel", "assigneeId", "assignedById", "createdById", "dueDate"::text AS "dueDate", "dueTime", status::text AS status, title, description, "messageId", version FROM "Task" WHERE id = $1`, [taskId])
const issuesOfBatch = (batchId: string) =>
  admin<Json>(
    `SELECT id, "companyId", "siteId", "partyId", "recordType", "recordId", "salesOrderId", "taskId", "messageId", source::text AS source, "batchId", status::text AS status, "raisedAt", "dueDate"::text AS "dueDate", "escalationStep", "escalatedAt", "createdById" FROM "ProductionIssue" WHERE "batchId" = $1 ORDER BY "raisedAt", id`,
    [batchId],
  )

// ---- the outbox, as the relay hands it to the worker ----------------------------------------------------------------------------
const handled = new Set<string>()
async function outbox(type: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}
async function fresh(...types: string[]): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for (const type of types) for (const event of await outbox(type)) if (!handled.has(event.eventId)) out.push(event)
  for (const event of out) handled.add(event.eventId)
  return out.sort((x, y) => x.occurredAt.localeCompare(y.occurredAt))
}
/** B-PR-43b's handler on each answering event since the last call, in order (as the relay would). */
async function answerAll(): Promise<number> {
  let answered = 0
  for (const event of await fresh(...ISSUE_ANSWERED_EVENTS)) answered += (await issueAnswered(system, event)).answered
  return answered
}

const officeActor = (session: string): Actor => ({ audience: 'office', tenantId: T, grants: (SESSIONS[session] as Extract<SessionContext, { audience: 'office' }>).grants })
const partnerOf = (partyId: string): Actor => ({ audience: 'partner', tenantId: T, partyId, grants: [{ permissions: ['portal.production.view', 'portal.home.view', 'portal.comment'], companies: 'all', sites: 'all', parties: [partyId] }] })

/** A shared message to the customer in an order's thread, written by a person of the office through threads' own seam. */
async function shareOn(orderId: string, at: Date): Promise<string> {
  const caller = callerFor(h.database, { audience: 'office', tenantId: T, actorId: people.backupA, grants: [grant(OFFICE_PERMISSIONS, 'all')], requestId: newId() })
  const { result } = await command(caller, { name: 'test.shareOnOrder', input: { orderId } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: orderId }, people.backupA)
    const message = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: people.backupA, name: 'T Backup Alpha' }, bodyText: 'Made-up answer: we change the zip on Monday.', at })
    return message.id
  })
  return result
}

// ---- the portal --------------------------------------------------------------------------------------------------------------
const portal = { betaProd: 'paola.production@pr45-beta.example.com', betaViewer: 'vito.viewer@pr45-beta.example.com', alphaProd: 'alba.production@pr45-alpha.example.com' }
const browsers = {} as Record<keyof typeof portal, Browser>
/** Every answer B's people got, for the scans. */
const seenByB: { url: string; body: unknown }[] = []
let aMarkers: Marker[] = []
let officeWords: Marker[] = []

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope(officeScope(), async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

async function report(who: keyof typeof portal, orderIds: readonly string[], body: string, key: string = newId()): Promise<{ status: number; body: Json }> {
  const answer = await browsers[who].post('/portal/production/problems', { orderIds, body }, { headers: { 'idempotency-key': key } })
  if (who !== 'alphaProd') seenByB.push({ url: 'POST /portal/production/problems', body: answer.body })
  return { status: answer.status, body: answer.body as Json }
}
async function portalGet(who: keyof typeof portal, url: string): Promise<Json> {
  const answer = await browsers[who].get(url)
  if (who !== 'alphaProd') seenByB.push({ url, body: answer.body })
  expect(answer.status, `${who} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(200)
  return answer.body as Json
}

const log = { info() {}, warn() {}, error() {} }
const clockAt = (at: Date) => ({ now: () => new Date(at.getTime()) })

/** B's other orders: two more in production (CONFIRMED) and one cancelled. */
const beta2 = { orderId: newId(), number: 'T-PR45-SO-B2', customerRef: 'T-PR45-PO-B2' }
const beta3 = { orderId: newId(), number: 'T-PR45-SO-B3', customerRef: 'T-PR45-PO-B3' }
const beta4 = { orderId: newId(), number: 'T-PR45-SO-B4', customerRef: 'T-PR45-PO-B4' }

/** The made-up role of the test's office people: they hold tasks and read the threads of the customers they reach. */
async function officeStaff(): Promise<void> {
  const at = new Date('2026-11-10T08:00:00.000Z')
  await h.database.withScope(officeScope(), (client) =>
    client.$transaction(async (tx) => {
      const roleId = fixed('role:tasks')
      const data = { key: 't-pr45-tasks', name: 'T tasks and threads (made up)', audience: 'OFFICE' as const, permissions: ['home.view', 'tasks.manage', 'threads.read'], grains: [] }
      await tx.role.upsert({ where: { id: roleId }, create: { id: roleId, ...data, createdAt: at }, update: data, select: { id: true } })
      const systemRole = async (key: string) => (await tx.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })).id
      const pm = await systemRole('production_manager')
      const adm = await systemRole('admin')
      for (const [key, name] of Object.entries(STAFF_NAMES) as [keyof typeof staff, string][]) {
        const user = { email: `${key.toLowerCase()}.${NS}@example.com`, displayName: name, status: 'ACTIVE' as const, requireMfa: false }
        await tx.user.upsert({ where: { id: staff[key] }, create: { id: staff[key], ...user, createdAt: at, createdById: actorId }, update: user, select: { id: true } })
      }
      const assignments: [string, string, string, string[]][] = [
        ['pmA:pm', staff.pmA, pm, [ids.a]],
        ['pmB:pm', staff.pmB, pm, [ids.b]],
        ['adminAll:admin', staff.adminAll, adm, []],
        ['pmA:tasks', staff.pmA, roleId, [ids.a]],
        ['pmB:tasks', staff.pmB, roleId, [ids.b]],
        ['adminAll:tasks', staff.adminAll, roleId, []],
        ['supervisorA:tasks', people.supervisorA, roleId, [ids.a]],
        ['officeB:tasks', people.officeB, roleId, [ids.b]],
        ['backupA:tasks', people.backupA, roleId, []],
      ]
      for (const [key, userId, role, parties] of assignments) {
        const assignmentId = fixed(`assignment:${key}`)
        const assignment = { userId, roleId: role, allCompanies: true, companyIds: [], siteIds: [], partyIds: parties, validFrom: at, grantedById: actorId }
        await tx.roleAssignment.upsert({ where: { id: assignmentId }, create: { id: assignmentId, ...assignment, createdAt: at }, update: assignment, select: { id: true } })
      }
    }),
  )
}

beforeAll(async () => {
  h = await startHarness('pr45_issues')
  // A little in the past: the sign-ins move the app's clock on, and what the portal writes must not be ahead of the database's.
  h.clock.set(new Date(Date.now() - 4 * 60_000))
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await h.database.withScope(officeScope(), async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
  })
  officeApp = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db: h.db, database: h.database, app: officeApp, namespace: NS })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])
  expect(await supervisorPeople({ database: h.database, namespace: NS }, w)).toEqual(people)
  await officeStaff()
  await ok('office.all', `/production/brands/${ids.a}/supervisor`, { supervisorId: people.supervisorA, backupId: people.backupA, version: await settingsVersion(ids.a) }, 'PUT')
  await ok('office.all', `/production/brands/${ids.b}/supervisor`, { supervisorId: people.officeB, backupId: null, version: await settingsVersion(ids.b) }, 'PUT')
  await h.database.withScope(officeScope(), async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })

  // B's other orders: B2 and B4 CONFIRMED (one line of our own jacket each), B3 cancelled.
  const bLine = (await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [w.b.salesOrderLineId]))!
  for (const order of [beta2, beta3, beta4]) {
    await h.database.withScope(officeScope(), (client) =>
      client.$transaction(async (tx) => {
        await tx.salesOrder.create({
          data: { id: order.orderId, companyId: w.companyId, partyId: ids.b, number: order.number, customerRef: order.customerRef, status: 'CONFIRMED', orderDate: new Date('2026-10-01T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer B' }, shipTo: { name: 'Made-up store B' }, promiseDate: new Date('2026-12-20T00:00:00.000Z') },
          select: { id: true },
        })
        const lineId = newId()
        await tx.salesOrderLine.create({ data: { id: lineId, companyId: w.companyId, orderId: order.orderId, partyId: ids.b, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId: bLine.colourwayId, quantity: 4, unitPrice: '100.000000', netAmount: 40_000, vatRatePct: '22.00', vatAmount: 8_800 }, select: { id: true } })
        await tx.salesOrderLineSize.createMany({ data: [['50', 2], ['52', 2]].map(([size, quantity]) => ({ id: newId(), lineId, partyId: ids.b, size: size as string, quantity: quantity as number })) })
      }),
    )
  }
  await replica([{ sql: `UPDATE "SalesOrder" SET status = 'CANCELLED' WHERE id = $1`, values: [beta3.orderId] }])

  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(portal.betaProd, ids.b, ['customer-production'])
  await partnerPerson(portal.betaViewer, ids.b, ['customer-viewer'])
  await partnerPerson(portal.alphaProd, ids.a, ['customer-production'])
  for (const person of Object.keys(portal) as (keyof typeof portal)[]) browsers[person] = await signedIn(portal[person])
  system = callerFor(h.database, systemContext(T, newId()))
  // Whatever the harness wrote before is not this suite's to answer.
  await fresh(...ISSUE_ANSWERED_EVENTS)

  aMarkers = [...(await markersOf(h.db, ids.a)), { label: "A's order", text: w.a.salesOrderId }]
  const officeNames = await admin<{ id: string; displayName: string; email: string }>(`SELECT id::text, "displayName", email FROM "User" WHERE id = ANY($1::uuid[])`, [[...Object.values(people), ...Object.values(staff)]])
  officeWords = officeNames.flatMap((user) => [
    { label: 'office person', text: user.displayName },
    { label: 'office e-mail', text: user.email },
    { label: 'office id', text: user.id },
  ])
}, 420_000)

beforeEach(() => {
  freshGuard(h)
  forgetProgress()
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  forgetProgress()
  await officeApp?.close()
  await h?.close()
}, 60_000)

const BODY = 'Made-up: the zip of size 52 jams on the first try.'
let batch: Json
let batchIssues: Json[] = []
let batchTask: Json
const reportKey = `pr45-report-${newId()}`

describe('B-PR-45 Report a problem (POST /portal/production/problems)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('PW-17: one message in each OWN order’s thread, one issue each (one batch), ONE task on the first order for its supervisor; A’s id neither acted on nor named; a cancelled order refused in words', async () => {
    const answer = await report('betaProd', [w.b.salesOrderId, w.a.salesOrderId, beta2.orderId, beta3.orderId], BODY, reportKey)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    batch = answer.body
    expect(batch.notFound).toBe(1)
    expect(batch.replayed).toBe(false)
    expect(batch.results.map((row: Json) => [row.orderId, row.done])).toEqual([
      [w.b.salesOrderId, true],
      [beta2.orderId, true],
      [beta3.orderId, false],
    ])
    expect(batch.results[2].words).toEqual(PROBLEM_WORDS.NOT_IN_PRODUCTION)
    const today = businessDate(h.clock.now())
    for (const row of batch.results.slice(0, 2)) expect(row.problem).toMatchObject({ state: 'WAITING_ON_US', since: today, words: { en: expect.stringContaining('Waiting on us since') } })
    expect(findMarkers(batch, aMarkers)).toEqual([])
    expect(findMarkers(batch, officeWords)).toEqual([])

    // One INBOUND portal message by the person in each own order's thread; none in A's thread, none in the cancelled order's.
    const messages = async (orderId: string) =>
      admin(`SELECT m.id::text, m.direction::text, m.channel::text, m."authorKind"::text, m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1 AND m."bodyText" = $2`, [orderId, BODY])
    for (const orderId of [w.b.salesOrderId, beta2.orderId]) expect((await messages(orderId)).map((row) => [row.direction, row.channel, row.authorKind]), orderId).toEqual([['INBOUND', 'PORTAL', 'PARTY']])
    expect(await messages(w.a.salesOrderId)).toEqual([])
    expect(await messages(beta3.orderId)).toEqual([])

    // The issues: one per posted order, source BRAND, one batch, B's own, each with its message; due raise + 1 working day.
    batchIssues = await issuesOfBatch(batch.batchId)
    expect(batchIssues.map((issue) => issue.recordId).sort()).toEqual([w.b.salesOrderId, beta2.orderId].sort())
    for (const issue of batchIssues) {
      expect(issue).toMatchObject({ partyId: ids.b, companyId: w.companyId, siteId: null, recordType: 'SalesOrder', salesOrderId: issue.recordId, source: 'BRAND', status: 'OPEN', escalationStep: 0, escalatedAt: null })
      expect((await messages(issue.recordId)).map((row) => row.id)).toEqual([issue.messageId])
    }
    expect(new Set(batchIssues.map((issue) => issue.taskId)).size).toBe(1)
    const dueOn = await h.database.withScope(officeScope(), (client) => issueDueOn({ tx: client as unknown as CommandTx, now: new Date(batchIssues[0]!.raisedAt) }, w.companyId))
    for (const issue of batchIssues) expect(issue.dueDate).toBe(dueOn)

    // ONE task for the batch on the FIRST order (a sales order: it carries B's wall), for its supervisor; made by the system.
    batchTask = (await taskOf(batchIssues[0]!.taskId))!
    const nameB = (await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [ids.b]))!.name
    expect(batchTask).toMatchObject({ partyId: ids.b, recordType: 'SalesOrder', recordId: w.b.salesOrderId, recordLabel: 'SEED-SO-B001', assigneeId: people.officeB, createdById: null, dueDate: dueOn, dueTime: '08:00', status: 'OPEN' })
    expect(batchTask.messageId).toBe(batchIssues.find((issue) => issue.recordId === w.b.salesOrderId)!.messageId)
    expect(batchTask.title).toBe(`Rispondi al problema segnalato da ${nameB} su 2 ordini`)
    expect(batchTask.description).toContain('SEED-SO-B001')
    expect(batchTask.description).toContain(beta2.number)
    expect(findMarkers(batchTask, aMarkers)).toEqual([])
  })

  it('PW-15: production_issue.raised per issue reaches the production unit and office.p2 only — never office.p1, never a partner; the bell is the system’s', async () => {
    const raised = (await outbox('production_issue.raised')).filter((event) => (event.payload as Json).batchId === batch.batchId)
    expect(raised).toHaveLength(2)
    for (const event of raised) {
      expect(event.payload).toMatchObject({ partyId: ids.b, source: 'BRAND', recordType: 'SalesOrder', batchId: batch.batchId })
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))!
      expect(liveViewFor(message, officeActor('office.all'), EVENT_CATALOGUE)).not.toBeNull()
      expect(liveViewFor(message, officeActor('office.p2'), EVENT_CATALOGUE)).not.toBeNull()
      expect(liveViewFor(message, officeActor('office.p1'), EVENT_CATALOGUE)).toBeNull()
      for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE)).toBeNull()
      expect(JSON.stringify(event.payload)).not.toContain('zip')
    }
    expect(Object.keys(PARTNER_LIVE_EVENTS).filter((type) => type.startsWith('production_issue.') || type.startsWith('task.'))).toEqual([])
    const assigned = (await outbox('task.assigned')).filter((event) => (event.payload as Json).taskId === batchTask.id)
    expect(assigned.map((event) => event.payload)).toEqual([expect.objectContaining({ assigneeId: people.officeB, assignedById: null })])
    // One audit row per batch, naming only B's orders.
    const audits = await admin(`SELECT "recordId"::text, after FROM "AuditLog" WHERE action = 'production.issuesRaised' AND after->>'batchId' = $1`, [batch.batchId])
    expect(audits).toHaveLength(1)
    expect(audits[0]!.recordId).toBe(ids.b)
    expect(JSON.stringify(audits[0]!.after)).not.toContain(w.a.salesOrderId)
  })

  it('a retry with the same key answers the same batch: no second message, no second issue, no second task', async () => {
    const before = await one<{ issues: number; tasks: number; messages: number }>(
      `SELECT (SELECT count(*)::int FROM "ProductionIssue" WHERE "tenantId" = $1) AS issues, (SELECT count(*)::int FROM "Task" WHERE "tenantId" = $1) AS tasks, (SELECT count(*)::int FROM "Message" WHERE "tenantId" = $1 AND "bodyText" = $2) AS messages`,
      [T, BODY],
    )
    const again = await report('betaProd', [w.b.salesOrderId, w.a.salesOrderId, beta2.orderId, beta3.orderId], BODY, reportKey)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.batchId).toBe(batch.batchId)
    expect(again.body.results.map((row: Json) => row.done)).toEqual([true, true, false])
    expect(
      await one(
        `SELECT (SELECT count(*)::int FROM "ProductionIssue" WHERE "tenantId" = $1) AS issues, (SELECT count(*)::int FROM "Task" WHERE "tenantId" = $1) AS tasks, (SELECT count(*)::int FROM "Message" WHERE "tenantId" = $1 AND "bodyText" = $2) AS messages`,
        [T, BODY],
      ),
    ).toEqual(before)
  })

  it('PW-17: A’s order alone is as unknown as a made-up id (404, neutral); B’s Viewer may not write (403 in the thread’s words); a preview-free refusal writes nothing', async () => {
    const count = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ProductionIssue" WHERE "tenantId" = $1`, [T]))!.n
    const before = await count()
    const foreign = await report('betaProd', [w.a.salesOrderId], 'Made-up: about an order that is not ours.')
    const unknown = await report('betaProd', [newId()], 'Made-up: about an order that is not ours.')
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(foreign.body.error.message).toBe('Order not found.')
    expect(foreign.body.error).toMatchObject({ code: unknown.body.error.code, message: unknown.body.error.message })
    expect(findMarkers(foreign.body, aMarkers)).toEqual([])
    const viewer = await report('betaViewer', [w.b.salesOrderId], 'Made-up: a viewer writes.')
    expect(viewer.status).toBe(403)
    // The thread's own refusal words (partnerThreadWords NO_COMMENT), in the person's language: they name nobody.
    expect(viewer.body.error.message).toBeTruthy()
    expect(findMarkers(viewer.body, officeWords)).toEqual([])
    expect(await count()).toBe(before)
    // Named twice: 400.
    expect((await report('betaProd', [beta2.orderId, beta2.orderId], 'Made-up.')).status).toBe(400)
  })

  it('PW-17: the task goes only to a person who reads the order — a supervisor limited to A is skipped, then the production manager of B (never A’s)', async () => {
    // B's default supervisor made someone limited to A (the route refuses that: PW-14; written here as a broken setting would be).
    await replica([{ sql: `UPDATE "PortalSettings" SET "productionSupervisorId" = $2 WHERE "partyId" = $1`, values: [ids.b, people.supervisorA] }])
    try {
      const answer = await report('betaProd', [beta4.orderId], 'Made-up: the label on this order is missing.')
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      const [issue] = await issuesOfBatch(answer.body.batchId)
      const task = (await taskOf(issue!.taskId))!
      expect(task.assigneeId).toBe(staff.pmB)
      expect([people.supervisorA, staff.pmA]).not.toContain(task.assigneeId)
    } finally {
      await replica([{ sql: `UPDATE "PortalSettings" SET "productionSupervisorId" = $2 WHERE "partyId" = $1`, values: [ids.b, people.officeB] }])
    }
  })

  it('A’s report on its own order goes to A’s supervisor, nothing of it reaches B', async () => {
    const answer = await report('alphaProd', [w.a.salesOrderId], 'Made-up: Alpha’s sleeve is too short.')
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const [issue] = await issuesOfBatch(answer.body.batchId)
    expect(issue).toMatchObject({ partyId: ids.a, recordId: w.a.salesOrderId, source: 'BRAND' })
    expect((await taskOf(issue!.taskId))!.assigneeId).toBe(people.supervisorA)
  })

  it('PW-15: B reads "Waiting on us since …" on its orders (its oldest open report first), never a person', async () => {
    const list = await portalGet('betaProd', '/portal/production')
    const row = (orderId: string) => list.items.find((item: Json) => item.id === orderId)
    // SEED-SO-B001 holds the harness's report of 29 Oct too: its oldest open one.
    expect(row(w.b.salesOrderId).problem).toMatchObject({ state: 'WAITING_ON_US', since: '2026-10-29' })
    expect(row(beta2.orderId).problem).toMatchObject({ state: 'WAITING_ON_US', since: businessDate(new Date(batchIssues[0]!.raisedAt)) })
    expect(findMarkers(list, officeWords)).toEqual([])
    expect(findMarkers(list, aMarkers)).toEqual([])
  })
})

describe('B-PR-45 the office’s issue list (GET /production/issues)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the brand wall: the production unit reads both customers, office.p2 only B, office.p1 only A; another customer named → 404; no read right → 403', async () => {
    const all = await ok('office.all', '/production/issues?limit=200')
    const parties = (list: Json) => [...new Set(list.issues.map((issue: Json) => issue.customer.id))].sort()
    expect(parties(all)).toEqual([ids.a, ids.b].sort())
    const p2 = await ok('office.p2', '/production/issues?limit=200')
    expect(parties(p2)).toEqual([ids.b])
    expect(findMarkers(p2, aMarkers)).toEqual([])
    const p1 = await ok('office.p1', '/production/issues?limit=200')
    expect(parties(p1)).toEqual([ids.a])
    const refused = await call('office.p2', `/production/issues?partyId=${ids.a}`)
    expect(refused.status).toBe(404)
    expect(refused.body.error.message).toBe('Customer not found.')
    expect((await call('office.none', '/production/issues')).status).toBe(403)
  })

  it('a row: source, status and words, its record and sales order, the customer, due day, the task as Me / Someone else / Not set, its batch, the words for a reader of the thread', async () => {
    const mine = await ok('office.officeB', `/production/issues?partyId=${ids.b}&mine=true`)
    expect(mine.issues.map((issue: Json) => issue.id).sort()).toEqual(batchIssues.map((issue) => issue.id).sort())
    for (const issue of mine.issues) {
      expect(issue).toMatchObject({ source: 'BRAND', status: 'OPEN', note: null, record: { type: 'SalesOrder' }, customer: { id: ids.b }, mine: true, task: { id: batchTask.id, status: 'OPEN', assignee: 'ME' }, batch: { id: batch.batchId, issues: 2 }, escalation: null })
      expect(issue.excerpt).toBe(BODY)
      expect(issue.dueOn).toBe(batchTask.dueDate)
    }
    expect(mine.counts.mine).toBe(2)
    const all = await ok('office.all', `/production/issues?partyId=${ids.b}&limit=200`)
    const harnessIssue = all.issues.find((issue: Json) => issue.id === w.production.issue.id)
    expect(harnessIssue.task.assignee).toBe('NOT_SET')
    expect(all.issues.find((issue: Json) => issue.id === batchIssues[0]!.id).task.assignee).toBe('SOMEONE_ELSE')
    // OPEN: the oldest waiting first.
    expect(all.issues[0].id).toBe(w.production.issue.id)
    expect(all.live.events).toEqual(expect.arrayContaining(['production_issue.raised', 'production_issue.answered', 'production_issue.escalated']))
    // No name of a person on a list.
    expect(findMarkers(all, officeWords.filter((marker) => marker.label === 'office person'))).toEqual([])
  })

  it('R-42: a ticked task without a reply keeps the issue open — the office reads "No reply sent yet", B still "Waiting on us"', async () => {
    await ok('office.all', `/tasks/${batchTask.id}/status`, { status: 'DONE', version: (await taskOf(batchTask.id))!.version }, 'POST')
    expect(await answerAll()).toBe(0)
    for (const issue of await issuesOfBatch(batch.batchId)) expect(issue.status).toBe('OPEN')
    const list = await ok('office.all', `/production/issues?partyId=${ids.b}&limit=200`)
    for (const id of batchIssues.map((issue) => issue.id)) {
      const row = list.issues.find((issue: Json) => issue.id === id)
      expect(row).toMatchObject({ status: 'OPEN', note: 'NO_REPLY_YET', noteWords: ISSUE_WORDS.NO_REPLY_YET, task: { status: 'DONE' }, mine: false })
    }
    expect(list.counts.noReplyYet).toBe(2)
    const portalList = await portalGet('betaProd', '/portal/production')
    expect(portalList.items.find((item: Json) => item.id === beta2.orderId).problem.state).toBe('WAITING_ON_US')
  })
})

describe('B-PR-45 escalation (cron production.issueEscalation)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let clock: { dueOn: string; backupAt: Date; ownerAt: Date }
  const escalationTasks = () =>
    admin<Json>(`SELECT id::text, "assigneeId"::text AS "assigneeId", "recordId"::text AS "recordId", status::text AS status, "createdById" FROM "Task" WHERE "tenantId" = $1 AND "createdById" IS NULL AND title LIKE ANY (ARRAY['Senza risposta%', 'No answer after%'])`, [T])

  beforeAll(async () => {
    const found = await h.database.withScope(officeScope(), (client) => issueClockOf(client, w.companyId, new Date(batchIssues[0]!.raisedAt)))
    expect(found).not.toBeNull()
    clock = found!
  })

  it('the cron: clustered, every 15 minutes', () => {
    const job = issueEscalationCron({ database: h.database, log })
    expect(job.name).toBe(ISSUE_ESCALATION_CRON)
    expect(job.schedule).toBe('*/15 * * * *')
  })

  it('before 08:00 on raise + 1 working day nothing of this batch moves; the report raised before this step (29 Oct) goes up at once, both steps', async () => {
    await runIssueEscalation({ database: h.database, log, clock: clockAt(new Date(clock.backupAt.getTime() - 60_000)) })
    for (const issue of await issuesOfBatch(batch.batchId)) expect(issue.escalationStep).toBe(0)
    const old = (await one<Json>(`SELECT "escalationStep", "escalatedAt" FROM "ProductionIssue" WHERE id = $1`, [w.production.issue.id]))!
    expect(old.escalationStep).toBe(2)
    expect(old.escalatedAt).not.toBeNull()
    expect((await escalationTasks()).filter((task) => task.id === issueEscalationTaskId(w.production.issue.taskId, 1, staff.pmB))).toHaveLength(1)
  })

  it('step 1 at 08:00 on raise + 1 working day: B has no backup → B’s production manager only (PW-17: never A’s, never a person limited to A); one command per batch and step', async () => {
    const at = new Date(clock.backupAt.getTime() + 60_000)
    await runIssueEscalation({ database: h.database, log, clock: clockAt(at) })
    for (const issue of await issuesOfBatch(batch.batchId)) expect(issue.escalationStep).toBe(1)
    const tasks = (await escalationTasks()).filter((task) => [1, 2].some((step) => [staff.pmA, staff.pmB, staff.adminAll, people.supervisorA, people.backupA, people.officeB].some((userId) => task.id === issueEscalationTaskId(batchTask.id, step as 1 | 2, userId))))
    expect(tasks.map((task) => [task.assigneeId, task.recordId, task.status])).toEqual([[staff.pmB, w.b.salesOrderId, 'OPEN']])
    const task = (await taskOf(issueEscalationTaskId(batchTask.id, 1, staff.pmB)))!
    expect(task).toMatchObject({ partyId: ids.b, createdById: null, dueDate: clock.dueOn, dueTime: '08:00' })
    expect(task.title).toContain('2 ordini')
    expect(task.description).toContain('SEED-SO-B001')
    expect(task.description).toContain(beta2.number)
    // A's report escalated to A's backup, never to B's production manager.
    const aIssue = (await one<Json>(`SELECT "taskId"::text AS "taskId", "escalationStep" FROM "ProductionIssue" WHERE "partyId" = $1 AND source = 'BRAND' ORDER BY "raisedAt" DESC LIMIT 1`, [ids.a]))!
    expect(aIssue.escalationStep).toBe(1)
    expect(await taskOf(issueEscalationTaskId(aIssue.taskId, 1, people.backupA))).toBeDefined()
    expect(await taskOf(issueEscalationTaskId(aIssue.taskId, 1, staff.pmB))).toBeUndefined()
    // One event per issue, office only; one audit row naming B's production managers' step.
    const escalated = (await outbox('production_issue.escalated')).filter((event) => (event.payload as Json).batchId === batch.batchId)
    expect(escalated.map((event) => (event.payload as Json).step)).toEqual([1, 1])
    for (const event of escalated) {
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))!
      expect(liveViewFor(message, officeActor('office.p1'), EVENT_CATALOGUE)).toBeNull()
      expect(liveViewFor(message, officeActor('office.p2'), EVENT_CATALOGUE)).not.toBeNull()
      for (const partyId of [ids.a, ids.b]) expect(partnerLiveViewFor(message, partnerOf(partyId), EVENT_CATALOGUE)).toBeNull()
    }
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE action = 'production.issuesEscalated' AND after->>'batchId' = $1`, [batch.batchId])
    expect(audit.map((row) => [row.after.step, row.after.audience, row.after.told])).toEqual([[1, 'PRODUCTION_MANAGERS', [staff.pmB]]])
    // A second tick at the same time changes nothing.
    const count = (await escalationTasks()).length
    await runIssueEscalation({ database: h.database, log, clock: clockAt(at) })
    expect((await escalationTasks()).length).toBe(count)
    expect((await outbox('production_issue.escalated')).filter((event) => (event.payload as Json).batchId === batch.batchId)).toHaveLength(2)
  })

  it('step 2 at 08:00 on raise + 2 working days: the Owner and Admin who read the order; every person told reads B’s order', async () => {
    await runIssueEscalation({ database: h.database, log, clock: clockAt(new Date(clock.ownerAt.getTime() + 60_000)) })
    for (const issue of await issuesOfBatch(batch.batchId)) expect(issue.escalationStep).toBe(2)
    expect((await taskOf(issueEscalationTaskId(batchTask.id, 2, staff.adminAll)))!).toMatchObject({ assigneeId: staff.adminAll, recordId: w.b.salesOrderId, status: 'OPEN' })
    for (const userId of [staff.pmA, people.supervisorA]) for (const step of [1, 2] as const) expect(await taskOf(issueEscalationTaskId(batchTask.id, step, userId))).toBeUndefined()
    const told = (await escalationTasks()).filter((task) => task.recordId === w.b.salesOrderId)
    expect(told.length).toBeGreaterThan(0)
    for (const task of told) {
      const reads = await h.database.withScope(officeScope(), (client) => personReads(client, T, task.assigneeId, { companyId: w.companyId, siteId: null, partyId: ids.b }, new Date(), 'SalesOrder'))
      expect(reads, task.assigneeId).toBe(true)
    }
    const list = await ok('office.p2', `/production/issues?partyId=${ids.b}`)
    expect(list.issues.find((issue: Json) => issue.id === batchIssues[0]!.id).escalation).toMatchObject({ step: 2 })
    expect(list.counts.escalated).toBeGreaterThanOrEqual(2)
  })

  // ---- F-PR-05b: the office bell's words for a reported problem and its escalation (the tasks.assigned rule asks issues/bell.ts) ----
  it('F-PR-05b: the bell says what an issue’s task is — the reported problem, step 1 (raise + 1 working day), step 2 (raise + 2); no person "assigned" it; another task keeps its words', async () => {
    const rule = ASSIGNMENT_RULES.find((entry) => entry.name === 'tasks.assigned')!
    const draftsOf = async (taskId: string) => {
      const task = (await taskOf(taskId))!
      return system.withClient((client) => client.$transaction((tx) => rule.drafts(ruleContext(tx, T, new Date()), { taskId, recordType: task.recordType, recordId: task.recordId, assigneeId: task.assigneeId, assignedById: null })))
    }
    const nameB = (await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [ids.b]))!.name
    const reported = await draftsOf(batchTask.id)
    expect(reported).toEqual([expect.objectContaining({ userId: people.officeB, category: 'ASSIGNMENT', messageKey: 'notifications.production.problemReportedMany', actorId: null, record: expect.objectContaining({ type: 'SalesOrder', id: w.b.salesOrderId }) })])
    expect(reported[0]!.params).toMatchObject({ customer: nameB, count: 2, taskId: batchTask.id })
    expect(sentenceOf({ messageKey: reported[0]!.messageKey, params: reported[0]!.params, recordLabel: 'SEED-SO-B001', actorId: null }, new Map(), 'en')).toBe(`${nameB} reported a problem on 2 orders: answer in the thread of SEED-SO-B001`)
    const stepOne = await draftsOf(issueEscalationTaskId(batchTask.id, 1, staff.pmB))
    expect(stepOne).toEqual([expect.objectContaining({ userId: staff.pmB, messageKey: 'notifications.production.issueEscalatedBackup', actorId: null })])
    expect(sentenceOf({ messageKey: stepOne[0]!.messageKey, params: stepOne[0]!.params, recordLabel: 'SEED-SO-B001', actorId: null }, new Map(), 'it')).toBe(`Senza risposta da 1 giorno lavorativo su SEED-SO-B001 (${nameB}): ora tocca a te`)
    const stepTwo = await draftsOf(issueEscalationTaskId(batchTask.id, 2, staff.adminAll))
    expect(stepTwo).toEqual([expect.objectContaining({ userId: staff.adminAll, messageKey: 'notifications.production.issueEscalatedOwner', actorId: null })])
    // PW-17: the bell names B only, to people who read B's order; nothing of A.
    expect(findMarkers([reported, stepOne, stepTwo], aMarkers)).toEqual([])
    // A task that is no issue's (made by a person, or by the system beside the batch task under another id) keeps the generic words.
    const bellOf = (task: { id: string; createdById: string | null }) => system.withClient((client) => client.$transaction((tx) => issueBellOf(tx, { ...task, recordType: 'SalesOrder', recordId: w.b.salesOrderId, assigneeId: staff.pmB })))
    expect(await bellOf({ id: newId(), createdById: staff.adminAll })).toBeNull()
    expect(await bellOf({ id: newId(), createdById: null })).toBeNull()
  // ---- end F-PR-05b
})

describe('B-PR-45 answered: our first shared reply in one order’s thread answers the batch (T11 fallback)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a shared message in SEED-SO-B001’s thread answers every issue of the batch and closes every task; B2 reads "Answered in SEED-SO-B001"; the other batch waits; escalation stops', async () => {
    const raisedAt = new Date(batchIssues[0]!.raisedAt)
    await shareOn(w.b.salesOrderId, new Date(raisedAt.getTime() + 60_000))
    expect(await answerAll()).toBeGreaterThanOrEqual(2)
    for (const issue of await issuesOfBatch(batch.batchId)) expect(issue.status).toBe('ANSWERED')
    for (const taskId of [issueEscalationTaskId(batchTask.id, 1, staff.pmB), issueEscalationTaskId(batchTask.id, 2, staff.adminAll)]) expect((await taskOf(taskId))!.status).toBe('DONE')
    // B4's report (another batch) is not answered by a reply on another order.
    const b4 = (await one<Json>(`SELECT status::text AS status FROM "ProductionIssue" WHERE "salesOrderId" = $1`, [beta4.orderId]))!
    expect(b4.status).toBe('OPEN')

    const list = await portalGet('betaProd', '/portal/production')
    const row = (orderId: string) => list.items.find((item: Json) => item.id === orderId)
    expect(row(w.b.salesOrderId).problem.state).toBe('ANSWERED')
    expect(row(beta2.orderId).problem).toMatchObject({ state: 'ANSWERED_IN', inOrder: { number: 'SEED-SO-B001' }, words: { en: 'Answered in SEED-SO-B001' } })
    expect(row(beta4.orderId).problem.state).toBe('WAITING_ON_US')

    const answered = await ok('office.all', `/production/issues?partyId=${ids.b}&status=ANSWERED&limit=200`)
    expect(answered.issues.map((issue: Json) => issue.id)).toEqual(expect.arrayContaining(batchIssues.map((issue) => issue.id)))
    for (const issue of answered.issues) expect(issue.note).toBeNull()

    // Answered: the scan leaves the batch alone, however late.
    const ofBatch = async () => (await escalationTasksOf(batchTask.id)).length
    const before = await ofBatch()
    await runIssueEscalation({ database: h.database, log, clock: clockAt(new Date(Date.now() + 10 * 86_400_000)) })
    expect(await ofBatch()).toBe(before)
    for (const issue of await issuesOfBatch(batch.batchId)) expect(issue).toMatchObject({ status: 'ANSWERED', escalationStep: 2 })
  })

  it('PW-15: nothing B’s people got names a person of ours or anything of A', () => {
    expect(seenByB.length).toBeGreaterThan(0)
    for (const seen of seenByB) {
      expect(findMarkers(seen.body, aMarkers), seen.url).toEqual([])
      expect(findMarkers(seen.body, officeWords), seen.url).toEqual([])
      expect(JSON.stringify(seen.body), seen.url).not.toMatch(/"(supervisor|supervisorId|assignee|assigneeId|backupId)"/)
    }
  })
})

/** The escalation tasks of a batch task, for every person of this suite (steps 1 and 2). */
async function escalationTasksOf(taskId: string): Promise<Json[]> {
  const wanted = [...Object.values(people), ...Object.values(staff)].flatMap((userId) => [issueEscalationTaskId(taskId, 1, userId), issueEscalationTaskId(taskId, 2, userId)])
  return admin(`SELECT id::text FROM "Task" WHERE id = ANY($1::uuid[])`, [wanted])
}
