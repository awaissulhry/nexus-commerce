import type { Prisma } from '@nexus/factory-db'
import { PRINT_DOCUMENTS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import {
  labelledParcelProblems,
  MAX_PARCELS,
  nextParcelSeq,
  parcelChangeProblems,
  parcelMeasureProblems,
  placementOf,
  renumberedParcels,
  shipmentMachine,
  type ParcelMeasures,
  type ShipmentStatus,
} from '@nexus/factory-domain/shipping/shipments'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readPrinter } from '../../../platform/print/printers'
import { assertMay, shippingContextOf, type ShippingContext } from '../access'
import { lockCells, tenantOf } from '../cells'
import { holdOnPacking } from '../../quality/holds/checks'
import { pdfFileIdsOf } from '../ddt/store'
import { readSettings } from '../settings/settings'
import { PACKING_DOCUMENTS } from './contract'
import { contentsView, lockedStatus, packLineOf, packParcelOf, readContents, readShipment, shipmentFacts, type ShipmentHeader } from '../store'

/**
 * Packing (B-W1-46; LOG-039, LOG-002, QHS-073; A2 SCR-098 on the floor, SCR-067 in the office): the office and a floor
 * device at its own site (shipping.pack) add, weigh, measure and remove parcels, put the planned garments into parcels
 * (a line moves whole, splits, or joins its cell's line in the parcel), pack and unpack serials, and move the shipment
 * DRAFT ⇄ PACKED. Nothing here adds garments to a shipment or ships it: the office plans lines (../shipments), and the
 * floor never ships or cancels. Every write is one command() on the Shipment record (its version bump locks the row;
 * a cell's shipping lock follows, as in the triggers).
 */

/** Who made a row: the office user or the floor worker. */
const creatorOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' || tools.context.audience === 'floor' ? tools.context.actorId : null)

/** The shipment a packer may work on: the office's within its grants, a floor device's at its own site (else 404). */
async function packingShipment(caller: CommandCaller, shipmentId: string): Promise<{ context: ShippingContext; shipment: ShipmentHeader }> {
  const context = shippingContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_PACK, SHIPPING_PACK, shipment)
  return { context, shipment: shipment! }
}

/**
 * The office's documents a packer prints (SCR-098 "Documents"): the shipment's live DDT with its stored PDF (FISCAL_ARCHIVE,
 * shared with the site's floor), and the latest packing list (a DOCUMENT of the shipment shared with the site's floor;
 * the copies that travel by the party's link are never shared with the floor, so never this one). In any client: the
 * floor reads its own site's DDTs and the files shared with it.
 */
