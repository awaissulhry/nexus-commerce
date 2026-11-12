import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { finishProblems, finishStateHeld, finishWordsOf, type FinishReason } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import { OPEN_RETURN_STATUSES, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller } from '../../../core/command'
import { officeReturn } from '../returns/access'
import { lockReturn, touchReturn } from '../returns/rma'
import { closeWarningsFor, liveRepairsByLine, readLines } from '../returns/store'
import { finishFactsOf, outcomesOf, type OutcomesView } from './outcomes'

/**
 * Close with a finish reason (B-W2b-346; SAL-360; design returns.close "Finish reason (required)"). Office only
 * (sales.returns.manage over the RMA). `POST /sales/returns/:returnId/finish` {version, finishReason, reason?} — ONE
 * command: the RMA row locked at the version read (W2a's lockReturn), AUTHORISED, RECEIVED or INSPECTED with every received
 * line decided (409 in words); the reason must fit what the RMA's facts carry (factory-domain finishReasonHeld: credited
 * without a return needs such a line, returned unchanged a line sent back, the goods not received a piece that never
 * came, completed a decided line, the customer withdrew no credit given; 400 at body/finishReason), OTHER says why in
 * `reason`. CLOSED with closedAt, the finish reason and its words (statusReason: what was typed, else the reason's words)
 * in the SAME update (the …_service_safety_w2b_guards guard: a finish reason only with CLOSED; W2a freezes a closed RMA).
 * What the close still leaves open is answered as W2a's warnings (a replacement order, a return DDT, a repair order).
 * Events W2a's return.status_changed (to CLOSED) and return.finished. W2a's `POST …/close` (no finish reason) stays for
 * the screens that call it until they move here (B-W2b-352).
 */

export interface FinishBody {
  readonly version: number
  readonly finishReason: FinishReason
  readonly reason?: string | null | undefined
}

export async function finishReturn(caller: CommandCaller, returnId: string, body: FinishBody, idempotencyKey?: string): Promise<{ return: OutcomesView; warnings: Issue[] }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const { result } = await command(caller, { name: 'returnsOutcomes.finish', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, OPEN_RETURN_STATUSES, 'it is closed')
    const lines = await readLines(tx, rma.id)
    const facts = finishFactsOf(rma, lines, now)
    const held = finishStateHeld(facts)
    if (held) throw new InvalidStateError(`Return ${rma.number} cannot be closed now: ${held}`)
    const problems = finishProblems(body.finishReason, body.reason, facts)
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The return cannot be closed like this.', problems)
    const liveDdt = (await tx.ddt.count({ where: { sourceType: 'ReturnAuthorisation', sourceId: rma.id, cancellations: { none: {} } } })) > 0
    const warnings: Issue[] = closeWarningsFor(lines, await liveRepairsByLine(tx, lines.map((line) => line.id)), liveDdt).map((warning) => ({ path: warning.path, message: warning.message }))
    const words = finishWordsOf(body.finishReason, body.reason)
    await touchReturn(tools, rma, { status: 'CLOSED', closedAt: now, statusReason: words, finishReason: body.finishReason })
    tools.audit({
      action: 'returnsOutcomes.finish',
      recordType: 'ReturnAuthorisation',
      recordId: rma.id,
      companyId: rma.companyId,
      siteId: rma.siteId,
      before: { status: rma.status },
      after: { status: 'CLOSED', closedAt: toUtcIso(now), finishReason: body.finishReason, received: lines.reduce((sum, line) => sum + line.receivedQuantity, 0), warnings: warnings.length },
      reason: words,
    })
    const from = rma.status as Extract<ReturnStatus, 'AUTHORISED' | 'RECEIVED' | 'INSPECTED'>
    tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from, to: 'CLOSED' } })
    tools.emit({ type: 'return.finished', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, finishReason: body.finishReason, from } })
    return { warnings }
  })
  return { return: await outcomesOf(caller, seen.id), warnings: result.warnings }
}
