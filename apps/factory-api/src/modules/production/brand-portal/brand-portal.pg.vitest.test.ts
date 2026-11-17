import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { forbiddenKeysIn } from '@nexus/factory-domain/production-brand/portal-read'
import { PROMISE_REASON_WORDS } from '@nexus/factory-domain/sales/portal-orders/promise'
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
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { forgetProgress } from '../../sales/portal-orders/progress'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'

/**
 * B-PR-18 — the customer's own production in its portal (production plan §2 the brand wall, §3, §4, §5; R-26, R-42, R-43, R-46,
 * R-65; Owner P3; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as
 * the production unit, should be able to see it all. And manage it all as well.") on the local stack, through the real app and the
 * real portal sign-in by code: the seeds up to shipping (brand A = the seeds' customer P1, its orders SEED-SO-0001/0002/0003), the
 * production two-brand harness (brand B = the threads' second brand with SEED-SO-B001, a work order each, a legacy work order
 * mixing both; A's SEED-SO-0002 and its new order Urgent 1st and 2nd, B's order set back to Regular and locked by us; B's open
 * reported problem), and here: B's second order (no production row yet: read live), B's limits at + Gates & dates (urgency on, quota
 * 2), A's at + Progress (urgency on, quota 3), a production supervisor and a raised health with the office's note on B's order, our
 * production holds (B's own work order with words for B; the mixed one with words for nobody but A), quality releases on the mixed
 * work order (B's cell over what B ordered, A's cell), gates of both brands (and one in the office's own words), swatches of both
 * brands on the shared style, and a published plan with slots on B's own work order, on the mixed one and on A's.
 *
 *   PW-P01  B lists only B's orders, in its own order; A's order id → 404 as an unknown id; a role without production → 403
 *   PW-P02  B's order by level: holds in plain words (never the office note, never words meant for A), progress of B's own cells
 *           only (the mixed work order's B cell capped at what B ordered; nothing of A's cell), no lot size, no work order
 *   PW-P03  gates & dates: only B's real gates (no OTHER, no override reason), B's swatch answers only, the PUBLISHED plan's days of
 *           B's OWN work order only (not the working plan, not the mixed work order, not A's), no line or capacity key
 *   PW-11   (read part) "n of max used" counts only the customer's own open orders; no place, no other customer's count
 *   PW-15   no portal read or file carries a supervisor, an office person, the office's note or another customer's figure
 *   and     the list order, urgency off (no urgency in the read, marks kept), the reported problem's states ("Waiting on us since",
 *           "Answered", "Answered in SO-…"), the CSV export of every own row with urgency.
 *
 * Every answer B got is scanned for A's names, codes, numbers and ids and for every office word written here. Every name and number
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/brand-portal`.
 */

let h: Harness
let officeApp: FastifyInstance
let w: ProductionTwoBrands
let tenant: TestTenant
const NS = 'pr18-brand-portal'
const ids = twoBrandIds(NS)
const T = ids.tenantId
const companyA = seedUuid(NS, 'company:A')
const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]
const SESSIONS = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** Statements with the database's rules off, in one transaction (as the two-brand harness writes what the app would never make). */
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

