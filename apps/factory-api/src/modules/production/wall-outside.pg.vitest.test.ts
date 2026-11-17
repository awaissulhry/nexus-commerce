import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedHolds } from '../../../../../packages/factory-db/seed/holds'
import { seed as seedInstructions, type InstructionsSeed } from '../../../../../packages/factory-db/seed/instructions'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning } from '../../../../../packages/factory-db/seed/planning'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import type { Log } from '../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { runAlertEvaluation } from '../../platform/alerts/engine'
import { EVERY_PARTY_MARKER } from '../../platform/alerts/evaluators'
import { fanOut } from '../../platform/notifications/fan-out'
import { systemContext } from '../../platform/outbox/system'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * B-PR-37 (production plan §2, the brand wall outside Production; 11-review R-01; wall tests PW-09 "alerts inbox and bell"
 * and PW-06 "instructions"; Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand.
 * But we, as the production unit, should be able to see it all. And manage it all as well."), on the local stack with the
 * app's real routes and the alert engine as the scheduler runs it: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login), the seeds up to holds, planning and instructions, and the production two-brand harness (brand A = the
 * seeds' P1: SEED-WO-0001 in progress, SEED-WI-0003 on its private-label style; brand B = the threads' second brand).
 *
 *   PW-09  holds of A's work order, of B's, of both (placed 30 hours ago) and a material shortage of A's started work order:
 *          the alerts take their customer (both customers: the every-party marker), an alert of A's raised before this
 *          step is cleared and raised again with its customer; the Alerts inbox and the bell of a person limited to B hold
 *          only B's; the production unit sees them all.
 *   PW-06  work instructions are walled by their style's brand (our own collection and an operation on every style: all).
 *   reads  the subcontracting work order picker, the style's where-used and the leaflet batches hold no work order of A's.
 *
 * Every answer B's person got is scanned for A's names, codes, numbers and ids. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/wall-outside`.
 */

const ns = 'pr37-wall-outside'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'alerts.view',
  'quality.holds.view',
  'quality.holds.place',
  'planning.view',
  'production.instructions.view',
  'purchasing.view',
  'product.styles.view',
  'orders.view',
  'quotes.view',
  'compliance.certificates.view',
]
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let instructions: InstructionsSeed
let aMarkers: Marker[]
/** SEED-WO-0001: brand A's work order in progress. */
let startedA = ''
const holds = { a: '', b: '', both: '' }
const alerts = { a: '', b: '', both: '', short: '', old: '' }
/** Office people of the bell: the quality inspector and the planner (the built-in rules' roles), every customer and B only. */
const people = { inspectorAll: newId(), inspectorB: newId(), plannerAll: newId(), plannerB: newId() }

type Json = Record<string, any>
interface Seen {
  readonly url: string
  readonly body: unknown
}
const seenByB: Seen[] = []
let keys = 0
async function call(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, record = true): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `pr37-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2' && record) seenByB.push({ url: `${method} ${url}`, body: Object.keys(body).length > 0 ? body : response.body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw}`).toBe(status)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined }
const system = () => callerFor(database, systemContext(w.tenantId, `pr37-${newId()}`))
const alertIds = async (session: string) => ((await ok(session, 'GET', '/alerts?limit=200')).items as Json[]).map((item) => item.id as string)

