import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { atWarehouseOf } from './portal'

/**
 * The customer's label for a shipment through our warehouse (owb- order workflow, S3 ss1 step 1.5; walls of _owb-ss-common.md) with
 * the real portal sign-in: a throwaway PostgreSQL 17 database from the migrations (the partner role's row-level security and column
 * grants are real), the factory-db shipping seed (SEED-SO-0002 of customer P1 and its SEED-SH-0001, which left), ONE made-up warehouse
 * site of company A and the leg of SEED-SH-0001 through it (made-up facts, past the API: the leg's own planning is warehouse-leg.pg),
 * two files on SEED-SH-0001 (the customer's own portal upload, and one the office put there). Every name and address is made up.
 * WRITTEN, NOT RUN (Owner rule: tests at the end). Run with `node scripts/factory/run-pg-tests.mjs portal-label`.
 *
 *   walls   a customer of another party gets the same 404 as for an unknown order; a person without the upload capability 403; the
 *           order must carry the shipment (else 404); the portal names only the customer's own upload (LABEL_FILE)
 *   label   the customer's own file: filed as CUSTOMER_LABEL, the leg's label set with the person, ONE audit row (byCustomer)
 *   reads   the answer and atWarehouseOf carry no person, no hold, no office note; another party's ids are absent
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
let seedA: ShippingSeed
const NS = 'warehouse-leg-portal'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const WAREHOUSE = newId()

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const people = { buyer: 'bea.label@seed-racing.example', viewer: 'vic.label@seed-racing.example', other: 'oli.label@brand-other.example' }
const browsers = {} as Record<keyof typeof people, Browser>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** A file on the shipment (made-up bytes: only the row matters): the customer's portal upload (shared with it, made by the system) or the office's. */
async function fileOn(shipmentId: string, by: 'customer' | 'office'): Promise<string> {
  const fileId = newId()
  const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [T]))[0]!.id
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt", "createdAt", "updatedAt", "createdById")
     VALUES ($1, $2, $3, 'Shipment', $4, 'DOCUMENT', $5, 'application/pdf', 1200, repeat('c', 64), $6, $7, 'AVAILABLE', $8::"FileAudience"[], $9, now(), now(), now(), $10)`,
    [fileId, T, companyA, shipmentId, `${by}-label.pdf`, store, `t/${T}/c/${companyA}/2026/${fileId}`, by === 'customer' ? ['OFFICE', 'PARTNER'] : ['OFFICE'], by === 'customer' ? P1 : null, by === 'customer' ? null : newId()],
  )
  return fileId
}

const so2 = () => seedA.quality.production.salesOrderId
const sh1 = () => seedA.shipmentId
const labelUrl = (orderId: string, shipmentId: string) => `/portal/sales-orders/${orderId}/shipments/${shipmentId}/label`

beforeAll(async () => {
  h = await startHarness('warehouse_leg_portal')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  seedA = await seedShipping({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    // The portal's sign-in mail sender (as tenant set-up makes it): a FAKE SES account and company A's NOTIFICATION identity.
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [T])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), T])
  }
  // Our warehouse, and SEED-SH-0001 (left, of SEED-SO-0002) going through it — made-up facts past the API.
  await admin(
    `INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind, address) VALUES ($1, $2, $3, 'SEED-WH2', 'Seed warehouse South', 'WAREHOUSE', jsonb_build_object('line1', 'Via Deposito 8', 'postalCode', '00000', 'city', 'Seedharbour', 'country', 'IT'))`,
    [WAREHOUSE, T, companyA],
  )
  await admin(
    `INSERT INTO "ShipmentWarehouseLeg" (id, "tenantId", "companyId", "siteId", "partyId", "shipmentId", "warehouseSiteId", "createdById") SELECT $1, s."tenantId", s."companyId", s."siteId", s."partyId", s.id, $2, $3 FROM "Shipment" s WHERE s.id = $4`,
    [newId(), WAREHOUSE, newId(), sh1()],
  )
  // Company A's portal terms and another customer (no orders of P1's) with its portal on.
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer', 'partner-upload'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('1.5 the customer’s label from the portal: the walls', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a customer of another party gets the same 404 as for an unknown order; nothing is written', async () => {
    const file = await fileOn(sh1(), 'customer')
    const unknown = await browsers.other.post(labelUrl(newId(), sh1()), { fileId: file })
    const walled = await browsers.other.post(labelUrl(so2(), sh1()), { fileId: file })
    expect([unknown.status, walled.status]).toEqual([404, 404])
    expect(walled.body.error.message).toBe(unknown.body.error.message)
    expect((await one<{ customerLabelFileId: string | null }>(`SELECT "customerLabelFileId" FROM "ShipmentWarehouseLeg" WHERE "shipmentId" = $1`, [sh1()])).customerLabelFileId).toBeNull()
  })

  it('a person without the upload capability is refused (403); an order that does not carry the shipment answers 404', async () => {
    const file = await fileOn(sh1(), 'customer')
    expect((await browsers.viewer.post(labelUrl(so2(), sh1()), { fileId: file })).status).toBe(403)
    const otherOrder = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND id <> $3 ORDER BY number LIMIT 1`, [T, P1, so2()])).id
    const notCarried = await browsers.buyer.post(labelUrl(otherOrder, sh1()), { fileId: file })
    expect(notCarried.status).toBe(404)
    expect(notCarried.body.error.message).toBe('Shipment not found.')
  })

  it('the portal names only the customer’s own upload: a file the office put on the shipment is LABEL_FILE (409)', async () => {
    const officeFile = await fileOn(sh1(), 'office')
    const refused = await browsers.buyer.post(labelUrl(so2(), sh1()), { fileId: officeFile })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('refusal/LABEL_FILE')
  })
})

