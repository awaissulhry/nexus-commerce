import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor } from '@nexus/factory-domain/events/live'
import { PARTNER_LIVE_EVENTS, partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
import { PORTAL_AREAS } from '@nexus/factory-domain/portal/tasks/kinds'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../../../modules/production/testing/two-brands'
import { forgetProgress } from '../../../modules/sales/portal-orders/progress'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { HOME_SOURCES } from './sources'

/**
 * B-PR-20 — the customer's production on its Home and live (production plan §5 Portal › Home; F-PR-15 draws the tiles) and its wall
 * test PW-P07 ("Portal bell, mail and live: B receives only B's production notices; no A id in any payload"). The Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."
 *
 * On the local stack, through the real app and the real portal sign-in by code: the seeds up to shipping, the production two-brand
 * harness (brand A = the seeds' P1, brand B = the threads' second brand with SEED-SO-B001), and here B's order SEED-SO-B001 waiting
 * on B, at risk and on hold (our production hold on B's own work order), B's second order B2 waiting on us; urgency on for both.
 *
 *   - GET /portal/home: B's Production person reads the production counts of B's OWN orders (waiting on you 1, at risk 1, on hold
 *     1), area Production; A's changes never move B's counts; a role without production reads them as null (shows nothing); the
 *     Home's live list carries the production events (stage, health, urgency, hold) — never a supervisor's or an issue's;
 *   - PW-P07: a real urgency mark of each brand (B-PR-22a's route) → its brand_production.urgency_changed reaches only its own
 *     party's sessions on the partner live channel, ids and states only; no A id in anything B receives.
 *
 * Every name is made up. Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs platform/portal/home`.
 */

let h: Harness
let officeApp: FastifyInstance
let w: ProductionTwoBrands
let tenant: TestTenant
const NS = 'pr20-production-home'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const companyA = seedUuid(NS, 'company:A')
const actorId = seedUuid(NS, 'actor')
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const SESSIONS = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R | undefined> => (await admin<R>(sql, values))[0]
async function replica(statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query('SET LOCAL session_replication_role = replica')
    for (const statement of statements) await h.db.admin.query(statement.sql, statement.values ?? [])
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}
const officeScope = () => ({ audience: 'office' as const, tenantId: T, actorId })

const portal = { betaProd: 'paolo.production@pr20-beta.example.com', betaDesigner: 'diana.designer@pr20-beta.example.com', alphaProd: 'aldo.production@pr20-alpha.example.com' }
const browsers = {} as Record<keyof typeof portal, Browser>
const seenByB: { url: string; body: unknown }[] = []
let aMarkers: Marker[] = []
const beta2 = { orderId: newId(), number: 'T-PR20-SO-B2', customerRef: 'T-PR20-PO-B2' }
const office = { personId: newId() }

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope(officeScope(), async (client) => {
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

async function homeOf(who: keyof typeof portal): Promise<Json> {
  const answer = await browsers[who].get('/portal/home')
  if (who !== 'alphaProd') seenByB.push({ url: '/portal/home', body: answer.body })
  expect(answer.status, `${who} /portal/home: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(200)
  return answer.body as Json
}
const productionCounts = (home: Json): Record<string, number | null> => Object.fromEntries(home.counts.filter((count: Json) => count.key.startsWith('production.')).map((count: Json) => [count.key, count.value]))

const partnerOf = (partyId: string): Actor => ({ audience: 'partner', tenantId: T, partyId, grants: [{ permissions: ['portal.production.view', 'portal.home.view'], companies: 'all', sites: 'all', parties: [partyId] }] })
async function outbox(type: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}

const setLimits = (partyId: string, urgencyOn: boolean, max: number) =>
  admin(`UPDATE "PortalSettings" SET "productionUrgencyOn" = $2, "productionUrgentMax" = $3, version = version + 1 WHERE "partyId" = $1`, [partyId, urgencyOn, max])

beforeAll(async () => {
  h = await startHarness('pr20_production_home')
  // A little in the past: the sign-ins move the app's clock on, and what the portal writes must not be ahead of the database's.
  h.clock.set(new Date(Date.now() - 4 * 60_000))
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await h.database.withScope(officeScope(), async (client) => {
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
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])
  await h.database.withScope(officeScope(), async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })
  await setLimits(ids.a, true, 3)
  await setLimits(ids.b, true, 2)

  // B's second order: CONFIRMED, one line of our own jacket, its production row waiting on us.
  const bLine = (await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [w.b.salesOrderLineId]))!
  await h.database.withScope(officeScope(), (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: beta2.orderId, companyId: w.companyId, partyId: ids.b, number: beta2.number, customerRef: beta2.customerRef, status: 'CONFIRMED', orderDate: new Date('2026-10-01T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer B' }, shipTo: { name: 'Made-up store B' }, promiseDate: new Date('2026-12-20T00:00:00.000Z') },
        select: { id: true },
      })
      const lineId = newId()
      await tx.salesOrderLine.create({ data: { id: lineId, companyId: w.companyId, orderId: beta2.orderId, partyId: ids.b, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId: bLine.colourwayId, quantity: 4, unitPrice: '100.000000', netAmount: 40_000, vatRatePct: '22.00', vatAmount: 8_800 }, select: { id: true } })
      await tx.salesOrderLineSize.createMany({ data: [['50', 2], ['52', 2]].map(([size, quantity]) => ({ id: newId(), lineId, partyId: ids.b, size: size as string, quantity: quantity as number })) })
      await tx.brandOrderProduction.create({ data: { id: newId(), companyId: w.companyId, partyId: ids.b, salesOrderId: beta2.orderId, key: `brand-production:${beta2.orderId}`, waitingOn: 'US', waitingSince: new Date(), createdById: actorId }, select: { id: true } })
    }),
  )

  // SEED-SO-B001: waiting on B, at risk; our production hold on B's own work order (its order reads On hold).
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience) VALUES ($1, $2, $3, $4, $5, $6)', [office.personId, T, `planner.${NS}@example.com`, 'T Planner Pietro (made up)', 'ACTIVE', 'OFFICE'])
  await replica([
    { sql: `UPDATE "BrandOrderProduction" SET "waitingOn" = 'BRAND', "waitingSince" = now(), health = 'AT_RISK', "healthAt" = now(), version = version + 1 WHERE key = $1`, values: [`brand-production:${w.b.salesOrderId}`] },
    {
      sql: `INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", "partyId", kind, "reasonCode", note, "brandWords", status, "placedAt", "placedById", version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, $6, 'PRODUCTION', 'MATERIAL_MISSING', 'Made-up office note: lining late', 'Made-up: we wait for the lining', 'ACTIVE', now(), $7, 1, now(), now())`,
      values: [newId(), T, w.companyId, w.siteId, w.b.workOrderId, ids.b, office.personId],
    },
    { sql: `UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldAt" = now(), "holdRecordType" = 'WorkOrderHold' WHERE id = $1`, values: [w.b.workOrderId] },
  ])

  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(portal.betaProd, ids.b, ['customer-production'])
  await partnerPerson(portal.betaDesigner, ids.b, ['customer-designer'])
  await partnerPerson(portal.alphaProd, ids.a, ['customer-production'])
  for (const person of Object.keys(portal) as (keyof typeof portal)[]) browsers[person] = await signedIn(portal[person])
  aMarkers = [...(await markersOf(h.db, ids.a)), ...w.production.urgent.map((orderId) => ({ label: "A's urgent order", text: orderId }))]
}, 420_000)

