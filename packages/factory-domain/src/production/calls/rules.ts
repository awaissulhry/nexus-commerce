import type { Issue } from '../../core/errors'
import { REASON_CODE } from '../scans/reasons'

/**
 * Help calls (andon), pure (B-W2b-35; MES-142 call for help in one tap, MES-143 one open call per station and type,
 * MES-144 route calls to the right people, MES-145 acknowledge and resolve with times, MES-147 call status on line
 * displays, MES-137 extra material from the floor; design floor.help SCR-172, production.calls SCR-142, floor.supervisor
 * "Calls", floor.display "Stations", production.settings "Help-call routing"). apps/factory-api modules/production/calls
 * applies them; the database (andon.prisma, …_floor_work_w2b_guards) refuses the same at the row:
 *
 *   - a call is sent from a station in one tap: the station (the tablet's) and its line are known, the caller is named
 *     only where the site's floor records name workers; a second tap of the same type answers the open call, never a
 *     second one (one open call per station and type);
 *   - a call moves SENT → SEEN → ON_THE_WAY → SOLVED, forward only, each step with its time and who took it, set once; a
 *     responder's "on my way" or "solved" marks a call nobody had seen as seen at the same moment (they saw it); the
 *     station that sent it may close it itself ("It's solved", "Cancel call"); SOLVED and CANCELLED are final;
 *   - a call type is a code of the site's HELP_CALL reason list (its words, icon and colour), with a kind, the team of the
 *     site that answers it (none: the site's team leaders), the minutes after which it should escalate (kept for MES-146,
 *     a later wave), and the off-standard code the station's waiting books to (MES-148, B-W2b-29); its kind never changes;
 *   - a MATERIAL call is the floor's request for extra material (MES-137): it names the work order (and bundle) and what is
 *     missing in words, and goes to the team that brings material (the warehouse) like every call goes to its team.
 *
 * Response times are a call's and a line's (Statuto dei Lavoratori art. 4; Owner answers W1, F2): nothing here groups,
 * filters or totals by person.
 */

export const CALL_KINDS = ['MACHINE', 'MATERIAL', 'QUALITY', 'SUPERVISOR', 'MAINTENANCE', 'OTHER'] as const
export type CallKind = (typeof CALL_KINDS)[number]

export const CALL_STATUSES = ['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED'] as const
export type CallStatus = (typeof CALL_STATUSES)[number]

/** The states of a call still waiting for help (the partial unique index "one open call per station and type"). */
export const OPEN_CALL_STATUSES = ['SENT', 'SEEN', 'ON_THE_WAY'] as const satisfies readonly CallStatus[]
export const isOpenCall = (status: string): boolean => (OPEN_CALL_STATUSES as readonly string[]).includes(status)

/** The steps a call takes after it is sent. */
export const CALL_STEPS = ['SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED'] as const
export type CallStep = (typeof CALL_STEPS)[number]

/** Who takes a step: a responder (production.calls.answer) or the station that sent the call (floor.work). */
export const CALL_ACTORS = ['RESPONDER', 'STATION'] as const
export type CallActor = (typeof CALL_ACTORS)[number]

/** What a call led to (HelpCall.outcomeRecordType), named once. */
export const OUTCOME_TYPES = ['MaintenanceJob', 'MaintenanceRequest', 'Nonconformance', 'Task'] as const
export type OutcomeType = (typeof OUTCOME_TYPES)[number]

/** The tiles of production.calls ("Open calls", "Waiting over 5 minutes", "Answered today"); the median is beside them. */
export const CALL_TILES = ['OPEN', 'WAITING', 'ANSWERED_TODAY'] as const
export type CallTile = (typeof CALL_TILES)[number]

/** A list's set: the open calls (the inbox), the closed ones, or every call. */
export const CALL_VIEWS = ['open', 'closed', 'all'] as const
export type CallView = (typeof CALL_VIEWS)[number]

/** A station's call state on the line view and the line TV (colour, shape and word are the screens'). */
export const STATION_CALL_STATES = ['CALLING', 'COMING', 'CLEAR'] as const
export type StationCallState = (typeof STATION_CALL_STATES)[number]

