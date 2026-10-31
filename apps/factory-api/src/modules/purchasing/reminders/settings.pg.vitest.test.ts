import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { fixedClock } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSourcing, type SourcingSeed } from '../../../../../../packages/factory-db/seed/sourcing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { runConfirmationReminders } from './daily'

/**
 * The Owner's switch for automatic PO confirmation reminders (B-W2b-14; Z1:09; W2b plan §3 "Owner switch") on the local
 * stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (row-level security, the
 * grants and the PurchasingSettings guard are real), the factory-db seeds up to sourcing (SEED-PO-0003 SENT to its
 * supplier with a confirm-by time), a real owner signed in with two-factor (the step-up is the harness's), other people
 * from the test authenticator. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/reminders`.
 */

type Json = Record<string, any>
const NS = 'reminders-a'
const idOf = (key: string) => seedUuid(NS, key)
const ids = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B') }
const TENANT: TestTenant = { id: ids.tenant, slug: NS, companies: [{ id: ids.companyA, code: 'A' }, { id: ids.companyB, code: 'B' }] }

const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  /** The buyer: reads where the switch stands, never turns it. */
  buyer: { audience: 'office', tenantId: ids.tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send'])] },
}

let h: Harness
let app: FastifyInstance
let sourcing: SourcingSeed
let owner: { browser: Browser; secret: string }
let serial = 0
const idem = () => `rem-${randomBytes(4).toString('hex')}-${++serial}`
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const asOwner = async (method: 'GET' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const answer = await owner.browser.send(method as 'POST', url, body, method === 'GET' ? {} : { headers: { 'idempotency-key': idem() } })
  return { status: answer.status, body: answer.body as Json }
}
const errors: string[] = []
const log = { info: () => undefined, error: (detail: { err?: unknown }) => void errors.push(String((detail?.err as Error | undefined)?.message ?? detail)), warn: () => undefined } as never

