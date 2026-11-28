import type { Issue } from '../../core/errors'
import type { LocalisedNames } from '../materials/rules'
import type { StyleStatus } from '../styles/rules'
import type { RevisionStatus } from '../styles/revisions'
import { decimalOf } from '../units/units'
import { MAX_INSTRUCTIONS, minutesOf, operationUseRefusal, sameMinutes, type OperationStatus, type WorkCentreKind } from './operations'
import { groupProblems, parallelGroupProblem } from './parallel'

/**
 * A style revision's routing (plan A1 §2.4 B, §2.5; features PRD-110, PRD-111), pure: the operations that make the
 * garment, in order. Each step is a COPY of a library operation (./operations): its code, name, kind of work centre,
 * standard minutes and instructions are taken when it is added, so a later library change leaves the routing as it is;
 * the step's minutes, scan point and instructions may then differ for this style. The floor scans bundles at the steps
 * marked `scanRequired` (B-W1-42); a work order makes one operation of every step, at a work centre of the step's kind
 * on its site (B-W1-38).
 *
 *   order        steps are numbered 10, 20, 30 … (`seq`, unique per revision); a reorder numbers them again from 10
 *   minutes      per garment, above 0, 3 decimals (./operations minutesOf rounds a typed value half up, once)
 *   scan points  at least one step is scanned, or the floor cannot report the garment; the FINAL operation is the last
 *                scanned step: where the batch number or the garment's serial is given (B-W1-44)
 *   the library  a step is added only from an ACTIVE operation; it keeps its operation when that is archived later
 *                (a warning, not a blocker: the step's copy is what the floor works from)
 *   side by side B-W2b-88 (MES-025): steps with the same parallel group run at once and count as one step (./parallel);
 *                the group's steps follow each other and the final operation runs alone (both release blockers)
 *
 * The routing is edited only while the revision is DRAFT (the …_product_guards triggers refuse anything else, for every
 * login); `editRefusal` says so first, as a 409. A released routing is frozen; a change is a new revision.
 */

export const MAX_ROUTING_STEPS = 100
/** New steps are numbered 10, 20, 30 … */
export const SEQ_STEP = 10
export const MAX_SEQ = 99_999

/** A step as stored (the minutes as a plain decimal string). */
export interface StepFields {
  readonly seq: number
  readonly operationId: string
  readonly code: string
  readonly name: string
  readonly nameI18n: LocalisedNames | null
  readonly workCentreKind: WorkCentreKind
  readonly standardMinutes: string
  readonly scanRequired: boolean
  readonly instructions: string | null
  /** B-W2b-88: steps with the same number run side by side and count as one step (./parallel); left out or null: in sequence. */
  readonly parallelGroup?: number | null | undefined
  /**
   * owb-pd2: the department the step is in (RoutingOperation.departmentId, owb-b1 G3): copied from its library operation when the
   * step is made, kept by a copy, changed by the route builder; left out or null: its kind's department (production/departments/kinds).
   */
  readonly departmentId?: string | null | undefined
}

export interface StepData extends StepFields {
  readonly id: string
}

/** What the rules read about a step's library operation. */
export interface LibraryOperation {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly nameI18n: LocalisedNames | null
  readonly workCentreKind: WorkCentreKind
  readonly standardMinutes: string
  readonly instructions: string | null
  readonly status: OperationStatus
  /** owb-pd2: the department the operation belongs to (Operation.departmentId); a step made from it is in that department. */
  readonly departmentId?: string | null | undefined
}

/** A step as typed: on a new step what is left out comes from the library; on a change, what is left out stays. */
export interface StepChange {
  readonly standardMinutes?: string | undefined
  readonly scanRequired?: boolean | undefined
  readonly instructions?: string | null | undefined
  /** B-W2b-88: the step's parallel group; null takes it back into the sequence. */
  readonly parallelGroup?: number | null | undefined
}

