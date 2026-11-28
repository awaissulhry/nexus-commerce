import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPortalSales } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * owb- (order workflow, b3.4): the customer's walls of the ONE order log and of the order's picture — through the real app and the
 * real portal sign-in by code, on the factory-db seeds up to the customer portal (Brand A = the seeded customer SEED-C1, P1, with
 * SEED-SO-0001 and its SENT request SEED-RQ-0001; Brand B = another customer, no orders). The audit rows and files the reads read
 * are planted with the database's rules off (the reads are what is tested). Every name and number is made up.
 *
 *   WS-OWB-1  brand B never reads brand A's order log or picture: its buyer gets 404 on A's order and request, read or write
 *   WS-OWB-2  the portal log never carries a worker's name, an office note, a reason or a cost: every factory person is "The
 *             factory", only the ALLOW-list's rows, no reason, no price, no file the customer may not see
 *   WS-OWB-5  the picture of another party's order is refused (404); its own request's picture set by its buyer (and its
 *             Designer: one right before and after Send), a file not shared with it refused in words (400)
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-orders/order-log`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'owb-portal-order-log'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const people = { a: 'ada.buyer@brand-alpha.example', designer: 'dino.designer@brand-alpha.example', b: 'bea.buyer@brand-beta.example' }
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

async function planted(rows: readonly { readonly sql: string; readonly values: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await h.db.admin.query(row.sql, row.values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}

const seeded = { order: '', request: '', store: '', officeUser: '', worker: '', workerName: '' }

const audit = (row: { recordType: string; recordId: string; action: string; audience?: string; actorId?: string; before?: Json | null; after?: Json | null; reason?: string | null }) => ({
  sql: `INSERT INTO "AuditLog" (id, "tenantId", "companyId", at, audience, "actorId", action, "recordType", "recordId", before, after, reason, "requestId") VALUES ($1, $2, $3, now(), $4::"AuditAudience", $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, 'owb-test')`,
  values: [newId(), T, companyA, row.audience ?? 'OFFICE', row.actorId ?? seeded.officeUser, row.action, row.recordType, row.recordId, row.before ? JSON.stringify(row.before) : null, row.after ? JSON.stringify(row.after) : null, row.reason ?? null],
})

/** A file of a record: office only, or shared with a party (PARTNER). */
async function file(recordType: string, recordId: string, name: string, sharedWith: string | null): Promise<string> {
  const fileId = newId()
  await planted([
    {
      sql: `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "partyId") VALUES ($1, $2, $3, $4, $5, 'PHOTO', $6, 'image/jpeg', 2400, repeat('0', 64), $7, $8, 'AVAILABLE', $9::"FileAudience"[], $10)`,
      values: [fileId, T, companyA, recordType, recordId, name, seeded.store, `test/${fileId}`, sharedWith ? '{OFFICE,PARTNER}' : '{OFFICE}', sharedWith],
    },
  ])
  return fileId
}

beforeAll(async () => {
  h = await startHarness('owb_portal_order_log')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedPortalSales({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal-owb', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.upsert({ where: { id: P1 }, create: { id: P1, partyId: P1, portalOn: true }, update: { portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.a, P1, ['customer-buyer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.b, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  seeded.order = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T])).id
  seeded.request = (await one<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = 'SEED-RQ-0001'`, [T])).id
  seeded.store = (await one<{ id: string }>(`SELECT id::text AS id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' LIMIT 1`, [T])).id
  seeded.officeUser = (await one<{ id: string }>(`SELECT id FROM "User" WHERE "tenantId" = $1 AND audience = 'OFFICE' ORDER BY "createdAt" LIMIT 1`, [T])).id
  const worker = await one<{ id: string; displayName: string }>(`SELECT id, "displayName" FROM "Worker" WHERE "tenantId" = $1 ORDER BY "displayName" LIMIT 1`, [T])
  seeded.worker = worker.id
  seeded.workerName = worker.displayName
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('owb-: the order log and the picture in the customer\'s face', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('WS-OWB-1: brand B never reads brand A\'s order log or picture — 404 on the order and the request, read or write', async () => {
    for (const url of [`/portal/sales-orders/${seeded.order}/log`, `/portal/order-requests/${seeded.request}/log`]) {
      const answer = await browsers.b.get(url)
      expect(answer.status, url).toBe(404)
      expect(JSON.stringify(answer.body), url).not.toContain('SEED-')
    }
    for (const url of [`/portal/sales-orders/${seeded.order}/picture`, `/portal/order-requests/${seeded.request}/picture`]) {
      expect((await browsers.b.post(url, { fileId: null, version: 1 })).status, url).toBe(404)
    }
    // Brand A reads its own.
    expect((await browsers.a.get(`/portal/sales-orders/${seeded.order}/log`)).status).toBe(200)
    expect((await browsers.a.get(`/portal/order-requests/${seeded.request}/log`)).status).toBe(200)
  })

  it('WS-OWB-2: no worker\'s name, no office note, no reason, no cost — "The factory" on the allowed rows only', async () => {
    const officeOnly = await file('SalesOrder', seeded.order, 'made-up office price sheet.pdf', null)
    await planted([
      audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.changePromise', after: { previous: '2026-12-01', promiseDate: '2026-12-08' }, reason: 'Made-up office note: the lining supplier is late' }),
      audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.priority', after: { priorityLevel: 'URGENT', urgentReason: 'Made-up rush for a race' } }),
      audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.markReady', audience: 'FLOOR', actorId: seeded.worker, before: { status: 'IN_PRODUCTION' }, after: { status: 'READY' } }),
      audit({ recordType: 'SalesOrder', recordId: seeded.order, action: 'orders.amend', after: { lines: [{ unitPrice: '481.250000', cost: { minor: 30100, currency: 'EUR' } }] } }),
      audit({ recordType: 'StoredFile', recordId: officeOnly, action: 'files.completeUpload' }),
    ])
    const answer = await browsers.a.get(`/portal/sales-orders/${seeded.order}/log?limit=100`)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const rows = answer.body.rows as Json[]
    expect(rows.find((row) => row.action === 'PROMISE_MOVED')).toMatchObject({ who: { face: 'THE_FACTORY', name: null }, reason: null, to: { kind: 'DATE', date: '2026-12-08' } })
    expect(rows.find((row) => row.action === 'READY')).toMatchObject({ who: { face: 'THE_FACTORY', name: null }, to: { kind: 'LIFE', life: 'READY_TO_SHIP' } })
    for (const row of rows) {
      expect(row.reason, row.action).toBeNull()
      expect(['PERSON', 'THE_FACTORY', 'SYSTEM'], row.action).toContain(row.who.face)
      expect(row.action, row.id).not.toBe('OTHER')
    }
    const said = JSON.stringify(answer.body)
    for (const secret of [seeded.workerName, 'office note', 'rush', 'URGENT', '481.25', '30100', 'price sheet', officeOnly]) expect(said, secret).not.toContain(secret)
  })

  it('WS-OWB-5: its own request\'s picture by its buyer and its Designer (one right); a file not shared with it: 400 in words; logged', async () => {
    const shared = await file('PortalOrderRequest', seeded.request, 'made-up mockup.jpg', P1)
    const officeOnly = await file('PortalOrderRequest', seeded.request, 'made-up office copy.jpg', null)
    const version = (await one<{ version: number }>('SELECT version FROM "PortalOrderRequest" WHERE id = $1', [seeded.request])).version
    const refused = await browsers.a.post(`/portal/order-requests/${seeded.request}/picture`, { fileId: officeOnly, version })
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error).toMatchObject({ code: 'validation_failed', issues: [{ path: 'body/fileId' }] })
    const set = await browsers.a.post(`/portal/order-requests/${seeded.request}/picture`, { fileId: shared, version })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expect(set.body).toEqual({ pictureFileId: shared, pictureSetAt: expect.any(String), version: version + 1 })
    // The customer's Designer holds the same right (portal.orderDrafts.edit) while the request is SENT.
    const designer = await browsers.designer.post(`/portal/order-requests/${seeded.request}/picture`, { fileId: null, version: version + 1 })
    expect(designer.status, JSON.stringify(designer.body)).toBe(200)
    const log = (await browsers.a.get(`/portal/order-requests/${seeded.request}/log?limit=100`)).body.rows as Json[]
    const pictures = log.filter((row) => row.action === 'PICTURE_SET')
    expect(pictures.length).toBeGreaterThanOrEqual(2)
    expect(pictures.find((row) => row.to?.fileId === shared)).toMatchObject({ icon: 'image', who: { face: 'PERSON' } })
    // Its own order: another customer's order is never reached (404 above); a stale version is a 409 in words.
    const orderVersion = (await one<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [seeded.order])).version
    expect((await browsers.a.post(`/portal/sales-orders/${seeded.order}/picture`, { fileId: null, version: orderVersion + 5 })).status).toBe(409)
  })
})
