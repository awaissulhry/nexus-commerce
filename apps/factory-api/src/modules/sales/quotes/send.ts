import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import { viesStanding } from '@nexus/factory-domain/parties/vies'
import { quoteDocument, quoteDocumentNumber, quoteMail, type CustomerQuote } from '@nexus/factory-domain/sales/quotes/document'
import { QUOTES_MANAGE, QUOTES_SEND } from '@nexus/factory-domain/sales/quotes/permissions'
import { versionTaxModeOf, type QuoteVersionStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import { billToSnapshot, reviseProblem, revisedValidUntil, sendChecks, shipToSnapshot, type AddressFacts, type BillToSnapshot, type SendCheck, type ShipToSnapshot } from '@nexus/factory-domain/sales/quotes/send'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { processEmail } from '../../../platform/email-out/service'
import { putGeneratedFile, recordGeneratedFile, systemCallerOf, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { TAX_COLUMNS, taxFieldsOf, VIES_COLUMNS, viesFactsOf } from '../../parties/store'
import { depositBankDetailsFor } from '../deposits/deposits'
import { acceptLinkTerms, insertAcceptLink, mintAcceptLink, revokeAcceptLinks, type AcceptLinkTerms, type MintedLink } from './accept-links'
import { CUSTOMER_VERSION_COLUMNS, customerQuoteOf, dayOf, lineLabels, readCustomerLines, readCustomerVersions, type Reader } from './frozen'
import { deliverLinkMail, queueLinkMail } from './mail'
import { refreshVersion } from './pricing'
import { detailInCommand, onQuote } from './quotes'
import { quoteRulesFor } from './rules'
import { grainsOf, officeContextOf, officeQuote, readCurrentVersion, readQuote, storedVat, treatmentFor, treatmentOfStored, type QuoteRow } from './store'
import { forCaller, readFacts, type QuoteDetail } from './views'

/**
 * Sending a quote (B-W1-24; A1 §2.5 "Sending freezes a version"; SAL-157, SAL-192, SAL-194, SAL-093; GAP-005, GAP-008;
 * the design's Send dialog `quotes.send`; PLAN §4.7 stage 05-quote → 06a-accept). ONE flow, quotes.send over the quote's
 * company and customer:
 *
 *   1. the checks (factory-domain sales/quotes/send sendChecks): B-W1-21's send blockers and the send's own
 *      (letterhead, addresses, SDI identity, VAT as priced, a firm offer that stands, terms version); warnings never stop;
 *   2. outside any transaction: the frozen document — the CustomerQuote of the version (prices, size grids, totals,
 *      deposit, terms by customer), the QUOTE layout with the company's letterhead, the PDF (same input, same bytes) —
 *      put in the file store (FISCAL_ARCHIVE: the evidence of a contract is kept ten years, c.c. art. 2220), and the
 *      accept link's token minted (only its hash goes further);
 *   3. ONE command on the Quote (its version = the edit-conflict guard): the customer's data checked unchanged since the
 *      document was made; the PDF's StoredFile row (shared with the customer and its link); older SENT versions
 *      SUPERSEDED; the version SENT with its frozen buyer and delivery address, the PDF's SHA-256, sentAt, sentById and
 *      the terms version (the …_sales_guards trigger freezes it from now on); the quote SENT; the QUOTE_ACCEPT link; the
 *      mail on the quote's thread with the PDF, without the link (quotes/mail.ts); quote.sent;
 *   4. after the commit, the mail leaves with the link (in this process: the link exists only in memory).
 *
 * Idempotent: a repeated Idempotency-Key answers the first send from its receipt (nothing is made again, no second mail);
 * a send of a version that changed since it was read is a 409 naming the current version. The token is in no answer,
 * row, audit entry or event: only the mail holds it.
 */

const ADDRESS_COLUMNS = { id: true, partyId: true, status: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true } as const

const asAddress = (row: { name: string | null; line1: string; line2: string | null; postalCode: string; city: string; province: string | null; country: string; contactName: string | null; phone: string | null }): AddressFacts => ({
  name: row.name,
  line1: row.line1,
  line2: row.line2,
  postalCode: row.postalCode,
  city: row.city,
  province: row.province,
  country: row.country,
  contactName: row.contactName,
  phone: row.phone,
})

const SENDABLE: readonly QuoteVersionStatus[] = ['DRAFT', 'APPROVED']

interface SendFacts {
  readonly checks: { readonly ready: boolean; readonly checks: SendCheck[] }
  readonly versionId: string
  readonly versionStatus: QuoteVersionStatus
  readonly billTo: BillToSnapshot | null
  readonly shipTo: ShipToSnapshot | null
  readonly contact: { readonly name: string; readonly email: string | null } | null
  readonly customer: CustomerQuote | null
  readonly today: string
}

/**
 * What the send would freeze and what stops it, read in one scope (the office's client, or the command's transaction).
 * `companyLegal` is the company's letterhead problems (read through the caller beforehand). With `preview`, the
 * customer's document is made whenever its addresses and validity are there (the checks may still fail), in the
 * language asked: the office reads the PDF before it sends (preview.ts); nothing is stored.
 */
export async function readSendFacts(db: Reader, quote: QuoteRow, now: Date, companyLegal: readonly Issue[], preview?: { readonly language: 'it' | 'en' }): Promise<SendFacts> {
  const facts = await readFacts(db, quote, now)
  const { version, party, today } = facts
  const addresses = await db.partyAddress.findMany({ where: { id: { in: [version.billToAddressId, version.shipToAddressId].filter((id): id is string => id !== null) }, status: 'ACTIVE' }, select: ADDRESS_COLUMNS })
  const billRow = addresses.find((row) => row.id === version.billToAddressId && row.partyId === quote.partyId) ?? null
  const shipRow = addresses.find((row) => row.id === version.shipToAddressId && row.partyId === quote.partyId) ?? null

  // The VAT as decided today against the VAT the lines were priced with (a VIES proof that lapsed or arrived since).
  let vatChanged = false
  if (party?.profile && party.identity) {
    const decided = treatmentFor(party.profile)
    const first = facts.lines[0]
    vatChanged =
      versionTaxModeOf(party.identity.taxMode, party.viesValid) !== version.taxMode ||
      'problem' in decided ||
      (first !== undefined && JSON.stringify(storedVat(decided)) !== JSON.stringify(storedVat(treatmentOfStored(first))))
  }
  const versions = await readCustomerVersions(db, quote.id)
  const standing = versions.find((row) => row.revision < version.revision && row.status === 'SENT' && row.firmOffer && row.validUntil !== null && dayOf(row.validUntil)! >= today)
  const bank = await depositBankDetailsFor(db, quote.companyId)
  const checks = sendChecks({
    issues: facts.issues,
    status: version.status,
    approvalNeeded: facts.priced.approvalNeeded,
    companyLegal,
    billTo: billRow ? asAddress(billRow) : null,
    shipTo: shipRow ? asAddress(shipRow) : null,
    identity: party?.identity ?? null,
    vatChanged,
    standingFirmOffer: standing ? { revision: standing.revision, validUntil: dayOf(standing.validUntil)! } : null,
    termsText: version.termsText,
    termsVersion: version.termsVersion,
    depositAsked: version.depositAmount !== null && version.depositAmount > 0,
    bankDetailsKnown: bank !== null,
  })

  let billTo: BillToSnapshot | null = null
  if (billRow && party?.identity) {
    let consultation: string | null = null
    if (version.taxMode === 'EU_B2B' && party.identityId) {
      const identityRow = await db.partyTaxIdentity.findUnique({ where: { id: party.identityId }, select: TAX_COLUMNS })
      const checksOf = await db.viesCheck.findMany({ where: { taxIdentityId: party.identityId }, select: VIES_COLUMNS })
      consultation = identityRow ? (viesStanding(taxFieldsOf(identityRow), checksOf.map(viesFactsOf), now).proof?.consultationNumber ?? null) : null
    }
    billTo = billToSnapshot({ legalName: party.row.legalName, kind: party.row.kind, identity: party.identity, viesConsultationNumber: consultation, address: asAddress(billRow) })
  }
  const shipTo = shipRow ? shipToSnapshot(asAddress(shipRow)) : null
  const contact = facts.contact ? { name: facts.contact.name, email: facts.contact.email } : null

  let customer: CustomerQuote | null = null
  const row = versions.find((entry) => entry.id === version.id)!
  if (preview ? billTo && shipTo && row.validUntil !== null : checks.ready && billTo && shipTo) {
    const lines = await readCustomerLines(db, version.id)
    const shown = preview ? { ...row, language: preview.language } : row
    customer = customerQuoteOf({ quote, version: shown, lines, labels: await lineLabels(db, lines), billTo: billTo!, shipTo: shipTo!, contact, date: today })
  }
  return { checks, versionId: version.id, versionStatus: version.status, billTo, shipTo, contact, customer, today }
}

const refusal = (checks: readonly SendCheck[]): DomainError => {
  const blocking = checks.filter((check) => check.severity === 'BLOCKS')
  return new DomainError('conflict', `The quote cannot be sent yet. ${blocking.map((check) => check.message).join(' ')}`, blocking.map((check) => ({ path: check.path, message: check.message })))
}

const languageOf = (value: string): 'it' | 'en' => (value === 'en' ? 'en' : 'it')

// ---- the checks (the Send dialog) -----------------------------------------------------------------------------------

/** quotes.view: what the send would check now, to whom it goes, and the mail it would write (no link: it does not exist yet). */
export async function sendCheck(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  const companyLegal = legalProblems(await companyLegalOf(caller, quote.companyId))
  const facts = await caller.withClient((client) => readSendFacts(client, quote, now, companyLegal))
  const version = await caller.withClient((client) => readCurrentVersion(client, quote))
  const validUntil = dayOf(version.validUntil)
  const number = quoteDocumentNumber(quote.number, version.revision)
  const terms = validUntil ? acceptLinkTerms(facts.today, validUntil, now) : null
  const mail = validUntil && terms ? quoteMail({ language: languageOf(version.language), number, validUntil, linkUntil: businessDate(terms.expiresAt), recipientName: facts.contact?.name ?? null, message: null, resend: false }) : null
  return {
    ready: facts.checks.ready,
    checks: facts.checks.checks,
    recipient: facts.contact ? { contactId: quote.contactId, name: facts.contact.name, email: facts.contact.email } : null,
    documentNumber: number,
    language: languageOf(version.language),
    validUntil,
    linkExpiresAt: terms ? toUtcIso(terms.expiresAt) : null,
    subject: mail?.subject ?? null,
    message: mail?.stored ?? null,
  }
}

// ---- send -----------------------------------------------------------------------------------------------------------

export interface SendBody {
  readonly version: number
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  /** The office's own words above the link paragraph; none: the standard text. */
  readonly message?: string | null | undefined
}

interface SendPlan {
  readonly facts: SendFacts
  readonly customer: CustomerQuote
  readonly file: PreparedGeneratedFile
  readonly pdf: Buffer
  readonly fileName: string
  readonly layout: string
  readonly link: MintedLink
  readonly terms: AcceptLinkTerms
  readonly mail: ReturnType<typeof quoteMail>
  readonly to: string
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** quotes.send: freezes the version, stores its PDF, makes the accept link and mails both (see the module comment). */
export async function sendQuote(request: FastifyRequest, quoteId: string, body: SendBody, idempotencyKey?: string) {
  const caller: CommandCaller = request
  const context = officeContextOf(caller)
  const quote = await officeQuote(caller, quoteId, QUOTES_SEND)
  const now = serverClock.now()

  // Steps 1 and 2, only for the version the caller read (a repeat or a stale send goes straight to the command: its
  // receipt answers, or the version guard refuses).
  let plan: SendPlan | null = null
  let refused: DomainError | null = null
  if (quote.version === body.version) {
    const companyLegal = legalProblems(await companyLegalOf(caller, quote.companyId))
    const facts = await caller.withClient((client) => readSendFacts(client, quote, now, companyLegal))
    if (!SENDABLE.includes(facts.versionStatus) || !facts.checks.ready || !facts.customer || !facts.contact?.email) {
      refused = refusal(facts.checks.checks)
    } else {
      const customer = facts.customer
      const composed = composeDocument({ ...quoteDocument(customer), company: await companyLegalOf(caller, quote.companyId), sample: false })
      const pdf = await renderDocumentPdf(composed)
      const fileName = documentFileName(composed)
      const file = await putGeneratedFile(processFiles(), caller, {
        companyId: quote.companyId,
        recordType: 'Quote',
        recordId: quote.id,
        kind: 'FISCAL_ARCHIVE',
        originalName: fileName,
        contentType: 'application/pdf',
        body: pdf,
        visibility: ['OFFICE', 'PARTNER', 'LINK'],
        partyId: quote.partyId,
      })
      const terms = acceptLinkTerms(facts.today, customer.validUntil, now)
      const mail = quoteMail({
        language: customer.language,
        number: quoteDocumentNumber(customer.number, customer.revision),
        validUntil: customer.validUntil,
        linkUntil: businessDate(terms.expiresAt),
        recipientName: facts.contact.name,
        message: body.message ?? null,
        resend: false,
      })
      plan = { facts, customer, file, pdf, fileName, layout: composed.layout, link: mintAcceptLink(context.tenantId, quote.partyId), terms, mail, to: facts.contact.email }
    }
  }

  const { result, replayed } = await command(
    caller,
    { name: 'quotes.send', idempotencyKey, input: { quoteId, ...body }, record: { type: 'Quote', id: quote.id, expectedVersion: body.version } },
    async (tools) => {
      if (!plan) throw refused ?? new InvalidStateError('The quote cannot be sent as it is: reload it.')
      const { tx } = tools
      const current = (await readQuote(tx, quote.id))!
      const version = await readCurrentVersion(tx, current)
      if (version.id !== plan.facts.versionId || !SENDABLE.includes(version.status)) throw new InvalidStateError('The quote changed while it was being sent: reload it and send again.')
      // The customer's data as the document printed it (the parties module writes it outside the quote's commands).
      const again = await readSendFacts(tx, current, tools.now, [])
      if (!sameJson(again.billTo, plan.facts.billTo) || !sameJson(again.shipTo, plan.facts.shipTo) || again.contact?.email !== plan.to) {
        throw new DomainError('conflict', "The customer's details changed while the quote was being sent: send it again.", [{ path: 'party', message: 'Changed since the document was made.' }])
      }
      const file = await recordGeneratedFile(tools, plan.file, { details: { documentType: 'QUOTE', number: quoteDocumentNumber(current.number, version.revision), layout: plan.layout, language: plan.customer.language } })
      const superseded = (await tx.quoteVersion.findMany({ where: { quoteId: current.id, status: 'SENT', id: { not: version.id } }, select: { id: true } })).map((row) => row.id)
      if (superseded.length > 0) await tx.quoteVersion.updateMany({ where: { id: { in: superseded }, status: 'SENT' }, data: { status: 'SUPERSEDED', closedAt: tools.now, version: { increment: 1 } } })
      await tx.quoteVersion.update({
        where: { id: version.id },
        data: {
          status: 'SENT',
          billTo: plan.facts.billTo as unknown as Prisma.InputJsonValue,
          shipTo: plan.facts.shipTo as unknown as Prisma.InputJsonValue,
          documentSha256: plan.file.sha256,
          sentAt: tools.now,
          sentById: context.actorId,
          termsVersion: plan.customer.terms.termsVersion,
          version: { increment: 1 },
        },
        select: { id: true },
      })
      await tx.quote.update({ where: { id: current.id }, data: { status: 'SENT' }, select: { id: true } })
      const link = await insertAcceptLink(tools, plan.link, current, { email: plan.to, terms: plan.terms, actorId: context.actorId })
      const mail = await queueLinkMail(tools, {
        quoteId: current.id,
        sender: await senderOf(tools, context),
        to: plan.to,
        cc: body.cc ?? [],
        subject: body.subject?.trim() ? body.subject.trim() : plan.mail.subject,
        storedText: plan.mail.stored,
        attachments: [file.id],
        locale: plan.customer.language,
      })
      tools.audit({
        action: 'quotes.send',
        recordType: 'Quote',
        recordId: current.id,
        companyId: current.companyId,
        before: { status: version.status },
        after: {
          status: 'SENT',
          versionId: version.id,
          revision: version.revision,
          documentFileId: file.id,
          documentSha256: plan.file.sha256,
          termsVersion: plan.customer.terms.termsVersion,
          linkId: link.linkId,
          linkExpiresAt: toUtcIso(link.expiresAt),
          outboundId: mail.outbound.id,
          supersededVersionIds: superseded,
        },
      })
      tools.emit({
        type: 'quote.sent',
        subject: current.id,
        companyId: current.companyId,
        payload: { quoteId: current.id, versionId: version.id, revision: version.revision, number: current.number, documentFileId: file.id, linkId: link.linkId, supersededVersionIds: superseded },
      })
      const detail = await detailInCommand(tools, current.id)
      return {
        ...detail,
        sent: {
          versionId: version.id,
          revision: version.revision,
          sentAt: toUtcIso(tools.now),
          documentFileId: file.id,
          documentSha256: plan.file.sha256,
          termsVersion: plan.customer.terms.termsVersion,
          to: plan.to,
          link: { id: link.linkId, expiresAt: toUtcIso(link.expiresAt) },
          emailId: mail.outbound.id,
          supersededVersionIds: superseded,
        },
      }
    },
  )
  // Step 4: the mail leaves with the link, once (a replay sends nothing again).
  const delivery = replayed || !plan ? null : await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.sent.emailId, { text: plan.mail.withLink(officeAuthOf(request.server).link('/l', plan.link.token)), attachment: { filename: plan.fileName, content: plan.pdf } })
  return { ...forCaller(result, grainsOf(context)), delivery }
}

/** The office user who sends, as their mail and the thread show them (the company's name when they have no user row). */
async function senderOf(tools: CommandTools, context: OfficeContext) {
  const user = await tools.tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  return { userId: context.actorId, name: user?.displayName ?? 'Ufficio commerciale', email: user?.email ?? null }
}

// ---- a new link -----------------------------------------------------------------------------------------------------

export interface NewLinkBody {
  readonly version: number
  readonly cc?: readonly string[] | undefined
  readonly message?: string | null | undefined
}

/**
 * quotes.send: a new accept link for the sent version (the customer lost it, a mail scanner used it, the link ran out
 * before the offer did): the live ones stop working, the new one is mailed with the PDF, as the send does. Refused once
 * the offer ended (a new version is made) or when the quote is not waiting for the customer.
 */
export async function sendNewLink(request: FastifyRequest, quoteId: string, body: NewLinkBody, idempotencyKey?: string) {
  const caller: CommandCaller = request
  const context = officeContextOf(caller)
  const quote = await officeQuote(caller, quoteId, QUOTES_SEND)
  const now = serverClock.now()
  const today = businessDate(now)

  const facts = await caller.withClient(async (client) => {
    const version = await client.quoteVersion.findFirst({ where: { quoteId: quote.id, revision: quote.currentRevision }, select: CUSTOMER_VERSION_COLUMNS })
    if (!version) throw new NotFoundError('Quote version not found.')
    const contact = quote.contactId ? await client.partyContact.findUnique({ where: { id: quote.contactId }, select: { name: true, email: true } }) : null
    const file = version.documentSha256 ? await client.storedFile.findFirst({ where: { recordType: 'Quote', recordId: quote.id, sha256: version.documentSha256, status: 'AVAILABLE' }, select: { id: true, originalName: true, sizeBytes: true, storeAccountId: true, storageKey: true } }) : null
    return { version, contact, file }
  })
  const { version, contact, file } = facts
  const plannable = quote.version === body.version && quote.status === 'SENT' && version.status === 'SENT'
  let refused: DomainError | null = null
  let plan: { link: MintedLink; terms: AcceptLinkTerms; mail: ReturnType<typeof quoteMail>; pdf: Buffer; to: string; fileId: string; fileName: string } | null = null
  if (plannable) {
    const validUntil = dayOf(version.validUntil)!
    if (validUntil < today) refused = new InvalidStateError(`The offer ended on ${validUntil}: make a new version and send it.`)
    else if (!contact?.email) refused = new DomainError('conflict', 'Choose a contact with an email: the link goes to them.', [{ path: 'contactId', message: 'No email.' }])
    else if (!file) refused = new InvalidStateError("The sent version's PDF is not available: it cannot be sent again.")
    else {
      const pdf = await processEmail().files().read(caller, file.storeAccountId, file.storageKey, file.sizeBytes)
      if (!pdf) throw new InvalidStateError("The sent version's PDF is missing from the file store.")
      const terms = acceptLinkTerms(today, validUntil, now)
      const mail = quoteMail({ language: languageOf(version.language), number: quoteDocumentNumber(quote.number, version.revision), validUntil, linkUntil: businessDate(terms.expiresAt), recipientName: contact.name, message: body.message ?? null, resend: true })
      plan = { link: mintAcceptLink(context.tenantId, quote.partyId), terms, mail, pdf, to: contact.email, fileId: file.id, fileName: file.originalName }
    }
  } else if (quote.version === body.version) {
    refused = new InvalidStateError('Only a sent quote waiting for its customer gets a new link.')
  }

  const { result, replayed } = await command(
    caller,
    { name: 'quotes.sendLink', idempotencyKey, input: { quoteId, ...body }, record: { type: 'Quote', id: quote.id, expectedVersion: body.version } },
    async (tools) => {
      if (!plan) throw refused ?? new InvalidStateError('The quote changed: reload it.')
      const current = (await readQuote(tools.tx, quote.id))!
      const revoked = await revokeAcceptLinks(tools, current, context.actorId)
      const link = await insertAcceptLink(tools, plan.link, current, { email: plan.to, terms: plan.terms, actorId: context.actorId })
      const mail = await queueLinkMail(tools, { quoteId: current.id, sender: await senderOf(tools, context), to: plan.to, cc: body.cc ?? [], subject: plan.mail.subject, storedText: plan.mail.stored, attachments: [plan.fileId], locale: languageOf(version.language) })
      tools.audit({ action: 'quotes.sendLink', recordType: 'Quote', recordId: current.id, companyId: current.companyId, after: { versionId: version.id, linkId: link.linkId, linkExpiresAt: toUtcIso(link.expiresAt), revokedLinkIds: revoked, outboundId: mail.outbound.id } })
      tools.emit({ type: 'quote.link_sent', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, linkId: link.linkId, revokedLinkIds: revoked } })
      return { ...(await detailInCommand(tools, current.id)), link: { id: link.linkId, expiresAt: toUtcIso(link.expiresAt), to: plan.to, revokedLinkIds: revoked, emailId: mail.outbound.id } }
    },
  )
  const delivery = replayed || !plan ? null : await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.link.emailId, { text: plan.mail.withLink(officeAuthOf(request.server).link('/l', plan.link.token)), attachment: { filename: plan.fileName, content: plan.pdf } })
  return { ...forCaller(result, grainsOf(context)), delivery }
}

