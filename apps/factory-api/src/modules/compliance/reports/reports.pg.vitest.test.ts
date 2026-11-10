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
 * Compliance reports (B-W2b-272; ANA-025; design compliance.reports SCR-261) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), tenant A from EVERY seed: in
 * November 2026 the seeds record gate refusals and an override, a shipment to Italy, a lot issued to production with its
 * passing chromium VI result, register entries of every kind with a recall in progress, an authority notice sent and three
 * authority requests, and an accepted supplier declaration valid to October 2027. The clock is 10 December 2026. Made-up
 * words only.
 *   - ANA-025 is the status board's own matrix: a cell is covered exactly when its certificate line (GET /compliance/status/cell)
 *     is OK or Expiring, over the cells where that line applies;
 *   - every figure is checked against what the database holds; the brand filter; the company's and tenant-wide styles;
 *   - reports per role: every figure needs its records' view permission besides compliance.reports.view;
 *   - refusals: no right, another company's screen, an unknown key, a period too long or ending after today, an unknown brand.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/reports`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'compliance-reports-a'
const NOW = new Date('2026-12-10T10:00:00.000Z')
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), company: id('company:A'), companyB: id('company:B') }

const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all', companyId: string = A.company): SessionContext =>
  ({ audience: 'office', tenantId: A.tenant, actorId: newId(), companyId, grants: [grant(permissions, companies)] }) as SessionContext
