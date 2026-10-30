import type { Tone } from '@nexus/ui/primitives'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { DailyLane, LineCard, LineState, Recipient, ReportLocale, Subscription } from './api'

/**
 * Production › Reports (SCR-240) and Floor now's Lines (SCR-073 fn-lines): the rules without a screen. What a person may
 * do (from the session's permissions; the API checks every call again), the page's address (`?site=&date=`, Floor now's
 * `?line=`), the chart's bars per lane, the e-mail draft and why Subscribe is held, a refused write as words, and the
 * links a number opens. Words are message keys of the `production-reports` catalogue with their parameters (`Phrase`);
 * the views translate them. Per line, work centre, style and size only: never a person (Statuto dei Lavoratori art. 4).
 */

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** production.reports.view: the page, and the e-mail to oneself. */
  readonly view: boolean
  /** production.reports.subscribe: the e-mail to colleagues who may read it. */
  readonly subscribe: boolean
  /** workorders.view: Floor now and the work orders a number opens. */
  readonly floor: boolean
}

export function reportsCanOf(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return { view: held.has('production.reports.view'), subscribe: held.has('production.reports.subscribe'), floor: held.has('workorders.view') }
}

// ---- the address ---------------------------------------------------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ReportAddress {
  /** null: the API's first site. */
  readonly site: string | null
  /** null: today at the site. */
  readonly date: string | null
}

export function addressOf(params: { get(name: string): string | null } | null): ReportAddress {
  const site = params?.get('site')?.trim() ?? ''
  const date = params?.get('date')?.trim() ?? ''
  return { site: UUID.test(site) ? site : null, date: DAY.test(date) ? date : null }
}

export function addressText(address: ReportAddress): string {
  const query = new URLSearchParams()
  if (address.site) query.set('site', address.site)
  if (address.date) query.set('date', address.date)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Floor now's line scope (`?line=<id>`; null: all lines). */
export function lineScopeOf(params: { get(name: string): string | null } | null): string | null {
  const line = params?.get('line')?.trim() ?? ''
  return UUID.test(line) ? line : null
}

/** `[` / `]` on Floor now: the previous or next line's id (from all lines: the first or the last), null when none. */
export function stepLine(lines: readonly { readonly id: string }[], current: string | null, delta: -1 | 1): string | null {
  if (lines.length === 0) return null
  const index = current ? lines.findIndex((line) => line.id === current) : -1
  if (index < 0) return (delta === 1 ? lines[0] : lines[lines.length - 1])!.id
  const next = index + delta
  return next < 0 || next >= lines.length ? null : lines[next]!.id
}

export const reportsHref = (prefix: string, address: ReportAddress): string => `${prefix}/production/reports${addressText(address)}`
export const printHref = (prefix: string, address: ReportAddress): string => `${prefix}/production/reports/print${addressText(address)}`
/** A line's number opens Floor now on that line (its work orders, its stations). */
export const lineHref = (prefix: string, lineId: string): string => `${prefix}/production/floor?line=${encodeURIComponent(lineId)}`
/** A style's row opens the work orders of that style (the list's search). */
export const styleHref = (prefix: string, styleCode: string): string => `${prefix}/production/work-orders?q=${encodeURIComponent(styleCode)}`

// ---- the chart ---------------------------------------------------------------------------------------------------------------

export interface ChartPoint extends Record<string, number | string> {
  lane: string
  good: number
  scrap: number
  rework: number
}

/** One bar per lane (good, scrap and rework stacked); a line's efficiency as a point on the right axis, none for a work centre. */
export function chartData(lanes: readonly DailyLane[]): ChartPoint[] {
  return lanes.map((lane) => ({ lane: lane.code, good: lane.good, scrap: lane.scrap, rework: lane.rework, ...(lane.efficiencyPct === null ? {} : { efficiency: Number(lane.efficiencyPct) }) }))
}

/** Something was recorded (a bar to draw). */
export const anythingRecorded = (lanes: readonly DailyLane[]): boolean => lanes.some((lane) => lane.good + lane.scrap + lane.rework > 0)

/** "24,0 %" / "24.0 %"; null → "—". */
export function pctText(pct: string | null, locale: string): string {
  if (pct === null) return '—'
  return `${locale === 'it' ? pct.replace('.', ',') : pct} %`
}

/** The lines' efficiency over the day together: earned over available of every line (null: nothing available). */
export function siteEfficiency(lanes: readonly DailyLane[]): string | null {
  let earned = 0
  let available = 0
  for (const lane of lanes) {
    if (lane.kind !== 'LINE' || lane.availableMinutes === null || lane.earnedMinutes === null) continue
    earned += Number(lane.earnedMinutes)
    available += Number(lane.availableMinutes)
  }
  return available > 0 ? ((earned / available) * 100).toFixed(1) : null
}

// ---- Floor now's line cards ----------------------------------------------------------------------------------------------------

export const STATE_TONE: Readonly<Record<LineState, Tone>> = Object.freeze({ RUNNING: 'success', WAITING: 'warning', NO_WORK: 'neutral' })

/** The card's output words: "14 of 20 planned" / "14 · no plan published for today". */
export function outputPhrase(card: Pick<LineCard, 'output' | 'plannedToday'>): Phrase {
  return card.plannedToday === null ? phrase('lines.output.noPlan', { done: card.output }) : phrase('lines.output.ofPlan', { done: card.output, planned: card.plannedToday })
}

/** Stations nobody is signed in at, and the machines down (Owner F2: these, per station, and nothing else). */
export function stationNotes(card: Pick<LineCard, 'stations'>): { readonly nobody: string[]; readonly down: string[] } {
  return {
    nobody: card.stations.filter((station) => !station.signedIn).map((station) => station.code),
    down: card.stations.flatMap((station) => station.machinesDown.map((machine) => `${station.code} · ${machine.assetNumber}`)),
  }
}

// ---- the e-mail ----------------------------------------------------------------------------------------------------------------

export const DEFAULT_SEND_TIME = '07:00'
export const DEFAULT_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])
const SEND_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