export const CALL_LIMITS = Object.freeze({
  note: 500,
  resolutionNote: 500,
  /** Why the office cancelled a call (kept on its audit row). */
  reason: 500,
  /** "Waiting over 5 minutes" (design production.calls): open and nobody on the way yet. */
  waitingMinutes: 5,
  escalateMinutes: Object.freeze({ min: 1, max: 240 }),
  /** A queued call keeps the tablet's time when it is at most 2 minutes ahead of the server and 12 hours behind. */
  aheadMs: 2 * 60_000,
  behindMs: 12 * 60 * 60_000,
  types: 50,
})

/** How a call was solved: a code (BROUGHT, FIXED, ADJUSTED…), upper-case letters, digits and underscores. */
export const RESOLUTION_CODE = /^[A-Z][A-Z0-9_]{1,39}$/

export interface CallRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

const refusal = (code: string, message: string, fix: string): CallRefusal => Object.freeze({ code, message, fix })

export const CALL_REFUSALS = Object.freeze({
  NO_STATION: refusal('NO_STATION', 'This tablet stands at no station, so a call cannot say where help is needed.', 'An administrator places the tablet at a station (Admin › Devices); call out loud or use the line lamp meanwhile.'),
  OTHER_STATION: refusal('OTHER_STATION', 'Only a team leader calls for another station.', "Call from that station's own tablet, or ask the team leader."),
  TYPE_INACTIVE: refusal('TYPE_INACTIVE', 'This kind of call is switched off at the site.', 'Pick another tile, or ask the office to switch it on again (Floor rules & codes).'),
  NOT_THIS_STATION: refusal('NOT_THIS_STATION', 'This call was sent from another station: only that station closes it here.', 'A team leader or the office answers it from the line view or Help calls.'),
  SOLVED: refusal('SOLVED', 'This call is solved already.', 'Send a new call if help is still needed.'),
  CANCELLED: refusal('CANCELLED', 'This call was cancelled.', 'Send a new call if help is still needed.'),
  ALREADY_SEEN: refusal('ALREADY_SEEN', 'Someone has seen this call already.', 'Say you are on the way, or mark it solved.'),
  ALREADY_ON_THE_WAY: refusal('ALREADY_ON_THE_WAY', 'Someone is on the way to this call already.', 'Read the call again: it says who is coming.'),
  OUTCOME_NAMED: refusal('OUTCOME_NAMED', 'What this call led to is named already.', 'Open that record from the call.'),
  KIND_FIXED: refusal('KIND_FIXED', 'A call type keeps its kind: the calls already sent were routed by it.', 'Switch this type off and add a new one with the other kind.'),
  CODE_TAKEN: refusal('CODE_TAKEN', 'The site has a help-call type with this code already.', 'Change that type, or pick another code.'),
  CODE_NOT_LISTED: refusal('CODE_NOT_LISTED', 'This is not an active code of the help-call reason list.', 'Add it to the help-call reasons first (Floor rules & codes › Reason codes).'),
  TEAM_NOT_ACTIVE: refusal('TEAM_NOT_ACTIVE', 'This team is archived or works at another site.', "Pick an active team of the site, or none (the site's team leaders answer)."),
  WAITING_CODE: refusal('WAITING_CODE', "The waiting time books to an active off-standard code of the site's company.", 'Pick one of the off-standard codes (Floor rules & codes › Off-standard codes), or none.'),
} satisfies Record<string, CallRefusal>)

// ---- the steps ----------------------------------------------------------------------------------------------------------

export interface CallState {
  readonly status: CallStatus
  readonly sentAt: Date
  readonly seenAt: Date | null
  readonly onTheWayAt: Date | null
}

/** Why this step is refused now, or null. A responder's "seen" only on a call nobody saw; "on my way" once. */
export function stepRefusal(call: CallState, step: CallStep): CallRefusal | null {
  if (call.status === 'SOLVED') return CALL_REFUSALS.SOLVED
  if (call.status === 'CANCELLED') return CALL_REFUSALS.CANCELLED
  if (step === 'SEEN' && call.status !== 'SENT') return call.status === 'SEEN' ? CALL_REFUSALS.ALREADY_SEEN : CALL_REFUSALS.ALREADY_ON_THE_WAY
  if (step === 'ON_THE_WAY' && call.status === 'ON_THE_WAY') return CALL_REFUSALS.ALREADY_ON_THE_WAY
  return null
}

