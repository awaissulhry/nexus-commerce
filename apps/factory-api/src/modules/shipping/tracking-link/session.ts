import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkDocuments } from '@nexus/factory-domain/shipping/documents/documents'
import { hasTestLabel } from '@nexus/factory-domain/shipping/exceptions/rules'
import { trackingPageOf, type TrackingStatus } from '@nexus/factory-domain/shipping/labels/tracking'
import {
  claimHeld,
  deliveryPlaceOf,
  expectedDeliveryOf,
  papersShown,
  trackerOf,
  trackingEndsAt,
  trackingOpen,
  viaOfNote,
  type PaperKind,
} from '@nexus/factory-domain/shipping/tracking-link/rules'
import type { CommandCaller } from '../../../core/command'
import { requireContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { presignedView, storeCall, systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { keyShownTo } from '../../../platform/files/thumbs/outside'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { linkCommand, useLink } from '../../../platform/links/use'
import { readDocuments } from '../documents/read'
import { currentPackingListFile } from '../shipments/packing-list'
import { readShipment, type ShipmentHeader } from '../store'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers' // fix-portal-numbers-1

/**
 * A customer's tracking page by link (B-W2b-170; LOG-062; design links.tracking, SCR-194). The link authenticator opened a
 * live SHIPMENT_TRACK link of ONE Shipment of ONE party; any other link is the one 404. The tracking facts (parcels,
 * carrier events, the papers) are not the partner role's to read, so they are read here in the tenant's system scope, for
 * the link's shipment only, after the shipment is found to be the link's party's. Reading uses nothing.
 *
 *   page       GET /link/tracking: where it is (codes), the carrier's events (codes and places, never the carrier's own
 *              text), the delivery town and postcode, the papers (packing list, DoC, user information — never the DDT,
 *              never a price; none for a link found by the public search), whether a claim may be opened, when the page
 *              ends (60 days after delivery). A shipment no longer trackable (back to draft, cancelled, ended): the 404.
 *   download   POST /link/tracking/papers/:fileId/download: one of those papers, DOWNLOADED evidence on the link (never a
 *              use) and an audit row on the file in ONE command, then a presigned GET (60 s) as the tenant's system.
 */

function trackingLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'SHIPMENT_TRACK' || link.record.type !== 'Shipment') throw linkUnavailable()
  return link
}

const systemOf = (request: FastifyRequest, link: LinkSession): CommandCaller => systemCallerOf(request)(link.tenantId)
const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

type Reader = Parameters<Parameters<CommandCaller['withClient']>[0]>[0]

interface Paper {
  readonly fileId: string
  readonly kind: PaperKind
  readonly number: string | null
  readonly style: { readonly code: string; readonly name: string } | null
  readonly language: string | null
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
}

/** The shipment's papers without prices: the current packing list, then each DoC and user information copy shared with the party. */
async function papersOf(db: Reader, shipment: ShipmentHeader): Promise<Paper[]> {
  const papers: Paper[] = []
  const current = await currentPackingListFile(db, shipment.id)
  if (current) {
    const file = await db.storedFile.findUnique({ where: { id: current.id }, select: { id: true, originalName: true, contentType: true, sizeBytes: true } })
    const version = await db.generatedDocument.findFirst({ where: { recordType: 'Shipment', recordId: shipment.id, kind: 'PACKING_LIST', fileId: current.id }, select: { number: true, language: true }, orderBy: { version: 'desc' } })
    if (file) papers.push({ fileId: file.id, kind: 'PACKING_LIST', number: version?.number ?? null, style: null, language: version?.language ?? null, originalName: file.originalName, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) })
  }
  const read = await readDocuments(db, shipment)
  for (const entry of linkDocuments(read.facts.shared, read.documents.documents)) {
    if (entry.kind !== 'DECLARATION_OF_CONFORMITY' && entry.kind !== 'USER_INFORMATION') continue
    papers.push({ fileId: entry.fileId, kind: entry.kind, number: entry.number, style: entry.style ? { code: entry.style.code, name: entry.style.name } : null, language: entry.language, originalName: entry.originalName, contentType: entry.contentType, sizeBytes: entry.sizeBytes })
  }
  return papers
}

