import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { shareOrderArtwork } from './artwork'

/**
 * B-W2b-374 (XF3:04) on the local stack with the real portal sign-in by code: an order line's artwork the office shows in the
 * portal (StoredFile visibility PARTNER, the order's party) is listed with the line's options in words and opened (logged,
 * presigned); another customer finds nothing; a file not shown is not listed. Tenant A from the factory-db seeds up to
 * shipping (SEED-SO-0001 of P1), the options library of the options seed. Made-up people and files only.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-ordering/artwork`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
let options: OptionsSeed
const NS = 'portal-artwork-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const people = { buyer: 'bianca.buyer@seed-racing.example', other: 'otto.buyer@brand-alpha.example' }
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

const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), requestId: newId(), grants: [{ permissions: ['orders.view', 'orders.manage'], companies: 'all', sites: 'all', parties: 'all' }] })

/** A made-up artwork file on an order line (as the configurator's upload leaves it: office only). */
async function artworkOn(lineId: string, name: string, contentType: string): Promise<string> {
  const store = await one<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY code LIMIT 1`, [T])
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, (client) =>
    client.storedFile.create({
      data: {
        id,
        companyId: companyA,
        recordType: 'SalesOrderLine',
        recordId: lineId,
        kind: contentType.startsWith('image/') ? 'PHOTO' : 'DOCUMENT',
        category: 'ARTWORK',
        originalName: name,
        contentType,
        sizeBytes: 2048,
        sha256: 'a'.repeat(64),
        storeAccountId: store.id,
        storageKey: `t/${T}/c/${companyA}/2026/${newId()}`,
        status: 'AVAILABLE',
        availableAt: new Date(),
      },
      select: { id: true },
    }),
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('portal_artwork')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  options = await seedOptions({ db: h.database, namespace: NS })
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
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
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

describe("an option's artwork in the portal (XF3:04)", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the office shows a file of the line; the customer reads the line\'s options and opens it, logged; another customer finds nothing', async () => {
    const order = await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T])
    const line = await one<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [order.id])
    const logo = await artworkOn(line.id, 'demo-logo.pdf', 'application/pdf')
    const hidden = await artworkOn(line.id, 'demo-sketch.png', 'image/png')
    // A chosen option on the line (test data past the style's offer: the triggers are the configurator's tests).
    await admin(`SET session_replication_role = replica`)
    try {
      await admin(`INSERT INTO "SalesOrderLineOption" (id, "tenantId", "lineId", "partyId", "groupId", "valueId", "freeText") VALUES ($1, $2, $3, $4, $5, $6, 'BIANCHI')`, [newId(), T, line.id, line.partyId, options.groupIds.name, options.valueIds.name])
    } finally {
      await admin(`SET session_replication_role = origin`)
    }
    // Not shown yet: the line's options only.
    let read = (await browsers.buyer.get(`/portal/sales-orders/${order.id}/options`)).body as Json
    expect(read.lines).toHaveLength(1)
    expect(read.lines[0].artwork).toEqual([])
    expect(read.lines[0].options[0].en).toMatch(/«BIANCHI»/)
    expect(read.lines[0].options[0].it).toMatch(/«BIANCHI»/)
    // The office shows the logo (orders.manage): shared with the order's party, audited.
    const shared = await shareOrderArtwork(office(), order.id, line.id, logo, { shown: true })
    expect(shared.artwork.find((file) => file.fileId === logo)).toMatchObject({ portal: true })
    expect(await one(`SELECT visibility::text[] AS visibility, "partyId" FROM "StoredFile" WHERE id = $1`, [logo])).toMatchObject({ visibility: ['OFFICE', 'PARTNER'], partyId: P1 })
    expect((await admin(`SELECT 1 FROM "AuditLog" WHERE action = 'orders.shareArtwork' AND "recordId" = $1`, [order.id])).length).toBe(1)
    read = (await browsers.buyer.get(`/portal/sales-orders/${order.id}/options`)).body as Json
    expect(read.lines[0].artwork).toEqual([{ fileId: logo, name: 'demo-logo.pdf', contentType: 'application/pdf', sizeBytes: 2048, picture: false }])
    // Opened: a presigned GET and the audit row of the party's person; the file not shown is not found.
    const opened = await browsers.buyer.post(`/portal/sales-orders/${order.id}/artwork/${logo}/open`, { mode: 'preview' })
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body).toMatchObject({ file: { fileId: logo, name: 'demo-logo.pdf' }, download: { mode: 'inline', method: 'GET' } })
    const [audit] = await admin<Json>(`SELECT audience::text AS audience, "partyId", after FROM "AuditLog" WHERE action = 'portal.artwork.open' AND "recordId" = $1`, [logo])
    expect(audit).toMatchObject({ audience: 'PARTNER', partyId: P1, after: { mode: 'preview', orderId: order.id, lineId: line.id } })
    expect((await browsers.buyer.post(`/portal/sales-orders/${order.id}/artwork/${hidden}/open`, {})).status).toBe(404)
    // Another customer: the order is not found.
    expect((await browsers.other.get(`/portal/sales-orders/${order.id}/options`)).status).toBe(404)
    expect((await browsers.other.post(`/portal/sales-orders/${order.id}/artwork/${logo}/open`, {})).status).toBe(404)
    // Taken out of the portal again: not listed.
    await shareOrderArtwork(office(), order.id, line.id, logo, { shown: false })
    expect(await one(`SELECT visibility::text[] AS visibility, "partyId" FROM "StoredFile" WHERE id = $1`, [logo])).toMatchObject({ visibility: ['OFFICE'], partyId: null })
    read = (await browsers.buyer.get(`/portal/sales-orders/${order.id}/options`)).body as Json
    expect(read.lines[0].artwork).toEqual([])
  })
})
