import { daysFrom } from '../calendars/dates'
import type { Issue } from '../core/errors'
import { businessDate, type BusinessDate } from '../core/time'
import type { Words } from '../portal/tasks/kinds'
import type { SalesOrderStatus } from '../sales/orders/orders'
import { BRAND_STAGES, brandStageRank, type BrandStage } from './stages'
import { STAGE_WORDS } from './words'

/**
 * B-MS-001 (set the stage by hand, plan.md D1–D9; design A; review fixes R4, R14, R19, R21) — B-SC-001 (stage control B, "full
 * control", Owner's pick 2026-11-21: it reverses 11-20 D1 "Ready only through quality" and "only ahead of the floor"): the ONE named
 * exception to "a stage is only the floor's and quality's", pure. A person of the office with production.brand.manage sets the stage
 * the customer reads where the work really is — forward when the floor cannot record work that is done (the system or the scanners
 * are down, too few people to record it, the work is at an outside workshop), back when the floor's records are wrong (a wrong scan:
 * "Something else" with a note) — with a reason and an office-only note, audited. Only the stage: the piece counts, quality's
 * records, the shipments, the freeze and change cut-offs, Mark urgent and planning stay on the floor's real records.
 *
 *   which      any of the five stages (HAND_STAGES = BRAND_STAGES), forward or back of the stage the customer reads, also below
 *              the floor and also Ready to ship (READY_UNRELEASED_WORDS warns while quality has not released every piece: the
 *              order's status stays quality's); never the stage it reads already (sameStageWords: a Set), never the floor's own
 *              stage while a hand stage stands (floorStageWords: Clear is the one way back to the floor)
 *   where      an order In production or Partly shipped only (R4: a Confirmed order has no released work order yet), never
 *              while the customer's own pause stands (R19: our own production or quality hold allows it)
 *   shown      while it stands the keeper writes the hand stage into BrandOrderProduction.stage, higher or lower than the
 *              floor's (shownStageOf). The floor's stage is never stored: a reader that needs it reads the facts, never `stage`
 *   ends       (E1, "the floor agrees or moves on") when the floor's stage equals it; set ahead of the floor (hand above
 *              `floorAtSet`, the floor's stage when it was set or changed), when the floor reaches or passes it; set back (hand
 *              below `floorAtSet`), when the floor moves past where it stood at the set — a real release after a wrong scan:
 *              quality's truth takes over; with no `floorAtSet` (never for a command-made set), as ahead. Also when no goods
 *              line is left open (handStands), by Clear, or when the order leaves production. No time limit: the office's tag
 *              turns amber after 7 days (handSetOld)
 *   Change     replaces it, forward or back (handMoveOf: a move back of what the customer reads is told as a correction); at
 *              the same stage it changes only the reason or the note (office fields: the customer is told nothing), and with
 *              stage, reason and note all unchanged there is nothing to change (NOTHING_TO_CHANGE)
 *
 * The customer reads a plain stage and the usual notice (a move back: one "Correction: …" notice), never "by hand", the reason,
 * the note or who set it (the five columns are hidden from the partner role and are portal-read FORBIDDEN_BRAND_KEYS). No reason
 * names a person (Statuto art. 4): the note's hint says never name a person on the floor.
 */

/** The stages a person may set by hand (B-SC-001: all five — Preparing … Ready to ship). */
export const HAND_STAGES = BRAND_STAGES
export type HandStage = (typeof HAND_STAGES)[number]

export const isHandStage = (stage: string): stage is HandStage => (HAND_STAGES as readonly string[]).includes(stage)

/** Why the floor could not record it (the database's StageSetReason; office only). OTHER needs a note. */
export const STAGE_SET_REASON_CODES = ['OUTAGE', 'FEW_PEOPLE', 'OUTSIDE', 'OTHER'] as const
export type StageSetReasonCode = (typeof STAGE_SET_REASON_CODES)[number]

/** The office-only note beside a hand stage: one line. */
export const STAGE_SET_NOTE_MAX = 200
/** After this many days with the floor still behind, the office's tag turns amber ("check it"). Nothing moves on its own. */
export const STAGE_SET_CHECK_DAYS = 7
/** The order states a stage may be set by hand in. */
export const STAGE_SET_STATUSES = ['IN_PRODUCTION', 'PARTLY_SHIPPED'] as const satisfies readonly SalesOrderStatus[]

const ONE_LINE = /^[^\r\n]+$/

/**
 * Does a hand stage still stand (B-SC-001, end rule E1)? Not with no goods line open (floor null), not once the floor's stage equals
 * it; set ahead (`hand` above `floorAtSet`, the floor's stage when it was set or changed; null: not known, read as ahead), not once
 * the floor reaches or passes it; set back (`hand` below `floorAtSet`), not once the floor moves past where it stood at the set.
 */
