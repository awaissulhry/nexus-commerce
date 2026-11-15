import { isTimeZone, localInstant, plusDays } from '../calendars/dates'
import type { Issue } from '../core/errors'
import type { Permission } from '../core/permissions'
import { businessDate, type BusinessDate } from '../core/time'
import { formatMoney } from '../documents/format'
import type { CurrencyCode, MinorUnits } from '../core/money'

/**
 * The owner digest (B-W2b-435; ANA-032 "every morning: yesterday's shipped and late orders, new orders, WIP stuck, alerts and
 * approvals waiting, in Italian or English"; design home.reports `digest`, home.today ⋯ "Daily digest by e-mail"), pure.
 *
 * One DigestSetting per office person (factory-db insights-depth.prisma, B-W2b-381): OFF until they turn it on, a time of day on
 * a clock (the site's: "07:30 site time"), ISO weekdays, a language and the sections it lists, for one company or for every
 * company they see (the Owner's group digest). It goes out only while the company's switch is on too (InsightsSettings, OFF by
 * default: the Owner's rule of 11-13); a group digest lists only the companies whose switch is on. What it lists is what the
 * person may read now (their live roles): a section of a list they cannot read is left out and said; money only with its grain.
 * No figure about one person, ever (Statuto dei Lavoratori art. 4): orders, work orders, lines, alerts and approvals only.
 */

export const DIGEST_SECTIONS = ['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS'] as const
export type DigestSection = (typeof DIGEST_SECTIONS)[number]

export const DIGEST_LOCALES = ['it', 'en'] as const
export type DigestLocale = (typeof DIGEST_LOCALES)[number]

export const DIGEST_DEFAULTS = Object.freeze({
  sendTime: '07:30',
  timeZone: 'Europe/Rome',
  weekdays: Object.freeze([1, 2, 3, 4, 5]) as readonly number[],
  locale: 'it' as DigestLocale,
  sections: DIGEST_SECTIONS as readonly DigestSection[],
})

/** A work order is "stuck" when nothing was reported on it for more than this many days (design home.today: "WIP stuck over 2 days"). */
export const WIP_STUCK_DAYS = 2
/** The records a section names in the mail and the preview (then "and N more"). */
export const DIGEST_ITEMS = 5

export const digestKey = (userId: string): string => `digest:${userId}`
export const insightsKey = (companyId: string): string => `insights:${companyId}`

/** What each section reads (besides home.view): a section of a list the person cannot read is left out, and said. */
export const SECTION_NEEDS: Readonly<Record<DigestSection, readonly Permission[]>> = Object.freeze({
  SHIPPED: ['orders.view'],
  LATE: ['orders.view'],
  NEW_ORDERS: ['orders.view'],
  // The WIP drill of the metric layer (B-W2b-429): the KPI library and the production reports.
  WIP_STUCK: ['home.kpis.view', 'production.reports.view'],
  ALERTS: ['home.view'],
  APPROVALS: ['home.view'],
})

const SEND_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

export const isDigestSection = (value: unknown): value is DigestSection => typeof value === 'string' && (DIGEST_SECTIONS as readonly string[]).includes(value)

export interface DigestSettings {
  readonly sendTime: string
  readonly timeZone: string
  readonly weekdays: readonly number[]
  readonly locale: string
  readonly sections: readonly string[]
}

/** What is wrong with a digest's settings, in words with the field's path (empty: nothing). The database holds the same. */
export function settingProblems(settings: DigestSettings): Issue[] {
  const problems: Issue[] = []
  if (!SEND_TIME.test(settings.sendTime)) problems.push({ path: 'body/sendTime', message: 'A time of day is HH:MM (07:30).' })
  if (!isTimeZone(settings.timeZone)) problems.push({ path: 'body/timeZone', message: 'Choose a known time zone (Europe/Rome).' })
  const days = settings.weekdays
  if (days.length === 0 || days.some((day, index) => !Number.isInteger(day) || day < 1 || day > 7 || (index > 0 && day <= days[index - 1]!)))
    problems.push({ path: 'body/weekdays', message: 'Weekdays are 1 (Monday) to 7 (Sunday), ascending, each once, at least one.' })
  if (!(DIGEST_LOCALES as readonly string[]).includes(settings.locale)) problems.push({ path: 'body/locale', message: 'The digest is written in Italian (it) or English (en).' })
  if (settings.sections.length === 0 || settings.sections.some((section, index) => !isDigestSection(section) || settings.sections.indexOf(section) !== index))
    problems.push({ path: 'body/sections', message: 'Choose at least one section, each once.' })
  return problems
}

