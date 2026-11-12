import { ConflictError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { scheduledEditProblem } from '@nexus/factory-domain/purchasing/po-depth/schedule'
import { parseDecimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * B-W2b-296: what other purchasing commands call so a delivery schedule stays the line's (each a small step INSIDE the
 * caller's command; this file imports no command module, so W1's files import it without a cycle).
 *
 *   removeDeliveriesOf       a draft line removed: its deliveries first (their reference to the line is Restrict)
 *   assertScheduledEdit      a draft line edited: its quantity, unit and need date come from its deliveries
 *   clearDeliveryConfirmations  the order back to DRAFT for its next revision (revisions/change.ts): the deliveries
 *                            lose the supplier's days as the lines lose theirs (the send refuses leftovers)
 *   confirmScheduleAsAsked   the supplier confirmed lines (its link, the portal, or the buyer accepting its changes):
 *                            the deliveries of a line confirmed exactly as asked (its quantity, on its need date) are
 *                            confirmed each on its own day; a line confirmed otherwise keeps its deliveries unconfirmed
 *                            (the buyer records the supplier's days, po-depth/dates.ts)
 *   receiptPlaceOf           a goods receipt against an order shipped to a third party (SCM-066, SCM-147): the office's
 *                            lands on the workshop's place by default (the stock it holds of ours); a tablet at our dock
 *                            never receives it (the goods do not come there)
 */

/** A draft line's deliveries, before the line is deleted. */
export async function removeDeliveriesOf(tx: CommandTx, lineIds: readonly string[]): Promise<number> {
  if (lineIds.length === 0) return 0
  return (await tx.purchaseOrderLineDelivery.deleteMany({ where: { purchaseOrderLineId: { in: [...lineIds] } } })).count
}

/** A stored quantity and a typed one are the same number (a typed one that is no number is not). */
export const sameQuantity = (stored: { toString(): string }, typed: string): boolean => {
  const parsed = parseDecimal(typed.trim())
  return parsed !== null && parsed.equals(stored.toString())
}

/** A 409 in words when an edit of a scheduled line changes what its deliveries make. */
export async function assertScheduledEdit(tx: CommandTx, line: { readonly id: string; readonly seq: number }, change: { readonly quantity: boolean; readonly uom: boolean; readonly needDate: boolean }): Promise<void> {
  if (!(change.quantity || change.uom || change.needDate)) return
  const deliveries = await tx.purchaseOrderLineDelivery.count({ where: { purchaseOrderLineId: line.id } })
  const problem = scheduledEditProblem({ seq: line.seq, deliveries }, change)
  if (problem) throw new ConflictError(problem)
}

/** The order is a draft again: its live lines' deliveries lose the supplier's days. */
export async function clearDeliveryConfirmations(tools: Pick<CommandTools, 'tx'>, orderId: string): Promise<number> {
  return (await tools.tx.purchaseOrderLineDelivery.updateMany({ where: { confirmedDate: { not: null }, line: { purchaseOrderId: orderId, cancelledAt: null, closedShortAt: null } }, data: { confirmedDate: null, version: { increment: 1 } } })).count
}

/**
 * The lines just confirmed (while the order is still SENT, or CHANGES_PROPOSED for the buyer's acceptance): each delivery
 * of a line confirmed exactly as asked takes its own day as its confirmed day. Runs in the caller's session (a link or
 * portal session may confirm a delivery's day once, while the order is SENT).
 */
export async function confirmScheduleAsAsked(tools: Pick<CommandTools, 'tx'>, orderId: string, lineIds: readonly string[]): Promise<number> {
  if (lineIds.length === 0) return 0
  const lines = await tools.tx.purchaseOrderLine.findMany({ where: { id: { in: [...lineIds] }, purchaseOrderId: orderId }, select: { id: true, quantity: true, needDate: true, confirmedQuantity: true, confirmedDate: true } })
  const asAsked = lines.filter((line) => line.confirmedQuantity !== null && line.confirmedQuantity.equals(line.quantity) && line.confirmedDate !== null && line.confirmedDate.getTime() === line.needDate.getTime())
  let confirmed = 0
  for (const line of asAsked) {
    const deliveries = await tools.tx.purchaseOrderLineDelivery.findMany({ where: { purchaseOrderLineId: line.id, confirmedDate: null }, select: { id: true, needDate: true } })
    for (const delivery of deliveries) {
      await tools.tx.purchaseOrderLineDelivery.update({ where: { id: delivery.id }, data: { confirmedDate: delivery.needDate, version: { increment: 1 } }, select: { id: true } })
      confirmed += 1
    }
  }
  return confirmed
}

/**
 * Inside a receipt's command, after the order is locked: where an order shipped to a third party lands. The floor is
 * refused in words; the office gets the workshop's place (null when the order names none: the office says where).
 */
export async function receiptPlaceOf(tools: Pick<CommandTools, 'tx'>, order: { readonly id: string; readonly number: string }, floor: boolean): Promise<{ readonly locationId: string | null; readonly shipsToThirdParty: boolean }> {
  const row = await tools.tx.purchaseOrder.findUnique({ where: { id: order.id }, select: { shipToPartyId: true, shipToLocationId: true } })
  if (!row?.shipToPartyId) return { locationId: null, shipsToThirdParty: false }
  if (floor) throw new InvalidStateError(`Purchase order ${order.number} is delivered straight to a third party, not to this dock: the office records its receipt from the delivery note.`)
  return { locationId: row.shipToLocationId, shipsToThirdParty: true }
}