export function handStands(floorNow: BrandStage | null, hand: BrandStage, floorAtSet: BrandStage | null): boolean {
  if (floorNow === null || !isHandStage(hand) || floorNow === hand) return false
  if (floorAtSet !== null && brandStageRank(hand) < brandStageRank(floorAtSet)) return brandStageRank(floorNow) <= brandStageRank(floorAtSet)
  return brandStageRank(floorNow) < brandStageRank(hand)
}

/**
 * The stage the customer reads, and what the keeper writes into `stage`: the hand stage while it stands (handStands; higher or lower
 * than the floor's), else the floor's. With no goods line open (floor null) no hand stage stands: null, as the floor's.
 */
export function shownStageOf(floor: BrandStage, hand: BrandStage | null, floorAtSet: BrandStage | null): BrandStage
export function shownStageOf(floor: BrandStage | null, hand: BrandStage | null, floorAtSet: BrandStage | null): BrandStage | null
export function shownStageOf(floor: BrandStage | null, hand: BrandStage | null, floorAtSet: BrandStage | null): BrandStage | null {
  if (floor === null) return null
  return hand !== null && handStands(floor, hand, floorAtSet) ? hand : floor
}

/** B-SC-001: a move of the stage the customer reads — forward, back (told as a correction) or the same. */
export type HandMove = 'FORWARD' | 'BACK' | 'SAME'
export function handMoveOf(from: BrandStage, to: BrandStage): HandMove {
  const step = brandStageRank(to) - brandStageRank(from)
  return step > 0 ? 'FORWARD' : step < 0 ? 'BACK' : 'SAME'
}

// ---- the refusals, in words -----------------------------------------------------------------------------------------------

export const STAGE_SET_REFUSALS = ['NOT_STARTED', 'ALREADY_READY', 'PRODUCTION_OVER', 'NOTHING_LEFT', 'PAUSED', 'NOTHING_TO_CHANGE', 'UNKNOWN_STAGE', 'UNKNOWN_REASON', 'NOTE_NEEDED', 'NOTE_TOO_LONG'] as const
export type StageSetRefusal = (typeof STAGE_SET_REFUSALS)[number]

/** The office's words of each refusal (IT "tu"; "la fase" is feminine). The API answers the English; the web maps it. */
export const STAGE_SET_REFUSAL_WORDS: Readonly<Record<StageSetRefusal, Words>> = Object.freeze({
  NOT_STARTED: {
    it: "La produzione non è ancora iniziata: una fase si imposta a mano solo quando l'ordine è in produzione.",
    en: 'Production has not started yet: a stage is set by hand only once the order is in production.',
  },
  // B-SC-001: the status READY is quality's (it released every piece), so its stage is no longer set by hand.
  ALREADY_READY: {
    it: "L'ordine è Pronto per la spedizione: la qualità ha rilasciato ogni capo, quindi la fase non si imposta più a mano.",
    en: 'The order is Ready to ship: quality released every piece, so its stage is no longer set by hand.',
  },
  PRODUCTION_OVER: {
    it: 'La produzione di questo ordine è finita: una fase si imposta a mano solo mentre è in produzione.',
    en: 'Production is over for this order: a stage is set by hand only while it is in production.',
  },
  NOTHING_LEFT: {
    it: "Su questo ordine non resta niente da produrre: non c'è una fase da impostare a mano.",
    en: 'Nothing is left to make on this order: there is no stage to set by hand.',
  },
  PAUSED: { it: 'In pausa su richiesta del cliente: togli prima la pausa.', en: "Paused at the customer's request: lift the pause first." },
  // B-SC-001: a Change at the stage set by hand with the same reason and the same note.
  NOTHING_TO_CHANGE: {
    it: 'Niente da cambiare: la fase impostata a mano è già questa, con lo stesso motivo e la stessa nota.',
    en: 'Nothing to change: the stage set by hand already reads so, with the same reason and note.',
  },
  UNKNOWN_STAGE: { it: `Atteso uno tra ${HAND_STAGES.join(', ')}.`, en: `Expected one of ${HAND_STAGES.join(', ')}.` },
  UNKNOWN_REASON: { it: `Atteso uno tra ${STAGE_SET_REASON_CODES.join(', ')}.`, en: `Expected one of ${STAGE_SET_REASON_CODES.join(', ')}.` },
  NOTE_NEEDED: { it: 'Per «Altro» serve una nota.', en: 'Something else needs a note.' },
  NOTE_TOO_LONG: {
    it: `La nota è una riga di al massimo ${STAGE_SET_NOTE_MAX} caratteri.`,
    en: `The note is one line of at most ${STAGE_SET_NOTE_MAX} characters.`,
  },
})

