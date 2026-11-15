import type { FastifyRequest } from 'fastify'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { BROKER_LINK_REFUSAL_WORDS, type BrokerLinkRefusal } from '@nexus/factory-domain/shipping/broker-pack/rules'
import { mrnOf, type DeclarationStatus } from '@nexus/factory-domain/shipping/customs/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import { requireContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { linkCommand, useLink } from '../../../platform/links/use'
import { fileInCommand } from '../customs/declarations'
import { countryOf } from '../customs/facts'

/**
 * The broker's page by link (B-W2b-409; LOG-097 "sends the broker the papers as a link and collects the MRN back"; the
 * BROKER_PACK link's page). The link authenticator opened a live BROKER_PACK link of ONE CustomsDeclaration for ONE party (the
 * broker); any other link is the one 404, and so is a declaration that is gone (removed: sent by mistake), whose broker is no
 * longer the link's party, or whose site switched the broker pack off since (fail closed: nothing goes to a third party while
 * the switch is off). The declaration, its shipment and the papers are the office's, so they are read here in the tenant's
 * system scope, for the link's declaration only: the papers are exactly the link's own LinkFile rows.
 *
 *   page       GET /link/broker-pack: the sender, the shipment's number and destination, the papers (name, size), the
 *              declaration's state and, once filed, its MRN; reading uses nothing
 *   download   POST /link/broker-pack/files/:fileId/download: one paper of the link, DOWNLOADED evidence (never a use), an
 *              audit row on the file, a presigned GET of 60 seconds
 *   MRN        POST /link/broker-pack/mrn {mrn}: checked first (the pattern; a declaration filed already answers the page
 *              when it is the same MRN, else 409 in words), SUBMITTED evidence (the link's one use) in the link's command,
 *              then the declaration FILED with the MRN in the tenant's system scope (the link session writes nothing itself)
 */

function packLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'BROKER_PACK' || link.record.type !== 'CustomsDeclaration') throw linkUnavailable()
  return link
}

const systemOf = (request: FastifyRequest, link: LinkSession): CommandCaller => systemCallerOf(request)(link.tenantId)

function linkRefused(code: BrokerLinkRefusal): never {
  const message = BROKER_LINK_REFUSAL_WORDS[code]
  throw new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])
}

/** The link's declaration, shipment and papers (in the tenant's system scope), or null: the one 404. */
async function packOf(db: CommandTx, link: LinkSession) {
  const declaration = await db.customsDeclaration.findUnique({ where: { id: link.record.id }, select: { id: true, companyId: true, siteId: true, shipmentId: true, brokerPartyId: true, status: true, mrn: true } })
  if (!declaration || declaration.companyId !== link.companyId || declaration.brokerPartyId !== link.partyId) return null
  const settings = await db.shippingSettings.findUnique({ where: { id: declaration.siteId }, select: { brokerPackOn: true } })
  if (!settings?.brokerPackOn) return null
  const shipment = await db.shipment.findUnique({ where: { id: declaration.shipmentId }, select: { id: true, number: true, companyId: true, siteId: true, shipTo: true } })
  if (!shipment) return null
  const rows = await db.linkFile.findMany({ where: { linkId: link.id }, select: { fileId: true, position: true }, orderBy: { position: 'asc' } })
  const files = rows.length === 0 ? [] : await db.storedFile.findMany({ where: { id: { in: rows.map((row) => row.fileId) } }, select: { id: true, companyId: true, status: true, storeAccountId: true, storageKey: true, thumbnailKey: true, contentType: true, originalName: true, sizeBytes: true } })
  const papers = rows.flatMap((row) => {
    const file = files.find((entry) => entry.id === row.fileId)
    return file ? [file] : []
  })
  return { declaration, shipment, papers }
}

type Pack = NonNullable<Awaited<ReturnType<typeof packOf>>>

function pageOf(pack: Pack, companyName: string, link: LinkSession) {
  return {
    companyName,
    shipment: { number: pack.shipment.number, country: countryOf(pack.shipment.shipTo) },
    declaration: { status: pack.declaration.status as DeclarationStatus, mrn: pack.declaration.mrn },
    papers: pack.papers.map((file) => ({ fileId: file.id, name: file.originalName, sizeBytes: Number(file.sizeBytes), available: file.status === 'AVAILABLE' })),
    link: { expiresAt: toUtcIso(link.expiresAt) },
  }
}