/** The sections in the design's order (what a person picked, put in order). */
export const sectionsInOrder = (sections: readonly string[]): DigestSection[] => DIGEST_SECTIONS.filter((section) => sections.includes(section))

const minuteOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
const weekdayOf = (day: BusinessDate): number => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1

/**
 * When it goes out next: the first of its weekdays at its time on its clock that is still to come (today's time already passed,
 * or today's digest already went out: the next day). Null without a weekday (never: the settings hold one).
 */
export function nextSendAt(settings: Pick<DigestSettings, 'sendTime' | 'timeZone' | 'weekdays'>, now: Date, sentToday: boolean): Date | null {
  if (!SEND_TIME.test(settings.sendTime) || !isTimeZone(settings.timeZone)) return null
  const today = businessDate(now, settings.timeZone)
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = plusDays(today, offset)
    if (!settings.weekdays.includes(weekdayOf(day))) continue
    const at = localInstant(day, minuteOf(settings.sendTime), settings.timeZone)
    if (offset === 0 && (sentToday || at.getTime() <= now.getTime())) continue
    return at
  }
  return null
}

/** Is it due now: one of its weekdays, its time reached on its clock, and not gone out today on that clock. */
export function digestDueNow(settings: Pick<DigestSettings, 'sendTime' | 'timeZone' | 'weekdays'>, lastSentAt: Date | null, now: Date): boolean {
  if (!SEND_TIME.test(settings.sendTime) || !isTimeZone(settings.timeZone)) return false
  const today = businessDate(now, settings.timeZone)
  if (lastSentAt !== null && businessDate(lastSentAt, settings.timeZone) === today) return false
  if (!settings.weekdays.includes(weekdayOf(today))) return false
  return localInstant(today, minuteOf(settings.sendTime), settings.timeZone).getTime() <= now.getTime()
}

/** Why a digest would not go out now, or null: it is off; no company it looks at has its morning e-mail switched on. */
export type DigestHeld = 'OFF' | 'MAIL_OFF'
export function digestHeld(enabled: boolean, switchedOn: number): DigestHeld | null {
  if (!enabled) return 'OFF'
  if (switchedOn === 0) return 'MAIL_OFF'
  return null
}

// ---- what a digest says ------------------------------------------------------------------------------------------------------

export interface DigestItem {
  /** The record's own number or label (SO-2026-0012, WO-0098): the same in both languages. */
  readonly label: string
  /** Days late (LATE), days waited (WIP_STUCK); null elsewhere. */
  readonly days: number | null
  /** The line's code (WIP_STUCK), else null. */
  readonly place: string | null
  /** The record it names (the preview opens it), or null. */
  readonly record: { readonly type: string; readonly id: string } | null
}

export interface DigestAmount {
  readonly minor: MinorUnits
  readonly currency: CurrencyCode
  readonly grain: 'price' | 'cost'
}

export interface DigestSectionContent {
  readonly section: DigestSection
  /** READY; NO_ACCESS (left out: a list the person cannot read); FAILED (it could not be read this time). */
  readonly state: 'READY' | 'NO_ACCESS' | 'FAILED'
  /** The section's count: shipments, late orders, new orders, stuck work orders, alerts, approvals. */
  readonly count: number
  /** ALERTS: of them urgent, WIP_STUCK: garments waiting; else null. */
  readonly extra: number | null
  /** SHIPPED: yesterday's shipped on time in percent (the KPI delivery.shipped_on_time, "93.5"), else null. */
  readonly percent: string | null
  /** NEW_ORDERS: their value (price), WIP_STUCK: their value at cost — only with the grain, in one currency; else null. */
  readonly amount: DigestAmount | null
  readonly items: readonly DigestItem[]
}

export interface DigestContent {
  /** The day it looks back on (yesterday on the digest's clock) and today. */
  readonly day: BusinessDate
  readonly today: BusinessDate
  /** The companies it covers, by name (a group digest: the switched-on ones). */
  readonly companies: readonly string[]
  readonly sections: readonly DigestSectionContent[]
}

