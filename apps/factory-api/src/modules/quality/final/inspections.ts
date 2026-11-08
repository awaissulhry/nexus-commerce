import { createHash } from 'node:crypto'
import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_INSPECTIONS_RECORD, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import {
  aqlText,
  checklistOf,
  checklistProblems,
  computedResult,
  decisionProblems,
  defectCounts,
  defectProblems,
  dueProblem,
  inspectionOverdue,
  inspectionLabel,
  isOverride,
  planProblems,
  reasonProblem,
  resultWords,
  type ChecklistAnswer,
  type DefectLine,
  type InspectionResult,
  type SamplingPlan,
} from '@nexus/factory-domain/quality/final/rules'
import { RELEASE_STATUSES } from '@nexus/factory-domain/quality/release/rules'
// B-W2b-97: the final inspection by plan (QHS-014, QHS-023, QHS-049, QHS-052, QHS-053, QHS-054).
import { recordedClassProblem } from '@nexus/factory-domain/quality/defects/severity'
import type { DefectClass as LibraryClass } from '@nexus/factory-domain/quality/defects/rules'
import { reasonProblem as aqlReasonProblem } from '@nexus/factory-domain/quality/aql/profiles'
import { acceptanceOf, aqlStored, levelText } from '@nexus/factory-domain/quality/aql/sampling'
import {
  applicablePlans,
  checksState,
  fixedSampling,
  identityEntry,
  inspectedOf,
  isSystemEntry,
  photoSet,
  planChecklist,
  planDecisionProblems,
  sampleEntry,
  sampleRejected,
  samplingChanges,
  type ChecklistEntry,
} from '@nexus/factory-domain/quality/final/plan'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { allocateNumber, assertNumberUniqueInTenant } from '../../../platform/numbering/allocate'
import { asTenantSystem, assertFloorReady } from '../../production/serials/facts'
import { readCells, type LabelHeader } from '../../production/serials/store'
import { scanProgressOf } from '../../production/scans/progress'
import { aqlPlanFor, customersOf } from '../aql/chain'
import { holdOnInspection } from '../holds/checks'
import { finalWorkOrder, inspectorOf, mayOn, postedBy, signerOf, type Inspector } from './access'
import { assertAssignable, assignedView, assigneeNames, assigneeOf, isAssigned, isAssignee, type Assignee } from './assign'
import { identityOf, MakerRefusedError, makerCheck, type Identity } from './facts'
import { bindingOf, factsReader, finalPlans, identityFacts, measurementRow, measurementsOf, namedPlan, photosOf, readBinding, resultRow, resultsOf, stopRule, workOrderFacts, type Binding } from './plan'
import { makersOf, readDefects, readInspection, readWorkOrderInspections, type DefectRow, type InspectionRow, type Reader } from './store'

/**
 * The final inspection of a work order's finished garments (B-W1-45; QHS-013, QHS-050, QHS-058; A1 §2.5 "Final release";
 * design quality.inspections, floor.final; SCR-075, SCR-076, SCR-097). The office (a quality inspector) or the site's
 * floor (a floor inspector, signed in, at its own site) opens one, records the sample, the checklist and the defects, and
 * signs the result; each write is ONE command() with its audit row and event; the rules and words are factory-domain
 * quality/final; the …_quality_final_release_guards triggers are the last word (they write the computed result).
 *
 *   open      quality.inspections.record over the work order: released, in progress or completed; a lot of its FINISHED
 *             garments (B-W1-42's scans at the final operation); the opener is the inspector (an office user, or the
 *             floor's signed-in worker) and made none of the garments (cut log, bundles, scans). The floor first needs
 *             the site's floor to be ready (B-W1-36/37).
 *   record    PATCH (plan, checklist, note, the signed statement) and PUT …/defects (the whole list; lines matched by
 *             class and code) while OPEN, by its inspector, with the inspection's version.
 *   decide    the signature (QHS-058): the office's fresh code (step-up) or the floor's PIN; every check answered; the
 *             decision is the computed result, or an override with the written reason (QHS-013; a PASS over a critical
 *             defect or a failed check never); the inspector still made none of the garments, and signs the statement
 *             where the floor's records name the station only. Its SHA-256 is the e-signature.
 *   cancel    an OPEN inspection abandoned, with the reason.
 */

/** B-W2b-97: a change the sampling plan's source does not allow, in words with its code (409 `refusal/<CODE>` + the fields). */
export class SamplingRefusedError extends ConflictError {
  override name = 'SamplingRefusedError'
  override readonly issues: readonly Issue[]
  constructor(code: 'PROFILE_BOUND' | 'PLAN_BOUND' | 'PLAN_CHECKS', message: string, fields: readonly string[]) {
    super(message)
    this.issues = [{ path: `refusal/${code}`, message }, ...fields.map((field) => ({ path: `body/${field}`, message }))]
  }
}

/** A decided or cancelled inspection never changes (409 before the trigger). */
export const assertOpen = (inspection: Pick<InspectionRow, 'status'>) => {
  if (inspection.status !== 'OPEN') throw new InvalidStateError(`This inspection is ${inspection.status}; a signed or cancelled inspection never changes (a correction is an amendment, W2b).`)
}

/**
 * The inspection's row FOR UPDATE inside a command, then its version (edit-conflict guard: 409) and its state (an OPEN
 * one only: 409 in words, before the trigger would refuse). Every write bumps the version itself.
 */
export async function lockInspection(tx: CommandTx, inspectionId: string, expectedVersion: number): Promise<InspectionRow> {
  await tx.$queryRaw`SELECT "id" FROM "Inspection" WHERE "id" = ${inspectionId}::uuid FOR UPDATE`
  const row = await readInspection(tx, inspectionId)
  if (!row) throw new NotFoundError('Inspection not found.')
  if (row.version !== expectedVersion) throw new StaleVersionError('Inspection', row.id, row.version, expectedVersion)
  assertOpen(row)
  return row
}

export const invalid = (message: string, problems: readonly Issue[]) => new ValidationError(message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))

