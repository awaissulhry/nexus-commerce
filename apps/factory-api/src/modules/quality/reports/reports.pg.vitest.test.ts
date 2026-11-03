import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Quality reports (B-W2b-138; QHS-147; design quality.reports SCR-147) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security is real), tenant A from EVERY seed: in November 2026 the
 * seeds sign an end-of-line FAIL on line L1, final inspections of SEED-WO-0001 and WO-0003, an incoming inspection of P2's lot,
 * two NCRs and a hold. The clock is 10 December 2026. Made-up words only.
 *   - reports per role: every figure needs its records' view permission besides quality.reports.view;
 *   - never per worker (ANA-075): with fewer than 3 people behind it a figure is empty in words; two more people on line L1 and
 *     the line's figures show, while an operation one person did stays empty; no answer carries a person;
 *   - NCRs open and old holds at the period's end, against the previous period;
 *   - the trend per ISO week, the comparison by line, operation, supplier and style, incoming quality per supplier;
 *   - refusals: no right, another company's site, a person key, a period too long or ending after today.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/quality/reports`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'reports-a'
const NOW = new Date('2026-12-10T10:00:00.000Z')
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  company: id('company:A'),
  companyB: id('company:B'),
  site: id('site:A1'),
  siteB: id('site:B1'),
  line: id('site:A1:line:L1'),
  sew1: id('site:A1:station:SEW-01'),
  sew2: id('site:A1:station:SEW-02'),
  cut: id('site:A1:station:CUT-01'),
  wo1: id('production:work-order:WO-0001'),
  operator: id('worker:A1:operator'),
  lead: id('worker:A1:lead'),
  device: id('device:A1:cutting'),
}
const W3 = newId()
const W4 = newId()

