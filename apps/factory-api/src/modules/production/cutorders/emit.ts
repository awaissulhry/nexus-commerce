import type { CutOrderChange, CutTicketChange, PlyRunChange } from '@nexus/factory-domain/production-cutorders/events'
// B-PR-09: the customers a cut order's events name (the office's live wall).
import { partyIdsOf } from '@nexus/factory-domain/events/live'
import type { CommandTools } from '../../../core/command'
import { CELL_PARTY } from './access'
import type { Reader } from './store'

/**
 * The events of cut orders (B-W2b-112; factory-domain production-cutorders/events): one per change, in the command that makes
 * it, about the cut order's company and site (the Cutting page and the site's cutting tablets). Ids, numbers and states only.
 *
 * B-PR-09 (production plan §2, the brand wall): each names `partyIds`, the customers of the work orders the cut order cuts, read
 * in the command (so a plan's new lines count): each once, [] when one of them names no customer. The office's live screens send
 * the message only to people who reach every one of them — as the cut order itself is found (./access may, cutOrderWall): a
 * person limited to brand B never receives one of brand A's cut orders, nor of a cut order of A and B.
 */

type Order = { readonly id: string; readonly companyId: string; readonly siteId: string; readonly number: string; readonly kind: string; readonly status: string }
type Tools = Pick<CommandTools, 'emit' | 'tx'>

// ── B-PR-09 ──
/** The cut order's `partyIds`: the customers of its lines' work orders (factory-domain events/live.ts partyIdsOf). */
export async function cutOrderPartyIds(db: Reader, cutOrderId: string): Promise<string[]> {
  const lines = await db.cutOrderLine.findMany({ where: { cutOrderId }, select: CELL_PARTY })
  return partyIdsOf(lines.map((line) => line.workOrderSize.workOrder.partyId))
}
// ── end B-PR-09 ──

export async function emitOrder(tools: Tools, order: Order, change: CutOrderChange, workOrderIds: readonly string[], allocation: { readonly layId: string; readonly rollIds: readonly string[] } | null = null): Promise<void> {
  tools.emit({
    type: 'cut_order.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { cutOrderId: order.id, number: order.number, partyIds: await cutOrderPartyIds(tools.tx, order.id) /* B-PR-09 */, kind: order.kind, status: order.status, change, workOrderIds: [...workOrderIds], layId: allocation?.layId ?? null, rollIds: [...(allocation?.rollIds ?? [])] },
  })
}

export async function emitTicket(tools: Tools, order: Order, ticket: { readonly id: string; readonly number: string; readonly layId: string | null; readonly status: string }, change: CutTicketChange, replacedById: string | null): Promise<void> {
  tools.emit({
    type: 'cut_ticket.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { ticketId: ticket.id, ticketNumber: ticket.number, cutOrderId: order.id, number: order.number, partyIds: await cutOrderPartyIds(tools.tx, order.id) /* B-PR-09 */, layId: ticket.layId, ticketStatus: ticket.status, status: order.status, change, replacedById },
  })
}

export async function emitPlyRun(tools: Tools, order: Order, run: { readonly id: string; readonly layId: string; readonly status: string; readonly firstPly: number; readonly lastPly: number; readonly labelCount: number }, change: PlyRunChange): Promise<void> {
  tools.emit({
    type: 'ply_run.changed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { plyRunId: run.id, layId: run.layId, cutOrderId: order.id, number: order.number, partyIds: await cutOrderPartyIds(tools.tx, order.id) /* B-PR-09 */, runStatus: run.status, change, firstPly: run.firstPly, lastPly: run.lastPly, labelCount: run.labelCount },
  })
}
