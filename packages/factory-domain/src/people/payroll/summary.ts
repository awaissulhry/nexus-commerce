import { monthLabel } from '../../accounting/periods'
import type { BusinessDate } from '../../core/time'
import { Dec } from '../../tax/decimal'
import { payrollFileName, type FileContext } from './layouts'
import { CODE_MEANINGS, isFixedCode } from './codes'
import { codeSums, type PayrollValue, type ValueChange } from './values'

/**
 * The summary of a payroll export (B-W2b-54; design people.payroll new tab "Export summary (PDF)": totals per employee for the
 * consultant's check), pure: what it says is decided here, apps/factory-api paints the PDF. Italian only: one document, for
 * the consultant. By employee code and never by name: the file and its summary travel by link. A correction says what it
 * replaces and lists what changed from → to.
 */

export interface SummaryRow {
  readonly employeeCode: string
  readonly voice: string
  readonly code: string
  readonly words: string
  readonly quantity: string
  readonly amount: string
}

export interface SummaryBlock {
  readonly title: string
  readonly note: string | null
  readonly rows: readonly SummaryRow[]
}

export interface SummaryChange {
  readonly employeeCode: string
  readonly words: string
  readonly from: string
  readonly to: string
}

export interface PayrollSummary {
  readonly title: string
  readonly heading: string
  readonly facts: readonly string[]
  readonly notes: readonly string[]
  readonly changes: readonly SummaryChange[]
  readonly blocks: readonly SummaryBlock[]
  readonly totals: readonly SummaryRow[]
  readonly foot: string
  readonly pageLabel: string
  readonly fileName: string
  readonly createdAt: Date
}

export interface SummaryFacts {
  readonly context: FileContext
  readonly company: { readonly legalName: string; readonly vatNumber: string | null }
  readonly layoutName: string
  readonly confirmed: boolean
  readonly values: readonly PayrollValue[]
  readonly changes: readonly ValueChange[]
  /** A correction: the export it replaces. */
  readonly replaces: { readonly number: string | null; readonly revision: number } | null
  readonly leftOut: number
  readonly createdAt: Date
}

const italianDay = (date: BusinessDate): string => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`
const comma = (value: string): string => value.replace('.', ',')
/** Minor units as Italian text ("1.234,56"); the summary is read, not imported. */
export function amountWords(minor: number | null, currency: string | null): string {
  if (minor === null) return ''
  const [whole = '0', cents = '00'] = new Dec(minor).div(100).toFixed(2).split('.')
  const negative = whole.startsWith('-')
  const digits = (negative ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${negative ? '-' : ''}${digits},${cents}${currency ? ` ${currency}` : ''}`
}

const quantityWords = (value: { readonly quantity: string | null; readonly unit: string | null }): string => (value.quantity === null ? '' : value.unit === 'PIECES' ? `${value.quantity} pz` : `${comma(value.quantity)} h`)
const italianMeaning = (code: string, words: string): string => (isFixedCode(code) ? CODE_MEANINGS[code].it : words)

const rowOf = (employeeCode: string, value: { readonly code: string; readonly providerCode: string | null; readonly meaning: string; readonly quantity: string | null; readonly unit: string | null; readonly amount: number | null; readonly currency: string | null }): SummaryRow => ({
  employeeCode,
  voice: value.providerCode ?? '',
  code: value.code,
  words: italianMeaning(value.code, value.meaning),
  quantity: quantityWords(value),
  amount: amountWords(value.amount, value.currency),
})

const changeSide = (quantity: string | null, unit: string | null, amount: number | null, currency: string | null, voice: string | null): string => [quantityWords({ quantity, unit }), amountWords(amount, currency), voice ? `(${voice})` : ''].filter((part) => part !== '').join(' ') || '-'

export function payrollSummary(facts: SummaryFacts): PayrollSummary {
  const { context, company, values } = facts
  const label = monthLabel(context.month, 'it')
  const codes = [...new Set(values.map((value) => value.employeeCode))]
  const blocks = codes.map((employeeCode): SummaryBlock => {
    const own = values.filter((value) => value.employeeCode === employeeCode)
    const lastDay = own.find((value) => value.lastDay !== null)?.lastDay ?? null
    return { title: `Matricola ${employeeCode}`, note: lastDay ? `cessazione: ultimo giorno ${italianDay(lastDay)}` : null, rows: own.map((value) => rowOf(employeeCode, value)) }
  })
  return {
    title: 'Riepilogo paghe',
    heading: `${company.legalName} · ${label}`,
    facts: [...(company.vatNumber ? [`P. IVA ${company.vatNumber}`] : []), `Versione v${context.revision}`, `Tracciato: ${facts.layoutName}`, `Persone: ${codes.length}`],
    notes: [
      ...(facts.replaces ? [`Sostituisce la versione v${facts.replaces.revision}${facts.replaces.number ? ` (${facts.replaces.number})` : ''}, che resta conservata.`] : []),
      ...(facts.confirmed ? [] : ['Tracciato da confermare con il consulente del lavoro.']),
      ...(facts.leftOut > 0 ? [`Persone di agenzia o esterne non comprese: ${facts.leftOut}.`] : []),
      'Ore in centesimi. Le ore notturne e festive sono "di cui". Nexus non elabora le paghe: questi sono i dati per il consulente.',
    ],
    changes: facts.changes.map((change) => ({
      employeeCode: change.employeeCode,
      words: italianMeaning(change.code, change.meaning),
      from: changeSide(change.fromQuantity, change.unit, change.fromAmount, change.currency, change.fromProviderCode),
      to: changeSide(change.toQuantity, change.unit, change.toAmount, change.currency, change.toProviderCode),
    })),
    blocks,
    totals: codeSums(values).map((sum) => rowOf('', sum)),
    foot: 'Riepilogo per il consulente del lavoro. Dati personali: non inoltrare.',
    pageLabel: 'Pagina {page} di {pages}',
    fileName: payrollFileName(context, '_riepilogo', 'pdf'),
    createdAt: facts.createdAt,
  }
}
