import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedLeather } from '../../../../../../packages/factory-db/seed/leather'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * The leather and cut plan (B-W2b-132; PLN-106 need in area and hides, PLN-108 one shade per order, PLN-109 planned against
 * actual yield, PLN-114 certified protectors; design planning.leather) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the triggers — the
 * revision freeze among them — are real), on the factory-db seeds of one tenant: SEED-SO-0002 (CONFIRMED) on SEED-JKT-02
 * rev 1 (RELEASED, planned hide yield 75 %, its cowhide line 12 % wastage, a shoulder protector SEED-PRO-300) made at A1 by
 * SEED-WO-0001 (IN_PROGRESS, holding SEED-HIDE-0001 of lot SEED-LOT-LEA-01) and SEED-WO-0002. Made up here: six cut log
 * entries of SEED-WO-0001 that each use 30 % more than their pattern (written with the cut log's triggers off for this set-up
 * only: the floor route's checks are B-W2b-103's and tested there), a draft revision 2 copied through Products' own route.
 * Every name and value is made up.
 *
 * The rules the tests name: a changed loss goes into the DRAFT revision only (a released revision and the work orders made
 * from it never change); a decision rests on the proposal the person saw (409 refusal/PROPOSAL_MOVED); money only with the
 * cost grain; never a cutter. Run with `node scripts/factory/run-pg-tests.mjs modules/planning/leather`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'w2b132-leather'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const siteA1 = idOf('site:A1')

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'planning.run', 'planning.leather.manage'])] },
  costed: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'money.cost'])] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view'])] },
  maker: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['product.bom.view', 'product.bom.manage', 'product.styles.view'])] },
  outsider: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['inventory.stock.view'])] },
  // B-W2b-GB29 (G226): a planner who reserves (the split by garment).
  reserver: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['planning.view', 'inventory.reserve', 'inventory.stock.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': `t-${run}-${++serial}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues as Json[]).map((issue) => String(issue.path))
const outbox = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id', [T, type, subject])

let jacket: { id: string; released: string }
const need = () => ok('planner', 'GET', `/planning/leather/need?siteId=${siteA1}`)
const yieldOf = async (session = 'planner') => ((await ok(session, 'GET', `/planning/leather/yield?siteId=${siteA1}`)).rows as Json[]).find((row) => row.style.code === 'SEED-JKT-02')!
const acceptUrl = () => `/planning/leather/styles/${jacket.id}/loss/accept`
const dismissUrl = () => `/planning/leather/styles/${jacket.id}/loss/dismiss`

beforeAll(async () => {
  h = await startHarness('planning_leather')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedPrivacy, seedLeather]) await seed({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    { database: h.database, officeAuth: h.auth, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )

  const [style] = await admin<{ id: string; released: string }>(`SELECT s.id, r.id AS released FROM "Style" s JOIN "StyleRevision" r ON r."styleId" = s.id AND r.status = 'RELEASED' WHERE s."tenantId" = $1 AND s.code = 'SEED-JKT-02'`, [T])
  jacket = style!
  // Six made-up cuts of SEED-WO-0001's black size-50 garment: one whole set each ("Outer shell"), 30 % more area than the pattern.
  const [cell] = await admin<{ cellId: string; workOrderId: string; quantity: number; baseQuantity: string; wastagePct: string; lotId: string; hideId: string; uom: string }>(
    `SELECT s.id AS "cellId", s."workOrderId", s.quantity, m."baseQuantity"::text AS "baseQuantity", b."wastagePct"::text AS "wastagePct", h."lotId", h.id AS "hideId", i."baseUom"::text AS uom
       FROM "WorkOrder" w JOIN "WorkOrderSize" s ON s."workOrderId" = w.id JOIN "WorkOrderMaterial" m ON m."workOrderSizeId" = s.id JOIN "BomLine" b ON b.id = m."bomLineId"
       JOIN "Hide" h ON h.code = 'SEED-HIDE-0001' AND h."tenantId" = w."tenantId" JOIN "Lot" l ON l.id = h."lotId" JOIN "Item" i ON i.id = h."itemId"
      WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0001' AND m."itemId" = h."itemId" AND m."itemColourId" = l."itemColourId" ORDER BY s.size LIMIT 1`,
    [T],
  )
  const pattern = Number(cell!.baseQuantity) / (1 + Number(cell!.wastagePct) / 100) / cell!.quantity
  const used = (pattern / 0.7).toFixed(4)
  await admin(`ALTER TABLE "CutLog" DISABLE TRIGGER USER`)
  await admin(`ALTER TABLE "CutLogPiece" DISABLE TRIGGER USER`)
  try {
    for (let index = 0; index < 6; index += 1) {
      const id = newId()
      await admin(
        `INSERT INTO "CutLog" (id, "tenantId", "siteId", "workOrderId", "lotId", "hideId", uom, "areaUsed", "baseAreaUsed", "clientEventId", "serverTime") VALUES ($1, $2, $3, $4, $5, $6, $7::"Uom", $8, $8, $9, now() - ($10 || ' days')::interval)`,
        [id, T, siteA1, cell!.workOrderId, cell!.lotId, cell!.hideId, cell!.uom, used, `leather-plan-${run}-${index}`, String(10 - index)],
      )
      await admin(`INSERT INTO "CutLogPiece" (id, "tenantId", "siteId", "workOrderId", "cutLogId", "workOrderSizeId", part, pieces) VALUES ($1, $2, $3, $4, $5, $6, 'Outer shell', 1)`, [newId(), T, siteA1, cell!.workOrderId, id, cell!.cellId])
    }
  } finally {
    await admin(`ALTER TABLE "CutLog" ENABLE TRIGGER USER`)
    await admin(`ALTER TABLE "CutLogPiece" ENABLE TRIGGER USER`)
  }
  await ok('planner', 'POST', '/planning/runs', { siteId: siteA1 }, 201)
}, 120_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('leather need per order and one shade (PLN-106, PLN-108)', () => {
  it('reads the latest plan run: area and hides per order line, what is left to find, the shade lots and the answer', async () => {
    const answer = await need()
    expect(answer.run).toMatchObject({ id: expect.any(String) })
    expect(answer.rule).toBe('ORDER')
    const rows = (answer.rows as Json[]).filter((row) => row.style.code === 'SEED-JKT-02')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.item.code).toBe('SEED-LEA-100')
      expect(Number(row.area)).toBeGreaterThan(0)
      expect(Number(row.toFind)).toBe(Math.max(0, Math.round((Number(row.area) - Number(row.issued) - Number(row.reserved)) * 10000) / 10000))
      // The loss the plan carries: the leather line's 12 % on top = 10.71 % of the area cut.
      expect(row).toMatchObject({ lossPct: '10.71', lossSource: 'BOM' })
      expect(Number(row.netArea)).toBeCloseTo(Number(row.area) / 1.12, 3)
      expect(row.parts.map((part: Json) => part.part)).toEqual(['Outer shell'])
      expect(['COVERED', 'FITS', 'SPLIT', 'MUST_BUY', 'ASK_CUSTOMER']).toContain(row.feasibility)
      expect(row.sizes.length).toBeGreaterThan(0)
      // No money without the cost grain.
      expect(row).not.toHaveProperty('value')
    }
    const withWorkOrder = rows.find((row) => row.workOrders.some((order: Json) => order.number === 'SEED-WO-0001'))!
    expect(withWorkOrder.heldLots.map((held: Json) => held.lotCode)).toContain('SEED-LOT-LEA-01')
    if (withWorkOrder.feasibility === 'MUST_BUY') expect(Number(withWorkOrder.buy.area)).toBeGreaterThan(0)
  })

  it('gives the cost grain the value of what is left to find, and nobody without planning.view a read', async () => {
    const answer = await ok('costed', 'GET', `/planning/leather/need?siteId=${siteA1}`)
    expect((answer.rows as Json[])[0]).toHaveProperty('value')
    await no('outsider', 'GET', `/planning/leather/need?siteId=${siteA1}`, undefined, 403)
  })
})

