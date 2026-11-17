import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { urgencyWorld, type UrgencyWorld } from '../../production/testing/urgency-world'

/**
 * B-PR-27a (the pr3e note: "a colourway CHANGE ask is not taken yet — its accept goes here") — a customer asks a line of its order
 * in another colourway of the line's style, and Sales accepts it (production plan §3 "Brand asks, we decide": change … colour;
 * 08-backend §4.2 "CHANGE (exists) + colour"; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any
 * other brand. But we, as the production unit, should be able to see it all. And manage it all as well."), on the local stack
 * through the real app (../../production/testing/urgency-world.ts: brand A = the seeds' P1, brand B the threads' second brand;
 * the harness's own jacket, its colourway and a made-up second one, RED, made in 50, 52 and 54):
 *
 *   ask      the rules read lists the other colourways of the line's style with their sizes; the change stores the line size by
 *            size with the colourway (the database checks it is another colourway of the line's own style); refused in words:
 *            the line's own colourway, a size not made in it
 *   accept   Sales (orders.manage): a NEW line of the style in the colourway with the sizes asked, at the old line's price, the old
 *            line closed short (a line a request names is never removed), the request ACCEPTED with the amendment; the same pieces
 *            at the same price ask no re-acceptance
 *   by hand  once a work order makes the line: refused in words (cancel-and-remake), nothing written
 *   wall     a Sales person limited to B does not reach A's request (404); B's order lines do not move
 *
 * Every name, address and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/change-requests`.
 */

let world: UrgencyWorld
const NS = 'pr27a-colourway'
type Json = Record<string, any>
type Office = Awaited<ReturnType<UrgencyWorld['officePerson']>>
type Portal = Awaited<ReturnType<UrgencyWorld['portalPerson']>>
let sales: Office
let salesB: Office
let buyerA: Portal
const RED = newId()
const orders = {} as Record<'free' | 'inWork' | 'refused' | 'b', { orderId: string; number: string; lineId: string }>

const admin = <R = Json>(sql: string, values: unknown[] = []) => world.admin<R>(sql, values)
const key = () => ({ headers: { 'idempotency-key': `pr27a-colour-${newId()}` } })