// ── B-SC-001: the two state refusals of a stage asked, and the warning of Ready by hand ──
/** "The customer already reads Sewing." — the stage asked is the one the customer reads now (409). */
export const sameStageWords = (stage: BrandStage): Words => ({ it: `Il cliente legge già ${STAGE_WORDS[stage].it}.`, en: `The customer already reads ${STAGE_WORDS[stage].en}.` })

/** "Cutting is the floor's own stage: …" — the live floor's stage asked while a hand stage stands (409): Clear goes back to it. */
export const floorStageWords = (stage: BrandStage): Words => ({
  it: `${STAGE_WORDS[stage].it} è la fase del reparto: togli la fase impostata a mano per tornarci.`,
  en: `${STAGE_WORDS[stage].en} is the floor's own stage: clear the stage set by hand to go back to it.`,
})

/** Ready to ship by hand while the floor is not Ready: a WARNING the dialog shows, never a refusal. */
export const READY_UNRELEASED_WORDS: Words = Object.freeze({
  it: 'La qualità non ha rilasciato tutti i capi: il cliente legge Pronto per la spedizione, i capi restano come li ha registrati la qualità.',
  en: 'Quality has not released every piece: the customer reads Ready to ship, the pieces stay as quality recorded them.',
})
// ── end B-SC-001 ──

/** What the order's state refuses (the API's 409), from the order now: its status, the live floor and the customer's pause. */
export interface StageSetState {
  readonly status: SalesOrderStatus
  /** The floor's stage read live under the keeper's lock (null: no goods line is open). */
  readonly floor: BrandStage | null
  /** B-SC-001: the stage the customer reads now — the row's stage after the keeper's pass in the same command (null: none). */
  readonly shown: BrandStage | null
  /** The hand stage standing now (null: a Set; else a Change, forward or back). */
  readonly hand: BrandStage | null
  /** B-SC-001: the standing hand stage's reason and office note (a Change at the same stage must change one of them). */
  readonly handReason?: string | null
  readonly handNote?: string | null
  /** The customer's own pause stands (a BRAND_PAUSE blocker). */
  readonly paused: boolean
}

/** What the person asks (the API's body: 400). */
export interface StageSetAsk {
  readonly stage: string
  readonly reasonCode: string
  readonly note?: string | null | undefined
}

/** What the ask itself breaks, whatever the order (paths under `at`): a hand stage, a known reason, the note's rules. */
export function stageSetAskProblems(input: StageSetAsk, at = 'body'): Issue[] {
  const issues: Issue[] = []
  const words = (refusal: StageSetRefusal) => STAGE_SET_REFUSAL_WORDS[refusal].en
  // B-SC-001: any of the five stages; Preparing and Ready are no longer refused.
  if (!isHandStage(input.stage)) issues.push({ path: `${at}/stage`, message: words('UNKNOWN_STAGE') })
  if (!(STAGE_SET_REASON_CODES as readonly string[]).includes(input.reasonCode)) issues.push({ path: `${at}/reasonCode`, message: words('UNKNOWN_REASON') })
  const note = input.note?.trim() ?? ''
  if (note === '' && input.reasonCode === 'OTHER') issues.push({ path: `${at}/note`, message: words('NOTE_NEEDED') })
  else if (note !== '' && (note.length > STAGE_SET_NOTE_MAX || !ONE_LINE.test(note))) issues.push({ path: `${at}/note`, message: words('NOTE_TOO_LONG') })
  return issues
}

/** One line of the office's note as compared: trimmed, empty = none. */
const noteOf = (note: string | null | undefined): string | null => note?.trim() || null

/**
 * What the order now refuses of a stage asked (paths under `at`): only In production or Partly shipped (R4), something left to
 * make, not while the customer's own pause stands (R19); B-SC-001: a Set never at the stage the customer reads already; a Change at
 * the stage set by hand only with another reason or note (else nothing to change); never the live floor's own stage while a hand
 * stage stands (Clear goes back to it). A stage that is no stage at all is the ask's problem (stageSetAskProblems), not the order's.
 */
