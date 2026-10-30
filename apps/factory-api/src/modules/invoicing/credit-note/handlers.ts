import { command } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { draftFromReturnInCommand } from './from-return'

/**
 * The worker's handler that drafts the credit notes of a customer return (B-W2a-61; FIN-070; background.ts): on
 * `return.credit_due` (B-W2a-43's decision, the lines decided with a credit), as the system of the event's tenant, the
 * same command a person runs on the RMA (credit-note/from-return.ts). It only drafts: a person issues each credit note.
 * A line already on a credit note (a person was first, or the event came again) is skipped, so a repeat changes nothing.
 *
 *   invoicing.creditNoteFromReturn   return.credit_due {returnId, number, partyId, lineIds}
 */
export function creditNoteHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'invoicing.creditNoteFromReturn',
      // Declared and emitted by the returns module (sales/returns/decide.ts).
      events: ['return.credit_due'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { returnId: string; lineIds?: string[] }
        const lineIds = [...new Set(payload.lineIds ?? [])]
        if (lineIds.length === 0) return
        await command(caller, { name: 'invoices.creditNotesFromReturn', input: { returnId: payload.returnId, lineIds }, causationId: event.eventId }, async (tools) => {
          const drafted = await draftFromReturnInCommand(tools, payload.returnId, new Set(lineIds))
          return { made: drafted.made.map((entry) => entry.invoiceId), skipped: drafted.skipped.map((line) => line.code) }
        })
      },
    }),
  ]
}