const ALL_VIEWS: Permission[] = ['compliance.reports.view', 'compliance.certificates.view', 'compliance.register.view', 'quality.lots.view', 'shipping.view']
const SESSIONS: Record<string, SessionContext> = {
  quality: office(ALL_VIEWS),
  reportsOnly: office(['compliance.reports.view']),
  register: office(['compliance.reports.view', 'compliance.register.view']),
  noRight: office(['compliance.certificates.view', 'compliance.register.view']),
  otherCompany: office(ALL_VIEWS, [id('company:B')]),
  companyB: office(ALL_VIEWS, 'all', id('company:B')),
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

const NOVEMBER = 'from=2026-11-01&to=2026-11-30'
// The period in Rome: 1 November 00:00 (CET) to 1 December 00:00.
const SPAN = ['2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z']

beforeAll(async () => {
  db = await migratedDatabase('compliance_reports')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  // The seeds date some rows from the real clock (the database checks them against its own today): the report's clock moves after them.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 1_500_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('refusals', () => {
  it('no compliance.reports.view: refused; a reader of company B only, on company A\'s screen: refused in words', async () => {
    await refused('noRight', `/compliance/reports/kpis?${NOVEMBER}`, 403)
    expect((await refused('otherCompany', `/compliance/reports/kpis?${NOVEMBER}`, 403)).message).toBe('Compliance reports of this company are not in your role.')
  })

  it('an unknown key, a period too long, backwards or after today, an unknown brand, a bad number of months', async () => {
    expect((await refused('quality', `/compliance/reports/kpis?${NOVEMBER}&workerId=${newId()}`, 400)).code).toBe('validation_failed')
    expect((await refused('quality', '/compliance/reports/kpis?from=2025-11-01&to=2026-11-30', 400)).message).toBe('A report covers at most 366 days.')
    expect((await refused('quality', '/compliance/reports/register?from=2026-11-10&to=2026-11-01', 400)).message).toBe('The period ends before it starts.')
    expect((await refused('quality', '/compliance/reports/cr6?from=2026-12-01&to=2026-12-11', 400)).message).toMatch(/cannot end after today/)
    expect((await refused('quality', `/compliance/reports/gaps?brandId=${newId()}`, 404)).message).toBe('Brand not found.')
    await refused('quality', '/compliance/reports/expiries?months=30', 400)
  })
})

describe('reports per role', () => {
  it('the page alone shows no figure: each needs the view of its records, said by `sight`', async () => {
    const kpis = await ok('reportsOnly', `/compliance/reports/kpis?${NOVEMBER}`)
    expect(kpis.sight).toEqual({ certificates: false, register: false, lots: false, shipments: false })
    expect(kpis.kpis).toEqual({ coverage: null, shipped: null, gaps: null, refusals: null, registerOpen: null, crViLots: null })
    expect(kpis.styles).toBeNull()
    expect((await ok('reportsOnly', '/compliance/reports/gaps')).rows).toEqual([])
    expect((await ok('reportsOnly', '/compliance/reports/expiries')).months.every((month: Json) => month.count === 0)).toBe(true)
    expect((await ok('reportsOnly', `/compliance/reports/cr6?${NOVEMBER}`)).suppliers).toEqual([])
    expect((await ok('reportsOnly', `/compliance/reports/register?${NOVEMBER}`))).toMatchObject({ kinds: [], all: null, notices: null, recalls: null, requests: null })
  })

  it('a register reader sees the register figures only', async () => {
    const kpis = await ok('register', `/compliance/reports/kpis?${NOVEMBER}`)
    expect(kpis.sight).toEqual({ certificates: false, register: true, lots: false, shipments: false })
    expect(kpis.kpis.registerOpen).not.toBeNull()
    expect(kpis.kpis.coverage).toBeNull()
    expect(kpis.kpis.crViLots).toBeNull()
  })
})

describe('ANA-025 certificate coverage and the headline numbers (November 2026)', () => {
  let kpis: Json
  beforeAll(async () => {
    kpis = await ok('quality', `/compliance/reports/kpis?${NOVEMBER}`)
  })

  it('the head: company A, the period, today, the sight; the matrix read whole (tenant-wide styles count for the company)', async () => {
    expect(kpis).toMatchObject({ company: { id: A.company }, brand: null, from: '2026-11-01', to: '2026-11-30', today: '2026-12-10' })
    expect(kpis.sight).toEqual({ certificates: true, register: true, lots: true, shipments: true })
    const styles = await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Style" WHERE "tenantId" = $1 AND status <> 'ARCHIVED' AND ("companyId" IS NULL OR "companyId" = $2)`, [A.tenant, A.company])
    expect(kpis.styles).toMatchObject({ read: styles[0]!.n, more: false })
    expect(kpis.styles.markets.map((market: Json) => market.code)).toEqual(['IT', 'DE', 'FR', 'ES'])
    expect(kpis.brands.map((brand: Json) => brand.code)).toContain('SEED-C1')
  })

  it('a cell is covered exactly when the status board\'s certificate line is OK or Expiring (the same formula)', async () => {
    const board = await ok('quality', '/compliance/status/board')
    let needing = 0
    let covered = 0
    for (const row of board.rows) {
      for (const market of board.markets) {
        const cell = await ok('quality', `/compliance/status/cell?styleId=${row.style.id}&market=${market.code}`)
        const states = cell.items.filter((item: Json) => item.check === 'certificate.coverage' && item.state !== 'NOT_NEEDED').map((item: Json) => item.state)
        if (states.length === 0) continue
        needing += 1
        if (!states.includes('MISSING') && states.every((state: string) => state === 'OK' || state === 'EXPIRING')) covered += 1
      }
    }
    expect(needing).toBeGreaterThan(0)
    expect(kpis.kpis.coverage).toMatchObject({ needing, covered, cells: board.rows.length * board.markets.length })
    expect(kpis.kpis.coverage.pct).toBe((Math.round((covered / needing) * 1000) / 10).toFixed(1))
  })

  it('gate refusals and overrides recorded in November for company A', async () => {
    const rows = await admin<{ gate: string; outcome: string }>(`SELECT gate::text, outcome::text FROM "GateEvent" WHERE "tenantId" = $1 AND "companyId" = $2 AND "createdAt" >= $3 AND "createdAt" < $4`, [A.tenant, A.company, ...SPAN])
    const refused = rows.filter((row) => row.outcome === 'REFUSED')
    expect(refused.length).toBeGreaterThan(0)
    expect(kpis.kpis.refusals.count).toBe(refused.length)
    expect(kpis.kpis.refusals.overridden).toBe(rows.filter((row) => row.outcome === 'OVERRIDDEN').length)
    for (const entry of kpis.kpis.refusals.byGate) expect(entry.count).toBe(refused.filter((row) => row.gate === entry.gate).length)
  })

  it('register entries open at the end of November, and those that may present a risk', async () => {
    const open = await admin<{ n: number; risk: number }>(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE risk = 'YES')::int AS risk FROM "PpeRegisterEntry" WHERE "tenantId" = $1 AND "companyId" = $2 AND "reportedAt" < $3 AND ("closedAt" IS NULL OR "closedAt" >= $3)`,
      [A.tenant, A.company, SPAN[1]],
    )
    expect(open[0]!.n).toBeGreaterThan(0)
    expect(kpis.kpis.registerOpen).toEqual({ count: open[0]!.n, risk: open[0]!.risk })
  })

  it('lots that need a Cr VI test issued to production in November, with their passing results', async () => {
    const lots = await admin<{ n: number; pass: number }>(
      `SELECT COUNT(DISTINCT l.id)::int AS n, COUNT(DISTINCT l.id) FILTER (WHERE l."crViStatus" = 'PASS')::int AS pass FROM "StockMove" m JOIN "Lot" l ON l.id = m."lotId"
        WHERE m."tenantId" = $1 AND l."companyId" = $2 AND m.reason = 'ISSUE' AND m."reversalOfId" IS NULL AND m."occurredAt" >= $3 AND m."occurredAt" < $4 AND l."requiresCrViTest"
          AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."reversalOfId" = m.id)`,
      [A.tenant, A.company, ...SPAN],
    )
    expect(lots[0]!.n).toBeGreaterThan(0)
    expect(kpis.kpis.crViLots).toEqual({ lots: lots[0]!.n, withEvidence: lots[0]!.pass, pct: ((lots[0]!.pass / lots[0]!.n) * 100).toFixed(1) })
  })

  it('the shipments of November: their style × market pairs, measured against the board\'s cells', async () => {
    const shipped = await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Shipment" WHERE "tenantId" = $1 AND "companyId" = $2 AND status IN ('SHIPPED', 'DELIVERED', 'RETURNED') AND "shippedAt" >= $3 AND "shippedAt" < $4`, [A.tenant, A.company, ...SPAN])
    expect(shipped[0]!.n).toBeGreaterThan(0)
    expect(kpis.kpis.shipped.shipments).toBe(shipped[0]!.n)
    expect(kpis.kpis.shipped.pairs).toBeGreaterThan(0)
    expect(kpis.kpis.shipped.needing + kpis.kpis.shipped.unknown).toBeLessThanOrEqual(kpis.kpis.shipped.pairs)
    expect(kpis.kpis.shipped.covered).toBeLessThanOrEqual(kpis.kpis.shipped.needing)
  })

  it('a period with nothing recorded: counts are 0 and rates null (never 0 % for nothing)', async () => {
    const empty = await ok('quality', '/compliance/reports/kpis?from=2025-01-01&to=2025-01-31')
    expect(empty.kpis.refusals.count).toBe(0)
    expect(empty.kpis.crViLots).toEqual({ lots: 0, withEvidence: 0, pct: null })
    expect(empty.kpis.shipped).toMatchObject({ pairs: 0, needing: 0, pct: null })
  })
})

