import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth, type AuthSeed } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCostSheets, type CostSheetsSeed } from '../seed/cost-sheets'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedProductRoutes, type ProductRoutesFixture } from './testing/product-routes'

/**
 * owb-pd2w (order workflow build, S4 schema wave "routes" with "cost Keep"; build/briefs/owb-pd-server.md steps 2.1, 3.2, 3.3):
 * the rules of …_product_routes_guards on a database built from the migrations and seeded, through the real login and the
 * scoped client. The product seed's SEED-JKT-01 (P1's own label, revision 1 a DRAFT, its four ready-made routes and the knee
 * slider beside it), the production seed's SEED-JKT-02 (revision 1 RELEASED) and SEED-SO-0002 (its lines made to that revision),
 * the sales seed's SEED-SO-0001 of P1 (its lines name no revision), the cost sheets seed's DRAFT sheet of company B (made by the
 * auth seed's member), and the wave's fixture (testing/product-routes.ts: the model route "Seed double check" of SEED-JKT-01 and
 * SEED-SO-0001's line 10 "Only this order").
 *   - StyleRoute + StyleRouteStep: written while the revision is a DRAFT, FROZEN once it is released (update, delete, a new step:
 *     refused); a released revision takes no new route; a name of 1 to 80; a customer route names its customer, the brand itself
 *     on a brand's own product; a step's operation of its own department; 0 to 10000 minutes.
 *   - RouteTemplate: born OPEN at version 1; a name once among the OPEN ones whatever its case (a closed one does not count);
 *     never deleted.
 *   - SalesOrderLineRoute: refused after the order's Print FIRST (change, new row); a picked route of ANOTHER style refused, of
 *     another revision refused, a draft revision's refused for a line that names none, another customer's refused (the brand
 *     wall: the words name no customer); "Only this order" all or none, its steps' shape, departments of the tenant.
 *   - LabourRate: a department of the rate's kind; two departments of one kind keep their own rates on the same day; the
 *     department never changes.
 *   - BomLine: one main material line per revision.
 *   - Cost Keep (the redefined cost-sheet guard): the same person approving its own sheet is refused with the company's setting
 *     OFF, refused with it ON and no reason, allowed with it ON and a reason; the reason then never changes; the setting is
 *     switched on only on a company's own row.
 *   - The walls: the floor and the partner role read and write none of the new tables.
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation, a grant "permission denied"); their messages are
 * read through raw SQL. Rows only time reaches (a route written while a revision was still a draft) are planted by the owner with
 * triggers off. Every name is made up. Not run in the build (Owner rule: checks at the end).
 */