export async function packingDocuments(db: CommandTx, shipmentId: string) {
  const ddt = await db.ddt.findFirst({ where: { shipmentId, cancellations: { none: {} } }, select: { id: true, number: true, documentDate: true } })
  const ddtFile = ddt ? ((await pdfFileIdsOf(db, [ddt.id])).get(ddt.id) ?? null) : null
  const packingList = await db.storedFile.findFirst({
    where: { recordType: 'Shipment', recordId: shipmentId, kind: 'DOCUMENT', status: 'AVAILABLE', contentType: 'application/pdf', visibility: { has: 'FLOOR' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true },
  })
  return {
    ddt: ddt ? { id: ddt.id, number: ddt.number, documentDate: ddt.documentDate.toISOString().slice(0, 10), fileId: ddtFile } : null,
    packingList: packingList ? { fileId: packingList.id, createdAt: toUtcIso(packingList.createdAt) } : null,
  }
}

/** What a packer sees of a shipment: no order, party or address (the floor reads none). */
async function packingView(db: CommandTx, shipment: ShipmentHeader) {
  const contents = await contentsView(db, shipment.id)
  const settings = await readSettings(db, shipment.siteId)
  const documents = await packingDocuments(db, shipment.id)
  return {
    id: shipment.id,
    number: shipment.number,
    status: shipment.status,
    version: shipment.version,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    transportBy: shipment.transportBy,
    carrierCode: shipment.carrierCode,
    serviceCode: shipment.serviceCode,
    internalNote: shipment.internalNote,
    packedAt: shipment.packedAt ? toUtcIso(shipment.packedAt) : null,
    ...contents,
    documents,
    settings: settings
      ? { cutOffTime: settings.cutOffTime, defaultGoodsAppearance: settings.defaultGoodsAppearance, labelPrinterId: settings.labelPrinterId, documentPrinterId: settings.documentPrinterId }
      : null,
  }
}

export async function getPacking(caller: CommandCaller, shipmentId: string) {
  const { shipment } = await packingShipment(caller, shipmentId)
  return { shipment: await caller.withClient((client) => packingView(client, shipment)) }
}

/** The packing queue: DRAFT and PACKED shipments of the caller's sites (a floor device: its own), oldest first. */
export async function packingQueue(caller: CommandCaller, query: { siteId?: string | undefined; status?: 'DRAFT' | 'PACKED' | undefined }) {
  const context = shippingContextOf(caller)
  const where: Prisma.ShipmentWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_PACK, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput,
      { status: query.status ?? { in: ['DRAFT', 'PACKED'] } },
      query.siteId ? { siteId: query.siteId } : {},
    ],
  }
  const rows = await caller.withClient((client) =>
    client.shipment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, number: true, status: true, version: true, siteId: true, transportBy: true, carrierCode: true, packedAt: true, createdAt: true, lines: { select: { quantity: true } }, _count: { select: { parcels: true } } },
    }),
  )
  return {
    shipments: rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      version: row.version,
      siteId: row.siteId,
      transportBy: row.transportBy,
      carrierCode: row.carrierCode,
      lines: row.lines.length,
      garments: row.lines.reduce((garments, line) => garments + line.quantity, 0),
      parcels: row._count.parcels,
      packedAt: row.packedAt ? toUtcIso(row.packedAt) : null,
      createdAt: toUtcIso(row.createdAt),
    })),
  }
}

type Change = 'lines' | 'parcels' | 'serials' | 'status'

/** What a packer sees of a shipment (the packing view). */
type PackingView = Awaited<ReturnType<typeof packingView>>