/** The inspection and its work order, as the caller may reach them. */
export async function inspectionFor(caller: CommandCaller, inspectionId: string, permission: Permission = QUALITY_INSPECTIONS_VIEW): Promise<{ inspection: InspectionRow; header: LabelHeader }> {
  const context = inspectorOf(caller)
  const inspection = await caller.withClient((client) => readInspection(client, inspectionId))
  if (!inspection || !(mayOn(context, QUALITY_INSPECTIONS_VIEW, inspection) || mayOn(context, permission, inspection))) throw new NotFoundError('Inspection not found.')
  const header = await finalWorkOrder(caller, inspection.workOrderId, permission)
  return { inspection, header }
}

/**
 * The caller records and signs this inspection: its assignee when it is assigned (W2a, B-W2a-67: ./assign.ts), else its
 * inspector (the worker or office user who opened it).
 */
export const isOwn = (context: Inspector, inspection: Pick<InspectionRow, 'inspectorWorkerId' | 'inspectorUserId' | 'assignedInspectorId' | 'assignedInspectorWorkerId'>): boolean => {
  const signer = signerOf(context)
  const assignee = assigneeOf(inspection)
  if (isAssigned(assignee)) return isAssignee(assignee, signer)
  return (signer.workerId !== null && signer.workerId === inspection.inspectorWorkerId) || (signer.userId !== null && signer.userId === inspection.inspectorUserId)
}

/** Only its inspector — or, once assigned, its assignee — records and signs an inspection. */
export function assertOwnInspection(context: Inspector, inspection: InspectionRow) {
  if (isOwn(context, inspection)) return
  throw new ForbiddenError(isAssigned(assigneeOf(inspection)) ? 'This inspection is assigned to another inspector: they record and sign it.' : 'This inspection is recorded and signed by the inspector who opened it.')
}

/**
 * The inspector columns a write sets: the assignee who records it becomes its inspector (the signature and the four-eyes
 * rules name who signs); nothing changes when the caller already is.
 */
export function takeOver(context: Inspector, row: Pick<InspectionRow, 'inspectorWorkerId' | 'inspectorUserId'>): { inspectorWorkerId: string | null; inspectorUserId: string | null } | Record<string, never> {
  const signer = signerOf(context)
  if (signer.workerId === row.inspectorWorkerId && signer.userId === row.inspectorUserId) return {}
  return { inspectorWorkerId: signer.workerId, inspectorUserId: signer.userId }
}

/** The caller as people (office: their own reads; floor: through the tenant's system view, which reads Worker.userId). */
export async function callerIdentity(caller: CommandCaller): Promise<Identity> {
  const context = inspectorOf(caller)
  const reader = context.audience === 'office' ? caller : asTenantSystem(caller)
  return reader.withClient((client) => identityOf(client, signerOf(context)))
}

