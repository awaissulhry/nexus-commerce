import { startOnIssueHandler } from '../../../../factory-api/src/modules/inventory/issue/start'
import { floorMoveValuationHandler } from '../../../../factory-api/src/modules/inventory/ledger/valuation'
import { invoiceFilesHandler } from '../../../../factory-api/src/modules/invoicing/invoice-files'
import { sdiArchiveHandler } from '../../../../factory-api/src/modules/invoicing/sdi/archive'
import { sdiCourtesyCopyHandler } from '../../../../factory-api/src/modules/invoicing/sdi/copy'
import { sdiPollHandler } from '../../../../factory-api/src/modules/invoicing/sdi/poll'
import { tellBuyerHandler } from '../../../../factory-api/src/modules/purchasing/confirm/handler'
import { orderHandlers } from '../../../../factory-api/src/modules/sales/orders/handlers'
import { afterAcceptanceHandler } from '../../../../factory-api/src/modules/sales/quotes/after-acceptance'
import { shipDocumentsHandler } from '../../../../factory-api/src/modules/shipping/documents/handler'
import { trackingPollHandler } from '../../../../factory-api/src/modules/shipping/labels/poll'
import { emailInHandlers } from '../../../../factory-api/src/platform/email-in/handlers'
import { emailSendHandler } from '../../../../factory-api/src/platform/email-out/outbound'
import { importHandlers } from '../../../../factory-api/src/platform/imports/worker'
import { inboundHandler } from '../../../../factory-api/src/platform/inbound/process'
import type { EventHandler } from '../../../../factory-api/src/platform/outbox/dispatch'
import { printDispatchHandler } from '../../../../factory-api/src/platform/print/handler'

/**
 * The worker's handlers for the stack (stack.ts), built from the same factories as src/background.ts HANDLERS, in the
 * same order. The stack compares HANDLER_FACTORIES with background.ts at start: a handler the worker gains stops the
 * browser golden flow until it is added here too.
 */
export function handlers(): readonly EventHandler[] {
  return [inboundHandler(), ...importHandlers(), printDispatchHandler(), emailSendHandler(), ...emailInHandlers(), floorMoveValuationHandler(), startOnIssueHandler(), invoiceFilesHandler(), sdiPollHandler(), sdiArchiveHandler(), sdiCourtesyCopyHandler(), trackingPollHandler(), afterAcceptanceHandler(), shipDocumentsHandler(), ...orderHandlers(), tellBuyerHandler()]
}

export const HANDLER_FACTORIES = ['inboundHandler', 'importHandlers', 'printDispatchHandler', 'emailSendHandler', 'emailInHandlers', 'floorMoveValuationHandler', 'startOnIssueHandler', 'invoiceFilesHandler', 'sdiPollHandler', 'sdiArchiveHandler', 'sdiCourtesyCopyHandler', 'trackingPollHandler', 'afterAcceptanceHandler', 'shipDocumentsHandler', 'orderHandlers', 'tellBuyerHandler']