const NS = 'owb-pd2w-product-routes'
const DENIED = /permission denied/
const UNIQUE = /Unique constraint|duplicate key|unique/i
// StyleRoute / StyleRouteStep
const PART_FROZEN = (table: string): RegExp => new RegExp(`its "${table}" rows never change, a change is a new revision`)
const ROUTE_NEW = /a new route of a product is at version 1/
const ROUTE_NAME = /a route of a product has a name of 1 to 80 characters, with no space at either end/
const ROUTE_CUSTOMER = /a customer route names its customer/
const ROUTE_BRAND = /a route of a brand's own product names that brand only \(never another customer\)/
const ROUTE_VERSION = /the version of a route of a product goes up by one/
const STEP_OPERATION = /a step of a route runs an operation of its own department/
const STEP_MINUTES = /a step of a route takes 0 to 10000 minutes a piece, or none typed/
// RouteTemplate
const TEMPLATE_NEW = /a new ready-made route is OPEN, at version 1/
const TEMPLATE_NAME = /a ready-made route has a name of 1 to 80 characters, with no space at either end/
const TEMPLATE_KEPT = /a ready-made route is closed, never deleted/
// SalesOrderLineRoute
const LINE_PRINTED = /the route of an order line is fixed once the order's work papers are printed/
const LINE_PRODUCT = /an order line picks a route of its own product and revision \(the released revision when the line names none\)/
const LINE_CUSTOMER = /an order line picks a model route or a route of its own customer, never another customer's/
const LINE_PICKED = /a route picked on an order line carries when it was picked \(and by whom\), and only a picked one/
const LINE_ALL = /"Only this order" comes with its steps, why and when \(and by whom\), all together or none/
const LINE_SHAPE = /the steps of "Only this order" are a list of 1 to 50 steps/
const LINE_DEPARTMENTS = /the steps of "Only this order" are departments of the order's company or of the whole factory/
const LINE_WHY = /why an order line takes its own route is said in 1 to 500 characters, not blank/
const LINE_OWN_ORDER = /a route is kept for a line of its own order/
// LabourRate
const RATE_KIND = /is for department \d+, which works at/
const RATE_FIXED = /the department of the labour rate .* never changes/
// Cost Keep
const SHEET_OWN = /is approved by someone other than the person who made it \(nobody approves their own\), unless the company lets one person keep a cost and the reason is given/
const SHEET_REASON = /why one person kept cost sheet .* is said in 1 to 500 characters, not blank/
const SHEET_LOCKED = /is approved and locked: it is never edited, only frozen/
const KEEPER_ROW = /"one person may keep a cost" is switched on only on a company's own costing settings/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let auth: AuthSeed
let portal: PortalAuthSeed
let production: ProductionSeed
let sales: SalesSeed
let sheets: CostSheetsSeed
let pr: ProductRoutesFixture

