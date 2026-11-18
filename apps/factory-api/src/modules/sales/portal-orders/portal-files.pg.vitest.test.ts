import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../../production/testing/two-brands'

/**
 * B-SA-037 — the customer's face of an order's files (`GET /portal/sales-orders/:orderId/files`): Sales page plan N9, P14, R6, R7;
 * 13-backend B11 "Portal face". The Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But
 * we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On the local stack, through the real app and the real portal sign-in by code: the seeds up to shipping (Brand Alpha = the seeds'
 * customer P1, its SEED-SO-0002 with SH-0001), the production two-brand harness (Brand Beta = the threads' second brand with
 * SEED-SO-B001), both portals on, Alpha's buyer and Beta's buyer signed in. On Alpha's new order: a sheet shared with Alpha, an office
 * note never shared, a line artwork shared with Alpha, and an old copy of Beta's sheet shared with Alpha (made before the write rule:
 * the admin pool, its rules off) whose content is Beta's; on Beta's order its own shared sheet; on SH-0001 a document shared with
 * Alpha (a library entry of SEED-SO-0002 only). Every answer Beta's buyer got is scanned for Alpha's names, numbers and ids. Every
 * name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-orders/portal-files`.
 */

let h: Harness
let officeApp: FastifyInstance
let w: ProductionTwoBrands
let tenant: TestTenant
const NS = 'sa037-portal-files'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const companyA = seedUuid(NS, 'company:A')
const so2 = seedUuid(NS, 'production:sales-order:SO-0002')
const sh1 = seedUuid(NS, 'shipping:shipment:SH-0001')
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const SESSIONS = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const lit = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}

const people = { alpha: 'anna.buyer@sa037-alpha.example.com', beta: 'bruno.buyer@sa037-beta.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>
const seenByB: { url: string; body: unknown }[] = []
let aMarkers: Marker[] = []
const files = { shared: '', office: '', artwork: '', copyOfBeta: '', beta: '', shipment: '' }

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
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

/** A refusal's words without its own request id: "the same words". */
const refusalOf = (body: Json): Json => {
  const { requestId: _requestId, ...error } = (body.error ?? {}) as Json
  return error
}

async function get(who: keyof typeof people, url: string, status = 200): Promise<Json> {
  const answer = await browsers[who].get(url)
  if (who === 'beta') seenByB.push({ url, body: answer.body })
  expect(answer.status, `${who} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(status)
  return answer.body as Json
}
const filesOf = (orderId: string) => `/portal/sales-orders/${orderId}/files`
const everyFile = (answer: Json): Json[] => (answer.groups as Json[]).flatMap((group) => group.files as Json[])
const groupOf = (answer: Json, key: string): Json => (answer.groups as Json[]).find((group) => group.key === key) ?? {}

let minute = 0
async function fileOn(recordType: string, recordId: string, originalName: string, extra: { readonly category?: 'ARTWORK'; readonly sharedWith?: string } = {}): Promise<string> {
  const id = newId()
  const at = new Date(Date.now() - 60 * 60_000 + ++minute * 60_000)
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) =>
    client.storedFile.create({
      data: seedFile(T, {
        id,
        companyId: companyA,
        recordType,
        recordId,
        kind: 'DOCUMENT',
        ...(extra.category ? { category: extra.category } : {}),
        originalName,
        contentType: 'application/pdf',
        sizeBytes: 2048,
        storeAccountId: seedUuid(NS, 'files:account:r2'),
        storageKey: `t/${T}/c/${companyA}/2026/${newId()}`,
        status: 'AVAILABLE',
        availableAt: at,
        visibility: extra.sharedWith ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
        ...(extra.sharedWith ? { partyId: extra.sharedWith } : {}),
        createdAt: at,
        updatedAt: at,
      }),
      select: { id: true },
    }),
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('sa037_portal_files')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
  })
  officeApp = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof SESSIONS] ?? null) },
  )
  w = await productionTwoBrands({ db: h.db, database: h.database, app: officeApp, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })

  files.shared = await fileOn('SalesOrder', w.a.salesOrderId, 'T-SA037-A order sheet.pdf', { sharedWith: ids.a })
  files.office = await fileOn('SalesOrder', w.a.salesOrderId, 'T-SA037-A office notes.pdf')
  files.artwork = await fileOn('SalesOrderLine', w.a.salesOrderLineId, 'T-SA037-A logo artwork.pdf', { category: 'ARTWORK', sharedWith: ids.a })
  files.beta = await fileOn('SalesOrder', w.b.salesOrderId, 'T-SA037-B order sheet.pdf', { sharedWith: ids.b })
  files.shipment = await fileOn('Shipment', sh1, 'T-SA037-A packing photo.pdf', { sharedWith: ids.a })
  // An old copy of Beta's sheet on Alpha's order, shared with Alpha (before the write rule): its content is Beta's.
  files.copyOfBeta = newId()
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', ${lit(files.copyOfBeta)}, 'recordType', 'SalesOrder', 'recordId', ${lit(w.a.salesOrderId)}, 'sourceFileId', f.id, 'partyId', ${lit(ids.a)}, 'originalName', 'T-SA037-copy of a sheet.pdf', 'storageKey', 't/${T}/c/${companyA}/2026/${newId()}'))).* FROM "StoredFile" f WHERE f.id = ${lit(files.beta)};
     COMMIT;`,
  )

  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.alpha, ids.a, ['customer-buyer'])
  await partnerPerson(people.beta, ids.b, ['customer-buyer'])
  for (const person of Object.keys(people) as (keyof typeof people)[]) browsers[person] = await signedIn(people[person])

  aMarkers = [
    ...(await markersOf(h.db, ids.a)),
    ...Object.entries(files).filter(([key]) => key !== 'beta').map(([, text]) => ({ label: 'A file id', text })),
    ...['T-SA037-A order sheet.pdf', 'T-SA037-A office notes.pdf', 'T-SA037-A logo artwork.pdf', 'T-SA037-A packing photo.pdf'].map((text) => ({ label: 'A file', text })),
    { label: 'A order', text: w.a.salesOrderId },
  ]
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await officeApp?.close()
  await h?.close()
})

