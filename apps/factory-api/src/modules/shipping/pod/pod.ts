import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { carrierTracked, hasTestLabel } from '@nexus/factory-domain/shipping/exceptions/rules'
import { podProblems, signerOf, POD_LIMITS, type DeliveredVia } from '@nexus/factory-domain/shipping/pod/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { events as deliveryEvents } from '@nexus/factory-domain/shipping-delivery/events'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { presignedView, putGeneratedFile, recordGeneratedFile, storeCall, type PreparedGeneratedFile } from '../../../platform/files/files'
import { attachmentDisposition, DOWNLOAD_URL_SECONDS } from '../../../platform/files/rules'
import type { FilesRuntime } from '../../../platform/files/service'
import { carrierProblem, type CarrierRuntime } from '../labels/carrier'
import { mayOn, officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'

/**
 * The proof of delivery on the shipment (B-W2b-398; LOG-065; factory-domain shipping/pod): who signed, when and the image,
 * on the Shipment (podSignedBy, podAt, podFileId; each set once, only while DELIVERED: the database's Shipment_pod_check).
 *
 *   GET  /shipping/shipments/:shipmentId/pod        shipping.view: the proof, how the shipment came to be delivered, may record
 *   PUT  /shipping/shipments/:shipmentId/pod        shipping.manage: recorded by hand from the carrier's paper (the image a
 *                                                   file of the shipment, uploaded first through the files routes)
 *   GET  /shipping/shipments/:shipmentId/pod/file   shipping.view: the image, a presigned GET of 60 seconds (for a dispute)
 *   from the carrier   the worker (handler.ts) asks the carrier through the gateway once tracking moved the shipment
 *                      DELIVERED (never for a TEST label, our van or a carrier booked by hand); the image is stored first
 *                      (outside any transaction), then ONE command sets what is still missing
 */

const podEvent = deliveryEvents.find((event) => event.type === 'shipment.pod_recorded')!

const POD_SELECT = { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, shippedAt: true, deliveredAt: true, integrationAccountId: true, podSignedBy: true, podAt: true, podFileId: true, version: true } as const

type PodShipment = { readonly id: string; readonly status: string; readonly shippedAt: Date | null; readonly deliveredAt: Date | null; readonly podSignedBy: string | null; readonly podAt: Date | null; readonly podFileId: string | null }

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** How the shipment came to be delivered: the carrier's tracking, or a status typed by a person (B-W2b-390's own transport). */
export async function deliveredViaOf(db: CommandTx, shipmentId: string): Promise<DeliveredVia | null> {
  const event = await db.trackingEvent.findFirst({ where: { shipmentId, status: 'DELIVERED' }, select: { source: true }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] })
  if (!event) return null
  return event.source === 'MANUAL' ? 'TYPED' : 'CARRIER'
}

/** The proof as the screens read it (office: the signer is the customer's person, inside this one record). */
export async function podViewOf(db: CommandTx, shipment: PodShipment) {
  const file = shipment.podFileId ? await db.storedFile.findUnique({ where: { id: shipment.podFileId }, select: { id: true, originalName: true, contentType: true, sizeBytes: true } }) : null
  return {
    deliveredAt: iso(shipment.deliveredAt),
    deliveredVia: shipment.status === 'DELIVERED' ? await deliveredViaOf(db, shipment.id) : null,
    pod:
      shipment.podSignedBy || shipment.podAt || file
        ? { signedBy: shipment.podSignedBy, signedAt: iso(shipment.podAt), file: file ? { id: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) } : null }
        : null,
  }
}

/** GET: the shipment's proof of delivery. */
export async function getPod(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  const header = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  return caller.withClient(async (db) => {
    const shipment = (await db.shipment.findUnique({ where: { id: header.id }, select: POD_SELECT }))!
    const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { carrierParcelId: true, trackingNumber: true } })
    const complete = shipment.podSignedBy !== null && shipment.podAt !== null && shipment.podFileId !== null
    return {
      shipment: { id: shipment.id, number: shipment.number, status: shipment.status, shippedAt: iso(shipment.shippedAt), version: shipment.version },
      ...(await podViewOf(db, shipment)),
      /** The carrier is asked for its proof once tracking says delivered (a real carrier label, never a TEST one). */
      carrierAsked: shipment.integrationAccountId !== null && !hasTestLabel(parcels) && parcels.some((parcel) => parcel.trackingNumber !== null),
      /** Why a person cannot record it now (null: they may). */
      recordHeld: shipment.status !== 'DELIVERED' ? ('NOT_DELIVERED' as const) : complete ? ('KEPT' as const) : !mayOn(context, SHIPPING_MANAGE, header) ? ('NO_RIGHT' as const) : null,
      signerMax: POD_LIMITS.signer,
    }
  })
}

export interface PodBody {
  readonly version?: number | undefined
  readonly signedBy?: string | null | undefined
  readonly signedAt?: string | null | undefined
  readonly fileId?: string | null | undefined
}