const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all'): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [{ ...grant(permissions), companies }] })
const ALL_VIEWS: Permission[] = ['quality.reports.view', 'quality.inprocess.view', 'quality.inspections.view', 'quality.ncr.view', 'quality.capa.view', 'quality.holds.view', 'quality.incoming.view', 'quality.lots.view']
const SESSIONS: Record<string, SessionContext> = {
  quality: office(ALL_VIEWS),
  reportsOnly: office(['quality.reports.view']),
  floorman: office(['quality.reports.view', 'quality.inprocess.view']),
  buyer: office(['quality.reports.view', 'quality.incoming.view', 'quality.lots.view']),
  noRight: office(['quality.inprocess.view', 'quality.inspections.view']),
  otherCompany: office(ALL_VIEWS, [id('company:B')]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
async function refused(session: string, url: string, status: number): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
/** Words that name or count a person: never in a quality report. */
const PERSON = /^(workerId|employeeId|userId|ownerId|worker|workers|operator|inspector|people|createdById|signedById|displayName|name_of)$/

const NOVEMBER = `siteId=${A.site}&from=2026-11-01&to=2026-11-30`
let sewOp = ''
let cutOp = ''

/** A one-garment bundle of a free cell of SEED-WO-0001, as the bundles module makes it. */
async function bundle(code: string, colourway: string, size: string): Promise<string> {
  const cell = (await admin<{ id: string }>(`SELECT s.id FROM "WorkOrderSize" s JOIN "Colourway" c ON c.id = s."colourwayId" WHERE s."workOrderId" = $1 AND c.code = $2 AND s.size = $3`, [A.wo1, colourway, size]))[0]!.id
  const bundleId = newId()
  await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity, "deviceId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $8)`, [bundleId, A.tenant, A.site, A.wo1, cell, code, A.device, new Date('2026-11-16T10:30:00Z')])
  return bundleId
}

/** A scan as the floor writes it: the bundle's one garment reported good at an operation, by a worker at a station. */
async function scan(bundleId: string, worker: string, operation: string, station: string, at: string) {
  const scanId = newId()
  await admin(
    `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "workerId", "stationId", "deviceId", "clientScanId", "deviceTime", "serverTime", "createdById")
     VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', 1, $7, $8, $9, $10, $11, $11, $7)`,
    [scanId, A.tenant, A.site, A.wo1, operation, bundleId, worker, station, A.device, `qr-${scanId}`, new Date(at)],
  )
}

/** What the database holds for November, so the answer can be checked against it (signed rows only). */
async function novemberFacts() {
  const span = ['2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z']
  const eol = (await admin<{ pieces: number; defective: number; defects: number; checks: number }>(
    `SELECT COALESCE(SUM(pieces), 0)::int AS pieces, COALESCE(SUM("defectivePieces"), 0)::int AS defective, COALESCE(SUM(defects), 0)::int AS defects, COUNT(*)::int AS checks
       FROM "InProcessCheck" WHERE "tenantId" = $1 AND "siteId" = $2 AND kind = 'END_OF_LINE' AND status = 'DECIDED' AND "decidedAt" >= $3 AND "decidedAt" < $4`,
    [A.tenant, A.site, ...span],
  ))[0]!
  const finals = (await admin<{ passed: number; decided: number }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'PASSED')::int AS passed, COUNT(*)::int AS decided FROM "Inspection" WHERE "tenantId" = $1 AND "siteId" = $2 AND status IN ('PASSED', 'FAILED') AND "decidedAt" >= $3 AND "decidedAt" < $4`,
    [A.tenant, A.site, ...span],
  ))[0]!
  return { eol, finals }
}

beforeAll(async () => {
  db = await migratedDatabase('quality_reports')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  for (const row of await admin<{ id: string; kind: string }>(`SELECT o.id, c.kind::text FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1`, [A.wo1])) {
    if (row.kind === 'CUTTING') cutOp = row.id
    else if (!['INSPECTION', 'PACKING'].includes(row.kind) && !sewOp) sewOp = row.id
  }
  // The seeds date some rows from the real clock (the database checks them against its own today): the report's clock moves after them.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('refusals', () => {
  it('no quality.reports.view: refused; another company\'s reader does not find the site', async () => {
    await refused('noRight', `/quality/reports/kpis?${NOVEMBER}`, 403)
    await refused('otherCompany', `/quality/reports/kpis?${NOVEMBER}`, 404)
  })

  it('a person key is refused like any unknown key; a period too long, backwards or after today is refused in words', async () => {
    expect((await refused('quality', `/quality/reports/compare?${NOVEMBER}&by=line&workerId=${A.operator}`, 400)).code).toBe('validation_failed')
    await refused('quality', `/quality/reports/compare?${NOVEMBER}&by=worker`, 400)
    expect((await refused('quality', `/quality/reports/kpis?siteId=${A.site}&from=2025-11-01&to=2026-11-30`, 400)).message).toBe('A report covers at most 366 days.')
    expect((await refused('quality', `/quality/reports/kpis?siteId=${A.site}&from=2026-11-10&to=2026-11-01`, 400)).message).toBe('The period ends before it starts.')
    expect((await refused('quality', `/quality/reports/trend?siteId=${A.site}&from=2026-12-01&to=2026-12-11`, 400)).message).toMatch(/cannot end after today/)
    await refused('quality', `/quality/reports/trend?${NOVEMBER}&lineId=${newId()}`, 404)
  })
})

describe('reports per role (QHS-147)', () => {
  it('the page alone shows no figure: each needs the view of its records, said by `sight`', async () => {
    const answer = await ok('reportsOnly', `/quality/reports/kpis?${NOVEMBER}&compare=previous`)
    expect(answer.sight).toEqual({ inprocess: false, inspections: false, ncr: false, capa: false, holds: false, incoming: false, lots: false })
    expect(answer.kpis).toEqual({ fpy: null, dhu: null, aqlPass: null, ncrOpen: null, capaOnTime: null, holdsOld: null })
    expect(answer.amendments).toBeNull()
    expect((await ok('reportsOnly', `/quality/reports/compare?${NOVEMBER}&by=supplier`)).rows).toEqual([])
  })

  it('the floor supervisor sees the in-process figures only; the buyer incoming quality only', async () => {
    const floor = await ok('floorman', `/quality/reports/kpis?${NOVEMBER}`)
    expect(floor.kpis.fpy).not.toBeNull()
    expect(floor.kpis.aqlPass).toBeNull()
    expect(floor.kpis.ncrOpen).toBeNull()
    const buyer = await ok('buyer', `/quality/reports/incoming?${NOVEMBER}`)
    expect(buyer.sight).toEqual({ incoming: true, lots: true })
    expect((await ok('buyer', `/quality/reports/kpis?${NOVEMBER}`)).kpis.fpy).toBeNull()
  })
})

describe('never per worker (ANA-075)', () => {
  it('with fewer than 3 people behind them the site\'s FPY, DHU and AQL show no figure', async () => {
    const answer = await ok('quality', `/quality/reports/kpis?${NOVEMBER}`)
    expect(answer.minimumGroupSize).toBe(3)
    expect(answer.kpis.fpy).toMatchObject({ tooFew: true, value: null, part: null, whole: null, checks: null })
    expect(answer.kpis.dhu).toMatchObject({ tooFew: true, value: null })
    expect(answer.kpis.aqlPass).toMatchObject({ tooFew: true, value: null })
    const lines = await ok('quality', `/quality/reports/compare?${NOVEMBER}&by=line`)
    expect(lines.rows.find((row: Json) => row.ref?.id === A.line)).toMatchObject({ tooFew: true, inspected: null, dhu: null, aql: null, ncrs: null })
    expect(lines.hidden).toBeGreaterThan(0)
    // The week of the seed's end-of-line checks on L1 hides its figures; a week with no check is "—", not "too few".
    const trend = await ok('quality', `/quality/reports/trend?${NOVEMBER}&lineId=${A.line}`)
    expect(trend.weeks.find((week: Json) => week.week === '2026-W47')).toMatchObject({ tooFew: true, fpy: null, dhu: null, pieces: null })
    expect(trend.weeks.find((week: Json) => week.week === '2026-W45')).toMatchObject({ tooFew: false, fpy: null, pieces: 0, checks: 0 })
  })

  it('two more people on line L1 in the week of the seed\'s end-of-line check: the site, the line and that week show; an operation one person did stays empty', async () => {
    await admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName") VALUES ($1, $2, $3, $4, 'Made-up Three'), ($5, $2, $3, $4, 'Made-up Four')`, [W3, A.tenant, A.company, A.site, W4])
    // Both have read the workers' notice in force, as the operator has (no scan names a worker before that: art. 4 c.3).
    for (const worker of [W3, W4]) {
      await admin(
        `INSERT INTO "WorkerNoticeAck" (id, "tenantId", "siteId", "workerId", "noticeVersion", locale, "noticeSha256", channel, "noticeId", "deviceId", "deviceTime")
         SELECT gen_random_uuid(), "tenantId", "siteId", $2, "noticeVersion", locale, "noticeSha256", channel, "noticeId", "deviceId", "deviceTime" FROM "WorkerNoticeAck" WHERE "tenantId" = $1 AND "workerId" = $3`,
        [A.tenant, worker, A.operator],
      )
    }
    // Three garments cut by the operator at the cutting table (a station on no line: cutting stays one person's work), each
    // sewn on L1 by another person.
    const made = [await bundle('QR-BN-1', 'BLK', '54'), await bundle('QR-BN-2', 'RED', '50'), await bundle('QR-BN-3', 'RED', '52')]
    for (const [index, bundleId] of made.entries()) await scan(bundleId, A.operator, cutOp, A.cut, `2026-11-17T0${7 + index}:00:00Z`)
    await scan(made[0]!, A.operator, sewOp, A.sew1, '2026-11-17T10:00:00Z')
    await scan(made[1]!, W3, sewOp, A.sew1, '2026-11-17T11:00:00Z')
    await scan(made[2]!, W4, sewOp, A.sew2, '2026-11-17T12:00:00Z')
    const facts = await novemberFacts()
    expect(facts.eol.checks).toBeGreaterThan(0)
    const answer = await ok('quality', `/quality/reports/kpis?${NOVEMBER}`)
    const fpy = facts.eol.pieces > 0 ? (Math.round(((facts.eol.pieces - facts.eol.defective) * 1000) / facts.eol.pieces) / 10).toFixed(1) : null
    const dhu = facts.eol.pieces > 0 ? (Math.round((facts.eol.defects * 1000) / facts.eol.pieces) / 10).toFixed(1) : null
    expect(answer.kpis.fpy).toMatchObject({ tooFew: false, value: fpy, part: facts.eol.pieces - facts.eol.defective, whole: facts.eol.pieces, checks: facts.eol.checks })
    expect(answer.kpis.dhu).toMatchObject({ tooFew: false, value: dhu, part: facts.eol.defects, whole: facts.eol.pieces })
    // The AQL pass rate stands on the makers of the inspected work orders: WO-0001's now has 3 or more.
    expect(answer.kpis.aqlPass.weeks.length).toBe(6)

    const lines = await ok('quality', `/quality/reports/compare?${NOVEMBER}&by=line`)
    const l1 = lines.rows.find((row: Json) => row.ref?.id === A.line)
    expect(l1).toMatchObject({ tooFew: false, ref: { code: 'L1' }, inspected: facts.eol.pieces, defects: facts.eol.defects, dhu })

    const operations = await ok('quality', `/quality/reports/compare?${NOVEMBER}&by=operation`)
    expect(operations.sight).toEqual({ counts: true, aql: false, ncrs: false })
    // Sewing: three people this month; every row is by the operation, never by who did it.
    const sewing = operations.rows.find((row: Json) => row.tooFew === false)
    expect(sewing).toBeDefined()
    expect(sewing.aql).toBeNull()
    expect(sewing.ncrs).toBeNull()
    expect(operations.rows.some((row: Json) => row.tooFew === true && row.inspected === null && row.defects === null)).toBe(true)
  })

  it('no answer names, counts or lists a person', async () => {
    for (const url of [`/quality/reports/kpis?${NOVEMBER}&compare=previous`, `/quality/reports/trend?${NOVEMBER}`, `/quality/reports/trend?${NOVEMBER}&lineId=${A.line}`, `/quality/reports/compare?${NOVEMBER}&by=line`, `/quality/reports/compare?${NOVEMBER}&by=operation`, `/quality/reports/compare?${NOVEMBER}&by=style`, `/quality/reports/compare?${NOVEMBER}&by=supplier`, `/quality/reports/incoming?${NOVEMBER}`]) {
      const response = await call('quality', url)
      expect(response.statusCode, `${url} ${response.body}`).toBe(200)
      expect(keysOf(response.json()).filter((key) => PERSON.test(key)), url).toEqual([])
      for (const worker of [A.operator, A.lead, W3, W4]) expect(response.body.includes(worker), url).toBe(false)
      expect(response.body).not.toMatch(/Made-up (Three|Four)/)
    }
  })
})

