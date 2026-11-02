import type { SectionSpec } from '@nexus/ui/patterns'
import { ATTENDANCE_RULES } from '@nexus/factory-domain/people/attendance/rules'
import { EFFICIENCY_LIMITS } from '@nexus/factory-domain/people/efficiency/rules'
import { OPEN_NOTE_MAX } from '@nexus/factory-domain/people/privacy/figures'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { fieldOf, problemOf, type Words } from '../_shared/model'
import type { DayPoint, Decision, LineFigures, LineRow, OpenReason, OperationFigures, OperationRow, Overview, ReviewDecision, ReviewEntry, ReviewQueue, TrendLine } from './api'

/**
 * The pure rules of People › Efficiency (B-W2b-64, SCR-161): what this person may do (from the session's permissions; the
 * API checks each again), the address, the words of the figures, what is left out and why, the drafts of a review decision
 * and of opening one person's figures. Lines and operations, never a person: no person key exists here, nothing sorts or
 * ranks, and the address never holds a person (Statuto dei Lavoratori art. 4; Owner answers W1, F2, H3).
 */

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface EfficiencyCan {
  /** people.efficiency.view: the figures per line and per operation. */
  view: boolean
  /** people.efficiency.review: decide the standard review. */
  review: boolean
  /** people.view: the register, the people the one-person dialog offers. */
  people: boolean
  /** people.privacy.view: People settings (the minimum group size). */
  settings: boolean
  /** product.routing.view: Operations in Products. */
  operations: boolean
  /** product.styles.view: the style's routing, where "Change" goes. */
  styles: boolean
}