/** Writes the parts still missing, inside a command (the row FOR UPDATE first); answers what it set. */
async function setPodInCommand(tools: CommandTools, shipmentId: string, given: { signedBy: string | null; signedAt: Date | null; fileId: string | null }, via: 'CARRIER' | 'OFFICE', version?: number) {
  const { tx, now } = tools
  await tx.$queryRaw`SELECT 1 FROM "Shipment" WHERE "id" = ${shipmentId}::uuid FOR UPDATE`
  const current = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: POD_SELECT })
  if (version !== undefined && version !== current.version) throw new StaleVersionError('Shipment', current.id, current.version, version)
  const data: { podSignedBy?: string; podAt?: Date; podFileId?: string } = {}
  if (current.podSignedBy === null && given.signedBy !== null) data.podSignedBy = given.signedBy
  if (current.podAt === null && given.signedAt !== null) data.podAt = given.signedAt
  if (current.podFileId === null && given.fileId !== null) data.podFileId = given.fileId
  if (Object.keys(data).length === 0) {
    tools.audit({ action: 'shipping.recordPod', recordType: 'Shipment', recordId: shipmentId, companyId: current.companyId, siteId: current.siteId, after: { via, set: [] } })
    return { current, set: [] as string[] }
  }
  if (current.status !== 'DELIVERED') throw new InvalidStateError(`The shipment is ${current.status}: the proof of delivery is recorded once it is delivered.`)
  await tx.shipment.update({ where: { id: shipmentId }, data: { ...data, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({
    action: 'shipping.recordPod',
    recordType: 'Shipment',
    recordId: shipmentId,
    companyId: current.companyId,
    siteId: current.siteId,
    after: { via, signedBy: data.podSignedBy !== undefined, signedAt: data.podAt ? toUtcIso(data.podAt) : null, fileId: data.podFileId ?? null },
  })
  tools.emit(eventFor(podEvent, { subject: shipmentId, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId, number: current.number, via, image: (data.podFileId ?? current.podFileId) !== null } }))
  return { current, set: Object.keys(data) }
}

const refusal = (code: string, message: string): never => {
  throw new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])
}

/** PUT: shipping.manage, the proof recorded by hand (each part once). Answers the proof. */
export async function recordPod(caller: CommandCaller, shipmentId: string, body: PodBody, idempotencyKey?: string) {
  const header = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const now = serverClock.now()
  const signedAt = body.signedAt === undefined || body.signedAt === null ? null : new Date(body.signedAt)
  const given = { signedBy: body.signedBy === undefined ? null : body.signedBy, signedAt, fileId: body.fileId ?? null }
  const facts = await caller.withClient(async (db) => {
    const shipment = await db.shipment.findUniqueOrThrow({ where: { id: header.id }, select: POD_SELECT })
    const file = given.fileId && isUuid(given.fileId) ? await db.storedFile.findUnique({ where: { id: given.fileId }, select: { id: true, recordType: true, recordId: true, companyId: true, status: true } }) : null
    return { shipment, file }
  })
  const problems: Issue[] = podProblems(given, { status: facts.shipment.status, shippedAt: facts.shipment.shippedAt, kept: { signedBy: facts.shipment.podSignedBy, signedAt: facts.shipment.podAt, fileId: facts.shipment.podFileId } }, now)
  if (given.fileId !== null && (!facts.file || facts.file.recordType !== 'Shipment' || facts.file.recordId !== header.id || facts.file.companyId !== header.companyId || facts.file.status !== 'AVAILABLE')) {
    problems.push({ path: 'body/fileId', message: 'The image must be an available file of this shipment: upload it on the shipment first.' })
  }
  const state = problems.find((problem) => problem.path.startsWith('refusal/'))
  if (state) refusal(state.path.slice('refusal/'.length), state.message)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The proof of delivery is not valid.', problems)
  const kept = facts.shipment
  const signer = signerOf(given.signedBy)
  const adds = (kept.podSignedBy === null && signer !== null) || (kept.podAt === null && given.signedAt !== null) || (kept.podFileId === null && given.fileId !== null)
  if (body.version !== undefined && body.version !== kept.version) throw new StaleVersionError('Shipment', kept.id, kept.version, body.version)
  // The same parts sent again: nothing changes, nothing is written.
  if (!adds) return getPod(caller, header.id)
  await command(caller, { name: 'shipping.recordPod', idempotencyKey, input: { shipmentId: header.id, ...body } }, async (tools) => {
    const { set } = await setPodInCommand(tools, header.id, { signedBy: signer, signedAt: given.signedAt, fileId: given.fileId }, 'OFFICE', body.version)
    return { set }
  })
  return getPod(caller, header.id)
}

