import type { FastifyRequest } from 'fastify'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { replyAddress } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { linkState, linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { depositLinkMail } from '@nexus/factory-domain/payments/deposit-link'
import { PAYMENTS_RECORD, PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { quoteDocumentNumber } from '@nexus/factory-domain/sales/quotes/document'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, COMMAND_SETTINGS, type CommandCaller, type CommandTools } from '../../core/command'
import { companyLegalOf } from '../../platform/documents/documents'
import { deliverOutbound, sendEmail, type DeliveryOutcome } from '../../platform/email-out/outbound'
import type { EmailRuntime } from '../../platform/email-out/service'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { systemCallerOf } from '../../platform/files/files'
import { linkSessionOf, linkUnavailable } from '../../platform/links/authenticator'
import { DEPOSIT_COLUMNS, instructionsFor, type DepositRow } from '../sales/deposits/deposits'
import { assertMay, officeContextOf } from './store'

/**
 * The customer's deposit page by link (DEPOSIT_INFO; Q12 (a): an acconto paid by bank transfer; design 02-sections:
 * the deposit request's "bank details page sent to the customer", the bank-transfer part of Pay online in W1).
 *
 *   send   `POST /payments/deposit-requests/:id/link` (office, payments.record over the request's company and party):
 *          an OPEN request only. The token is minted OUTSIDE the command (only its hash goes in); ONE command: the
 *          address's older live DEPOSIT_INFO links of the request revoked, the link (the purpose's terms: 30 days, 20
 *          counted opens), the mail on the QUOTE's thread to the quote's contact through email out's `sendEmail` with the
 *          text WITHOUT the link and its email.queued withheld (the worker would send the stored text), audit rows, the
 *          event deposit_request.link_sent. B-W2b-16: a request made on an order without a quote (a typed order's
 *          deposit, a balance before shipping) goes on the ORDER's thread to the contact named (`contactId`), else the
 *          customer's INVOICES contact, else its ORDERS contact; its page names the order. After the commit the mail is composed WITH the link in memory and sent at
 *          once (`deliverOutbound`, never retried by a job: a failed one is FAILED and the office sends again). The token
 *          is in the sent mail only, never in an answer, a result, an audit row, an event or a log.
 *   page   `GET /payments/link/deposit` (the link's session; links.open, price grain): the request as its party sees it
 *          (read in the link's own scope: another party's request is behind the wall) and the instructions (amount, due
 *          date, reference, the company's bank account: read through the tenant's system scope, which the partner role
 *          cannot). Reading uses nothing; `POST /link/open` counts an open.
 */

export interface DepositLinkAnswer {
  readonly link: { readonly id: string; readonly expiresAt: string; readonly to: string; readonly revokedLinkIds: string[] }
  readonly emailId: string
  readonly delivery: DeliveryOutcome | 'replayed'
}

interface Facts {
  readonly request: DepositRow
  /** The accepted quote version it was asked for; null for a request made on an order (a typed order, a balance). */
  readonly quote: { readonly id: string; readonly number: string; readonly revision: number; readonly language: string } | null
  /** B-W2b-16: the order a request without a quote version belongs to (its thread carries the mail). */
  readonly order: { readonly id: string; readonly number: string; readonly language: string } | null
  readonly contact: { readonly email: string; readonly name: string }
}

/** The request's language and where its mail goes: the quote's thread, else (B-W2b-16) its order's. */
const languageOf = (facts: Pick<Facts, 'quote' | 'order'>): string => facts.quote?.language ?? facts.order?.language ?? 'it'

/**
 * The request, its quote version and the quote's contact, read in the office caller's scope. B-W2b-16: a request made on
 * an order without a quote (a typed order's deposit, a balance before shipping) goes to the contact named in the body, or
 * the customer's INVOICES contact, else its ORDERS contact (active, with an address), on the order's thread.
 */
async function factsOf(caller: CommandCaller, depositRequestId: string, contactId: string | undefined): Promise<Facts> {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const found = await client.depositRequest.findUnique({ where: { id: depositRequestId }, select: DEPOSIT_COLUMNS })
    assertMay(context, PAYMENTS_VIEW, PAYMENTS_RECORD, found ? { companyId: found.companyId, partyId: found.partyId } : null, 'Deposit request')
    const request = found!
    if (request.status !== 'OPEN') throw new InvalidStateError(`The deposit request is ${request.status}: there is nothing to pay, so no deposit page is sent.`)
    const orderRow = request.orderId ? await client.salesOrder.findUnique({ where: { id: request.orderId }, select: { id: true, number: true, language: true } }) : null
    if (!request.quoteVersionId) {
      if (!orderRow) throw new InvalidStateError('The deposit request names neither a quote nor an order: there is no page to send.')
      const contact = await orderContactOf(client, request.partyId, contactId)
      return { request, quote: null, order: orderRow, contact }
    }
    const version = await client.quoteVersion.findUniqueOrThrow({ where: { id: request.quoteVersionId }, select: { revision: true, language: true, quoteId: true } })
    const quote = await client.quote.findUniqueOrThrow({ where: { id: version.quoteId }, select: { id: true, number: true, contactId: true } })
    const contact = contactId ? await orderContactOf(client, request.partyId, contactId) : quote.contactId ? await client.partyContact.findUnique({ where: { id: quote.contactId }, select: { name: true, email: true, status: true } }) : null
    if (!contact || ('status' in contact && contact.status !== 'ACTIVE') || !contact.email) {
      throw new InvalidStateError("The quote's contact has no e-mail address (or is not active): give the quote an active contact with an address, then send the deposit page.")
    }
    return {
      request,
      quote: { id: quote.id, number: quote.number, revision: version.revision, language: version.language },
      order: orderRow,
      contact: { email: contact.email.trim().toLowerCase(), name: contact.name },
    }
  })
}