export function efficiencyCan(permissions: readonly string[]): EfficiencyCan {
  const held = new Set(permissions)
  return {
    view: held.has('people.efficiency.view'),
    review: held.has('people.efficiency.review'),
    people: held.has('people.view'),
    settings: held.has('people.privacy.view'),
    operations: held.has('product.routing.view'),
    styles: held.has('product.styles.view'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export interface EfficiencyAddress {
  from: string | null
  to: string | null
  lineId: string | null
  styleId: string | null
  compare: boolean
  /** Lines over time: the day whose operations the grid shows. */
  day: string | null
  /** The standard review's DetailModal. */
  open: string | null
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)

export function efficiencyAddressOf(params: URLSearchParams | { get(name: string): string | null } | null): EfficiencyAddress {
  return {
    from: dayOr(params?.get('from')),
    to: dayOr(params?.get('to')),
    lineId: params?.get('line') || null,
    styleId: params?.get('style') || null,
    compare: params?.get('compare') === '1',
    day: dayOr(params?.get('day')),
    open: params?.get('open') || null,
  }
}

export function efficiencyAddressText(address: EfficiencyAddress): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (address.lineId) terms.set('line', address.lineId)
  if (address.styleId) terms.set('style', address.styleId)
  if (address.compare) terms.set('compare', '1')
  if (address.day) terms.set('day', address.day)
  if (address.open) terms.set('open', address.open)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** A business day as the date picker's local day, and back. */
export const dateOfDay = (day: string): Date => new Date(`${day}T12:00:00`)
export const dayOfDate = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** The period on show: the address's, else what the API answered, else this month so far (the API's own default). */
export function rangeShown(address: Pick<EfficiencyAddress, 'from' | 'to'>, answer: { from: string; to: string } | null, now: Date = new Date()): { from: string; to: string } {
  const today = dayOfDate(now)
  return { from: address.from ?? answer?.from ?? `${today.slice(0, 7)}-01`, to: address.to ?? answer?.to ?? today }
}

/** The band's Print: the same scope, without the pop-up. */
export const printAddress = (prefix: string, address: EfficiencyAddress): string => `${prefix}/people/efficiency/print${efficiencyAddressText({ ...address, open: null, day: null })}`

/** Where the grid reads: the chosen day, else the period. */
export const operationsRange = (address: Pick<EfficiencyAddress, 'from' | 'to' | 'day'>) => (address.day ? { from: address.day, to: address.day } : { from: address.from, to: address.to })

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

export const EFFICIENCY_SECTIONS = ['privacy', 'tiles', 'trend', 'lines', 'operations', 'review', 'individual'] as const
export type EfficiencySection = (typeof EFFICIENCY_SECTIONS)[number]
export const LAYOUT_KEY = 'people.efficiency.layout'

/** What the page says before anything is read stays first and cannot be hidden. */
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => EFFICIENCY_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full', ...(id === 'privacy' ? { locked: true } : {}) }))

/** Stored order with the locked section first, whatever the storage said. */
export const privacyFirst = (order: readonly string[]): string[] => ['privacy', ...order.filter((id) => id !== 'privacy')]

// ---- figures in words --------------------------------------------------------------------------------------------------------

const asNumber = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export const percentText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : `${formatNumber(number, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

/** Whole minutes: a tile, a line. */
export const minutesText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : formatNumber(number, locale, { maximumFractionDigits: 0 })
}

/** A standard or an actual average: up to three decimals, as the routing writes it. */
export const standardText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : formatNumber(number, locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 })
}

/** "+30,0 %" for a difference: the sign says which way, both ways count (MES-251). */
export const differenceText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  if (number === null) return '—'
  return `${number > 0 ? '+' : ''}${formatNumber(number, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

export const lineLabel = (line: LineRow['line']): string | null => (line ? `${line.code} · ${line.name}` : null)
export const styleLabel = (row: Pick<OperationRow, 'style'>): string => `${row.style.code} · ${row.style.name}`
export const operationLabel = (row: Pick<OperationRow, 'operation'>): string => `${row.operation.code} · ${row.operation.name}`

/** A tile's movement against the previous period, in percentage points or minutes; null without both sides. */
export function deltaOf(now: string | null | undefined, before: string | null | undefined, unit: 'points' | 'minutes', locale: Locale): string | null {
  const a = asNumber(now)
  const b = asNumber(before)
  if (a === null || b === null) return null
  const change = a - b
  const text = formatNumber(Math.abs(change), locale, unit === 'points' ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 0 })
  return `${change > 0 ? '+' : change < 0 ? '−' : ''}${text}`
}

export type TileId = 'efficiency' | 'onStandard' | 'earned' | 'attended' | 'offStandard'
export const TILES: readonly TileId[] = ['efficiency', 'onStandard', 'earned', 'attended', 'offStandard']

export const tileFigure = (tiles: LineFigures | null | undefined, tile: TileId): string | null | undefined =>
  ({ efficiency: tiles?.efficiency, onStandard: tiles?.onStandardEfficiency, earned: tiles?.earnedMinutes, attended: tiles?.attendedMinutes, offStandard: tiles?.offStandardMinutes })[tile]

/** Each tile's source list, once its page is built; the line figures are on this page. */
export function tileHref(tile: TileId, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  const page = tile === 'attended' ? '/people/attendance' : tile === 'earned' || tile === 'offStandard' ? '/production/labour' : null
  if (tile === 'efficiency' || tile === 'onStandard') return '#fw-ef-lines'
  if (!page || !built.has(page)) return null
  return `${prefix}${page}${tile === 'offStandard' ? '?kind=OFF_STANDARD' : ''}`
}

// ---- lines over time ---------------------------------------------------------------------------------------------------------

export interface TrendRow extends Record<string, number | string> {
  day: string
}

/** One line's points: a hidden or empty day is a GAP (no key), never a zero; the target runs across every day. */
export function trendRows(line: Pick<TrendLine, 'points' | 'targetPercent'>, dayText: (date: string) => string): TrendRow[] {
  const target = asNumber(line.targetPercent)
  return line.points.map((point) => {
    const efficiency = point.tooFew ? null : asNumber(point.efficiency)
    return { day: dayText(point.date), ...(efficiency === null ? {} : { efficiency }), ...(target === null ? {} : { target }) }
  })
}

export const hiddenDays = (line: Pick<TrendLine, 'points'>): number => line.points.filter((point) => point.tooFew).length

/** The chart's fixed range, so the line and its target share one scale. */
export function trendDomain(rows: readonly TrendRow[]): [number, number] {
  const values = rows.flatMap((row) => [row.efficiency, row.target]).filter((value): value is number => typeof value === 'number')
  return [0, Math.max(100, Math.ceil(Math.max(0, ...values) / 10) * 10)]
}

/** The days a person can pick for "that day's operations": those with something to show, newest first. */
export function daysWithFigures(lines: readonly Pick<TrendLine, 'points'>[]): string[] {
  const days = new Set(lines.flatMap((line) => line.points.filter((point) => !point.tooFew && point.earnedMinutes !== null).map((point) => point.date)))
  return [...days].sort().reverse()
}

// ---- operations --------------------------------------------------------------------------------------------------------------

/** The sparkline's readings: a hidden day keeps its place and breaks the line. */
export const sparkValues = (series: readonly DayPoint[]): (number | null)[] => series.map((point) => (point.tooFew ? null : asNumber(point.differencePercent)))

/** Why a row may not be chosen, or null. */
export const operationHeld = (row: Pick<OperationRow, 'tooFew'>): string | null => (row.tooFew ? 'tooFew.short' : null)

export const stateKey = (figures: Pick<OperationFigures, 'state'>, tooFew: boolean): string => (tooFew ? 'state.TOO_FEW_PEOPLE' : `state.${figures.state ?? 'TOO_FEW_BUNDLES'}`)
export const stateTone = (figures: Pick<OperationFigures, 'state'>, tooFew: boolean): 'success' | 'warning' | 'neutral' => (tooFew ? 'neutral' : figures.state === 'REVIEW' ? 'warning' : figures.state === 'WITHIN' ? 'success' : 'neutral')

/** Where the operation stands in Products: the library's record (⌘-click) and the style's routing (where a standard changes). */
export const operationHref = (prefix: string, operationId: string): string => `${prefix}/products/operations/${encodeURIComponent(operationId)}`
export const routingHref = (prefix: string, styleId: string): string => `${prefix}/products/styles/${encodeURIComponent(styleId)}?tab=routing`

// ---- what is left out --------------------------------------------------------------------------------------------------------

export interface LeftOutLine {
  key: string
  count?: number
}

/** The page's own words for what the figures leave out and why, from the API's flags and counts (its English is never drawn). */
export function overviewNotes(overview: Pick<Overview, 'attendance' | 'hiddenGroups' | 'traineeDaysLeftOut'>): LeftOutLine[] {
  return [
    ...(overview.attendance.open ? [] : [{ key: 'notes.attendanceOff' }]),
    ...(overview.attendance.provisional ? [{ key: 'notes.provisional' }] : []),
    ...(overview.hiddenGroups > 0 ? [{ key: 'notes.hiddenLines', count: overview.hiddenGroups }] : []),
    ...(overview.traineeDaysLeftOut > 0 ? [{ key: 'notes.traineeDays', count: overview.traineeDaysLeftOut }] : []),
  ]
}

export type LeftOutWeight = 'none' | 'some' | 'most'

/**
 * How much of the queue the minimum group size hides. With one person per operation it can be most of it: a cost of the
 * rule (one operation is then one person's figure), and the page says so in words instead of showing a short queue as if
 * it were the whole.
 */
export const leftOutWeight = (queue: Pick<ReviewQueue, 'count' | 'leftOut'>): LeftOutWeight => (queue.leftOut === 0 ? 'none' : queue.leftOut >= queue.count ? 'most' : 'some')

// ---- the standard review -----------------------------------------------------------------------------------------------------

export type DecisionChoice = Extract<ReviewDecision, 'KEEP' | 'CHANGE' | 'INVESTIGATE'>
export const DECISION_CHOICES: readonly DecisionChoice[] = ['KEEP', 'CHANGE', 'INVESTIGATE']

export interface DecisionDraft {
  decision: DecisionChoice | null
  reason: string
  /** CHANGE: as typed ("1,25" or "1.25"). */
  proposed: string
}

export const EMPTY_DECISION: DecisionDraft = { decision: null, reason: '', proposed: '' }

/** The minutes as the API takes them ("1.25"), or null when they are not minutes it would keep. */
export function proposedMinutes(text: string): string | null {
  const value = text.trim().replace(',', '.')
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(value)) return null
  return Number(value) > 0 && Number(value) <= EFFICIENCY_LIMITS.maxStandardMinutes ? value : null
}

/** Why the decision may not go yet (a message key), or null. */
export function decisionHeld(draft: DecisionDraft, can: Pick<EfficiencyCan, 'review'>, busy: boolean): string | null {
  if (!can.review) return 'held.noReview'
  if (busy) return 'held.busy'
  if (!draft.decision) return 'held.pickDecision'
  if (draft.decision === 'CHANGE' && proposedMinutes(draft.proposed) === null) return 'held.proposed'
  const reason = draft.reason.trim()
  if (reason.length < EFFICIENCY_LIMITS.reasonMin) return 'held.reason'
  if (reason.length > EFFICIENCY_LIMITS.reasonMax) return 'held.reasonLong'
  return null
}

export const decisionBody = (siteId: string, draft: DecisionDraft, basedOn: string | null) => ({
  siteId,
  decision: draft.decision as DecisionChoice,
  reason: draft.reason.trim(),
  proposedMinutes: draft.decision === 'CHANGE' ? proposedMinutes(draft.proposed) : null,
  basedOn,
})

/** The queue's rows that a many-rows decision may take: one with no figure cannot be judged from a list. */
export const reviewHeld = (row: Pick<ReviewEntry, 'tooFew'>): string | null => (row.tooFew ? 'held.oneAtATime' : null)

export const historyLine = (entry: Decision): string => `history.${entry.decision}`

// ---- one person's figures ----------------------------------------------------------------------------------------------------

export interface PersonDraft {
  personId: string
  reason: OpenReason | ''
  note: string
}

export const EMPTY_PERSON: PersonDraft = { personId: '', reason: '', note: '' }

/** Why "Show figures" waits (a message key), or null. The API asks the gate, the right and the reason again. */
export function personHeld(draft: PersonDraft, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!draft.personId) return 'held.pickPerson'
  if (!draft.reason) return 'held.pickPurpose'
  if (draft.note.length > OPEN_NOTE_MAX) return 'held.noteLong'
  return null
}

/** Why the one-person panel is not offered: in words, naming no person (the gate first: nothing is looked up behind it). */
export function individualWhy(sightOpen: boolean, available: boolean): string {
  if (!sightOpen) return 'individual.gateOff'
  return available ? 'individual.available' : 'individual.notYours'
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

export interface EfficiencyProblem {
  ns: 'efficiency' | 'people'
  words: Words
}

const pathOf = (error: unknown, start: string): string | null => {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith(start)) return path.slice(start.length)
  }
  return null
}

