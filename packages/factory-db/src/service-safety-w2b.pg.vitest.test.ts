import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedService, type ServiceSeed } from '../seed/service'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Returns, repairs, service and product safety (W2b-5, schema wave 43/44, B-W2b-291, …_service_safety_w2b_guards) on a
 * database built from the migrations and seeded twice, through the real login and the scoped client:
 *   - return policies: at least 14 days for consumers at a distance, the withdrawal words only for them, one live policy per
 *     company and channel, one an RMA names keeps its terms; fee rules: a percent or an amount, the reason codes' shape;
 *   - the RMA: its scan code set once, its finish reason only when CLOSED, its policy and withdrawal only before the goods;
 *   - the return line: split after a partial receipt (the split lines cover the cut at commit), credit without the goods, the
 *     size exchange, the fee dropped when the cause is ours, the garment and lot of ours (never a sample made for no order),
 *     the dock's scan of the lot;
 *   - repair estimates: DRAFT → SENT → ACCEPTED | DECLINED, what was sent frozen, lines only while DRAFT, the customer's
 *     answer; the partner reads its own estimates without our cost;
 *   - service cases: numbered, their states, the cover decided with its guarantee and words, links only while open;
 *   - safety reports: seen once, a SAFETY case, the register entry of the style, closed frozen but the reporter's data erased;
 *     the injury apart: words only with the consent, erased once, never a search entry, no partner or floor read;
 *   - the accident log append-only by revision; the register takes a safety report as its source.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-291-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: ServiceSeed