export type StepPlan = { readonly ok: true; readonly step: StepFields } | { readonly ok: false; readonly issues: readonly Issue[] }

/** The next free place at the end of the routing: the next multiple of SEQ_STEP after the highest. */
export const nextSeq = (steps: readonly { readonly seq: number }[]): number => (Math.floor(steps.reduce((top, step) => Math.max(top, step.seq), 0) / SEQ_STEP) + 1) * SEQ_STEP

/** The steps in routing order. */
export const inOrder = <Step extends { readonly seq: number }>(steps: readonly Step[]): Step[] => [...steps].sort((a, b) => a.seq - b.seq)

interface ChangedFields extends Pick<StepFields, 'standardMinutes' | 'scanRequired' | 'instructions'> {
  readonly parallelGroup: number | null
}

function changedFields(change: StepChange, base: Pick<StepFields, 'standardMinutes' | 'scanRequired' | 'instructions' | 'parallelGroup'>): { fields: ChangedFields; issues: Issue[] } {
  const issues: Issue[] = []
  let standardMinutes = base.standardMinutes
  if (change.standardMinutes !== undefined) {
    const minutes = minutesOf(change.standardMinutes)
    if (minutes.ok) standardMinutes = minutes.minutes
    else issues.push({ path: 'standardMinutes', message: minutes.message })
  }
  const instructions = change.instructions === undefined ? base.instructions : change.instructions
  if (instructions !== null && (instructions.trim() !== instructions || instructions === '' || instructions.length > MAX_INSTRUCTIONS)) {
    issues.push({ path: 'instructions', message: `Expected text of 1 to ${MAX_INSTRUCTIONS} characters without leading or trailing spaces.` })
  }
  const parallelGroup = change.parallelGroup === undefined ? (base.parallelGroup ?? null) : change.parallelGroup
  const badGroup = parallelGroupProblem(parallelGroup)
  if (badGroup) issues.push({ path: 'parallelGroup', message: badGroup })
  return { fields: { standardMinutes, scanRequired: change.scanRequired ?? base.scanRequired, instructions, parallelGroup }, issues }
}

/**
 * A new step from a library operation, at `seq`: its code, name, kind, minutes and instructions copied from the
 * library, then what was typed (minutes for this style, scan point, instructions). Scanned unless said otherwise.
 */
export function planNewStep(operation: LibraryOperation, change: StepChange, seq: number): StepPlan {
  const issues: Issue[] = []
  const refusal = operationUseRefusal(operation)
  if (refusal) issues.push({ path: 'operationId', message: refusal })
  const { fields, issues: problems } = changedFields(change, { standardMinutes: operation.standardMinutes, scanRequired: true, instructions: operation.instructions, parallelGroup: null })
  issues.push(...problems)
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) issues.push({ path: 'seq', message: `The place is a whole number from 1 to ${MAX_SEQ}.` })
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    step: { seq, operationId: operation.id, code: operation.code, name: operation.name, nameI18n: operation.nameI18n, workCentreKind: operation.workCentreKind, departmentId: operation.departmentId ?? null, ...fields },
  }
}

/** A change to a step: its minutes, scan point, instructions or parallel group (its operation and place stay; a reorder moves it). */
export function planStepChange(current: StepFields, change: StepChange): StepPlan {
  const { fields, issues } = changedFields(change, current)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, step: { ...current, ...fields } }
}

/** The fields of a change that really change ("4.20" and "4.2" are the same minutes). */
export function stepChanges(before: StepFields, after: StepFields): (keyof StepFields)[] {
  const fields: (keyof StepFields)[] = ['seq', 'operationId', 'code', 'name', 'nameI18n', 'workCentreKind', 'standardMinutes', 'scanRequired', 'instructions', 'parallelGroup']
  return fields.filter((field) => (field === 'standardMinutes' ? !sameMinutes(before.standardMinutes, after.standardMinutes) : JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)))
}

// ---- order -------------------------------------------------------------------------------------------------------------

