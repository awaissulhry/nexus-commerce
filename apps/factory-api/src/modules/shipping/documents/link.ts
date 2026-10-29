import type { FastifyRequest } from 'fastify'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { compose } from '@nexus/factory-domain/email/compose'
import { privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor, replyAddress, threadingOf } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, matchesLinkHash, mintLinkToken, parseLinkToken } from '@nexus/factory-domain/links/token'
import { documentTitle, linkDocuments, linkRecipients, LINK_EXPIRY_DAYS, LINK_MAX_USES, RENEW_COALESCE_MS, renewalRefusal, type ContactFacts } from '@nexus/factory-domain/shipping/documents/documents'
import { documentsLinkMail } from '@nexus/factory-domain/shipping/documents/mail'
import type { DOCUMENT_LINK_REASONS } from '@nexus/factory-domain/shipping/events'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import type { CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { deliverOutbound, sendingIdentity, type ClaimedOutbound } from '../../../platform/email-out/outbound'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { LINK_HEADER } from '../../../platform/links/authenticator'
import { systemContext } from '../../../platform/outbox/system'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { tenantOf } from '../cells'
import { readShipment, type ShipmentHeader } from '../store'
import { attachStateProblem } from './attach'
import { contactsOf, documentsClock, documentsCommand, lockShipmentDocuments, readDocuments } from './read'

/**
 * The shipment's documents link (B-W1-49; SAL-099, LOG-020; A2 SCR-101 "Download a document", links.frame "Ask for a new
 * link"): a one-off DOCUMENT_VIEW link of the Shipment, one per address, mailed on the shipment's thread.
 *
 *   send      the addresses: the office's choice of the party's contacts, else its ACTIVE ORDERS and QUALITY contacts
 *             with an address (never a suppressed one). A token per address is minted OUTSIDE the command (only its
 *             hash goes in), then ONE command: the shipment's documents lock, the links (the purpose's longest life:
 *             365 days, 100 counted opens), per address the thread message (OUTBOUND EMAIL, its text WITHOUT the link)
 *             and the EmailOutbound row (QUEUED, no body), their audit rows, the event shipment.documents_link_sent.
 *             No email.queued: the worker never sends this mail from its stored text. After the commit each mail is
 *             composed in memory WITH its link and sent at once (email-out deliverOutbound, as a sign-in mail), never
 *             retried by a job: a failed one is FAILED and the office sends again. The token is in the sent mail only:
 *             never in an answer, a command's result (receipts keep results), an audit row, an event or a log.
 *             The office's send replaces the address's older live link (revoked); the automatic send when the goods
 *             leave sends once per address (a repeated event finds the link and sends nothing).
 *   renew     "Ask for a new link" (public; the token in x-factory-link): ONE answer, at once, whatever the token; the
 *             work runs after the answer (officeAuth afterAnswer), so neither content nor time tells anything. A new
 *             link goes only to the address the old one was sent to, only while it is an ACTIVE contact of the party,
 *             only for an expired or used-up link of a shipment (never a withdrawn one), not twice in ten minutes.
 */

export type DocumentLinkReason = (typeof DOCUMENT_LINK_REASONS)[number]

/** Every address got its link already (or asked again too soon): the command writes nothing. */
class NothingToSend extends Error {
  constructor(readonly skipped: SendResult['skipped']) {
    super('nothing to send')
  }
}

/** Nobody can receive the link: the party has no such contact (or every address is suppressed). */
export class NoRecipientsError extends InvalidStateError {
  override name = 'NoRecipientsError'
}

export interface Sender {
  readonly userId: string
  readonly name: string
  readonly email: string | null
}

export type Recipients = { readonly kind: 'default' } | { readonly kind: 'contacts'; readonly contactIds: readonly string[] } | { readonly kind: 'address'; readonly email: string }

export interface SendRequest {
  readonly email: EmailRuntime
  /** The writer: an office session or the tenant's system. */
  readonly caller: CommandCaller
  /** The tenant's system, which claims and sends the mail (as the worker would). */
  readonly delivery: CommandCaller
  readonly shipment: ShipmentHeader
  readonly reason: DocumentLinkReason
  readonly to: Recipients
  readonly expiresInDays?: number | undefined
  /** The office user who sends; null for the system. */
  readonly sender: Sender | null
  readonly idempotencyKey?: string | undefined
  readonly causationId?: string | undefined
  /** The link a new one replaces (asked again). */
  readonly renewalOf?: string | undefined
}

export interface SentLink {
  readonly linkId: string
  readonly email: string
  readonly expiresAt: string
  readonly maxUses: number
  readonly outboundId: string
  readonly delivery: string
}

export interface SendResult {
  readonly links: readonly SentLink[]
  readonly skipped: readonly { readonly email: string; readonly reason: 'SUPPRESSED' | 'ALREADY_SENT' | 'ASKED_RECENTLY' }[]
}

const normal = (email: string): string => email.trim().toLowerCase()
const DAY_MS = 24 * 60 * 60 * 1000

/** The addresses asked for, checked against the party's contacts (never an address typed for the party). */
function addressesOf(to: Recipients, contacts: readonly ContactFacts[]): string[] {
  if (to.kind === 'address') return [normal(to.email)]
  if (to.kind === 'default') return linkRecipients(contacts).map((contact) => normal(contact.email!))
  const issues: Issue[] = []
  const addresses: string[] = []
  to.contactIds.forEach((contactId, index) => {
    const contact = contacts.find((entry) => entry.id === contactId)
    if (!contact) issues.push({ path: `body/contactIds/${index}`, message: 'Not a contact of the shipment\'s customer.' })
    else if (contact.status !== 'ACTIVE') issues.push({ path: `body/contactIds/${index}`, message: `${contact.name} is not an active contact.` })
    else if (!contact.email) issues.push({ path: `body/contactIds/${index}`, message: `${contact.name} has no e-mail address.` })
    else addresses.push(normal(contact.email))
  })
  if (issues.length > 0) throw new ValidationError('The link cannot go to these contacts.', issues)
  return [...new Set(addresses)]
}

const linkUrl = (email: EmailRuntime, token: string): string => `${email.webOrigin}/l#token=${encodeURIComponent(token)}`

/** Sends the shipment's documents link to each address (see the file's comment). */
export async function sendDocumentLinks(request: SendRequest): Promise<SendResult> {
  const { caller, shipment, email } = request
  const context = caller.factoryContext!
  const tenantId = tenantOf(context)
  const problem = attachStateProblem(shipment.status)
  if (problem) throw new InvalidStateError(problem)

  const facts = await caller.withClient(async (client) => {
    const contacts = await contactsOf(client, shipment.partyId)
    const addresses = addressesOf(request.to, contacts)
    const suppressed = addresses.length > 0 ? await client.suppression.findMany({ where: { address: { in: addresses } }, select: { address: true } }) : []
    const read = await readDocuments(client, shipment)
    return { addresses, suppressed: new Set(suppressed.map((row) => row.address)), read }
  })
  const addresses = facts.addresses.filter((address) => !facts.suppressed.has(address))
  const skipped: { email: string; reason: 'SUPPRESSED' | 'ALREADY_SENT' | 'ASKED_RECENTLY' }[] = facts.addresses.filter((address) => facts.suppressed.has(address)).map((address) => ({ email: address, reason: 'SUPPRESSED' as const }))
  if (addresses.length === 0) {
    throw new NoRecipientsError(
      facts.addresses.length === 0
        ? 'Nobody of the customer can receive the link: give the party an active orders or quality contact with an e-mail address, then send it.'
        : 'Every address of the customer\'s contacts is suppressed (it bounced or complained): correct it, then send the link.',
    )
  }

  // The documents the link shows now, for the mail's list (the copies already on the shipment).
  const { read } = facts
  const locale = localeOf(read.order?.language)
  const titles = linkDocuments(read.facts.shared, read.documents.documents).map((entry) => (entry.kind === 'OTHER' ? entry.title : documentTitle({ kind: entry.kind, number: entry.number, style: entry.style ? { id: '', ...entry.style } : null, language: entry.language }, locale)))
  const days = request.expiresInDays ?? LINK_EXPIRY_DAYS
  // Minted here, outside the command: only their hashes enter the transaction.
  const minted = new Map(addresses.map((address) => {
    const linkId = newId()
    return [address, { linkId, outboundId: newId(), token: mintLinkToken({ tenantId, partyId: shipment.partyId, linkId }).value }] as const
  }))
  const mailFor = (expiresAt: Date, url: string | null) =>
    documentsLinkMail({ locale, shipmentNumber: shipment.number, orderNumber: read.order?.number ?? null, customerRef: read.order?.customerRef ?? null, titles, expiresAt, renewal: request.reason === 'ASKED_AGAIN' }, url)

  let outcome: { readonly result: SendResult; readonly replayed: boolean }
  try {
    outcome = await documentsCommand(
      caller,
      {
        name: 'shipping.sendDocumentLink',
        idempotencyKey: request.idempotencyKey,
        input: { shipmentId: shipment.id, reason: request.reason, to: request.to, expiresInDays: days, renewalOf: request.renewalOf ?? null },
        ...(request.causationId ? { causationId: request.causationId } : {}),
      },
      async (tools) => {
        const { tx, now } = tools
        await lockShipmentDocuments(tx, tenantId, shipment.id)
        const current = await readShipment(tx, shipment.id)
        if (!current) throw new InvalidStateError('The shipment is gone.')
        const stateProblem = attachStateProblem(current.status)
        if (stateProblem) throw new InvalidStateError(stateProblem)
        const actorId = context.audience === 'office' ? context.actorId : SYSTEM_ACTOR_ID
        const existing = await tx.oneOffLink.findMany({
          where: { recordType: 'Shipment', recordId: current.id, purpose: 'DOCUMENT_VIEW', email: { in: addresses } },
          select: { id: true, email: true, createdAt: true, revokedAt: true, expiresAt: true, uses: true, maxUses: true },
        })
        const skippedNow: typeof skipped = []
        const sending: string[] = []
        for (const address of addresses) {
          const own = existing.filter((link) => link.email === address)
          if (request.reason === 'SHIPPED' && own.some((link) => link.revokedAt === null)) skippedNow.push({ email: address, reason: 'ALREADY_SENT' })
          else if (request.reason === 'ASKED_AGAIN' && own.some((link) => link.createdAt.getTime() > now.getTime() - RENEW_COALESCE_MS)) skippedNow.push({ email: address, reason: 'ASKED_RECENTLY' })
          else sending.push(address)
        }
        if (sending.length === 0) throw new NothingToSend(skippedNow)

        // The office's new link replaces the address's older live one: one live link per address and shipment.
        if (request.reason === 'OFFICE') {
          for (const link of existing.filter((entry) => sending.includes(entry.email!) && linkState(entry, now) === 'LIVE')) {
            await tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now, revokedById: actorId } })
            tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId: current.companyId, after: { revokedAt: toUtcIso(now) }, reason: 'Replaced by a new link to the same address.' })
          }
        }

        const identity = await sendingIdentity(tx, current.companyId, null, 'CONVERSATION')
        const { thread } = await ensureThread(tools, { type: 'Shipment', id: current.id }, context.audience === 'office' ? context.actorId : null)
        const earlier = await tx.message.findMany({ where: { threadId: thread.id, emailMessageId: { not: null } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { emailMessageId: true } })
        const threading = threadingOf(earlier.map((row) => row.emailMessageId as string))
        const from = fromLine(identity, request.sender ? { name: request.sender.name, email: request.sender.email } : null)
        const expiresAt = new Date(now.getTime() + days * DAY_MS)
        const author = request.sender ? { kind: 'USER' as const, id: request.sender.userId, name: request.sender.name } : { kind: 'SYSTEM' as const, id: null, name: identity.displayName }
        const links: SentLink[] = []
        for (const address of sending) {
          const { linkId, outboundId, token } = minted.get(address)!
          await tx.oneOffLink.createMany({
            data: [
              {
                id: linkId,
                companyId: current.companyId,
                partyId: current.partyId,
                purpose: 'DOCUMENT_VIEW',
                recordType: 'Shipment',
                recordId: current.id,
                tokenHash: linkTokenHash(token),
                email: address,
                note: request.reason === 'SHIPPED' ? 'Sent when the goods left.' : request.reason === 'ASKED_AGAIN' ? 'The party asked for a new link.' : null,
                expiresAt,
                maxUses: LINK_MAX_USES,
                createdAt: now,
                updatedAt: now,
                createdById: actorId,
              },
            ],
          })
          tools.audit({
            action: 'links.create',
            recordType: 'OneOffLink',
            recordId: linkId,
            companyId: current.companyId,
            after: { purpose: 'DOCUMENT_VIEW', recordType: 'Shipment', recordId: current.id, partyId: current.partyId, email: address, expiresAt: toUtcIso(expiresAt), maxUses: LINK_MAX_USES, reason: request.reason, renewalOf: request.renewalOf ?? null },
          })
          const mail = mailFor(expiresAt, null)
          const emailMessageId = messageIdFor(outboundId, identity.domain)
          const message = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author, bodyText: cleanBody(mail.body), emailMessageId })
          await tx.emailOutbound.create({
            data: {
              id: outboundId,
              companyId: identity.companyId,
              identityId: identity.id,
              threadId: thread.id,
              messageId: message.id,
              recordType: 'Shipment',
              recordId: current.id,
              templateKey: 'thread.message',
              locale,
              fromAddress: from.address,
              fromName: from.name,
              to: [address],
              subject: mail.subject,
              emailMessageId,
              inReplyTo: threading.inReplyTo,
              referenceIds: threading.references,
              status: 'QUEUED',
              queuedAt: now,
              createdAt: now,
              updatedAt: now,
              createdById: request.sender?.userId ?? null,
            },
            select: { id: true },
          })
          tools.audit({
            recordType: 'EmailOutbound',
            recordId: outboundId,
            companyId: identity.companyId,
            siteId: thread.siteId,
            after: { threadId: thread.id, messageId: message.id, identityId: identity.id, templateKey: 'thread.message', recipients: 1, attachments: 0, status: 'QUEUED', linkId },
          })
          links.push({ linkId, email: address, expiresAt: toUtcIso(expiresAt), maxUses: LINK_MAX_USES, outboundId, delivery: 'QUEUED' })
        }
        tools.emit({
          type: 'shipment.documents_link_sent',
          subject: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          payload: { shipmentId: current.id, number: current.number, links: links.length, reason: request.reason },
        })
        return { links, skipped: skippedNow }
      },
    )
  } catch (error) {
    if (error instanceof NothingToSend) return { links: [], skipped: [...skipped, ...error.skipped] }
    throw error
  }
  const { result, replayed } = outcome

  if (replayed) {
    // A repeat: its mails were sent (or failed) the first time; say where each is now.
    const statuses = await caller.withClient((client) => client.emailOutbound.findMany({ where: { id: { in: result.links.map((link) => link.outboundId) } }, select: { id: true, status: true } }))
    return { links: result.links.map((link) => ({ ...link, delivery: statuses.find((row) => row.id === link.outboundId)?.status ?? link.delivery })), skipped: [...skipped, ...result.skipped] }
  }

  const tokens = new Map([...minted.values()].map((entry) => [entry.linkId, entry.token]))
  const sent: SentLink[] = []
  for (const link of result.links) {
    const url = linkUrl(email, tokens.get(link.linkId)!)
    const outcome = await deliverOutbound(email, request.delivery, link.outboundId, {
      retry: false,
      clock: documentsClock(),
      ...(request.causationId ? { causationId: request.causationId } : {}),
      build: (row) => linkMailMime(email, request.delivery, row, mailFor(new Date(link.expiresAt), url).body, request.sender),
    })
    sent.push({ ...link, delivery: outcome === 'sent' ? 'SENT' : outcome === 'failed' ? 'FAILED' : link.delivery })
  }
  return { links: sent, skipped: [...skipped, ...result.skipped] }
}

