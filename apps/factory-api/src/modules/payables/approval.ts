import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ForbiddenError, isDomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PAYABLES_APPROVE, PAYABLES_DIFFERENCES_ACCEPT, PAYABLES_MANAGE, PAYABLES_PAY } from '@nexus/factory-domain/payables/permissions'
import { actionProblems, approvalProblems, isTyped, type InvoiceKind, type InvoiceSource, type InvoiceStatus } from '@nexus/factory-domain/payables/rules'
import type { MatchStatus } from '@nexus/factory-domain/payables/match'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { honourPeriodLocks } from '../accounting/period-guard'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { closeClaimInCommand } from '../purchasing/claims/claims'
import { followInCommand } from '../../platform/threads/followers'
import { ensureThread, mentionProblems, writeMessage } from '../../platform/threads/threads'
import { detailInCommand, RefusedError } from './invoices'
import { rematchInCommand } from './matching'
import { invoiceInCommand, officeInvoice, officeOf, preparationOf, readLines, readMatches, RECORD, type InvoiceRow } from './store'
import type { DetailView } from './views'

/**
 * Approval and payment of supplier invoices (B-W2a-62; FIN-137; design finance.payables, record tabs Match ("Accept
 * difference with reason", "Send to buyer") and Approval ("You entered this invoice, so someone else approves it";
 * Approve · Reject with reason), the grid's bulk approve "separation of duties respected per row"). Office only; each
 * write is ONE command on the invoice. Separation of duties (four eyes, the lead's stricter rule of B-W2a-F7): the person
 * who registered an invoice (the …_money_w2a_guards hold this part too), mapped or matched one of its lines, or accepted
 * one of its differences never approves it (store.ts preparationOf); an invoice SDI delivered was registered by nobody of
 * the office, so its mapping and acceptances decide.
 */

const now = (): Date => serverClock.now()

async function approvalFacts(tools: Pick<CommandTools, 'tx'>, invoice: InvoiceRow) {
  const lines = await readLines(tools.tx, invoice.id)
  const matches = await readMatches(tools.tx, invoice.id)
  const { mappedByIds, acceptedByIds } = await preparationOf(tools.tx, invoice.id)
  return {
    number: invoice.number,
    status: invoice.status as InvoiceStatus,
    source: invoice.source as InvoiceSource,
    kind: invoice.kind as InvoiceKind,
    matchStatus: invoice.matchStatus as MatchStatus,
    createdById: invoice.createdById,
    mappedByIds,
    acceptedByIds,
    xmlFileId: invoice.xmlFileId,
    unaccepted: matches.filter((row) => !row.withinTolerance && row.acceptedAt === null).length,
    linesNet: isTyped(invoice.source as InvoiceSource) ? lines.reduce((total, line) => total + line.netAmount, 0) : null,
    netTotal: invoice.netTotal,
    lines: lines.length,
  }
}