const people = { alpha: 'anna.buyer@pr18-alpha.example.com', beta: 'bruno.production@pr18-beta.example.com', betaDesigner: 'dina.designer@pr18-beta.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>

/** What B's portal people got: every answer, for the scans. */
const seenByB: { url: string; body: unknown }[] = []
/** Everything of A and every office word that must never reach B. */
let aMarkers: Marker[] = []
const OFFICE_WORDS = {
  supervisorName: 'Made-up Supervisor Sergio Fittizio',
  supervisorEmail: 'sergio.supervisor@pr18-office.example.com',
  healthNote: 'Made-up office words: tannery batch twelve',
  holdNote: 'Made-up office note: supplier Zeta late',
  alphaHoldWords: 'Made-up words meant for Alpha only',
  gateLabel: 'Made-up office gate: Zeta tannery visit',
  overrideReason: 'Made-up override: planner Pietro decided',
  swatchNote: 'Made-up swatch note: lot Zeta-12',
}
const BETA_HOLD_WORDS = 'Made-up: we wait for the lining to arrive'
const office = { supervisorId: newId() }
const beta2 = { orderId: newId(), number: 'T-PR18-SO-B2', customerRef: 'T-PR18-PO-B2' }
const ANSWERED_AT = new Date('2026-11-16T15:00:00.000Z')

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

async function get(who: keyof typeof people, url: string, status = 200): Promise<Json> {
  const answer = await browsers[who].get(url)
  if (who !== 'alpha') seenByB.push({ url, body: answer.response.headers['content-type']?.toString().includes('json') ? answer.body : answer.response.body })
  expect(answer.status, `${who} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(status)
  return answer.body as Json
}

const day = (offsetDays: number) => businessDate(new Date(Date.now() + offsetDays * 86_400_000))
const setLimits = (partyId: string, level: string, urgencyOn: boolean, max: number) =>
  admin(`UPDATE "PortalSettings" SET "productionLevel" = $2::"ProductionShareLevel", "progressShared" = $3, "productionUrgencyOn" = $4, "productionUrgentMax" = $5, version = version + 1 WHERE "partyId" = $1`, [partyId, level, level !== 'STATUS', urgencyOn, max])

beforeAll(async () => {
  h = await startHarness('pr18_brand_portal')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
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
  // The production two-brand harness, through an app whose test sessions are the office's (it makes the work orders by route).
  officeApp = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof SESSIONS] ?? null) },
  )
  w = await productionTwoBrands({ db: h.db, database: h.database, app: officeApp, namespace: NS })
  expect([w.a.partyId, w.b.partyId]).toEqual([ids.a, ids.b])

  // Both portals on; A at + Progress (urgency on, quota 3), B at + Gates & dates (urgency on, quota 2).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })
  await setLimits(ids.a, 'PROGRESS', true, 3)
  await setLimits(ids.b, 'GATES', true, 2)

  // An office person: B's production supervisor (the customer's default and its order's own), who raised B's health.
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience) VALUES ($1, $2, $3, $4, $5, $6)', [office.supervisorId, T, OFFICE_WORDS.supervisorEmail, OFFICE_WORDS.supervisorName, 'ACTIVE', 'OFFICE'])
  await admin(`UPDATE "PortalSettings" SET "productionSupervisorId" = $2, "productionSupervisorSetAt" = now(), version = version + 1 WHERE "partyId" = $1`, [ids.b, office.supervisorId])
  await admin(
    `UPDATE "BrandOrderProduction" SET "supervisorId" = $2, "supervisorAssignedAt" = now(), stage = 'QUALITY', health = 'ON_TRACK', "healthAt" = now(),
       "healthSet" = 'AT_RISK', "healthReasonCode" = 'MATERIAL_LATE', "healthNote" = $3, "healthSetAt" = now(), "healthSetById" = $2, "healthSetUntil" = $4::date, version = version + 1
     WHERE key = $1`,
    [`brand-production:${w.b.salesOrderId}`, office.supervisorId, OFFICE_WORDS.healthNote, day(3)],
  )

  // B's second order: CONFIRMED, one line of our own jacket, no production row yet (the keeper has not run: read live).
  const bLine = await one<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [w.b.salesOrderLineId])
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: beta2.orderId, companyId: w.companyId, partyId: ids.b, number: beta2.number, customerRef: beta2.customerRef, status: 'CONFIRMED', orderDate: new Date('2026-10-01T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer B' }, shipTo: { name: 'Made-up store B' }, promiseDate: new Date('2026-12-20T00:00:00.000Z') },
        select: { id: true },
      })
      const lineId = newId()
      await tx.salesOrderLine.create({ data: { id: lineId, companyId: w.companyId, orderId: beta2.orderId, partyId: ids.b, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId: bLine.colourwayId, quantity: 6, unitPrice: '100.000000', netAmount: 60_000, vatRatePct: '22.00', vatAmount: 13_200 }, select: { id: true } })
      await tx.salesOrderLineSize.createMany({ data: [['50', 3], ['52', 3]].map(([size, quantity]) => ({ id: newId(), lineId, partyId: ids.b, size: size as string, quantity: quantity as number })) })
    }),
  )

  // Our production holds: B's own work order (words for B; the office's note), the mixed one (words typed for A only). B's work
  // order is held under its hold.
  const holdOf = (workOrderId: string, partyId: string | null, brandWords: string) => ({
    sql: `INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", "partyId", kind, "reasonCode", note, "brandWords", status, "placedAt", "placedById", version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 'PRODUCTION', 'MATERIAL_MISSING', $7, $8, 'ACTIVE', $9, $10, 1, now(), now())`,
    values: [newId(), T, w.companyId, w.siteId, workOrderId, partyId, OFFICE_WORDS.holdNote, brandWords, new Date('2026-11-12T08:00:00.000Z'), office.supervisorId],
  })
  // Quality releases on the mixed work order: B's cell 9 (B ordered 4 of that size), A's cell 5.
  const mixedCells = await admin<{ id: string; size: string; lineId: string }>('SELECT id, size, "salesOrderLineId" AS "lineId" FROM "WorkOrderSize" WHERE "workOrderId" = $1', [w.mixed.workOrderId])
  const release = (cellId: string, quantity: number) => ({
    sql: `INSERT INTO "QualityRelease" SELECT (jsonb_populate_record(NULL::"QualityRelease", to_jsonb(r) || jsonb_build_object('id', $1::uuid, 'workOrderId', $2::uuid, 'workOrderSizeId', $3::uuid, 'quantity', $4::int, 'number', NULL))).* FROM "QualityRelease" r WHERE r."tenantId" = $5 ORDER BY r.id LIMIT 1`,
    values: [newId(), w.mixed.workOrderId, cellId, quantity, T],
  })
  // Gates: B's PP sample waiting, lab passed, trims started before (with our reason), one in our own words; A's trims gate.
  const gate = (salesOrderId: string, partyId: string, kind: string, target: string, extra: { passedAt?: Date; overriddenAt?: Date; label?: string } = {}) => ({
    sql: `INSERT INTO "OrderGate" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, label, "targetDate", "passedAt", "passedById", "overriddenAt", "overriddenById", "overrideReason", version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6::"GateKind", $7, $8::date, $9, $10, $11, $12, $13, 1, now(), now())`,
    values: [newId(), T, w.companyId, partyId, salesOrderId, kind, extra.label ?? null, target, extra.passedAt ?? null, extra.passedAt ? office.supervisorId : null, extra.overriddenAt ?? null, extra.overriddenAt ? office.supervisorId : null, extra.overriddenAt ? OFFICE_WORDS.overrideReason : null],
  })
  // Swatches of the shared style: one to B (approved), one to A (refused).
  const item = await one<{ id: string }>('SELECT id FROM "Item" WHERE "tenantId" = $1 ORDER BY code LIMIT 1', [T])
  const swatch = (partyId: string, decision: string) => ({
    sql: `INSERT INTO "SampleSwatch" (id, "tenantId", "styleId", "partyId", kind, "itemId", note, "sentAt", decision, "decidedAt", version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, 'COLOUR', $5, $6, $7, $8::"SampleDecision", $9, 1, now(), now())`,
    values: [newId(), T, w.styleId, partyId, item.id, OFFICE_WORDS.swatchNote, new Date('2026-11-05T09:00:00.000Z'), decision, new Date('2026-11-07T09:00:00.000Z')],
  })
  await replica([
    holdOf(w.b.workOrderId, ids.b, BETA_HOLD_WORDS),
    holdOf(w.mixed.workOrderId, null, OFFICE_WORDS.alphaHoldWords),
    { sql: `UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldAt" = now(), "holdRecordType" = 'WorkOrderHold' WHERE id = $1`, values: [w.b.workOrderId] },
    ...mixedCells.map((cell) => release(cell.id, cell.lineId === w.b.salesOrderLineId ? 9 : 5)),
    gate(w.b.salesOrderId, ids.b, 'PP_SAMPLE', '2026-11-25'),
    gate(w.b.salesOrderId, ids.b, 'LAB_PASSED', '2026-11-10', { passedAt: new Date('2026-11-09T10:00:00.000Z') }),
    gate(w.b.salesOrderId, ids.b, 'TRIMS_IN', '2026-11-15', { overriddenAt: new Date('2026-11-12T10:00:00.000Z') }),
    gate(w.b.salesOrderId, ids.b, 'OTHER', '2026-11-20', { label: OFFICE_WORDS.gateLabel }),
    gate(w.a.salesOrderId, ids.a, 'TRIMS_IN', '2026-11-21'),
    swatch(ids.b, 'APPROVED'),
    swatch(ids.a, 'REJECTED'),
  ])

  // A published plan (the site's newest version) with slots on B's own work order (a cutting and a sewing operation), on the mixed
  // work order and on A's; and a working-plan slot on B's: only B's own published slots may reach B.
  const centres = await admin<{ id: string; kind: string }>(`SELECT id, kind::text FROM "WorkCentre" WHERE "siteId" = $1 AND kind IN ('CUTTING', 'SEWING') ORDER BY code`, [w.siteId])
  const cutCentre = centres.find((row) => row.kind === 'CUTTING')!.id
  const sewCentre = centres.find((row) => row.kind === 'SEWING')!.id
  const bRevision = (await one<{ styleRevisionId: string }>('SELECT "styleRevisionId" FROM "WorkOrder" WHERE id = $1', [w.b.workOrderId])).styleRevisionId
  const ops = { cut: newId(), sew: newId() }
  const operation = (id: string, seq: number, centre: string) => ({
    sql: `INSERT INTO "WorkOrderOperation" SELECT (jsonb_populate_record(NULL::"WorkOrderOperation", to_jsonb(o) || jsonb_build_object('id', $1::uuid, 'workOrderId', $2::uuid, 'siteId', $3::uuid, 'styleRevisionId', $4::uuid, 'seq', $5::int, 'workCentreId', $6::uuid, 'routingSeq', NULL, 'subcontractOrderId', NULL))).* FROM "WorkOrderOperation" o WHERE o."tenantId" = $7 ORDER BY o.id LIMIT 1`,
    values: [id, w.b.workOrderId, w.siteId, bRevision, seq, centre, T],
  })
  const number = (await one<{ next: number }>(`SELECT COALESCE(max(number), 0) + 1 AS next FROM "PlanVersion" WHERE "siteId" = $1 AND kind = 'PUBLISHED'`, [w.siteId])).next
  const published = newId()
  const working = (await admin<{ id: string }>(`SELECT id FROM "PlanVersion" WHERE "siteId" = $1 AND kind = 'WORKING' LIMIT 1`, [w.siteId]))[0]?.id ?? null
  const slot = (planVersionId: string, planKind: string, workOrderId: string, operationId: string | null, centre: string, start: string, end: string) => ({
    sql: `INSERT INTO "ScheduleSlot" (id, "tenantId", "siteId", "planVersionId", "planKind", "workOrderId", "workOrderOperationId", "workCentreId", "startAt", "endAt", minutes, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5::"PlanVersionKind", $6, $7, $8, $9, $10, 10, 1, now(), now())`,
    values: [newId(), T, w.siteId, planVersionId, planKind, workOrderId, operationId, centre, new Date(start), new Date(end)],
  })
  await replica([
    operation(ops.cut, 901, cutCentre),
    operation(ops.sew, 902, sewCentre),
    {
      sql: `INSERT INTO "PlanVersion" (id, "tenantId", "companyId", "siteId", kind, number, "coversFrom", "coversTo", "effectiveFrom", "publishedAt", version, "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'PUBLISHED', $5, '2026-11-18', '2026-12-31', now(), now(), 1, now(), now())`,
      values: [published, T, w.companyId, w.siteId, number],
    },
    slot(published, 'PUBLISHED', w.b.workOrderId, ops.cut, cutCentre, '2026-12-01T07:00:00.000Z', '2026-12-02T15:00:00.000Z'),
    slot(published, 'PUBLISHED', w.b.workOrderId, ops.sew, sewCentre, '2026-12-03T07:00:00.000Z', '2026-12-05T15:00:00.000Z'),
    slot(published, 'PUBLISHED', w.mixed.workOrderId, null, cutCentre, '2026-11-20T07:00:00.000Z', '2026-12-20T15:00:00.000Z'),
    slot(published, 'PUBLISHED', w.a.workOrderId, null, cutCentre, '2026-11-19T07:00:00.000Z', '2026-12-22T15:00:00.000Z'),
    ...(working ? [slot(working, 'WORKING', w.b.workOrderId, ops.cut, cutCentre, '2026-11-23T07:00:00.000Z', '2026-11-23T15:00:00.000Z')] : []),
  ])

  // The portals: company A's terms, and A's buyer, B's production person and B's designer, signed in.
  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.alpha, ids.a, ['customer-buyer'])
  await partnerPerson(people.beta, ids.b, ['customer-production'])
  await partnerPerson(people.betaDesigner, ids.b, ['customer-designer'])
  for (const person of Object.keys(people) as (keyof typeof people)[]) browsers[person] = await signedIn(people[person])

  aMarkers = [
    ...(await markersOf(h.db, ids.a)),
    { label: 'mixed work order', text: w.mixed.number },
    { label: 'mixed work order', text: w.mixed.workOrderId },
    { label: "B's work order", text: w.b.workOrderNumber },
    { label: "B's work order", text: w.b.workOrderId },
    ...Object.entries(OFFICE_WORDS).map(([label, text]) => ({ label: `office: ${label}`, text })),
    { label: 'office: supervisor id', text: office.supervisorId },
  ]
}, 360_000)

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

