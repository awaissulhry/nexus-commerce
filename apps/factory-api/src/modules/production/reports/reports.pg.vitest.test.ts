import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { runDailyReports } from './mail'

/**
 * Production reports (B-W2a-38; MES-301 the daily production report, MES-160 the floor overview by line; Owner answers
 * W1, F2) through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security and the guard triggers are real), on the factory-db seeds' plant A1 (line L1 with SEW-01 and
 * SEW-02; CUT-01, QC-01, PACK-01 alone; v1 published: SEED-WO-0001 sewn on L1 on 17 Nov 08:00-16:00 UTC, 7 garments),
 * with whole-garment bundles and scans written here as the floor writes them (the seed's operator, the cutting tablet,
 * the station of each report). People with live role assignments (the recipients' rules and the mail read them), FAKE
 * SES for the mail. The clock is Tuesday 17 Nov 2026 09:00 UTC (10:00 at the plant). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/reports`.
 */

const NOW = new Date('2026-11-17T09:00:00.000Z')
const NS = 'w2a38-reports'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const station = (code: string) => idOf(`site:A1:station:${code}`)
const centre = (code: string) => idOf(`site:A1:work-centre:${code}`)
const operator = idOf('worker:A1:operator')
const tablet = idOf('device:A1:cutting')
const ownerUser = idOf('actor')

const PEOPLE = { supervisor: newId(), reader: newId(), salesperson: newId(), outsider: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Person, { readonly role: string; readonly only?: string }> = {
  supervisor: { role: 'floor_supervisor' },
  reader: { role: 'read_only' },
  salesperson: { role: 'sales' },
  outsider: { role: 'floor_supervisor', only: 'B' },
}

let h: Harness
let app: FastifyInstance
type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]

