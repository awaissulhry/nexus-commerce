import { HAND_STAGES, STAGE_SET_REASON_CODES, STAGE_SET_REFUSAL_WORDS, floorAlreadyWords, handStageChoicesOf, stageSetAskProblems, type HandStage, type HandStageChoice, type StageSetReasonCode } from '@nexus/factory-domain/production-brand/stage-set'
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
 * F-MS-103 (set the stage by hand, 04 §3; review R3b, R8, R9, R18, R20; Owner D4, D9) — the dialog's rules, pure. ONE dialog sets and
 * changes the stage by hand ("Set the stage by hand…", "Change…"); Clear… is a confirm. Everything it judges is the domain's
 * (production-brand/stage-set: handStageChoicesOf, stageSetAskProblems and the refusal words) — never a web copy of a rule.
 *
 *   the stages   one row per stage, Preparing to Ready to ship: what the floor's counts already did ("Done, from the floor's counts")
 *                and where the floor is now ("Now, from the floor's counts") are never picked; Ready to ship never (only quality's
 *                release of every piece makes it Ready); Change… pre-picks the stage set, and a lower one still above the floor is
 *                allowed (a correction, never told: D9)
 *   the reason   one of the domain's four (office only); the note is optional except for "Something else" — one line of at most
 *                200 characters, and its hint says never name a person on the floor (Statuto art. 4, R20)
 *   the lines    the customer reads it as a plain stage; when the stage moves forward the customer is told after the 10-minute window
 *                (Owner D4; clear it before then and it is not told; after that Clear does not take back what it read, R3b); the
 *                customer's changes are judged on the floor's records — key the cuts in as soon as the floor can (R18). No line about
 *                Mark urgent (R8: the customer's own urgent mark keeps reading the real cuts).
 *   the write    PUT /production/brand-orders/:orderId/stage {stage, reasonCode, note only when typed, version} — the version is the
 *                headline's production row's as read, null only when the headline has no row yet (R1, R9); DELETE …?version= clears
 *                it. A refusal is said in the dialog in this page's words (the domain's own, it + en; "changed meanwhile" when the
 *                version moved), what was typed stays.
 */

/**
 * The window before the customer is told of a stage set by hand forward (Owner D4: 10 minutes; a mistake cleared inside it is never
 * told), in minutes for the words: B-MS-008, the domain's HAND_STAGE_NOTICE_DELAY_MS — the one the API's notice waits.
 */
export const NOTICE_WAIT_MINUTES = HAND_STAGE_NOTICE_DELAY_MS / 60_000

/** One row of the stage pick: its stage, the domain's choice, whether it is pickable, and its line under the title (null: none). */
export interface StageChoiceRow {
  readonly stage: PlainStage
  readonly choice: HandStageChoice
  readonly disabled: boolean
  readonly note: HandWords | null
}

const ROW_NOTE: Readonly<Record<HandStageChoice, HandWords | null>> = Object.freeze({
  DONE: { key: 'where.manual.rowDone' },
  NOW: { key: 'where.manual.rowNow' },
  OPEN: null,
  SET: { key: 'where.manual.rowSet' },
  READY_HELD: STAGE_SET_REFUSAL_WORDS.NEVER_READY,
})

/** The rows for the floor's stage and the hand stage standing (if any): the domain's handStageChoicesOf, in the dialog's words. */
export function stageChoicesOf(floor: BrandStage, hand: BrandStage | null): readonly StageChoiceRow[] {
  return handStageChoicesOf(floor, hand).map((row) => ({ stage: plainStageOf(row.stage), choice: row.choice, disabled: row.choice !== 'OPEN' && row.choice !== 'SET', note: ROW_NOTE[row.choice] }))
}

/** What the dialog opens on: the floor, the hand stage standing, the rows, and what it pre-fills (Change…: the stage, reason and note set). */
export interface StageByHandStart {
  /** A Change… while a hand stage stands (else a Set: a Change whose hand stage went meanwhile opens as a Set). */
  readonly changing: boolean
  readonly floor: BrandStage
  readonly hand: BrandStage | null
  readonly rows: readonly StageChoiceRow[]
  readonly pick: PlainStage | null
  readonly reasonCode: string
  readonly note: string
}

/**
 * The floor's own stage: while a hand stage stands the headline's `byHand.floor` (read live by the API); else the headline's stage is
 * the floor's. Not known (an older answer, a read without it): Preparing — the API judges against the live floor and refuses in words.
 */
