import { HAND_STAGES, READY_UNRELEASED_WORDS, STAGE_SET_REASON_CODES, STAGE_SET_REFUSAL_WORDS, floorStageWords, handMoveOf, handStageChoicesOf, sameStageWords, stageSetAskProblems, type HandStage, type HandStageChoice, type StageSetReasonCode } from '@nexus/factory-domain/production-brand/stage-set'
import { HAND_STAGE_NOTICE_DELAY_MS } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-008
import { STAGE_WORDS } from '@nexus/factory-domain/production-brand/words'
import { isApiError } from '../../../../../lib/api/errors'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { PlainStage } from '../../../../../lib/production/model'
import { HELD_FOR_SALES } from '../../../../../lib/production/work-order-acts/model'
import { productionWordsFor } from '../../../../../lib/production/words'
import { writeProblem, type Phrase } from '../../model'
import { BRAND_STAGES, type BrandStage, type Headline, type Words } from './api'
import { plainStageOf, type HandWords } from './where'

/**
 * F-MS-103 (set the stage by hand, 04 §3; review R3b, R8, R9, R18, R20; Owner D4) — the dialog's rules, pure. ONE dialog sets and
 * changes the stage by hand ("Set the stage by hand…", "Change…", or a step of the stages picked); Clear… is a confirm. Everything it
 * judges is the domain's (production-brand/stage-set: handStageChoicesOf, handMoveOf, stageSetAskProblems and the refusal words) —
 * never a web copy of a rule.
 *
 * F-SC-W1 (stage control B, the Owner's pick 2026-11-21; 40-stage-plan §1, §3): full control — any of the five stages, forward or back,
 * also below what the floor recorded (a wrong scan), and Ready to ship by hand with a warning. Only the stage moves: work orders, counts,
 * quality and shipments stay as recorded.
 *
 *   the stages   one row per stage, Preparing to Ready to ship: the stage the customer reads now (never picked in a Set: it is there
 *                already; F-SC-W6: in Change… it is the hand stage standing, pre-picked, so its reason or note can be changed alone);
 *                while a hand stage stands, the floor's own stage (never picked: Clear… is the one way back to it); every other one
 *                ahead or back of what the customer reads — Ready to ship with the warning when quality has not released every piece
 *   the reason   one of the domain's four (office only; a wrong record is "Something else" with a note); the note is optional except for
 *                "Something else" — one line of at most 200 characters, and its hint says never name a person on the floor (Statuto
 *                art. 4, R20)
 *   the lines    the customer reads it as a plain stage; a move forward is told after the 10-minute window (Owner D4: clear it before then
 *                and it is not told); a move back is told as a correction after the same window, only when the customer was told the
 *                stage it leaves; the customer's changes are judged on the floor's records — key the cuts in as soon as the floor can
 *                (R18); when it clears by itself (forward: the floor reaches it; back: the floor comes back to it or passes the stage it
 *                was at). No line about Mark urgent (R8).
 *   the write    PUT /production/brand-orders/:orderId/stage {stage, reasonCode, note only when typed, version} — the version is the
 *                headline's production row's as read, null only when the headline has no row yet (R1, R9); DELETE …?version= clears
 *                it. A refusal is said in the dialog in this page's words (the domain's own, it + en; "changed meanwhile" when the
 *                version moved), what was typed stays.
 */

/**
 * The window before the customer is told of a stage set by hand (Owner D4: 10 minutes; a mistake cleared inside it is never told), in
 * minutes for the words: B-MS-008, the domain's HAND_STAGE_NOTICE_DELAY_MS — the one the API's notice waits.
 */
export const NOTICE_WAIT_MINUTES = HAND_STAGE_NOTICE_DELAY_MS / 60_000

/**
 * One row of the stage pick: its stage, the domain's choice, whether it is pickable, its line under the title (null: none), and — Ready
 * to ship only — whether quality has not released every piece (the dialog warns when it is picked).
 */
export interface StageChoiceRow {
  readonly stage: PlainStage
  readonly choice: HandStageChoice
  readonly disabled: boolean
  readonly note: HandWords | null
  readonly readyUnreleased: boolean
}

