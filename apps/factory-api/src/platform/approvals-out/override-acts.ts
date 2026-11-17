import type { FactoryClient } from '@nexus/factory-db'
import type { ApprovalKind, ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { decideForPartyProblems, decideForRefusal } from '@nexus/factory-domain/approvals-out/rules'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { OverrideOrder } from '@nexus/factory-domain/production-brand/override'
import type { CommandTools, CommandTx } from '../../core/command'
import { closeTasksInCommand } from '../portal/tasks/store'
import type { RecordAdapter } from './adapter'
import { adapterOf } from './records'
import { settleInCommand } from './settle'
import { lockRequest, RECORD, refOf, revokeLinksInCommand, sourceKeyOf, type PartnerRow } from './store'

/**
 * B-PR-30a (production plan §3 "Full control: decide for a brand or undo, always with a reason it reads", "No silent
 * decisions"; 08-backend §4.6; lead pick L6; Owner answer 11-10 Q3; rules factory-domain approvals-out/rules and
 * production-brand/override): what the office does FOR a customer on one of its approval requests, inside ONE command — the
 * route's own (./override.ts, at once) or the second person's yes (platform/approvals/kinds/brand-override.ts onApproved, while
 * the customer's overrideFourEyes is on). Both re-read and re-check the request under its lock; nothing here reads or names
 * another customer (every write is about the request's own party).
 *
 *   decide for   an OPEN request of a kind the office may decide (never a concession, a revised order, a signature or a
 *                proof), by an office person who did not ask it: the answer written as theirs (decidedForPartyById, the typed
 *                name, why the customer reads — no portal person, no link), its APPROVAL links revoked, the customer's task
 *                cancelled (it is no longer theirs to do), then the settle in the same command (./settle.ts settleInCommand:
 *                the record's consequence — a sample round or swatch decided as OFFICE by that person, so its gate passes by
 *                the round's event —, OUR message on the record's thread "Decided by us for you: …", the settle's marker);
 *                approval_request.decided_for_party
 * Each refusal is said in words with its code (409 `refusal/<CODE>`, 403 for the person who asked).
 */

type Client = FactoryClient | CommandTx

/** Throws a refusal in words with its code (the screens key on `refusal/<CODE>`). */
export function refuse(refusal: { readonly code: string; readonly message: string }, kind: 'conflict' | 'forbidden' = 'conflict'): never {
  throw new DomainError(kind, refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])
}

export const fail = (issues: readonly Issue[], what: string): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : what, [...issues])

/** The answer's evidence of an office decision (the office request's address hash and user agent; none on a second person's yes). */
export interface OverrideEvidence {
  readonly ipHash: string | null
  readonly userAgent: string | null
}

export type DecideForOrder = Extract<OverrideOrder, { act: 'DECIDE_FOR' }>

/** The asker of a request (the office person who asked the party; null for a request a job made). */
async function askerOf(tx: Client, requestId: string): Promise<string | null> {
  return (await tx.approvalRequest.findUnique({ where: { id: requestId }, select: { createdById: true } }))?.createdById ?? null
}

/** The request's adapter, or 404 (a kind nobody registered is never acted on: fail closed). */
function adapterFor(row: Pick<PartnerRow, 'kind' | 'recordType'>): RecordAdapter {
  const adapter = adapterOf(row.kind as ApprovalKind, row.recordType)
  if (!adapter) throw new NotFoundError('Approval request not found.')
  return adapter
}

// ---- decide for the party --------------------------------------------------------------------------------------------------

/** Decides the request for its party, in the command (the route's at once, or the second person's yes). */
export async function decideForPartyInCommand(
  tools: CommandTools,
  input: { readonly requestId: string; readonly version?: number | undefined; readonly deciderId: string; readonly order: DecideForOrder; readonly evidence: OverrideEvidence | null; readonly grantedById: string | null },
): Promise<{ readonly settled: boolean }> {
  const { tx, now } = tools
  const current = await lockRequest(tx, input.requestId, input.version)
  const kind = current.kind as ApprovalKind
  const status = current.status as ApprovalStatus
  const { order } = input
  const refusal = decideForRefusal({ kind, status, askedById: await askerOf(tx, current.id) }, input.deciderId)
  if (refusal) refuse(refusal, refusal.code === 'OWN_ASK' ? 'forbidden' : 'conflict')
  const problems = decideForPartyProblems({ kind, status, askedById: null }, { decision: order.decision, answer: order.answer, typedName: order.typedName, reason: order.reason }, input.deciderId)
  if (problems.length > 0) throw fail(problems, 'The decision is not complete.')
  const adapter = adapterFor(current)
  // The record moved on (a newer revision, decided meanwhile): nothing is decided for the party.
  const held = adapter.answerHeld ? await adapter.answerHeld(tx, refOf(current), 'en') : null
  if (held) refuse({ code: 'HELD', message: held })

  const answer = order.answer?.trim() ? order.answer.trim() : null
  const typedName = order.typedName.trim()
  const reason = order.reason.trim()
  const { count } = await tx.approvalRequest.updateMany({
    where: { id: current.id, status: 'OPEN', version: current.version },
    data: {
      status: order.decision,
      answer,
      typedName,
      markupFileId: null,
      answeredAt: now,
      answeredByUserId: null,
      answeredViaLinkId: null,
      decidedForPartyById: input.deciderId,
      decidedForPartyReason: reason,
      answerRequestId: tools.context.requestId,
      answerIpHash: input.evidence?.ipHash ?? null,
      answerUserAgent: input.evidence?.userAgent ?? null,
      version: current.version + 1,
      updatedAt: now,
    },
  })
  if (count !== 1) throw new InvalidStateError('This request changed meanwhile: read it again.')
  const revoked = await revokeLinksInCommand(tools, current, input.deciderId)
  // The customer's task is no longer theirs to do (an office "cancel"; the portal reads the decision on the request). A
  // concession's own answer (onAnswered) never comes here: nobody decides a concession for the customer.
  await closeTasksInCommand(tools, { recordType: RECORD, recordId: current.id, sourceKey: sourceKeyOf(current.id), status: 'CANCELLED', doneById: null })
  tools.audit({
    action: 'approvalsOut.decideForParty',
    recordType: RECORD,
    recordId: current.id,
    companyId: current.companyId,
    reason,
    before: { status: 'OPEN' },
    after: { status: order.decision, decidedForPartyById: input.deciderId, grantedById: input.grantedById, typedName, answered: answer !== null, linksRevoked: revoked.length },
  })
  tools.emit({ type: 'approval_request.decided_for_party', subject: current.id, companyId: current.companyId, payload: { requestId: current.id, kind, recordType: current.recordType, recordId: current.recordId, partyId: current.partyId, decision: order.decision } })
  const settled = await settleInCommand(tools, current.id)
  return { settled: settled.settled }
}