beforeAll(async () => {
  db = await migratedDatabase('pr37_wall_outside')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles, seedProduction, seedNumbering, seedReasons, seedHolds, seedPlanning]) await seed({ db: database, namespace: ns })
  instructions = await seedInstructions({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  startedA = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [w.tenantId]))[0]!.id
  expect((await admin<{ partyId: string; status: string }>(`SELECT "partyId", status FROM "WorkOrder" WHERE id = $1`, [startedA]))[0]).toEqual({ partyId: w.a.partyId, status: 'IN_PROGRESS' })

  // The bell's people: the built-in rules' roles, at every customer or only B (RoleAssignment.partyIds).
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [w.tenantId])).map((row) => [row.key, row.id]))
  for (const [userId, role, parties] of [
    [people.inspectorAll, 'quality_inspector', []],
    [people.inspectorB, 'quality_inspector', [w.b.partyId]],
    [people.plannerAll, 'planner', []],
    [people.plannerB, 'planner', [w.b.partyId]],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, w.tenantId, `pr37-${userId.slice(-8)}@example.com`, `Made-up person ${userId.slice(-4)}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, $5::uuid[], now() - interval '30 days')`, [newId(), w.tenantId, userId, roleIds.get(role), [...parties]])
  }

  // The built-in rules, then an alert of A's shortage raised before this step (no customer, the old key).
  await runAlertEvaluation({ database, log, clock: { now: () => new Date() } })
  const shortRule = (await admin<{ id: string }>(`SELECT id FROM "AlertRule" WHERE "tenantId" = $1 AND "ruleKind" = 'MATERIAL_SHORT' AND "builtIn" ORDER BY "createdAt" LIMIT 1`, [w.tenantId]))[0]!.id
  alerts.old = newId()
  const exception = newId()
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Alert" ("id", "tenantId", "ruleId", "ruleKind", "severity", "companyId", "siteId", "partyId", "recordType", "recordId", "recordLabel", "dedupeKey", "occurrence", "facts", "state", "raisedAt", "createdAt", "updatedAt")
       VALUES (${sql(alerts.old)}, ${sql(w.tenantId)}, ${sql(shortRule)}, 'MATERIAL_SHORT', 'CRITICAL', ${sql(w.companyId)}, ${sql(w.siteId)}, NULL, 'WorkOrder', ${sql(startedA)}, 'SEED-WO-0001', 'MATERIAL_SHORT:${startedA}', 1, '{"item": "SEED-LEA", "materials": 1}', 'OPEN', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days');
     INSERT INTO "PlanningException" SELECT (jsonb_populate_record(NULL::"PlanningException", to_jsonb(e) || jsonb_build_object('id', ${sql(exception)}, 'dedupeKey', 'T-PR37-SHORT', 'recordType', 'WorkOrder', 'recordId', ${sql(startedA)}, 'status', 'NEW', 'siteId', ${sql(w.siteId)}))).* FROM "PlanningException" e WHERE e."tenantId" = ${sql(w.tenantId)} AND e.kind = 'SHORT' LIMIT 1;
     COMMIT;`,
  )
  // Holds of A's draft work order, of B's, of both, through the real route; placed 30 hours ago (the rule says 24).
  const place = async (subjectIds: string[]) => (await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds, reasonCode: 'QUALITY_CHECK' }, 201)).hold.id as string
  holds.a = await place([w.a.workOrderId])
  holds.b = await place([w.b.workOrderId])
  holds.both = await place([w.a.workOrderId, w.b.workOrderId])
  await db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "QualityHold" SET "placedAt" = now() - interval '30 hours' WHERE id IN (${[holds.a, holds.b, holds.both].map(sql).join(', ')}); COMMIT;`)

  // The scheduler's pass, then the worker's fan-out of what it raised.
  const pass = await runAlertEvaluation({ database, log, clock: { now: () => new Date() } })
  expect(pass.failed).toBe(0)
  const alertOf = async (kind: string, recordId: string) => (await admin<{ id: string }>(`SELECT id FROM "Alert" WHERE "ruleKind" = $1 AND "recordId" = $2 AND state <> 'RESOLVED'`, [kind, recordId]))[0]?.id ?? ''
  alerts.a = await alertOf('HOLD_TOO_LONG', holds.a)
  alerts.b = await alertOf('HOLD_TOO_LONG', holds.b)
  alerts.both = await alertOf('HOLD_TOO_LONG', holds.both)
  alerts.short = await alertOf('MATERIAL_SHORT', startedA)
  for (const row of await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'alert.raised' ORDER BY "occurredAt", id`, [w.tenantId])) {
    await fanOut(system(), { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload })
  }

  const holdNumbers = await admin<{ text: string }>(`SELECT number AS text FROM "QualityHold" WHERE id IN ($1, $2) AND number IS NOT NULL UNION ALL SELECT id::text FROM "QualityHold" WHERE id IN ($1, $2) UNION ALL SELECT id::text FROM "Alert" WHERE id IN ($3, $4, $5, $6)`, [holds.a, holds.both, alerts.a || newId(), alerts.both || newId(), alerts.short || newId(), alerts.old])
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, ...holdNumbers.map((row) => ({ label: 'A record', text: row.text }))]
}, 400_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('PW-09: alerts take their customer; the inbox and the bell of a person limited to B hold only B’s', { timeout: 60_000 }, () => {
  it('each alert names its customer; both customers’ hold the every-party marker; the old alert of A’s is cleared and raised again', async () => {
    expect([alerts.a, alerts.b, alerts.both, alerts.short].every(isUuid)).toBe(true)
    const party = async (id: string) => (await admin<{ partyId: string | null; dedupeKey: string }>(`SELECT "partyId", "dedupeKey" FROM "Alert" WHERE id = $1`, [id]))[0]!
    expect(await party(alerts.a)).toEqual({ partyId: w.a.partyId, dedupeKey: `HOLD_TOO_LONG:${holds.a}:customer-${w.a.partyId}` })
    expect(await party(alerts.b)).toEqual({ partyId: w.b.partyId, dedupeKey: `HOLD_TOO_LONG:${holds.b}:customer-${w.b.partyId}` })
    expect(await party(alerts.both)).toEqual({ partyId: EVERY_PARTY_MARKER, dedupeKey: `HOLD_TOO_LONG:${holds.both}:customer-every` })
    expect(await party(alerts.short)).toEqual({ partyId: w.a.partyId, dedupeKey: `MATERIAL_SHORT:${startedA}:customer-${w.a.partyId}` })
    expect((await admin(`SELECT state, resolution FROM "Alert" WHERE id = $1`, [alerts.old]))[0]).toEqual({ state: 'RESOLVED', resolution: 'CLEARED' })
  })

  it('the Alerts inbox: B’s person gets only B’s alert, A’s person only A’s, the production unit all; A’s alert answers as an unknown one', async () => {
    const all = await alertIds('office.all')
    expect(all).toEqual(expect.arrayContaining([alerts.a, alerts.b, alerts.both, alerts.short]))
    const ofB = await alertIds('office.p2')
    expect(ofB).toContain(alerts.b)
    for (const id of [alerts.a, alerts.both, alerts.short, alerts.old]) expect(ofB).not.toContain(id)
    const ofA = await alertIds('office.p1')
    expect(ofA).toEqual(expect.arrayContaining([alerts.a, alerts.short]))
    for (const id of [alerts.b, alerts.both]) expect(ofA).not.toContain(id)
    const theirs = await call('office.p2', 'GET', `/alerts/${alerts.a}`)
    const unknown = await call('office.p2', 'GET', `/alerts/${newId()}`, undefined, false)
    expect([theirs.status, theirs.body.error?.message]).toEqual([unknown.status, unknown.body.error?.message])
    expect(theirs.status).toBe(404)
  })

  it('the bell: the role’s holders limited to B are told only of B’s alert; those of every customer of all', async () => {
    const told = async (userId: string) => (await admin<{ anchor: string }>(`SELECT anchor FROM "Notification" WHERE "userId" = $1 AND anchor LIKE 'alert:%'`, [userId])).map((row) => row.anchor.slice('alert:'.length))
    const inspectorAll = await told(people.inspectorAll)
    expect(inspectorAll).toEqual(expect.arrayContaining([alerts.a, alerts.b, alerts.both]))
    const inspectorB = await told(people.inspectorB)
    expect(inspectorB).toContain(alerts.b)
    expect(inspectorB).not.toContain(alerts.a)
    expect(inspectorB).not.toContain(alerts.both)
    expect(await told(people.plannerAll)).toContain(alerts.short)
    expect(await told(people.plannerB)).not.toContain(alerts.short)
  })
})

describe('PW-06: work instructions walled by their style’s brand', { timeout: 60_000 }, () => {
  it('B’s person never meets A’s private-label instruction; an operation’s instruction on every style stays open to all', async () => {
    const brand = (await admin<{ brandPartyId: string | null }>(`SELECT s."brandPartyId" FROM "WorkInstruction" i JOIN "Style" s ON s.id = i."styleId" WHERE i.id = $1`, [instructions.instructionIds.revision]))[0]!.brandPartyId
    expect(brand).toBe(w.a.partyId)
    const listed = async (session: string) => ((await ok(session, 'GET', '/production/instructions')).instructions as Json[]).map((row) => row.id as string)
    expect(await listed('office.all')).toEqual(expect.arrayContaining([instructions.instructionIds.revision, instructions.instructionIds.sewing]))
    const ofB = await listed('office.p2')
    expect(ofB).toContain(instructions.instructionIds.sewing)
    expect(ofB).not.toContain(instructions.instructionIds.revision)
    expect(await listed('office.p1')).toContain(instructions.instructionIds.revision)
    const theirs = await call('office.p2', 'GET', `/production/instructions/${instructions.instructionIds.revision}`)
    const unknown = await call('office.p2', 'GET', `/production/instructions/${newId()}`, undefined, false)
    expect([theirs.status, theirs.body.error?.message]).toEqual([404, 'Work instruction not found.'])
    expect(unknown.body.error?.message).toBe('Work instruction not found.')
    await ok('office.p2', 'GET', `/production/instructions/${instructions.instructionIds.sewing}`)
  })
})

describe('the work order reads outside Production hold no work order of A’s for B’s person', { timeout: 60_000 }, () => {
  it('the subcontracting picker, the style’s where-used and the leaflet batches', async () => {
    const picker = async (session: string) => ((await ok(session, 'GET', '/purchasing/subcontracting/work-orders?limit=50')).items as Json[]).map((row) => row.id as string)
    expect(await picker('office.all')).toContain(startedA)
    expect(await picker('office.p2')).not.toContain(startedA)
    const whereUsed = async (session: string) => (((await ok(session, 'GET', `/product/styles/${w.styleId}/where-used`)).whereUsed.groups as Json[]).find((group) => group.kind === 'WORK_ORDERS')?.rows as Json[]).map((row) => row.id as string)
    expect((await whereUsed('office.all')).sort()).toEqual([w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId].sort())
    expect(await whereUsed('office.p2')).toEqual([w.b.workOrderId])
    const theirs = await call('office.p2', 'GET', `/compliance/user-information/batches?workOrderId=${startedA}`)
    const unknown = await call('office.p2', 'GET', `/compliance/user-information/batches?workOrderId=${newId()}`, undefined, false)
    expect([theirs.status, theirs.body.error?.message]).toEqual([unknown.status, unknown.body.error?.message])
    expect(theirs.status).toBe(404)
  })

  it('no answer B’s person got names A: not its names, codes, orders, work orders, holds, alerts or ids', () => {
    expect(seenByB.length).toBeGreaterThan(5)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})