const key = (name: string): string => seedUuid(NS, name)
const SITE_A1 = key('site:A1')
const P1 = key('party:P1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: SITE_A1 })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** Statements of one transaction in the office scope. */
const together = (...steps: [string, ...unknown[]][]) =>
  as(office(), (client) => client.$transaction(async (tx) => { for (const [text, ...values] of steps) await tx.$executeRawUnsafe(text, ...values) }))
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  db = await migratedDatabase('servicesafetyw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedService({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedService({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('return policies and fee rules (SAL-338, SAL-343)', () => {
  const newPolicy = (changes: Record<string, unknown>) => copyRow(office(), 'ReturnPolicy', s.policyIds.retired, { id: randomUUID(), ...changes })

  it('give a consumer at a distance at least 14 days, and withdrawal words only to them', async () => {
    await expect(newPolicy({ channel: 'CONSUMER_DISTANCE', windowDays: 10 })).rejects.toThrow(/at least 14/)
    await expect(newPolicy({ withdrawalWords: 'Diritto di recesso' })).rejects.toThrow(/only for consumers at a distance/)
    await expect(newPolicy({ windowDays: 0 })).rejects.toThrow(/1 to 365 days to ask/)
    await expect(newPolicy({ name: 'two\nlines' })).rejects.toThrow(/a name of one line/)
    expect(await newPolicy({ channel: 'CONSUMER_DISTANCE', windowDays: 14, withdrawalWords: 'Diritto di recesso (made up)' })).toBe(1)
  })

  it('keep one live policy per company and channel, retired once', async () => {
    await expect(newPolicy({ retiredAt: null, retiredById: null })).rejects.toThrow(/ReturnPolicy_one_live|duplicate key/)
    await expect(update(office(), 'ReturnPolicy', s.policyIds.retired, `"retiredAt" = now()`)).rejects.toThrow(/stays retired/)
    await expect(update(office(), 'ReturnPolicy', s.policyIds.retired, `channel = 'CONSUMER_DISTANCE'`)).rejects.toThrow(/never change/)
  })

  it('keep the terms of a policy an RMA names (SEED-RMA-0001 names the live business policy)', async () => {
    await expect(update(office(), 'ReturnPolicy', s.policyIds.b2b, `"windowDays" = 45`)).rejects.toThrow(/named by an RMA/)
    expect(await update(office(), 'ReturnPolicy', s.policyIds.b2b, `name = 'Brands, dealers and teams', version = version + 1`)).toBe(1)
    expect(await update(office(), 'ReturnPolicy', s.policyIds.consumer, `"windowDays" = 30, version = version + 1`)).toBe(1)
  })

  it('count fees as a percent or an amount with its currency, for reason codes of the right shape', async () => {
    const newRule = (changes: Record<string, unknown>) => copyRow(office(), 'ReturnFeeRule', s.feeRuleIds.changeOfMind, { id: randomUUID(), ...changes })
    await expect(newRule({ percent: '0' })).rejects.toThrow(/a percent above 0/)
    await expect(newRule({ percent: '101' })).rejects.toThrow(/a percent above 0/)
    await expect(newRule({ amount: 500, currency: 'EUR' })).rejects.toThrow(/a percent above 0/)
    await expect(newRule({ kind: 'AMOUNT', percent: null, amount: 500, currency: 'eur' })).rejects.toThrow(/a percent above 0/)
    await expect(newRule({ reasonCodes: ['wrong size'] })).rejects.toThrow(/reason codes' shape/)
    await expect(newRule({ reasonCodes: ['OTHER', 'OTHER'] })).rejects.toThrow(/each once/)
    expect(await newRule({ kind: 'AMOUNT', percent: null, amount: 500, currency: 'EUR', reasonCodes: ['DEFECT', 'OTHER'] })).toBe(1)
    await expect(admin(`DELETE FROM "ReturnFeeRule" WHERE id = $1::uuid`, [s.feeRuleIds.off])).rejects.toThrow(/never deleted/)
  })
})

describe('the RMA (SAL-337, SAL-338, SAL-346, SAL-360)', () => {
  it('prints a scan code set once, in its shape', async () => {
    const rma = s.returns.waitingReturnId
    await expect(update(office(), 'ReturnAuthorisation', rma, `"scanCode" = 'rma-1'`)).rejects.toThrow(/6 to 40 capital letters/)
    expect(await update(office(), 'ReturnAuthorisation', rma, `"scanCode" = 'RMA-TEST-0001'`)).toBe(1)
    await expect(update(office(), 'ReturnAuthorisation', rma, `"scanCode" = 'RMA-TEST-0002'`)).rejects.toThrow(/set once/)
    // The dock reads it (the floor's "Scan the return").
    expect((await sql(floor(), `SELECT number FROM "ReturnAuthorisation" WHERE "scanCode" = 'RMA-TEST-0001'`))[0]?.number).toBe('SEED-RMA-0001')
  })

  it('names a live policy, a withdrawal only under a consumer policy, and keeps both once the goods arrived', async () => {
    const rma = s.returns.waitingReturnId
    await expect(update(office(), 'ReturnAuthorisation', rma, `"policyId" = $2::uuid`, s.policyIds.retired)).rejects.toThrow(/was retired/)
    await expect(update(office(), 'ReturnAuthorisation', rma, `withdrawal = true`)).rejects.toThrow(/consumers at a distance/)
    expect(await update(office(), 'ReturnAuthorisation', rma, `"policyId" = $2::uuid, withdrawal = true`, s.policyIds.consumer)).toBe(1)
    expect(await update(office(), 'ReturnAuthorisation', rma, `"policyId" = $2::uuid, withdrawal = false`, s.policyIds.b2b)).toBe(1)
    await expect(update(office(), 'ReturnAuthorisation', s.returns.inspectedReturnId, `"policyId" = $2::uuid`, s.policyIds.b2b)).rejects.toThrow(/only before the goods arrive/)
  })

  it('has a finish reason only when CLOSED', async () => {
    await expect(update(office(), 'ReturnAuthorisation', s.returns.inspectedReturnId, `"finishReason" = 'COMPLETED'`)).rejects.toThrow(/only once it is CLOSED/)
  })
})

describe('the return line (SAL-336, SAL-342, SAL-343, SAL-350, SAL-351)', () => {
  const RED_LINE = key('production:sales-order:SO-0002:20')
  let creditRma: string
  let creditLine: string
  let restLine: string

  it('splits a line of which only part arrived: the rest on a line split from it, in the same transaction', async () => {
    const rma = s.returns.waitingReturnId
    const line = s.returns.waitingLineId
    const receipt = randomUUID()
    // Two of the invoice line's two sample jackets come back; one arrives.
    expect(await update(office(), 'ReturnLine', line, `quantity = 2, version = version + 1`)).toBe(1)
    await together(
      [`INSERT INTO "ReturnReceipt" (id, "siteId", "returnId", "receivedAt", parcels, "parcelCondition", "requestId") VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 1, 'INTACT', 'test-291')`, receipt, SITE_A1, rma],
      [`UPDATE "ReturnLine" SET "receivedQuantity" = 1, "receivedAt" = now(), "receiptId" = $2::uuid, version = version + 1 WHERE id = $1::uuid`, line, receipt],
      [`UPDATE "ReturnAuthorisation" SET status = 'RECEIVED', "receivedAt" = now(), version = version + 1 WHERE id = $1::uuid`, rma],
    )
    await expect(update(office(), 'ReturnLine', line, `"reasonCode" = 'DEFECT'`)).rejects.toThrow(/what comes back is fixed/)
    await expect(update(office(), 'ReturnLine', line, `quantity = 1`)).rejects.toThrow(/take back only 0/)
    const rest = randomUUID()
    const child = (changes: Record<string, unknown>) =>
      [copyText('ReturnLine'), JSON.stringify({ id: rest, seq: 20, quantity: 1, receivedQuantity: 0, receivedAt: null, receiptId: null, parentLineId: line, ...changes }), line] as [string, ...unknown[]]
    await expect(together([`UPDATE "ReturnLine" SET quantity = 1 WHERE id = $1::uuid`, line], child({ unitPrice: '1.000000' }))).rejects.toThrow(/split from line/)
    await expect(together([`UPDATE "ReturnLine" SET quantity = 1 WHERE id = $1::uuid`, line], child({ receivedQuantity: 1, receivedAt: ago(0), receiptId: receipt }))).rejects.toThrow(/split from line/)
    // The rest first, before the cut: more than was sold, counted line by line.
    await expect(together(child({}), [`UPDATE "ReturnLine" SET quantity = 1 WHERE id = $1::uuid`, line])).rejects.toThrow(/already on other returns/)
    await together([`UPDATE "ReturnLine" SET quantity = 1, version = version + 1 WHERE id = $1::uuid`, line], child({}))
    expect(await admin(`SELECT quantity, "receivedQuantity", "parentLineId" FROM "ReturnLine" WHERE id = ANY($1::uuid[]) ORDER BY seq`, [[line, rest]])).toEqual([
      { quantity: 1, receivedQuantity: 1, parentLineId: null },
      { quantity: 1, receivedQuantity: 0, parentLineId: line },
    ])
    await expect(update(office(), 'ReturnLine', rest, `"parentLineId" = NULL`)).rejects.toThrow(/never changes/)
    restLine = rest
  })

  it('credits the rest of a partly received line without it coming back', async () => {
    await expect(update(office(), 'ReturnLine', s.returns.waitingLineId, `"creditWithoutReturn" = true`)).rejects.toThrow(/credited without the goods coming back/)
    expect(await update(office(), 'ReturnLine', restLine, `"creditWithoutReturn" = true, disposition = 'CREDIT_ONLY', "decidedAt" = now(), "decidedById" = $2::uuid, "creditAmount" = 25000`, s.memberId)).toBe(1)
  })

  it('decides a size exchange with the other size, and a fee only when the cause is not ours', async () => {
    const line = s.returns.waitingLineId
    const decide = (set: string, ...values: unknown[]) =>
      update(office(), 'ReturnLine', line, `grade = 'LIKE_NEW', "inspectedAt" = now(), "inspectedById" = $2::uuid, "decidedAt" = now(), "decidedById" = $2::uuid, ${set}`, s.memberId, ...values)
    await expect(decide(`cause = 'NO_FAULT', disposition = 'SIZE_EXCHANGE'`)).rejects.toThrow(/exactly when it is a SIZE_EXCHANGE/)
    await expect(decide(`cause = 'NO_FAULT', disposition = 'CREDIT_ONLY', "exchangeSize" = '54'`)).rejects.toThrow(/exactly when it is a SIZE_EXCHANGE/)
    await expect(decide(`cause = 'OUR_DEFECT', disposition = 'SIZE_EXCHANGE', "exchangeSize" = '54', "feeRuleId" = $3::uuid, "feeAmount" = 2500`, s.feeRuleIds.changeOfMind)).rejects.toThrow(/the fee is dropped when the cause is ours/)
    await expect(decide(`cause = 'NO_FAULT', disposition = 'SIZE_EXCHANGE', "exchangeSize" = '54', "feeRuleId" = $3::uuid, "feeAmount" = 1000`, s.feeRuleIds.off)).rejects.toThrow(/not an active rule/)
    await expect(decide(`cause = 'NO_FAULT', disposition = 'SIZE_EXCHANGE', "exchangeSize" = '54', "feeRuleId" = $3::uuid`, s.feeRuleIds.changeOfMind)).rejects.toThrow(/with the rule it came from/)
    expect(await decide(`cause = 'NO_FAULT', disposition = 'SIZE_EXCHANGE', "exchangeSize" = '54', "feeRuleId" = $3::uuid, "feeAmount" = 2500, "creditAmount" = 0`, s.feeRuleIds.changeOfMind)).toBe(1)
    expect(await update(office(), 'ReturnLine', line, `cause = 'OUR_DEFECT', "feeAmount" = 0`)).toBe(1)
  })

  it('lets the dock write the lot it scans, nothing of the decision', async () => {
    const line = s.returns.inspectedLineId
    expect(await update(floor(), 'ReturnLine', line, `"garmentBatch" = NULL`)).toBe(1)
    expect(await update(floor(), 'ReturnLine', line, `"garmentBatch" = 'SEED-BT-0001'`)).toBe(1)
    await expect(update(floor(), 'ReturnLine', line, `"exchangeSize" = '52'`)).rejects.toThrow(/the dock writes only/)
    await expect(sql(floor(), `SELECT "feeAmount" FROM "ReturnLine" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('credits a line without the goods coming back: no pieces, no inspection, CREDIT_ONLY; then the RMA closes with its reason', async () => {
    creditRma = randomUUID()
    creditLine = randomUUID()
    expect(await copyRow(office(), 'ReturnAuthorisation', s.returns.inspectedReturnId, {
      id: creditRma, number: 'TEST-RMA-0291', status: 'AUTHORISED', receivedAt: null, inspectedAt: null, scanCode: null, policyId: s.policyIds.b2b, replacementOrderId: null, salesOrderId: null,
    })).toBe(1)
    const line = { id: creditLine, returnId: creditRma, seq: 10, salesOrderLineId: RED_LINE, size: '52', invoiceLineId: null, quantity: 1, receivedQuantity: 0, receivedAt: null, receiptId: null, grade: null, cause: null, conditionNote: null, inspectedAt: null, inspectedById: null, disposition: null, goodsOutcome: null, decidedAt: null, decidedById: null, creditAmount: null, garmentBatch: null }
    await expect(copyRow(office(), 'ReturnLine', s.returns.inspectedLineId, { ...line, garmentSerial: 'SEED-SN-0002', garmentBatch: 'SEED-BT-0001' })).rejects.toThrow(/is of batch SEED-BT-0003, not of batch SEED-BT-0001/)
    expect(await copyRow(office(), 'ReturnLine', s.returns.inspectedLineId, { ...line, creditWithoutReturn: true })).toBe(1)
    const decided = `"decidedAt" = now(), "decidedById" = $2::uuid, "creditAmount" = 12000`
    await expect(update(office(), 'ReturnLine', creditLine, `disposition = 'REPAIR', ${decided}`, s.memberId)).rejects.toThrow(/credited without the goods coming back/)
    await expect(update(office(), 'ReturnLine', creditLine, `disposition = 'CREDIT_ONLY', "goodsOutcome" = 'RESTOCK', ${decided}`, s.memberId)).rejects.toThrow(/credited without the goods coming back/)
    expect(await update(office(), 'ReturnLine', creditLine, `disposition = 'CREDIT_ONLY', ${decided}`, s.memberId)).toBe(1)
    await expect(update(office(), 'ReturnLine', creditLine, `"receivedQuantity" = 1, "receivedAt" = now()`)).rejects.toThrow(/credited without the goods coming back/)
    await expect(update(office(), 'ReturnAuthorisation', creditRma, `"finishReason" = 'CREDITED_WITHOUT_RETURN'`)).rejects.toThrow(/only once it is CLOSED/)
    expect(await update(office(), 'ReturnAuthorisation', creditRma, `status = 'CLOSED', "closedAt" = now(), "statusReason" = 'Credited, the customer keeps the jacket', "finishReason" = 'CREDITED_WITHOUT_RETURN'`)).toBe(1)
  })

  it('never takes back a sample made for no order (B-W2b-284)', async () => {
    const cell = (await admin(`SELECT "workOrderSizeId" AS cell FROM "GarmentSerial" WHERE "tenantId" = $1::uuid AND serial = 'SEED-SN-0001'`, [a.tenantId]))[0]!.cell as string
    const plant = async (orderLine: string | null, party: string | null) => {
      await db.admin.query('BEGIN')
      await db.admin.query("SET LOCAL session_replication_role = 'replica'")
      await db.admin.query(`UPDATE "WorkOrderSize" SET "salesOrderLineId" = $2::uuid, "partyId" = $3::uuid WHERE id = $1::uuid`, [cell, orderLine, party])
      await db.admin.query('COMMIT')
    }
    const [before] = await admin(`SELECT "salesOrderLineId"::text AS line, "partyId"::text AS party FROM "WorkOrderSize" WHERE id = $1::uuid`, [cell])
    await plant(null, null)
    try {
      const rma = randomUUID()
      expect(await copyRow(office(), 'ReturnAuthorisation', s.returns.inspectedReturnId, { id: rma, number: 'TEST-RMA-0292', status: 'AUTHORISED', receivedAt: null, inspectedAt: null, scanCode: null, policyId: null, replacementOrderId: null, salesOrderId: null })).toBe(1)
      await expect(copyRow(office(), 'ReturnLine', s.returns.waitingLineId, { id: randomUUID(), returnId: rma, seq: 10, quantity: 1, receivedQuantity: 0, receivedAt: null, receiptId: null, grade: null, cause: null, inspectedAt: null, inspectedById: null, disposition: null, decidedAt: null, decidedById: null, exchangeSize: null, feeRuleId: null, feeAmount: null, creditAmount: null, garmentSerial: 'SEED-SN-0001', invoiceLineId: null, salesOrderLineId: RED_LINE, size: '52' })).rejects.toThrow(/a sample made for no order/)
    } finally {
      await plant(before!.line as string, before!.party as string)
    }
  })
})

describe('repairs and their estimates (SAL-384, SAL-387, SAL-391, SAL-393)', () => {
  it('keep how the request reached us; the work wanted in words', async () => {
    const repair = s.returns.repairId
    expect(await update(office(), 'RepairOrder', repair, `"workWanted" = 'Add 2 cm to the sleeve', "garmentSerial" = 'SEED-SN-0003', version = version + 1`)).toBe(1)
    await expect(update(office(), 'RepairOrder', repair, `channel = 'PORTAL'`)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'RepairOrder', repair, `"workWanted" = ''`)).rejects.toThrow(/1 to 2000 characters/)
    expect((await sql(office(), `SELECT count(*)::int AS n FROM "RepairOrder" WHERE "garmentSerial" = 'SEED-SN-0003'`))[0]?.n).toBe(1)
  })

  it('start as a DRAFT of the repair\'s customer, are sent with lines, then what was sent is frozen', async () => {
    const draft = s.estimateIds.draft
    const newEstimate = (changes: Record<string, unknown>) => copyRow(office(), 'RepairEstimate', draft, { id: randomUUID(), revision: 3 + Math.floor(Math.random() * 1000), ...changes })
    await expect(newEstimate({ status: 'SENT', sentAt: ago(1), sentById: s.memberId })).rejects.toThrow(/starts as a DRAFT/)
    await expect(newEstimate({ partyId: key('party:P2') })).rejects.toThrow(/its repair's company and customer|foreign key/)
    const empty = randomUUID()
    expect(await newEstimate({ id: empty, revision: 9 })).toBe(1)
    await expect(update(office(), 'RepairEstimate', empty, `status = 'SENT', "sentAt" = now(), "sentById" = $2::uuid`, s.memberId)).rejects.toThrow(/with one line or more/)
    await expect(update(office(), 'RepairEstimate', draft, `status = 'SENT'`)).rejects.toThrow(/wrong sending/)
    expect(await update(office(), 'RepairEstimate', draft, `status = 'SENT', "sentAt" = now(), "sentById" = $2::uuid, version = version + 1`, s.memberId)).toBe(1)
    await expect(update(office(), 'RepairEstimate', draft, `"customerNote" = 'Changed after sending'`)).rejects.toThrow(/what the customer saw never changes/)
    await expect(update(office(), 'RepairEstimateLine', s.estimateLineIds.draftZip, `"unitPrice" = 10`)).rejects.toThrow(/only while it is a DRAFT/)
    await expect(run(office(), `DELETE FROM "RepairEstimateLine" WHERE id = $1::uuid`, s.estimateLineIds.draftLabour)).rejects.toThrow(/only while it is a DRAFT/)
    expect(await update(office(), 'RepairEstimate', draft, `"internalNote" = 'Customer called back'`)).toBe(1)
  })

  it('take the customer\'s answer once: an office answer names who recorded it; an acceptance by the end day', async () => {
    const draft = s.estimateIds.draft
    await expect(update(office(), 'RepairEstimate', draft, `status = 'ACCEPTED', "answeredAt" = now(), "answeredVia" = 'OFFICE'`)).rejects.toThrow(/an OFFICE answer with who recorded it/)
    await expect(update(office(), 'RepairEstimate', draft, `status = 'ACCEPTED', "answeredAt" = now() - interval '30 days', "answeredVia" = 'LINK'`)).rejects.toThrow(/the answer not before the sending/)
    await expect(update(office(), 'RepairEstimate', draft, `status = 'ACCEPTED', "answeredAt" = now(), "answeredVia" = 'LINK', "declineReason" = 'no'`)).rejects.toThrow(/why they declined/)
    await expect(update(office(), 'RepairEstimate', draft, `"validUntil" = $2::date`, day(-1))).rejects.toThrow(/what the customer saw never changes/)
    expect(await update(office(), 'RepairEstimate', draft, `status = 'ACCEPTED', "answeredAt" = now(), "answeredVia" = 'OFFICE', "recordedById" = $2::uuid, "answeredByName" = 'Buyer on the phone'`, s.memberId)).toBe(1)
    await expect(update(office(), 'RepairEstimate', draft, `status = 'WITHDRAWN', "withdrawnAt" = now()`)).rejects.toThrow(/it never changes/)
    await expect(admin(`DELETE FROM "RepairEstimate" WHERE id = $1::uuid`, [s.estimateIds.declined])).rejects.toThrow(/never deleted/)
  })

  it('are read by the customer in the portal without our cost', async () => {
    const rows = await sql(partner(), `SELECT id::text, status::text FROM "RepairEstimate" ORDER BY revision`)
    expect(rows.map((row) => row.status)).toEqual(['DECLINED', 'ACCEPTED', 'DRAFT'])
    expect((await sql(partner(), `SELECT count(*)::int AS n FROM "RepairEstimateLine"`))[0]?.n).toBe(4)
    await expect(sql(partner(), `SELECT "unitCost" FROM "RepairEstimateLine" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "internalNote" FROM "RepairEstimate" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect((await sql(partner(), `SELECT number FROM "RepairOrder"`)).map((row) => row.number)).toEqual(['SEED-REP-0001'])
    await expect(sql(partner(), `SELECT "internalNote" FROM "RepairOrder" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT 1 FROM "RepairEstimate" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})

describe('service cases (SAL-368, SAL-436)', () => {
  const newCase = (changes: Record<string, unknown>) => copyRow(office(), 'ServiceCase', s.caseIds.warranty, { id: randomUUID(), number: `TEST-SVC-${randomUUID().slice(0, 8)}`, ...changes })

  it('start NEW or OPEN, numbered, with what the customer reports; a contact with their customer', async () => {
    await expect(newCase({ status: 'RESOLVED' })).rejects.toThrow(/starts NEW or OPEN/)
    await expect(newCase({ number: ' ' })).rejects.toThrow(/has its number, from its company's SERVICE_CASE series/)
    await expect(newCase({ problem: '' })).rejects.toThrow(/what the customer reports/)
    await expect(newCase({ partyId: null })).rejects.toThrow(/a contact with their customer/)
    await expect(newCase({ garmentBatch: 'SEED-BT-0001' })).rejects.toThrow(/is of batch SEED-BT-0003/)
    await expect(update(office(), 'ServiceCase', s.caseIds.warranty, `number = 'SVC-OTHER'`)).rejects.toThrow(/never changes/)
  })

  it('move through their states and decide the cover with its guarantee and words', async () => {
    const id = randomUUID()
    expect(await newCase({ id })).toBe(1)
    await expect(update(office(), 'ServiceCase', id, `status = 'RESOLVED'`)).rejects.toThrow(/cannot move from NEW to RESOLVED/)
    expect(await update(office(), 'ServiceCase', id, `status = 'OPEN'`)).toBe(1)
    expect(await update(office(), 'ServiceCase', id, `status = 'WAITING_PART'`)).toBe(1)
    const decide = (set: string) => update(office(), 'ServiceCase', id, `"coverDecidedAt" = now(), "coverDecidedById" = $2::uuid, ${set}`, s.memberId)
    await expect(decide(`"coverDecision" = 'COVERED', cover = 'LEGAL_GUARANTEE', "coverNote" = 'Within two years'`)).rejects.toThrow(/with its last day/)
    await expect(decide(`"coverDecision" = 'NOT_COVERED', cover = 'FACTORY_GUARANTEE', "coverNote" = 'Misuse'`)).rejects.toThrow(/not covered \(NONE\)/)
    await expect(decide(`"coverDecision" = 'COVERED', cover = 'FACTORY_GUARANTEE'`)).rejects.toThrow(/why in words/)
    expect(await decide(`"coverDecision" = 'PARTLY', cover = 'FACTORY_GUARANTEE', "coverNote" = 'The zip is covered, the scuffs are wear'`)).toBe(1)
    await expect(update(office(), 'ServiceCase', id, `status = 'RESOLVED'`)).rejects.toThrow(/what was done/)
    expect(await update(office(), 'ServiceCase', id, `status = 'RESOLVED', "resolvedAt" = now(), resolution = 'Zip replaced'`)).toBe(1)
    expect(await update(office(), 'ServiceCase', id, `status = 'OPEN', "resolvedAt" = NULL, resolution = NULL`)).toBe(1)
    await expect(update(office(), 'ServiceCase', id, `status = 'CLOSED', "closedAt" = now()`)).rejects.toThrow(/the reason in words/)
    expect(await update(office(), 'ServiceCase', id, `status = 'CLOSED', "closedAt" = now(), "closeReason" = 'The customer stopped answering'`)).toBe(1)
    await expect(update(office(), 'ServiceCase', id, `priority = 'HIGH'`)).rejects.toThrow(/is CLOSED; it never changes/)
    expect(await update(office(), 'ServiceCase', id, `"internalNote" = 'Kept for the record'`)).toBe(1)
  })

  it('link records while open, never once closed', async () => {
    const link = (caseId: string, changes: Record<string, unknown> = {}) => copyRow(office(), 'ServiceCaseLink', s.linkIds.warranty, { id: randomUUID(), caseId, ...changes })
    expect(await link(s.caseIds.warranty, { recordType: 'RepairOrder', recordId: s.returns.repairId })).toBe(1)
    await expect(link(s.caseIds.warranty, { recordType: 'repair order' })).rejects.toThrow(/by its model name/)
    await expect(link(s.caseIds.closed)).rejects.toThrow(/is CLOSED: its links never change/)
    await expect(run(office(), `DELETE FROM "ServiceCaseLink" WHERE id = $1::uuid`, s.linkIds.closedRma)).rejects.toThrow(/is CLOSED: its links never change/)
    expect(await run(office(), `DELETE FROM "ServiceCaseLink" WHERE id = $1::uuid`, s.linkIds.warranty)).toBe(1)
    await expect(admin(`UPDATE "ServiceCaseLink" SET note = 'x' WHERE id = $1::uuid`, [s.linkIds.closedRepair])).rejects.toThrow(/never changed/)
  })
})

describe('product-safety reports, the injury apart, the accident log (SAL-414, SAL-415, SAL-423)', () => {
  /** A NEW report: a copy of the phoned one (whatever this file did to it since) with `changes`. */
  const newReport = (changes: Record<string, unknown>) =>
    copyRow(office(), 'ProductSafetyReport', s.reportIds.phoned, {
      id: randomUUID(), number: `TEST-PSR-${randomUUID().slice(0, 8)}`, status: 'NEW', seenAt: null, seenById: null, closedAt: null, closedById: null, closeNote: null,
      serviceCaseId: null, registerEntryId: null, ...changes,
    })

  it('start NEW, a portal report names its customer, the reporter in their shapes', async () => {
    await expect(newReport({ status: 'ASSESSING' })).rejects.toThrow(/starts NEW/)
    await expect(newReport({ source: 'PORTAL' })).rejects.toThrow(/through the portal/)
    await expect(newReport({ reporterEmail: 'not an address' })).rejects.toThrow(/in their shapes/)
    await expect(newReport({ occurredOn: day(30) })).rejects.toThrow(/happened by then/)
    await expect(newReport({ whatHappened: '' })).rejects.toThrow(/what happened/)
    expect(await newReport({ source: 'PUBLIC_LINK', reporterName: 'A rider', reporterEmail: 'rider@example.com', serial: 'SN-UNKNOWN-1' })).toBe(1)
  })

  it('are seen once before quality assesses them, open a SAFETY case and sit in a register entry of their style', async () => {
    const report = s.reportIds.phoned
    await expect(update(office(), 'ProductSafetyReport', report, `status = 'ASSESSING'`)).rejects.toThrow(/before quality assesses it/)
    expect(await update(office(), 'ProductSafetyReport', report, `status = 'ASSESSING', "seenAt" = now(), "seenById" = $2::uuid`, s.memberId)).toBe(1)
    await expect(update(office(), 'ProductSafetyReport', report, `"seenAt" = now()`)).rejects.toThrow(/set once/)
    await expect(update(office(), 'ProductSafetyReport', report, `"serviceCaseId" = $2::uuid`, s.caseIds.warranty)).rejects.toThrow(/opens a SAFETY service case/)
    const entry = randomUUID()
    expect(await run(office(), copyText('PpeRegisterEntry'), JSON.stringify({ id: entry, reference: `TEST-REG-${entry.slice(0, 8)}`, styleId: s.returns.money.shipping.quality.serialStyleId, sourceType: 'ProductSafetyReport', sourceId: report, batchNumbers: [], serials: [] }), s.returns.money.shipping.quality.registerEntryId)).toBe(1)
    await expect(update(office(), 'ProductSafetyReport', report, `"registerEntryId" = $2::uuid`, entry)).rejects.toThrow(/of its own style/)
    expect(await update(office(), 'ProductSafetyReport', report, `"registerEntryId" = $2::uuid, "serviceCaseId" = $3::uuid`, s.returns.money.shipping.quality.registerEntryId, s.caseIds.safety)).toBe(1)
    await expect(update(office(), 'ProductSafetyReport', report, `"serviceCaseId" = NULL`)).rejects.toThrow(/set once/)
    await expect(run(office(), copyText('PpeRegisterEntry'), JSON.stringify({ id: randomUUID(), reference: 'TEST-REG-X', sourceType: 'SafetyThing', sourceId: report }), s.returns.money.shipping.quality.registerEntryId)).rejects.toThrow(/known record type/)
  })

  it('close with words; then only the reporter\'s data is erased', async () => {
    const report = s.reportIds.phoned
    await expect(update(office(), 'ProductSafetyReport', report, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid`, s.memberId)).rejects.toThrow(/closed exactly with when, by whom and the words/)
    expect(await update(office(), 'ProductSafetyReport', report, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid, "closeNote" = 'A print defect, not a safety one'`, s.memberId)).toBe(1)
    await expect(update(office(), 'ProductSafetyReport', report, `"whatHappened" = 'Changed'`)).rejects.toThrow(/erased on request/)
    await expect(update(office(), 'ProductSafetyReport', report, `"reporterName" = 'Someone else'`)).rejects.toThrow(/erased on request/)
    expect(await update(office(), 'ProductSafetyReport', report, `"reporterName" = NULL, "reporterPhone" = NULL`)).toBe(1)
  })

  it('keep the injury apart: words only with the consent, erased once, never indexed, never on the floor or a portal', async () => {
    const newInjury = (report: string, changes: Record<string, unknown>) =>
      copyRow(office(), 'ProductSafetyInjury', s.injuryIds.phoned, { id: randomUUID(), reportId: report, key: `injury:${report}`, ...changes })
    const report = randomUUID()
    expect(await newReport({ id: report })).toBe(1)
    await expect(newInjury(report, { key: `injury:${randomUUID()}` })).rejects.toThrow(/injury:<its report>/)
    await expect(newInjury(report, { injured: true, injuryWords: 'A cut on the hand' })).rejects.toThrow(/with the explicit consent/)
    await expect(newInjury(report, { injured: false, consentAt: ago(1), injuryWords: 'A cut on the hand' })).rejects.toThrow(/only when someone was hurt/)
    const injury = randomUUID()
    expect(await newInjury(report, { id: injury, injured: true, consentAt: ago(1), injuryWords: 'A cut on the hand' })).toBe(1)
    await expect(newInjury(report, {})).rejects.toThrow(/duplicate key|ProductSafetyInjury_tenantId_key_key/)
    await expect(update(office(), 'ProductSafetyInjury', injury, `"injuryWords" = 'A deep cut'`)).rejects.toThrow(/only erased/)
    await expect(update(office(), 'ProductSafetyInjury', injury, `"injuryWords" = NULL`)).rejects.toThrow(/only erased/)
    await expect(update(office(), 'ProductSafetyInjury', injury, `injured = false`)).rejects.toThrow(/never change/)
    expect(await update(office(), 'ProductSafetyInjury', injury, `"injuryWords" = NULL, "erasedAt" = now(), "erasedById" = $2::uuid`, s.ownerId)).toBe(1)
    await expect(update(office(), 'ProductSafetyInjury', injury, `"erasedAt" = NULL`)).rejects.toThrow(/stays erased/)
    await expect(admin(`DELETE FROM "ProductSafetyInjury" WHERE id = $1::uuid`, [injury])).rejects.toThrow(/never deleted/)
    await expect(run(office(), `INSERT INTO "SearchEntry" (id, "companyId", "recordType", "recordId", title, area, "viewPermission", "searchText", "indexedAt") VALUES ($1::uuid, $2::uuid, 'ProductSafetyInjury', $3::uuid, 'x', 'sales', 'sales.safety.view', 'x', now())`, randomUUID(), s.companyA, injury)).rejects.toThrow(/never indexed/)
    await expect(sql(floor(), `SELECT 1 FROM "ProductSafetyInjury" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT 1 FROM "ProductSafetyInjury" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT 1 FROM "ProductSafetyReport" LIMIT 1`)).rejects.toThrow(/permission denied/)
    // The seed: the portal report's words erased on the rider's request.
    expect((await admin(`SELECT "injuryWords", "erasedAt" IS NOT NULL AS erased FROM "ProductSafetyInjury" WHERE id = $1::uuid`, [s.injuryIds.portal]))[0]).toEqual({ injuryWords: null, erased: true })
  })

  it('log accidents append-only, a later revision with its reason; the authority told with when and by whom', async () => {
    const entry = (changes: Record<string, unknown>) => copyRow(office(), 'AccidentLogEntry', s.accidentIds.told, { id: randomUUID(), createdAt: ago(0), ...changes })
    await expect(entry({ revision: 0 })).rejects.toThrow(/above every earlier one/)
    await expect(entry({ revision: 3, note: null })).rejects.toThrow(/say why/)
    await expect(entry({ revision: 3, authorityToldById: null })).rejects.toThrow(/with when and by whom/)
    await expect(entry({ revision: 3, occurredOn: day(1) })).rejects.toThrow(/not in the future and not after its report/)
    await expect(entry({ revision: 3, authorityNoticeId: randomUUID() })).rejects.toThrow(/not a SENT notice of its company/)
    expect(await entry({ revision: 3, outcome: 'SERIOUS_HARM', note: 'The rider was kept in hospital for a night' })).toBe(1)
    await expect(admin(`UPDATE "AccidentLogEntry" SET place = 'x' WHERE id = $1::uuid`, [s.accidentIds.recorded])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`DELETE FROM "AccidentLogEntry" WHERE id = $1::uuid`, [s.accidentIds.recorded])).rejects.toThrow(/never changed or removed/)
    await expect(run(office(), `UPDATE "AccidentLogEntry" SET place = 'x' WHERE id = $1::uuid`, s.accidentIds.recorded)).rejects.toThrow(/permission denied/)
  })

  it('number cases and reports from their own series', async () => {
    const series = await admin(`SELECT kind::text, pattern FROM "NumberSeries" WHERE "tenantId" = $1::uuid AND kind IN ('SERVICE_CASE', 'SAFETY_REPORT') ORDER BY kind, "companyId"`, [a.tenantId])
    expect(series.map((row) => `${row.kind as string} ${row.pattern as string}`)).toEqual([
      'SAFETY_REPORT PSR-{YYYY}-{N:4}',
      'SAFETY_REPORT PSR-{YYYY}-{N:4}',
      'SERVICE_CASE SVC-{YYYY}-{N:4}',
      'SERVICE_CASE SVC-{YYYY}-{N:4}',
    ])
    await expect(update(office(), 'ProductSafetyReport', s.reportIds.mailed, `number = 'PSR-OTHER'`)).rejects.toThrow(/never changes/)
  })
})
