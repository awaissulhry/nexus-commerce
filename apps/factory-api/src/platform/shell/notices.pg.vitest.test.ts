import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { eInvoicingSettings } from '../../modules/invoicing/test-mode/settings'
import { getTestModes } from '../../modules/shipping/test-mode/test-mode'

/**
 * The office shell's notices (B-W2b-F49; Owner rule W2b-6 "a test mode shows a banner on every page while it is on", for
 * everyone) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security and W2b-6's guards are real), the factory-db core seed of one tenant (Seed Company A with
 * plant A1, Seed Company B with plant B1), sessions from the test authenticator built from the role templates as they ship.
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/shell`.
 *
 *   for all     an admin, a buyer and a floor supervisor (none holds shipping.view or invoices.view) read what is in test
 *               mode where they work: names only, no settings
 *   scope       a person of company B never sees company A's, even when asking for it; a person limited to plant B1 sees no
 *               other plant's carrier; the company the shell names narrows the answer
 *   one rule    the notices say what the settings pages say (shipping's and e-invoicing's own reads); the carrier's settings
 *               ask Carriers & shipping's right (shipping.settings.view), so the admin who switches a site reads them
 *   refused     floor, partner and link sessions 403, no session 401
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'shell-notices'
const idOf = (key: string) => seedUuid(ns, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1') }
const switcher = newId()

const permissionsOf = (role: string): Permission[] => [...templateOf(role)!.permissions] as Permission[]
const grant = (permissions: Permission[], scope: Partial<Omit<Grant, 'permissions'>> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  owner: office([grant(permissionsOf('owner'))]),
  admin: office([grant(permissionsOf('admin'))]),
  buyer: office([grant(permissionsOf('buyer'))]),
  floorSupervisor: office([grant(permissionsOf('floor_supervisor'))]),
  companyB: office([grant(permissionsOf('owner'), { companies: [T.companyB] })]),
  plantB1: office([grant(permissionsOf('buyer'), { sites: [T.siteB1] })]),
  shipmentsOnly: office([grant(['shipping.view'])]),
  noRole: office([]),
  floor: { audience: 'floor', tenantId: T.tenant, actorId: newId(), siteId: T.siteA1, deviceId: newId(), grants: [grant(permissionsOf('floor_supervisor'), { companies: [T.companyA], sites: [T.siteA1] })] },
  partner: { audience: 'partner', tenantId: T.tenant, actorId: newId(), partyId: newId(), grants: [grant(['portal.view' as Permission])] },
  link: { audience: 'link', tenantId: T.tenant, linkId: newId(), partyId: newId(), record: { type: 'Shipment', id: newId() }, grants: [] },
}

type Notices = { testModes: { carrierSites: { siteId: string; name: string }[]; eInvoicingCompanies: { companyId: string; name: string }[] } }
const admin = async (sql: string, values: unknown[] = []) => (await db.admin.query(sql, values)).rows as Array<Record<string, unknown>>
const call = (session: string | null, url: string) => app.inject({ method: 'GET', url, headers: session ? { 'x-test-session': session } : {} })
async function notices(session: string, companyId?: string): Promise<Notices> {
  const response = await call(session, `/shell/notices${companyId ? `?companyId=${companyId}` : ''}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const A1 = { siteId: T.siteA1, name: 'Seed plant A1' }
const B1 = { siteId: T.siteB1, name: 'Seed plant B1' }
const A = { companyId: T.companyA, name: 'Seed Company A' }
const B = { companyId: T.companyB, name: 'Seed Company B' }

/** Plant B1's carrier and Seed Company B's e-invoicing live (as their switches leave them), or back in test mode. */
async function companyBLive(live: boolean) {
  await admin(
    `UPDATE "ShippingSettings" SET "testMode" = $2, "liveSince" = CASE WHEN $2 THEN NULL ELSE now() - interval '1 hour' END, "liveSetById" = CASE WHEN $2 THEN NULL ELSE $3::uuid END WHERE id = $1`,
    [T.siteB1, !live, switcher],
  )
  await admin(
    `UPDATE "CompanyEInvoiceSettings" SET "testMode" = $2, "liveSince" = CASE WHEN $2 THEN NULL ELSE now() - interval '1 hour' END, "liveSetById" = CASE WHEN $2 THEN NULL ELSE $3::uuid END WHERE id = $1`,
    [T.companyB, !live, switcher],
  )
}