const ROW_NOTE: Readonly<Record<HandStageChoice, HandWords | null>> = Object.freeze({
  NOW: { key: 'where.manual.rowNow' },
  FLOOR: { key: 'where.manual.rowFloor' },
  AHEAD: null,
  BACK: { key: 'where.manual.rowBack' },
})

/**
 * What the rows are judged against: the floor's own stage, the stage the customer reads now, the hand stage standing (if any), and —
 * F-SC-W6 — whether it is a Change… of that hand stage (its own row may then be kept, to change the reason or the note alone).
 */
export interface StageChoiceInput {
  readonly floor: BrandStage
  readonly shown: BrandStage
  readonly hand: BrandStage | null
  readonly changing?: boolean
}

/** The rows: the domain's handStageChoicesOf, in the dialog's words (Ready to ship not yet released by quality: the domain's warning). */
export function stageChoicesOf(input: StageChoiceInput): readonly StageChoiceRow[] {
  const { changing = false, ...against } = input
  return handStageChoicesOf(against).map((row) => {
    // F-SC-W6: a Change… keeps the hand stage standing pickable (the server takes it when the reason or the note differs).
    const keep = changing && row.choice === 'NOW' && row.stage === input.hand
    return {
      stage: plainStageOf(row.stage),
      choice: row.choice,
      disabled: (row.choice === 'NOW' && !keep) || row.choice === 'FLOOR',
      note: keep ? { key: 'where.manual.rowKeep' } : row.readyUnreleased && row.choice === 'AHEAD' ? READY_UNRELEASED_WORDS : ROW_NOTE[row.choice],
      readyUnreleased: row.readyUnreleased,
    }
  })
}

/** What the dialog opens on: the floor, the stage shown, the hand stage standing, the rows, and what it pre-fills. */
export interface StageByHandStart {
  /** A Change… while a hand stage stands (else a Set: a Change whose hand stage went meanwhile opens as a Set). */
  readonly changing: boolean
  readonly floor: BrandStage
  /** The stage the customer reads now (the headline's). */
  readonly shown: BrandStage
  readonly hand: BrandStage | null
  /** F-SC-W6: where the floor was when the hand stage was set (headline byHand.floorAtSet; a Change of words only keeps it). */
  readonly floorAtSet: BrandStage | null
  readonly rows: readonly StageChoiceRow[]
  /**
   * The step picked on the stages (Overview's strip, Production's stage bar), when it may be picked; else Change… pre-picks the hand
   * stage standing (F-SC-W6); else nothing.
   */
  readonly pick: PlainStage | null
  readonly reasonCode: string
  readonly note: string
  /** F-SC-W6: Change… — what stands now (the hand stage, its reason, its note): Go waits while nothing differs from it. */
  readonly kept: StageByHandAsk | null
}

/**
 * The floor's own stage: while a hand stage stands the headline's `byHand.floor` (read live by the API); else the headline's stage is
 * the floor's. Not known (an older answer, a read without it): Preparing — the API judges against the live floor and refuses in words.
 * `pick`: the step picked on the stages (the dialog's `pick`) — kept only when its row may be picked. Change… pre-fills the reason and
 * the note set and — F-SC-W6 — pre-picks the hand stage standing when no other step was clicked (its reason or note may change alone).
 */
export function stageByHandStartOf(mode: 'set' | 'change', headline: Headline | null | undefined, pick: PlainStage | null = null): StageByHandStart {
  const stage = headline?.stage ?? null
  const standing = stage?.byHand ?? null
  const floor: BrandStage = standing ? (standing.floor?.code ?? 'PREPARING') : (stage?.code ?? 'PREPARING')
  const shown: BrandStage = stage?.code ?? floor
  const changing = mode === 'change' && !!standing
  const hand = standing ? standing.stage : null
  const rows = stageChoicesOf({ floor, shown, hand, changing })
  const known = !!standing && (STAGE_SET_REASON_CODES as readonly string[]).includes(standing.reasonCode)
  const pickable = (stage: PlainStage | null) => !!stage && rows.some((row) => row.stage === stage && !row.disabled)
  return {
    changing,
    floor,
    shown,
    hand,
    floorAtSet: standing?.floorAtSet ?? null,
    rows,
    pick: pickable(pick) ? pick : changing && hand && pickable(hand) ? hand : null,
    reasonCode: changing && known ? standing!.reasonCode : '',
    note: changing ? (standing!.note ?? '') : '',
    kept: changing && hand ? { stage: hand, reasonCode: standing!.reasonCode, note: standing!.note ?? '' } : null,
  }
}

