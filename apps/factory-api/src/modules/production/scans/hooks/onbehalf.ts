import type { OnBehalfReasonCode } from '@nexus/factory-domain/production/onbehalf/rules'
import type { CommandTools } from '../../../../core/command'

/**
 * B-W2b-47 hook of the scans' report (modules/production/onbehalf; MES-099): what scans.ts calls, each in a named line.
 * A report that carries `onBehalf` names that person (or, where the site records stations, that station) instead of the
 * signed-in team leader, who stays who entered it (createdById; the audit row's actor); its `reason` carries the mark. All
 * the report's rules run as for any report; only the running off-standard block is left alone (the entry says what was
 * done, not what the person does now).
 */

export interface OnBehalf {
  /** The person the report names; null where the site records the station. */
  readonly workerId: string | null
  readonly stationId: string
  readonly reasonCode: OnBehalfReasonCode
  /** The scan's `reason`: the mark, the tile's words, the note (onBehalfReasonText). */
  readonly reason: string
}

/** The scan's `reason`: the entry's words, and why a station reports another kind of work when it does. */
export const reportReason = (onBehalf: OnBehalf | undefined, kindReason: string | null): string | null => (onBehalf ? [onBehalf.reason, kindReason].filter((part) => part !== null).join(' · ') : kindReason)

export function onBehalfRecordedInCommand(tools: CommandTools, onBehalf: OnBehalf | undefined, report: { readonly scanId: string; readonly workOrder: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string }; readonly bundleId: string; readonly operationId: string }): void {
  if (!onBehalf) return
  const { workOrder } = report
  tools.audit({ action: 'production.scanEnteredOnBehalf', recordType: 'OperationScan', recordId: report.scanId, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { workOrderId: workOrder.id, bundleId: report.bundleId, operationId: report.operationId, workerId: onBehalf.workerId, stationId: onBehalf.stationId, reasonCode: onBehalf.reasonCode }, reason: onBehalf.reason })
  tools.emit({
    type: 'production.scan_entered_on_behalf',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: { workOrderId: workOrder.id, number: workOrder.number, siteId: workOrder.siteId, bundleId: report.bundleId, scanId: report.scanId, operationId: report.operationId, reasonCode: onBehalf.reasonCode },
  })
}
