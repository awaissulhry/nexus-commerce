import type { FastifyRequest } from 'fastify'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import { goodsDueByOf, RETURN_LIMITS } from '@nexus/factory-domain/sales/returns/rules'
import { command, idempotencyKeyFrom, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { deliverLinkMail } from '../../../platform/links/mail'
import { assertNoPayByLink, LinkRefusedError } from '../../../platform/links/pay'
import { officeOf, officeReturn } from '../returns/access'
import { policyOf } from '../returns/policy'
import { openSafetyEntries } from '../returns/register'
import { lockReturn, recordOf, touchReturn } from '../returns/rma'
import { asDay, LINE_COLUMNS } from '../returns/store'
import type { Reader } from './store'

/**
 * The office's side of a request from outside (B-W2b-192; design sales.returns "Return (RMA)", the plan "the office
 * authorises in Returns as today"; links.claim "made with a shipment"):
 *
 *   POST /sales/returns/:id/authorise {version, goodsDueBy?}  sales.returns.manage: a REQUESTED return (a customer's, from
 *        the portal or a claim link) → AUTHORISED as the office's own new return is (the maker authorises, the goods due by
 *        the return policy's days from today, unless a day is given; the person becomes its owner when it has none; a
 *        protective garment returned for a defect opens its PPE register entry in the same command: W2a's register.ts).
 *        W2a's events return.authorised and return.status_changed tell the dock and the customer's pages.
 *   POST /sales/returns/:id/reject {version, reason}          sales.returns.manage: REQUESTED → REJECTED with the reason the
 *        customer reads ("Not accepted: …").
 *   POST /sales/claim-links {recordType, recordId, contactId? | email?, send, language?, expiresInDays?}
 *        sales.returns.manage over the record's company and customer: a CLAIM link ("Report a problem") for a shipment that
 *        left (SHIPPED or DELIVERED) or an order of the customer. ONE command makes the link (the token minted before it, only
 *        its hash stored) and queues its mail; after the commit the mail goes (FAKE locally) or, without `send`, the address
 *        comes back ONCE for the office to pass on. No price by a claim link (the purpose holds no grain).
 *
 * Every write is ONE command(); the RMA row FOR UPDATE at the version the screen read (W2a's lockReturn), its version moved.
 */

export async function authoriseReturn(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly goodsDueBy?: BusinessDate | null | undefined }, idempotencyKey?: string) {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const registerEntries = (
    await command(caller, { name: 'portalReturns.authorise', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
      const rma = await lockReturn(tools, seen.id, body.version, ['REQUESTED'], 'it is authorised')
      const today = businessDate(tools.now)
      if (body.goodsDueBy && body.goodsDueBy < today) throw new ValidationError('The deadline for the goods is today or later.', [{ path: 'body/goodsDueBy', message: 'The deadline for the goods is today or later.' }])
      const goodsDueBy = body.goodsDueBy === undefined ? goodsDueByOf(today, await policyOf(tools.tx, rma.companyId)) : body.goodsDueBy
      const after = await touchReturn(tools, rma, { status: 'AUTHORISED', authorisedAt: tools.now, authorisedById: context.actorId, goodsDueBy: goodsDueBy ? asDay(goodsDueBy) : null, ownerId: rma.ownerId ?? context.actorId })
      const lines = await tools.tx.returnLine.findMany({ where: { returnId: rma.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
      tools.audit({ action: 'portalReturns.authorise', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: 'REQUESTED' }, after: { status: 'AUTHORISED', goodsDueBy, ownerId: after.ownerId } })
      tools.emit({ type: 'return.authorised', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, partyId: rma.partyId, salesOrderId: rma.salesOrderId, lineIds: lines.map((line) => line.id), goodsDueBy } })
      tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: 'REQUESTED', to: 'AUTHORISED' } })
      return openSafetyEntries(tools, rma, lines)
    })
  ).result
  return { return: await recordOf(caller, seen.id), registerEntries }
}

export async function rejectReturn(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const reason = body.reason.trim()
  if (reason === '' || reason.length > RETURN_LIMITS.statusReason) throw new ValidationError('Say why, in words the customer reads.', [{ path: 'body/reason', message: reason === '' ? 'Say why, in words the customer reads.' : `At most ${RETURN_LIMITS.statusReason} characters.` }])
  await command(caller, { name: 'portalReturns.reject', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const rma = await lockReturn(tools, seen.id, body.version, ['REQUESTED'], 'it is rejected')
    await touchReturn(tools, rma, { status: 'REJECTED', closedAt: tools.now, statusReason: reason })
    tools.audit({ action: 'portalReturns.reject', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: 'REQUESTED' }, after: { status: 'REJECTED', statusReason: reason } })
    tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: 'REQUESTED', to: 'REJECTED' } })
    return null
  })
  return { return: await recordOf(caller, seen.id) }
}

