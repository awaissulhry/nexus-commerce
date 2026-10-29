import { DomainError, ForbiddenError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { QUOTES_APPROVE, QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { approvalDetails, brokenReasons, piecesOf, STATUS_WORDS, submitBlockers, type ApprovalStatus, type QuoteVersionStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { fingerprintOf, refreshVersion, versionNow } from './pricing'
import { assertDraft, detailInCommand, onQuote, withdrawPending } from './quotes'
import { decimal, grainsOf, officeContextOf, officeQuote, readLineRecords, type QuoteRow, type VersionRow } from './store'
import { readFacts, type QuoteDetail } from './views'

/**
 * The approval of a quote version (B-W1-21; SAL-184, FIN-023; A1 §2.5 Quote; A2 SCR-035 "Ask for approval", "Approve or
 * reject quote"): asked only when a rule breaks (the margin under the floor, a discount over the limit), and only when
 * nothing blocks the quote (every line priced and costed, the customer quotable). Asking freezes the lines (the version
 * leaves DRAFT; the …_sales_guards triggers refuse any line change) and records exactly what is asked, with the
 * fingerprint of the priced content. An approver (quotes.approve over the quote's company and customer) decides it:
 * never the person who asked, and a request about the margin floor only with the margin grain (the decision rests on
 * the numbers). Approve → APPROVED (B-W1-24 sends it); reject (with a reason) → DRAFT. The office may reopen a waiting
 * or approved version (the request is withdrawn; a change asks again when a rule still breaks).
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

async function moveTo(tools: CommandTools, quote: QuoteRow, version: VersionRow, status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED'): Promise<void> {
  await tools.tx.quoteVersion.update({ where: { id: version.id }, data: { status, version: { increment: 1 } }, select: { id: true } })
  await tools.tx.quote.update({ where: { id: quote.id }, data: { status }, select: { id: true } })
}

/** quotes.manage: asks for an approval of the DRAFT version: the rules it breaks, in one request; its lines freeze. */
export async function askApproval(caller: CommandCaller, quoteId: string, body: { version: number; note?: string | null | undefined }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.askApproval', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    if (version.status === 'PENDING_APPROVAL') throw new InvalidStateError('An approval request is already waiting for a decision.')
    assertDraft(version)
    const { priced, lines } = await refreshVersion(tools, current, version, new Set())
    const facts = await readFacts(tools.tx, current, tools.now, { certificates: false })
    const blockers = submitBlockers(facts.issues)
    if (blockers.length > 0) {
      throw new DomainError('conflict', `The quote cannot go for approval yet. ${blockers.map((issue) => issue.message).join(' ')}`, blockers.map((issue) => ({ path: issue.path, message: issue.message })))
    }
    if (!priced.approvalNeeded) throw new DomainError('conflict', 'No rule needs an approval: the quote can be sent as it is.', [{ path: 'approval', message: 'No rule is broken.' }])
    const after = await versionNow(tools.tx, version.id)
    const details = approvalDetails(
      priced,
      lines.map((line) => ({ seq: line.seq, description: line.description, quantity: piecesOf(line.sizes), unitPrice: decimal(line.unitPrice)!, listUnitPrice: decimal(line.listUnitPrice) })),
      fingerprintOf(after, lines),
    )
    const approvalId = newId()
    const reasons = brokenReasons(priced.rules)
    await tools.tx.quoteApproval.create({
      data: { id: approvalId, versionId: version.id, partyId: current.partyId, reasons, details, requestNote: blankToNull(body.note), createdById: actorIdOf(tools) },
      select: { id: true },
    })
    await moveTo(tools, current, version, 'PENDING_APPROVAL')
    tools.audit({ action: 'quotes.askApproval', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { status: version.status }, after: { status: 'PENDING_APPROVAL', approvalId, reasons, note: blankToNull(body.note) } })
    tools.emit({ type: 'quote.approval_requested', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, approvalId, reasons } })
    return detailInCommand(tools, current.id)
  })
}

export interface Decision {
  readonly approvalId: string
  readonly approval: { readonly from: ApprovalStatus; readonly to: ApprovalStatus }
  readonly status: { readonly from: QuoteVersionStatus; readonly to: QuoteVersionStatus }
}

/**
 * The waiting request an approver may decide: not their own (403), about the margin floor only with the margin grain
 * (403), and the version still the content that was asked (409).
 */
