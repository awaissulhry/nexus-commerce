import { InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import type { CommandTools } from '../../../core/command'
import { askApproval, withdrawPending } from '../../../platform/approvals/engine'
import type { CountRow, LineRow } from '../counts/store'
import { ownVarianceRefusals, varianceRequestOf, waitingWords } from './reads'
import { tenantOf } from './store'

/**
 * Recount and approval (B-W2b-299; SCM-229): the count's differences asked a yes from the approval engine (kind
 * COUNT_VARIANCE, platform/approvals/kinds/count-variance.ts) when an approval rule the Owner switched on holds for them (no
 * rule is on until the Owner sets one: then the count is approved as W2a approves it). Called inside the counts' own
 * commands (../counts/counts.ts, each call in its own line marked B-W2b-299):
 *
 *   askVarianceInCommand       the submit: a rule that holds asks the yes (the submitter asks; a rule naming them is skipped)
 *   refuseWhileInApprovals     the counts' own approve and apply wait while the request is pending (the yes is given in
 *                              Approvals, where the engine re-reads the count and the counter rule holds)
 *   withdrawVarianceInCommand  a send back or a cancel takes the pending request back
 *   ownVarianceInCommand       the counts' own approve: the counter-not-approver rule as the warehouse rules hold it
 */

class CountHeldError extends InvalidStateError {
  override name = 'CountHeldError'
  override readonly issues: readonly Issue[]
  constructor(message: string, code: string) {
    super(message)
    this.issues = [{ path: `problem/${code}`, message }]
  }
}

/** The submit's ask (the count is SUBMITTED in this command): asked or not, as the rules say. */
export async function askVarianceInCommand(tools: CommandTools, count: CountRow, requesterId: string): Promise<boolean> {
  const outcome = await askApproval(tools, { kind: 'COUNT_VARIANCE', recordId: count.id, requester: { userId: requesterId } })
  return outcome.asked
}

/** While a COUNT_VARIANCE request waits, the count is approved only in Approvals (and applied once approved). */
export async function refuseWhileInApprovals(tools: Pick<CommandTools, 'tx'>, count: CountRow): Promise<void> {
  const request = await varianceRequestOf(tools.tx, count.id)
  if (request?.status !== 'PENDING') return
  throw new CountHeldError(await waitingWords(tools.tx, request, count.number), 'IN_APPROVALS')
}

/** A send back or a cancel: the pending request is taken back by the person (the engine's line and event). */
export async function withdrawVarianceInCommand(tools: CommandTools, count: CountRow, byId: string, words: string): Promise<void> {
  await withdrawPending(tools, { kind: 'COUNT_VARIANCE', recordId: count.id, byId, words: words.slice(0, 500) })
}

/** The counts' own approve: who counted, recounted or scanned a line that differs never approves it, while the switch is on. */
export async function ownVarianceInCommand(tools: CommandTools, count: CountRow, lines: readonly LineRow[], approverId: string) {
  return ownVarianceRefusals(tools.tx, tenantOf(tools.context), count, lines, approverId, count.approvalRequired)
}
