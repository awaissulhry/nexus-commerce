import { depositDueDaysFor } from '../terms/store'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { acceptanceMail, quoteDocumentNumber } from '@nexus/factory-domain/sales/quotes/document'
import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { sendEmail } from '../../../platform/email-out/outbound'
import { depositOfVersion, depositViewOf, instructionsFor, requestDepositInCommand, type DepositView } from '../deposits/deposits'
import { makeOrderInCommand, type OrderWait } from '../orders/make'
import { quotePartyOf } from './store'

/**
 * What follows an acceptance (B-W1-24; SAL-093, SAL-195, FIN-066; PLAN §4.7 06a-accept → 06b-deposit → 07-order). The
 * accept itself is the link session's ONE command (quotes/accept.ts: the version and quote ACCEPTED, the evidence, the
 * event quote.accepted), in the customer's partner scope, which may not write a deposit request, an order or a mail.
 * Right after it, in the same request, the tenant's system context (the office role) runs:
 *
 *   1. `quotes.afterAccept` (idempotency key `accepted-<versionId>`): the version's row locked, its deposit request made
 *      OPEN when it asks one (sales/deposits), then the sales order made from the ACCEPTED version (B-W1-25,
 *      sales/orders/make: numbered from the company's SALES_ORDER series, its lines, prices, costs, dates and addresses
 *      as accepted) and named on the deposit request, in this command, so the order and the deposit request appear at the
 *      same moment (the design; Owner answer S1). A company without an active SALES_ORDER series still gets its deposit
 *      request; the audit row says the order waits, and the office makes it (POST /sales/orders) once a series exists;
 *   2. `quotes.confirmAccept` (key `accepted-mail-<versionId>`): the confirmation on the quote's thread, with the accepted
 *      PDF and the deposit's payment instructions (Codice del Consumo art. 51 c.7: the contract confirmed on a durable
 *      medium), sent by the worker like any record mail.
 *
 * Each runs once per version, whoever runs it: the worker's handler `sales.afterAcceptance` (on quote.accepted) is the
 * backstop when the request ended between the commands; their idempotency keys make the second run answer the first's.
 */

export interface AcceptedIds {
  readonly quoteId: string
  readonly versionId: string
}

const VERSION_FACTS = { id: true, quoteId: true, partyId: true, revision: true, status: true, currency: true, language: true, depositPct: true, depositKind: true, depositAmount: true, documentSha256: true, sentById: true, paymentTermsId: true } as const

export interface AfterAccept {
  readonly deposit: DepositView | null
  /** The order made from the version (now or by an earlier run); null while it waits (`orderWaits`). */
  readonly order: { readonly id: string; readonly number: string } | null
  readonly orderWaits: OrderWait | null
}

/** Step 1: the deposit request and the order of an accepted version. */
export async function afterAccept(caller: CommandCaller, ids: AcceptedIds, causationId?: string): Promise<AfterAccept> {
  const { result } = await command(caller, { name: 'quotes.afterAccept', idempotencyKey: `accepted-${ids.versionId}`, input: ids, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const { tx } = tools
    // One at a time per version: the deposit (and the order) are made once.
    await tx.$queryRaw`SELECT id FROM "QuoteVersion" WHERE id = ${ids.versionId}::uuid FOR UPDATE`
    const version = await tx.quoteVersion.findUnique({ where: { id: ids.versionId }, select: VERSION_FACTS })
    if (!version || version.quoteId !== ids.quoteId) throw new DomainError('not_found', 'Quote version not found.')
    if (version.status !== 'ACCEPTED') throw new InvalidStateError(`The quote version is ${version.status}, not accepted.`)
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: ids.quoteId }, select: { companyId: true } })
    const acceptance = await tx.quoteAcceptance.findFirstOrThrow({ where: { versionId: version.id }, select: { acceptedAt: true } })
    const party = await quotePartyOf(tx, version.partyId, businessDate(acceptance.acceptedAt), acceptance.acceptedAt)
    const deposit = await requestDepositInCommand(
      tools,
      {
        id: version.id,
        quoteId: ids.quoteId,
        companyId: quote.companyId,
        partyId: version.partyId,
        currency: version.currency,
        depositPct: version.depositPct === null ? null : version.depositPct.toString(),
        depositKind: version.depositKind,
        depositAmount: version.depositAmount,
        acceptedOn: businessDate(acceptance.acceptedAt),
        // B-W2a-19: due after the days its payment terms' order instalment says (the PDF printed the same), else 7.
        depositDueDays: await depositDueDaysFor(tx, version.paymentTermsId),
      },
      party?.profile ?? null,
    )
    const made = await makeOrderInCommand(tools, version.id)
    tools.audit({
      action: 'quotes.afterAccept',
      recordType: 'Quote',
      recordId: ids.quoteId,
      companyId: quote.companyId,
      after: { versionId: version.id, depositRequestId: deposit?.row.id ?? null, depositCreated: deposit?.created ?? false, orderId: made.order?.id ?? null, orderCreated: made.created, orderWaits: made.waits },
    })
    // The request as it is now (the order just named on it).
    const request = deposit ? ((await depositOfVersion(tx, version.id)) ?? deposit.row) : null
    return { deposit: request ? depositViewOf(request) : null, order: made.order, orderWaits: made.waits }
  })
  return result
}

