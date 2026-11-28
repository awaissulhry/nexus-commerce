import type { CallRefusal, CallStatus } from '../calls/rules'

/**
 * The floor's signals on a basket (owb- order workflow, S5 fl3; LF plan.md § 5 pick C, `_owb-fl-common.md` § 2 settles 2–5,
 * § 3 "fl3"), pure. apps/factory-api applies them: modules/production/calls (problems and asks as help calls, photo and voice
 * on a call, the escalation after 10 minutes, the designer's asks), modules/production/baskets (Do this first, Will be late),
 * modules/production/floornotes (Tell the office, Me).
 *
 *   - Problems and asks are help-call TYPES of the site, by code (no enum change). Problem codes: MATERIAL, DAMAGED, UNCLEAR,
 *     MACHINE, PAPER. Ask codes: ASK_LOGO, ASK_PATCH, ASK_TO_PATCH, ASK_UNCLEAR, ASK_OTHER. Who answers an ask is fixed by its
 *     code (`askTo`): never a pick, one tap fewer. The floor lists the site's ACTIVE types of these codes; a code the site lacks
 *     is not shown; none at all → a sentence, never an empty box.
 *   - A phone has no station of its own: its call goes to the station of its department pick (FloorSession.stationId), else the
 *     device's. No pick → "Pick your department first."
 *   - An open call (SENT or SEEN) past its type's minutes is escalated once (ON_THE_WAY: someone comes; SOLVED, CANCELLED: final).
 *   - Do this first (FIRST) and Will be late (1, 2, 3 or 5 days, a reason) are the team leader's (floor.lead); a list of at
 *     most 50 baskets.
 *   - Tell the office: an idea, something wrong or a thanks, in words, by voice or the kind alone, with or without the worker's
 *     name; without the name nothing of the worker or the device is kept (Statuto dei Lavoratori art. 4: no read mark, no figure,
 *     no name; a PHONE is one person's own, so its device id would name them).
 *
 * Nothing here names or measures a person.
 */

const refusal = (code: string, message: string, fix: string): CallRefusal => Object.freeze({ code, message, fix })

// ---- problems and asks -------------------------------------------------------------------------------------------------------

export const FLOOR_PROBLEM_CODES = ['MATERIAL', 'DAMAGED', 'UNCLEAR', 'MACHINE', 'PAPER'] as const
export type FloorProblemCode = (typeof FLOOR_PROBLEM_CODES)[number]

export const FLOOR_ASK_CODES = ['ASK_LOGO', 'ASK_PATCH', 'ASK_TO_PATCH', 'ASK_UNCLEAR', 'ASK_OTHER'] as const
export type FloorAskCode = (typeof FLOOR_ASK_CODES)[number]

/** The two windows of the basket page: Problem and Ask. */
export const FLOOR_CALL_GROUPS = ['PROBLEM', 'ASK'] as const
export type FloorCallGroup = (typeof FLOOR_CALL_GROUPS)[number]

/** Who answers an ask (the ask tile's "to" chip). */
export const ASK_TO_KINDS = ['DESIGNER', 'TEAM_LEADER'] as const
export type AskTo = (typeof ASK_TO_KINDS)[number]

/** Settle 5: who answers each ask, fixed by the code. */
export const ASK_TO: Readonly<Record<FloorAskCode, AskTo>> = Object.freeze({
  ASK_LOGO: 'DESIGNER',
  ASK_PATCH: 'DESIGNER',
  ASK_UNCLEAR: 'DESIGNER',
  ASK_TO_PATCH: 'TEAM_LEADER',
  ASK_OTHER: 'TEAM_LEADER',
})

/** The ask codes the designer answers (the Design desk's list). */
export const DESIGNER_ASK_CODES: readonly FloorAskCode[] = Object.freeze(FLOOR_ASK_CODES.filter((code) => ASK_TO[code] === 'DESIGNER'))

export const isFloorAskCode = (code: unknown): code is FloorAskCode => (FLOOR_ASK_CODES as readonly unknown[]).includes(code)
export const isFloorProblemCode = (code: unknown): code is FloorProblemCode => (FLOOR_PROBLEM_CODES as readonly unknown[]).includes(code)

/** Who answers a call of this code: an ask's fixed answerer; null for any other code (its type's team answers). */
export function askTo(code: string): AskTo | null {
  return isFloorAskCode(code) ? ASK_TO[code] : null
}

/** The window a code belongs to, or null (a call type the basket page does not list: TEAM_LEADER, MAINTENANCE …). */
export function floorGroupOf(code: string): FloorCallGroup | null {
  if (isFloorProblemCode(code)) return 'PROBLEM'
  if (isFloorAskCode(code)) return 'ASK'
  return null
}