/** The link's shipment, how the link came to be, and whether the page still answers (in the tenant's system scope). */
async function trackedOf(db: Reader, link: LinkSession, now: Date) {
  const shipment = await readShipment(db, link.record.id)
  if (!shipment || shipment.partyId !== link.partyId || shipment.companyId !== link.companyId) return null
  if (!trackingOpen(shipment, link.expiresAt, now)) return null
  const row = await db.oneOffLink.findUnique({ where: { id: link.id }, select: { note: true } })
  return { shipment, via: viaOfNote(row?.note) }
}

/** GET /link/tracking */
export async function trackingPage(request: FastifyRequest) {
  const link = trackingLinkOf(request)
  const now = officeAuthOf(request.server).clock.now()
  const page = await systemOf(request, link).withClient(async (db) => {
    const tracked = await trackedOf(db, link, now)
    if (!tracked) return null
    const { shipment, via } = tracked
    // fix-portal-numbers-1 (B-TH-303, plan §0.5): the customer's own order number, never the office's SO-… series.
    const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { customerSeq: true, customerRef: true } })
    // B-OP-042 (order page N6, R-18, lead decision): the page names the shipment's first order for every link, plus the pieces
    // of the customer's other orders on it as a count only ("and N pieces of other orders"), never their numbers.
    const otherPieces = (await db.shipmentLine.findMany({ where: { shipmentId: shipment.id, salesOrderLine: { orderId: { not: shipment.salesOrderId } } }, select: { quantity: true } })).reduce((sum, line) => sum + line.quantity, 0)
    const site = await db.site.findUnique({ where: { id: shipment.siteId }, select: { timezone: true } })
    // B-OS-022: + each parcel's number typed by hand (named; the tenant's system for the link, never the floor).
    const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true, trackingNumber: true, trackingUrl: true, carrierParcelId: true, manualTrackingNumber: true, manualTrackingUrl: true }, orderBy: { seq: 'asc' } })
    const events = await db.trackingEvent.findMany({ where: { shipmentId: shipment.id }, select: { id: true, status: true, location: true, occurredAt: true, parcelId: true }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 200 })
    const papers = papersShown(via) ? await papersOf(db, shipment) : []
    // ── B-OP-031 (order page plan N5): the number typed for a carrier booked by hand ──
    // B-OP-034: and the tracking link typed beside it (https only) — read by the tenant's system for the link, never the floor.
    const typedRow = await db.shipment.findUnique({ where: { id: shipment.id }, select: { manualTrackingNumber: true, manualTrackingUrl: true } })
    const typed = typedRow?.manualTrackingNumber ?? null
    const typedUrl = typed === null ? null : trackingPageOf(typedRow?.manualTrackingUrl)
    // ── end B-OP-031 ──
    return { shipment, via, order, otherPieces, timeZone: site?.timezone ?? 'Europe/Rome', parcels, events, papers, typed, typedUrl }
  })
  if (!page) throw linkUnavailable()
  const { shipment, via, parcels, events } = page
  const tracker = trackerOf({ status: shipment.status, packedAt: shipment.packedAt, shippedAt: shipment.shippedAt, deliveredAt: shipment.deliveredAt, returnedAt: shipment.returnedAt, events })
  const seqOf = new Map(parcels.map((parcel) => [parcel.id, parcel.seq]))
  // The parcel's newest news (the events are newest first; an event of the whole shipment counts for every parcel).
  const latestOf = (parcelId: string): TrackingStatus | null => events.find((event) => event.parcelId === parcelId || event.parcelId === null)?.status ?? null
  return {
    shipment: {
      number: shipment.number,
      status: shipment.status,
      transportBy: shipment.transportBy,
      carrierName: shipment.carrierName,
      packedAt: iso(shipment.packedAt),
      shippedAt: iso(shipment.shippedAt),
      deliveredAt: iso(shipment.deliveredAt),
      returnedAt: iso(shipment.returnedAt),
      expectedDeliveryAt: iso(expectedDeliveryOf(shipment.status, shipment.expectedDeliveryAt)),
      typedTrackingNumber: page.typed, // B-OP-031: no carrier feeds it ("No live tracking")
      typedTrackingUrl: page.typedUrl, // B-OP-034: "Track ›" on the carrier's page typed by hand
    },
    order: { customerRef: page.order?.customerRef ?? null, number: customerRefOf('ORDER', page.order?.customerSeq ?? null) /* fix-portal-numbers-1: "#12" */, otherPieces: page.otherPieces /* B-OP-042, R-18 */ },
    pill: tracker.pill,
    problem: tracker.problem,
    steps: tracker.steps.map((step) => ({ code: step.code, state: step.state, at: iso(step.at) })),
    // B-W2b-398: a TEST label's number (test mode, B-W2b-390) is never shown to a customer.
    // B-OS-022: a parcel no label tracks shows the number typed for it (and its typed link), no carrier feeding it.
    parcels: parcels.map((parcel) => {
      if (hasTestLabel([parcel])) return { seq: parcel.seq, trackingNumber: null, carrierPage: null, status: latestOf(parcel.id) }
      const typed = parcel.trackingNumber === null && parcel.carrierParcelId === null ? parcel.manualTrackingNumber : null
      return { seq: parcel.seq, trackingNumber: parcel.trackingNumber ?? typed, carrierPage: typed !== null ? trackingPageOf(parcel.manualTrackingUrl) : trackingPageOf(parcel.trackingUrl), status: latestOf(parcel.id) }
    }),
    events: events.map((event) => ({ id: event.id, status: event.status, place: event.location?.trim() || null, occurredAt: toUtcIso(event.occurredAt), parcelSeq: event.parcelId ? (seqOf.get(event.parcelId) ?? null) : null })),
    delivery: deliveryPlaceOf(shipment.shipTo),
    papers: { shown: papersShown(via), files: page.papers },
    claim: { held: claimHeld(shipment.status, via) },
    link: { endsAt: toUtcIso(trackingEndsAt(link.expiresAt, shipment)), via },
    timeZone: page.timeZone,
  }
}

