import type { Issue } from '../../core/errors'
import { toUtcIso } from '../../core/time'

/**
 * Repairs and alterations (B-W2a-57; SAL-383 repair order from a case, SAL-390 repair stages, LOG-116 repair round trip;
 * design sales.returns "Repair order": Intake & photos, Work, Safety check, Return), pure. apps/factory-api's
 * modules/sales/repairs says these rules in words before the database's …_sales_w2a_guards triggers (and the DDT's
 * …_quality_plant_w2a_guards check) would refuse the same, and builds every answer from them.
 *
 *   the repair    one garment of one customer, numbered from the company's REPAIR series: made from an RMA line decided
 *                 Repair (the garment is here: RECEIVED with the line's arrival and the customer's DDT of its receipt),
 *                 from a complaint, or by hand (AWAITING_GOODS until the garment arrives, or RECEIVED at once when it
 *                 came with the customer). Its garment: the serial read from the label (our serial: style, colourway,
 *                 size, made on), or the style, colourway and size typed.
 *   its stages    RECEIVED → ESTIMATED → APPROVED → IN_REPAIR → REPAIRED → SHIPPED (SAL-390), the database's moves:
 *                 the estimate and the customer's approval may be skipped (RECEIVED → IN_REPAIR), the garment may go back
 *                 unrepaired from RECEIVED or ESTIMATED (declined, not repairable), and REPAIRED goes back into repair.
 *                 Every move is one RepairStageEvent row, written after the move in the same command.
 *   the work      done on its repair work order (B-W2a-12: a REPAIR work order of the repair's site with only the steps
 *                 it needs): IN_REPAIR once that work order is released, REPAIRED once it is completed.
 *   the safety    a protective garment (PPE; a garment of unknown style is treated as one) goes back after its repair
 *                 only with a passed safety check made after the repair: seams, abrasion zones, closures, protectors (the
 *                 lot and level of a replaced one, SAL-400), and the certificate still covers it. Back into repair, the
 *                 check is made again.
 *   the way back  a DDT whose source is the repair (DPR 472/1996; B-W2a-17), issued before the move to SHIPPED (or
 *                 already live), one live DDT per repair. The customer's own DDT the garment came with is its
 *                 reference.
 */

export const REPAIR_STAGES = ['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED', 'CANCELLED'] as const
export type RepairStage = (typeof REPAIR_STAGES)[number]
export const REPAIR_KINDS = ['REPAIR', 'ALTERATION'] as const
export type RepairKind = (typeof REPAIR_KINDS)[number]
export const SAFETY_RESULTS = ['PASS', 'FAIL'] as const
export type SafetyResult = (typeof SAFETY_RESULTS)[number]

export const FINAL_REPAIR_STAGES: readonly RepairStage[] = Object.freeze(['SHIPPED', 'CANCELLED'])
export const OPEN_REPAIR_STAGES: readonly RepairStage[] = Object.freeze(['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED'])
/** The garment is here and the work has not started. */
export const WAITING_WORK_STAGES: readonly RepairStage[] = Object.freeze(['RECEIVED', 'ESTIMATED', 'APPROVED'])
/** The garment goes back from these (the DDT's and the database's rule). */
export const SHIP_FROM_STAGES: readonly RepairStage[] = Object.freeze(['RECEIVED', 'ESTIMATED', 'REPAIRED'])
/** It goes back unrepaired from these (declined, not repairable). */
export const UNREPAIRED_STAGES: readonly RepairStage[] = Object.freeze(['RECEIVED', 'ESTIMATED'])

/** The number series a repair takes its number from. */
export const REPAIR_NUMBER_KIND = 'REPAIR' as const

export const REPAIR_LIMITS = Object.freeze({
  problem: 2000,
  note: 1000,
  reason: 500,
  serial: 60,
  size: 20,
  internalNote: 2000,
  ddtNumber: 40,
  protectorLot: 60,
  /** At most this many repairs in one list answer. */
  list: 200,
  /** At most this many other repairs of the same garment in a record. */
  history: 20,
})