const WEEKDAYS: Readonly<Record<DigestLocale, readonly string[]>> = {
  it: ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'],
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
}
const MONTHS: Readonly<Record<DigestLocale, readonly string[]>> = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
}

/** "mercoledì 28 ottobre" / "Wednesday 28 October" (written out here: the same on every server, whatever its ICU). */
export function digestDayWords(day: BusinessDate, locale: DigestLocale): string {
  const [, month, date] = day.split('-').map(Number) as [number, number, number]
  return `${WEEKDAYS[locale][weekdayOf(day) - 1]} ${date} ${MONTHS[locale][month - 1]}`
}

const plural = (count: number, one: string, other: string): string => `${count} ${count === 1 ? one : other}`

/** The records a section names: "SO-0012, SO-0015 and 3 more". */
function itemsText(content: DigestSectionContent, locale: DigestLocale, detail: (item: DigestItem) => string): string {
  if (content.items.length === 0) return ''
  const named = content.items.map((item) => `${item.label}${detail(item)}`).join(', ')
  const more = content.count - content.items.length
  if (more <= 0) return `: ${named}`
  return locale === 'it' ? `: ${named} e altri ${more}` : `: ${named} and ${more} more`
}

/** One section in a language (a line), or the reason it is left out. */
export function sectionLine(content: DigestSectionContent, locale: DigestLocale): string {
  const it = locale === 'it'
  const money = (amount: DigestAmount | null) => (amount ? formatMoney(amount.minor, amount.currency, locale) : null)
  if (content.state === 'FAILED') return it ? `${sectionTitle(content.section, locale)}: non è stato possibile leggerlo questa volta.` : `${sectionTitle(content.section, locale)}: it could not be read this time.`
  switch (content.section) {
    case 'SHIPPED': {
      if (content.count === 0) return it ? 'Spedito ieri: nessuna spedizione.' : 'Shipped yesterday: no shipments.'
      const onTime = content.percent === null ? '' : it ? ` (${content.percent.replace('.', ',')} % in tempo)` : ` (${content.percent} % on time)`
      return it
        ? `Spedito ieri: ${plural(content.count, 'spedizione', 'spedizioni')}${onTime}${itemsText(content, locale, () => '')}.`
        : `Shipped yesterday: ${plural(content.count, 'shipment', 'shipments')}${onTime}${itemsText(content, locale, () => '')}.`
    }
    case 'LATE': {
      if (content.count === 0) return it ? 'In ritardo: nessun ordine oltre la data promessa.' : 'Late: no order past its promise date.'
      const days = (item: DigestItem) => (item.days === null ? '' : it ? ` (${plural(item.days, 'giorno', 'giorni')})` : ` (${plural(item.days, 'day', 'days')})`)
      return it
        ? `In ritardo: ${plural(content.count, 'ordine', 'ordini')} oltre la data promessa${itemsText(content, locale, days)}.`
        : `Late: ${plural(content.count, 'order', 'orders')} past the promise date${itemsText(content, locale, days)}.`
    }
    case 'NEW_ORDERS': {
      if (content.count === 0) return it ? 'Nuovi ordini ieri: nessuno.' : 'New orders yesterday: none.'
      const value = money(content.amount)
      const worth = value === null ? '' : it ? `, per ${value}` : `, worth ${value}`
      return it
        ? `Nuovi ordini ieri: ${plural(content.count, 'ordine', 'ordini')}${worth}${itemsText(content, locale, () => '')}.`
        : `New orders yesterday: ${plural(content.count, 'order', 'orders')}${worth}${itemsText(content, locale, () => '')}.`
    }
    case 'WIP_STUCK': {
      if (content.count === 0) return it ? `Lavorazioni ferme: nessun ordine di lavoro fermo da più di ${WIP_STUCK_DAYS} giorni.` : `Work stuck: no work order stuck for more than ${WIP_STUCK_DAYS} days.`
      const value = money(content.amount)
      const pieces = content.extra === null ? '' : it ? `, ${plural(content.extra, 'capo in attesa', 'capi in attesa')}` : `, ${plural(content.extra, 'garment waiting', 'garments waiting')}`
      const worth = value === null ? '' : it ? `, ${value} al costo` : `, ${value} at cost`
      const detail = (item: DigestItem) => {
        const parts = [item.place, item.days === null ? null : it ? plural(item.days, 'giorno', 'giorni') : plural(item.days, 'day', 'days')].filter((part): part is string => part !== null)
        return parts.length > 0 ? ` (${parts.join(', ')})` : ''
      }
      return it
        ? `Lavorazioni ferme da più di ${WIP_STUCK_DAYS} giorni: ${plural(content.count, 'ordine di lavoro', 'ordini di lavoro')}${pieces}${worth}${itemsText(content, locale, detail)}.`
        : `Work stuck for more than ${WIP_STUCK_DAYS} days: ${plural(content.count, 'work order', 'work orders')}${pieces}${worth}${itemsText(content, locale, detail)}.`
    }
    case 'ALERTS': {
      if (content.count === 0) return it ? 'Avvisi: nessuno aperto.' : 'Alerts: none open.'
      const high = content.extra ? (it ? ` (${content.extra} urgenti)` : ` (${content.extra} urgent)`) : ''
      return it ? `Avvisi aperti: ${content.count}${high}${itemsText(content, locale, () => '')}.` : `Open alerts: ${content.count}${high}${itemsText(content, locale, () => '')}.`
    }
    case 'APPROVALS': {
      if (content.count === 0) return it ? 'Approvazioni: nessuna aspetta te.' : 'Approvals: none waiting for you.'
      return it
        ? `Approvazioni che aspettano te: ${content.count}${itemsText(content, locale, () => '')}.`
        : `Approvals waiting for you: ${content.count}${itemsText(content, locale, () => '')}.`
    }
  }
}

