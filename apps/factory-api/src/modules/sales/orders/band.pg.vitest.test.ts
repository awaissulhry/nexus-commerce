import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { keysIn, MONEY_KEY, officeWorld, type OfficeWorld } from './testing/office-world'

/**
 * owb-of1 step 2 + 3 (order workflow, settle L3: Draft and Sent orders keep /sales/orders/new?draft=<id>, framed with this band):
 * GET /sales/orders/requests/:requestId/band on the office world (./testing/office-world.ts). Written, not run (Owner rule). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders/band`.
 *
 *   BA-1  a Sent order: may.confirm true for Sales (orders.manage), false for the designer on it; no price key
 *   BA-2  a line without a product → confirmHeld true and the line named PRODUCT in `open.lines`
 *   BA-3  the designer not on it → 404; a party-limited role of another customer → 404; neither right → 403
 *   BA-4  "Give to the designer" (POST /sales/orders/designer): orders.manage over every order, all or nothing; once per person
 */

vi.setConfig({ testTimeout: 180_000 })

let w: OfficeWorld
const textLine = newId()

beforeAll(async () => {
  w = await officeWorld('band')
  // SEED-RQ-0001 gets a second line in the customer's words, no product picked (as a text order has).
  const line = (await w.admin<{ id: string; seq: number }>(`SELECT id, seq FROM "PortalOrderRequestLine" WHERE "requestId" = $1 ORDER BY seq DESC LIMIT 1`, [w.ids.rq1]))[0]!
  await w.planted([
    {
      sql: `INSERT INTO "PortalOrderRequestLine" SELECT * FROM jsonb_populate_record(NULL::"PortalOrderRequestLine", (SELECT to_jsonb(l) || $2::jsonb FROM "PortalOrderRequestLine" l WHERE l.id = $1))`,
      values: [line.id, JSON.stringify({ id: textLine, seq: line.seq + 1, kind: 'DESCRIBED', styleId: null, colourwayId: null, description: 'Made-up racing jacket, red and white', quantity: 4, sourceOrderLineId: null, version: 1 })],
    },
  ])
}, 900_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

const band = (who: Parameters<OfficeWorld['get']>[0], requestId = w.ids.rq1) => w.get(who, `/sales/orders/requests/${requestId}/band`)

describe('BA-1 the band of a Sent order', () => {
  it('Sales may confirm it; the designer on it reads it and may not; no price key', async () => {
    const read = await band('sales')
    expect(read.statusCode, read.body.slice(0, 300)).toBe(200)
    const answer = read.json()
    expect(Object.keys(answer).sort()).toEqual(['id', 'life', 'may', 'number', 'open', 'party', 'picture', 'subject', 'version'])
    expect(answer).toMatchObject({ id: w.ids.rq1, number: 'SEED-RQ-0001', life: 'SENT', party: { id: w.ids.p1 }, may: { confirm: true, picture: true } })
    expect([...keysIn(answer)].filter((key) => MONEY_KEY.test(key))).toEqual([])
    await w.planted([{ sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'PortalOrderRequest', $3, $4, 'CHOSE')`, values: [newId(), w.tenant, w.ids.rq1, w.people.designer] }])
    const designer = await band('designer')
    expect(designer.statusCode, designer.body.slice(0, 300)).toBe(200)
    expect(designer.json().may).toEqual({ confirm: false, picture: false })
  })
})

describe('BA-2 the one stop that stays (A-5)', () => {
  it('a line without a product holds Confirm and is named PRODUCT', async () => {
    const answer = (await band('sales')).json()
    expect(answer.open.confirmHeld).toBe(true)
    expect(answer.open.lines).toEqual(expect.arrayContaining([expect.objectContaining({ lineId: textLine, what: 'PRODUCT' })]))
    expect(answer.open.count).toBeGreaterThanOrEqual(1)
  })
})

describe('BA-3 the walls', () => {
  it('another customer\'s role and an unknown id get the same 404; a request the designer is not on is 404; neither right is 403', async () => {
    for (const [who, id] of [['onlyP4', w.ids.rq1], ['sales', newId()], ['designer', w.ids.rq3]] as const) {
      const refused = await band(who, id)
      expect(refused.statusCode, `${who} ${refused.body.slice(0, 200)}`).toBe(404)
      expect(refused.body).not.toContain('SEED-RQ')
    }
    expect((await band('nobody')).statusCode).toBe(403)
  })
})

describe('BA-4 Give to the designer', () => {
  it('puts the person on every order once; one order not managed refuses all, nothing written', async () => {
    const body = { orderIds: [w.ids.so1, w.ids.so3], userId: w.people.designer }
    const given = await w.post('sales', '/sales/orders/designer', body)
    expect(given.statusCode, given.body.slice(0, 300)).toBe(200)
    expect(given.json()).toEqual({ added: 2 })
    expect((await w.post('sales', '/sales/orders/designer', body)).json()).toEqual({ added: 0 })
    const follows = await w.admin<{ recordId: string; reason: string; createdById: string }>(`SELECT "recordId", reason::text AS reason, "createdById" FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = 'SalesOrder' AND "userId" = $2 ORDER BY "recordId"`, [w.tenant, w.people.designer])
    expect(follows.map((row) => row.recordId).sort()).toEqual([w.ids.so1, w.ids.so3].sort())
    for (const row of follows) expect(row).toMatchObject({ reason: 'ADDED', createdById: w.people.sales })
    expect((await w.admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.designer.give'`, [w.tenant]))[0]!.n).toBe(4)
    // The designer now reads both orders (on-the-order.ts).
    for (const id of [w.ids.so1, w.ids.so3]) expect((await w.get('designer', `/sales/orders/${id}`)).statusCode).toBe(200)
    // All or nothing: another customer's role sees none of them (404), the designer manages none (its manifest: 403).
    expect((await w.post('onlyP4', '/sales/orders/designer', { orderIds: [w.ids.so2], userId: w.people.priced })).statusCode).toBe(404)
    expect((await w.post('designer', '/sales/orders/designer', { orderIds: [w.ids.so2], userId: w.people.priced })).statusCode).toBe(403)
    expect((await w.admin(`SELECT 1 FROM "RecordFollower" WHERE "tenantId" = $1 AND "userId" = $2`, [w.tenant, w.people.priced])).length).toBe(0)
    // Not an office person: 400 in words.
    const portal = await w.post('sales', '/sales/orders/designer', { orderIds: [w.ids.so2], userId: newId() })
    expect(portal.statusCode).toBe(400)
    expect(portal.json().error.issues[0].path).toBe('body/userId')
  })
})