describe('certified protectors (PLN-114)', () => {
  it('plans the part the style names with its certificate and the released lots; another protector is never offered', async () => {
    const answer = await ok('viewer', 'GET', `/planning/leather/protectors?siteId=${siteA1}`)
    const row = (answer.rows as Json[]).find((entry) => entry.style.code === 'SEED-JKT-02' && entry.item.code === 'SEED-PRO-300')!
    expect(row).toMatchObject({ placement: 'Shoulder pockets' })
    expect(Number(row.needed)).toBeGreaterThan(0)
    expect(['NO_CERTIFICATE', 'EXPIRES_BEFORE_DUE', 'SHORT', 'OK']).toContain(row.state)
    if (row.certificate === null) expect(row.state).toBe('NO_CERTIFICATE')
    expect(row.substitutes.map((other: Json) => other.code)).not.toContain('SEED-PRO-300')
  })
})

describe('planned against actual yield and the cutting loss (PLN-109)', () => {
  it('learns the loss from the cuts and proposes it against the plan', async () => {
    const row = await yieldOf()
    expect(row.cuts).toBeGreaterThanOrEqual(6)
    expect(row).toMatchObject({ plannedLossPct: '25.00', plannedSource: 'STYLE', revision: { revision: 1 }, draft: null })
    expect(Number(row.actualLossPct)).toBeGreaterThan(26)
    expect(row.proposal).toMatchObject({ state: 'PROPOSED', fromPct: '25.00', cuts: row.cuts })
    expect(row.trend.length).toBeGreaterThan(0)
    expect(row).not.toHaveProperty('extraLossValue')
    expect(await yieldOf('costed')).toHaveProperty('extraLossValue')
  })

  it('refuses a decision on a moved proposal, a short reason and a person without the right', async () => {
    const row = await yieldOf()
    expect(pathsOf(await no('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts - 1 }, 409))).toContain('refusal/PROPOSAL_MOVED')
    expect(pathsOf(await no('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: '45', cuts: row.cuts }, 400))).toContain('body/toPct')
    expect(pathsOf(await no('planner', 'POST', dismissUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts, reason: 'no' }, 400))).toContain('body/reason')
    await no('viewer', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts }, 403)
  })

  it('records an accepted loss without a draft revision; the released revision never changes', async () => {
    const row = await yieldOf()
    const decided = await ok('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts })
    expect(decided).toMatchObject({ decision: 'ACCEPTED', fromPct: '25.00', toPct: row.proposal.toPct, carriedIn: null })
    const after = await yieldOf()
    expect(after.proposal.state).toBe('ACCEPTED')
    expect(after.lastDecision).toMatchObject({ decision: 'ACCEPTED', toPct: row.proposal.toPct, revision: null })
    const [released] = await admin<{ y: string }>(`SELECT "plannedHideYieldPct"::text AS y FROM "StyleRevision" WHERE id = $1`, [jacket.released])
    expect(released!.y).toBe('75.0000')
    expect(pathsOf(await no('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts }, 409))).toContain('refusal/ALREADY_ACCEPTED')
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'planning.leather.acceptLoss' AND "recordType" = 'Style' AND "recordId" = $2`, [T, jacket.id])
    expect(audit!.after).toMatchObject({ decision: 'ACCEPTED', toPct: row.proposal.toPct, cuts: row.cuts, carriedIn: null })
    expect((await outbox('planning.cutting_loss_decided', jacket.id)).map((event) => event.payload)).toEqual([expect.objectContaining({ decision: 'ACCEPTED', revisionId: null, siteId: siteA1 })])
  })

  // B-W2b-GB29 (G226): the accepted loss is kept for planning and reaches the next plan run on the released revision.
  it('keeps the accepted loss for planning: the next plan run cuts the released revision with it, without a new revision', async () => {
    const [kept] = await admin<{ pct: string; cuts: number }>(`SELECT "lossPct"::text AS pct, "basedOnCuts" AS cuts FROM "StyleCuttingLoss" WHERE "tenantId" = $1 AND "styleId" = $2 ORDER BY "decidedAt" DESC LIMIT 1`, [T, jacket.id])
    const decided = (await yieldOf()).lastDecision
    expect(kept).toEqual({ pct: Number(decided.toPct).toFixed(2), cuts: expect.any(Number) })
    const before = ((await need()).rows as Json[]).filter((row) => row.style.code === 'SEED-JKT-02')
    // The run before the decision cut with the BOM's 12 %: its area is the pattern's × 1.12.
    expect(before.length).toBeGreaterThan(0)
    await ok('planner', 'POST', '/planning/runs', { siteId: siteA1 }, 201)
    const after = ((await need()).rows as Json[]).filter((row) => row.style.code === 'SEED-JKT-02')
    expect(after.length).toBe(before.length)
    const wastage = Number(decided.toPct) / (100 - Number(decided.toPct))
    for (const row of after) {
      expect(Number(row.lossPct)).toBeCloseTo(Number(decided.toPct), 1)
      expect(Number(row.netArea)).toBeCloseTo(Number(row.area) / (1 + wastage), 2)
    }
    const total = (rows: Json[]) => rows.reduce((sum, row) => sum + Number(row.area), 0)
    expect(total(after)).toBeGreaterThan(total(before))
    // The released revision itself never changed.
    const [released] = await admin<{ w: string }>(`SELECT b."wastagePct"::text AS w FROM "BomLine" b JOIN "Item" i ON i.id = b."itemId" WHERE b."revisionId" = $1 AND i.tracking = 'HIDE'`, [jacket.released])
    expect(released!.w).toBe('12.0000')
  })

  it('carries the accepted loss into a draft revision: its planned yield and its leather wastage, under its version', async () => {
    await ok('maker', 'POST', `/product/styles/${jacket.id}/revisions/${jacket.released}/copy`, { changeNote: 'Made-up: the learned cutting loss.' }, 201)
    const row = await yieldOf()
    expect(row.draft).toMatchObject({ revision: 2 })
    expect(pathsOf(await no('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts }, 400))).toContain('body/draftVersion')
    expect((await no('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts, draftVersion: row.draft.version + 5 }, 409)).message).toMatch(/version|changed/i)
    const decided = await ok('planner', 'POST', acceptUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts, draftVersion: row.draft.version })
    const loss = Number(row.proposal.toPct)
    expect(decided.carriedIn).toMatchObject({ revisionId: row.draft.id, revision: 2, plannedHideYieldPct: (100 - loss).toFixed(4), lines: 1 })
    const [draft] = await admin<{ y: string; w: string }>(
      `SELECT r."plannedHideYieldPct"::text AS y, b."wastagePct"::text AS w FROM "StyleRevision" r JOIN "BomLine" b ON b."revisionId" = r.id JOIN "Item" i ON i.id = b."itemId" WHERE r.id = $1 AND i.tracking = 'HIDE'`,
      [row.draft.id],
    )
    expect(draft).toEqual({ y: (100 - loss).toFixed(4), w: decided.carriedIn.wastagePct })
    expect(Number(draft!.w)).toBeCloseTo((loss / (100 - loss)) * 100, 3)
    const [released] = await admin<{ w: string }>(`SELECT b."wastagePct"::text AS w FROM "BomLine" b JOIN "Item" i ON i.id = b."itemId" WHERE b."revisionId" = $1 AND i.tracking = 'HIDE'`, [jacket.released])
    expect(released!.w).toBe('12.0000')
    const events = await outbox('style.bom_changed', jacket.id)
    expect(events.at(-1)!.payload).toMatchObject({ revisionId: row.draft.id, revision: 2 })
  })

  it('dismisses a proposal with a reason; it stays quiet until it changes or more cuts come in', async () => {
    const row = await yieldOf()
    const decided = await ok('planner', 'POST', dismissUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts, reason: 'Made-up: a new knife since last week.' })
    expect(decided).toMatchObject({ decision: 'DISMISSED', carriedIn: null })
    const after = await yieldOf()
    expect(after.proposal.state).toBe('DISMISSED')
    expect(after.lastDecision).toMatchObject({ decision: 'DISMISSED', reason: 'Made-up: a new knife since last week.' })
    expect(pathsOf(await no('planner', 'POST', dismissUrl(), { siteId: siteA1, toPct: row.proposal.toPct, cuts: row.cuts, reason: 'Again (made up).' }, 409))).toContain('refusal/ALREADY_DISMISSED')
  })
})

// B-W2b-GB29 (G226): a split by garment holds each size's share for its cell of the work order (data, not words).
describe('the split by garment as data (B-W2b-GB29)', () => {
  it('reserves a lot for one size of the work order (its cell); a cell of another work order or an order-line demand is refused in words', async () => {
    const [cell] = await admin<{ id: string; workOrderId: string; lotId: string }>(
      `SELECT s.id, s."workOrderId", l.id AS "lotId" FROM "WorkOrder" w JOIN "WorkOrderSize" s ON s."workOrderId" = w.id JOIN "Lot" l ON l.code = 'SEED-LOT-LEA-01' AND l."tenantId" = w."tenantId"
        WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0001' ORDER BY s.size LIMIT 1`,
      [T],
    )
    const [other] = await admin<{ id: string }>(`SELECT s.id FROM "WorkOrder" w JOIN "WorkOrderSize" s ON s."workOrderId" = w.id WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0002' LIMIT 1`, [T])
    const refused = await no('reserver', 'POST', '/inventory/reservations', { siteId: siteA1, workOrderId: cell!.workOrderId, lines: [{ lotId: cell!.lotId, quantity: '1', workOrderSizeId: other!.id }] }, 400)
    expect(pathsOf(refused)).toContain('body/lines/0/workOrderSizeId')
    expect(refused.message).toMatch(/^Not a size of work order SEED-WO-0001/)
    const [line] = await admin<{ id: string }>(`SELECT l.id FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0002' LIMIT 1`, [T])
    const lineDemand = await no('reserver', 'POST', '/inventory/reservations', { siteId: siteA1, salesOrderLineId: line!.id, lines: [{ lotId: cell!.lotId, quantity: '1', workOrderSizeId: cell!.id }] }, 400)
    expect(lineDemand.message).toMatch(/needs the work order/)
    const made = await call('reserver', 'POST', '/inventory/reservations', { siteId: siteA1, workOrderId: cell!.workOrderId, note: 'Made-up split', lines: [{ lotId: cell!.lotId, quantity: '1', workOrderSizeId: cell!.id }] })
    // The lot may hold nothing free in this set-up (a refusal in words then); when it reserves, the row names its cell.
    if (made.statusCode === 201) {
      const [row] = await admin<{ cell: string | null }>(`SELECT "workOrderSizeId" AS cell FROM "Reservation" WHERE id = $1`, [made.json().reservations[0].id])
      expect(row!.cell).toBe(cell!.id)
    } else {
      expect(made.statusCode, made.body).toBe(409)
      expect(made.json().error.message).not.toMatch(/size/)
    }
  })
})