async function decidable(tools: CommandTools, version: VersionRow) {
  const context = tools.context
  if (context.audience !== 'office') throw new ForbiddenError()
  if (version.status !== 'PENDING_APPROVAL') throw new InvalidStateError(`The quote is ${STATUS_WORDS[version.status]}: no approval request is waiting.`)
  const pending = await tools.tx.quoteApproval.findFirst({ where: { versionId: version.id, status: 'PENDING' }, select: { id: true, reasons: true, details: true, createdById: true } })
  if (!pending) throw new InvalidStateError('No approval request is waiting.')
  if (pending.createdById !== null && pending.createdById === context.actorId) throw new ForbiddenError('You asked for this approval: another approver decides.')
  if (pending.reasons.includes('MARGIN_FLOOR') && !grainsOf(context).has('margin')) throw new ForbiddenError('This request is about the margin floor: deciding it needs a role that sees margins.')
  const asked = (pending.details as { fingerprint?: unknown } | null)?.fingerprint
  if (asked !== fingerprintOf(version, await readLineRecords(tools.tx, version.id))) {
    throw new DomainError('conflict', 'The quote changed since the approval was asked: it is decided only as it was asked. Reopen it and ask again.')
  }
  return pending
}

/** quotes.approve: approves the waiting request (another person than the one who asked) → APPROVED. */
export async function approve(caller: CommandCaller, quoteId: string, body: { version: number; note?: string | null | undefined }, idempotencyKey?: string): Promise<{ quote: QuoteDetail; decision: Decision }> {
  officeContextOf(caller)
  const quote = await officeQuote(caller, quoteId, QUOTES_APPROVE)
  return onQuote(caller, quote, { name: 'quotes.approve', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const pending = await decidable(tools, version)
    await tools.tx.quoteApproval.update({ where: { id: pending.id }, data: { status: 'APPROVED', decidedAt: tools.now, decidedById: actorIdOf(tools), decisionNote: blankToNull(body.note), version: { increment: 1 } }, select: { id: true } })
    await moveTo(tools, current, version, 'APPROVED')
    tools.audit({ action: 'quotes.approve', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { status: 'PENDING_APPROVAL', approval: 'PENDING' }, after: { status: 'APPROVED', approvalId: pending.id, approval: 'APPROVED', note: blankToNull(body.note) } })
    tools.emit({ type: 'quote.approval_decided', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, approvalId: pending.id, status: 'APPROVED' } })
    const decision: Decision = { approvalId: pending.id, approval: { from: 'PENDING', to: 'APPROVED' }, status: { from: 'PENDING_APPROVAL', to: 'APPROVED' } }
    return { ...(await detailInCommand(tools, current.id)), decision }
  })
}

/** quotes.approve: rejects the waiting request with a reason → the version is a DRAFT again. */
export async function reject(caller: CommandCaller, quoteId: string, body: { version: number; reason: string }, idempotencyKey?: string): Promise<{ quote: QuoteDetail; decision: Decision }> {
  officeContextOf(caller)
  const quote = await officeQuote(caller, quoteId, QUOTES_APPROVE)
  return onQuote(caller, quote, { name: 'quotes.reject', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const pending = await decidable(tools, version)
    const reason = body.reason.trim()
    await tools.tx.quoteApproval.update({ where: { id: pending.id }, data: { status: 'REJECTED', decidedAt: tools.now, decidedById: actorIdOf(tools), decisionNote: reason, version: { increment: 1 } }, select: { id: true } })
    await moveTo(tools, current, version, 'DRAFT')
    tools.audit({ action: 'quotes.reject', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { status: 'PENDING_APPROVAL', approval: 'PENDING' }, after: { status: 'DRAFT', approvalId: pending.id, approval: 'REJECTED' }, reason })
    tools.emit({ type: 'quote.approval_decided', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, approvalId: pending.id, status: 'REJECTED' } })
    const decision: Decision = { approvalId: pending.id, approval: { from: 'PENDING', to: 'REJECTED' }, status: { from: 'PENDING_APPROVAL', to: 'DRAFT' } }
    return { ...(await detailInCommand(tools, current.id)), decision }
  })
}

/**
 * quotes.manage: a version waiting for approval (its request is withdrawn) or approved goes back to DRAFT for a change;
 * an approval is asked again if a rule still breaks.
 */
export async function reopen(caller: CommandCaller, quoteId: string, body: { version: number; reason?: string | null | undefined }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.reopen', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    if (version.status !== 'PENDING_APPROVAL' && version.status !== 'APPROVED') {
      throw new InvalidStateError(version.status === 'DRAFT' ? 'The quote is a draft already.' : `The quote is ${STATUS_WORDS[version.status]}: it is not reopened here.`)
    }
    const withdrawn = await withdrawPending(tools, version.id)
    await moveTo(tools, current, version, 'DRAFT')
    const reason = blankToNull(body.reason)
    tools.audit({ action: 'quotes.reopen', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { status: version.status }, after: { status: 'DRAFT', withdrawnApprovalId: withdrawn }, ...(reason ? { reason } : {}) })
    tools.emit({ type: 'quote.reopened', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, withdrawnApprovalId: withdrawn } })
    return detailInCommand(tools, current.id)
  })
}
