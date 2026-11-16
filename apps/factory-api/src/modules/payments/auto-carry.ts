import { command } from '../../core/command'
import { defineHandler, type EventHandler } from '../../platform/outbox/dispatch'
import { ordersOfInvoices } from '../invoicing/from-shipment/settlement'
import { collectionsOf } from '../receivables/notices/settings'
import { carryInCommand, carryRefused, depositsToCarry } from './deposit-carry'

/**
 * B-W2b-GB02 (G088; B-W2b-21's gap "no auto-carry"): the worker's `payments.autoCarry` (background.ts W2B_GB02_HANDLERS).
 * On invoice.issued of a TD01 or TD24, while the company's switch ReceivablesSettings.depositAutoCarryOn is on (OFF by
 * default; the collections switches, PUT /receivables/collections/settings), each PAID deposit of the invoice's orders that
 * issues no deposit invoice (NONE) and still holds money is carried as a person would carry it (deposit-carry.ts
 * `carryInCommand`: the money locks, each live allocation reversed and placed on the oldest invoice of the order that takes
 * it whole), ONE system command per deposit. A deposit that cannot be carried (an invoice open for less than it holds) is
 * left to a person, its reason audited on the request; nothing is retried by itself.
 */
export function autoCarryHandler(): EventHandler {
  return defineHandler({
    name: 'payments.autoCarry',
    events: ['invoice.issued'],
    attempts: 10,
    async handle(event, { caller }) {
      const { invoiceId } = event.payload as { invoiceId: string }
      const deposits = await caller.withClient(async (db) => {
        const invoice = await db.invoice.findUnique({ where: { id: invoiceId }, select: { companyId: true, docType: true } })
        if (!invoice || (invoice.docType !== 'TD01' && invoice.docType !== 'TD24')) return []
        if (!(await collectionsOf(db, invoice.companyId)).depositAutoCarryOn) return []
        const held = await depositsToCarry(db, await ordersOfInvoices(db, [invoiceId]))
        return [...held.values()].flat().map((entry) => entry.depositRequestId)
      })
      for (const depositRequestId of deposits) {
        await command(caller, { name: 'payments.autoCarry', input: { depositRequestId, invoiceId }, causationId: event.eventId }, async (tools) => {
          const outcome = await carryInCommand(tools, depositRequestId, {})
          if (carryRefused(outcome)) {
            tools.audit({ action: 'payments.autoCarry', recordType: 'DepositRequest', recordId: depositRequestId, after: { carried: false, invoiceId, problem: outcome.problem } })
            return { carried: false }
          }
          return { carried: true }
        })
      }
    },
  })
}
