import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPricing, type PricingSeed } from '../seed/pricing'
import { seed as seedReturns, type ReturnsSeed } from '../seed/returns'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The W2a sales walls beyond the generated isolation tests (W2a plan §5 schema wave 2/7; features FIN-075, SAL-012,
 * SAL-165, SAL-209, SAL-210, SAL-216, SAL-217, SAL-333, SAL-335, SAL-341, LOG-114, QHS-117, SAL-383, SAL-390, SAL-416,
 * QHS-113, QHS-115), on a database built from the migrations and seeded twice (tenants A and B), through the real login
 * and the scoped client, and as the owner (the …_sales_w2a_guards triggers hold for every login):
 *   - the dock (the floor role) reads its site's RMAs and lines without prices, receives the goods, grades them and
 *     moves the RMA to RECEIVED and INSPECTED, and nothing else; the floor and the portal read no terms, price lists,
 *     amendments, schedules, repairs or complaints;
 *   - payment terms total 100 percent; a price list version starts DRAFT, its prices change only while DRAFT, two ACTIVE
 *     versions never overlap, a list never falls back to itself; the customer's commercial terms are in range;
 *   - an order line is closed short (also once the order PARTLY_SHIPPED, the only change then); an amendment is
 *     append-only and only of an order that can change; a schedule step starts OPEN and a final one never changes;
 *   - an RMA moves along its states, RECEIVED only with a receipt, INSPECTED only with every received line decided; a
 *     line never takes back more than was sold (invoiced, or shipped); what comes back is fixed once goods arrived; a
 *     receipt and a repair's stage events are append-only; a repair's stage change has its event; a repaired PPE
 *     garment ships only after a passed safety check;
 *   - a complaint is triaged with its owner and answer due, a SAFETY one raises its alert and closes only once it is in
 *     the PPE register (whose entries now take a Complaint as their source);
 *   - the seeds are idempotent.
 */

const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let pricingA: PricingSeed
let returnsA: ReturnsSeed
let returnsB: ReturnsSeed
/** An invoice line of a hundred test jackets on FT-2026-00001 (planted, see beforeAll), so the tests' RMAs never run out. */
const TEST_INVOICE_LINE = randomUUID()

const key = (name: string): string => seedUuid('w2a-a', name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  P1: key('party:P1'),
  P3: key('party:P3'),
}