/** The finished garments of the work order (good at the final operation; null: no scanned operation). */
async function finishedOf(db: Reader, header: LabelHeader): Promise<number | null> {
  const progress = await scanProgressOf(db, header)
  const values = [...progress.values()].map((cell) => cell.finished)
  if (values.length === 0 || values.some((value) => value === null)) return values.length === 0 ? 0 : null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

const piecesOf = async (db: Reader, workOrderId: string) => (await readCells(db, workOrderId)).reduce((sum, cell) => sum + cell.quantity, 0)

// ---- the views -------------------------------------------------------------------------------------------------------------------

const defectView = (row: DefectRow) => ({ id: row.id, defectClass: row.defectClass, code: row.code, defectCodeId: row.defectCodeId, zone: row.zone, description: row.description, quantity: row.quantity, workOrderSizeId: row.workOrderSizeId, note: row.note, causeCodeId: row.causeCodeId })

/** The checklist's answers (B-W2b-97: without the counter's and the identity check's entries of an inspection on a plan). */
export const checklistAnswers = (value: unknown): ChecklistAnswer[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is { code: string; ok: boolean | null; note?: string | null } => entry !== null && typeof entry === 'object' && typeof (entry as { code?: unknown }).code === 'string' && !isSystemEntry((entry as { code: string }).code))
        .map((entry) => ({ code: entry.code, ok: entry.ok, note: entry.note ?? null }))
    : []

/** The plan an inspection runs on, as its view names it (B-W2b-97). */
export interface PlannedView {
  readonly planVersion: { readonly id: string; readonly planId: string; readonly code: string; readonly name: string; readonly number: number }
  /** The checklist written from the results as it stands (the decision writes the same). */
  readonly checklist: readonly ChecklistEntry[]
}

export const planOf = (row: InspectionRow): SamplingPlan => ({
  lotSize: row.lotSize,
  sampleSize: row.sampleSize,
  inspectionLevel: row.inspectionLevel,
  aqlMajor: row.aqlMajor.toString(),
  aqlMinor: row.aqlMinor.toString(),
  acceptMajor: row.acceptMajor,
  acceptMinor: row.acceptMinor,
})

/** One inspection as every screen shows it: its plan, checklist, defects, the result now (computed) and the decision. */
export function inspectionView(row: InspectionRow, defects: readonly DefectRow[], context: { readonly number: string; readonly seq: number; readonly names?: ReadonlyMap<string, string>; readonly now?: Date; readonly planned?: PlannedView | null }) {
  const plan = planOf(row)
  // B-W2b-97: on a plan, the checks' answers are the results (written into `checklist` at the decision).
  const checklist = context.planned && row.status === 'OPEN' ? checklistAnswers(context.planned.checklist) : checklistAnswers(row.checklist)
  const computed = computedResult({ counts: defectCounts(defects), plan, checklist: context.planned && row.status === 'OPEN' ? context.planned.checklist : checklist })
  return {
    id: row.id,
    /** Its own number (INS-2026-0412); null for one opened before the company's INSPECTION series existed. */
    inspectionNumber: row.number,
    label: inspectionLabel(context.number, context.seq, row.number),
    workOrderId: row.workOrderId,
    companyId: row.companyId,
    siteId: row.siteId,
    status: row.status,
    plan: { ...plan, aqlMajor: aqlText(plan.aqlMajor), aqlMinor: aqlText(plan.aqlMinor), hundredPercent: plan.sampleSize === plan.lotSize },
    // On a plan: in the plan's order (its codes need not be W1's); W1: in the fixed checklist's order.
    checklist: context.planned ? checklist.map((answer) => ({ code: answer.code, ok: answer.ok, note: answer.note?.trim() ? answer.note.trim() : null })) : checklistOf(checklist),
    /** B-W2b-97: the plan version it runs on (null: W1's fixed checklist), the AQL profile and code letter its sample came from, the units inspected. */
    planVersion: context.planned ? { ...context.planned.planVersion } : null,
    aqlProfileId: row.aqlProfileId,
    codeLetter: row.codeLetter,
    inspected: row.planVersionId ? inspectedOf(row.checklist) : null,
    defects: defects.filter((defect) => defect.inspectionId === row.id).map(defectView),
    counts: defectCounts(defects.filter((defect) => defect.inspectionId === row.id)),
    /** The rules' result now (an OPEN inspection: as it stands); a decided one: what the database wrote. */
    computed: { result: (row.computedResult ?? computed.result) as InspectionResult, words: resultWords(computed) },
    overridden: row.overrideReason !== null,
    overrideReason: row.overrideReason,
    inspector: { kind: row.inspectorWorkerId ? ('FLOOR' as const) : ('OFFICE' as const), workerId: row.inspectorWorkerId, userId: row.inspectorUserId },
    /** W2a: who it is assigned to (inside one inspection a worker is named). */
    assigned: assignedView(row, context.names, true),
    /** B-W2b-17: by when it is due (the office sets it while OPEN) and whether it is past it. */
    dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
    overdue: inspectionOverdue(row, context.now ?? new Date()),
    notMakerStatement: row.notMakerStatement,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    signatureSha256: row.signatureSha256,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

/** An inspection's place among its work order's inspections (oldest first). */
export async function seqOf(db: Reader, inspection: Pick<InspectionRow, 'id' | 'workOrderId'>): Promise<number> {
  return (await readWorkOrderInspections(db, inspection.workOrderId)).findIndex((row) => row.id === inspection.id) + 1
}

/** The plan of an inspection on one, with the checklist its results give now (null: W1's fixed checklist). */
export async function plannedOf(db: Reader, row: InspectionRow): Promise<PlannedView | null> {
  if (!row.planVersionId) return null
  const binding = await readBinding(db, row.planVersionId)
  const results = (await resultsOf(db, row.id)).map((result) => resultRow(result, 0))
  const measurements = (await measurementsOf(db, row.id)).map(measurementRow)
  const identity = Array.isArray(row.checklist) ? ((row.checklist as unknown[]).find((entry) => (entry as { code?: unknown } | null)?.code === 'IDENTITY') as ChecklistEntry | undefined) ?? null : null
  return {
    planVersion: { id: binding.version.id, planId: binding.plan.id, code: binding.plan.code, name: binding.plan.name, number: binding.version.number },
    checklist: planChecklist(binding.checks, results, measurements, { inspected: inspectedOf(row.checklist), sampleSize: row.sampleSize, identity }),
  }
}

async function viewOf(db: Reader, row: InspectionRow, number: string) {
  return inspectionView(row, await readDefects(db, [row.id]), { number, seq: await seqOf(db, row), names: await assigneeNames(db, [row]), planned: await plannedOf(db, row) })
}

// ---- open --------------------------------------------------------------------------------------------------------------------------

/**
 * A number of the company's series for a final inspection or a release, inside its command (office or bench: a floor
 * command numbers these kinds of its own site's company), unique in the tenant; a company without the series is told
 * in words (409), not a 404 of the work order.
 */
export async function qualityNumber(tools: CommandTools, kind: 'INSPECTION' | 'RELEASE', companyId: string, record: { readonly type: string; readonly id: string }): Promise<string> {
  try {
    const issued = await allocateNumber(tools, { companyId, kind }, record)
    await assertNumberUniqueInTenant(tools, issued)
    return issued.formatted
  } catch (error) {
    if (error instanceof NotFoundError) throw new InvalidStateError(`${error.message} (${kind === 'INSPECTION' ? 'final inspections' : 'quality releases'} are numbered from it).`)
    throw error
  }
}

export interface OpenBody extends Partial<SamplingPlan> {
  readonly workOrderId: string
  readonly lotSize: number
  readonly note?: string | null | undefined
  /** W2a: the office assigns it at once (never a maker; ./assign.ts). */
  readonly assigneeId?: string | null | undefined
  readonly assigneeWorkerId?: string | null | undefined
  /** B-W2b-17: by when it is due (office only). */
  readonly dueAt?: string | null | undefined
  /** B-W2b-97: the FINAL plan it runs on (its APPROVED version is frozen on it), and why when it is not the one that applies. */
  readonly planId?: string | null | undefined
  readonly planReason?: string | null | undefined
  /** B-W2b-93's chain: a profile other than the one the chain gives, and why. */
  readonly profileId?: string | null | undefined
  readonly profileReason?: string | null | undefined
}

/** The typed sampling fields of W1's body (all of them, or none: the plan or the AQL profile gives the sample). */
const TYPED_FIELDS = ['sampleSize', 'inspectionLevel', 'aqlMajor', 'aqlMinor', 'acceptMajor', 'acceptMinor'] as const

/**
 * The sampling plan an inspection opens with (B-W2b-97, inside the open command): W1's typed plan (every field, no plan or a
 * plan's fixed sample of the same size); a plan version's FIXED sample (its size on the lot, AQL 0, the acceptance numbers
 * typed or 0); else the AQL profile the chain gives (plan version › style of the customer › style › customer › company
 * default) or the one named with its reason, through B-W2b-93's `aqlPlanFor` (THE place sampling is computed).
 */
async function samplingAtOpening(tx: CommandTx, header: LabelHeader, body: OpenBody, version: Binding['version'] | null): Promise<{ plan: SamplingPlan; aqlProfileId: string | null; codeLetter: string | null; profileCode: string | null; source: string; named: boolean }> {
  const given = TYPED_FIELDS.filter((field) => body[field] !== undefined && body[field] !== null)
  const typed = given.length === TYPED_FIELDS.length
  const acceptOnly = given.every((field) => field === 'acceptMajor' || field === 'acceptMinor')
  if (version?.samplingMethod === 'FIXED') {
    if (body.profileId) throw invalid('The plan samples a fixed number of units: no AQL profile applies.', [{ path: 'profileId', message: 'The plan samples a fixed number of units: no AQL profile applies.' }])
    const plan = fixedSampling(version.fixedSampleSize ?? 1, body.lotSize, { acceptMajor: body.acceptMajor, acceptMinor: body.acceptMinor })
    if (!acceptOnly && !(typed && body.sampleSize === plan.sampleSize)) {
      throw invalid("The plan's fixed sample sets the sampling plan: give only the lot (and the acceptance numbers, when any are accepted).", given.filter((field) => field !== 'acceptMajor' && field !== 'acceptMinor').map((field) => ({ path: field, message: `The plan inspects ${plan.sampleSize} unit(s) of the lot: ${field} is not typed.` })))
    }
    return { plan, aqlProfileId: null, codeLetter: null, profileCode: null, source: 'FIXED', named: false }
  }
  if (typed && !version) {
    if (body.profileId) throw invalid('A typed sampling plan names no AQL profile: leave one of the two out.', [{ path: 'profileId', message: 'A typed sampling plan names no AQL profile.' }])
    return { plan: { lotSize: body.lotSize, sampleSize: body.sampleSize!, inspectionLevel: body.inspectionLevel!, aqlMajor: body.aqlMajor!, aqlMinor: body.aqlMinor!, acceptMajor: body.acceptMajor!, acceptMinor: body.acceptMinor! }, aqlProfileId: null, codeLetter: null, profileCode: null, source: 'TYPED', named: false }
  }
  if (given.length > 0) {
    const problems = version
      ? given.map((field) => ({ path: field, message: `The plan takes its sample from the AQL profile: ${field} is not typed (name another profile with the reason instead).` }))
      : TYPED_FIELDS.filter((field) => !given.includes(field)).map((field) => ({ path: field, message: 'Type every field of the sampling plan, or none (the AQL profile then gives it).' }))
    throw invalid(version ? 'The plan takes its sample from the AQL profile.' : 'Type every field of the sampling plan, or none.', problems)
  }
  const answer = await aqlPlanFor(tx, { companyId: header.companyId, planVersionId: version?.id ?? null, styleId: header.styleId, customerIds: await customersOf(tx, header.id), lotSize: body.lotSize, profileId: body.profileId ?? null, at: 'body/profileId' })
  if (!answer.profile || !answer.plan) throw new InvalidStateError('No AQL profile applies (the company has no default and no assignment answers): name a profile with the reason, or type the sampling plan.')
  const reason = answer.named ? aqlReasonProblem(body.profileReason, 'profileReason') : null
  if (reason) {
    const words = `${answer.profile.code} is not the profile the chain gives (${answer.chain.answer.words.replace(/\.$/, '')}): say why${body.profileReason?.trim() ? ` (${reason.message.toLowerCase().replace(/\.$/, '')})` : ''}.`
    throw invalid(words, [{ ...reason, message: words }])
  }
  if (!answer.named && body.profileReason?.trim()) throw invalid('This is the profile the chain gives: no reason is needed.', [{ path: 'profileReason', message: 'This is the profile the chain gives: no reason is needed.' }])
  const accept = acceptanceOf(answer.plan)
  return {
    plan: { lotSize: body.lotSize, sampleSize: answer.plan.sampleSize, inspectionLevel: levelText(answer.plan.level), aqlMajor: aqlStored(answer.plan.classes[1]!.aql), aqlMinor: aqlStored(answer.plan.classes[2]!.aql), acceptMajor: accept.acceptMajor, acceptMinor: accept.acceptMinor },
    aqlProfileId: answer.profile.id,
    codeLetter: answer.plan.codeLetter,
    profileCode: answer.profile.code,
    source: answer.named ? 'NAMED' : answer.chain.answer.source,
    named: answer.named,
  }
}

export async function openInspection(caller: CommandCaller, body: OpenBody, idempotencyKey: string | undefined) {
  const context = inspectorOf(caller)
  const header = await finalWorkOrder(caller, body.workOrderId, QUALITY_INSPECTIONS_RECORD)
  if (context.audience === 'floor') await assertFloorReady(caller, header.siteId)
  const identity = await callerIdentity(caller)
  const assignee: Assignee = { userId: body.assigneeId ?? null, workerId: body.assigneeWorkerId ?? null }
  if (isAssigned(assignee) && context.audience !== 'office') throw new ForbiddenError('The office assigns an inspection to its inspector; the floor does not.')
  const dueAt = body.dueAt ? new Date(body.dueAt) : null
  if (dueAt && context.audience !== 'office') throw new ForbiddenError('The office sets by when an inspection is due; the floor does not.')
  if (!body.planId && body.planReason?.trim()) throw invalid('A reason goes with a plan that is not the one that applies.', [{ path: 'planReason', message: 'No plan is named: no reason is needed.' }])
  const { result } = await command(caller, { name: 'quality.inspection.open', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (isAssigned(assignee) && context.audience === 'office') await assertAssignable(tx, context, assignee, header, now)
    const due = dueProblem(dueAt, now)
    if (due) throw invalid(due.message, [due])
    // B-W2a-F1 hook (quality/holds checks.ts): a work order ON_HOLD, in its hold's words (wave 5's Inspection_awaits_hold).
    const held = await holdOnInspection(tx, tools.context, { workOrderId: header.id })
    if (held) throw new InvalidStateError(held)
    const current = (await tx.workOrder.findUnique({ where: { id: header.id }, select: { status: true } }))?.status ?? header.status
    if (!(RELEASE_STATUSES as readonly string[]).includes(current)) throw new InvalidStateError(`Work order ${header.number} is ${current.toLowerCase()}: its garments are inspected while it is released, in progress or completed.`)
    // B-W2b-97: the plan it runs on (the one that applies, or another with the reason kept), frozen at the opening.
    const named = body.planId ? await namedPlan(tx, header.companyId, body.planId) : null
    let planWords: string | null = null
    if (named) {
      const fit = applicablePlans(await finalPlans(tx, header.companyId), (await workOrderFacts(tx, header)).facts)
      if (fit.suggestedId !== named.plan.id) {
        const reason = reasonProblem(body.planReason, 'planReason')
        const suggested = fit.plans.find((plan) => plan.id === fit.suggestedId)
        if (reason) {
          const words = `${named.plan.code} is not the plan that applies to this work order (${suggested ? `${suggested.code} does` : 'none does'}): say why${body.planReason?.trim() ? ` (${reason.message.toLowerCase().replace(/\.$/, '')})` : ''}.`
          throw invalid(words, [{ ...reason, message: words }])
        }
        planWords = `${named.plan.code} v${named.version.number} named instead of ${suggested ? `${suggested.code} v${suggested.approved?.number}` : 'no plan'}`
      } else if (body.planReason?.trim()) {
        throw invalid('This is the plan that applies: no reason is needed.', [{ path: 'planReason', message: 'This is the plan that applies: no reason is needed.' }])
      } else planWords = `${named.plan.code} v${named.version.number} applies`
    }
    const sampling = await samplingAtOpening(tx, header, body, named?.version ?? null)
    const problems = planProblems(sampling.plan, { pieces: await piecesOf(tx, header.id), finished: await finishedOf(tx, header) })
    if (problems.length > 0) throw invalid('The sampling plan is not valid.', problems)
    const maker = makerCheck(identity, await makersOf(tx, header.id), header.number)
    if (maker.made) throw new MakerRefusedError(maker.words)
    const signer = signerOf(context)
    const id = newId()
    const number = await qualityNumber(tools, 'INSPECTION', header.companyId, { type: 'Inspection', id })
    const plan = sampling.plan
    const row = await tx.inspection.create({
      data: {
        id,
        companyId: header.companyId,
        siteId: header.siteId,
        workOrderId: header.id,
        number,
        lotSize: plan.lotSize,
        sampleSize: plan.sampleSize,
        inspectionLevel: plan.inspectionLevel.trim(),
        aqlMajor: aqlText(plan.aqlMajor),
        aqlMinor: aqlText(plan.aqlMinor),
        acceptMajor: plan.acceptMajor,
        acceptMinor: plan.acceptMinor,
        // B-W2b-97: the plan version (frozen), the profile and code letter its sample came from, the counter at 0.
        planVersionId: named?.version.id ?? null,
        aqlProfileId: sampling.aqlProfileId,
        codeLetter: sampling.codeLetter,
        ...(named ? { checklist: [sampleEntry(0, plan.sampleSize)] as unknown as Prisma.InputJsonValue } : {}),
        inspectorWorkerId: signer.workerId,
        inspectorUserId: signer.userId,
        assignedInspectorId: assignee.userId,
        assignedInspectorWorkerId: assignee.workerId,
        dueAt,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true, version: true },
    })
    const reasons = [named && planWords?.includes('instead') ? body.planReason?.trim() : null, sampling.named ? body.profileReason?.trim() : null].filter((reason): reason is string => Boolean(reason))
    tools.audit({
      recordType: 'Inspection',
      recordId: id,
      companyId: header.companyId,
      siteId: header.siteId,
      after: {
        ...body,
        ...plan,
        number,
        workOrderId: header.id,
        status: 'OPEN',
        inspector: postedBy(context),
        ...(isAssigned(assignee) ? { assigned: assignee } : {}),
        ...(named ? { plan: planWords, planVersionId: named.version.id } : {}),
        sampling: sampling.source,
        ...(sampling.profileCode ? { profileCode: sampling.profileCode, codeLetter: sampling.codeLetter } : {}),
      },
      // The reasons for another plan or another profile than the ones that apply (no column keeps them: B-W2b-76's gap).
      ...(reasons.length ? { reason: reasons.join(' · ') } : {}),
    })
    tools.emit({ type: 'quality.inspection_opened', subject: id, companyId: header.companyId, siteId: header.siteId, payload: { inspectionId: id, inspectionNumber: number, workOrderId: header.id, number: header.number, lotSize: body.lotSize, postedBy: postedBy(context) } })
    return { id: row.id }
  })
  return caller.withClient(async (db) => ({ inspection: await viewOf(db, (await readInspection(db, result.id))!, header.number) }))
}

// ---- record ------------------------------------------------------------------------------------------------------------------------

export interface UpdateBody extends Partial<SamplingPlan> {
  readonly version: number
  readonly checklist?: readonly ChecklistAnswer[] | undefined
  readonly note?: string | null | undefined
  readonly notMakerStatement?: boolean | undefined
}

export async function updateInspection(caller: CommandCaller, inspectionId: string, body: UpdateBody, idempotencyKey: string | undefined) {
  const context = inspectorOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_RECORD)
  assertOwnInspection(context, inspection)
  const { result } = await command(caller, { name: 'quality.inspection.record', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const before = await lockInspection(tx, inspection.id, body.version)
    const was = planOf(before)
    // B-W2b-97 (B-W2b-93's gap): a sample taken from an AQL profile or a plan's fixed sample is never retyped by hand (the
    // profile is changed, with a reason, before counting starts: POST /quality/aql/inspections/:id/profile); an inspection on
    // a plan records each check's result, not W1's checklist.
    const moved = samplingChanges(was, body)
    if (moved.length > 0 && (before.aqlProfileId || before.planVersionId)) {
      const source = before.aqlProfileId ? `AQL profile${before.codeLetter ? ` (code letter ${before.codeLetter})` : ''}` : "plan's fixed sample"
      throw new SamplingRefusedError(
        before.aqlProfileId ? 'PROFILE_BOUND' : 'PLAN_BOUND',
        `The sampling plan comes from the ${source}: it is not typed by hand. ${before.aqlProfileId ? 'Change the profile, with the reason, before counting starts (Sample & AQL › Change profile).' : 'Cancel the inspection and open another for another lot.'}`,
        moved,
      )
    }
    if (body.checklist && before.planVersionId) throw new SamplingRefusedError('PLAN_CHECKS', "This inspection runs on its plan: record each check's result (PUT …/results), not W1's checklist.", ['checklist'])
    const plan: SamplingPlan = {
      lotSize: body.lotSize ?? was.lotSize,
      sampleSize: body.sampleSize ?? was.sampleSize,
      inspectionLevel: body.inspectionLevel ?? was.inspectionLevel,
      aqlMajor: body.aqlMajor ?? was.aqlMajor,
      aqlMinor: body.aqlMinor ?? was.aqlMinor,
      acceptMajor: body.acceptMajor ?? was.acceptMajor,
      acceptMinor: body.acceptMinor ?? was.acceptMinor,
    }
    const counts = defectCounts(await readDefects(tx, [before.id]))
    const most = Math.max(counts.critical, counts.major, counts.minor)
    const problems = [
      ...planProblems(plan, { pieces: await piecesOf(tx, header.id), finished: await finishedOf(tx, header) }),
      ...(body.checklist ? checklistProblems(body.checklist, { forDecision: false }) : []),
      ...(most > plan.sampleSize ? [{ path: 'sampleSize', message: `The defects recorded name ${most} garments of one class: the sample is at least that.` }] : []),
    ]
    if (problems.length > 0) throw invalid('The inspection is not valid.', problems)
    const data: Prisma.InspectionUpdateInput = {
      lotSize: plan.lotSize,
      sampleSize: plan.sampleSize,
      inspectionLevel: plan.inspectionLevel.trim(),
      aqlMajor: aqlText(plan.aqlMajor),
      aqlMinor: aqlText(plan.aqlMinor),
      acceptMajor: plan.acceptMajor,
      acceptMinor: plan.acceptMinor,
      ...(body.checklist ? { checklist: checklistOf(body.checklist) } : {}),
      ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
      ...(body.notMakerStatement !== undefined ? { notMakerStatement: body.notMakerStatement } : {}),
      ...takeOver(context, before),
      version: { increment: 1 },
      updatedAt: now,
    }
    await tx.inspection.update({ where: { id: before.id }, data, select: { id: true } })
    tools.audit({ recordType: 'Inspection', recordId: before.id, companyId: header.companyId, siteId: header.siteId, before: { ...was, checklist: before.checklist, note: before.note }, after: { ...plan, checklist: body.checklist ?? before.checklist, note: body.note ?? before.note } })
    return { id: before.id }
  })
  return caller.withClient(async (db) => ({ inspection: await viewOf(db, (await readInspection(db, result.id))!, header.number) }))
}

export interface DefectsBody {
  readonly version: number
  /** B-W2b-127: a line may name its cause code (undefined: the stored cause stays). */
  readonly defects: readonly (DefectLine & { readonly causeCodeId?: string | null | undefined })[]
}

/**
 * B-W2b-127 (design ins-defects "cause code"): a cause a line names is a code of the group's list, active unless the line
 * named it already (a retired code stays where it is; the database's own trigger refuses it on a new line too).
 */
async function causeProblems(tx: CommandTx, lines: DefectsBody['defects'], existing: readonly DefectRow[]): Promise<Issue[]> {
  const ids = [...new Set(lines.map((line) => line.causeCodeId).filter((id): id is string => typeof id === 'string'))]
  if (ids.length === 0) return []
  const causes = new Map((await tx.causeCode.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, active: true } })).map((row) => [row.id, row]))
  const problems: Issue[] = []
  lines.forEach((line, index) => {
    if (!line.causeCodeId) return
    const found = causes.get(line.causeCodeId)
    const at = `defects/${index}/causeCodeId`
    if (!found) problems.push({ path: at, message: 'Not a cause code of the list.' })
    else if (!found.active && !existing.some((row) => row.defectClass === line.defectClass && row.code === line.code && row.causeCodeId === line.causeCodeId)) problems.push({ path: at, message: `${found.code} is retired: it is no longer picked.` })
  })
  return problems
}

