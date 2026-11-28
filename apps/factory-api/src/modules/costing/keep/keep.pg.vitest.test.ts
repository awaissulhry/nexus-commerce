import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCostSheets } from '../../../../../../packages/factory-db/seed/cost-sheets'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'

/**
 * owb-pd3 steps 3.1 + 3.2 on the local stack, with the app's real routes and the runtime login (row-level security, the redefined
 * factory_cost_sheet_guard and factory_costing_settings_one_keeper_check are real): the cost sheets seed (the jacket JKT-01 revision
 * 1 of company A with complete inputs) and the pricing seed (customer P1 priced from SEED-PL-P1: JKT-01 420.00, its RED colourway
 * 430.00). Price against cost: refused without the price, cost and margin grains; margin = (price − cost) ÷ price; the flag against
 * the target. Keep: the switch OFF → SENT_FOR_APPROVAL (four eyes, no standard yet); TOTAL_MOVED; the switch only on a company's own
 * row and with a reason; ON → KEPT by the same person (APPROVED, keptAloneReason, frozen standards written) and the price against cost
 * reads it as kept; the same cost again → SAME_AS_KEPT; a moved cost the same day → KEPT_TODAY. Made-up people and figures.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/costing/keep`. Written, not run (Owner rule: checks at the end).
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'owb-pd3-keep'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const jacket = id('product:style:JKT-01')
const revision1 = id('product:revision:JKT-01:1')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const PEOPLE = { finance: newId(), owner: newId(), checker: newId() } as const
const ROLE_OF: Record<keyof typeof PEOPLE, string> = { finance: 'finance', owner: 'owner', checker: 'finance' }
const grantOf = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const templateGrants = (name: string): Grant[] => {
  const role = templateOf(name)!
  return [grantOf([...role.permissions, ...role.grains.map((grain) => grainPermission(grain))])]
}
const SESSIONS: Record<string, SessionContext> = {
  // Costs, never prices: price against cost is refused.
  costOnly: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grantOf(['costing.view', 'money.cost', 'pricelists.view'])] },
  // Prices and costs without the margin: refused too (what a price earns is the margin grain's).
  noMargin: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grantOf(['costing.view', 'money.cost', 'money.price', 'pricelists.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refusal(session: string, url: string, payload: unknown, code: string): Promise<Json> {
  const response = await call(session, 'POST', url, payload)
  expect(response.statusCode, response.body).toBe(409)
  const error = response.json().error
  expect(error.issues?.[0]?.path).toBe(`refusal/${code}`)
  return error
}
const pacUrl = `/costing/styles/${jacket}/price-against-cost?revisionId=${revision1}`
const keepUrl = `/costing/styles/${jacket}/revisions/${revision1}/keep`
const sheetOf = async (sheetId: string) => (await admin('SELECT state::text AS state, "createdById", "approvedById", "keptAloneReason", "approvalTaskId", "sheetVersion" FROM "CostSheet" WHERE id = $1', [sheetId]))[0]!
const frozenKept = async () => admin<{ unitCost: string; breakdown: Json }>(`SELECT s."unitCost"::text AS "unitCost", s.breakdown FROM "StandardCost" s JOIN "Item" i ON i.id = s."itemId" JOIN "Variant" v ON v.id = i."variantId" WHERE v."styleId" = $1 AND s."companyId" = $2 AND s.status = 'FROZEN' AND s.breakdown->>'basis' = 'KEEP'`, [jacket, companyA])

beforeAll(async () => {
  db = await migratedDatabase('owb_pd3_keep')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedCostSheets({ db: database, namespace: NS })
  await seedPricing({ db: database, namespace: NS })
  await database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: new Date(), actorId: newId() }))
  const roles = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [tenant])).map((row) => [row.key, row.id]))
  for (const [person, userId] of Object.entries(PEOPLE) as Array<[keyof typeof PEOPLE, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, tenant, `pd3-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), tenant, userId, roles.get(ROLE_OF[person])])
    SESSIONS[person] = { audience: 'office', tenantId: tenant, actorId: userId, grants: templateGrants(ROLE_OF[person]) }
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('price against cost (3.1)', () => {
  it('is refused without the price grain, and without the margin grain (403 in words)', async () => {
    for (const session of ['costOnly', 'noMargin']) {
      const response = await call(session, 'GET', pacUrl)
      expect(response.statusCode, response.body).toBe(403)
      expect(response.json().error.message).toContain('the price, the cost and the margin right')
    }
  })

  it('lists P1\'s agreed prices of the jacket against ONE cost: margin = (price − cost) ÷ price, the flag against the target', async () => {
    const answer = await ok('owner', 'GET', pacUrl)
    expect(answer.currency).toBe('EUR')
    expect(answer.costNow, 'the seed\'s jacket costs completely').not.toBeNull()
    const prices = answer.rows.map((row: Json) => [row.customer.code, row.material, row.minQty, Number(row.price)])
    expect(prices).toEqual(expect.arrayContaining([expect.arrayContaining([420]), expect.arrayContaining([430])]))
    for (const row of answer.rows) {
      const cost = Number(row.cost)
      expect(cost).toBe(Number(answer.kept?.amount ?? answer.costNow))
      const price = Number(row.price)
      expect(row.marginPct).toBe((Math.round(((price - cost) / price) * 1000) / 10).toFixed(1))
      expect(Number(row.earned)).toBeCloseTo(price - cost, 2)
      const target = Number(answer.targetPct)
      expect(row.flag).toBe(Number(row.marginPct) < 0 ? 'UNDER_COST' : Number(row.marginPct) < target ? 'UNDER_TARGET' : 'OK')
    }
    expect(Number(answer.lowestPriceForTarget)).toBeGreaterThanOrEqual(Number(answer.kept?.amount ?? answer.costNow))
  })
})

describe('Keep (3.2)', () => {
  let costNow: string

  it('the switch OFF: Keep sends the version for approval (four eyes); no standard is written yet', async () => {
    costNow = (await ok('finance', 'GET', pacUrl)).costNow
    const answer = await ok('finance', 'POST', keepUrl, { reason: 'Leather went up (made up).', expectedTotal: costNow })
    expect(answer).toMatchObject({ mode: 'SENT_FOR_APPROVAL', kept: null })
    const sheet = await sheetOf(answer.costSheetId)
    expect(sheet).toMatchObject({ state: 'DRAFT', approvedById: null, keptAloneReason: null })
    expect(sheet.approvalTaskId).not.toBeNull()
    expect(await frozenKept()).toEqual([])
  })

  it('a cost that moved since it was read is refused (TOTAL_MOVED); a blank reason is a 400', async () => {
    await refusal('owner', keepUrl, { reason: 'Made up.', expectedTotal: '0.01' }, 'TOTAL_MOVED')
    const blank = await call('owner', 'POST', keepUrl, { reason: '   ', expectedTotal: costNow })
    expect(blank.statusCode, blank.body).toBe(400)
  })

  it('the switch lives on a company\'s own settings only, and its change says why', async () => {
    const tenantRow = await call('owner', 'PUT', '/costing/settings', { overheadPct: '25', oneKeeperAllowed: true, reason: 'Made up.' })
    expect(tenantRow.statusCode, tenantRow.body).toBe(400)
    const current = (await ok('owner', 'GET', `/costing/settings?companyId=${companyA}`)).settings
    // The company's own row as it is (none yet: one that follows the tenant-wide overhead, so the cost stays the same).
    const body = current.company
      ? { companyId: companyA, overheadPct: current.company.overheadPct, overheadFromTenant: current.company.overheadFromTenant, version: current.company.version }
      : { companyId: companyA, overheadPct: '0', overheadFromTenant: true }
    const noReason = await call('owner', 'PUT', '/costing/settings', { ...body, oneKeeperAllowed: true })
    expect(noReason.statusCode, noReason.body).toBe(400)
    const saved = await ok('owner', 'PUT', '/costing/settings', { ...body, oneKeeperAllowed: true, reason: 'The owner keeps the costs alone (made up).' })
    expect(saved.settings).toMatchObject({ companyId: companyA, oneKeeperAllowed: true })
    expect((await ok('owner', 'GET', `/costing/settings?companyId=${companyA}`)).settings.company.oneKeeperAllowed).toBe(true)
  })

  it('the switch ON: the same person keeps it at once — APPROVED by its maker with the reason, the standards frozen, read as kept', async () => {
    costNow = (await ok('owner', 'GET', pacUrl)).costNow
    const answer = await ok('owner', 'POST', keepUrl, { reason: 'First standard (made up).', expectedTotal: costNow })
    expect(answer.mode).toBe('KEPT')
    expect(Number(answer.kept.amount)).toBeCloseTo(Number(costNow), 2)
    const sheet = await sheetOf(answer.costSheetId)
    expect(sheet).toMatchObject({ state: 'APPROVED', keptAloneReason: 'First standard (made up).' })
    expect(sheet.approvedById).toBe(sheet.createdById)
    expect(answer.kept.version).toBe(sheet.sheetVersion)
    const standards = await frozenKept()
    expect(standards.length).toBeGreaterThan(0)
    expect(standards.every((row) => row.breakdown.sheetId === answer.costSheetId)).toBe(true)
    const after = await ok('owner', 'GET', pacUrl)
    expect(Number(after.kept.amount)).toBeGreaterThanOrEqual(Number(costNow) - 0.005)
    expect(after.kept.version).toBe(sheet.sheetVersion)
  })

  it('the same cost again is refused (SAME_AS_KEPT); a moved cost the same day too (KEPT_TODAY)', async () => {
    const kept = (await ok('owner', 'GET', pacUrl)).kept.amount
    await refusal('owner', keepUrl, { reason: 'Again (made up).', expectedTotal: kept }, 'SAME_AS_KEPT')
    await admin(`UPDATE "Item" SET "standardCost" = "standardCost" * 1.1 WHERE id IN (SELECT "itemId" FROM "BomLine" WHERE "revisionId" = $1) AND "standardCost" IS NOT NULL`, [revision1])
    const moved = (await ok('owner', 'GET', pacUrl)).costNow
    expect(moved).not.toBe(costNow)
    await refusal('owner', keepUrl, { reason: 'Moved (made up).', expectedTotal: moved }, 'KEPT_TODAY')
  })

  it('the product\'s shared history says "a new cost" with the version, never an amount', async () => {
    const lines = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Style' AND "recordId" = $1 AND action = 'costing.keepCost' ORDER BY "occurredAt"`, [jacket])
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) expect(Object.keys(line.after).sort()).toEqual(expect.arrayContaining(['mode', 'sheetId', 'sheetVersion']))
    for (const line of lines) expect(JSON.stringify(line.after)).not.toMatch(/amount|total|unitCost/)
  })
})