describe('1.5 the customer’s label from the portal: sent', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('its own upload: filed as CUSTOMER_LABEL, the leg names it and the person; ONE audit row; the answer has no person and no hold', async () => {
    const file = await fileOn(sh1(), 'customer')
    const sent = await browsers.buyer.post(labelUrl(so2(), sh1()), { fileId: file })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(Object.keys(sent.body).sort()).toEqual(['labelSentAt', 'shipmentId'])
    expect(sent.body.shipmentId).toBe(sh1())
    expect(JSON.stringify(sent.body)).not.toMatch(/arrivedById|forwardedById|hold|internalNote|createdById/)
    const buyerId = (await one<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [people.buyer])).id
    expect(await one(`SELECT "customerLabelFileId", "customerLabelById" FROM "ShipmentWarehouseLeg" WHERE "shipmentId" = $1`, [sh1()])).toEqual({ customerLabelFileId: file, customerLabelById: buyerId })
    expect(await one(`SELECT category::text AS category FROM "StoredFile" WHERE id = $1`, [file])).toEqual({ category: 'CUSTOMER_LABEL' })
    const audits = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND action = 'shipping.warehouseLeg.label'`, [sh1()])
    expect(audits.map((row) => row.after)).toEqual([expect.objectContaining({ customerLabelFileId: file, byCustomer: true, door: 'portal' })])
    expect((await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.label_received' AND subject = $1`, [sh1()])).map((row) => row.payload.byCustomer)).toEqual([true])
  })

  it('atWarehouseOf: the party’s legs only, no person field; another party’s ids are absent', async () => {
    const read = await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) => atWarehouseOf(client, { partyId: P1, shipmentIds: [sh1(), seedA.draftShipmentId] }))
    expect([...read.keys()]).toEqual([sh1()])
    expect(read.get(sh1())).toEqual({ place: 'Seed warehouse South', city: 'Seedharbour', since: null, sentOn: false, labelSent: true })
    expect(Object.keys(read.get(sh1())!).sort()).toEqual(['city', 'labelSent', 'place', 'sentOn', 'since'])
    const walled = await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) => atWarehouseOf(client, { partyId: world.partyId, shipmentIds: [sh1()] }))
    expect(walled.size).toBe(0)
  })
})
