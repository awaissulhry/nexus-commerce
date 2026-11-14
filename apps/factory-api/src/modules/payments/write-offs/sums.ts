import type { Reader } from '../store'

/**
 * What small differences written off take (B-W2b-393; FIN-119; factory-db PaymentWriteOff, append-only: a reversal is a
 * negative row, so a sum is what still stands). The reads of W1 and W2a count them as the database's caps do:
 *
 *   a payment's unplaced part   amount − allocations − live refunds − its OVERPAYMENT write-offs
 *   an invoice's open amount    gross − issued credit notes − allocations − the UNDERPAYMENT write-offs on its allocations
 *
 * Each read is one query whatever the count of ids.
 */

/** Per payment, its OVERPAYMENT write-offs still standing (minor units; absent: none). */
export async function overpaymentsWrittenOff(db: Reader, paymentIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(paymentIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.paymentWriteOff.groupBy({ by: ['paymentId'], where: { paymentId: { in: ids }, kind: 'OVERPAYMENT' }, _sum: { amount: true } })
  return new Map(rows.map((row) => [row.paymentId, row._sum.amount ?? 0]))
}

/** Per invoice, the UNDERPAYMENT write-offs still standing on its allocations (minor units; absent: none). */
export async function underpaymentsWrittenOff(db: Reader, invoiceIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(invoiceIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.paymentWriteOff.findMany({ where: { kind: 'UNDERPAYMENT', allocation: { invoiceId: { in: ids } } }, select: { amount: true, allocation: { select: { invoiceId: true } } } })
  const sums = new Map<string, number>()
  for (const row of rows) {
    const invoiceId = row.allocation?.invoiceId
    if (invoiceId) sums.set(invoiceId, (sums.get(invoiceId) ?? 0) + row.amount)
  }
  return sums
}

/** One payment's OVERPAYMENT write-offs still standing. */
export const overpaymentWrittenOff = async (db: Reader, paymentId: string): Promise<number> => (await overpaymentsWrittenOff(db, [paymentId])).get(paymentId) ?? 0

/** One invoice's UNDERPAYMENT write-offs still standing. */
export const underpaymentWrittenOff = async (db: Reader, invoiceId: string): Promise<number> => (await underpaymentsWrittenOff(db, [invoiceId])).get(invoiceId) ?? 0

/**
 * The write-off tolerance in force for a company (minor units): its receivables settings row's, else the tenant-wide
 * row's (the database's factory_bank_write_off_tolerance); null when neither sets one (nothing is written off).
 */
export async function toleranceOf(db: Reader, companyId: string): Promise<{ amount: number | null; source: 'COMPANY' | 'TENANT' | null }> {
  const rows = await db.receivablesSettings.findMany({ where: { OR: [{ companyId }, { companyId: null }] }, select: { companyId: true, writeOffToleranceAmount: true } })
  const own = rows.find((row) => row.companyId === companyId)?.writeOffToleranceAmount ?? null
  if (own !== null) return { amount: own, source: 'COMPANY' }
  const tenant = rows.find((row) => row.companyId === null)?.writeOffToleranceAmount ?? null
  return tenant !== null ? { amount: tenant, source: 'TENANT' } : { amount: null, source: null }
}
