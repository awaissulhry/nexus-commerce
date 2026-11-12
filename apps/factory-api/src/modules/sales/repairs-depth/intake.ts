import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { SALES_REPAIRS_MANAGE, SALES_REPAIRS_VIEW } from '@nexus/factory-domain/sales/repairs/permissions'
import { statusWords, type RepairKind, type RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import { coverWords, DEPTH_LIMITS, newestOf, photosHeld, photosNeeded, type EstimateStatus } from '@nexus/factory-domain/sales/repairs-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { completeUpload, requestUpload } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { certificateGateFor } from '../../compliance/certificates/gate'
import { photoProblems, type PhotoUpload } from '../portal-returns/files'
import { mayOn, officeOf, officeRepair } from '../repairs/access'
import { garmentOf, readRepair, safetyFactsOf, styleOf, type RepairRow } from '../repairs/store'
import { damagePhotosOf, fromCustomer, isoOrNull, linesOf, totalsOf, type Reader } from './store'

/**
 * The intake of a repair in depth (B-W2b-342; SAL-384, SAL-385, SAL-391, SAL-393; design sales.returns rec "Repair order"
 * › Intake & photos: "Garment serial → style, size, colour, made on", "Customer's description", "Photos with markup",
 * "Repair history of this serial"):
 *
 *   GET  /sales/repairs/:repairId/intake               how it reached us, what is wrong and the work wanted, the garment of
 *                                                      ours its serial names, the damage photos (the customer's and ours),
 *                                                      and the safety rule with the certificate that covers the garment
 *                                                      today (an alteration of a protective garment keeps its check)
 *   POST /sales/repairs/:repairId/photos (+ /:fileId/complete)  an office damage photo (category DAMAGE_PHOTO, office only)
 *   GET  /sales/repairs/history?serial=                every repair, return and complaint of one garment by its serial,
 *                                                      newest first: the repairs the caller may see, a return line with
 *                                                      sales.returns.view, a complaint with quality.complaints.view
 */

const today = () => businessDate(serverClock.now())

/** The certificate that covers the garment today (its style, colour and size), as the gate answers. */
async function coverOf(db: Reader, repair: Pick<RepairRow, 'kind' | 'styleId' | 'colourwayId' | 'size' | 'safetyCheckRequired'>) {
  const gate = repair.styleId && repair.colourwayId ? await certificateGateFor(db, { styleId: repair.styleId, colourwayId: repair.colourwayId, ...(repair.size ? { size: repair.size } : {}) }, today()).catch(() => null) : null
  const certificate = gate?.certificate ?? null
  return {
    required: repair.safetyCheckRequired,
    styleKnown: repair.styleId !== null,
    outcome: gate?.outcome ?? null,
    certificate: certificate ? { id: certificate.id, number: certificate.number, standard: certificate.standard, ppeClass: certificate.ppeClass } : null,
    reasons: (gate?.reasons ?? []).map((reason) => reason.message),
    words: coverWords({ kind: repair.kind as RepairKind, required: repair.safetyCheckRequired, styleKnown: repair.styleId !== null, certificateNumber: certificate?.number ?? null }),
  }
}

export async function intakeView(db: Reader, repair: RepairRow) {
  const extra = await db.repairOrder.findUniqueOrThrow({ where: { id: repair.id }, select: { channel: true, workWanted: true, garmentSerial: true } })
  const garment = await garmentOf(db, extra.garmentSerial ?? repair.serial)
  const style = garment ? await styleOf(db, garment.styleId) : null
  const photos = await damagePhotosOf(db, repair.id)
  const others = extra.garmentSerial || repair.serial ? await db.repairOrder.count({ where: { id: { not: repair.id }, OR: [...(extra.garmentSerial ? [{ garmentSerial: extra.garmentSerial }] : []), ...(repair.serial ? [{ serial: repair.serial }] : [])] } }) : 0
  return {
    repair: { id: repair.id, number: repair.number, kind: repair.kind, stage: repair.stage, channel: extra.channel, partyId: repair.partyId, version: repair.version },
    problem: repair.problem,
    workWanted: extra.workWanted,
    garment: {
      serial: repair.serial,
      garmentSerial: extra.garmentSerial,
      ours: garment
        ? { style: style ? { code: style.code, name: style.name } : null, size: garment.size, madeOn: garment.madeOn, workOrderNumber: garment.workOrderNumber, batchNumber: garment.batchNumber, forThisCustomer: garment.partyId === null || garment.partyId === repair.partyId }
        : null,
      otherRepairs: others,
    },
    photos: photos.map((photo) => ({ id: photo.id, name: photo.originalName, contentType: photo.contentType, sizeBytes: photo.sizeBytes, status: photo.status, at: toUtcIso(photo.createdAt), fromCustomer: fromCustomer(photo) })),
    photosNeeded: photosNeeded(repair.kind as RepairKind),
    photosHeld: photosHeld(repair.number, repair.stage as RepairStage),
    cover: await coverOf(db, repair),
  }
}

export async function getIntake(caller: CommandCaller, repairId: string) {
  const { repair } = await officeRepair(caller, repairId)
  return caller.withClient(async (client) => ({ intake: await intakeView(client, (await readRepair(client, repair.id))!) }))
}

// ---- the office's damage photos ----------------------------------------------------------------------------------------

/** POST /sales/repairs/:repairId/photos: an office photo of the damage (DAMAGE_PHOTO, OFFICE only), to PUT then confirm. */
export async function announceOfficePhoto(files: FilesRuntime, caller: CommandCaller, repairId: string, body: PhotoUpload, idempotencyKey?: string) {
  const { repair } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  photoProblems(body)
  const held = photosHeld(repair.number, repair.stage as RepairStage)
  if (held) throw new InvalidStateError(held)
  const count = await caller.withClient((client) => client.storedFile.count({ where: { recordType: 'RepairOrder', recordId: repair.id, category: 'DAMAGE_PHOTO', status: { not: 'DELETED' } } }))
  if (count >= DEPTH_LIMITS.photos * 2) throw new InvalidStateError(`Repair ${repair.number} holds ${count} damage photos already.`)
  const answer = await requestUpload(
    files,
    caller,
    { companyId: repair.companyId, recordType: 'RepairOrder', recordId: repair.id, kind: 'PHOTO', category: 'DAMAGE_PHOTO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256, visibility: ['OFFICE'] },
    idempotencyKey,
  )
  return { file: { id: answer.file.id, originalName: answer.file.originalName, sizeBytes: answer.file.sizeBytes, status: answer.file.status }, upload: answer.upload }
}

export async function completeOfficePhoto(files: FilesRuntime, caller: CommandCaller, repairId: string, fileId: string, idempotencyKey?: string) {
  const { repair } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  const file = isUuid(fileId) ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: 'RepairOrder', recordId: repair.id, category: 'DAMAGE_PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('File not found.')
  const view = await completeUpload(files, caller, fileId, idempotencyKey)
  return { file: { id: view.id, originalName: view.originalName, sizeBytes: view.sizeBytes, status: view.status } }
}

// ---- the history of a garment (SAL-391) --------------------------------------------------------------------------------

/** GET /sales/repairs/history?serial=: what happened to one garment with us, by the serial on its label. */
export async function garmentHistory(caller: CommandCaller, query: { readonly serial: string }) {
  const context = officeOf(caller)
  const serial = query.serial.trim()
  if (serial === '' || serial.length > DEPTH_LIMITS.query) throw new ValidationError('Type the serial on the label.', [{ path: 'querystring/serial', message: `The serial, 1 to ${DEPTH_LIMITS.query} characters.` }])
  const actor = actorOf(context)
  const grains = heldGrains(actor)
  return caller.withClient(async (db) => {
    const garment = await garmentOf(db, serial)
    const style = garment ? await styleOf(db, garment.styleId) : null
    const colourway = garment ? await db.colourway.findUnique({ where: { id: garment.colourwayId }, select: { code: true, name: true } }) : null
    const madeFor = garment?.partyId ? await db.party.findUnique({ where: { id: garment.partyId }, select: { id: true, code: true, legalName: true } }) : null
    const repairs = await db.repairOrder.findMany({
      where: { OR: [{ serial }, { garmentSerial: serial }] },
      select: { id: true, number: true, kind: true, stage: true, channel: true, companyId: true, siteId: true, partyId: true, problem: true, workWanted: true, receivedAt: true, repairedAt: true, shippedAt: true, safetyCheckRequired: true, safetyCheckResult: true, safetyCheckedAt: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: DEPTH_LIMITS.history,
    })
    const seen = repairs.filter((row) => mayOn(context, SALES_REPAIRS_VIEW, row))
    const estimates = seen.length > 0 ? await db.repairEstimate.findMany({ where: { repairId: { in: seen.map((row) => row.id) } }, select: { id: true, repairId: true, revision: true, status: true, currency: true } }) : []
    const lines = await linesOf(db, estimates.map((row) => row.id))
    const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(seen.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
    const returns = can(actor, SALES_RETURNS_VIEW, {})
      ? await db.returnLine.findMany({
          where: { OR: [{ serial }, { garmentSerial: serial }] },
          select: { id: true, seq: true, reasonCode: true, disposition: true, receivedAt: true, createdAt: true, rma: { select: { id: true, number: true, status: true, companyId: true, partyId: true, requestedAt: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: DEPTH_LIMITS.history,
        })
      : []
    const complaints = can(actor, QUALITY_COMPLAINTS_VIEW, {})
      ? await db.complaint.findMany({ where: { serial }, select: { id: true, number: true, status: true, companyId: true, partyId: true, receivedAt: true, category: true }, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: DEPTH_LIMITS.history })
      : []
    return {
      serial,
      garment: garment
        ? {
            serial: garment.serial,
            style: style ? { code: style.code, name: style.name, ppeCategory: style.ppeCategory } : null,
            colourway,
            size: garment.size,
            madeOn: garment.madeOn,
            workOrderNumber: garment.workOrderNumber,
            batchNumber: garment.batchNumber,
            madeFor: madeFor && can(actor, SALES_REPAIRS_VIEW, { partyId: madeFor.id }) ? { id: madeFor.id, code: madeFor.code, legalName: madeFor.legalName } : null,
          }
        : null,
      repairs: seen.map((row) => {
        const own = estimates.filter((estimate) => estimate.repairId === row.id)
        const newest = newestOf(own.map((estimate) => ({ ...estimate, status: estimate.status as EstimateStatus })))
        const sums = newest ? totalsOf(lines.get(newest.id) ?? []) : null
        return {
          id: row.id,
          number: row.number,
          kind: row.kind,
          stage: row.stage,
          status: statusWords({ stage: row.stage as RepairStage, ...safetyFactsOf(row) }),
          channel: row.channel,
          party: parties.get(row.partyId) ?? null,
          problem: row.problem,
          workWanted: row.workWanted,
          receivedAt: isoOrNull(row.receivedAt),
          repairedAt: isoOrNull(row.repairedAt),
          shippedAt: isoOrNull(row.shippedAt),
          safetyResult: row.safetyCheckResult,
          createdAt: toUtcIso(row.createdAt),
          estimate: newest && sums ? { revision: newest.revision, status: newest.status, currency: newest.currency, amount: asMoney('price', sums.amount) } : null,
        }
      }),
      hidden: repairs.length - seen.length,
      returns: returns
        .filter((row) => can(actor, SALES_RETURNS_VIEW, { companyId: row.rma.companyId, partyId: row.rma.partyId }))
        .map((row) => ({ lineId: row.id, seq: row.seq, returnId: row.rma.id, number: row.rma.number, status: row.rma.status, reasonCode: row.reasonCode, disposition: row.disposition, receivedAt: isoOrNull(row.receivedAt), requestedAt: isoOrNull(row.rma.requestedAt) })),
      complaints: complaints.filter((row) => can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: row.companyId, partyId: row.partyId })).map((row) => ({ id: row.id, number: row.number, status: row.status, category: row.category, receivedAt: toUtcIso(row.receivedAt) })),
      seesPrices: grains.has('price'),
    }
  })
}