export type LanguageChoice = 'own' | ReportLocale

export interface SubscribeDraft {
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly language: LanguageChoice
  /** User ids; the person's own id is in it when they get it themselves. */
  readonly recipients: readonly string[]
}

/** My subscription to this site's report (its newest row), or null. */
export function mySubscription(rows: readonly Subscription[] | null, siteId: string | null): Subscription | null {
  if (!rows || !siteId) return null
  return rows.find((row) => row.mine && row.site?.id === siteId) ?? null
}

/** The colleagues I made it for at this site, still on. */
export function othersSubscribed(rows: readonly Subscription[] | null, siteId: string | null): Subscription[] {
  if (!rows || !siteId) return []
  return rows.filter((row) => !row.mine && row.active && row.site?.id === siteId)
}

/** The dialog's start: my own settings when I have some, else 07:00 Monday to Friday, me, each person's own language. */
export function draftOf(mine: Subscription | null, me: string): SubscribeDraft {
  if (mine) return { sendTime: mine.sendTime, weekdays: [...mine.weekdays], language: mine.locale, recipients: [me] }
  return { sendTime: DEFAULT_SEND_TIME, weekdays: [...DEFAULT_WEEKDAYS], language: 'own', recipients: [me] }
}

export const toggleDay = (days: readonly number[], day: number): number[] => (days.includes(day) ? days.filter((entry) => entry !== day) : [...days, day].sort((a, b) => a - b))
export const toggleRecipient = (ids: readonly string[], id: string): string[] => (ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id])

/** Why Subscribe cannot go yet (null: it can). Said on the held button. */
export function subscribeHeld(draft: SubscribeDraft, can: ReportsCan, me: string): Phrase | null {
  if (!can.view) return phrase('subscribe.held.noView')
  if (!SEND_TIME.test(draft.sendTime)) return phrase('subscribe.held.time')
  if (draft.weekdays.length === 0) return phrase('subscribe.held.weekdays')
  if (draft.recipients.length === 0) return phrase('subscribe.held.recipients')
  if (!can.subscribe && draft.recipients.some((id) => id !== me)) return phrase('subscribe.held.noSubscribe')
  return null
}

/** The body the API takes: me alone needs no list; null language = each person's own. */
export function subscribeBody(draft: SubscribeDraft, siteId: string, me: string) {
  const onlyMe = draft.recipients.length === 1 && draft.recipients[0] === me
  return { siteId, ...(onlyMe ? {} : { recipients: [...draft.recipients] }), sendTime: draft.sendTime, weekdays: [...draft.weekdays], locale: draft.language === 'own' ? null : draft.language }
}

/** "Monday to Friday", "every day", or the days listed. */
export function weekdaysPhrase(days: readonly number[]): Phrase {
  const sorted = [...days].sort((a, b) => a - b).join(',')
  if (sorted === '1,2,3,4,5') return phrase('weekdays.workweek')
  if (sorted === '1,2,3,4,5,6,7') return phrase('weekdays.everyDay')
  return phrase('weekdays.some', { count: days.length })
}

/** A refused write as words; for a refused recipient, who. */
export function subscribeProblem(error: unknown, people: readonly Recipient[], asked: readonly string[]): Phrase {
  if (!isApiError(error)) return phrase('subscribe.problem.write')
  if (error.kind === 'forbidden') return phrase('subscribe.problem.forbidden')
  if (error.kind === 'conflict') return phrase('subscribe.problem.changed')
  if (error.kind === 'unavailable') return phrase('error.offline')
  if (error.kind === 'invalid') {
    const path = error.issues.map(issuePath).find((entry) => entry.startsWith('body/recipients/'))
    if (path) {
      const id = asked[Number(path.split('/')[2])]
      const name = people.find((person) => person.id === id)?.name
      return name ? phrase('subscribe.problem.recipient', { name }) : phrase('subscribe.problem.someone')
    }
    return phrase('subscribe.problem.settings')
  }
  return phrase('subscribe.problem.write')
}

/** A read that failed, as a message key. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'error.read'
  if (error.kind === 'forbidden') return 'error.forbidden'
  if (error.kind === 'not_found') return 'error.notFound'
  if (error.kind === 'unavailable') return 'error.offline'
  return 'error.read'
}

/** Live: what re-reads the report (the floor's scans and the rework), at most once a minute (the design). */
export function liveTouches(change: { readonly type: string }): boolean {
  return change.type === 'production.scan_recorded' || change.type.startsWith('production.rework') || change.type === 'production.report_subscription_changed' || change.type.startsWith('workorder.')
}
export const LIVE_COALESCE_MS = 60_000