// ---- the stages (the …_sales_w2a_guards trigger's moves) -------------------------------------------------------------

export const REPAIR_MOVES: Readonly<Record<RepairStage, readonly RepairStage[]>> = Object.freeze({
  AWAITING_GOODS: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['ESTIMATED', 'IN_REPAIR', 'SHIPPED', 'CANCELLED'],
  ESTIMATED: ['APPROVED', 'SHIPPED', 'CANCELLED'],
  APPROVED: ['IN_REPAIR', 'CANCELLED'],
  IN_REPAIR: ['REPAIRED', 'CANCELLED'],
  REPAIRED: ['IN_REPAIR', 'SHIPPED'],
  SHIPPED: [],
  CANCELLED: [],
})

export const canMoveRepair = (from: RepairStage, to: RepairStage): boolean => REPAIR_MOVES[from].includes(to)
export const isFinalRepair = (stage: RepairStage): boolean => FINAL_REPAIR_STAGES.includes(stage)

const STAGE_WORDS: Readonly<Record<RepairStage, string>> = Object.freeze({
  AWAITING_GOODS: 'waiting for the garment',
  RECEIVED: 'received',
  ESTIMATED: 'estimated',
  APPROVED: 'approved by the customer',
  IN_REPAIR: 'in repair',
  REPAIRED: 'repaired',
  SHIPPED: 'shipped back',
  CANCELLED: 'cancelled',
})
export const stageWords = (stage: RepairStage): string => STAGE_WORDS[stage]

