import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { choiceFilter } from '@nexus/factory-domain/insights/reports/definition'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../../env'
import { useReports } from '../registry'
import { defineReport } from '../report'

/**
 * The report run log and "last run by me" (B-W2b-24, Z12:06 of B-W2a-79; table ReportRun) through the app's real routes
 * on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the run guard are
 * real), with two made-up reports: each run of GET /reports/:key/results logs one row (the person, the key, the filters
 * as run, the time); the library and a report's About say when I last ran it, from my own rows only; a refused run logs
 * nothing; a log that cannot be written never fails the report. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/insights/reports/runs`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenant = newId()
const company = newId()
const anna = newId()
const bruno = newId()
const ghost = newId()

const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (actorId: string, permissions: readonly Permission[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, companyId: company, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  anna: office(anna, ['home.reports.view', 'sites.view']),
  bruno: office(bruno, ['home.reports.view', 'sites.view']),
  // A session whose person has no User row: the run log's insert fails (its user key), the report still answers.
  ghost: office(ghost, ['home.reports.view', 'sites.view']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const get = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await get(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const runsOf = (userId: string) => admin<{ reportKey: string; params: Json; at: Date }>(`SELECT "reportKey", params, at FROM "ReportRun" WHERE "tenantId" = $1 AND "userId" = $2 ORDER BY at, id`, [tenant, userId])
const libraryRow = async (session: string, key: string) => ((await ok(session, '/reports')).reports as Json[]).find((report) => report.key === key)!

const report = (key: string, title: string) =>
  defineReport({
    key,
    area: 'sales',
    title,
    question: `${title}?`,
    permission: 'sites.view',
    needs: null,
    columns: [
      { key: 'lane', label: 'Lane', kind: 'text', group: true },
      { key: 'good', label: 'Good', kind: 'number', sum: true },
    ],
    filters: [choiceFilter('state', 'State', { OPEN: 'Open', CLOSED: 'Closed' })],
    groupBy: null,
    sources: 'Test',
    definition: 'Test',
    numbers: [],
    mail: null,
    formats: ['CSV'],
    read: async () => ({ complete: true, rows: [{ id: 'r1', record: null, currency: null, cells: { lane: 'L1', good: 3 } }] }),
  })

beforeAll(async () => {
  db = await migratedDatabase('insights_report_runs')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'report-runs'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, 'RRN', 'Report Run Prova S.r.l.')`, [company, tenant])
  for (const [id, email, name] of [
    [anna, 'anna.r@example.com', 'Anna Demo'],
    [bruno, 'bruno.r@example.com', 'Bruno Demo'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, tenant, email, name])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
  useReports([report('sales.test-alpha', 'Alpha'), report('sales.test-beta', 'Beta')])
}, 120_000)

afterAll(async () => {
  useReports(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the run log (Z12:06)', () => {
  it('nothing run yet: the library and the About say never', async () => {
    expect(await libraryRow('anna', 'sales.test-alpha')).toMatchObject({ lastRunByMe: null })
    expect((await ok('anna', '/reports/sales.test-alpha')).lastRunByMe).toBeNull()
  })

  it('logs one row per run with the person, the key and the filters as run; the library says my newest run', async () => {
    await ok('anna', '/reports/sales.test-alpha/results')
    await ok('anna', '/reports/sales.test-alpha/results?state=OPEN&group=lane')
    await ok('anna', '/reports/sales.test-beta/results?group=none')
    const rows = await runsOf(anna)
    expect(rows.map((row) => [row.reportKey, row.params])).toEqual([
      ['sales.test-alpha', {}],
      ['sales.test-alpha', { state: 'OPEN', group: 'lane' }],
      ['sales.test-beta', { group: 'none' }],
    ])
    const newestAlpha = rows[1]!.at.toISOString()
    expect(await libraryRow('anna', 'sales.test-alpha')).toMatchObject({ lastRunByMe: newestAlpha })
    expect(await libraryRow('anna', 'sales.test-beta')).toMatchObject({ lastRunByMe: rows[2]!.at.toISOString() })
    expect((await ok('anna', '/reports/sales.test-alpha')).lastRunByMe).toBe(newestAlpha)
    // Not a command: no audit row per read.
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'ReportRun'`, [tenant])).toEqual([{ n: 0 }])
  })

  it('never another person’s runs: Bruno’s library says never until he runs it himself', async () => {
    expect(await libraryRow('bruno', 'sales.test-alpha')).toMatchObject({ lastRunByMe: null })
    await ok('bruno', '/reports/sales.test-beta/results')
    expect(await libraryRow('bruno', 'sales.test-beta')).toMatchObject({ lastRunByMe: (await runsOf(bruno))[0]!.at.toISOString() })
    expect(await libraryRow('bruno', 'sales.test-alpha')).toMatchObject({ lastRunByMe: null })
    expect((await runsOf(anna)).length).toBe(3)
  })

  it('a refused run logs nothing; a log that cannot be written never fails the report', async () => {
    const refused = await get('anna', '/reports/sales.test-alpha/results?group=good')
    expect(refused.statusCode).toBe(400)
    expect((await runsOf(anna)).length).toBe(3)
    const ghostRun = await ok('ghost', '/reports/sales.test-alpha/results')
    expect(ghostRun.rows).toHaveLength(1)
    expect(await runsOf(ghost)).toEqual([])
    expect((await ok('ghost', '/reports')).reports.every((row: Json) => row.lastRunByMe === null)).toBe(true)
  })

  it('the database keeps a run as it was: an update is refused', async () => {
    await expect(admin(`UPDATE "ReportRun" SET params = '{"state":"CLOSED"}'::jsonb WHERE "tenantId" = $1`, [tenant])).rejects.toThrow()
  })
})
