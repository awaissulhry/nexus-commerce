import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowValues } from '@nexus/factory-domain/imports/importer'
import { HIDE_LIST_IMPORTER_KEY, hideListTotals, lineOfRow, lotKeyOf } from '@nexus/factory-domain/inventory/receipts/hide-list'
import type { CommandCaller } from '../../../core/command'
import { getImport } from '../../../platform/imports/jobs'
import { baseAreaOf, orderOf, text, type OrderFacts } from './hide-list'

/**
 * GET /inventory/receipts/hide-lists/:importId: a tannery hide list's totals against its order — per order line the
 * hides and the area it brings (the rows planned to be received), what the line expects and received before, the
 * difference with the tolerance — and, once applied, the receipt it made.
 */
export async function hideListSummary(caller: CommandCaller, importId: string) {
  const job = await getImport(caller, importId)
  if (job.importerKey !== HIDE_LIST_IMPORTER_KEY || job.companyId === null) throw new NotFoundError('Hide list not found.')
  const companyId = job.companyId
  return caller.withClient(async (client) => {
    const rows = await client.importRow.findMany({ where: { jobId: job.id }, select: { rowNumber: true, action: true, key: true, after: true, outcome: true, recordId: true }, orderBy: { rowNumber: 'asc' } })
    const counts = { rows: rows.length, toReceive: rows.filter((row) => row.action === 'CREATE').length, receivedBefore: rows.filter((row) => row.action === 'UNCHANGED').length, errors: rows.filter((row) => row.action === 'ERROR').length }
    const number = rows.map((row) => (row.key ? (JSON.parse(row.key) as CellValue[])[0] : null)).find((value) => value !== null && value !== undefined)
    const facts: OrderFacts | null = number === undefined || number === null ? null : await orderOf(client, companyId, String(number))
    const planned = rows.filter((row) => row.action === 'CREATE' && row.after && typeof row.after === 'object')
    const totals = facts
      ? hideListTotals(
          planned.flatMap((row) => {
            const values = row.after as RowValues
            const found = lineOfRow(values, facts.lines)
            if (found.problem) return []
            const line = facts.orderLines.get(found.line.id)!
            const area = baseAreaOf(values, line, facts.items.get(line.itemId)!)
            return area.problem ? [] : [{ line: found.line, baseArea: area.base, lotKey: lotKeyOf(values), differenceReason: text(values.differenceReason) }]
          }),
        )
      : []
    const hideIds = rows.flatMap((row) => (row.outcome === 'APPLIED' && row.recordId && isUuid(row.recordId) ? [row.recordId] : []))
    const hide = hideIds.length > 0 ? await client.hide.findFirst({ where: { id: { in: hideIds } }, select: { lotId: true } }) : null
    const lot = hide ? await client.lot.findUnique({ where: { id: hide.lotId }, select: { receiptLineId: true } }) : null
    const line = lot?.receiptLineId ? await client.goodsReceiptLine.findUnique({ where: { id: lot.receiptLineId }, select: { receiptId: true } }) : null
    const receipt = line ? await client.goodsReceipt.findUnique({ where: { id: line.receiptId }, select: { id: true, number: true, status: true } }) : null
    return {
      importId: job.id,
      status: job.status,
      counts,
      order: facts ? { id: facts.order.id, number: facts.order.number, status: facts.order.status, siteId: facts.order.siteId } : null,
      lines: totals.map((total) => ({
        purchaseOrderLineId: total.line.id,
        seq: total.line.seq,
        itemCode: total.line.itemCode,
        baseUom: total.line.baseUom,
        hides: total.hides,
        lots: total.lots,
        baseArea: total.baseArea,
        expected: total.difference.expected,
        receivedBefore: total.difference.receivedBefore,
        after: total.difference.after,
        difference: total.difference.difference,
        tolerancePct: total.difference.tolerancePct,
        upTo: total.difference.upTo,
        kind: total.difference.kind,
        needsReason: total.needsReason,
      })),
      receipt,
    }
  })
}
