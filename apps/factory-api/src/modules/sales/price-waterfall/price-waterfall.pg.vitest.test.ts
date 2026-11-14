import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { suggestedPriceOf } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { taxable } from '@nexus/factory-domain/tax/vat-treatment'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSalesPricing, type SalesPricingSeed } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { settlementOf } from '../../invoicing/from-shipment/settlement'
import { systemContext } from '../../../platform/outbox/system'
import { feeLinesFor, feesBilledOf } from './fee-invoicing'
import { saveMarginFloors } from './floors'

/**
 * B-W2b-330 on the local stack, with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security, the grants and the …_sales_pricing_w2b_guards triggers — the waterfall that must
 * add up, dropped when a price changes without it — are real). The seeds' P1 list SEED-PL-P1 version 1 (SEED-JKT-01 at
 * 420.00), the tenant's floors by role (sales 25 %, owner 10 %; the company floor 20 %), SEED-Q-0004 (SENT, LIST 430 →
 * MANUAL −10 VOLUME → NET 420) and SEED-SO-0004 (CONFIRMED, SUGGESTED 400 → liner → MANUAL +10 LOYALTY → NET 470). A
 * seller (the sales role) and the owner (the owner role) each make a quote; prices are made up and worked out by hand.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/price-waterfall/`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: SalesPricingSeed

const NS = 'price-waterfall-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jkt01 = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
const PEOPLE: Record<string, { readonly template: string; readonly role: string | null; readonly dropGrains?: readonly string[] }> = {
  seller: { template: 'sales', role: 'sales' },
  owner: { template: 'owner', role: 'owner' },
  // The sales role without the price and margin grains (a custom role may be).
  blind: { template: 'sales', role: null, dropGrains: ['price', 'margin'] },
  // An approver: finance decides quote approvals.
  finance: { template: 'finance', role: 'finance' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const role = templateOf(person.template)!
    const grains = role.grains.filter((grain) => !(person.dropGrains ?? []).includes(grain))
    // finance decides quote approvals; the seller may approve too, so the test reaches "nobody approves their own request".
    const approves = person.template === 'finance' || key === 'seller'
    const grant: Grant = { permissions: [...role.permissions, ...grainsOf(grains), ...(approves ? (['quotes.approve'] as Permission[]) : [])], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const officeCaller = (session: string): CommandCaller => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const q = (id: string) => `/sales/quotes/${id}`

const quotes: { seller: Json; owner: Json } = { seller: {}, owner: {} }
async function newQuote(who: string): Promise<Json> {
  let quote = (await ok(who, 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
  quote = (await ok(who, 'POST', `${q(quote.id)}/lines`, { version: quote.version, styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }, { size: '54', quantity: 2 }] }, 201)).quote
  return quote
}
const lineOf = (quote: Json) => quote.lines.find((line: Json) => line.kind === 'SIZE_GRID')
/** The line's unit cost as priced (the seller holds no cost grain: read as the database keeps it). */
const unitCostOf = async (lineId: string): Promise<string> => (await admin<{ cost: string }>(`SELECT trim(trailing '.' from trim(trailing '0' from "unitCost"::text)) AS cost FROM "QuoteLine" WHERE id = $1`, [lineId]))[0]!.cost

