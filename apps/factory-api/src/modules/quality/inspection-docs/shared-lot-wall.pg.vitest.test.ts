import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers } from '../../../golden-flow/portal/testing/two-brands'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-TH-032 (threads plan TH-2, WALL-G07, wall test T16; Owner decision 16 and the rule of 2026-11-16: "One brand must not be
 * able to see anything related to any other brand"): an inspection report goes to a customer only when the work order is that
 * customer's alone. An inspection judges a whole work order (its lot size, its sample, its results); when the work order also
 * makes garments for another customer, its report is not shared on a shipment as it is (409 `held/SHARED_PRODUCTION`, the
 * shipment not shareable in the reports read) and the customer gets its own shipment's certificate of conformity instead.
 *
 * Tenant A from the factory-db seeds up to shipping (WO-0001's PASSED inspection; SH-0001 SHIPPED, both of P1 — here Brand
 * Alpha). Brand Beta (P3) gets one cell of WO-0001 (a made-up cell of a size of its own, written past the cell triggers: the
 * data shape of a shared lot, which the office makes through orders). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/inspection-docs`.
 */

let h: Harness
let app: FastifyInstance
let shipping: ShippingSeed

const NS = 'th032-shared-lot'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const alpha = idIn('party:P1')
const beta = idIn('party:P3')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = () => `th032-${++counter}-${newId()}`
const QUALITY: Permission[] = ['quality.inspections.view', 'shipping.view', 'files.read', 'quality.documents.make', 'quality.documents.share']
let qualityActor = ''
const SESSIONS: Record<string, () => SessionContext> = {
  quality: () => ({ audience: 'office', tenantId: T, actorId: qualityActor, grants: [{ permissions: QUALITY, companies: 'all', sites: 'all', parties: 'all' } satisfies Grant] }),
}

async function call(method: Method, url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': 'quality', ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: String(response.headers['content-type'] ?? '').startsWith('application/json') ? (response.json() as Json) : ({} as Json) }
}
async function ok(method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const reportCopies = (shipmentId: string) => admin(`SELECT id FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND "originalName" LIKE '%inspection report%'`, [shipmentId])

beforeAll(async () => {
  h = await startHarness('quality_shared_lot')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  shipping = await seedShipping({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T])
  for (const [party, brand] of [[alpha, BRAND_ALPHA], [beta, BRAND_BETA]] as const) {
    await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [party, brand.legalName, brand.tradeName, brand.code])
  }
  qualityActor = (await addUser(h, TENANT, { email: 'quality.th032@example.com' })).id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const inspection = () => shipping.quality.passedInspectionId

describe('T16: an inspection of a work order with cells of A and B is not shared with A as is (B-TH-032, WALL-G07)', () => {
  it('a work order of brand A alone: its report goes on brand A’s shipment (as before)', async () => {
    await ok('POST', `/quality/inspections/${inspection()}/reports`, { language: 'en' }, 201)
    const read = await ok('GET', `/quality/inspections/${inspection()}/reports`, undefined, 200)
    expect(read.shipments.find((row: Json) => row.id === shipping.shipmentId)).toMatchObject({ shareable: true, problem: null })
  })

  it('once the work order also makes garments for brand B, the report is held and the shipment says why', async () => {
    const workOrderId = (await admin<{ workOrderId: string }>('SELECT "workOrderId" FROM "Inspection" WHERE id = $1', [inspection()]))[0]!.workOrderId
    const cell = (await admin<{ id: string }>('SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1', [workOrderId]))[0]!.id
    const made = newId()
    // A cell of brand B on the same work order (no order line: past the cell triggers, test data only).
    await admin(`DO $$ BEGIN
      SET LOCAL session_replication_role = replica;
      INSERT INTO "WorkOrderSize" SELECT (jsonb_populate_record(NULL::"WorkOrderSize", to_jsonb(w) || jsonb_build_object('id', '${made}', 'partyId', '${beta}', 'salesOrderLineId', NULL, 'measurementProfileId', NULL, 'size', '99'))).* FROM "WorkOrderSize" w WHERE w.id = '${cell}';
    END $$`)
    expect((await admin('SELECT DISTINCT "partyId" FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND "partyId" IS NOT NULL ORDER BY 1', [workOrderId])).length).toBe(2)

    const read = await ok('GET', `/quality/inspections/${inspection()}/reports`, undefined, 200)
    const row = read.shipments.find((entry: Json) => entry.id === shipping.shipmentId)
    expect(row).toMatchObject({ shareable: false, problem: expect.stringMatching(/also makes garments for another customer.*certificate of conformity/) })
    expect(findMarkers(row, fixtureMarkers(BRAND_BETA))).toEqual([])

    const refused = await call('POST', `/quality/inspections/${inspection()}/reports/share`, { shipmentId: shipping.shipmentId })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('held/SHARED_PRODUCTION')
    expect(findMarkers(refused.body, fixtureMarkers(BRAND_BETA))).toEqual([])
    expect(await reportCopies(shipping.shipmentId)).toEqual([])
  })

  it("brand A still gets its own shipment's certificate of conformity", async () => {
    await ok('POST', `/quality/shipments/${shipping.shipmentId}/certificates`, {}, 201)
    const shared = await ok('POST', `/quality/shipments/${shipping.shipmentId}/certificates/share`, {}, 201)
    expect(shared.shared).toMatchObject({ shipmentId: shipping.shipmentId, copied: true })
    const party = (await admin<{ partyId: string }>('SELECT "partyId" FROM "StoredFile" WHERE id = $1', [shared.shared.fileId]))[0]!.partyId
    expect(party).toBe(alpha)
  })
})
