import type { Issue } from '../../core/errors'
import type { Permission } from '../../core/permissions'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { isGarmentZone, useAsIsProblem, type DefectClass, type DispositionFollowUp, type DispositionMove, type DispositionOutcome, type QualityStage } from '../defects/rules'

/**
 * Nonconformances (B-W2a-47; QHS-080 raised from anywhere, QHS-081 content, QHS-082 containment actions, QHS-083
 * disposition by quantity split, QHS-089 board, QHS-090 closure rules, QHS-091 rework order; design quality.ncr SCR-144
 * board and list, SCR-145 record: Problem & evidence, Containment, Disposition, Linked records, Activity; pop-ups
 * ncr-new and ncr-close). Pure rules: the stages and what each move needs (the board's refusal in words, the closing
 * checklist), the content's limits, containment, the decisions by quantity, the record types an NCR is raised from and
 * linked to, and what is signed at the close. The …_quality_plant_w2a_guards triggers hold the same rules for every
 * login; the API refuses first, in these words.
 *
 * Stages: OPEN → CONTAINED (every containment action done or cancelled, at least one done) → DECIDED (the whole quantity
 * affected decided, every decision that needs approval approved) → CLOSED (every decision carried out: its stock move
 * posted or its follow-up record made; the e-signature) — CANCELLED from OPEN or CONTAINED when nothing was carried out.
 */

export const NCR_SOURCES = ['INSPECTION', 'BUNDLE', 'COMPLAINT', 'RETURN', 'SUPPLIER', 'AUDIT', 'OTHER'] as const
export type NcrSource = (typeof NCR_SOURCES)[number]

export const NCR_STAGES = ['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED', 'CANCELLED'] as const
export type NcrStage = (typeof NCR_STAGES)[number]
/** The stages of an NCR still followed up. */
export const OPEN_NCR_STAGES = ['OPEN', 'CONTAINED', 'DECIDED'] as const satisfies readonly NcrStage[]
/** The board's lanes (design ncr-board: Open → Contained → Decided → Closed). */
export const BOARD_LANES = ['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED'] as const satisfies readonly NcrStage[]

export const CONTAINMENT_KINDS = ['HOLD_STOCK', 'CHECK_WIP', 'CHECK_SHIPPED', 'TELL_CUSTOMER', 'OTHER'] as const
export type ContainmentKind = (typeof CONTAINMENT_KINDS)[number]
export const CONTAINMENT_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type ContainmentStatus = (typeof CONTAINMENT_STATUSES)[number]

export const NCR_LIMITS = Object.freeze({
  title: 160,
  description: 4000,
  note: 1000,
  evidence: 2000,
  reason: 500,
  size: 40,
  serial: 80,
  /** Rows of a list or a board lane. */
  list: 200,
  actions: 30,
  decisions: 30,
  links: 100,
  /** The board's Closed lane shows the NCRs closed in the last days. */
  closedLaneDays: 30,
})

// ---- from anywhere ----------------------------------------------------------------------------------------------------

/**
 * The records an NCR is raised from (QHS-080 "from anywhere"; design ncr-new: "'Create NCR' on inspections, bundles,
 * complaints, returns"; the warehouse's write-off and the receipt's discrepancy; a scan's scrap; a hold). The API reads
 * each one and prefills the NCR from it.
 */
export const NCR_FROM_TYPES = [
  'Inspection',
  'Bundle',
  'OperationScan',
  'WorkOrder',
  'GarmentSerial',
  'Lot',
  'Hide',
  'GoodsReceipt',
  'ReceiptDiscrepancy',
  'SupplierClaim',
  'QualityHold',
  'ReturnAuthorisation',
  'ReturnLine',
  'Complaint',
] as const
export type NcrFromType = (typeof NCR_FROM_TYPES)[number]