const key = (name: string): string => seedUuid(NS, name)
const lastKey = (name: string): string => `ffffffff${key(name).slice(8)}`
const P1 = key('party:P1')
const P3 = key('party:P3')
const companyA = key('company:A')
const companyB = key('company:B')
const siteA = key('site:A1')
const department = (number: number): string => key(`product:department:${number}`)
const defaultOperation = (number: number): string => lastKey(`product:operation:DEPT-${number}`)
const jkt01 = key('product:style:JKT-01')
const jkt01Rev1 = key('product:revision:JKT-01:1')
const slider = lastKey('product:style:KS-01')
const sliderRev1 = lastKey('product:revision:KS-01:1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: production.operatorId, siteId: siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
/** The owner, with every trigger off for one statement (set-up only: rows only time reaches). */
async function replica(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** A copy of row `id` of `table` with `changes`, planted. */
const plant = (table: string, id: string, changes: Record<string, unknown>) =>
  replica(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
const tag = (prefix: string): string => `${prefix} ${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, P3])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

const routeRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  styleId: jkt01,
  revisionId: jkt01Rev1,
  name: tag('Made-up route'),
  kind: 'MODEL',
  seq: 2,
  createdById: a.actorId,
  ...extra,
})
const stepRow = (routeId: string, revisionId: string, number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  revisionId,
  routeId,
  seq: number,
  departmentId: department(number),
  operationId: defaultOperation(number),
  createdById: a.actorId,
  ...extra,
})
/** A new DRAFT revision of a style, planted as a copy of `fromRevision` (a revision only time reaches); its id. */
async function plantRevision(fromRevision: string, revision: number): Promise<string> {
  const id = randomUUID()
  await plant('StyleRevision', fromRevision, { id, revision, status: 'DRAFT', releasedAt: null, releasedById: null, changeNote: 'Made-up revision.' })
  return id
}
const release = (revisionId: string) => replica(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid WHERE id = $1::uuid`, [revisionId, a.actorId])
const lineRouteRow = (salesOrderId: string, salesOrderLineId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId,
  salesOrderLineId,
  createdById: a.actorId,
  ...extra,
})
const exception = (numbers: readonly number[], why = 'The customer asked for it (made up).'): Record<string, unknown> => ({
  exceptionSteps: numbers.map((number) => ({ departmentId: department(number), minutes: null })),
  exceptionReason: why,
  exceptionAt: new Date().toISOString(),
  exceptionById: a.actorId,
})
const picked = (styleRouteId: string): Record<string, unknown> => ({ styleRouteId, pickedAt: new Date().toISOString(), pickedById: a.actorId })
/** The lines of an order, in their order. */
const linesOf = async (orderId: string): Promise<string[]> =>
  (await admin(`SELECT id::text AS id FROM "SalesOrderLine" WHERE "orderId" = $1::uuid ORDER BY seq`, [orderId])).map((row) => String(row.id))

beforeAll(async () => {
  db = await migratedDatabase('productroutes')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  auth = await seedAuth({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  sales = await seedSales({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  sheets = await seedCostSheets({ db: factory, namespace: NS })
  pr = await seedProductRoutes({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the seed: product types, ready-made routes, the molded knee slider', () => {
  it('three product types of kind OTHER, four ready-made routes in department order, the knee slider on the molded route', async () => {
    const types = await admin(`SELECT code, "productType"::text AS kind FROM "ProductTypeProfile" WHERE "tenantId" = $1::uuid AND code LIKE 'SEED-PT-%' AND "productType" = 'OTHER' ORDER BY code`, [a.tenantId])
    expect(types.map((row) => row.code)).toEqual(['SEED-PT-HOODIE', 'SEED-PT-MOLDED', 'SEED-PT-TSHIRT'])
    const routes = await admin(
      `SELECT t.name, array_agg(d.number ORDER BY s.seq) AS numbers FROM "RouteTemplate" t JOIN "RouteTemplateStep" s ON s."templateId" = t.id JOIN "Department" d ON d.id = s."departmentId"
        WHERE t."tenantId" = $1::uuid GROUP BY t.name ORDER BY t.name`,
      [a.tenantId],
    )
    expect(routes).toEqual([
      { name: 'Leather garment', numbers: [1, 2, 3, 4, 5, 6] },
      { name: 'Molded and assembled', numbers: [7, 8, 9, 5, 6] },
      { name: 'Molded part', numbers: [7, 8, 5, 6] },
      { name: 'Textile, on a line', numbers: [2, 3, 4, 5, 6] },
    ])
    const steps = await admin(`SELECT d.number FROM "RoutingOperation" r JOIN "Department" d ON d.id = r."departmentId" WHERE r."revisionId" = $1::uuid ORDER BY r.seq`, [sliderRev1])
    expect(steps.map((row) => row.number)).toEqual([7, 8, 5, 6])
    const [knee] = await admin(`SELECT s.name, s.status::text AS status, s."brandPartyId", p.code AS type FROM "Style" s JOIN "ProductTypeProfile" p ON p.id = s."productTypeProfileId" WHERE s.id = $1::uuid`, [slider])
    expect(knee).toEqual({ name: 'Knee slider, molded', status: 'DRAFT', brandPartyId: null, type: 'SEED-PT-MOLDED' })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('StyleRoute and StyleRouteStep (the part rule; factory_style_route_check, factory_style_route_step_check)', () => {
  it('a DRAFT revision takes a route and its steps; a RELEASED one takes none', async () => {
    const route = routeRow({})
    expect(await insert(office(), 'StyleRoute', route)).toBe(1)
    expect(await insert(office(), 'StyleRouteStep', stepRow(String(route.id), jkt01Rev1, 2))).toBe(1)
    expect(await insert(office(), 'StyleRouteStep', stepRow(String(route.id), jkt01Rev1, 6, { seq: 2, minutes: '3.5' }))).toBe(1)
    // SEED-JKT-02's revision 1 is released (the production seed): no new route on it.
    expect(await refusalOf(insert(office(), 'StyleRoute', routeRow({ styleId: production.styleId, revisionId: production.revisionId })))).toMatch(PART_FROZEN('StyleRoute'))
  })

  it('FROZEN after release: the route and its steps never change, are never removed, take no new step', async () => {
    // The knee slider's revision 9, planted as a draft: its route is written, then the revision is released.
    const revision = await plantRevision(sliderRev1, 9)
    const route = routeRow({ styleId: slider, revisionId: revision })
    expect(await insert(office(), 'StyleRoute', route)).toBe(1)
    const step = stepRow(String(route.id), revision, 2)
    expect(await insert(office(), 'StyleRouteStep', step)).toBe(1)
    await release(revision)
    expect(await refusalOf(update(office(), 'StyleRoute', String(route.id), `name = 'Renamed (made up)', version = version + 1`))).toMatch(PART_FROZEN('StyleRoute'))
    expect(await refusalOf(remove(office(), 'StyleRoute', String(route.id)))).toMatch(PART_FROZEN('StyleRoute'))
    expect(await refusalOf(update(office(), 'StyleRouteStep', String(step.id), `minutes = 12`))).toMatch(PART_FROZEN('StyleRouteStep'))
    expect(await refusalOf(remove(office(), 'StyleRouteStep', String(step.id)))).toMatch(PART_FROZEN('StyleRouteStep'))
    expect(await refusalOf(insert(office(), 'StyleRouteStep', stepRow(String(route.id), revision, 4, { seq: 2 })))).toMatch(PART_FROZEN('StyleRouteStep'))
    // An UPDATE that changes nothing passes (the isolation tests' touch).
    expect(await update(office(), 'StyleRoute', String(route.id), `name = name`)).toBe(1)
  })

  it('its words, its customer and its version; the brand itself on a brand\'s own product, in neutral words', async () => {
    expect(await refusalOf(insert(office(), 'StyleRoute', routeRow({ name: ' Padded ' })))).toMatch(ROUTE_NAME)
    expect(await refusalOf(insert(office(), 'StyleRoute', routeRow({ name: 'x'.repeat(81) })))).toMatch(ROUTE_NAME)
    expect(await refusalOf(insert(office(), 'StyleRoute', routeRow({ kind: 'CUSTOMER', partyId: null })))).toMatch(ROUTE_CUSTOMER)
    expect(await refusalOf(insert(office(), 'StyleRoute', routeRow({ version: 2 })))).toMatch(ROUTE_NEW)
    // SEED-JKT-01 is P1's own label: a route of it names P1 or nobody.
    expect(await insert(office(), 'StyleRoute', routeRow({ kind: 'CUSTOMER', partyId: P1 }))).toBe(1)
    const words = await refusalOf(insert(office(), 'StyleRoute', routeRow({ kind: 'MODEL', partyId: P3 })))
    expect(words).toMatch(ROUTE_BRAND)
    await expectNeutral(words)
    // The knee slider is of our range: any customer may have its own route.
    expect(await insert(office(), 'StyleRoute', routeRow({ styleId: slider, revisionId: sliderRev1, kind: 'CUSTOMER', partyId: P3 }))).toBe(1)
    // Two routes of a revision never share a name; the version goes up by one.
    expect(await refusalOf(insert(office(), 'StyleRoute', routeRow({ name: 'Seed double check' })))).toMatch(UNIQUE)
    expect(await refusalOf(update(office(), 'StyleRoute', pr.ids.route, `seq = 3, version = version + 2`))).toMatch(ROUTE_VERSION)
    expect(await update(office(), 'StyleRoute', pr.ids.route, `seq = 3, version = version + 1`)).toBe(1)
  })

  it("a step runs an operation of its own department, 0 to 10000 minutes; it never moves to another revision", async () => {
    expect(await refusalOf(insert(office(), 'StyleRouteStep', stepRow(pr.ids.route, jkt01Rev1, 7, { seq: 9, operationId: defaultOperation(8) })))).toMatch(STEP_OPERATION)
    expect(await refusalOf(insert(office(), 'StyleRouteStep', stepRow(pr.ids.route, jkt01Rev1, 7, { seq: 9, minutes: '10000.5' })))).toMatch(STEP_MINUTES)
    expect(await refusalOf(update(office(), 'StyleRouteStep', pr.ids.steps[0]!, `minutes = -1`))).toMatch(STEP_MINUTES)
    expect(await refusalOf(update(office(), 'StyleRouteStep', pr.ids.steps[0]!, `"revisionId" = $2::uuid`, sliderRev1))).toMatch(/never moves to another revision|_fkey|foreign key/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('RouteTemplate (factory_route_template_guard; RouteTemplate_open_name_factory)', () => {
  it('born OPEN at version 1; a name once among the OPEN ones whatever its case; a closed one does not count; never deleted', async () => {
    const row = (extra: Record<string, unknown>) => ({ id: randomUUID(), name: tag('Made-up ready route'), createdById: a.actorId, ...extra })
    expect(await refusalOf(insert(office(), 'RouteTemplate', row({ status: 'CLOSED' })))).toMatch(TEMPLATE_NEW)
    expect(await refusalOf(insert(office(), 'RouteTemplate', row({ name: '' })))).toMatch(TEMPLATE_NAME)
    expect(await refusalOf(insert(office(), 'RouteTemplate', row({ name: 'MOLDED PART' })))).toMatch(UNIQUE)
    const [molded] = await admin(`SELECT id::text AS id FROM "RouteTemplate" WHERE "tenantId" = $1::uuid AND name = 'Molded part'`, [a.tenantId])
    expect(await update(office(), 'RouteTemplate', String(molded!.id), `status = 'CLOSED', version = version + 1`)).toBe(1)
    expect(await insert(office(), 'RouteTemplate', row({ name: 'Molded part' }))).toBe(1)
    expect(await refusalOf(update(office(), 'RouteTemplate', String(molded!.id), `status = 'OPEN', version = version + 1`))).toMatch(UNIQUE)
    expect(await refusalOf(remove(office(), 'RouteTemplate', String(molded!.id)))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "RouteTemplate" WHERE id = $1::uuid`, [molded!.id])).rejects.toThrow(TEMPLATE_KEPT)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('SalesOrderLineRoute (factory_sales_order_line_route_guard)', () => {
  it('a picked route of ANOTHER style is refused; of the line\'s style but another revision too; another customer\'s too, in neutral words', async () => {
    // SEED-SO-0002's lines are made to SEED-JKT-02's revision 1 (released). Its routes were written while it was a draft.
    const [line10, line20] = await linesOf(production.salesOrderId)
    const own = randomUUID()
    const theirs = randomUUID()
    await plant('StyleRoute', pr.ids.route, { id: own, styleId: production.styleId, revisionId: production.revisionId, name: 'Made-up model of JKT-02' })
    await plant('StyleRoute', pr.ids.route, { id: theirs, styleId: production.styleId, revisionId: production.revisionId, name: 'Made-up route of another customer', kind: 'CUSTOMER', partyId: P3 })
    // SEED-JKT-01's model route on SEED-SO-0002's line: another style.
    const other = await refusalOf(insert(office(), 'SalesOrderLineRoute', lineRouteRow(production.salesOrderId, line10!, picked(pr.ids.route))))
    expect(other).toMatch(LINE_PRODUCT)
    // Another revision of SEED-JKT-02 (a draft planted beside the released one).
    const draft = await plantRevision(production.revisionId, 7)
    const ofDraft = randomUUID()
    await plant('StyleRoute', pr.ids.route, { id: ofDraft, styleId: production.styleId, revisionId: draft, name: 'Made-up route of a draft' })
    expect(await refusalOf(insert(office(), 'SalesOrderLineRoute', lineRouteRow(production.salesOrderId, line10!, picked(ofDraft))))).toMatch(LINE_PRODUCT)
    // Another customer's route: refused, and the words name no customer.
    const words = await refusalOf(insert(office(), 'SalesOrderLineRoute', lineRouteRow(production.salesOrderId, line10!, picked(theirs))))
    expect(words).toMatch(LINE_CUSTOMER)
    await expectNeutral(words)
    // The model route of the line's own style and revision: picked; then changed back to none.
    const choice = lineRouteRow(production.salesOrderId, line10!, picked(own))
    expect(await insert(office(), 'SalesOrderLineRoute', choice)).toBe(1)
    expect(await update(office(), 'SalesOrderLineRoute', String(choice.id), `"styleRouteId" = NULL, "pickedAt" = NULL, "pickedById" = NULL, version = version + 1`)).toBe(1)
    // A line of another order is not this order's.
    expect(await refusalOf(insert(office(), 'SalesOrderLineRoute', lineRouteRow(sales.orderId, line20!, exception([2, 6]))))).toMatch(LINE_OWN_ORDER)
  })

  it("a line that names no revision picks a route of its product's RELEASED revision only", async () => {
    // SEED-SO-0001's lines name no revision; SEED-JKT-01 has none released: its draft's route is refused.
    const [, line20] = pr.orderLineIds
    expect(await refusalOf(insert(office(), 'SalesOrderLineRoute', lineRouteRow(pr.orderId, line20, picked(pr.ids.route))))).toMatch(LINE_PRODUCT)
    // Revision 8 released (planted as a draft, its route written, then released): its route is picked.
    const revision = await plantRevision(jkt01Rev1, 8)
    const route = routeRow({ revisionId: revision })
    expect(await insert(office(), 'StyleRoute', route)).toBe(1)
    await release(revision)
    const choice = lineRouteRow(pr.orderId, line20, picked(String(route.id)))
    expect(await insert(office(), 'SalesOrderLineRoute', choice)).toBe(1)
    expect(await refusalOf(update(office(), 'SalesOrderLineRoute', String(choice.id), `"pickedAt" = NULL, version = version + 1`))).toMatch(LINE_PICKED)
  })

  it('"Only this order": steps, why and when together; 1 to 50 steps of the tenant\'s departments; why 1 to 500', async () => {
    const id = pr.ids.lineRoute
    const set = (steps: unknown) => update(office(), 'SalesOrderLineRoute', id, `"exceptionSteps" = $2::jsonb, version = version + 1`, JSON.stringify(steps))
    expect(await refusalOf(update(office(), 'SalesOrderLineRoute', id, `"exceptionReason" = NULL, version = version + 1`))).toMatch(LINE_ALL)
    expect(await refusalOf(update(office(), 'SalesOrderLineRoute', id, `"exceptionReason" = '   ', version = version + 1`))).toMatch(LINE_WHY)
    expect(await refusalOf(set([]))).toMatch(LINE_SHAPE)
    expect(await refusalOf(set({ departmentId: department(2) }))).toMatch(LINE_SHAPE)
    expect(await refusalOf(set(['not a step']))).toMatch(LINE_SHAPE)
    expect(await refusalOf(set([{ departmentId: department(2), minutes: '-1' }]))).toMatch(LINE_SHAPE)
    expect(await refusalOf(set([{ departmentId: department(2), minutes: null, note: 'extra' }]))).toMatch(LINE_SHAPE)
    expect(await refusalOf(set(Array.from({ length: 51 }, () => ({ departmentId: department(4) }))))).toMatch(LINE_SHAPE)
    // No department of this tenant: refused (no foreign key holds the list).
    expect(await refusalOf(set([{ departmentId: randomUUID() }]))).toMatch(LINE_DEPARTMENTS)
    expect(await set([{ departmentId: department(2), minutes: '12.5' }, { departmentId: department(4), minutes: 30 }, { departmentId: department(6) }])).toBe(1)
  })

  it('FIXED after Print FIRST: nothing changes, no new choice; the floor and the customer never read it', async () => {
    const [line10] = pr.orderLineIds
    // SEED-SO-0001's first print (the office starts the work).
    expect(await insert(office(), 'OrderPrint', { id: randomUUID(), companyId: companyA, partyId: P1, salesOrderId: pr.orderId, kind: 'FIRST', pages: [], cards: [], createdById: a.actorId })).toBe(1)
    expect(await refusalOf(update(office(), 'SalesOrderLineRoute', pr.ids.lineRoute, `"exceptionReason" = 'Changed after the print (made up).', version = version + 1`))).toMatch(LINE_PRINTED)
    // Line 20's choice (the test before) is fixed too, and a line with no choice takes none.
    const [chosen] = await admin(`SELECT id::text AS id FROM "SalesOrderLineRoute" WHERE "salesOrderId" = $1::uuid AND "salesOrderLineId" <> $2::uuid`, [pr.orderId, line10])
    expect(await refusalOf(update(office(), 'SalesOrderLineRoute', String(chosen!.id), `"styleRouteId" = NULL, "pickedAt" = NULL, "pickedById" = NULL, version = version + 1`))).toMatch(LINE_PRINTED)
    await expect(admin(`DELETE FROM "SalesOrderLineRoute" WHERE id = $1::uuid`, [pr.ids.lineRoute])).rejects.toThrow(LINE_PRINTED)
    expect(await refusalOf(remove(office(), 'SalesOrderLineRoute', pr.ids.lineRoute))).toMatch(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('LabourRate (LabourRate_department_check and the per-day keys)', () => {
  it("a department of the rate's kind; two departments of one kind keep their own rates on the same day; the department never changes", async () => {
    const rate = (extra: Record<string, unknown>) => ({ id: randomUUID(), workCentreKind: 'CUTTING', costPerMinute: '0.5', validFrom: '2027-03-01', createdById: a.actorId, ...extra })
    // The kind's rate of the whole factory and the two CUTTING departments' own rates (1 Pattern, 2 Cutting), all on one day.
    expect(await insert(office(), 'LabourRate', rate({}))).toBe(1)
    const pattern = rate({ departmentId: department(1), costPerMinute: '0.55' })
    expect(await insert(office(), 'LabourRate', pattern)).toBe(1)
    expect(await insert(office(), 'LabourRate', rate({ departmentId: department(2), costPerMinute: '0.6' }))).toBe(1)
    // The same department twice on one day, the kind twice on one day: refused.
    expect(await refusalOf(insert(office(), 'LabourRate', rate({ departmentId: department(1) })))).toMatch(UNIQUE)
    expect(await refusalOf(insert(office(), 'LabourRate', rate({})))).toMatch(UNIQUE)
    // Company A's own: the same rules.
    expect(await insert(office(), 'LabourRate', rate({ companyId: companyA }))).toBe(1)
    expect(await refusalOf(insert(office(), 'LabourRate', rate({ companyId: companyA })))).toMatch(UNIQUE)
    expect(await insert(office(), 'LabourRate', rate({ companyId: companyA, departmentId: department(1) }))).toBe(1)
    // 4 Stitching works at SEWING, not CUTTING.
    expect(await refusalOf(insert(office(), 'LabourRate', rate({ departmentId: department(4), validFrom: '2027-03-02' })))).toMatch(RATE_KIND)
    expect(await refusalOf(update(office(), 'LabourRate', String(pattern.id), `"departmentId" = $2::uuid, version = version + 1`, department(2)))).toMatch(RATE_FIXED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('BomLine.isMain (BomLine_one_main)', () => {
  it('one main material line per revision', async () => {
    const lines = await admin(`SELECT id::text AS id FROM "BomLine" WHERE "revisionId" = $1::uuid ORDER BY seq`, [jkt01Rev1])
    expect(await update(office(), 'BomLine', String(lines[0]!.id), `"isMain" = true, version = version + 1`)).toBe(1)
    expect(await refusalOf(update(office(), 'BomLine', String(lines[1]!.id), `"isMain" = true, version = version + 1`))).toMatch(UNIQUE)
    // A line made without the column is not the main one (the database's default).
    const [made] = await admin(`SELECT "isMain" FROM "BomLine" WHERE id = $1::uuid`, [lines[1]!.id])
    expect(made!.isMain).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('Cost Keep (the redefined factory_cost_sheet_guard; CostingSettings_one_keeper_check)', () => {
  // Company B's DRAFT sheet, made by the auth seed's member (the cost sheets seed).
  const approveOwn = (reason: string | null) =>
    update(office(), 'CostSheet', sheets.sheetIds.draftB, `state = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid, "keptAloneReason" = $3, version = version + 1`, auth.memberId, reason)
  const setOneKeeper = (on: boolean) =>
    run(
      office(),
      `INSERT INTO "CostingSettings" (id, "companyId", "overheadPct", "overheadFromTenant", "oneKeeperAllowed", "createdById")
       VALUES ($1::uuid, $1::uuid, 0, true, $2, $3::uuid)
       ON CONFLICT (id) DO UPDATE SET "oneKeeperAllowed" = $2, version = "CostingSettings".version + 1`,
      companyB,
      on,
      a.actorId,
    )

  it('the same person: refused with the setting OFF', async () => {
    const [sheet] = await admin(`SELECT state::text AS state, "createdById"::text AS maker FROM "CostSheet" WHERE id = $1::uuid`, [sheets.sheetIds.draftB])
    expect(sheet).toEqual({ state: 'DRAFT', maker: auth.memberId })
    expect(await refusalOf(approveOwn('Only one person costs company B (made up).'))).toMatch(SHEET_OWN)
    await setOneKeeper(false)
    expect(await refusalOf(approveOwn('Only one person costs company B (made up).'))).toMatch(SHEET_OWN)
  })

  it('refused with the setting ON and no reason (or a blank one)', async () => {
    await setOneKeeper(true)
    expect(await refusalOf(approveOwn(null))).toMatch(SHEET_OWN)
    expect(await refusalOf(approveOwn('   '))).toMatch(SHEET_REASON)
  })

  it('allowed with the setting ON and a reason; the reason never changes after; the setting lives on a company\'s own row', async () => {
    expect(await approveOwn('Only one person costs company B (made up).')).toBe(1)
    expect(await refusalOf(update(office(), 'CostSheet', sheets.sheetIds.draftB, `"keptAloneReason" = 'Another reason (made up).', version = version + 1`))).toMatch(SHEET_LOCKED)
    const [kept] = await admin(`SELECT state::text AS state, "approvedById"::text AS approver, "keptAloneReason" AS reason FROM "CostSheet" WHERE id = $1::uuid`, [sheets.sheetIds.draftB])
    expect(kept).toEqual({ state: 'APPROVED', approver: auth.memberId, reason: 'Only one person costs company B (made up).' })
    // The row of the whole factory never switches it on.
    expect(await refusalOf(run(office(), `UPDATE "CostingSettings" SET "oneKeeperAllowed" = true, version = version + 1 WHERE "companyId" IS NULL`))).toMatch(KEEPER_ROW)
  })

  it('a reason of more than 500 characters is refused on a draft too', async () => {
    // Company A's DRAFT (version 3, made by the member): its words checked while it is a draft.
    expect(await refusalOf(update(office(), 'CostSheet', sheets.sheetIds.draftA, `"keptAloneReason" = $2, version = version + 1`, 'x'.repeat(501)))).toMatch(SHEET_REASON)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the walls: the floor and the customer read and write none of the new tables', () => {
  const TABLES = ['StyleRoute', 'StyleRouteStep', 'RouteTemplate', 'RouteTemplateStep', 'SalesOrderLineRoute'] as const

  it.each(TABLES)('%s: the floor and the partner role have no grant', async (table) => {
    for (const scope of [floor(), p1()]) {
      expect(await refusalOf(as(scope, (client) => client.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)))).toMatch(DENIED)
      expect(await refusalOf(run(scope, `UPDATE "${table}" SET id = id WHERE false`))).toMatch(DENIED)
    }
  })
})
