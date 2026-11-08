import type { ConsumptionChange, LayChange } from '@nexus/factory-domain/production-lays/events'
import type { CommandTools } from '../../../core/command'

/**
 * The events of lays and reconciliations (B-W2b-116; factory-domain production-lays/events): one per change, in the command that
 * makes it, about the cut order's company and site. Ids, numbers, states and counts only.
 */

type Order = { readonly id: string; readonly companyId: string; readonly siteId: string; readonly number: string; readonly kind: string; readonly status: string }

export function emitLay(tools: Pick<CommandTools, 'emit'>, order: Order, lay: { readonly id: string; readonly seq: number; readonly status: string }, change: LayChange, plies: number, rollIds: readonly string[]): void {
  tools.emit({
    type: 'lay.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { layId: lay.id, cutOrderId: order.id, number: order.number, seq: lay.seq, status: lay.status, change, plies, rollIds: [...rollIds] },
  })
}

export function emitConsumption(tools: Pick<CommandTools, 'emit'>, order: Order, consumption: { readonly id: string; readonly layId: string }, change: ConsumptionChange, workOrderIds: readonly string[], moveIds: readonly string[]): void {
  tools.emit({
    type: 'cut_consumption.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { consumptionId: consumption.id, layId: consumption.layId, cutOrderId: order.id, number: order.number, change, workOrderIds: [...workOrderIds], moveIds: [...moveIds] },
  })
}

export function emitReconciled(tools: Pick<CommandTools, 'emit'>, order: Order, workOrderIds: readonly string[], counts: { readonly lines: number; readonly variances: number; readonly garmentsOrdered: number; readonly garmentsCut: number }): void {
  tools.emit({
    type: 'cut_order.reconciled',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { cutOrderId: order.id, number: order.number, kind: order.kind, status: order.status, workOrderIds: [...workOrderIds], ...counts },
  })
}
