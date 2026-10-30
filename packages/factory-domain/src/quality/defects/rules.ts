import type { Issue } from '../../core/errors'
import { LANGUAGE_CODE, REASON_COLOURS, REASON_ICONS, type ReasonWords } from '../../reasons/rules'

/**
 * The defect library and the disposition codes (B-W2a-26; QHS-001, QHS-005; design quality.defects "Defect library" and
 * "Disposition codes"), pure. apps/factory-api's modules/quality/defects says these rules in words before the database's
 * guards (…_quality_plant_w2a_guards DefectCode_guard, DispositionCode_guard) would refuse the same:
 *
 *   defects       two levels: a category (no parent, no class) and its defects (a category as parent, a default class
 *                 CRITICAL, MAJOR or MINOR); a code is upper-case letters, digits, hyphens and underscores (no spaces),
 *                 unique in the tenant and never changes, nor its category; Italian and English words, the other floor
 *                 languages by ISO 639 code; an icon and a colour from the design system's sets (the tile on the floor);
 *                 the zone of the garment it is usually found in (GARMENT_ZONES), the stages it applies to (none: every
 *                 stage); "Other" asks for a note or a photo (needsDetail). A code in use is retired (inactive), never
 *                 deleted; one nothing names may be deleted.
 *   dispositions  an outcome (use as is, rework, repair, regrade, return to the supplier, quarantine, scrap) with the stock
 *                 move a decision with it posts and the record it opens (OUTCOME_RULES), whether the garments are
 *                 inspected again, and when a decision needs a second person's approval: by the NCR's class (this class
 *                 or worse) or by the value of the goods (the cost grain). The code, outcome, move and follow-up never
 *                 change (decisions keep them): set it inactive and add another.
 */

export const DEFECT_CLASSES = ['CRITICAL', 'MAJOR', 'MINOR'] as const
export type DefectClass = (typeof DEFECT_CLASSES)[number]

/** How bad a class is: CRITICAL first (a lower rank is worse). */
export const CLASS_RANK: Readonly<Record<DefectClass, number>> = Object.freeze({ CRITICAL: 0, MAJOR: 1, MINOR: 2 })

/** The stages of the factory (factory-db holds.prisma QualityStage, in its order; a PG test compares them). */
export const QUALITY_STAGES = ['INCOMING', 'STOCK', 'CUTTING', 'IN_LINE', 'FINAL', 'PACKING', 'CUSTOMER', 'AUDIT'] as const
export type QualityStage = (typeof QUALITY_STAGES)[number]

/**
 * The zones of a rider garment a defect is pinned to (design GarmentZoneMap: EN 17092's impact zones, the seams, the
 * label), front and back. Ids are what DefectCode.zone and InspectionDefect.zone keep (no spaces, the guard's rule).
 */
export const GARMENT_ZONES = [
  { id: 'FRONT', it: 'Davanti', en: 'Front' },
  { id: 'BACK', it: 'Dietro', en: 'Back' },
  { id: 'COLLAR', it: 'Colletto', en: 'Collar' },
  { id: 'SHOULDER', it: 'Spalla', en: 'Shoulder' },
  { id: 'SHOULDER_L', it: 'Spalla sinistra', en: 'Left shoulder' },
  { id: 'SHOULDER_R', it: 'Spalla destra', en: 'Right shoulder' },
  { id: 'SLEEVE_L', it: 'Manica sinistra', en: 'Left sleeve' },
  { id: 'SLEEVE_R', it: 'Manica destra', en: 'Right sleeve' },
  { id: 'ELBOW_L', it: 'Gomito sinistro', en: 'Left elbow' },
  { id: 'ELBOW_R', it: 'Gomito destro', en: 'Right elbow' },
  { id: 'CUFF', it: 'Polsino', en: 'Cuff' },
  { id: 'CHEST', it: 'Petto', en: 'Chest' },
  { id: 'BACK_PROTECTOR', it: 'Tasca paraschiena', en: 'Back protector pocket' },
  { id: 'WAIST', it: 'Vita', en: 'Waist' },
  { id: 'HIP_L', it: 'Anca sinistra', en: 'Left hip' },
  { id: 'HIP_R', it: 'Anca destra', en: 'Right hip' },
  { id: 'SEAT', it: 'Seduta', en: 'Seat' },
  { id: 'KNEE_L', it: 'Ginocchio sinistro', en: 'Left knee' },
  { id: 'KNEE_R', it: 'Ginocchio destro', en: 'Right knee' },
  { id: 'LEG_L', it: 'Gamba sinistra', en: 'Left leg' },
  { id: 'LEG_R', it: 'Gamba destra', en: 'Right leg' },
  { id: 'ZIP', it: 'Cerniera', en: 'Zip' },
  { id: 'POCKET', it: 'Tasca', en: 'Pocket' },
  { id: 'LINING', it: 'Fodera', en: 'Lining' },
  { id: 'LABEL', it: 'Etichetta', en: 'Label' },
] as const
export type GarmentZone = (typeof GARMENT_ZONES)[number]['id']
const ZONE_IDS: ReadonlySet<string> = new Set(GARMENT_ZONES.map((zone) => zone.id))
export const isGarmentZone = (value: string): value is GarmentZone => ZONE_IDS.has(value)

