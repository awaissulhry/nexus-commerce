import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { newId } from '@nexus/factory-domain/core/ids'
import { PAYMENTS_BANK_MATCH, PAYMENTS_BANK_VIEW } from '@nexus/factory-domain/payments/bank/permissions'
import { sameSuggestion, suggest, type LineFacts, type MatchFacts } from '@nexus/factory-domain/payments/matching/match'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { officeContextOf } from '../store'
import { matchFacts } from './facts'

/**
 * The suggested matches of a company's bank lines (B-W2b-393; FIN-132; design finance.bank live "finance.payment.recorded
 * / .allocated → Suggestions drop items already paid"). A suggestion is a BankMatch row nobody accepted; it is kept while
 * the matcher still finds it exactly (what it names, how sure, why), deleted when it no longer holds, and a new one is
 * inserted when the matcher finds it. Only the lines nobody matched yet (no live acceptance) are looked at.
 *
 *   in a command   refreshSuggestions(tools, companyId, lineIds?): the import (its new lines), an acceptance or a
 *                  reversal (the lines whose suggestions named the same items), the route below
 *   worker         `payments.bankSuggestions` on payment.recorded | allocated | allocation_reversed | voided,
 *                  invoice.issued, deposit_request.created(_for_order) | waived: the event's company, as the system
 *   route          POST /payments/bank/suggestions/refresh {companyId} (payments.bank.match): look again now
 *
 * One advisory lock per company ('factory.bank-match') orders refreshes and acceptances, so a refresh never deletes the
 * suggestion a person is accepting. Each line whose suggestions changed gets an audit row (codes and ids, no money), and
 * one bank_line.suggestions_changed event names the lines (at most 500 per event).
 */

/** The company's matching lock (a transaction advisory lock). */
export async function lockMatching(tx: CommandTx, context: RequestContext, companyId: string): Promise<void> {
  if (context.audience === 'platform') throw new ForbiddenError()
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bank-match'::text, ${context.tenantId}::uuid, ${companyId}::uuid), 0))`
}

const LINE_FACTS = { id: true, amount: true, currency: true, bankReference: true, referenceText: true, counterpartyName: true, counterpartyIban: true } as const

/** Inside a command: the suggestions of the company's open lines (or of these), refreshed. Answers the lines changed. */
export async function refreshSuggestions(tools: CommandTools, companyId: string, lineIds?: readonly string[], facts?: MatchFacts): Promise<string[]> {
  const { tx } = tools
  await lockMatching(tx, tools.context, companyId)
  if (lineIds !== undefined && lineIds.length === 0) return []
  const lines: LineFacts[] = await tx.bankLine.findMany({
    where: { companyId, ...(lineIds ? { id: { in: [...lineIds] } } : {}), matches: { none: { acceptedAt: { not: null }, reversedAt: null } } },
    select: LINE_FACTS,
    orderBy: [{ bookedOn: 'asc' }, { id: 'asc' }],
  })
  if (lines.length === 0) return []
  const kept = await tx.bankMatch.findMany({ where: { bankLineId: { in: lines.map((line) => line.id) }, acceptedAt: null }, select: { id: true, bankLineId: true, partyId: true, invoiceIds: true, depositRequestIds: true, paymentId: true, supplierInvoiceId: true, confidence: true, reasons: true } })
  const known = facts ?? (await matchFacts(tx, companyId))
  const changed: string[] = []
  let added = 0
  let removed = 0
  for (const line of lines) {
    const found = suggest(line, known)
    const mine = kept.filter((row) => row.bankLineId === line.id)
    const gone = mine.filter((row) => !found.some((suggestion) => sameSuggestion(suggestion, row)))
    const fresh = found.filter((suggestion) => !mine.some((row) => sameSuggestion(suggestion, row)))
    if (gone.length === 0 && fresh.length === 0) continue
    if (gone.length > 0) await tx.bankMatch.deleteMany({ where: { id: { in: gone.map((row) => row.id) }, acceptedAt: null } })
    for (const suggestion of fresh) {
      await tx.bankMatch.create({
        data: {
          id: newId(),
          companyId,
          bankLineId: line.id,
          partyId: suggestion.partyId,
          invoiceIds: [...suggestion.invoiceIds],
          depositRequestIds: [...suggestion.depositRequestIds],
          paymentId: suggestion.paymentId,
          supplierInvoiceId: suggestion.supplierInvoiceId,
          confidence: suggestion.confidence,
          reasons: [...suggestion.reasons],
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
        },
        select: { id: true },
      })
    }
    added += fresh.length
    removed += gone.length
    changed.push(line.id)
    tools.audit({
      action: 'payments.bank.suggest',
      recordType: 'BankLine',
      recordId: line.id,
      companyId,
      after: { suggestions: found.map((suggestion) => ({ partyId: suggestion.partyId, confidence: suggestion.confidence, reasons: suggestion.reasons, items: suggestion.invoiceIds.length + suggestion.depositRequestIds.length, paymentId: suggestion.paymentId, supplierInvoiceId: suggestion.supplierInvoiceId })) },
    })
  }
  for (let start = 0; start < changed.length; start += 500) {
    const chunk = changed.slice(start, start + 500)
    tools.emit({ type: 'bank_line.suggestions_changed', subject: chunk[0]!, companyId, payload: { bankLineIds: chunk, added: start === 0 ? added : 0, removed: start === 0 ? removed : 0 } })
  }
  return changed
}