beforeAll(async () => {
  db = await migratedDatabase('price_waterfall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  seeded = await seedSalesPricing({ db: database, namespace: NS })
  // The PRICE_ADJUSTMENT reasons (LOYALTY, COMPETITION, VOLUME, …, OTHER with words).
  await seedReasons({ db: database, namespace: NS })
  // The people, with live assignments of the tenant's system roles: the floor of a quote is read from its maker's roles.
  for (const [key, person] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.waterfall@example.com`, `Waterfall ${key}`])
    if (person.role === null) continue
    const [role] = await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [tenant, person.role])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', now() - interval '1 day')`, [newId(), tenant, IDS[key], role!.id])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // A size surcharge of SEED-JKT-01's own (B-W2b-325's route): size 54 adds 15.00.
  await ok('seller', 'PUT', `/sales/styles/${jkt01}/size-surcharges`, { surcharges: [{ size: '54', amount: '15', currency: 'EUR', pct: null }] })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a line priced by its waterfall, list to net (SAL-174, SAL-175)', () => {
  it("reads what the list would give, the price the cost suggests and the floor of the quote's maker", async () => {
    quotes.seller = await newQuote('seller')
    const line = lineOf(quotes.seller)
    expect(line).toMatchObject({ listUnitPrice: '420', unitPrice: '420' })
    const pricing = await ok('seller', 'GET', `${q(quotes.seller.id)}/pricing`)
    expect(pricing.floor).toMatchObject({ marginFloorPct: '25', source: 'ROLE', roleKey: 'sales', personId: IDS.seller })
    const priced = pricing.lines[0]
    // W1 priced it without a waterfall.
    expect(priced).toMatchObject({ kind: 'SIZE_GRID', steps: null, why: null, adjustmentReason: null })
    expect(priced.fromList.map((step: Json) => [step.kind, step.unitPrice ?? step.sizes])).toEqual([
      ['LIST', '420'],
      ['SIZE_SURCHARGE', { '54': '15' }],
      ['NET', '420'],
    ])
    // The cost of the revision as priced, at the seller's 25 %: cost ÷ 0.75, up to the cent.
    const expected = suggestedPriceOf({ unitCost: await unitCostOf(line.id), marginPct: '25', currency: 'EUR' })
    expect(priced.suggested).toMatchObject({ unitPrice: 'unitPrice' in expected ? expected.unitPrice : null, marginPct: '25', problem: null, basedOn: { revisionId: line.styleRevisionId } })
    // Without the price and margin grains: no figure, no waterfall.
    const blind = (await ok('blind', 'GET', `${q(quotes.seller.id)}/pricing`)).lines[0]
    for (const field of ['unitPrice', 'steps', 'why', 'fromList', 'marginPct']) expect(blind).not.toHaveProperty(field)
    expect(blind.suggested).not.toHaveProperty('unitPrice')
  })

  it('writes list → discount → manual net with its reason → size surcharge → net in one update; the database takes it', async () => {
    const line = lineOf(quotes.seller)
    const answer = await ok('seller', 'PUT', `${q(quotes.seller.id)}/lines/${line.id}/price`, {
      version: quotes.seller.version,
      start: 'LIST',
      discount: { pct: '5', reasonCode: 'VOLUME' },
      net: { unitPrice: '395', reasonCode: 'COMPETITION', note: 'Made-up: matched the price offered elsewhere.' },
    })
    quotes.seller = answer.quote
    // 420 − 5 % (21) = 399; typed 395: −4 COMPETITION; size 54 + 15 beside it.
    expect(answer.line.steps.map((step: Json) => [step.kind, step.delta ?? null, step.unitPrice ?? null])).toEqual([
      ['LIST', null, '420'],
      ['DISCOUNT', '-21', '399'],
      ['MANUAL', '-4', '395'],
      ['SIZE_SURCHARGE', null, null],
      ['NET', null, '395'],
    ])
    expect(answer.line.why.sentence).toBe('List price (SEED-PL-P1 version 1) 420.00; Discount (5 %, Volume) − 21.00 = 399.00; Manual change (Competition) − 4.00 = 395.00; Size surcharge (Size 54): size 54 + 15.00; Net 395.00.')
    const after = lineOf(quotes.seller)
    expect(after).toMatchObject({ unitPrice: '395', listUnitPrice: '420', discountPct: '5.9524' })
    expect(after.sizes.map((row: Json) => [row.size, row.unitPrice])).toEqual([
      ['50', null],
      ['52', null],
      ['54', '410'],
    ])
    // 6 × 395 + 2 × 410 = 3190.00.
    expect(after.netAmount).toBe(319_000)
    const [stored] = await admin(`SELECT "priceSteps", "adjustmentReason", "unitPrice"::text FROM "QuoteLine" WHERE id = $1`, [line.id])
    expect(stored!.adjustmentReason).toBe('COMPETITION')
    expect(stored!.priceSteps.map((step: Json) => step.kind)).toEqual(['LIST', 'DISCOUNT', 'MANUAL', 'SIZE_SURCHARGE', 'NET'])
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'quotes.priceLine' AND "recordId" = $1`, [quotes.seller.id])
    expect(JSON.stringify(audit!.after)).toContain('"$money":"price"')
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'quote.lines_changed' AND subject = $1 ORDER BY "occurredAt", id`, [quotes.seller.id])
    expect(events.at(-1)!.payload).toMatchObject({ change: 'changed', lineId: line.id })
    // "Why this price?" reads it back.
    const pricing = (await ok('seller', 'GET', `${q(quotes.seller.id)}/pricing`)).lines[0]
    expect(pricing).toMatchObject({ adjustmentReason: 'COMPETITION', stepsProblem: null, unitPrice: '395' })
    expect(pricing.why.rows.map((row: Json) => row.reasonCode)).toEqual([null, 'VOLUME', 'COMPETITION', null, null])
  })

  it('refuses in words: a reason that is not one, a reason that needs words, a typed start without its reason, a stale quote, a fee', async () => {
    const line = lineOf(quotes.seller)
    const url = `${q(quotes.seller.id)}/lines/${line.id}/price`
    const version = quotes.seller.version
    expect((await refused('seller', 'PUT', url, { version, start: 'LIST', net: { unitPrice: '390', reasonCode: 'CHEAPER' } }, 400)).message).toBe('"CHEAPER" is not an active reason for a price change: choose one of the price adjustment reasons (Sales settings › Reasons).')
    expect((await refused('seller', 'PUT', url, { version, start: 'LIST', net: { unitPrice: '390', reasonCode: 'OTHER' } }, 400)).message).toBe('The reason "Other" needs a few words: add a note.')
    expect((await refused('seller', 'PUT', url, { version, start: 'MANUAL', startPrice: '380' }, 400)).message).toBe('A typed starting price names its reason (SAL-175).')
    expect((await refused('seller', 'PUT', url, { version: version - 1, start: 'LIST' }, 409)).message).toMatch(/version/i)
    // Without the price grain no price is sent.
    await refused('blind', 'PUT', url, { version, start: 'MANUAL', startPrice: '380', startReasonCode: 'GOODWILL' }, 403)
    // The line is as it was.
    expect(lineOf((await ok('seller', 'GET', q(quotes.seller.id))).quote)).toMatchObject({ unitPrice: '395', version: line.version })
  })

  it("drops the waterfall when W1's line edit changes the price without it (never stale)", async () => {
    const line = lineOf(quotes.seller)
    quotes.seller = (await ok('seller', 'PATCH', `${q(quotes.seller.id)}/lines/${line.id}`, { version: quotes.seller.version, unitPrice: '401' })).quote
    const [stored] = await admin(`SELECT "priceSteps" FROM "QuoteLine" WHERE id = $1`, [line.id])
    expect(stored!.priceSteps).toBeNull()
    expect((await ok('seller', 'GET', `${q(quotes.seller.id)}/pricing`)).lines[0]).toMatchObject({ steps: null, unitPrice: '401' })
  })

  it('starts from the price the cost suggests (SAL-173), at the floor or at the margin asked', async () => {
    const line = lineOf(quotes.seller)
    const url = `${q(quotes.seller.id)}/lines/${line.id}/price`
    let answer = await ok('seller', 'PUT', url, { version: quotes.seller.version, start: 'SUGGESTED' })
    quotes.seller = answer.quote
    const unitCost = await unitCostOf(line.id)
    const at25 = suggestedPriceOf({ unitCost, marginPct: '25', currency: 'EUR' }) as { unitPrice: string }
    expect(answer.line.steps).toEqual([
      { kind: 'SUGGESTED', unitPrice: at25.unitPrice, source: { type: 'StyleRevision', id: line.styleRevisionId }, label: 'From the cost and the margin to earn' },
      { kind: 'NET', unitPrice: at25.unitPrice },
    ])
    // At the floor (or just above it): no approval is needed for the margin.
    expect(quotes.seller.approval.rules.find((rule: Json) => rule.reason === 'MARGIN_FLOOR')).toMatchObject({ known: true, broken: false })
    answer = await ok('seller', 'PUT', url, { version: quotes.seller.version, start: 'SUGGESTED', marginPct: '40' })
    quotes.seller = answer.quote
    expect(answer.line.unitPrice).toBe((suggestedPriceOf({ unitCost, marginPct: '40', currency: 'EUR' }) as { unitPrice: string }).unitPrice)
    // The margin asked is the margin grain.
    await refused('blind', 'PUT', url, { version: quotes.seller.version, start: 'SUGGESTED', marginPct: '30' }, 403)
  })
})