/** A defect's code (the guard: no spaces): upper-case letters, digits, hyphens and underscores, 2-40. */
export const DEFECT_CODE = /^[A-Z][A-Z0-9_-]{1,39}$/
/** A disposition code: upper-case letters, digits and underscores, 2-40. */
export const DISPOSITION_CODE = /^[A-Z][A-Z0-9_]{1,39}$/

export const DEFECT_LIMITS = Object.freeze({ label: 80, languages: 12, perTenant: 500 })

// ---- words -------------------------------------------------------------------------------------------------------------

export interface WordsDraft {
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  /** Other languages; null takes one out. */
  readonly labelI18n?: Readonly<Record<string, string | null>> | undefined
  readonly icon?: string | null | undefined
  readonly colour?: string | null | undefined
}

const blank = (value: string | undefined): boolean => value !== undefined && value.trim() === ''

/** Words, icon and colour (only the fields present are checked). */
export function wordsProblems(draft: WordsDraft, what: 'defect' | 'disposition'): Issue[] {
  const problems: Issue[] = []
  for (const field of ['labelIt', 'labelEn'] as const) {
    const value = draft[field]
    if (blank(value)) problems.push({ path: field, message: field === 'labelIt' ? `Name the ${what} in Italian.` : `Name the ${what} in English.` })
    else if (value !== undefined && value.trim().length > DEFECT_LIMITS.label) problems.push({ path: field, message: `At most ${DEFECT_LIMITS.label} characters.` })
  }
  const entries = Object.entries(draft.labelI18n ?? {})
  if (entries.length > DEFECT_LIMITS.languages) problems.push({ path: 'labelI18n', message: `At most ${DEFECT_LIMITS.languages} other languages.` })
  for (const [language, words] of entries) {
    if (!LANGUAGE_CODE.test(language) || language === 'it' || language === 'en') problems.push({ path: `labelI18n/${language}`, message: 'A language is its ISO 639 code (ro, ur, zh); Italian and English have their own words.' })
    else if (words !== null && words.trim() === '') problems.push({ path: `labelI18n/${language}`, message: 'Leave a language out instead of blank words.' })
    else if (words !== null && words.trim().length > DEFECT_LIMITS.label) problems.push({ path: `labelI18n/${language}`, message: `At most ${DEFECT_LIMITS.label} characters.` })
  }
  if (draft.icon !== undefined && draft.icon !== null && !(REASON_ICONS as readonly string[]).includes(draft.icon)) problems.push({ path: 'icon', message: 'Pick one of the icons offered.' })
  if (draft.colour !== undefined && draft.colour !== null && !(REASON_COLOURS as readonly string[]).includes(draft.colour.toLowerCase())) problems.push({ path: 'colour', message: 'Pick one of the colours offered.' })
  return problems
}

/** The words in a language (it, en, else the other languages), else the English words. */
export function labelIn(row: { readonly labelIt: string; readonly labelEn: string; readonly labelI18n?: ReasonWords | null | undefined }, language: string): string {
  if (language === 'it') return row.labelIt
  if (language === 'en') return row.labelEn
  return row.labelI18n?.[language] ?? row.labelEn
}

// ---- the defect library ------------------------------------------------------------------------------------------------

export interface DefectDraft extends WordsDraft {
  readonly code?: string | undefined
  /** The category (a defect); null or absent on a new code: a category. */
  readonly parentId?: string | null | undefined
  readonly severity?: DefectClass | null | undefined
  readonly zone?: string | null | undefined
  readonly stages?: readonly string[] | undefined
  readonly needsDetail?: boolean | undefined
  readonly sortOrder?: number | undefined
}