const office = (seeded: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: seeded.tenantId, actorId: seeded.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: a.sites[0]!.id })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: A.P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** Several statements in one transaction as the owner (the deferred checks run at its COMMIT). */
async function adminTransaction(statements: readonly (readonly [string, (readonly unknown[])?])[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    for (const [text, values] of statements) await db.admin.query(text, [...(values ?? [])])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

beforeAll(async () => {
  db = await migratedDatabase('sales_w2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'w2a-a' })
  b = await seedCore({ db: factory, namespace: 'w2a-b' })
  pricingA = await seedPricing({ db: factory, namespace: 'w2a-a' })
  returnsA = await seedReturns({ db: factory, namespace: 'w2a-a' })
  await seedPricing({ db: factory, namespace: 'w2a-b' })
  returnsB = await seedReturns({ db: factory, namespace: 'w2a-b' })
  // Planted with the triggers off (an issued invoice's lines never change): what the tests' RMAs take back, so the seed's
  // FT-2026-00001 line keeps its own count for the "more than sold" test.
  await adminTransaction([
    ["SET LOCAL session_replication_role = 'replica'"],
    [
      `INSERT INTO "InvoiceLine" (id, "tenantId", "invoiceId", "buyerPartyId", "partyId", seq, kind, description, quantity, "unitPrice", "netAmount", "vatRatePct", "updatedAt")
       VALUES ($1, $2, $3, $4, $4, 99, 'GOODS', 'Test jackets', 100, 10, 100000, 22, now())`,
      [TEST_INVOICE_LINE, a.tenantId, pricingA.money.sampleInvoiceId, A.P1],
    ],
  ])
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

/** A new AUTHORISED RMA of tenant A's company A at site A1 for P1, as the owner. */
async function newReturn(status = 'AUTHORISED'): Promise<string> {
  const id = randomUUID()
  const authorised = status === 'REQUESTED' ? [null, null] : [new Date().toISOString(), a.actorId]
  await admin(
    `INSERT INTO "ReturnAuthorisation" (id, "tenantId", "companyId", "siteId", "partyId", number, status, "requestedAt", "authorisedAt", "authorisedById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7::"ReturnStatus", now(), $8, $9, now())`,
    [id, a.tenantId, A.companyA, A.siteA, A.P1, `T-RMA-${id.slice(0, 8)}`, status, authorised[0], authorised[1]],
  )
  return id
}

/** A line of an RMA as the owner: by default one piece of the planted test invoice line. */
async function newLine(returnId: string, fields: { invoiceLineId?: string | null; salesOrderLineId?: string | null; size?: string | null; quantity?: number } = {}): Promise<string> {
  const id = randomUUID()
  await admin(
    `INSERT INTO "ReturnLine" (id, "tenantId", "siteId", "partyId", "returnId", seq, "invoiceLineId", "salesOrderLineId", size, description, quantity, "reasonCode", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(seq), 0) + 10 FROM "ReturnLine" WHERE "returnId" = $5), $6, $7, $8, 'A test garment', $9, 'WRONG_SIZE', now())`,
    [id, a.tenantId, A.siteA, A.P1, returnId, fields.invoiceLineId === undefined ? TEST_INVOICE_LINE : fields.invoiceLineId, fields.salesOrderLineId ?? null, fields.size ?? null, fields.quantity ?? 1],
  )
  return id
}

describe('the walls', () => {
  it('lets the dock read its site’s RMAs and lines, never a price', async () => {
    const rmas = await sql(floor(), 'SELECT id::text AS id, number FROM "ReturnAuthorisation" ORDER BY number')
    expect(rmas.map((row) => row.number)).toEqual(['SEED-RMA-0001', 'SEED-RMA-0002'])
    const lines = await sql(floor(), 'SELECT id::text AS id, "receivedQuantity", grade::text AS grade FROM "ReturnLine" ORDER BY seq, id')
    expect(lines).toHaveLength(2)
    for (const column of ['unitPrice', 'discountPct', 'creditAmount']) await expect(sql(floor(), `SELECT "${column}" FROM "ReturnLine"`)).rejects.toThrow(DENIED)
    // Another tenant's RMAs are not there.
    expect(rmas.map((row) => row.id)).not.toContain(returnsB.waitingReturnId)
  })

  it('gives the floor and the portal nothing of terms, lists, amendments, schedules, repairs and complaints', async () => {
    for (const table of ['PaymentTerms', 'PriceList', 'PriceListVersion', 'PriceListEntry', 'SalesOrderAmendment', 'SalesOrderMilestone', 'RepairOrder', 'RepairStageEvent', 'Complaint']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
      await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    }
    for (const table of ['ReturnAuthorisation', 'ReturnLine', 'ReturnReceipt']) await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    // The partner still reads its own Party row, with its commercial terms (its own documents show them).
    expect(await sql(partner(), 'SELECT "invoiceTiming"::text AS timing, incoterm FROM "Party"')).toEqual([{ timing: 'MONTHLY', incoterm: 'DAP' }])
  })

  it('lets the dock receive, grade and inspect, and nothing more', async () => {
    const rma = await newReturn()
    const line = await newLine(rma)
    const receipt = randomUUID()
    await as(floor(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "ReturnReceipt" (id, "siteId", "returnId", "receivedAt", "parcelCondition", "requestId") VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'DAMAGED', 'test-dock')`,
          receipt,
          A.siteA,
          rma,
        )
        await tx.$executeRawUnsafe(`UPDATE "ReturnAuthorisation" SET status = 'RECEIVED', "receivedAt" = now(), version = version + 1 WHERE id = $1::uuid`, rma)
        await tx.$executeRawUnsafe(
          `UPDATE "ReturnLine" SET "receivedQuantity" = 1, "receivedAt" = now(), "receiptId" = $2::uuid, grade = 'GOOD', cause = 'NO_FAULT', "inspectedAt" = now(), "inspectedById" = $3::uuid,
             disposition = 'CREDIT_ONLY', "goodsOutcome" = 'RESTOCK', "decidedAt" = now(), "decidedById" = $3::uuid WHERE id = $1::uuid`,
          line,
          receipt,
          a.actorId,
        )
        await tx.$executeRawUnsafe(`UPDATE "ReturnAuthorisation" SET status = 'INSPECTED', "inspectedAt" = now() WHERE id = $1::uuid`, rma)
      }),
    )
    expect(await admin('SELECT status::text AS status FROM "ReturnAuthorisation" WHERE id = $1', [rma])).toEqual([{ status: 'INSPECTED' }])
    // What comes back, the owner of the RMA and closing are the office's.
    await expect(run(floor(), `UPDATE "ReturnLine" SET quantity = 2 WHERE id = $1::uuid`, line)).rejects.toThrow(/the dock writes only what arrived/)
    await expect(run(floor(), `UPDATE "ReturnAuthorisation" SET "ownerId" = $2::uuid WHERE id = $1::uuid`, rma, a.actorId)).rejects.toThrow(/the dock only receives and inspects/)
    await expect(run(floor(), `UPDATE "ReturnAuthorisation" SET status = 'CLOSED', "closedAt" = now(), "statusReason" = 'done' WHERE id = $1::uuid`, rma)).rejects.toThrow(
      /the dock only receives and inspects/,
    )
    // The office closes it.
    expect(await run(office(), `UPDATE "ReturnAuthorisation" SET status = 'CLOSED', "closedAt" = now(), "statusReason" = 'COMPLETED' WHERE id = $1::uuid`, rma)).toBe(1)
  })
})

describe('payment terms, price lists and the customer’s terms', () => {
  const terms = (instalments: unknown, extra = '') =>
    admin(`INSERT INTO "PaymentTerms" (id, "tenantId", code, name, method, instalments, "updatedAt"${extra ? ', "earlyPaymentDiscountPct"' : ''}) VALUES ($1, $2, $3, 'Test', 'MP05', $4::jsonb, now()${extra ? `, ${extra}` : ''})`, [
      randomUUID(),
      a.tenantId,
      `T-${randomUUID().slice(0, 8)}`,
      JSON.stringify(instalments),
    ])

  it('keeps payment terms whole', async () => {
    await expect(terms([{ sharePct: '30', from: 'ORDER', days: 0 }])).rejects.toThrow(/total 30 percent, not 100/)
    await expect(terms([{ sharePct: '100', from: 'NEXT_TUESDAY', days: 0 }])).rejects.toThrow(/each instalment/)
    await expect(terms([{ sharePct: '100', from: 'INVOICE', days: 400 }])).rejects.toThrow(/0 to 366 days/)
    await expect(terms([])).rejects.toThrow(/at least one instalment/)
    await expect(terms([{ sharePct: '100', from: 'INVOICE', days: 30, endOfMonth: true }], "'2.0000'")).rejects.toThrow(/early-payment discount/)
    await expect(terms([{ sharePct: '50', from: 'INVOICE', days: 30, endOfMonth: true }, { sharePct: '50.0000', from: 'INVOICE', days: 60, endOfMonth: true }])).resolves.toBeDefined()
    await expect(admin(`UPDATE "PaymentTerms" SET method = 'BONIFICO' WHERE id = $1`, [pricingA.paymentTermsIds.BB60])).rejects.toThrow(/ModalitaPagamento/)
    await expect(admin('DELETE FROM "PaymentTerms" WHERE id = $1', [pricingA.paymentTermsIds.BB60])).rejects.toThrow(/archived, never deleted/)
  })

  it('fixes a price list version’s prices once ACTIVE, and never lets two overlap', async () => {
    const entryOf = (versionId: string) => admin('SELECT id::text AS id FROM "PriceListEntry" WHERE "versionId" = $1 LIMIT 1', [versionId]).then((rows) => rows[0]!.id as string)
    // ACTIVE: its prices and start are fixed; only its end moves.
    await expect(admin(`UPDATE "PriceListEntry" SET "unitPrice" = 1 WHERE id = $1`, [await entryOf(pricingA.activeVersionId)])).rejects.toThrow(/its prices are fixed/)
    await expect(admin(`UPDATE "PriceListVersion" SET "validFrom" = '2026-09-01' WHERE id = $1`, [pricingA.activeVersionId])).rejects.toThrow(/only its end changes/)
    await expect(admin(`UPDATE "PriceListVersion" SET status = 'DRAFT', "activatedAt" = NULL, "activatedById" = NULL WHERE id = $1`, [pricingA.activeVersionId])).rejects.toThrow(
      /only its end changes/,
    )
    await expect(admin('DELETE FROM "PriceListVersion" WHERE id = $1', [pricingA.activeVersionId])).rejects.toThrow(/kept, never deleted/)
    // A version starts as a DRAFT.
    await expect(
      admin(`INSERT INTO "PriceListVersion" (id, "tenantId", "listId", revision, status, "validFrom", "activatedAt", "activatedById", "updatedAt") VALUES ($1, $2, $3, 9, 'ACTIVE', '2027-01-01', now(), $4, now())`, [
        randomUUID(),
        a.tenantId,
        pricingA.customerListId,
        a.actorId,
      ]),
    ).rejects.toThrow(/starts as DRAFT/)
    // The DRAFT's prices change; activating it from 2027-01-01 overlaps version 1 (open-ended) until that one ends.
    expect((await admin(`UPDATE "PriceListEntry" SET "unitPrice" = 436 WHERE "versionId" = $1 RETURNING id`, [pricingA.draftVersionId])).length).toBe(1)
    const activate = (from: string) =>
      `UPDATE "PriceListVersion" SET status = 'ACTIVE', "validFrom" = '${from}', "activatedAt" = now(), "activatedById" = '${a.actorId}', version = version + 1 WHERE id = '${pricingA.draftVersionId}'`
    await expect(admin(activate('2027-01-01'))).rejects.toThrow(/overlaps another ACTIVE version/)
    await expect(admin(`UPDATE "PriceListVersion" SET "validTo" = '2026-09-30' WHERE id = $1`, [pricingA.activeVersionId])).rejects.toThrow(/ends \(2026-09-30\) before it starts/)
    await adminTransaction([[`UPDATE "PriceListVersion" SET "validTo" = '2026-12-31' WHERE id = $1`, [pricingA.activeVersionId]], [activate('2027-01-01')]])
    expect(await admin('SELECT status::text AS status FROM "PriceListVersion" WHERE id = $1', [pricingA.draftVersionId])).toEqual([{ status: 'ACTIVE' }])
    // Now version 1 cannot reach into version 2's year again.
    await expect(admin(`UPDATE "PriceListVersion" SET "validTo" = NULL WHERE id = $1`, [pricingA.activeVersionId])).rejects.toThrow(/overlaps another ACTIVE version/)
  })

  it('never lets a list fall back to itself, or to another currency', async () => {
    await expect(admin(`UPDATE "PriceList" SET "baseListId" = id WHERE id = $1`, [pricingA.baseListId])).rejects.toThrow(/never falls back to itself/)
    await expect(admin(`UPDATE "PriceList" SET "baseListId" = $2 WHERE id = $1`, [pricingA.baseListId, pricingA.customerListId])).rejects.toThrow(/through the lists it falls back to/)
    await expect(
      admin(`INSERT INTO "PriceList" (id, "tenantId", code, name, kind, currency, "baseListId", "updatedAt") VALUES ($1, $2, 'T-CHF', 'CHF', 'CUSTOMER', 'CHF', $3, now())`, [randomUUID(), a.tenantId, pricingA.baseListId]),
    ).rejects.toThrow(/another currency/)
    await expect(admin('DELETE FROM "PriceList" WHERE id = $1', [pricingA.baseListId])).rejects.toThrow(/archived, never deleted/)
  })

  it('keeps the customer’s commercial terms in range', async () => {
    await expect(admin(`UPDATE "Party" SET "defaultDepositPct" = 0 WHERE id = $1`, [A.P1])).rejects.toThrow(/default deposit/)
    await expect(admin(`UPDATE "Party" SET incoterm = 'dap' WHERE id = $1`, [A.P1])).rejects.toThrow(/Incoterms/)
    await expect(admin(`UPDATE "Party" SET "minimumOrderAmount" = -1 WHERE id = $1`, [A.P1])).rejects.toThrow(/minimum order/)
    await admin(`UPDATE "PaymentTerms" SET status = 'ARCHIVED' WHERE id = $1`, [pricingA.paymentTermsIds.CONSEGNA])
    await expect(admin(`UPDATE "Party" SET "paymentTermsId" = $2 WHERE id = $1`, [A.P3, pricingA.paymentTermsIds.CONSEGNA])).rejects.toThrow(/payment terms that are ARCHIVED/)
    await admin(`UPDATE "PaymentTerms" SET status = 'ACTIVE' WHERE id = $1`, [pricingA.paymentTermsIds.CONSEGNA])
    expect(await run(office(), `UPDATE "Party" SET "paymentTermsId" = $2::uuid, "invoiceTiming" = 'MONTHLY' WHERE id = $1::uuid`, A.P3, pricingA.paymentTermsIds.CONSEGNA)).toBe(1)
  })

  it('keeps the return policy in range', async () => {
    await expect(admin(`UPDATE "SalesSettings" SET "returnWindowDays" = 0 WHERE id = $1`, [a.tenantId])).rejects.toThrow(/return window/)
    await expect(admin(`UPDATE "SalesSettings" SET "returnRestockingFeePct" = 101 WHERE id = $1`, [a.tenantId])).rejects.toThrow(/restocking fee/)
    expect(await admin('SELECT "returnWindowDays", "returnFreightPaidBy"::text AS freight FROM "SalesSettings" WHERE id = $1', [a.tenantId])).toEqual([{ returnWindowDays: 30, freight: 'BY_CAUSE' }])
  })
})

describe('order amendments, the schedule and closing short', () => {
  it('keeps an amendment as it was applied, of an order that can still change', async () => {
    await expect(admin(`UPDATE "SalesOrderAmendment" SET reason = 'x' WHERE id = $1`, [pricingA.amendmentId])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "SalesOrderAmendment" WHERE id = $1', [pricingA.amendmentId])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "SalesOrderAmendment"')).rejects.toThrow(/append-only/)
    const insert = (orderId: string) =>
      admin(
        `INSERT INTO "SalesOrderAmendment" (id, "tenantId", "companyId", "orderId", "partyId", revision, reason, before, after, "netAmountBefore", "netAmountAfter", "grossAmountBefore", "grossAmountAfter", "requestId")
         VALUES ($1, $2, $3, $4, $5, $6, 'A test', '{}', '{}', 0, 0, 0, 0, 'test')`,
        [randomUUID(), a.tenantId, A.companyA, orderId, A.P1, 100 + Math.floor(Math.random() * 1000)],
      )
    const order = pricingA.money.sales.orderId
    await insert(order)
    await admin(`UPDATE "SalesOrder" SET status = 'PARTLY_SHIPPED' WHERE id = $1`, [order])
    try {
      await expect(insert(order)).rejects.toThrow(/amended only while CONFIRMED, IN_PRODUCTION or READY/)
    } finally {
      await admin(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = $1`, [order])
    }
  })

  it('closes a line short, also once the order PARTLY_SHIPPED, and changes nothing else then', async () => {
    const order = pricingA.money.sales.orderId
    const [line] = await admin('SELECT id::text AS id, quantity FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [order])
    const close = (quantity: number, reason: string | null = 'The customer does not want the rest.') =>
      admin(`UPDATE "SalesOrderLine" SET "closedShortQuantity" = $2, "closedShortAt" = now(), "closedShortById" = $3, "closeShortReason" = $4 WHERE id = $1`, [line!.id, quantity, a.actorId, reason])
    await expect(close(1, null)).rejects.toThrow(/closed short with its pieces, time, who and why/)
    await expect(close(Number(line!.quantity) + 1)).rejects.toThrow(/closes short 1 to/)
    await admin(`UPDATE "SalesOrder" SET status = 'PARTLY_SHIPPED' WHERE id = $1`, [order])
    try {
      await close(2)
      await expect(admin(`UPDATE "SalesOrderLine" SET note = 'changed' WHERE id = $1`, [line!.id])).rejects.toThrow(/once PARTLY_SHIPPED, a line is only closed short or reopened/)
      // Reopened.
      await admin(`UPDATE "SalesOrderLine" SET "closedShortQuantity" = NULL, "closedShortAt" = NULL, "closedShortById" = NULL, "closeShortReason" = NULL WHERE id = $1`, [line!.id])
      await admin(`UPDATE "SalesOrder" SET status = 'SHIPPED' WHERE id = $1`, [order])
      await expect(close(2)).rejects.toThrow(/its lines change only while/)
    } finally {
      await admin(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = $1`, [order])
    }
  })

  it('starts a schedule step OPEN and never changes a paid one', async () => {
    const [deposit, balance] = pricingA.milestoneIds
    expect(await admin('SELECT status::text AS status FROM "SalesOrderMilestone" WHERE id = $1', [deposit])).toEqual([{ status: 'PAID' }])
    await expect(admin(`UPDATE "SalesOrderMilestone" SET amount = 1 WHERE id = $1`, [deposit])).rejects.toThrow(/is PAID; it never changes/)
    await expect(admin(`UPDATE "SalesOrderMilestone" SET status = 'PAID' WHERE id = $1`, [balance])).rejects.toThrow(/wrong payment time or note/)
    // B-W2a-F2: a BEFORE_SHIPPING step may name a deposit request (its own: an advance, TD02 when paid before the goods
    // leave); an ON_INVOICE (or ON_DELIVERY) step may not — it falls due with the goods' invoice.
    await admin(`UPDATE "SalesOrderMilestone" SET "depositRequestId" = $2 WHERE id = $1`, [balance, pricingA.money.sales.depositRequestId])
    await admin(`UPDATE "SalesOrderMilestone" SET "depositRequestId" = NULL WHERE id = $1`, [balance])
    await expect(
      admin(`INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, "depositRequestId", "updatedAt") VALUES ($1, $2, $3, $4, $5, 91, 'ON_INVOICE', 100, $6, now())`, [
        randomUUID(),
        a.tenantId,
        A.companyA,
        pricingA.money.sales.orderId,
        A.P1,
        pricingA.money.sales.depositRequestId,
      ]),
    ).rejects.toThrow(/not the DEPOSIT step or a BEFORE_SHIPPING step/)
    await expect(admin(`UPDATE "SalesOrderMilestone" SET status = 'WAIVED' WHERE id = $1`, [balance])).rejects.toThrow(/wrong payment time or note/)
    await expect(
      admin(`INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, status, "paidAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 90, 'ON_INVOICE', 100, 'PAID', now(), now())`, [
        randomUUID(),
        a.tenantId,
        A.companyA,
        pricingA.money.sales.orderId,
        A.P1,
      ]),
    ).rejects.toThrow(/starts OPEN/)
    await expect(admin('DELETE FROM "SalesOrderMilestone" WHERE id = $1', [balance])).rejects.toThrow(/cancelled, never deleted/)
  })
})

describe('returns', () => {
  it('moves an RMA along its states: RECEIVED with a receipt, INSPECTED with every received line decided', async () => {
    await expect(newReturn('RECEIVED')).rejects.toThrow(/starts REQUESTED or AUTHORISED/)
    const requested = await newReturn('REQUESTED')
    await expect(admin(`UPDATE "ReturnAuthorisation" SET status = 'RECEIVED', "receivedAt" = now(), "authorisedAt" = now(), "authorisedById" = $2 WHERE id = $1`, [requested, a.actorId])).rejects.toThrow(
      /cannot move from REQUESTED to RECEIVED/,
    )
    await admin(`UPDATE "ReturnAuthorisation" SET status = 'REJECTED', "closedAt" = now(), "statusReason" = 'Outside the return window' WHERE id = $1`, [requested])
    await expect(admin(`UPDATE "ReturnAuthorisation" SET "ownerId" = $2 WHERE id = $1`, [requested, a.actorId])).rejects.toThrow(/is REJECTED; it never changes/)
    await expect(admin('DELETE FROM "ReturnAuthorisation" WHERE id = $1', [requested])).rejects.toThrow(/never deleted/)

    const rma = await newReturn()
    const line = await newLine(rma)
    await expect(admin(`UPDATE "ReturnAuthorisation" SET status = 'RECEIVED', "receivedAt" = now() WHERE id = $1`, [rma])).rejects.toThrow(/RECEIVED without a dock receipt/)
    const receipt = randomUUID()
    await adminTransaction([
      [`INSERT INTO "ReturnReceipt" (id, "tenantId", "siteId", "returnId", "receivedAt", "parcelCondition", "requestId") VALUES ($1, $2, $3, $4, now(), 'INTACT', 'test')`, [receipt, a.tenantId, A.siteA, rma]],
      [`UPDATE "ReturnAuthorisation" SET status = 'RECEIVED', "receivedAt" = now() WHERE id = $1`, [rma]],
      [`UPDATE "ReturnLine" SET "receivedQuantity" = 1, "receivedAt" = now(), "receiptId" = $2 WHERE id = $1`, [line, receipt]],
    ])
    await expect(admin(`UPDATE "ReturnAuthorisation" SET "receivedAt" = now() + interval '1 hour' WHERE id = $1`, [rma])).rejects.toThrow(/set once/)
    await expect(admin(`UPDATE "ReturnAuthorisation" SET status = 'INSPECTED', "inspectedAt" = now() WHERE id = $1`, [rma])).rejects.toThrow(/a received line has no disposition/)
    // A disposition comes after the grade; the grade only of received pieces.
    await expect(admin(`UPDATE "ReturnLine" SET disposition = 'SCRAP', "decidedAt" = now(), "decidedById" = $2 WHERE id = $1`, [line, a.actorId])).rejects.toThrow(/after its inspection/)
    await adminTransaction([
      [`UPDATE "ReturnLine" SET grade = 'UNUSABLE', "inspectedAt" = now(), "inspectedById" = $2, disposition = 'SCRAP', "goodsOutcome" = 'SCRAP', "decidedAt" = now(), "decidedById" = $2 WHERE id = $1`, [line, a.actorId]],
      [`UPDATE "ReturnAuthorisation" SET status = 'INSPECTED', "inspectedAt" = now() WHERE id = $1`, [rma]],
    ])
    // The goods arrived: what comes back is fixed, no line is added or removed.
    await expect(admin(`UPDATE "ReturnLine" SET "reasonCode" = 'OTHER' WHERE id = $1`, [line])).rejects.toThrow(/what comes back is fixed/)
    await expect(newLine(rma)).rejects.toThrow(/what comes back is fixed/)
    await expect(admin('DELETE FROM "ReturnLine" WHERE id = $1', [line])).rejects.toThrow(/what comes back is fixed/)
    // The receipt is kept as it was written; no receipt on a closed RMA.
    await expect(admin(`UPDATE "ReturnReceipt" SET note = 'x' WHERE id = $1`, [receipt])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "ReturnReceipt" WHERE id = $1', [receipt])).rejects.toThrow(/append-only/)
    await admin(`UPDATE "ReturnAuthorisation" SET status = 'CLOSED', "closedAt" = now(), "statusReason" = 'COMPLETED' WHERE id = $1`, [rma])
    await expect(
      admin(`INSERT INTO "ReturnReceipt" (id, "tenantId", "siteId", "returnId", "receivedAt", "parcelCondition", "requestId") VALUES ($1, $2, $3, $4, now(), 'INTACT', 'test')`, [randomUUID(), a.tenantId, A.siteA, rma]),
    ).rejects.toThrow(/goods are received only while/)
    await expect(admin(`UPDATE "ReturnLine" SET "conditionNote" = 'x' WHERE id = $1`, [line])).rejects.toThrow(/its lines never change/)
  })

  it('never takes back more than was sold: invoiced, or shipped', async () => {
    // FT-2026-00001 billed two sample jackets; SEED-RMA-0001 takes one back.
    const sample = key('money:line:FT-2026-00001:1')
    const rma = await newReturn()
    await expect(newLine(rma, { invoiceLineId: sample, quantity: 2 })).rejects.toThrow(/which billed 2\.0000, 1 of them already on other returns/)
    await newLine(rma, { invoiceLineId: sample })
    await expect(newLine(await newReturn(), { invoiceLineId: sample })).rejects.toThrow(/already on other returns/)
    // A cancelled RMA gives its pieces back, and so does one closed without the goods (a CLOSED RMA keeps what it received).
    await admin(`UPDATE "ReturnAuthorisation" SET status = 'CANCELLED', "closedAt" = now(), "statusReason" = 'The customer kept it' WHERE id = $1`, [rma])
    const closed = await newReturn()
    await newLine(closed, { invoiceLineId: sample })
    await admin(`UPDATE "ReturnAuthorisation" SET status = 'CLOSED', "closedAt" = now(), "statusReason" = 'NO_GOODS' WHERE id = $1`, [closed])
    const last = await newReturn()
    await newLine(last, { invoiceLineId: sample })
    await admin(`UPDATE "ReturnAuthorisation" SET status = 'CANCELLED', "closedAt" = now(), "statusReason" = 'Test done' WHERE id = $1`, [last])
    // SEED-SO-0002's BLK 50 shipped one with SH-0001, and SEED-RMA-0002 took it back.
    const blk = key('production:sales-order:SO-0002:10')
    await expect(newLine(await newReturn(), { invoiceLineId: null, salesOrderLineId: blk, size: '50' })).rejects.toThrow(/of which 1 shipped, 1 of them already on other returns/)
    await expect(newLine(await newReturn(), { invoiceLineId: null, salesOrderLineId: blk })).rejects.toThrow(/size-grid order line without its size/)
    // An invoice line that bills something else than the order line named.
    await expect(newLine(await newReturn(), { salesOrderLineId: blk, size: '52' })).rejects.toThrow(/does not bill that order line and size/)
    await expect(newLine(await newReturn(), { invoiceLineId: null })).rejects.toThrow(/names what was sold/)
  })
})

describe('repairs', () => {
  it('moves a repair with its stage events, and ships a repaired PPE garment only after a passed check', async () => {
    const repair = returnsA.repairId
    const move = (stage: string, extra = '') => `UPDATE "RepairOrder" SET stage = '${stage}', version = version + 1${extra} WHERE id = '${repair}'`
    const event = (from: string, to: string) => [
      `INSERT INTO "RepairStageEvent" (id, "tenantId", "siteId", "repairId", "fromStage", stage, "repairVersion", at, "requestId") SELECT $1, "tenantId", "siteId", id, $2::"RepairStage", $3::"RepairStage", version, now(), 'test' FROM "RepairOrder" WHERE id = $4`,
      [randomUUID(), from, to, repair],
    ] as const
    await expect(admin(move('IN_REPAIR'))).rejects.toThrow(/without its stage event/)
    await expect(admin(move('REPAIRED', ', "repairedAt" = now()'))).rejects.toThrow(/cannot move from RECEIVED to REPAIRED/)
    await expect(
      admin(`INSERT INTO "RepairStageEvent" (id, "tenantId", "siteId", "repairId", "fromStage", stage, "repairVersion", at, "requestId") VALUES ($1, $2, $3, $4, 'RECEIVED', 'IN_REPAIR', 1, now(), 'test')`, [
        randomUUID(),
        a.tenantId,
        A.siteA,
        repair,
      ]),
    ).rejects.toThrow(/move the repair first/)
    await adminTransaction([[move('IN_REPAIR')], event('RECEIVED', 'IN_REPAIR')])
    await adminTransaction([[move('REPAIRED', ', "repairedAt" = now()')], event('IN_REPAIR', 'REPAIRED')])
    await expect(adminTransaction([[move('SHIPPED', ', "shippedAt" = now()')], event('REPAIRED', 'SHIPPED')])).rejects.toThrow(/passed safety check made after the repair/)
    await expect(admin(`UPDATE "RepairOrder" SET "safetyCheckResult" = 'PASS' WHERE id = $1`, [repair])).rejects.toThrow(/points \(an object\), result, time and who/)
    await admin(`UPDATE "RepairOrder" SET "safetyCheckResult" = 'PASS', "safetyCheckedAt" = now(), "safetyCheckedById" = $2, "safetyChecklist" = '{"seams":"PASS","protectors":"PASS","certificateCovers":true}' WHERE id = $1`, [
      repair,
      a.actorId,
    ])
    await adminTransaction([[move('SHIPPED', ', "shippedAt" = now()')], event('REPAIRED', 'SHIPPED')])
    await expect(admin(`UPDATE "RepairOrder" SET "ownerId" = NULL WHERE id = $1`, [repair])).rejects.toThrow(/is SHIPPED; it never changes/)
    expect((await admin('SELECT stage::text AS stage FROM "RepairStageEvent" WHERE "repairId" = $1 ORDER BY "repairVersion"', [repair])).map((row) => row.stage)).toEqual([
      'RECEIVED',
      'IN_REPAIR',
      'REPAIRED',
      'SHIPPED',
    ])
    await expect(admin(`UPDATE "RepairStageEvent" SET note = 'x' WHERE "repairId" = $1`, [repair])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "RepairOrder" WHERE id = $1', [repair])).rejects.toThrow(/never deleted/)
  })
})

describe('complaints', () => {
  it('triages, raises the safety alert, and closes a safety complaint only once it is in the PPE register', async () => {
    const complaint = returnsA.complaintId
    await expect(admin(`UPDATE "Complaint" SET "ownerId" = NULL WHERE id = $1`, [complaint])).rejects.toThrow(/without its triage/)
    await expect(admin(`UPDATE "Complaint" SET "safetyRaisedAt" = now() WHERE id = $1`, [complaint])).rejects.toThrow(/set once/)
    await expect(admin(`UPDATE "Complaint" SET "safetyAcknowledgedAt" = now() WHERE id = $1`, [complaint])).rejects.toThrow(/acknowledged \(when and by whom\)/)
    await admin(`UPDATE "Complaint" SET "safetyAcknowledgedAt" = now(), "safetyAcknowledgedById" = $2 WHERE id = $1`, [complaint, a.actorId])
    await expect(admin(`UPDATE "Complaint" SET "shipmentId" = $2 WHERE id = $1`, [complaint, randomUUID()])).rejects.toThrow(/a shipment that does not exist/)
    const close = () => admin(`UPDATE "Complaint" SET status = 'CLOSED', "closedAt" = now(), "closeReason" = 'Repaired under warranty' WHERE id = $1`, [complaint])
    await expect(close()).rejects.toThrow(/closes once it is in the PPE register/)
    // The register takes the complaint as its source (W1's openRegisterEntryFor writes this row).
    const styleId = pricingA.money.shipping.quality.production.styleId
    const entry = (sourceType: string) =>
      admin(
        `INSERT INTO "PpeRegisterEntry" (id, "tenantId", "companyId", reference, kind, "styleId", "batchNumbers", "partyId", "sourceType", "sourceId", "reportedAt", description, "updatedAt")
         VALUES ($1, $2, $3, $4, 'COMPLAINT', $5, ARRAY['SEED-BT-0001'], $6, $7, $8, now(), 'Shoulder seam opened', now())`,
        [randomUUID(), a.tenantId, A.companyA, `T-REG-${randomUUID().slice(0, 6)}`, styleId, A.P1, sourceType, complaint],
      )
    await expect(entry('Rumour')).rejects.toThrow(/known record type/)
    await entry('Complaint')
    await close()
    await expect(admin(`UPDATE "Complaint" SET "internalNote" = 'x' WHERE id = $1`, [complaint])).rejects.toThrow(/is CLOSED; it never changes/)
    await expect(admin('DELETE FROM "Complaint" WHERE id = $1', [complaint])).rejects.toThrow(/never deleted/)
  })

  it('refuses a complaint that starts past triage, or a safety one without its alert', async () => {
    const insert = (status: string, category: string | null, raised: string | null) =>
      admin(
        `INSERT INTO "Complaint" (id, "tenantId", "companyId", "partyId", number, channel, "receivedAt", description, status, category, severity, "ownerId", "answerDueOn", "triagedAt", "triagedById", "safetyRaisedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'PHONE', now(), 'It leaks', $6::"ComplaintStatus", $7::"ComplaintCategory", 'MINOR', $8, current_date + 7, now(), $8, $9::timestamptz, now())`,
        [randomUUID(), a.tenantId, A.companyA, A.P1, `T-CMP-${randomUUID().slice(0, 8)}`, status, category, a.actorId, raised],
      )
    await expect(insert('ANSWERED', 'FUNCTION', null)).rejects.toThrow(/starts NEW or TRIAGED/)
    await expect(insert('TRIAGED', 'SAFETY', null)).rejects.toThrow(/raises its alert/)
    await expect(insert('TRIAGED', 'FUNCTION', null)).resolves.toBeDefined()
  })
})

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['PaymentTerms', 'PriceList', 'PriceListVersion', 'PriceListEntry', 'SalesOrderAmendment', 'SalesOrderMilestone', 'ReturnAuthorisation', 'ReturnLine', 'ReturnReceipt', 'RepairOrder', 'RepairStageEvent', 'Complaint']
    const snapshot = async () => {
      const rows = []
      for (const table of tables) rows.push((await admin(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId]))[0])
      return rows
    }
    const before = await snapshot()
    const again = await seedReturns({ db: factory, namespace: 'w2a-b' })
    await seedPricing({ db: factory, namespace: 'w2a-b' })
    expect(again.complaintId).toBe(returnsB.complaintId)
    expect(await snapshot()).toEqual(before)
    // The rows the generated isolation tests copy sort first: an AUTHORISED RMA and its line, a DRAFT version and entry,
    // an OPEN schedule step.
    const first = async (table: string, column: string) => (await admin(`SELECT "${column}"::text AS v FROM "${table}" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [b.tenantId]))[0]!.v
    expect(await first('ReturnAuthorisation', 'status')).toBe('AUTHORISED')
    expect(await first('PriceListVersion', 'status')).toBe('DRAFT')
    expect(await first('SalesOrderMilestone', 'status')).toBe('OPEN')
  })
})
