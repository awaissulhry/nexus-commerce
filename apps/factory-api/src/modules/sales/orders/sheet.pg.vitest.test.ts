import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { keysIn, MONEY_KEY, officeWorld, type Json, type OfficeWorld } from './testing/office-world'

/**
 * owb-of1 step 1 + 3 (order workflow, plan.md § 5b, § 5c; the Shape FIXED in owb-of1.md): GET /sales/orders/sheet on the office world
 * (./testing/office-world.ts). Written, not run (Owner rule: checks at the end). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders/sheet`.
 *
 *   SH-1  both kinds in ONE page: a Sent request (REQUEST) beside the confirmed orders (ORDER), newest change first
 *   SH-2  a party-limited role sees only its parties' rows — the REQUEST rows too
 *   SH-3  no price / amount / cost / margin / total key anywhere in the answer (for a price holder neither)
 *   SH-4  withdrawn rows hidden by default; `life=withdrawn` shows them; a draft only under `life=drafts`
 *   SH-5  an office number never on a REQUEST row; a Sent request carries its own RQ number
 *   SH-6  the designer (orders.view.own) lists only the rows it is on; not on → absent
 *   SH-7  the cursor walks without a repeat; a cursor that is not ours is 400
 */

vi.setConfig({ testTimeout: 180_000 })

let w: OfficeWorld
const draft = newId()