async function readPage(request: FastifyRequest, link: LinkSession) {
  const page = await systemOf(request, link).withClient(async (db) => {
    const pack = await packOf(db, link)
    if (!pack) return null
    const company = await db.company.findUnique({ where: { id: pack.declaration.companyId }, select: { legalName: true, tradeName: true } })
    return pageOf(pack, company?.tradeName ?? company?.legalName ?? '', link)
  })
  if (!page) throw linkUnavailable()
  return page
}

/** GET /link/broker-pack */
export async function brokerPackPage(request: FastifyRequest) {
  return readPage(request, packLinkOf(request))
}

/** POST /link/broker-pack/files/:fileId/download */
export async function downloadPaper(files: FilesRuntime, request: FastifyRequest, fileId: string, idempotencyKey: string | undefined) {
  const link = packLinkOf(request)
  const system = systemOf(request, link)
  const found = await system.withClient(async (db) => {
    const pack = await packOf(db, link)
    if (!pack) return { dead: true as const, file: null }
    const file = isUuid(fileId) ? pack.papers.find((paper) => paper.id === fileId) : undefined
    return { dead: false as const, file: file && file.status === 'AVAILABLE' ? file : null }
  })
  if (found.dead) throw linkUnavailable()
  const file = found.file
  if (!file) throw new NotFoundError('This paper is not in the pack, or it was withdrawn.')
  const key = await keyShownTo(files, requireContext(request), system, file)
  await linkCommand(request, { name: 'shipping.brokerPackDownload', idempotencyKey, input: { fileId: file.id } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'download' })
    tools.audit({ action: 'links.downloadFile', recordType: 'StoredFile', recordId: file.id, companyId: file.companyId ?? link.companyId, after: { linkId: link.id, declarationId: link.record.id, evidenceId: use.evidenceId } })
    return { fileId: file.id }
  })
  const download = await storeCall(() => files.storage.presignDownload(system, file.storeAccountId, { key, contentType: file.contentType, disposition: attachmentDisposition(file.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }))
  return { fileId: file.id, name: file.originalName, download: presignedView(download) }
}

/** POST /link/broker-pack/mrn */
export async function submitMrn(request: FastifyRequest, body: { readonly mrn: string }, idempotencyKey: string | undefined) {
  const link = packLinkOf(request)
  const system = systemOf(request, link)
  const mrn = mrnOf(body.mrn)
  if (!mrn) throw new ValidationError(BROKER_LINK_REFUSAL_WORDS.MRN_FORMAT, [{ path: 'body/mrn', message: 'Not an MRN.' }])
  const pack = await system.withClient((db) => packOf(db, link))
  if (!pack) throw linkUnavailable()
  if (pack.declaration.mrn !== null) {
    // Sent again (a second press, another tab): the same MRN answers the page; another one is refused.
    if (pack.declaration.mrn === mrn) return readPage(request, link)
    linkRefused('FILED')
  }
  if (pack.declaration.status !== 'PACK_SENT') linkRefused('FILED')
  await linkCommand(request, { name: 'shipping.brokerPackMrn', idempotencyKey, input: { mrn } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'submit' })
    tools.audit({ action: 'links.submitMrn', recordType: 'OneOffLink', recordId: link.id, companyId: link.companyId, after: { declarationId: pack.declaration.id, mrn, evidenceId: use.evidenceId } })
    return { evidenceId: use.evidenceId }
  })
  await runCommand(
    system,
    { name: 'shipping.recordMrn', idempotencyKey: idempotencyKey ? `broker-mrn:${pack.declaration.id}:${idempotencyKey}`.slice(0, 200) : undefined, input: { declarationId: pack.declaration.id, mrn, linkId: link.id } },
    (tools) => fileInCommand(tools, pack.shipment, mrn, 'LINK'),
    { ...COMMAND_SETTINGS, clock: officeAuthOf(request.server).clock },
  )
  return readPage(request, link)
}