describe('gaps by type (today)', () => {
  it('every missing line of the matrix by type, the Cr VI lots without evidence, the total the tile shows', async () => {
    const gaps = await ok('quality', '/compliance/reports/gaps')
    expect(gaps.rows.map((row: Json) => row.type)).toEqual(['certificate', 'docLanguage', 'label', 'crVi', 'operator', 'other'])
    const kpis = await ok('quality', `/compliance/reports/kpis?${NOVEMBER}`)
    expect(gaps.rows.reduce((sum: number, row: Json) => sum + row.count, 0)).toBe(kpis.kpis.gaps.count)
    expect(kpis.kpis.gaps.crViCounted).toBe(true)
    const held = await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "Lot" WHERE "tenantId" = $1 AND "companyId" = $2 AND "requiresCrViTest" AND "crViStatus" IN ('PENDING', 'FAIL') AND "qualityStatus" IN ('QUARANTINE', 'BLOCKED')`, [A.tenant, A.company])
    expect(gaps.rows.find((row: Json) => row.type === 'crVi')).toMatchObject({ count: held[0]!.n, styles: null, markets: null })
    // The DoC languages the board asks of every market as if the style sold there (B-W2b-254): the seeds miss some.
    const doc = gaps.rows.find((row: Json) => row.type === 'docLanguage')
    expect(doc.count).toBeGreaterThan(0)
    expect(doc.requirements.length).toBeGreaterThan(0)
    expect(doc.styles).toBeGreaterThan(0)
  })

  it('without lots in sight the Cr VI row is left out (not a zero)', async () => {
    const only = { ...SESSIONS.quality!, grants: [grant(['compliance.reports.view', 'compliance.certificates.view'])] } as SessionContext
    SESSIONS.certificatesOnly = only
    const gaps = await ok('certificatesOnly', '/compliance/reports/gaps')
    expect(gaps.rows.map((row: Json) => row.type)).not.toContain('crVi')
  })
})

describe('the brand and the company', () => {
  it('one brand: only its styles\' cells; the tenant-wide styles count for company B too', async () => {
    const brand = (await admin<{ id: string; n: number }>(`SELECT s."brandPartyId" AS id, COUNT(*)::int AS n FROM "Style" s WHERE s."tenantId" = $1 AND s."brandPartyId" IS NOT NULL AND s.status <> 'ARCHIVED' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [A.tenant]))[0]!
    const branded = await ok('quality', `/compliance/reports/kpis?${NOVEMBER}&brandId=${brand.id}`)
    expect(branded.brand).toMatchObject({ id: brand.id })
    expect(branded.styles.read).toBe(brand.n)
    expect(branded.kpis.coverage.cells).toBe(brand.n * branded.styles.markets.length)
    const b = await ok('companyB', `/compliance/reports/kpis?${NOVEMBER}`)
    expect(b.company).toMatchObject({ id: A.companyB })
    expect(b.styles.read).toBeGreaterThan(0)
    expect(b.kpis.registerOpen.count).toBe(0)
  })
})