export interface StepInput {
  readonly at: Date
  /** Who took it: an office user or a floor worker; null where nobody is named (a station at a site that names none). */
  readonly takerId: string | null
  readonly actor: CallActor
  readonly resolutionCode?: string | null | undefined
  readonly resolutionNote?: string | null | undefined
}

export interface StepChange {
  readonly status: CallStatus
  readonly seenAt?: Date
  readonly seenById?: string | null
  readonly onTheWayAt?: Date
  readonly onTheWayById?: string | null
  readonly solvedAt?: Date
  readonly solvedById?: string | null
  readonly resolutionCode?: string | null
  readonly resolutionNote?: string | null
  readonly cancelledAt?: Date
  readonly cancelledById?: string | null
}

/** The latest time the call has: a step is never before it (each time after the one before). */
const latestOf = (call: CallState): Date => [call.sentAt, call.seenAt, call.onTheWayAt].reduce<Date>((latest, at) => (at && at.getTime() > latest.getTime() ? at : latest), call.sentAt)

/**
 * The columns a step (not refused) writes. A responder's "on my way" or "solved" also marks a call nobody had seen as seen
 * at the same moment by them; the station's own "it's solved" or "cancel" marks nothing it did not do.
 */
export function stepChange(call: CallState, step: CallStep, input: StepInput): StepChange {
  const latest = latestOf(call)
  const at = input.at.getTime() < latest.getTime() ? latest : input.at
  const seen = input.actor === 'RESPONDER' && call.seenAt === null && step !== 'CANCELLED' ? { seenAt: at, seenById: input.takerId } : {}
  switch (step) {
    case 'SEEN':
      return { status: 'SEEN', seenAt: at, seenById: input.takerId }
    case 'ON_THE_WAY':
      return { status: 'ON_THE_WAY', ...seen, onTheWayAt: at, onTheWayById: input.takerId }
    case 'SOLVED':
      return { status: 'SOLVED', ...seen, solvedAt: at, solvedById: input.takerId, resolutionCode: input.resolutionCode ?? null, resolutionNote: input.resolutionNote?.trim() || null }
    case 'CANCELLED':
      return { status: 'CANCELLED', cancelledAt: at, cancelledById: input.takerId }
  }
}

// ---- times ---------------------------------------------------------------------------------------------------------------

const secondsBetween = (from: Date, to: Date | null): number | null => (to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000)) : null)

export interface CallTimes {
  /** Sent → seen (a responder's first step marks it seen): the call's response time. */
  readonly responseSeconds: number | null
  /** Sent → someone on the way. */
  readonly onTheWaySeconds: number | null
  /** Sent → solved. */
  readonly resolveSeconds: number | null
}

/** A call's own times (MES-145): never a person's figure. */
export function callTimes(call: { readonly sentAt: Date; readonly seenAt: Date | null; readonly onTheWayAt: Date | null; readonly solvedAt: Date | null }): CallTimes {
  return { responseSeconds: secondsBetween(call.sentAt, call.seenAt), onTheWaySeconds: secondsBetween(call.sentAt, call.onTheWayAt), resolveSeconds: secondsBetween(call.sentAt, call.solvedAt) }
}

/** Whole seconds since a call was sent (the elapsed time the floor shows big). */
export const secondsOpen = (sentAt: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / 1000))

/** The median of whole numbers, rounded (null for none). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

/** Open and nobody on the way yet, for longer than the waiting minutes ("Waiting over 5 minutes"). */
export function isWaiting(call: CallState, now: Date): boolean {
  return (call.status === 'SENT' || call.status === 'SEEN') && now.getTime() - call.sentAt.getTime() >= CALL_LIMITS.waitingMinutes * 60_000
}

/** When a call was sent: the tablet's time of a queued call when believable, else the server's. */
export function sentAtOf(deviceTime: Date | null, now: Date): Date {
  if (!deviceTime) return now
  const ahead = deviceTime.getTime() - now.getTime()
  if (ahead > CALL_LIMITS.aheadMs || -ahead > CALL_LIMITS.behindMs) return now
  return ahead > 0 ? now : deviceTime
}

// ---- the line view and the line TV --------------------------------------------------------------------------------------

