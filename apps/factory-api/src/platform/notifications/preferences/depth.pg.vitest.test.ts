import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { ROLE_TEMPLATES, templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { runDigests } from '../../email-out/digest/digest'
import { systemContext } from '../../outbox/system'
import { useSecrets } from '../../secrets/service'
import { fanOut } from '../fan-out'
import { createPushRuntime, FakePushService, usePush } from '../push/service'
import { testBrowser, testVapid, type TestBrowser } from '../push/testing'
import { deliverInstant } from './deliver'

/**
 * Notifications in depth (B-W2b-385; PLT-140 push to phones, PLT-141 the preferences matrix, PLT-152 text built per reader) on
 * the local stack: a throwaway PostgreSQL 17 from the migrations (the runtime login: row-level security and the
 * …_notify_depth_w2b_guards triggers are real), the real routes, people with live role assignments (the matrix reads their
 * roles), FAKE SES for the mails and the FAKE push service, whose requests are opened here as each phone would open them.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/notifications/preferences`.
 */

vi.setConfig({ testTimeout: 120_000 })

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let company: string
const push = new FakePushService()

const PEOPLE = { admin: newId(), sales: newId(), planner: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { admin: 'admin', sales: 'sales', planner: 'planner', reader: 'read_only' }
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]

function grantOf(key: string): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
/** Sessions by name: the four people, and one person per office template (`role:<key>`). */
const sessions = new Map<string, SessionContext>()
let serial = 0
async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `w2b385-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

async function person(id: string, key: string, roleKey: string): Promise<void> {
  const roleId = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [tenant.id, roleKey]))[0]!.id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [id, tenant.id, `${key.replace(/[^a-z0-9]/g, '-')}@notify-depth.example.com`, `Person ${key}`])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '1 day')`, [newId(), tenant.id, id, roleId])
  sessions.set(key, { audience: 'office', tenantId: tenant.id, actorId: id, grants: [grantOf(roleKey)] })
}

let mark = new Date(0)
const system = () => callerFor(h.database, systemContext(tenant.id, `test-${newId()}`))
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [tenant.id, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(system(), envelope)
  }
  return made
}
const THREAD_EVENTS = ['thread.user_mentioned', 'thread.message_posted']
const mention = (who: Person, whom: Person, body: string) => ok(who, 'POST', `/threads/Company/${company}/notes`, { body, mentions: [PEOPLE[whom]] }, 201)