describe('the headline numbers at the period\'s end, against the previous period', () => {
  it('NCRs open and their age, old holds, CAPA on time and the corrections signed', async () => {
    const answer = await ok('quality', `/quality/reports/kpis?${NOVEMBER}&compare=previous`)
    expect(answer.previous).toEqual({ from: '2026-10-02', to: '2026-10-31' })
    const end = new Date('2026-11-30T22:59:59.999Z')
    const open = await admin<{ foundOn: Date }>(
      `SELECT "foundOn" FROM "Nonconformance" WHERE "tenantId" = $1 AND "siteId" = $2 AND "foundOn" <= $3 AND ("closedAt" IS NULL OR "closedAt" > $3) AND ("cancelledAt" IS NULL OR "cancelledAt" > $3)`,
      [A.tenant, A.site, end],
    )
    expect(open.length).toBeGreaterThan(0)
    expect(answer.kpis.ncrOpen).toMatchObject({ value: open.length, previous: { value: 0, averageAgeDays: null } })
    expect(answer.kpis.ncrOpen.change).toMatchObject({ direction: 'UP', better: false })
    const age = open.reduce((total, row) => total + (end.getTime() - new Date(row.foundOn).getTime()) / 86_400_000, 0) / open.length
    expect(answer.kpis.ncrOpen.averageAgeDays).toBe((Math.round(age * 10) / 10).toFixed(1))
    // The seed's hold of SEED-HIDE-0002 was placed on 21 November and still stands on the 30th: older than 7 days.
    expect(answer.kpis.holdsOld).toMatchObject({ value: 1, previous: { value: 0 }, change: { direction: 'UP', by: '1.0', better: false } })
    expect(answer.kpis.capaOnTime).toMatchObject({ weeks: [] })
    const signed = (await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "InspectionAmendment" WHERE "tenantId" = $1 AND "siteId" = $2 AND kind = 'SIGNED' AND "signedAt" >= '2026-10-31T23:00:00Z' AND "signedAt" < '2026-11-30T23:00:00Z'`, [A.tenant, A.site]))[0]!.n
    expect(answer.amendments).toEqual({ signed })
    expect(signed).toBeGreaterThan(0)
  })

  it('a period with nothing signed says "—" (null), never 0', async () => {
    const answer = await ok('quality', `/quality/reports/kpis?siteId=${A.site}&from=2026-12-01&to=2026-12-09`)
    expect(answer.kpis.fpy.value).toBeNull()
    expect(answer.kpis.aqlPass.value).toBeNull()
    expect(answer.kpis.fpy.weeks.map((week: Json) => week.week)).toEqual(['2026-W49', '2026-W50'])
  })
})

describe('the trend, the comparison and incoming quality', () => {
  it('the trend has every ISO week of the period; only the week with three people on L1 shows its end-of-line figures', async () => {
    const trend = await ok('quality', `/quality/reports/trend?${NOVEMBER}&lineId=${A.line}`)
    expect(trend.lineId).toBe(A.line)
    expect(trend.lines.map((line: Json) => line.code)).toContain('L1')
    expect(trend.weeks.map((week: Json) => week.week)).toEqual(['2026-W44', '2026-W45', '2026-W46', '2026-W47', '2026-W48', '2026-W49'])
    expect(trend.weeks[0]).toMatchObject({ from: '2026-11-01', to: '2026-11-01' })
    const w47 = trend.weeks.find((week: Json) => week.week === '2026-W47')
    expect(w47).toMatchObject({ tooFew: false })
    expect(w47.pieces).toBeGreaterThan(0)
    for (const week of trend.weeks.filter((entry: Json) => entry.week !== '2026-W47')) expect(week).toMatchObject({ tooFew: false, fpy: null, dhu: null, pieces: 0 })
    for (const week of trend.weeks) expect(week.capaClosed).toMatchObject({ count: expect.any(Number) })
  })

  it('by supplier: incoming inspections per supplier, never masked (companies, not people); by style: final inspections', async () => {
    const suppliers = await ok('quality', `/quality/reports/compare?${NOVEMBER}&by=supplier`)
    expect(suppliers.sight).toEqual({ counts: true, aql: true, ncrs: true })
    expect(suppliers.rows.length).toBeGreaterThan(0)
    for (const row of suppliers.rows) expect(row.tooFew).toBe(false)
    const decided = (await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "IncomingInspection" WHERE "tenantId" = $1 AND "siteId" = $2 AND status = 'DECIDED' AND "decidedAt" >= '2026-10-31T23:00:00Z' AND "decidedAt" < '2026-11-30T23:00:00Z'`, [A.tenant, A.site]))[0]!.n
    expect(suppliers.rows.reduce((total: number, row: Json) => total + (row.aql?.decided ?? 0), 0)).toBe(decided)
    const styles = await ok('quality', `/quality/reports/compare?${NOVEMBER}&by=style`)
    expect(styles.sight).toEqual({ counts: true, aql: true, ncrs: true })
    const facts = await novemberFacts()
    const shown = styles.rows.filter((row: Json) => !row.tooFew)
    const hiddenFinals = facts.finals.decided - shown.reduce((total: number, row: Json) => total + (row.aql?.decided ?? 0), 0)
    expect(hiddenFinals).toBeGreaterThanOrEqual(0)
  })

  it('incoming quality per supplier: lots received, rejected, Cr VI fails, days in quarantine and the inspections', async () => {
    const answer = await ok('quality', `/quality/reports/incoming?${NOVEMBER}`)
    expect(answer.sight).toEqual({ incoming: true, lots: true })
    const inspected = answer.suppliers.filter((row: Json) => (row.inspections ?? 0) > 0)
    expect(inspected.length).toBeGreaterThan(0)
    const received = (await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Lot" WHERE "tenantId" = $1 AND "siteId" = $2 AND "receivedAt" >= '2026-10-31T23:00:00Z' AND "receivedAt" < '2026-11-30T23:00:00Z'`, [A.tenant, A.site]))[0]!.n
    expect(answer.suppliers.reduce((total: number, row: Json) => total + (row.lotsReceived ?? 0), 0)).toBe(received)
    // Without quality.lots.view the lot columns are empty; the inspections stay.
    const noLots = { ...SESSIONS.buyer!, grants: [grant(['quality.reports.view', 'quality.incoming.view'])] }
    SESSIONS.noLots = noLots
    const partial = await ok('noLots', `/quality/reports/incoming?${NOVEMBER}`)
    expect(partial.sight).toEqual({ incoming: true, lots: false })
    for (const row of partial.suppliers) expect(row).toMatchObject({ lotsReceived: null, rejected: null, crViFails: null, averageQuarantineDays: null })
  })
})