/**
 * A new code or a change (only the fields present are checked). `isCategory`: what the code is (a new code: no parent);
 * `parent`: the category a new defect is filed under, as read (null: not found).
 */
export function defectDraftProblems(draft: DefectDraft, facts: { readonly isCategory: boolean; readonly creating: boolean; readonly parent?: { readonly isCategory: boolean } | null }): Issue[] {
  const problems: Issue[] = []
  if (facts.creating && (draft.code === undefined || !DEFECT_CODE.test(draft.code))) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits, hyphens and underscores, starting with a letter (SEAM-OPEN).' })
  problems.push(...wordsProblems(draft, 'defect'))
  if (facts.creating) {
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Name the defect in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Name the defect in English.' })
    if (!facts.isCategory) {
      if (facts.parent === null || facts.parent === undefined) problems.push({ path: 'parentId', message: 'File the defect under a category of the library.' })
      else if (!facts.parent.isCategory) problems.push({ path: 'parentId', message: 'The library has two levels: file the defect under a category, not under another defect.' })
    }
  }
  if (facts.isCategory) {
    if (draft.severity !== undefined && draft.severity !== null) problems.push({ path: 'severity', message: 'A category has no class: its defects have one each.' })
    if (draft.zone !== undefined && draft.zone !== null) problems.push({ path: 'zone', message: 'A category has no zone: its defects have one each.' })
    if (draft.needsDetail === true) problems.push({ path: 'needsDetail', message: 'Only a defect asks for a note.' })
  } else {
    if (facts.creating && (draft.severity === undefined || draft.severity === null)) problems.push({ path: 'severity', message: 'Give the defect its default class: critical, major or minor.' })
    if (!facts.creating && draft.severity === null) problems.push({ path: 'severity', message: 'A defect keeps a default class: critical, major or minor.' })
  }
  if (draft.zone !== undefined && draft.zone !== null && !isGarmentZone(draft.zone)) problems.push({ path: 'zone', message: 'Pick a zone of the garment map.' })
  if (draft.stages !== undefined) {
    const known = draft.stages.filter((stage) => (QUALITY_STAGES as readonly string[]).includes(stage))
    if (known.length !== draft.stages.length) problems.push({ path: 'stages', message: 'Pick stages of the factory (incoming, stock, cutting, in-line, final, packing, customer, audit).' })
    else if (new Set(known).size !== known.length) problems.push({ path: 'stages', message: 'Name each stage once.' })
  }
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0 || draft.sortOrder > 1_000_000)) problems.push({ path: 'sortOrder', message: 'A whole number from 0.' })
  return problems
}

/** The stages in the factory's order. */
export const sortedStages = (stages: readonly string[]): QualityStage[] => QUALITY_STAGES.filter((stage) => stages.includes(stage))

/** Does a defect apply to a stage? (No stages: every stage.) */
export const appliesAt = (stages: readonly string[], stage: QualityStage): boolean => stages.length === 0 || stages.includes(stage)

/** The words of retiring a used code (design df-retire). */
export function retireWords(code: string, used: number): string {
  return used === 0
    ? `${code} is not used yet: retiring it takes it out of the pickers (it can also be deleted).`
    : `${code} is used on ${used} ${used === 1 ? 'record' : 'records'}; it stays on them and leaves the pickers.`
}

// ---- the disposition codes ---------------------------------------------------------------------------------------------

export const DISPOSITION_OUTCOMES = ['USE_AS_IS', 'REWORK', 'REPAIR', 'REGRADE', 'RETURN_TO_SUPPLIER', 'QUARANTINE', 'SCRAP'] as const
export type DispositionOutcome = (typeof DISPOSITION_OUTCOMES)[number]

export const DISPOSITION_FOLLOW_UPS = ['REWORK_ORDER', 'REPAIR_ORDER', 'SUPPLIER_CLAIM'] as const
export type DispositionFollowUp = (typeof DISPOSITION_FOLLOW_UPS)[number]

/** The moves of the ledger a disposition may post out of held stock (the guard's list). */
export const DISPOSITION_MOVES = ['SCRAP', 'TRANSFER', 'ADJUSTMENT', 'ISSUE'] as const
export type DispositionMove = (typeof DISPOSITION_MOVES)[number]

/**
 * What each outcome may move and open (design df-dispositions: "the stock action is a Listbox of the moves the ledger
 * knows"; QHS-005 "each code says which stock move and which follow-up order it creates"). The first entry is the
 * default; null: none. USE AS IS moves and opens nothing, SCRAP always posts a SCRAP move (the guard's rules too).
 */