/** What the person typed: the stage picked, the reason, the note. */
export interface StageByHandAsk {
  readonly stage: PlainStage | null
  readonly reasonCode: string
  readonly note: string
}

/** The domain's refusal words by their English (the API answers them; the web says them in the page's language). */
const REFUSAL_BY_EN: ReadonlyMap<string, Words> = new Map(Object.values(STAGE_SET_REFUSAL_WORDS).map((words) => [words.en, words] as const))
/** F-SC-W1: "The customer already reads Sewing." and "Sewing is the floor's own stage: clear the stage set by hand to go back to it." */
const STAGE_BY_EN: ReadonlyMap<string, Words> = new Map(BRAND_STAGES.flatMap((stage) => [sameStageWords(stage), floorStageWords(stage)].map((words) => [words.en, words] as const)))

/**
 * Why Go waits (null: it may go), in this order: a write running; no stage picked (or the one the customer reads in a Set, or the
 * floor's own while a hand stage stands); no reason; then the domain's own rule of the note (stageSetAskProblems: "Something else" needs
 * a note; one line of at most 200 characters, spaces around it not counted); F-SC-W6: a Change… where the stage, the reason and the
 * note are all what stands (`kept`; the note compared trimmed, empty = none) — the domain's NOTHING_TO_CHANGE words (the server's 409).
 */
export function stageByHandHeld(input: StageByHandAsk & { readonly rows: readonly StageChoiceRow[]; readonly busy: boolean; readonly kept?: StageByHandAsk | null }): HandWords | null {
  if (input.busy) return { key: 'held.busy' }
  if (!input.stage || !input.rows.some((row) => row.stage === input.stage && !row.disabled)) return { key: 'where.manual.held.stage' }
  if (!(STAGE_SET_REASON_CODES as readonly string[]).includes(input.reasonCode)) return { key: 'raise.held.pick', ns: 'production' }
  const issue = stageSetAskProblems({ stage: input.stage, reasonCode: input.reasonCode, note: input.note })[0]
  if (issue) return REFUSAL_BY_EN.get(issue.message ?? '') ?? { key: 'where.manual.held.stage' }
  const kept = input.kept ?? null
  if (kept && kept.stage === input.stage && kept.reasonCode === input.reasonCode && kept.note.trim() === input.note.trim()) return STAGE_SET_REFUSAL_WORDS.NOTHING_TO_CHANGE
  return null
}

/** The body of PUT …/stage: the stage, the reason, the note only when typed (trimmed), the production row's version as read. */
export interface StageByHandBody {
  readonly stage: HandStage
  readonly reasonCode: StageSetReasonCode
  readonly note?: string
  /** The headline's production version; null only when the headline has no row yet (the set makes it, R1). */
  readonly version: number | null
}

/** The request a Set or a Change sends (asked only once Go is not held: a stage that may be picked, a known reason). */
export function stageByHandBodyOf(ask: StageByHandAsk, headline: Headline | null | undefined): StageByHandBody {
  const note = ask.note.trim()
  const stage = (HAND_STAGES as readonly string[]).includes(ask.stage ?? '') ? (ask.stage as HandStage) : 'CUTTING'
  return { stage, reasonCode: ask.reasonCode as StageSetReasonCode, ...(note ? { note } : {}), version: versionOf(headline) }
}

/** The production row's version as the headline read it (null: no row yet, or an older answer without it). */
export const versionOf = (headline: Headline | null | undefined): number | null => headline?.stage?.version ?? null