/**
 * W2a (B-W2a-67; QHS-001): a line picked from the library names an ACTIVE defect (not a category) and carries its code
 * (the …_quality_plant_w2a_guards defect library guard holds the same).
 */
async function libraryProblems(tx: CommandTx, lines: readonly DefectLine[], existing: readonly DefectRow[]): Promise<Issue[]> {
  const ids = [...new Set(lines.map((line) => line.defectCodeId).filter((id): id is string => typeof id === 'string'))]
  if (ids.length === 0) return []
  const library = new Map((await tx.defectCode.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, parentId: true, active: true, severity: true } })).map((row) => [row.id, row]))
  const problems: Issue[] = []
  lines.forEach((line, index) => {
    if (!line.defectCodeId) return
    const found = library.get(line.defectCodeId)
    const at = `defects/${index}/defectCodeId`
    if (!found) problems.push({ path: at, message: 'Not a defect of the library.' })
    else if (found.parentId === null) problems.push({ path: at, message: `${found.code} is a category: pick one of its defects.` })
    else if (found.code !== line.code) problems.push({ path: `defects/${index}/code`, message: `The library names this defect ${found.code}.` })
    // A retired defect stays on the lines that already name it (only a new pick is refused).
    else if (!found.active && !existing.some((row) => row.defectClass === line.defectClass && row.code === line.code && row.defectCodeId === line.defectCodeId)) problems.push({ path: at, message: `${found.code} is retired: it is no longer picked.` })
    // B-W2b-97 (B-W2b-90's SAFETY rule, Reg. (EU) 2016/425): a defect the library classes CRITICAL is recorded critical, never
    // milder, so it always fails the lot (critical's acceptance number is 0).
    if (found) {
      const downgrade = recordedClassProblem((found.severity as LibraryClass | null) ?? null, line.defectClass, found.code)
      if (downgrade) problems.push({ path: `defects/${index}/defectClass`, message: downgrade })
    }
  })
  return problems
}

