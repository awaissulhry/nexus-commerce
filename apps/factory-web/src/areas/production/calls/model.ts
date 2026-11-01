import { CALL_KINDS, CALL_LIMITS, CALL_TILES, CALL_VIEWS, RESOLUTION_CODE, type CallKind, type CallStatus, type CallTile, type CallView } from '@nexus/factory-domain/production/calls/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Call, CallCounts, CallRecord, CallsByHour, CallType, Person } from './api'

/**
 * Production › Floor control › Help calls (B-W2b-58; SCR-142; design production.calls), pure: what this person may do,
 * the address (`?view=&tile=&kind=&q=&open=`) — the tiles are the API's own named filters —, the words of a status, a
 * kind, a duration and a person (a floor worker is never named in a list: Owner answer W1), why each step is held, the
 * API's refusals in this page's words (`refusal/<CODE>` → `refusal.<CODE>` + `fix.<CODE>`), the chart's rows (calls
 * per hour stacked by kind or by line) and the response times by kind. Response times are a call's, a kind's and a
 * line's, never a person's (Statuto dei Lavoratori art. 4; Owner answer F2). Keys of `help-calls`.
 */

export const CALLS_NAMESPACE = 'help-calls'
export const CALLS_NAMESPACES = [CALLS_NAMESPACE, 'lists', 'ds-words'] as const

// ---- what this person may do ----------------------------------------------------------------------------------------------

export interface CallsCan {
  /** production.calls.view: the page. */
  view: boolean
  /** production.calls.answer: acknowledge, on my way, solve, cancel, name what a call led to. */
  answer: boolean
  /** production.calls.manage: who is called (edited in Floor rules & codes). */
  manage: boolean
  /** production.settings.view: the link to Floor rules & codes. */
  settings: boolean
  /** plant.view + plant.jobs.manage: "Open a maintenance job" from a machine call. */
  plantJobs: boolean
  /** workorders.view: the work order's link. */
  workOrders: boolean
}

export function callsCanOf(permissions: readonly string[]): CallsCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.calls.view'),
    answer: held.has('production.calls.answer'),
    manage: held.has('production.calls.manage'),
    settings: held.has('production.settings.view'),
    plantJobs: held.has('plant.view') && held.has('plant.jobs.manage'),
    workOrders: held.has('workorders.view'),
  }
}

// ---- the address ----------------------------------------------------------------------------------------------------------

export interface CallsAddress {
  view: CallView
  tile: CallTile | null
  kind: CallKind | null
  q: string
  /** The call open in its DetailModal. */
  open: string | null
}

const pick = <T extends string>(values: readonly T[], value: string | null | undefined): T | null => (value && (values as readonly string[]).includes(value) ? (value as T) : null)

export function addressOf(params: { get(name: string): string | null } | null): CallsAddress {
  return {
    view: pick(CALL_VIEWS, params?.get('view')) ?? 'open',
    tile: pick(CALL_TILES, params?.get('tile')),
    kind: pick(CALL_KINDS, params?.get('kind')),
    q: params?.get('q') ?? '',
    open: params?.get('open') || null,
  }
}