function grantOf(key: string, companies: Grant['companies']): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(ROLES[person].role, ROLES[person].only ? [companyB] : 'all')] })
const call = (person: Person, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(person: Person, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}

let wo1: string
const ops: Record<string, { id: string; sam: string }> = {}
const bundles: Record<string, string> = {}

/** A whole-garment bundle of one of WO-0001's cells, as the bundles module makes it. */
async function bundle(code: string, colourway: string, size: string, quantity: number): Promise<string> {
  const cell = (await admin<{ id: string }>(`SELECT s.id FROM "WorkOrderSize" s JOIN "Colourway" c ON c.id = s."colourwayId" WHERE s."workOrderId" = $1 AND c.code = $2 AND s.size = $3`, [wo1, colourway, size]))[0]!.id
  const id = newId()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "deviceId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, [id, T, siteA1, wo1, cell, code, quantity, tablet, new Date('2026-11-16T10:30:00Z')])
  return id
}

/** A floor scan as the scans module writes it (the signed-in operator on the tablet, the station that reported it). */
async function scan(row: { kind?: 'REPORT' | 'UNDO' | 'CORRECTION'; bundle: string; op: string; good?: number; scrap?: number; rework?: number; at: string; stationCode: string; corrects?: string }): Promise<string> {
  const id = newId()
  const correction = row.kind === 'CORRECTION'
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "correctsId", "goodQuantity", "scrapQuantity", "reworkQuantity", reason, "approvedById", "workerId", "stationId", "deviceId", "clientScanId", "deviceTime", "serverTime", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18, $14)`,
    [id, T, siteA1, wo1, ops[row.op]!.id, bundles[row.bundle], row.kind ?? 'REPORT', row.corrects ?? null, row.good ?? 0, row.scrap ?? 0, row.rework ?? 0, row.kind && row.kind !== 'REPORT' ? 'A test correction.' : null, correction ? ownerUser : null, operator, station(row.stationCode), correction ? null : tablet, `w2a38-${id}`, new Date(row.at)],
  )
  return id
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  h = await startHarness('production_reports')
  for (const seed of [seedCore, seedAuth, seedRoles, seedEmail, seedCalendar, seedSchedule, seedPlant]) await seed({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, { role, only }] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [userId, T, `${person}@reports.example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)`, [newId(), T, userId, roleIds.get(role), only === undefined, only ? [companyB] : [], new Date('2026-11-01T00:00:00Z')])
  }
  wo1 = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-WO-0001']))[0]!.id
  for (const row of await admin<{ id: string; kind: string; standardMinutes: string }>(`SELECT o.id, c.kind::text, o."standardMinutes"::text FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1`, [wo1]))
    ops[row.kind === 'CUTTING' ? 'cut' : row.kind === 'SEWING' || row.kind === 'ASSEMBLY' ? 'sew' : row.kind === 'INSPECTION' ? 'qc' : 'pack'] = { id: row.id, sam: row.standardMinutes }
  bundles.blk50 = await bundle('W2A38-BLK-50', 'BLK', '50', 1)
  bundles.blk52 = await bundle('W2A38-BLK-52', 'BLK', '52', 2)
  bundles.red52 = await bundle('W2A38-RED-52', 'RED', '52', 1)
  bundles.red50 = await bundle('W2A38-RED-50', 'RED', '50', 1)
  // Monday 16 Nov: RED 50 sewn good at SEW-01 … and on the 17th corrected to scrapped (the correction counts on the 16th).
  const monday = await scan({ bundle: 'red50', op: 'sew', good: 1, at: '2026-11-16T14:00:00Z', stationCode: 'SEW-01' })
  await scan({ kind: 'CORRECTION', bundle: 'red50', op: 'sew', scrap: 1, at: '2026-11-17T08:10:00Z', stationCode: 'SEW-01', corrects: monday })
  // Tuesday 17 Nov, at L1: BLK 52 sewn (2 good) at SEW-01, BLK 50 scrapped at SEW-02, RED 52 sent to rework at SEW-02.
  await scan({ bundle: 'blk52', op: 'sew', good: 2, at: '2026-11-17T08:30:00Z', stationCode: 'SEW-01' })
  await scan({ bundle: 'red52', op: 'sew', rework: 1, at: '2026-11-17T08:45:00Z', stationCode: 'SEW-02' })
  await scan({ bundle: 'blk50', op: 'sew', scrap: 1, at: '2026-11-17T08:55:00Z', stationCode: 'SEW-02' })
  // … and at the inspection bench (a lane of its own): BLK 52 passed; a mis-scan of RED 52 undone at once.
  await scan({ bundle: 'blk52', op: 'qc', good: 2, at: '2026-11-17T08:50:00Z', stationCode: 'QC-01' })
  const mistake = await scan({ bundle: 'red52', op: 'qc', good: 1, at: '2026-11-17T08:51:00Z', stationCode: 'QC-01' })
  await scan({ kind: 'UNDO', bundle: 'red52', op: 'qc', at: '2026-11-17T08:51:20Z', stationCode: 'QC-01', corrects: mistake })

  // Owner F2 per station: someone signed in at SEW-01 (a live session on its tablet), a machine down at SEW-02.
  const sewTablet = newId()
  const sessionId = newId()
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', $6)`, [sewTablet, T, companyA, siteA1, station('SEW-01'), NOW])
  await admin(`INSERT INTO "FloorSession" (id, "tenantId", "siteId", "deviceId", "workerId", "tokenHash", "startedAt", "lastSeenAt", "idleExpiresAt", "endsAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)`, [sessionId, T, siteA1, sewTablet, operator, `w2a38-${sessionId}`, new Date('2026-11-17T08:00:00Z'), new Date('2026-11-17T09:10:00Z'), new Date('2026-11-17T16:00:00Z')])
  await admin(`UPDATE "Device" SET "currentSessionId" = $1 WHERE id = $2`, [sessionId, sewTablet])
  const machineClass = (await admin<{ id: string }>(`SELECT id FROM "MachineClass" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [T]))[0]!.id
  await admin(`INSERT INTO "Machine" (id, "tenantId", "companyId", "siteId", "assetNumber", "classId", "stationId", "workCentreId", status, "statusSince") VALUES ($1, $2, $3, $4, 'W2A38-SEW-02', $5, $6, $7, 'DOWN', $8)`, [newId(), T, companyA, siteA1, machineClass, station('SEW-02'), centre('SEW'), NOW])

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)),
    },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
  vi.useRealTimers()
})

const lane = (answer: Json, code: string) => answer.lanes.find((entry: Json) => entry.code === code)

describe('the daily production report (MES-301): per line, style and size, never per person', () => {
  it('counts the day at L1 and at the inspection bench from the floor’s standing scans', async () => {
    const answer = await ok('supervisor', 'GET', `/production/reports/daily?siteId=${siteA1}&date=2026-11-17`)
    expect(answer).toMatchObject({ site: { id: siteA1, code: 'A1', timeZone: 'Europe/Rome' }, day: '2026-11-17', today: '2026-11-17', nextDay: null, workingDay: true, previousWorkingDay: '2026-11-16' })
    expect(answer.sites.map((site: Json) => site.code)).toEqual(['A1', 'B1'])
    const l1 = lane(answer, 'L1')
    // good through L1's last operation (sewing): BLK 52 2; scrap BLK 50 1; rework RED 52 1. The 16th's correction is not today's.
    expect(l1).toMatchObject({ kind: 'LINE', id: lineL1, good: 2, scrap: 1, rework: 1 })
    expect(l1.rows).toEqual([
      { style: expect.objectContaining({ code: 'SEED-JKT-02' }), size: '50', good: 0, scrap: 1, rework: 0 },
      { style: expect.objectContaining({ code: 'SEED-JKT-02' }), size: '52', good: 2, scrap: 0, rework: 1 },
    ])
    // Efficiency per line: 2 garments × the sewing's standard minutes over people × L1's working minutes that day.
    const earned = new Dec(ops.sew!.sam).times(2).toFixed(1)
    expect(l1.earnedMinutes).toBe(earned)
    expect(l1.people).toBeGreaterThan(0)
    expect(l1.workingMinutes).toBeGreaterThan(0)
    expect(l1.availableMinutes).toBe(new Dec(l1.people).times(l1.workingMinutes).toFixed(1))
    expect(l1.efficiencyPct).toBe(new Dec(earned).div(l1.availableMinutes).times(100).toDecimalPlaces(1).toFixed(1))
    // The inspection bench stands alone: a work-centre lane, no efficiency; the undone mis-scan does not count.
    expect(lane(answer, 'QC')).toMatchObject({ kind: 'WORK_CENTRE', good: 2, scrap: 0, rework: 0, efficiencyPct: null, people: null })
    expect(answer.totals).toEqual({ good: 4, scrap: 1, rework: 1 })
  })

  it('counts a correction approved later on the day of the report it corrects', async () => {
    const answer = await ok('supervisor', 'GET', `/production/reports/daily?siteId=${siteA1}&date=2026-11-16`)
    expect(lane(answer, 'L1')).toMatchObject({ good: 0, scrap: 1, rework: 0, earnedMinutes: '0.0' })
    expect(answer).toMatchObject({ day: '2026-11-16', nextDay: '2026-11-17' })
  })

  it('names no worker and no money, and refuses who may not read it', async () => {
    const workers = (await admin<{ name: string }>('SELECT "displayName" AS name FROM "Worker" WHERE "tenantId" = $1', [T])).map((row) => row.name)
    expect(workers.length).toBeGreaterThan(0)
    const text = JSON.stringify([await ok('supervisor', 'GET', `/production/reports/daily?siteId=${siteA1}&date=2026-11-17`), await ok('supervisor', 'GET', `/production/reports/lines?siteId=${siteA1}`)])
    for (const name of workers) expect(text).not.toContain(name)
    expect(text).not.toMatch(/worker|cost|price|margin|wage/i)
    expect((await call('salesperson', 'GET', `/production/reports/daily?siteId=${siteA1}`)).statusCode).toBe(403)
    expect((await call('outsider', 'GET', `/production/reports/daily?siteId=${siteA1}`)).statusCode).toBe(404)
    // The outsider reads B1 only (its company), by default too.
    expect((await ok('outsider', 'GET', '/production/reports/daily')).site.code).toBe('B1')
  })
})

describe('the floor overview by line (MES-160; Owner F2: per station only who is signed in and machines down)', () => {
  it('gives L1 its state, output against the published plan, work orders and stations', async () => {
    const answer = await ok('supervisor', 'GET', `/production/reports/lines?siteId=${siteA1}`)
    expect(answer.sites).toEqual([expect.objectContaining({ id: siteA1, code: 'A1', today: '2026-11-17' })])
    const l1 = answer.lines.find((line: Json) => line.id === lineL1)
    // v1 sews WO-0001's 7 garments on L1 today 08:00-16:00 UTC; 2 passed sewing; the last report 08:55 (5 minutes ago).
    expect(l1).toMatchObject({ code: 'L1', state: 'RUNNING', plannedToday: 7, plan: { number: 1 }, output: 2, outputPct: 29, lastScanAt: '2026-11-17T08:55:00.000Z' })
    expect(l1.workOrders.map((row: Json) => row.number)).toEqual(['SEED-WO-0001'])
    expect(l1.stations).toEqual([
      { id: station('SEW-01'), code: 'SEW-01', name: 'Sewing station 1', signedIn: true, machinesDown: [] },
      { id: station('SEW-02'), code: 'SEW-02', name: 'Sewing station 2', signedIn: false, machinesDown: [{ assetNumber: 'W2A38-SEW-02', status: 'DOWN' }] },
    ])
    if (l1.bottleneck) expect(l1.bottleneck).toMatchObject({ workOrderNumber: 'SEED-WO-0001', waiting: expect.any(Number) })
  })

  it('says Waiting once the line has been quiet, and refuses the office without the floor', async () => {
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'))
    const quiet = (await ok('supervisor', 'GET', `/production/reports/lines?siteId=${siteA1}`)).lines.find((line: Json) => line.id === lineL1)
    expect(quiet.state).toBe('WAITING')
    vi.setSystemTime(NOW)
    expect((await call('outsider', 'GET', `/production/reports/lines?siteId=${siteA1}`)).statusCode).toBe(404)
  })
})

describe('the daily report by e-mail: nothing until someone subscribes (PLT-142)', () => {
  const log = { info() {}, warn() {}, error() {} }
  const clock = { now: () => NOW }

  it('sends nothing by default', async () => {
    expect((await ok('supervisor', 'GET', '/production/reports/subscriptions')).subscriptions).toEqual([])
    expect(await runDailyReports({ database: h.database, log, clock, runtime: () => h.email })).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
  })

  it('subscribes me and the colleagues who may read it, refuses the others, and lists who may get it', async () => {
    const mine = await ok('supervisor', 'POST', '/production/reports/subscriptions', { siteId: siteA1, sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], locale: null }, 201)
    expect(mine.subscriptions).toEqual([expect.objectContaining({ user: { id: PEOPLE.supervisor, name: 'Person supervisor' }, mine: true, site: expect.objectContaining({ code: 'A1' }), sendTime: '07:00', locale: 'en', active: true, version: 1 })])
    const people = await ok('supervisor', 'GET', `/production/reports/recipients?siteId=${siteA1}`)
    expect(people.people[0]).toEqual({ id: PEOPLE.supervisor, name: 'Person supervisor', me: true, subscribed: true })
    const ids = people.people.map((person: Json) => person.id)
    expect(ids).toContain(PEOPLE.reader)
    expect(ids).not.toContain(PEOPLE.salesperson)
    expect(ids).not.toContain(PEOPLE.outsider)
    // A colleague who may not read it is refused at their index; nothing is written.
    const refused = await call('supervisor', 'POST', '/production/reports/subscriptions', { siteId: siteA1, recipients: [PEOPLE.reader, PEOPLE.salesperson], sendTime: '07:30', weekdays: [1, 2, 3, 4, 5], locale: 'it' })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/recipients/1'])
    const both = await ok('supervisor', 'POST', '/production/reports/subscriptions', { siteId: siteA1, recipients: [PEOPLE.supervisor, PEOPLE.reader], sendTime: '07:30', weekdays: [1, 2, 3, 4, 5], locale: 'it' }, 201)
    expect(both.subscriptions.map((row: Json) => [row.user.id, row.locale, row.version])).toEqual([
      [PEOPLE.supervisor, 'it', 2],
      [PEOPLE.reader, 'it', 1],
    ])
    // The reader subscribes nobody else (no production.reports.subscribe), nor sees the list of people.
    expect((await call('reader', 'POST', '/production/reports/subscriptions', { siteId: siteA1, recipients: [PEOPLE.supervisor], sendTime: '07:00', weekdays: [1] })).statusCode).toBe(403)
    expect((await call('reader', 'GET', `/production/reports/recipients?siteId=${siteA1}`)).statusCode).toBe(403)
    expect((await call('supervisor', 'POST', '/production/reports/subscriptions', { siteId: siteA1, sendTime: '7:00', weekdays: [] })).statusCode).toBe(400)
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'production.report_subscription_changed'`, [T])).toEqual([{ n: 2 }])
  })

  it('changes a subscription at its version, its recipient or its maker only', async () => {
    const [own] = (await ok('reader', 'GET', '/production/reports/subscriptions')).subscriptions as Json[]
    expect(own).toMatchObject({ mine: true, user: { id: PEOPLE.reader } })
    expect((await call('reader', 'PATCH', `/production/reports/subscriptions/${own!.id}`, { version: own!.version + 5, sendTime: '06:30' })).statusCode).toBe(409)
    expect((await call('salesperson', 'PATCH', `/production/reports/subscriptions/${own!.id}`, { version: own!.version, active: false })).statusCode).toBe(403)
    const changed = await ok('reader', 'PATCH', `/production/reports/subscriptions/${own!.id}`, { version: own!.version, sendTime: '00:00', weekdays: [1, 2, 3, 4, 5, 6, 7], locale: 'en' })
    expect(changed.subscription).toMatchObject({ sendTime: '00:00', locale: 'en', active: true, version: own!.version + 1 })
    // The supervisor made it, so sees it too.
    expect(((await ok('supervisor', 'GET', '/production/reports/subscriptions')).subscriptions as Json[]).map((row) => row.user.id).sort()).toEqual([PEOPLE.reader, PEOPLE.supervisor].sort())
  })

  it('mails the previous working day’s report once a day at its time, per line, never per person', async () => {
    const before = h.ses.mails.length
    // At 10:00 at the plant both are due (07:30 and 00:00, Tuesday).
    expect(await runDailyReports({ database: h.database, log, clock, runtime: () => h.email })).toEqual({ due: 2, sent: 2, skipped: 0, failed: 0 })
    const mails = h.ses.mails.slice(before)
    const toReader = mails.find((mail) => mail.to.includes('reader@reports.example.com'))!
    expect(toReader.templateKey).toBe('production.daily')
    const text = textOf(toReader.raw)
    expect(text).toContain('Seed plant A1 (A1), Monday 16 November 2026.')
    expect(text).toContain('• L1 Line 1 (A1): 0 good · 1 scrap · 0 rework · efficiency 0.0 %')
    expect(text).toContain('/production/reports?site=')
    const toSupervisor = textOf(mails.find((mail) => mail.to.includes('supervisor@reports.example.com'))!.raw)
    expect(toSupervisor).toContain('Seed plant A1 (A1), lunedì 16 novembre 2026.')
    const subjects = await admin<{ subject: string; to: string[] }>(`SELECT subject, "to" FROM "EmailOutbound" WHERE "tenantId" = $1 AND "templateKey" = 'production.daily' ORDER BY subject`, [T])
    expect(subjects.map((row) => [row.to[0], row.subject])).toEqual([
      ['reader@reports.example.com', 'Production on Monday 16 November 2026 · A1'],
      ['supervisor@reports.example.com', 'Produzione del lunedì 16 novembre 2026 · A1'],
    ])
    const workers = (await admin<{ name: string }>('SELECT "displayName" AS name FROM "Worker" WHERE "tenantId" = $1', [T])).map((row) => row.name)
    for (const name of workers) expect(text + toSupervisor).not.toContain(name)
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'production.daily_report_sent'`, [T])).toEqual([{ n: 2 }])
    // Once a day.
    expect(await runDailyReports({ database: h.database, log, clock, runtime: () => h.email })).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
  })

  it('sends nothing to someone who may no longer read it, and marks the day checked', async () => {
    await admin(`UPDATE "RoleAssignment" SET "validTo" = $1 WHERE "tenantId" = $2 AND "userId" = $3`, [new Date('2026-11-17T12:00:00Z'), T, PEOPLE.reader])
    vi.setSystemTime(new Date('2026-11-18T13:00:00.000Z'))
    const before = h.ses.mails.length
    expect(await runDailyReports({ database: h.database, log, runtime: () => h.email })).toEqual({ due: 2, sent: 1, skipped: 1, failed: 0 })
    expect(h.ses.mails.slice(before).flatMap((mail) => mail.to)).toEqual(['supervisor@reports.example.com'])
    expect(await runDailyReports({ database: h.database, log, runtime: () => h.email })).toEqual({ due: 0, sent: 0, skipped: 0, failed: 0 })
    vi.setSystemTime(NOW)
  })
})