/** One line of the dialogs: its key and what it names (a stage in the office's words; what the customer reads in its own words). */
export interface DialogLine {
  readonly key: string
  /** A stage in the office's words (parts.stage.*). */
  readonly stage?: PlainStage
  /** F-SC-W1: the stage the floor was at, a set back clears once the floor's counts pass it (parts.stage.*). */
  readonly past?: PlainStage
  /** What the customer reads, in the customer's own words (the domain's STAGE_WORDS: the portal's). */
  readonly customer?: Words
  readonly minutes?: number
}

/**
 * The lines under the fields, always in this order: the customer reads a plain stage; the notice and its 10-minute window (R3b); going
 * back of what the customer reads — told as a correction after the window, only if it was told the stage it leaves (F-SC-W6: the same
 * stage kept in a Change… — the customer is told nothing, only the reason or the note changes); the customer's
 * changes judged on the floor's records (R18); with a stage picked, when it clears by itself — ahead of the floor once the floor reaches
 * it, below the floor once the floor comes back to it or passes the stage it is at now (F-SC-W6: the same stage kept — judged against
 * where the floor was at the set, which a Change of words only keeps). No Mark urgent line (R8).
 */
export function stageDialogLinesOf(input: { readonly floor: BrandStage; readonly shown: BrandStage; readonly pick: PlainStage | null; readonly floorAtSet?: BrandStage | null }): DialogLine[] {
  const { shown, pick } = input
  const floor = pick && handMoveOf(shown, pick) === 'SAME' ? (input.floorAtSet ?? input.floor) : input.floor
  const lines: DialogLine[] = [{ key: 'where.manual.customer' }, { key: 'where.manual.told', minutes: NOTICE_WAIT_MINUTES }]
  if (pick && handMoveOf(shown, pick) === 'BACK') lines.push({ key: 'where.manual.back', customer: STAGE_WORDS[pick], minutes: NOTICE_WAIT_MINUTES })
  else if (pick && handMoveOf(shown, pick) === 'SAME') lines.push({ key: 'where.manual.same', customer: STAGE_WORDS[pick] }) // F-SC-W6
  lines.push({ key: 'where.manual.cuts' })
  if (pick) {
    const move = handMoveOf(floor, pick)
    if (move === 'FORWARD') lines.push({ key: 'where.manual.clears', stage: pick })
    else if (move === 'BACK') lines.push({ key: 'where.manual.clearsBack', stage: pick, past: plainStageOf(floor) })
  }
  return lines
}

// ---- pt-sc-fx3 (stage walk #1): what the picked step does is in sight when the dialog opens on it ----
/** The lines of the step picked — the move (back: told as a correction; the same stage kept: told nothing) and when it clears. */
export const PICK_LINE_KEYS: ReadonlySet<string> = new Set(['where.manual.back', 'where.manual.same', 'where.manual.clears', 'where.manual.clearsBack'])

/**
 * The dialog's lines in their two places: `pick` — what the step picked does, drawn right under the stages with the Ready warning (in
 * sight when the dialog opens on a step: never under the reason and the note); `after` — the rules that always hold, under the fields.
 */
export function splitDialogLines(lines: readonly DialogLine[]): { readonly pick: readonly DialogLine[]; readonly after: readonly DialogLine[] } {
  return { pick: lines.filter((line) => PICK_LINE_KEYS.has(line.key)), after: lines.filter((line) => !PICK_LINE_KEYS.has(line.key)) }
}
// ---- end pt-sc-fx3

/** F-SC-W1: the warning when Ready to ship is picked while quality has not released every piece (the domain's words; never a refusal). */
export function readyWarningOf(rows: readonly StageChoiceRow[], pick: PlainStage | null): Words | null {
  return pick === 'READY' && rows.some((row) => row.stage === 'READY' && row.readyUnreleased) ? READY_UNRELEASED_WORDS : null
}

/**
 * Clear…'s lines (null: no hand stage stands). F-SC-W1: Clear goes back to the floor's own stage, told by the one rule of every move —
 * up to the floor (a set back cleared): the customer reads the floor's stage and gets the usual notice; down to the floor (a set ahead
 * cleared): told as a correction when the customer was told the stage set (after the window), else not told — inside the window it is
 * left untold, never told: it is not told now. What the customer was told is the API's notice (the keeper's markers, B-MS-008); none read
 * (an older answer) or the floor not known: no line — never a guess.
 */