describe('B-SA-037 GET /portal/sales-orders/:orderId/files — the customer’s face of the order’s files', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists only what is shared with the customer, in the office’s groups a customer may hold; never "also on", never "n hidden", never the office’s number', async () => {
    const answer = await get('alpha', filesOf(w.a.salesOrderId))
    expect((answer.groups as Json[]).map((group) => group.key)).toEqual(['ORDER', 'LINES', 'REQUESTS', 'SHIPMENTS', 'RETURNS'])
    expect(groupOf(answer, 'ORDER').words).toEqual({ it: 'Ordine e conversazione', en: 'Order & thread' })
    expect((groupOf(answer, 'ORDER').files as Json[]).map((file) => file.id)).toEqual([files.shared])
    expect((groupOf(answer, 'LINES').files as Json[]).map((file) => [file.id, file.line?.seq])).toEqual([[files.artwork, 900]])
    // The office's own note is never shared; the copy whose content is Beta's is left out, uncounted (the content wall).
    expect(everyFile(answer).map((file) => file.id)).not.toContain(files.office)
    expect(everyFile(answer).map((file) => file.id)).not.toContain(files.copyOfBeta)
    expect(answer.total).toBe(everyFile(answer).length)
    const text = JSON.stringify(answer)
    expect(text).not.toMatch(/alsoOn|leftOut|hidden|OFFICE_ONLY|audience/)
    expect(text).not.toContain('T-SA037-copy of a sheet.pdf')
    // The order by the customer's own reference, never the office's series.
    const [order] = await admin<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId])
    expect(text).not.toContain(order!.number)
  })

  it('the order’s entries of the customer-documents library, of that order only', async () => {
    const other = await get('alpha', filesOf(so2))
    expect((groupOf(other, 'SHIPMENTS').files as Json[]).map((file) => file.id)).toContain(files.shipment)
    expect(everyFile(await get('alpha', filesOf(w.a.salesOrderId))).map((file) => file.id)).not.toContain(files.shipment)
  })

  it('the brand wall: Beta’s buyer gets 404 on Alpha’s order files, word for word the answer of an unknown order; Beta’s own order names nothing of Alpha', async () => {
    const unknown = await browsers.beta.get(filesOf(newId()))
    const alpha = await browsers.beta.get(filesOf(w.a.salesOrderId))
    seenByB.push({ url: filesOf(w.a.salesOrderId), body: alpha.body })
    expect([alpha.status, unknown.status]).toEqual([404, 404])
    expect(refusalOf(alpha.body as Json)).toEqual(refusalOf(unknown.body as Json))
    for (const orderId of [so2, w.a.salesOrderId]) expect((await browsers.beta.get(filesOf(orderId))).status).toBe(404)
    const own = await get('beta', filesOf(w.b.salesOrderId))
    expect(everyFile(own).map((file) => file.id)).toContain(files.beta)
    expect(JSON.stringify(own)).not.toMatch(/alsoOn/)
  })

  it('nothing Beta’s buyer got names Alpha', () => {
    expect(seenByB.length).toBeGreaterThan(0)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
