import type { FastifyRequest } from 'fastify'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { SALES_RETURNS_MANAGE, SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { cancellable, RETURN_LABEL_LINK, RETURN_LABEL_MAIL_TEMPLATE, returnLabelMail, type ReturnLabelMode, type ReturnLabelStatus } from '@nexus/factory-domain/shipping/return-labels/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { storeCall, systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { deliverLinkMail } from '../../../platform/links/mail'
import { linkCommand } from '../../../platform/links/use'
import { mayOn, officeReturn } from '../../sales/returns/access'
import type { CarrierRuntime } from '../labels/carrier'
import { recipientsOf } from '../tracking-link/office'
import { bookCarrier, insertBookedInCommand, labelChanged, labelFactsOf, lockReturn, readReturn, refused, type ReturnRow } from './book'

/**
 * Return labels for the office (B-W2b-398; LOG-112; design sales.returns RMA › Shipments "Return label or link", "Make
 * return label", the Return label PDF window):
 *
 *   GET  /sales/returns/:returnId/return-labels                    sales.returns.view: the labels, what stops a new one, who
 *                                                                  may get its link
 *   POST /sales/returns/:returnId/return-labels                    sales.returns.manage: a label booked now (LABEL), or
 *                                                                  offered by a link (LINK) mailed to the customer's orders
 *                                                                  contacts or passed on (its address in this answer once)
 *   POST /sales/returns/:returnId/return-labels/:labelId/cancel    sales.returns.manage: withdrawn (an offered one's link with it)
 *   GET  /sales/returns/:returnId/return-labels/:labelId/pdf       sales.returns.view: the label PDF (the window prints it)
 */

const LABEL_SELECT = { id: true, status: true, carrierCode: true, bookingReference: true, labelFileId: true, linkId: true, usedAt: true, createdAt: true, updatedAt: true } as const
const LINK_SELECT = { id: true, email: true, expiresAt: true, revokedAt: true, lastUsedAt: true } as const

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

async function labelsOf(db: CommandTx, returnId: string) {
  const rows = await db.returnLabel.findMany({ where: { returnId }, select: LABEL_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
  const files = await db.storedFile.findMany({ where: { id: { in: rows.flatMap((row) => (row.labelFileId ? [row.labelFileId] : [])) } }, select: { id: true, originalName: true } })
  const links = await db.oneOffLink.findMany({ where: { id: { in: rows.flatMap((row) => (row.linkId ? [row.linkId] : [])) } }, select: LINK_SELECT })
  return rows.map((row) => {
    const file = files.find((entry) => entry.id === row.labelFileId) ?? null
    const link = links.find((entry) => entry.id === row.linkId) ?? null
    return {
      id: row.id,
      status: row.status as ReturnLabelStatus,
      mode: (row.linkId ? 'LINK' : 'LABEL') as ReturnLabelMode,
      carrierCode: row.carrierCode,
      bookingReference: row.bookingReference,
      file: file ? { id: file.id, name: file.originalName } : null,
      link: link ? { email: link.email, expiresAt: toUtcIso(link.expiresAt), revoked: link.revokedAt !== null, lastOpenedAt: iso(link.lastUsedAt) } : null,
      usedAt: iso(row.usedAt),
      createdAt: toUtcIso(row.createdAt),
      changedAt: toUtcIso(row.updatedAt),
    }
  })
}

/** GET: the return's labels and what a new one needs. */
export async function getReturnLabels(caller: CommandCaller, returnId: string) {
  const { context, rma: header } = await officeReturn(caller, returnId, SALES_RETURNS_VIEW)
  const recipients = await recipientsOf(caller, header.partyId)
  return caller.withClient(async (db) => {
    const rma = (await readReturn(db, header.id))!
    const facts = await labelFactsOf(db, rma)
    return {
      return: { id: rma.id, number: rma.number, status: rma.status },
      labels: await labelsOf(db, rma.id),
      make: { held: facts.held, shipment: facts.shipment, shipments: facts.shipments, carrierCode: facts.carrierCode, linkDays: RETURN_LABEL_LINK.expiryDays },
      recipients: recipients.map(({ contactId, name, email }) => ({ contactId, name, email })),
      mayManage: mayOn(context, SALES_RETURNS_MANAGE, rma),
    }
  })
}

export interface MakeBody {
  readonly mode: ReturnLabelMode
  /** The shipment whose addresses are swapped (one of the order's that left); none: the newest. */
  readonly shipmentId?: string | undefined
  /** LINK: mail it to the customer's orders contacts (all, or those named); false: one link to pass on. */
  readonly send?: boolean | undefined
  readonly contactIds?: readonly string[] | undefined
}

/** POST: a return label made (see above). Answers the labels and, for a link to pass on, its address once. */
export async function makeReturnLabel(runtime: { readonly carrier: CarrierRuntime; readonly files: FilesRuntime }, request: FastifyRequest, returnId: string, body: MakeBody, idempotencyKey?: string) {
  const { context, rma: header } = await officeReturn(request, returnId, SALES_RETURNS_MANAGE)
  if (body.shipmentId !== undefined && !isUuid(body.shipmentId)) throw new ValidationError('Choose a shipment of the return\'s order.', [{ path: 'body/shipmentId', message: 'Not a shipment of the return\'s order.' }])
  const rma = (await request.withClient((db) => readReturn(db, header.id)))!
  const facts = await request.withClient((db) => labelFactsOf(db, rma, body.shipmentId))
  if (body.shipmentId !== undefined && facts.shipment === null) throw new ValidationError('Choose a shipment of the return\'s order.', [{ path: 'body/shipmentId', message: 'Not a shipment of the return\'s order that left us.' }])
  if (facts.held) refused(facts.held)
  let url: string | null = null
  if (body.mode === 'LABEL') {
    const labelId = newId()
    const booked = await bookCarrier(runtime, request, rma, facts, labelId)
    await command(request, { name: 'shipping.returnLabel', idempotencyKey, input: { returnId: rma.id, mode: 'LABEL', shipmentId: facts.shipment!.id } }, async (tools) => {
      await insertBookedInCommand(tools, rma, labelId, facts.carrierCode!, booked)
      return { labelId }
    })
  } else {
    url = await offerByLink(request, context.actorId, context.tenantId, rma, facts.carrierCode!, body, idempotencyKey)
  }
  return { url, labels: await getReturnLabels(request, rma.id) }
}

/** The LINK mode: the link and the OFFERED label in ONE command, then each mail sent with the link in memory. */
async function offerByLink(request: FastifyRequest, actorId: string, tenantId: string, rma: ReturnRow, carrierCode: string, body: MakeBody, idempotencyKey: string | undefined): Promise<string | null> {
  const auth = officeAuthOf(request.server)
  const send = body.send !== false
  const all = await recipientsOf(request, rma.partyId)
  const unknown = (body.contactIds ?? []).filter((id) => !all.some((recipient) => recipient.contactId === id))
  if (unknown.length > 0) throw new ValidationError('Choose among the customer\'s orders contacts.', [{ path: 'body/contactIds', message: 'One of these is not an active orders contact of the customer with an e-mail address.' }])
  const to = send ? (body.contactIds && body.contactIds.length > 0 ? all.filter((recipient) => body.contactIds!.includes(recipient.contactId)) : all) : []
  if (send && to.length === 0) refused('NO_RECIPIENT')
  const words = await request.withClient(async (db) => {
    const company = await db.company.findUnique({ where: { id: rma.companyId }, select: { legalName: true, tradeName: true } })
    const party = await db.party.findUnique({ where: { id: rma.partyId }, select: { language: true } })
    const user = await db.user.findUnique({ where: { id: actorId }, select: { displayName: true, email: true } })
    return { companyName: company?.tradeName ?? company?.legalName ?? '', partyLanguage: party?.language ?? null, user }
  })
  const linkId = newId()
  const labelId = newId()
  const token = mintLinkToken({ tenantId, partyId: rma.partyId, linkId }).value
  const { result, replayed } = await linkCommand(request, { name: 'shipping.returnLabelLink', idempotencyKey, input: { returnId: rma.id, mode: 'LINK', to: to.map((recipient) => recipient.email) } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockReturn(tx, rma.id)
    if (current.status !== 'AUTHORISED' && current.status !== 'RECEIVED') refused('RETURN_CLOSED')
    const expiresAt = new Date(now.getTime() + RETURN_LABEL_LINK.expiryDays * 86_400_000)
    const suppressed = await suppressedAmong(tx, to.map((recipient) => recipient.email))
    const going = to.filter((recipient) => !suppressed.has(recipient.email))
    if (send && going.length === 0) refused('NO_RECIPIENT', 'Every address of the customer\'s orders contacts bounced or complained (it is suppressed): correct it, or pass the link on.')
    await tx.oneOffLink.createMany({
      data: [
        {
          id: linkId,
          companyId: rma.companyId,
          partyId: rma.partyId,
          purpose: 'RETURN_LABEL',
          recordType: 'ReturnAuthorisation',
          recordId: rma.id,
          tokenHash: linkTokenHash(token),
          email: going[0]?.email ?? null,
          contactId: going[0]?.contactId ?? null,
          note: RETURN_LABEL_LINK.note,
          expiresAt,
          maxUses: 1,
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        },
      ],
    })
    tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: rma.companyId, siteId: rma.siteId, after: { purpose: 'RETURN_LABEL', recordType: 'ReturnAuthorisation', recordId: rma.id, partyId: rma.partyId, email: going[0]?.email ?? null, expiresAt: toUtcIso(expiresAt), maxUses: 1 } })
    await tx.returnLabel.create({ data: { id: labelId, companyId: rma.companyId, siteId: rma.siteId, partyId: rma.partyId, returnId: rma.id, carrierCode, status: 'OFFERED', linkId, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
    tools.audit({ action: 'shipping.returnLabel', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, after: { labelId, status: 'OFFERED', carrierCode, linkId, mailed: going.length } })
    tools.emit(eventFor(labelChanged, { subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, labelId, status: 'OFFERED', via: 'OFFICE' } }))
    const mails: Array<{ outboundId: string; locale: 'it' | 'en' }> = []
    if (going.length > 0) {
      const identity = await sendingIdentity(tx, rma.companyId, null, 'CONVERSATION')
      const from = fromLine(identity, words.user ? { name: words.user.displayName, email: words.user.email } : null)
      for (const recipient of going) {
        const locale = localeOf(recipient.language ?? words.partyLanguage) === 'en' ? 'en' : 'it'
        const outboundId = newId()
        const mail = returnLabelMail({ locale, companyName: words.companyName, returnNumber: rma.number, customerRef: rma.customerRef, openUntil: businessDate(expiresAt) }, null)
        await tx.emailOutbound.create({
          data: { id: outboundId, companyId: identity.companyId, identityId: identity.id, recordType: 'OneOffLink', recordId: linkId, templateKey: RETURN_LABEL_MAIL_TEMPLATE, locale, fromAddress: from.address, fromName: from.name, to: [recipient.email], subject: mail.subject, emailMessageId: messageIdFor(outboundId, identity.domain), status: 'QUEUED', queuedAt: now, createdAt: now, updatedAt: now, createdById: actorId },
          select: { id: true },
        })
        tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: RETURN_LABEL_MAIL_TEMPLATE, linkId, identityId: identity.id, recipients: 1, status: 'QUEUED' } })
        mails.push({ outboundId, locale })
      }
    }
    return { mails, openUntil: businessDate(expiresAt) }
  })
  // A repeat: its mails went the first time; the token of that first answer is gone.
  if (replayed) return null
  const linkUrl = auth.link('/l', token)
  for (const mail of result.mails) {
    const text = returnLabelMail({ locale: mail.locale, companyName: words.companyName, returnNumber: rma.number, customerRef: rma.customerRef, openUntil: result.openUntil }, linkUrl).body
    await deliverLinkMail(processEmail(), systemCallerOf(request)(tenantId), mail.outboundId, text, words.user?.displayName ?? null, auth.clock)
  }
  return send ? null : linkUrl
}

