import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { benchProblems, marksCurrent, openCarton, renumbered, sizeGrid, type CartonLine, type CartonParcel } from '@nexus/factory-domain/shipping/cartons/rules'
import { bestDefault, netWeightKg, PARCEL_PACKAGING_KINDS, type LiveDefault } from '@nexus/factory-domain/shipping/packaging/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { ShipmentHeader } from '../store'

/**
 * The packing bench's reads (B-W2b-384; LOG-007, LOG-003, LOG-010): a shipment's lines with what is scanned of each, its
 * parcels with their packaging, number and marks, and their contents with the serials in them. Read in the command's
 * transaction or a scoped client (row-level security decides what it finds: a floor device its own site's, without the
 * packaging's cost). No party, no address, no money: the floor reads all of it.
 */

const LINE_SELECT = {
  id: true,
  parcelId: true,
  workOrderId: true,
  workOrderSizeId: true,
  salesOrderLineId: true,
  size: true,
  quantity: true,
  workOrderSize: {
    select: {
      colourway: { select: { id: true, code: true, name: true } },
      workOrder: { select: { number: true, batchNumber: true, style: { select: { id: true, code: true, name: true, garmentTracking: true, sizeScaleId: true, originCountry: true } } } },
    },
  },
  serials: { select: { id: true, serial: true, parcelId: true, packedAt: true }, orderBy: { serial: 'asc' } },
} as const satisfies Prisma.ShipmentLineSelect

const PARCEL_SELECT = {
  id: true,
  seq: true,
  version: true,
  grossWeightKg: true,
  lengthCm: true,
  widthCm: true,
  heightCm: true,
  trackingNumber: true,
  labelledAt: true,
  packagingTypeId: true,
  cartonNumber: true,
  cartonCount: true,
  marksPrintedAt: true,
} as const satisfies Prisma.ParcelSelect

const CONTENT_SELECT = { id: true, parcelId: true, shipmentLineId: true, size: true, quantity: true } as const satisfies Prisma.ParcelLineSelect

/** What the floor reads of a packaging type (never its cost). */
const TYPE_SELECT = { id: true, name: true, kind: true, innerLengthCm: true, innerWidthCm: true, innerHeightCm: true, tareKg: true, maxWeightKg: true, palletKind: true, active: true } as const satisfies Prisma.PackagingTypeSelect

export type BenchLine = Prisma.ShipmentLineGetPayload<{ select: typeof LINE_SELECT }>
export type BenchParcel = Prisma.ParcelGetPayload<{ select: typeof PARCEL_SELECT }>
export type BenchContent = Prisma.ParcelLineGetPayload<{ select: typeof CONTENT_SELECT }>
export type BenchType = Prisma.PackagingTypeGetPayload<{ select: typeof TYPE_SELECT }>

export interface Bench {
  readonly lines: BenchLine[]
  readonly parcels: BenchParcel[]
  readonly contents: BenchContent[]
}

/** A shipment's lines (style, colour, size order), parcels (by place) and carton contents, as read now. */
export async function readBench(db: CommandTx, shipmentId: string): Promise<Bench> {
  // One query after another: a transaction's client has one connection.
  const lines = await db.shipmentLine.findMany({ where: { shipmentId }, select: LINE_SELECT, orderBy: { id: 'asc' } })
  const parcels = await db.parcel.findMany({ where: { shipmentId }, select: PARCEL_SELECT, orderBy: { seq: 'asc' } })
  const contents = await db.parcelLine.findMany({ where: { shipmentId }, select: CONTENT_SELECT, orderBy: { id: 'asc' } })
  lines.sort(
    (a, b) =>
      a.workOrderSize.workOrder.style.code.localeCompare(b.workOrderSize.workOrder.style.code) ||
      a.workOrderSize.colourway.code.localeCompare(b.workOrderSize.colourway.code) ||
      a.size.localeCompare(b.size, undefined, { numeric: true }) ||
      (a.parcelId ?? '').localeCompare(b.parcelId ?? '') ||
      a.id.localeCompare(b.id),
  )
  return { lines, parcels, contents }
}

/** The garments of a line scanned into its carton (its contents). */
export const scannedOf = (bench: Bench, lineId: string): number => bench.contents.filter((content) => content.shipmentLineId === lineId).reduce((sum, content) => sum + content.quantity, 0)

export const cartonLinesOf = (bench: Bench): CartonLine[] =>
  bench.lines.map((line) => ({
    id: line.id,
    cellId: line.workOrderSizeId,
    workOrderId: line.workOrderId,
    styleId: line.workOrderSize.workOrder.style.id,
    styleCode: line.workOrderSize.workOrder.style.code,
    colourwayId: line.workOrderSize.colourway.id,
    colourwayCode: line.workOrderSize.colourway.code,
    size: line.size,
    quantity: line.quantity,
    parcelId: line.parcelId,
    scanned: scannedOf(bench, line.id),
    serialIds: line.serials.map((serial) => serial.id),
    serialsInCarton: line.serials.filter((serial) => serial.parcelId !== null && serial.parcelId === line.parcelId).length,
    serialTracked: line.workOrderSize.workOrder.style.garmentTracking === 'SERIAL',
  }))

