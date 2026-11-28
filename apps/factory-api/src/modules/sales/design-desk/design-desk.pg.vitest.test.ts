import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { keysIn, MONEY_KEY, officeWorld, type Json, type OfficeWorld } from '../orders/testing/office-world'

/**
 * owb-of2 step 4 (order workflow, plan.md § 5f "Design desk", R20): GET /design-desk on the office world (../orders/testing/office-world.ts:
 * SEED-SO-0001/-0002/-0003 are customer P1's, SEED-RQ-0001 a Sent request of P1). The designer is ASKED on SEED-SO-0001 (a mention)
 * and GIVEN SEED-RQ-0001 by Sales; an open design proof waits on a line of SEED-SO-0001, an open artwork on SEED-SO-0002 (planted,
 * the database's rules off). Written, not run (Owner rule). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/design-desk`.
 *
 *   DD-1  the designer sees only its own orders in every list: asked (HELP_ASKED, GIVEN), approvals, floor; codes is null
 *   DD-2  Sales (orders.view) sees every order's approvals; asked lists the follow rows of each customer's Factory designer
 *   DD-3  the customer's Factory designer slot: its confirmed open orders come as CONFIRMED; a mention stays HELP_ASKED
 *   DD-4  no price key anywhere; neither right 403; another customer's role sees none of P1's rows
 */

vi.setConfig({ testTimeout: 180_000 })

let w: OfficeWorld
const proof = newId()
const artwork = newId()

beforeAll(async () => {
  w = await officeWorld('desk')
  const line = (await w.admin<{ id: string }>('SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [w.ids.so1]))[0]!
  const approval = (id: string, recordType: string, recordId: string, kind: string) => ({
    sql: `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, version, "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7::"ApprovalKind", 'Made-up: is the logo right?', now() + interval '5 days', 'OPEN', 1, now(), now())`,
    values: [id, w.tenant, w.ids.company, recordType, recordId, w.ids.p1, kind],
  })
  await w.planted([
    { sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'SalesOrder', $3, $4, 'MENTIONED')`, values: [newId(), w.tenant, w.ids.so1, w.people.designer] },
    { sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, "createdById") VALUES ($1, $2, 'PortalOrderRequest', $3, $4, 'ADDED', $5)`, values: [newId(), w.tenant, w.ids.rq1, w.people.designer, w.people.sales] },
    approval(proof, 'SalesOrderLine', line.id, 'PROOF'),
    approval(artwork, 'SalesOrder', w.ids.so2, 'ARTWORK'),
  ])
}, 900_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

const desk = async (who: Parameters<OfficeWorld['get']>[0]) => {
  const answer = await w.get(who, '/design-desk')
  expect(answer.statusCode, answer.body.slice(0, 300)).toBe(200)
  return answer.json() as { asked: Json[]; approvals: Json[]; codes: Json[] | null; floor: Json[] }
}

describe('DD-1 the designer sees only its own orders', () => {
  it('asked: SO-0001 (asked in the thread) and RQ-0001 (given); approvals: only SO-0001\'s; codes null', async () => {
    const answer = await desk('designer')
    expect(answer.asked.map((row) => [row.id, row.kind, row.why]).sort()).toEqual([[w.ids.rq1, 'REQUEST', 'GIVEN'], [w.ids.so1, 'ORDER', 'HELP_ASKED']].sort())
    expect(answer.asked.find((row) => row.id === w.ids.so1)).toMatchObject({ number: 'SEED-SO-0001', party: { code: expect.any(String) } })
    expect(answer.approvals.map((row) => row.approvalId)).toEqual([proof])
    expect(answer.approvals[0]).toMatchObject({ orderId: w.ids.so1, kind: 'PROOF', state: 'OPEN' })
    expect(answer.codes).toBeNull()
    expect(answer.floor.every((row) => row.orderNumber === null || row.orderNumber === 'SEED-SO-0001')).toBe(true)
    expect(JSON.stringify(answer)).not.toContain('SEED-SO-0002')
  })
})

describe('DD-2 Sales sees all', () => {
  it('every order\'s open approvals; asked only of a customer\'s own Factory designer', async () => {
    const answer = await desk('sales')
    expect(answer.approvals.map((row) => row.approvalId).sort()).toEqual([proof, artwork].sort())
    // The designer is not P1's Factory designer yet: its follow rows are not a designer's work for Sales' desk.
    expect(answer.asked).toEqual([])
  })
})

describe('DD-3 the Factory designer slot', () => {
  it('P1\'s Factory designer: its confirmed open orders come as CONFIRMED; the mention stays HELP_ASKED; Sales now sees them asked', async () => {
    await w.planted([
      {
        sql: `INSERT INTO "PortalSettings" (id, "tenantId", "partyId", "portalOn", "factoryDesignerId", "factoryDesignerSetAt", "createdAt", "updatedAt")
              VALUES ($1, $2, $1, false, $3, now(), now(), now())
              ON CONFLICT (id) DO UPDATE SET "factoryDesignerId" = $3, "factoryDesignerSetAt" = now()`,
        values: [w.ids.p1, w.tenant, w.people.designer],
      },
    ])
    const answer = await desk('designer')
    expect(answer.asked.find((row) => row.id === w.ids.so1)?.why).toBe('HELP_ASKED')
    for (const row of answer.asked.filter((entry) => entry.why === 'CONFIRMED')) expect(row.kind).toBe('ORDER')
    expect(answer.approvals.map((row) => row.approvalId).sort()).toEqual([proof, artwork].sort())
    const sales = await desk('sales')
    expect(sales.asked.map((row) => row.id)).toEqual(expect.arrayContaining([w.ids.so1, w.ids.rq1]))
  })
})

describe('DD-4 the walls', () => {
  it('no price key; neither right 403; another customer\'s role sees none of P1\'s rows', async () => {
    for (const who of ['designer', 'sales'] as const) expect([...keysIn(await desk(who))].filter((key) => MONEY_KEY.test(key)), who).toEqual([])
    expect((await w.get('nobody', '/design-desk')).statusCode).toBe(403)
    const other = await desk('onlyP4')
    expect(JSON.stringify(other)).not.toContain('SEED-SO-000')
    expect(other.approvals).toEqual([])
  })
})
