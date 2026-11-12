import { chooseRules } from '@nexus/factory-domain/approvals/rules'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_DECIDE } from '@nexus/factory-domain/sales/returns/permissions'
import { CREDIT_WITHOUT_RETURN_EFFECT, CREDIT_WITHOUT_RETURN_STATUSES, creditWithoutReturnProblems, DEPTH_LIMITS } from '@nexus/factory-domain/sales/returns-depth/rules'
import type { ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { askApproval } from '../../../platform/approvals/engine'
import { kindOf } from '../../../platform/approvals/kinds'
import { CREDIT_WITHOUT_RETURN_RECORD, creditChanges, withAskedCredit } from '../../../platform/approvals/kinds/credit-without-return'
import { officeReturn } from '../returns/access'
import { lockReturn } from '../returns/rma'
import { currencyOf, LINE_COLUMNS, lineKeyOf, lineValue, soldFactsOf, type LineRow, type Reader } from '../returns/store'
import { creditWithoutReturnInCommand } from './credit-write'

/**
 * Credit without a return (B-W2b-341; SAL-342; design rma.credit "Credit without return (W2b, within the approval
 * limit)"): a line none of whose pieces arrived is credited CREDIT_ONLY and the goods stay with the customer (a jacket not
 * worth sending back, a courtesy for a small defect). Office only (sales.returns.decide over the RMA, the price grain for
 * the amount). Within the approval limit: an approval rule of kind CREDIT_WITHOUT_RETURN switched on (Admin › Automation ›
 * Approval rules) asks a yes first; without one (as on every tenant until the Owner sets one) the credit is written at
 * once. Nobody approves their own request.
 *
 *   POST …/:returnId/lines/:lineId/credit-without-return/preview  what it credits (at most what its pieces are worth),
 *                                                                  the problems, whether a yes is needed and from whom
 *   POST …/:returnId/lines/:lineId/credit-without-return          ONE command: the RMA locked at its version (AUTHORISED,
 *                                                                  RECEIVED or INSPECTED), the line checked, the yes asked
 *                                                                  (asked: the request waits, 202; not asked: credited,
 *                                                                  200; on the approver's yes the credit is written)
 *
 * No restocking or handling fee: nothing comes back to restock or handle.
 */

export interface CreditBody {
  readonly version: number
  /** Minor units (the price grain); left out: what the line's pieces are worth. */
  readonly creditAmount?: number | null | undefined
  /** Why the goods need not come back (the request's note for the approver). */
  readonly note?: string | null | undefined
}

interface LineFacts {
  readonly line: LineRow
  readonly value: number | null
  readonly currency: string | null
  readonly waiting: { readonly taskId: string; readonly requestedAt: Date } | null
}

async function lineFacts(db: Reader, returnId: string, lineId: string): Promise<LineFacts> {
  const line = isUuid(lineId) ? await db.returnLine.findFirst({ where: { id: lineId, returnId }, select: LINE_COLUMNS }) : null
  if (!line) throw new NotFoundError('Return line not found.')
  const sold = (await soldFactsOf(db, [line])).get(lineKeyOf(line))
  const task = await db.approvalTask.findFirst({ where: { kind: 'CREDIT_WITHOUT_RETURN', recordType: CREDIT_WITHOUT_RETURN_RECORD, recordId: line.id, status: 'PENDING' }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, requestedAt: true } })
  return { line, value: lineValue(sold, line.quantity), currency: currencyOf(sold), waiting: task ? { taskId: task.id, requestedAt: task.requestedAt } : null }
}

const problemsOf = (status: string, facts: LineFacts, creditAmount: number | undefined) =>
  creditWithoutReturnProblems({ status: status as ReturnStatus, seq: facts.line.seq, quantity: facts.line.quantity, received: facts.line.receivedQuantity, decided: facts.line.disposition !== null, value: facts.value, waiting: facts.waiting !== null }, creditAmount).map((problem) => ({ ...problem, path: `body/${problem.path}` }))

