import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { carrierAddressOf } from '@nexus/factory-domain/shipping/labels/labels'
import { RETURN_LABEL_REFUSAL_WORDS, type ReturnLabelStatus } from '@nexus/factory-domain/shipping/return-labels/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import { requireContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { linkCommand, useLink } from '../../../platform/links/use'
import type { CarrierRuntime } from '../labels/carrier'
import { bookCarrier, bookOfferedInCommand, labelFactsOf, readReturn, refused } from './book'

/**
 * A return label by link (B-W2b-398; LOG-112 "a link that books the carrier only when used"; the customer's page SCR-436).
 * The link authenticator opened a live RETURN_LABEL link of ONE ReturnAuthorisation of ONE party; any other link is the
 * one 404, and so is a link no label names (a RETURN_LABEL link made through the generic links route offers nothing) or
 * whose label was withdrawn. The return, its label and the shipment are not the partner role's to read in full, so they
 * are read here in the tenant's system scope, for the link's return only. Nothing counts a use (the label is booked once).
 *
 *   page       GET /link/return-label: the return (number, the customer's reference, what to send, by when), the label
 *              (offered, booked with its carrier reference, used), where the parcel goes (our return address) and from
 *              (the customer's town, postcode and country only)
 *   book       POST /link/return-label/book: the carrier booked now (checked first: a refusal uses nothing; the carrier and
 *              the file store outside any transaction), CONFIRMED evidence in the link's command, then the label BOOKED in
 *              the tenant's system scope (the link session has no write grant)
 *   download   POST /link/return-label/download: the label PDF, DOWNLOADED evidence, a presigned GET of 60 seconds
 */

function returnLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'RETURN_LABEL' || link.record.type !== 'ReturnAuthorisation') throw linkUnavailable()
  return link
}

const systemOf = (request: FastifyRequest, link: LinkSession): CommandCaller => systemCallerOf(request)(link.tenantId)

/** The link's return and label (in the tenant's system scope), or null: the one 404. */
async function offerOf(db: CommandTx, link: LinkSession) {
  const rma = await readReturn(db, link.record.id)
  if (!rma || rma.partyId !== link.partyId || rma.companyId !== link.companyId) return null
  const label = await db.returnLabel.findFirst({ where: { returnId: rma.id, linkId: link.id }, select: { id: true, status: true, carrierCode: true, bookingReference: true, labelFileId: true, usedAt: true, updatedAt: true } })
  if (!label || label.status === 'CANCELLED') return null
  return { rma, label }
}

/** GET /link/return-label */
export async function returnLabelPage(request: FastifyRequest) {
  const link = returnLinkOf(request)
  const page = await systemOf(request, link).withClient(async (db) => {
    const offer = await offerOf(db, link)
    if (!offer) return null
    const { rma, label } = offer
    const lines = await db.returnLine.findMany({ where: { returnId: rma.id }, select: { seq: true, description: true, size: true, quantity: true }, orderBy: { seq: 'asc' } })
    const company = await db.company.findUnique({ where: { id: rma.companyId }, select: { legalName: true, tradeName: true } })
    const facts = await labelFactsOf(db, rma)
    const swap = facts.swap(label.id)
    const from = swap.customerAddress ? carrierAddressOf(swap.customerAddress) : null
    const to = swap.siteAddress ? carrierAddressOf(swap.siteAddress) : null
    return { rma, label, lines, company, held: facts.held, from, to }
  })
  if (!page) throw linkUnavailable()
  const { rma, label, lines, company, held, from, to } = page
  return {
    return: { number: rma.number, customerRef: rma.customerRef, status: rma.status, goodsDueBy: rma.goodsDueBy ? rma.goodsDueBy.toISOString().slice(0, 10) : null },
    companyName: company?.tradeName ?? company?.legalName ?? '',
    lines: lines.map((line) => ({ seq: line.seq, description: line.description, size: line.size, quantity: line.quantity })),
    label: { status: label.status as ReturnLabelStatus, carrierCode: label.carrierCode, bookingReference: label.bookingReference, hasPdf: label.labelFileId !== null, usedAt: label.usedAt ? toUtcIso(label.usedAt) : null },
    /** Why the label cannot be booked now (only while it is offered). */
    bookHeld: label.status === 'OFFERED' ? held : null,
    from: from ? { city: from.city, postalCode: from.postalCode, country: from.country } : null,
    to: to ? { name: to.name, companyName: to.companyName, line1: to.line1, line2: to.line2, postalCode: to.postalCode, city: to.city, province: to.province, country: to.country } : null,
    link: { expiresAt: toUtcIso(link.expiresAt) },
  }
}