/** Where an NCR raised from each kind of record comes from and was found, unless the person says otherwise. */
export const FROM_DEFAULTS: Readonly<Record<NcrFromType, { readonly source: NcrSource; readonly foundAt: QualityStage }>> = Object.freeze({
  Inspection: { source: 'INSPECTION', foundAt: 'FINAL' },
  Bundle: { source: 'BUNDLE', foundAt: 'IN_LINE' },
  OperationScan: { source: 'BUNDLE', foundAt: 'IN_LINE' },
  WorkOrder: { source: 'OTHER', foundAt: 'IN_LINE' },
  GarmentSerial: { source: 'OTHER', foundAt: 'FINAL' },
  Lot: { source: 'SUPPLIER', foundAt: 'STOCK' },
  Hide: { source: 'SUPPLIER', foundAt: 'STOCK' },
  GoodsReceipt: { source: 'SUPPLIER', foundAt: 'INCOMING' },
  ReceiptDiscrepancy: { source: 'SUPPLIER', foundAt: 'INCOMING' },
  SupplierClaim: { source: 'SUPPLIER', foundAt: 'INCOMING' },
  QualityHold: { source: 'OTHER', foundAt: 'STOCK' },
  ReturnAuthorisation: { source: 'RETURN', foundAt: 'CUSTOMER' },
  ReturnLine: { source: 'RETURN', foundAt: 'CUSTOMER' },
  Complaint: { source: 'COMPLAINT', foundAt: 'CUSTOMER' },
})

/** An NCR raised from a hold: by what it holds and why it was placed. */
export function holdDefaults(subjectType: string, holdSourceType: string | null): { readonly source: NcrSource; readonly foundAt: QualityStage } {
  if (holdSourceType === 'Complaint') return { source: 'COMPLAINT', foundAt: 'CUSTOMER' }
  const source: NcrSource = holdSourceType === 'Inspection' ? 'INSPECTION' : subjectType === 'Lot' || subjectType === 'Hide' ? 'SUPPLIER' : 'OTHER'
  const foundAt: QualityStage =
    subjectType === 'Lot' || subjectType === 'Hide' ? 'STOCK' : subjectType === 'GarmentSerial' ? 'FINAL' : subjectType === 'Shipment' || subjectType === 'Parcel' ? 'PACKING' : 'IN_LINE'
  return { source, foundAt }
}

/** The records an NCR may be linked to (the Linked records tab): what it is raised from and what it makes or touches. */
export const NCR_LINK_TYPES = [...NCR_FROM_TYPES, 'PpeRegisterEntry', 'ReworkOrder', 'RepairOrder', 'Shipment', 'SalesOrder', 'PurchaseOrder', 'Style'] as const
export type NcrLinkType = (typeof NCR_LINK_TYPES)[number]

/** A PPE nonconformity that may present a risk goes to the PPE register (Reg. (EU) 2016/425 art. 8(4)) by itself. */
export function opensRegisterEntry(ncr: { readonly ppe: boolean; readonly severity: DefectClass; readonly foundAt: QualityStage; readonly source: NcrSource }): boolean {
  return ncr.ppe && (ncr.severity === 'CRITICAL' || ncr.foundAt === 'CUSTOMER' || ncr.source === 'COMPLAINT' || ncr.source === 'RETURN')
}

// ---- stages -----------------------------------------------------------------------------------------------------------

const MOVES: Readonly<Record<NcrStage, readonly NcrStage[]>> = Object.freeze({
  OPEN: ['CONTAINED', 'CANCELLED'],
  CONTAINED: ['DECIDED', 'CANCELLED'],
  DECIDED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
})
export const canMoveNcr = (from: NcrStage, to: NcrStage): boolean => MOVES[from].includes(to)
/** The stage after this one on the board (null: CLOSED, CANCELLED). */
export const nextStage = (stage: NcrStage): NcrStage | null => (stage === 'OPEN' ? 'CONTAINED' : stage === 'CONTAINED' ? 'DECIDED' : stage === 'DECIDED' ? 'CLOSED' : null)
export const isOpenStage = (stage: NcrStage): boolean => (OPEN_NCR_STAGES as readonly NcrStage[]).includes(stage)
/** The problem (what happened, quantities, what it is about) is edited while OPEN or CONTAINED; read-only after (design ncr-what). */
export const problemEditable = (stage: NcrStage): boolean => stage === 'OPEN' || stage === 'CONTAINED'

const STAGE_WORDS: Readonly<Record<NcrStage, string>> = Object.freeze({ OPEN: 'open', CONTAINED: 'contained', DECIDED: 'decided', CLOSED: 'closed', CANCELLED: 'cancelled' })
export const stageWords = (stage: NcrStage): string => STAGE_WORDS[stage]