/** A's orders in production in A's company, regular ones in the list's order (date sent, made, number). */
const alphaRegular = async (urgent: readonly string[]) =>
  (
    await admin<{ id: string }>(
      `SELECT id::text FROM "SalesOrder" WHERE "partyId" = $1 AND "companyId" = $2 AND status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') AND NOT (id = ANY($3::uuid[])) ORDER BY "orderDate", "createdAt", number`,
      [ids.a, w.companyId, [...urgent]],
    )
  ).map((row) => row.id)

describe('B-PR-18 My production (GET /portal/production)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('PW-P01: B lists only its own orders in production, in its own order (Regular by the day sent), every row, no cut', async () => {
    const list = await get('beta', '/portal/production')
    expect(list).toMatchObject({ level: 'GATES', progressShared: true, urgencyOn: true, chip: 'ALL' })
    expect(list.items.map((row: Json) => row.id)).toEqual([beta2.orderId, w.b.salesOrderId])
    expect(list.count).toBe(2)
    expect(list.items.map((row: Json) => [row.number, row.customerRef])).toEqual([
      [beta2.number, beta2.customerRef],
      ['SEED-SO-B001', 'SEED-B-PO-1'],
    ])
    expect(list.live.events).toEqual(expect.arrayContaining(['brand_production.stage_reached', 'brand_production.urgency_changed']))
    expect(list.live.events.some((event: string) => event.includes('supervisor') || event.startsWith('production_issue'))).toBe(false)
  })

  it('reads the keeper’s row (stage, health raised with its reason code, You/Us, marks, the lock in our words) and the order with no row live', async () => {
    const list = await get('beta', '/portal/production')
    const [second, first] = list.items as Json[]
    if (!first || !second) throw new Error(`B lists both its orders: ${JSON.stringify(list.items).slice(0, 300)}`)
    // No production row yet: the stage read live, no since, no health, waiting on us; Regular.
    expect(second).toMatchObject({ stage: { code: 'PREPARING', since: null }, health: null, waiting: { code: 'US' }, urgency: { code: 'REGULAR', urgentRank: null, locked: false, byUs: false } })
    expect(second.pieces).toBe(6)
    expect(second.styles).toEqual([{ code: 'T-OWN-JKT-02', name: 'Our own production jacket' }])
    // The keeper's row: Quality check, the raise to At risk with its curated reason (never the note), waiting on us since the
    // problem; held under our hold; locked by us with the reason B reads.
    expect(first.stage).toMatchObject({ code: 'QUALITY', words: { en: 'Quality check' }, next: { code: 'READY' } })
    expect(first.health).toEqual({ code: 'AT_RISK', words: { it: 'A rischio', en: 'At risk' }, reason: { code: 'MATERIAL_LATE', words: PROMISE_REASON_WORDS.MATERIAL_LATE } })
    expect(first.waiting).toEqual({ code: 'US', words: { it: 'Tocca a noi', en: 'Waiting on us' }, since: '2026-10-29' })
    expect(first.marks).toMatchObject({ onHold: true, paused: false, partlyShipped: false, changePending: false })
    expect(first.urgency).toEqual({
      code: 'REGULAR',
      words: { it: 'Normale', en: 'Regular' },
      urgentRank: null,
      asked: false,
      askedWords: null,
      byUs: true,
      byUsWords: { it: 'Modificato da noi', en: 'Changed by us' },
      locked: true,
      lockWords: { it: `Riportato a normale da noi: ${w.production.lockReason}`, en: `Set to Regular by us: ${w.production.lockReason}` },
    })
    // + Gates & dates: the next waiting gate with its day; + Progress: how far its stage went (B's cell capped at what it ordered).
    expect(first.next).toEqual({ kind: 'GATE', stage: null, gate: 'PP_SAMPLE', date: '2026-11-25', words: { it: 'Campione di pre-produzione', en: 'PP sample' } })
    expect(first.count).toEqual({ done: 4, of: 10, words: { it: '4 di 10 controllati', en: '4 of 10 checked' } })
    // B's second order has no gate and no work order: the next stage, no planned day.
    expect(second.next).toMatchObject({ kind: 'STAGE', stage: 'CUTTING', date: null })
  })

  it('PW-11 (read part): "n of max used" counts only the customer’s own open orders — A 2 of 3, B 0 of 2 — and no answer holds a place', async () => {
    const alpha = await get('alpha', '/portal/production')
    expect(alpha.urgentUse).toEqual({ used: 2, max: 3, agreed: 0, left: 1, over: false, words: { it: '2 urgenti su 3', en: '2 of 3 urgent used' } })
    // Urgent in A's own order, then Regular by the day sent.
    expect(alpha.items.map((row: Json) => row.id)).toEqual([...w.production.urgent, ...(await alphaRegular(w.production.urgent))])
    expect(alpha.items.slice(0, 2).map((row: Json) => [row.urgency.code, row.urgency.urgentRank])).toEqual([
      ['URGENT', 1],
      ['URGENT', 2],
    ])
    expect(alpha.chips.find((chip: Json) => chip.chip === 'URGENT')).toMatchObject({ count: 2 })
    const beta = await get('beta', '/portal/production')
    expect(beta.urgentUse).toEqual({ used: 0, max: 2, agreed: 0, left: 2, over: false, words: { it: '0 urgenti su 2', en: '0 of 2 urgent used' } })
    expect(beta.chips.find((chip: Json) => chip.chip === 'URGENT')).toMatchObject({ count: 0 })
    for (const answer of [alpha, beta]) expect(forbiddenKeysIn(answer)).toEqual([])
    // A at + Progress: no gate and no planned day reach its rows (its trims gate stays below its level).
    expect(alpha.items.every((row: Json) => row.next === null || (row.next.kind === 'STAGE' && row.next.date === null))).toBe(true)
  })

  it('chips with counts and the search (their PO, our number, a style)', async () => {
    const list = await get('beta', '/portal/production?chip=ON_HOLD')
    expect(list.items.map((row: Json) => row.id)).toEqual([w.b.salesOrderId])
    expect(Object.fromEntries(list.chips.map((chip: Json) => [chip.chip, chip.count]))).toEqual({ ALL: 2, URGENT: 0, WAITING_ON_YOU: 0, AT_RISK: 1, LATE: 0, ON_HOLD: 1, READY: 0 })
    expect((await get('beta', `/portal/production?q=${encodeURIComponent('PR18-PO-B2')}`)).items.map((row: Json) => row.id)).toEqual([beta2.orderId])
    expect((await get('beta', '/portal/production?q=t-own-jkt')).count).toBe(2)
    expect((await get('beta', '/portal/production?q=SEED-SO-0001')).count).toBe(0)
  })

  it('a portal role without production is refused (403); the reads ask portal.production.view', async () => {
    await get('betaDesigner', '/portal/production', 403)
    await get('betaDesigner', `/portal/production/${w.b.salesOrderId}`, 403)
  })
})