/** POST …/cancel: withdrawn (an offered label's link revoked with it). Answers the labels. */
export async function cancelReturnLabel(request: FastifyRequest, returnId: string, labelId: string, body: { readonly reason?: string | undefined }, idempotencyKey?: string) {
  const { context, rma } = await officeReturn(request, returnId, SALES_RETURNS_MANAGE)
  const known = isUuid(labelId) ? await request.withClient((db) => db.returnLabel.findFirst({ where: { id: labelId, returnId: rma.id }, select: { id: true } })) : null
  if (!known) throw new NotFoundError('Return label not found.')
  const reason = body.reason?.trim() ? body.reason.trim().slice(0, 500) : null
  await command(request, { name: 'shipping.cancelReturnLabel', idempotencyKey, input: { returnId: rma.id, labelId, reason } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT 1 FROM "ReturnLabel" WHERE "id" = ${labelId}::uuid FOR UPDATE`
    const row = await tx.returnLabel.findUniqueOrThrow({ where: { id: labelId }, select: { status: true, linkId: true } })
    if (!cancellable(row.status as ReturnLabelStatus)) refused('FINAL')
    await tx.returnLabel.update({ where: { id: labelId }, data: { status: 'CANCELLED', updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    if (row.linkId) {
      const { count } = await tx.oneOffLink.updateMany({ where: { id: row.linkId, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId, updatedAt: now } })
      if (count === 1) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: row.linkId, companyId: rma.companyId, after: { revokedAt: toUtcIso(now), by: 'shipping.cancelReturnLabel' } })
    }
    tools.audit({ action: 'shipping.cancelReturnLabel', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: row.status }, after: { labelId, status: 'CANCELLED' }, ...(reason ? { reason } : {}) })
    tools.emit(eventFor(labelChanged, { subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, labelId, status: 'CANCELLED', via: 'OFFICE' } }))
    return { labelId }
  })
  return { labels: await getReturnLabels(request, rma.id) }
}

/** The most bytes a label PDF read here may have. */
const LABEL_PDF_MAX = 10 * 1024 * 1024

/** GET …/pdf: the label's PDF bytes and its name (the Return label PDF window shows and prints it). */
export async function returnLabelPdf(files: FilesRuntime, caller: CommandCaller, returnId: string, labelId: string): Promise<{ body: Buffer; fileName: string }> {
  const { rma } = await officeReturn(caller, returnId, SALES_RETURNS_VIEW)
  const file = isUuid(labelId)
    ? await caller.withClient(async (db) => {
        const row = await db.returnLabel.findFirst({ where: { id: labelId, returnId: rma.id }, select: { labelFileId: true } })
        return row?.labelFileId ? db.storedFile.findUnique({ where: { id: row.labelFileId }, select: { status: true, storeAccountId: true, storageKey: true, originalName: true } }) : null
      })
    : null
  if (!file || file.status !== 'AVAILABLE') throw new NotFoundError('This return label has no PDF (it is offered by link and not booked yet, or its file is gone).')
  const body = await storeCall(() => files.storage.read(caller, file.storeAccountId, file.storageKey, LABEL_PDF_MAX))
  if (!body) throw new NotFoundError('The label PDF is missing from the file store.')
  return { body, fileName: file.originalName }
}