export const cartonParcelsOf = (bench: Bench): CartonParcel[] =>
  bench.parcels.map((parcel) => ({ id: parcel.id, seq: parcel.seq, closed: parcel.cartonNumber !== null, labelled: parcel.trackingNumber !== null || parcel.labelledAt !== null }))

export const numberedOf = (parcel: BenchParcel) => ({ id: parcel.id, seq: parcel.seq, cartonNumber: parcel.cartonNumber, cartonCount: parcel.cartonCount, marksPrinted: parcel.marksPrintedAt !== null })

/** The hold in force on the shipment (the oldest), its reason only (the floor never reads the words). */
export async function holdInForce(db: CommandTx, shipmentId: string): Promise<{ reason: string; placedAt: Date } | null> {
  return db.shipmentHold.findFirst({ where: { shipmentId, releasedAt: null }, select: { reason: true, placedAt: true }, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] })
}

/**
 * Inside a command on the shipment: the closed cartons whose "n of N" no longer fits (a carton added or removed) take
 * their place and the new count; their marks are to be printed again.
 */
export async function renumberCartons(tools: Pick<CommandTools, 'tx'>, shipmentId: string): Promise<string[]> {
  const parcels = await tools.tx.parcel.findMany({ where: { shipmentId }, select: PARCEL_SELECT, orderBy: { seq: 'asc' } })
  const moves = renumbered(parcels.map(numberedOf))
  for (const move of moves) {
    await tools.tx.parcel.update({ where: { id: move.id }, data: { cartonNumber: move.cartonNumber, cartonCount: move.cartonCount, marksPrintedAt: null, version: { increment: 1 } }, select: { id: true } })
  }
  return moves.map((move) => move.id)
}

/** The live packaging defaults of a company, each run as positions of its scale's sizes. */
export async function liveDefaults(db: CommandTx, companyId: string): Promise<LiveDefault[]> {
  const rows = await db.packagingDefault.findMany({ where: { companyId, active: true }, select: { id: true, packagingTypeId: true, kind: true, styleId: true, sizeScaleId: true, fromSize: true, toSize: true }, orderBy: { id: 'asc' } })
  const scales = [...new Set(rows.flatMap((row) => (row.sizeScaleId && row.fromSize ? [row.sizeScaleId] : [])))]
  const sizes = scales.length === 0 ? [] : await db.size.findMany({ where: { scaleId: { in: scales } }, select: { scaleId: true, code: true, seq: true } })
  const seqOf = (scaleId: string | null, code: string | null) => (scaleId && code ? (sizes.find((size) => size.scaleId === scaleId && size.code === code)?.seq ?? null) : null)
  return rows.map((row) => ({ id: row.id, packagingTypeId: row.packagingTypeId, kind: row.kind, styleId: row.styleId, sizeScaleId: row.sizeScaleId, fromSeq: seqOf(row.sizeScaleId, row.fromSize), toSeq: seqOf(row.sizeScaleId, row.toSize) }))
}

/** The default carton type of a line's garments (style and size), or null. */
export async function defaultCartonFor(db: CommandTx, companyId: string, line: BenchLine | undefined, defaults?: LiveDefault[]): Promise<string | null> {
  if (!line) return null
  const style = line.workOrderSize.workOrder.style
  const live = defaults ?? (await liveDefaults(db, companyId))
  const size = await db.size.findFirst({ where: { scaleId: style.sizeScaleId, code: line.size }, select: { seq: true } })
  for (const kind of PARCEL_PACKAGING_KINDS) {
    const found = bestDefault(live, kind, { styleId: style.id, sizeScaleId: style.sizeScaleId, sizeSeq: size?.seq ?? null })
    if (found) return found.packagingTypeId
  }
  return null
}

const decimal = (value: Prisma.Decimal | null, places: number): string | null => (value === null ? null : value.toFixed(places))

/** A carton's contents record (LOG-010): style, colour, size, quantity, batch, serials (with when they were packed). */
export function contentsOf(bench: Bench, parcelId: string) {
  return bench.contents
    .filter((content) => content.parcelId === parcelId)
    .map((content) => {
      const line = bench.lines.find((entry) => entry.id === content.shipmentLineId)!
      const style = line.workOrderSize.workOrder.style
      return {
        id: content.id,
        shipmentLineId: line.id,
        cellId: line.workOrderSizeId,
        styleId: style.id,
        styleCode: style.code,
        styleName: style.name,
        colourwayId: line.workOrderSize.colourway.id,
        colourwayCode: line.workOrderSize.colourway.code,
        colourwayName: line.workOrderSize.colourway.name,
        size: content.size,
        quantity: content.quantity,
        workOrderNumber: line.workOrderSize.workOrder.number,
        batchNumber: line.workOrderSize.workOrder.batchNumber,
        originCountry: style.originCountry,
        serials: line.serials.filter((serial) => serial.parcelId === parcelId).map((serial) => ({ id: serial.id, serial: serial.serial, packedAt: serial.packedAt ? toUtcIso(serial.packedAt) : null })),
      }
    })
}