// ---- the claim link -------------------------------------------------------------------------------------------------------

export const CLAIM_MAIL_TEMPLATE = 'sales.claim_link'
export type ClaimRecordType = 'Shipment' | 'SalesOrder'
type Locale = 'it' | 'en'

export interface ClaimLinkBody {
  readonly recordType: ClaimRecordType
  readonly recordId: string
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly send: boolean
  readonly language?: Locale | undefined
  readonly expiresInDays?: number | undefined
}

export interface ClaimRecord {
  readonly companyId: string
  readonly partyId: string
  readonly siteId: string | null
  readonly label: string
}

/** The shipment (left us) or the order a claim link names, read in the caller's scope; null when it is not one. */
export async function claimRecordOf(db: Reader, recordType: ClaimRecordType, recordId: string): Promise<ClaimRecord | null> {
  if (!isUuid(recordId)) return null
  if (recordType === 'Shipment') {
    const row = await db.shipment.findUnique({ where: { id: recordId }, select: { companyId: true, partyId: true, siteId: true, number: true, status: true, salesOrderId: true } })
    if (!row || !['SHIPPED', 'DELIVERED'].includes(row.status)) return null
    const order = row.salesOrderId ? await db.salesOrder.findUnique({ where: { id: row.salesOrderId }, select: { number: true, customerRef: true } }) : null
    return { companyId: row.companyId, partyId: row.partyId, siteId: row.siteId, label: [row.number, order?.customerRef ?? order?.number].filter(Boolean).join(' · ') }
  }
  const row = await db.salesOrder.findUnique({ where: { id: recordId }, select: { companyId: true, partyId: true, number: true, customerRef: true, status: true } })
  if (!row || row.status === 'CANCELLED') return null
  return { companyId: row.companyId, partyId: row.partyId, siteId: null, label: [row.customerRef, row.number].filter(Boolean).join(' · ') }
}

export function claimMail(locale: Locale, input: { readonly companyName: string; readonly label: string; readonly expiresAt: Date }, url: string) {
  const until = toUtcIso(input.expiresAt).slice(0, 10)
  if (locale === 'it') {
    return {
      subject: `Segnala un problema — ${input.label} — ${input.companyName}`,
      body: [
        'Buongiorno,',
        '',
        `se qualcosa di ${input.label} non va, da questo link può chiedere un reso o segnalarci un problema di qualità, con le foto:`,
        url,
        '',
        `Il link vale fino al ${until.split('-').reverse().join('/')} ed è solo per voi: non inoltratelo.`,
      ].join('\n'),
    }
  }
  return {
    subject: `Report a problem — ${input.label} — ${input.companyName}`,
    body: ['Hello,', '', `If something about ${input.label} is not right, ask for a return or report a quality problem, with photos, from this link:`, url, '', `The link works until ${until} and is for you only: please do not forward it.`].join('\n'),
  }
}

async function identityFor(tools: Pick<CommandTools, 'tx'>, companyId: string) {
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
    throw error
  }
}

export interface MadeClaimLink {
  readonly linkId: string
  readonly outboundId: string | null
  readonly expiresAt: string
}

/**
 * Makes a CLAIM link inside the caller's command (the office's, or the system's for a link asked from a tracking page):
 * the pay rule, a suppressed address, the link row (only the token's hash), its audit row, the mail queued when `to` is
 * given and `send`, claim_link.sent.
 */