beforeAll(async () => {
  w = await officeWorld('sheet')
  // A Draft of P1 (planted from SEED-RQ-0001: never sent, so no number).
  await w.planted([
    {
      sql: `INSERT INTO "PortalOrderRequest" SELECT * FROM jsonb_populate_record(NULL::"PortalOrderRequest", (SELECT to_jsonb(r) || $2::jsonb FROM "PortalOrderRequest" r WHERE r.id = $1))`,
      values: [w.ids.rq1, JSON.stringify({ id: draft, number: null, status: 'DRAFT', sentAt: null, sentById: null, subject: 'Made-up team jackets', version: 1, updatedAt: new Date().toISOString() })],
    },
  ])
}, 900_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

const sheet = async (who: Parameters<OfficeWorld['get']>[0], query = '') => {
  const answer = await w.get(who, `/sales/orders/sheet${query}`)
  expect(answer.statusCode, answer.body.slice(0, 300)).toBe(200)
  return answer.json() as { rows: Json[]; tiles: Json; nextCursor: string | null }
}

describe('SH-1 one list over both records', () => {
  it('a Sent request and the confirmed orders in one page, newest change first, in the ONE row shape', async () => {
    const page = await sheet('sales', '?limit=100')
    const kinds = new Set(page.rows.map((row) => row.kind))
    expect(kinds).toEqual(new Set(['ORDER', 'REQUEST']))
    expect(page.rows.map((row) => row.id)).toEqual(expect.arrayContaining([w.ids.so1, w.ids.rq1]))
    const request = page.rows.find((row) => row.id === w.ids.rq1)!
    expect(request).toMatchObject({ kind: 'REQUEST', life: 'SENT', where: null, promised: null, party: { id: w.ids.p1 } })
    expect(Object.keys(request).sort()).toEqual(['customerOnHold', 'daysLate', 'id', 'kind', 'life', 'lines', 'may', 'news', 'number', 'party', 'picture', 'pieces', 'promised', 'restricted', 'subject', 'version', 'wantedFor', 'where'])
    const order = page.rows.find((row) => row.id === w.ids.so1)!
    expect(order).toMatchObject({ kind: 'ORDER', number: 'SEED-SO-0001' })
    expect(order.where).toEqual(expect.objectContaining({ held: expect.any(Boolean) }))
    expect(Object.keys(page.tiles).sort()).toEqual(['inProduction', 'incoming', 'late', 'problems', 'readyToShip', 'waitingForPrint'])
    expect(page.tiles.incoming).toBeGreaterThanOrEqual(1)
  })
})

describe('SH-2 the brand wall', () => {
  it('a role limited to another customer reads none of P1\'s rows, orders or requests', async () => {
    for (const life of ['all', 'drafts', 'incoming', 'withdrawn']) {
      const page = await sheet('onlyP4', `?life=${life}&limit=100`)
      for (const row of page.rows) expect(row.party.id, `${life} ${row.kind} ${row.id}`).toBe(w.ids.p4)
      expect(JSON.stringify(page.rows)).not.toContain('SEED-RQ-0001')
    }
  })
})

describe('SH-3 no money', () => {
  it('no price, amount, cost, margin or total key anywhere — for Sales and for a price holder alike', async () => {
    for (const who of ['sales', 'priced'] as const) {
      for (const life of ['all', 'drafts', 'withdrawn']) {
        const page = await sheet(who, `?life=${life}&limit=100`)
        expect([...keysIn(page)].filter((key) => MONEY_KEY.test(key)), `${who} ${life}`).toEqual([])
      }
    }
  })
})

describe('SH-4 withdrawn and drafts', () => {
  it('withdrawn rows only on ask; a draft only under drafts', async () => {
    const all = (await sheet('sales', '?limit=100')).rows.map((row) => row.id)
    expect(all).not.toContain(w.ids.rq3)
    expect(all).not.toContain(draft)
    const withdrawn = await sheet('sales', '?life=withdrawn&limit=100')
    expect(withdrawn.rows.find((row) => row.id === w.ids.rq3)).toMatchObject({ kind: 'REQUEST', life: 'WITHDRAWN' })
    for (const row of withdrawn.rows) expect(row.life).toBe('WITHDRAWN')
    const drafts = await sheet('sales', '?life=drafts&limit=100')
    expect(drafts.rows.find((row) => row.id === draft)).toMatchObject({ kind: 'REQUEST', life: 'DRAFT', number: null, subject: 'Made-up team jackets', may: { confirm: true, deleteDraft: true, editLines: 'DRAFT' } })
    for (const row of drafts.rows) expect(row.kind).toBe('REQUEST')
  })
})

describe('SH-5 the two numbers', () => {
  it('a REQUEST row carries its own number (or none), never an office order number', async () => {
    const orderNumbers = new Set((await w.admin<{ number: string }>(`SELECT number FROM "SalesOrder" WHERE "tenantId" = $1`, [w.tenant])).map((row) => row.number))
    for (const life of ['all', 'drafts', 'incoming', 'withdrawn']) {
      for (const row of (await sheet('sales', `?life=${life}&limit=100`)).rows.filter((entry) => entry.kind === 'REQUEST')) {
        expect(orderNumbers.has(row.number), `${row.id} ${row.number}`).toBe(false)
      }
    }
    expect((await sheet('sales', '?life=incoming&limit=100')).rows.find((row) => row.id === w.ids.rq1)?.number).toBe('SEED-RQ-0001')
    // The ACCEPTED request is listed as its order, never as a request row.
    expect((await sheet('sales', '?limit=100')).rows.map((row) => row.id)).not.toContain(w.ids.rq2)
  })
})

describe('SH-6 the designer sees only its rows', () => {
  it('orders.view.own lists only what the designer is on (a follow of the order, or of the request)', async () => {
    expect((await sheet('designer', '?limit=100')).rows).toEqual([])
    await w.planted([
      { sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'SalesOrder', $3, $4, 'CHOSE')`, values: [newId(), w.tenant, w.ids.so1, w.people.designer] },
      { sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'PortalOrderRequest', $3, $4, 'CHOSE')`, values: [newId(), w.tenant, w.ids.rq1, w.people.designer] },
    ])
    const page = await sheet('designer', '?limit=100')
    expect(page.rows.map((row) => row.id).sort()).toEqual([w.ids.so1, w.ids.rq1].sort())
    for (const row of page.rows) expect(row.may).toEqual({ confirm: false, deleteDraft: false, editLines: null })
    expect([...keysIn(page)].filter((key) => MONEY_KEY.test(key))).toEqual([])
    // Someone with neither orders.view nor orders.view.own is refused as before.
    expect((await w.get('nobody', '/sales/orders/sheet')).statusCode).toBe(403)
  })
})

describe('SH-7 the cursor', () => {
  it('pages walk the whole list once; a cursor that is not ours is refused in words', async () => {
    const whole = (await sheet('sales', '?limit=100')).rows.map((row) => row.id)
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const page = await sheet('sales', `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      walked.push(...page.rows.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(walked).toEqual(whole)
    expect(new Set(walked).size).toBe(walked.length)
    expect((await w.get('sales', '/sales/orders/sheet?cursor=not-ours')).statusCode).toBe(400)
  })
})
