import type { BusinessDate } from '../core/time'
import type { Period } from '../insights/reports/definition'
import { digestDayWords, type DigestLocale } from './digest'

/**
 * "E-mail me this" for any report of the library (B-W2b-435; follow-up DG1:01 "report subscriptions for any report, not only the
 * daily production report"; design home.reports rec:Report › Schedule), pure. One ReportSubscription per person and report
 * (views.prisma: `reportKey` = the report's key, the run's filters in `params`, a site filter's value also in `siteId`), sent to
 * that person only, at its time on its weekdays on its site's clock (else the company's), in its language. The scheduler runs
 * the report AS the person (their live roles now: the rows their lists reach, money only with its grain, people figures of
 * small groups hidden) and mails how many rows it found, the first records by their own number, and the link to the report with
 * the same filters. A report that shares its rows with a module's own mail (`production.daily`: the production module sends it)
 * is subscribed there. Nothing is mailed to anyone else.
 */

/** The records a report mail names (then "and N more"). */
export const REPORT_MAIL_ROWS = 10

/** The report's title in Italian (the library's own words, apps/factory-web messages/it/home-reports.json `report.<key>.title`). */
const TITLES_IT: Readonly<Record<string, string>> = Object.freeze({
  'compliance.certificates-expiring': 'Certificati in scadenza',
  'finance.overdue-receivables': 'Scaduto dei clienti',
  'finance.stock-value': 'Valore del magazzino',
  'planning.shortages': 'Mancanze',
  'production.daily': 'Produzione giornaliera',
  'production.scrap-by-reason': 'Scarti per causa',
  'production.wip-by-stage': 'Semilavorati per fase',
  'purchasing.receipts-due': 'Arrivi attesi',
  'quality.open-ncrs': 'Non conformità aperte',
  'sales.late-orders': 'Ordini in ritardo',
  'sales.margin-by-order': 'Margine per ordine',
  'sales.open-orders': 'Ordini aperti',
  'sales.orders-in': 'Ordini acquisiti',
  'sales.shipments-on-time': 'Spedito in tempo',
})

/** The report keys whose Italian title is known (the API's registry test holds every report of the pack to it). */
export const REPORT_TITLE_KEYS: readonly string[] = Object.freeze(Object.keys(TITLES_IT))

/** A report's title in a language: the English one is the report's own (its definition's `title`). */
export const reportTitleIn = (key: string, english: string, locale: DigestLocale): string => (locale === 'it' ? (TITLES_IT[key] ?? english) : english)

const PERIOD_WORDS: Readonly<Record<Period, Readonly<Record<DigestLocale, string>>>> = Object.freeze({
  THIS_WEEK: { it: 'questa settimana', en: 'this week' },
  LAST_WEEK: { it: 'la settimana scorsa', en: 'last week' },
  THIS_MONTH: { it: 'questo mese', en: 'this month' },
  LAST_MONTH: { it: 'il mese scorso', en: 'last month' },
  LAST_8_WEEKS: { it: 'le ultime 8 settimane', en: 'the last 8 weeks' },
  NEXT_7_DAYS: { it: 'i prossimi 7 giorni', en: 'the next 7 days' },
  NEXT_30_DAYS: { it: 'i prossimi 30 giorni', en: 'the next 30 days' },
  NEXT_90_DAYS: { it: 'i prossimi 90 giorni', en: 'the next 90 days' },
})

export const periodWords = (period: string, locale: DigestLocale): string | null => (period in PERIOD_WORDS ? PERIOD_WORDS[period as Period][locale] : null)

export interface ReportMailInput {
  readonly title: string
  readonly today: BusinessDate
  /** What the run looked at, said: the period's words and the site's code (each null when not set). */
  readonly period: string | null
  readonly site: string | null
  /** How many rows the run found (complete: every row; else "at least"). */
  readonly rows: number
  readonly complete: boolean
  /** The records of the rows by their own number, each once, in the report's order (at most REPORT_MAIL_ROWS are named). */
  readonly records: readonly string[]
  /** Columns left out because of the person's rights (in the report's own words: a count is enough here). */
  readonly leftOut: number
  readonly link: string
  readonly settings: string
}

/** The mail's subject and lines in a language. */
export function reportMail(input: ReportMailInput, locale: DigestLocale): { readonly subject: string; readonly lines: readonly string[] } {
  const it = locale === 'it'
  const when = digestDayWords(input.today, locale)
  const subject = `${input.title} · ${when}`
  const scope = [input.period, input.site].filter((part): part is string => part !== null && part !== '')
  const count = input.complete ? String(input.rows) : it ? `almeno ${input.rows}` : `at least ${input.rows}`
  const lines: string[] = []
  lines.push(it ? `${input.title}${scope.length > 0 ? ` (${scope.join(', ')})` : ''}, ${when}.` : `${input.title}${scope.length > 0 ? ` (${scope.join(', ')})` : ''}, ${when}.`)
  lines.push(input.rows === 0 ? (it ? 'Nessuna riga con questi filtri.' : 'No rows for these filters.') : it ? `Righe trovate: ${count}.` : `Rows found: ${count}.`)
  const named = input.records.slice(0, REPORT_MAIL_ROWS)
  if (named.length > 0) {
    const more = input.records.length - named.length
    lines.push(`${it ? 'Prime' : 'First'}: ${named.join(', ')}${more > 0 ? (it ? ` e altre ${more}` : ` and ${more} more`) : ''}.`)
  }
  if (input.leftOut > 0) lines.push(it ? 'Alcune colonne restano fuori per i tuoi permessi: il report le dice.' : 'Some columns are left out because of your rights: the report says which.')
  lines.push('')
  lines.push(it ? `Apri il report con gli stessi filtri: ${input.link}` : `Open the report with the same filters: ${input.link}`)
  lines.push(it ? `Cambia o ferma questa e-mail: ${input.settings}` : `Change or stop this e-mail: ${input.settings}`)
  return { subject, lines }
}