/**
 * What the bench and the office's Cartons read of a shipment: the size grid (ordered against packed), the cartons with
 * their contents, the open carton, the packaging to choose from (no cost) and the suggested one, the hold in force (its
 * reason), what packing still needs.
 */
export async function benchView(db: CommandTx, shipment: ShipmentHeader, given?: Bench) {
  const bench = given ?? (await readBench(db, shipment.id))
  const lines = cartonLinesOf(bench)
  const parcels = cartonParcelsOf(bench)
  const hold = await holdInForce(db, shipment.id)
  const types = await db.packagingType.findMany({ where: { companyId: shipment.companyId, kind: { in: [...PARCEL_PACKAGING_KINDS] } }, select: TYPE_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const typeOf = (id: string | null) => (id === null ? null : (types.find((type) => type.id === id) ?? null))
  const open = openCarton(parcels)
  const forSuggestion = open ? bench.lines.find((line) => line.parcelId === open.id) : bench.lines.find((line) => line.quantity > scannedOf(bench, line.id))
  const count = bench.parcels.length
  const nameOf = (line: CartonLine) => bench.lines.find((entry) => entry.id === line.id)!
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, version: shipment.version, companyId: shipment.companyId, siteId: shipment.siteId },
    hold: hold ? { reason: hold.reason, placedAt: toUtcIso(hold.placedAt) } : null,
    grid: sizeGrid(lines).map((row) => {
      const first = nameOf(lines.find((line) => line.styleId === row.styleId && line.colourwayId === row.colourwayId)!)
      const style = first.workOrderSize.workOrder.style
      const batches = [...new Set(bench.lines.filter((line) => line.workOrderSize.workOrder.style.id === row.styleId && line.workOrderSize.colourway.id === row.colourwayId).flatMap((line) => (line.workOrderSize.workOrder.batchNumber ? [line.workOrderSize.workOrder.batchNumber] : [])))]
      return { ...row, sizes: row.sizes.map((size) => ({ ...size, cellIds: [...size.cellIds] })), styleCode: style.code, styleName: style.name, colourwayCode: first.workOrderSize.colourway.code, colourwayName: first.workOrderSize.colourway.name, batchNumbers: batches }
    }),
    cartons: bench.parcels.map((parcel) => {
      const type = typeOf(parcel.packagingTypeId)
      const contents = contentsOf(bench, parcel.id)
      const gross = decimal(parcel.grossWeightKg, 4)
      return {
        id: parcel.id,
        version: parcel.version,
        seq: parcel.seq,
        closed: parcel.cartonNumber !== null,
        cartonNumber: parcel.cartonNumber,
        cartonCount: parcel.cartonCount,
        marksPrintedAt: parcel.marksPrintedAt ? toUtcIso(parcel.marksPrintedAt) : null,
        marksCurrent: marksCurrent(numberedOf(parcel), count),
        labelled: parcel.trackingNumber !== null || parcel.labelledAt !== null,
        packagingType: type ? { id: type.id, name: type.name, kind: type.kind } : null,
        grossWeightKg: gross,
        netWeightKg: netWeightKg(gross, decimal(type?.tareKg ?? null, 4)),
        lengthCm: decimal(parcel.lengthCm, 2),
        widthCm: decimal(parcel.widthCm, 2),
        heightCm: decimal(parcel.heightCm, 2),
        garments: contents.reduce((sum, content) => sum + content.quantity, 0),
        contents,
      }
    }),
    openCartonId: open?.id ?? null,
    packagingTypes: types
      .filter((type) => type.active)
      .map((type) => ({
        id: type.id,
        name: type.name,
        kind: type.kind,
        innerLengthCm: decimal(type.innerLengthCm, 2),
        innerWidthCm: decimal(type.innerWidthCm, 2),
        innerHeightCm: decimal(type.innerHeightCm, 2),
        tareKg: decimal(type.tareKg, 4),
        maxWeightKg: decimal(type.maxWeightKg, 4),
        palletKind: type.palletKind,
      })),
    suggestedPackagingTypeId: await defaultCartonFor(db, shipment.companyId, forSuggestion),
    problems: benchProblems(
      lines,
      bench.parcels.map((parcel) => ({ ...numberedOf(parcel), hasContents: bench.contents.some((content) => content.parcelId === parcel.id) })),
    ),
  }
}

export type BenchView = Awaited<ReturnType<typeof benchView>>