export const OUTCOME_RULES: Readonly<Record<DispositionOutcome, { readonly moves: readonly (DispositionMove | null)[]; readonly followUps: readonly (DispositionFollowUp | null)[]; readonly reinspection: boolean }>> = Object.freeze({
  USE_AS_IS: { moves: [null], followUps: [null], reinspection: false },
  REWORK: { moves: [null], followUps: ['REWORK_ORDER', null], reinspection: true },
  REPAIR: { moves: [null], followUps: ['REPAIR_ORDER', null], reinspection: true },
  REGRADE: { moves: ['TRANSFER', null], followUps: [null], reinspection: false },
  RETURN_TO_SUPPLIER: { moves: [null, 'ADJUSTMENT', 'TRANSFER'], followUps: ['SUPPLIER_CLAIM', null], reinspection: false },
  QUARANTINE: { moves: ['TRANSFER'], followUps: [null], reinspection: false },
  SCRAP: { moves: ['SCRAP'], followUps: [null], reinspection: false },
})

/** The amount a value rule can name, in minor units (999 999 999.99). */
export const MAX_APPROVAL_AMOUNT = 99_999_999_999

export interface DispositionDraft extends WordsDraft {
  readonly code?: string | undefined
  readonly outcome?: DispositionOutcome | undefined
  readonly stockMoveReason?: DispositionMove | null | undefined
  readonly followUp?: DispositionFollowUp | null | undefined
  readonly reinspection?: boolean | undefined
  readonly approvalSeverity?: DefectClass | null | undefined
  readonly approvalAmount?: number | null | undefined
  readonly sortOrder?: number | undefined
}

/** A new code (`creating`) or a change of one: the change never names the code, outcome, move or follow-up. */
export function dispositionDraftProblems(draft: DispositionDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating && (draft.code === undefined || !DISPOSITION_CODE.test(draft.code))) problems.push({ path: 'code', message: 'A code is 2 to 40 upper-case letters, digits and underscores, starting with a letter (SCRAP).' })
  problems.push(...wordsProblems(draft, 'disposition'))
  if (creating) {
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Name the disposition in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Name the disposition in English.' })
    if (draft.outcome === undefined) problems.push({ path: 'outcome', message: 'Say what the disposition decides: use as is, rework, repair, regrade, return to the supplier, quarantine or scrap.' })
    else {
      const rule = OUTCOME_RULES[draft.outcome]
      const move = draft.stockMoveReason === undefined ? rule.moves[0]! : draft.stockMoveReason
      const followUp = draft.followUp === undefined ? rule.followUps[0]! : draft.followUp
      if (!rule.moves.includes(move)) problems.push({ path: 'stockMoveReason', message: `${outcomeWords(draft.outcome)} ${movesWords(rule.moves)}.` })
      if (!rule.followUps.includes(followUp)) problems.push({ path: 'followUp', message: `${outcomeWords(draft.outcome)} ${followUpsWords(rule.followUps)}.` })
      if (draft.outcome === 'USE_AS_IS' && draft.reinspection === true) problems.push({ path: 'reinspection', message: 'Goods used as they are are not inspected again.' })
    }
  } else {
    for (const field of ['code', 'outcome', 'stockMoveReason', 'followUp'] as const) {
      if (draft[field] !== undefined) problems.push({ path: field, message: 'The code, what it decides, its stock move and its follow-up never change (decisions keep them): set it inactive and add another.' })
    }
  }
  if (draft.approvalAmount !== undefined && draft.approvalAmount !== null && (!Number.isInteger(draft.approvalAmount) || draft.approvalAmount < 0 || draft.approvalAmount > MAX_APPROVAL_AMOUNT)) {
    problems.push({ path: 'approvalAmount', message: 'A value from 0, in cents of the company currency.' })
  }
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0 || draft.sortOrder > 1_000_000)) problems.push({ path: 'sortOrder', message: 'A whole number from 0.' })
  return problems
}

const OUTCOME_WORDS: Readonly<Record<DispositionOutcome, string>> = Object.freeze({
  USE_AS_IS: 'Use as is',
  REWORK: 'Rework',
  REPAIR: 'Repair',
  REGRADE: 'Regrade',
  RETURN_TO_SUPPLIER: 'Return to the supplier',
  QUARANTINE: 'Quarantine',
  SCRAP: 'Scrap',
})
export const outcomeWords = (outcome: DispositionOutcome): string => OUTCOME_WORDS[outcome]