beforeEach(() => {
  freshGuard(h)
  forgetProgress()
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  forgetProgress()
  await officeApp?.close()
  await h?.close()
}, 60_000)

describe('B-PR-20 the production source of the Home', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('declares three counts of the Production area, for customers only, in both languages, on the production live events', () => {
    const source = HOME_SOURCES.find((entry) => entry.name === 'production')!
    expect(source.counts.map((count) => count.key)).toEqual(['production.waiting_on_you', 'production.at_risk', 'production.on_hold'])
    for (const count of source.counts) {
      expect(count.area).toBe('production')
      expect(count.kinds).toEqual(['CUSTOMER'])
      expect(count.words.it.trim()).not.toBe('')
      expect(count.words.en.trim()).not.toBe('')
    }
    expect(PORTAL_AREAS).toContain('production')
    expect([...(source.live ?? [])].sort()).toEqual(['brand_production.health_changed', 'brand_production.hold_changed', 'brand_production.stage_reached', 'brand_production.urgency_changed'])
    // Each one is a partner live event the party's own sessions receive.
    for (const event of source.live ?? []) expect(PARTNER_LIVE_EVENTS[event]?.permission, event).toBe('portal.production.view')
  })

  it("B's Production person reads the counts of B's OWN orders: waiting on you, at risk, on hold — and the Home reads them again on the production events", async () => {
    const home = await homeOf('betaProd')
    expect(productionCounts(home)).toEqual({ 'production.waiting_on_you': 1, 'production.at_risk': 1, 'production.on_hold': 1 })
    expect(home.counts.filter((count: Json) => count.key.startsWith('production.')).map((count: Json) => count.area)).toEqual(['production', 'production', 'production'])
    expect(home.live.events).toEqual(expect.arrayContaining(['brand_production.stage_reached', 'brand_production.health_changed', 'brand_production.urgency_changed', 'brand_production.hold_changed', 'partner_notification.created']))
    expect(home.live.events.some((event: string) => event.includes('supervisor') || event.startsWith('production_issue') || event.startsWith('work_order_hold'))).toBe(false)
    expect(new Set(home.live.events).size).toBe(home.live.events.length)
    expect(findMarkers(home, aMarkers)).toEqual([])
  })

  it("the wall: A's orders changing never move B's counts; A's own counts move by A's orders only", async () => {
    const bBefore = productionCounts(await homeOf('betaProd'))
    const aBefore = productionCounts(await homeOf('alphaProd'))
    // One more of A's orders waiting on A and at risk.
    await replica([{ sql: `UPDATE "BrandOrderProduction" SET "waitingOn" = 'BRAND', "waitingSince" = now(), health = 'AT_RISK', "healthAt" = now(), version = version + 1 WHERE key = $1`, values: [`brand-production:${w.a.salesOrderId}`] }])
    const aAfter = productionCounts(await homeOf('alphaProd'))
    expect(productionCounts(await homeOf('betaProd'))).toEqual(bBefore)
    expect(aAfter['production.waiting_on_you']).toBe((aBefore['production.waiting_on_you'] ?? 0) + 1)
    expect(aAfter['production.at_risk']).toBe((aBefore['production.at_risk'] ?? 0) + 1)
  })

  it('a role without production reads the counts as null (the tile shows nothing, never 0)', async () => {
    expect(productionCounts(await homeOf('betaDesigner'))).toEqual({ 'production.waiting_on_you': null, 'production.at_risk': null, 'production.on_hold': null })
  })
})