export async function putDefects(caller: CommandCaller, inspectionId: string, body: DefectsBody, idempotencyKey: string | undefined) {
  const context = inspectorOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_RECORD)
  assertOwnInspection(context, inspection)
  const { result } = await command(caller, { name: 'quality.inspection.defects', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockInspection(tx, inspection.id, body.version)
    const cells = await readCells(tx, header.id)
    const existing = await readDefects(tx, [current.id])
    const problems = [...defectProblems(body.defects, { sampleSize: current.sampleSize, cellIds: new Set(cells.map((cell) => cell.id)) }), ...(await libraryProblems(tx, body.defects, existing)), ...(await causeProblems(tx, body.defects, existing))]
    if (problems.length > 0) throw invalid('The defects are not valid.', problems)
    const key = (line: Pick<DefectLine, 'defectClass' | 'code'>) => `${line.defectClass}|${line.code}`
    const wanted = new Map(body.defects.map((line) => [key(line), line]))
    for (const row of existing) if (!wanted.has(key(row))) await tx.inspectionDefect.delete({ where: { id: row.id }, select: { id: true } })
    for (const line of body.defects) {
      const row = existing.find((entry) => key(entry) === key(line))
      // B-W2b-127: a line without `causeCodeId` keeps its stored cause (the bench sends none).
      const causeCodeId = line.causeCodeId === undefined ? (row?.causeCodeId ?? null) : line.causeCodeId
      const data = { quantity: line.quantity, workOrderSizeId: line.workOrderSizeId ?? null, description: line.description?.trim() || null, note: line.note?.trim() || null, defectCodeId: line.defectCodeId ?? null, zone: line.zone?.trim() || null, causeCodeId }
      if (row) await tx.inspectionDefect.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      else
        await tx.inspectionDefect.create({
          data: { id: newId(), siteId: current.siteId, workOrderId: current.workOrderId, inspectionId: current.id, defectClass: line.defectClass, code: line.code, ...data, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true },
        })
    }
    await tx.inspection.update({ where: { id: current.id }, data: { ...takeOver(context, current), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'Inspection', recordId: current.id, companyId: header.companyId, siteId: header.siteId, before: { defects: existing.map(defectView) }, after: { defects: body.defects } })
    return { id: current.id }
  })
  return caller.withClient(async (db) => ({ inspection: await viewOf(db, (await readInspection(db, result.id))!, header.number) }))
}

