import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAccounting, type AccountingSeed } from '../seed/accounting'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSalesOrdersDepth, type SalesOrdersDepthSeed } from '../seed/sales-orders-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Orders, credit and changes (W2b-5, schema wave 39/44, B-W2b-281, …_sales_orders_depth_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - an order waiting for a yes: only from its making, then CONFIRMED or CANCELLED; its lines change meanwhile; nothing is made,
 *     shipped or confirmed for it;
 *   - the office's priority (URGENT with its reason) and the confirmation sent (a version of its ORDER_CONFIRMATION document);
 *   - a priced change after the start: its parts and fee, an extra deposit of at most the growth, the new yes of its order;
 *   - the caparra penitenziale: switched off until the company's sales settings switch it on (GATE-ACCOUNTANT);
 *   - what freezes at each stage: one active rule per company, field and stage; a later stage never loosens an earlier BLOCKED;
 *   - credit checks: append-only, what they saw adding up, a result that fits it, an override naming its HOLD and its yes;
 *   - a customer's materials per order line: a BOM line the customer sends, counts that add up;
 *   - customer-owned stock: received from the customer, never valued, never bought, never issued or held for another party;
 *   - grants: the office only.
 * The refusals are check_violation (23514) in words, unique keys unique_violation (23505); their messages are read through raw SQL.
 */

const NS = 'w2b-281-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SalesOrdersDepthSeed
let acc: AccountingSeed