const MOVE_WORDS: Readonly<Record<DispositionMove, string>> = Object.freeze({
  SCRAP: 'a SCRAP move out of stock',
  TRANSFER: 'a TRANSFER to another place of the site (a quarantine or second-quality place)',
  ADJUSTMENT: 'an ADJUSTMENT out of stock (the goods go back to the supplier)',
  ISSUE: 'an ISSUE to the work order that uses them',
})
const FOLLOW_UP_WORDS: Readonly<Record<DispositionFollowUp, string>> = Object.freeze({
  REWORK_ORDER: 'a rework order',
  REPAIR_ORDER: 'a repair',
  SUPPLIER_CLAIM: 'a supplier claim and the return of the goods',
})

const either = (values: readonly string[]): string => (values.length <= 1 ? (values[0] ?? '') : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`)
const movesWords = (moves: readonly (DispositionMove | null)[]): string =>
  moves.every((move) => move === null) ? 'moves no stock' : `posts ${either(moves.map((move) => (move === null ? 'no move' : MOVE_WORDS[move])))}`
const followUpsWords = (followUps: readonly (DispositionFollowUp | null)[]): string =>
  followUps.every((followUp) => followUp === null) ? 'opens no other record' : `opens ${either(followUps.map((followUp) => (followUp === null ? 'nothing else' : FOLLOW_UP_WORDS[followUp])))}`

/** What a decision with a code does, in words (design: "Each disposition code says which stock move and follow-up order it makes"). */
export function stockActionWords(code: { readonly outcome: DispositionOutcome; readonly stockMoveReason: DispositionMove | null; readonly followUp: DispositionFollowUp | null; readonly reinspection: boolean }): string {
  const parts: string[] = []
  parts.push(code.stockMoveReason ? `Posts ${MOVE_WORDS[code.stockMoveReason]}` : 'Moves no stock')
  if (code.followUp) parts.push(`opens ${FOLLOW_UP_WORDS[code.followUp]}`)
  if (code.reinspection) parts.push('the goods are inspected again before they are released')
  return `${parts.join('; ')}.`
}

/** The options a new code of each outcome offers (the Listboxes of the dialog). */
export const outcomeOptions = () =>
  DISPOSITION_OUTCOMES.map((outcome) => ({ outcome, words: OUTCOME_WORDS[outcome], moves: [...OUTCOME_RULES[outcome].moves], followUps: [...OUTCOME_RULES[outcome].followUps], reinspection: OUTCOME_RULES[outcome].reinspection }))

/**
 * Does a decision with this code need a second person's approval? By the NCR's class (this class or worse) or by the
 * value of the goods it decides (minor units of the company's currency; null: not known, so a value rule asks).
 */
export function approvalNeeded(code: { readonly approvalSeverity: DefectClass | null; readonly approvalAmount: number | null }, decision: { readonly severity: DefectClass; readonly value: number | null }): { readonly needed: boolean; readonly why: string | null } {
  if (code.approvalSeverity !== null && CLASS_RANK[decision.severity] <= CLASS_RANK[code.approvalSeverity]) {
    return { needed: true, why: `A ${decision.severity.toLowerCase()} nonconformance: this disposition needs another person's approval.` }
  }
  if (code.approvalAmount !== null && (decision.value === null || decision.value >= code.approvalAmount)) {
    return { needed: true, why: decision.value === null ? 'The value of the goods is not known: this disposition needs another person\'s approval.' : 'The goods are worth the approval amount or more: this disposition needs another person\'s approval.' }
  }
  return { needed: false, why: null }
}

/** "Use as is" only on a MINOR nonconformance (design: refused on a major or any critical defect; QHS-002). */
export function useAsIsProblem(outcome: DispositionOutcome, severity: DefectClass): string | null {
  return outcome === 'USE_AS_IS' && severity !== 'MINOR' ? `Use as is is refused on a ${severity.toLowerCase()} nonconformance: only minor ones are used as they are.` : null
}

/** The other languages after a change: null takes a language out, words replace it. */
export function mergedLabels(current: ReasonWords, change: Readonly<Record<string, string | null>> | undefined): Record<string, string> {
  const next: Record<string, string> = { ...current }
  for (const [language, words] of Object.entries(change ?? {})) {
    if (words === null) delete next[language]
    else next[language] = words.trim()
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}
