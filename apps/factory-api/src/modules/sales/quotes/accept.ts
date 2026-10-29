import type { FastifyRequest } from 'fastify'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { evidenceNeeds } from '@nexus/factory-domain/links/evidence'
import { answerProblem, linkQuoteState, type LinkQuoteFacts } from '@nexus/factory-domain/sales/quotes/acceptance'
import { quoteDocumentNumber, sizesText } from '@nexus/factory-domain/sales/quotes/document'
import { versionOfLink, type BillToSnapshot, type ShipToSnapshot } from '@nexus/factory-domain/sales/quotes/send'
import { ACCEPTANCE_RETENTION_NOTICE } from '@nexus/factory-domain/sales/quotes/terms'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { idempotencyKeyFrom } from '../../../core/command'
import { requireContext, type LinkContext } from '../../../core/context'
import { linkSessionOf, linkUnavailable } from '../../../platform/links/authenticator'
import { linkCommand, useLink } from '../../../platform/links/use'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { depositOfVersion, depositViewOf, instructionsFor } from '../deposits/deposits'
import { afterAcceptance } from './after-acceptance'
import { CUSTOMER_QUOTE_COLUMNS, customerQuoteOf, dayOf, lineLabels, readCustomerLines, readCustomerVersions, type CustomerVersionRow, type Reader } from './frozen'

/**
 * The customer's side of a sent quote, through its one-off QUOTE_ACCEPT link (B-W1-24; A1 §2.5, §3.10 "Links"; SAL-093,
 * SAL-157, SAL-304; GAP-005; the design's "Accept a quote" link page; PLAN §4.7 stage 06a-accept, "accept by link in a
 * second browser context"). A link session reads in its party's scope (factory_partner_runtime: its own quote, never a
 * cost or margin column); the style codes, the company's name and its bank details come from the tenant's system scope,
 * for this link's quote only. Every answer names the version the page showed.
 *
 *   GET  /link/quote             the version the link was sent with (send.ts versionOfLink), as the PDF says it, its
 *                                state (OPEN, EXPIRED, REVISING, SUPERSEDED, ACCEPTED, DECLINED), what the page must ask
 *                                before each answer, the deposit (once accepted), the privacy notice. A read: it uses
 *                                nothing up (the open's evidence is POST /link/open; a mail scanner's visit changes
 *                                nothing).
 *   POST /link/quote/accept      ONE command: the link used (useLink: the typed name, the email check, the evidence row
 *                                with the hashed address and the browser), the rules of factory-domain
 *                                sales/quotes/acceptance (the latest SENT version, open, as shown; the no-withdrawal
 *                                statement), the version and the quote ACCEPTED, the QuoteAcceptance row (the name typed,
 *                                the email check, the PDF's SHA-256, the terms version, the time, the request), the event
 *                                quote.accepted. Then the system step (after-acceptance.ts): the deposit request, the
 *                                confirmation mail. The answer is the end state with the deposit's payment instructions.
 *   POST /link/quote/decline     the same, DECLINED, with the customer's reason.
 *   POST /link/quote/new-link    the customer asks for a new link (the offer ended, a newer version replaced it): an audit
 *                                row on the quote and quote.link_requested for the office. It uses nothing up.
 */

function linkOf(request: FastifyRequest) {
  const link = linkSessionOf(request)
  // A link of another purpose (a document's, a deposit's) holds links.open too: it opens no quote here.
  if (link.purpose !== 'QUOTE_ACCEPT' || link.record.type !== 'Quote') throw linkUnavailable()
  return link
}

interface LinkFacts {
  readonly quote: { readonly id: string; readonly companyId: string; readonly number: string; readonly partyId: string; readonly customerRef: string | null; readonly status: LinkQuoteFacts['quoteStatus']; readonly currentRevision: number }
  readonly version: CustomerVersionRow
  readonly versions: readonly CustomerVersionRow[]
  readonly facts: LinkQuoteFacts
}