const TITLES: Readonly<Record<DigestSection, Readonly<Record<DigestLocale, string>>>> = {
  SHIPPED: { it: 'Spedito ieri', en: 'Shipped yesterday' },
  LATE: { it: 'Ordini in ritardo', en: 'Late orders' },
  NEW_ORDERS: { it: 'Nuovi ordini', en: 'New orders' },
  WIP_STUCK: { it: 'Lavorazioni ferme', en: 'Work stuck' },
  ALERTS: { it: 'Avvisi', en: 'Alerts' },
  APPROVALS: { it: 'Approvazioni', en: 'Approvals' },
}

export const sectionTitle = (section: DigestSection, locale: DigestLocale): string => TITLES[section][locale]

export interface DigestMail {
  readonly subject: string
  readonly lines: readonly string[]
}

/**
 * The mail's subject and lines in a language: the day it looks back on and the companies, one line per section, the sections
 * left out because of the person's rights, then where to read more and how to stop it. `test` marks a test mail.
 */
export function digestMail(content: DigestContent, locale: DigestLocale, links: { readonly today: string; readonly settings: string }, test = false): DigestMail {
  const it = locale === 'it'
  const when = digestDayWords(content.today, locale)
  const subject = `${test ? (it ? '[Prova] ' : '[Test] ') : ''}${it ? `Il riepilogo del mattino · ${when}` : `Your morning summary · ${when}`}`
  const lines: string[] = []
  const where = content.companies.length === 0 ? '' : ` · ${content.companies.join(', ')}`
  lines.push(it ? `Ieri, ${digestDayWords(content.day, locale)}${where}.` : `Yesterday, ${digestDayWords(content.day, locale)}${where}.`)
  lines.push('')
  const shown = content.sections.filter((section) => section.state !== 'NO_ACCESS')
  for (const section of shown) lines.push(`• ${sectionLine(section, locale)}`)
  if (shown.length === 0) lines.push(it ? 'Nessuna sezione che tu possa leggere.' : 'No section you may read.')
  const leftOut = content.sections.filter((section) => section.state === 'NO_ACCESS').map((section) => sectionTitle(section.section, locale))
  if (leftOut.length > 0) lines.push(it ? `Lasciato fuori per i tuoi permessi: ${leftOut.join(', ')}.` : `Left out because of your rights: ${leftOut.join(', ')}.`)
  lines.push('')
  lines.push(it ? 'Numeri per azienda, linea e ordine, mai per persona.' : 'Figures per company, line and order, never per person.')
  lines.push(it ? `Apri Oggi: ${links.today}` : `Open Today: ${links.today}`)
  lines.push(it ? `Cambia o ferma questa e-mail: ${links.settings}` : `Change or stop this e-mail: ${links.settings}`)
  return { subject, lines }
}