/** What the checks read of an NCR: its quantity, its containment actions, its decisions and the holds it decides. */
export interface NcrFacts {
  readonly stage: NcrStage
  readonly quantityAffected: string
  readonly uom: string
  readonly actions: readonly { readonly status: ContainmentStatus }[]
  readonly decisions: readonly { readonly quantity: string; readonly approvalRequired: boolean; readonly approved: boolean; readonly done: boolean }[]
  /** ACTIVE holds this NCR decides (closed with it). */
  readonly activeHolds: number
}

export const STAGE_CHECKS = ['STAGE', 'ACTION_DONE', 'NO_OPEN_ACTION', 'ALL_DECIDED', 'APPROVED', 'CARRIED_OUT', 'HOLDS', 'NOTHING_CARRIED_OUT'] as const
export type StageCheckKey = (typeof STAGE_CHECKS)[number]
export interface StageCheck {
  readonly key: StageCheckKey
  readonly ok: boolean
  readonly words: string
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
const text = (value: Decimal): string => (value.isInteger() ? value.toFixed(0) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))

/** How much is decided (design "28 of 40 decided · 12 left"). */
export function decidedOf(facts: Pick<NcrFacts, 'quantityAffected' | 'uom' | 'decisions'>): { readonly affected: Decimal; readonly decided: Decimal; readonly left: Decimal; readonly words: string } {
  const affected = new Dec(facts.quantityAffected)
  const decided = facts.decisions.reduce((sum, decision) => sum.plus(decision.quantity), ZERO)
  const left = affected.minus(decided)
  const unit = facts.uom
  const words = left.lte(0) ? `All ${text(affected)} ${unit} decided` : `${text(decided)} of ${text(affected)} ${unit} decided · ${text(left)} left`
  return { affected, decided, left: left.lt(0) ? ZERO : left, words }
}

function containedChecks(facts: NcrFacts): StageCheck[] {
  const done = facts.actions.filter((action) => action.status === 'DONE').length
  const open = facts.actions.filter((action) => action.status === 'OPEN').length
  return [
    { key: 'ACTION_DONE', ok: done > 0, words: done > 0 ? `${plural(done, 'containment action', 'containment actions')} done.` : 'No containment action is done yet: do one (hold the stock, check the work in progress …).' },
    { key: 'NO_OPEN_ACTION', ok: open === 0, words: open === 0 ? 'No containment action is open.' : `${plural(open, 'containment action is', 'containment actions are')} still open: do or cancel ${open === 1 ? 'it' : 'them'} first.` },
  ]
}

function decidedChecks(facts: NcrFacts): StageCheck[] {
  const bar = decidedOf(facts)
  const waiting = facts.decisions.filter((decision) => decision.approvalRequired && !decision.approved).length
  return [
    { key: 'ALL_DECIDED', ok: bar.left.lte(0), words: bar.left.lte(0) ? `${bar.words}.` : `${bar.words}: decide the rest first.` },
    { key: 'APPROVED', ok: waiting === 0, words: waiting === 0 ? 'No decision waits for approval.' : `${plural(waiting, 'decision waits', 'decisions wait')} for another person's approval.` },
  ]
}

function closedChecks(facts: NcrFacts): StageCheck[] {
  const undone = facts.decisions.filter((decision) => !decision.done).length
  return [
    {
      key: 'CARRIED_OUT',
      ok: undone === 0,
      words: undone === 0 ? 'Every decision is carried out.' : `${plural(undone, 'decision waits', 'decisions wait')} for ${undone === 1 ? 'its' : 'their'} stock move or follow-up record: carry ${undone === 1 ? 'it' : 'them'} out first.`,
    },
    { key: 'HOLDS', ok: true, words: facts.activeHolds === 0 ? 'No hold of this NCR is active.' : `${plural(facts.activeHolds, 'hold', 'holds')} this NCR decides ${facts.activeHolds === 1 ? 'is' : 'are'} closed with it.` },
  ]
}