/** The address's query (`?…`, or '' for the plain inbox). */
export function addressText(address: CallsAddress): string {
  const query = new URLSearchParams()
  if (address.view !== 'open') query.set('view', address.view)
  if (address.tile) query.set('tile', address.tile)
  if (address.kind) query.set('kind', address.kind)
  if (address.q.trim()) query.set('q', address.q.trim())
  if (address.open) query.set('open', address.open)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The tiles (design cl-metrics "saved filters"): three named filters of the API and today's median beside them. */
export const TILES = [
  { id: 'OPEN', tile: 'OPEN' },
  { id: 'WAITING', tile: 'WAITING' },
  { id: 'ANSWERED_TODAY', tile: 'ANSWERED_TODAY' },
  { id: 'MEDIAN', tile: null },
] as const satisfies readonly { id: string; tile: CallTile | null }[]

/** A tile pressed: its filter (open calls for the first two, every call for "answered today"); pressed again: the inbox. */
export function tileAddress(address: CallsAddress, tile: CallTile): Partial<CallsAddress> {
  if (address.tile === tile) return { tile: null, view: 'open' }
  return { tile, view: tile === 'ANSWERED_TODAY' ? 'all' : 'open' }
}

export function tileValue(id: (typeof TILES)[number]['id'], counts: CallCounts | null): number | null {
  if (!counts) return null
  if (id === 'MEDIAN') return counts.medianResponseSeconds
  return counts.tiles[id]
}

// ---- words ----------------------------------------------------------------------------------------------------------------

export interface Phrase {
  key: string
  params?: Readonly<Record<string, string | number>>
}

/** A duration in words: "45 s", "2 min 10 s", "1 h 05 min"; null: "—". */
export function durationPhrase(seconds: number | null | undefined): Phrase | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  const whole = Math.max(0, Math.round(seconds))
  if (whole < 60) return { key: 'dur.s', params: { s: whole } }
  if (whole < 3600) {
    const m = Math.floor(whole / 60)
    const s = whole % 60
    return s === 0 ? { key: 'dur.m', params: { m } } : { key: 'dur.ms', params: { m, s } }
  }
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  return { key: 'dur.hm', params: { h, m: String(m).padStart(2, '0') } }
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A status's pill (design: Open / Acknowledged / On the way / Resolved; and Cancelled). */
export const STATUS_TONE: Readonly<Record<CallStatus, Tone>> = Object.freeze({ SENT: 'danger', SEEN: 'warning', ON_THE_WAY: 'info', SOLVED: 'success', CANCELLED: 'neutral' })

/** A kind's colour on the chart and its glyph: a DS swatch name (the type's own colour wins where it has one). */
export const KIND_SWATCH: Readonly<Record<CallKind, string>> = Object.freeze({ MACHINE: 'Red', MATERIAL: 'Amber', QUALITY: 'Purple', SUPERVISOR: 'Blue', MAINTENANCE: 'Teal', OTHER: 'Grey' })

/** A type's words in the page's language (its other languages, else English); its code when it has none. */
export function typeLabel(type: Pick<CallType, 'code' | 'labelIt' | 'labelEn' | 'labelI18n'>, locale: string): string {
  if (locale === 'it') return type.labelIt || type.labelEn || type.code
  if (locale === 'en') return type.labelEn || type.code
  return type.labelI18n[locale] || type.labelEn || type.code
}

/** Who took a step, in words: an office user by name (the API names them in the office), a floor worker never in a list. */
export function personPhrase(person: Person | null, inRecord: boolean): Phrase | null {
  if (!person) return null
  if (person.name) return { key: 'person.named', params: { name: person.name } }
  return { key: person.kind === 'WORKER' ? (inRecord ? 'person.workerHidden' : 'person.worker') : 'person.user' }
}

/** The call's title (design pop:cl-item "Machine call · Line 2 · Station 4"). */
export function callTitleParts(call: Pick<Call, 'type' | 'line' | 'station'>, locale: string): { type: string; line: string | null; station: string } {
  return { type: typeLabel(call.type, locale), line: call.line?.code ?? null, station: call.station.code }
}

/** The rows the search keeps (type words, station, line, work order, bundle, team; any language's words). */
export function searchRows(rows: readonly Call[], q: string, locale: string): Call[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) =>
    [typeLabel(row.type, locale), row.type.code, row.station.code, row.station.name, row.line?.code, row.line?.name, row.workOrder?.number, row.bundle?.code, row.responderTeam?.name, row.responderTeam?.code]
      .filter((text): text is string => typeof text === 'string')
      .some((text) => text.toLowerCase().includes(needle)),
  )
}

// ---- held steps -----------------------------------------------------------------------------------------------------------

/** A closed call cannot be selected (its reason on the box), nor can any row without the right to answer. */
export function rowHeld(call: Pick<Call, 'open'>, can: Pick<CallsCan, 'answer'>): string | null {
  if (!can.answer) return 'held.noAnswer'
  return call.open ? null : 'held.closed'
}

/** The calls Acknowledge N reaches: open, nobody saw them yet. */
export const ackTargets = <T extends Pick<Call, 'status'>>(calls: readonly T[]): T[] => calls.filter((call) => call.status === 'SENT')
/** The calls Solve N reaches: open. */
export const solveTargets = <T extends Pick<Call, 'open'>>(calls: readonly T[]): T[] => calls.filter((call) => call.open)

export interface StepState {
  canAnswer: boolean
  busy: boolean
}

