import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSamples } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers } from '../../../golden-flow/portal/testing/two-brands'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-TH-034 (threads plan TH-2, WALL-G15, wall test T12; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand"): a sample round never uses another brand's private-label style. A round for brand B on brand
 * A's private-label style (Style.brandPartyId) is refused in words (409 `refusal/PRIVATE_STYLE`), as quotes and orders already
 * refuse its lines; a round for brand A itself, and an internal round (no customer), go on as before. Nothing is written.
 *
 * The seeds up to the samples: SEED-JKT-02 is P1's private-label style (here Brand Alpha); P3 is Brand Beta. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/samples`.
 */

type Json = Record<string, any>
const NS = 'th034-samples'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const alpha = idOf('party:P1')
const beta = idOf('party:P3')
const manager = newId()
const MANAGER: Permission[] = ['sales.samples.view', 'sales.samples.manage', 'workorders.view']
const SESSIONS: Record<string, SessionContext> = {
  manager: { audience: 'office', tenantId: T, actorId: manager, grants: [{ permissions: MANAGER, companies: 'all', sites: 'all', parties: 'all' }] },
}

let h: Harness
let app: FastifyInstance
let serial = 0
let jacket = ''
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { 'x-test-session': 'manager', 'idempotency-key': `th034-${++serial}-${newId()}` }, payload: payload as object })
const rounds = async () => Number((await admin<{ n: string }>('SELECT count(*) AS n FROM "SampleRound" WHERE "styleId" = $1', [jacket]))[0]!.n)

beforeAll(async () => {
  h = await startHarness('samples_private')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedSamples({ db: h.database, namespace: NS })
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up manager', 'ACTIVE')`, [manager, T, `th034-manager-${manager.slice(-8)}@example.test`])
  for (const [party, brand] of [[alpha, BRAND_ALPHA], [beta, BRAND_BETA]] as const) {
    await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [party, brand.legalName, brand.tradeName, brand.code])
  }
  const style = (await admin<{ id: string; brandPartyId: string | null }>('SELECT id, "brandPartyId" FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02']))[0]!
  expect(style.brandPartyId).toBe(alpha)
  jacket = style.id
  expect((await admin<{ roles: string[] }>('SELECT roles::text[] AS roles FROM "Party" WHERE id = $1', [beta]))[0]!.roles).toContain('CUSTOMER')
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe("T12: a round for brand B on brand A's private style is refused (B-TH-034, WALL-G15)", () => {
  it('refuses the round in words and writes nothing', async () => {
    const before = await rounds()
    const response = await post('/sales/samples/rounds', { styleId: jacket, companyId: companyA, kind: 'FIT', partyId: beta, cells: [{ size: '52', quantity: 1 }] })
    expect(response.statusCode, response.body).toBe(409)
    const error = response.json().error
    expect(error.issues[0]).toMatchObject({ path: 'refusal/PRIVATE_STYLE', message: "SEED-JKT-02 is Brand Alpha's private-label style: its samples are made for that customer only." })
    expect(await rounds()).toBe(before)
    // The office reads the real reason; nothing of the refused round reaches brand B (no round, no thread, no notice).
    expect(findMarkers(await admin('SELECT * FROM "SampleRound" WHERE "partyId" = $1', [beta]), fixtureMarkers(BRAND_ALPHA))).toEqual([])
  })

  it("brand A's own round and an internal round go on as before", async () => {
    const own = await post('/sales/samples/rounds', { styleId: jacket, companyId: companyA, kind: 'FIT', partyId: alpha, cells: [{ size: '52', quantity: 1 }] })
    expect(own.statusCode, own.body).toBe(201)
    expect(own.json().round).toMatchObject({ party: { id: alpha } })
    const internal = await post('/sales/samples/rounds', { styleId: jacket, companyId: companyA, kind: 'FIT', cells: [{ size: '52', quantity: 1 }] })
    expect(internal.statusCode, internal.body).toBe(201)
  })
})