/** What a move of the NCR needs, each check in words (the board's refusal: "12 of 40 PCS not decided"). */
export function stageChecks(facts: NcrFacts, to: NcrStage): StageCheck[] {
  const stage: StageCheck = canMoveNcr(facts.stage, to)
    ? { key: 'STAGE', ok: true, words: `The NCR moves from ${stageWords(facts.stage)} to ${stageWords(to)}.` }
    : {
        key: 'STAGE',
        ok: false,
        words: facts.stage === 'CLOSED' || facts.stage === 'CANCELLED' ? `The NCR is ${stageWords(facts.stage)}: it never changes.` : `An NCR ${stageWords(facts.stage)} moves ${MOVES[facts.stage].map((next) => `to ${stageWords(next)}`).join(' or ')}, not to ${stageWords(to)}.`,
      }
  if (to === 'CONTAINED') return [stage, ...containedChecks(facts)]
  if (to === 'DECIDED') return [stage, ...decidedChecks(facts)]
  if (to === 'CLOSED') return [stage, ...closedChecks(facts)]
  if (to === 'CANCELLED') {
    const done = facts.decisions.filter((decision) => decision.done).length
    return [stage, { key: 'NOTHING_CARRIED_OUT', ok: done === 0, words: done === 0 ? 'No decision is carried out.' : `${plural(done, 'decision is', 'decisions are')} carried out: close the NCR instead.` }]
  }
  return [stage]
}

/**
 * The closing checklist (design ncr-close: "all quantity decided ✓ · stock moves done ✕ (2 waiting) · actions complete
 * ✓"): from whichever open stage the NCR is in, everything still missing on the way to CLOSED. The close command moves
 * the NCR through the stages it skips in one command when every check is met.
 */
export function closeChecklist(facts: NcrFacts): StageCheck[] {
  if (!isOpenStage(facts.stage)) return stageChecks(facts, 'CLOSED')
  const checks: StageCheck[] = []
  if (facts.stage === 'OPEN') checks.push(...containedChecks(facts))
  if (facts.stage !== 'DECIDED') checks.push(...decidedChecks(facts))
  checks.push(...closedChecks(facts))
  return checks
}

export const allMet = (checks: readonly StageCheck[]): boolean => checks.every((check) => check.ok)
export const firstUnmet = (checks: readonly StageCheck[]): StageCheck | null => checks.find((check) => !check.ok) ?? null

/** The stages a close passes through from where the NCR is (CONTAINED → DECIDED → CLOSED …). */
export function stagesToClose(stage: NcrStage): NcrStage[] {
  const path: NcrStage[] = []
  let at: NcrStage | null = stage
  while (at && at !== 'CLOSED' && isOpenStage(at)) {
    at = nextStage(at)
    if (at) path.push(at)
  }
  return path
}

/** What a closing e-signature signs: the NCR, who and when, its decisions and the note (its SHA-256 is stored). */
export function closeStatement(input: {
  readonly ncrId: string
  readonly number: string
  readonly closedBy: string
  readonly closedAt: string
  readonly quantityAffected: string
  readonly uom: string
  readonly decisions: readonly { readonly seq: number; readonly code: string; readonly quantity: string; readonly followUp: string | null; readonly stockMoveId: string | null }[]
  readonly note: string
}): string {
  return [
    `I close nonconformance ${input.number} (${input.ncrId}).`,
    `Quantity affected: ${input.quantityAffected} ${input.uom}; every quantity has an outcome:`,
    ...input.decisions.map((decision) => `  ${decision.seq}. ${decision.code} ${decision.quantity} ${input.uom}${decision.stockMoveId ? `, stock move ${decision.stockMoveId}` : ''}${decision.followUp ? `, ${decision.followUp}` : ''}`),
    `Closed by ${input.closedBy} at ${input.closedAt}.`,
    `Note: ${input.note}`,
  ].join('\n')
}

// ---- content ----------------------------------------------------------------------------------------------------------

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/

/** A quantity as typed (Decimal(18,4)), above 0 or from 0. */
export function quantityProblem(value: string | null | undefined, path: string, positive: boolean): Issue | null {
  if (value === null || value === undefined) return null
  if (!QUANTITY.test(value)) return { path, message: 'A quantity with at most 4 decimals.' }
  const amount = new Dec(value)
  if (positive && amount.lte(0)) return { path, message: 'Above 0.' }
  return null
}

