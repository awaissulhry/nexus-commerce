import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPeople } from '../../../../../../packages/factory-db/seed/people'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedSafety } from '../../../../../../packages/factory-db/seed/safety'
import { seed as seedHealth, type HealthSeed } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedPlantCare } from '../../../../../../packages/factory-db/seed/plantcare'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { incidents as incidentsExport } from '../../exports/sources/incidents'
import { systemContext } from '../../outbox/system'
import { indexEvent, rebuildIndex } from '../indexing'
import incidentIndexer from './incident'

/**
 * B-W2b-149 — Plant › Incidents is searchable and exportable, ANONYMISED (GDPR art. 9; B-W2b-91's rule "no export, no search
 * index" for the protected tables): the search entry of every incident is its number, its kind's words and its place as
 * codes — never a person (reporter, worker, anyone involved), never an injury, an INAIL filing or the free words of the
 * report — scoped to the incident's company and site and to safety.incidents.view; the export of the list (through the list's
 * own read) writes no person, no injury and no filing's type either. On a throwaway PostgreSQL 17 database from the migrations
 * with the seeds up to the health pages (B-W2b-125's incidents: an injury with its INSURANCE filing DUE, a hazard sent without
 * a name, a closed near miss…). Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs
 * platform/search/indexers/incident platform/exports/sources`.
 */

let h: Harness
let app: FastifyInstance
let health: HealthSeed

const NS = 'w2b149-incidents-search'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1') }
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.incidents.view'])] },
  siteB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.incidents.view'], [T.companyB], [T.siteB1])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view', 'orders.view'])] },
}

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
async function search(session: string, q: string): Promise<Json[]> {
  const response = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}&type=Incident&limit=100`, headers: { 'x-test-session': session } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().results as Json[]
}

/** Every protected word of the seeded incidents: the people's names, the free words of each report, the filings' references. */
async function protectedWords(): Promise<string[]> {
  const names = await admin<{ word: string }>(
    `SELECT e."displayName" AS word FROM "IncidentPerson" p JOIN "Employee" e ON e.id = p."employeeId" WHERE p."tenantId" = $1
     UNION SELECT e."lastName" FROM "IncidentPerson" p JOIN "Employee" e ON e.id = p."employeeId" WHERE p."tenantId" = $1
     UNION SELECT p."outsideName" FROM "IncidentPerson" p WHERE p."tenantId" = $1 AND p."outsideName" IS NOT NULL
     UNION SELECT w."displayName" FROM "Incident" i JOIN "Worker" w ON w.id = i."reportedByWorkerId" WHERE i."tenantId" = $1
     UNION SELECT f."certificateReference" FROM "InailFiling" f WHERE f."tenantId" = $1 AND f."certificateReference" IS NOT NULL
     UNION SELECT f."protocolNumber" FROM "InailFiling" f WHERE f."tenantId" = $1 AND f."protocolNumber" IS NOT NULL`,
    [T.tenant],
  )
  const reports = await admin<{ what: string; place: string | null; immediate: string | null }>(`SELECT what, place, "immediateAction" AS immediate FROM "Incident" WHERE "tenantId" = $1`, [T.tenant])
  return [...names.map((row) => row.word), ...reports.flatMap((row) => [row.what, row.place, row.immediate])].filter((word): word is string => Boolean(word && word.trim().length > 3)).map((word) => word.toLowerCase())
}

beforeAll(async () => {
  h = await startHarness('w2b149_inc_search')
  const database = h.database
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles, seedNumbering, seedPeople, seedPlant, seedSafety]) await seed({ db: database, namespace: NS })
  health = await seedHealth({ db: database, namespace: NS })
  await seedPlantCare({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('Incident in the search index (anonymised)', () => {
  it('every incident is an entry by its number, with its scope, its status and the incidents view; never a person, an injury or the free words', async () => {
    const system = callerFor(h.database, systemContext(T.tenant, 'w2b149-search'))
    await rebuildIndex(system, [incidentIndexer], { recordTypes: ['Incident'], key: `w2b149-rebuild-${newId()}` })
    const entries = await admin<{ recordId: string; number: string; title: string; subtitle: string | null; status: string; companyId: string; siteId: string; partyId: string | null; viewPermission: string; area: string; searchText: string }>(
      `SELECT "recordId"::text AS "recordId", number, title, subtitle, status, "companyId"::text AS "companyId", "siteId"::text AS "siteId", "partyId", "viewPermission", area, "searchText" FROM "SearchEntry" WHERE "tenantId" = $1 AND "recordType" = 'Incident' ORDER BY number`,
      [T.tenant],
    )
    const rows = await admin<{ id: string; number: string; status: string; companyId: string; siteId: string }>(`SELECT id::text AS id, number, status::text AS status, "companyId"::text AS "companyId", "siteId"::text AS "siteId" FROM "Incident" WHERE "tenantId" = $1 ORDER BY number`, [T.tenant])
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(entries.map((entry) => [entry.recordId, entry.number, entry.status, entry.companyId, entry.siteId])).toEqual(rows.map((row) => [row.id, row.number, row.status, row.companyId, row.siteId]))
    for (const entry of entries) {
      expect(entry).toMatchObject({ title: entry.number, partyId: null, viewPermission: 'safety.incidents.view', area: 'plant' })
    }
    // The injury (SEED-INC-0005) is found by its kind in both languages; the anonymous hazard by its station's code.
    const cut = entries.find((entry) => entry.recordId === health.incidentIds.cut)!
    expect(cut.searchText).toMatch(/injury|incident/)
    expect(cut.searchText).toMatch(/infortunio/)
    const words = await protectedWords()
    expect(words.length).toBeGreaterThan(3)
    for (const entry of entries) {
      const text = `${entry.title} ${entry.subtitle ?? ''} ${entry.searchText}`.toLowerCase()
      for (const word of words) expect(text.includes(word), `${entry.number} holds "${word}"`).toBe(false)
    }
  })

  it('a reader finds an incident only where the incidents list would show it; without the view, nothing', async () => {
    const all = await search('viewer', 'SEED-INC')
    expect(all.map((result) => result.number).sort()).toEqual(expect.arrayContaining(['SEED-INC-0001', 'SEED-INC-0002', 'SEED-INC-0005', 'SEED-INC-0006']))
    expect(new Set(all.map((result) => result.recordType))).toEqual(new Set(['Incident']))
    // Site B1 only: B1's near miss, none of A1's.
    expect((await search('siteB', 'SEED-INC')).map((result) => result.number)).toEqual(['SEED-INC-0001'])
    expect(await search('sales', 'SEED-INC')).toEqual([])
    // "pericolo" (hazard in Italian) finds the hazards.
    expect((await search('viewer', 'pericolo')).map((result) => result.number)).toEqual(expect.arrayContaining(['SEED-INC-0002', 'SEED-INC-0006']))
  })

  it('an incident event re-reads its entry (incident.changed): the status follows the record', async () => {
    const system = callerFor(h.database, systemContext(T.tenant, 'w2b149-index-event'))
    // Make the entry stale on purpose, then hand the indexer the incident's event as the worker does.
    await admin(`UPDATE "SearchEntry" SET status = 'STALE' WHERE "recordType" = 'Incident' AND "recordId" = $1`, [health.incidentIds.closed])
    const event = { eventId: newId(), type: 'incident.changed', version: 1, context: 'test', tenantId: T.tenant, companyId: T.companyA, siteId: T.siteA1, subject: health.incidentIds.closed, correlationId: `w2b149-${newId()}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: {} }
    await indexEvent(system, [incidentIndexer], event as never)
    const entry = (await admin<{ status: string }>(`SELECT status FROM "SearchEntry" WHERE "recordType" = 'Incident' AND "recordId" = $1`, [health.incidentIds.closed]))[0]!
    expect(entry.status).toBe('CLOSED')
  })
})