/** A refused read or write in our words (never the API's): the gates, "someone decided first", the rest as People says it. */
export function efficiencyProblem(error: unknown): EfficiencyProblem {
  const gate = pathOf(error, 'gate/')
  if (gate) return { ns: 'efficiency', words: { key: `refused.gate${gate === 'ATTENDANCE' ? 'Attendance' : 'Performance'}` } }
  if (pathOf(error, 'figures/')) return { ns: 'efficiency', words: { key: 'refused.notAllowed' } }
  const refusal = pathOf(error, 'refusal/')
  if (refusal === 'REVIEW_MOVED' || refusal === 'TOO_FEW_PEOPLE' || refusal === 'STATION_SITE') return { ns: 'efficiency', words: { key: `refused.${refusal}` } }
  if (pathOf(error, 'querystring/')) return { ns: 'efficiency', words: { key: 'refused.range', params: { days: ATTENDANCE_RULES.rangeDays } } }
  if (isApiError(error) && error.kind === 'invalid') {
    const field = fieldOf(error)
    if (field === 'reason') return { ns: 'efficiency', words: { key: 'refused.reason' } }
    if (field === 'proposedMinutes') return { ns: 'efficiency', words: { key: 'held.proposed' } }
  }
  return { ns: 'people', words: problemOf(error) }
}

// ---- the line report's file --------------------------------------------------------------------------------------------------

/** Line level only: the rows the page shows. A hidden line is written empty, with no figure to subtract. */
export function linesCsvRows(lines: readonly LineRow[], words: { noLine: string; tooFew: string }, locale: Locale): (string | null)[][] {
  return lines.map((row) =>
    row.tooFew
      ? [lineLabel(row.line) ?? words.noLine, words.tooFew, null, null, null, null, null, null]
      : [
          lineLabel(row.line) ?? words.noLine,
          row.people === null ? null : String(row.people),
          minutesText(row.figures.earnedMinutes, locale),
          minutesText(row.figures.attendedMinutes, locale),
          minutesText(row.figures.offStandardMinutes, locale),
          percentText(row.figures.efficiency, locale),
          percentText(row.figures.onStandardEfficiency, locale),
          percentText(row.figures.plannedEfficiency, locale),
        ],
  )
}
