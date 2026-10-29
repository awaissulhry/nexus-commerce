import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import type { SdiMessage } from '@nexus/factory-domain/ports/sdi'
import type { CommandTools } from '../../../core/command'
import type { InboundProcessor, InboundReceipt } from '../../../platform/inbound/providers'
import { settleNoted } from '../from-shipment/settlement'
import { applyMessages } from './record'
import { processSdi, type SdiRuntime } from './runtime'

/**
 * SDI's webhooks (FIN-086; plan A1 §4 "Inbound webhooks"): the inbound ledger verifies the delivery (a FAKE account: the
 * fake signature; LIVE and SANDBOX: the provider's verifier, none until Q21), stores the receipt FIRST and answers;
 * the worker then runs this processor ONCE per receipt, inside the ledger's processing command: the body is read by the
 * account's adapter into SDI messages, each message finds its send (the provider's id, else our file name, among the
 * account's sends) and is recorded by applyMessages (once per SDI MessageId: a replayed webhook, a provider's retry
 * under a new delivery id and a poll that found it first all leave one notification). A message whose send is not
 * known (yet) fails the receipt: the ledger keeps it FAILED and the job retries (the provider's answer to the send may
 * still be on its way), then a person looks.
 */

class UnknownSend extends Error {
  override name = 'UnknownSend'
}

async function sendOf(tools: CommandTools, accountId: string, message: SdiMessage): Promise<string> {
  const where = [
    ...(message.providerRef ? [{ providerRef: message.providerRef }] : []),
    ...(message.fileName ? [{ fileName: message.fileName }] : []),
    ...(message.sdiIdentifier ? [{ sdiIdentifier: message.sdiIdentifier }] : []),
  ]
  const found = where.length > 0 ? await tools.tx.sdiSubmission.findFirst({ where: { integrationAccountId: accountId, OR: where }, select: { id: true } }) : null
  if (!found) throw new UnknownSend(`No send of this SDI account matches the notification (${message.type}, file ${message.fileName ?? '?'}).`)
  return found.id
}

export function sdiInboundProcessor(runtime: () => SdiRuntime = processSdi): InboundProcessor {
  return {
    async process(receipt: InboundReceipt, tools: CommandTools): Promise<void> {
      const account = await tools.tx.integrationAccount.findUniqueOrThrow({ where: { id: receipt.accountId }, select: { mode: true } })
      const messages = runtime().webhookMessages(account.mode as IntegrationMode, receipt.body)
      const bySend = new Map<string, SdiMessage[]>()
      for (const message of messages) {
        const sendId = await sendOf(tools, receipt.accountId, message)
        bySend.set(sendId, [...(bySend.get(sendId) ?? []), message])
      }
      for (const [sendId, list] of [...bySend].sort(([a], [b]) => a.localeCompare(b))) {
        await applyMessages(tools, sendId, list, { inboundWebhookId: receipt.id })
      }
      // B-W1-51: the orders an outcome may have settled, once every invoice row is held.
      await settleNoted(tools)
    },
  }
}
