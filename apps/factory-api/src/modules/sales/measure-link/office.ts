import type { FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { linkTerms } from '@nexus/factory-domain/links/purposes'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { MEASURE_MAIL_TEMPLATE, measureMail, type MeasureMailLocale } from '@nexus/factory-domain/sales/measure-link/mail'
import { SALES_MEASUREMENTS_MANAGE, SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { DEFAULT_PHOTO_RULE, type PhotoRule } from '@nexus/factory-domain/sales/measure-link/rules'
import { command, idempotencyKeyFrom, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { makeStrippedCopy } from '../../../platform/files/thumbs/strip-copy'
import { deliverLinkMail } from '../../../platform/links/mail'
import { commandOn } from '../../../platform/portal/tasks/clock'
import { assertNoPayByLink, LinkRefusedError } from '../../../platform/links/pay'
import { LINK_MADE_ACTION, latestOf, linkTermsOf, measureNotice, photosOf, pointsOf, PROFILE_COLUMNS, PROFILE_RECORD, type Reader } from './store'

/**
 * The office's side of measurements by link (B-W2b-171; design links.measure "Office: sales.mtm › Measurements (lands as a
 * new revision for review)", sales.quotes "made-to-measure line"):
 *
 *   POST /sales/measure-links                                   a MEASUREMENTS link for a rider's measurement profile (its
 *                                                               latest revision), or for a made-to-measure order line (its
 *                                                               profile; the order's company): photos required or optional,
 *                                                               mailed to the rider (FAKE locally) or its address given ONCE.
 *                                                               Refused while the company has no public privacy notice in
 *                                                               force (GATE-PRIVACY: the rider reads it before any field).
 *   GET  /sales/measurement-profiles/:profileId/sent            who sent what: the revisions of the rider's garment sent by
 *                                                               link (the link, its address and contact, the notice, the
 *                                                               values, the photos and when they go) and the links made
 *   POST /sales/measurement-profiles/:profileId/photos/:fileId/open   one photo for 60 seconds, without location data,
 *                                                               the opening recorded (who, when)
 *   POST /sales/measurement-profiles/:profileId/photos-delete-after   the day a revision's photos are deleted (the rider asked;
 *                                                               moved, never cleared; the hourly job deletes them)
 */

function officeOf(request: FastifyRequest): OfficeContext {
  const context = request.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const localeOf = (language: string | null | undefined): MeasureMailLocale => (language === 'en' ? 'en' : 'it')
const garmentName = (template: { name: string; nameI18n: Record<string, string> }, locale: MeasureMailLocale) => template.nameI18n[locale] ?? template.name

async function identityFor(tools: Pick<CommandTools, 'tx'>, companyId: string, system: boolean) {
  if (!system) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
  try {
    return await sendingIdentity(tools.tx, companyId, null, 'NOTIFICATION')
  } catch (error) {
    if (error instanceof DomainError) return sendingIdentity(tools.tx, companyId, null, 'CONVERSATION')
    throw error
  }
}

export const NO_NOTICE = 'This company has no public privacy notice in force (Admin › Privacy & notices): a rider reads it before any measurement or photo, so no measurement link goes out before it is published.'

export interface MadeMeasureLink {
  readonly linkId: string
  readonly outboundId: string | null
  readonly expiresAt: string
}

export interface MakeMeasureLink {
  readonly profile: { readonly id: string; readonly partyId: string }
  readonly companyId: string
  readonly linkId: string
  readonly tokenHash: string
  readonly to: string | null
  readonly contactId: string | null
  readonly send: boolean
  readonly expiresInDays?: number | undefined
  readonly photos: PhotoRule
  readonly orderNumber: string | null
  readonly salesOrderLineId: string | null
  readonly via: 'OFFICE' | 'RENEWAL'
  readonly createdById: string
  readonly renewalOfId?: string | null | undefined
  readonly subject: (expiresAt: Date) => string
  readonly locale: MeasureMailLocale
  readonly sender: { readonly name: string; readonly email: string } | null
}

/**
 * Makes a MEASUREMENTS link inside the caller's command (the office's, or the system's renewal): the pay rule, the public
 * notice in force (GATE-PRIVACY), a suppressed address, the link row (only the token's hash), its audit row with what the
 * office asked (photos, the order), the mail queued when `send`, measure_link.sent.
 */
export async function makeMeasureLinkInCommand(tools: CommandTools, input: MakeMeasureLink): Promise<MadeMeasureLink> {
  await assertNoPayByLink(tools.tx, { recordType: PROFILE_RECORD, recordId: input.profile.id })
  if (!(await measureNotice(tools.tx, input.companyId))) throw new LinkRefusedError('NO_NOTICE', NO_NOTICE)
  if (input.send && input.to && (await suppressedAmong(tools.tx, [input.to])).size > 0) throw new LinkRefusedError('SUPPRESSED', 'This address bounced or complained: correct it first.')
  const terms = linkTerms('MEASUREMENTS', { expiresInDays: input.expiresInDays }, tools.now)
  await tools.tx.oneOffLink.createMany({
    data: [
      {
        id: input.linkId,
        companyId: input.companyId,
        partyId: input.profile.partyId,
        purpose: 'MEASUREMENTS',
        recordType: PROFILE_RECORD,
        recordId: input.profile.id,
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
  tools.audit({
    action: LINK_MADE_ACTION,
    recordType: 'OneOffLink',
    recordId: input.linkId,
    companyId: input.companyId,
    after: { purpose: 'MEASUREMENTS', recordType: PROFILE_RECORD, recordId: input.profile.id, partyId: input.profile.partyId, email: input.to, expiresAt: toUtcIso(terms.expiresAt), maxUses: terms.maxUses, photos: input.photos, orderNumber: input.orderNumber, salesOrderLineId: input.salesOrderLineId, via: input.via, renewalOfId: input.renewalOfId ?? null },
  })
  let outboundId: string | null = null
  if (input.send && input.to) {
    const identity = await identityFor(tools, input.companyId, input.sender === null)
    const from = fromLine(identity, input.sender)
    outboundId = newId()
    await tools.tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'OneOffLink',
        recordId: input.linkId,
        templateKey: MEASURE_MAIL_TEMPLATE,
        locale: input.locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [input.to],
        subject: input.subject(terms.expiresAt),
        emailMessageId: messageIdFor(outboundId, identity.domain),
        status: 'QUEUED',
        queuedAt: tools.now,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: input.via === 'OFFICE' ? input.createdById : null,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: MEASURE_MAIL_TEMPLATE, linkId: input.linkId, identityId: identity.id, recipients: 1, attachments: 0, status: 'QUEUED' } })
  }
  tools.emit({ type: 'measure_link.sent', subject: input.linkId, companyId: input.companyId, payload: { linkId: input.linkId, profileId: input.profile.id, partyId: input.profile.partyId, mailed: outboundId !== null, photos: input.photos, expiresAt: toUtcIso(terms.expiresAt) } })
  return { linkId: input.linkId, outboundId, expiresAt: toUtcIso(terms.expiresAt) }
}

export interface MeasureLinkBody {
  readonly profileId?: string | undefined
  readonly salesOrderLineId?: string | undefined
  readonly companyId?: string | undefined
  readonly contactId?: string | undefined
  readonly email?: string | undefined
  readonly send: boolean
  readonly photos?: PhotoRule | undefined
  readonly language?: 'it' | 'en' | undefined
  readonly expiresInDays?: number | undefined
}

const notFound = () => new NotFoundError('Measurement profile not found.')

/** The profile, company and order a body names (an order line: its profile, the order's company and number). */
async function targetOf(db: Reader, body: MeasureLinkBody) {
  if ((body.profileId === undefined) === (body.salesOrderLineId === undefined)) {
    throw new ValidationError('Name the measurement profile or the made-to-measure order line.', [{ path: 'body/profileId', message: 'Exactly one of profileId and salesOrderLineId.' }])
  }
  if (body.salesOrderLineId !== undefined) {
    const line = await db.salesOrderLine.findUnique({ where: { id: body.salesOrderLineId }, select: { id: true, measurementProfileId: true, order: { select: { companyId: true, partyId: true, number: true } } } })
    if (!line) throw new NotFoundError('Order line not found.')
    if (!line.measurementProfileId) throw new InvalidStateError('This order line is not made to measure: it has no measurement profile.')
    const profile = await db.measurementProfile.findUnique({ where: { id: line.measurementProfileId }, select: PROFILE_COLUMNS })
    if (!profile) throw notFound()
    return { profile, companyId: line.order.companyId, orderNumber: line.order.number, salesOrderLineId: line.id }
  }
  if (!body.companyId) throw new ValidationError('Name the company that asks for the measurements.', [{ path: 'body/companyId', message: 'Required with a measurement profile.' }])
  const [profile, company] = await Promise.all([
    db.measurementProfile.findUnique({ where: { id: body.profileId! }, select: PROFILE_COLUMNS }),
    db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }),
  ])
  if (!profile) throw notFound()
  if (!company) throw new ValidationError('Not a company of yours.', [{ path: 'body/companyId', message: 'Not a company of yours.' }])
  return { profile, companyId: company.id, orderNumber: null, salesOrderLineId: null }
}

/** POST /sales/measure-links. */
export async function sendMeasureLink(request: FastifyRequest, body: MeasureLinkBody) {
  const context = officeOf(request)
  const auth = officeAuthOf(request.server)
  const facts = await request.withClient(async (client) => {
    const target = await targetOf(client, body)
    const latest = (await latestOf(client, target.profile)) ?? target.profile
    const party = await client.party.findUnique({ where: { id: latest.partyId }, select: { language: true } })
    const company = await client.company.findUnique({ where: { id: target.companyId }, select: { legalName: true, tradeName: true } })
    const contactId = body.contactId ?? latest.contactId ?? null
    const contact = contactId && isUuid(contactId) ? await client.partyContact.findFirst({ where: { id: contactId, partyId: latest.partyId, status: 'ACTIVE' }, select: { id: true, email: true, language: true } }) : null
    const user = await client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    const template = await pointsOf(client, latest.garmentType)
    return { ...target, latest, party, company, contact, user, template }
  })
  if (!can(actorOf(context), SALES_MEASUREMENTS_MANAGE, { companyId: facts.companyId, partyId: facts.latest.partyId })) throw notFound()
  if (body.contactId && !facts.contact?.email) throw new ValidationError('Not a contact of this customer with an e-mail.', [{ path: 'body/contactId', message: 'Not a contact of this customer with an e-mail.' }])
  const typed = body.email === undefined ? null : emailOrThrow(body.email, 'body/email')
  const to = typed ?? facts.contact?.email?.trim().toLowerCase() ?? null
  if (body.send && !to) throw new ValidationError('Give the address the link goes to, or take the link to pass it on yourself.', [{ path: 'body/email', message: 'An address to send the link to.' }])
  const locale: MeasureMailLocale = body.language ?? localeOf(facts.contact?.language ?? facts.party?.language)
  const photos = body.photos ?? DEFAULT_PHOTO_RULE
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: facts.latest.partyId, linkId })
  const companyName = facts.company?.tradeName ?? facts.company?.legalName ?? ''
  const sender = facts.user ? { name: facts.user.displayName, email: facts.user.email } : null
  const mailOf = (expiresAt: Date, url: string) => measureMail(locale, { companyName, riderName: facts.latest.riderName, garment: garmentName(facts.template, locale), expiresAt, photos: photos === 'REQUIRED' }, url)
  // The app's clock (the sign-in's): the link's expiry and its sends are judged by the same clock.
  const { result, replayed } = await commandOn(request.server, request, { name: 'measureLink.make', idempotencyKey: idempotencyKeyFrom(request), input: body }, (tools) =>
    makeMeasureLinkInCommand(tools, {
      profile: { id: facts.latest.id, partyId: facts.latest.partyId },
      companyId: facts.companyId,
      linkId,
      tokenHash: linkTokenHash(token.value),
      to,
      contactId: facts.contact?.id ?? null,
      send: body.send,
      expiresInDays: body.expiresInDays,
      photos,
      orderNumber: facts.orderNumber,
      salesOrderLineId: facts.salesOrderLineId,
      via: 'OFFICE',
      createdById: context.actorId,
      subject: (expiresAt) => mailOf(expiresAt, '').subject,
      locale,
      sender,
    }),
  )
  const answer = { link: { id: result.linkId, purpose: 'MEASUREMENTS' as const, profileId: facts.latest.id, expiresAt: result.expiresAt, email: to, photos } }
  if (replayed) return { ...answer, url: null, delivery: result.outboundId ? ('QUEUED' as const) : null }
  const url = auth.link('/l', token.value)
  if (!result.outboundId) return { ...answer, url, delivery: null }
  const text = mailOf(new Date(result.expiresAt), url).body
  const delivery = await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), result.outboundId, text, sender?.name ?? null, auth.clock)
  return { ...answer, url: null, delivery }
}

