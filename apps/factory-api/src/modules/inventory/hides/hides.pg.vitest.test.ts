import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Hides as stock (B-W2b-94; PRD-031, SCM-249, SCM-250, SCM-258) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the …_leather_stock_w2b_guards triggers are real),
 * tenant A from EVERY seed (grades A-D, the cowhide SEED-LEA-100's rules A 88 / B 74 / C 58 and D retired, its shade groups,
 * SEED-HIDE-0001 partly cut at WO-0001 with W1's text "A", SEED-HIDE-0002 whole in grade B and group 2 with its two measures,
 * lot SEED-LOT-LEA-01 with its order line's 5 % area tolerance, the goatskin offcut SEED-HIDE-0009 with two tagged remnants)
 * and tenant B bare. Made-up figures only. In order:
 *   - the grade mix per article and per lot, hides beside area, usable area of what is left, remnants as pieces;
 *   - an article's grade rules: what applies, a new rule, its share and panels, retire and make active again, the refusals;
 *   - a hide graded by record (the W1 text moves with it), shade group, thickness, the reason once cut, the changes; the
 *     database still refuses a text that disagrees with the record;
 *   - a whole hide measured again, the check against the tannery, the stock corrected by an adjustment move (once);
 *   - the lot's area check, the claim it opens, and that claim's body accepted by purchasing as it is;
 *   - a receipt's grade text that is a grade's code names the grade's record.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/hides`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'hides-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `hides-${Date.now()}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${id(key).slice(8)}`
const A = {
  tenant: id('tenant'),
  companyA: id('company:A'),
  siteA1: id('site:A1'),
  leather: id('product:item:leather'),
  leatherBLK: id('product:item-colour:leather:BLK'),
  lining: id('product:item:lining'),
  offcut: id('leather:item:LEA-110'),
  lot: id('inventory:lot:LEA-01'),
  liningLot: id('inventory:lot:LIN-01'),
  H1: id('inventory:hide:H1'),
  H2: id('inventory:hide:H2'),
  H9: id('leather:hide:0009'),
  bin: id('inventory:location:A1-STORE-01'),
  grade: { A: id('leather:grade:A'), B: id('leather:grade:B'), C: id('leather:grade:C'), D: id('leather:grade:D') },
  retiredRuleD: firstId('leather:rule:LEA-100:D'),
  shade: { one: id('leather:shade:LEA-100:BLK:1'), two: id('leather:shade:LEA-100:BLK:2'), three: id('leather:shade:LEA-100:BLK:3'), out: id('leather:shade:LEA-100:BLK:out'), lot: id('leather:shade:lot:LEA-01'), lining: id('leather:shade:LIN-200:1') },
}
const tenantB = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const KEEP: Permission[] = ['inventory.stock.view', 'inventory.hides.manage', 'inventory.adjust', 'product.materials.view', 'product.materials.manage', 'purchasing.view', 'purchasing.claims.manage', 'inventory.receive']
const SESSIONS: Record<string, SessionContext> = {
  keeper: office(A.tenant, [grant(KEEP)]),
  viewer: office(A.tenant, [grant(['inventory.stock.view', 'product.materials.view'])]),
  // Grades and measures, but no stock correction.
  grader: office(A.tenant, [grant(['inventory.stock.view', 'inventory.hides.manage', 'product.materials.view'])]),
  // Keeps materials of company A only: SEED-LEA-100 is every company's, so it reads its grades but does not change them.
  companyKeeper: office(A.tenant, [grant(['product.materials.view', 'product.materials.manage'], { companies: [A.companyA] })]),
  nobody: office(A.tenant, [grant(['sites.view'])]),
  keeperB: office(tenantB, [grant(KEEP)]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PATCH'
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = idem()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const hideRow = async (hideId: string) => (await admin<Json>(`SELECT grade, "gradeId", shade, "shadeGroupId", "thicknessMm"::text AS thickness, defects, area::text AS area, version FROM "Hide" WHERE id = $1`, [hideId]))[0]!
const onHand = async (hideId: string) =>
  (await admin<{ n: string }>(`SELECT (coalesce(sum(CASE WHEN "toLocationId" IS NOT NULL THEN "baseQuantity" END), 0) - coalesce(sum(CASE WHEN "fromLocationId" IS NOT NULL THEN "baseQuantity" END), 0))::numeric(18,4)::text AS n FROM "StockMove" WHERE "hideId" = $1`, [hideId]))[0]!.n
const grading = (hideId: string, session = 'keeper') => ok(session, 'GET', `/inventory/hides/${hideId}/grading`)
const rulesOf = (session = 'keeper', materialId = A.leather) => ok(session, 'GET', `/product/materials/${materialId}/grades`)

beforeAll(async () => {
  db = await migratedDatabase('inventory_hides')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'hides-b', 'Gruppo Nuovo')`, [tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('grade mix and usable area, hides beside area (SCM-250, SCM-258)', () => {
  it('gives per article and colour the hides, what is left, the usable area per grade and the remnants as pieces', async () => {
    const mix = await ok('keeper', 'GET', '/inventory/leather/grade-mix')
    expect(mix.groupBy).toBe('article')
    const cow = (mix.groups as Json[]).find((group) => group.item.id === A.leather && group.colour?.id === A.leatherBLK)!
    // SEED-HIDE-0001 is at WO-0001 (issued, nothing at the site); SEED-HIDE-0002 lies whole in the rack.
    expect(cow).toMatchObject({ uom: 'FT2', hides: 2, measured: '105.0000', left: '51.8000', usable: '38.3320', ungradedLeft: '0.0000', remnants: { pieces: 0, area: '0.0000' } })
    expect(cow.words).toEqual({ it: '2 pelli · 51,80 ft² (4,8 m²)', en: '2 hides · 51.80 ft² (4.8 m²)' })
    expect(cow.grades.map((row: Json) => [row.grade?.code, row.hides, row.byText, row.measured, row.left, row.share, row.source, row.usable, row.percentOfArea])).toEqual([
      ['A', 1, 1, '53.2000', '0.0000', '88.00', 'RULE', '0.0000', '50.67'],
      ['B', 1, 0, '51.8000', '51.8000', '74.00', 'RULE', '38.3320', '49.33'],
    ])
    // The goatskin offcut has no rules: grade A's default 85 %; its two tagged remnants are pieces beside their area.
    const goat = (mix.groups as Json[]).find((group) => group.item.id === A.offcut)!
    expect(goat).toMatchObject({ hides: 1, measured: '40.0000', left: '14.0000', usable: '11.9000', remnants: { pieces: 2, area: '8.0000' } })
    expect(goat.grades[0]).toMatchObject({ grade: { code: 'A' }, share: '85.00', source: 'GRADE' })
    const ft2 = (mix.totals as Json[]).find((total) => total.uom === 'FT2')!
    expect(ft2.hides).toBeGreaterThanOrEqual(3)
    expect(ft2.remnants.pieces).toBeGreaterThanOrEqual(2)
  })

  it('gives the grade mix of one lot as delivered, and nothing of another tenant', async () => {
    const mix = await ok('keeper', 'GET', `/inventory/leather/grade-mix?groupBy=lot&lotId=${A.lot}&inStock=false`)
    expect(mix.groups).toHaveLength(1)
    expect(mix.groups[0]).toMatchObject({ lot: { id: A.lot, code: 'SEED-LOT-LEA-01' }, hides: 2, measured: '105.0000' })
    expect((await ok('keeperB', 'GET', '/inventory/leather/grade-mix')).groups).toEqual([])
    expect((await refused('nobody', 'GET', '/inventory/leather/grade-mix', undefined, 403)).code).toBe('forbidden')
    expect(paths(await refused('keeper', 'GET', '/inventory/leather/grade-mix?groupBy=supplier', undefined, 400))).toContain('querystring/groupBy')
  })
})

describe("an article's grades and usable shares (PRD-031)", () => {
  it('says what applies per grade: the rule, else the grade default; the retired rules; the hides in stock', async () => {
    const view = await rulesOf()
    expect(view.material).toMatchObject({ id: A.leather, code: 'SEED-LEA-100', companyId: null, tracksHides: true })
    expect(view.grades.map((row: Json) => [row.grade.code, row.share, row.source, row.panels, row.retiredRules.length, row.hidesInStock])).toEqual([
      ['A', '88.00', 'RULE', [], 0, 1],
      ['B', '74.00', 'RULE', [], 0, 1],
      ['C', '58.00', 'RULE', ['under collar', 'pocket bag'], 0, 0],
      ['D', '45.00', 'GRADE', [], 1, 0],
    ])
    expect(view.canManage).toBe(true)
    expect((await rulesOf('viewer')).canManage).toBe(false)
    expect((await rulesOf('companyKeeper')).canManage).toBe(false)
    // The lining is traced by lot: no grades.
    expect(await rulesOf('keeper', A.lining)).toMatchObject({ material: { tracksHides: false }, grades: [], canManage: false })
    expect((await refused('keeperB', 'GET', `/product/materials/${A.leather}/grades`, undefined, 404)).code).toBe('not_found')
  })

  it('adds a rule, changes its share and panels at the version read, retires it and makes it active again', async () => {
    const created = await ok('keeper', 'POST', `/product/materials/${A.leather}/grades`, { gradeId: A.grade.D, usableShare: '50', panels: [' Sleeve ', 'sleeve', '', 'yoke'] }, 201)
    expect(created.grade).toMatchObject({ grade: { code: 'D', defaultShare: '45.00' }, share: '50.00', source: 'RULE', panels: ['Sleeve', 'yoke'], rule: { usableShare: '50.00', version: 1 } })
    const ruleId = created.grade.rule.id as string
    expect((await refused('keeper', 'POST', `/product/materials/${A.leather}/grades`, { gradeId: A.grade.D, usableShare: '40' }, 409)).message).toBe('SEED-LEA-100 has a rule for grade D already: change that one.')
    const edited = await ok('keeper', 'PATCH', `/product/materials/${A.leather}/grades/${ruleId}`, { version: 1, usableShare: '52.5' })
    expect(edited.grade).toMatchObject({ share: '52.50', rule: { version: 2 } })
    expect((await refused('keeper', 'PATCH', `/product/materials/${A.leather}/grades/${ruleId}`, { version: 1, usableShare: '53' }, 409)).message).toMatch(/changed since it was read \(version 1\)/)
    const retired = await ok('keeper', 'PATCH', `/product/materials/${A.leather}/grades/${ruleId}`, { version: 2, active: false })
    expect(retired.grade).toMatchObject({ rule: null, share: '45.00', source: 'GRADE' })
    expect(retired.grade.retiredRules).toHaveLength(2)
    expect((await refused('keeper', 'PATCH', `/product/materials/${A.leather}/grades/${ruleId}`, { version: 3, usableShare: '60' }, 409)).message).toMatch(/retired rule is history/)
    const back = await ok('keeper', 'PATCH', `/product/materials/${A.leather}/grades/${ruleId}`, { version: 3, active: true })
    expect(back.grade).toMatchObject({ share: '52.50', source: 'RULE' })
    await ok('keeper', 'PATCH', `/product/materials/${A.leather}/grades/${ruleId}`, { version: 4, active: false })
    expect((await events('inventory.grade_rule_changed')).map((payload) => payload.change)).toEqual(['CREATED', 'EDITED', 'RETIRED', 'REACTIVATED', 'RETIRED'])
    const audit = await admin<{ action: string; companyId: string | null }>(`SELECT action, "companyId" FROM "AuditLog" WHERE "recordType" = 'ItemGradeRule' AND "recordId" = $1 ORDER BY at, id`, [ruleId])
    expect(audit.map((row) => row.action)).toEqual(['inventory.createGradeRule', 'inventory.editGradeRule', 'inventory.editGradeRule', 'inventory.editGradeRule', 'inventory.editGradeRule'])
  })

  it('refuses in words: a share over 100, a grade of nobody, a material of every company for a company keeper, a lot-traced material', async () => {
    expect(paths(await refused('keeper', 'POST', `/product/materials/${A.leather}/grades`, { gradeId: A.grade.D, usableShare: '101' }, 400))).toEqual(['body/usableShare'])
    expect(paths(await refused('keeper', 'POST', `/product/materials/${A.leather}/grades`, { gradeId: newId(), usableShare: '50' }, 400))).toEqual(['body/gradeId'])
    expect((await refused('companyKeeper', 'POST', `/product/materials/${A.leather}/grades`, { gradeId: A.grade.D, usableShare: '50' }, 403)).message).toMatch(/every company/)
    expect((await refused('keeper', 'POST', `/product/materials/${A.lining}/grades`, { gradeId: A.grade.A, usableShare: '50' }, 409)).message).toMatch(/not tracked hide by hide/)
    expect((await refused('viewer', 'POST', `/product/materials/${A.leather}/grades`, { gradeId: A.grade.D, usableShare: '50' }, 403)).code).toBe('forbidden')
  })
})

describe("a hide's grade and shade group by record (SCM-250)", () => {
  it('reads the grade, shade, usable area, the estimates per grade and the choices', async () => {
    const view = await grading(A.H2)
    expect(view.hide).toMatchObject({ code: 'SEED-HIDE-0002', state: 'FULL', area: { uom: 'FT2', quantity: '51.8000', other: { uom: 'M2', quantity: '4.8124' } }, baseArea: '51.8000', onHand: '51.8000', thicknessMm: '1.25' })
    expect(view.grade).toMatchObject({ id: A.grade.B, code: 'B', byText: false })
    expect(view.shade).toMatchObject({ id: A.shade.two, label: '2' })
    expect(view.usable).toEqual({ share: '74.00', source: 'RULE', panels: [], measured: '38.3320', left: '38.3320' })
    expect(view.estimates.map((row: Json) => [row.code, row.share, row.usable, row.current])).toEqual([
      ['A', '88.00', '45.5840', false],
      ['B', '74.00', '38.3320', true],
      ['C', '58.00', '30.0440', false],
    ])
    // The article's grades only (D's rule is retired); its own colour's groups and its own lot's; never the lining's.
    expect(view.choices.grades.map((row: Json) => row.code)).toEqual(['A', 'B', 'C'])
    expect(view.choices.shadeGroups.map((row: Json) => row.label)).toEqual(['1', '2', '3', 'Out of shade', 'L1'])
    expect(view.lastMeasure).toMatchObject({ measuredArea: '51.3000', declared: '51.8000', declaredFrom: 'TANNERY', outcome: 'WITHIN', by: { audience: 'OFFICE', hidden: false } })
    expect(view).toMatchObject({ readOnly: null, reasonRequired: false, canEdit: true, changes: [] })
    expect((await grading(A.H2, 'viewer')).canEdit).toBe(false)
    expect((await refused('keeperB', 'GET', `/inventory/hides/${A.H2}/grading`, undefined, 404)).code).toBe('not_found')
  })

  it("moves a W1 hide's text to the record, and asks why once the hide was cut", async () => {
    const before = await grading(A.H1)
    expect(before).toMatchObject({ grade: { code: 'A', byText: true }, gradeText: 'A', reasonRequired: true, hide: { state: 'PARTLY_CUT', onHand: '0.0000' } })
    expect((await hideRow(A.H1)).gradeId).toBeNull()
    expect(paths(await refused('keeper', 'PATCH', `/inventory/hides/${A.H1}/grading`, { version: before.hide.version, gradeId: A.grade.A }, 400))).toEqual(['body/reason'])
    const after = await ok('keeper', 'PATCH', `/inventory/hides/${A.H1}/grading`, { version: before.hide.version, gradeId: A.grade.A, reason: 'Graded at the table: grade A as the tannery said.' })
    expect(after).toMatchObject({ grade: { code: 'A', byText: false }, gradeText: 'A', hide: { version: before.hide.version + 1 } })
    expect(await hideRow(A.H1)).toMatchObject({ grade: 'A', gradeId: A.grade.A })
    expect(after.changes).toHaveLength(1)
    expect(after.changes[0]).toMatchObject({ from: {}, to: {}, reason: 'Graded at the table: grade A as the tannery said.' })
    expect((await events('inventory.hide_graded')).at(-1)).toEqual({ hideId: A.H1, lotId: A.lot, itemId: A.leather, changed: ['GRADE'], gradeId: A.grade.A, gradeCode: 'A', shadeGroupId: null, shadeLabel: null })
  })

  it('sorts into another shade group with a new thickness at the version read; the text goes with the record', async () => {
    const { hide } = await grading(A.H2)
    expect((await refused('keeper', 'PATCH', `/inventory/hides/${A.H2}/grading`, { version: hide.version + 5, shadeGroupId: A.shade.three }, 409)).message).toMatch(/changed since it was read \(version /)
    const key = idem()
    const view = await ok('keeper', 'PATCH', `/inventory/hides/${A.H2}/grading`, { version: hide.version, shadeGroupId: A.shade.three, thicknessMm: '1.3' }, 200, key)
    // The same request again (its Idempotency-Key) answers what is there, and changes nothing.
    const replay = await ok('keeper', 'PATCH', `/inventory/hides/${A.H2}/grading`, { version: hide.version, shadeGroupId: A.shade.three, thicknessMm: '1.3' }, 200, key)
    expect(replay.hide.version).toBe(view.hide.version)
    expect(replay.changes).toHaveLength(1)
    expect(view).toMatchObject({ shade: { id: A.shade.three, label: '3' }, shadeText: '3', hide: { thicknessMm: '1.30' } })
    expect(await hideRow(A.H2)).toMatchObject({ shade: '3', shadeGroupId: A.shade.three, thickness: '1.30' })
    expect(view.changes[0]).toMatchObject({ from: { shade: '2', thicknessMm: '1.25' }, to: { shade: '3', thicknessMm: '1.30' }, reason: null })
    expect((await events('inventory.hide_graded')).at(-1)).toMatchObject({ hideId: A.H2, changed: ['SHADE', 'THICKNESS'], shadeGroupId: A.shade.three, shadeLabel: '3' })
    // Cleared: the record and its text together; then grade B again.
    const cleared = await ok('keeper', 'PATCH', `/inventory/hides/${A.H2}/grading`, { version: view.hide.version, gradeId: null })
    expect(cleared).toMatchObject({ grade: null, gradeText: null, usable: null })
    expect(await hideRow(A.H2)).toMatchObject({ grade: null, gradeId: null })
    const again = await ok('keeper', 'PATCH', `/inventory/hides/${A.H2}/grading`, { version: cleared.hide.version, gradeId: A.grade.B })
    expect(again.grade).toMatchObject({ code: 'B' })
  })

  it("refuses in words: a grade not the article's, another article's group, nothing to change; a viewer may not", async () => {
    const { hide } = await grading(A.H2)
    const url = `/inventory/hides/${A.H2}/grading`
    expect((await refused('keeper', 'PATCH', url, { version: hide.version, gradeId: A.grade.D }, 400)).message).toBe("Grade D is not one of SEED-LEA-100's grades (A, B, C): add it on the material's Grades and usable area first.")
    expect((await refused('keeper', 'PATCH', url, { version: hide.version, shadeGroupId: A.shade.lining }, 400)).message).toBe('Shade group 1 is of another article than hide SEED-HIDE-0002.')
    expect((await refused('keeper', 'PATCH', url, { version: hide.version, gradeId: A.grade.B }, 400)).message).toBe('Nothing changes: hide SEED-HIDE-0002 says this already.')
    expect(paths(await refused('keeper', 'PATCH', url, { version: hide.version, thicknessMm: '0' }, 400))).toEqual(['body/thicknessMm'])
    expect((await refused('viewer', 'PATCH', url, { version: hide.version, gradeId: A.grade.A }, 403)).code).toBe('forbidden')
    expect((await hideRow(A.H2)).version).toBe(hide.version)
  })

  it('the database still refuses a grade text that says otherwise than the record (the W1 text-only write)', async () => {
    await expect(admin(`UPDATE "Hide" SET grade = 'C' WHERE id = $1`, [A.H2])).rejects.toThrow(/names grade "B"; its grade text says the same, not "C"/)
  })
})

describe("a receipt's grade text names the grade's record (W1's text-only route moved to the record)", () => {
  it("a text that is an active grade's code names that grade; another text stays text", async () => {
    const orderId = newId()
    const lineId = newId()
    const supplier = id('party:P2')
    await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, 'T-PO-HIDES-1', $5, current_date, $6)`, [orderId, A.tenant, A.companyA, A.siteA1, supplier, id('actor')])
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "requiresCrViTest")
       VALUES ($1, $2, $3, $4, $5, 10, $6, $7, '120', 'FT2', '120', '5.000000', 60000, current_date + 20, true)`,
      [lineId, A.tenant, orderId, supplier, A.siteA1, A.leather, A.leatherBLK],
    )
    await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = 60000, version = 2 WHERE id = $1`, [orderId, id('actor')])
    await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', version = 3 WHERE id = $1`, [orderId])
    await ok(
      'keeper',
      'POST',
      '/inventory/receipts',
      { purchaseOrderId: orderId, supplierDdtNumber: 'DDT-HIDES-1', supplierDdtDate: '2026-11-02', lines: [{ purchaseOrderLineId: lineId, lots: [{ dyeBatch: 'DB-H', hides: [{ supplierCode: 'G-01', area: '52.1', grade: 'C' }, { supplierCode: 'G-02', area: '49.7', grade: 'Extra' }] }] }] },
      201,
    )
    const hides = await admin<Json>(`SELECT id, "lotId", "supplierCode", grade, "gradeId" FROM "Hide" WHERE "supplierCode" IN ('G-01', 'G-02') ORDER BY "supplierCode"`)
    expect(hides.map(({ supplierCode, grade, gradeId }) => ({ supplierCode, grade, gradeId }))).toEqual([
      { supplierCode: 'G-01', grade: 'C', gradeId: A.grade.C },
      { supplierCode: 'G-02', grade: 'Extra', gradeId: null },
    ])
    G.hide1 = hides[0]!.id
    G.hide2 = hides[1]!.id
    G.lot = hides[0]!.lotId
  })
})

