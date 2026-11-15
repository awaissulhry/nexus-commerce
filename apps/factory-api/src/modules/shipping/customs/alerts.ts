import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { exitOverdue } from '@nexus/factory-domain/shipping/customs/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The missing proof of exit's alert (B-W2b-409; LOG-089 "an alert when it is still missing after N days"; art. 8 c. 1 lett. a
 * DPR 633/1972: the export stays VAT-free on the proof that the goods left the EU): the exception rules' kind
 * EXIT_PROOF_MISSING (factory-domain alerts/kinds) finds, in the tenant's system scope, the shipments that left with an
 * export declaration whose exit is not confirmed (PACK_SENT or FILED) more than the declaration's own days
 * (alertAfterDays) after they left. One alert per shipment (one declaration each); it clears when the exit is confirmed or
 * the declaration is removed. `only`: the shipments of a recheck (customs.declaration_changed names its shipment). Nothing
 * here carries money.
 */

const LIMIT = 500

export async function exitProofFindings(tx: CommandTx, rule: RulePlace & { readonly threshold: unknown }, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const rows = await tx.customsDeclaration.findMany({
    where: {
      ...(only ? { shipmentId: { in: [...only] } } : {}),
      ...(rule.companyId ? { companyId: rule.companyId } : {}),
      ...(rule.siteId ? { siteId: rule.siteId } : {}),
      status: { in: ['PACK_SENT', 'FILED'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: LIMIT,
    select: { id: true, shipmentId: true, companyId: true, siteId: true, partyId: true, status: true, alertAfterDays: true },
  })
  if (rows.length === 0) return []
  const shipments = new Map(
    (await tx.shipment.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.shipmentId))] } }, select: { id: true, number: true, shippedAt: true, status: true } })).map((row) => [row.id, row]),
  )
  return rows.flatMap((row) => {
    const shipment = shipments.get(row.shipmentId)
    if (!shipment || shipment.shippedAt === null || shipment.status === 'CANCELLED' || !exitOverdue(row, shipment.shippedAt, now)) return []
    return [
      {
        recordType: 'Shipment',
        recordId: shipment.id,
        label: shipment.number,
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId },
        facts: { declarationId: row.id, status: row.status, shippedDate: businessDate(shipment.shippedAt), days: row.alertAfterDays },
      },
    ]
  })
}
