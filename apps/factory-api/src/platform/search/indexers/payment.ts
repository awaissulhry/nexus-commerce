import { bySubjectIn, defineIndexer, idWhere, partyName, type RecordsOf } from '../indexer'

/**
 * Payments received (modules/payments; payments.view; opens in Finance › Payments): by the bank's reference (a payment has
 * no number of its own: the reference is what people type, a CRO or TRN), the customer's name and code, the numbers of the
 * invoices and orders it is placed on. Scope as the payments list: company and customer (no site). NEVER its amount.
 * Recorded, voided, placed and taken back (credit-balance steps included) re-read it; a customer renamed re-indexes its
 * payments.
 */
const paymentsOfRelease: RecordsOf = (event) => {
  const ids = (event.payload as { paymentIds?: unknown } | null)?.paymentIds
  return Array.isArray(ids) ? ids.filter((entry): entry is string => typeof entry === 'string') : []
}

/** The invoice and order numbers shown under a payment (at most this many; the rest stay among its words). */
const SHOWN = 3
const WORDS = 50

export default defineIndexer({
  recordType: 'Payment',
  area: 'finance',
  viewPermission: 'payments.view',
  on: {
    'payment.recorded': 'subject',
    'payment.voided': 'subject',
    'payment.allocated': 'subject',
    'payment.allocation_reversed': 'subject',
    'payment.overpayment_released': paymentsOfRelease,
    'party.updated': bySubjectIn((tx, partyId, take) => tx.payment.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.payment.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        partyId: true,
        externalRef: true,
        status: true,
        party: { select: { code: true, legalName: true, tradeName: true } },
        allocations: {
          select: { invoice: { select: { number: true } }, depositRequest: { select: { order: { select: { number: true } } } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: WORDS,
        },
      },
    })
    return rows.map((row) => {
      const placed = [...new Set(row.allocations.map((allocation) => allocation.invoice?.number ?? allocation.depositRequest?.order?.number ?? null).filter((number): number is string => Boolean(number)))]
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: null,
        partyId: row.partyId,
        number: row.externalRef,
        title: partyName(row.party) ?? row.externalRef,
        subtitle: placed.length > 0 ? [...placed.slice(0, SHOWN), ...(placed.length > SHOWN ? [`+${placed.length - SHOWN}`] : [])].join(', ') : null,
        status: row.status,
        words: [row.party.code, row.party.legalName, ...placed],
      }
    })
  },
})
