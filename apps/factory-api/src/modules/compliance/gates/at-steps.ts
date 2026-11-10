import { isCertificateCoverage, notApplying, type ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import type { Reader } from '../register-of-rules/common'
import { gateRequirements } from '../requirements/store'
import { readGateStyle } from './facts'
import { attachRefusals, decideGate, GateRefusedError, pendingOf, refusalError, shipmentTargets, workOrderTargets, type GateAnswer, type PendingRefusal } from './gate'

/**
 * Where W1's steps call the one gate (B-W2b-254; PRD-272: work-order release, label print, final release, shipment). Each
 * step keeps its own checks and words (W1's certificate check IS the CERT-COVERAGE requirement's check, so its refusal
 * stays W1's sentence and is recorded as that requirement's GateEvent); the gate adds every other requirement that blocks
 * the place, in the GateExplainer's words. The hooks in the steps' files are marked B-W2b-254.
 */

/** The work order as the gate reads it. */
export interface GatedWorkOrder {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly siteId: string
  readonly styleId: string
  /** The frozen label template of a released work order (null: the style's released revision's). */
  readonly labelTemplateId: string | null
}

/** The gate's answer for a work order at a place (its cells, or the ones named), with this reader. */
export async function workOrderGate(db: Reader, gate: ComplianceGate, workOrder: GatedWorkOrder, now: Date, cellIds?: readonly string[]): Promise<GateAnswer> {
  const targets = await workOrderTargets(db, workOrder.id, cellIds)
  return decideGate(db, {
    gate,
    subjectType: 'WorkOrder',
    subjectId: workOrder.id,
    subjectWords: `Work order ${workOrder.number}`,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    styleId: workOrder.styleId,
    labelTemplateId: workOrder.labelTemplateId,
    targets,
    day: businessDate(now),
    now,
  })
}

/** Reads with the caller's client in the office, the tenant's system client on the floor (the floor role reads less). */
export async function readAsGate<T>(caller: CommandCaller, work: (db: Reader) => Promise<T>): Promise<T> {
  const context = caller.factoryContext
  if (context && context.audience === 'floor') {
    const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
    view.factoryContext = systemContext(context.tenantId, context.requestId)
    return view.withClient((client) => work(client))
  }
  return caller.withClient((client) => work(client))
}

const actorOf = (caller: Pick<CommandCaller, 'factoryContext'>): string | null => {
  const context = caller.factoryContext
  return context && (context.audience === 'office' || context.audience === 'floor') ? context.actorId : null
}

/** The CERT-COVERAGE line of a target that blocks the place: W1's certificate refusal recorded as that requirement's. */
function certificatePending(answer: GateAnswer, targetKey: string, words: string, createdById: string | null): PendingRefusal | null {
  const line = answer.decision.lines.find((entry) => entry.target.key === targetKey && entry.blocks && isCertificateCoverage(entry.requirement))
  return line ? pendingOf(answer, { line, words }, createdById, words) : null
}

// ---- work-order release (office, inside the release's transaction) -----------------------------------------------------

/**
 * The release's gate (MES-004 as a requirement): after W1's checklist. W1 refused → its error carries the gate's refusal
 * (W1's words stay the answer); W1 passed and the gate refuses → the gate's 409 in words. Returns the answer when it passes.
 */
export async function releaseGate(tools: CommandTools, workOrder: GatedWorkOrder, w1Refusal: Error | null): Promise<GateAnswer> {
  const answer = await workOrderGate(tools.tx, 'WORK_ORDER_RELEASE', workOrder, tools.now)
  const createdById = actorOf({ factoryContext: tools.context })
  if (w1Refusal) throw attachRefusals(w1Refusal, answer.decision.refusal ? [pendingOf(answer, answer.decision.refusal, createdById)] : [])
  const refused = refusalError(answer, createdById)
  if (refused) throw refused
  return answer
}

/**
 * W1's CERTIFICATE check at the release honours the requirement (B-W2b-254): when no applying certificate-coverage
 * requirement blocks the work-order release (the company's choice — the law locks only the label, the final release and
 * the shipment), the check is not required. True: it blocks (W1's behaviour, also while the tenant has no row yet).
 */
export async function certificateBlocksRelease(db: Reader, styleId: string, day: BusinessDate): Promise<boolean> {
  const style = await readGateStyle(db, styleId)
  if (!style) return true
  const certificate = (await gateRequirements(db)).filter((requirement) => isCertificateCoverage(requirement) && notApplying(requirement, style.subject, null, day) === null)
  // No applying certificate requirement at all (switched off or archived — never a locked one): W1's rule stays.
  if (certificate.length === 0) return true
  return certificate.some((requirement) => requirement.blocks.includes('WORK_ORDER_RELEASE'))
}

/** W1's CERTIFICATE check's words when the company lifted the release block. */
export const RELEASE_NOT_GATED = 'Certificate coverage does not block the work-order release here (Rules & markets › Gates); the label, the final release and the shipment still need it.'

// ---- label print (the floor; decided before the step with the system client) -------------------------------------------

export interface LabelGate {
  /** The gate's refusal of a cell (W1's LabelRefusal shape: LABEL_NOT_PRINTABLE with the gate's words), or null. */
  refusalFor(cellId: string): { readonly code: 'LABEL_NOT_PRINTABLE'; readonly message: string; readonly fix: string; readonly cellId: string } | null
  /** The GateEvents of the refused cells: W1's certificate refusals as CERT-COVERAGE, the gate's own as theirs. */
  pendingFor(refusals: readonly { readonly code: string; readonly message: string; readonly cellId: string | null }[]): PendingRefusal[]
}

export async function labelPrintGate(caller: CommandCaller, workOrder: GatedWorkOrder, cellIds?: readonly string[]): Promise<LabelGate> {
  const now = new Date()
  const answer = await readAsGate(caller, (db) => workOrderGate(db, 'LABEL_PRINT', workOrder, now, cellIds))
  const createdById = actorOf(caller)
  const mine = new Map(answer.decision.refusedTargets.filter((refusal) => !isCertificateCoverage(refusal.line.requirement)).map((refusal) => [refusal.line.target.key, refusal]))
  return {
    refusalFor(cellId) {
      const refusal = mine.get(cellId)
      return refusal ? { code: 'LABEL_NOT_PRINTABLE', message: refusal.words, fix: refusal.line.fix ? `Tell the office: ${refusal.line.fix}` : 'Tell the office.', cellId } : null
    },
    pendingFor(refusals) {
      return refusals.flatMap((refusal) => {
        if (!refusal.cellId) return []
        if (refusal.code === 'CERTIFICATE') return [certificatePending(answer, refusal.cellId, refusal.message, createdById)].filter((entry): entry is PendingRefusal => entry !== null)
        const own = mine.get(refusal.cellId)
        return own && refusal.message === own.words ? [pendingOf(answer, own, createdById)] : []
      })
    },
  }
}

// ---- final release (office or the floor inspector; decided before the step with the right client) ----------------------

/**
 * The final release's gate (QHS-051 as a requirement) for one cell: W1's checks refused (`w1Refused`, with the
 * certificate's words when that was the reason) → the CERT-COVERAGE refusal to record; else the gate's own refusal. The
 * caller throws (and `withGateRecords` writes the refusals).
 */
export async function finalReleaseGate(caller: CommandCaller, workOrder: GatedWorkOrder, cellId: string, w1: { readonly certificateRefusal: string | null }): Promise<{ readonly refusal: GateRefusedError | null; readonly pending: PendingRefusal[] }> {
  const now = new Date()
  const answer = await readAsGate(caller, (db) => workOrderGate(db, 'FINAL_RELEASE', workOrder, now, [cellId]))
  const createdById = actorOf(caller)
  if (w1.certificateRefusal) {
    const pending = certificatePending(answer, cellId, w1.certificateRefusal, createdById)
    return { refusal: null, pending: pending ? [pending] : [] }
  }
  const own = answer.decision.refusedTargets.find((refusal) => !isCertificateCoverage(refusal.line.requirement)) ?? null
  if (!own) return { refusal: null, pending: [] }
  const error = new GateRefusedError(own.words, [{ path: `gate/${own.line.requirement.code}`, message: own.words }], [pendingOf(answer, own, createdById)])
  return { refusal: error, pending: [] }
}

// ---- shipment (office, inside the ship command) ------------------------------------------------------------------------

/**
 * The shipment's gate (PRD-272): every style on it, for the shipment's destination, on the ship day — certificate
 * coverage (locked by the law), the operator, and every other requirement that blocks the shipment. The first refusal
 * (by style, then the gate's order) is the 409.
 */
export async function shipmentGate(tools: CommandTools, shipmentId: string): Promise<GateAnswer[]> {
  const facts = await shipmentTargets(tools.tx, shipmentId)
  if (!facts) return []
  const createdById = actorOf({ factoryContext: tools.context })
  const answers: GateAnswer[] = []
  for (const [styleId, targets] of facts.styles) {
    const answer = await decideGate(tools.tx, {
      gate: 'SHIPMENT',
      subjectType: 'Shipment',
      subjectId: shipmentId,
      subjectWords: `Shipment ${facts.number}`,
      companyId: facts.companyId,
      siteId: facts.siteId,
      styleId,
      targets,
      day: businessDate(tools.now),
      now: tools.now,
    })
    const refused = refusalError(answer, createdById)
    if (refused) throw refused
    answers.push(answer)
  }
  return answers
}

export type { BusinessDate }