// ---- who sent what ------------------------------------------------------------------------------------------------------

/** The revisions of the profile's rider and garment type (the chain the office reviews), read in the office's scope. */
async function chainOf(db: Reader, profileId: string) {
  const profile = await db.measurementProfile.findUnique({ where: { id: profileId }, select: PROFILE_COLUMNS })
  if (!profile) return null
  const revisions = await db.measurementProfile.findMany({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType }, orderBy: { revision: 'asc' }, select: PROFILE_COLUMNS })
  return { profile, revisions }
}

function mayRead(request: FastifyRequest, permission: typeof SALES_MEASUREMENTS_VIEW | typeof SALES_MEASUREMENTS_MANAGE, partyId: string): OfficeContext {
  const context = officeOf(request)
  if (!can(actorOf(context), permission, { partyId })) throw notFound()
  return context
}

const asMeasurements = (value: unknown): Record<string, { value: string; unit: string }> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).flatMap(([code, entry]) => {
          const raw = (entry ?? {}) as { value?: unknown; unit?: unknown }
          return typeof raw.value === 'string' ? [[code, { value: raw.value, unit: typeof raw.unit === 'string' ? raw.unit : '' }]] : []
        }),
      )
    : {}

/** GET /sales/measurement-profiles/:profileId/sent. */
export async function measurementsSent(request: FastifyRequest, profileId: string) {
  const chain = await request.withClient((client) => chainOf(client, profileId))
  if (!chain) throw notFound()
  const context = mayRead(request, SALES_MEASUREMENTS_VIEW, chain.profile.partyId)
  const actor = actorOf(context)
  return request.withClient(async (client) => {
    const ids = chain.revisions.map((revision) => revision.id)
    const links = await client.oneOffLink.findMany({ where: { purpose: 'MEASUREMENTS', recordType: PROFILE_RECORD, recordId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { id: true, companyId: true, recordId: true, email: true, contactId: true, createdAt: true, expiresAt: true, uses: true, maxUses: true, revokedAt: true } })
    const seen = links.filter((link) => can(actor, SALES_MEASUREMENTS_VIEW, { companyId: link.companyId, partyId: chain.profile.partyId }))
    const sentBy = chain.revisions.filter((revision) => revision.submittedViaLinkId !== null)
    const linkIds = [...new Set(sentBy.map((revision) => revision.submittedViaLinkId!))]
    const sendingLinks = await client.oneOffLink.findMany({ where: { id: { in: linkIds } }, select: { id: true, companyId: true, email: true, contactId: true } })
    const contactIds = [...new Set(sendingLinks.flatMap((link) => (link.contactId ? [link.contactId] : [])))]
    const contacts = await client.partyContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } })
    const noticeIds = [...new Set(sentBy.flatMap((revision) => (revision.noticeVersionId ? [revision.noticeVersionId] : [])))]
    const notices = await client.privacyNotice.findMany({ where: { id: { in: noticeIds } }, select: { id: true, label: true } })
    const fileIds = sentBy.flatMap((revision) => photosOf(revision).map((photo) => photo.fileId))
    const files = await client.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, status: true } })
    const terms = await Promise.all(seen.map((link) => linkTermsOf(client, link.id)))
    return {
      profile: { id: chain.profile.id, riderName: chain.profile.riderName, garmentType: chain.profile.garmentType, latestRevision: chain.revisions.at(-1)!.revision },
      revisions: sentBy
        .filter((revision) => {
          const link = sendingLinks.find((row) => row.id === revision.submittedViaLinkId)
          return link !== undefined && can(actor, SALES_MEASUREMENTS_VIEW, { companyId: link.companyId, partyId: revision.partyId })
        })
        .reverse()
        .map((revision) => {
          const link = sendingLinks.find((row) => row.id === revision.submittedViaLinkId)!
          return {
            id: revision.id,
            revision: revision.revision,
            supersedesId: revision.supersedesId,
            submittedAt: toUtcIso(revision.submittedAt!),
            takenBy: revision.takenBy,
            link: { id: link.id, email: link.email, contactId: link.contactId, contactName: contacts.find((contact) => contact.id === link.contactId)?.name ?? null },
            notice: { id: revision.noticeVersionId!, label: notices.find((notice) => notice.id === revision.noticeVersionId)?.label ?? '', at: toUtcIso(revision.privacyNoticeAt) },
            measurements: asMeasurements(revision.measurements),
            fitNotes: revision.fitNotes,
            photos: photosOf(revision).map((photo) => ({ ...photo, status: files.find((file) => file.id === photo.fileId)?.status ?? 'DELETED' })),
            photosDeleteAfter: revision.photosDeleteAfter ? toUtcIso(revision.photosDeleteAfter) : null,
          }
        }),
      links: seen.map((link, index) => ({ id: link.id, recordId: link.recordId, email: link.email, createdAt: toUtcIso(link.createdAt), expiresAt: toUtcIso(link.expiresAt), uses: link.uses, maxUses: link.maxUses, revoked: link.revokedAt !== null, photos: terms[index]!.photos })),
    }
  })
}