/** The lot received above: two whole hides (52.1 ft² grade C, 49.7 ft² "Extra"), no measure yet, an order line without a tolerance. */
const G = { lot: '', hide1: '', hide2: '' }

describe('re-measure and area check (SCM-249)', () => {
  it("reads a hide's measures, newest first, each against the tannery with its lot's tolerance", async () => {
    const view = await ok('keeper', 'GET', `/inventory/hides/${A.H2}/measures`)
    expect(view).toMatchObject({ tolerancePercent: '5.00', toleranceFrom: 'ORDER_LINE', measureRefusal: null, canMeasure: true, canCorrectStock: true })
    expect(view.measures.map((row: Json) => [row.measuredArea, row.declared, row.differencePercent, row.outcome, row.by.audience, row.latest])).toEqual([
      ['51.3000', '51.8000', '-0.97', 'WITHIN', 'OFFICE', true],
      ['51.1000', '51.8000', '-1.35', 'WITHIN', 'FLOOR', false],
    ])
    // The bench's inspector stays unnamed while site A1's PERFORMANCE gate is not open.
    expect(view.measures[1].by).toEqual({ audience: 'FLOOR', id: null, name: null, hidden: true })
    expect((await ok('grader', 'GET', `/inventory/hides/${A.H2}/measures`)).canCorrectStock).toBe(false)
    expect((await ok('keeper', 'GET', `/inventory/hides/${A.H1}/measures`)).measureRefusal).toBe("Hide SEED-HIDE-0001 was cut already: only a whole hide is measured against the tannery's area.")
    const fresh = await ok('keeper', 'GET', `/inventory/hides/${G.hide1}/measures`)
    expect(fresh).toMatchObject({ tolerancePercent: '2.00', toleranceFrom: 'DEFAULT', measures: [], latest: null, hide: { onHand: '52.1000' } })
  })

  it('records a measure without touching the stock or the area', async () => {
    const answer = await ok('grader', 'POST', `/inventory/hides/${G.hide1}/measures`, { measuredArea: '51.5', note: 'Pin wheel at the office table.' }, 201)
    expect(answer.move).toBeNull()
    expect(answer.measure).toMatchObject({ measuredArea: '51.5000', areaUom: 'FT2', declaredArea: null, declared: '52.1000', declaredFrom: 'RECEIPT', difference: '-0.6000', differencePercent: '-1.15', outcome: 'WITHIN', latest: true })
    expect(await onHand(G.hide1)).toBe('52.1000')
    expect((await hideRow(G.hide1)).area).toBe('52.1000')
    expect((await events('inventory.hide_measured')).at(-1)).toEqual({ hideId: G.hide1, lotId: G.lot, itemId: A.leather, measureId: answer.measure.id, outcome: 'WITHIN', moveId: null })
    // In another unit, with the tannery's area typed in it.
    const metric = await ok('grader', 'POST', `/inventory/hides/${G.hide1}/measures`, { measuredArea: '4.7', areaUom: 'M2', declaredArea: '4.81' }, 201)
    expect(metric.measure).toMatchObject({ areaUom: 'M2', declared: '4.8100', declaredFrom: 'TANNERY', differencePercent: '-2.29', outcome: 'SHORT' })
  })

  it('corrects the stock to the measured area by one adjustment move, valued, and once for a repeated request', async () => {
    const key = idem()
    const body = { measuredArea: '49', correctStock: { note: 'Measuring machine, calibrated.' } }
    expect(paths(await refused('grader', 'POST', `/inventory/hides/${G.hide1}/measures`, body, 400))).toEqual(['body/correctStock'])
    const answer = await ok('keeper', 'POST', `/inventory/hides/${G.hide1}/measures`, body, 201, key)
    expect(answer.measure).toMatchObject({ measuredArea: '49.0000', outcome: 'SHORT', differencePercent: '-5.95' })
    expect(answer.move).toMatchObject({ direction: 'OUT', quantity: '3.1000', uom: 'FT2' })
    expect(await onHand(G.hide1)).toBe('49.0000')
    expect((await hideRow(G.hide1)).area).toBe('52.1000')
    const [move] = await admin<Json>(`SELECT reason::text AS reason, "fromLocationId", "toLocationId", "hideId", note, "baseQuantity"::text AS quantity FROM "StockMove" WHERE id = $1`, [answer.move.id])
    expect(move).toMatchObject({ reason: 'ADJUSTMENT', toLocationId: null, hideId: G.hide1, quantity: '3.1000' })
    expect(move!.note).toMatch(/^Hide HD-\S+ measured 49\.00 ft²; its stock said 52\.10 ft²\. Measuring machine, calibrated\.$/)
    expect((await admin(`SELECT 1 FROM "StockValuation" WHERE "moveId" = $1`, [answer.move.id])).length).toBe(1)
    const again = await ok('keeper', 'POST', `/inventory/hides/${G.hide1}/measures`, body, 201, key)
    expect(again).toEqual(answer)
    expect(await onHand(G.hide1)).toBe('49.0000')
    // The stock says the measured area already: no move.
    expect((await ok('keeper', 'POST', `/inventory/hides/${G.hide1}/measures`, body, 201)).move).toBeNull()
    expect((await events('inventory.hide_measured')).at(-1)).toMatchObject({ outcome: 'SHORT', moveId: null })
  })

  it('refuses in words: a cut hide, an area of 0, a unit that is no area; a viewer may not; a measure is never rewritten', async () => {
    expect((await refused('keeper', 'POST', `/inventory/hides/${A.H1}/measures`, { measuredArea: '50' }, 409)).message).toBe("Hide SEED-HIDE-0001 was cut already: only a whole hide is measured against the tannery's area.")
    expect(paths(await refused('keeper', 'POST', `/inventory/hides/${G.hide1}/measures`, { measuredArea: '0' }, 400))).toEqual(['body/measuredArea'])
    expect(paths(await refused('keeper', 'POST', `/inventory/hides/${G.hide1}/measures`, { measuredArea: '5', areaUom: 'HIDE' }, 400))).toContain('body/areaUom')
    expect((await refused('viewer', 'POST', `/inventory/hides/${G.hide1}/measures`, { measuredArea: '50' }, 403)).code).toBe('forbidden')
    await expect(admin(`UPDATE "HideMeasure" SET note = 'x' WHERE "hideId" = $1`, [G.hide1])).rejects.toThrow(/append-only/)
  })
})