describe('the expiry calendar (12 months from today)', () => {
  it('certificates in force and accepted declarations ending in the window, per month; a new certificate ending in March 2027 shows there', async () => {
    const certificateId = newId()
    await admin(
      `INSERT INTO "Certificate" (id, "tenantId", "companyId", standard, number, "notifiedBodyName", "notifiedBodyNumber", "validFrom", "validTo", status, "updatedAt") VALUES ($1, $2, $3, 'EN 17092-4:2020', 'RPT-CERT-0001', 'Made-up Body', '9998', '2022-04-01', '2027-03-31', 'VALID', now())`,
      [certificateId, A.tenant, A.company],
    )
    const calendar = await ok('quality', '/compliance/reports/expiries')
    expect(calendar.months).toHaveLength(12)
    expect(calendar.months[0].month).toBe('2026-12')
    expect(calendar).toMatchObject({ from: '2026-12-10', to: '2027-12-10' })
    const march = calendar.months.find((month: Json) => month.month === '2027-03')
    expect(march.items).toEqual([expect.objectContaining({ recordType: 'Certificate', recordId: certificateId, label: 'RPT-CERT-0001', validTo: '2027-03-31', status: 'VALID', detail: 'EN 17092-4:2020', endsWithBase: false })])
    const declarations = await admin<{ id: string; validTo: Date }>(`SELECT id, "validTo" FROM "SupplierDeclarationRequest" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'ACCEPTED' AND "validTo" BETWEEN '2026-12-10' AND '2027-12-10'`, [A.tenant, A.company])
    expect(declarations.length).toBeGreaterThan(0)
    const items = calendar.months.flatMap((month: Json) => month.items)
    for (const row of declarations) expect(items).toContainEqual(expect.objectContaining({ recordType: 'SupplierDeclarationRequest', recordId: row.id, status: 'ACCEPTED' }))
    expect(calendar.count).toBe(items.length)
    expect((await ok('quality', '/compliance/reports/expiries?months=3')).months).toHaveLength(3)
  })
})

