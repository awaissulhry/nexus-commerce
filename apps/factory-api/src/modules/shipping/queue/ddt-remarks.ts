import { requirementRemarks } from '@nexus/factory-domain/shipping/queue/ddt-remarks'
import type { CommandTx } from '../../../core/command'
import { requirementsApplying } from '../../parties/requirements/requirements'

/**
 * The customer's requirements on a shipment's DDT (B-W2b-386; follow-up LQ1:02; rules factory-domain shipping/queue/
 * ddt-remarks): the requirements in force on the shipping checklist (stage SHIPMENT) for the shipment's company and the
 * styles it carries, as the DDT's printed remarks — read by the DDT's facts (shipping/ddt store.ts readDdtFacts); the office
 * may type its own remarks instead (the DDT request's `remarks`). Null when none applies.
 */
export async function ddtRequirementRemarks(db: CommandTx, shipment: { readonly id: string; readonly partyId: string; readonly companyId: string }): Promise<string | null> {
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: shipment.id }, select: { workOrderSize: { select: { workOrder: { select: { styleId: true } } } } } })
  const styleIds = [...new Set(lines.map((line) => line.workOrderSize.workOrder.styleId))]
  const rows = await requirementsApplying(db, shipment.partyId, { companyId: shipment.companyId, stages: ['SHIPMENT'], styleIds })
  return requirementRemarks(rows)
}