beforeAll(async () => {
  db = await migratedDatabase('shell_notices')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, 'switcher.f49@example.com', 'Made-up Switcher', 'ACTIVE', 'en')`, [switcher, T.tenant])
  // Plant B1 and Seed Company B have settings rows (plant A1 and Seed Company A none: test mode by default).
  await admin(`INSERT INTO "ShippingSettings" (id, "tenantId", "companyId", "siteId", "senderAddress") VALUES ($1, $2, $3, $1, $4::jsonb)`, [
    T.siteB1,
    T.tenant,
    T.companyB,
    JSON.stringify({ name: 'Seed Company B', line1: 'Via Esempio 12', postalCode: '00000', city: 'Seedville', country: 'IT' }),
  ])
  await admin(`INSERT INTO "CompanyEInvoiceSettings" (id, "tenantId", "companyId") VALUES ($1, $2, $1)`, [T.companyB, T.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('every office person reads the test modes where they work (B-W2b-F49)', () => {
  it('an admin, a buyer and a floor supervisor, who read neither test mode, see both: names only, no settings', async () => {
    for (const role of ['admin', 'buyer', 'floor_supervisor']) {
      // The premise: none of these templates reads the carrier's or e-invoicing's settings.
      expect(templateOf(role)!.permissions, role).not.toContain('shipping.view')
      expect(templateOf(role)!.permissions, role).not.toContain('invoices.view')
    }
    for (const session of ['admin', 'buyer', 'floorSupervisor']) {
      expect(await notices(session), session).toEqual({ testModes: { carrierSites: [A1, B1], eInvoicingCompanies: [A, B] } })
      // The settings stay behind their pages' rights: e-invoicing's invoices.view (Finance settings).
      expect((await call(session, '/invoicing/e-invoicing/settings')).statusCode, session).toBe(403)
    }
    // The carrier's settings ask Carriers & shipping's own right, shipping.settings.view: the admin, who switches a site's
    // test mode (shipping.settings.manage), reads its card; a buyer and a floor supervisor do not, nor shipping.view alone.
    expect(templateOf('admin')!.permissions).toContain('shipping.settings.manage')
    expect(Object.fromEntries(app.factoryRouteManifest.routes())['GET /shipping/test-mode']).toMatchObject({ permission: 'shipping.settings.view' })
    const admin = callerFor(database, { ...(SESSIONS.admin as Extract<SessionContext, { audience: 'office' }>), requestId: newId() })
    const read = (await getTestModes(admin, {}, 'test')).sites.map((site) => `${site.code}:${site.testMode}`)
    expect(read.sort()).toEqual(['A1:true', 'B1:true'])
    for (const session of ['buyer', 'floorSupervisor', 'shipmentsOnly']) expect((await call(session, '/shipping/test-mode')).statusCode, session).toBe(403)
    // A person without any role reaches no company and no site: nothing to say.
    expect(await notices('noRole')).toEqual({ testModes: { carrierSites: [], eInvoicingCompanies: [] } })
  })

  it('lists only what is in test mode: plant B1 and Seed Company B live leave plant A1 and Seed Company A', async () => {
    await companyBLive(true)
    try {
      expect(await notices('admin')).toEqual({ testModes: { carrierSites: [A1], eInvoicingCompanies: [A] } })
      expect(await notices('admin', T.companyB)).toEqual({ testModes: { carrierSites: [], eInvoicingCompanies: [] } })
    } finally {
      await companyBLive(false)
    }
    expect(await notices('admin', T.companyB)).toEqual({ testModes: { carrierSites: [B1], eInvoicingCompanies: [B] } })
  })

  it('narrows to the company the shell names; a person of company B never sees company A’s, even when asking for it', async () => {
    expect(await notices('owner', T.companyA)).toEqual({ testModes: { carrierSites: [A1], eInvoicingCompanies: [A] } })
    expect(await notices('companyB')).toEqual({ testModes: { carrierSites: [B1], eInvoicingCompanies: [B] } })
    expect(await notices('companyB', T.companyA)).toEqual({ testModes: { carrierSites: [], eInvoicingCompanies: [] } })
    // Limited to plant B1 (every company): no other plant's carrier; e-invoicing is per company.
    expect(await notices('plantB1')).toEqual({ testModes: { carrierSites: [B1], eInvoicingCompanies: [A, B] } })
    // Not a company id: refused in words by the contract.
    expect((await call('owner', '/shell/notices?companyId=SCA')).statusCode).toBe(400)
  })

  it('says what the settings pages say (one read for both)', async () => {
    await companyBLive(true)
    try {
      const owner = callerFor(database, { ...(SESSIONS.owner as Extract<SessionContext, { audience: 'office' }>), requestId: newId() })
      const sites = (await getTestModes(owner, {}, 'test')).sites.filter((site) => site.testMode).map((site) => ({ siteId: site.siteId, name: site.name }))
      const companies = (await eInvoicingSettings({ liveProviderReady: false }, owner)).companies.filter((company) => company.state.code === 'TEST').map((company) => ({ companyId: company.companyId, name: company.legalName }))
      expect(sites).toEqual([A1])
      expect(companies).toEqual([A])
      expect(await notices('owner')).toEqual({ testModes: { carrierSites: sites, eInvoicingCompanies: companies } })
    } finally {
      await companyBLive(false)
    }
  })

  it('refuses floor, partner and link sessions (403) and a request without a session (401)', async () => {
    for (const session of ['floor', 'partner', 'link']) expect((await call(session, '/shell/notices')).statusCode, session).toBe(403)
    expect((await call(null, '/shell/notices')).statusCode).toBe(401)
  })
})