describe('chromium VI per supplier (November)', () => {
  it('the current results per lot supplier: lots, median, highest, fails, the limit', async () => {
    const rows = await admin<{ supplier: string | null; lots: number; fails: number; high: string }>(
      `SELECT l."supplierId" AS supplier, COUNT(DISTINCT r."lotId")::int AS lots, COUNT(*) FILTER (WHERE r.verdict = 'FAIL')::int AS fails, MAX(r."valueMgKg")::text AS high
         FROM "LabResult" r JOIN "Lot" l ON l.id = r."lotId"
        WHERE r."tenantId" = $1 AND r."companyId" = $2 AND r.test = 'CR_VI' AND r."testedOn" BETWEEN '2026-11-01' AND '2026-11-30' AND NOT EXISTS (SELECT 1 FROM "LabResult" s WHERE s."supersedesId" = r.id)
        GROUP BY 1`,
      [A.tenant, A.company],
    )
    expect(rows.length).toBeGreaterThan(0)
    const answer = await ok('quality', `/compliance/reports/cr6?${NOVEMBER}`)
    expect(answer.unit).toBe('mg/kg')
    expect(answer.suppliers).toHaveLength(rows.length)
    for (const row of rows) {
      const found = answer.suppliers.find((entry: Json) => (entry.party?.id ?? null) === row.supplier)
      expect(found).toMatchObject({ lots: row.lots, fails: row.fails, highest: String(Number(row.high)), limit: '3' })
    }
    expect((await ok('quality', '/compliance/reports/cr6?from=2025-01-01&to=2025-01-31')).suppliers).toEqual([])
  })
})

describe('the register summary (November)', () => {
  it('per kind opened, closed and open at the end; notices sent; recalls in progress; authority requests on time', async () => {
    const answer = await ok('quality', `/compliance/reports/register?${NOVEMBER}`)
    expect(answer.months).toEqual(['2026-11'])
    expect(answer.kinds.map((row: Json) => row.kind)).toEqual(['COMPLAINT', 'NON_CONFORMITY', 'RECALL', 'WITHDRAWAL', 'AUTHORITY_REQUEST'])
    const opened = await admin<{ kind: string; n: number }>(`SELECT kind::text, COUNT(*)::int AS n FROM "PpeRegisterEntry" WHERE "tenantId" = $1 AND "companyId" = $2 AND "reportedAt" >= $3 AND "reportedAt" < $4 GROUP BY 1`, [A.tenant, A.company, ...SPAN])
    for (const row of answer.kinds) {
      expect(row.opened).toBe(opened.find((entry) => entry.kind === row.kind)?.n ?? 0)
      expect(row.months).toEqual([row.opened])
    }
    expect(answer.all.opened).toBe(opened.reduce((sum, row) => sum + row.n, 0))
    const sent = await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "AuthorityNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'SENT' AND "sentAt" >= $3 AND "sentAt" < $4`, [A.tenant, A.company, ...SPAN])
    expect(answer.notices.sent).toBe(sent[0]!.n)
    const active = await admin<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "RecallAction" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'ACTIVE'`, [A.tenant, A.company])
    expect(answer.recalls.active).toBe(active[0]!.n)
    const requests = await admin<{ received: number; answered: number; ontime: number; open: number; overdue: number }>(
      `SELECT COUNT(*) FILTER (WHERE "receivedAt" >= $3 AND "receivedAt" < $4)::int AS received,
              COUNT(*) FILTER (WHERE status = 'ANSWERED' AND "answeredAt" >= $3 AND "answeredAt" < $4)::int AS answered,
              COUNT(*) FILTER (WHERE status = 'ANSWERED' AND "answeredAt" >= $3 AND "answeredAt" < $4 AND "answeredAt" < (("dueOn" + 1)::timestamp AT TIME ZONE 'Europe/Rome'))::int AS ontime,
              COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
              COUNT(*) FILTER (WHERE status = 'OPEN' AND "dueOn" < '2026-12-10')::int AS overdue
         FROM "AuthorityRequest" WHERE "tenantId" = $1 AND "companyId" = $2`,
      [A.tenant, A.company, ...SPAN],
    )
    expect(answer.requests).toMatchObject({ received: requests[0]!.received, answered: requests[0]!.answered, onTime: requests[0]!.ontime, open: requests[0]!.open, overdue: requests[0]!.overdue })
    expect(answer.requests.received).toBeGreaterThan(0)
  })
})
