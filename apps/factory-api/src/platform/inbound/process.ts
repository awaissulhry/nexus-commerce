import { events } from '@nexus/factory-domain/integration/events'
import { command, type CommandCaller } from '../../core/command'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { inboundRuntime, type InboundReceipt, type InboundRuntime } from './providers'

/**
 * Processing a stored webhook (plan A1 §3.3, §4; feature PLT-194), in the worker: the handler of
 * `integration.inbound_received` (the event the receipt's own transaction wrote, so no receipt waits without its job).
 * Replay-safe: the outbox, BullMQ and a person may all deliver the same receipt again; it is applied once.
 *
 *   1. A receipt that is PROCESSED or REJECTED (or gone) is left alone.
 *   2. No processor for its provider: the receipt is marked FAILED ("no processor") and the job ends without a retry;
 *      a person sends it back once the provider's step exists.
 *   3. Otherwise ONE command: the receipt's row is claimed (RECEIVED or FAILED → locked by the update, so two workers
 *      never both apply it), the provider's processor applies it through the same tools (audited, with its events),
 *      and the receipt becomes PROCESSED, in one transaction. A receipt another worker finished meanwhile is skipped.
 *   4. The processor fails: the transaction rolls back, the failure is recorded (FAILED, attempts + 1, lastError) by
 *      its own command, and the job throws, so BullMQ retries with backoff and its last attempt goes to the dead-letter
 *      queue (core/queue.ts). The receipt keeps its body: nothing is lost.
 *
 * Wire it in the worker: background.ts `HANDLERS = [inboundHandler()]`.
 */

export const INBOUND_HANDLER = 'integration.processInbound'
const payloadSchema = events[0].payload

/** The receipt was processed (or rejected) meanwhile: nothing to do. */
class AlreadySettled extends Error {
  override name = 'AlreadySettled'
}

const RECEIPT_SELECT = {
  id: true,
  tenantId: true,
  companyId: true,
  accountId: true,
  provider: true,
  dedupeKey: true,
  externalId: true,
  eventType: true,
  contentType: true,
  body: true,
  receivedAt: true,
  attempts: true,
  status: true,
} as const

const errorText = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1_000)

/** Records a failed attempt (FAILED, attempts + 1, the error). Returns false when the receipt was settled meanwhile. */
async function recordFailure(caller: CommandCaller, receiptId: string, companyId: string | null, lastError: string, causationId: string): Promise<boolean> {
  try {
    await command(caller, { name: 'integration.failInbound', input: { receiptId }, causationId }, async (tools) => {
      const { count } = await tools.tx.inboundWebhook.updateMany({
        where: { id: receiptId, status: { in: ['RECEIVED', 'FAILED'] } },
        data: { status: 'FAILED', attempts: { increment: 1 }, lastError },
      })
      if (count !== 1) throw new AlreadySettled()
      tools.audit({ recordType: 'InboundWebhook', recordId: receiptId, companyId, after: { status: 'FAILED', lastError } })
      return { failed: true }
    })
    return true
  } catch (error) {
    if (error instanceof AlreadySettled) return false
    throw error
  }
}

/** Processes one receipt (the handler's work). Answers what happened, for the tests and the log. */
export async function processReceipt(
  caller: CommandCaller,
  receiptId: string,
  causationId: string,
  runtime: InboundRuntime = inboundRuntime(),
): Promise<'processed' | 'settled' | 'no_processor'> {
  const receipt = await caller.withClient((client) => client.inboundWebhook.findUnique({ where: { id: receiptId }, select: RECEIPT_SELECT }))
  if (!receipt || receipt.status === 'PROCESSED' || receipt.status === 'REJECTED' || receipt.body === null || receipt.dedupeKey === null) return 'settled'
  const processor = runtime.providers[receipt.provider]?.processor
  if (!processor) {
    await recordFailure(caller, receipt.id, receipt.companyId, `no processor for provider ${receipt.provider}`, causationId)
    return 'no_processor'
  }
  const view: InboundReceipt = Object.freeze({ ...receipt, body: receipt.body, dedupeKey: receipt.dedupeKey })
  try {
    await command(caller, { name: 'integration.processInbound', input: { receiptId }, causationId }, async (tools) => {
      // The claim: the row is locked by this update for the rest of the transaction; a settled receipt matches nothing.
      const { count } = await tools.tx.inboundWebhook.updateMany({
        where: { id: receiptId, status: { in: ['RECEIVED', 'FAILED'] } },
        data: { attempts: { increment: 1 } },
      })
      if (count !== 1) throw new AlreadySettled()
      await processor.process(view, tools)
      await tools.tx.inboundWebhook.update({ where: { id: receiptId }, data: { status: 'PROCESSED', processedAt: tools.now, lastError: null }, select: { id: true } })
      tools.audit({ recordType: 'InboundWebhook', recordId: receiptId, companyId: receipt.companyId, before: { status: receipt.status }, after: { status: 'PROCESSED' } })
      return { processed: true }
    })
    return 'processed'
  } catch (error) {
    if (error instanceof AlreadySettled) return 'settled'
    await recordFailure(caller, receipt.id, receipt.companyId, errorText(error), causationId)
    throw error
  }
}

/** The worker's handler of integration.inbound_received. */
export function inboundHandler(runtime?: () => InboundRuntime): EventHandler {
  return defineHandler({
    name: INBOUND_HANDLER,
    events: ['integration.inbound_received'],
    attempts: 5,
    async handle(event, tools) {
      const { receiptId } = payloadSchema.parse(event.payload)
      await processReceipt(tools.caller, receiptId, event.eventId, runtime ? runtime() : inboundRuntime())
    },
  })
}