export interface NcrDraft {
  readonly title?: string | null | undefined
  readonly description?: string | null | undefined
  readonly quantityAffected?: string | null | undefined
  readonly quantitySuspect?: string | null | undefined
  readonly zone?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly foundOn?: Date | null | undefined
}

/** The NCR's content (QHS-081), new (`creating`: title and quantity required) or changed. Paths are the body's fields. */
export function ncrDraftProblems(draft: NcrDraft, creating: boolean, now: Date): Issue[] {
  const problems: Issue[] = []
  const title = draft.title?.trim() ?? ''
  if ((creating || draft.title !== undefined) && title === '') problems.push({ path: 'title', message: 'Say in a few words what is wrong.' })
  if (title.length > NCR_LIMITS.title) problems.push({ path: 'title', message: `At most ${NCR_LIMITS.title} characters.` })
  if ((draft.description ?? '').length > NCR_LIMITS.description) problems.push({ path: 'description', message: `At most ${NCR_LIMITS.description} characters.` })
  if (creating && (draft.quantityAffected === undefined || draft.quantityAffected === null)) problems.push({ path: 'quantityAffected', message: 'How much is affected.' })
  const affected = quantityProblem(draft.quantityAffected, 'quantityAffected', true)
  if (affected) problems.push(affected)
  const suspect = quantityProblem(draft.quantitySuspect, 'quantitySuspect', false)
  if (suspect) problems.push(suspect)
  if (draft.zone !== undefined && draft.zone !== null && !isGarmentZone(draft.zone)) problems.push({ path: 'zone', message: 'A zone of the garment map (FRONT, SLEEVE_L …).' })
  if ((draft.size ?? '').length > NCR_LIMITS.size) problems.push({ path: 'size', message: `At most ${NCR_LIMITS.size} characters.` })
  if ((draft.serial ?? '').length > NCR_LIMITS.serial) problems.push({ path: 'serial', message: `At most ${NCR_LIMITS.serial} characters.` })
  if (draft.foundOn && draft.foundOn.getTime() > now.getTime() + 5 * 60_000) problems.push({ path: 'foundOn', message: 'When it was found: not in the future.' })
  return problems
}

// ---- containment (QHS-082) --------------------------------------------------------------------------------------------

