import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { travellerPapers } from './work-orders/traveller'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../packages/factory-db/seed/calendar'
import { seed as seedSchedule, type ScheduleSeed } from '../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
// ---- B-W2b-F53: this file fixes its clock on a day of the seeds' story, so it runs the seeds as written (seed-calendar)
await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())

/**
 * B-PR-11 (production plan §2 "Shared floor screens (tickets, travellers, Line TV, dispatch, wall screens) show the customer
 * code, never the name"; lead pick L13; 06-tree §0.6 PW-F01: "Shared floor payloads: no party name key, code only") through the
 * app's real routes on a throwaway PostgreSQL 17 database from the migrations (runtime and floor logins, row-level security
 * real: the floor role reads no party, so its list gets the code through the tenant's system view), on the factory-db seeds'
 * plant A1 with v1 published for 16-20 Nov (SEED-WO-0001 of the seeds' customer SEED-C1, sewn on line L1 on the 17th). The
 * clock is fixed at Tuesday 17 Nov 2026 09:00 UTC. Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/floor-code`.
 *
 *   - the dispatch lists (the office's per line, a station tablet's own), the dispatch board's cards and the printed list carry
 *     the work order's customer CODE;
 *   - the traveller prints it as a fact of its own;
 *   - the Line TV and a bundle ticket carry no customer at all (line totals; our own company as the ticket's maker);
 *   - no answer holds the customer's legal or trade name, nor a key that names a party.
 */

const NOW = new Date('2026-11-17T09:00:00.000Z')
const NS = 'pr11-floor-code'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const lineL1 = idOf('site:A1:line:L1')
const customer = idOf('party:P1')
const sewingTablet = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: ScheduleSeed
/** The seeds' customer's names: what no shared floor payload may hold. */
let names: string[]

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  office: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view', 'production.dispatch.view', 'production.boards.view', 'production.bundles.view'])] },
  sewing: { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1, deviceId: sewingTablet, grants: [{ permissions: ['floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const seen: { url: string; body: unknown }[] = []
async function ok(session: string, url: string, floorSurface = true): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, `${url}: ${response.body}`).toBe(200)
  const body = response.json() as Json
  if (floorSurface) seen.push({ url, body })
  return body
}
/** Every key of an answer, at any depth. */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
const NAME_KEYS = /^(legalName|tradeName|customerName|partyName)$/

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  db = await migratedDatabase('pr11_floor_code')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  seeded = await seedSchedule({ db: database, namespace: NS })
  const station = (await admin<{ id: string }>('SELECT id FROM "Station" WHERE "tenantId" = $1 AND "siteId" = $2 AND code = $3', [T, siteA1, 'SEW-01']))[0]!.id
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Sewing tablet 1', 'TABLET', 'ACTIVE', now())`, [sewingTablet, T, companyA, siteA1, station])
  const party = (await admin<{ code: string; legalName: string; tradeName: string | null }>('SELECT code, "legalName", "tradeName" FROM "Party" WHERE id = $1', [customer]))[0]!
  expect(party.code).toBe('SEED-C1')
  names = [party.legalName, ...(party.tradeName ? [party.tradeName] : [])]
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
  vi.useRealTimers()
})

describe('PW-F01: shared floor surfaces show the customer code, never the name (L13)', { timeout: 60_000 }, () => {
  it('the dispatch lists, the board’s cards and the printed list carry the customer code', async () => {
    const office = await ok('office', `/production/dispatch?lineId=${lineL1}`)
    expect((office.entries as Json[]).length).toBeGreaterThan(0)
    expect((office.entries as Json[]).map((entry) => entry.workOrder.customerCode)).toEqual((office.entries as Json[]).map(() => 'SEED-C1'))
    // A station tablet: read in the floor's own scope, the code through the tenant's system view (the floor role reads no party).
    const station = await ok('sewing', '/production/dispatch/station')
    expect((station.entries as Json[]).length).toBeGreaterThan(0)
    expect(new Set((station.entries as Json[]).map((entry) => entry.workOrder.customerCode))).toEqual(new Set(['SEED-C1']))
    const board = await ok('office', `/production/dispatch/board?siteId=${siteA1}`)
    const cards = [...(board.lines as Json[]).flatMap((line) => (line.stations as Json[]).flatMap((lane) => lane.cards as Json[])), ...(board.otherStations as Json[]).flatMap((lane) => lane.cards as Json[]), ...(board.notAssigned as Json[])]
    expect(cards.length).toBeGreaterThan(0)
    expect(new Set(cards.map((card) => card.workOrder.customerCode))).toEqual(new Set(['SEED-C1']))
    const paper = await ok('office', `/production/dispatch/print/paper?lineId=${lineL1}&language=en`)
    expect(paper.columns.slice(0, 3)).toEqual(['No.', 'Work order', 'Customer'])
    const rows = (paper.sections as Json[]).flatMap((section) => section.rows as Json[])
    expect(rows.length).toBeGreaterThan(0)
    expect(new Set(rows.map((row) => row.cells[2]))).toEqual(new Set(['SEED-C1']))
  })

  it('the traveller prints the code; the Line TV and a bundle ticket name no customer', async () => {
    const [paper] = await travellerPapers(callerFor(database, { ...SESSIONS.office!, requestId: newId() } as never), [seeded.production.workOrderId], 'en')
    expect(paper!.facts).toContainEqual({ label: 'Customer', value: 'SEED-C1' })
    seen.push({ url: 'traveller', body: paper })
    const tv = await ok('office', `/production/boards/tv?lineId=${lineL1}`)
    expect(JSON.stringify(tv)).not.toContain('SEED-C1')
    // The bundle's office record is not a floor surface; its ticket is.
    const bundle = await ok('office', `/production/bundles/${seeded.production.bundleIds[0]}`, false)
    expect(bundle.ticket).toBeDefined()
    expect(JSON.stringify(bundle.ticket)).not.toContain('SEED-C1')
    seen.push({ url: 'bundle ticket', body: bundle.ticket })
  })

  it('no shared floor answer holds the customer’s name, nor a key that names a party', () => {
    expect(seen.length).toBeGreaterThanOrEqual(7)
    for (const { url, body } of seen) {
      const text = JSON.stringify(body)
      for (const name of names) expect(text, `${url} names the customer`).not.toContain(name)
      expect(keysOf(body).filter((key) => NAME_KEYS.test(key)), url).toEqual([])
    }
  })
})