describe('the margin floor of the person quoting (SAL-189)', () => {
  // A price that earns about 21 %: under the seller's 25 %, over the owner's 10 % (and the company's 20 %); within the
  // 15 % discount limit off the list's 420 (so only the floor decides).
  const at21 = (unitCost: string) => {
    const price = (suggestedPriceOf({ unitCost, marginPct: '21', currency: 'EUR' }) as { unitPrice: string }).unitPrice
    expect(Number(price)).toBeGreaterThanOrEqual(357)
    return price
  }

  it("holds the seller's quote to the sales floor and the owner's to the owner's; the approval names the role", async () => {
    const line = lineOf(quotes.seller)
    quotes.seller = (await ok('seller', 'PUT', `${q(quotes.seller.id)}/lines/${line.id}/price`, { version: quotes.seller.version, start: 'MANUAL', startPrice: at21(await unitCostOf(line.id)), startReasonCode: 'TARGET_PRICE' })).quote
    expect(quotes.seller.approval).toMatchObject({ needed: true, marginFloorPct: '25' })
    quotes.owner = await newQuote('owner')
    const ownerLine = lineOf(quotes.owner)
    quotes.owner = (await ok('owner', 'PUT', `${q(quotes.owner.id)}/lines/${ownerLine.id}/price`, { version: quotes.owner.version, start: 'MANUAL', startPrice: at21(await unitCostOf(ownerLine.id)), startReasonCode: 'TARGET_PRICE' })).quote
    expect(quotes.owner.approval).toMatchObject({ needed: false, marginFloorPct: '10' })
    expect((await ok('owner', 'GET', `${q(quotes.owner.id)}/pricing`)).floor).toMatchObject({ source: 'ROLE', roleKey: 'owner', marginFloorPct: '10' })
    // The owner reading the seller's quote sees the seller's floor: the floor is the quote's maker's, the same for every reader.
    expect((await ok('owner', 'GET', q(quotes.seller.id))).quote.approval).toMatchObject({ needed: true, marginFloorPct: '25' })

    const asked = (await ok('seller', 'POST', `${q(quotes.seller.id)}/approval`, { version: quotes.seller.version, note: 'The brand asked for this price.' })).quote
    const request = asked.approval.requests[0]
    expect(request).toMatchObject({ status: 'PENDING', reasons: ['MARGIN_FLOOR'] })
    expect(request.details.rules[0]).toMatchObject({ reason: 'MARGIN_FLOOR', marginFloorPct: '25', marginFloorRole: 'sales' })
    // Nobody approves their own request; another approver does.
    expect((await refused('seller', 'POST', `${q(quotes.seller.id)}/approval/approve`, { version: asked.version }, 403)).message).toBe('You asked for this approval: another approver decides.')
    const approved = await ok('finance', 'POST', `${q(quotes.seller.id)}/approval/approve`, { version: asked.version })
    expect(approved.decision).toMatchObject({ approval: { to: 'APPROVED' } })
    quotes.seller = (await ok('seller', 'POST', `${q(quotes.seller.id)}/reopen`, { version: approved.quote.version })).quote
  })

  it('keeps the floors by role in the sales settings; lowering one asks a step-up, an unknown role is refused', async () => {
    const floors = await ok('seller', 'GET', '/sales/settings/margin-floors')
    expect(floors.tenant).toMatchObject({ floors: { owner: '10.0000', sales: '25.0000' } })
    expect(floors.inForce).toMatchObject({ from: 'TENANT', companyFloorPct: '20' })
    expect(floors.roles.map((role: Json) => role.key)).toEqual(expect.arrayContaining(['owner', 'sales', 'finance']))
    expect(await ok('blind', 'GET', '/sales/settings/margin-floors')).not.toHaveProperty('inForce.floors')
    const version = floors.tenant.version
    // The owner (a role over every company) raises the sales floor: no step-up.
    const raised = await ok('owner', 'PUT', '/sales/settings/margin-floors', { version, floors: { owner: '10', sales: '30' } })
    expect(raised.settings).toMatchObject({ floors: { owner: '10.0000', sales: '30.0000' }, version: version + 1 })
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_settings.changed' AND subject = $1`, [tenant])).at(-1)!.payload).toEqual({ settingsId: tenant, fields: ['marginFloorByRole'] })
    // The seller's draft is held to the new floor at once.
    expect((await ok('seller', 'GET', `${q(quotes.seller.id)}/pricing`)).floor).toMatchObject({ marginFloorPct: '30', roleKey: 'sales' })
    expect((await refused('owner', 'PUT', '/sales/settings/margin-floors', { version: version + 1, floors: { sales: '30', nobody: '5' } }, 400)).message).toBe('Not an office role of this business: nobody.')
    // Lowering a floor (or dropping one under the company's) asks for the step-up first; raising it does not.
    const asked: string[] = []
    await expect(saveMarginFloors(officeCaller('owner'), { version: version + 1, floors: { owner: '10', sales: '22' } }, undefined, () => void asked.push('lower'))).resolves.toBeTruthy()
    await saveMarginFloors(officeCaller('owner'), { version: version + 2, floors: { owner: '10', sales: '26' } }, undefined, () => void asked.push('raise'))
    expect(asked).toEqual(['lower'])
    // The seller cannot change the tenant-wide floors (a role over every company with sales.settings.manage).
    await refused('seller', 'PUT', '/sales/settings/margin-floors', { version: version + 3, floors: null }, 403)
  })
})

