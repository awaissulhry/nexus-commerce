import type { CutOrderChange, CutTicketChange, PlyRunChange } from '@nexus/factory-domain/production-cutorders/events'
import type { CommandTools } from '../../../core/command'

/**
 * The events of cut orders (B-W2b-112; factory-domain production-cutorders/events): one per change, in the command that makes
 * it, about the cut order's company and site (the Cutting page and the site's cutting tablets). Ids, numbers and states only.
 */

type Order = { readonly id: string; readonly companyId: string; readonly siteId: string; readonly number: string; readonly kind: string; readonly status: string }

export function emitOrder(tools: Pick<CommandTools, 'emit'>, order: Order, change: CutOrderChange, workOrderIds: readonly string[], allocation: { readonly layId: string; readonly rollIds: readonly string[] } | null = null): void {
  tools.emit({
    type: 'cut_order.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { cutOrderId: order.id, number: order.number, kind: order.kind, status: order.status, change, workOrderIds: [...workOrderIds], layId: allocation?.layId ?? null, rollIds: [...(allocation?.rollIds ?? [])] },
  })
}

export function emitTicket(tools: Pick<CommandTools, 'emit'>, order: Order, ticket: { readonly id: string; readonly number: string; readonly layId: string | null; readonly status: string }, change: CutTicketChange, replacedById: string | null): void {
  tools.emit({
    type: 'cut_ticket.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { ticketId: ticket.id, ticketNumber: ticket.number, cutOrderId: order.id, number: order.number, layId: ticket.layId, ticketStatus: ticket.status, status: order.status, change, replacedById },
  })
}

export function emitPlyRun(tools: Pick<CommandTools, 'emit'>, order: Order, run: { readonly id: string; readonly layId: string; readonly status: string; readonly firstPly: number; readonly lastPly: number; readonly labelCount: number }, change: PlyRunChange): void {
  tools.emit({
    type: 'ply_run.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { plyRunId: run.id, layId: run.layId, cutOrderId: order.id, number: order.number, runStatus: run.status, change, firstPly: run.firstPly, lastPly: run.lastPly, labelCount: run.labelCount },
  })
}