describe('B-PR-20 PW-P07: production on the partner live channel, each brand its own', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("a real urgency mark of each brand reaches only its own party's sessions, ids and states only; nothing of A in what B receives", async () => {
    const markB = await browsers.betaProd.post('/portal/production/urgency', { orderIds: [beta2.orderId], urgency: 'URGENT' }, { headers: { 'idempotency-key': newId() } })
    seenByB.push({ url: 'POST /portal/production/urgency', body: markB.body })
    expect(markB.status, JSON.stringify(markB.body)).toBe(200)
    const markA = await browsers.alphaProd.post('/portal/production/urgency', { orderIds: [w.production.urgent[0]], urgency: 'REGULAR' }, { headers: { 'idempotency-key': newId() } })
    expect(markA.status, JSON.stringify(markA.body)).toBe(200)

    const events = await outbox('brand_production.urgency_changed')
    const ofB = events.filter((event) => (event.payload as Json).partyId === ids.b && ((event.payload as Json).orderIds as string[]).includes(beta2.orderId))
    const ofA = events.filter((event) => (event.payload as Json).partyId === ids.a && ((event.payload as Json).orderIds as string[]).includes(w.production.urgent[0]))
    expect(ofB.length).toBeGreaterThan(0)
    expect(ofA.length).toBeGreaterThan(0)
    for (const event of ofB) {
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))!
      const seen = partnerLiveViewFor(message, partnerOf(ids.b), EVENT_CATALOGUE)
      expect(seen?.fields).toMatchObject({ partyId: ids.b, orderIds: [beta2.orderId], urgency: 'URGENT' })
      expect(Object.keys(seen!.fields).sort()).toEqual([...PARTNER_LIVE_EVENTS['brand_production.urgency_changed']!.fields].filter((key) => key in seen!.fields).sort())
      expect(findMarkers(seen, aMarkers)).toEqual([])
      expect(partnerLiveViewFor(message, partnerOf(ids.a), EVENT_CATALOGUE)).toBeNull()
    }
    for (const event of ofA) {
      const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))!
      expect(partnerLiveViewFor(message, partnerOf(ids.b), EVENT_CATALOGUE)).toBeNull()
      expect(partnerLiveViewFor(message, partnerOf(ids.a), EVENT_CATALOGUE)?.fields).toMatchObject({ partyId: ids.a })
    }
    // Every production event of the outbox: a B session receives only B's, never an issue's or a supervisor's.
    for (const type of [...Object.keys(PARTNER_LIVE_EVENTS).filter((key) => key.startsWith('brand_production.')), 'brand_production.supervisor_changed', 'production_issue.raised', 'production_issue.answered', 'production_issue.escalated']) {
      for (const event of await outbox(type)) {
        const message = liveMessageFor(event, EVENT_CATALOGUE.get(event.type, event.version))
        if (!message) continue
        const seen = partnerLiveViewFor(message, partnerOf(ids.b), EVENT_CATALOGUE)
        if (seen === null) continue
        expect(type.startsWith('brand_production.') && type !== 'brand_production.supervisor_changed', type).toBe(true)
        expect(seen.fields.partyId, type).toBe(ids.b)
        expect(findMarkers(seen, aMarkers), type).toEqual([])
      }
    }
    // The Home after B's mark: still only B's counts.
    expect(productionCounts(await homeOf('betaProd'))).toEqual({ 'production.waiting_on_you': 1, 'production.at_risk': 1, 'production.on_hold': 1 })
  })

  it('nothing B’s people got names anything of A', () => {
    expect(seenByB.length).toBeGreaterThan(0)
    for (const seen of seenByB) expect(findMarkers(seen.body, aMarkers), seen.url).toEqual([])
  })
})