/** B-W2b-16: the contact a typed order's deposit page goes to: the one named, else INVOICES, else ORDERS (active, with an address). */
async function orderContactOf(client: Parameters<Parameters<CommandCaller['withClient']>[0]>[0], partyId: string, contactId: string | undefined): Promise<{ email: string; name: string }> {
  const select = { id: true, name: true, email: true, status: true, partyId: true } as const
  if (contactId !== undefined) {
    const named = await client.partyContact.findUnique({ where: { id: contactId }, select })
    if (!named || named.partyId !== partyId || named.status !== 'ACTIVE' || !named.email) throw new InvalidStateError("Not an active contact of the customer with an e-mail address: pick another, or add the address to the customer's contact.")
    return { email: named.email.trim().toLowerCase(), name: named.name }
  }
  for (const role of ['INVOICES', 'ORDERS'] as const) {
    const found = await client.partyContact.findFirst({ where: { partyId, status: 'ACTIVE', roles: { has: role }, email: { not: null } }, select, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    if (found?.email) return { email: found.email.trim().toLowerCase(), name: found.name }
  }
  throw new InvalidStateError('The customer has no active invoices or orders contact with an e-mail address: add one (Customers › Contacts), or pick a contact, then send the deposit page.')
}

/** Mails the deposit page's link to the quote's contact (see the file's comment). */
export async function sendDepositLink(email: EmailRuntime, request: FastifyRequest, depositRequestId: string, body: { readonly message?: string | undefined; readonly contactId?: string | undefined }, idempotencyKey?: string): Promise<DepositLinkAnswer> {
  const context = officeContextOf(request)
  const facts = await factsOf(request, depositRequestId, body.contactId)
  const locale = localeOf(languageOf(facts))
  const quoteDocument = facts.quote ? quoteDocumentNumber(facts.quote.number, facts.quote.revision) : null
  // Minted here, outside the command: only its hash enters the transaction.
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: facts.request.partyId, linkId }).value
  const mailFor = (expiresAt: Date, url: string | null) => depositLinkMail({ locale, quoteDocument, orderNumber: facts.order?.number ?? null, expiresAt, message: body.message ?? null }, url)

  const { result, replayed } = await command(
    request,
    { name: 'payments.sendDepositLink', idempotencyKey, input: { depositRequestId, message: body.message ?? null, ...(body.contactId ? { contactId: body.contactId } : {}) } },
    async (tools) => {
      const { tx, now } = tools
      // The request row, locked: a payment that makes it PAID meanwhile waits, and then the page is not sent.
      const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "DepositRequest" WHERE "id" = ${depositRequestId}::uuid FOR UPDATE`
      if (!locked) throw new NotFoundError('Deposit request not found.')
      if (locked.status !== 'OPEN') throw new InvalidStateError(`The deposit request is ${locked.status}: there is nothing to pay, so no deposit page is sent.`)
      const { request: row, contact, quote, order } = facts
      const revokedLinkIds = await revokeOlderLinks(tools, row, contact.email, context.actorId)
      const terms = linkTerms('DEPOSIT_INFO', {}, now)
      await tx.oneOffLink.createMany({
        data: [
          {
            id: linkId,
            companyId: row.companyId,
            partyId: row.partyId,
            purpose: 'DEPOSIT_INFO',
            recordType: 'DepositRequest',
            recordId: row.id,
            tokenHash: linkTokenHash(token),
            email: contact.email,
            expiresAt: terms.expiresAt,
            maxUses: terms.maxUses,
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
          },
        ],
      })
      tools.audit({
        action: 'links.create',
        recordType: 'OneOffLink',
        recordId: linkId,
        companyId: row.companyId,
        after: { purpose: 'DEPOSIT_INFO', recordType: 'DepositRequest', recordId: row.id, partyId: row.partyId, email: contact.email, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses },
      })
      const sender = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
      const mail = mailFor(terms.expiresAt, null)
      const sent = await queueLinkMail(tools, {
        // B-W2b-16: a request made on an order (no quote) writes on the order's thread.
        record: quote ? { type: 'Quote', id: quote.id } : { type: 'SalesOrder', id: order!.id },
        sender: { userId: context.actorId, name: sender?.displayName ?? 'Ufficio amministrazione', email: sender?.email ?? null },
        to: contact.email,
        subject: mail.subject,
        storedText: mail.body,
        locale,
      })
      tools.audit({
        action: 'payments.sendDepositLink',
        recordType: 'DepositRequest',
        recordId: row.id,
        companyId: row.companyId,
        after: { linkId, linkExpiresAt: toUtcIso(terms.expiresAt), revokedLinkIds, outboundId: sent.outbound.id, to: contact.email },
      })
      tools.emit({ type: 'deposit_request.link_sent', subject: row.id, companyId: row.companyId, payload: { depositRequestId: row.id, quoteId: quote?.id ?? null, orderId: order?.id ?? null, partyId: row.partyId, linkId } })
      return { link: { id: linkId, expiresAt: toUtcIso(terms.expiresAt), to: contact.email, revokedLinkIds }, emailId: sent.outbound.id }
    },
  )
  if (replayed) return { ...result, delivery: 'replayed' }
  const url = officeAuthOf(request.server).link('/l', token)
  const delivery = await deliverLinkMail(email, systemCallerOf(request)(context.tenantId), result.emailId, mailFor(new Date(result.link.expiresAt), url).body)
  return { ...result, delivery }
}

/** One live deposit page per address: the address's older live DEPOSIT_INFO links of the request are revoked. */
async function revokeOlderLinks(tools: CommandTools, row: DepositRow, address: string, actorId: string): Promise<string[]> {
  const { tx, now } = tools
  const older = await tx.oneOffLink.findMany({
    where: { recordType: 'DepositRequest', recordId: row.id, purpose: 'DEPOSIT_INFO', email: address },
    select: { id: true, revokedAt: true, expiresAt: true, uses: true, maxUses: true },
  })
  const revoked: string[] = []
  for (const link of older.filter((entry) => linkState(entry, now) === 'LIVE')) {
    await tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now, revokedById: actorId } })
    tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId: row.companyId, after: { revokedAt: toUtcIso(now) }, reason: 'Replaced by a new deposit page link to the same address.' })
    revoked.push(link.id)
  }
  return revoked
}

interface LinkMailInput {
  /** The thread the mail goes on: the quote's, else (B-W2b-16) the order's. */
  readonly record: { readonly type: 'Quote' | 'SalesOrder'; readonly id: string }
  readonly sender: { readonly userId: string; readonly name: string; readonly email: string | null }
  readonly to: string
  readonly subject: string
  /** The mail's text without the link (what the thread keeps). */
  readonly storedText: string
  readonly locale: string
}

/** Inside the command: the thread message and the QUEUED mail on the quote's thread, without the link and its event. */
function queueLinkMail(tools: CommandTools, input: LinkMailInput) {
  const quiet = {
    tx: tools.tx,
    context: tools.context,
    now: tools.now,
    audit: tools.audit,
    // The worker builds a queued mail from its stored text, which has no link: this mail is delivered in-process.
    emit: (event: Parameters<CommandTools['emit']>[0]) => (event.type === 'email.queued' ? undefined : tools.emit(event)),
  }
  return sendEmail(quiet, { record: input.record, sender: input.sender, to: [input.to], subject: input.subject, body: input.storedText, locale: input.locale })
}

/** After the commit: sends the queued mail once, with the link, as the tenant's system. Never throws: the outcome says. */
async function deliverLinkMail(runtime: EmailRuntime, caller: CommandCaller, outboundId: string, text: string): Promise<DeliveryOutcome> {
  try {
    return await deliverOutbound(runtime, caller, outboundId, {
      retry: false,
      build: async (row) => {
        if (!row.threadId || !row.messageId) throw new Error('A deposit page mail names its thread and message.')
        const { threadId, messageId } = row
        const { thread, message } = await caller.withClient(async (client) => ({
          thread: await client.thread.findUniqueOrThrow({ where: { id: threadId }, select: { replyToken: true } }),
          message: await client.message.findUniqueOrThrow({ where: { id: messageId }, select: { authorName: true } }),
        }))
        const company = await companyLegalOf(caller, row.companyId)
        const mail = compose(
          { template: 'thread.message', body: cleanBody(text), senderName: message.authorName, companyName: row.identity.displayName, attachmentNames: [] },
          { locale: localeOf(row.locale), company, privacyUrl: privacyNoticeUrl(runtime.webOrigin, row.companyId) },
        )
        return buildMime({
          id: row.id,
          from: { name: row.fromName, address: row.fromAddress },
          to: row.to,
          cc: row.cc,
          replyTo: replyAddress(thread.replyToken, row.identity.replyDomain),
          subject: row.subject,
          messageId: row.emailMessageId,
          inReplyTo: row.inReplyTo,
          references: row.referenceIds,
          date: COMMAND_SETTINGS.clock.now(),
          text: mail.text,
          html: mail.html,
          automatic: false,
          attachments: [],
        })
      },
    })
  } catch {
    return 'failed'
  }
}

/** The deposit page as the link's holder reads it (see the file's comment). */
export async function depositLinkView(request: FastifyRequest) {
  const link = linkSessionOf(request)
  if (link.purpose !== 'DEPOSIT_INFO' || link.record.type !== 'DepositRequest') throw linkUnavailable()
  const system = systemCallerOf(request)(link.tenantId)
  return request.withClient((own) =>
    system.withClient(async (tenant) => {
      // The link's own scope finds its party's request or nothing.
      const row = await own.depositRequest.findUnique({ where: { id: link.record.id }, select: DEPOSIT_COLUMNS })
      if (!row) throw linkUnavailable()
      // B-W2b-16: a request made on an order (no quote version) shows its order; one with neither has no page.
      if (!row.quoteVersionId && !row.orderId) throw linkUnavailable()
      const version = row.quoteVersionId ? await tenant.quoteVersion.findUniqueOrThrow({ where: { id: row.quoteVersionId }, select: { revision: true, language: true, quoteId: true } }) : null
      const quote = version ? await tenant.quote.findUniqueOrThrow({ where: { id: version.quoteId }, select: { number: true } }) : null
      const order = row.orderId ? await tenant.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true, language: true } }) : null
      if (!quote && !order) throw linkUnavailable()
      const company = await tenant.company.findUnique({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } })
      const language = (version?.language ?? order?.language) === 'it' ? 'it' : 'en'
      const document = version && quote ? quoteDocumentNumber(quote.number, version.revision) : order!.number
      const instructions = await instructionsFor(tenant, row, document, language)
      return {
        deposit: {
          kind: row.kind,
          // As the database holds it: "30.0000" → "30" (trimming zeros off a whole "30" would say 3 %).
          depositPct: row.depositPct === null ? null : decimalText(row.depositPct.toString()),
          currency: row.currency,
          amount: asMoney('price', row.amount),
          dueDate: row.dueDate.toISOString().slice(0, 10),
          status: row.status,
          paid: row.status === 'PAID',
        },
        quote: version && quote ? { document: quoteDocumentNumber(quote.number, version.revision) } : null,
        order: order ? { number: order.number } : null,
        from: { legalName: company?.legalName ?? '', tradeName: company?.tradeName ?? null },
        instructions: { ...instructions, amount: asMoney('price', instructions.amount) },
        expiresAt: toUtcIso(link.expiresAt),
      }
    }),
  )
}