/** The link's quote and version in the party's scope (a command's transaction or the session's client). */
async function readLinkFacts(db: Reader, linkId: string, quoteId: string, today: string): Promise<LinkFacts> {
  const quote = await db.quote.findUnique({ where: { id: quoteId }, select: CUSTOMER_QUOTE_COLUMNS })
  const created = await db.oneOffLink.findUnique({ where: { id: linkId }, select: { createdAt: true } })
  if (!quote || !created) throw linkUnavailable()
  const versions = await readCustomerVersions(db, quote.id)
  const version = versionOfLink(versions, created.createdAt)
  if (!version) throw linkUnavailable()
  return {
    quote,
    version,
    versions,
    facts: {
      quoteStatus: quote.status,
      version: { id: version.id, revision: version.revision, status: version.status, validUntil: dayOf(version.validUntil), noWithdrawal: version.noWithdrawal },
      sentRevisions: versions.filter((row) => row.status === 'SENT').map((row) => row.revision),
      currentRevision: quote.currentRevision,
      today,
    },
  }
}

/** The page: the frozen version as its PDF says it, with its state and what the page asks before an answer. */
async function linkView(request: FastifyRequest, facts: LinkFacts) {
  const link = linkOf(request)
  const context = requireContext(request) as LinkContext
  const system = systemCallerOf(request)(context.tenantId)
  const { quote, version } = facts
  const lines = await request.withClient((client) => readCustomerLines(client, version.id))
  const document = version.documentSha256
    ? await request.withClient((client) => client.storedFile.findFirst({ where: { recordType: 'Quote', recordId: quote.id, sha256: version.documentSha256!, status: 'AVAILABLE' }, select: { id: true, originalName: true, sha256: true, sizeBytes: true } }))
    : null
  const status = linkQuoteState(facts.facts)
  const extra = await system.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: quote.companyId }, select: { legalName: true, tradeName: true } })
    const labels = await lineLabels(client, lines)
    const deposit = version.status === 'ACCEPTED' ? await depositOfVersion(client, version.id) : null
    const language = version.language === 'en' ? 'en' : 'it'
    const instructions = deposit ? await instructionsFor(client, deposit, quoteDocumentNumber(quote.number, version.revision), language) : null
    return { company, labels, deposit, instructions }
  })
  const customer = customerQuoteOf({
    quote,
    version,
    lines,
    labels: extra.labels,
    billTo: version.billTo as unknown as BillToSnapshot,
    shipTo: version.shipTo as unknown as ShipToSnapshot,
    contact: null,
    date: businessDate(version.sentAt ?? version.createdAt),
  })
  const acceptance = version.status === 'ACCEPTED' ? await request.withClient((client) => client.quoteAcceptance.findFirst({ where: { versionId: version.id }, select: { signerName: true, acceptedAt: true, documentSha256: true, termsVersion: true } })) : null
  const answers = status.canAnswer
    ? (['accept', 'decline'] as const).map((action) => ({ action, ...evidenceNeeds(link.purpose, action, { email: link.email }), noWithdrawal: action === 'accept' && version.noWithdrawal }))
    : []
  return {
    quote: {
      number: quoteDocumentNumber(customer.number, customer.revision),
      quoteNumber: quote.number,
      versionId: version.id,
      revision: version.revision,
      seller: { legalName: extra.company?.legalName ?? '', tradeName: extra.company?.tradeName ?? null },
      customerRef: customer.customerRef,
      date: customer.date,
      language: customer.language,
      currency: customer.currency,
      priceBasis: customer.priceBasis,
      validUntil: customer.validUntil,
      firmOffer: customer.firmOffer,
      promiseDate: customer.promiseDate,
      paymentTerms: customer.paymentTerms,
      billTo: { legalName: customer.billTo.legalName, address: customer.billTo.address },
      shipTo: customer.shipTo,
      lines: customer.lines.map((line) => ({
        seq: line.seq,
        code: line.code,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: asMoney('price', line.unitPrice),
        discountPct: line.discountPct,
        netAmount: asMoney('price', line.netAmount),
        vatAmount: asMoney('price', line.vatAmount),
        vatRatePct: line.vatRatePct,
        vatNature: line.vatNature,
        sizes: line.sizes.map((row) => ({ size: row.size, quantity: row.quantity, unitPrice: asMoney('price', row.unitPrice) })),
        sizesText: sizesText(line.sizes, customer.currency, customer.language),
      })),
      totals: asMoney('price', { net: customer.totals.net, vat: customer.totals.vat.map((entry) => ({ ...entry })), gross: customer.totals.gross }),
      deposit: customer.deposit ? { pct: customer.deposit.pct, kind: customer.deposit.kind, amount: asMoney('price', customer.deposit.amount) } : null,
      noWithdrawal: customer.noWithdrawal,
      terms: { termsVersion: customer.terms.termsVersion, clauses: customer.terms.clauses.map((clause) => ({ ...clause })) },
      document: document ? { fileId: document.id, name: document.originalName, sha256: document.sha256, sizeBytes: document.sizeBytes } : null,
    },
    state: status.state,
    message: status.message,
    answers,
    acceptance: acceptance ? { signerName: acceptance.signerName, acceptedAt: toUtcIso(acceptance.acceptedAt), documentSha256: acceptance.documentSha256, termsVersion: acceptance.termsVersion } : null,
    deposit:
      extra.deposit && extra.instructions
        ? (() => {
            const view = depositViewOf(extra.deposit)
            const instructions = extra.instructions
            return {
              id: view.id,
              kind: view.kind,
              depositPct: view.depositPct,
              currency: view.currency,
              amount: asMoney('price', view.amount),
              dueDate: view.dueDate,
              fiscalDocument: view.fiscalDocument,
              status: view.status,
              instructions: { ...instructions, amount: asMoney('price', instructions.amount), bank: instructions.bank ? { ...instructions.bank } : null },
            }
          })()
        : null,
    expiresAt: toUtcIso(link.expiresAt),
    privacy: { url: privacyNoticeUrl(processEmail().webOrigin, quote.companyId), retention: ACCEPTANCE_RETENTION_NOTICE[customer.language] },
  }
}