/** POST /link/return-label/book */
export async function bookFromLink(runtime: { readonly carrier: CarrierRuntime; readonly files: FilesRuntime }, request: FastifyRequest, idempotencyKey: string | undefined) {
  const link = returnLinkOf(request)
  const system = systemOf(request, link)
  const read = await system.withClient(async (db) => {
    const offer = await offerOf(db, link)
    if (!offer) return null
    return { ...offer, facts: await labelFactsOf(db, offer.rma) }
  })
  if (!read) throw linkUnavailable()
  // Booked already (a second press, another tab): the page as it is, nothing booked again.
  if (read.label.status !== 'OFFERED') return returnLabelPage(request)
  // Checked before anything: a label that cannot be booked uses nothing and books nothing.
  if (read.facts.held) refused(read.facts.held, RETURN_LABEL_REFUSAL_WORDS[read.facts.held])
  const booked = await bookCarrier(runtime, system, read.rma, read.facts, read.label.id)
  await linkCommand(request, { name: 'shipping.returnLabelLinkUse', idempotencyKey, input: { labelId: read.label.id } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'confirm' })
    tools.audit({ action: 'links.confirmReturnLabel', recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { labelId: read.label.id, evidenceId: use.evidenceId } })
    return { evidenceId: use.evidenceId }
  })
  await runCommand(system, { name: 'shipping.returnLabelBook', idempotencyKey: idempotencyKey ? `return-label-book:${read.label.id}:${idempotencyKey}`.slice(0, 200) : undefined, input: { labelId: read.label.id, linkId: link.id } }, async (tools) => {
    await bookOfferedInCommand(tools, read.rma, read.label.id, booked)
    return { labelId: read.label.id }
  }, { ...COMMAND_SETTINGS, clock: officeAuthOf(request.server).clock })
  return returnLabelPage(request)
}

/** POST /link/return-label/download */
export async function downloadFromLink(files: FilesRuntime, request: FastifyRequest, idempotencyKey: string | undefined) {
  const link = returnLinkOf(request)
  const system = systemOf(request, link)
  const found = await system.withClient(async (db) => {
    const offer = await offerOf(db, link)
    if (!offer) return { dead: true as const, file: null }
    const file = offer.label.labelFileId ? await db.storedFile.findUnique({ where: { id: offer.label.labelFileId }, select: { id: true, companyId: true, status: true, storeAccountId: true, storageKey: true, thumbnailKey: true, contentType: true, originalName: true } }) : null
    return { dead: false as const, file: file && file.status === 'AVAILABLE' ? file : null }
  })
  if (found.dead) throw linkUnavailable()
  const file = found.file
  if (!file) throw new NotFoundError('The label is not booked yet: book it first.')
  const key = await keyShownTo(files, requireContext(request), system, file)
  await linkCommand(request, { name: 'shipping.returnLabelDownload', idempotencyKey, input: { fileId: file.id } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'download' })
    tools.audit({ action: 'links.downloadFile', recordType: 'StoredFile', recordId: file.id, companyId: file.companyId ?? link.companyId, after: { linkId: link.id, returnId: link.record.id, evidenceId: use.evidenceId } })
    return { fileId: file.id }
  })
  const download = await storeCall(() => files.storage.presignDownload(system, file.storeAccountId, { key, contentType: file.contentType, disposition: attachmentDisposition(file.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }))
  return { fileId: file.id, name: file.originalName, download: presignedView(download) }
}