// ---- decide ---------------------------------------------------------------------------------------------------------------------------

export interface DecideBody {
  readonly version: number
  readonly result: InspectionResult
  /** W1's checklist; an inspection on a plan sends none (its results are the answers). */
  readonly checklist?: readonly ChecklistAnswer[] | undefined
  readonly notMakerStatement?: boolean | undefined
  readonly overrideReason?: string | null | undefined
  readonly note?: string | null | undefined
}

/** The e-signature: SHA-256 of what was signed, by whom, when (QHS-058). */
export const signatureOf = (what: unknown): string => createHash('sha256').update(JSON.stringify(what)).digest('hex')

/**
 * B-W2b-97: what the checks of an inspection on a plan say at its decision. The checklist W1's database rule computes from,
 * written from the results by check code (a failed check: ok false, so the lot FAILS; the serial or batch check's entry
 * with its own ok), the plan's holds on the signature (planDecisionProblems), and what is signed (the digest). Photos are
 * counted by the caller beforehand (a bench reads only its floor files: the tenant's system view counts every photo).
 */
async function planDecision(db: Reader, row: InspectionRow, header: LabelHeader, binding: Binding, decision: InspectionResult, photos: ReadonlyMap<string, number>, tenantId: string) {
  const results = (await resultsOf(db, row.id)).map((result) => resultRow(result, photos.get(result.id) ?? 0))
  const measurements = (await measurementsOf(db, row.id)).map(measurementRow)
  const identity = await identityFacts(db, header, row)
  const identityRecord = identity.scans.length > 0 ? identityEntry(identity.mode, identity.scans, identity.summary) : null
  const inspected = inspectedOf(row.checklist)
  const checklist = planChecklist(binding.checks, results, measurements, { inspected, sampleSize: row.sampleSize, identity: identityRecord })
  const checks = checksState(binding.checks, results, measurements)
  const counts = defectCounts(await readDefects(db, [row.id]))
  const stop = await stopRule(db, tenantId, row.companyId, binding.version.stopAtReject)
  const rejected = sampleRejected({ counts, acceptMajor: row.acceptMajor, acceptMinor: row.acceptMinor, failedCritical: checks.failedCritical.length })
  const problems = planDecisionProblems({ decision, checks, identity: identity.summary, photos: photoSet(binding.checks, results), inspected, sampleSize: row.sampleSize, stop, rejected })
  const digest = {
    planVersionId: binding.version.id,
    results: results.map((result) => ({ check: binding.checks.find((check) => check.id === result.planCheckId)?.code, sampleIndex: result.sampleIndex, outcome: result.outcome, value: result.value, photos: result.photos })),
    measurements: measurements.map((value) => ({ point: value.pointCode, size: value.size, sampleIndex: value.sampleIndex, measured: value.measured, nominal: value.nominal, tolerance: value.tolerance, uom: value.uom, pass: value.pass })),
    identity: identity.summary.words,
    inspected,
    stop: stop.stop,
  }
  return { checklist, problems, digest, inspected }
}