describe('B-PR-18 one order (GET /portal/production/:orderId)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('PW-P01: another customer’s order is as unknown as a wrong id (404, the same words); its own opens', async () => {
    const foreign = await browsers.beta.get(`/portal/production/${w.a.salesOrderId}`)
    seenByB.push({ url: 'A order', body: foreign.body })
    const unknown = await browsers.beta.get(`/portal/production/${newId()}`)
    expect([foreign.status, unknown.status]).toEqual([404, 404])
    expect(foreign.body).toEqual(unknown.body)
    expect((await browsers.alpha.get(`/portal/production/${w.b.salesOrderId}`)).status).toBe(404)
    expect(await get('beta', `/portal/production/${w.b.salesOrderId}`)).toMatchObject({ order: { id: w.b.salesOrderId, number: 'SEED-SO-B001' }, inProduction: true })
  })

  it('PW-P02: holds in plain words (B’s own words on its own work order, the reason’s words on the mixed one), progress of B’s own cells only', async () => {
    const order = await get('beta', `/portal/production/${w.b.salesOrderId}`)
    const production = order.holds.filter((hold: Json) => hold.kind === 'PRODUCTION')
    expect(production.map((hold: Json) => hold.words.en)).toContain(BETA_HOLD_WORDS)
    expect(production.every((hold: Json) => hold.since === '2026-11-12')).toBe(true)
    // The mixed work order's hold reads its reason's words (never the words typed for A, never the note).
    expect(production.filter((hold: Json) => hold.words.en !== BETA_HOLD_WORDS).map((hold: Json) => hold.words.en)).toEqual([expect.stringMatching(/^(Material missing|Production hold)$/)])
    expect(order.marks).toMatchObject({ onHold: true, paused: false })
    // + Progress: B's own line only; the mixed work order's B cell (9 released) capped at B's 4 of that size; A's cell nowhere.
    expect(order.progress.lines.map((line: Json) => line.lineId)).toEqual([w.b.salesOrderLineId])
    expect(order.progress.whole.ordered).toBe(10)
    const sizes = Object.fromEntries(order.progress.lines[0].sizes.map((row: Json) => [row.size, row.inspected]))
    expect(sizes).toEqual({ '50': 0, '52': 4, '54': 0 })
    expect(forbiddenKeysIn(order)).toEqual([])
  })

  it('PW-P03: only B’s real gates (no gate in our own words, no override reason), its swatch answers as approvals, the published plan of its own work order only', async () => {
    const order = await get('beta', `/portal/production/${w.b.salesOrderId}`)
    expect(order.gates.gates.map((gate: Json) => [gate.kind, gate.state, gate.targetDate, gate.doneOn])).toEqual([
      ['LAB_PASSED', 'PASSED', '2026-11-10', '2026-11-09'],
      ['TRIMS_IN', 'STARTED_BEFORE', '2026-11-15', '2026-11-12'],
      ['PP_SAMPLE', 'WAITING_US', '2026-11-25', null],
    ])
    expect(order.gates.approvals).toEqual([{ kind: 'COLOUR', words: { it: 'Colore', en: 'Colour' }, state: 'APPROVED', stateWords: { it: 'Approvato', en: 'Approved' }, sentOn: '2026-11-05', answeredOn: '2026-11-07' }])
    // B's own work order's published slots only: not the working plan's 23 Nov, not the mixed work order's or A's wider slots.
    expect(order.gates.planned).toEqual({ cutStart: '2026-12-01', sewStart: '2026-12-03', finish: '2026-12-05' })
    expect(forbiddenKeysIn(order)).toEqual([])
    // A at + Progress: the gates section is not drawn (null), the progress is.
    const alpha = await get('alpha', `/portal/production/${w.a.salesOrderId}`)
    expect(alpha).toMatchObject({ level: 'PROGRESS', gates: null })
    expect(alpha.progress).not.toBeNull()
    expect(alpha.urgency).toMatchObject({ code: 'URGENT', urgentRank: 2, byUs: false, locked: false })
  })

  it('the stage keeps its words beside the promise and its moves; B’s second order (no row) reads live', async () => {
    const order = await get('beta', `/portal/production/${beta2.orderId}`)
    expect(order).toMatchObject({ inProduction: true, stage: { code: 'PREPARING', since: null, ahead: 0, aheadWords: null }, health: null, waiting: { code: 'US' }, urgency: { code: 'REGULAR' } })
    expect(order.order).toMatchObject({ number: beta2.number, promiseDate: '2026-12-20', promiseMoved: false })
    expect(Array.isArray(order.promiseHistory)).toBe(true)
    expect(order.gates.gates).toEqual([])
  })
})

