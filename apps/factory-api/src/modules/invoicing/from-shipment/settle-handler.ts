import { command, type CommandTools } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { settledStateChanged, settleOrders } from './settlement'

/**
 * B-W2b-GB02 (G148; B-W1-51's gap "order.unsettled only from the watched commands"): the worker's handler that announces
 * an order's settlement when a change made outside the money module moved it (background.ts W2B_GB02_HANDLERS):
 *
 *   shipment.status_changed   to SHIPPED, DELIVERED, RETURNED or CANCELLED: the shipment's order (goods paid and invoiced
 *                             ahead are settled once they left; goods back unsettle it)
 *   sales_order.amended       an amendment (a line or a quantity added unsettles a settled order)
 *   sales_order.lines_closed  a line closed short (the rest is done: it may settle) or reopened
 *   sales_order.split         the order and the orders split from it
 *
 * It reads first, outside any transaction, whether the order's settled state differs from what its history last
 * announced (settlement.ts `settledStateChanged`); only then ONE system command runs `settleOrders` (its 'order' lock,
 * the audit row, `order.fully_settled` or `order.unsettled`, once). A repeat or a late event finds nothing to announce.
 */

const SHIPMENT_MOVES = new Set(['SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'])

export function settleAfterChangesHandler(): EventHandler {
  return defineHandler({
    name: 'invoicing.settleAfterChanges',
    events: ['shipment.status_changed', 'sales_order.amended', 'sales_order.lines_closed', 'sales_order.split'],
    attempts: 10,
    async handle(event, { caller }) {
      const payload = event.payload as { shipmentId?: string; to?: string; orderId?: string; newOrderIds?: string[] }
      const orderIds = await caller.withClient(async (client) => {
        if (event.type === 'shipment.status_changed') {
          if (!payload.shipmentId || !payload.to || !SHIPMENT_MOVES.has(payload.to)) return []
          const shipment = await client.shipment.findUnique({ where: { id: payload.shipmentId }, select: { salesOrderId: true } })
          return shipment ? [shipment.salesOrderId] : []
        }
        return [...new Set([...(payload.orderId ? [payload.orderId] : []), ...(payload.newOrderIds ?? [])])]
      })
      const changed = await caller.withClient(async (client) => {
        const found: string[] = []
        for (const orderId of orderIds.sort()) if (await settledStateChanged(client, orderId)) found.push(orderId)
        return found
      })
      if (changed.length === 0) return
      await command(caller, { name: 'invoices.settleOrders', input: { orderIds: changed, event: event.type }, causationId: event.eventId }, async (tools) => {
        let announced = 0
        const counting: CommandTools = { ...tools, audit: (entry) => ((announced += 1), tools.audit(entry)) }
        await settleOrders(counting, changed)
        // Another command announced it meanwhile: a command records at least one audit row.
        if (announced === 0) tools.audit({ action: 'invoices.settleOrders', recordType: 'SalesOrder', recordId: changed[0]!, after: { unchanged: true, event: event.type } })
        return { announced }
      })
    },
  })
}
