import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CloseRefusal } from '@nexus/factory-domain/costing/close/rules'
import type { Split } from '@nexus/factory-domain/costing/variances/split'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTools, CommandTx } from '../../../core/command'
import { lockMethodInCommand } from '../method/method'
import { ENTRY_COLUMNS, lockWorkOrderCosts, type CostedWorkOrder, type EntryRow } from '../actual/store'

/**
 * The cost close of a work order (B-W2b-411; FIN-030, FIN-034), inside the close's command, while the company's figures for
 * the accountant are on: the variance split's lines (WorkOrderVariance), one VARIANCE entry per line taking its amount
 * off the work order (sourceType WorkOrderVariance, key `variance:<id>`), then the CLOSE entry last, in its own statement
 * (what is left after them, so the work order's entries add up to 0; sourceType WorkOrderClose, key `close:<id>`), all
 * dated at the close. From then on the database refuses any entry on the work order but a reversal. Also: the live
 * VARIANCE and CLOSE entries of a close (what an undo or a reopen reverses), and the refusals in words.
 */

/** A refusal of the close, the undo or the reopen, as a 409 with `refusal/<code>`. */
export const refused = (code: CloseRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

export interface Settlement {
  readonly varianceIds: readonly string[]
  readonly entryIds: readonly string[]
  readonly closing: number
}

export async function settleInCommand(tools: CommandTools, workOrder: CostedWorkOrder, closeId: string, split: Split): Promise<Settlement> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const method = await lockMethodInCommand(tools, workOrder.companyId)
  const base = { companyId: workOrder.companyId, siteId: workOrder.siteId, workOrderId: workOrder.id, currency: workOrder.currency }
  const varianceIds = split.lines.map(() => newId())
  const entryIds = split.lines.map(() => newId())
  if (split.lines.length > 0) {
    await tx.workOrderVariance.createMany({
      data: split.lines.map((line, index) => ({ ...base, id: varianceIds[index]!, closeId, ...line, createdAt: now, createdById })),
    })
    await tx.workOrderCostEntry.createMany({
      data: split.lines.map((line, index) => ({
        ...base,
        id: entryIds[index]!,
        kind: 'VARIANCE' as const,
        occurredAt: now,
        itemId: line.itemId,
        amount: line.amount === 0 ? 0 : -line.amount,
        costingMethod: method,
        sourceType: 'WorkOrderVariance',
        sourceId: varianceIds[index]!,
        idempotencyKey: `variance:${varianceIds[index]!}`,
        createdAt: now,
        createdById,
      })),
    })
  }
  // The closing entry last, on its own: the database checks the work order adds up to 0 after it.
  const closeEntryId = newId()
  await tx.workOrderCostEntry.create({
    data: { ...base, id: closeEntryId, kind: 'CLOSE', occurredAt: now, amount: split.closing, costingMethod: method, sourceType: 'WorkOrderClose', sourceId: closeId, idempotencyKey: `close:${closeId}`, createdAt: now, createdById },
    select: { id: true },
  })
  tools.audit({
    action: 'costing.closeWorkOrderCost',
    recordType: 'WorkOrderClose',
    recordId: closeId,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: {
      basis: split.basis,
      method,
      variances: split.lines.map((line, index) => ({ id: varianceIds[index], category: line.category, itemId: line.itemId, amount: markMoney('cost', line.amount) })),
      closing: markMoney('cost', split.closing),
    },
  })
  return { varianceIds, entryIds: [...entryIds, closeEntryId], closing: split.closing }
}

/** The close's VARIANCE and CLOSE entries not reversed yet (under the work order's costing lock). */
export async function liveEntriesOfClose(tx: CommandTx, tenantId: string, workOrderId: string, closeId: string): Promise<EntryRow[]> {
  await lockWorkOrderCosts(tx, tenantId, workOrderId)
  const variances = (await tx.workOrderVariance.findMany({ where: { closeId }, select: { id: true } })).map((row) => row.id)
  const rows = await tx.workOrderCostEntry.findMany({
    where: { workOrderId, reversalOfId: null, OR: [{ kind: 'CLOSE', sourceType: 'WorkOrderClose', sourceId: closeId }, { kind: 'VARIANCE', sourceType: 'WorkOrderVariance', sourceId: { in: variances } }] },
    select: ENTRY_COLUMNS,
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  })
  const reversed = new Set((await tx.workOrderCostEntry.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId))
  return rows.filter((row) => !reversed.has(row.id))
}
