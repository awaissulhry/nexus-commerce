import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  componentDecision,
  componentsAsked,
  garmentsGoingOn,
  guardFindings,
  heldBy,
  kindsOf,
  overrideReasonText,
  type GuardFinding,
  type TracedComponent,
} from '@nexus/factory-domain/production/guards/rules'
import type { Counts, ScanFact, ScanOperation } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { refuse } from '../scans/access'
import type { VerifiedOverride } from './override'
import { componentFacts, FLAGGED_ACTION, guardSettingsFor, lineFacts, OVERRIDDEN_ACTION, scannedLots, TRACED_ACTION } from './store'

/**
 * The checks of one floor report, INSIDE its command (B-W2b-46), after W1's operation, kind, "already reported" and
 * bundle-size checks and under the scans' locks (the work order's scan lock, the bundle FOR SHARE, the bundle's scan
 * lock): the site's rules (quantity, skipped operation), the line (wrong bundle), then the lots scanned at the
 * operation. A STRICT finding holds the report unless a verified team leader's override came with it; a refusal of the
 * components is never overridden. After the scan row is written, recordGuards keeps what was found (the audit log on
 * the scan and its work order) and tells the team leaders (events).
 */

export interface ComponentInput {
  /** The lot's label (Lot.code). */
  readonly code: string
  /** How many of the garments that go on carry a component of this lot. */
  readonly garments: number
}

export interface GuardWork {
  readonly workOrder: { readonly id: string; readonly number: string; readonly siteId: string; readonly styleId: string }
  readonly bundle: { readonly id: string; readonly code: string; readonly workOrderSizeId: string }
  /** The bundle's live garments (bundles/flow). */
  readonly quantity: number
  readonly operations: readonly ScanOperation[]
  readonly operation: ScanOperation
  /** The flow's standing scans. */
  readonly standing: ReadonlyMap<string, ScanFact>
  readonly counts: Counts
  readonly stationId: string | null
  readonly components?: readonly ComponentInput[] | undefined
  readonly override?: VerifiedOverride | undefined
}

export interface GuardOutcome {
  /** What reached the operation (the report's record keeps it as its cap). */
  readonly cap: number
  /** WARN findings: the report counts, the team leaders are told. */
  readonly flagged: readonly GuardFinding[]
  /** STRICT findings a team leader overrode, and the override (null: nothing was held). */
  readonly overridden: readonly GuardFinding[]
  readonly override: VerifiedOverride | null
  /** The lots traced for the garments that go on (MES-114). */
  readonly traced: readonly TracedComponent[]
  readonly garments: number
}

export async function guardReport(tx: CommandTx, work: GuardWork): Promise<GuardOutcome> {
  const settings = await guardSettingsFor(tx, work.workOrder.siteId)
  const lines = await lineFacts(tx, { stationId: work.stationId, workOrderId: work.workOrder.id, kind: work.operation.workCentreKind })
  const result = guardFindings({
    operations: work.operations,
    operation: work.operation,
    bundleId: work.bundle.id,
    bundle: { code: work.bundle.code, quantity: work.quantity },
    workOrder: work.workOrder,
    standing: work.standing,
    counts: work.counts,
    settings,
    lines,
  })
  const held = heldBy(result.findings)
  if (held && !work.override) refuse(held)
  if (held && work.override) {
    // The team leader signed outside the command: still an active worker of the site now.
    const lead = await tx.worker.findUnique({ where: { id: work.override.leadWorkerId }, select: { status: true, siteId: true } })
    if (!lead || lead.status !== 'ACTIVE' || lead.siteId !== work.workOrder.siteId) refuse({ code: 'OVERRIDE_NOT_LEAD', message: 'This person may not override floor checks.', fix: 'Ask a team leader of this site to sign.', final: true })
  }

  const garments = garmentsGoingOn(work.counts)
  const facts = await componentFacts(tx, { styleId: work.workOrder.styleId, workOrderId: work.workOrder.id, workOrderSizeId: work.bundle.workOrderSizeId })
  const asked = componentsAsked({ operations: work.operations, operation: work.operation, garmentTracking: facts.garmentTracking, materials: facts.materials })
  const scanned = work.components && work.components.length > 0 ? await scannedLots(tx, work.workOrder.siteId, work.components) : []
  const traced = componentDecision({ asked, materials: facts.materials, scanned, garments, operation: work.operation })
  if (!traced.ok) refuse(traced.refusal)

  return {
    cap: result.cap,
    flagged: result.findings.filter((finding) => finding.mode === 'WARN'),
    overridden: held ? result.findings.filter((finding) => finding.mode === 'STRICT') : [],
    override: held ? work.override! : null,
    traced: traced.ok ? traced.lines : [],
    garments,
  }
}

const findingRecord = (finding: GuardFinding) => ({ kind: finding.kind, mode: finding.mode, code: finding.refusal.code, message: finding.refusal.message, detail: finding.detail })

export interface RecordedScan {
  readonly id: string
  readonly stationId: string | null
  readonly serverTime: Date
}

/** Keeps what the checks found on the scan (and the lots on its work order too) and tells the team leaders. */
export function recordGuards(tools: CommandTools, outcome: GuardOutcome, input: { readonly scan: RecordedScan; readonly workOrder: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string }; readonly bundleId: string; readonly operation: ScanOperation }): void {
  const { scan, workOrder, operation } = input
  const where = { workOrderId: workOrder.id, bundleId: input.bundleId, scanId: scan.id, operationId: operation.id, operationSeq: operation.seq, stationId: scan.stationId }
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  if (outcome.flagged.length > 0) {
    tools.audit({ action: FLAGGED_ACTION, recordType: 'OperationScan', recordId: scan.id, ...scope, after: { ...where, number: workOrder.number, cap: outcome.cap, guards: outcome.flagged.map(findingRecord) } })
    tools.emit({ type: 'production.scan_guard_flagged', subject: workOrder.id, ...scope, payload: { ...where, number: workOrder.number, guards: kindsOf(outcome.flagged) } })
  }
  if (outcome.override) {
    const reason = overrideReasonText(outcome.override.reasonCode, outcome.override.note)
    tools.audit({
      action: OVERRIDDEN_ACTION,
      recordType: 'OperationScan',
      recordId: scan.id,
      ...scope,
      reason,
      after: { ...where, number: workOrder.number, cap: outcome.cap, guards: outcome.overridden.map(findingRecord), leadWorkerId: outcome.override.leadWorkerId, reasonCode: outcome.override.reasonCode, note: outcome.override.note },
    })
    tools.emit({ type: 'production.scan_guard_overridden', subject: workOrder.id, ...scope, payload: { ...where, number: workOrder.number, guards: kindsOf(outcome.overridden), reasonCode: outcome.override.reasonCode } })
  }
  if (outcome.traced.length > 0) {
    const after = { ...where, garments: outcome.garments, at: toUtcIso(scan.serverTime), components: outcome.traced.map((line) => ({ ...line })), lotIds: [...new Set(outcome.traced.map((line) => line.lotId))] }
    tools.audit({ action: TRACED_ACTION, recordType: 'OperationScan', recordId: scan.id, ...scope, after })
    tools.audit({ action: TRACED_ACTION, recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after })
  }
}