export async function decideInspection(caller: CommandCaller, inspectionId: string, body: DecideBody, options: { readonly sign: () => void | Promise<void>; readonly idempotencyKey?: string | undefined }) {
  const context = inspectorOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_RECORD)
  assertOwnInspection(context, inspection)
  assertOpen(inspection)
  if (context.audience === 'floor') await assertFloorReady(caller, header.siteId)
  const asked = body.checklist ?? []
  // B-W2b-97: on a plan, the results are the checks' answers (W1's checklist is written from them).
  const binding = inspection.planVersionId ? await caller.withClient((db) => bindingOf(db, inspection)) : null
  if (binding && asked.length > 0) throw new SamplingRefusedError('PLAN_CHECKS', "This inspection runs on its plan: its results are the checks' answers; send no checklist.", ['checklist'])
  const photoCounts = binding
    ? await factsReader(caller).withClient(async (client) => new Map([...(await photosOf(client, (await resultsOf(client, inspection.id)).map((result) => result.id))).entries()].map(([id, files]) => [id, files.filter((file) => file.status === 'AVAILABLE').length])))
    : new Map<string, number>()
  if (!binding) {
    const checklistIssues = checklistProblems(asked, { forDecision: true })
    if (checklistIssues.length > 0) throw invalid('Answer the checklist before signing.', checklistIssues)
  }
  const planned = binding ? await caller.withClient((db) => planDecision(db, inspection, header, binding, body.result, photoCounts, context.tenantId)) : null
  const defects = await caller.withClient((db) => readDefects(db, [inspection.id]))
  const computed = computedResult({ counts: defectCounts(defects), plan: planOf(inspection), checklist: planned ? planned.checklist : asked })
  const decisionIssues = [...decisionProblems(body.result, computed, body.overrideReason), ...(planned?.problems ?? [])]
  if (decisionIssues.length > 0) throw invalid(decisionIssues.length === 1 ? decisionIssues[0]!.message : 'The decision is not valid.', decisionIssues)
  const identity = await callerIdentity(caller)
  await options.sign()
  const { result } = await command(caller, { name: 'quality.inspection.decide', idempotencyKey: options.idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockInspection(tx, inspection.id, body.version)
    const counts = defectCounts(await readDefects(tx, [current.id]))
    const plannedNow = binding ? await planDecision(tx, current, header, binding, body.result, photoCounts, context.tenantId) : null
    const again = computedResult({ counts, plan: planOf(current), checklist: plannedNow ? plannedNow.checklist : asked })
    const problems = [...decisionProblems(body.result, again, body.overrideReason), ...(plannedNow?.problems ?? [])]
    if (problems.length > 0) throw new ConflictError(`The inspection changed while you signed: ${problems.map((problem) => problem.message).join(' ')}`)
    const makers = await makersOf(tx, current.workOrderId)
    const maker = makerCheck(identity, makers, header.number)
    if (maker.made) throw new MakerRefusedError(maker.words)
    const statement = body.notMakerStatement ?? current.notMakerStatement
    if (makers.unnamed && !statement) {
      throw new MakerRefusedError("This site records the station, not the worker, so the floor's records cannot tell who made the garments: sign the statement 'I did not make these garments' (notMakerStatement).")
    }
    const checklist = plannedNow ? plannedNow.checklist.map((entry) => ({ ...entry })) : checklistOf(asked)
    const overrideReason = isOverride(body.result, again) ? body.overrideReason!.trim() : null
    const status = body.result === 'PASS' ? 'PASSED' : 'FAILED'
    const signature = signatureOf({ inspectionId: current.id, workOrderId: current.workOrderId, status, computed: again.result, counts, plan: planOf(current), checklist, overrideReason, notMakerStatement: statement, signer: signerOf(context), at: toUtcIso(now), ...(plannedNow ? { onPlan: plannedNow.digest } : {}) })
    const decided = await tx.inspection.update({
      where: { id: current.id },
      data: { status, checklist: checklist as unknown as Prisma.InputJsonValue, decidedAt: now, signatureSha256: signature, overrideReason, notMakerStatement: statement, ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}), ...takeOver(context, current), version: { increment: 1 }, updatedAt: now },
      select: { computedResult: true },
    })
    if (decided.computedResult !== again.result) throw new ConflictError('The computed result differs from the rules: reload the inspection.')
    tools.audit({
      recordType: 'Inspection',
      recordId: current.id,
      companyId: header.companyId,
      siteId: header.siteId,
      before: { status: 'OPEN' },
      after: { status, computedResult: again.result, counts, checklist, overrideReason, notMakerStatement: statement, signatureSha256: signature, signedBy: postedBy(context), ...(plannedNow ? { planVersionId: plannedNow.digest.planVersionId, inspected: plannedNow.inspected, identity: plannedNow.digest.identity } : {}) },
      ...(overrideReason ? { reason: overrideReason } : {}),
    })
    tools.emit({
      type: 'quality.inspection_decided',
      subject: current.id,
      companyId: header.companyId,
      siteId: header.siteId,
      payload: { inspectionId: current.id, workOrderId: header.id, number: header.number, status, computedResult: again.result, overridden: overrideReason !== null, postedBy: postedBy(context) },
    })
    return { id: current.id }
  })
  return caller.withClient(async (db) => ({ inspection: await viewOf(db, (await readInspection(db, result.id))!, header.number) }))
}

