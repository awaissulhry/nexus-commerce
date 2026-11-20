import { daysFrom } from '../calendars/dates'
import type { Issue } from '../core/errors'
import { businessDate, type BusinessDate } from '../core/time'
import type { Words } from '../portal/tasks/kinds'
import type { SalesOrderStatus } from '../sales/orders/orders'
import { BRAND_STAGES, brandStageRank, type BrandStage } from './stages'
import { STAGE_WORDS } from './words'

/**
 * B-MS-001 (set the stage by hand, plan.md D1–D9; design A; review fixes R4, R14, R19, R21): the ONE named exception to "a stage
 * is only the floor's and quality's", pure. When the floor cannot record work that is done (the system or the scanners are
 * down, too few people to record it, the work is at an outside workshop), a person of the office with production.brand.manage
 * puts the order's stage ahead, with a reason and an office-only note, audited. Only the stage: the piece counts, Ready, the
 * freeze and change cut-offs, Mark urgent and planning stay on the floor's real records.
 *
 *   which      Cutting, Sewing or Quality check (HAND_STAGES), only ahead of the floor; never Preparing (where every order
 *              starts) and never Ready to ship (only quality's release of every piece makes it Ready: Owner D1)
 *   where      an order In production or Partly shipped only (R4: a Confirmed order has no released work order yet), never
 *              while the customer's own pause stands (R19: our own production or quality hold allows it)
 *   shown      the keeper writes the SHOWN stage into BrandOrderProduction.stage: the higher of the floor's and the hand stage
 *              (shownStageOf). The floor's stage is never stored: a reader that needs it reads the facts, never `stage`
 *   ends       when the floor reaches or passes it, when no goods line is left open (handStands), by Clear, or when the order
 *              leaves production; no time limit, the office's tag turns amber after 7 days (handSetOld)
 *   Change     replaces it; it may go down while it stays above the floor (Owner D9: a correction, never told again)
 *
 * The customer reads a plain stage and the usual notice, never "by hand", the reason, the note or who set it (the five
 * columns are hidden from the partner role and are portal-read FORBIDDEN_BRAND_KEYS). No reason names a person (Statuto
 * art. 4): the note's hint says never name a person on the floor.
 */

/** The stages a person may set by hand (never PREPARING, never READY). */
export const HAND_STAGES = ['CUTTING', 'SEWING', 'QUALITY'] as const satisfies readonly BrandStage[]
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

/** Does a hand stage still stand? Not once the floor reaches or passes it, nor when no goods line is open (floor null). */
export function handStands(floorNow: BrandStage | null, hand: BrandStage): boolean {
  return floorNow !== null && isHandStage(hand) && brandStageRank(hand) > brandStageRank(floorNow)
}

/**
 * The stage the customer reads, and what the keeper writes into `stage`: the higher of the floor's and the hand stage. With no
 * goods line open (floor null) no hand stage stands: null, as the floor's.
 */
export function shownStageOf(floor: BrandStage, hand: BrandStage | null): BrandStage
export function shownStageOf(floor: BrandStage | null, hand: BrandStage | null): BrandStage | null
export function shownStageOf(floor: BrandStage | null, hand: BrandStage | null): BrandStage | null {
  if (floor === null) return null
  return hand !== null && handStands(floor, hand) ? hand : floor
}

// ---- the refusals, in words -----------------------------------------------------------------------------------------------

export const STAGE_SET_REFUSALS = ['NOT_STARTED', 'ALREADY_READY', 'PRODUCTION_OVER', 'NOTHING_LEFT', 'PAUSED', 'NEVER_READY', 'NEVER_PREPARING', 'UNKNOWN_STAGE', 'UNKNOWN_REASON', 'NOTE_NEEDED', 'NOTE_TOO_LONG'] as const
export type StageSetRefusal = (typeof STAGE_SET_REFUSALS)[number]