describe('development and sample fees (SAL-181)', () => {
  it('a fee on the quote: its own price and times, no cost sheet, no waterfall; the money follows', async () => {
    const before = quotes.seller.current.netAmount
    quotes.seller = (await ok('seller', 'POST', `${q(quotes.seller.id)}/fees`, { version: quotes.seller.version, feeKind: 'DEVELOPMENT', styleId: jkt01, unitPrice: '500' }, 201)).quote
    const fee = quotes.seller.lines.find((line: Json) => line.kind === 'FEE')
    expect(fee).toMatchObject({ quantity: 1, unitPrice: '500', netAmount: 50_000, colourwayId: BLK, costMissing: [] })
    // Its cost is 0 (the cost grain: read as finance).
    expect((await ok('finance', 'GET', q(quotes.seller.id))).quote.lines.find((line: Json) => line.id === fee.id)).toMatchObject({ costAmount: 0, unitCost: '0', marginPct: '100' })
    expect(fee.description).toMatch(/^Development fee - SEED-JKT-01 /)
    expect(quotes.seller.current.netAmount).toBe(before + 50_000)
    expect(quotes.seller.issues.filter((issue: Json) => issue.lineId === fee.id)).toEqual([])
    const pricing = (await ok('seller', 'GET', `${q(quotes.seller.id)}/pricing`)).lines.find((line: Json) => line.kind === 'FEE')
    expect(pricing).toMatchObject({ feeKind: 'DEVELOPMENT', steps: null, suggested: null, fee: { creditAgainstBulk: { enabled: true } } })
    quotes.seller = (await ok('seller', 'PATCH', `${q(quotes.seller.id)}/fees/${fee.id}`, { version: quotes.seller.version, unitPrice: '450', quantity: 2, feeKind: 'SAMPLE' })).quote
    expect(quotes.seller.lines.find((line: Json) => line.id === fee.id)).toMatchObject({ quantity: 2, unitPrice: '450', netAmount: 90_000 })
    expect(quotes.seller.current.netAmount).toBe(before + 90_000)
    // A fee is not priced by a waterfall; a line of goods is not a fee.
    expect((await refused('seller', 'PUT', `${q(quotes.seller.id)}/lines/${fee.id}/price`, { version: quotes.seller.version, start: 'LIST' }, 409)).message).toBe('A fee is priced on its own: change it with PATCH …/fees/:lineId.')
    expect((await refused('seller', 'PATCH', `${q(quotes.seller.id)}/fees/${lineOf(quotes.seller).id}`, { version: quotes.seller.version, unitPrice: '1' }, 409)).message).toMatch(/^Not a fee/)
    expect((await refused('seller', 'POST', `${q(quotes.seller.id)}/fees`, { version: quotes.seller.version, feeKind: 'TOOLING', styleId: jkt01, unitPrice: '0' }, 400)).message).toBe('A fee above 0, at most 6 decimals.')
    // W1's remove-line removes it.
    quotes.seller = (await ok('seller', 'DELETE', `${q(quotes.seller.id)}/lines/${fee.id}?version=${quotes.seller.version}`)).quote
    expect(quotes.seller.current.netAmount).toBe(before)
  })

  it("an order's fee never holds the order back and is invoiced once", async () => {
    const order = seeded.order
    const feeLineId = newId()
    // A fee on SEED-SO-0004 (CONFIRMED), as the accepted quote's FEE line would be copied by make-order.
    await admin(
      `INSERT INTO "SalesOrderLine" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, "feeKind", "styleId", "colourwayId", description, quantity, "unitPrice", "netAmount", "vatRatePct", "vatAmount", "unitCost", "costAmount")
       SELECT $1, "tenantId", "companyId", "orderId", "partyId", 20, 'FEE', 'DEVELOPMENT', "styleId", "colourwayId", 'Development of the configured jacket', 1, 500, 50000, 22, 11000, 0, 0 FROM "SalesOrderLine" WHERE id = $2`,
      [feeLineId, order.lineId],
    )
    const pricing = await ok('seller', 'GET', `/sales/orders/${order.orderId}/pricing`)
    expect(pricing.lines.map((line: Json) => [line.kind, line.steps?.map((step: Json) => step.kind) ?? null])).toEqual([
      ['SIZE_GRID', ['SUGGESTED', 'OPTION', 'MANUAL', 'NET']],
      ['FEE', null],
    ])
    expect(pricing.lines[0].why.sentence).toContain('Manual change (Loyalty) + 10.00 = 470.00')
    expect(pricing.lines[1].fee).toMatchObject({ invoices: [], invoiced: false, creditAgainstBulk: { enabled: true } })
    // The order's progress: nothing of the fee to ship; the totals are the goods'.
    const view = (await ok('seller', 'GET', `/sales/orders/${order.orderId}`)).order
    expect(view.lines.find((line: Json) => line.id === feeLineId).sizes[0].progress).toMatchObject({ ordered: 1, toShip: 0 })
    expect(view.progress).toMatchObject({ ordered: 4, toShip: 4 })
    // The settlement: the fee is not waited for at the shipping, it is waited for at the invoice.
    const settlement = await system().withClient((client) => settlementOf(client, order.orderId))
    expect(settlement!.settlement.lines.filter((line) => line.salesOrderLineId === feeLineId)).toMatchObject([{ toShip: 0, toInvoice: '1' }])
    // The invoice draft takes it once, as a SERVICE line naming the order line, taxed as the goods.
    const { result } = await command(system(), { name: 'test.feeLines', input: {} }, async (tools) => {
      const first = await feeLinesFor(tools.tx, tools.context, [order.orderId], () => taxable(22))
      tools.audit({ recordType: 'SalesOrder', recordId: order.orderId, after: { feeLines: first.lines.length } })
      return { lines: first.lines.map((line) => ({ kind: line.core.kind, quantity: line.core.quantity, unitPrice: line.core.unitPrice, salesOrderLineId: line.salesOrderLineId, ddtId: line.ddtId, size: line.size })), left: first.left }
    })
    expect(result).toEqual({ lines: [{ kind: 'SERVICE', quantity: '1.0000', unitPrice: '500.000000', salesOrderLineId: feeLineId, ddtId: null, size: null }], left: [] })
    expect(await system().withClient((client) => feesBilledOf(client, [feeLineId]))).toEqual([])
  })
})

describe('a revision keeps the waterfall', () => {
  it("SEED-Q-0004's new version takes its line's steps with the price", async () => {
    const sent = (await ok('seller', 'GET', q(seeded.sentQuote.quoteId))).quote
    const revised = (await ok('seller', 'POST', `${q(seeded.sentQuote.quoteId)}/revise`, { version: sent.version, changeNote: 'Made-up: a new delivery date.' })).quote
    expect(revised.current.revision).toBe(2)
    const pricing = await ok('seller', 'GET', `${q(seeded.sentQuote.quoteId)}/pricing`)
    // (the seed writes six places)
    expect(pricing.lines[0].steps.map((step: Json) => [step.kind, step.unitPrice === undefined ? null : Number(step.unitPrice).toString(), step.reasonCode ?? null])).toEqual([
      ['LIST', '430', null],
      ['MANUAL', '420', 'VOLUME'],
      ['NET', '420', null],
    ])
    expect(pricing.lines[0].stepsProblem).toBeNull()
    // The new version is the seller's: their floor.
    expect(pricing.floor).toMatchObject({ roleKey: 'sales' })
  })
})
