import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SIMULATED_MODES, simulatedMessages, testRefOf, type SimulatedOutcome } from '@nexus/factory-domain/invoicing/test-mode/test-mode'
import type { SdiSendReceipt, SdiSendRequest, SdiStatusAnswer, SdiStatusRequest } from '@nexus/factory-domain/ports/sdi'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { readSettings } from './store'

/**
 * The in-process answers of e-invoice test mode (B-W2b-401; FIN-096): the SDI runtime (sdi/runtime.ts) asks here before it
 * calls a company's intermediary. A company in test mode whose connection is LIVE or SANDBOX never reaches the intermediary:
 * the send gets a simulated receipt (its provider id marks it simulated for good, with the outcome chosen then), and its
 * status is SDI's simulated answer (factory-domain invoicing/test-mode). No gateway call, no IntegrationCall row: nothing
 * leaves the process. A FAKE connection is left to the fake intermediary.
 */

/** The outcome test mode simulates for a send through this account now, or null when the send goes to the account's adapter. */
export async function simulatedOutcomeFor(caller: CommandCaller, accountId: string): Promise<SimulatedOutcome | null> {
  if (!isUuid(accountId)) return null
  return caller.withClient(async (client) => {
    const account = await client.integrationAccount.findUnique({ where: { id: accountId }, select: { provider: true, mode: true, companyId: true } })
    if (!account || account.provider !== 'SDI' || account.companyId === null || !(SIMULATED_MODES as readonly string[]).includes(account.mode)) return null
    const settings = await readSettings(client, account.companyId)
    return settings.testMode ? settings.simulateOutcome : null
  })
}

/** The simulated receipt of a send: taken now, its provider id the send's own marked as simulated. */
export function simulatedReceipt(request: SdiSendRequest, outcome: SimulatedOutcome): SdiSendReceipt {
  return { providerRef: testRefOf(request.idempotencyKey, outcome), acceptedAt: toUtcIso(serverClock.now()), providerFileName: null }
}

/** What the simulation knows of a simulated send: the file, and SDI's simulated answer (the poll's view, as an intermediary's). */
export async function simulatedStatus(caller: CommandCaller, request: SdiStatusRequest): Promise<SdiStatusAnswer> {
  const send = isUuid(request.idempotencyKey) ? await caller.withClient((client) => client.sdiSubmission.findUnique({ where: { id: request.idempotencyKey }, select: { attempt: true, sentAt: true, createdAt: true } })) : null
  if (!send || request.providerRef === null) return { known: false, providerRef: null, acceptedAt: null, messages: [] }
  const acceptedAt = toUtcIso(send.sentAt ?? send.createdAt)
  return { known: true, providerRef: request.providerRef, acceptedAt, messages: simulatedMessages({ providerRef: request.providerRef, fileName: request.fileName, attempt: send.attempt, acceptedAt }) }
}