/** The codes of one window, in the design's order. */
export function codesOf(group: FloorCallGroup): readonly string[] {
  return group === 'PROBLEM' ? FLOOR_PROBLEM_CODES : FLOOR_ASK_CODES
}

/**
 * The site's types a window lists: ACTIVE, of the window's codes, in the site's own order (the types come ordered by their
 * sortOrder). A code the site lacks is simply not there.
 */
export function floorTypesFor<Type extends { readonly code: string; readonly active: boolean }>(types: readonly Type[], group: FloorCallGroup): Type[] {
  const codes = codesOf(group)
  return types.filter((type) => type.active && codes.includes(type.code))
}

/** The sentence a window shows when the site has none of its codes (never an empty box). */
export const NO_FLOOR_TYPES: Readonly<Record<FloorCallGroup, string>> = Object.freeze({
  PROBLEM: 'This site has no problem tiles yet. Ask the office to add them (Floor rules & codes › Help-call routing).',
  ASK: 'This site has no ask tiles yet. Ask the office to add them (Floor rules & codes › Help-call routing).',
})

/** A phone's refusals when its call has no station to go to (code NO_STATION, as a tablet's: the screen offers the pick). */
export const PHONE_CALL_REFUSALS = Object.freeze({
  NO_DEPARTMENT: refusal('NO_STATION', 'Pick your department first.', 'Tap your department at the top, then send it again.'),
  NO_DEPARTMENT_STATION: refusal('NO_STATION', 'This department has no station at this site. Ask the office to add one.', 'Ask the office to add a station for this department; call out loud meanwhile.'),
} satisfies Record<string, CallRefusal>)

/**
 * The words of a call with no station: a phone (or any device whose session picked a department) gets the phone's words, a
 * tablet keeps today's.
 */
export function noStationRefusal(place: { readonly phone: boolean; readonly departmentId: string | null }, tabletRefusal: CallRefusal): CallRefusal {
  if (place.departmentId) return PHONE_CALL_REFUSALS.NO_DEPARTMENT_STATION
  return place.phone ? PHONE_CALL_REFUSALS.NO_DEPARTMENT : tabletRefusal
}

// ---- photo and voice on a call -------------------------------------------------------------------------------------------------

export const CALL_FILE_LIMITS = Object.freeze({
  /** A voice note runs at most two minutes (an add-on, never the only record: the tile says what it is about). */
  voiceSeconds: 120,
  /** Photos and voice notes on one call. */
  filesPerCall: 6,
})

/** The kind of a file on a call by its type: a picture is a PHOTO, a sound an AUDIO voice note; anything else none. */
export function callFileKindOf(contentType: string): 'PHOTO' | 'AUDIO' | null {
  const type = contentType.trim().toLowerCase()
  if (type.startsWith('image/')) return 'PHOTO'
  if (type.startsWith('audio/')) return 'AUDIO'
  return null
}

/** The place on the basket picture a problem points at: one of 9 spots (0–8). */
export const CALL_SPOTS = 9
export const isCallSpot = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CALL_SPOTS

// ---- escalation ------------------------------------------------------------------------------------------------------------------

/** The states that escalate: nobody is on the way yet. */
export const ESCALATING_STATUSES = ['SENT', 'SEEN'] as const satisfies readonly CallStatus[]

/** How far back the job looks for calls to escalate (the longest escalation is 240 minutes; a day covers a missed run). */
export const ESCALATION_LOOK_BACK_MINUTES = 24 * 60

/**
 * When the call escalates, or null: open and nobody on the way (SENT, SEEN), not escalated yet, its type names minutes, and
 * those minutes have passed since it was sent. Once only: an escalated call never escalates again.
 */
export function escalationDue(call: { readonly status: string; readonly sentAt: Date; readonly escalatedAt: Date | null }, minutes: number | null, now: Date): Date | null {
  if (call.escalatedAt !== null || minutes === null || minutes <= 0) return null
  if (!(ESCALATING_STATUSES as readonly string[]).includes(call.status)) return null
  const dueAt = new Date(call.sentAt.getTime() + minutes * 60_000)
  return dueAt.getTime() <= now.getTime() ? dueAt : null
}

/** Whole minutes a call is open (the red card's "12 min"). */
export const minutesOpen = (sentAt: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / 60_000))

// ---- Do this first, Will be late -------------------------------------------------------------------------------------------------

export const BASKET_FLAG_KINDS = ['FIRST'] as const
export type BasketFlagKind = (typeof BASKET_FLAG_KINDS)[number]