const either = (words: readonly string[]): string => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`)

/** "Repair REP-1 is received: from there it goes to estimated, in repair, shipped back or cancelled." */
export function moveRefusal(number: string, from: RepairStage, to: RepairStage): string {
  if (isFinalRepair(from)) return `Repair ${number} is ${stageWords(from)}: it changes no more.`
  return `Repair ${number} is ${stageWords(from)}: it cannot be ${stageWords(to)} from there (it goes on to ${either(REPAIR_MOVES[from].map(stageWords))}).`
}

// ---- the repair work order (B-W2a-12) ------------------------------------------------------------------------------

/** The repair's live repair work order (not CANCELLED), as the stage rules read it. */
export interface RepairWorkOrder {
  readonly number: string
  readonly status: string
}

/** The work order is on the floor (released, started, or done). */
const RELEASED_WORK_ORDER = ['RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED']
/** The work is done. */
const DONE_WORK_ORDER = ['COMPLETED', 'CLOSED']

/** Where a repair work order can still be made: before the repair is done (production's own rule). */
export const WORK_ORDER_STAGES: readonly RepairStage[] = Object.freeze(['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR'])

export function makeWorkOrderHeld(number: string, stage: RepairStage, workOrder: RepairWorkOrder | null, reworkRound = false): string | null {
  if (workOrder && !reworkAllowed(stage, workOrder, reworkRound)) return `Repair work order ${workOrder.number} is ${workOrder.status.toLowerCase().replace('_', ' ')}: one live work order per repair.`
  if (!WORK_ORDER_STAGES.includes(stage)) return stage === 'REPAIRED' ? `Repair ${number} is repaired: back into repair first if it needs more work.` : `Repair ${number} is ${stageWords(stage)}.`
  return null
}

/**
 * B-W2b-16 (B-W2a-57's gap: "the rework after a failed check is not on a work order"): a garment put back into repair
 * after it was repaired (REPAIRED → IN_REPAIR: a failed safety check, or more work found) may get a NEW repair work order
 * once the last one is done (COMPLETED or CLOSED). The new one becomes the repair's work order: REPAIRED then waits for
 * it to be completed. A rework round is the repair IN_REPAIR whose last move came from REPAIRED (`reworkRoundOf`).
 */
export function reworkAllowed(stage: RepairStage, workOrder: RepairWorkOrder | null, reworkRound: boolean): boolean {
  return reworkRound && stage === 'IN_REPAIR' && workOrder !== null && DONE_WORK_ORDER.includes(workOrder.status)
}

/** The repair is in a rework round: IN_REPAIR, and its last stage move came back from REPAIRED. */
export function reworkRoundOf(stage: RepairStage, moves: readonly { readonly from: RepairStage | null; readonly to: RepairStage }[]): boolean {
  const last = moves.at(-1)
  return stage === 'IN_REPAIR' && last !== undefined && last.to === 'IN_REPAIR' && last.from === 'REPAIRED'
}

// ---- the moves the office makes by hand (POST …/stage) -------------------------------------------------------------

/** RECEIVED, SHIPPED and CANCELLED have their own steps (receive, ship, cancel). */
export const HAND_MOVES = ['ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED'] as const
export type HandMove = (typeof HAND_MOVES)[number]

export interface StageFacts {
  readonly number: string
  readonly stage: RepairStage
  readonly workOrder: RepairWorkOrder | null
}

/** What the move needs that is missing (409, in words); empty: it may move. */
export function stageMoveProblems(to: HandMove, facts: StageFacts): string[] {
  if (!canMoveRepair(facts.stage, to)) return [moveRefusal(facts.number, facts.stage, to)]
  const workOrder = facts.workOrder
  if (to === 'IN_REPAIR') {
    if (!workOrder) return [`Make the repair work order of ${facts.number} first and release it: the repair is done on it (Work › Make repair work order).`]
    if (workOrder.status === 'DRAFT') return [`Release repair work order ${workOrder.number} first: the floor works only on a released work order.`]
    if (workOrder.status === 'ON_HOLD') return [`Repair work order ${workOrder.number} is on hold: lift its hold first.`]
    if (!RELEASED_WORK_ORDER.includes(workOrder.status)) return [`Repair work order ${workOrder.number} is ${workOrder.status.toLowerCase()}.`]
  }
  if (to === 'REPAIRED') {
    if (!workOrder) return [`Repair ${facts.number} has no repair work order: make it, release it and complete it first (the repair is done when its work order is).`]
    if (!DONE_WORK_ORDER.includes(workOrder.status)) return [`Repair work order ${workOrder.number} is ${workOrder.status.toLowerCase().replace('_', ' ')}: complete it first (the repair is done when its work order is).`]
  }
  return []
}

/** The note a move needs (400 at body/note), or null. */
export function noteNeeded(from: RepairStage, to: RepairStage): string | null {
  if (to === 'ESTIMATED') return 'Say what was estimated (the parts and work, and what the customer was told): the estimate sheet comes later.'
  if (to === 'APPROVED') return 'Say how and when the customer approved the work (phone, e-mail, in person).'
  if (from === 'REPAIRED' && to === 'IN_REPAIR') return 'Say what still needs doing (the safety check is made again after it).'
  if (to === 'SHIPPED' && UNREPAIRED_STAGES.includes(from)) return 'Say why the garment goes back unrepaired (the estimate was declined, it cannot be repaired).'
  return null
}

// ---- the safety check (a protective garment after its repair) ---------------------------------------------------------

export const POINT_RESULTS = ['PASS', 'FAIL', 'NOT_APPLICABLE'] as const
export type PointResult = (typeof POINT_RESULTS)[number]
/** EN 1621 protector levels. */
export const PROTECTOR_LEVELS = ['1', '2'] as const

export interface SafetyChecklist {
  /** Every garment has seams: PASS or FAIL. */
  readonly seams: PointResult
  readonly abrasionZones: PointResult
  readonly closures: PointResult
  readonly protectors: {
    readonly result: PointResult
    /** A protector was replaced in the repair: its lot and level (SAL-400). */
    readonly replaced: boolean
    readonly lot: string | null
    readonly level: string | null
  }
  /** The certificate (EU type examination) still covers the garment as repaired. */
  readonly certificateCovers: boolean
  readonly note: string | null
}

export function safetyChecklistProblems(list: SafetyChecklist, path = 'body/checklist'): Issue[] {
  const problems: Issue[] = []
  if (list.seams === 'NOT_APPLICABLE') problems.push({ path: `${path}/seams`, message: 'Every garment has seams: PASS or FAIL.' })
  const protectors = list.protectors
  if (protectors.replaced) {
    if (protectors.result === 'NOT_APPLICABLE') problems.push({ path: `${path}/protectors/result`, message: 'A replaced protector is checked: PASS or FAIL.' })
    if (!protectors.lot || protectors.lot.trim() === '') problems.push({ path: `${path}/protectors/lot`, message: 'The lot of the new protector (it traces the garment back to it).' })
    else if (protectors.lot.trim().length > REPAIR_LIMITS.protectorLot) problems.push({ path: `${path}/protectors/lot`, message: `At most ${REPAIR_LIMITS.protectorLot} characters.` })
    if (!protectors.level || !(PROTECTOR_LEVELS as readonly string[]).includes(protectors.level)) problems.push({ path: `${path}/protectors/level`, message: 'The level of the new protector: 1 or 2 (EN 1621).' })
  } else if (protectors.lot || protectors.level) {
    problems.push({ path: `${path}/protectors/replaced`, message: 'A lot and a level are given only for a replaced protector.' })
  }
  if ((list.note ?? '').trim().length > REPAIR_LIMITS.note) problems.push({ path: `${path}/note`, message: `At most ${REPAIR_LIMITS.note} characters.` })
  return problems
}

/** What failed, in words (empty: every point passed). */
export function safetyFailures(list: SafetyChecklist): string[] {
  const failed: string[] = []
  if (list.seams === 'FAIL') failed.push('the seams')
  if (list.abrasionZones === 'FAIL') failed.push('the abrasion zones')
  if (list.closures === 'FAIL') failed.push('the closures')
  if (list.protectors.result === 'FAIL') failed.push('the protectors')
  if (!list.certificateCovers) failed.push('the certificate no longer covers the garment')
  return failed
}

/** PASS when no point failed and the certificate still covers the garment. */
export const safetyResultOf = (list: SafetyChecklist): SafetyResult => (safetyFailures(list).length === 0 ? 'PASS' : 'FAIL')

/** The checklist as stored (an object; the result is its own column). */
export const storedChecklist = (list: SafetyChecklist) => ({
  seams: list.seams,
  abrasionZones: list.abrasionZones,
  closures: list.closures,
  protectors: { result: list.protectors.result, replaced: list.protectors.replaced, lot: list.protectors.lot?.trim() || null, level: list.protectors.level ?? null },
  certificateCovers: list.certificateCovers,
  note: list.note?.trim() || null,
})

export const SAFETY_STATES = ['NOT_REQUIRED', 'NOT_CHECKED', 'OUTDATED', 'PASSED', 'FAILED'] as const
export type SafetyState = (typeof SAFETY_STATES)[number]

export interface SafetyFacts {
  readonly required: boolean
  readonly result: SafetyResult | null
  readonly checkedAt: Date | null
  readonly repairedAt: Date | null
}

/** Where the check stands: none needed, not made, made before the last repair, passed, failed. */
export function safetyStateOf(facts: SafetyFacts): SafetyState {
  if (!facts.required) return 'NOT_REQUIRED'
  if (!facts.result || !facts.checkedAt) return 'NOT_CHECKED'
  if (facts.repairedAt && facts.checkedAt.getTime() < facts.repairedAt.getTime()) return 'OUTDATED'
  return facts.result === 'PASS' ? 'PASSED' : 'FAILED'
}

/** A repaired garment may go back: no check needed, or a PASS made at or after the repair (the database's rule). */
export const safeToShip = (facts: SafetyFacts): boolean =>
  !facts.required || facts.repairedAt === null || (facts.result === 'PASS' && facts.checkedAt !== null && facts.checkedAt.getTime() >= facts.repairedAt.getTime())

const SAFETY_HELD: Readonly<Record<Exclude<SafetyState, 'NOT_REQUIRED' | 'PASSED'>, string>> = Object.freeze({
  NOT_CHECKED: 'it is not checked yet',
  OUTDATED: 'its last check was made before the last repair: check it again',
  FAILED: 'its last check failed: repair it again (back into repair), then check it again',
})

/** Why a repaired protective garment may not go back yet, or null. */
export function unsafeWords(number: string, facts: SafetyFacts): string | null {
  if (safeToShip(facts)) return null
  const state = safetyStateOf(facts)
  const why = state === 'NOT_REQUIRED' || state === 'PASSED' ? SAFETY_HELD.NOT_CHECKED : SAFETY_HELD[state]
  return `Repair ${number} is a protective garment: it goes back only after a passed safety check made after the repair (${why}).`
}

/** Whether the check may be signed now (409 in words), or null. */
export function safetyCheckHeld(number: string, stage: RepairStage, required: boolean): string | null {
  if (!required) return `Repair ${number} is not a protective garment: it needs no safety check.`
  if (stage !== 'REPAIRED') return `The safety check is made after the repair: repair ${number} is ${stageWords(stage)}.`
  return null
}

// ---- the way back (SHIPPED) -------------------------------------------------------------------------------------------

export interface ShipFacts extends SafetyFacts {
  readonly number: string
  readonly stage: RepairStage
  readonly workOrder: RepairWorkOrder | null
  /** The repair's live DDT (one per repair), when issued already. */
  readonly liveDdt: { readonly number: string } | null
  /** The step issues the DDT itself (the body has one). */
  readonly ddtAsked: boolean
}

const SHIP_HELD: Partial<Record<RepairStage, string>> = Object.freeze({
  AWAITING_GOODS: 'the garment has not arrived yet',
  APPROVED: 'the customer approved the work: repair it first, or cancel the repair',
  IN_REPAIR: 'finish the repair first (repaired), or cancel the repair',
  SHIPPED: 'the garment went back already',
  CANCELLED: 'the repair is cancelled',
})

/** What stops the garment going back now (409, in words), the DDT apart. */
export function shipStateProblems(facts: Omit<ShipFacts, 'liveDdt' | 'ddtAsked'>): string[] {
  if (!SHIP_FROM_STAGES.includes(facts.stage)) return [`Repair ${facts.number} is ${stageWords(facts.stage)}: ${SHIP_HELD[facts.stage] ?? 'it goes back from received, estimated or repaired'}.`]
  const problems: string[] = []
  if (facts.stage === 'REPAIRED') {
    const unsafe = unsafeWords(facts.number, facts)
    if (unsafe) problems.push(unsafe)
  } else if (facts.workOrder && !DONE_WORK_ORDER.includes(facts.workOrder.status)) {
    problems.push(`Cancel repair work order ${facts.workOrder.number} first: the garment goes back unrepaired.`)
  }
  return problems
}

/** What stops the step: the state (409) and the DDT (a live one and a new one asked: 409; none at all: 400 body/ddt). */
export function shipProblems(facts: ShipFacts): { state: string[]; fields: Issue[] } {
  const state = shipStateProblems(facts)
  const fields: Issue[] = []
  if (facts.liveDdt && facts.ddtAsked) state.push(`DDT ${facts.liveDdt.number} is live for this repair: send the garment back without a new DDT, or cancel that DDT first.`)
  if (!facts.liveDdt && !facts.ddtAsked) fields.push({ path: 'body/ddt', message: 'The garment travels back with a DDT (DPR 472/1996): say who carries it, the packages and the weight, or issue the DDT first under Shipping.' })
  return { state, fields }
}

/** A protective garment that goes back unrepaired was not checked: say so (a warning, not a refusal). */
export function unrepairedWarning(facts: { readonly stage: RepairStage; readonly required: boolean }): string | null {
  return facts.required && UNREPAIRED_STAGES.includes(facts.stage) ? 'A protective garment goes back unrepaired and unchecked: tell the customer in writing that it may no longer protect.' : null
}

// ---- cancel -----------------------------------------------------------------------------------------------------------

export interface CancelFacts {
  readonly number: string
  readonly stage: RepairStage
  readonly workOrder: RepairWorkOrder | null
  readonly liveDdt: { readonly number: string } | null
}

/** What stops the cancel (409, in words). */
export function cancelProblems(facts: CancelFacts): string[] {
  if (isFinalRepair(facts.stage)) return [`Repair ${facts.number} is ${stageWords(facts.stage)}.`]
  if (facts.stage === 'REPAIRED') return [`Repair ${facts.number} is repaired: the garment goes back to the customer (send it back).`]
  if (UNREPAIRED_STAGES.includes(facts.stage)) return [`The garment of repair ${facts.number} is here: send it back unrepaired instead of cancelling.`]
  const problems: string[] = []
  if (facts.workOrder) {
    problems.push(
      DONE_WORK_ORDER.includes(facts.workOrder.status)
        ? `Repair work order ${facts.workOrder.number} is ${facts.workOrder.status.toLowerCase()}: move the repair to repaired and send the garment back.`
        : `Cancel repair work order ${facts.workOrder.number} first (Production › Work orders).`,
    )
  }
  if (facts.liveDdt) problems.push(`DDT ${facts.liveDdt.number} is live for this repair: cancel it first.`)
  return problems
}

/** The garment arrived and the repair is cancelled: it stays at the site (a cancelled repair takes no DDT). */
export function cancelWarning(receivedAt: Date | null, siteCode: string): string | null {
  return receivedAt ? `The garment arrived on ${toUtcIso(receivedAt).slice(0, 10)}: it stays at ${siteCode} until the customer collects it (a cancelled repair takes no DDT).` : null
}

// ---- the arrival (AWAITING_GOODS → RECEIVED) --------------------------------------------------------------------------

export function receiveHeld(number: string, stage: RepairStage): string | null {
  return stage === 'AWAITING_GOODS' ? null : stage === 'CANCELLED' ? `Repair ${number} is cancelled.` : `The garment of repair ${number} is here already (${stageWords(stage)}).`
}

/** No customer DDT with the garment: a warning (it may come by hand). */
export const NO_INBOUND_DDT_WORDS = "No customer DDT: goods sent in for repair travel with one (DPR 472/1996); add its number when it turns up."

// ---- the garment --------------------------------------------------------------------------------------------------------

/** A protective garment needs the check: its style is PPE, or its style is not known (treated as one, to be safe). */
export const safetyRequiredFor = (style: { readonly ppeCategory: string } | null): boolean => style === null || style.ppeCategory !== 'NOT_PPE'

export const UNKNOWN_STYLE_WORDS = "The garment's style is not known: it is treated as a protective garment, so it goes back only after a passed safety check (name the style or read its serial to change that)."

// ---- the record's stepper and actions ---------------------------------------------------------------------------------

/** The design's stepper (repair.work.stages): Received → estimated → approved → in repair → repaired → shipped. */
export const REPAIR_STEPS = ['RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED'] as const satisfies readonly RepairStage[]
export type RepairStep = (typeof REPAIR_STEPS)[number]
export const STEP_STATES = ['DONE', 'CURRENT', 'WAITING', 'SKIPPED'] as const
export type StepState = (typeof STEP_STATES)[number]

export interface StageEventFact {
  readonly stage: RepairStage
  readonly at: Date
}

/** Each step of the stepper: done (when last reached), current, waiting, or skipped (passed over, or cancelled). */
export function stepsOf(stage: RepairStage, events: readonly StageEventFact[]): { stage: RepairStep; state: StepState; at: string | null }[] {
  const order: readonly RepairStage[] = REPAIR_STEPS
  const current = order.indexOf(stage)
  // The events in the order they were written (oldest first): the last one into a step is when it was last reached.
  const lastInto = (step: RepairStage) => [...events].reverse().find((event) => event.stage === step)?.at ?? null
  const reachedBefore = stage === 'CANCELLED' ? Math.max(-1, ...events.map((event) => order.indexOf(event.stage))) : current
  return REPAIR_STEPS.map((step, index): { stage: RepairStep; state: StepState; at: string | null } => {
    const at = lastInto(step)
    if (stage === 'CANCELLED') return { stage: step, state: index <= reachedBefore && at ? 'DONE' : 'SKIPPED', at: index <= reachedBefore && at ? toUtcIso(at) : null }
    if (index === current) return { stage: step, state: 'CURRENT', at: at ? toUtcIso(at) : null }
    if (index < current) return at ? { stage: step, state: 'DONE', at: toUtcIso(at) } : { stage: step, state: 'SKIPPED', at: null }
    return { stage: step, state: 'WAITING', at: null }
  })
}

export const REPAIR_ACTIONS = ['edit', 'receive', 'estimate', 'approve', 'makeWorkOrder', 'startRepair', 'finishRepair', 'reopenRepair', 'safetyCheck', 'ship', 'cancel'] as const
export type RepairAction = (typeof REPAIR_ACTIONS)[number]

export interface ActionFacts extends SafetyFacts {
  readonly number: string
  readonly stage: RepairStage
  readonly workOrder: RepairWorkOrder | null
  readonly liveDdt: { readonly number: string } | null
  /** B-W2b-16: back into repair after it was repaired (`reworkRoundOf`): a new work order may follow a done one. */
  readonly reworkRound?: boolean
}

export interface ActionState {
  readonly action: RepairAction
  readonly allowed: boolean
  /** Why not, in words (null when allowed). */
  readonly held: string | null
}

/** Each action of the record: allowed, or held with its reason (the same words the step answers). */
export function repairActions(facts: ActionFacts): ActionState[] {
  const held = (action: RepairAction, why: string | null): ActionState => ({ action, allowed: why === null, held: why })
  const move = (to: HandMove) => stageMoveProblems(to, facts)[0] ?? null
  const cancel = cancelProblems(facts)[0] ?? null
  const ship = shipStateProblems(facts)[0] ?? null
  return [
    held('edit', isFinalRepair(facts.stage) ? `The repair is ${stageWords(facts.stage)}.` : null),
    held('receive', receiveHeld(facts.number, facts.stage)),
    held('estimate', move('ESTIMATED')),
    held('approve', move('APPROVED')),
    held('makeWorkOrder', makeWorkOrderHeld(facts.number, facts.stage, facts.workOrder, facts.reworkRound ?? false)),
    held('startRepair', facts.stage === 'REPAIRED' ? `Repair ${facts.number} is repaired: put it back into repair instead.` : move('IN_REPAIR')),
    held('finishRepair', move('REPAIRED')),
    held('reopenRepair', facts.stage === 'REPAIRED' ? null : `Repair ${facts.number} is ${stageWords(facts.stage)}: only a repaired garment goes back into repair.`),
    held('safetyCheck', safetyCheckHeld(facts.number, facts.stage, facts.required)),
    held('ship', ship),
    held('cancel', cancel),
  ]
}

// ---- the list ---------------------------------------------------------------------------------------------------------

export const REPAIR_LIST_VIEWS = ['open', 'awaiting', 'received', 'inRepair', 'toCheck', 'toShip', 'closed', 'all'] as const
export type RepairListView = (typeof REPAIR_LIST_VIEWS)[number]

/** Where the repair stands, in a few words for the list (no amount). */
export function statusWords(facts: { readonly stage: RepairStage } & SafetyFacts): string {
  if (facts.stage === 'REPAIRED') {
    const state = safetyStateOf(facts)
    if (state === 'NOT_REQUIRED' || state === 'PASSED') return 'Repaired: ready to go back'
    return state === 'FAILED' ? 'Repaired: the safety check failed' : 'Repaired: waiting for its safety check'
  }
  if (facts.stage === 'SHIPPED') return facts.repairedAt ? 'Repaired and shipped back' : 'Shipped back unrepaired'
  const words = stageWords(facts.stage)
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}
