import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { expect } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
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
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { productionTwoBrands, twoBrandIds, twoBrandSessions, type ProductionTwoBrands } from './two-brands'

/**
 * B-PR-22a/b — the world of the customer-urgency tests (production plan §3 "Customer urgency"; wall tests PW-11, PW-18; the Owner
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should
 * be able to see it all. And manage it all as well."), on the local stack through the real app:
 *
 *   - the seeds up to shipping and the production two-brand harness (./two-brands.ts): brand A = the seeds' customer P1 (its
 *     SEED-SO-0002 and a new order Urgent 1st and 2nd, marked in one batch), brand B = the threads' second brand (SEED-SO-B001
 *     set back to Regular and locked by us), a work order each, a legacy mixed one;
 *   - both portals on, A's urgency on (quota 3), B's urgency on (quota 2);
 *   - `addOrder`: a CONFIRMED order of a brand with one goods line and its production state (Regular), as the keeper makes it;
 *   - portal people signed in by code (`portalPerson`), office people signed in with two-factor for the step-up routes
 *     (`officePerson`, optionally limited to some customers), and the office test sessions `office.all`, `office.p1`,
 *     `office.p2` on `officeApp` (reads only need them).
 *
 * Every name, address and number is made up (example.com; no real company).
 */

export interface UrgencyWorld {
  readonly h: Harness
  readonly officeApp: FastifyInstance
  readonly w: ProductionTwoBrands
  readonly tenant: TestTenant
  readonly ids: { readonly tenantId: string; readonly a: string; readonly b: string }
  readonly namespace: string
  admin<R = Record<string, any>>(sql: string, values?: unknown[]): Promise<R[]>
  /** Statements with the database's rules off, in one transaction (what the app would never make, as the harness does). */
  replica(statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void>
  /** A CONFIRMED order of a brand (one goods line of the harness's own jacket, 4 pieces) with its production state, Regular. */
  addOrder(partyId: string, label: string, orderDate: string): Promise<{ readonly orderId: string; readonly number: string; readonly lineId: string }>
  /** A portal person of a brand with these portal roles, signed in by code (company A's portal). */
  portalPerson(email: string, partyId: string, roleKeys: readonly string[]): Promise<{ readonly id: string; readonly browser: Browser }>
  /** An office person signed in with two-factor (its secret for the step-up), with a system role over every company, or only over some customers. */
  officePerson(email: string, roleKey: string, parties?: readonly string[]): Promise<{ readonly id: string; readonly browser: Browser; stepUp(): Promise<void> }>
  close(): Promise<void>
}

const OFFICE_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.link === undefined && definition.partner === undefined).map((definition) => definition.name) as Permission[]

