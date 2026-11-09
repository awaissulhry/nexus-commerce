import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShadeRule } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import type { CommandCaller } from '../../../core/command'
import { buildApp } from '../../../core/app'
import { testAuthenticator, withContextClient, type FloorContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { toleranceOfLot } from '../../inventory/hides/facts'
import { leatherToleranceFor } from '../../inventory/hides/tolerance'
import { minimumRemnantFor } from '../../inventory/remnants/size'
import { shadeRuleFor } from '../../inventory/reservations/shade'
import { incomingToleranceOfLot } from '../../quality/incoming/area-tolerance'
import { hidePhotoRequiredFor } from '../cutting/photo'
import { cuttingRulesFor } from './cutting-rules'

/**
 * The cutting follow-ups' settings (B-W2b-219; FC4:01–03) through the app's real routes on a throwaway PostgreSQL 17 database
 * from the migrations (the runtime and floor logins: row-level security, the floor's column grant on ProductionSettings, no
 * grant on PurchasingSettings, and B-W2b-204's checks are real), on the factory-db seeds up to production (plants A1 and B1
 * with their floor rules on the schema's defaults). A site's cutting rules (shade rule, photo before cutting, smallest
 * remnant) and the leather area tolerance where a purchase order line names none; their readers in the office's and the
 * floor's scope. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/settings`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b219-cutting-rules'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const operator = idOf('worker:A1:operator')
const device = idOf('device:A1:cutting')
const leather = idOf('product:item:leather')

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(['production.settings.view', 'production.settings.manage'])]),
  viewer: office([grant(['production.settings.view'])]),
  buyer: office([grant(['purchasing.view', 'purchasing.manage'])]),
  buyerA: office([grant(['purchasing.view', 'purchasing.manage'], [companyA])]),
  reader: office([grant(['purchasing.view'])]),
}
const floorContext: FloorContext = { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: device, grants: [grant(['floor.work'], [companyA], [siteA1])], requestId: 'w2b219-floor' }
const floorScope = { audience: 'floor' as const, tenantId: T, actorId: operator, siteId: siteA1 }
const officeScope = { audience: 'office' as const, tenantId: T, actorId: newId() }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const key = () => `t-${run}-${++serial}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const rulesUrl = `/production/settings/${siteA1}/cutting-rules`
const audits = () => admin('SELECT action, before, after, reason FROM "AuditLog" WHERE "recordType" = \'ProductionSettings\' AND "recordId" = $1 AND action = \'production.changeCuttingRules\' ORDER BY at, id', [siteA1])
const events = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
let lotId = ''

beforeAll(async () => {
  h = await startHarness('w2b219_cutting_rules')
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  // A made-up leather lot received with no purchase order line (nothing says its tolerance).
  lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'DB-T-1', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, T, companyA, siteA1, leather, idOf('product:item-colour:leather:BLK'), `T-${run}-LOT`],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...SHADE_RULES].sort()).toEqual(Object.values(ShadeRule).sort())
  })
})

describe("a site's cutting rules (FC4:01, FC4:02): the Cutting card of Floor rules & codes", () => {
  it('reads the defaults in words; a viewer reads them and may not change them', async () => {
    const view = await ok('viewer', 'GET', rulesUrl)
    expect(view).toMatchObject({ site: { id: siteA1 }, rules: { shadeRule: 'ORDER', hidePhotoRequired: false, minimumRemnant: { area: '10.0000', uom: 'DM2' } }, isDefault: false, canManage: false })
    expect(view.words).toEqual(expect.arrayContaining([expect.stringContaining('one shade lot per order'), expect.stringContaining('optional'), expect.stringContaining('10.00 dm²')]))
    await no('viewer', 'POST', rulesUrl, { shadeRule: 'OFF', version: view.version }, 403)
    // The readers in the floor's scope (the column grant) on the defaults.
    await h.database.withScope(floorScope, async (client) => {
      expect(await shadeRuleFor(client, siteA1)).toBe('ORDER')
      expect(await hidePhotoRequiredFor(client, siteA1)).toBe(false)
      expect(await minimumRemnantFor(client, siteA1)).toEqual({ area: '10.0000', uom: 'DM2', setting: true })
    })
  })

  it('changes them in ONE command at the version read: audited before → after with the reason, told, read by the floor', async () => {
    const before = await ok('manager', 'GET', rulesUrl)
    const answer = await ok('manager', 'POST', rulesUrl, { shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnantArea: '0.25', minimumRemnantUom: 'M2', reason: 'Monocolour collection', version: before.version })
    expect(answer).toMatchObject({ changed: true, changedFields: ['shadeRule', 'hidePhotoRequired', 'minimumRemnant'], rules: { shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnant: { area: '0.2500', uom: 'M2' } }, version: before.version + 1 })
    const [audit] = (await audits()).slice(-1)
    expect(audit).toMatchObject({ before: { shadeRule: 'ORDER', hidePhotoRequired: false, minimumRemnant: { area: '10.0000', uom: 'DM2' } }, after: { shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnant: { area: '0.2500', uom: 'M2' } }, reason: 'Monocolour collection' })
    expect((await events('production.cutting_rules_changed')).at(-1)!.payload).toEqual({ siteId: siteA1, fields: ['shadeRule', 'hidePhotoRequired', 'minimumRemnant'], shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnantArea: '0.2500', minimumRemnantUom: 'M2' })
    await h.database.withScope(floorScope, async (client) => {
      expect(await shadeRuleFor(client, siteA1)).toBe('GARMENT')
      expect(await hidePhotoRequiredFor(client, siteA1)).toBe(true)
      expect(await minimumRemnantFor(client, siteA1)).toEqual({ area: '0.2500', uom: 'M2', setting: true })
      expect((await cuttingRulesFor(client, siteA1)).isDefault).toBe(false)
    })
    // The same values again change nothing: no audit, no event, no version.
    const again = await ok('manager', 'POST', rulesUrl, { shadeRule: 'GARMENT', minimumRemnantArea: '0.250', minimumRemnantUom: 'M2', version: answer.version })
    expect(again).toMatchObject({ changed: false, changedFields: [], version: answer.version })
    expect(await audits()).toHaveLength(1)
  })

  it('refuses in words: a minimum above 10 m² or with no unit, a rule it does not know, a stale version', async () => {
    const now = await ok('manager', 'GET', rulesUrl)
    const large = await no('manager', 'POST', rulesUrl, { minimumRemnantArea: '11', minimumRemnantUom: 'M2', version: now.version }, 400)
    expect(large.issues).toEqual([expect.objectContaining({ path: 'body/minimumRemnantArea', message: expect.stringContaining('at most 10 m²') })])
    expect((await no('manager', 'POST', rulesUrl, { minimumRemnantArea: '0', minimumRemnantUom: 'DM2', version: now.version }, 400)).issues[0].path).toBe('body/minimumRemnantArea')
    expect((await no('manager', 'POST', rulesUrl, { minimumRemnantArea: '5', version: now.version }, 400)).issues[0].path).toBe('body/minimumRemnantUom')
    await no('manager', 'POST', rulesUrl, { shadeRule: 'LOT', version: now.version }, 400)
    expect((await no('manager', 'POST', rulesUrl, { shadeRule: 'OFF', version: now.version - 1 }, 409)).code).toBe('conflict')
    // Back to the defaults for the rest of the file.
    await ok('manager', 'POST', rulesUrl, { shadeRule: 'ORDER', hidePhotoRequired: false, minimumRemnantArea: '10', minimumRemnantUom: 'DM2', version: now.version })
  })

  it('the database keeps the same bounds (a write past the API is refused in words by its check)', async () => {
    await expect(admin(`UPDATE "ProductionSettings" SET "minimumRemnantArea" = 20, "minimumRemnantUom" = 'M2' WHERE id = $1`, [siteA1])).rejects.toThrow(/at most 10 m²/)
  })
})

describe('the leather area tolerance where a purchase order line names none (FC4:03)', () => {
  const url = '/purchasing/settings/leather-tolerance'
  const lotTolerance = (scope: typeof floorScope | typeof officeScope) => h.database.withScope(scope, (client) => toleranceOfLot(client, lotId))

  it('reads 2 % while nothing is set, in the office and (never failing) on the floor', async () => {
    expect(await ok('reader', 'GET', `${url}?companyId=${companyA}`)).toMatchObject({ companyId: companyA, percent: '2.00', from: 'DEFAULT', company: null, tenant: null, mayChange: false })
    expect(await lotTolerance(officeScope)).toEqual({ percent: '2.00', from: 'DEFAULT', setting: 'DEFAULT' })
    expect(await lotTolerance(floorScope)).toEqual({ percent: '2.00', from: 'DEFAULT', setting: 'DEFAULT' })
  })

  it('every company\'s value, then the company\'s own: audited, told, read by the incoming check and the re-measure', async () => {
    // Every company's row: only a role over every company.
    expect((await no('buyerA', 'PUT', url, { companyId: null, percent: '2.5' }, 403)).message).toContain('every company')
    const tenant = await ok('buyer', 'PUT', url, { companyId: null, percent: '2.5' })
    expect(tenant).toMatchObject({ companyId: null, percent: '2.50', from: 'TENANT', changed: true })
    expect(await lotTolerance(officeScope)).toEqual({ percent: '2.50', from: 'DEFAULT', setting: 'TENANT' })
    const own = await ok('buyerA', 'PUT', url, { companyId: companyA, percent: '3.5' })
    expect(own).toMatchObject({ companyId: companyA, percent: '3.50', from: 'COMPANY', company: { percent: '3.50' }, tenant: { percent: '2.50' }, changed: true })
    expect(await lotTolerance(officeScope)).toEqual({ percent: '3.50', from: 'DEFAULT', setting: 'COMPANY' })
    // Company B still follows every company's.
    expect((await ok('reader', 'GET', `${url}?companyId=${companyB}`)).percent).toBe('2.50')
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'PurchasingSettings' AND "recordId" = $1 AND action = 'purchasing.leatherTolerance'`, [companyA])
    expect(audit).toEqual({ before: { leatherAreaTolerancePct: null }, after: { leatherAreaTolerancePct: '3.50' } })
    expect((await events('purchasing_settings.leather_tolerance_changed')).map((event) => event.payload)).toEqual([
      { settingsId: T, companyId: null, leatherAreaTolerancePct: '2.50' },
      { settingsId: companyA, companyId: companyA, leatherAreaTolerancePct: '3.50' },
    ])
    // The same value again changes nothing.
    expect(await ok('buyerA', 'PUT', url, { companyId: companyA, percent: '3.50', version: own.company.version })).toMatchObject({ changed: false, company: { version: own.company.version } })
  })

  it('the floor bench reads it through the tenant\'s system scope (no grant on the table), its own transaction gives 2 %', async () => {
    // As a request is (core/app.ts): its client follows its context, so a view of it as the tenant's system reads as the system.
    const floor: CommandCaller = { factoryContext: floorContext, withClient(work) { return withContextClient(h.database, this.factoryContext, work) } }
    expect(await leatherToleranceFor(floor, companyA)).toEqual({ percent: '3.50', from: 'COMPANY' })
    expect(await floor.withClient((client) => incomingToleranceOfLot(floor, client, { id: lotId, companyId: companyA }))).toEqual({ percent: '3.50', from: 'DEFAULT', setting: 'COMPANY' })
    // Read in the floor's own transaction the table is never touched: the default answers, nothing fails.
    expect(await lotTolerance(floorScope)).toEqual({ percent: '2.00', from: 'DEFAULT', setting: 'DEFAULT' })
  })

  it('refuses in words: above 100, three decimals, a stale version; null clears the company\'s own', async () => {
    const now = await ok('reader', 'GET', `${url}?companyId=${companyA}`)
    expect((await no('buyerA', 'PUT', url, { companyId: companyA, percent: '120', version: now.company.version }, 400)).issues[0].path).toBe('body/percent')
    await no('buyerA', 'PUT', url, { companyId: companyA, percent: '2.555', version: now.company.version }, 400)
    expect((await no('buyerA', 'PUT', url, { companyId: companyA, percent: '4', version: now.company.version - 1 }, 409)).code).toBe('conflict')
    await no('reader', 'PUT', url, { companyId: companyA, percent: '4', version: now.company.version }, 403)
    const cleared = await ok('buyerA', 'PUT', url, { companyId: companyA, percent: null, version: now.company.version })
    expect(cleared).toMatchObject({ percent: '2.50', from: 'TENANT', company: { percent: null } })
    // The database keeps the same bound.
    await expect(admin(`UPDATE "PurchasingSettings" SET "leatherAreaTolerancePct" = 101 WHERE id = $1`, [companyA])).rejects.toThrow(/0 to 100 percent/)
  })
})