const todayOf = (request: FastifyRequest): string => businessDate(officeAuthOf(request.server).clock.now())

/** GET /link/quote: the link's quote (see the module comment). Reads only. */
export async function openQuote(request: FastifyRequest) {
  const link = linkOf(request)
  const facts = await request.withClient((client) => readLinkFacts(client, link.id, link.record.id, todayOf(request)))
  return linkView(request, facts)
}

export interface AnswerBody {
  readonly versionId: string
  readonly typedName?: string | null | undefined
  readonly email?: string | null | undefined
  readonly noWithdrawalAccepted?: boolean | undefined
  readonly note?: string | null | undefined
}

const refuse = (problem: { readonly path: string; readonly message: string; readonly state: string }): DomainError =>
  new DomainError(problem.state === 'WRONG_VERSION' || problem.state === 'NO_WITHDRAWAL_STATEMENT' ? 'validation_failed' : 'conflict', problem.message, [{ path: problem.path, message: problem.message }])

/** POST /link/quote/accept and /decline: the customer's answer (see the module comment). */
export async function answerQuote(request: FastifyRequest, action: 'accept' | 'decline', body: AnswerBody) {
  const link = linkOf(request)
  const { result } = await linkCommand(
    request,
    { name: action === 'accept' ? 'quotes.accept' : 'quotes.decline', idempotencyKey: idempotencyKeyFrom(request), input: body, record: { type: 'Quote', id: link.record.id } },
    async (tools) => {
      const use = await useLink(tools, request, { action, typedName: body.typedName, email: body.email })
      const { tx, now } = tools
      const facts = await readLinkFacts(tx, link.id, link.record.id, businessDate(now))
      const problem = answerProblem({ ...facts.facts, action, askedVersionId: body.versionId, noWithdrawalAccepted: body.noWithdrawalAccepted === true })
      if (problem) throw refuse(problem)
      const { quote, version } = facts
      const note = body.note?.trim() ? body.note.trim() : null
      const status = action === 'accept' ? 'ACCEPTED' : 'DECLINED'
      await tx.quoteVersion.update({ where: { id: version.id }, data: { status, closedAt: now, decisionNote: note }, select: { id: true } })
      await tx.quote.update({ where: { id: quote.id }, data: { status }, select: { id: true } })
      if (action === 'decline') {
        tools.audit({ action: 'quotes.decline', recordType: 'Quote', recordId: quote.id, companyId: quote.companyId, before: { status: 'SENT' }, after: { status, versionId: version.id, revision: version.revision, evidenceId: use.evidenceId, typedName: use.typedName, note } })
        tools.emit({ type: 'quote.declined', subject: quote.id, companyId: quote.companyId, payload: { quoteId: quote.id, versionId: version.id, revision: version.revision } })
        return { quoteId: quote.id, versionId: version.id, status, acceptanceId: null as string | null }
      }
      const acceptanceId = newId()
      const noWithdrawalAccepted = version.noWithdrawal && body.noWithdrawalAccepted === true
      await tx.quoteAcceptance.createMany({
        data: [
          {
            id: acceptanceId,
            versionId: version.id,
            partyId: quote.partyId,
            channel: 'LINK',
            linkId: link.id,
            signerName: use.typedName!,
            emailCheck: use.emailCheck,
            documentSha256: version.documentSha256!,
            termsVersion: version.termsVersion,
            noWithdrawalAccepted,
            acceptedAt: now,
            requestId: tools.context.requestId,
            createdAt: now,
          },
        ],
      })
      tools.audit({
        action: 'quotes.accept',
        recordType: 'Quote',
        recordId: quote.id,
        companyId: quote.companyId,
        before: { status: 'SENT' },
        after: { status, versionId: version.id, revision: version.revision, acceptanceId, evidenceId: use.evidenceId, signerName: use.typedName, emailCheck: use.emailCheck, documentSha256: version.documentSha256, termsVersion: version.termsVersion, noWithdrawalAccepted, note },
      })
      tools.emit({
        type: 'quote.accepted',
        subject: quote.id,
        companyId: quote.companyId,
        payload: {
          quoteId: quote.id,
          versionId: version.id,
          revision: version.revision,
          number: quote.number,
          companyId: quote.companyId,
          partyId: quote.partyId,
          acceptanceId,
          channel: 'LINK',
          acceptedAt: toUtcIso(now),
          taxMode: version.taxMode,
          currency: version.currency,
          promiseDate: dayOf(version.promiseDate),
          depositAsked: version.depositAmount !== null && version.depositAmount > 0,
          noWithdrawal: version.noWithdrawal,
        },
      })
      return { quoteId: quote.id, versionId: version.id, status, acceptanceId: acceptanceId as string | null }
    },
  )
  if (action === 'accept' && result.acceptanceId) {
    // The deposit request and the confirmation mail, now (the worker's handler on quote.accepted finishes them otherwise).
    const context = requireContext(request) as LinkContext
    try {
      await afterAcceptance(systemCallerOf(request)(context.tenantId), { quoteId: result.quoteId, versionId: result.versionId })
    } catch (error) {
      request.log.error({ err: error }, 'the step after an acceptance failed; the worker finishes it')
    }
  }
  const facts = await request.withClient((client) => readLinkFacts(client, link.id, link.record.id, todayOf(request)))
  return linkView(request, facts)
}

/** POST /link/quote/new-link: the customer asks the office for a new link (it uses nothing up). */
export async function askNewLink(request: FastifyRequest, body: { readonly note?: string | null | undefined }) {
  const link = linkOf(request)
  const { result } = await linkCommand(request, { name: 'quotes.askNewLink', idempotencyKey: idempotencyKeyFrom(request), input: body }, async (tools) => {
    const facts = await readLinkFacts(tools.tx, link.id, link.record.id, businessDate(tools.now))
    const status = linkQuoteState(facts.facts)
    const note = body.note?.trim() ? body.note.trim() : null
    tools.audit({ action: 'quotes.askNewLink', recordType: 'Quote', recordId: facts.quote.id, companyId: facts.quote.companyId, after: { linkId: link.id, versionId: facts.version.id, state: status.state, note } })
    tools.emit({ type: 'quote.link_requested', subject: facts.quote.id, companyId: facts.quote.companyId, payload: { quoteId: facts.quote.id, versionId: facts.version.id, linkId: link.id, state: status.state } })
    return { asked: true, state: status.state }
  })
  return { asked: result.asked, message: 'We told the sender: a new link will reach you by e-mail.' }
}

