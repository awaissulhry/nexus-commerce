import { events as shippingEvents } from '@nexus/factory-domain/shipping/events'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { processFiles, type FilesRuntime } from '../../../platform/files/service'
import { readShipment } from '../store'
import { attachDocuments, attachStateProblem } from './attach'
import { NoRecipientsError, sendDocumentLinks } from './link'
import { readDocuments } from './read'

/**
 * The worker's handler of the goods leaving (B-W1-49; PLAN §4.7 14-ship "DoC by link"; Reg. (EU) 2016/425 art. 8(8)):
 *
 *   shipment.status_changed → SHIPPED   attach the documents (attach.ts), then mail the party's ORDERS and QUALITY
 *                                       contacts their link (link.ts, once per address: a repeated event sends nothing)
 *   ddt.issued, a replacement           attach again: the new DDT's copy joins the link the party already has
 *
 * The DDT's PDF is stored right after its issuing command commits, so the job may find it missing: it throws and the
 * queue tries again, and on its last try it attaches what is there (the DoC never waits for the DDT). A party with no
 * contact to mail is not an error: the office sees "no link sent" on the Documents tab. Both commands take keys made
 * from the event, so a repeated job answers from their receipts.
 */

export const SHIP_DOCUMENTS_HANDLER = 'shipping.shipDocuments'
const ATTEMPTS = 8

const statusChanged = shippingEvents.find((event) => event.type === 'shipment.status_changed')!.payload
const ddtIssued = shippingEvents.find((event) => event.type === 'ddt.issued')!.payload

/** The DDT's PDF is not stored yet: the job tries again. */
export class DdtPdfPending extends Error {
  override name = 'DdtPdfPending'
}

export function shipDocumentsHandler(runtime: { readonly files?: () => FilesRuntime; readonly email?: () => EmailRuntime } = {}): EventHandler {
  const files = runtime.files ?? processFiles
  const email = runtime.email ?? processEmail
  return defineHandler({
    name: SHIP_DOCUMENTS_HANDLER,
    events: ['shipment.status_changed', 'ddt.issued'],
    attempts: ATTEMPTS,
    async handle(event, tools) {
      let shipmentId: string
      let send: boolean
      if (event.type === 'shipment.status_changed') {
        const payload = statusChanged.parse(event.payload)
        if (payload.to !== 'SHIPPED') return
        shipmentId = payload.shipmentId
        send = true
      } else {
        const payload = ddtIssued.parse(event.payload)
        if (!payload.replacement) return
        shipmentId = payload.shipmentId
        send = false
      }
      const shipment = await tools.caller.withClient((client) => readShipment(client, shipmentId))
      if (!shipment || attachStateProblem(shipment.status) !== null) return
      const { documents } = await tools.caller.withClient((client) => readDocuments(client, shipment))
      const ddt = documents.documents.find((document) => document.kind === 'DDT')
      if (ddt && ddt.state === 'MISSING' && ddt.documentId !== null && tools.attempt < ATTEMPTS) {
        throw new DdtPdfPending(`DDT ${ddt.number} of shipment ${shipment.number} has no stored PDF yet; the documents are attached on the next try.`)
      }
      await attachDocuments(files(), tools.caller, shipment, { idempotencyKey: `ship-docs:attach:${event.eventId}`, causationId: event.eventId })
      if (!send) return
      try {
        await sendDocumentLinks({
          email: email(),
          caller: tools.caller,
          delivery: tools.caller,
          shipment,
          reason: 'SHIPPED',
          to: { kind: 'default' },
          sender: null,
          idempotencyKey: `ship-docs:link:${event.eventId}`,
          causationId: event.eventId,
        })
      } catch (error) {
        if (error instanceof NoRecipientsError) return
        throw error
      }
    },
  })
}
