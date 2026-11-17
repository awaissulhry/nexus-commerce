import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { callerFor } from '../../../core/command'
import { BRAND_ALPHA, findMarkers, type Marker } from '../../../golden-flow/portal/testing/two-brands'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { partnerWorld, signIn, type PartnerWorld } from '../../../platform/search/partner/testing/world'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { previewOrderPdf } from '../send'

/**
 * B-TH-036 (threads plan TH-2, WALL-G18, wall test T36; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand"): supplier and workshop answers never hold a brand's name. A purchase order shipped straight to a
 * brand prints the brand's address under OUR company's name — in the supplier's portal, its price-free copy and the PDF we mail
 * (the address stays: it is where the goods go); a workshop's job names a private-label style by our code and its kind of
 * garment, never by a name that may carry the brand's. The office keeps reading everything.
 *
 * The base seeds of every module (partnerWorld: P1 the customer — here Brand Alpha —, P2 the supplier and workshop with its
 * order desk and jobs people). One of P2's sent orders is made to ship to Brand Alpha, and SEED-JKT-02 (P1's private-label
 * style, on the jobs' work order) gets a name that carries the brand's (both written past their triggers: test data only).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/portal-jobs`.
 */

let h: Harness
let world: PartnerWorld
let orders: Browser
let workshop: Browser
let orderId = ''
let companyName = ''
const NS = 'th036-names'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
/** Brand Alpha's names (never its address line: a ship-to's street is where the goods go). */
const NAMES: Marker[] = [
  { label: 'legal name', text: BRAND_ALPHA.legalName },
  { label: 'trade name', text: BRAND_ALPHA.tradeName },
  { label: 'code', text: BRAND_ALPHA.code },
]
const get = async (browser: Browser, url: string): Promise<Json> => {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('portal_no_brands')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [world.p1, BRAND_ALPHA.legalName, BRAND_ALPHA.tradeName, BRAND_ALPHA.code])
  companyName = (await admin<{ legalName: string }>('SELECT "legalName" FROM "Company" WHERE id = $1', [world.companyA]))[0]!.legalName
  // One of the supplier's sent orders ships straight to Brand Alpha (an address of its own, labelled with its name).
  orderId = (await admin<{ id: string }>(`SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 AND status::text <> 'DRAFT' AND "sentAt" IS NOT NULL ORDER BY number LIMIT 1`, [world.tenantId, world.p2, world.companyA]))[0]!.id
  const address = (await admin<{ id: string }>('SELECT id FROM "PartyAddress" WHERE "partyId" = $1 ORDER BY "createdAt", id LIMIT 1', [world.p1]))[0]!.id
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    UPDATE "PartyAddress" SET name = 'Brand Alpha warehouse' WHERE id = '${address}';
    UPDATE "PurchaseOrder" SET "shipToPartyId" = '${world.p1}', "shipToAddressId" = '${address}', "shipToLocationId" = NULL WHERE id = '${orderId}';
    UPDATE "Style" SET name = 'Brand Alpha Pista GT jacket' WHERE "tenantId" = '${world.tenantId}' AND code = 'SEED-JKT-02';
  END $$`)
  orders = await signIn(h, world, world.people.orders)
  workshop = await signIn(h, world, world.people.workshop)
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('T36: supplier and workshop answers never hold a brand name (B-TH-036, WALL-G18)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("the supplier's portal says where the goods go under our name, never the brand's", async () => {
    const list = await get(orders, '/portal/purchase-orders')
    expect(findMarkers(list, NAMES)).toEqual([])
    const order = await get(orders, `/portal/purchase-orders/${orderId}`)
    expect(order.deliverTo).toMatchObject({ name: companyName })
    expect(order.deliverTo.line1).toBeTruthy()
    expect(findMarkers(order, NAMES)).toEqual([])
    expect(JSON.stringify(order)).not.toContain('Brand Alpha warehouse')
    const copy = await orders.get(`/portal/purchase-orders/${orderId}/copy`)
    expect(copy.status).toBe(200)
    const printed = pdfFlatText(copy.response.rawPayload)
    expect(printed).toContain(companyName)
    expect(findMarkers(printed, NAMES)).toEqual([])
  })

  it('the PDF we mail the supplier prints our name over the address too', async () => {
    const grants = [{ permissions: ['purchasing.view', 'money.cost'] as Permission[], companies: 'all' as const, sites: 'all' as const, parties: 'all' as const }]
    const { pdf } = await previewOrderPdf(callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, requestId: newId(), grants }), orderId, 'en')
    const text = pdfFlatText(pdf)
    expect(text).toContain(companyName)
    expect(findMarkers(text, NAMES)).toEqual([])
    expect(text).not.toContain('Brand Alpha warehouse')
  })

  it("a workshop's jobs name a private-label style by our code and its kind of garment", async () => {
    const jobs = await get(workshop, '/portal/jobs')
    expect(findMarkers(jobs, NAMES)).toEqual([])
    const ids = (await admin<{ id: string }>(`SELECT s.id FROM "SubcontractOrder" s JOIN "WorkOrder" w ON w.id = s."workOrderId" JOIN "Style" st ON st.id = w."styleId" WHERE s."tenantId" = $1 AND s."partyId" = $2 AND s."issuedAt" IS NOT NULL AND st.code = 'SEED-JKT-02'`, [world.tenantId, world.p2])).map((row) => row.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const job = await get(workshop, `/portal/jobs/${id}`)
      expect(job.job.workOrder.style).toEqual({ code: 'SEED-JKT-02', name: 'Jacket' })
      expect(findMarkers(job, NAMES)).toEqual([])
    }
    // The office still reads the style's own name.
    expect((await admin<{ name: string }>(`SELECT name FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [world.tenantId]))[0]!.name).toContain(BRAND_ALPHA.tradeName)
  })
})
