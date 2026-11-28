import type { TaskProblem } from '../../tasks/shared/task-api'
import type { CallFlag, CallTypeRow, DepartmentPicked, HelpRead, Raised } from './api'

/**
 * owb-fl8 — the rules of a basket's problems and asks on a phone, without React or the network, so the tests hold them
 * (design § 4.4, § 5zf B–D; P/core.js PROBLEMS, ASKS_F, ASK_TO; P/fplus.js probCard, fCallCards; P/reprint.js; settles 1–5).
 *
 *   tiles        the site's ACTIVE types of the settle-5 codes, in the design's order; a code the site lacks is not shown; none at
 *                all → a sentence, never an empty box
 *   asks         who answers is fixed by the code (askTo), no pick: one tap fewer; the tile shows the "to" chip
 *   department   a phone tells a problem only after its department pick (HelpCall.stationId stays required): one tap, offered in
 *                the window when missing; a department with no station answers in words
 *   one tap      online: the office answers at once; a second worker's tap of the same type at the same station answers "Already
 *                told for B-0431: the team leader comes." (today's one open call per station and type); offline: saved here
 *   the card     Told → The team leader comes → Solved, with the minutes; no answer in its time → "It is at the office now";
 *                "Page lost or damaged" says "The office prints it again" until the print solves it
 *   media        a photo, a voice note and the place need the network ("Needs the network")
 */

export const PROBLEM_CODES = ['MATERIAL', 'DAMAGED', 'UNCLEAR', 'MACHINE', 'PAPER'] as const
export type ProblemCode = (typeof PROBLEM_CODES)[number]

export const ASK_CODES = ['ASK_LOGO', 'ASK_PATCH', 'ASK_TO_PATCH', 'ASK_UNCLEAR', 'ASK_OTHER'] as const
export type AskCode = (typeof ASK_CODES)[number]

/** "Something else (voice)": the ask that records a voice note before it goes. */
export const VOICE_ASK: AskCode = 'ASK_OTHER'

export const isProblemCode = (code: string): code is ProblemCode => (PROBLEM_CODES as readonly string[]).includes(code)
export const isAskCode = (code: string): code is AskCode => (ASK_CODES as readonly string[]).includes(code)

export type AskTo = 'DESIGNER' | 'TEAM_LEADER'

/** Who answers an ask, fixed by its code (settle 5): logo, patch and an unclear design → the designer; the rest → the team leader. */
export function askTo(code: AskCode): AskTo {
  switch (code) {
    case 'ASK_LOGO':
    case 'ASK_PATCH':
    case 'ASK_UNCLEAR':
      return 'DESIGNER'
    case 'ASK_TO_PATCH':
    case 'ASK_OTHER':
      return 'TEAM_LEADER'
  }
}

export interface HelpTile<C extends string> {
  readonly code: C
  readonly typeId: string
}

/** The tiles of one group: the site's active types of these codes, in the codes' order (never a code the site lacks). */
export function tilesOf<C extends string>(types: readonly CallTypeRow[], codes: readonly C[]): HelpTile<C>[] {
  return codes.flatMap((code) => {
    const type = types.find((row) => row.code === code && row.active !== false)
    return type ? [{ code, typeId: type.id }] : []
  })
}

// ---- the department pick (settle 2-3) ---------------------------------------------------------------------------------------

/** A phone with no department picked tells nothing yet: the window offers the pick first. */
export const needsDepartment = (read: Pick<HelpRead, 'here'>, pickedHere = false): boolean => (read.here?.departmentId ?? null) === null && !pickedHere

export type PickOutcome = { readonly kind: 'taken' } | { readonly kind: 'choose'; readonly stations: readonly { readonly id: string; readonly name: string }[] } | { readonly kind: 'none' }

/** What the pick answered: one station → taken; several → the phone lists their names once; none → words. */
export function pickOutcome(answer: DepartmentPicked): PickOutcome {
  if (answer.station) return { kind: 'taken' }
  if (answer.choose.length > 0) return { kind: 'choose', stations: answer.choose }
  return { kind: 'none' }
}

// ---- one tap tells it --------------------------------------------------------------------------------------------------------

export type RaiseOutcome =
  /** Told: the office has it (or it was this basket's own open call). */
  | { readonly kind: 'told'; readonly callId: string }
  /** The station's open call of the type is for another basket (settle 4). */
  | { readonly kind: 'already'; readonly callId: string; readonly basketCode: string }
  /** No department picked (or a station of it): pick first. */
  | { readonly kind: 'department' }
  /** Saved on this phone; it goes when the network is back. */
  | { readonly kind: 'saved'; readonly clientEventId: string }
  /** A refusal or a failure, in the screen's words. */
  | { readonly kind: 'problem'; readonly problem: TaskProblem }