describe('B-PR-18 the problems B reported (R-42, R-43)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('reads "Waiting on us since 29 Oct" while its problem is open', async () => {
    const list = await get('beta', '/portal/production')
    const first = list.items.find((row: Json) => row.id === w.b.salesOrderId)
    expect(first.problem).toEqual({ state: 'WAITING_ON_US', since: '2026-10-29', on: null, inOrder: null, words: { it: 'In attesa di una nostra risposta dal 29 ott', en: 'Waiting on us since 29 Oct' } })
    expect(list.items.find((row: Json) => row.id === beta2.orderId).problem).toBeNull()
  })

  it('a batch answered in one order’s thread: that order reads "Answered", the other "Answered in SEED-SO-B001"', async () => {
    // The problem was reported on both of B's orders in one batch; we wrote to B in SEED-SO-B001's thread, which answered both.
    const batchId = newId()
    const thread = await one<{ id: string }>(`SELECT id FROM "Thread" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1`, [w.b.salesOrderId])
    const issue = await one<Json>('SELECT * FROM "ProductionIssue" WHERE id = $1', [w.production.issue.id])
    await replica([
      { sql: `UPDATE "ProductionIssue" SET "batchId" = $2, status = 'ANSWERED', "answeredAt" = $3, version = version + 1 WHERE id = $1`, values: [w.production.issue.id, batchId, ANSWERED_AT] },
      {
        sql: `INSERT INTO "ProductionIssue" (id, "tenantId", "companyId", "partyId", "recordType", "recordId", "salesOrderId", "taskId", "messageId", source, "batchId", status, "raisedAt", "dueDate", "answeredAt", version, "createdAt", "updatedAt")
              VALUES ($1, $2, $3, $4, 'SalesOrder', $5, $5, $6, $7, 'BRAND', $8, 'ANSWERED', $9, $10, $11, 1, now(), now())`,
        values: [newId(), T, w.companyId, ids.b, beta2.orderId, issue.taskId, issue.messageId, batchId, issue.raisedAt, issue.dueDate, ANSWERED_AT],
      },
      {
        sql: `INSERT INTO "Message" (id, "tenantId", "threadId", "partyId", direction, audience, channel, "authorKind", "authorId", "authorName", "bodyText", at, "createdAt")
              VALUES ($1, $2, $3, $4, 'OUTBOUND', 'PARTNER', 'APP', 'USER', $5, $6, 'Made-up answer: the lining arrives on Monday.', $7, now())`,
        values: [newId(), T, thread.id, ids.b, office.supervisorId, OFFICE_WORDS.supervisorName, new Date(ANSWERED_AT.getTime() - 60_000)],
      },
    ])
    const list = await get('beta', '/portal/production')
    const first = list.items.find((row: Json) => row.id === w.b.salesOrderId)
    const second = list.items.find((row: Json) => row.id === beta2.orderId)
    expect(first.problem).toEqual({ state: 'ANSWERED', since: null, on: '2026-11-16', inOrder: null, words: { it: 'Risposto il 16 nov', en: 'Answered 16 Nov' } })
    expect(second.problem).toMatchObject({ state: 'ANSWERED_IN', on: '2026-11-16', inOrder: { id: w.b.salesOrderId, number: 'SEED-SO-B001', customerRef: 'SEED-B-PO-1' }, words: { en: 'Answered in SEED-SO-B001' } })
    // The answer names no person: whoever answered signs in the thread, never here.
    expect(JSON.stringify(list)).not.toContain(OFFICE_WORDS.supervisorName)
  })
})