/** Step 2: the confirmation mail of an accepted version, with its PDF and the deposit's instructions. */
export async function confirmAccept(caller: CommandCaller, ids: AcceptedIds, causationId?: string): Promise<{ outboundId: string | null }> {
  const { result } = await command(caller, { name: 'quotes.confirmAccept', idempotencyKey: `accepted-mail-${ids.versionId}`, input: ids, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const { tx } = tools
    const version = await tx.quoteVersion.findUnique({ where: { id: ids.versionId }, select: VERSION_FACTS })
    if (!version || version.status !== 'ACCEPTED') throw new InvalidStateError('The quote version is not accepted.')
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: ids.quoteId }, select: { companyId: true, number: true, contactId: true } })
    const acceptance = await tx.quoteAcceptance.findFirstOrThrow({ where: { versionId: version.id }, select: { signerName: true, acceptedAt: true } })
    const contact = quote.contactId ? await tx.partyContact.findUnique({ where: { id: quote.contactId }, select: { email: true } }) : null
    const link = await tx.quoteAcceptance.findFirst({ where: { versionId: version.id }, select: { link: { select: { email: true } } } })
    const to = link?.link?.email ?? contact?.email ?? null
    const language = version.language === 'en' ? 'en' : 'it'
    const number = quoteDocumentNumber(quote.number, version.revision)
    const deposit = await depositOfVersion(tx, version.id)
    const depositText = deposit ? (await instructionsFor(tx, deposit, number, language)).text : null
    const file = version.documentSha256 ? await tx.storedFile.findFirst({ where: { recordType: 'Quote', recordId: ids.quoteId, sha256: version.documentSha256, status: 'AVAILABLE' }, select: { id: true } }) : null
    const sender = version.sentById ? await tx.user.findUnique({ where: { id: version.sentById }, select: { id: true, displayName: true, email: true } }) : null
    if (!to || !sender) {
      tools.audit({ action: 'quotes.confirmAccept', recordType: 'Quote', recordId: ids.quoteId, companyId: quote.companyId, after: { versionId: version.id, mailed: false, why: !to ? 'no address' : 'no sender' } })
      return { outboundId: null }
    }
    const mail = acceptanceMail({ language, number, acceptedAt: acceptance.acceptedAt, timeZone: 'Europe/Rome', signerName: acceptance.signerName, depositText })
    const sent = await sendEmail(tools, {
      record: { type: 'Quote', id: ids.quoteId },
      sender: { userId: sender.id, name: sender.displayName, email: sender.email },
      to: [to],
      subject: mail.subject,
      body: mail.body,
      attachments: file ? [file.id] : [],
      locale: language,
    })
    tools.audit({ action: 'quotes.confirmAccept', recordType: 'Quote', recordId: ids.quoteId, companyId: quote.companyId, after: { versionId: version.id, mailed: true, outboundId: sent.outbound.id, at: toUtcIso(tools.now) } })
    return { outboundId: sent.outbound.id }
  })
  return result
}

/** Both steps; a failure of the mail never undoes the deposit or the order. Returns the deposit request and the order. */
export async function afterAcceptance(caller: CommandCaller, ids: AcceptedIds, causationId?: string): Promise<AfterAccept & { mailed: boolean }> {
  const done = await afterAccept(caller, ids, causationId)
  let mailed = false
  try {
    mailed = (await confirmAccept(caller, ids, causationId)).outboundId !== null
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
  }
  return { ...done, mailed }
}

/**
 * The worker's `sales.afterAcceptance` (on quote.accepted, background.ts HANDLERS): the same two steps as the system of
 * the event's tenant, when the accepting request could not finish them (each runs once: its idempotency key).
 */
export function afterAcceptanceHandler(): EventHandler {
  return defineHandler({
    name: 'sales.afterAcceptance',
    events: ['quote.accepted'],
    attempts: 10,
    async handle(event, { caller }) {
      const { quoteId, versionId } = event.payload as AcceptedIds
      await afterAccept(caller, { quoteId, versionId }, event.eventId)
      await confirmAccept(caller, { quoteId, versionId }, event.eventId)
    },
  })
}