/** One packing command on the shipment, answered with the packing view after it. */
async function packCommand<Extra extends object = Record<never, never>>(
  caller: CommandCaller,
  shipmentId: string,
  spec: { name: `shipping.${string}`; idempotencyKey: string | undefined; input: object; version: number | undefined; change: Change },
  work: (tools: CommandTools, shipment: ShipmentHeader) => Promise<Extra | void>,
): Promise<{ shipment: PackingView } & Extra> {
  const { shipment } = await packingShipment(caller, shipmentId)
  const { result } = await command(
    caller,
    { name: spec.name, idempotencyKey: spec.idempotencyKey, input: { shipmentId, ...spec.input }, record: { type: 'Shipment', id: shipment.id, expectedVersion: spec.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const extra = ((await work(tools, current)) ?? {}) as Extra
      const after = (await readShipment(tools.tx, shipment.id))!
      tools.emit({ type: 'shipment.packing_changed', subject: after.id, companyId: after.companyId, siteId: after.siteId, payload: { shipmentId: after.id, number: after.number, status: after.status, change: spec.change } })
      return { shipment: await packingView(tools.tx, after), ...extra }
    },
  )
  return result
}

function measuresData(measures: ParcelMeasures) {
  const data: Record<string, string | null> = {}
  for (const key of ['grossWeightKg', 'lengthCm', 'widthCm', 'heightCm'] as const) {
    const value = measures[key]
    if (value !== undefined) data[key] = value === null || value === '' ? null : value
  }
  return data
}

function checkMeasures(measures: ParcelMeasures): void {
  const problems = parcelMeasureProblems(measures)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The measures are not valid.', problems)
}

async function parcelOf(tx: CommandTx, shipmentId: string, parcelId: string) {
  const parcel = isUuid(parcelId)
    ? await tx.parcel.findFirst({ where: { id: parcelId, shipmentId }, select: { id: true, seq: true, grossWeightKg: true, lengthCm: true, widthCm: true, heightCm: true, trackingNumber: true, labelledAt: true } })
    : null
  if (!parcel) throw new NotFoundError('Parcel not found.')
  return parcel
}

const measuresOf = (parcel: { grossWeightKg: Prisma.Decimal | null; lengthCm: Prisma.Decimal | null; widthCm: Prisma.Decimal | null; heightCm: Prisma.Decimal | null }) => ({
  grossWeightKg: parcel.grossWeightKg?.toFixed(4) ?? null,
  lengthCm: parcel.lengthCm?.toFixed(2) ?? null,
  widthCm: parcel.widthCm?.toFixed(2) ?? null,
  heightCm: parcel.heightCm?.toFixed(2) ?? null,
})

/**
 * W2a B-W2a-26 hook (modules/quality/holds/checks.ts): packing goods on hold — garments into a parcel, a serial packed,
 * the shipment PACKED — is refused with the hold's reason (409) before the database's …_awaits_quality_hold triggers.
 */
async function refuseIfHeld(tools: CommandTools, shipmentId: string, what: { readonly parcelIds?: readonly (string | null)[]; readonly workOrderIds?: readonly string[]; readonly serialIds?: readonly string[] }): Promise<void> {
  const held = await holdOnPacking(tools.tx, tools.context, { shipmentId, ...what })
  if (held) throw new ConflictError(held)
}

// ---- parcels ------------------------------------------------------------------------------------------------------

/** shipping.pack: a new parcel (the next place), weighed and measured when given; only while a DRAFT. */
export async function addParcel(caller: CommandCaller, shipmentId: string, body: ParcelMeasures & { version?: number | undefined }, idempotencyKey?: string) {
  checkMeasures(body)
  const parcelId = newId()
  const { version, ...measures } = body
  return packCommand(caller, shipmentId, { name: 'shipping.addParcel', idempotencyKey, input: body, version, change: 'parcels' }, async (tools, shipment) => {
    await lockedStatus(tools, shipment.id, ['DRAFT'], 'parcels are added')
    const parcels = await tools.tx.parcel.findMany({ where: { shipmentId: shipment.id }, select: { seq: true } })
    if (parcels.length >= MAX_PARCELS) throw new ConflictError(`A shipment has at most ${MAX_PARCELS} parcels.`)
    const seq = nextParcelSeq(parcels)
    const data = measuresData(measures)
    await tools.tx.parcel.create({
      data: { id: parcelId, siteId: shipment.siteId, partyId: shipment.partyId, shipmentId: shipment.id, seq, ...data, createdById: creatorOf(tools) },
      select: { id: true },
    })
    tools.audit({ action: 'shipping.addParcel', recordType: 'Parcel', recordId: parcelId, companyId: shipment.companyId, siteId: shipment.siteId, after: { shipmentId: shipment.id, seq, ...data } })
    return { parcelId }
  })
}

/** shipping.pack: weighs and measures a parcel (a measure left out stays, null clears it) until the goods leave. */
export async function changeParcel(caller: CommandCaller, shipmentId: string, parcelId: string, body: ParcelMeasures & { version?: number | undefined }, idempotencyKey?: string) {
  checkMeasures(body)
  const { version, ...measures } = body
  return packCommand(caller, shipmentId, { name: 'shipping.changeParcel', idempotencyKey, input: { parcelId, ...body }, version, change: 'parcels' }, async (tools, shipment) => {
    const parcel = await parcelOf(tools.tx, shipment.id, parcelId)
    const problems = parcelChangeProblems(shipment.status as ShipmentStatus, measures, { seq: parcel.seq, labelled: parcel.trackingNumber !== null || parcel.labelledAt !== null })
    if (problems.length > 0) throw new ConflictError(problems.join(' '))
    const data = measuresData(measures)
    await tools.tx.parcel.update({ where: { id: parcel.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.changeParcel', recordType: 'Parcel', recordId: parcel.id, companyId: shipment.companyId, siteId: shipment.siteId, before: measuresOf(parcel), after: { ...measuresOf(parcel), ...data } })
  })
}

/** shipping.pack: removes an empty, unlabelled parcel while a DRAFT; the others close up (1, 2, 3 …). */
export async function removeParcel(caller: CommandCaller, shipmentId: string, parcelId: string, query: { version?: number | undefined }, idempotencyKey?: string) {
  return packCommand(caller, shipmentId, { name: 'shipping.removeParcel', idempotencyKey, input: { parcelId, ...query }, version: query.version, change: 'parcels' }, async (tools, shipment) => {
    await lockedStatus(tools, shipment.id, ['DRAFT'], 'parcels are removed')
    const parcel = await parcelOf(tools.tx, shipment.id, parcelId)
    if (await tools.tx.shipmentLine.count({ where: { parcelId: parcel.id } })) throw new ConflictError(`Parcel ${parcel.seq} holds garments: move them first.`)
    if (parcel.trackingNumber !== null || parcel.labelledAt !== null) throw new ConflictError(`Parcel ${parcel.seq} has a carrier label: void it first.`)
    await tools.tx.parcel.delete({ where: { id: parcel.id }, select: { id: true } })
    const rest = await tools.tx.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true } })
    for (const moved of renumberedParcels(rest)) {
      await tools.tx.parcel.update({ where: { id: moved.id }, data: { seq: moved.seq, version: { increment: 1 } }, select: { id: true } })
    }
    tools.audit({ action: 'shipping.removeParcel', recordType: 'Parcel', recordId: parcel.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { shipmentId: shipment.id, seq: parcel.seq, ...measuresOf(parcel) } })
  })
}

// ---- garments into parcels ------------------------------------------------------------------------------------------

/**
 * shipping.pack: puts `quantity` garments (default all) of a line into a parcel, or out of every parcel (`parcelId`
 * null), while a DRAFT: the whole line moves, part of it splits off, or it joins the line of its cell already in the
 * parcel (its serials with it). A cell's garments on the shipment never change, only where they are.
 */
export async function placeLine(caller: CommandCaller, shipmentId: string, lineId: string, body: { version?: number | undefined; parcelId: string | null; quantity?: number | undefined }, idempotencyKey?: string) {
  return packCommand(caller, shipmentId, { name: 'shipping.placeLine', idempotencyKey, input: { lineId, ...body }, version: body.version, change: 'lines' }, async (tools, shipment) => {
    await lockedStatus(tools, shipment.id, ['DRAFT'], 'garments move between parcels')
    const { lines, parcels } = await readContents(tools.tx, shipment.id)
    const line = lines.find((entry) => entry.id === lineId)
    if (!line) throw new NotFoundError('Shipment line not found.')
    if (body.parcelId !== null && !parcels.some((parcel) => parcel.id === body.parcelId)) throw new NotFoundError('Parcel not found.')
    // A labelled parcel keeps its contents until its label is voided (B-W1-48).
    const labelled = [line.parcelId, body.parcelId].flatMap((id) => labelledParcelProblems(parcels.map(packParcelOf).find((parcel) => parcel.id === id)))
    if (labelled.length > 0) throw new ConflictError(labelled.join(' '))
    const placed = placementOf(packLineOf(line), body.parcelId, body.quantity ?? line.quantity, lines.map(packLineOf))
    if (!placed.ok) throw new ConflictError(placed.problem)
    if (body.parcelId !== null) await refuseIfHeld(tools, shipment.id, { parcelIds: [body.parcelId], workOrderIds: [line.workOrderId] })
    const placement = placed.placement
    await lockCells(tools.tx, tenantOf(tools.context), [line.workOrderSizeId])
    const audit = (recordId: string, before: unknown, after: unknown) =>
      tools.audit({ action: 'shipping.placeLine', recordType: 'ShipmentLine', recordId, companyId: shipment.companyId, siteId: shipment.siteId, before, after })
    switch (placement.kind) {
      case 'none':
        audit(line.id, { parcelId: line.parcelId, quantity: line.quantity }, { parcelId: line.parcelId, quantity: line.quantity })
        break
      case 'move':
        await tools.tx.shipmentLine.update({ where: { id: line.id }, data: { parcelId: placement.parcelId, version: { increment: 1 } }, select: { id: true } })
        audit(line.id, { parcelId: line.parcelId }, { parcelId: placement.parcelId })
        break
      case 'split': {
        // The source shrinks first: the trigger counts the cell's other lines with the new one.
        await tools.tx.shipmentLine.update({ where: { id: line.id }, data: { quantity: placement.keeps, version: { increment: 1 } }, select: { id: true } })
        const splitId = newId()
        await tools.tx.shipmentLine.create({
          data: {
            id: splitId,
            siteId: shipment.siteId,
            partyId: shipment.partyId,
            shipmentId: shipment.id,
            parcelId: placement.parcelId,
            workOrderId: line.workOrderId,
            workOrderSizeId: line.workOrderSizeId,
            salesOrderLineId: line.salesOrderLineId,
            size: line.size,
            quantity: placement.quantity,
            createdById: creatorOf(tools),
          },
          select: { id: true },
        })
        audit(line.id, { quantity: line.quantity }, { quantity: placement.keeps })
        audit(splitId, null, { splitFrom: line.id, parcelId: placement.parcelId, quantity: placement.quantity })
        break
      }
      case 'merge': {
        const into = lines.find((entry) => entry.id === placement.intoLineId)!
        // Serials leave the source first, the source shrinks or goes, then the target grows and takes the serials.
        if (placement.movesSerials) {
          for (const serial of line.serials) await tools.tx.garmentSerial.update({ where: { id: serial.id }, data: { shipmentLineId: null, version: { increment: 1 } }, select: { id: true } })
        }
        if (placement.removesSource) await tools.tx.shipmentLine.delete({ where: { id: line.id }, select: { id: true } })
        else await tools.tx.shipmentLine.update({ where: { id: line.id }, data: { quantity: line.quantity - placement.quantity, version: { increment: 1 } }, select: { id: true } })
        await tools.tx.shipmentLine.update({ where: { id: into.id }, data: { quantity: into.quantity + placement.quantity, version: { increment: 1 } }, select: { id: true } })
        if (placement.movesSerials) {
          for (const serial of line.serials) await tools.tx.garmentSerial.update({ where: { id: serial.id }, data: { shipmentLineId: into.id, version: { increment: 1 } }, select: { id: true } })
        }
        audit(line.id, { parcelId: line.parcelId, quantity: line.quantity }, placement.removesSource ? { mergedInto: into.id } : { quantity: line.quantity - placement.quantity })
        audit(into.id, { quantity: into.quantity }, { quantity: into.quantity + placement.quantity, ...(placement.movesSerials ? { serials: line.serials.map((serial) => serial.serial) } : {}) })
        break
      }
    }
  })
}

// ---- serials (Q31 (b), QHS-073) -------------------------------------------------------------------------------------

/**
 * shipping.pack: a scanned serial into the shipment, while a DRAFT: a RELEASED serial (only released garments are
 * packed, QHS-073), not packed elsewhere, of a cell the shipment has a line of with a garment still without a serial
 * (in the named parcel when one is named).
 */
export async function packSerial(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; serial: string; parcelId?: string | undefined }, idempotencyKey?: string) {
  return packCommand(caller, shipmentId, { name: 'shipping.packSerial', idempotencyKey, input: body, version: body.version, change: 'serials' }, async (tools, shipment) => {
    await lockedStatus(tools, shipment.id, ['DRAFT'], 'serials are packed')
    const serial = await tools.tx.garmentSerial.findFirst({ where: { serial: body.serial }, select: { id: true, serial: true, status: true, shipmentLineId: true, workOrderSizeId: true } })
    if (!serial) throw new NotFoundError(`Serial ${body.serial} not found.`)
    if (serial.status !== 'RELEASED') throw new ConflictError(`Serial ${serial.serial} is ${serial.status}: only garments quality released are packed (QHS-073).`)
    const { lines, parcels } = await readContents(tools.tx, shipment.id)
    if (serial.shipmentLineId !== null) {
      throw new ConflictError(lines.some((line) => line.id === serial.shipmentLineId) ? `Serial ${serial.serial} is in this shipment already.` : `Serial ${serial.serial} is packed in another shipment.`)
    }
    if (body.parcelId !== undefined && !parcels.some((parcel) => parcel.id === body.parcelId)) throw new NotFoundError('Parcel not found.')
    const room = lines.filter((line) => line.workOrderSizeId === serial.workOrderSizeId && line.serials.length < line.quantity && (body.parcelId === undefined || line.parcelId === body.parcelId))
    const target = room.find((line) => line.parcelId !== null) ?? room[0]
    if (!target) {
      const seq = parcels.find((parcel) => parcel.id === body.parcelId)?.seq
      throw new ConflictError(`This shipment has no garment of serial ${serial.serial}'s cell left without a serial${seq ? ` in parcel ${seq}` : ''}.`)
    }
    await refuseIfHeld(tools, shipment.id, { parcelIds: [target.parcelId], workOrderIds: [target.workOrderId], serialIds: [serial.id] })
    await tools.tx.garmentSerial.update({ where: { id: serial.id }, data: { shipmentLineId: target.id, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.packSerial', recordType: 'GarmentSerial', recordId: serial.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { shipmentLineId: null }, after: { shipmentLineId: target.id, shipmentId: shipment.id } })
  })
}

/** shipping.pack: takes a serial out of the shipment again, while a DRAFT. */
export async function unpackSerial(caller: CommandCaller, shipmentId: string, serialId: string, query: { version?: number | undefined }, idempotencyKey?: string) {
  return packCommand(caller, shipmentId, { name: 'shipping.unpackSerial', idempotencyKey, input: { serialId, ...query }, version: query.version, change: 'serials' }, async (tools, shipment) => {
    await lockedStatus(tools, shipment.id, ['DRAFT'], 'serials are unpacked')
    const serial = isUuid(serialId) ? await tools.tx.garmentSerial.findFirst({ where: { id: serialId, shipmentLine: { shipmentId: shipment.id } }, select: { id: true, shipmentLineId: true } }) : null
    if (!serial) throw new NotFoundError('Serial not found in this shipment.')
    await tools.tx.garmentSerial.update({ where: { id: serial.id }, data: { shipmentLineId: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.unpackSerial', recordType: 'GarmentSerial', recordId: serial.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { shipmentLineId: serial.shipmentLineId }, after: { shipmentLineId: null } })
  })
}

// ---- DRAFT ⇄ PACKED -------------------------------------------------------------------------------------------------

async function move(tools: CommandTools, shipment: ShipmentHeader, from: 'DRAFT' | 'PACKED', to: 'DRAFT' | 'PACKED') {
  await lockedStatus(tools, shipment.id, [from], to === 'PACKED' ? 'it is packed' : 'it is unpacked')
  if (to === 'PACKED') {
    const { lines, parcels } = await readContents(tools.tx, shipment.id)
    await refuseIfHeld(tools, shipment.id, { parcelIds: parcels.map((parcel) => parcel.id), workOrderIds: lines.map((line) => line.workOrderId), serialIds: lines.flatMap((line) => line.serials.map((entry) => entry.id)) })
  }
  assertTransition(shipmentMachine, from, to, await shipmentFacts(tools.tx, shipment.id))
  await tools.tx.shipment.update({ where: { id: shipment.id }, data: { status: to, packedAt: to === 'PACKED' ? tools.now : null }, select: { id: true } })
  tools.audit({ action: to === 'PACKED' ? 'shipping.packShipment' : 'shipping.unpackShipment', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: from }, after: { status: to } })
  tools.emit({ type: 'shipment.status_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, from, to } })
}

/** shipping.pack: DRAFT → PACKED once every garment is in a weighed parcel (and every serial-tracked garment has its serial). */
export async function packShipment(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined }, idempotencyKey?: string) {
  return packCommand(caller, shipmentId, { name: 'shipping.packShipment', idempotencyKey, input: body, version: body.version, change: 'status' }, (tools, shipment) => move(tools, shipment, 'DRAFT', 'PACKED'))
}

/** shipping.pack: PACKED → DRAFT, to change the packing, while no carrier label and no live DDT name it. */
export async function unpackShipment(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined }, idempotencyKey?: string) {
  return packCommand(caller, shipmentId, { name: 'shipping.unpackShipment', idempotencyKey, input: body, version: body.version, change: 'status' }, (tools, shipment) => move(tools, shipment, 'PACKED', 'DRAFT'))
}

// ---- the office's documents on the station's printer (SCR-098 "Documents") ------------------------------------------

type PackingDocument = (typeof PACKING_DOCUMENTS)[number]

/**
 * shipping.pack: the office's documents of the shipment — its live DDT's PDF and the latest packing list — printed on
 * the packing station's A4 printer (the site's shipping settings, `documentPrinterId`). Printing the shipment's own
 * documents at its station is part of packing (a floor role never holds print.documents: FLOOR_SHARED_PERMISSIONS); any
 * other printer of the site needs print.documents there. Nothing is made here: what the office has not issued (the DDT)
 * or made (the packing list) is said in words. One command: a PDF print job per document (the relay sends it).
 */
export async function printDocuments(caller: CommandCaller, shipmentId: string, body: { documents?: PackingDocument[] | undefined; printerId?: string | undefined; copies?: number | undefined }, idempotencyKey?: string) {
  const { context, shipment } = await packingShipment(caller, shipmentId)
  const settings = await caller.withClient((client) => client.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { documentPrinterId: true } }))
  const printerId = body.printerId ?? settings?.documentPrinterId ?? null
  if (!printerId) throw new ValidationError('No document printer.', [{ path: 'body/printerId', message: "Set the site's document printer in the shipping settings; the office can print the PDFs meanwhile." }])
  const printer = await readPrinter(caller, printerId)
  if (printer.siteId !== shipment.siteId) throw new ValidationError('Not a printer of this site.', [{ path: 'body/printerId', message: "Choose a printer of the shipment's site." }])
  if (printer.id !== settings?.documentPrinterId && !can(actorOf(context), PRINT_DOCUMENTS, { companyId: printer.companyId, siteId: printer.siteId })) throw new ForbiddenError()
  if (printer.kind !== 'A4_PDF') throw new ValidationError('This printer prints labels.', [{ path: 'body/printerId', message: 'The DDT and the packing list print on an A4 printer.' }])
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`This printer is ${printer.status.toLowerCase()}; it takes no jobs now.`)

  const documents = await caller.withClient((client) => packingDocuments(client, shipment.id))
  const asked = body.documents ?? null
  const wanted: PackingDocument[] = asked ?? [...PACKING_DOCUMENTS]
  const chosen: { document: PackingDocument; fileId: string; recordType: string; recordId: string }[] = []
  for (const document of wanted) {
    if (document === 'DDT') {
      if (documents.ddt?.fileId) chosen.push({ document, fileId: documents.ddt.fileId, recordType: 'Ddt', recordId: documents.ddt.id })
      else if (asked) throw new InvalidStateError(documents.ddt ? `The PDF of DDT ${documents.ddt.number} is not stored yet: the office prints it again.` : 'This shipment has no live DDT yet: the office issues it.')
    } else if (documents.packingList) {
      chosen.push({ document, fileId: documents.packingList.fileId, recordType: 'Shipment', recordId: shipment.id })
    } else if (asked) {
      throw new InvalidStateError('This shipment has no packing list yet: the office makes it.')
    }
  }
  if (chosen.length === 0) throw new InvalidStateError('Nothing to print yet: the office issues the DDT and makes the packing list.')
  const copies = body.copies ?? 1

  const { result } = await command(caller, { name: 'shipping.printDocuments', idempotencyKey, input: { shipmentId, ...body } }, async ({ tx, audit, emit, now, context: inside }) => {
    const current = await tx.printer.findUnique({ where: { id: printer.id }, select: { status: true } })
    if (current?.status !== 'ACTIVE') throw new InvalidStateError('This printer takes no jobs now.')
    const requester =
      inside.audience === 'floor'
        ? { requestedById: inside.actorId, deviceId: inside.deviceId, createdById: inside.actorId }
        : inside.audience === 'office'
          ? { requestedById: inside.actorId, deviceId: null, createdById: inside.actorId }
          : { requestedById: null, deviceId: null, createdById: null }
    const jobs: { jobId: string; document: PackingDocument; status: string }[] = []
    for (const entry of chosen) {
      const id = newId()
      await tx.printJob.create({
        data: { id, companyId: printer.companyId, siteId: printer.siteId, printerId: printer.id, recordType: entry.recordType, recordId: entry.recordId, payloadKind: 'PDF', fileId: entry.fileId, copies, ...requester, createdAt: now, updatedAt: now },
        select: { id: true },
      })
      audit({ recordType: 'PrintJob', recordId: id, companyId: printer.companyId, siteId: printer.siteId, after: { printerId: printer.id, recordType: entry.recordType, recordId: entry.recordId, payloadKind: 'PDF', fileId: entry.fileId, copies, shipmentId: shipment.id, document: entry.document } })
      emit({ type: 'print.job_queued', subject: id, companyId: printer.companyId, siteId: printer.siteId, payload: { jobId: id, printerId: printer.id, payloadKind: 'PDF' } })
      jobs.push({ jobId: id, document: entry.document, status: 'QUEUED' })
    }
    return { jobs }
  })
  return result
}
