import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { NO_COSTING_INPUTS, useCostingInputs } from '../../costing/inputs'
import { useQuoteRules } from './rules'

/**
 * Quotes, part 1 (B-W1-21; SAL-143, SAL-172, SAL-184, SAL-203, SAL-268, GAP-001, FIN-023) on the local stack, with the
 * app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security,
 * the column grants and the …_sales_guards triggers are real), the seeds' brand customer P1 (an Italian business), the
 * jacket SEED-JKT-01 in BLK and RED, sizes 50 / 52 / 54 (2 colours × 3 sizes), its cost sheet with the costing seed's
 * rates and no overhead (per garment 50 = 281.031, 52 = 290.439, 54 = 302.199: B-W1-16's hand-computed sheet) and the
 * compliance seed's certificate. Every price is made up and worked out by hand below. Run with
 * `node scripts/factory/run-pg-tests.mjs quotes`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'quotes-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA = seedId('site:A1')
const P1 = seedId('party:P1')
const P2 = seedId('party:P2')
const P3 = seedId('party:P3')
const P4 = seedId('party:P4')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')
const otherTenant = newId()
const EU_NO_PROOF = newId()
const BLOCKED = newId()
const NO_IDENTITY = newId()
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = businessDate(new Date())

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
interface Person {
  readonly tenantId: string
  readonly actorId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const fromTemplate = (key: string, extra: Permission[] = []): Person => {
  const role = templateOf(key)!
  return { tenantId: tenant, actorId: newId(), permissions: [...role.permissions, ...grainsOf(role.grains), ...extra], companies: 'all' }
}
const QUOTES: Permission[] = ['quotes.view', 'quotes.manage']
const PEOPLE: Record<string, Person> = {
  // The templates as they are: sales sees prices only (design question S2, answer b, until the Owner answers), finance
  // everything, and approves.
  sales: fromTemplate('sales'),
  finance: fromTemplate('finance'),
  // Sales as design answer a (the template with the margin grain too): margin % against the floor, never a cost.
  salesWithMargin: fromTemplate('sales', ['money.margin']),
  // A manager who may edit and approve, with every grain: asks, then may not approve their own request.
  boss: { tenantId: tenant, actorId: newId(), permissions: [...QUOTES, 'quotes.approve', ...grainsOf(['price', 'cost', 'margin'])], companies: 'all' },
  // An approver without the margin grain.
  blindApprover: { tenantId: tenant, actorId: newId(), permissions: ['quotes.view', 'quotes.approve', 'money.price'], companies: 'all' },
  companyB: { tenantId: tenant, actorId: newId(), permissions: [...QUOTES, 'quotes.approve', ...grainsOf(['price', 'cost', 'margin'])], companies: [companyB] },
  otherTenant: { tenantId: otherTenant, actorId: newId(), permissions: [...QUOTES, ...grainsOf(['price', 'cost', 'margin'])], companies: 'all' },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: person.actorId, grants: [grant] }]
  }),
)
// A floor device and a portal session holding even the quote permissions and the price grain: quotes are the office's.
SESSIONS.floor = { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: [...QUOTES, 'floor.work'], companies: [companyA], sites: [siteA], parties: 'all' }] }
SESSIONS.partner = { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P1, grants: [{ permissions: [...QUOTES, 'money.price'], companies: 'all', sites: 'all', parties: [P1] }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
/** Every key of a JSON value, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => event.type)

const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
const BLK_GRID = grid([['50', 2], ['52', 4], ['54', 2]])
const RED_GRID = grid([['50', 1], ['52', 3], ['54', 2]])
const quoteUrl = (id: string) => `/sales/quotes/${id}`
const get = async (session: string, id: string): Promise<Json> => (await ok(session, 'GET', quoteUrl(id))).quote

async function addParty(id: string, code: string, status: string, identity: { country: string; taxMode: string; vatNumber: string } | null) {
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles, status, country) VALUES ($1, $2, $3, 'ORGANISATION', $4, '{CUSTOMER}', $5::"PartyStatus", $6)`, [id, tenant, code, `Cliente Fittizio ${code}`, status, identity?.country ?? 'IT'])
  if (identity) await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "validFrom") VALUES ($1, $2, $3, $4, $5::"PartyTaxMode", $6, '2026-01-01')`, [newId(), tenant, id, identity.country, identity.taxMode, identity.vatNumber])
}

beforeAll(async () => {
  db = await migratedDatabase('quotes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS }) // the product and parties seeds come with it
  await seedCosting({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'quotes-other'])
  for (const company of [companyA, companyB]) {
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'QUOTE', 'MAIN', $4, 'YEARLY', 'Q-{YYYY}-{N:4}', false)`, [newId(), tenant, company, YEAR])
  }
  // A fresh VIES proof for the German customer P3 (the seed's is dated; a proof counts for 30 days).
  await admin(
    `INSERT INTO "ViesCheck" (id, "tenantId", "partyId", "taxIdentityId", "companyId", "countryCode", "vatNumber", "requestedAt", result, "consultationNumber", "requestId") VALUES ($1, $2, $3, $4, $5, 'DE', '000000003', now() - interval '1 minute', 'VALID', 'TESTVIES0000002', 'test-vies')`,
    [newId(), tenant, P3, seedId('party-tax:P3'), companyA],
  )
  await addParty(EU_NO_PROOF, 'T-DE', 'ACTIVE', { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE000000003' })
  await addParty(BLOCKED, 'T-BLK', 'BLOCKED', { country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000001016' })
  await addParty(NO_IDENTITY, 'T-NOID', 'ACTIVE', null)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  useCostingInputs(undefined)
  useQuoteRules(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

let quote: Json
const addLine = async (session: string, body: Json, status = 201) => {
  const answer = await ok(session, 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, ...body }, status)
  quote = answer.quote
  return quote
}
const editLine = async (session: string, lineId: string, body: Json) => {
  quote = (await ok(session, 'PATCH', `${quoteUrl(quote.id)}/lines/${lineId}`, { version: quote.version, ...body })).quote
  return quote
}
const act = async (session: string, path: string, body: Json = {}, status = 200) => {
  const answer = await ok(session, 'POST', `${quoteUrl(quote.id)}${path}`, { version: quote.version, ...body }, status)
  quote = answer.quote
  return answer
}

describe('a quote for the brand customer: 2 colours × 3 sizes (SAL-143, SAL-203, SAL-268; golden flow 05-quote)', () => {
  it("is made with its number, the customer's defaults and the company's rules", async () => {
    quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-0042' }, 201)).quote
    expect(quote).toMatchObject({
      number: `Q-${YEAR}-0001`,
      companyId: companyA,
      partyId: P1,
      party: { code: 'SEED-C1', status: 'ACTIVE' },
      contactId: seedId('party-contact:P1:buyer'),
      contact: { email: 'buyer.p1@example.com' },
      customerRef: 'RFQ-0042',
      status: 'DRAFT',
      currentRevision: 1,
      createdById: PEOPLE.sales!.actorId,
      lines: [],
      canAskApproval: false,
    })
    expect(quote.current).toMatchObject({
      revision: 1,
      status: 'DRAFT',
      currency: 'EUR',
      language: 'it',
      taxMode: 'IT_B2B',
      priceBasis: 'NET',
      taxIdentityId: seedId('party-tax:P1'),
      billToAddressId: seedId('party-address:P1:office'),
      shipToAddressId: seedId('party-address:P1:workshop'),
      validUntil: addDays(TODAY, 30),
      depositPct: '30',
      depositKind: 'ACCONTO',
      netAmount: 0,
      grossAmount: 0,
    })
    // The floor the version is checked against: margin grain (sales today sees no margin).
    expect(quote.current.marginFloorPct).toBeUndefined()
    expect((await get('finance', quote.id)).current.marginFloorPct).toBe('20')
    expect(quote.issues.map((issue: Json) => [issue.code, issue.severity])).toEqual([['NO_LINES', 'BLOCKS']])
    const [allocation] = await admin('SELECT formatted, "recordType" FROM "NumberAllocation" WHERE "recordId" = $1', [quote.id])
    expect(allocation).toEqual({ formatted: quote.number, recordType: 'Quote' })
  })

  it('prices the size grids: net, VAT 22 %, gross, deposit; costs each line from the cost sheet; margin against the floor', async () => {
    await addLine('boss', { styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450.00' })
    await addLine('boss', { styleId: jacket, colourwayId: RED, sizes: RED_GRID, unitPrice: '440' })
    // BLK 8 × 450 = 3600.00; RED 6 × 440 = 2640.00; net 6240.00, VAT 1372.80, gross 7612.80, deposit 30 % 2283.84.
    expect(quote.current).toMatchObject({ netAmount: 624000, vatAmount: 137280, grossAmount: 761280, depositAmount: 228384, vat: [{ rate: '22.00', nature: null, taxable: 624000, vat: 137280, rounding: 0 }] })
    // Cost: BLK 2 × 281.031 + 4 × 290.439 + 2 × 302.199 = 2328.216 → 2328.22; RED 281.031 + 3 × 290.439 + 2 × 302.199 =
    // 1756.746 → 1756.75. Margin 6240.00 − 4084.97 = 2155.03 = 34.5357 % (floor 20 %): no approval needed.
    expect(quote.current).toMatchObject({ costAmount: 408497, costComplete: true, marginAmount: 215503, marginPct: '34.5357', marginFloorPct: '20', marginFloorBreached: false })
    expect(quote.lines.map((line: Json) => [line.seq, line.colourway.code, line.quantity, line.unitPrice, line.netAmount, line.vatRatePct, line.vatAmount, line.unitCost, line.costAmount, line.marginAmount, line.marginPct, line.belowFloor])).toEqual([
      [10, 'BLK', 8, '450', 360000, '22.00', 79200, '291.027', 232822, 127178, '35.3272', false],
      [20, 'RED', 6, '440', 264000, '22.00', 58080, '292.791', 175675, 88325, '33.4564', false],
    ])
    const [blk] = quote.lines
    expect(blk).toMatchObject({ styleId: jacket, styleRevisionId: revision1, styleRevision: { revision: 1, status: 'DRAFT' }, description: 'SEED-JKT-01 Seed leather jacket — Black', costMissing: [] })
    expect(blk.sizes.map((row: Json) => [row.size, row.quantity, row.unitPrice, row.certificate.outcome])).toEqual([
      ['50', 2, null, 'covered'],
      ['52', 4, null, 'covered'],
      ['54', 2, null, 'covered'],
    ])
    // The snapshot is the cost sheet's cells as priced (B-W1-16 cellView, with each size's pieces).
    expect(blk.costSnapshot).toMatchObject({ revisionId: revision1, revisionStatus: 'DRAFT', currency: 'EUR', complete: true, missing: [] })
    expect(blk.costSnapshot.cells.map((cell: Json) => [cell.size, cell.quantity, cell.total])).toEqual([
      ['50', 2, '281.031'],
      ['52', 4, '290.439'],
      ['54', 2, '302.199'],
    ])
    expect(quote.approval).toMatchObject({ needed: false, marginFloorPct: '20', discountLimitPct: '15', requests: [] })
    // A draft revision: an estimate, said; nothing stops the send.
    expect(quote.issues.map((issue: Json) => [issue.code, issue.severity])).toEqual([
      ['COST_ESTIMATE', 'INFO'],
      ['COST_ESTIMATE', 'INFO'],
    ])
    expect(quote.sendBlockers).toEqual([])
    const [row] = await admin('SELECT "netAmount", "costAmount", "marginFloorBreached", "marginFloorPct"::text AS floor FROM "QuoteVersion" WHERE "quoteId" = $1', [quote.id])
    expect(row).toEqual({ netAmount: 624000, costAmount: 408497, marginFloorBreached: false, floor: '20.0000' })
  })

  it('sales sees prices, never a cost; with the margin grain the margin % against the floor, never the margin amount (S2)', async () => {
    // Answer b (the sales template today): no margin at all; the rules still say why, in words.
    const seen = await get('sales', quote.id)
    const keys = new Set(keysOf(seen))
    for (const key of ['unitCost', 'costAmount', 'costSnapshot', 'marginAmount', 'knownTotal', 'marginPct', 'marginFloorPct', 'marginFloorBreached', 'belowFloor', 'details']) expect(keys.has(key), key).toBe(false)
    expect(seen.current).toMatchObject({ netAmount: 624000, grossAmount: 761280, costComplete: true })
    expect(seen.lines[0]).toMatchObject({ unitPrice: '450', netAmount: 360000, costComplete: true })
    expect(seen.approval.rules.map((rule: Json) => [rule.reason, rule.broken, rule.message])).toEqual([
      ['MARGIN_FLOOR', false, 'The margin is at or above the floor.'],
      ['DISCOUNT_LIMIT', false, 'No discount is over the 15 % limit.'],
    ])
    // Answer a (the margin grain without the cost grain): percentages against the floor, never an amount that gives the
    // cost away (net − margin).
    const margins = await get('salesWithMargin', quote.id)
    const marginKeys = new Set(keysOf(margins))
    for (const key of ['unitCost', 'costAmount', 'costSnapshot', 'marginAmount', 'knownTotal']) expect(marginKeys.has(key), key).toBe(false)
    expect(margins.current).toMatchObject({ netAmount: 624000, marginPct: '34.5357', marginFloorPct: '20', marginFloorBreached: false })
    expect(margins.lines[0]).toMatchObject({ marginPct: '35.3272', belowFloor: false })
    // The list: the same walls.
    const listed = (await ok('sales', 'GET', '/sales/quotes')).quotes
    expect(listed).toEqual([expect.objectContaining({ id: quote.id, number: quote.number, partyName: 'Seed Customer One S.r.l.', lineCount: 2, units: 14, netAmount: 624000, approval: null })])
    expect(Object.keys(listed[0])).not.toContain('marginPct')
    expect((await ok('salesWithMargin', 'GET', '/sales/quotes')).quotes[0]).toMatchObject({ marginPct: '34.5357', marginFloorBreached: false })
  })

  it('asking for an approval when no rule breaks is refused: the quote can be sent as it is', async () => {
    const error = await refused('boss', 'POST', `${quoteUrl(quote.id)}/approval`, { version: quote.version }, 409)
    expect(error.message).toBe('No rule needs an approval: the quote can be sent as it is.')
  })

  it('under the floor → the rule breaks, the approval request freezes the lines (PENDING_APPROVAL)', async () => {
    await editLine('boss', quote.lines[0].id, { unitPrice: '340' })
    await editLine('boss', quote.lines[1].id, { unitPrice: '340' })
    // Net 14 × 340 = 4760.00; margin 4760.00 − 4084.97 = 675.03 = 14.1813 % < 20 %.
    expect(quote.current).toMatchObject({ netAmount: 476000, marginAmount: 67503, marginPct: '14.1813', marginFloorBreached: true })
    expect(quote.lines.map((line: Json) => [line.marginPct, line.belowFloor])).toEqual([
      ['14.4037', true],
      ['13.8848', true],
    ])
    expect(quote.approval.rules[0]).toEqual({ reason: 'MARGIN_FLOOR', known: true, broken: true, lines: [10, 20], message: "The quote's margin is under the floor: an approver decides." })
    expect(quote).toMatchObject({ canAskApproval: true, approval: { needed: true } })
    expect(quote.sendBlockers.map((issue: Json) => issue.message)).toEqual(['A rule is broken: ask for an approval first.'])

    await act('boss', '/approval', { note: 'Launch order for a new brand.' })
    expect(quote).toMatchObject({ status: 'PENDING_APPROVAL', current: { status: 'PENDING_APPROVAL' }, canAskApproval: false })
    const [request] = quote.approval.requests
    expect(request).toMatchObject({ status: 'PENDING', reasons: ['MARGIN_FLOOR'], requestNote: 'Launch order for a new brand.', createdById: PEOPLE.boss!.actorId, decidedById: null })
    expect(request.details.rules).toEqual([{ reason: 'MARGIN_FLOOR', marginPct: '14.1813', marginFloorPct: '20', lines: [{ seq: 10, marginPct: '14.4037' }, { seq: 20, marginPct: '13.8848' }] }])
    expect(request.details.asked).toMatchObject({ netAmount: 476000, grossAmount: 580720, marginPct: '14.1813', lines: [{ seq: 10, quantity: 8, unitPrice: '340' }, { seq: 20, quantity: 6, unitPrice: '340' }] })
    expect(request.details.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(request.details)).not.toMatch(/costAmount|unitCost|marginAmount/)
    // The lines are frozen: the API says to reopen first, and the database refuses the change for every login.
    const error = await refused('boss', 'PATCH', `${quoteUrl(quote.id)}/lines/${quote.lines[0].id}`, { version: quote.version, unitPrice: '500' }, 409)
    expect(error.message).toContain('Reopen it first')
    await expect(admin('UPDATE "QuoteLine" SET "unitPrice" = 500 WHERE id = $1', [quote.lines[0].id])).rejects.toThrow(/its lines change only while it is DRAFT/)
    // Waiting for approval: the list's tile.
    expect((await ok('sales', 'GET', '/sales/quotes?status=PENDING_APPROVAL')).quotes.map((row: Json) => [row.id, row.approval])).toEqual([[quote.id, 'PENDING']])
  })

  it('the person who asked never approves; an approver without the margin grain cannot decide a margin request; sales has no approve right', async () => {
    const own = await refused('boss', 'POST', `${quoteUrl(quote.id)}/approval/approve`, { version: quote.version }, 403)
    expect(own.message).toBe('You asked for this approval: another approver decides.')
    const blind = await refused('blindApprover', 'POST', `${quoteUrl(quote.id)}/approval/approve`, { version: quote.version }, 403)
    expect(blind.message).toBe('This request is about the margin floor: deciding it needs a role that sees margins.')
    await refused('sales', 'POST', `${quoteUrl(quote.id)}/approval/approve`, { version: quote.version }, 403)
    expect((await get('finance', quote.id)).status).toBe('PENDING_APPROVAL')
  })

  it('another person approves it: the exact change is answered and recorded (→ APPROVED)', async () => {
    const answer = await act('finance', '/approval/approve', { note: 'Strategic customer.' })
    expect(answer.decision).toEqual({ approvalId: quote.approval.requests[0].id, approval: { from: 'PENDING', to: 'APPROVED' }, status: { from: 'PENDING_APPROVAL', to: 'APPROVED' } })
    expect(quote).toMatchObject({ status: 'APPROVED', current: { status: 'APPROVED' }, sendBlockers: [] })
    expect(quote.approval.requests[0]).toMatchObject({ status: 'APPROVED', decidedById: PEOPLE.finance!.actorId, decisionNote: 'Strategic customer.' })
    const audit = await admin<{ action: string; actorId: string }>(`SELECT action, "actorId"::text AS "actorId" FROM "AuditLog" WHERE "recordId" = $1 AND action IN ('quotes.askApproval', 'quotes.approve') ORDER BY at`, [quote.id])
    expect(audit).toEqual([
      { action: 'quotes.askApproval', actorId: PEOPLE.boss!.actorId },
      { action: 'quotes.approve', actorId: PEOPLE.finance!.actorId },
    ])
    expect(await eventsOf(quote.id)).toEqual(expect.arrayContaining(['quote.created', 'quote.lines_changed', 'quote.approval_requested', 'quote.approval_decided']))
  })

  it('reopened for a change; asked again and rejected with a reason (→ DRAFT)', async () => {
    await act('boss', '/reopen', { reason: 'The customer asked for two more jackets.' })
    expect(quote).toMatchObject({ status: 'DRAFT', current: { status: 'DRAFT' } })
    await act('boss', '/approval')
    expect((await refused('finance', 'POST', `${quoteUrl(quote.id)}/approval/reject`, { version: quote.version }, 400)).code).toBe('validation_failed')
    const answer = await act('finance', '/approval/reject', { reason: 'Too far under the floor.' })
    expect(answer.decision.status).toEqual({ from: 'PENDING_APPROVAL', to: 'DRAFT' })
    expect(quote.approval.requests.map((request: Json) => [request.status, request.decisionNote])).toEqual([
      ['REJECTED', 'Too far under the floor.'],
      ['APPROVED', 'Strategic customer.'],
    ])
  })

  it('a discount off the list price over the limit asks for an approval too', async () => {
    // BLK: list 500, discount 20 % → 400 a piece (its margin 3200.00 − 2328.22 = 27.24 %); RED back to 440.
    await editLine('boss', quote.lines[0].id, { listUnitPrice: '500', discountPct: '20' })
    await editLine('boss', quote.lines[1].id, { unitPrice: '440' })
    expect(quote.lines.map((line: Json) => [line.listUnitPrice, line.unitPrice, line.discountPct])).toEqual([
      ['500', '400', '20'],
      [null, '440', null],
    ])
    expect(quote.approval.rules.map((rule: Json) => [rule.reason, rule.broken])).toEqual([
      ['MARGIN_FLOOR', false],
      ['DISCOUNT_LIMIT', true],
    ])
    expect(quote.approval.rules[1].message).toBe('Line 10 has a discount off the list price over the 15 % limit: an approver decides.')
    // The limit comes from the company's rules (the seam): a 25 % limit lets it through.
    useQuoteRules({ rulesFor: async () => ({ marginFloorPct: '20', discountLimitPct: '25', defaultValidityDays: 30, defaultDepositPct: '30', source: 'COMPANY' }) })
    try {
      expect((await get('boss', quote.id)).approval.needed).toBe(false)
    } finally {
      useQuoteRules(undefined)
    }
  })

  it('an incomplete cost stops the approval request, listed in words; never counted as 0', async () => {
    useCostingInputs(NO_COSTING_INPUTS)
    try {
      await act('boss', '/recompute')
    } finally {
      useCostingInputs(undefined)
    }
    expect(quote.current).toMatchObject({ costAmount: null, costComplete: false, marginAmount: null, marginPct: null, marginFloorBreached: false })
    expect(quote.lines[0]).toMatchObject({ unitCost: null, costAmount: null, costComplete: false, marginPct: null })
    expect(quote.lines[0].costMissing.map((entry: Json) => entry.code)).toEqual(['LABOUR_RATE', 'LABOUR_RATE', 'LABOUR_RATE', 'LABOUR_RATE'])
    expect(quote.approval.rules[0]).toMatchObject({ reason: 'MARGIN_FLOOR', known: false, message: 'The margin is not known until every line has its cost.' })
    const blocked = quote.issues.filter((issue: Json) => issue.severity === 'BLOCKS')
    expect(blocked.map((issue: Json) => issue.code)).toEqual(['COST_INCOMPLETE', 'COST_INCOMPLETE'])
    expect(blocked[0].message).toMatch(/^Line 10 \(SEED-JKT-01 Black\): the cost is incomplete — /)
    const error = await refused('boss', 'POST', `${quoteUrl(quote.id)}/approval`, { version: quote.version }, 409)
    expect(error.message).toContain('the cost is incomplete')
    expect(error.issues.map((issue: Json) => issue.path)).toEqual(['lines/0/cost', 'lines/1/cost'])
    // Costed again with the rates back: complete.
    await act('boss', '/recompute')
    expect(quote.current).toMatchObject({ costAmount: 408497, costComplete: true })
  })

  it('a size whose certificate does not reach the promise date is a warning per size; the grid follows its edits', async () => {
    // The seed certificate is valid until 2031-01-14: a later promise date is not covered.
    quote = (await ok('boss', 'PATCH', quoteUrl(quote.id), { version: quote.version, promiseDate: '2031-06-01' })).quote
    const warnings = quote.issues.filter((issue: Json) => issue.code === 'CERTIFICATE')
    expect(warnings.map((issue: Json) => [issue.severity, issue.size])).toEqual([
      ['WARNING', '50'],
      ['WARNING', '52'],
      ['WARNING', '54'],
      ['WARNING', '50'],
      ['WARNING', '52'],
      ['WARNING', '54'],
    ])
    expect(quote.lines[0].sizes[2].certificate.outcome).toBe('refused')
    quote = (await ok('boss', 'PATCH', quoteUrl(quote.id), { version: quote.version, promiseDate: null })).quote
    // A grid edit: 54 dropped (0), a 56 is not in the range, a size price.
    const error = await refused('boss', 'PATCH', `${quoteUrl(quote.id)}/lines/${quote.lines[1].id}`, { version: quote.version, sizes: grid([['56', 1]]) }, 400)
    expect(error.issues).toEqual([{ path: 'body/sizes/0/size', message: "Not a size of this style's range (50, 52, 54)." }])
    await editLine('boss', quote.lines[1].id, { sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 3, unitPrice: '450' }, { size: '54', quantity: 0 }] })
    // RED: 1 × 440 + 3 × 450 = 1790.00; cost 281.031 + 3 × 290.439 = 1152.348 → 1152.35.
    expect(quote.lines[1]).toMatchObject({ quantity: 4, netAmount: 179000, costAmount: 115235 })
    expect(quote.lines[1].sizes.map((row: Json) => [row.size, row.quantity, row.unitPrice])).toEqual([
      ['50', 1, null],
      ['52', 3, '450'],
    ])
  })

  it('a stale version is a 409 that names the current one (COL-078)', async () => {
    const error = await refused('boss', 'PATCH', quoteUrl(quote.id), { version: quote.version - 1, customerRef: 'RFQ-0043' }, 409)
    expect(error.message).toContain(`it is now at version ${quote.version}`)
  })

  it('removing a line and cancelling the quote', async () => {
    quote = (await ok('boss', 'DELETE', `${quoteUrl(quote.id)}/lines/${quote.lines[1].id}?version=${quote.version}`)).quote
    expect(quote.lines.map((line: Json) => line.seq)).toEqual([10])
    expect(quote.current).toMatchObject({ netAmount: 320000, costAmount: 232822 })
    await act('boss', '/cancel', { reason: 'Customer chose another supplier.' })
    expect(quote).toMatchObject({ status: 'CANCELLED', current: { status: 'CANCELLED' } })
    const error = await refused('boss', 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' }, 409)
    expect(error.message).toContain('cancelled')
  })
})

describe('VAT by the customer (GAP-001; DL 331/1993 art. 41)', () => {
  it('an EU business with a VIES proof is zero-rated (N3.2)', async () => {
    quote = (await ok('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: P3 }, 201)).quote
    await addLine('boss', { styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' })
    expect(quote.current).toMatchObject({ taxMode: 'EU_B2B', netAmount: 360000, vatAmount: 0, grossAmount: 360000, vat: [{ rate: null, nature: 'N3.2', taxable: 360000, vat: 0 }] })
    expect(quote.lines[0]).toMatchObject({ vatRatePct: '0.00', vatNature: 'N3.2', vatAmount: 0 })
    expect(quote.issues.map((issue: Json) => issue.code)).not.toContain('VIES_NOT_PROVEN')
  })

  it('an EU business without a proof is charged Italian VAT at 22 %, and the quote says so', async () => {
    quote = (await ok('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: EU_NO_PROOF }, 201)).quote
    await addLine('boss', { styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' })
    expect(quote.current).toMatchObject({ taxMode: 'IT_B2B', netAmount: 360000, vatAmount: 79200, grossAmount: 439200 })
    const [vies] = quote.issues.filter((issue: Json) => issue.code === 'VIES_NOT_PROVEN')
    expect(vies).toMatchObject({ severity: 'WARNING', message: expect.stringMatching(/^VAT is charged at 22 % until VIES confirms the VAT number\./) })
  })
})

describe('a consumer (Codice del Consumo art. 49)', () => {
  it('is quoted VAT included (GROSS); the send needs the promise date', async () => {
    quote = (await ok('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: P4 }, 201)).quote
    await addLine('boss', { styleId: jacket, colourwayId: BLK, sizes: grid([['52', 1]]), unitPrice: '549' })
    // 549.00 VAT included = 450.00 + 99.00; deposit 30 % = 164.70. Cost 290.439 → 290.44; margin 159.56 = 35.4578 %.
    expect(quote.current).toMatchObject({ taxMode: 'IT_B2C', priceBasis: 'GROSS', netAmount: 45000, vatAmount: 9900, grossAmount: 54900, depositAmount: 16470, costAmount: 29044, marginAmount: 15956, marginPct: '35.4578' })
    expect(quote.lines[0]).toMatchObject({ unitPrice: '549', netAmount: 45000, vatAmount: 9900 })
    expect(quote.sendBlockers.map((issue: Json) => issue.code)).toContain('NO_PROMISE_DATE')
  })
})

describe('refusals', () => {
  it('a blocked customer, a supplier, a customer without a tax identity', async () => {
    expect((await refused('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: BLOCKED }, 409)).message).toBe('Cliente Fittizio T-BLK is blocked: no quote goes to it until it is active again.')
    expect((await refused('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: P2 }, 400)).issues).toEqual([{ path: 'body/partyId', message: 'Give the party the customer (or brand) role first.' }])
    expect((await refused('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: NO_IDENTITY }, 409)).message).toContain('has no tax identity in force')
    expect(await admin('SELECT id FROM "Quote" WHERE "partyId" = ANY($1::uuid[])', [[BLOCKED, P2, NO_IDENTITY]])).toEqual([])
  })

  it('a customer blocked after the quote was made gets no new line', async () => {
    quote = (await ok('boss', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    await admin(`UPDATE "Party" SET status = 'BLOCKED' WHERE id = $1`, [P1])
    try {
      const error = await refused('boss', 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' }, 409)
      expect(error.message).toContain('is blocked')
      expect((await get('boss', quote.id)).issues.map((issue: Json) => issue.code)).toContain('PARTY_NOT_QUOTABLE')
    } finally {
      await admin(`UPDATE "Party" SET status = 'ACTIVE' WHERE id = $1`, [P1])
    }
  })

  it('a made-to-measure line: 409, it comes later (Owner Q9)', async () => {
    const error = await refused('boss', 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, kind: 'MADE_TO_MEASURE', measurementProfileId: seedId('measurement:P1:rider:JACKET:1'), styleId: jacket, colourwayId: BLK, sizes: grid([['52', 1]]) }, 409)
    expect(error.message).toBe('Made-to-measure comes later: quote a size-grid line for now (one style in one colourway with pieces per size).')
    expect(await admin('SELECT id FROM "QuoteLine" WHERE "versionId" = $1', [quote.current.id])).toEqual([])
  })

  it('a size not offered in the colourway, a discount with a unit price', async () => {
    await admin(`UPDATE "Variant" SET status = 'ARCHIVED' WHERE id = $1`, [seedId('product:variant:JKT-01:RED:54')])
    try {
      const error = await refused('boss', 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: RED, sizes: RED_GRID, unitPrice: '450', listUnitPrice: '500', discountPct: '5' }, 400)
      expect(error.issues).toEqual([
        { path: 'body/sizes/2/size', message: 'Size 54 is not offered in this colourway (no active SKU).' },
        { path: 'body/discountPct', message: 'Send a unit price or a discount off the list price, not both.' },
      ])
    } finally {
      await admin(`UPDATE "Variant" SET status = 'ACTIVE' WHERE id = $1`, [seedId('product:variant:JKT-01:RED:54')])
    }
  })
})

describe('walls (A1 §2.2, §2.6)', () => {
  it('floor and portal sessions are refused; another tenant and another company see nothing', async () => {
    await refused('floor', 'GET', '/sales/quotes', undefined, 403)
    await refused('partner', 'GET', quoteUrl(quote.id), undefined, 403)
    await refused('partner', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 403)
    await refused('otherTenant', 'GET', quoteUrl(quote.id), undefined, 404)
    expect((await ok('otherTenant', 'GET', '/sales/quotes')).quotes).toEqual([])
    await refused('companyB', 'GET', quoteUrl(quote.id), undefined, 404)
    expect((await ok('companyB', 'GET', '/sales/quotes')).quotes).toEqual([])
    await refused('companyB', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 404)
    await refused('companyB', 'PATCH', quoteUrl(quote.id), { version: quote.version, customerRef: 'X' }, 404)
    // Company B quotes from its own series.
    const own = (await ok('companyB', 'POST', '/sales/quotes', { companyId: companyB, partyId: P1 }, 201)).quote
    expect(own).toMatchObject({ companyId: companyB, number: `Q-${YEAR}-0001` })
  })

  it('a body that sends a price without the price grain is refused', async () => {
    SESSIONS.noPrice = { audience: 'office', tenantId: tenant, actorId: newId(), grants: [{ permissions: QUOTES, companies: 'all', sites: 'all', parties: 'all' }] }
    const error = await refused('noPrice', 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' }, 403)
    expect(JSON.stringify(error)).toContain('unitPrice')
  })
})

describe('replays (PLT-189)', () => {
  it('a repeated Idempotency-Key answers from its receipt: one quote, one number', async () => {
    const send = () => app.inject({ method: 'POST', url: '/sales/quotes', headers: { 'x-test-session': 'sales', 'idempotency-key': 'quote-create-0001' }, payload: { companyId: companyA, partyId: P1, customerRef: 'RFQ-REPLAY' } })
    const first = await send()
    const again = await send()
    expect(first.statusCode, first.body).toBe(201)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().quote).toEqual(first.json().quote)
    expect(await admin('SELECT count(*)::int AS n FROM "Quote" WHERE "customerRef" = $1', ['RFQ-REPLAY'])).toEqual([{ n: 1 }])
  })
})