/** The open lines whose suggestions name one of these items or payments (to look at again after they changed). */
export async function linesNaming(tx: CommandTx, companyId: string, names: { readonly invoiceIds?: readonly string[]; readonly depositRequestIds?: readonly string[]; readonly paymentIds?: readonly string[] }): Promise<string[]> {
  const or = [
    ...(names.invoiceIds && names.invoiceIds.length > 0 ? [{ invoiceIds: { hasSome: [...names.invoiceIds] } }] : []),
    ...(names.depositRequestIds && names.depositRequestIds.length > 0 ? [{ depositRequestIds: { hasSome: [...names.depositRequestIds] } }] : []),
    ...(names.paymentIds && names.paymentIds.length > 0 ? [{ paymentId: { in: [...names.paymentIds] } }] : []),
  ]
  if (or.length === 0) return []
  const rows = await tx.bankMatch.findMany({ where: { companyId, acceptedAt: null, OR: or }, select: { bankLineId: true } })
  return [...new Set(rows.map((row) => row.bankLineId))]
}

/** POST /payments/bank/suggestions/refresh (payments.bank.match): look at the company's open lines again now. */
export async function refreshRoute(caller: CommandCaller, body: { readonly companyId: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), PAYMENTS_BANK_VIEW, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
  if (!can(actorOf(context), PAYMENTS_BANK_MATCH, { companyId: body.companyId })) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'payments.bank.suggest', idempotencyKey, input: body }, async (tools) => {
    const changed = await refreshSuggestions(tools, body.companyId)
    // Every command records at least one audit row: an unchanged look says so on the company.
    if (changed.length === 0) tools.audit({ action: 'payments.bank.suggest', recordType: 'Company', recordId: body.companyId, companyId: body.companyId, after: { changed: 0 } })
    return { companyId: body.companyId, changed: changed.length }
  })
  return result
}

/** What makes the suggestions of a company's lines change. */
const SUGGESTION_EVENTS = ['payment.recorded', 'payment.allocated', 'payment.allocation_reversed', 'payment.voided', 'invoice.issued', 'deposit_request.created', 'deposit_request.created_for_order', 'deposit_request.waived'] as const

/** The worker's handler: the event's company, as the system; nothing is written when nothing changed. */
export function suggestionHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'payments.bankSuggestions',
      events: [...SUGGESTION_EVENTS],
      async handle(event, tools) {
        const companyId = event.companyId
        if (!companyId) return
        const open = await tools.caller.withClient((client) => client.bankLine.count({ where: { companyId, matches: { none: { acceptedAt: { not: null }, reversedAt: null } } } }))
        if (open === 0) return
        const facts = await tools.caller.withClient((client) => matchFacts(client, companyId))
        const lines = await tools.caller.withClient((client) =>
          client.bankLine.findMany({ where: { companyId, matches: { none: { acceptedAt: { not: null }, reversedAt: null } } }, select: { ...LINE_FACTS, matches: { where: { acceptedAt: null }, select: { partyId: true, invoiceIds: true, depositRequestIds: true, paymentId: true, supplierInvoiceId: true, confidence: true, reasons: true } } } }),
        )
        // Only a command when something would change (handlers run often; the command repeats the look under the lock).
        if (lines.every((line) => { const found = suggest(line, facts); return found.length === line.matches.length && found.every((suggestion) => line.matches.some((row) => sameSuggestion(suggestion, row))) })) return
        await command(tools.caller, { name: 'payments.bank.suggest', input: { companyId, eventId: event.eventId }, causationId: event.eventId }, async (inside) => {
          const changed = await refreshSuggestions(inside, companyId)
          if (changed.length === 0) inside.audit({ action: 'payments.bank.suggest', recordType: 'Company', recordId: companyId, companyId, after: { changed: 0 } })
          return { changed: changed.length }
        })
      },
    }),
  ]
}
