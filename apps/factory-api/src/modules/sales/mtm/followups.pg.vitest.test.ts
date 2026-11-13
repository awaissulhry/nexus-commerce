import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { WAIT_WORDS } from '@nexus/factory-domain/sales/orders-depth/rules'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * The made-to-measure follow-ups (B-W2b-368; XF1:01 – XF1:05) on the local stack, through the app's real routes: a throwaway
 * PostgreSQL 17 database with every factory-db seed (the JACKET template, SEED-JKT-01 flagged made to measure, the private rider
 * SEED-R1, company A's plant, numbering and mail identity), FAKE files and mail (the harness), and office people holding their role
 * templates (sales, the production manager, the administrator, the owner, read-only). Made-to-measure is started for JACKET here
 * (GATE-MTM, B-W2b-248's switch) and stopped again where a test says so. Test data past its guards: SEED-JKT-01's brand cleared (the
 * private rider may order it), the quote version accepted, a returned unit's RMA copied from SEED-RMA-0002, and a confirmed review
 * put back to waiting for one release check. Every name, number and address is made up; every time is relative to now. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/mtm/followups`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'mtm-368'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const companyA = sid('company:A')

const PEOPLE = { sales: newId(), pm: newId(), admin: newId(), owner: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', pm: 'production_manager', admin: 'admin', owner: 'owner', reader: 'read_only' }
const SESSIONS: Record<string, SessionContext> = {}
const grantsOf = (role: string): Grant[] => {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (person: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `w2b368-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(person: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(person: Person, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(person, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const messages = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.message))
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const S = { r1: '', jacket: '', jkt01: '', blk: '' }
const RIDER = 'Made-up rider 368'
const values = { chest: '100', waist: '84', sleeve: '64', height: '178' }

const templateUrl = () => `/product/measurement-templates/${S.jacket}`
async function switchMtm(on: boolean): Promise<void> {
  const rules = (await ok('owner', 'GET', `${templateUrl()}/mtm-rules`)).rules
  await ok('owner', 'PUT', `${templateUrl()}/mtm-rules/switch`, { version: rules.template.version, on, reason: on ? 'Made-up first made-to-measure order.' : 'Made-up pause.' })
}
const quoteVersion = async (id: string) => (await one<{ version: number }>(`SELECT version FROM "Quote" WHERE id = $1`, [id])).version
const orderVersion = async (id: string) => (await one<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [id])).version

beforeAll(async () => {
  h = await startHarness('mtm_w2b368')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b368-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(role) }
  }
  S.r1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R1'`, [T])).id
  S.jacket = (await one<{ id: string }>(`SELECT id FROM "MeasurementTemplate" WHERE "tenantId" = $1 AND code = 'JACKET'`, [T])).id
  S.jkt01 = (await one<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [T])).id
  S.blk = (await one<{ id: string }>(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [S.jkt01])).id
  await force(`UPDATE "Style" SET "brandPartyId" = NULL WHERE id = $1`, [S.jkt01])
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The template measures the height too (the certificate gate reads it), then made-to-measure starts for JACKET.
  const template = (await ok('owner', 'GET', templateUrl())).template
  await ok('owner', 'PUT', `${templateUrl()}/points`, {
    version: template.version,
    points: [
      { code: 'chest', name: 'Chest', minValue: '70', maxValue: '150' },
      { code: 'waist', name: 'Waist', minValue: '60', maxValue: '140' },
      { code: 'sleeve', name: 'Sleeve', minValue: '50', maxValue: '80' },
      { code: 'height', name: 'Height', minValue: '140', maxValue: '210', required: false },
    ],
  })
  await switchMtm(true)
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let rev1 = ''
let quoteId = ''
let orderId = ''
let unitLine = ''
let gridLine = ''
let unitWorkOrder = ''
let baseSize = ''

describe('the order waits for the factory review, in words (XF1:02)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a unit whose measures wait makes a waiting order: its reason is MEASUREMENTS (no yes is asked of anyone)', async () => {
    rev1 = (await ok('sales', 'POST', '/sales/mtm/profiles', { partyId: S.r1, riderName: RIDER, garmentType: 'JACKET', measurements: values, takenAt: ago(1), measuredByUserId: PEOPLE.sales, measuredPlace: 'Made-up showroom', privacyNoticeRef: 'Made-up notice v1', privacyNoticeAt: ago(2) }, 201)).profile.id
    const quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: S.r1 }, 201)).quote
    quoteId = quote.id
    await ok('sales', 'POST', `/sales/quotes/${quoteId}/lines/made-to-measure`, { version: quote.version, styleId: S.jkt01, colourwayId: S.blk, measurementProfileId: rev1, unitPrice: '610' }, 201)
    await ok('sales', 'POST', `/sales/quotes/${quoteId}/lines`, { version: await quoteVersion(quoteId), styleId: S.jkt01, colourwayId: S.blk, sizes: [{ size: '52', quantity: 2 }] }, 201)
    const version = await one<{ id: string }>(`SELECT id FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1`, [quoteId])
    const accepted = await one<{ billTo: Json; shipTo: Json }>(`SELECT v."billTo", v."shipTo" FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0001'`, [T])
    await force(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "billTo" = $2, "shipTo" = $3 WHERE id = $1`, [version.id, accepted.billTo, accepted.shipTo])
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [quoteId])
    orderId = (await ok('sales', 'POST', '/sales/orders', { quoteVersionId: version.id, customerRef: 'PO-368-1' }, 201)).order.id
    const lines = await admin<{ id: string; kind: string; baseSize: string | null }>(`SELECT id, kind::text, "baseSize" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [orderId])
    unitLine = lines.find((line) => line.kind === 'MADE_TO_MEASURE')!.id
    gridLine = lines.find((line) => line.kind === 'SIZE_GRID')!.id
    baseSize = lines.find((line) => line.kind === 'MADE_TO_MEASURE')!.baseSize!
    expect(baseSize).toBeTruthy()
    const approval = await ok('sales', 'GET', `/sales/orders/${orderId}/approval`)
    expect(approval).toMatchObject({ status: 'PENDING_APPROVAL', waiting: true, reasons: [{ reason: 'MEASUREMENTS', words: WAIT_WORDS.MEASUREMENTS }] })
    expect((await ok('sales', 'GET', `/sales/orders/${orderId}/made-to-measure`)).made).toMatchObject({ waitsForReview: true, units: [{ lineId: unitLine, profile: { id: rev1, review: 'WAITING' } }] })
  })
})