/** payables.approve: approved for payment, once matched and every difference accepted, never by who prepared it. */
export async function approveInvoice(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const { context } = await officeInvoice(caller, invoiceId, PAYABLES_APPROVE)
  const { result } = await command(caller, { name: 'payables.approve', idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    const problems = approvalProblems(await approvalFacts(tools, invoice), context.actorId)
    if (problems.length > 0) throw new RefusedError(problems)
    const note = input.note?.trim() || null
    await tools.tx.supplierInvoice.update({ where: { id: invoiceId }, data: { status: 'APPROVED', approvedAt: tools.now, approvedById: context.actorId, approvalNote: note }, select: { id: true } })
    tools.audit({ action: 'payables.approve', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, before: { status: invoice.status }, after: { status: 'APPROVED', matchStatus: invoice.matchStatus, note } })
    tools.emit({ type: 'supplier_invoice.approved', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: 'APPROVED', matchStatus: invoice.matchStatus } })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

/**
 * payables.approve: several invoices at once (the grid's bulk approve): each is its own command and its own key, and
 * each answers approved or why not, in words (an invoice the person registered is refused, the others go on).
 */
export async function approveMany(caller: CommandCaller, input: { readonly items: readonly { readonly id: string; readonly version: number }[]; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  officeOf(caller)
  const results: { id: string; approved: boolean; status: InvoiceStatus | null; version: number | null; refusals: { code: string; message: string }[] }[] = []
  for (const [index, item] of input.items.entries()) {
    try {
      const { invoice } = await approveInvoice(caller, item.id, { version: item.version, note: input.note }, idempotencyKey ? `${idempotencyKey}:${index}` : undefined)
      results.push({ id: item.id, approved: true, status: invoice.status, version: invoice.version, refusals: [] })
    } catch (error) {
      if (!isDomainError(error)) throw error
      const refusals = error instanceof RefusedError ? error.issues.map((issue) => ({ code: issue.path.replace(/^refusal\//, ''), message: issue.message })) : [{ code: error.code.toUpperCase(), message: error.message }]
      results.push({ id: item.id, approved: false, status: null, version: null, refusals })
    }
  }
  return { results, approved: results.filter((row) => row.approved).length, refused: results.filter((row) => !row.approved).length }
}

/** payables.approve: the approval withdrawn before payment (back to received), with a reason. */
export async function withdrawApproval(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const { invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_APPROVE)
  const held = actionProblems({ number: seen.number, status: seen.status as InvoiceStatus, source: seen.source as InvoiceSource }).withdraw
  if (held) throw new RefusedError([{ code: 'NOT_APPROVED', message: held }])
  const { result } = await command(caller, { name: 'payables.withdrawApproval', idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    if (invoice.status !== 'APPROVED') throw new RefusedError([{ code: 'NOT_APPROVED', message: 'Only an approved invoice not paid yet has its approval withdrawn.' }])
    await tools.tx.supplierInvoice.update({ where: { id: invoiceId }, data: { status: 'RECEIVED', approvedAt: null, approvedById: null, approvalNote: null }, select: { id: true } })
    tools.audit({ action: 'payables.withdrawApproval', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, reason: input.reason.trim(), before: { status: 'APPROVED', approvedById: invoice.approvedById }, after: { status: 'RECEIVED' } })
    tools.emit({ type: 'supplier_invoice.approval_withdrawn', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: 'RECEIVED', matchStatus: invoice.matchStatus } })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

/** payables.pay: the payment recorded (the day the transfer left the bank and its reference); the proposal is W2b. */
export async function payInvoice(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly paidOn: string; readonly paymentRef: string; readonly periodLockOverride?: PeriodLockOverride | undefined }, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const { invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_PAY)
  const held = actionProblems({ number: seen.number, status: seen.status as InvoiceStatus, source: seen.source as InvoiceSource }).pay
  if (held) throw new RefusedError([{ code: 'NOT_APPROVED', message: held }])
  if (input.paidOn > businessDate(now())) throw new ValidationError('The payment is dated in the future.', [{ path: 'body/paidOn', message: 'Record a payment once the transfer left the bank.' }])
  const { result } = await command(caller, { name: 'payables.pay', idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    if (invoice.status !== 'APPROVED') throw new RefusedError([{ code: 'NOT_APPROVED', message: `Invoice ${invoice.number} is ${invoice.status.toLowerCase()}: an invoice is paid once approved.` }])
    if (input.paidOn < invoice.issueDate.toISOString().slice(0, 10)) throw new ValidationError('The payment is dated before the invoice.', [{ path: 'body/paidOn', message: 'Paid before it was issued.' }])
    await honourPeriodLocks(tools, [{ companyId: invoice.companyId, day: input.paidOn, refused: `the payment of supplier invoice ${invoice.number} on ${dayWords(input.paidOn)} is not recorded`, path: 'body/paidOn', record: { type: RECORD, id: invoiceId } }], input.periodLockOverride)
    await tools.tx.supplierInvoice.update({ where: { id: invoiceId }, data: { status: 'PAID', paidOn: new Date(`${input.paidOn}T00:00:00.000Z`), paymentRef: input.paymentRef.trim() }, select: { id: true } })
    tools.audit({ action: 'payables.pay', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, before: { status: 'APPROVED' }, after: { status: 'PAID', paidOn: input.paidOn, paymentRef: input.paymentRef.trim() } })
    tools.emit({ type: 'supplier_invoice.paid', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: 'PAID', matchStatus: invoice.matchStatus, paidOn: input.paidOn } })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

/** payables.differences.accept: a difference outside the tolerance accepted in words (the buyer's "yes, that was agreed"). */
export async function acceptDifference(caller: CommandCaller, invoiceId: string, matchId: string, input: { readonly version: number; readonly note: string }, idempotencyKey?: string): Promise<{ invoice: DetailView }> {
  const { context, invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_DIFFERENCES_ACCEPT)
  const held = actionProblems({ number: seen.number, status: seen.status as InvoiceStatus, source: seen.source as InvoiceSource }).map
  if (held) throw new RefusedError([{ code: 'NOT_OPEN', message: held }])
  const { result } = await command(caller, { name: 'payables.acceptDifference', idempotencyKey, input: { invoiceId, matchId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    const match = isUuid(matchId) ? await tools.tx.supplierInvoiceMatch.findUnique({ where: { id: matchId }, select: { id: true, invoiceId: true, withinTolerance: true, acceptedAt: true, invoiceLineId: true } }) : null
    if (!match || match.invoiceId !== invoiceId) throw new NotFoundError('Match not found.')
    if (match.withinTolerance) throw new RefusedError([{ code: 'WITHIN_TOLERANCE', message: 'This line matches within the tolerance: there is nothing to accept.' }])
    if (match.acceptedAt !== null) throw new RefusedError([{ code: 'ACCEPTED', message: 'This difference was accepted already.' }])
    await tools.tx.supplierInvoiceMatch.update({ where: { id: matchId }, data: { acceptedAt: tools.now, acceptedById: context.actorId, acceptNote: input.note.trim(), version: { increment: 1 } }, select: { id: true } })
    // An accepted wait for goods (paying ahead of the delivery) turns WAITING_GOODS into DIFFERENCES.
    const outcome = await rematchInCommand(tools, invoiceId)
    tools.audit({ action: 'payables.acceptDifference', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, reason: input.note.trim(), after: { matchId, invoiceLineId: match.invoiceLineId, matchStatus: outcome.matchStatus } })
    tools.emit({ type: 'supplier_invoice.difference_accepted', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: invoice.status, matchStatus: outcome.matchStatus, matchId } })
    return { invoice: await detailInCommand(tools, invoiceId) }
  })
  return result
}

/**
 * payables.manage: the differences sent to the buyer ("Differences go to the buyer before payment"): an internal note on
 * the invoice's thread that names each line outside the tolerance (no price: a note has no money grain) and mentions
 * the buyers who sent the orders, who then follow the invoice. A buyer who cannot read the invoice is not mentioned (the
 * answer names them).
 */
export async function sendToBuyer(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly message?: string | null | undefined }, idempotencyKey?: string) {
  const { context } = await officeInvoice(caller, invoiceId, PAYABLES_MANAGE)
  const { result } = await command(caller, { name: 'payables.sendToBuyer', idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const { tx } = tools
    const invoice = await invoiceInCommand(tx, invoiceId)
    const lines = await readLines(tx, invoiceId)
    const outside = (await readMatches(tx, invoiceId)).filter((row) => !row.withinTolerance)
    if (outside.length === 0) throw new RefusedError([{ code: 'NO_DIFFERENCES', message: 'Every matched line is within the tolerance: there is nothing to send to the buyer.' }])
    const orderLines = await tx.purchaseOrderLine.findMany({ where: { id: { in: outside.map((row) => row.purchaseOrderLineId).filter((value): value is string => value !== null) } }, select: { id: true, seq: true, uom: true, purchaseOrder: { select: { id: true, number: true, sentById: true, createdById: true } } } })
    const subcontracts = await tx.subcontractOrder.findMany({ where: { id: { in: outside.map((row) => row.subcontractOrderId).filter((value): value is string => value !== null) } }, select: { id: true, number: true, issuedById: true, createdById: true } })
    const said = outside.map((row) => {
      const line = lines.find((entry) => entry.id === row.invoiceLineId)!
      const order = orderLines.find((entry) => entry.id === row.purchaseOrderLineId)
      const subcontract = subcontracts.find((entry) => entry.id === row.subcontractOrderId)
      const where = order ? `${order.purchaseOrder.number} line ${order.seq}` : subcontract ? subcontract.number : 'its order'
      const quantity = row.invoicedQuantity.equals(row.receivedQuantity) ? '' : `, invoiced ${row.invoicedQuantity.toString()} against ${row.receivedQuantity.toString()} ${order?.uom ?? 'pieces'} received and not billed yet`
      const price = row.invoicedUnitPrice.greaterThan(row.orderedUnitPrice) ? ', at a price above the order’s' : ''
      return `Line ${line.seq} (${line.description.slice(0, 80)}) on ${where}${quantity}${price}${row.acceptedAt ? ' (accepted)' : ''}.`
    })
    const candidates = [...new Set([...orderLines.map((entry) => entry.purchaseOrder.sentById ?? entry.purchaseOrder.createdById), ...subcontracts.map((entry) => entry.issuedById ?? entry.createdById)].filter((value): value is string => value !== null && value !== context.actorId))]
    const { thread } = await ensureThread(tools, { type: RECORD, id: invoiceId }, context.actorId)
    if (thread.status !== 'OPEN') throw new RefusedError([{ code: 'THREAD_CLOSED', message: "The invoice's thread is closed; reopen it to send the differences." }])
    const problems = await mentionProblems(tx, context, thread, candidates, tools.now)
    const unreachable = new Set(problems.map((issue) => candidates[Number.parseInt(issue.path.split('/').pop()!, 10)]!))
    const mentions = candidates.filter((id) => !unreachable.has(id))
    const author = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
    const body = cleanBody(
      [`Supplier invoice ${invoice.number}: ${outside.length === 1 ? 'a difference' : `${outside.length} differences`} with the order${outside.length === 1 ? '' : 's'} to check before payment.`, ...said, input.message?.trim() ? `\n${input.message.trim()}` : '']
        .filter((part) => part !== '')
        .join('\n'),
    )
    await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: context.actorId, name: author?.displayName ?? null }, bodyText: body, mentions })
    for (const userId of mentions) await followInCommand(tools, { type: RECORD, id: invoiceId, companyId: invoice.companyId, siteId: null }, userId, 'MENTIONED', context.actorId)
    tools.audit({ action: 'payables.sendToBuyer', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, after: { differences: outside.length, mentioned: mentions, notReached: [...unreachable] } })
    tools.emit({ type: 'supplier_invoice.sent_to_buyer', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: invoice.status, matchStatus: invoice.matchStatus, mentioned: mentions.length } })
    return { invoice: await detailInCommand(tools, invoiceId), mentioned: mentions, notReached: [...unreachable] }
  })
  return result
}

/**
 * payables.manage + purchasing.claims.manage: the supplier's credit note settles a supplier claim (B-W2a-44's hook
 * closeClaimInCommand): the claim of the same supplier and company, accepted for a credit, is closed in the same command
 * with the credit note named in its note. A CREDIT_NOTE only, not voided.
 */
export async function settleClaim(caller: CommandCaller, invoiceId: string, input: { readonly version: number; readonly claimId: string }, idempotencyKey?: string) {
  const { context, invoice: seen } = await officeInvoice(caller, invoiceId, PAYABLES_MANAGE)
  if (seen.kind !== 'CREDIT_NOTE') throw new RefusedError([{ code: 'NOT_A_CREDIT_NOTE', message: 'A claim is settled by the supplier’s credit note: this is an invoice.' }])
  if (seen.status === 'VOIDED') throw new RefusedError([{ code: 'VOIDED', message: 'A voided credit note settles nothing.' }])
  const claim = isUuid(input.claimId) ? await caller.withClient((client) => client.supplierClaim.findUnique({ where: { id: input.claimId }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true, status: true, remedy: true } })) : null
  if (!claim || !can(actorOf(context), 'purchasing.view', { companyId: claim.companyId, siteId: claim.siteId, partyId: claim.partyId })) throw new NotFoundError('Supplier claim not found.')
  if (!can(actorOf(context), PURCHASING_CLAIMS_MANAGE, { companyId: claim.companyId, siteId: claim.siteId, partyId: claim.partyId })) throw new ForbiddenError()
  if (claim.partyId !== seen.partyId || claim.companyId !== seen.companyId) throw new RefusedError([{ code: 'OTHER_SUPPLIER', message: `Claim ${claim.number} is of another supplier or company.` }])
  if (claim.status !== 'ACCEPTED' || claim.remedy !== 'CREDIT') throw new RefusedError([{ code: 'NOT_ACCEPTED_FOR_CREDIT', message: `Claim ${claim.number} is ${claim.status.toLowerCase()}${claim.remedy ? ` for a ${claim.remedy.toLowerCase()}` : ''}: a credit note settles a claim the supplier accepted for a credit.` }])
  const { result } = await command(caller, { name: 'payables.settleClaim', idempotencyKey, input: { invoiceId, ...input }, record: { type: 'SupplierInvoice', id: invoiceId, expectedVersion: input.version } }, async (tools) => {
    const invoice = await invoiceInCommand(tools.tx, invoiceId)
    await closeClaimInCommand(tools, claim.id, `Credit note ${invoice.number} of ${dayWords(invoice.issueDate.toISOString().slice(0, 10))} settles it.`)
    tools.audit({ action: 'payables.settleClaim', recordType: RECORD, recordId: invoiceId, companyId: invoice.companyId, after: { supplierClaimId: claim.id, claimNumber: claim.number } })
    tools.emit({ type: 'supplier_invoice.claim_settled', subject: invoiceId, companyId: invoice.companyId, payload: { supplierInvoiceId: invoiceId, partyId: invoice.partyId, status: invoice.status, matchStatus: invoice.matchStatus, supplierClaimId: claim.id } })
    return { invoice: await detailInCommand(tools, invoiceId), claim: { id: claim.id, number: claim.number, status: 'CLOSED' as const } }
  })
  return result
}