beforeAll(async () => {
  h = await startHarness('reminders_switch')
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  sourcing = await seedSourcing({ db: h.database, namespace: NS })
  for (const seedOf of [seedNumbering, seedReasons, seedFiles, seedEmail]) await seedOf({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [ids.tenant])
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const user = await addUser(h, TENANT, { email: `owner-${randomBytes(3).toString('hex')}@example.test`, role: 'owner' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`owner sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser) }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe("the Owner's switch for automatic PO confirmation reminders (Z1:09)", () => {
  let orderCompany = ''
  let offCount = 0

  it('OFF by default: the buyer reads it, never changes it; the daily run sends nothing and counts the due orders', async () => {
    orderCompany = (await admin<{ companyId: string }>(`SELECT "companyId" FROM "PurchaseOrder" WHERE id = $1`, [sourcing.revisedPurchaseOrderId]))[0]!.companyId
    const read = await call('buyer', 'GET', `/purchasing/reminders/settings?companyId=${orderCompany}`)
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json()).toMatchObject({ companyId: orderCompany, source: 'DEFAULT', on: false, mayChange: false, company: null, tenant: null })
    expect(read.json().words).toContain('never switched on')
    const refused = await call('buyer', 'PUT', '/purchasing/reminders/settings/switch', { companyId: orderCompany, on: true })
    expect(refused.statusCode, refused.body).toBe(403)
    // The order waits for its supplier; a month on, it is past its confirm-by time: due, but nothing is sent.
    const clock = fixedClock(new Date(Date.now() + 30 * 24 * 3_600_000))
    const off = await runConfirmationReminders({ database: h.database, log, clock })
    expect(off).toMatchObject({ sent: 0, failed: 0 })
    expect(off.switchedOff).toBeGreaterThanOrEqual(1)
    offCount = off.switchedOff
    const reminders = await call('buyer', 'GET', `/purchasing/orders/${sourcing.revisedPurchaseOrderId}/reminders`)
    expect(reminders.statusCode, reminders.body).toBe(200)
    expect(reminders.json().automatic).toBe(false)
  })

  it('the owner turns it ON for the company only with a fresh step-up; OFF needs none; every change audited, with the event', async () => {
    const noStepUp = await asOwner('PUT', '/purchasing/reminders/settings/switch', { companyId: orderCompany, on: true })
    expect([noStepUp.status, noStepUp.body.error.issues]).toEqual([403, [{ path: 'stepUp', message: 'Required.' }]])
    await stepUp(h, owner.browser, owner.secret)
    const on = await asOwner('PUT', '/purchasing/reminders/settings/switch', { companyId: orderCompany, on: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body).toMatchObject({ companyId: orderCompany, source: 'COMPANY', on: true, mayChange: true, company: { confirmationRemindersEnabled: true, version: 2 }, tenant: null })
    // A stale version is refused in words; nothing changes.
    const stale = await asOwner('PUT', '/purchasing/reminders/settings/switch', { companyId: orderCompany, on: false, version: 1 })
    expect([stale.status, stale.body.error.issues]).toEqual([409, [{ path: 'body/version', message: 'The current version is 2.' }]])
    expect(await admin(`SELECT "confirmationRemindersEnabled" FROM "PurchasingSettings" WHERE id = $1`, [orderCompany])).toEqual([{ confirmationRemindersEnabled: true }])
    expect((await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'PurchasingSettings' AND "recordId" = $1 ORDER BY at, id`, [orderCompany])).map((row) => row.action)).toEqual(['purchasing.reminderSettingsCreate', 'purchasing.remindersSwitch'])
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'purchasing_settings.changed' AND subject = $1`, [orderCompany])).toEqual([{ payload: { settingsId: orderCompany, companyId: orderCompany, confirmationRemindersEnabled: true } }])
    // The buyer reads it ON; the order's reminders card says so.
    expect((await call('buyer', 'GET', `/purchasing/reminders/settings?companyId=${orderCompany}`)).json()).toMatchObject({ on: true, source: 'COMPANY' })
    expect((await call('buyer', 'GET', `/purchasing/orders/${sourcing.revisedPurchaseOrderId}/reminders`)).json().automatic).toBe(true)
  })

  it('ON: the daily run reads it and reminds the due order of that company (switched off no more)', async () => {
    const clock = fixedClock(new Date(Date.now() + 30 * 24 * 3_600_000))
    const before = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1`, [sourcing.revisedPurchaseOrderId]))[0]!.n
    // The order needs its contact with an e-mail for a reminder: the seed's P1 order desk (made up).
    const contact = (await admin<{ id: string }>(`SELECT c.id FROM "PartyContact" c JOIN "PurchaseOrder" o ON o."partyId" = c."partyId" WHERE o.id = $1 AND c.email IS NOT NULL AND c.status = 'ACTIVE' ORDER BY c.id LIMIT 1`, [sourcing.revisedPurchaseOrderId]))[0]
    if (contact) await admin(`UPDATE "PurchaseOrder" SET "contactId" = $2 WHERE id = $1 AND "contactId" IS NULL`, [sourcing.revisedPurchaseOrderId, contact.id])
    // …and its company a sending address (the e-mail seed gives one to company A only): a copy of A's, made up.
    await admin(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault", status)
       SELECT $1, i."tenantId", $2, i.kind, i.domain, 'ordini-b@' || i.domain, 'Company B', i."displayNamePolicy", i."replyDomain", i."accountId", i."verificationStatus", i."dkimStatus", true, i.status
         FROM "EmailIdentity" i WHERE i."tenantId" = $3 AND NOT EXISTS (SELECT 1 FROM "EmailIdentity" x WHERE x."tenantId" = $3 AND x."companyId" = $2) ORDER BY i."isDefault" DESC LIMIT 1`,
      [newId(), orderCompany, ids.tenant],
    )
    const on = await runConfirmationReminders({ database: h.database, log, clock })
    // The run read the switch: that company's due orders are no longer switched off, they went (or were tried).
    expect(on.switchedOff).toBeLessThan(offCount)
    expect(on.sent + on.failed).toBe(offCount - on.switchedOff)
    expect(on.sent, errors.join(' | ')).toBeGreaterThanOrEqual(1)
    const after = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1`, [sourcing.revisedPurchaseOrderId]))[0]!.n
    expect(after).toBe(before + 1)
    expect(await admin(`SELECT "sentById" FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1 ORDER BY "sentAt" DESC LIMIT 1`, [sourcing.revisedPurchaseOrderId])).toEqual([{ sentById: null }])
  })

  it('OFF again without a step-up: the next run sends nothing to that company', async () => {
    const current = (await call('buyer', 'GET', `/purchasing/reminders/settings?companyId=${orderCompany}`)).json()
    const off = await asOwner('PUT', '/purchasing/reminders/settings/switch', { companyId: orderCompany, on: false, version: current.company.version })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body).toMatchObject({ on: false, source: 'COMPANY', company: { confirmationRemindersEnabled: false } })
    const clock = fixedClock(new Date(Date.now() + 40 * 24 * 3_600_000))
    const before = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1`, [sourcing.revisedPurchaseOrderId]))[0]!.n
    const run = await runConfirmationReminders({ database: h.database, log, clock })
    expect(run.switchedOff).toBeGreaterThanOrEqual(1)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1`, [sourcing.revisedPurchaseOrderId]))[0]!.n).toBe(before)
  })

  it('the tenant-wide row is a role over every company: the owner sets it, a company without its own row follows it', async () => {
    const other = ids.companyA === orderCompany ? ids.companyB : ids.companyA
    const on = await asOwner('PUT', '/purchasing/reminders/settings/switch', { companyId: null, on: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body).toMatchObject({ companyId: null, source: 'TENANT', on: true, tenant: { id: ids.tenant, companyId: null, confirmationRemindersEnabled: true } })
    expect((await call('buyer', 'GET', `/purchasing/reminders/settings?companyId=${other}`)).json()).toMatchObject({ source: 'TENANT', on: true })
    // The company with its own row keeps it (OFF).
    expect((await call('buyer', 'GET', `/purchasing/reminders/settings?companyId=${orderCompany}`)).json()).toMatchObject({ source: 'COMPANY', on: false })
    // Never deleted, for every login.
    await expect(admin(`DELETE FROM "PurchasingSettings" WHERE id = $1`, [ids.tenant])).rejects.toThrow(/never deleted/)
  })
})