/** A new order must name every step of the routing exactly once (paths relative to the request body). */
export function orderProblems(stepIds: readonly string[], order: readonly string[]): Issue[] {
  const issues: Issue[] = []
  const known = new Set(stepIds)
  const seen = new Set<string>()
  order.forEach((id, index) => {
    if (seen.has(id)) issues.push({ path: `stepIds/${index}`, message: 'This step is named twice.' })
    else if (!known.has(id)) issues.push({ path: `stepIds/${index}`, message: 'Not a step of this routing.' })
    seen.add(id)
  })
  const missing = stepIds.filter((id) => !seen.has(id))
  if (missing.length > 0) issues.push({ path: 'stepIds', message: `Name every step of the routing once: ${missing.length} missing.` })
  return issues
}

/** The places of an order: 10, 20, 30 … */
export function sequenceOf(order: readonly string[]): Map<string, number> {
  return new Map(order.map((id, index) => [id, (index + 1) * SEQ_STEP]))
}

/**
 * The moves a renumbering needs, so the unique place per revision holds at every row: only the steps whose place
 * changes, each parked first (to its negative place, free because places are above 0) and then set.
 */
export function renumbering(steps: readonly Pick<StepData, 'id' | 'seq'>[], places: ReadonlyMap<string, number>): { readonly id: string; readonly from: number; readonly to: number }[] {
  return inOrder(steps)
    .map((step) => ({ id: step.id, from: step.seq, to: places.get(step.id) ?? step.seq }))
    .filter((move) => move.from !== move.to)
}

/**
 * Steps copied to the end of a routing (or into an empty one), numbered on from `firstSeq`, under new ids; a parallel group
 * renumbered by `groups` (./parallel groupsAfter: a copied group never joins one the routing keeps).
 */
export function copySteps(steps: readonly StepData[], firstSeq: number, newId: () => string, groups: ReadonlyMap<number, number> = new Map()): StepData[] {
  return inOrder(steps).map((step, index) => ({
    ...step,
    id: newId(),
    seq: firstSeq + index * SEQ_STEP,
    nameI18n: step.nameI18n ? { ...step.nameI18n } : null,
    parallelGroup: step.parallelGroup == null ? null : (groups.get(step.parallelGroup) ?? step.parallelGroup),
  }))
}

// ---- the final operation and what a draft still lacks ------------------------------------------------------------------

/** The final operation: the last scanned step (where the batch or serial is given, B-W1-44), or null. */
export function finalStepOf<Step extends Pick<StepData, 'id' | 'seq' | 'scanRequired'>>(steps: readonly Step[]): Step | null {
  return inOrder(steps).filter((step) => step.scanRequired).at(-1) ?? null
}

/** Blockers (the revision's release refuses them: product/bom release, B-W1-14) and warnings (shown only). */
export const ROUTING_BLOCKERS = ['NO_STEPS', 'MINUTES_NOT_POSITIVE', 'NO_SCAN_POINT', 'PARALLEL_GROUP_SPLIT', 'FINAL_SIDE_BY_SIDE'] as const
export const ROUTING_WARNINGS = ['OPERATION_ARCHIVED', 'LAST_STEP_NOT_SCANNED', 'PARALLEL_GROUP_ALONE'] as const
export const ROUTING_ISSUE_CODES = [...ROUTING_BLOCKERS, ...ROUTING_WARNINGS] as const
export type RoutingIssueCode = (typeof ROUTING_ISSUE_CODES)[number]

export interface RoutingIssue {
  readonly code: RoutingIssueCode
  readonly stepId: string | null
  readonly message: string
}

export interface RoutingCheck {
  readonly blockers: readonly RoutingIssue[]
  readonly warnings: readonly RoutingIssue[]
}

/**
 * What a draft routing still lacks before its revision is released (the release check, A2 SCR-046: "routing has
 * operations with SMV"; the release refuses every blocker: a work order is released with one operation per step, and the
 * floor reports at the scanned ones), and what it points out without refusing; against the library as it is now. A
 * released routing is frozen and never checked again.
 */