export function clearLinesOf(headline: Headline | null | undefined, now: number): DialogLine[] | null {
  const hand = headline?.stage?.byHand ?? null
  if (!hand) return null
  const floor = hand.floor?.code ?? null
  if (!floor) return []
  const move = handMoveOf(hand.stage, floor)
  if (move === 'FORWARD') return [{ key: 'where.manual.clearForward', customer: STAGE_WORDS[floor] }]
  if (move === 'SAME') return []
  const told = toldLineOf(hand, now) // B-MS-008 (ms-fx1)
  if (!told) return []
  return told.key === 'where.manual.clearCorrection' ? [told] : [told, { key: 'where.manual.clearFloor', customer: STAGE_WORDS[floor] }]
}

// ---- B-MS-008 (ms-fx1; Z01 note 2): Clear… says what the customer was told from the API's notice (the keeper's markers), never from
// the set's time — a Change to the same stage writes a new one and tells nothing, a set of a stage told before tells nothing ----
/**
 * The told line of a hand stage Clear… lowers: a notice still waiting its window (Owner D4) — not told yet, and now never is; told (the
 * notice went, the floor told it, or the window is over: a notice sent stays sent) — F-SC-W1: told the correction after the window;
 * never told (a notice dropped) — and not told now. No notice read (an older answer): no line — never a guess.
 */
function toldLineOf(hand: NonNullable<NonNullable<Headline['stage']>['byHand']>, now: number): DialogLine | null {
  const notice = hand.notice ?? null
  if (!notice) return null
  const customer = STAGE_WORDS[hand.stage]
  const goes = notice.waitsUntil ? Date.parse(notice.waitsUntil) : Number.NaN
  if (!notice.told && Number.isFinite(goes) && now < goes) return { key: 'where.manual.clearUntold', customer, minutes: NOTICE_WAIT_MINUTES }
  if (notice.told || Number.isFinite(goes)) return { key: 'where.manual.clearCorrection', customer, minutes: NOTICE_WAIT_MINUTES }
  return { key: 'where.manual.clearNever', customer }
}
// ---- end B-MS-008 (ms-fx1)

/**
 * A refused set, change or clear in this page's words, said in its dialog: the domain's own words when the API answers them (the
 * order's state: not started, paused, nothing left …; the ask's note; F-SC-W1: "The customer already reads {stage}", "{stage} is the
 * floor's own stage: clear the stage set by hand to go back to it"), "The stage changed meanwhile: it was read again" for any other
 * conflict (the version moved), the held words without the right, else the page's write words (another customer's order reads as not
 * found: the API's wall, never a hint).
 */
export function stageRefusalOf(error: unknown): Phrase | Words {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const words = REFUSAL_BY_EN.get(issue.message ?? '') ?? STAGE_BY_EN.get(issue.message ?? '')
      if (words) return words
    }
    if (error.kind === 'conflict') return { key: 'where.manual.refused' }
    if (error.kind === 'forbidden') return { ...HELD_FOR_SALES }
  }
  return { key: writeProblem(error).key }
}

/** "Sewing set by hand: the customer reads Sewing." — the office's word of the stage, then the customer's own. */
export function setNoticeOf(stage: PlainStage, locale: Locale): Phrase {
  return { key: 'where.manual.notice', params: { stage: productionWordsFor(locale)(`parts.stage.${stage}`), customer: STAGE_WORDS[stage][locale === 'it' ? 'it' : 'en'] } }
}

/** "Back to the floor's stage: Preparing." (the floor's stage now, as the API answers; not known: the plain words). */
export function clearNoticeOf(floor: PlainStage | null, locale: Locale): Phrase {
  return floor ? { key: 'where.manual.cleared', params: { floor: productionWordsFor(locale)(`parts.stage.${floor}`) } } : { key: 'where.manual.clearedPlain' }
}