/** Why Acknowledge (A) is held for this call now, or null. */
export function ackHeld(call: Pick<Call, 'status'>, state: StepState): string | null {
  if (!state.canAnswer) return 'held.noAnswer'
  if (call.status === 'SOLVED' || call.status === 'CANCELLED') return 'held.closed'
  if (call.status !== 'SENT') return call.status === 'SEEN' ? 'held.seenAlready' : 'held.comingAlready'
  return state.busy ? 'held.busy' : null
}

/** Why "On my way" is held. */
export function comeHeld(call: Pick<Call, 'status'>, state: StepState): string | null {
  if (!state.canAnswer) return 'held.noAnswer'
  if (call.status === 'SOLVED' || call.status === 'CANCELLED') return 'held.closed'
  if (call.status === 'ON_THE_WAY') return 'held.comingAlready'
  return state.busy ? 'held.busy' : null
}

/** Why Done (D, solved) and Cancel are held. */
export function closeHeld(call: Pick<Call, 'open'>, state: StepState): string | null {
  if (!state.canAnswer) return 'held.noAnswer'
  if (!call.open) return 'held.closed'
  return state.busy ? 'held.busy' : null
}

/** Why "Open a maintenance job" is held for a machine call, or null; it is offered on machine and maintenance calls. */
export function jobHeld(record: Pick<CallRecord, 'outcome' | 'type'>, canNameOutcome: boolean, can: Pick<CallsCan, 'plantJobs' | 'answer'>, busy: boolean): string | null {
  if (!can.answer) return 'held.noAnswer'
  if (record.outcome) return 'held.outcomeNamed'
  if (!can.plantJobs) return 'held.noPlantJobs'
  if (!canNameOutcome) return 'held.noAnswer'
  return busy ? 'held.busy' : null
}

/** Machine and maintenance calls lead to a maintenance job. */
export const offersJob = (call: Pick<Call, 'type'>): boolean => call.type.kind === 'MACHINE' || call.type.kind === 'MAINTENANCE'

/** How a call is solved: codes the page offers (free codes in the API, RESOLUTION_CODE), each with its words. */
export const RESOLUTIONS = ['FIXED', 'BROUGHT', 'ADJUSTED', 'EXPLAINED', 'REPLACED', 'NOT_NEEDED'] as const
export type Resolution = (typeof RESOLUTIONS)[number]

export interface SolveDraft {
  code: Resolution | ''
  note: string
}

/** Why Solve in the dialog is held (a code is optional; the note at most 500 characters). */
export function solveHeld(draft: SolveDraft, busy: boolean): string | null {
  if (draft.code !== '' && !RESOLUTION_CODE.test(draft.code)) return 'held.code'
  if (draft.note.trim().length > CALL_LIMITS.resolutionNote) return 'held.noteLong'
  return busy ? 'held.busy' : null
}

export function solveBody(draft: SolveDraft): { resolutionCode?: string; resolutionNote?: string } {
  return { ...(draft.code ? { resolutionCode: draft.code } : {}), ...(draft.note.trim() ? { resolutionNote: draft.note.trim() } : {}) }
}

/** Why Cancel in the dialog is held: the reason is required (kept on the audit row). */
export function cancelHeld(reason: string, busy: boolean): string | null {
  if (!reason.trim()) return 'held.reason'
  if (reason.trim().length > CALL_LIMITS.reason) return 'held.reasonLong'
  return busy ? 'held.busy' : null
}

export interface JobDraft {
  machineId: string
  priority: 'P1' | 'P2' | 'P3'
  problem: string
}

/** Why Open the job is held. */
export function jobDraftHeld(draft: JobDraft, busy: boolean): string | null {
  if (!draft.machineId) return 'held.machine'
  if (!draft.problem.trim()) return 'held.problem'
  if (draft.problem.trim().length > 2000) return 'held.problemLong'
  return busy ? 'held.busy' : null
}

// ---- the API's answers in words -------------------------------------------------------------------------------------------

/** The refusal's code of a 409 (`refusal/<CODE>`), else null. */
export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

const KNOWN_REFUSALS = new Set(['SOLVED', 'CANCELLED', 'ALREADY_SEEN', 'ALREADY_ON_THE_WAY', 'OUTCOME_NAMED', 'KIND_FIXED', 'CODE_TAKEN', 'CODE_NOT_LISTED', 'TEAM_NOT_ACTIVE', 'WAITING_CODE', 'TYPE_INACTIVE', 'NOT_THIS_STATION', 'NO_STATION', 'OTHER_STATION'])

