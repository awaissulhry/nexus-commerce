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
import { seed as seedCostSheets, type CostSheetsSeed } from '../../../../../../packages/factory-db/seed/cost-sheets'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'

/**
 * Cost sheet versions on the local stack (B-W2b-420; FIN-013, FIN-014, FIN-015, FIN-016; follow-up KS3:01) with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_cost_sheets_w2b_guards are real), the cost sheets seed (the jacket JKT-01 revision 1 for company A and its season FW27:
 * version 1 FROZEN, version 2 APPROVED at target 520 / 45 % with the FW27 size weights 30 / 45 / 25, version 3 a DRAFT; 12 lines a
 * sheet: leather 57 / 59.5 / 62.5 ft² at 4.20, lining 1.6 m at 6.50, protectors 5 at 7.80, cutting 14 and sewing 96.5 minutes at
 * 0.50, overhead 25 % of labour 13.8125, freight 3 % of the leather per size, packaging typed 1.35 — version 2's sizes cost
 * 366.3945 / 377.2095 / 390.1875, weighted 377.2095 — the mix happens to land on size 52's cost) and the sales seed's draft quote SEED-Q-0002 (season FW27, the jacket).
 * Three made-up office people: two of finance (the costing owner's role) and the Owner. Every figure is made up and worked out
 * by hand. Run with `node scripts/factory/run-pg-tests.mjs modules/costing/sheet-versions`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: CostSheetsSeed

const NS = 'sheet-versions'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const jacket = id('product:style:JKT-01')
const leather = id('product:item:leather')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const PEOPLE = { maker: newId(), checker: newId(), owner: newId() } as const
const ROLE_OF: Record<keyof typeof PEOPLE, string> = { maker: 'finance', checker: 'finance', owner: 'owner' }
const grantOf = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const templateGrants = (name: string, drop: readonly string[] = []): Grant[] => {
  const role = templateOf(name)!
  return [grantOf([...role.permissions, ...role.grains.map((grain) => grainPermission(grain))].filter((permission) => !drop.includes(permission)))]
}
const SESSIONS: Record<string, SessionContext> = {
  // A cost reader without the price and margin grains: costs, never the target.
  costOnly: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grantOf(['costing.view', 'money.cost'])] },
  // Company B only: company A's sheets are not found.
  viewerB: { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grantOf(['costing.view', 'costing.sheets.manage', 'money.cost'], [companyB])] },
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
async function refusal(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(409)
  const error = response.json().error
  expect(error.issues?.[0]?.path).toBe(`refusal/${code}`)
  return error
}
const sheetOf = async (sheetId: string) => (await admin('SELECT state::text AS state, "approvedById", "frozenReason"::text AS "frozenReason", "frozenById", "approvalTaskId", "sheetVersion", "basedOnId" FROM "CostSheet" WHERE id = $1', [sheetId]))[0]!
const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => [event.type, event.payload.change ?? event.payload.supersededId ?? null])
let fw27: string

beforeAll(async () => {
  db = await migratedDatabase('sheet_versions')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  seeded = await seedCostSheets({ db: database, namespace: NS })
  // The system roles as the templates hold them now (finance: costing.sheets.approve).
  await database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: new Date(), actorId: newId() }))
  const roles = new Map((await admin<{ id: string; key: string }>('SELECT id, key FROM "Role" WHERE "tenantId" = $1', [tenant])).map((row) => [row.key, row.id]))
  for (const [person, userId] of Object.entries(PEOPLE) as Array<[keyof typeof PEOPLE, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, tenant, `w2b420-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), tenant, userId, roles.get(ROLE_OF[person])])
    SESSIONS[person] = { audience: 'office', tenantId: tenant, actorId: userId, grants: templateGrants(ROLE_OF[person]) }
  }
  fw27 = (await admin<{ id: string }>(`SELECT id FROM "Season" WHERE "tenantId" = $1 AND "companyId" = $2 AND code = 'FW27'`, [tenant, companyA]))[0]!.id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the approved version prices are released from (KS3:01)', () => {
  it("suggests the draft quote's jacket at version 2's target price, and starts its price there", async () => {
    const quote = (await admin<{ id: string }>(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = 'SEED-Q-0002'`, [tenant]))[0]!.id
    const pricing = await ok('owner', 'GET', `/sales/quotes/${quote}/pricing`)
    const line = pricing.lines.find((entry: Json) => entry.kind === 'SIZE_GRID')
    expect(line.suggested).toMatchObject({ costSheet: { id: seeded.sheetIds.approvedA, sheetVersion: 2 }, problem: null })
    expect(Number(line.suggested.unitPrice)).toBe(520)
    const priced = await ok('owner', 'PUT', `/sales/quotes/${quote}/lines/${line.lineId}/price`, { version: (await admin<{ version: number }>('SELECT version FROM "Quote" WHERE id = $1', [quote]))[0]!.version, start: 'SUGGESTED' })
    expect(priced.line.steps[0]).toMatchObject({ kind: 'SUGGESTED', source: { type: 'CostSheet', id: seeded.sheetIds.approvedA }, label: 'The target price of cost sheet version 2' })
  })
})

describe('versions per season, compared, what-if (FIN-014)', () => {
  let v4: Json
  let v5: Json

  it("lists the jacket's versions with their base size's and weighted cost; another company's caller sees none of A's", async () => {
    const list = await ok('maker', 'GET', `/costing/cost-sheets?styleId=${jacket}&companyId=${companyA}`)
    expect(list.versions.map((row: Json) => [row.sheetVersion, row.state, row.season?.code ?? null])).toEqual([
      [3, 'DRAFT', 'FW27'],
      [2, 'APPROVED', 'FW27'],
      [1, 'FROZEN', 'FW27'],
    ])
    expect(list.versions[1]).toMatchObject({ baseSize: '52', baseCost: '377.2095', weightedCost: '377.2095', targetPrice: '520', targetMarginPct: '45', approvedBy: { name: 'Seed Owner' } })
    // A cost reader without the price and margin grains: the costs, never the target.
    const costOnly = await ok('costOnly', 'GET', `/costing/cost-sheets?styleId=${jacket}&companyId=${companyA}`)
    expect(costOnly.versions[1]).toMatchObject({ baseCost: '377.2095' })
    expect(costOnly.versions[1]).not.toHaveProperty('targetPrice')
    expect(costOnly.versions[1]).not.toHaveProperty('targetMarginPct')
    expect((await ok('viewerB', 'GET', `/costing/cost-sheets?styleId=${jacket}`)).versions.map((row: Json) => row.companyId)).toEqual([companyB])
    expect((await call('viewerB', 'GET', `/costing/cost-sheets/${seeded.sheetIds.approvedA}`)).statusCode).toBe(404)
  })

  it('copies the approved version 2 as a new draft version 4; the approved one takes no edit', async () => {
    v4 = (await ok('maker', 'POST', '/costing/cost-sheets', { styleId: jacket, from: 'COPY', basedOnId: seeded.sheetIds.approvedA }, 201)).sheet
    expect(v4).toMatchObject({ sheetVersion: 4, state: 'DRAFT', basedOnId: seeded.sheetIds.approvedA, season: { id: fw27 }, baseCost: '377.2095', weightedCost: '377.2095', targetPrice: '520' })
    const record = await ok('maker', 'GET', `/costing/cost-sheets/${v4.id}`)
    expect(record.lines).toHaveLength(12)
    expect(record.weights).toMatchObject({ source: 'SEASON', weights: { '50': '30.0000', '52': '45.0000', '54': '25.0000' }, weighted: '377.2095' })
    expect(record.can).toMatchObject({ edit: true, remove: true, submit: true, takeBack: false })
    v4 = (await ok('maker', 'PATCH', `/costing/cost-sheets/${v4.id}`, { version: v4.version, targetPrice: '540' })).sheet
    expect(v4.targetPrice).toBe('540')
    await refusal('maker', 'PATCH', `/costing/cost-sheets/${seeded.sheetIds.approvedA}`, { version: 1, note: 'Edited after approval' }, 'LOCKED')
    await refusal('maker', 'DELETE', `/costing/cost-sheets/${seeded.sheetIds.frozenA}?version=1`, undefined, 'FROZEN')
    await refusal('maker', 'POST', '/costing/cost-sheets', { styleId: jacket, from: 'COPY', basedOnId: seeded.sheetIds.approvedA, seasonId: null }, 'OTHER_SERIES')
  })

  it('what-if leather +10 %: the leather and its freight move; saved as draft version 5; compared with version 2', async () => {
    const preview = await ok('maker', 'POST', `/costing/cost-sheets/${v4.id}/what-if`, { changes: [{ target: 'CATEGORY', category: 'LEATHER', pct: '10' }] })
    // 4.62 a ft²: 52 = 59.5 × 4.62 = 274.89 (+24.99), its freight 8.2467 (+0.7497): 377.2095 → 402.9492; weighted +25.7397.
    expect(preview).toMatchObject({ changed: 6, kept: [], unmatched: [], weighted: { a: '377.2095', b: '402.9492', difference: '25.7397' } })
    expect(preview.sizesCompared.find((row: Json) => row.size === '52').total).toEqual({ a: '377.2095', b: '402.9492', difference: '25.7397' })
    expect(await sheetOf(v4.id)).toMatchObject({ state: 'DRAFT', sheetVersion: 4 })
    v5 = (await ok('maker', 'POST', `/costing/cost-sheets/${v4.id}/what-if/save`, { changes: [{ target: 'ITEM', itemId: leather, pct: '10' }] }, 201)).sheet
    expect(v5).toMatchObject({ sheetVersion: 5, basedOnId: v4.id, baseCost: '402.9492' })
    expect((await admin<{ note: string }>('SELECT note FROM "CostSheet" WHERE id = $1', [v5.id]))[0]!.note).toBe('What-if: SEED-LEA-100 Seed cowhide 1.2 mm +10 %')
    const compared = await ok('maker', 'GET', `/costing/cost-sheets/compare?a=${seeded.sheetIds.approvedA}&b=${v5.id}`)
    expect(compared.comparable).toBe(true)
    expect(compared.lines.filter((line: Json) => line.change === 'CHANGED').map((line: Json) => [line.category, line.size])).toEqual([
      ['LEATHER', '50'],
      ['LEATHER', '52'],
      ['LEATHER', '54'],
      ['FREIGHT', '50'],
      ['FREIGHT', '52'],
      ['FREIGHT', '54'],
    ])
    expect(compared.words).toBe('Version 5 against version 2: 6 lines differ.')
    await refusal('maker', 'GET', `/costing/cost-sheets/compare?a=${v5.id}&b=${v5.id}`, undefined, 'SAME_SHEET')
    // Version 4 was copied into version 5: it stays; version 5 goes.
    await refusal('maker', 'DELETE', `/costing/cost-sheets/${v4.id}?version=${v4.version}`, undefined, 'COPIED_FROM')
    expect(await ok('maker', 'DELETE', `/costing/cost-sheets/${v5.id}?version=${v5.version}`)).toEqual({ id: v5.id, removed: true })
  })

  it('goal-seek: version 2 at 520 / 45 % allows 286, 91.2095 above; the cost by size suggests a surcharge for 54', async () => {
    const goal = await ok('maker', 'GET', `/costing/cost-sheets/${seeded.sheetIds.approvedA}/goal-seek`)
    expect(goal).toMatchObject({ basis: { kind: 'WEIGHTED', size: null }, target: { price: '520', marginPct: '45', from: 'SHEET' }, cost: '377.2095', allowedCost: '286', gap: '91.2095', marginAtCost: '27.46', state: 'ABOVE', held: null })
    // The leather, written per size, is one line at its weighted 249.90: alone it must come down 91.2095 ÷ 249.90 = 36.5 %.
    expect(goal.lines[0]).toMatchObject({ category: 'LEATHER', cost: '249.9', cutAlonePct: '36.5' })
    const at52 = await ok('maker', 'GET', `/costing/cost-sheets/${seeded.sheetIds.approvedA}/goal-seek?basis=SIZE&size=52&targetPrice=700`)
    expect(at52).toMatchObject({ target: { price: '700', from: 'ASKED' }, cost: '377.2095', allowedCost: '385', state: 'WITHIN' })
    const held = await ok('costOnly', 'GET', `/costing/cost-sheets/${seeded.sheetIds.approvedA}/goal-seek`)
    expect(held).toMatchObject({ state: 'NO_TARGET', cost: '377.2095' })
    expect(held.held).toContain('price grain')
    const bySize = await ok('maker', 'GET', `/costing/cost-sheets/${seeded.sheetIds.approvedA}/by-size`)
    // 54 is 12.978 above 52 (3.44 %); at 45 % the price surcharge is 12.978 ÷ 0.55 = 23.596… → 23.60.
    expect(bySize.surcharges).toEqual([{ size: '54', extraCost: '12.978', extraPct: '3.44', priceSurcharge: '23.6', current: null }])
    expect(bySize.weights).toMatchObject({ weighted: '377.2095', missing: [] })
  })
})

describe('approval and lock (FIN-015)', () => {
  it("is asked of the costing owner; the person who asked never decides; the yes locks version 4 and freezes version 2", async () => {
    const v4 = (await admin<{ id: string; version: number }>(`SELECT id, version FROM "CostSheet" WHERE key LIKE $1 AND "sheetVersion" = 4`, [`costsheet:${jacket}:${companyA}:%`]))[0]!
    const submitted = (await ok('maker', 'POST', `/costing/cost-sheets/${v4.id}/submit`, { version: v4.version, note: 'The new tannery price.' })).sheet
    expect(submitted.approval).toMatchObject({ status: 'PENDING' })
    const task = (await admin<{ id: string; version: number; approverRoleId: string }>('SELECT id, version, "approverRoleId" FROM "ApprovalTask" WHERE id = $1', [submitted.approval.taskId]))[0]!
    expect((await admin<{ key: string }>('SELECT key FROM "Role" WHERE id = $1', [task.approverRoleId]))[0]!.key).toBe('finance')
    // Whoever asked never decides (the engine); the draft stays a draft.
    expect((await call('maker', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: null })).statusCode).not.toBe(200)
    await ok('checker', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: 'Agreed with the tannery.' })
    expect(await sheetOf(v4.id)).toMatchObject({ state: 'APPROVED', approvedById: PEOPLE.checker, approvalTaskId: task.id })
    expect(await sheetOf(seeded.sheetIds.approvedA)).toMatchObject({ state: 'FROZEN', frozenReason: 'SUPERSEDED', frozenById: PEOPLE.checker })
    expect(await eventsOf(v4.id)).toEqual([
      ['cost_sheet.version_changed', 'created'],
      ['cost_sheet.version_changed', 'updated'],
      ['cost_sheet.version_changed', 'submitted'],
      ['cost_sheet.approved', seeded.sheetIds.approvedA],
    ])
    const locked = await ok('maker', 'GET', `/costing/cost-sheets/${v4.id}`)
    // Locked; finance (the costing owner's role) may take it back.
    expect(locked.can).toMatchObject({ edit: false, remove: false, submit: false, takeBack: true })
    await refusal('maker', 'PATCH', `/costing/cost-sheets/${v4.id}`, { version: locked.sheet.version, targetPrice: '1' }, 'LOCKED')
    // Taken back (a mistake found): frozen, WITHDRAWN, by the person; the series has no approved version now.
    await ok('maker', 'POST', `/costing/cost-sheets/${v4.id}/take-back`, { version: locked.sheet.version, reason: 'A mistake in the protectors.' })
    expect(await sheetOf(v4.id)).toMatchObject({ state: 'FROZEN', frozenReason: 'WITHDRAWN', frozenById: PEOPLE.maker })
    await refusal('checker', 'POST', `/costing/cost-sheets/${v4.id}/take-back`, { version: locked.sheet.version + 1, reason: 'Again.' }, 'NOT_APPROVED')
  })

  it('nobody approves a version they made: the checker made it, the maker asked, so the Owner decides', async () => {
    // Version 5 was deleted: the series' next number is 5 again.
    const v5 = (await ok('checker', 'POST', '/costing/cost-sheets', { styleId: jacket, from: 'COPY', basedOnId: seeded.sheetIds.draftA }, 201)).sheet
    expect(v5.sheetVersion).toBe(5)
    const submitted = (await ok('maker', 'POST', `/costing/cost-sheets/${v5.id}/submit`, { version: v5.version })).sheet
    const task = (await admin<{ id: string; version: number; approverRoleId: string }>('SELECT id, version, "approverRoleId" FROM "ApprovalTask" WHERE id = $1', [submitted.approval.taskId]))[0]!
    // Finance has nobody but the two of them: the Owner's role is asked.
    expect((await admin<{ key: string }>('SELECT key FROM "Role" WHERE id = $1', [task.approverRoleId]))[0]!.key).toBe('owner')
    expect((await call('checker', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: null })).statusCode).not.toBe(200)
    expect(await sheetOf(v5.id)).toMatchObject({ state: 'DRAFT' })
    await ok('owner', 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: null })
    expect(await sheetOf(v5.id)).toMatchObject({ state: 'APPROVED', approvedById: PEOPLE.owner })
  })

  it('a draft changed while it waits sends the request back; nothing left out unless typed lines cover it', async () => {
    const version = (await admin<{ version: number }>('SELECT version FROM "CostSheet" WHERE id = $1', [seeded.sheetIds.draftA]))[0]!.version
    const submitted = (await ok('checker', 'POST', `/costing/cost-sheets/${seeded.sheetIds.draftA}/submit`, { version })).sheet
    const edited = (await ok('checker', 'PATCH', `/costing/cost-sheets/${seeded.sheetIds.draftA}`, { version: submitted.version, note: 'Leather 4.40 confirmed.' })).sheet
    expect(edited.approval).toBeNull()
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "ApprovalTask" WHERE id = $1', [submitted.approval.taskId]))[0]!.status).toBe('WITHDRAWN')
    expect((await sheetOf(seeded.sheetIds.draftA)).approvalTaskId).toBeNull()
    await refusal('checker', 'PATCH', `/costing/cost-sheets/${seeded.sheetIds.draftA}`, { version: edited.version, note: 'Leather 4.40 confirmed.' }, 'NOTHING_CHANGES')
    // Company A's first version without a season, written from the revision's components now.
    const fresh = (await ok('maker', 'POST', '/costing/cost-sheets', { styleId: jacket, from: 'COMPONENTS', revisionId: id('product:revision:JKT-01:1'), companyId: companyA, seasonId: null, leaveOutMissing: true, piecesPerCarton: 12 }, 201)).sheet
    expect(fresh).toMatchObject({ sheetVersion: 1, season: null, state: 'DRAFT', basedOnId: null })
    // Something left out (made so here): no yes is asked while no typed line covers it.
    await admin(`UPDATE "CostSheet" SET inputs = jsonb_set(COALESCE(inputs, '{}'::jsonb), '{components,leftOut}', '[{"key":"CARTON_PIECES","code":"CARTON_PIECES","itemId":null,"recordType":null,"recordId":null,"size":null,"workCentreKind":null,"message":"How many garments does the carton hold?"}]'::jsonb) WHERE id = $1`, [fresh.id])
    await refusal('maker', 'POST', `/costing/cost-sheets/${fresh.id}/submit`, { version: fresh.version }, 'LEFT_OUT')
    await refusal('maker', 'POST', `/costing/cost-sheets/${fresh.id}/submit`, { version: fresh.version, coveredByTyped: true }, 'LEFT_OUT')
  })
})

describe('size weights and the season (FIN-016, FIN-014)', () => {
  it("keeps the jacket's mix for every season; a repeat changes nothing; a size outside the range is refused", async () => {
    const before = await ok('maker', 'GET', `/costing/size-weights?styleId=${jacket}&seasonId=${fw27}`)
    expect(before.inForce).toMatchObject({ source: 'SEASON', weights: { '50': '30.0000', '52': '45.0000', '54': '25.0000' } })
    await ok('maker', 'PUT', '/costing/size-weights', { styleId: jacket, seasonId: null, weights: { '50': '1', '52': '2', '54': '1' } })
    await refusal('maker', 'PUT', '/costing/size-weights', { styleId: jacket, seasonId: null, weights: { '50': '1', '52': '2', '54': '1' } }, 'NOTHING_CHANGES')
    expect((await call('maker', 'PUT', '/costing/size-weights', { styleId: jacket, seasonId: null, weights: { '99': '1' } })).statusCode).toBe(400)
    const after = await ok('maker', 'GET', `/costing/size-weights?styleId=${jacket}`)
    expect(after.sets.find((set: Json) => set.seasonId === null)).toMatchObject({ weights: { '50': '1.0000', '52': '2.0000', '54': '1.0000' }, shares: [{ size: '50', sharePct: '25' }, { size: '52', sharePct: '50' }, { size: '54', sharePct: '25' }] })
  })

  it("closing FW27 freezes its approved version and sends back its drafts' requests; no new version for it", async () => {
    const approved = (await admin<{ id: string }>(`SELECT id FROM "CostSheet" WHERE "seasonId" = $1 AND state = 'APPROVED'`, [fw27]))[0]!.id
    const v3version = (await admin<{ version: number }>('SELECT version FROM "CostSheet" WHERE id = $1', [seeded.sheetIds.draftA]))[0]!.version
    const waiting = (await ok('checker', 'POST', `/costing/cost-sheets/${seeded.sheetIds.draftA}/submit`, { version: v3version })).sheet
    const season = (await admin<{ version: number }>('SELECT version FROM "Season" WHERE id = $1', [fw27]))[0]!
    await ok('owner', 'POST', `/sales/seasons/${fw27}/close`, { version: season.version })
    expect(await sheetOf(approved)).toMatchObject({ state: 'FROZEN', frozenReason: 'SEASON_CLOSED', frozenById: null })
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "ApprovalTask" WHERE id = $1', [waiting.approval.taskId]))[0]!.status).toBe('WITHDRAWN')
    expect((await sheetOf(seeded.sheetIds.draftA)).approvalTaskId).toBeNull()
    await refusal('maker', 'POST', '/costing/cost-sheets', { styleId: jacket, from: 'COPY', basedOnId: seeded.sheetIds.draftA }, 'SEASON_CLOSED')
  })
})