export async function cancelInspection(caller: CommandCaller, inspectionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string | undefined) {
  const context = inspectorOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId, QUALITY_INSPECTIONS_RECORD)
  assertOwnInspection(context, inspection)
  const problem = reasonProblem(body.reason)
  if (problem) throw invalid('Say why the inspection is cancelled.', [problem])
  const { result } = await command(caller, { name: 'quality.inspection.cancel', idempotencyKey, input: body }, async (tools) => {
    const current = await lockInspection(tools.tx, inspection.id, body.version)
    await tools.tx.inspection.update({ where: { id: current.id }, data: { status: 'CANCELLED', ...takeOver(context, current), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'Inspection', recordId: current.id, companyId: header.companyId, siteId: header.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason: body.reason.trim() })
    tools.emit({ type: 'quality.inspection_cancelled', subject: current.id, companyId: header.companyId, siteId: header.siteId, payload: { inspectionId: current.id, workOrderId: header.id, number: header.number } })
    return { id: current.id }
  })
  return caller.withClient(async (db) => ({ inspection: await viewOf(db, (await readInspection(db, result.id))!, header.number) }))
}

// ---- read -------------------------------------------------------------------------------------------------------------------------

export async function getInspection(caller: CommandCaller, inspectionId: string) {
  const context = inspectorOf(caller)
  const { inspection, header } = await inspectionFor(caller, inspectionId)
  const identity = await callerIdentity(caller)
  return caller.withClient(async (db) => {
    const makers = await makersOf(db, header.id)
    return {
      inspection: await viewOf(db, inspection, header.number),
      workOrder: { id: header.id, number: header.number, status: header.status, batchNumber: header.batchNumber },
      /** The viewer's maker check (design ins-side "You are not among them"). */
      maker: makerCheck(identity, makers, header.number),
      /** Where the floor's records name only the station, the signer ticks the statement. */
      statementNeeded: makers.unnamed,
      /** The viewer is its inspector: they record and sign it. */
      yours: isOwn(context, inspection),
    }
  })
}