const key = (name: string): string => seedUuid(NS, name)
const P2 = key('party:P2')
const P3 = key('party:P3')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: key('site:A1') })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
/** The same copy with every trigger off (test set-up only: a row the commands of later steps would make). */
async function plant(table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(copyText(table), [JSON.stringify(changes), id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const one = async (text: string, values: unknown[] = []): Promise<Record<string, unknown>> => {
  const [row] = await admin(text, values)
  expect(row, text).toBeDefined()
  return row!
}

beforeAll(async () => {
  db = await migratedDatabase('ordersdepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  acc = await seedAccounting({ db: factory, namespace: NS })
  s = await seedSalesOrdersDepth({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedSalesOrdersDepth({ db: factory, namespace: NS })
}, 600_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

/** A new order of P1 (or `party`), a copy of the waiting one with `changes`, with one jacket line of its own; their ids. */
async function newOrder(changes: Record<string, unknown> = {}, party = key('party:P1')): Promise<{ order: string; line: string }> {
  const order = randomUUID()
  const line = randomUUID()
  expect(await copyRow(office(), 'SalesOrder', s.waitingOrderId, { id: order, number: `T-${order.slice(0, 8)}`, partyId: party, confirmationSentAt: null, confirmationVersion: null, ...changes })).toBe(1)
  expect(await copyRow(office(), 'SalesOrderLine', s.waitingLineId, { id: line, orderId: order, partyId: party })).toBe(1)
  return { order, line }
}

describe('an order waiting for a yes (SAL-205)', () => {
  it('waits only from its making; the yes confirms it, a no cancels it with its reason', async () => {
    const waiting = await one(`SELECT status, "priorityLevel", "urgentReason" FROM "SalesOrder" WHERE id = $1::uuid`, [s.waitingOrderId])
    expect(waiting).toEqual({ status: 'PENDING_APPROVAL', priorityLevel: 'URGENT', urgentReason: 'The brand moved its launch event a week forward (made-up).' })
    await expect(update(office(), 'SalesOrder', s.orderId, `status = 'PENDING_APPROVAL'`)).rejects.toThrow(/waits for a yes \(PENDING_APPROVAL\) only from its making/)
    const yes = await newOrder()
    await expect(update(office(), 'SalesOrder', yes.order, `status = 'IN_PRODUCTION'`)).rejects.toThrow(/leaves it CONFIRMED with the yes or CANCELLED with a no/)
    await expect(update(office(), 'SalesOrder', yes.order, `status = 'SHIPPED'`)).rejects.toThrow(/cannot move from PENDING_APPROVAL to SHIPPED/)
    expect(await update(office(), 'SalesOrder', yes.order, `status = 'CONFIRMED', version = version + 1`)).toBe(1)
    const no = await newOrder()
    await expect(update(office(), 'SalesOrder', no.order, `status = 'CANCELLED', "closedAt" = now()`)).rejects.toThrow(/cancel reason exactly when it is CANCELLED/)
    expect(await update(office(), 'SalesOrder', no.order, `status = 'CANCELLED', "closedAt" = now(), "cancelReason" = 'Over the credit limit; the customer will pay first.'`)).toBe(1)
  })

  it('changes its lines and sizes meanwhile', async () => {
    const { order, line } = await newOrder()
    expect(await run(office(), `INSERT INTO "SalesOrderLineSize" (id, "lineId", "partyId", size, quantity) VALUES ($1::uuid, $2::uuid, $3::uuid, '56', 1)`, randomUUID(), line, key('party:P1'))).toBe(1)
    expect(await update(office(), 'SalesOrderLine', line, `quantity = quantity + 1, note = 'One more in 56.'`)).toBe(1)
    expect(await run(office(), `DELETE FROM "SalesOrderLineSize" WHERE "lineId" = $1::uuid AND size = '56'`, line)).toBe(1)
    expect(await update(office(), 'SalesOrder', order, `"customerRef" = 'T-PO-2'`)).toBe(1)
  })

  it('has nothing made, shipped or confirmed for it', async () => {
    // A jacket order of SEED-JKT-01 waiting, and a cell of the draft SEED-WO-0002 for its line.
    const cell = await one(`SELECT c.id, c."salesOrderLineId" FROM "WorkOrderSize" c JOIN "WorkOrder" w ON w.id = c."workOrderId" WHERE w.number = 'SEED-WO-0002' AND w."tenantId" = $1::uuid ORDER BY c.id LIMIT 1`, [a.tenantId])
    const order = randomUUID()
    const line = randomUUID()
    const so1 = await one(`SELECT "orderId" FROM "SalesOrderLine" WHERE id = $1::uuid`, [cell.salesOrderLineId])
    expect(await copyRow(office(), 'SalesOrder', String(so1.orderId), { id: order, number: `T-${order.slice(0, 8)}`, status: 'PENDING_APPROVAL', quoteVersionId: null, originalPromiseDate: null })).toBe(1)
    expect(await copyRow(office(), 'SalesOrderLine', String(cell.salesOrderLineId), { id: line, orderId: order, quoteLineId: null })).toBe(1)
    await expect(copyRow(office(), 'WorkOrderSize', String(cell.id), { id: randomUUID(), salesOrderLineId: line, size: '58' })).rejects.toThrow(/waits for a yes \(PENDING_APPROVAL\); nothing is made for it/)
    const shipment = await one(`SELECT id FROM "Shipment" WHERE "tenantId" = $1::uuid AND status = 'DRAFT' ORDER BY id LIMIT 1`, [a.tenantId])
    await expect(copyRow(office(), 'Shipment', String(shipment.id), { id: randomUUID(), number: `T-SH-${order.slice(0, 8)}`, salesOrderId: order })).rejects.toThrow(/waits for a yes \(PENDING_APPROVAL\); nothing ships for it/)
    // Once confirmed, the cell is made.
    expect(await update(office(), 'SalesOrder', order, `status = 'CONFIRMED'`)).toBe(1)
    expect(await copyRow(office(), 'WorkOrderSize', String(cell.id), { id: randomUUID(), salesOrderLineId: line, size: '58' })).toBe(1)
  })
})

describe('priority and the confirmation (SAL-207, SAL-208)', () => {
  it('is URGENT exactly with its reason, one line', async () => {
    const { order } = await newOrder({ priorityLevel: 'NORMAL', urgentReason: null })
    await expect(update(office(), 'SalesOrder', order, `"priorityLevel" = 'URGENT'`)).rejects.toThrow(/URGENT exactly with its reason/)
    await expect(update(office(), 'SalesOrder', order, `"urgentReason" = 'Why not.'`)).rejects.toThrow(/URGENT exactly with its reason/)
    await expect(update(office(), 'SalesOrder', order, `"priorityLevel" = 'URGENT', "urgentReason" = E'Two\\nlines'`)).rejects.toThrow(/URGENT exactly with its reason/)
    expect(await update(office(), 'SalesOrder', order, `"priorityLevel" = 'URGENT', "urgentReason" = 'The fair opens on Monday.'`)).toBe(1)
    expect(await update(office(), 'SalesOrder', order, `"priorityLevel" = 'LOW', "urgentReason" = NULL`)).toBe(1)
  })

  it('sends a version of its own ORDER_CONFIRMATION, never while it waits, never going back', async () => {
    const sent = await one(`SELECT "confirmationVersion", "confirmationSentAt" IS NOT NULL AS sent FROM "SalesOrder" WHERE id = $1::uuid`, [s.orderId])
    expect(sent).toEqual({ confirmationVersion: 1, sent: true })
    await expect(update(office(), 'SalesOrder', s.orderId, `"confirmationVersion" = NULL`)).rejects.toThrow(/with when and its version/)
    await expect(update(office(), 'SalesOrder', s.orderId, `"confirmationVersion" = 2, "confirmationSentAt" = now()`)).rejects.toThrow(/version 2, which is no ORDER_CONFIRMATION document of it/)
    await expect(update(office(), 'SalesOrder', s.orderId, `"confirmationSentAt" = now() + interval '1 hour'`)).rejects.toThrow(/in the future/)
    await expect(update(office(), 'SalesOrder', s.orderId, `"confirmationSentAt" = NULL, "confirmationVersion" = NULL`)).rejects.toThrow(/a later sending never goes back/)
    await expect(update(office(), 'SalesOrder', s.orderId, `"confirmationSentAt" = "confirmationSentAt" - interval '1 day'`)).rejects.toThrow(/a later sending never goes back/)
    // Version 2 made, then sent.
    const v2 = randomUUID()
    expect(await copyRow(office(), 'GeneratedDocument', s.confirmationId, { id: v2, version: 2, fingerprint: 'b'.repeat(64) })).toBe(1)
    expect(await update(office(), 'SalesOrder', s.orderId, `"confirmationVersion" = 2, "confirmationSentAt" = now(), version = version + 1`)).toBe(1)
    // The waiting order sends none (its document may be made: a PDF of its own).
    const file = String((await one(`SELECT "fileId" FROM "GeneratedDocument" WHERE id = $1::uuid`, [s.confirmationId])).fileId)
    const waitingFile = randomUUID()
    expect(await copyRow(office(), 'StoredFile', file, { id: waitingFile, recordId: s.waitingOrderId, storageKey: `t/${a.tenantId}/c/${s.companyA}/2026/${waitingFile}` })).toBe(1)
    expect(await copyRow(office(), 'GeneratedDocument', s.confirmationId, { id: randomUUID(), recordId: s.waitingOrderId, fileId: waitingFile })).toBe(1)
    await expect(update(office(), 'SalesOrder', s.waitingOrderId, `"confirmationVersion" = 1, "confirmationSentAt" = now()`)).rejects.toThrow(/waits for a yes \(PENDING_APPROVAL\); its confirmation is sent once it is CONFIRMED/)
  })

  it('keeps the confirmation a SalesOrder\'s, of its company, with no site', async () => {
    await expect(copyRow(office(), 'GeneratedDocument', s.confirmationId, { id: randomUUID(), recordType: 'Shipment' })).rejects.toThrow(/an order confirmation a SalesOrder's/)
    await expect(copyRow(office(), 'GeneratedDocument', s.confirmationId, { id: randomUUID(), version: 9, siteId: key('site:A1') })).rejects.toThrow(/of the company and site of its SalesOrder/)
    await expect(copyRow(office(), 'GeneratedDocument', s.confirmationId, { id: randomUUID(), version: 9, kind: 'PACKING_LIST' })).rejects.toThrow(/a packing list is a Shipment's/)
  })
})

describe('a priced change after the start (SAL-219, SAL-221, SAL-190)', () => {
  /** A new amendment of SEED-SO-W39-02: a copy of amendment 1 with `changes`. */
  const amend = (changes: Record<string, unknown>) =>
    copyRow(office(), 'SalesOrderAmendment', s.amendmentId, { id: randomUUID(), revision: 100 + Math.floor(Math.random() * 100_000), depositRequestId: null, reapprovalTaskId: null, ...changes })

  it('is seeded priced, with its extra deposit and its new yes', async () => {
    const row = await one(`SELECT "priceDeltaLines", "feeAmount", "depositRequestId", "reapprovalTaskId" FROM "SalesOrderAmendment" WHERE id = $1::uuid`, [s.amendmentId])
    expect(row).toEqual({ priceDeltaLines: [{ label: 'One more jacket in 52, cut on its own', orderLineId: s.lineId, amount: 48_000 }], feeAmount: 2_500, depositRequestId: s.extraDepositId, reapprovalTaskId: s.taskIds.reapproval2 })
    await expect(admin(`UPDATE "SalesOrderAmendment" SET "feeAmount" = 1 WHERE id = $1::uuid`, [s.amendmentId])).rejects.toThrow(/never changed or removed|append-only|amendment/)
  })

  it('prices each part with a label, a signed amount never 0, a line of the order', async () => {
    await expect(amend({ priceDeltaLines: [] })).rejects.toThrow(/in 1 to 100 parts/)
    await expect(amend({ priceDeltaLines: { label: 'x', amount: 1 } })).rejects.toThrow(/in 1 to 100 parts/)
    await expect(amend({ priceDeltaLines: [{ label: 'Recut', amount: 0 }] })).rejects.toThrow(/an amount in minor units/)
    await expect(amend({ priceDeltaLines: [{ label: 'Recut', amount: 10.5 }] })).rejects.toThrow(/an amount in minor units/)
    await expect(amend({ priceDeltaLines: [{ label: 'Recut', amount: '100' }] })).rejects.toThrow(/an amount in minor units/)
    await expect(amend({ priceDeltaLines: [{ label: '', amount: 100 }] })).rejects.toThrow(/an amount in minor units/)
    await expect(amend({ priceDeltaLines: [{ label: 'Recut', amount: 100, extra: true }] })).rejects.toThrow(/an amount in minor units/)
    await expect(amend({ priceDeltaLines: [{ label: 'Recut', amount: 100, orderLineId: randomUUID() }] })).rejects.toThrow(/no line of the order before or after/)
    await expect(amend({ feeAmount: 0 })).rejects.toThrow(/a fee above 0/)
    expect(await amend({ priceDeltaLines: [{ label: 'Colour change after cutting', orderLineId: s.lineId, amount: 12_000 }, { label: 'Discount kept', amount: -2_000 }], feeAmount: 1_500 })).toBe(1)
  })

  it('asks an extra deposit of the same order, only when it grew, of at most the growth, once', async () => {
    const deposit = randomUUID()
    expect(await copyRow(office(), 'DepositRequest', s.extraDepositId, { id: deposit, amount: 10_000 })).toBe(1)
    await expect(amend({ depositRequestId: deposit, grossAmountAfter: 351_360 })).rejects.toThrow(/only when the order grew/)
    await expect(amend({ depositRequestId: deposit, grossAmountAfter: 351_360 + 5_000 })).rejects.toThrow(/of at most what the order grew by/)
    const other = await newOrder({ status: 'CONFIRMED' })
    const elsewhere = randomUUID()
    expect(await copyRow(office(), 'DepositRequest', s.extraDepositId, { id: elsewhere, orderId: other.order, amount: 1_000 })).toBe(1)
    await expect(amend({ depositRequestId: elsewhere })).rejects.toThrow(/a deposit request of the same order/)
    expect(await amend({ depositRequestId: deposit })).toBe(1)
    await expect(amend({ depositRequestId: deposit })).rejects.toThrow(/unique|duplicate key/)
  })

  it("names a SALES_ORDER_CHANGE request about its own order as its new yes", async () => {
    await expect(amend({ reapprovalTaskId: s.taskIds.override2 })).rejects.toThrow(/a SALES_ORDER_CHANGE request about its own order/)
    const otherTask = randomUUID()
    expect(await copyRow(office(), 'ApprovalTask', s.taskIds.reapproval2, { id: otherTask, recordId: s.waitingOrderId, requestedAt: ago(30), createdAt: ago(30), dueAt: null })).toBe(1)
    await expect(amend({ reapprovalTaskId: otherTask })).rejects.toThrow(/a SALES_ORDER_CHANGE request about its own order/)
    expect(await amend({ reapprovalTaskId: s.taskIds.reapproval2 })).toBe(1)
  })
})

describe('the caparra penitenziale (SAL-248, GATE-ACCOUNTANT)', () => {
  it('is switched off: no deposit request and no quote version asks it until the company switches it on', async () => {
    const tenantRow = a.tenantId
    expect(await one(`SELECT "caparraPenitenzialeEnabled" AS on FROM "SalesSettings" WHERE id = $1::uuid`, [tenantRow])).toEqual({ on: false })
    const draftVersion = String((await one(`SELECT v.id FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE v."tenantId" = $1::uuid AND v.status = 'DRAFT' ORDER BY v.id LIMIT 1`, [a.tenantId])).id)
    await expect(copyRow(office(), 'DepositRequest', s.extraDepositId, { id: randomUUID(), kind: 'CAPARRA_PENITENZIALE' })).rejects.toThrow(/caparra penitenziale \(c\.c\. art\. 1386\), which its company does not ask/)
    await expect(update(office(), 'QuoteVersion', draftVersion, `"depositKind" = 'CAPARRA_PENITENZIALE'`)).rejects.toThrow(/caparra penitenziale \(c\.c\. art\. 1386\), which its company does not ask/)
    // The tenant-wide row switches it on for every company without a row of its own.
    expect(await update(office(), 'SalesSettings', tenantRow, `"caparraPenitenzialeEnabled" = true, version = version + 1`)).toBe(1)
    expect(await copyRow(office(), 'DepositRequest', s.extraDepositId, { id: randomUUID(), kind: 'CAPARRA_PENITENZIALE', fiscalDocument: 'NONE' })).toBe(1)
    expect(await update(office(), 'QuoteVersion', draftVersion, `"depositKind" = 'CAPARRA_PENITENZIALE'`)).toBe(1)
    // Company A's own row wins: off.
    expect(await copyRow(office(), 'SalesSettings', tenantRow, { id: s.companyA, companyId: s.companyA, caparraPenitenzialeEnabled: false, version: 1 })).toBe(1)
    await expect(copyRow(office(), 'DepositRequest', s.extraDepositId, { id: randomUUID(), kind: 'CAPARRA_PENITENZIALE' })).rejects.toThrow(/which its company does not ask/)
    expect(await update(office(), 'QuoteVersion', draftVersion, `"depositKind" = 'ACCONTO'`)).toBe(1)
    expect(await update(office(), 'SalesSettings', tenantRow, `"caparraPenitenzialeEnabled" = false, version = version + 1`)).toBe(1)
  })
})

describe('what freezes at each stage (SAL-218)', () => {
  const addRule = (changes: Record<string, unknown>) => copyRow(office(), 'OrderFreezeRule', s.freezeRuleIds.off, { id: randomUUID(), ...changes })

  it('keeps one active rule per company, field and stage; switched off, never deleted', async () => {
    expect((await admin(`SELECT count(*)::int AS n FROM "OrderFreezeRule" WHERE "tenantId" = $1::uuid AND active`, [a.tenantId]))[0]!.n).toBe(8)
    await expect(addRule({ field: 'SIZE_QUANTITY', frozenFrom: 'CUT', action: 'CHANGE_REQUEST', active: true })).rejects.toThrow(/OrderFreezeRule_one_active|duplicate key/)
    expect(await addRule({})).toBe(1)
    await expect(update(office(), 'OrderFreezeRule', s.freezeRuleIds.sizeCut, `"frozenFrom" = 'SEWING'`)).rejects.toThrow(/company, field, stage and creation of freeze rule .* never change/)
    await expect(update(office(), 'OrderFreezeRule', s.freezeRuleIds.sizeCut, `field = 'PRICE'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'OrderFreezeRule', s.freezeRuleIds.sizeCut, `note = E'Two\\nlines'`)).rejects.toThrow(/one line of at most 200/)
    expect(await update(office(), 'OrderFreezeRule', s.freezeRuleIds.sizeCut, `note = 'Cut: sizes frozen', version = version + 1`)).toBe(1)
    await expect(run(office(), `DELETE FROM "OrderFreezeRule" WHERE id = $1::uuid`, s.freezeRuleIds.off)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "OrderFreezeRule" WHERE id = $1::uuid`, [s.freezeRuleIds.off])).rejects.toThrow(/switched off, never deleted/)
    await expect(admin(`TRUNCATE "OrderFreezeRule"`)).rejects.toThrow(/TRUNCATE on "OrderFreezeRule" is refused/)
  })

  it('never loosens at a later stage what an earlier stage blocks', async () => {
    // SIZE_QUANTITY: CHANGE_REQUEST from CUT, BLOCKED from FINISHED.
    await expect(addRule({ field: 'SIZE_QUANTITY', frozenFrom: 'SHIPPED', action: 'CHANGE_REQUEST', active: true })).rejects.toThrow(/would loosen what an earlier stage blocks/)
    await expect(addRule({ field: 'SIZE_QUANTITY', frozenFrom: 'RELEASED', action: 'BLOCKED', active: true })).rejects.toThrow(/would loosen what an earlier stage blocks/)
    // Switched off, the same rule holds nothing and is kept.
    expect(await addRule({ field: 'SIZE_QUANTITY', frozenFrom: 'SHIPPED', action: 'CHANGE_REQUEST', active: false })).toBe(1)
    expect(await addRule({ field: 'SIZE_QUANTITY', frozenFrom: 'SEWING', action: 'CHANGE_REQUEST', active: true })).toBe(1)
    // The colourway: blocked from CUT; switching the BLOCKED rule off lets a later change request in.
    await expect(addRule({ field: 'COLOURWAY', frozenFrom: 'SEWING', action: 'CHANGE_REQUEST', active: true })).rejects.toThrow(/would loosen/)
    expect(await update(office(), 'OrderFreezeRule', s.freezeRuleIds.colourCut, `active = false, version = version + 1`)).toBe(1)
    expect(await addRule({ field: 'COLOURWAY', frozenFrom: 'SEWING', action: 'CHANGE_REQUEST', active: true })).toBe(1)
    await expect(update(office(), 'OrderFreezeRule', s.freezeRuleIds.colourCut, `active = true`)).rejects.toThrow(/would loosen/)
  })
})

describe('credit checks (SAL-148, SAL-237, SAL-241, SAL-244)', () => {
  /** A new check: a copy of the PASS at the quote with `changes`. */
  const check = (changes: Record<string, unknown>) => copyRow(office(), 'CreditCheck', s.checkIds.pass, { id: randomUUID(), checkedAt: ago(1), ...changes })
  const sums = (orders: number, invoices: number, overdue: number, subject: number) => ({ openOrdersAmount: orders, openInvoicesAmount: invoices, overdueAmount: overdue, subjectAmount: subject, exposureAmount: orders + invoices + subject })

  it('are append-only, for every login', async () => {
    await expect(run(office(), `UPDATE "CreditCheck" SET words = 'Changed.' WHERE id = $1::uuid`, s.checkIds.pass)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "CreditCheck" SET words = 'Changed.' WHERE id = $1::uuid`, [s.checkIds.pass])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`DELETE FROM "CreditCheck" WHERE id = $1::uuid`, [s.checkIds.pass])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`TRUNCATE "CreditCheck"`)).rejects.toThrow(/TRUNCATE on "CreditCheck" is refused/)
  })

  it('check a record of the step, of their customer and company', async () => {
    await expect(check({ step: 'ORDER' })).rejects.toThrow(/an order or API check a SalesOrder/)
    await expect(check({ step: 'RELEASE', recordType: 'SalesOrder', recordId: s.orderId })).rejects.toThrow(/a release check a WorkOrder/)
    await expect(check({ recordId: randomUUID() })).rejects.toThrow(/no record of its customer and company/)
    await expect(check({ partyId: P3 })).rejects.toThrow(/no record of its customer and company/)
    await expect(check({ companyId: key('company:B') })).rejects.toThrow(/no record of its customer and company|violates foreign key/)
    const wo = await one(`SELECT id FROM "WorkOrder" WHERE number = 'SEED-WO-0001' AND "tenantId" = $1::uuid`, [a.tenantId])
    expect(await check({ step: 'RELEASE', recordType: 'WorkOrder', recordId: wo.id })).toBe(1)
    await expect(check({ step: 'RELEASE', recordType: 'WorkOrder', recordId: wo.id, partyId: P3 })).rejects.toThrow(/no record of its customer and company/)
    expect(await check({ step: 'PORTAL', recordType: 'SalesOrder', recordId: s.waitingOrderId })).toBe(1)
    expect(await check({ step: 'API', recordType: 'SalesOrder', recordId: s.orderId })).toBe(1)
  })

  it('add up what they saw, and their result fits it', async () => {
    await expect(check({ exposureAmount: 1 })).rejects.toThrow(/adds up its exposure/)
    await expect(check({ ...sums(0, 100, 200, 0) })).rejects.toThrow(/adds up its exposure/)
    await expect(check({ ...sums(-1, 0, 0, 1) })).rejects.toThrow(/adds up its exposure/)
    await expect(check({ limitAmount: -1 })).rejects.toThrow(/adds up its exposure/)
    await expect(check({ ...sums(1_000_000, 600_000, 0, 0), result: 'PASS' })).rejects.toThrow(/is a PASS, but it is over the limit/)
    await expect(check({ onHold: true })).rejects.toThrow(/is a PASS/)
    await expect(check({ result: 'HOLD' })).rejects.toThrow(/a WARN or a HOLD says what is wrong/)
    await expect(check({ result: 'WARN', limitAmount: null })).rejects.toThrow(/a WARN or a HOLD says what is wrong/)
    await expect(check({ currency: 'eur' })).rejects.toThrow(/three capitals/)
    await expect(check({ words: '' })).rejects.toThrow(/one line of at most 500/)
    await expect(check({ checkedAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/not checked in the future/)
    // No limit: nothing held. Overdue within the limit: a WARN (or a PASS, by the company's setting). On hold: a HOLD.
    expect(await check({ limitAmount: null, ...sums(5_000_000, 0, 0, 1) })).toBe(1)
    expect(await check({ ...sums(0, 100_000, 50_000, 0), result: 'WARN', words: '500.00 EUR overdue' })).toBe(1)
    expect(await check({ ...sums(0, 100_000, 50_000, 0), result: 'PASS' })).toBe(1)
    expect(await check({ onHold: true, result: 'HOLD', words: 'On credit hold' })).toBe(1)
  })

  it('override a HOLD only with an approved CREDIT_OVERRIDE request about it, once, not before its yes', async () => {
    const seeded = await one(`SELECT result, "overridesCheckId", "overrideTaskId" FROM "CreditCheck" WHERE id = $1::uuid`, [s.checkIds.override2])
    expect(seeded).toEqual({ result: 'HOLD', overridesCheckId: s.checkIds.hold2, overrideTaskId: s.taskIds.override2 })
    const hold2 = { step: 'ORDER', recordType: 'SalesOrder', recordId: s.orderId }
    const hold1 = { step: 'ORDER', recordType: 'SalesOrder', recordId: s.waitingOrderId }
    await expect(check({ ...hold1, overridesCheckId: s.checkIds.hold1 })).rejects.toThrow(/exactly with the request for a yes/)
    // The waiting order's request is still PENDING.
    await expect(check({ ...hold1, overridesCheckId: s.checkIds.hold1, overrideTaskId: s.taskIds.override1 })).rejects.toThrow(/an APPROVED CREDIT_OVERRIDE request about that check/)
    // A request about another check; a PASS overridden; another record.
    await expect(check({ ...hold1, overridesCheckId: s.checkIds.hold1, overrideTaskId: s.taskIds.override2 })).rejects.toThrow(/an APPROVED CREDIT_OVERRIDE request about that check/)
    await expect(check({ overridesCheckId: s.checkIds.pass, overrideTaskId: s.taskIds.override2 })).rejects.toThrow(/a HOLD \(not itself an override\)/)
    // A check is overridden once (SEED-SO-W39-02's HOLD is).
    await expect(check({ ...hold2, ...sums(980_000, 260_000, 0, 351_360), result: 'HOLD', overridesCheckId: s.checkIds.hold2, overrideTaskId: s.taskIds.override2 })).rejects.toThrow(/CreditCheck_tenantId_overridesCheckId_key|duplicate key/)
    // Finance (the member is not the one who asked: the member asked; the Owner says yes) approves the waiting order's request.
    expect(await update(office(), 'ApprovalTask', s.taskIds.override1, `status = 'APPROVED', "decidedAt" = now() - interval '2 minutes', "decidedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(check({ ...hold1, ...sums(1_140_000, 260_000, 80_000, 234_240), result: 'HOLD', overridesCheckId: s.checkIds.hold1, overrideTaskId: s.taskIds.override1, checkedAt: ago(5) })).rejects.toThrow(/not before its yes/)
    await expect(check({ ...hold1, step: 'API', ...sums(1_140_000, 260_000, 80_000, 234_240), result: 'HOLD', overridesCheckId: s.checkIds.hold1, overrideTaskId: s.taskIds.override1 })).rejects.toThrow(/of the same step and record/)
    expect(await check({ ...hold1, ...sums(1_140_000, 260_000, 80_000, 234_240), result: 'HOLD', overridesCheckId: s.checkIds.hold1, overrideTaskId: s.taskIds.override1 })).toBe(1)
    await expect(check({ ...hold1, ...sums(1_140_000, 260_000, 80_000, 234_240), result: 'HOLD', overridesCheckId: s.checkIds.hold1, overrideTaskId: s.taskIds.override1 })).rejects.toThrow(/CreditCheck_tenantId_overridesCheckId_key|duplicate key/)
    // An override is not overridden.
    await expect(check({ ...hold2, ...sums(980_000, 260_000, 0, 351_360), result: 'HOLD', overridesCheckId: s.checkIds.override2, overrideTaskId: s.taskIds.override2 })).rejects.toThrow(/not itself an override/)
    // The waiting order goes on with the yes.
    expect(await update(office(), 'SalesOrder', s.waitingOrderId, `status = 'CONFIRMED', version = version + 1`)).toBe(1)
  })
})

describe("a customer's materials (SAL-306)", () => {
  const addMaterial = (changes: Record<string, unknown>) => copyRow(office(), 'CustomerMaterial', s.materialIds.waiting, { id: randomUUID(), ...changes })

  it('are of a line of the order, a BOM line the customer sends, in the base unit', async () => {
    expect(await one(`SELECT "expectedQuantity"::text AS q, "expectedBySize" FROM "CustomerMaterial" WHERE id = $1::uuid`, [s.materialIds.waiting])).toEqual({ q: '4.0000', expectedBySize: { '50': '1.0000', '52': '2.0000', '54': '1.0000' } })
    await expect(addMaterial({ orderLineId: s.lineId })).rejects.toThrow(/for line .* of another order/)
    const shell = String((await one(`SELECT id, "itemId" FROM "BomLine" WHERE "revisionId" = $1::uuid AND seq = 10`, [s.jacket.revisionId])).id)
    const shellItem = String((await one(`SELECT "itemId" FROM "BomLine" WHERE id = $1::uuid`, [shell])).itemId)
    const leatherBase = String((await one(`SELECT "baseUom" FROM "Item" WHERE id = $1::uuid`, [shellItem])).baseUom)
    await expect(addMaterial({ bomLineId: shell, itemId: shellItem, uom: leatherBase })).rejects.toThrow(/whose material the order's customer does not send/)
    await expect(addMaterial({ uom: 'M' })).rejects.toThrow(/in the material's base unit \(PCS\)/)
  })

  it('count from 0, use and return at most what came, expect sizes that add up', async () => {
    await expect(addMaterial({ receivedQuantity: 2, usedQuantity: 2, returnedQuantity: 1 })).rejects.toThrow(/at most what was received/)
    await expect(addMaterial({ receivedQuantity: -1 })).rejects.toThrow(/counts from 0/)
    await expect(addMaterial({ expectedBySize: { '50': '1', '52': '2' } })).rejects.toThrow(/adding up to its whole/)
    await expect(addMaterial({ expectedBySize: { '50': 1, '52': 2, '54': 1 } })).rejects.toThrow(/an object of size codes to decimals above 0/)
    await expect(addMaterial({ expectedBySize: { '50': '0', '52': '4' } })).rejects.toThrow(/an object of size codes to decimals above 0/)
    await expect(addMaterial({ expectedBySize: ['50'] })).rejects.toThrow(/an object of size codes/)
    expect(await addMaterial({ expectedBySize: {}, note: 'A made-to-measure unit: no sizes.\nOne label.' })).toBe(1)
    const id = randomUUID()
    expect(await addMaterial({ id, receivedQuantity: 4, usedQuantity: 3, returnedQuantity: 1 })).toBe(1)
    await expect(update(office(), 'CustomerMaterial', id, `"itemColourId" = $2::uuid`, randomUUID())).rejects.toThrow(/never change|violates foreign key/)
    await expect(update(office(), 'CustomerMaterial', id, `"orderLineId" = $2::uuid`, s.lineId)).rejects.toThrow(/never change/)
    expect(await update(office(), 'CustomerMaterial', id, `"expectedQuantity" = 0, "expectedBySize" = '{}', version = version + 1`)).toBe(1)
    await expect(run(office(), `DELETE FROM "CustomerMaterial" WHERE id = $1::uuid`, id)).rejects.toThrow(/was received, used or returned; it is kept/)
    const unused = randomUUID()
    expect(await addMaterial({ id: unused })).toBe(1)
    expect(await run(office(), `DELETE FROM "CustomerMaterial" WHERE id = $1::uuid`, unused)).toBe(1)
  })
})

describe('customer-owned stock (SAL-306): never valued, never bought, never used for another party', () => {
  it('is received from the customer: a CUSTOMER_SUPPLIED receipt, no purchase order, lots it owns', async () => {
    const lot = await one(`SELECT "ownerPartyId", "qualityStatus" FROM "Lot" WHERE id = $1::uuid`, [s.owned.lotId])
    expect(lot).toEqual({ ownerPartyId: s.partyId, qualityStatus: 'RELEASED' })
    expect(await one(`SELECT count(*)::int AS n FROM "StockValuation" WHERE "moveId" = $1::uuid`, [s.owned.moveId])).toEqual({ n: 0 })
    const po = await one(`SELECT id, "partyId" FROM "PurchaseOrder" WHERE "tenantId" = $1::uuid AND "siteId" = $2::uuid AND status IN ('SENT', 'CONFIRMED', 'PARTLY_RECEIVED') ORDER BY id LIMIT 1`, [a.tenantId, key('site:A1')])
    const receipt = (changes: Record<string, unknown>) =>
      copyRow(office(), 'GoodsReceipt', s.owned.receiptId, { id: randomUUID(), number: `T-GR-${randomUUID().slice(0, 8)}`, status: 'OPEN', postedAt: null, postedById: null, ...changes })
    await expect(receipt({ supplierId: po.partyId, purchaseOrderId: po.id })).rejects.toThrow(/nothing of it was bought, so it names no purchase order/)
    await expect(receipt({ supplierId: P2 })).rejects.toThrow(/its sender is a party with the CUSTOMER or BRAND role/)
    const open = randomUUID()
    expect(await receipt({ id: open })).toBe(1)
    await expect(update(office(), 'GoodsReceipt', open, `kind = 'STANDARD'`)).rejects.toThrow(/kind never changes/)
    const line = (changes: Record<string, unknown>) => copyRow(office(), 'GoodsReceiptLine', s.owned.receiptLineId, { id: randomUUID(), receiptId: open, ...changes })
    await expect(line({ itemId: s.jacket.labelItemId, uom: 'PCS', quantity: 7, baseQuantity: 7 })).rejects.toThrow(/tracked by LOT or HIDE \(the lot names its owner; this one is NONE\)/)
    const lineId = randomUUID()
    expect(await line({ id: lineId })).toBe(1)
    // Its lot is owned by the sender; a lot of a bought receipt by nobody; the owner a customer, set once.
    const newLot = (changes: Record<string, unknown>) => copyRow(office(), 'Lot', s.owned.lotId, { id: randomUUID(), code: `T-LOT-${randomUUID().slice(0, 8)}`, receiptLineId: lineId, ...changes })
    await expect(newLot({ ownerPartyId: null })).rejects.toThrow(/a lot of goods a customer sent \(CUSTOMER_SUPPLIED\) is owned by that customer/)
    await expect(newLot({ ownerPartyId: P3 })).rejects.toThrow(/owned by that customer/)
    await expect(newLot({ ownerPartyId: P2, receiptLineId: null })).rejects.toThrow(/a party with the CUSTOMER or BRAND role/)
    expect(await newLot({ ownerPartyId: P3, receiptLineId: null })).toBe(1)
    const bought = String((await one(`SELECT l.id FROM "Lot" l WHERE l."tenantId" = $1::uuid AND l.code = 'SEED-LOT-LEA-01'`, [a.tenantId])).id)
    await expect(copyRow(office(), 'Lot', bought, { id: randomUUID(), code: `T-LOT-${randomUUID().slice(0, 8)}`, ownerPartyId: s.partyId })).rejects.toThrow(/a lot of goods we bought by nobody/)
    await expect(update(office(), 'Lot', s.owned.lotId, `"ownerPartyId" = NULL`)).rejects.toThrow(/set when it is made, never changed/)
  })

  it('is never valued nor matched to a supplier invoice', async () => {
    const opening = await one(`SELECT v.id FROM "StockValuation" v JOIN "StockMove" m ON m.id = v."moveId" WHERE m."idempotencyKey" = 'seed-opening-LIN-01' AND v."tenantId" = $1::uuid`, [a.tenantId])
    await expect(
      copyRow(office(), 'StockValuation', String(opening.id), { id: randomUUID(), moveId: s.owned.moveId, itemId: s.owned.itemId, lotId: s.owned.lotId, quantity: '30.0000', valueAmount: 6300, method: 'MANUAL', idempotencyKey: `move:${s.owned.moveId}` }),
    ).rejects.toThrow(/a customer's own material: customer-owned stock is never valued/)
    await expect(copyRow(office(), 'SupplierInvoiceMatch', acc.matchId, { id: randomUUID(), goodsReceiptLineId: s.owned.receiptLineId })).rejects.toThrow(/nothing of it was bought, so no supplier invoice is matched against it/)
  })

  it("is issued and held only for its owner's orders, never costed", async () => {
    const wo1 = String((await one(`SELECT id FROM "WorkOrder" WHERE number = 'SEED-WO-0001' AND "tenantId" = $1::uuid`, [a.tenantId])).id)
    const issue = (workOrderId: string, quantity = '2.0000') =>
      copyRow(office(), 'StockMove', s.owned.moveId, {
        id: randomUUID(),
        reason: 'ISSUE',
        fromLocationId: s.owned.locationId,
        toLocationId: null,
        receiptLineId: null,
        workOrderId,
        quantity,
        baseQuantity: quantity,
        idempotencyKey: `t-issue-${randomUUID()}`,
        occurredAt: ago(1),
      })
    // SEED-WO-0001 makes P1's SEED-SO-0001: the brand's lining may go into it.
    const moveId = randomUUID()
    expect(await copyRow(office(), 'StockMove', s.owned.moveId, { id: moveId, reason: 'ISSUE', fromLocationId: s.owned.locationId, toLocationId: null, receiptLineId: null, workOrderId: wo1, quantity: '2.0000', baseQuantity: '2.0000', idempotencyKey: `t-issue-${moveId}`, occurredAt: ago(1) })).toBe(1)
    // A work order with no cell, and one with a cell of P3's order (planted: the release rules are not under test).
    const empty = randomUUID()
    await plant('WorkOrder', wo1, { id: empty, number: `T-WO-${empty.slice(0, 8)}`, batchNumber: null })
    await expect(issue(empty)).rejects.toThrow(/issued only to a work order whose every cell makes that customer's orders/)
    const p3 = await newOrder({ status: 'CONFIRMED' }, P3)
    const cell = String((await one(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1::uuid ORDER BY id LIMIT 1`, [wo1])).id)
    const mixed = randomUUID()
    await plant('WorkOrder', wo1, { id: mixed, number: `T-WO-${mixed.slice(0, 8)}`, batchNumber: null })
    await plant('WorkOrderSize', cell, { id: randomUUID(), workOrderId: mixed })
    expect(await issue(mixed)).toBe(1)
    await plant('WorkOrderSize', cell, { id: randomUUID(), workOrderId: mixed, size: '58', salesOrderLineId: p3.line, partyId: P3 })
    await expect(issue(mixed)).rejects.toThrow(/issued only to a work order whose every cell makes that customer's orders/)
    // Never costed on the work order.
    await expect(
      copyRow(office(), 'WorkOrderCostEntry', acc.costEntryIds.material, { id: randomUUID(), stockMoveId: moveId, itemId: s.owned.itemId, quantity: '2.0000', idempotencyKey: `move:${moveId}` }),
    ).rejects.toThrow(/customer-owned stock is never costed on a work order/)
    // Held only for P1's order lines or a work order making only them.
    const hold = (workOrderId: string | null, salesOrderLineId: string | null, partyId: string | null) =>
      run(
        office(),
        `INSERT INTO "Reservation" (id, "companyId", "siteId", kind, "itemId", "lotId", quantity, "workOrderId", "salesOrderLineId", "partyId") VALUES ($1::uuid, $2::uuid, $3::uuid, 'QUANTITY', $4::uuid, $5::uuid, 1, $6::uuid, $7::uuid, $8::uuid)`,
        randomUUID(), s.companyA, key('site:A1'), s.owned.itemId, s.owned.lotId, workOrderId, salesOrderLineId, partyId,
      )
    await expect(hold(null, p3.line, P3)).rejects.toThrow(/held only for that customer's order lines/)
    await expect(hold(empty, null, null)).rejects.toThrow(/held only for that customer's order lines/)
    expect(await hold(null, s.lineId, s.partyId)).toBe(1)
    expect(await hold(wo1, null, null)).toBe(1)
  })
})

describe('grants', () => {
  it("are the office's: the floor and partners read nothing", async () => {
    for (const table of ['OrderFreezeRule', 'CreditCheck', 'CustomerMaterial']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    // The partner reads its orders without the office's priority.
    await expect(sql(partner(), `SELECT "priorityLevel" FROM "SalesOrder" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT "urgentReason" FROM "SalesOrder" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect((await sql(partner(), `SELECT "confirmationVersion" FROM "SalesOrder" WHERE id = $1::uuid`, s.orderId))[0]).toEqual({ confirmationVersion: expect.any(Number) })
    await expect(admin(`TRUNCATE "CustomerMaterial"`)).rejects.toThrow(/TRUNCATE on "CustomerMaterial" is refused/)
  })
})
