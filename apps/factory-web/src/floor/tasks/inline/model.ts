/**
 * SCR-176 — In-line inspection (design floor.inline; QHS-039 … QHS-042; B-W2b-105 on B-W2b-99's API): the rules of the screen
 * without React or the network, so the tests hold them. The kinds, outcomes and the roving light are factory-domain's
 * (quality/inprocess/rules: a test holds these copies to it; that file reaches node:crypto, so a browser module never imports it).
 *
 *   kinds         Which check? First piece · Cutting · Roving · End of line; what holds a tile (a first piece is signed with the PIN
 *                 and a cutting result is recorded at once: both need the network; roving needs the tablet's line)
 *   first piece   the plan's checks as the DS FloorChecklist (pass / fail) and the key measurements (a value, its verdict by the
 *                 numbers when the plan gives a nominal and a tolerance); the WHOLE results list saved with each answer; Approve is
 *                 held while a mandatory check is unanswered or a critical one failed (the API's PLAN_RESULTS, said first)
 *   roving        a few pieces of one operation: the light suggested (none wrong green, one amber, two or more or a critical defect
 *                 red); green with a piece wrong and a critical defect below red are held, as the API refuses them
 *   end of line   a bundle: Pass (all its pieces) in one tap; a defect: how many, which defect, which operation caused it, Send back
 *   cutting       pieces looked at and rejected (to recut) of a bundle: pass or fail in one step
 * Never a person, never money: every figure is per line and operation (Statuto dei Lavoratori art. 4; Owner answers W1, F2).
 */

export const IN_PROCESS_KINDS = ['FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE'] as const
export type InlineKind = (typeof IN_PROCESS_KINDS)[number]
export const IN_PROCESS_OUTCOMES = ['APPROVED', 'REJECTED', 'PASS', 'FAIL', 'GREEN', 'AMBER', 'RED'] as const
export type InlineOutcome = (typeof IN_PROCESS_OUTCOMES)[number]

/** The order of the tiles (design floor.inline sec:kind). */
export const KIND_ORDER: readonly InlineKind[] = ['FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE']

export const ROVING_COLOURS = ['GREEN', 'AMBER', 'RED'] as const
export type RovingColour = (typeof ROVING_COLOURS)[number]

/** Pieces a roving check looks at by default (the common seven-piece rule; the inspector changes it). */
export const ROVING_PIECES = 7

/** The refusal codes the screen has its own words for (B-W2b-99's in-process codes and the rework loop's); the rest show the API's. */
export const KNOWN_REFUSALS = [
  'FIRST_PIECE_OPEN',
  'ALREADY_APPROVED',
  'WORK_ORDER_NOT_RUNNING',
  'NOT_OPEN',
  'NO_PLAN',
  'PLAN_RESULTS',
  'NOT_FOUND',
  'FLOOR_NOT_READY',
  // The rework loop (B-W2a-13) when garments are sent back.
  'BUNDLE_NOT_ACTIVE',
  'MORE_THAN_BUNDLE',
  'NOT_A_REWORK_REASON',
  'NOT_OF_CELL',
  'REWORK_AT_LATER',
  'NEXT_REPORTED',
] as const
const KNOWN = new Set<string>(KNOWN_REFUSALS)
export const isKnownRefusal = (code: string): boolean => KNOWN.has(code)

// ---- which check? ------------------------------------------------------------------------------------------------------------

/** Why a tile cannot open now: `online` (signed or recorded at once), `noLine` (the tablet shows no line), or null. */
export type KindHeld = 'online' | 'noLine' | null

export function kindHeld(kind: InlineKind, place: { readonly online: boolean; readonly hasLine: boolean; readonly boardKept?: boolean }): KindHeld {
  switch (kind) {
    case 'FIRST_PIECE':
    case 'CUTTING':
      return place.online ? null : 'online'
    case 'ROVING':
      if (!place.hasLine) return 'noLine'
      return place.online || place.boardKept ? null : 'online'
    case 'END_OF_LINE':
      return null
  }
}

// ---- roving ------------------------------------------------------------------------------------------------------------------

/** The traffic light the inspector is offered (= factory-domain rovingColourOf): a suggestion, the inspector says the colour. */
export function rovingColourOf(finding: { readonly defectivePieces: number; readonly critical?: boolean }): RovingColour {
  if (finding.critical) return 'RED'
  if (finding.defectivePieces <= 0) return 'GREEN'
  return finding.defectivePieces === 1 ? 'AMBER' : 'RED'
}

/** Why a colour cannot be recorded with these findings (the API refuses both), or null. */
export function colourHeld(colour: RovingColour, finding: { readonly defectivePieces: number; readonly critical?: boolean }): 'greenWithDefects' | 'critical' | null {
  if (finding.critical && colour !== 'RED') return 'critical'
  if (colour === 'GREEN' && finding.defectivePieces > 0) return 'greenWithDefects'
  return null
}

