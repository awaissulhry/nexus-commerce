import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { NOTICE_ANSWERED_WORDS, NOTICE_NOT_FOUND } from './notices'
import { officeWorld, type OfficeWorld } from './testing/office-world'

/**
 * owb-of1 step 4 (order workflow, plan.md § 5m R37 "a notice, it changes nothing owed"; PL-schema § 5A row 4, guard G7): the customer's
 * "I paid" notices of an order, read and answered by the office, on the office world (./testing/office-world.ts). Written, not run
 * (Owner rule). Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/notices`.
 *
 *   NO-1  Sales reads the notice in words, without the amount; a price holder reads the amount
 *   NO-2  answered once: DISMISSED, then a second answer is 409 in words; a stale version 409
 *   NO-3  RECORDED records no payment (nothing new in Payment); Sales may not answer (payments.record: 403)
 *   NO-4  a notice of another order is not found; another customer's role reads nothing (404)
 */

vi.setConfig({ testTimeout: 180_000 })

let w: OfficeWorld
const first = newId()
const second = newId()

const notice = (id: string, orderId: string, amount: number) => ({
  sql: `INSERT INTO "PaymentNotice" (id, "tenantId", "companyId", "partyId", "salesOrderId", amount, currency, "paidOn", method, note, state, version, "createdAt", "updatedAt")
        SELECT $1, o."tenantId", o."companyId", o."partyId", o.id, $3, 'EUR', DATE '2026-11-20', 'Bank transfer', 'Made-up: paid the deposit', 'OPEN', 1, now(), now() FROM "SalesOrder" o WHERE o.id = $2`,
  values: [id, orderId, amount],
})

beforeAll(async () => {
  w = await officeWorld('notices')
  await w.planted([notice(first, w.ids.so1, 123_456), notice(second, w.ids.so1, 4_321)])
}, 900_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

describe('NO-1 the read', () => {
  it('Sales reads every notice of the order in words and never the amount; a price holder reads the amount', async () => {
    const sales = await w.get('sales', `/sales/orders/${w.ids.so1}/payment-notices`)
    expect(sales.statusCode, sales.body.slice(0, 300)).toBe(200)
    const rows = sales.json().notices as Record<string, unknown>[]
    expect(rows.map((row) => row.id).sort()).toEqual([first, second].sort())
    for (const row of rows) {
      expect(row).not.toHaveProperty('amount')
      expect(row).toMatchObject({ state: 'OPEN', currency: 'EUR', paidOn: '2026-11-20', method: 'Bank transfer' })
    }
    expect(sales.body).not.toContain('123456')
    const priced = (await w.get('priced', `/sales/orders/${w.ids.so1}/payment-notices`)).json().notices as Record<string, unknown>[]
    expect(priced.find((row) => row.id === first)).toMatchObject({ amount: 123_456 })
  })
})

describe('NO-2 answered once', () => {
  it('DISMISSED once; a second answer is refused in words; a stale version is 409', async () => {
    expect((await w.post('priced', `/sales/orders/${w.ids.so1}/payment-notices/${first}/answer`, { version: 9, state: 'DISMISSED' })).statusCode).toBe(409)
    const answered = await w.post('priced', `/sales/orders/${w.ids.so1}/payment-notices/${first}/answer`, { version: 1, state: 'DISMISSED' })
    expect(answered.statusCode, answered.body.slice(0, 300)).toBe(200)
    expect(answered.json().notice).toMatchObject({ id: first, state: 'DISMISSED', version: 2 })
    const again = await w.post('priced', `/sales/orders/${w.ids.so1}/payment-notices/${first}/answer`, { version: 2, state: 'RECORDED' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toBe(NOTICE_ANSWERED_WORDS.en)
    const row = (await w.admin<{ state: string; answeredById: string }>('SELECT state::text AS state, "answeredById" FROM "PaymentNotice" WHERE id = $1', [first]))[0]!
    expect(row).toEqual({ state: 'DISMISSED', answeredById: w.people.priced })
    expect((await w.admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.paymentNotice.answer'`, [w.tenant]))[0]!.n).toBe(1)
  })
})

describe('NO-3 RECORDED changes nothing owed', () => {
  it('records no payment; Sales may not answer', async () => {
    expect((await w.post('sales', `/sales/orders/${w.ids.so1}/payment-notices/${second}/answer`, { version: 1, state: 'RECORDED' })).statusCode).toBe(403)
    const payments = async () => (await w.admin<{ n: number }>('SELECT count(*)::int AS n FROM "Payment" WHERE "tenantId" = $1', [w.tenant]))[0]!.n
    const before = await payments()
    expect((await w.post('priced', `/sales/orders/${w.ids.so1}/payment-notices/${second}/answer`, { version: 1, state: 'RECORDED' })).json().notice).toMatchObject({ state: 'RECORDED' })
    expect(await payments()).toBe(before)
  })
})

describe('NO-4 the walls', () => {
  it('a notice of another order is not found; another customer\'s role reads nothing', async () => {
    const other = await w.post('priced', `/sales/orders/${w.ids.so2}/payment-notices/${second}/answer`, { version: 2, state: 'DISMISSED' })
    expect(other.statusCode).toBe(404)
    expect(other.json().error.message).toBe(NOTICE_NOT_FOUND)
    expect((await w.get('onlyP4', `/sales/orders/${w.ids.so1}/payment-notices`)).statusCode).toBe(404)
  })
})
