import type { UnmappedKey } from '@nexus/factory-domain/accounting/checks'
import { balances, costEntry, entryDocument, moneyEntry, purchaseEntry, salesEntry, unmappedOf, type JournalEntry } from '@nexus/factory-domain/accounting/journals/entries'
import type { DocumentRows } from '@nexus/factory-domain/accounting/journals'
import type { AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import type { PeriodFacts } from '../facts'

/**
 * The month's journal entries with mapped accounts (B-W2b-408; FIN-151), from the facts the export reads: each document of
 * the journal packages asked for, as factory-domain accounting/journals/entries.ts makes it. Only when the facts hold the
 * lines, the countries and the mapping (the company's journals switched on, or the integrity checks' own read).
 */

/** Σ the roundings of a stored VAT summary (Invoice.vatSummary: the lines' net amounts plus them make the net total). */
export function roundingOf(vatSummary: unknown): number {
  if (!Array.isArray(vatSummary)) return 0
  return vatSummary.reduce((sum: number, raw) => sum + (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).rounding === 'number' ? ((raw as Record<string, unknown>).rounding as number) : 0), 0)
}

export function journalEntriesOf(facts: PeriodFacts, packages: readonly AccountingPackage[]): JournalEntry[] {
  const bridge = facts.bridge
  if (!bridge.entriesRead) return []
  const wanted = new Set(packages)
  const country = (code: string): string | null => bridge.countries.get(code) ?? null
  const out: JournalEntry[] = []
  if (wanted.has('SALES_JOURNAL')) {
    const summaries = new Map(facts.totals.map((invoice) => [invoice.id, invoice.vatSummary]))
    for (const invoice of facts.sales) {
      out.push(
        salesEntry(
          {
            id: invoice.id,
            number: invoice.number,
            version: invoice.version,
            docType: invoice.docType,
            issueDate: invoice.issueDate,
            currency: invoice.currency,
            netTotal: invoice.netTotal,
            grossTotal: invoice.grossTotal,
            summary: invoice.summary,
            rounding: roundingOf(summaries.get(invoice.id)),
            lines: bridge.salesLines.get(invoice.id) ?? [],
            partyCode: invoice.buyerCode,
            partyName: invoice.buyer.name,
            partyCountry: invoice.buyer.country,
          },
          bridge.codes,
        ),
      )
    }
  }
  if (wanted.has('PURCHASES_JOURNAL')) {
    for (const invoice of facts.purchases ?? []) {
      out.push(purchaseEntry({ ...invoice, lines: bridge.purchaseLines.get(invoice.id) ?? [], supplierCountry: country(invoice.supplierCode) }))
    }
  }
  if (wanted.has('PAYMENTS')) {
    for (const payment of facts.payments) {
      out.push(moneyEntry('Payment', { id: payment.id, reference: payment.reference, version: payment.version, day: payment.receivedOn, method: payment.method, currency: payment.currency, amount: payment.amount, partyCode: payment.customerCode, partyName: payment.customerName, partyCountry: country(payment.customerCode) }))
    }
    for (const refund of facts.refunds) {
      out.push(moneyEntry('Refund', { id: refund.id, reference: refund.reference, version: refund.version, day: refund.paidOn, method: refund.method, currency: refund.currency, amount: refund.amount, partyCode: refund.customerCode, partyName: refund.customerName, partyCountry: country(refund.customerCode) }))
    }
  }
  if (wanted.has('COST_OF_SALES')) for (const figure of bridge.costFigures ?? []) out.push(costEntry(figure))
  return out
}

/** The entries file's rows per package (each entry a document of its package). */
export function entryDocumentsOf(entries: readonly JournalEntry[], facts: PeriodFacts): Map<AccountingPackage, DocumentRows[]> {
  const out = new Map<AccountingPackage, DocumentRows[]>()
  for (const entry of entries) out.set(entry.package, [...(out.get(entry.package) ?? []), entryDocument(entry, facts.bridge.mapping)])
  return out
}

/** The keys the entries post with no account in force on their day, with how many documents need each. */
export function unmappedKeysOf(entries: readonly JournalEntry[], facts: PeriodFacts): UnmappedKey[] {
  const counts = new Map<string, { kind: string; key: string; documents: number }>()
  for (const entry of entries) {
    const seen = new Set<string>()
    for (const line of unmappedOf(entry, facts.bridge.mapping)) {
      const id = `${line.kind}|${line.key}`
      if (seen.has(id)) continue
      seen.add(id)
      const found = counts.get(id) ?? { kind: line.kind, key: line.key, documents: 0 }
      found.documents += 1
      counts.set(id, found)
    }
  }
  return [...counts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
}

export const unbalancedOf = (entries: readonly JournalEntry[]) => entries.filter((entry) => !balances(entry)).map((entry) => ({ recordType: entry.recordType, recordId: entry.recordId, number: entry.number }))