export interface RovingDraft {
  readonly pieces: number
  readonly defective: number
  /** The defect found (a library defect's id), or null. */
  readonly defectId: string | null
  /** The colour the inspector picked; null: the suggestion. */
  readonly colour: RovingColour | null
}

export const NEW_ROVING: RovingDraft = Object.freeze({ pieces: ROVING_PIECES, defective: 0, defectId: null, colour: null })

/** The colour that will be recorded: the one picked, else the suggestion. */
export const rovingColour = (draft: RovingDraft, critical: boolean): RovingColour => draft.colour ?? rovingColourOf({ defectivePieces: draft.defective, critical })

/** The pieces looked at changed: the wrong ones never more than them. */
export const withRovingPieces = (draft: RovingDraft, pieces: number): RovingDraft => ({ ...draft, pieces: Math.max(1, pieces), defective: Math.min(draft.defective, Math.max(1, pieces)) })

/** The roving result as recorded in one step (one defect per piece with one; the defect named only when one was found). */
export function rovingDecision(draft: RovingDraft, critical: boolean) {
  const outcome = rovingColour(draft, critical)
  return { outcome, pieces: draft.pieces, defectivePieces: draft.defective, defects: draft.defective, ...(draft.defective > 0 && draft.defectId ? { defectCodeId: draft.defectId } : {}) }
}

// ---- end of line -------------------------------------------------------------------------------------------------------------

export interface EolDraft {
  /** Pieces with the defect (default one). */
  readonly defective: number
  readonly defectId: string | null
  /** The operation that caused it (the rework goes there). */
  readonly operationId: string | null
  /** The rework reason, when the tenant has no OTHER rework reason to send back with. */
  readonly reasonCode: string | null
}

export const NEW_EOL: EolDraft = Object.freeze({ defective: 1, defectId: null, operationId: null, reasonCode: null })

/** The bundle passes: every piece looked at, none wrong (one tap after the scan). */
export const eolPassDecision = (quantity: number) => ({ outcome: 'PASS' as const, pieces: Math.max(1, quantity) })

/** A defect sent back: the pieces looked at are the bundle's, the defect named, one defect per piece with it. */
export function eolFailDecision(draft: EolDraft, quantity: number) {
  const pieces = Math.max(1, quantity)
  const defective = Math.min(Math.max(1, draft.defective), pieces)
  return { outcome: 'FAIL' as const, pieces, defectivePieces: defective, defects: defective, defectCodeId: draft.defectId }
}

/** Why Send back waits: the defect, the operation, the rework reason (only when the tenant has no OTHER), or null. */
export function sendBackHeld(draft: EolDraft, needsReason: boolean): 'defect' | 'operation' | 'reason' | null {
  if (!draft.defectId) return 'defect'
  if (!draft.operationId) return 'operation'
  if (needsReason && !draft.reasonCode) return 'reason'
  return null
}

/**
 * The rework reason the garments go back with: the tenant's OTHER (the defect's own words go in the description), else the one
 * the inspector picks. Never another code guessed: a wrong reason would be a wrong record.
 */
export function reworkReasonOf(reasons: readonly { readonly kind: string; readonly code: string }[], picked: string | null): string | null {
  if (reasons.some((reason) => reason.kind === 'REWORK' && reason.code === 'OTHER')) return 'OTHER'
  return picked
}

/** The operations an end-of-line defect may be sent back to: every operation of the bundle's routing, in order. */
export function sendBackOperations<O extends { readonly seq: number }>(operations: readonly O[]): O[] {
  return [...operations].sort((a, b) => a.seq - b.seq)
}

// ---- cutting -----------------------------------------------------------------------------------------------------------------

export interface CuttingDraft {
  readonly pieces: number
  /** Pieces rejected against the pattern: they are recut. */
  readonly rejected: number
  readonly defectId: string | null
}

export const cuttingDraftOf = (quantity: number): CuttingDraft => ({ pieces: Math.max(1, quantity), rejected: 0, defectId: null })

/** Pass with none rejected, fail with the pieces to recut (the defect named when one was picked). */
export function cuttingDecision(draft: CuttingDraft) {
  const rejected = Math.min(Math.max(0, draft.rejected), draft.pieces)
  return rejected === 0
    ? { outcome: 'PASS' as const, pieces: draft.pieces }
    : { outcome: 'FAIL' as const, pieces: draft.pieces, defectivePieces: rejected, defects: rejected, ...(draft.defectId ? { defectCodeId: draft.defectId } : {}) }
}

// ---- first piece: the plan's checks --------------------------------------------------------------------------------------------

export interface PlanCheckFacts {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly type: string
  readonly checkClass: string | null
  readonly mandatory: boolean
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly uom: string | null
  readonly choices: readonly string[]
}

export interface ResultFacts {
  readonly code: string
  readonly sampleIndex: number
  readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'
  readonly value: string | null
}

