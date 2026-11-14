import type { Row } from '@nexus/factory-domain/accounting/journals'
import {
  PURCHASES_REGISTER_HEADINGS,
  purchasesRegisterDocument,
  SALES_REGISTER_HEADINGS,
  salesRegisterDocument,
  VAT_TOTALS_HEADINGS,
  vatTotalCells,
  vatTotals,
} from '@nexus/factory-domain/accounting/vat-registers/registers'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import type { PeriodFacts } from '../facts'

/**
 * The VAT registers package's files (B-W2b-408; FIN-106): three CSV in the DEFAULT layout — the sales register, the
 * purchases register and the month's totals with the VAT due. WHOLE: a re-export writes them whole again (the caller
 * leaves the package out when nothing behind it changed).
 */

export interface Sheet {
  /** In the file name, after the package's slug. */
  readonly suffix: string
  readonly headings: readonly string[]
  readonly rows: readonly Row[]
  /** Added to the file's note line. */
  readonly note: string
}

export function vatRegisterSheets(facts: PeriodFacts, language: ExportLocale): Sheet[] {
  const purchases = facts.purchases ?? []
  const it = language === 'it'
  return [
    { suffix: '_sales', headings: SALES_REGISTER_HEADINGS[language], rows: facts.sales.flatMap((invoice) => salesRegisterDocument(invoice).rows), note: it ? 'registro IVA vendite' : 'sales VAT register' },
    { suffix: '_purchases', headings: PURCHASES_REGISTER_HEADINGS[language], rows: purchases.flatMap((invoice) => purchasesRegisterDocument(invoice).rows), note: it ? 'registro IVA acquisti' : 'purchases VAT register' },
    {
      suffix: '_totals',
      headings: VAT_TOTALS_HEADINGS[language],
      rows: vatTotals(facts.sales, purchases).map(vatTotalCells),
      note: it ? "totali del mese e IVA del periodo (vendite meno acquisti): la liquidazione è del commercialista" : "the month's totals and VAT (sales less purchases): the settlement is the accountant's",
    },
  ]
}