export function routingIssues(steps: readonly StepData[], operations: ReadonlyMap<string, Pick<LibraryOperation, 'code' | 'status'>>): RoutingCheck {
  const blockers: RoutingIssue[] = []
  const warnings: RoutingIssue[] = []
  const ordered = inOrder(steps)
  if (ordered.length === 0) blockers.push({ code: 'NO_STEPS', stepId: null, message: 'The routing has no operation yet.' })
  for (const step of ordered) {
    const name = `Step ${step.seq} (${step.code})`
    if (!decimalOf(step.standardMinutes, 'standardMinutes').gt(0)) blockers.push({ code: 'MINUTES_NOT_POSITIVE', stepId: step.id, message: `${name}: its standard minutes are above 0.` })
    if (operations.get(step.operationId)?.status === 'ARCHIVED') {
      warnings.push({ code: 'OPERATION_ARCHIVED', stepId: step.id, message: `${name}: operation ${step.code} is archived in the library; the step keeps its copy.` })
    }
  }
  if (ordered.length > 0 && !ordered.some((step) => step.scanRequired)) {
    blockers.push({ code: 'NO_SCAN_POINT', stepId: null, message: 'No step is scanned: the floor could not report a garment. Mark at least the final operation as scanned.' })
  }
  const last = ordered.at(-1)
  if (last && !last.scanRequired && ordered.some((step) => step.scanRequired)) {
    warnings.push({ code: 'LAST_STEP_NOT_SCANNED', stepId: last.id, message: `Step ${last.seq} (${last.code}) is not scanned: the batch or serial is given at the last scanned step, ${finalStepOf(ordered)!.code}.` })
  }
  // B-W2b-88 (MES-025): side by side steps follow each other; the final operation, where garments finish, runs alone.
  const groups = groupProblems(ordered)
  const stepAt = (seq: number) => ordered.find((step) => step.seq === seq)!
  for (const entry of groups.split) {
    blockers.push({ code: 'PARALLEL_GROUP_SPLIT', stepId: stepAt(entry.seqs[0]!).id, message: `Parallel group ${entry.group} (steps ${entry.seqs.join(', ')}) is split by other steps: side by side steps follow each other. Move them together.` })
  }
  for (const entry of groups.alone) {
    warnings.push({ code: 'PARALLEL_GROUP_ALONE', stepId: stepAt(entry.seq).id, message: `Step ${entry.seq} is alone in parallel group ${entry.group}: it runs like any step until another step joins it.` })
  }
  const final = finalStepOf(ordered)
  if (final && final.parallelGroup != null && ordered.some((step) => step.id !== final.id && step.parallelGroup === final.parallelGroup)) {
    blockers.push({ code: 'FINAL_SIDE_BY_SIDE', stepId: final.id, message: `Step ${final.seq} (${final.code}) is the final operation, where the batch or serial is given: it runs alone, not side by side. Take it out of group ${final.parallelGroup}, or scan a step after it.` })
  }
  return { blockers, warnings }
}

// ---- the revision's state ----------------------------------------------------------------------------------------------

/** Why the routing of this revision cannot be changed now (a 409), or null. */
export function editRefusal(revision: { readonly revision: number; readonly status: RevisionStatus }, styleStatus: StyleStatus): string | null {
  if (revision.status !== 'DRAFT') return `Revision ${revision.revision} is ${revision.status.toLowerCase()}: its routing is frozen. Copy it into a new draft to change it.`
  if (styleStatus === 'ARCHIVED') return 'This style is archived: reactivate it before changing its routing.'
  return null
}

/** Why steps cannot be copied from this revision, or null: only a released routing is copied into another style's draft. */
export function copySourceRefusal(source: { readonly revision: number; readonly status: RevisionStatus }, sameRevision: boolean): string | null {
  if (sameRevision) return 'A routing is not copied into itself.'
  if (source.status !== 'RELEASED') return `Revision ${source.revision} is ${source.status.toLowerCase()}: steps are copied only from a released routing.`
  return null
}