export const LATE_DAYS = [1, 2, 3, 5] as const
export type LateDays = (typeof LATE_DAYS)[number]
export const isLateDays = (value: unknown): value is LateDays => (LATE_DAYS as readonly unknown[]).includes(value)

export const LATE_REASONS = ['MATERIAL', 'MACHINE', 'PEOPLE', 'REDO'] as const
export type LateReason = (typeof LATE_REASONS)[number]

export const LATE_STATES = ['OPEN', 'KEPT', 'CHANGED'] as const
export type LateState = (typeof LATE_STATES)[number]

/** Most baskets in one act ("all baskets of the order"). */
export const BASKET_SIGNAL_LIMITS = Object.freeze({ bundles: 50 })

/**
 * The late warnings one "Will be late" writes: one per work order of the baskets named. The warning names its basket when it
 * is about one basket of that work order, else none (the whole work order).
 */
export function lateWarningsOf(baskets: readonly { readonly id: string; readonly workOrderId: string }[]): { readonly workOrderId: string; readonly bundleId: string | null; readonly bundleIds: string[] }[] {
  const byWorkOrder = new Map<string, string[]>()
  for (const basket of baskets) {
    const ids = byWorkOrder.get(basket.workOrderId) ?? []
    if (!ids.includes(basket.id)) ids.push(basket.id)
    byWorkOrder.set(basket.workOrderId, ids)
  }
  return [...byWorkOrder.entries()].map(([workOrderId, bundleIds]) => ({ workOrderId, bundleId: bundleIds.length === 1 ? bundleIds[0]! : null, bundleIds }))
}

/**
 * The device's id for each row one act writes (the rows' unique (device, client event id)): the act's own id for a single row,
 * `<id>.<n>` (n from 1) for several. Stable for the same act, so a resent act names the same rows.
 */
export function rowEventIds(clientEventId: string, rows: number): string[] {
  if (rows <= 1) return [clientEventId]
  return Array.from({ length: rows }, (_, index) => `${clientEventId}.${index + 1}`)
}

// ---- Tell the office -----------------------------------------------------------------------------------------------------------

export const SUGGESTION_KINDS = ['IDEA', 'WRONG', 'THANKS'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const SUGGESTION_LIMITS = Object.freeze({ words: 1000, voiceSeconds: 120 })

/**
 * Why a suggestion cannot go, or null. Words, a voice note or the kind alone (a thank-you in one tap): words are never blank
 * and at most 1000 letters (the …_floor_baskets_2 guard says the same).
 */
export function suggestionProblem(input: { readonly words: string | null }): string | null {
  if (input.words !== null && input.words.trim().length === 0) return 'Write a few words, or send it without words.'
  if (input.words && input.words.length > SUGGESTION_LIMITS.words) return `Keep it to ${SUGGESTION_LIMITS.words} letters.`
  return null
}

// ---- the refusals of these acts -----------------------------------------------------------------------------------------------

export const SIGNAL_REFUSALS = Object.freeze({
  TOO_MANY: refusal('TOO_MANY', `At most ${BASKET_SIGNAL_LIMITS.bundles} baskets at once.`, 'Pick fewer baskets, then send it again.'),
  CALL_CLOSED: refusal('CALL_CLOSED', 'This call is closed: a photo or a voice note goes on an open call.', 'Send a new call if help is still needed.'),
  NOT_YOUR_CALL: refusal('NOT_YOUR_CALL', 'Only the phone or the station that sent this call adds to it.', 'Send your own call, or ask your team leader.'),
  TOO_MANY_FILES: refusal('TOO_MANY_FILES', `A call takes at most ${CALL_FILE_LIMITS.filesPerCall} photos and voice notes.`, 'Say the rest to the team leader when they come.'),
  NOT_AN_ASK: refusal('NOT_AN_ASK', 'This call is not an ask for the designer.', 'Answer it from Help calls.'),
  NO_ANSWER_WORDS: refusal('NO_ANSWER_WORDS', 'Write the answer the worker reads.', 'Add a few words, then send it again.'),
  NOT_A_BASKET: refusal('NOT_A_BASKET', 'This basket is not one of this site.', 'Scan the basket again, or ask your team leader.'),
  SUGGESTION_WORDS: refusal('SUGGESTION_WORDS', 'Write a few words, or send it without words.', 'Change the words, then send it again.'),
  NO_VOICE: refusal('NO_VOICE', 'This voice note is not ready (or not yours to send).', 'Record it again, then send it.'),
} satisfies Record<string, CallRefusal>)