/** The MIME of a link mail: its text WITH the link (in memory only), the sender's signature, the footer, the thread's reply address. */
async function linkMailMime(email: EmailRuntime, caller: CommandCaller, row: ClaimedOutbound, body: string, sender: Sender | null): Promise<string> {
  const thread = await caller.withClient((client) => client.thread.findUniqueOrThrow({ where: { id: row.threadId! }, select: { replyToken: true } }))
  const company = await companyLegalOf(caller, row.companyId)
  const mail = compose(
    { template: 'thread.message', body: cleanBody(body), senderName: sender?.name ?? null, companyName: row.identity.displayName, attachmentNames: [] },
    { locale: localeOf(row.locale), company, privacyUrl: privacyNoticeUrl(email.webOrigin, row.companyId) },
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
    date: documentsClock().now(),
    text: mail.text,
    html: mail.html,
    automatic: sender === null,
  })
}

// ---- ask for a new link -----------------------------------------------------------------------------------------------

/** A view of the request in another context (the platform's, a tenant's system): `withClient` follows its context. */
function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

/**
 * The work behind "ask for a new link", after the answer (see the file's comment). Every refusal is silent; the reason is
 * logged by kind only (never the token, the link or the address).
 */
export async function renewDocumentLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
  const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
  if (!token) return 'NOT_A_TOKEN'
  const requestId = String(request.id)
  const platform = asContext(request, { audience: 'platform', actorId: SYSTEM_ACTOR_ID, grants: [], requestId })
  const tenant = await platform.withClient((client) => client.tenant.findUnique({ where: { id: token.tenantId }, select: { status: true } }))
  if (tenant?.status !== 'ACTIVE') return 'UNKNOWN'
  const system = asContext(request, systemContext(token.tenantId, requestId))
  const found = await system.withClient(async (client) => {
    const link = await client.oneOffLink.findUnique({
      where: { id: token.linkId },
      select: { id: true, partyId: true, purpose: true, recordType: true, recordId: true, tokenHash: true, email: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true },
    })
    // The token must be this link's (constant-time hash compare) and name its party.
    if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash)) return null
    const shipment = link.recordType === 'Shipment' ? await readShipment(client, link.recordId) : null
    const contacts = shipment ? await contactsOf(client, shipment.partyId) : []
    const recent = link.email
      ? await client.oneOffLink.count({ where: { recordType: link.recordType, recordId: link.recordId, purpose: 'DOCUMENT_VIEW', email: link.email, createdAt: { gt: new Date(documentsClock().now().getTime() - RENEW_COALESCE_MS) } } })
      : 0
    return { link, shipment, contacts, recent }
  })
  if (!found) return 'UNKNOWN'
  const { link, shipment } = found
  const refusal = renewalRefusal({
    purpose: link.purpose,
    recordType: link.recordType,
    revoked: link.revokedAt !== null,
    email: link.email,
    state: linkState(link, documentsClock().now()),
    shipmentStatus: shipment?.status ?? null,
    contacts: found.contacts,
    askedRecently: found.recent > 0,
  })
  if (refusal) return refusal
  try {
    const sent = await sendDocumentLinks({
      email,
      caller: system,
      delivery: system,
      shipment: shipment!,
      reason: 'ASKED_AGAIN',
      to: { kind: 'address', email: link.email! },
      sender: null,
      renewalOf: link.id,
    })
    return sent.links.length > 0 ? 'SENT' : 'ASKED_RECENTLY'
  } catch (error) {
    if (error instanceof NoRecipientsError) return 'NO_ADDRESS'
    throw error
  }
}

/** The link token a request carries (the renew route reads the header the link pages send). */
export const linkTokenOf = (request: FastifyRequest): unknown => request.headers[LINK_HEADER]