// ---- revise ---------------------------------------------------------------------------------------------------------

/**
 * quotes.manage: a new version of a sent (or declined) quote, a DRAFT that copies the sent one's terms, addresses,
 * deposit, lines, size grids and their costs (the cost sheets they were priced with: a recompute costs them again), with
 * a new validity from today. The VAT is decided again. The sent version stays SENT (its link says the quote is being
 * revised) until the new one is sent, which supersedes it.
 */
export async function reviseQuote(caller: CommandCaller, quoteId: string, body: { version: number; changeNote?: string | null | undefined }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.revise', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, from) => {
    const problem = reviseProblem(from.status)
    if (problem) throw new InvalidStateError(problem)
    const { tx, now } = tools
    const today = businessDate(now)
    const rules = await quoteRulesFor(tx, current.companyId)
    const source = await tx.quoteVersion.findUniqueOrThrow({ where: { id: from.id }, select: { firmOffer: true, termsText: true, termsVersion: true, paymentTerms: true, promiseDate: true, noWithdrawal: true, taxIdentityId: true } })
    const versionId = newId()
    const revision = from.revision + 1
    await tx.quoteVersion.create({
      data: {
        id: versionId,
        quoteId: current.id,
        partyId: current.partyId,
        revision,
        currency: from.currency,
        language: from.language,
        taxMode: from.taxMode,
        taxIdentityId: source.taxIdentityId,
        billToAddressId: from.billToAddressId,
        shipToAddressId: from.shipToAddressId,
        validUntil: new Date(`${revisedValidUntil(today, rules.defaultValidityDays)}T00:00:00.000Z`),
        firmOffer: source.firmOffer,
        promiseDate: source.promiseDate && dayOf(source.promiseDate)! >= today ? source.promiseDate : null,
        paymentTerms: source.paymentTerms,
        termsText: source.termsText,
        termsVersion: source.termsVersion,
        depositPct: from.depositPct,
        depositKind: from.depositKind,
        noWithdrawal: source.noWithdrawal,
        marginFloorPct: rules.marginFloorPct,
        changeNote: body.changeNote?.trim() ? body.changeNote.trim() : null,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    await copyLines(tools, from.id, versionId, current.partyId)
    await tx.quote.update({ where: { id: current.id }, data: { status: 'DRAFT', currentRevision: revision }, select: { id: true } })
    const after = (await readQuote(tx, current.id))!
    await refreshVersion(tools, after, await readCurrentVersion(tx, after), new Set())
    tools.audit({ action: 'quotes.revise', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { status: from.status, revision: from.revision }, after: { status: 'DRAFT', revision, versionId, fromVersionId: from.id, changeNote: body.changeNote ?? null } })
    tools.emit({ type: 'quote.revised', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId, fromVersionId: from.id, revision } })
    return detailInCommand(tools, current.id)
  })
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** Copies a version's lines and size grids, with their prices, VAT and the costs they were priced with, onto another. */
async function copyLines(tools: CommandTools, fromVersionId: string, toVersionId: string, partyId: string): Promise<void> {
  const { tx } = tools
  const lines = await tx.quoteLine.findMany({
    where: { versionId: fromVersionId },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      kind: true,
      styleId: true,
      styleRevisionId: true,
      colourwayId: true,
      measurementProfileId: true,
      baseSize: true,
      description: true,
      note: true,
      quantity: true,
      listUnitPrice: true,
      unitPrice: true,
      adjustmentReason: true,
      netAmount: true,
      vatRatePct: true,
      vatNature: true,
      vatAmount: true,
      unitCost: true,
      costAmount: true,
      marginAmount: true,
      marginPct: true,
      costSnapshot: true,
    },
  })
  if (lines.length === 0) return
  const sizes = await tx.quoteLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true } })
  const actorId = actorIdOf(tools)
  for (const { id: oldId, costSnapshot, ...line } of lines) {
    const id = newId()
    await tx.quoteLine.create({ data: { ...line, id, versionId: toVersionId, partyId, ...(costSnapshot === null ? {} : { costSnapshot: costSnapshot as Prisma.InputJsonValue }), createdById: actorId }, select: { id: true } })
    const own = sizes.filter((row) => row.lineId === oldId)
    if (own.length > 0) await tx.quoteLineSize.createMany({ data: own.map((row) => ({ id: newId(), lineId: id, partyId, size: row.size, quantity: row.quantity, unitPrice: row.unitPrice, createdById: actorId })) })
  }
}