/** The online answer, or the item kept on the phone, as the window says it. */
export function raiseOutcome(result: { readonly kept: { readonly clientEventId: string } | null; readonly answer: { readonly ok: true; readonly value: Raised } | { readonly ok: false; readonly problem: TaskProblem } | null }, bundleId: string): RaiseOutcome {
  if (result.kept) return { kind: 'saved', clientEventId: result.kept.clientEventId }
  const answer = result.answer
  if (!answer) return { kind: 'problem', problem: { kind: 'unavailable' } }
  if (!answer.ok) return answer.problem.kind === 'refused' && answer.problem.code === 'NO_STATION' ? { kind: 'department' } : { kind: 'problem', problem: answer.problem }
  const { call, existing } = answer.value
  const other = call.bundle && call.bundle.id !== bundleId ? call.bundle : null
  return existing && other ? { kind: 'already', callId: call.id, basketCode: other.code } : { kind: 'told', callId: call.id }
}

// ---- the red card (problem) and the ask card ------------------------------------------------------------------------------------

export type CardState = 'TOLD' | 'COMES' | 'OFFICE' | 'SOLVED'

/**
 * Told → The team leader comes → Solved; a told call past its type's minutes (the server's `escalated`) is "at the office now".
 * Someone on the way wins over the office (the design's probState). A cancelled call shows no card.
 */
export function cardStateOf(flag: Pick<CallFlag, 'state' | 'escalated'> | null | undefined): CardState | null {
  if (!flag) return null
  switch (flag.state) {
    case 'SENT':
      return flag.escalated ? 'OFFICE' : 'TOLD'
    case 'SEEN':
    case 'ON_THE_WAY':
      return 'COMES'
    case 'SOLVED':
      return 'SOLVED'
    default:
      return null
  }
}

/** The card's words for its state (`floor-help2` keys): a lost or damaged page is the office's print, not the team leader's walk. */
export function cardWordsKey(state: CardState, typeCode: string): string {
  if (typeCode === 'PAPER' && (state === 'TOLD' || state === 'COMES')) return 'card.state.reprint'
  return `card.state.${state}`
}

/** The card's tone: told amber, coming blue, at the office red, solved green (never colour alone: an icon and words with it). */
export const CARD_TONE: Readonly<Record<CardState, 'warning' | 'info' | 'danger' | 'success'>> = { TOLD: 'warning', COMES: 'info', OFFICE: 'danger', SOLVED: 'success' }

/** The ask card's words: asked → works on it → answered. */
export function askStateKey(flag: Pick<CallFlag, 'state'>): 'ask.state.asked' | 'ask.state.taken' | 'ask.state.answered' | null {
  switch (flag.state) {
    case 'SENT':
      return 'ask.state.asked'
    case 'SEEN':
    case 'ON_THE_WAY':
      return 'ask.state.taken'
    case 'SOLVED':
      return 'ask.state.answered'
    default:
      return null
  }
}

/** The leader's buttons on a call that waits for them: On my way while nobody comes, Solved while it is open. */
export function leaderButtons(flag: Pick<CallFlag, 'state' | 'escalated'>): readonly ('ON_THE_WAY' | 'SOLVED')[] {
  const state = cardStateOf(flag)
  if (state === 'TOLD' || state === 'OFFICE') return ['ON_THE_WAY', 'SOLVED']
  if (state === 'COMES') return ['SOLVED']
  return []
}

/** The worker's own Solved stands on an open call (the design's card), never on a solved one. */
export const workerCanSolve = (flag: Pick<CallFlag, 'state' | 'escalated'>): boolean => {
  const state = cardStateOf(flag)
  return state !== null && state !== 'SOLVED'
}

/** Who answers calls on the floor: the team leader (and a technician or inspector at their site), by today's right. */
export const ANSWER_RIGHT = 'production.calls.answer'
export const answersCalls = (permissions: readonly string[]): boolean => permissions.includes(ANSWER_RIGHT)

/** The place on the picture is offered only where the read carries it (fl0 kept HelpCall.spot). */
export const spotShown = (flag: CallFlag | null | undefined): boolean => Boolean(flag) && Object.prototype.hasOwnProperty.call(flag, 'spot') && flag!.spot !== undefined

export const SPOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

/** A spot's place on the picture, in percent of its width and height (three by three, the middle of each cell). */
export function spotPlace(spot: number): { readonly left: number; readonly top: number } {
  const column = spot % 3
  const row = Math.floor(spot / 3)
  return { left: column * 33.33 + 16.67, top: row * 33.33 + 16.67 }
}

// ---- the network ------------------------------------------------------------------------------------------------------------

/** A photo, a voice note or the place goes up only online; the words are "Needs the network". */
export const mediaHeld = (online: boolean): 'offline' | null => (online ? null : 'offline')

/** A voice note's length in whole seconds for the server (at least 1, at most 120: server B's limit). */
export const voiceSeconds = (seconds: number | null | undefined, fallback: number): number => {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : fallback
  return Math.min(120, Math.max(1, Math.round(value)))
}

/** The file's name as the office sees it: the basket, what it is, the time it was taken (never a person). */
export function mediaName(basketCode: string, kind: 'photo' | 'voice', at: Date, type: string): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const ext = kind === 'photo' ? (type.includes('png') ? 'png' : 'jpg') : type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
  return `${basketCode}-${kind}-${stamp}.${ext}`
}
