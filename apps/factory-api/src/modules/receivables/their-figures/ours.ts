import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { OurBooks } from '@nexus/factory-domain/receivables-figures/figures'
import { openInvoices, type CustomerScope, type Reader } from '../store'

/**
 * Our books for one customer of one company as of a day, in one currency (B-W2b-406; FIN-135): what the customer's own
 * figures are compared with. Read as the person (row-level security keeps the tenant; the caller checked can()).
 *
 *   invoices   every issued TD01/TD24 up to the day, with what is open on it then (receivables' `openInvoices`: gross −
 *              issued credit notes − allocations − B-W2b-393's UNDERPAYMENT write-offs; 0 when settled), and its order (its
 *              own, else the order of its first line)
 *   orders     the customer's orders in the company (number and their own reference)
 *   payments   the payments received from the customer up to the day (VOIDED ones are no money)
 *   balance    the ledger's rule (receivables/ledger): issued TD01, TD02, TD24 debit; TD04 and payments received credit;
 *              refunds paid debit — and the small differences written off count as the database's caps do (an UNDERPAYMENT
 *              written off is no longer owed, an OVERPAYMENT written off no longer ours to give back)
 */

const day = (value: Date): BusinessDate => businessDate(value, 'UTC')
/** The most documents of one customer read for one comparison (a customer of many years still fits). */
const MAX_DOCUMENTS = 5000

export async function ourBooks(db: Reader, scope: CustomerScope, asOf: BusinessDate, currency: string): Promise<OurBooks> {
  const end = businessDayRange(asOf).end
  const issued = await db.$queryRaw<{ id: string; number: string | null; orderId: string | null }[]>`
    SELECT i.id, i.number,
           coalesce(i."salesOrderId", (SELECT o."orderId" FROM "InvoiceLine" l JOIN "SalesOrderLine" o ON o."tenantId" = l."tenantId" AND o.id = l."salesOrderLineId"
                                         WHERE l."invoiceId" = i.id ORDER BY l.seq LIMIT 1)) AS "orderId"
      FROM "Invoice" i
     WHERE i."companyId" = ${scope.companyId}::uuid AND i."buyerPartyId" = ${scope.partyId}::uuid AND i."docType" IN ('TD01', 'TD24')
       AND i.status <> 'DRAFT' AND i."issueDate" <= ${asOf}::date AND i.currency = ${currency}
     ORDER BY i."issueDate", i.number, i.id
     LIMIT ${MAX_DOCUMENTS}`
  const open = new Map(
    (await openInvoices(db, { companyId: scope.companyId, partyId: scope.partyId, asOf }))
      .filter((invoice) => invoice.currency === currency)
      .map((invoice) => [invoice.id, invoice.instalments.reduce((sum, entry) => sum + entry.open, 0)]),
  )
  const orders = await db.salesOrder.findMany({
    where: { companyId: scope.companyId, partyId: scope.partyId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_DOCUMENTS,
    select: { id: true, number: true, customerRef: true },
  })
  const payments = await db.payment.findMany({
    where: { companyId: scope.companyId, partyId: scope.partyId, status: 'RECEIVED', currency, receivedOn: { lte: new Date(`${asOf}T00:00:00.000Z`) } },
    orderBy: [{ receivedOn: 'asc' }, { id: 'asc' }],
    take: MAX_DOCUMENTS,
    select: { id: true, externalRef: true, receivedOn: true, amount: true },
  })
  const [sums] = await db.$queryRaw<{ invoiced: bigint | null; paid: bigint | null; refunded: bigint | null; under: bigint | null; over: bigint | null }[]>`
    SELECT (SELECT sum(CASE WHEN i."docType" = 'TD04' THEN -i."grossTotal" ELSE i."grossTotal" END) FROM "Invoice" i
             WHERE i."companyId" = ${scope.companyId}::uuid AND i."buyerPartyId" = ${scope.partyId}::uuid AND i."docType" IN ('TD01', 'TD02', 'TD04', 'TD24')
               AND i.status <> 'DRAFT' AND i."issueDate" <= ${asOf}::date AND i.currency = ${currency}) AS invoiced,
           (SELECT sum(p.amount) FROM "Payment" p
             WHERE p."companyId" = ${scope.companyId}::uuid AND p."partyId" = ${scope.partyId}::uuid AND p.status = 'RECEIVED' AND p."receivedOn" <= ${asOf}::date AND p.currency = ${currency}) AS paid,
           (SELECT sum(r.amount) FROM "Refund" r
             WHERE r."companyId" = ${scope.companyId}::uuid AND r."partyId" = ${scope.partyId}::uuid AND r.status = 'PAID' AND r."paidOn" <= ${asOf}::date AND r.currency = ${currency}) AS refunded,
           (SELECT sum(w.amount) FROM "PaymentWriteOff" w JOIN "Payment" p ON p."tenantId" = w."tenantId" AND p.id = w."paymentId"
             WHERE p."companyId" = ${scope.companyId}::uuid AND p."partyId" = ${scope.partyId}::uuid AND p.currency = ${currency} AND w.kind = 'UNDERPAYMENT' AND w."createdAt" < ${end}) AS under,
           (SELECT sum(w.amount) FROM "PaymentWriteOff" w JOIN "Payment" p ON p."tenantId" = w."tenantId" AND p.id = w."paymentId"
             WHERE p."companyId" = ${scope.companyId}::uuid AND p."partyId" = ${scope.partyId}::uuid AND p.currency = ${currency} AND w.kind = 'OVERPAYMENT' AND w."createdAt" < ${end}) AS over`
  const n = (value: bigint | null | undefined): number => Number(value ?? 0n)
  return {
    invoices: issued.map((row) => ({ id: row.id, number: row.number ?? '', orderId: row.orderId, open: open.get(row.id) ?? 0 })),
    orders: orders.map((row) => ({ id: row.id, number: row.number, customerRef: row.customerRef })),
    payments: payments.map((row) => ({ id: row.id, reference: row.externalRef, receivedOn: day(row.receivedOn), amount: row.amount })),
    balance: n(sums?.invoiced) - n(sums?.paid) + n(sums?.refunded) - n(sums?.under) + n(sums?.over),
  }
}