/** A station's state from its open calls: someone needed (CALLING), everyone coming (COMING), nothing open (CLEAR). */
export function stationCallState(open: readonly { readonly status: string }[]): StationCallState {
  if (open.length === 0) return 'CLEAR'
  return open.some((call) => call.status === 'SENT' || call.status === 'SEEN') ? 'CALLING' : 'COMING'
}

// ---- calls by hour -------------------------------------------------------------------------------------------------------

export interface HourCall {
  readonly sentAt: Date
  readonly seenAt: Date | null
  readonly kind: CallKind
  readonly lineId: string | null
}

export interface CallsByHour {
  readonly hours: readonly { readonly hour: number; readonly calls: number; readonly byKind: Readonly<Record<CallKind, number>>; readonly byLine: readonly { readonly lineId: string | null; readonly count: number }[] }[]
  readonly byKind: readonly { readonly kind: CallKind; readonly calls: number; readonly answered: number; readonly medianResponseSeconds: number | null }[]
}

/** The hour (0-23) of an instant in a time zone. */
export function hourIn(instant: Date, timeZone: string): number {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(instant))
  return hour === 24 ? 0 : hour
}

const zeroKinds = (): Record<CallKind, number> => Object.fromEntries(CALL_KINDS.map((kind) => [kind, 0])) as Record<CallKind, number>

/** A day's calls per hour, by kind and by line, and each kind's median response time (design production.calls "Calls by hour"). */
export function callsByHour(calls: readonly HourCall[], timeZone: string): CallsByHour {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, byKind: zeroKinds(), lines: new Map<string | null, number>() }))
  const responses = new Map<CallKind, { calls: number; seconds: number[] }>()
  for (const call of calls) {
    const slot = hours[hourIn(call.sentAt, timeZone)]!
    slot.calls += 1
    slot.byKind[call.kind] += 1
    slot.lines.set(call.lineId, (slot.lines.get(call.lineId) ?? 0) + 1)
    const entry = responses.get(call.kind) ?? { calls: 0, seconds: [] }
    entry.calls += 1
    const seconds = callTimes({ sentAt: call.sentAt, seenAt: call.seenAt, onTheWayAt: null, solvedAt: null }).responseSeconds
    if (seconds !== null) entry.seconds.push(seconds)
    responses.set(call.kind, entry)
  }
  return {
    hours: hours.map((slot) => ({ hour: slot.hour, calls: slot.calls, byKind: slot.byKind, byLine: [...slot.lines.entries()].map(([lineId, count]) => ({ lineId, count })) })),
    byKind: CALL_KINDS.filter((kind) => responses.has(kind)).map((kind) => {
      const entry = responses.get(kind)!
      return { kind, calls: entry.calls, answered: entry.seconds.length, medianResponseSeconds: median(entry.seconds) }
    }),
  }
}

// ---- the types (routing) ------------------------------------------------------------------------------------------------

export interface TypeDraft {
  readonly code?: string | undefined
  readonly escalateAfterMinutes?: number | null | undefined
  readonly sortOrder?: number | undefined
}

/** The problems of a type's fields, each at its field. */
export function typeDraftProblems(draft: TypeDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.code !== undefined && !REASON_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits and underscores, starting with a letter (a code of the help-call reason list).' })
  const minutes = draft.escalateAfterMinutes
  if (minutes !== undefined && minutes !== null && (!Number.isInteger(minutes) || minutes < CALL_LIMITS.escalateMinutes.min || minutes > CALL_LIMITS.escalateMinutes.max)) {
    problems.push({ path: 'escalateAfterMinutes', message: `Escalate after ${CALL_LIMITS.escalateMinutes.min} to ${CALL_LIMITS.escalateMinutes.max} minutes, or never.` })
  }
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0)) problems.push({ path: 'sortOrder', message: 'The order is a whole number from 0.' })
  return problems
}

/** The tiles' order: the types' order, then their code. */
export const typeOrder = <Type extends { readonly sortOrder: number; readonly code: string }>(types: readonly Type[]): Type[] =>
  [...types].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

/** The order after the last one (types added later go to the end). */
export const nextTypeOrder = (orders: Iterable<number>): number => {
  let last = 0
  for (const order of orders) if (order > last) last = order
  return last + 10
}