/** A refused write in this page's words: the rule's refusal with its fix, a version moved, no right, offline. */
export function writeProblem(error: unknown): Phrase {
  const code = refusalCode(error)
  if (code && KNOWN_REFUSALS.has(code)) return { key: `refusal.${code}` }
  if (!isApiError(error)) return { key: 'problem.write' }
  switch (error.kind) {
    case 'conflict':
      return { key: 'problem.changed' }
    case 'forbidden':
    case 'step_up':
      return { key: 'problem.forbidden' }
    case 'not_found':
      return { key: 'problem.gone' }
    case 'invalid':
      return { key: 'problem.invalid' }
    case 'unavailable':
      return { key: 'problem.offline' }
    default:
      return { key: 'problem.write' }
  }
}

/** A failed read in words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

// ---- the chart ------------------------------------------------------------------------------------------------------------

export type ChartBy = 'kind' | 'line'
export const CHART_BY: readonly ChartBy[] = ['kind', 'line']

/** The hours the chart shows: from 6 to 20, widened to the first and last hour with a call. */
export function chartHours(hours: CallsByHour['hours']): number[] {
  const busy = hours.filter((hour) => hour.calls > 0).map((hour) => hour.hour)
  const from = Math.min(6, ...busy)
  const to = Math.max(20, ...busy)
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

export interface ChartPart {
  key: string
  /** The part's words: a kind (a key of `help-calls`) or a line's code. */
  kind?: CallKind
  line?: { code: string; name: string } | null
}

/** The stacked parts: each kind with a call today (in the domain's order), or each line (calls with no line: "No line"). */
export function chartParts(day: CallsByHour, by: ChartBy): ChartPart[] {
  if (by === 'kind') return CALL_KINDS.filter((kind) => day.hours.some((hour) => (hour.byKind[kind] ?? 0) > 0)).map((kind) => ({ key: kind, kind }))
  const seen = new Set<string>()
  for (const hour of day.hours) for (const entry of hour.byLine) if (entry.count > 0) seen.add(entry.lineId ?? 'none')
  return [...day.lines.filter((line) => seen.has(line.id)).map((line) => ({ key: line.id, line: { code: line.code, name: line.name } })), ...(seen.has('none') ? [{ key: 'none', line: null }] : [])]
}

/** The chart's rows: one per hour ("08:00"), a number per part, and the calls so far today (the line). */
export function chartRows(day: CallsByHour, by: ChartBy): Array<Record<string, number | string>> {
  const parts = chartParts(day, by)
  const hours = chartHours(day.hours)
  let sofar = day.hours.filter((hour) => hour.hour < (hours[0] ?? 0)).reduce((sum, hour) => sum + hour.calls, 0)
  return hours.map((hourNumber) => {
    const hour = day.hours.find((entry) => entry.hour === hourNumber)
    sofar += hour?.calls ?? 0
    const row: Record<string, number | string> = { hour: `${String(hourNumber).padStart(2, '0')}:00`, sofar }
    for (const part of parts) {
      row[part.key] = by === 'kind' ? (hour?.byKind[part.key] ?? 0) : (hour?.byLine.find((entry) => (entry.lineId ?? 'none') === part.key)?.count ?? 0)
    }
    return row
  })
}

/** "Response times by type": each kind's median response time with how many were answered of how many. */
export function responseRows(day: CallsByHour): Array<{ kind: CallKind; median: number | null; calls: number; answered: number }> {
  return day.byKind.map((entry) => ({ kind: entry.kind, median: entry.medianResponseSeconds, calls: entry.calls, answered: entry.answered }))
}

export const totalCalls = (day: CallsByHour): number => day.hours.reduce((sum, hour) => sum + hour.calls, 0)

// ---- who is called --------------------------------------------------------------------------------------------------------

/** "Who is called" rows (design cl-routing: type · group · members count), the active types in their order. */
export function routingRows(types: readonly CallType[]): CallType[] {
  return types.filter((type) => type.active).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
}

/** A day in the site's zone (YYYY-MM-DD). */
export const dayIn = (at: Date, timeZone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

/** Live messages that change this page. */
export const isCallChange = (type: string): boolean => type.startsWith('help_call.') || type === 'help_call_type.changed'
