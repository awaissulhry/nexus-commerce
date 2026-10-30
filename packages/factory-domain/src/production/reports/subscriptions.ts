import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * The daily production report by e-mail (B-W2a-38; MES-301 "sent each morning"; design production.reports
 * "Email me this report": time, recipients, language), pure. One ReportSubscription per recipient (views.prisma), report
 * key `production.daily`, for ONE site; off by default (no row = nothing is sent; quiet defaults, PLT-142). The
 * scheduler sends each due one once a day, at its time on its weekdays in the site's zone, with the report of the site's
 * previous working day. The mail holds lines and work centres only, never a person (Statuto dei Lavoratori art. 4).
 */

export const DAILY_REPORT_KEY = 'production.daily'
export const REPORT_KEYS = [DAILY_REPORT_KEY] as const
export type ReportKey = (typeof REPORT_KEYS)[number]

export const REPORT_LOCALES = ['it', 'en'] as const
export type ReportLocale = (typeof REPORT_LOCALES)[number]

export const DAILY_DEFAULT_TIME = '07:00'
export const DAILY_DEFAULT_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])
/** The most people one Subscribe names. */
export const MAX_RECIPIENTS = 50

const SEND_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

export interface SubscriptionSettings {
  readonly sendTime: string
  readonly weekdays: readonly number[]
}

/** What is wrong with a subscription's time and weekdays (empty: nothing). */
export function subscriptionProblems(settings: SubscriptionSettings): Issue[] {
  const problems: Issue[] = []
  if (!SEND_TIME.test(settings.sendTime)) problems.push({ path: 'body/sendTime', message: 'A time of day is HH:MM (07:00).' })
  const days = settings.weekdays
  if (days.length === 0 || days.some((day, index) => !Number.isInteger(day) || day < 1 || day > 7 || (index > 0 && day <= days[index - 1]!)))
    problems.push({ path: 'body/weekdays', message: 'Weekdays are 1 (Monday) to 7 (Sunday), ascending, at least one.' })
  return problems
}

/** A stored or asked language, else the person's own, else Italian (the factory's language). */
export function reportLocaleOf(asked: string | null | undefined, person?: string | null): ReportLocale {
  const pick = (value: string | null | undefined) => (value ?? '').toLowerCase().slice(0, 2)
  const first = pick(asked)
  if (first === 'it' || first === 'en') return first
  return pick(person) === 'en' ? 'en' : 'it'
}

export interface MailLane {
  /** "L1 Linea 1", or a work centre's code and name. */
  readonly label: string
  readonly kind: 'LINE' | 'WORK_CENTRE'
  readonly good: number
  readonly scrap: number
  readonly rework: number
  readonly efficiencyPct: string | null
}

export interface MailReport {
  readonly site: { readonly code: string; readonly name: string }
  readonly day: BusinessDate
  readonly lanes: readonly MailLane[]
  readonly totals: { readonly good: number; readonly scrap: number; readonly rework: number }
  /** The report page for that day and site. */
  readonly link: string
}

const WEEKDAYS: Readonly<Record<ReportLocale, readonly string[]>> = {
  it: ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'],
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
}
const MONTHS: Readonly<Record<ReportLocale, readonly string[]>> = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
}

/** "giovedì 29 ottobre 2026" / "Thursday 29 October 2026" (written out here: the same on every server, whatever its ICU). */
export function dayWords(day: BusinessDate, locale: ReportLocale): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const weekday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7
  return `${WEEKDAYS[locale][weekday]} ${date} ${MONTHS[locale][month - 1]} ${year}`
}

const pctWords = (pct: string, locale: ReportLocale): string => (locale === 'it' ? `${pct.replace('.', ',')} %` : `${pct} %`)

/** The mail's subject and text lines in a language: totals, then one line per lane, then where to read more. */
export function dailyReportMail(report: MailReport, locale: ReportLocale): { readonly subject: string; readonly lines: readonly string[] } {
  const it = locale === 'it'
  const when = dayWords(report.day, locale)
  const subject = it ? `Produzione del ${when} · ${report.site.code}` : `Production on ${when} · ${report.site.code}`
  const figures = (lane: { good: number; scrap: number; rework: number }) =>
    it ? `${lane.good} buoni · ${lane.scrap} scarti · ${lane.rework} rilavorazioni` : `${lane.good} good · ${lane.scrap} scrap · ${lane.rework} rework`
  const lines: string[] = []
  lines.push(it ? `${report.site.name} (${report.site.code}), ${when}.` : `${report.site.name} (${report.site.code}), ${when}.`)
  lines.push(it ? `In totale: ${figures(report.totals)}.` : `In all: ${figures(report.totals)}.`)
  lines.push('')
  if (report.lanes.length === 0) lines.push(it ? 'Nessuna lavorazione registrata dal reparto in questo giorno.' : 'The floor recorded no work on this day.')
  for (const lane of report.lanes) {
    const efficiency =
      lane.kind === 'LINE'
        ? lane.efficiencyPct === null
          ? it
            ? ' · efficienza: nessun minuto previsto'
            : ' · efficiency: no minutes planned'
          : it
            ? ` · efficienza ${pctWords(lane.efficiencyPct, locale)}`
            : ` · efficiency ${pctWords(lane.efficiencyPct, locale)}`
        : ''
    lines.push(`• ${lane.label}: ${figures(lane)}${efficiency}`)
  }
  lines.push('')
  lines.push(it ? 'Numeri per linea, modello e taglia, mai per persona.' : 'Figures per line, style and size, never per person.')
  lines.push(it ? `Il report per modello e taglia: ${report.link}` : `The report by style and size: ${report.link}`)
  return { subject, lines }
}