async function send(person: Office | Portal, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const answer = method === 'GET' ? await person.browser.send('GET', url) : await person.browser.send('POST', url, body, key())
  return { status: answer.status, body: answer.body as Json }
}
async function ok(person: Office | Portal, url: string): Promise<Json> {
  const answer = await send(person, 'GET', url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(200)
  return answer.body
}
const linesOf = (orderId: string) =>
  admin<{ id: string; seq: number; colourwayId: string; unitPrice: string; closedShortQuantity: number | null }>(
    'SELECT id::text AS id, seq, "colourwayId"::text AS "colourwayId", "unitPrice"::text AS "unitPrice", "closedShortQuantity" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq',
    [orderId],
  )
const sizesOf = (lineId: string) => admin<{ size: string; quantity: number }>('SELECT size, quantity FROM "SalesOrderLineSize" WHERE "lineId" = $1 ORDER BY size', [lineId])
const requestRow = (id: string) => admin<{ status: string; version: number; amendmentId: string | null }>('SELECT status::text AS status, version, "amendmentId"::text AS "amendmentId" FROM "OrderChangeRequest" WHERE id = $1', [id]).then((rows) => rows[0]!)

beforeAll(async () => {
  world = await urgencyWorld('pr27a_colourway', NS)
  // A second colourway of the harness's own jacket (RED), made in 50, 52 and 54 (its SKUs active): written whole, as a catalogue
  // import would, with the database's rules off for these statements (a copy of the jacket's own colourway).
  const own = (await admin<{ colourwayId: string }>('SELECT "colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" WHERE id = $1', [world.w.a.salesOrderLineId]))[0]!.colourwayId
  await world.replica([
    { sql: `INSERT INTO "Colourway" SELECT (jsonb_populate_record(NULL::"Colourway", to_jsonb(c) || jsonb_build_object('id', $1::text, 'code', 'T-RED', 'name', 'Made-up red'))).* FROM "Colourway" c WHERE c.id = $2::uuid`, values: [RED, own] },
    ...['50', '52', '54'].map((size) => ({
      sql: `INSERT INTO "Variant" (id, "tenantId", "styleId", "colourwayId", size, sku, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'ACTIVE')`,
      values: [newId(), world.ids.tenantId, world.w.styleId, RED, size, `T-OWN-JKT-02-RED-${size}-${RED.slice(-4)}`],
    })),
  ])
  for (const name of ['free', 'inWork', 'refused'] as const) orders[name] = await world.addOrder(world.ids.a, `COL-${name.toUpperCase()}`, '2026-10-01')
  orders.b = await world.addOrder(world.ids.b, 'COL-B', '2026-10-01')
  // A work order already makes the "in work" order's line.
  const made = await world.officeApp.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.all' }, payload: { siteId: world.w.siteId, lines: [{ salesOrderLineId: orders.inWork.lineId, sizes: [{ size: '50', quantity: 2 }] }] } })
  expect(made.statusCode, made.body).toBe(201)
  sales = await world.officePerson('sonia.sales@pr27a-colour-office.example.com', 'sales')
  salesB = await world.officePerson('saul.sales@pr27a-colour-office.example.com', 'sales', [world.ids.b])
  buyerA = await world.portalPerson('ada.buyer@pr27a-colour-brand-alpha.example.com', world.ids.a, ['customer-buyer'])
}, 600_000)

beforeEach(() => {
  freshGuard(world.h)
})

afterAll(async () => {
  await world?.close()
})

describe('B-PR-27a: a line in another colourway, asked from the portal and accepted by Sales', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const ids = {} as Record<'free' | 'inWork', string>

  it('the rules read lists the other colourways with their sizes; the line’s own colourway or a size not made in it is refused in words', async () => {
    const rules = await ok(buyerA, `/portal/sales-orders/${orders.refused.orderId}/change-requests/rules`)
    const line = (rules.lines as Json[]).find((entry) => entry.lineId === orders.refused.lineId)!
    expect(line.colourways).toEqual([{ id: RED, code: 'T-RED', name: 'Made-up red', sizes: ['50', '52', '54'] }])
    const own = (await linesOf(orders.refused.orderId))[0]!.colourwayId
    const ownAsked = await send(buyerA, 'POST', `/portal/sales-orders/${orders.refused.orderId}/change-requests`, { kind: 'CHANGE', colourways: [{ lineId: orders.refused.lineId, colourwayId: own }] })
    expect(ownAsked.status).toBe(400)
    expect(ownAsked.body.error.issues[0]).toMatchObject({ path: 'body/colourways/0/colourwayId' })
    // Size 56 is not made in RED (nor in the line's colourway): refused at its cell.
    const notMade = await send(buyerA, 'POST', `/portal/sales-orders/${orders.refused.orderId}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: orders.refused.lineId, size: '56', quantity: 1 }], colourways: [{ lineId: orders.refused.lineId, colourwayId: RED }] })
    expect(notMade.status).toBe(400)
    // Another colourway only on a change.
    expect((await send(buyerA, 'POST', `/portal/sales-orders/${orders.refused.orderId}/change-requests`, { kind: 'CANCEL', reasonCode: 'LEAD_TIME', colourways: [{ lineId: orders.refused.lineId, colourwayId: RED }] })).body.error.issues[0].path).toBe('body/colourways')
    expect(await admin('SELECT id FROM "OrderChangeRequest" WHERE "orderId" = $1', [orders.refused.orderId])).toEqual([])
  })

  it('the change is stored size by size with the colourway; Sales accepts it as a new line at the old price and the old line closed short', async () => {
    const asked = await send(buyerA, 'POST', `/portal/sales-orders/${orders.free.orderId}/change-requests`, { kind: 'CHANGE', colourways: [{ lineId: orders.free.lineId, colourwayId: RED }], note: 'Made-up: the red sells better.' })
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    ids.free = asked.body.request.id as string
    expect(asked.body.request.cells).toEqual([
      expect.objectContaining({ lineId: orders.free.lineId, size: '50', before: 2, asked: 2, askedColourway: { id: RED, code: 'T-RED', name: 'Made-up red' } }),
      expect.objectContaining({ lineId: orders.free.lineId, size: '52', before: 2, asked: 2, askedColourway: { id: RED, code: 'T-RED', name: 'Made-up red' } }),
    ])
    expect(await admin('SELECT size, "styleId"::text AS "styleId", "colourwayId"::text AS "colourwayId" FROM "OrderChangeRequestLine" WHERE "requestId" = $1 ORDER BY size', [ids.free])).toEqual([
      { size: '50', styleId: world.w.styleId, colourwayId: RED },
      { size: '52', styleId: world.w.styleId, colourwayId: RED },
    ])
    // Sales limited to B: not found (the wall); B's order does not move.
    const bBefore = { lines: await linesOf(orders.b.orderId), sizes: await sizesOf(orders.b.lineId) }
    expect((await send(salesB, 'POST', `/sales/change-requests/${ids.free}/accept`, { version: 1 })).status).toBe(404)
    // The office reads what accepting does (the amendment's diff: the new line).
    const record = await ok(sales, `/sales/change-requests/${ids.free}`)
    expect(record.preview).toMatchObject({ ok: true })
    const before = (await linesOf(orders.free.orderId))[0]!
    const accepted = await send(sales, 'POST', `/sales/change-requests/${ids.free}/accept`, { version: 1, answer: 'Made-up: done, in red.' })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(accepted.body.request).toMatchObject({ status: 'ACCEPTED', amendment: { revision: expect.any(Number) } })
    const after = await linesOf(orders.free.orderId)
    expect(after).toHaveLength(2)
    // The old line closed short (never removed: the request names it); the new one in RED, the same sizes, the old price.
    expect(after[0]).toMatchObject({ id: before.id, colourwayId: before.colourwayId, closedShortQuantity: expect.any(Number) })
    expect(after[1]).toMatchObject({ colourwayId: RED, closedShortQuantity: null, unitPrice: before.unitPrice })
    expect(await sizesOf(after[1]!.id)).toEqual([{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }])
    expect((await requestRow(ids.free)).amendmentId).toBe(accepted.body.request.amendment.id)
    // The same pieces at the same price: no re-acceptance asked of the customer.
    expect((await admin<{ reapprovalNeededAt: string | null }>('SELECT "reapprovalNeededAt" FROM "SalesOrder" WHERE id = $1', [orders.free.orderId]))[0]!.reapprovalNeededAt).toBeNull()
    expect({ lines: await linesOf(orders.b.orderId), sizes: await sizesOf(orders.b.lineId) }).toEqual(bBefore)
    // The customer reads it accepted, in its words.
    const mine = ((await ok(buyerA, `/portal/sales-orders/${orders.free.orderId}/change-requests`)).items as Json[]).find((item) => item.id === ids.free)!
    expect(mine).toMatchObject({ status: 'ACCEPTED', answer: 'Made-up: done, in red.' })
  })

  it('once a work order makes the line, a colour change is answered by hand (cancel-and-remake): refused in words, nothing written', async () => {
    const asked = await send(buyerA, 'POST', `/portal/sales-orders/${orders.inWork.orderId}/change-requests`, { kind: 'CHANGE', colourways: [{ lineId: orders.inWork.lineId, colourwayId: RED }] })
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    ids.inWork = asked.body.request.id as string
    const record = await ok(sales, `/sales/change-requests/${ids.inWork}`)
    expect(record.preview.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'request/COLOUR_IN_WORK' })]))
    const refused = await send(sales, 'POST', `/sales/change-requests/${ids.inWork}/accept`, { version: 1 })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('request/COLOUR_IN_WORK')
    expect(refused.body.error.message).toMatch(/cancel-and-remake/)
    expect(await linesOf(orders.inWork.orderId)).toHaveLength(1)
    expect(await requestRow(ids.inWork)).toMatchObject({ status: 'OPEN', version: 1, amendmentId: null })
  })
})