/** POST /sales/returns/:returnId/lines/:lineId/credit-without-return/preview */
export async function previewCreditWithoutReturn(caller: CommandCaller, returnId: string, lineId: string, body: Pick<CreditBody, 'creditAmount'>) {
  const { context, rma } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  return caller.withClient(async (client) => {
    const facts = await lineFacts(client, rma.id, lineId)
    const creditAmount = body.creditAmount ?? undefined
    const problems = problemsOf(rma.status, facts, creditAmount)
    const credit = creditAmount ?? facts.value ?? 0
    // Whether a rule switched on would ask a yes, and from whom (the engine's own choice, never the person asking).
    const kind = kindOf('CREDIT_WITHOUT_RETURN')
    let approval: { needed: boolean; approverRoleId: string | null; approverUserId: string | null; nobodyElse: boolean } = { needed: false, approverRoleId: null, approverUserId: null, nobodyElse: false }
    if (kind && problems.length === 0) {
      const subject = await withAskedCredit(facts.line.id, credit, () => kind.read(client, facts.line.id))
      const rules = await client.approvalRule.findMany({
        where: { kind: 'CREDIT_WITHOUT_RETURN', active: true, OR: [{ companyId: null }, { companyId: rma.companyId }] },
        select: { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true, signatureMeaning: true, requireStepUp: true, dueHours: true },
      })
      if (subject) {
        const choice = chooseRules(rules, { companyId: subject.companyId, facts: subject.facts, askers: [context.actorId] }, kind.fields, serverClock.now())
        approval = { needed: choice.matched.length > 0, approverRoleId: choice.deciding?.approverRoleId ?? null, approverUserId: choice.deciding?.approverUserId ?? null, nobodyElse: choice.matched.length > 0 && choice.deciding === null }
      }
    }
    return {
      ok: problems.length === 0,
      problems,
      lineId: facts.line.id,
      seq: facts.line.seq,
      pieces: facts.line.quantity,
      currency: facts.currency,
      value: asMoney('price', facts.value),
      creditAmount: asMoney('price', problems.length === 0 ? credit : null),
      effect: CREDIT_WITHOUT_RETURN_EFFECT,
      approval,
      waiting: facts.waiting ? { taskId: facts.waiting.taskId, requestedAt: facts.waiting.requestedAt.toISOString() } : null,
    }
  })
}

/** POST /sales/returns/:returnId/lines/:lineId/credit-without-return */
export async function creditWithoutReturn(caller: CommandCaller, returnId: string, lineId: string, body: CreditBody, idempotencyKey?: string) {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  const note = body.note?.trim() ? body.note.trim() : null
  if (note && note.length > DEPTH_LIMITS.reason) throw new ValidationError(`At most ${DEPTH_LIMITS.reason} characters.`, [{ path: 'body/note', message: `At most ${DEPTH_LIMITS.reason} characters.` }])
  const { result } = await command(caller, { name: 'returnsDepth.creditWithoutReturn', idempotencyKey, input: { returnId, lineId, ...body } }, async (tools) => {
    const { tx } = tools
    const tenantId = context.tenantId
    // The approval engine's lock of this subject first, then the RMA (the order the approver's command takes them in).
    if (isUuid(lineId)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.approvals', ${tenantId}::text, ${CREDIT_WITHOUT_RETURN_RECORD}::text, ${lineId}::text), 0))`
    const rma = await lockReturn(tools, seen.id, body.version, CREDIT_WITHOUT_RETURN_STATUSES, 'a line is credited without the goods')
    const facts = await lineFacts(tx, rma.id, lineId)
    const creditAmount = body.creditAmount ?? undefined
    const problems = problemsOf(rma.status, facts, creditAmount)
    if (problems.length > 0) {
      const words = problems.length === 1 ? problems[0]!.message : 'The line cannot be credited without the goods like this.'
      // An amount is the body's (400); a line decided, partly back or waiting for a yes is its state (409).
      throw problems.some((problem) => problem.path === 'body/creditAmount') ? new ValidationError(words, problems) : new DomainError('conflict', words, problems)
    }
    const credit = creditAmount ?? facts.value!
    const outcome = await withAskedCredit(facts.line.id, credit, () => askApproval(tools, { kind: 'CREDIT_WITHOUT_RETURN', recordId: facts.line.id, requester: { userId: context.actorId }, note, changes: creditChanges(credit) }))
    if (!outcome.asked) {
      await creditWithoutReturnInCommand(tools, { lineId: facts.line.id, creditAmount: credit, decidedById: context.actorId, taskId: null })
      return { credited: true, waiting: null }
    }
    return { credited: false, waiting: { taskId: outcome.taskId, approverRoleId: outcome.approverRoleId, approverUserId: outcome.approverUserId, dueAt: outcome.dueAt } }
  })
  return result
}