/** POST /link/tracking/papers/:fileId/download */
export async function downloadPaper(request: FastifyRequest, fileId: string, idempotencyKey: string | undefined) {
  const link = trackingLinkOf(request)
  const now = officeAuthOf(request.server).clock.now()
  const system = systemOf(request, link)
  const found = await system.withClient(async (db) => {
    const tracked = await trackedOf(db, link, now)
    if (!tracked) return { dead: true as const }
    if (!papersShown(tracked.via)) return { dead: false as const, file: null }
    const paper = (await papersOf(db, tracked.shipment)).find((entry) => entry.fileId === fileId) ?? null
    const file = paper ? await db.storedFile.findUnique({ where: { id: fileId }, select: { id: true, companyId: true, status: true, storeAccountId: true, storageKey: true, thumbnailKey: true, contentType: true, originalName: true } }) : null
    return { dead: false as const, file: file && file.status === 'AVAILABLE' ? file : null }
  })
  if (found.dead) throw linkUnavailable()
  const file = found.file
  if (!file) throw new NotFoundError('File not found.')
  const runtime = processFiles()
  const key = await keyShownTo(runtime, requireContext(request), system, file)
  await linkCommand(request, { name: 'shipping.trackingPaper', idempotencyKey, input: { fileId } }, async (tools) => {
    const use = await useLink(tools, request, { action: 'download' })
    tools.audit({ action: 'links.downloadFile', recordType: 'StoredFile', recordId: file.id, companyId: file.companyId ?? link.companyId, after: { linkId: link.id, shipmentId: link.record.id, evidenceId: use.evidenceId } })
    return { fileId: file.id }
  })
  const download = await storeCall(() =>
    runtime.storage.presignDownload(system, file.storeAccountId, { key, contentType: file.contentType, disposition: attachmentDisposition(file.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: runtime.clock.now() }),
  )
  return { fileId: file.id, name: file.originalName, download: presignedView(download) }
}