export async function urgencyWorld(label: string, namespace: string): Promise<UrgencyWorld> {
  const ids = twoBrandIds(namespace)
  const T = ids.tenantId
  const companyA = seedUuid(namespace, 'company:A')
  const sessions = twoBrandSessions(T, ids.a, ids.b, OFFICE_PERMISSIONS)
  const h = await startHarness(label)
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace })
  await seedFiles({ db: h.database, namespace })
  await seedShipping({ db: h.database, namespace })
  await seedProduction({ db: h.database, namespace })
  await seedNumbering({ db: h.database, namespace })
  await seedReasons({ db: h.database, namespace })
  const tenant: TestTenant = { id: T, slug: namespace, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${namespace}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${namespace}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
  })
  // fix-pr-4: the harness's file store at test rates (the seeded R2 account keeps the production burst of 10: Approve N's world
  // stores and copies more files than that in its first minute — "the file store is not available right now").
  await h.db.admin.query(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // fix-pr-4: the test sessions' app carries the harness's office sign-in (the sessions stay the test's): the portal and production
  // routes read the app's clock from it (platform/portal/tasks/clock appClock) and answered 503 "Office sign-in is not configured".
  const officeApp = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, officeAuth: h.auth, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions[String(request.headers['x-test-session']) as keyof typeof sessions] ?? null) },
  )
  const w = await productionTwoBrands({ db: h.db, database: h.database, app: officeApp, namespace })
  // ── fix-pr-5: the copied jacket's certificate ───────────────────────────────────────────────────────────────────────────────
  // The world's own jacket (T-OWN-JKT-02) is a copy of SEED-JKT-02, a category II PPE garment: the full seed covers that style with
  // a certificate (seed/quality.ts SEED-CERT-0003, EN 17092-3 class AA), the copy had none, so every date proposed for an order of
  // it was refused at CERT-COVERAGE before the path a test meant. The copy gets the same certificate, made up and held by the
  // company (our own collection, no brand), covering all its colourways and sizes.
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const certificateId = seedUuid(namespace, 'urgency-world:certificate:T-OWN-JKT-02')
      const at = h.clock.now()
      await tx.certificate.create({
        data: {
          id: certificateId,
          companyId: w.companyId,
          standard: 'EN 17092-3:2020',
          ppeClass: 'AA',
          number: 'T-OWN-CERT-0002',
          notifiedBodyName: 'Made-up Notified Body',
          notifiedBodyNumber: '0000',
          modelReference: 'T-OWN-JKT-02',
          validFrom: new Date('2026-01-15T00:00:00.000Z'),
          validTo: new Date('2031-01-14T00:00:00.000Z'),
          status: 'VALID',
          statusChangedAt: at,
          createdAt: at,
          updatedAt: at,
          createdById: actorId,
        },
        select: { id: true },
      })
      await tx.certificateCoverage.create({ data: { id: seedUuid(namespace, 'urgency-world:coverage:T-OWN-JKT-02'), certificateId, styleId: w.styleId, createdAt: at, updatedAt: at, createdById: actorId }, select: { id: true } })
    }),
  )
  // ── end fix-pr-5 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  const admin = async <R = Record<string, any>>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
  const replica = async (statements: readonly { readonly sql: string; readonly values?: unknown[] }[]): Promise<void> => {
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

  // Both portals on; A's urgency on (quota 3), B's on (quota 2).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    for (const partyId of [ids.a, ids.b]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })
  for (const [partyId, max] of [[ids.a, 3], [ids.b, 2]] as const) {
    await admin(`UPDATE "PortalSettings" SET "productionLevel" = 'PROGRESS', "productionUrgencyOn" = true, "productionUrgentMax" = $2, version = version + 1 WHERE "partyId" = $1`, [partyId, max])
  }

  const colourway = (await admin<{ colourwayId: string }>('SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [w.b.salesOrderLineId]))[0]!.colourwayId
  const addOrder: UrgencyWorld['addOrder'] = async (partyId, orderLabel, orderDate) => {
    const orderId = newId()
    const lineId = newId()
    const number = `T-URG-${orderLabel}-${orderId.slice(-4)}`
    await h.database.withScope({ audience: 'office', tenantId: T, actorId }, (client) =>
      client.$transaction(async (tx) => {
        await tx.salesOrder.create({
          data: { id: orderId, companyId: w.companyId, partyId, number, customerRef: `T-URG-PO-${orderLabel}`, status: 'CONFIRMED', orderDate: new Date(`${orderDate}T00:00:00.000Z`), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up store' }, promiseDate: new Date('2026-12-20T00:00:00.000Z') },
          select: { id: true },
        })
        await tx.salesOrderLine.create({ data: { id: lineId, companyId: w.companyId, orderId, partyId, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId: colourway, quantity: 4, unitPrice: '100.000000', netAmount: 40_000, vatRatePct: '22.00', vatAmount: 8_800 }, select: { id: true } })
        await tx.salesOrderLineSize.createMany({ data: [['50', 2], ['52', 2]].map(([size, quantity]) => ({ id: newId(), lineId, partyId, size: size as string, quantity: quantity as number })) })
        await tx.brandOrderProduction.create({ data: { id: newId(), companyId: w.companyId, partyId, salesOrderId: orderId, key: `brand-production:${orderId}`, waitingOn: 'US', waitingSince: h.clock.now(), createdById: actorId }, select: { id: true } })
      }),
    )
    return { orderId, number, lineId }
  }

  await portalWorld(h, tenant)
  freshGuard(h)

  const portalPerson: UrgencyWorld['portalPerson'] = async (email, partyId, roleKeys) => {
    const id = newId()
    await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
      await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
      for (const roleKey of roleKeys) {
        const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
        await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
      }
    })
    const browser = await portalBrowser(h)
    h.clock.advance(61_000)
    expect((await browser.post('/portal/signin/start', { tenant: namespace, company: 'SCA', email })).status).toBe(200)
    await h.auth.settled()
    const answer = await browser.post('/portal/signin/code', { tenant: namespace, company: 'SCA', email, code: mailedCode(h, email)!.code })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const terms = await browser.get('/portal/terms?locale=en')
    expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
    return { id, browser }
  }

  const officePerson: UrgencyWorld['officePerson'] = async (email, roleKey, parties) => {
    const person = await addUser(h, tenant, { email })
    await h.database.withScope({ audience: 'office', tenantId: T, actorId: person.id }, async (client) => {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
      // fix-pr-5: valid from a minute before the earlier of the world's clock and the server's: the sign-ins move the world's clock
      // minutes ahead, and the internal approvals engine (a second person's yes) reads the roles on the server clock.
      const validFrom = new Date(Math.min(h.clock.now().getTime(), Date.now()) - 60_000)
      await client.roleAssignment.create({ data: { id: newId(), userId: person.id, roleId: role.id, allCompanies: true, partyIds: parties ? [...parties] : [], validFrom }, select: { id: true } })
    })
    const browser = new Browser(h.app)
    const signed = await browser.signIn(namespace, person.email, person.password)
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    const secret = await enrolTotp(h, browser)
    return { id: person.id, browser, stepUp: () => stepUp(h, browser, secret) }
  }

  return {
    h,
    officeApp,
    w,
    tenant,
    ids,
    namespace,
    admin,
    replica,
    addOrder,
    portalPerson,
    officePerson,
    async close() {
      useAbuseGuard(undefined)
      usePortalOptions({})
      await officeApp.close()
      await h.close()
    },
  }
}