/** POST /sales/measurement-profiles/:profileId/photos/:fileId/open: one photo of a revision of the chain, logged. */
export async function openMeasurementPhoto(files: FilesRuntime, request: FastifyRequest, profileId: string, fileId: string) {
  const chain = await request.withClient((client) => chainOf(client, profileId))
  if (!chain) throw notFound()
  const context = mayRead(request, SALES_MEASUREMENTS_VIEW, chain.profile.partyId)
  const owner = chain.revisions.find((revision) => photosOf(revision).some((photo) => photo.fileId === fileId))
  const view = owner ? photosOf(owner).find((photo) => photo.fileId === fileId)!.view : null
  const row = owner ? await request.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { id: true, status: true, storeAccountId: true, contentType: true, originalName: true } })) : null
  if (!owner || !view || !row || row.status !== 'AVAILABLE') throw new NotFoundError('Photo not found (deleted, or not one of these measurements).')
  await command(request, { name: 'measureLink.openPhoto', input: { profileId, fileId } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: fileId, after: { profileId: owner.id, revision: owner.revision, view, by: context.actorId } })
    return null
  })
  // Without location data for the office too: the rider's photo is shown as its stripped copy (B-W2b-160).
  const system = systemCallerOf(request)(context.tenantId)
  const made = await makeStrippedCopy(files, system, fileId)
  if (!made.key) throw new ConflictError('This photo is being prepared to be shown; try again in a minute.')
  const download = await storeCall(() =>
    files.storage.presignDownload(system, row.storeAccountId, { key: made.key!, contentType: row.contentType, disposition: attachmentDisposition(row.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }),
  )
  return { file: { id: fileId, view }, download: presignedView(download) }
}

