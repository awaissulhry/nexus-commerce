import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid, type SeedContext } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers, type Marker } from '../../golden-flow/portal/testing/two-brands'
import { systemContext } from '../outbox/system'
import { rebuildIndex } from './indexing'
import { loadIndexers } from './registry'

/**
 * B-TH-030 (threads plan TH-2, WALL-G12, wall test T28; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand"): office search entries carry their record's brand. A private-label style's entry — and the
 * entries that name it (its changes, labels, NCRs, inspections, internal sample rounds) — take the style's brand
 * (Style.brandPartyId), so an office person limited to brand B finds no brand A style and no brand A name; a person limited to
 * brand A, and everyone without a brand limit (the factory sees it all), still find them. The work order's own entry is the
 * production lane's (B-PR-08a): this test reads without workorders.view.
 *
 * The seed's P1 owns the private-label style SEED-JKT-01: here it is Brand Alpha (brand A); P3, the empty second customer, is
 * Brand Beta (brand B), with the two-brand harness's names. Run with `node scripts/factory/run-pg-tests.mjs platform/search`.
 */

const NAMESPACE = 'search'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed/', import.meta.url))
const id = (key: string): string => seedUuid(NAMESPACE, key)
const tenantId = id('tenant')
const companyA = id('company:A')
const alpha = id('party:P1')
const beta = id('party:P3')
const STYLE_CODE = 'SEED-JKT-01'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const grant = (permissions: readonly Permission[], scope: Partial<Pick<Grant, 'companies' | 'sites' | 'parties'>> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), companyId: companyA, grants })
// Every office view an entry may need, but the work order's (the production lane's entry, B-PR-08a).
const VIEWS: Permission[] = [
  'product.styles.view',
  'product.changes.view',
  'compliance.certificates.view',
  'quality.ncr.view',
  'quality.inspections.view',
  'sales.samples.view',
  'parties.view',
  'orders.view',
  'quotes.view',
  'product.materials.view',
  'quality.holds.view',
]
const SESSIONS: Record<string, SessionContext> = {
  everyBrand: office([grant([...VIEWS, 'workorders.view'])]),
  alphaOnly: office([grant(VIEWS, { parties: [alpha] })]),
  betaOnly: office([grant(VIEWS, { parties: [beta] })]),
}
const STYLE_BOUND = ['Style', 'ChangeOrder', 'ChangeRequest', 'LabelTemplate', 'Nonconformance', 'Inspection', 'SampleRound']

async function search(session: string, q: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}&limit=50`, headers: { 'x-test-session': session } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const alphaMarkers = (): Marker[] => [...fixtureMarkers(BRAND_ALPHA), { label: 'private style', text: STYLE_CODE }]

beforeAll(async () => {
  db = await migratedDatabase('search_brands')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  const context: SeedContext = { db: database, namespace: NAMESPACE }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  // The two brands of the harness, by name (reads of the seed's ids stay as they are).
  for (const [party, brand] of [[alpha, BRAND_ALPHA], [beta, BRAND_BETA]] as const) {
    await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [party, brand.legalName, brand.tradeName, brand.code])
  }
  await admin('DELETE FROM "SearchEntry"')
  const indexers = await loadIndexers(fileURLToPath(new URL('../..', import.meta.url)))
  await rebuildIndex(callerFor(database, systemContext(tenantId, 'search-brands-pg-test')), indexers, { recordTypes: null, key: `search-rebuild-${newId()}` })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('T28: office search entries carry their record brand (B-TH-030, WALL-G12)', () => {
  it("a private-label style's entry, and every entry that names it, is its brand's", async () => {
    const style = (await admin<{ id: string; brandPartyId: string }>('SELECT id, "brandPartyId" FROM "Style" WHERE code = $1 AND "tenantId" = $2', [STYLE_CODE, tenantId]))[0]!
    expect(style.brandPartyId).toBe(alpha)
    expect((await admin('SELECT "partyId" FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2', ['Style', style.id]))[0]).toEqual({ partyId: alpha })
    const naming = await admin<{ recordType: string; partyId: string | null }>(
      'SELECT "recordType", "partyId" FROM "SearchEntry" WHERE "tenantId" = $1 AND "recordType" = ANY($2::text[]) AND "searchText" LIKE $3',
      [tenantId, STYLE_BOUND, `%${STYLE_CODE.toLowerCase()}%`],
    )
    expect(naming.length).toBeGreaterThan(1)
    for (const row of naming) expect(row, row.recordType).toEqual({ recordType: row.recordType, partyId: alpha })
    // Our own range stays open to every grant: a style without a brand names no party.
    const open = await admin<{ partyId: string | null }>('SELECT e."partyId" FROM "SearchEntry" e JOIN "Style" s ON s.id = e."recordId" WHERE e."recordType" = $1 AND s."brandPartyId" IS NULL AND s."tenantId" = $2', ['Style', tenantId])
    for (const row of open) expect(row.partyId).toBeNull()
  })

  it('a person limited to brand B finds no brand A style and no brand A name', async () => {
    const style = (await admin<{ id: string }>('SELECT id FROM "Style" WHERE code = $1 AND "tenantId" = $2', [STYLE_CODE, tenantId]))[0]!.id
    for (const q of [STYLE_CODE, BRAND_ALPHA.tradeName, BRAND_ALPHA.code, 'Seed leather jacket']) {
      const answer = await search('betaOnly', q)
      // Other records a typo-tolerant search finds (our own range's styles) may come; none is brand A's style or names it.
      expect(answer.results.map((row: Json) => row.recordId), q).not.toContain(style)
      expect(answer.results.filter((row: Json) => findMarkers(row, alphaMarkers()).length > 0).map((row: Json) => `${row.recordType} ${row.number}`), q).toEqual([])
    }
  })

  it('a person limited to brand A finds its own style, by code and by its brand name; the factory finds it too', async () => {
    for (const session of ['alphaOnly', 'everyBrand']) {
      const byCode = await search(session, STYLE_CODE)
      expect(byCode.results.map((row: Json) => `${row.recordType} ${row.number}`), session).toContain(`Style ${STYLE_CODE}`)
      const byBrand = await search(session, BRAND_ALPHA.tradeName)
      expect(byBrand.results.map((row: Json) => `${row.recordType} ${row.number}`), session).toContain(`Style ${STYLE_CODE}`)
    }
  })
})
