import { isUuid } from '@nexus/factory-domain/core/ids'
import type { SdiStatusRequest } from '@nexus/factory-domain/ports/sdi'
import { fakeRefParts, type FakeSdiChoice, type FakeSdiKept } from '../../../adapters/sdi/fake'
import type { CommandCaller } from '../../../core/command'
import { readSettings } from './store'

/**
 * The FAKE intermediary across processes (B-W2b-F58; local and test only: a FAKE connection exists nowhere else). The API
 * sends an invoice to its fake, the worker's status poll asks its own: what both need is already in the database, so no new
 * store is kept.
 *
 *   at the send   the company's simulated answer while it is in test mode (CompanyEInvoiceSettings.simulateOutcome, as a
 *                 LIVE or SANDBOX connection's simulation in simulator.ts) and which send of the invoice this is
 *   at the poll   the send itself (SdiSubmission: the provider id that carries the outcome, the file name, when the provider
 *   and archive   took it), so the fake of any process answers it as the intermediary would
 */

/** The simulated answer a FAKE send takes now, or null (not a FAKE SDI account, or the company is live). */
export async function fakeChoiceFor(caller: CommandCaller, accountId: string, submissionId: string): Promise<FakeSdiChoice | null> {
  if (!isUuid(accountId)) return null
  return caller.withClient(async (client) => {
    const account = await client.integrationAccount.findUnique({ where: { id: accountId }, select: { provider: true, mode: true, companyId: true } })
    if (!account || account.provider !== 'SDI' || account.mode !== 'FAKE' || account.companyId === null) return null
    const settings = await readSettings(client, account.companyId)
    if (!settings.testMode) return null
    const send = isUuid(submissionId) ? await client.sdiSubmission.findUnique({ where: { id: submissionId }, select: { attempt: true } }) : null
    return { outcome: settings.simulateOutcome, attempt: send?.attempt ?? 1 }
  })
}

/**
 * The send a status or archive request names, as the database holds it (by its id, else its provider id), when the FAKE
 * intermediary took it: its provider id is a fake one and it was sent (the provider took it at sentAt). Else null.
 */
export async function recallFakeSend(caller: CommandCaller, request: Pick<SdiStatusRequest, 'providerRef' | 'fileName'> & { readonly idempotencyKey: string | null }): Promise<FakeSdiKept | null> {
  const select = { providerRef: true, fileName: true, sentAt: true, integrationAccountId: true } as const
  const send = await caller.withClient(async (client) =>
    request.idempotencyKey && isUuid(request.idempotencyKey)
      ? client.sdiSubmission.findUnique({ where: { id: request.idempotencyKey }, select })
      : request.providerRef
        ? client.sdiSubmission.findFirst({ where: { providerRef: request.providerRef }, select })
        : null,
  )
  if (!send || send.providerRef === null || send.sentAt === null || !fakeRefParts(send.providerRef)) return null
  if (request.providerRef !== null && request.providerRef !== send.providerRef) return null
  return { providerRef: send.providerRef, fileName: send.fileName, acceptedAt: send.sentAt, accountId: send.integrationAccountId }
}