describe('the incidents export (anonymised)', () => {
  it('reads the list as the screen shows it; every cell is free of people, injuries, filing types and the free words', async () => {
    const caller = callerFor(h.database, { ...SESSIONS.viewer!, requestId: 'w2b149-export' } as never)
    const page = await incidentsExport.read(caller, incidentsExport.query(new URLSearchParams('status=ALL')), null, 200)
    const rows = page.rows as Json[]
    expect(rows.length).toBeGreaterThanOrEqual(6)
    const words = (code: string) => (incidentsExport.words!.en as Record<string, string>)[code] ?? code
    const cells = rows.map((row) => Object.fromEntries(Object.entries(incidentsExport.columns).map(([key, column]) => [key, column.value(row, words)])))
    const cut = cells.find((cell) => cell.number === 'SEED-INC-0005')!
    expect(cut).toMatchObject({ kind: 'Injury', inail: expect.stringMatching(/^(Due|Overdue|Waiting for the certificate|Filed)$/) })
    expect(Object.keys(incidentsExport.columns)).not.toEqual(expect.arrayContaining(['person', 'people', 'injury', 'type']))
    const text = JSON.stringify(cells).toLowerCase()
    for (const word of await protectedWords()) {
      // The place in words is the list's own Where column (a location, as the screen shows it): only names, injuries and filings are checked here.
      if (rows.some((row) => (row.place ?? '').toLowerCase() === word)) continue
      expect(text.includes(word), `the export holds "${word}"`).toBe(false)
    }
    for (const type of ['statistical', 'insurance', 'statistic', 'assicurativ']) expect(text.includes(type), type).toBe(false)
    // Italian and English say the same codes.
    expect(Object.keys(incidentsExport.words!.it).sort()).toEqual(Object.keys(incidentsExport.words!.en).sort())
  })

  it('the address is the list’s own: Rows ▾, status, the window, the number', async () => {
    expect(incidentsExport.query(new URLSearchParams('rows=INAIL_DUE&status=OPEN&from=2026-01-01&to=2026-12-31&q=INC-2026&siteId=nope&extra=1'))).toEqual({ rows: 'INAIL_DUE', status: 'OPEN', from: '2026-01-01', to: '2026-12-31', q: 'INC-2026' })
    expect(incidentsExport.query(new URLSearchParams('rows=PEOPLE&status=MAYBE&from=yesterday'))).toEqual({})
    const caller = callerFor(h.database, { ...SESSIONS.viewer!, requestId: 'w2b149-export-rows' } as never)
    const due = await incidentsExport.read(caller, incidentsExport.query(new URLSearchParams('rows=INAIL_DUE')), null, 200)
    expect((due.rows as Json[]).map((row) => row.number)).toContain('SEED-INC-0005')
    for (const row of due.rows as Json[]) expect(['WAITING_CERTIFICATE', 'DUE', 'OVERDUE'], row.number).toContain(row.inail.state)
  })
})
