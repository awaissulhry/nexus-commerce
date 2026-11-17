import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { BRAND_ALPHA, BRAND_BETA, findMarkers, fixtureMarkers } from '../../../golden-flow/portal/testing/two-brands'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../../shipping/documents/testing/compliance'

/**
 * B-TH-035 (threads plan TH-2, WALL-G16, wall test T13; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand"): conformity per style leaves out a certificate held by another brand. The portal's "Conformity
 * per style you received" names the EU type-examination certificate of each shipment; a certificate held by brand B
 * (Certificate.holderPartyId) is never shown to brand A — neither as the one its declaration cites nor as one covering the
 * style. One the company holds, or brand A's own, still shows.
 *
 * Tenant A from the factory-db seeds up to money (SH-0001 of SEED-JKT-02 SHIPPED to P1, here Brand Alpha; SEED-CERT-0003
 * covers the style); the office files the style's declaration and leaflet on the shipment as its screens do. Brand Beta (P3)
 * becomes the holder of SEED-CERT-0003 (written past the certificate triggers: the data shape of a brand's own certificate).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-documents`.
 */

let h: Harness
let app: FastifyInstance
let shipping: ShippingSeed
let quality: Browser
const NS = 'th035-cert-holder'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const alpha = seedUuid(NS, 'party:P1')
const beta = seedUuid(NS, 'party:P3')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const PERSON = 'quinta.quality@brand-alpha.example'
const CERTIFICATE = 'SEED-CERT-0003'

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const OFFICE: Permission[] = [...TRAVEL_DOCUMENT_PERMISSIONS, 'shipping.view', 'shipping.manage', 'files.manage']
let officeActor = ''
const SESSIONS: Record<string, () => SessionContext> = { quality: () => ({ audience: 'office', tenantId: T, actorId: officeActor, grants: [{ permissions: OFFICE, companies: 'all', sites: 'all', parties: 'all' }] }) }

/** The certificate's holder, written past its triggers (a brand holds it: no company). */
async function holdCertificate(partyId: string | null): Promise<void> {
  const holder = partyId === null ? 'NULL' : `'${partyId}'::uuid`
  const company = partyId === null ? `'${companyA}'::uuid` : 'NULL'
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    UPDATE "Certificate" SET "holderPartyId" = ${holder}, "companyId" = ${company} WHERE "tenantId" = '${T}' AND number = '${CERTIFICATE}';
  END $$`)
}

async function conformityRow(): Promise<Json> {
  const answer = await quality.get('/portal/customer-documents/conformity')
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return ((answer.body.styles as Json[]).find((entry) => entry.style.code === 'SEED-JKT-02') ?? {}).received?.[0] ?? {}
}

beforeAll(async () => {
  h = await startHarness('portal_cert_holder')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  shipping = await seedShipping({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T])
  for (const [party, brand] of [[alpha, BRAND_ALPHA], [beta, BRAND_BETA]] as const) {
    await admin('UPDATE "Party" SET "legalName" = $2, "tradeName" = $3, code = $4 WHERE id = $1', [party, brand.legalName, brand.tradeName, brand.code])
  }
  officeActor = (await addUser(h, TENANT, { email: 'quality.th035@example.com' })).id
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: alpha, partyId: alpha, portalOn: true }, select: { id: true } })
    // Brand Alpha's quality person.
    const id = newId()
    await client.user.create({ data: { id, email: PERSON, displayName: 'Quinta Quality', locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: alpha, partnerKind: 'CUSTOMER' }, select: { id: true } })
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'customer-quality' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [alpha], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  // The portal's terms published, as an administrator does before the first sign-in.
  await portalWorld(h, TENANT)
  freshGuard(h)
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  // The style's declaration and leaflet on file and copied onto the shipment, as the office's screens do.
  const production = shipping.quality.production
  await fileTravelDocuments(app, 'quality', production.styleId, production.revisionId)
  const attached = await app.inject({ method: 'POST', url: `/shipping/shipments/${shipping.shipmentId}/documents/attach`, headers: { 'x-test-session': 'quality', 'idempotency-key': `th035-${++counter}-${newId()}` }, payload: {} })
  expect(attached.statusCode, attached.body).toBe(200)
  // Brand Alpha's quality person signs in by code.
  quality = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await quality.post('/portal/signin/start', { tenant: NS, company: 'SCA', email: PERSON })).status).toBe(200)
  await h.auth.settled()
  const signed = await quality.post('/portal/signin/code', { tenant: NS, company: 'SCA', email: PERSON, code: mailedCode(h, PERSON)!.code })
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
  const terms = await quality.get('/portal/terms?locale=en')
  expect((await quality.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
}, 1_500_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
}, 60_000)

describe('T13: a certificate held by brand B does not show in brand A’s conformity (B-TH-035, WALL-G16)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("the company's certificate shows (as before)", async () => {
    expect((await conformityRow()).certificate).toMatchObject({ number: CERTIFICATE })
  })

  it('held by brand B, it is left out — neither cited nor covering — and nothing of brand B is in the answer', async () => {
    await holdCertificate(beta)
    const row = await conformityRow()
    expect(row.certificate).toBeNull()
    expect(findMarkers(row, [...fixtureMarkers(BRAND_BETA), { label: 'certificate', text: CERTIFICATE }])).toEqual([])
    const whole = await quality.get('/portal/customer-documents/conformity')
    expect(findMarkers(whole.body, [...fixtureMarkers(BRAND_BETA), { label: 'certificate', text: CERTIFICATE }])).toEqual([])
  })

  it("held by brand A itself, it shows to brand A", async () => {
    await holdCertificate(alpha)
    expect((await conformityRow()).certificate).toMatchObject({ number: CERTIFICATE })
    await holdCertificate(null)
  })
})