export function stageByHandStartOf(mode: 'set' | 'change', headline: Headline | null | undefined): StageByHandStart {
  const stage = headline?.stage ?? null
  const standing = stage?.byHand ?? null
  const floor: BrandStage = standing ? (standing.floor?.code ?? 'PREPARING') : (stage?.code ?? 'PREPARING')
  const changing = mode === 'change' && !!standing
  const hand = standing ? standing.stage : null
  const rows = stageChoicesOf(floor, hand)
  const known = !!standing && (STAGE_SET_REASON_CODES as readonly string[]).includes(standing.reasonCode)
  return {
    changing,
    floor,
    hand,
    rows,
    pick: changing && hand ? (rows.find((row) => row.stage === hand && !row.disabled)?.stage ?? null) : null,
    reasonCode: changing && known ? standing!.reasonCode : '',
    note: changing ? (standing!.note ?? '') : '',
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
const FLOOR_BY_EN: ReadonlyMap<string, Words> = new Map(BRAND_STAGES.map((stage) => [floorAlreadyWords(stage).en, floorAlreadyWords(stage)] as const))

/**
 * Why Go waits (null: it may go), in this order: a write running; no stage picked (or one the floor's counts already did, or Ready);
 * no reason; then the domain's own rule of the note (stageSetAskProblems: "Something else" needs a note; one line of at most 200
 * characters, spaces around it not counted).
 */
export function stageByHandHeld(input: StageByHandAsk & { readonly rows: readonly StageChoiceRow[]; readonly busy: boolean }): HandWords | null {
  if (input.busy) return { key: 'held.busy' }
  if (!input.stage || !input.rows.some((row) => row.stage === input.stage && !row.disabled)) return { key: 'where.manual.held.stage' }
  if (!(STAGE_SET_REASON_CODES as readonly string[]).includes(input.reasonCode)) return { key: 'raise.held.pick', ns: 'production' }
  const issue = stageSetAskProblems({ stage: input.stage, reasonCode: input.reasonCode, note: input.note })[0]
  return issue ? (REFUSAL_BY_EN.get(issue.message ?? '') ?? { key: 'where.manual.held.stage' }) : null
}

/** The body of PUT …/stage: the stage, the reason, the note only when typed (trimmed), the production row's version as read. */
export interface StageByHandBody {
  readonly stage: HandStage
  readonly reasonCode: StageSetReasonCode
  readonly note?: string
  /** The headline's production version; null only when the headline has no row yet (the set makes it, R1). */
  readonly version: number | null
}

/** The request a Set or a Change sends (asked only once Go is not held: a hand stage, a known reason). */
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
  /** What the customer reads, in the customer's own words (the domain's STAGE_WORDS: the portal's). */
  readonly customer?: Words
  readonly minutes?: number
}

/**
 * The lines under the fields, always in this order: the customer reads a plain stage; the notice and its 10-minute window (R3b);
 * going back (a lower Change: not told, D9) or the same stage (not told again); the customer's changes judged on the floor's records
 * (R18); with a stage picked, when it clears by itself. No Mark urgent line (R8).
 */
export function stageDialogLinesOf(input: { readonly hand: BrandStage | null; readonly pick: PlainStage | null }): DialogLine[] {
  const lines: DialogLine[] = [{ key: 'where.manual.customer' }, { key: 'where.manual.told', minutes: NOTICE_WAIT_MINUTES }]
  const { hand, pick } = input
  if (hand && pick && BRAND_STAGES.indexOf(pick) < BRAND_STAGES.indexOf(hand)) lines.push({ key: 'where.manual.back', customer: STAGE_WORDS[pick] })
  else if (hand && pick === hand) lines.push({ key: 'where.manual.same', customer: STAGE_WORDS[pick] })
  lines.push({ key: 'where.manual.cuts' })
  if (pick) lines.push({ key: 'where.manual.clears', stage: pick })
  return lines
}

/**
 * Clear…'s lines (null: no hand stage stands): inside the 10-minute window the customer has not been told the stage yet and now never
 * is (Owner D4); after it, it was told and is not told it again; then what it reads again, with no notice.
 */
export function clearLinesOf(headline: Headline | null | undefined, now: number): DialogLine[] | null {
  const hand = headline?.stage?.byHand ?? null
  if (!hand) return null
  const at = Date.parse(hand.at)
  const inside = Number.isFinite(at) && now - at < HAND_STAGE_NOTICE_DELAY_MS // B-MS-008
  const lines: DialogLine[] = [inside ? { key: 'where.manual.clearUntold', customer: STAGE_WORDS[hand.stage], minutes: NOTICE_WAIT_MINUTES } : { key: 'where.manual.clearTold', customer: STAGE_WORDS[hand.stage] }]
  if (hand.floor) lines.push({ key: 'where.manual.clearFloor', customer: STAGE_WORDS[hand.floor.code] })
  return lines
}

/**
 * A refused set, change or clear in this page's words, said in its dialog: the domain's own words when the API answers them (the
 * order's state: not started, paused, nothing left …; the ask's note), "The floor already shows {stage}", "The stage changed
 * meanwhile: it was read again" for any other conflict (the version moved), the held words without the right, else the page's
 * write words (another customer's order reads as not found: the API's wall, never a hint).
 */
export function stageRefusalOf(error: unknown): Phrase | Words {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const words = REFUSAL_BY_EN.get(issue.message ?? '') ?? FLOOR_BY_EN.get(issue.message ?? '')
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