export async function makeClaimLinkInCommand(
  tools: CommandTools,
  input: { readonly record: ClaimRecord & { readonly type: ClaimRecordType; readonly id: string }; readonly linkId: string; readonly tokenHash: string; readonly to: string | null; readonly contactId: string | null; readonly send: boolean; readonly expiresInDays?: number | undefined; readonly via: 'OFFICE' | 'TRACKING'; readonly createdById: string; readonly renewalOfId?: string | null | undefined; readonly mail: (expiresAt: Date) => { subject: string }; readonly locale: Locale; readonly sender: { name: string; email: string } | null },
): Promise<MadeClaimLink> {
  const { record } = input
  await assertNoPayByLink(tools.tx, { recordType: record.type, recordId: record.id })
  if (input.send && input.to && (await suppressedAmong(tools.tx, [input.to])).size > 0) throw new LinkRefusedError('SUPPRESSED', 'This address bounced or complained: correct it first.')
  const terms = linkTerms('CLAIM', { expiresInDays: input.expiresInDays }, tools.now)
  await tools.tx.oneOffLink.createMany({
    data: [
      {
        id: input.linkId,
        companyId: record.companyId,
        partyId: record.partyId,
        purpose: 'CLAIM',
        recordType: record.type,
        recordId: record.id,
        tokenHash: input.tokenHash,
        email: input.to,
        expiresAt: terms.expiresAt,
        maxUses: terms.maxUses,
        contactId: input.contactId,
        renewalOfId: input.renewalOfId ?? null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: input.createdById,
      },
    ],
  })
  tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: input.linkId, companyId: record.companyId, ...(record.siteId ? { siteId: record.siteId } : {}), after: { purpose: 'CLAIM', recordType: record.type, recordId: record.id, partyId: record.partyId, email: input.to, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses, via: input.via } })
  let outboundId: string | null = null
  if (input.send && input.to) {
    const identity = await identityFor(tools, record.companyId)
    const from = fromLine(identity, input.sender)
    outboundId = newId()
    await tools.tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'OneOffLink',
        recordId: input.linkId,
        templateKey: CLAIM_MAIL_TEMPLATE,
        locale: input.locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [input.to],
        subject: input.mail(terms.expiresAt).subject,
        emailMessageId: messageIdFor(outboundId, identity.domain),
        status: 'QUEUED',
        queuedAt: tools.now,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: input.createdById,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: CLAIM_MAIL_TEMPLATE, linkId: input.linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
  }
  tools.emit({ type: 'claim_link.sent', subject: input.linkId, companyId: record.companyId, payload: { linkId: input.linkId, recordType: record.type, recordId: record.id, partyId: record.partyId, via: input.via, mailed: outboundId !== null, expiresAt: toUtcIso(terms.expiresAt) } })
  return { linkId: input.linkId, outboundId, expiresAt: toUtcIso(terms.expiresAt) }
}

const localeOf = (language: string | null | undefined): Locale => (language === 'en' ? 'en' : 'it')

/** POST /sales/claim-links. */
export async function sendClaimLink(request: FastifyRequest, body: ClaimLinkBody) {
  const context: OfficeContext = officeOf(request)
  const auth = officeAuthOf(request.server)
  const facts = await request.withClient(async (client) => {
    const record = await claimRecordOf(client, body.recordType, body.recordId)
    if (!record) return null
    const party = await client.party.findUnique({ where: { id: record.partyId }, select: { language: true } })
    const company = await client.company.findUnique({ where: { id: record.companyId }, select: { legalName: true, tradeName: true } })
    const contact = body.contactId && isUuid(body.contactId) ? await client.partyContact.findFirst({ where: { id: body.contactId, partyId: record.partyId, status: 'ACTIVE' }, select: { email: true, language: true } }) : null
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return { record, party, company, contact, user }
  })
  if (!facts || !can(actorOf(context), SALES_RETURNS_MANAGE, { companyId: facts.record.companyId, partyId: facts.record.partyId })) throw new NotFoundError(body.recordType === 'Shipment' ? 'Shipment not found (or it has not left yet).' : 'Order not found.')
  if (body.contactId && !facts.contact?.email) throw new ValidationError('Not a contact of this customer with an e-mail.', [{ path: 'body/contactId', message: 'Not a contact of this customer with an e-mail.' }])
  const typed = body.email === undefined ? null : emailOrThrow(body.email, 'body/email')
  const to = facts.contact?.email?.trim().toLowerCase() ?? typed
  if (body.send && !to) throw new ValidationError('Give the address the link goes to, or take the link to pass it on yourself.', [{ path: 'body/email', message: 'An address to send the link to.' }])
  const locale: Locale = body.language ?? localeOf(facts.contact?.language ?? facts.party?.language)
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: facts.record.partyId, linkId })
  const companyName = facts.company?.tradeName ?? facts.company?.legalName ?? ''
  const sender = facts.user ? { name: facts.user.displayName, email: facts.user.email } : null
  const mail = (expiresAt: Date) => claimMail(locale, { companyName, label: facts.record.label, expiresAt }, '')
  const { result, replayed } = await command(request, { name: 'portalReturns.claimLink', idempotencyKey: idempotencyKeyFrom(request), input: body }, (tools) =>
    makeClaimLinkInCommand(tools, { record: { ...facts.record, type: body.recordType, id: body.recordId }, linkId, tokenHash: linkTokenHash(token.value), to, contactId: facts.contact ? body.contactId! : null, send: body.send, expiresInDays: body.expiresInDays, via: 'OFFICE', createdById: context.actorId, mail, locale, sender }),
  )
  const answer = { link: { id: result.linkId, purpose: 'CLAIM' as const, recordType: body.recordType, recordId: body.recordId, expiresAt: result.expiresAt, email: to } }
  if (replayed) return { ...answer, url: null, delivery: result.outboundId ? ('QUEUED' as const) : null }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { ...answer, url, delivery: null }
  const text = claimMail(locale, { companyName, label: facts.record.label, expiresAt: new Date(result.expiresAt) }, url).body
  const delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, text, sender?.name ?? null, auth.clock)
  return { ...answer, url: null, delivery }
}