describe('B-PR-18 the list’s file and the urgency switch', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('GET /portal/production?format=csv: every own row of the chip, written here, urgency included, nothing of A', async () => {
    const file = await browsers.beta.get('/portal/production?format=csv')
    seenByB.push({ url: 'csv', body: file.response.body })
    expect(file.status).toBe(200)
    expect(String(file.response.headers['content-type'])).toContain('text/csv')
    expect(String(file.response.headers['content-disposition'])).toMatch(/^attachment; filename="Your production \d{4}-\d{2}-\d{2}\.csv"/)
    const content = file.response.body
    expect(content).toContain('Urgency')
    expect(content).toContain(beta2.customerRef)
    expect(content).toContain('SEED-B-PO-1')
    expect(content).toContain(`Set to Regular by us: ${w.production.lockReason}`)
    expect(content).toContain('Waiting on us')
    expect(findMarkers(content, aMarkers)).toEqual([])
    const italian = await browsers.beta.get('/portal/production?format=csv&locale=it')
    seenByB.push({ url: 'csv it', body: italian.response.body })
    expect(italian.response.body).toContain('Urgenza')
  })

  it('urgency off (R-46): no urgency in the read, no urgency chip, the list by the day sent; the marks stay kept', async () => {
    await setLimits(ids.a, 'PROGRESS', false, 3)
    try {
      const alpha = await get('alpha', '/portal/production')
      expect(alpha).toMatchObject({ urgencyOn: false, urgentUse: null })
      expect(alpha.items.every((row: Json) => row.urgency === null)).toBe(true)
      expect(alpha.chips.some((chip: Json) => chip.chip === 'URGENT')).toBe(false)
      expect(alpha.items.map((row: Json) => row.id)).toEqual(await alphaRegular([]))
      const marks = await admin<{ urgency: string }>(`SELECT urgency::text FROM "BrandOrderProduction" WHERE "salesOrderId" = ANY($1::uuid[]) ORDER BY "urgentRank"`, [[...w.production.urgent]])
      expect(marks.map((row) => row.urgency)).toEqual(['URGENT', 'URGENT'])
      const file = await browsers.alpha.get('/portal/production?format=csv')
      expect(file.response.body).not.toContain('Urgency')
    } finally {
      await setLimits(ids.a, 'PROGRESS', true, 3)
    }
  })
})

describe('B-PR-18 the wall over every answer B got (PW-15)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('no answer or file B got holds A’s names, codes, numbers or ids, a supervisor, an office person or the office’s words', async () => {
    expect(seenByB.length).toBeGreaterThan(10)
    const found = seenByB.flatMap((answer) => findMarkers(answer.body, aMarkers).map((marker) => `${answer.url}: ${marker}`))
    expect(found).toEqual([])
    const keys = seenByB.flatMap((answer) => (typeof answer.body === 'object' ? forbiddenKeysIn(answer.body).map((key) => `${answer.url}: ${key}`) : []))
    expect(keys).toEqual([])
  })
})