export function stageSetStateProblems(input: StageSetState & { readonly stage: string; readonly reasonCode?: string; readonly note?: string | null | undefined }, at = 'body'): Issue[] {
  const words = (refusal: StageSetRefusal) => STAGE_SET_REFUSAL_WORDS[refusal].en
  const path = `${at}/stage`
  if (!(STAGE_SET_STATUSES as readonly string[]).includes(input.status)) {
    const why: StageSetRefusal =
      input.status === 'PENDING_APPROVAL' || input.status === 'CONFIRMED' ? 'NOT_STARTED' : input.status === 'READY' ? 'ALREADY_READY' : 'PRODUCTION_OVER'
    return [{ path, message: words(why) }]
  }
  if (input.floor === null) return [{ path, message: words('NOTHING_LEFT') }]
  const issues: Issue[] = []
  if (input.paused) issues.push({ path, message: words('PAUSED') })
  if (!isHandStage(input.stage)) return issues
  const shown = input.shown ?? input.floor
  if (input.stage === shown) {
    // A Change of the office's words at the standing hand stage is taken (the customer is told nothing); unchanged, refused.
    const change = input.hand !== null && input.stage === input.hand
    if (!change) issues.push({ path, message: sameStageWords(shown).en })
    else if ((input.reasonCode ?? null) === (input.handReason ?? null) && noteOf(input.note) === noteOf(input.handNote)) issues.push({ path, message: words('NOTHING_TO_CHANGE') })
  } else if (input.hand !== null && input.stage === input.floor) issues.push({ path, message: floorStageWords(input.floor).en })
  return issues
}

/** Everything a stage set by hand as asked would break, the order's refusals first. */
export function stageSetProblems(input: StageSetState & StageSetAsk, at = 'body'): Issue[] {
  return [...stageSetStateProblems(input, at), ...stageSetAskProblems(input, at)]
}

// ---- the dialog's rows ----------------------------------------------------------------------------------------------------

/**
 * B-SC-001: how the dialog reads each stage, against the stage the customer reads (`shown`): NOW the stage it reads (never picked);
 * FLOOR the live floor's own stage while a hand stage stands (never picked: Clear… is the one way back to the floor); AHEAD a stage
 * after it, BACK one before it (a move back: told as a correction). `readyUnreleased`: Ready to ship while the floor is not Ready
 * (the dialog shows READY_UNRELEASED_WORDS).
 */
export const HAND_STAGE_CHOICES = ['NOW', 'FLOOR', 'AHEAD', 'BACK'] as const
export type HandStageChoice = (typeof HAND_STAGE_CHOICES)[number]

export interface HandStageRow {
  readonly stage: BrandStage
  readonly choice: HandStageChoice
  readonly readyUnreleased: boolean
}

/**
 * One row per stage, Preparing to Ready to ship: `floor` the live floor's stage (null: no goods line open), `shown` the stage the
 * customer reads, `hand` the hand stage standing (null: none).
 */
export function handStageChoicesOf(input: { readonly floor: BrandStage | null; readonly shown: BrandStage; readonly hand: BrandStage | null }): readonly HandStageRow[] {
  const { floor, shown, hand } = input
  return BRAND_STAGES.map((stage): HandStageRow => {
    const readyUnreleased = stage === 'READY' && floor !== 'READY'
    if (stage === shown) return { stage, choice: 'NOW', readyUnreleased }
    if (hand !== null && floor !== null && stage === floor) return { stage, choice: 'FLOOR', readyUnreleased }
    return { stage, choice: brandStageRank(stage) > brandStageRank(shown) ? 'AHEAD' : 'BACK', readyUnreleased }
  })
}

// ---- the office's reminder and its export -----------------------------------------------------------------------------------

/** Set by hand STAGE_SET_CHECK_DAYS days ago or more (calendar days, company time): the office's tag turns amber. */
export function handSetOld(setAt: Date | string, today: BusinessDate): boolean {
  const at = typeof setAt === 'string' ? new Date(setAt) : setAt
  if (!Number.isFinite(at.getTime())) return false
  return daysFrom(businessDate(at), today) >= STAGE_SET_CHECK_DAYS
}

/** Beside a stage set by hand in the office's export: "Sewing (by hand)". Never a customer's word. */
export const STAGE_BY_HAND_WORDS: Words = Object.freeze({ it: '(a mano)', en: '(by hand)' })

// ── B-MS-008 (Owner D4; review R3a) ──
/**
 * The undo window: how long the customer's notice of a stage set by hand forward waits before the worker makes it (Owner D4: 10
 * minutes), so a mistake cleared or changed inside it is never told. Only the notice waits — the portal reads the stage at once —
 * and only a stage set by hand: the floor's own stages are told at once. The event says so with its `byHand` flag (./events
 * stageNoticeWaitMs); a Clear or a Change inside the window leaves the stage untold (the API's keeper), so the real stage is told
 * when the floor reaches it.
 */
export const HAND_STAGE_NOTICE_DELAY_MS = 600_000
// ── end B-MS-008 ──