/** The office's words of each refusal (IT "tu"; "la fase" is feminine). The API answers the English; the web maps it. */
export const STAGE_SET_REFUSAL_WORDS: Readonly<Record<StageSetRefusal, Words>> = Object.freeze({
  NOT_STARTED: {
    it: "La produzione non è ancora iniziata: una fase si imposta a mano solo quando l'ordine è in produzione.",
    en: 'Production has not started yet: a stage is set by hand only once the order is in production.',
  },
  ALREADY_READY: {
    it: "L'ordine è già Pronto per la spedizione: non c'è una fase più avanti da impostare a mano.",
    en: 'The order is already Ready to ship: there is no stage ahead to set by hand.',
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
  NEVER_READY: {
    it: 'Solo il rilascio della qualità di ogni capo lo rende Pronto per la spedizione.',
    en: "Only quality's release of every piece makes it Ready to ship.",
  },
  NEVER_PREPARING: {
    it: 'In preparazione non si imposta a mano: scegli Taglio, Cucitura o Controllo qualità.',
    en: 'Preparing is never set by hand: pick Cutting, Sewing or Quality check.',
  },
  UNKNOWN_STAGE: { it: `Atteso uno tra ${HAND_STAGES.join(', ')}.`, en: `Expected one of ${HAND_STAGES.join(', ')}.` },
  UNKNOWN_REASON: { it: `Atteso uno tra ${STAGE_SET_REASON_CODES.join(', ')}.`, en: `Expected one of ${STAGE_SET_REASON_CODES.join(', ')}.` },
  NOTE_NEEDED: { it: 'Per «Altro» serve una nota.', en: 'Something else needs a note.' },
  NOTE_TOO_LONG: {
    it: `La nota è una riga di al massimo ${STAGE_SET_NOTE_MAX} caratteri.`,
    en: `The note is one line of at most ${STAGE_SET_NOTE_MAX} characters.`,
  },
})

/** "The floor already shows Sewing." — the stage asked is not ahead of the floor's. */
export const floorAlreadyWords = (floor: BrandStage): Words => ({ it: `Il reparto segna già ${STAGE_WORDS[floor].it}.`, en: `The floor already shows ${STAGE_WORDS[floor].en}.` })

/** What the order's state refuses (the API's 409), from the order now: its status, the live floor and the customer's pause. */
export interface StageSetState {
  readonly status: SalesOrderStatus
  /** The floor's stage read live under the keeper's lock (null: no goods line is open). */
  readonly floor: BrandStage | null
  /** The hand stage standing now (null: a Set; else a Change, which may go down while it stays above the floor). */
  readonly hand: BrandStage | null
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
  if (input.stage === 'READY') issues.push({ path: `${at}/stage`, message: words('NEVER_READY') })
  else if (input.stage === 'PREPARING') issues.push({ path: `${at}/stage`, message: words('NEVER_PREPARING') })
  else if (!isHandStage(input.stage)) issues.push({ path: `${at}/stage`, message: words('UNKNOWN_STAGE') })
  if (!(STAGE_SET_REASON_CODES as readonly string[]).includes(input.reasonCode)) issues.push({ path: `${at}/reasonCode`, message: words('UNKNOWN_REASON') })
  const note = input.note?.trim() ?? ''
  if (note === '' && input.reasonCode === 'OTHER') issues.push({ path: `${at}/note`, message: words('NOTE_NEEDED') })
  else if (note !== '' && (note.length > STAGE_SET_NOTE_MAX || !ONE_LINE.test(note))) issues.push({ path: `${at}/note`, message: words('NOTE_TOO_LONG') })
  return issues
}

/**
 * What the order now refuses of a stage asked (paths under `at`): only In production or Partly shipped (R4), something left to
 * make, not while the customer's own pause stands (R19), and ahead of the live floor. A stage that is no hand stage at all is
 * the ask's problem (stageSetAskProblems), not the order's.
 */
export function stageSetStateProblems(input: StageSetState & { readonly stage: string }, at = 'body'): Issue[] {
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
  if (isHandStage(input.stage) && !handStands(input.floor, input.stage)) issues.push({ path, message: floorAlreadyWords(input.floor).en })
  return issues
}

/** Everything a stage set by hand as asked would break, the order's refusals first. */
export function stageSetProblems(input: StageSetState & StageSetAsk, at = 'body'): Issue[] {
  return [...stageSetStateProblems(input, at), ...stageSetAskProblems(input, at)]
}

// ---- the dialog's rows ----------------------------------------------------------------------------------------------------

/**
 * How the dialog reads each stage: DONE and NOW come from the floor's counts (never picked); OPEN a hand stage ahead of the
 * floor (a person may pick it; below a standing hand stage it is a Change going down); SET the hand stage standing now (a Change
 * pre-picks it); READY_HELD Ready to ship, never by hand.
 */
export const HAND_STAGE_CHOICES = ['DONE', 'NOW', 'OPEN', 'SET', 'READY_HELD'] as const
export type HandStageChoice = (typeof HAND_STAGE_CHOICES)[number]

export interface HandStageRow {
  readonly stage: BrandStage
  readonly choice: HandStageChoice
}

/** One row per stage, Preparing to Ready to ship, against the floor's stage and the hand stage standing (if any). */
export function handStageChoicesOf(floor: BrandStage, hand: BrandStage | null): readonly HandStageRow[] {
  const standing = hand !== null && handStands(floor, hand) ? hand : null
  return BRAND_STAGES.map((stage): HandStageRow => {
    if (brandStageRank(stage) < brandStageRank(floor)) return { stage, choice: 'DONE' }
    if (stage === floor) return { stage, choice: 'NOW' }
    if (stage === 'READY') return { stage, choice: 'READY_HELD' }
    return { stage, choice: stage === standing ? 'SET' : 'OPEN' }
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
