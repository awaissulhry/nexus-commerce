import { INTRASTAT_HEADINGS, intrastatCells, intrastatFileRows } from '@nexus/factory-domain/accounting/intrastat'
import { fileRows, PAYMENTS_HEADINGS, PURCHASES_JOURNAL_HEADINGS, SALES_JOURNAL_HEADINGS, type Row } from '@nexus/factory-domain/accounting/journals'
import type { ManifestEntry, PackageDifference } from '@nexus/factory-domain/accounting/manifest'
import { PACKAGE_RULES, type AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import { monthLabel, type Period } from '@nexus/factory-domain/accounting/periods'
import { VALUATION_HEADINGS, valuationCells } from '@nexus/factory-domain/accounting/year-end'
import { cellText, csvText, type ExportLocale } from '@nexus/factory-domain/views/exports'
import type { PackageDocuments, PeriodFacts } from './facts'
import type { CompanyRow } from './store'

/**
 * The files of an accounting export (B-W2a-39), in Nexus's DEFAULT layout (Q7: to confirm with the accountant): CSV
 * (factory-domain views/exports csvText: a UTF-8 BOM, `;` and the decimal comma in Italian, `,` and the dot in English,
 * days ISO) with one note line above the header naming the company, the month, the package and the layout; and, in the
 * year-end pack, the signed-off inventories' frozen valued lists COPIED as they are (their PDF and sheet).
 *
 * A first export writes every package asked for (an empty month: the header only). A re-export writes a journal's new,
 * changed and removed documents only, and Intrastat or the year-end pack whole when anything behind them changed
 * (packages nothing changed in are left out of it). The batch's number is given in the export's command, after the
 * files are stored: a file names the company, the month and the package, and the export record names the number.
 */

export interface PlannedFile {
  readonly package: AccountingPackage
  readonly format: 'CSV' | 'PDF' | 'XLSX'
  readonly rowCount: number
  readonly name: string
  readonly contentType: string
  /** Bytes to store, or null for a copy of a stored file. */
  readonly body: Uint8Array | null
  readonly copyOf: string | null
}

export interface FilePlan {
  readonly files: readonly PlannedFile[]
  /** The packages this batch carries (a re-export leaves out those nothing changed in). */
  readonly packages: readonly AccountingPackage[]
}

const CSV = 'text/csv'
const PDF = 'application/pdf'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const csv = (locale: ExportLocale, headings: readonly string[], rows: readonly Row[], note: string): Uint8Array =>
  Buffer.from(csvText({ locale, header: headings, rows: rows.map((row) => headings.map((_, index) => cellText(row[index] ?? null, locale))), note }), 'utf8')

const fileName = (company: CompanyRow, period: Period, pkg: AccountingPackage, reExport: boolean, extension: string, suffix = ''): string =>
  `${company.code}_${period.month}_${PACKAGE_RULES[pkg].slug}${suffix}${reExport ? '_changes' : ''}.${extension}`.replace(/[^A-Za-z0-9._-]+/g, '-')

export interface PlanInput {
  readonly company: CompanyRow
  readonly period: Period
  readonly packages: readonly AccountingPackage[]
  readonly facts: PeriodFacts
  readonly documents: PackageDocuments
  /** A re-export: the difference against the batches before, and their numbers. Null: a first export. */
  readonly reExport: { readonly entries: readonly ManifestEntry[]; readonly packages: readonly PackageDifference[]; readonly earlier: readonly string[] } | null
  readonly language: ExportLocale
}

/** What the export stores, package by package. */
export function planFiles(input: PlanInput): FilePlan {
  const { company, period, facts, language } = input
  const reExport = input.reExport
  const changed = (pkg: AccountingPackage): boolean => {
    if (!reExport) return true
    const tally = reExport.packages.find((entry) => entry.package === pkg)
    return tally !== undefined && tally.new + tally.changed + tally.removed > 0
  }
  const note = (pkg: AccountingPackage): string => {
    const title = PACKAGE_RULES[pkg].words[language]
    const base = `${company.code} ${company.legalName} · ${monthLabel(period.month, language)} · ${title} · ${language === 'it' ? 'tracciato DEFAULT (da confermare con il commercialista)' : 'layout DEFAULT (to confirm with the accountant)'}`
    if (!reExport) return base
    const earlier = reExport.earlier.join(', ')
    if (PACKAGE_RULES[pkg].scope === 'WHOLE') return `${base} · ${language === 'it' ? `sostituisce il file di ${earlier}` : `replaces the file of ${earlier}`}`
    return `${base} · ${language === 'it' ? `solo le variazioni da ${earlier}` : `only the changes since ${earlier}`}`
  }
  const files: PlannedFile[] = []
  const carried: AccountingPackage[] = []
  for (const pkg of input.packages) {
    if (!changed(pkg)) continue
    carried.push(pkg)
    const entries = reExport ? reExport.entries.filter((entry) => entry.package === pkg) : null
    const journal = (headings: readonly string[], numberColumn: number) => {
      const rows = fileRows(input.documents.journals.get(pkg) ?? [], entries, headings.length - 1, numberColumn)
      files.push({ package: pkg, format: 'CSV', rowCount: rows.length, name: fileName(company, period, pkg, reExport !== null, 'csv'), contentType: CSV, body: csv(language, headings, rows, note(pkg)), copyOf: null })
    }
    switch (pkg) {
      case 'SALES_JOURNAL':
        journal(SALES_JOURNAL_HEADINGS[language], 0)
        break
      case 'PURCHASES_JOURNAL':
        journal(PURCHASES_JOURNAL_HEADINGS[language], 0)
        break
      case 'PAYMENTS':
        journal(PAYMENTS_HEADINGS[language], 2)
        break
      case 'INTRASTAT': {
        const rows = intrastatFileRows(facts.intrastat ?? []).map(intrastatCells)
        files.push({ package: pkg, format: 'CSV', rowCount: rows.length, name: fileName(company, period, pkg, reExport !== null, 'csv'), contentType: CSV, body: csv(language, INTRASTAT_HEADINGS[language], rows, note(pkg)), copyOf: null })
        break
      }
      case 'YEAR_END_STOCK': {
        const yearEnd = facts.yearEnd!
        for (const count of yearEnd.counts.filter((entry) => entry.status === 'SIGNED_OFF')) {
          const suffix = `_${count.number}`
          if (count.pdfFileId) files.push({ package: pkg, format: 'PDF', rowCount: 0, name: fileName(company, period, pkg, false, 'pdf', suffix), contentType: PDF, body: null, copyOf: count.pdfFileId })
          if (count.sheetFileId) files.push({ package: pkg, format: 'XLSX', rowCount: 0, name: fileName(company, period, pkg, false, 'xlsx', suffix), contentType: XLSX, body: null, copyOf: count.sheetFileId })
        }
        const rows = yearEnd.valuation.map(valuationCells)
        files.push({ package: pkg, format: 'CSV', rowCount: rows.length, name: fileName(company, period, pkg, reExport !== null, 'csv', '_valuation'), contentType: CSV, body: csv(language, VALUATION_HEADINGS[language], rows, `${note(pkg)} · ${language === 'it' ? `valori al ${yearEnd.day}, metodo di valutazione da confermare` : `values at the end of ${yearEnd.day}, costing method to confirm`}`), copyOf: null })
        break
      }
      default:
        // W2b packages are refused before a plan is made.
        throw new Error(`planFiles(): ${pkg} has no file in W2a.`)
    }
  }
  return { files, packages: carried }
}