describe("a lot's area against the tannery's, and the claim it opens (SCM-249, QHS-025)", () => {
  it('within the order line\'s tolerance, no claim (the seeded lot)', async () => {
    const check = await ok('keeper', 'GET', `/inventory/lots/${A.lot}/area-check`)
    expect(check).toMatchObject({ lot: { code: 'SEED-LOT-LEA-01', receipt: { number: expect.any(String) } }, uom: 'FT2', tolerancePercent: '5.00', toleranceFrom: 'ORDER_LINE', counts: { hides: 2, measured: 2, notMeasured: 0 } })
    expect(check.hides.map((row: Json) => [row.hide.code, row.declared, row.measuredArea, row.outcome])).toEqual([
      ['SEED-HIDE-0001', '53.2000', '52.6000', 'WITHIN'],
      ['SEED-HIDE-0002', '51.8000', '51.3000', 'WITHIN'],
    ])
    expect(check.total).toEqual({ declared: '105.0000', measured: '103.9000', difference: '-1.1000', differencePercent: '-1.05', outcome: 'WITHIN' })
    expect(check.claim).toMatchObject({ opens: false, prefill: null, words: { en: 'Area within the tolerance: no claim.' } })
  })

  it('short beyond the tolerance: the claim body, which purchasing takes as it is', async () => {
    const check = await ok('keeper', 'GET', `/inventory/lots/${G.lot}/area-check`)
    expect(check).toMatchObject({ tolerancePercent: '2.00', toleranceFrom: 'DEFAULT', counts: { hides: 2, measured: 1, notMeasured: 1 } })
    expect(check.hides.find((row: Json) => row.hide.id === G.hide2)).toMatchObject({ measured: false, declared: null, outcome: null })
    expect(check.total).toEqual({ declared: '52.1000', measured: '49.0000', difference: '-3.1000', differencePercent: '-5.95', outcome: 'SHORT' })
    expect(check.claim.opens).toBe(true)
    expect(check.claim.existing).toEqual([])
    expect(check.claim.prefill).toMatchObject({ kind: 'CLAIM', siteId: A.siteA1, reasonCode: 'SHORT_DELIVERY' })
    expect(check.claim.prefill.reasonNote).toMatch(/^Lot \S+: 1 hide measured 49\.00 ft² against the 52\.10 ft² invoiced, 3\.10 ft² \(5\.95 %\) short, beyond the 2\.00 % tolerance\.$/)
    expect(check.claim.prefill.lines).toEqual([{ lotId: G.lot, hideId: G.hide1, quantity: '3.1000', uom: 'FT2', reason: expect.stringMatching(/: 3\.10 ft² short of the tannery's area\.$/) }])
    const claim = await ok('keeper', 'POST', '/purchasing/claims', check.claim.prefill, 201)
    const again = await ok('keeper', 'GET', `/inventory/lots/${G.lot}/area-check`)
    expect(again.claim.existing).toHaveLength(1)
    expect(again.claim.existing[0]).toMatchObject({ number: expect.any(String), status: 'DRAFT' })
    expect(JSON.stringify(claim)).toContain(again.claim.existing[0].id)
    // Without purchasing.view: no claim is named.
    expect((await ok('viewer', 'GET', `/inventory/lots/${G.lot}/area-check`)).claim.existing).toEqual([])
  })

  it('answers not found for a lot traced by lot, and for another tenant', async () => {
    expect((await refused('keeper', 'GET', `/inventory/lots/${A.liningLot}/area-check`, undefined, 404)).code).toBe('not_found')
    expect((await refused('keeperB', 'GET', `/inventory/lots/${A.lot}/area-check`, undefined, 404)).code).toBe('not_found')
  })
})
