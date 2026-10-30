import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then"; Owner answer P3)
 * through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (runtime and floor logins,
 * row-level security real), on the factory-db seeds' plant A1: v1 published for 16-20 Nov (the floor works to it from
 * 06:00 on the 16th: SEED-WO-0001 cut on the 16th, sewn on line L1 on the 17th, inspected and packed on the 18th) and the
 * working plan moved on since (sewing an hour later, the draft SEED-WO-0002's sewing added on L1), which the floor must
 * never see. The clock is fixed at Tuesday 17 Nov 2026 09:00 UTC. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/dispatch`.
 */

const NOW = new Date('2026-11-17T09:00:00.000Z')
const NS = 'w2a34-dispatch'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const lineL1 = idOf('site:A1:line:L1')
const centre = (code: string) => idOf(`site:A1:work-centre:${code}`)
const sewingTablet = newId()
const looseTablet = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const grant = (permissions: Permission[], sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies: 'all', sites, parties: 'all' })
const floor = (deviceId: string): SessionContext => ({ audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1, deviceId, grants: [{ permissions: ['floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] })
const SESSIONS: Record<string, SessionContext> = {
  supervisor: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view'])] },
  planner: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'planning.schedule.manage', 'planning.schedule.publish', 'workorders.view'])] },
  elsewhere: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view'], [siteB1])] },
  noRight: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view'])] },
  sewing: floor(sewingTablet),
  loose: floor(looseTablet),
}

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, 'GET', url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const codes = (answer: Json) => answer.entries.map((entry: Json) => [entry.workOrder.number, entry.operation.code])

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('production_dispatch')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  const station = (await admin<{ id: string }>('SELECT id FROM "Station" WHERE "tenantId" = $1 AND "siteId" = $2 AND code = $3', [T, siteA1, 'SEW-01']))[0]!.id
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', now())`, [sewingTablet, T, companyA, siteA1, station])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'Spare tablet', 'TABLET', 'ACTIVE', now())`, [looseTablet, T, companyA, siteA1])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
  vi.useRealTimers()
})

describe('the dispatch list per line and station (MES-021, Owner answer P3)', () => {
  it("gives a sewing station its line's sewing from the published version, never the working plan", async () => {
    const answer = await ok('sewing', '/production/dispatch/station')
    expect(answer).toMatchObject({ target: { kind: 'STATION', code: 'SEW-01', line: { id: lineL1 }, workCentre: { id: centre('SEW') } }, version: { number: 1, coversFrom: '2026-11-16', coversTo: '2026-11-20' }, upcoming: null })
    // v1 sews SEED-WO-0001 on L1 on the 17th from 08:00 UTC; the working plan's hour later and the draft's sewing are not there.
    expect(codes(answer)).toEqual([['SEED-WO-0001', 'SEED-SEW-ASM']])
    expect(answer.entries[0]).toMatchObject({ startAt: '2026-11-17T08:00:00.000Z', garments: 7, workOrder: { rush: false, dueDate: '2026-12-04' } })
    expect(['READY', 'WAITING_FOR_PREVIOUS']).toContain(answer.entries[0].state)
    expect(answer.entries[0].words.length).toBeGreaterThan(5)
    // The floor's own reads hide the working plan altogether (the policies).
    const kinds = await database.withScope({ audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1 }, (client) => client.planVersion.findMany({ select: { kind: true } }))
    expect([...new Set(kinds.map((row) => row.kind))]).toEqual(['PUBLISHED'])
  })

  it('orders rush first, then due date, then the planned start', async () => {
    const wo1 = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-WO-0001']))[0]!.id
    const line = await ok('supervisor', `/production/dispatch?lineId=${lineL1}`)
    expect(codes(line)).toEqual([['SEED-WO-0001', 'SEED-SEW-ASM']])
    const centres = await ok('supervisor', `/production/dispatch?workCentreId=${centre('QC')}`)
    expect(codes(centres)).toEqual([['SEED-WO-0001', 'SEED-FIN-QC']])
    const cutting = await ok('supervisor', `/production/dispatch?workCentreId=${centre('CUT')}`)
    expect(codes(cutting)).toEqual([['SEED-WO-0001', 'SEED-CUT-LEA']])
    expect(cutting.entries[0].workOrder.id).toBe(wo1)
  })

  it('announces a later version until its start, then works to it', async () => {
    const before = await ok('planner', `/planning/schedule?siteId=${siteA1}&readiness=false`)
    const tomorrow = '2026-11-18T05:00:00.000Z'
    const published = await call('planner', 'POST', '/planning/schedule/publish', { siteId: siteA1, version: before.plan.version, coversFrom: '2026-11-18', coversTo: '2026-11-20', effectiveFrom: tomorrow })
    expect(published.statusCode, published.body).toBe(201)
    const waiting = await ok('sewing', '/production/dispatch/station')
    expect(waiting).toMatchObject({ version: { number: 1 }, upcoming: { number: 2, effectiveFrom: tomorrow } })
    vi.setSystemTime(new Date('2026-11-18T06:00:00.000Z'))
    const next = await ok('sewing', '/production/dispatch/station')
    expect(next).toMatchObject({ version: { number: 2, coversFrom: '2026-11-18' }, upcoming: null })
    // v2 carries the draft's sewing on the 19th: the station sees it, not released yet.
    expect(codes(next)).toEqual([['SEED-WO-0002', 'SEED-SEW-ASM']])
    expect(next.entries[0]).toMatchObject({ state: 'NOT_RELEASED', words: 'SEED-WO-0002 is not released yet.' })
    expect(next.next).toBeNull()
    vi.setSystemTime(NOW)
  })

  it('says why a tablet at no station has no list, and refuses what the office may not see', async () => {
    const loose = await ok('loose', '/production/dispatch/station')
    expect(loose).toMatchObject({ target: null, entries: [], words: 'This tablet is not placed at a station: ask the office to place it at one. Scan a bundle to work on it.' })
    expect((await call('noRight', 'GET', `/production/dispatch?lineId=${lineL1}`)).statusCode).toBe(403)
    expect((await call('elsewhere', 'GET', `/production/dispatch?lineId=${lineL1}`)).statusCode).toBe(404)
    expect((await call('supervisor', 'GET', `/production/dispatch?lineId=${lineL1}&workCentreId=${centre('QC')}`)).statusCode).toBe(400)
    expect((await call('supervisor', 'GET', '/production/dispatch/station')).statusCode).toBe(403)
    expect((await call('sewing', 'GET', `/production/dispatch?lineId=${lineL1}`)).statusCode).toBe(403)
  })

  it('names no person and no money (Statuto dei Lavoratori art. 4; the floor holds no money grain)', async () => {
    const names = (await admin<{ name: string }>('SELECT "displayName" AS name FROM "Worker" WHERE "tenantId" = $1', [T])).map((row) => row.name)
    expect(names.length).toBeGreaterThan(0)
    const text = JSON.stringify([await ok('sewing', '/production/dispatch/station'), await ok('supervisor', `/production/dispatch?lineId=${lineL1}`)])
    for (const name of names) expect(text).not.toContain(name)
    expect(text).not.toMatch(/cost|price|margin|wage/i)
  })
})
