import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { overdueFinding, overdueOf, type RuleFinding } from '@nexus/factory-domain/sales/quote-warnings/rules'
import { openInvoices } from '../../receivables/store'
import type { Reader } from '../quotes/store'

/**
 * An overdue account (B-W2b-294; SAL-147 "overdue"; design quote.lines.warnings "Overdue amount … — warn"): a WARNING of the
 * quote's Warnings when its customer has issued invoices of the quote's company with an instalment past its due day still
 * open (receivables/store openInvoices: gross − credit notes − allocations, the oldest instalments paid first, as the ageing
 * reads them). The words carry no amount; the amount per currency is in the details, price grain. It is a fact of the
 * customer, not a line rule: the send and the order are B-W2b-304's credit check's (SAL-148: the overdue part, the free credit,
 * the limit), so it is said here and stops nothing.
 */
export async function overdueWarning(db: Reader, scope: { readonly companyId: string; readonly partyId: string }, today: BusinessDate): Promise<{ readonly finding: RuleFinding; readonly details: Readonly<Record<string, unknown>> } | null> {
  const invoices = await openInvoices(db, { companyId: scope.companyId, partyId: scope.partyId, asOf: today })
  const summary = overdueOf(
    invoices.flatMap((invoice) => invoice.instalments.map((instalment) => ({ invoiceNumber: invoice.number || invoice.id, dueDate: instalment.dueDate, open: instalment.open, currency: invoice.currency }))),
    today,
  )
  if (!summary) return null
  const party = await db.party.findUnique({ where: { id: scope.partyId }, select: { id: true, legalName: true } })
  if (!party) return null
  return {
    finding: overdueFinding(party, summary),
    details: {
      invoices: summary.invoices,
      oldestDueDate: summary.oldestDueDate,
      daysLate: summary.daysLate,
      // Each amount marked on its own: inside free JSON a key that looks like money is never shown unmarked.
      overdue: summary.amounts.map((entry) => ({ currency: entry.currency, amount: markMoney('price', entry.amount) })),
    },
  }
}