// ---- owb-pd2 (S4 products, step 2.2; design § 5w "the route builder", prototype prod.js `rbErrors`): the rules of a route ---------
/**
 * A route = the departments a product goes through, in order (the product's route on its revision, a model or customer route,
 * one order line's exception). The same rules for every one, read by the API (a save is refused on an error) and the web (the
 * builder shows them live):
 *
 *   errors    TOO_FEW            fewer than 2 steps
 *             LAST_NOT_PACKING   the last step's department is not of kind PACKING ("the last step is Packing", S4 settle 7)
 *             DEPARTMENT_CLOSED  a CLOSED department added new (a step that keeps a closed department where it was may stay:
 *                                closing changes no product, S4 settle 8)
 *   warnings  NO_QUALITY         no step of kind INSPECTION ("no quality check" is a note, never a stop)
 *
 * Each code is said once, errors and warnings in this order.
 */
export const ROUTE_ERRORS = ['TOO_FEW', 'LAST_NOT_PACKING', 'DEPARTMENT_CLOSED'] as const
export type RouteError = (typeof ROUTE_ERRORS)[number]
export const ROUTE_WARNINGS = ['NO_QUALITY'] as const
export type RouteWarning = (typeof ROUTE_WARNINGS)[number]
export const MIN_ROUTE_STEPS = 2

export interface RouteRules {
  readonly errors: readonly RouteError[]
  readonly warnings: readonly RouteWarning[]
}

/** A step as the rules read it: its department, and whether it is added new (or moved to that department) by this change. */
export interface RouteRuleStep {
  readonly departmentId: string
  readonly isNew?: boolean | undefined
}

/** A department as the rules read it. */
export interface RouteRuleDepartment {
  readonly id: string
  readonly workCentreKind: WorkCentreKind
  readonly status: 'ACTIVE' | 'CLOSED'
}

/** What a route breaks (errors: a save is refused) and what it points out (warnings). */
export function routeProblems(steps: readonly RouteRuleStep[], departments: readonly RouteRuleDepartment[]): RouteRules {
  const byId = new Map(departments.map((department) => [department.id, department]))
  const errors: RouteError[] = []
  if (steps.length < MIN_ROUTE_STEPS) errors.push('TOO_FEW')
  const last = steps.at(-1)
  if (last && byId.get(last.departmentId)?.workCentreKind !== 'PACKING') errors.push('LAST_NOT_PACKING')
  if (steps.some((step) => step.isNew === true && byId.get(step.departmentId)?.status === 'CLOSED')) errors.push('DEPARTMENT_CLOSED')
  const warnings: RouteWarning[] = steps.length > 0 && !steps.some((step) => byId.get(step.departmentId)?.workCentreKind === 'INSPECTION') ? ['NO_QUALITY'] : []
  return { errors, warnings }
}

/** The words of each rule (English, Italian): the API sends the English ones with a refused save (`refusal/<code>`). */
export const ROUTE_RULE_WORDS: Readonly<Record<RouteError | RouteWarning, { readonly en: string; readonly it: string }>> = Object.freeze({
  TOO_FEW: { en: 'A route has 2 steps or more.', it: 'Un percorso ha 2 passaggi o più.' },
  LAST_NOT_PACKING: { en: 'The last step of a route is Packing.', it: 'L’ultimo passaggio di un percorso è l’Imballaggio.' },
  DEPARTMENT_CLOSED: { en: 'A closed department cannot be added to a route: open it again first.', it: 'Un reparto chiuso non si aggiunge a un percorso: riaprilo prima.' },
  NO_QUALITY: { en: 'This route has no quality check.', it: 'Questo percorso non ha un controllo qualità.' },
})
// ---- end owb-pd2 2.2
