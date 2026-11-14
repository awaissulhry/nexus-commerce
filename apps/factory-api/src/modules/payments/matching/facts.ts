import { businessDate } from '@nexus/factory-domain/core/time'
import type { HandPayment, MatchFacts, OpenItem, PartyFacts, SupplierItem } from '@nexus/factory-domain/payments/matching/match'
import { openOnDeposit, openOnInvoice } from '@nexus/factory-domain/payments/payments'
import type { Reader } from '../store'
import { toleranceOf, underpaymentsWrittenOff } from '../write-offs/sums'

/**
 * What the matcher looks at for one company (B-W2b-393; FIN-132), read in a few queries whatever the counts:
 *
 *   items       the issued TD01/TD24 invoices still open (gross − issued credit notes − allocations − UNDERPAYMENT
 *               write-offs, the sums of payments' open items) and the OPEN deposit requests (amount − allocations),
 *               each with its number (a request: its order's)
 *   payments    the bank transfers typed by hand (RECEIVED) that no bank line is yet (no live accepted match)
 *   suppliers   the supplier invoices (kind INVOICE, not VOIDED) no bank line paid yet: what is paid is gross less
 *               withholding
 *   parties     the names of every party those name, and the IBANs known for each: the other side of a line accepted for
 *               it before, and a supplier's bank accounts
 *   tolerance   the company's write-off tolerance in force
 */

const day = (value: Date): string => value.toISOString().slice(0, 10)

/** The open amounts of the company's open items (or of the ones named), oldest first. */
export async function openItemsOf(db: Reader, companyId: string, only: { readonly invoiceIds?: readonly string[]; readonly depositRequestIds?: readonly string[] } = {}): Promise<OpenItem[]> {
  const invoices = await db.invoice.findMany({
    where: { companyId, docType: { in: ['TD01', 'TD24'] }, status: { not: 'DRAFT' }, ...(only.invoiceIds ? { id: { in: [...only.invoiceIds] } } : {}) },
    select: { id: true, buyerPartyId: true, number: true, currency: true, grossTotal: true, issueDate: true },
  })
  const invoiceIds = invoices.map((invoice) => invoice.id)
  const paid = invoiceIds.length === 0 ? [] : await db.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: invoiceIds } }, _sum: { amount: true } })
  const credited = invoiceIds.length === 0 ? [] : await db.invoice.groupBy({ by: ['creditOfId'], where: { creditOfId: { in: invoiceIds }, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } })
  const written = await underpaymentsWrittenOff(db, invoiceIds)
  const requests = only.invoiceIds && !only.depositRequestIds
    ? []
    : await db.depositRequest.findMany({
        where: { companyId, status: 'OPEN', ...(only.depositRequestIds ? { id: { in: [...only.depositRequestIds] } } : {}) },
        select: { id: true, partyId: true, currency: true, amount: true, createdAt: true, order: { select: { number: true } } },
      })
  const requestIds = requests.map((request) => request.id)
  const paidRequests = requestIds.length === 0 ? [] : await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requestIds } }, _sum: { amount: true } })
  const items: OpenItem[] = [
    ...invoices.map((invoice) => ({
      kind: 'INVOICE' as const,
      id: invoice.id,
      partyId: invoice.buyerPartyId,
      number: invoice.number,
      currency: invoice.currency,
      open: openOnInvoice(invoice.grossTotal, credited.find((row) => row.creditOfId === invoice.id)?._sum.grossTotal ?? 0, (paid.find((row) => row.invoiceId === invoice.id)?._sum.amount ?? 0) + (written.get(invoice.id) ?? 0)),
      date: invoice.issueDate ? day(invoice.issueDate) : '',
    })),
    ...requests.map((request) => ({
      kind: 'DEPOSIT_REQUEST' as const,
      id: request.id,
      partyId: request.partyId,
      number: request.order?.number ?? null,
      currency: request.currency,
      open: openOnDeposit(request.amount, paidRequests.find((row) => row.depositRequestId === request.id)?._sum.amount ?? 0),
      date: businessDate(request.createdAt),
    })),
  ]
  return items.filter((item) => item.open > 0).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
}

/** The payments and supplier invoices a live accepted match already takes. */
async function takenByLines(db: Reader, companyId: string): Promise<{ payments: Set<string>; supplierInvoices: Set<string> }> {
  const live = await db.bankMatch.findMany({ where: { companyId, acceptedAt: { not: null }, reversedAt: null }, select: { paymentId: true, supplierInvoiceId: true } })
  return {
    payments: new Set(live.flatMap((row) => (row.paymentId ? [row.paymentId] : []))),
    supplierInvoices: new Set(live.flatMap((row) => (row.supplierInvoiceId ? [row.supplierInvoiceId] : []))),
  }
}

/** The names and known IBANs of these parties. */
export async function partiesOf(db: Reader, companyId: string, partyIds: readonly string[]): Promise<PartyFacts[]> {
  const ids = [...new Set(partyIds)]
  if (ids.length === 0) return []
  const parties = await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, legalName: true, tradeName: true } })
  const accepted = await db.bankMatch.findMany({ where: { companyId, partyId: { in: ids }, acceptedAt: { not: null }, reversedAt: null }, select: { partyId: true, bankLine: { select: { counterpartyIban: true } } } })
  const accounts = await db.supplierBankAccount.findMany({ where: { partyId: { in: ids } }, select: { partyId: true, iban: true } })
  return parties.map((party) => ({
    id: party.id,
    names: [party.legalName, ...(party.tradeName ? [party.tradeName] : [])],
    ibans: [...new Set([...accepted.filter((row) => row.partyId === party.id).flatMap((row) => (row.bankLine.counterpartyIban ? [row.bankLine.counterpartyIban] : [])), ...accounts.filter((row) => row.partyId === party.id).map((row) => row.iban)])],
  }))
}

/** Everything the matcher needs for the company's lines. */
export async function matchFacts(db: Reader, companyId: string): Promise<MatchFacts> {
  const items = await openItemsOf(db, companyId)
  const taken = await takenByLines(db, companyId)
  const paymentRows = await db.payment.findMany({ where: { companyId, status: 'RECEIVED', method: 'BANK_TRANSFER' }, select: { id: true, partyId: true, amount: true, currency: true, externalRef: true } })
  const payments: HandPayment[] = paymentRows.filter((row) => !taken.payments.has(row.id))
  const supplierRows = await db.supplierInvoice.findMany({ where: { companyId, kind: 'INVOICE', status: { not: 'VOIDED' } }, select: { id: true, partyId: true, number: true, currency: true, grossTotal: true, withholdingAmount: true } })
  const supplierInvoices: SupplierItem[] = supplierRows
    .filter((row) => !taken.supplierInvoices.has(row.id))
    .map((row) => ({ id: row.id, partyId: row.partyId, number: row.number, currency: row.currency, due: row.grossTotal - (row.withholdingAmount ?? 0) }))
    .filter((row) => row.due > 0)
  const parties = await partiesOf(db, companyId, [...items.map((item) => item.partyId), ...payments.map((payment) => payment.partyId), ...supplierInvoices.map((invoice) => invoice.partyId)])
  return { items, payments, supplierInvoices, parties, tolerance: (await toleranceOf(db, companyId)).amount }
}