export function containmentProblems(draft: { readonly kind?: ContainmentKind | undefined; readonly description?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if (draft.kind === 'OTHER' && !(draft.description ?? '').trim()) problems.push({ path: 'description', message: 'Say what the action is.' })
  if ((draft.description ?? '').length > NCR_LIMITS.note) problems.push({ path: 'description', message: `At most ${NCR_LIMITS.note} characters.` })
  return problems
}

/** Done needs its evidence: a note or a file of the action; holding stock names its hold. */
export function doneProblems(action: { readonly kind: ContainmentKind; readonly evidenceNote: string | null; readonly files: number; readonly holdId: string | null }): Issue[] {
  const problems: Issue[] = []
  if (!(action.evidenceNote ?? '').trim() && action.files === 0) problems.push({ path: 'evidenceNote', message: 'Say what was done, or add a photo or file of it first.' })
  if ((action.evidenceNote ?? '').length > NCR_LIMITS.evidence) problems.push({ path: 'evidenceNote', message: `At most ${NCR_LIMITS.evidence} characters.` })
  if (action.kind === 'HOLD_STOCK' && !action.holdId) problems.push({ path: 'hold', message: 'Holding stock names its hold: place it here, or name a hold of the goods.' })
  return problems
}

export const actionOverdue = (action: { readonly status: ContainmentStatus; readonly dueAt: Date | null }, now: Date): boolean => action.status === 'OPEN' && action.dueAt !== null && action.dueAt.getTime() < now.getTime()

/** The containment is overdue (the design's "Containment overdue" tile): OPEN past its due time, or an action open past its own. */
export function containmentOverdue(ncr: { readonly stage: NcrStage; readonly containmentDueAt: Date | null }, actions: readonly { readonly status: ContainmentStatus; readonly dueAt: Date | null }[], now: Date): boolean {
  if (ncr.stage !== 'OPEN') return false
  return (ncr.containmentDueAt !== null && ncr.containmentDueAt.getTime() < now.getTime()) || actions.some((action) => actionOverdue(action, now))
}

// ---- decisions (QHS-083, QHS-005) -------------------------------------------------------------------------------------

export const DECISION_STATES = ['WAITING_APPROVAL', 'TO_CARRY_OUT', 'DONE'] as const
export type DecisionState = (typeof DECISION_STATES)[number]
export const decisionState = (decision: { readonly approvalRequired: boolean; readonly approved: boolean; readonly done: boolean }): DecisionState =>
  decision.done ? 'DONE' : decision.approvalRequired && !decision.approved ? 'WAITING_APPROVAL' : 'TO_CARRY_OUT'

/** A new or changed decision: above 0, never more than is left to decide, never "use as is" on a major or critical NCR. */
export function decisionProblems(input: { readonly quantity: string; readonly left: Decimal; readonly uom: string; readonly outcome: DispositionOutcome; readonly severity: DefectClass; readonly note?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  const quantity = quantityProblem(input.quantity, 'quantity', true)
  if (quantity) problems.push(quantity)
  else if (new Dec(input.quantity).gt(input.left)) problems.push({ path: 'quantity', message: input.left.lte(0) ? 'The whole quantity is decided already: change or remove a decision first.' : `Only ${text(input.left)} ${input.uom} ${input.left.eq(1) ? 'is' : 'are'} left to decide.` })
  const asIs = useAsIsProblem(input.outcome, input.severity)
  if (asIs) problems.push({ path: 'dispositionCodeId', message: asIs })
  if ((input.note ?? '').length > NCR_LIMITS.note) problems.push({ path: 'note', message: `At most ${NCR_LIMITS.note} characters.` })
  return problems
}

/** Why the person may not approve a decision now (null: they may). Four eyes: never the one who decided it. */
export function approveProblem(input: { readonly stage: NcrStage; readonly approvalRequired: boolean; readonly approved: boolean; readonly done: boolean; readonly decidedById: string | null; readonly approverId: string }): string | null {
  if (!input.approvalRequired) return 'This decision needs no approval.'
  if (input.approved) return 'This decision is approved already.'
  if (!problemEditable(input.stage)) return `The NCR is ${stageWords(input.stage)}: decisions are approved while it is open or contained.`
  if (input.decidedById !== null && input.decidedById === input.approverId) return 'You decided this: another person approves it (four eyes).'
  return null
}

/** Why a decision cannot be carried out now (null: it can). */
export function carryOutProblem(input: { readonly stage: NcrStage; readonly approvalRequired: boolean; readonly approved: boolean; readonly done: boolean }): string | null {
  if (input.done) return 'This decision is carried out already.'
  if (!isOpenStage(input.stage)) return `The NCR is ${stageWords(input.stage)}: its decisions never change.`
  if (input.approvalRequired && !input.approved) return "This decision waits for another person's approval."
  return null
}

/** The right a decision's stock move needs besides the NCR's (the inventory's own). */
export const MOVE_PERMISSIONS: Readonly<Record<DispositionMove, Permission>> = Object.freeze({
  SCRAP: 'inventory.scrap',
  TRANSFER: 'inventory.transfer',
  ADJUSTMENT: 'inventory.adjust',
  ISSUE: 'inventory.issue',
})

/** The record type a decision's follow-up is (NcrDispositionLine.followUpType). */
export const FOLLOW_UP_TYPES: Readonly<Record<DispositionFollowUp, 'ReworkOrder' | 'RepairOrder' | 'SupplierClaim'>> = Object.freeze({
  REWORK_ORDER: 'ReworkOrder',
  REPAIR_ORDER: 'RepairOrder',
  SUPPLIER_CLAIM: 'SupplierClaim',
})

/** The goods' value for an approval rule (minor units of the company's currency), when the unit cost is known: else null. */
export function valueOf(quantity: string, unitCost: string | null): number | null {
  if (unitCost === null) return null
  const value = new Dec(quantity).times(unitCost).times(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP)
  return value.isFinite() ? Number(value.toFixed(0)) : null
}

// ---- the record's band -----------------------------------------------------------------------------------------------

/** What the record's band offers now: null = allowed, words = why not. */
export function ncrActions(facts: NcrFacts): { readonly edit: string | null; readonly contain: string | null; readonly decide: string | null; readonly close: string | null; readonly cancel: string | null } {
  const frozen = facts.stage === 'CLOSED' || facts.stage === 'CANCELLED' ? `The NCR is ${stageWords(facts.stage)}: it never changes.` : null
  const editable = problemEditable(facts.stage) ? null : (frozen ?? 'The NCR is decided: its problem is read-only now.')
  const contain = facts.stage === 'OPEN' ? firstUnmet(stageChecks(facts, 'CONTAINED'))?.words ?? null : (frozen ?? 'The containment is done.')
  const decide = facts.stage === 'CONTAINED' ? firstUnmet(stageChecks(facts, 'DECIDED'))?.words ?? null : facts.stage === 'OPEN' ? 'Contain it first: its containment actions done.' : (frozen ?? 'It is decided.')
  const close = frozen ?? firstUnmet(closeChecklist(facts))?.words ?? null
  const cancel = facts.stage === 'OPEN' || facts.stage === 'CONTAINED' ? firstUnmet(stageChecks(facts, 'CANCELLED'))?.words ?? null : (frozen ?? 'A decided NCR is closed, not cancelled.')
  return { edit: editable, contain, decide, close, cancel }
}

export function ageDays(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000))
}