/** POST /sales/measurement-profiles/:profileId/photos-delete-after: set or move the day (never cleared; the job deletes). */
export async function setPhotosDeleteAfter(request: FastifyRequest, profileId: string, body: { readonly deleteAfter: string; readonly reason: string }) {
  const caller: CommandCaller = request
  const profile = await request.withClient((client) => client.measurementProfile.findUnique({ where: { id: profileId }, select: PROFILE_COLUMNS }))
  if (!profile) throw notFound()
  mayRead(request, SALES_MEASUREMENTS_MANAGE, profile.partyId)
  if (photosOf(profile).length === 0) throw new InvalidStateError('This revision has no photos to delete.')
  const day = new Date(body.deleteAfter)
  if (day.getTime() < profile.createdAt.getTime()) throw new ValidationError('A day after the measurements were sent.', [{ path: 'body/deleteAfter', message: 'A day after the measurements were sent.' }])
  const { result } = await commandOn(request.server, caller, { name: 'measureLink.photosDeleteAfter', idempotencyKey: idempotencyKeyFrom(request), input: { profileId, ...body } }, async (tools) => {
    await tools.tx.measurementProfile.update({ where: { id: profileId }, data: { photosDeleteAfter: day }, select: { id: true } })
    tools.audit({ recordType: PROFILE_RECORD, recordId: profileId, before: { photosDeleteAfter: profile.photosDeleteAfter ? toUtcIso(profile.photosDeleteAfter) : null }, after: { photosDeleteAfter: toUtcIso(day) }, reason: body.reason })
    return { id: profileId, photosDeleteAfter: toUtcIso(day) }
  })
  return { profile: result }
}