/** A first piece is one piece: every result is its first unit. */
export const FIRST_UNIT = 1

/** The check's words in the worker's language (another floor language, else English; Italian for Italian). */
export function checkWords(check: Pick<PlanCheckFacts, 'labelIt' | 'labelEn' | 'labelI18n'>, language: string): string {
  if (language === 'it') return check.labelIt || check.labelEn
  if (language === 'en') return check.labelEn || check.labelIt
  return check.labelI18n[language] || check.labelEn || check.labelIt
}

/** How the floor answers a check: a tap (pass / fail), a value (measure, count, choice), read only (instruction), or in the office (words). */
export type CheckWay = 'tap' | 'value' | 'read' | 'office'

export function wayOf(check: Pick<PlanCheckFacts, 'type'>): CheckWay {
  switch (check.type) {
    case 'MEASUREMENT':
    case 'COUNT':
    case 'CHOICE':
      return 'value'
    case 'INSTRUCTION':
      return 'read'
    case 'FREE_TEXT':
      return 'office'
    default:
      return 'tap'
  }
}

/** The first unit's result of a check, or null. */
export const resultOf = (results: readonly ResultFacts[], code: string): ResultFacts | null => results.find((result) => result.code === code && result.sampleIndex === FIRST_UNIT) ?? null

/** The WHOLE results list with one check's first-unit answer put in (each save sends them all). */
export function withResult(results: readonly ResultFacts[], answer: { readonly code: string; readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; readonly value?: string | null }) {
  const kept = results.filter((result) => !(result.code === answer.code && result.sampleIndex === FIRST_UNIT))
  return [...kept, { code: answer.code, sampleIndex: FIRST_UNIT, outcome: answer.outcome, value: answer.value ?? null }].map((result) => ({
    code: result.code,
    sampleIndex: result.sampleIndex,
    outcome: result.outcome,
    ...(result.value !== null && result.value !== undefined ? { value: result.value } : {}),
  }))
}

/** A measurement against its nominal ± tolerance, by the numbers (= factory-domain measuredOutcome; the database computes the same). */
export function measuredOutcome(value: string, nominal: string, tolerance: string): 'PASS' | 'FAIL' {
  const thousandths = (text: string) => Math.round(Number(text) * 1000)
  return Math.abs(thousandths(value) - thousandths(nominal)) <= thousandths(tolerance) ? 'PASS' : 'FAIL'
}

/** The verdict a value gets by itself: by the numbers for a measurement with a nominal and a tolerance; else the inspector says it. */
export function verdictOf(check: Pick<PlanCheckFacts, 'type' | 'nominal' | 'tolerance'>, value: string): 'PASS' | 'FAIL' | null {
  if (check.type !== 'MEASUREMENT' || check.nominal === null || check.tolerance === null || value.trim() === '') return null
  return measuredOutcome(value, check.nominal, check.tolerance)
}

/** A typed number as the API takes it (a dot, up to three decimals). */
export function valueText(value: number, type: string): string {
  return type === 'COUNT' ? String(Math.round(value)) : String(Math.round(value * 1000) / 1000)
}

/** What holds Approve: a mandatory check unanswered (the API's blockers), a critical check failed, or null. Reject is never held. */
export function approveHeld(record: { readonly blockers: readonly string[]; readonly checks: readonly PlanCheckFacts[]; readonly results: readonly ResultFacts[] }): { readonly key: 'left'; readonly count: number } | { readonly key: 'critical'; readonly code: string } | null {
  const critical = record.checks.find((check) => check.checkClass === 'CRITICAL' && record.results.some((result) => result.code === check.code && result.outcome === 'FAIL'))
  if (critical) return { key: 'critical', code: critical.code }
  const left = record.checks.filter((check) => check.mandatory && wayOf(check) !== 'read' && resultOf(record.results, check.code) === null).length
  if (left > 0 || record.blockers.length > 0) return { key: 'left', count: Math.max(left, record.blockers.length) }
  return null
}

/** The first-piece decision as signed: one piece looked at; a rejection names it wrong with one defect per failed check (at least one). */
export function firstPieceDecision(outcome: 'APPROVED' | 'REJECTED', results: readonly ResultFacts[]) {
  if (outcome === 'APPROVED') return { outcome, pieces: 1, defectivePieces: 0, defects: 0 }
  const failed = results.filter((result) => result.outcome === 'FAIL').length
  return { outcome, pieces: 1, defectivePieces: 1, defects: Math.max(1, failed) }
}

// ---- the open first pieces of the site -------------------------------------------------------------------------------------------

/** Open first pieces first by age (the oldest run waits longest), then by work order. */
export function openFirstPieces<R extends { readonly kind: string; readonly status: string; readonly createdAt: string }>(rows: readonly R[]): R[] {
  return rows.filter((row) => row.kind === 'FIRST_PIECE' && row.status === 'OPEN').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