// ---- W2b follow-ups (B-W2b-17) ---------------------------------------------------------------------------------------

/**
 * The containment time (B-W2a-47's 24 hours made a setting; QualitySettings.defaultContainmentHours, W2b schema wave 2):
 * hours after the problem was found by which an NCR's containment is due when the person says nothing. The company's
 * row wins, else the tenant-wide row, else 24.
 */
export const DEFAULT_CONTAINMENT_HOURS = 24
export const CONTAINMENT_HOURS_LIMITS = Object.freeze({ min: 1, max: 720 })
export type SettingSource = 'COMPANY' | 'TENANT' | 'DEFAULT'

export function containmentHoursInForce(company: number | null | undefined, tenant: number | null | undefined): { readonly hours: number; readonly source: SettingSource } {
  if (company !== null && company !== undefined) return { hours: company, source: 'COMPANY' }
  if (tenant !== null && tenant !== undefined) return { hours: tenant, source: 'TENANT' }
  return { hours: DEFAULT_CONTAINMENT_HOURS, source: 'DEFAULT' }
}

export function containmentHoursProblem(hours: number | null): Issue | null {
  if (hours === null) return null
  if (!Number.isInteger(hours) || hours < CONTAINMENT_HOURS_LIMITS.min || hours > CONTAINMENT_HOURS_LIMITS.max) {
    return { path: 'body/defaultContainmentHours', message: `Whole hours from ${CONTAINMENT_HOURS_LIMITS.min} to ${CONTAINMENT_HOURS_LIMITS.max} (30 days).` }
  }
  return null
}

/**
 * An NCR's prefilled title in parts (B-W2a-68's gap: the API's English sentence on Italian screens): the screen words the
 * key with its values in the reader's language; `title` stays the English sentence the API stores when the person
 * leaves the field as it was prefilled.
 */
export const NCR_TITLE_KEYS = [
  'INSPECTION_DEFECT',
  'INSPECTION_DEFECTS',
  'INSPECTION_FAILED',
  'BUNDLE_REJECTED',
  'SCAN_REJECTED',
  'WORK_ORDER',
  'GARMENT',
  'LOT',
  'HIDE',
  'RECEIPT',
  'DISCREPANCY',
  'CLAIM',
  'HOLD',
  'RMA',
  'RETURN_LINE',
  'COMPLAINT',
] as const
export type NcrTitleKey = (typeof NCR_TITLE_KEYS)[number]
export interface NcrTitleParts {
  readonly key: NcrTitleKey
  /** The values the words name (codes, numbers, counts, a defect's code; never a person). */
  readonly values: Readonly<Record<string, string>>
}

/** The most defect lines picked for one NCR ("Create NCR from N defects"). */
export const NCR_PICKED_DEFECTS_LIMIT = 50

/** Bulk owner (design ncr-grid "Assign owner N"): at most this many NCRs in one command. */
export const NCR_BULK_LIMIT = 50