describe('the worksheet PDF is made once per revision (XF1:05)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('two people keeping the same new version at once get ONE version and ONE stored PDF', async () => {
    const [first, second] = await Promise.all([ok('sales', 'POST', `/sales/mtm/profiles/${rev1}/worksheets`, { companyId: companyA, language: 'en' }), ok('admin', 'POST', `/sales/mtm/profiles/${rev1}/worksheets`, { companyId: companyA, language: 'en' })])
    expect(second.worksheet.id).toBe(first.worksheet.id)
    expect(first.worksheet.version).toBe(1)
    expect((await one(`SELECT count(*)::int AS n FROM "GeneratedDocument" WHERE "recordType" = 'MeasurementProfile' AND "recordId" = $1`, [rev1])).n).toBe(1)
    expect((await one(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordType" = 'MeasurementProfile' AND "recordId" = $1 AND kind = 'DOCUMENT'`, [rev1])).n).toBe(1)
  })
})

describe('a W1 work order takes a made-to-measure unit (XF1:01)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the review’s CONFIRM lets the order go on; nothing waits any more', async () => {
    await ok('pm', 'POST', `/sales/mtm/profiles/${rev1}/review`, { decision: 'CONFIRM' })
    expect(await ok('sales', 'GET', `/sales/orders/${orderId}/approval`)).toMatchObject({ status: 'CONFIRMED', waiting: false, reasons: [] })
  })

  it('shows the unit as one piece of its base size; makes it on its own MADE_TO_MEASURE work order, once, with its revision', async () => {
    const open = await ok('owner', 'GET', `/production/work-orders/open-lines?salesOrderId=${orderId}`)
    expect(open.lines.find((line: Json) => line.id === unitLine)).toMatchObject({ kind: 'MADE_TO_MEASURE', madeToMeasure: true, sizes: [{ size: baseSize, ordered: 1, onWorkOrders: 0, open: 1 }] })
    const mixed = await no('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: unitLine }, { salesOrderLineId: gridLine }] }, 400)
    expect(mixed.message).toMatch(/line 10 is a made-to-measure unit: it is made on its own work order \(one garment for one rider\)\. Name it alone\.$/)
    const made = (await ok('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: unitLine }] }, 201)).workOrder
    unitWorkOrder = made.id
    expect(made).toMatchObject({ kind: 'MADE_TO_MEASURE', status: 'DRAFT', cells: [{ size: baseSize, quantity: 1 }] })
    expect(await one(`SELECT "measurementProfileId", quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [unitWorkOrder])).toEqual({ measurementProfileId: rev1, quantity: 1 })
    expect((await no('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: unitLine }] }, 400)).message).toBe('Nothing is open to make on these order lines.')
    expect((await no('owner', 'PUT', `/production/work-orders/${unitWorkOrder}/cells`, { version: made.version, cells: [{ salesOrderLineId: unitLine, size: baseSize, quantity: 0 }] }, 409)).message).toContain('makes one made-to-measure unit: its cell does not change')
    // The size grid of the same order is a work order as before (W1).
    expect((await ok('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: gridLine }] }, 201)).workOrder).toMatchObject({ kind: 'SIZE_GRID', cells: [{ size: '52', quantity: 2 }] })
  })

  it('the release check reads the confirmed revision; it holds a unit whose measures wait, and while made-to-measure is off', async () => {
    const cells = async () => (await ok('owner', 'GET', `/production/work-orders/${unitWorkOrder}/release-check`)).checks.find((check: Json) => check.code === 'CELLS')
    const cellId = (await one<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [unitWorkOrder])).id
    expect(await cells()).toMatchObject({ state: 'OK', message: expect.stringContaining(`for ${RIDER}, JACKET revision 1), the measures confirmed by the factory review.`) })
    // Test data past its guards: the confirmed review put back to waiting for this one check.
    await force(`UPDATE "MeasurementProfile" SET "reviewStatus" = 'WAITING' WHERE id = $1`, [rev1])
    expect(await cells()).toMatchObject({ state: 'BLOCKED', problems: [{ path: `cells/${cellId}/measures`, message: expect.stringContaining('wait for the factory review') }] })
    await force(`UPDATE "MeasurementProfile" SET "reviewStatus" = 'CONFIRMED' WHERE id = $1`, [rev1])
    await switchMtm(false)
    expect(await cells()).toMatchObject({ state: 'BLOCKED', problems: [{ path: `cells/${cellId}/mtm`, message: expect.stringContaining('Made-to-measure has not started for measurement template JACKET') }] })
    const draft = (await ok('owner', 'GET', `/production/work-orders/${unitWorkOrder}`)).workOrder
    await ok('owner', 'POST', `/production/work-orders/${unitWorkOrder}/cancel`, { version: draft.version, reason: 'Made-up: made again later.' })
    expect((await no('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: unitLine }] }, 409)).message).toContain('Made-to-measure has not started for measurement template JACKET')
    await switchMtm(true)
    unitWorkOrder = (await ok('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: unitLine }] }, 201)).workOrder.id
  })
})

describe('an amendment takes the made-to-measure unit (XF1:01)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('amends an order with a unit: the size grid changes, the unit stays as it was sold; leaving it out is refused in words', async () => {
    const before = await one<{ quantity: number; netAmount: number }>(`SELECT quantity, "netAmount" FROM "SalesOrderLine" WHERE id = $1`, [unitLine])
    const body = { reason: 'Made-up: one more jacket in 52.', lines: [{ id: unitLine }, { id: gridLine, sizes: [{ size: '52', quantity: 3 }] }] }
    const preview = await ok('sales', 'POST', `/sales/orders/${orderId}/amendments/preview`, body)
    expect(preview).toMatchObject({ ok: true, problems: [] })
    expect(preview.diff.lines.map((line: Json) => [line.lineId, line.change, line.piecesBefore, line.piecesAfter])).toEqual([[gridLine, 'CHANGED', 2, 3]])
    const left = await ok('sales', 'POST', `/sales/orders/${orderId}/amendments/preview`, { ...body, lines: [body.lines[1]] })
    expect(left.ok).toBe(false)
    expect(left.problems.map((problem: Json) => problem.message)).toContain('Line 10 is a made-to-measure unit: it does not change through an amendment.')
    await ok('sales', 'POST', `/sales/orders/${orderId}/amendments`, { ...body, version: await orderVersion(orderId) }, 201)
    expect(await one(`SELECT quantity, "netAmount" FROM "SalesOrderLine" WHERE id = $1`, [unitLine])).toEqual(before)
    expect((await one(`SELECT count(*)::int AS n FROM "SalesOrderLineSize" WHERE "lineId" = $1`, [unitLine])).n).toBe(0)
    expect((await one(`SELECT quantity FROM "SalesOrderLine" WHERE id = $1`, [gridLine])).quantity).toBe(3)
  })
})

const rma = sid('rma:368')
const rmaLine = sid('rma-line:368')

describe('a remake is a return outcome (XF1:03)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the decision preview offers REMAKE for the unit’s line (scrapped or quarantined), never for another line', async () => {
    await force(
      `INSERT INTO "ReturnAuthorisation" SELECT (jsonb_populate_record(NULL::"ReturnAuthorisation", to_jsonb(r) || $2::jsonb)).* FROM "ReturnAuthorisation" r WHERE r."tenantId" = $1 AND r.number = 'SEED-RMA-0002'`,
      [T, JSON.stringify({ id: rma, number: 'RMA-368-0001', partyId: S.r1, contactId: null, salesOrderId: null, status: 'RECEIVED', outcomeWanted: null, inspectedAt: null, replacementOrderId: null, closedAt: null, statusReason: null, finishReason: null, scanCode: null, policyId: null, withdrawal: false, version: 1 })],
    )
    await force(
      `INSERT INTO "ReturnLine" SELECT (jsonb_populate_record(NULL::"ReturnLine", to_jsonb(l) || $2::jsonb)).* FROM "ReturnLine" l JOIN "ReturnAuthorisation" r ON r.id = l."returnId" WHERE r."tenantId" = $1 AND r.number = 'SEED-RMA-0002' ORDER BY l.seq LIMIT 1`,
      [T, JSON.stringify({ id: rmaLine, returnId: rma, partyId: S.r1, seq: 10, salesOrderLineId: unitLine, size: null, invoiceLineId: null, description: 'Made-up made-to-measure jacket', serial: null, batchNumber: null, quantity: 1, receivedQuantity: 1, receiptId: null, grade: 'DAMAGED', cause: 'NO_FAULT', disposition: null, goodsOutcome: null, decidedAt: null, decidedById: null, replacementLineId: null, garmentSerial: null, garmentBatch: null, parentLineId: null, creditWithoutReturn: false, exchangeSize: null, feeRuleId: null, feeAmount: null, creditAmount: 0, version: 1 })],
    )
    const preview = await ok('sales', 'POST', `/sales/returns/${rma}/decisions/preview`, { lines: [{ lineId: rmaLine, disposition: 'CREDIT_ONLY' }] })
    const remake = preview.lines[0].options.find((option: Json) => option.disposition === 'REMAKE')
    expect(remake).toMatchObject({ outcomes: [{ outcome: 'SCRAP', held: null }, { outcome: 'QUARANTINE', held: null }] })
    const seeded = await one<{ id: string; lineId: string }>(`SELECT r.id, l.id AS "lineId" FROM "ReturnAuthorisation" r JOIN "ReturnLine" l ON l."returnId" = r.id WHERE r."tenantId" = $1 AND r.number = 'SEED-RMA-0002' ORDER BY l.seq LIMIT 1`, [T])
    const other = await ok('sales', 'POST', `/sales/returns/${seeded.id}/decisions/preview`, { lines: [{ lineId: seeded.lineId, disposition: 'CREDIT_ONLY' }] })
    expect(other.lines[0].options.map((option: Json) => option.disposition)).not.toContain('REMAKE')
    const restock = await ok('sales', 'POST', `/sales/returns/${rma}/decisions/preview`, { lines: [{ lineId: rmaLine, disposition: 'REMAKE', goodsOutcome: 'RESTOCK' }] })
    expect(restock.ok).toBe(false)
  })

  it('the office’s remake mark records the customer’s wish REMAKE on the RMA', async () => {
    const version = (await one<{ version: number }>(`SELECT version FROM "ReturnAuthorisation" WHERE id = $1`, [rma])).version
    await ok('sales', 'POST', `/sales/returns/${rma}/remake`, { version, lineIds: [rmaLine], fit: 'Made-up: the sleeves are 3 cm short.' })
    expect((await one(`SELECT "outcomeWanted"::text AS wish FROM "ReturnAuthorisation" WHERE id = $1`, [rma])).wish).toBe('REMAKE')
    expect((await ok('sales', 'GET', `/sales/returns/${rma}`)).return).toMatchObject({ outcomeWanted: 'REMAKE' })
  })

  it('while made-to-measure is off, the remake is offered held with GATE-MTM’s words', async () => {
    await switchMtm(false)
    const preview = await ok('sales', 'POST', `/sales/returns/${rma}/decisions/preview`, { lines: [{ lineId: rmaLine, disposition: 'REMAKE' }] })
    const remake = preview.lines[0].options.find((option: Json) => option.disposition === 'REMAKE')
    expect(remake.outcomes.map((outcome: Json) => outcome.held)).toEqual([expect.stringContaining('Made-to-measure has not started'), expect.stringContaining('Made-to-measure has not started')])
    expect(messages({ issues: preview.problems })).toEqual(expect.arrayContaining([expect.stringContaining('Made-to-measure has not started')]))
    await switchMtm(true)
  })
})