/** GET …/pod/file: the image, presigned for 60 seconds. */
export async function downloadPod(files: FilesRuntime, caller: CommandCaller, shipmentId: string) {
  const header = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const file = await caller.withClient(async (db) => {
    const shipment = await db.shipment.findUniqueOrThrow({ where: { id: header.id }, select: { podFileId: true } })
    return shipment.podFileId ? db.storedFile.findUnique({ where: { id: shipment.podFileId }, select: { id: true, status: true, storeAccountId: true, storageKey: true, contentType: true, originalName: true } }) : null
  })
  if (!file || file.status !== 'AVAILABLE') throw new NotFoundError('The shipment has no image of its proof of delivery.')
  const download = await storeCall(() =>
    files.storage.presignDownload(caller, file.storeAccountId, { key: file.storageKey, contentType: file.contentType, disposition: attachmentDisposition(file.originalName), expiresInSeconds: DOWNLOAD_URL_SECONDS, now: files.clock.now() }),
  )
  return { fileId: file.id, name: file.originalName, download: presignedView(download) }
}

// ---- from the carrier --------------------------------------------------------------------------------------------------

const FILE_TYPES = { 'application/pdf': { kind: 'DOCUMENT', extension: 'pdf' }, 'image/png': { kind: 'PHOTO', extension: 'png' }, 'image/jpeg': { kind: 'PHOTO', extension: 'jpg' } } as const

/**
 * Asks the carrier for a delivered shipment's proof (the worker, as the tenant's system): the parcels the carrier tracks,
 * the last one delivered first, until one answers; the image stored as a file of the shipment (office only), then ONE command
 * sets what is still missing (the signer one line of at most 200 characters; the time between the goods leaving and now,
 * else the carrier's delivery time). Answers what it set; a TEST label, a shipment not carried by Sendcloud, or a proof
 * already complete asks nothing.
 */
export async function fetchCarrierPod(runtime: { readonly carrier: CarrierRuntime; readonly files: FilesRuntime }, caller: CommandCaller, shipmentId: string, causationId?: string): Promise<{ readonly set: readonly string[]; readonly problem: string | null }> {
  const read = await caller.withClient(async (db) => {
    const shipment = await db.shipment.findUnique({ where: { id: shipmentId }, select: POD_SELECT })
    if (!shipment) return null
    const parcels = await db.parcel.findMany({ where: { shipmentId }, select: { id: true, seq: true, carrierParcelId: true, trackingNumber: true, labelledAt: true }, orderBy: { seq: 'asc' } })
    const arrivals = await db.trackingEvent.findMany({ where: { shipmentId, status: 'DELIVERED', parcelId: { not: null } }, select: { parcelId: true, occurredAt: true }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }] })
    return { shipment, parcels, arrivals }
  })
  if (!read) return { set: [], problem: null }
  const { shipment, parcels, arrivals } = read
  if (shipment.status !== 'DELIVERED' || shipment.integrationAccountId === null || hasTestLabel(parcels)) return { set: [], problem: null }
  if (shipment.podSignedBy !== null && shipment.podAt !== null && shipment.podFileId !== null) return { set: [], problem: null }
  const order = new Map(arrivals.map((row, index) => [row.parcelId!, index]))
  const tracked = carrierTracked(parcels).sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
  let proof = null
  let problem: string | null = null
  for (const parcel of tracked) {
    try {
      proof = await runtime.carrier.proofOfDelivery(caller, shipment.integrationAccountId, { providerId: parcel.carrierParcelId!, trackingNumber: parcel.trackingNumber! })
    } catch (error) {
      problem = carrierProblem(error)
      continue
    }
    if (proof) break
  }
  if (!proof) return { set: [], problem }
  const now = serverClock.now()
  const signer = signerOf(proof.signedBy)
  const signedBy = signer !== null && signer.length <= POD_LIMITS.signer && !/[\r\n]/.test(signer) ? signer : null
  const said = proof.signedAt ? new Date(proof.signedAt) : null
  const inRange = (at: Date | null) => at !== null && !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime() && (shipment.shippedAt === null || at.getTime() >= shipment.shippedAt.getTime())
  const signedAt = inRange(said) ? said : inRange(shipment.deliveredAt) ? shipment.deliveredAt : null
  let prepared: PreparedGeneratedFile | null = null
  if (proof.image && shipment.podFileId === null) {
    const type = FILE_TYPES[proof.image.contentType]
    prepared = await putGeneratedFile(runtime.files, caller, {
      companyId: shipment.companyId,
      recordType: 'Shipment',
      recordId: shipment.id,
      kind: type.kind,
      originalName: `proof-of-delivery-${shipment.number.replace(/[^A-Za-z0-9._-]+/g, '-')}.${type.extension}`,
      contentType: proof.image.contentType,
      body: proof.image.body,
      visibility: ['OFFICE'],
    })
  }
  const { result } = await command(caller, { name: 'shipping.carrierPod', input: { shipmentId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    await tools.tx.$queryRaw`SELECT 1 FROM "Shipment" WHERE "id" = ${shipmentId}::uuid FOR UPDATE`
    const kept = await tools.tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { podFileId: true } })
    // The image is named only when none is yet (another run may have named one meanwhile).
    const file = prepared && kept.podFileId === null ? await recordGeneratedFile(tools, prepared) : null
    const { set } = await setPodInCommand(tools, shipmentId, { signedBy, signedAt, fileId: file?.id ?? null }, 'CARRIER')
    return { set }
  })
  return { set: result.set, problem }
}