beforeAll(async () => {
  h = await startHarness('notify_depth_w2b385')
  h.clock.set(new Date())
  useSecrets(h.secrets)
  usePush(createPushRuntime({ vapid: testVapid(), transport: push }))
  tenant = await addTenant(h, 'notify-depth-w2b385', 1)
  company = tenant.companies[0]!.id
  for (const [key, id] of Object.entries(PEOPLE)) await person(id, key, ROLE_OF[key as Person])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 180_000)

afterAll(async () => {
  usePush(undefined)
  useSecrets(undefined)
  await app?.close()
  await h?.close()
})

describe('the preferences matrix (PLT-141)', () => {
  it('starts from the quiet defaults; each cell saves at once and says where it comes from; only e-mail has a digest', async () => {
    const first = await ok('sales', 'GET', '/notifications/preferences')
    expect(first.cells).toHaveLength(21)
    expect(first).toMatchObject({ digestOn: false, pushDevices: 0, mayManageDefaults: false })
    const cell = (body: Json, event: string, channel: string) => body.cells.find((entry: Json) => entry.event === event && entry.channel === channel)
    expect(cell(first, 'MENTIONED', 'PUSH')).toMatchObject({ cadence: 'INSTANT', source: 'QUIET', choices: ['INSTANT', 'OFF'] })
    expect(cell(first, 'MENTIONED', 'EMAIL')).toMatchObject({ cadence: 'DAILY_DIGEST', source: 'QUIET', choices: ['INSTANT', 'DAILY_DIGEST', 'OFF'] })
    const saved = await ok('sales', 'PUT', '/notifications/preferences', { event: 'ASSIGNED', channel: 'EMAIL', cadence: 'INSTANT' })
    expect(cell(saved, 'ASSIGNED', 'EMAIL')).toMatchObject({ cadence: 'INSTANT', source: 'PERSON', role: null })
    // Saved again: the same row (one per person, kind and channel), its cadence moved.
    await ok('sales', 'PUT', '/notifications/preferences', { event: 'ASSIGNED', channel: 'EMAIL', cadence: 'OFF' })
    expect(await admin(`SELECT cadence, key, version FROM "NotificationPreference" WHERE "userId" = $1`, [PEOPLE.sales])).toEqual([{ cadence: 'OFF', key: `pref:${PEOPLE.sales}:ASSIGNED:EMAIL`, version: 2 }])
    // REFUSED: a daily digest by push, in words.
    const refused = await call('sales', 'PUT', '/notifications/preferences', { event: 'MENTIONED', channel: 'PUSH', cadence: 'DAILY_DIGEST' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/cadence', message: 'Only e-mail has a daily digest: choose as it happens or off here.' }])
    // Reset to my roles' defaults: my rows go.
    const reset = await ok('sales', 'DELETE', '/notifications/preferences')
    expect(cell(reset, 'ASSIGNED', 'EMAIL')).toMatchObject({ source: 'QUIET', cadence: 'DAILY_DIGEST' })
    expect(await admin(`SELECT id FROM "NotificationPreference" WHERE "userId" = $1`, [PEOPLE.sales])).toEqual([])
  })

  it('an administrator sets a role’s default; its holders inherit it ("Default for …") until they choose; others may not set it', async () => {
    expect((await call('sales', 'GET', '/notifications/role-defaults')).status).toBe(403)
    expect((await ok('admin', 'GET', '/notifications/preferences')).mayManageDefaults).toBe(true)
    const salesRole = (await admin<{ id: string; name: string }>(`SELECT id, name FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [tenant.id]))[0]!
    const roles = await ok('admin', 'GET', `/notifications/role-defaults?roleId=${salesRole.id}`)
    expect(roles.roles.some((role: Json) => role.key === 'sales')).toBe(true)
    expect(roles.cells.find((entry: Json) => entry.event === 'AREA_ALERT' && entry.channel === 'EMAIL')).toMatchObject({ cadence: null, quiet: 'DAILY_DIGEST' })
    const set = await ok('admin', 'PUT', '/notifications/role-defaults', { roleId: salesRole.id, event: 'AREA_ALERT', channel: 'EMAIL', cadence: 'INSTANT' })
    expect(set.cells.find((entry: Json) => entry.event === 'AREA_ALERT' && entry.channel === 'EMAIL')).toMatchObject({ cadence: 'INSTANT' })
    const mine = await ok('sales', 'GET', '/notifications/preferences')
    expect(mine.cells.find((entry: Json) => entry.event === 'AREA_ALERT' && entry.channel === 'EMAIL')).toMatchObject({ cadence: 'INSTANT', source: 'ROLE', role: { id: salesRole.id, name: salesRole.name } })
    // A floor role gets no office defaults (refused in words).
    const floorRole = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND audience = 'FLOOR' LIMIT 1`, [tenant.id]))[0]!
    const refused = await call('admin', 'PUT', '/notifications/role-defaults', { roleId: floorRole.id, event: 'AREA_ALERT', channel: 'EMAIL', cadence: 'INSTANT' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues[0].path).toBe('body/roleId')
    // Removed: back to the quiet default.
    await ok('admin', 'PUT', '/notifications/role-defaults', { roleId: salesRole.id, event: 'AREA_ALERT', channel: 'EMAIL', cadence: null })
    expect(await admin(`SELECT id FROM "RoleNotificationDefault" WHERE "roleId" = $1`, [salesRole.id])).toEqual([])
  })

  it('the fan-out follows the matrix: off everywhere makes nothing; e-mail alone keeps it quiet and mails it at once, once', async () => {
    // The planner hears mentions by e-mail only, as they happen.
    await ok('planner', 'PUT', '/notifications/preferences', { event: 'MENTIONED', channel: 'IN_APP', cadence: 'OFF' })
    await ok('planner', 'PUT', '/notifications/preferences', { event: 'MENTIONED', channel: 'EMAIL', cadence: 'INSTANT' })
    // The reader hears nothing of mentions.
    for (const channel of ['IN_APP', 'EMAIL', 'PUSH']) await ok('reader', 'PUT', '/notifications/preferences', { event: 'MENTIONED', channel, cadence: 'OFF' })
    mark = new Date()
    const before = h.ses.mails.length
    await mention('sales', 'planner', 'Can you check the delivery plan?')
    await mention('sales', 'reader', 'For your records.')
    // The reader's mention: nothing (off everywhere). The planner's mention: kept quiet, mailed. The two notes' news to the
    // followers (the fan-out reads who follows when it runs: both mentioned people follow the company by then).
    expect(await fanOutSince(THREAD_EVENTS)).toBe(3)
    expect(await admin(`SELECT "userId", "eventType", category FROM "Notification" WHERE "tenantId" = $1 ORDER BY "createdAt", "eventType"`, [tenant.id])).toEqual([
      { userId: PEOPLE.reader, eventType: 'thread.message_posted', category: 'FOLLOWING' },
      { userId: PEOPLE.planner, eventType: 'thread.user_mentioned', category: 'MENTION' },
      { userId: PEOPLE.planner, eventType: 'thread.message_posted', category: 'FOLLOWING' },
    ])
    const rows = await admin(`SELECT id, "userId", "readAt", "doneAt", "createdAt" FROM "Notification" WHERE "tenantId" = $1 AND "eventType" = 'thread.user_mentioned'`, [tenant.id])
    expect(rows.map((row) => row.userId)).toEqual([PEOPLE.planner])
    // Kept quiet: read and done the moment it was made, so the bell never shows it.
    expect(rows[0]!.readAt.getTime()).toBe(rows[0]!.createdAt.getTime())
    expect(rows[0]!.doneAt.getTime()).toBe(rows[0]!.createdAt.getTime())
    expect((await ok('planner', 'GET', '/notifications/counts')).tabs.find((tab: Json) => tab.tab === 'MENTION').unread).toBe(0)
    const mails = h.ses.mails.slice(before)
    expect(mails.map((mail) => [mail.to, mail.templateKey])).toEqual([[['planner@notify-depth.example.com'], 'notifications.instant']])
    expect(textOf(mails[0]!.raw)).toContain('Person sales mentioned you on C1')
    expect(textOf(mails[0]!.raw)).toContain(`/w/C1/home/notifications?open=${rows[0]!.id}`)
    expect(await admin(`SELECT channel, outcome, "emailOutboundId" IS NOT NULL AS named FROM "NotificationDelivery" WHERE "notificationId" = $1`, [rows[0]!.id])).toEqual([{ channel: 'EMAIL', outcome: 'SENT', named: true }])
    // The worker's retry of the same event: nothing made, nothing mailed again.
    expect(await fanOutSince(THREAD_EVENTS)).toBe(0)
    expect(h.ses.mails.length).toBe(before + 1)
  })

  it('a quiet notification still goes in the daily digest when the e-mail column says so', async () => {
    await ok('planner', 'PUT', '/notifications/preferences', { event: 'MENTIONED', channel: 'EMAIL', cadence: 'DAILY_DIGEST' })
    await ok('planner', 'PUT', '/notifications/digest', { on: true, sendTime: '00:00', weekdays: [1, 2, 3, 4, 5, 6, 7], categories: ['ASSIGNMENT'], version: 0 })
    mark = new Date()
    await mention('sales', 'planner', 'One more thing on the plan.')
    // The planner's quiet mention, and the note's news to the reader, who follows the company since their mention.
    expect(await fanOutSince(THREAD_EVENTS)).toBe(2)
    const log = { info() {}, warn() {}, error() {} }
    const result = await runDigests({ database: h.database, log, runtime: () => h.email })
    expect(result).toMatchObject({ due: 1, sent: 1 })
    const digest = h.ses.mails.at(-1)!
    expect(digest.templateKey).toBe('notifications.digest')
    // Listed although the digest's own choice is ASSIGNMENT only: the matrix's e-mail column decides the kinds now.
    expect(textOf(digest.raw)).toContain('Person sales mentioned you on C1')
  })
})

describe('push to phones (PLT-140)', () => {
  let browser: TestBrowser
  const endpoint = 'https://fcm.googleapis.com/fcm/send/made-up-sales-phone'

  it('turns push on for a device (keys sealed, never shown), says what is urgent, and the test push reaches it', async () => {
    browser = testBrowser()
    const status = await ok('sales', 'GET', '/notifications/push')
    expect(status).toMatchObject({ available: true, unavailable: null, devices: [], urgent: ['MENTIONED', 'APPROVAL_WAITING', 'AREA_ALERT'] })
    expect(status.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    const on = await ok('sales', 'POST', '/notifications/push/devices', { label: 'Phone', endpoint, keys: browser.keys })
    expect(on.devices).toEqual([expect.objectContaining({ id: on.deviceId, label: 'Phone', service: 'fcm.googleapis.com', lastUsedAt: null })])
    const row = (await admin(`SELECT s."keysSecretId", v.purpose FROM "PushSubscription" s JOIN "SecretValue" v ON v.id = s."keysSecretId" WHERE s.id = $1`, [on.deviceId]))[0]!
    expect(row.purpose).toBe('notifications.push')
    expect(JSON.stringify(await admin(`SELECT * FROM "SecretValue" WHERE id = $1`, [row.keysSecretId]))).not.toContain(browser.keys.auth)
    // Turned on again from the same browser: the same device (renamed).
    const again = await ok('sales', 'POST', '/notifications/push/devices', { label: 'My phone', endpoint, keys: browser.keys })
    expect(again.deviceId).toBe(on.deviceId)
    const tested = await ok('sales', 'POST', '/notifications/push/test', {})
    expect(tested.results).toEqual([{ deviceId: on.deviceId, outcome: 'SENT' }])
    const request = push.sent.at(-1)!
    expect(request.endpoint).toBe(endpoint)
    expect(request.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400', urgency: 'normal' })
    expect(request.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/)
    expect(browser.open(request.body)).toMatchObject({ v: 1, title: 'Push is on', url: '/w/C1/home/notifications' })
    expect((await ok('sales', 'GET', '/notifications/push')).devices[0].lastUsedAt).not.toBeNull()
  })

  it('refuses an address that is not a browser’s push service, in words', async () => {
    const refused = await call('sales', 'POST', '/notifications/push/devices', { label: 'Laptop', endpoint: 'https://internal.example.com/collect', keys: testBrowser().keys })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues[0]).toEqual({ path: 'body/endpoint', message: 'This browser’s push service is not one the factory sends to (Chrome, Firefox, Safari, Edge).' })
  })

  it('a mention reaches the phone as it happens; a device the push service calls gone is turned off and its keys deleted', async () => {
    mark = new Date()
    const before = push.sent.length
    await mention('planner', 'sales', 'Please look at the plan.')
    // The mention, and the note's news to the reader (a follower without a device).
    expect(await fanOutSince(THREAD_EVENTS)).toBe(2)
    expect(push.sent.length).toBe(before + 1)
    expect(browser.open(push.sent.at(-1)!.body)).toMatchObject({ title: 'C1', body: 'Person planner mentioned you on C1' })
    const notification = (await admin(`SELECT id FROM "Notification" WHERE "userId" = $1 AND "eventType" = 'thread.user_mentioned' ORDER BY "createdAt" DESC LIMIT 1`, [PEOPLE.sales]))[0]!
    expect(await admin(`SELECT channel, outcome FROM "NotificationDelivery" WHERE "notificationId" = $1`, [notification.id])).toEqual([{ channel: 'PUSH', outcome: 'SENT' }])
    // The browser dropped the subscription: the push service answers 410.
    push.answer(endpoint, 410)
    mark = new Date()
    await mention('planner', 'sales', 'And one more.')
    expect(await fanOutSince(THREAD_EVENTS)).toBe(2)
    const device = (await admin(`SELECT "revokedAt", "keysSecretId" FROM "PushSubscription" WHERE endpoint = $1`, [endpoint]))[0]!
    expect(device.revokedAt).not.toBeNull()
    expect(device.keysSecretId).toBeNull()
    expect((await ok('sales', 'GET', '/notifications/push')).devices).toEqual([])
    expect((await call('sales', 'POST', '/notifications/push/test', {})).status).toBe(409)
  })

  it('a worker’s push never shows a price: each office role’s phone gets the amount only with the price grain (PLT-152)', async () => {
    const eventId = newId()
    const browsers = new Map<string, TestBrowser>()
    const offices = ROLE_TEMPLATES.filter((template) => template.audience === 'office')
    for (const template of offices) {
      const id = newId()
      await person(id, `role:${template.key}`, template.key)
      const own = testBrowser()
      const deviceEndpoint = `https://updates.push.services.mozilla.com/wpush/v2/made-up-${template.key}`
      browsers.set(deviceEndpoint, own)
      await ok(`role:${template.key}`, 'POST', '/notifications/push/devices', { label: 'Phone', endpoint: deviceEndpoint, keys: own.keys })
      // A notification whose params hold a price (as an old fan-out may have made it): the push cuts it to the reader's grains.
      const rowId = newId()
      await admin(
        `INSERT INTO "Notification" (id, "tenantId", "userId", "companyId", category, "eventType", "eventId", "recordType", "recordId", "recordLabel", "messageKey", params, "groupKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'APPROVAL', 'quote.approval_requested', $5, 'Quote', $6, 'Q-2026-0042', 'notifications.approval.quote_requested', $7::jsonb, $8, now(), now())`,
        [rowId, tenant.id, id, company, eventId, newId(), JSON.stringify({ actorId: PEOPLE.admin, netAmount: markMoney('price', { minor: 123456, currency: 'EUR' }) }), rowId],
      )
    }
    const before = push.sent.length
    const delivered = await deliverInstant(system(), eventId)
    expect(delivered.pushed).toBe(offices.length)
    const sent = push.sent.slice(before)
    expect(sent).toHaveLength(offices.length)
    for (const template of offices) {
      const request = sent.find((entry) => entry.endpoint.endsWith(`made-up-${template.key}`))!
      const message = browsers.get(request.endpoint)!.open(request.body) as Json
      expect(request.headers.urgency, template.key).toBe('high')
      if (template.grains.includes('price')) expect(message.body, template.key).toBe('Person admin asks you to approve quote Q-2026-0042 (EUR 1234.56)')
      else {
        expect(message.body, template.key).toBe('Person admin asks you to approve quote Q-2026-0042')
        expect(JSON.stringify(message), template.key).not.toMatch(/1234|EUR/)
      }
    }
  })
})
