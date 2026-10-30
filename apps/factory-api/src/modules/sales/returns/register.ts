import { isSafetyReturn, type ReturnCause } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandTools } from '../../../core/command'
import { openRegisterEntryFor } from '../../compliance/register/hook'
import { soldFactsOf, lineKeyOf, type LineRow, type RmaRow } from './store'

/**
 * A protective garment returned for a defect (or found defective or misused at the inspection) goes into the PPE
 * register (Reg. (EU) 2016/425 art. 8(4): the manufacturer keeps a register of complaints; W1's register, B-W1-43), in
 * the same command as the return or the decision: one entry per shipment the garment left on (the register's source
 * Shipment: the database takes no return as a source yet, schema need named in the notes), kind COMPLAINT, the
 * customer as the reporting party, the style, the batch and serial as read, risk ASSESSING. A second return from the
 * same shipment answers the entry it opened. Office and system commands only (the floor's grading opens it at the
 * decision). A line with no order line (a sample invoiced alone) names no shipment: none is opened, the answer says so.
 */

export interface SafetyEntry {
  readonly lineId: string
  readonly seq: number
  /** null: nothing to open it from (no shipment known), the line's words say so. */
  readonly entryId: string | null
  readonly reference: string | null
  readonly opened: boolean
  readonly words: string
}

export async function openSafetyEntries(tools: CommandTools, rma: Pick<RmaRow, 'id' | 'number' | 'companyId' | 'partyId' | 'requestedAt'>, lines: readonly LineRow[]): Promise<SafetyEntry[]> {
  if (tools.context.audience !== 'office' && tools.context.audience !== 'system') return []
  const { tx } = tools
  const sold = await soldFactsOf(tx, lines)
  const entries: SafetyEntry[] = []
  for (const line of lines) {
    const facts = sold.get(lineKeyOf(line))
    const ppe = facts?.style?.ppe ?? false
    if (!isSafetyReturn({ ppe, reasonCode: line.reasonCode, cause: line.cause as ReturnCause | null })) continue
    const orderLineId = facts?.orderLine?.id ?? null
    const shipment = orderLineId
      ? await tx.shipmentLine.findFirst({
          where: { salesOrderLineId: orderLineId, ...(line.size ? { size: line.size } : {}), shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } },
          select: { shipmentId: true },
          orderBy: { createdAt: 'desc' },
        })
      : null
    if (!shipment || !facts?.style) {
      entries.push({ lineId: line.id, seq: line.seq, entryId: null, reference: null, opened: false, words: `Line ${line.seq} names no shipment: record it in Compliance › PPE register by hand.` })
      continue
    }
    const why = line.cause ? `found ${line.cause.toLowerCase().replace('_', ' ')} at the inspection` : `returned for ${line.reasonCode.toLowerCase().replace(/_/g, ' ')}`
    const opened = await openRegisterEntryFor(tools, {
      companyId: rma.companyId,
      kind: 'COMPLAINT',
      styleId: facts.style.id,
      shipmentIds: [shipment.shipmentId],
      serials: line.serial ? [line.serial] : [],
      batchNumbers: line.batchNumber ? [line.batchNumber] : [],
      description: `Return ${rma.number} line ${line.seq}: ${line.description}, ${why}.${line.reasonNote ? ` The customer: ${line.reasonNote}` : ''}${line.conditionNote ? ` Condition: ${line.conditionNote}` : ''}`.slice(0, 2000),
      partyId: rma.partyId,
      reportedAt: rma.requestedAt,
      source: { type: 'Shipment', id: shipment.shipmentId },
    })
    entries.push({ lineId: line.id, seq: line.seq, entryId: opened.entryId, reference: opened.reference, opened: opened.opened, words: opened.opened ? `PPE register entry ${opened.reference} opened.` : `In PPE register entry ${opened.reference} (its shipment's).` })
  }
  return entries
}
