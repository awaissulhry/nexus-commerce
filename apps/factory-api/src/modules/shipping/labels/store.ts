import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { cutOffOf, isLabelled, type LabelEnvironment, type LabelFacts, type LabelParcel } from '@nexus/factory-domain/shipping/labels/labels'
import { latestByParcel, type TrackingStatus } from '@nexus/factory-domain/shipping/labels/tracking'
import type { CommandTx } from '../../../core/command'
import { liveDdtOf } from '../ddt/store'
import type { ShipmentHeader } from '../store'

/**
 * The labels part's reads (every read names its columns; one query at a time on a transaction client). A reader takes
 * the command's transaction or a scoped client (`request.withClient`): row-level security decides what it finds (a
 * floor device: its own site's shipments, parcels, files and print jobs).
 */

export const LABEL_PARCEL_SELECT = {
  id: true,
  seq: true,
  version: true,
  grossWeightKg: true,
  lengthCm: true,
  widthCm: true,
  heightCm: true,
  trackingNumber: true,
  carrierParcelId: true,
  labelledAt: true,
} as const satisfies Prisma.ParcelSelect

export type LabelParcelRow = Prisma.ParcelGetPayload<{ select: typeof LABEL_PARCEL_SELECT }>

const decimal = (value: Prisma.Decimal | null, places: number): string | null => (value === null ? null : value.toFixed(places))

export const labelParcelOf = (row: LabelParcelRow): LabelParcel & { readonly labelledAt: Date | null } => ({
  id: row.id,
  seq: row.seq,
  version: row.version,
  grossWeightKg: decimal(row.grossWeightKg, 4),
  lengthCm: decimal(row.lengthCm, 2),
  widthCm: decimal(row.widthCm, 2),
  heightCm: decimal(row.heightCm, 2),
  trackingNumber: row.trackingNumber,
  providerId: row.carrierParcelId,
  labelledAt: row.labelledAt,
})

export const readLabelParcels = (db: CommandTx, shipmentId: string) => db.parcel.findMany({ where: { shipmentId }, select: LABEL_PARCEL_SELECT, orderBy: { seq: 'asc' } })

/**
 * The Sendcloud account of a shipment: the one it names (its labels were bought with it), else its site's (shipping
 * settings), else the company's only one that is not disabled. Null: none.
 */
export async function carrierAccountIdOf(db: CommandTx, shipment: Pick<ShipmentHeader, 'companyId' | 'siteId'> & { integrationAccountId: string | null }, settingsAccountId: string | null): Promise<string | null> {
  if (shipment.integrationAccountId) return shipment.integrationAccountId
  if (settingsAccountId) return settingsAccountId
  const own = await db.integrationAccount.findMany({ where: { provider: 'SENDCLOUD', companyId: shipment.companyId, status: { not: 'DISABLED' } }, select: { id: true }, take: 2 })
  return own.length === 1 ? own[0]!.id : null
}

/**
 * Who the carrier label is addressed to: the shipment's ship-to snapshot; when its address has no name of its own (the
 * customer's seat, one address for everything) the customer's name, as the DDT names the consignee.
 */
async function recipientOf(db: CommandTx, shipment: Pick<ShipmentHeader, 'partyId' | 'shipTo'>): Promise<ShipmentHeader['shipTo']> {
  const shipTo = shipment.shipTo as Record<string, unknown> | null
  if (!shipTo || typeof shipTo !== 'object' || (typeof shipTo.name === 'string' && shipTo.name.trim() !== '')) return shipment.shipTo
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true, tradeName: true } })
  return party ? ({ ...shipTo, name: party.tradeName ?? party.legalName } as ShipmentHeader['shipTo']) : shipment.shipTo
}

/** Everything a buy needs (the office's client or the command's transaction). */
export async function readLabelFacts(db: CommandTx, shipment: ShipmentHeader & { integrationAccountId: string | null }, environment: LabelEnvironment) {
  const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { senderAddress: true, integrationAccountId: true, labelPrinterId: true } })
  const accountId = await carrierAccountIdOf(db, shipment, settings?.integrationAccountId ?? null)
  const account = accountId ? await db.integrationAccount.findUnique({ where: { id: accountId }, select: { id: true, provider: true, companyId: true, mode: true, status: true } }) : null
  const live = await liveDdtOf(db, shipment.id)
  const rows = await readLabelParcels(db, shipment.id)
  const printer = settings?.labelPrinterId ? await db.printer.findUnique({ where: { id: settings.labelPrinterId }, select: { id: true, kind: true, status: true } }) : null
  const parcels = rows.map(labelParcelOf)
  const facts: LabelFacts = {
    shipment: { number: shipment.number, status: shipment.status, transportBy: shipment.transportBy, companyId: shipment.companyId, shipTo: await recipientOf(db, shipment), carrierCode: shipment.carrierCode, serviceCode: shipment.serviceCode },
    sender: settings?.senderAddress ?? null,
    liveDdtNumber: live?.number ?? null,
    parcels,
    account,
    environment,
  }
  return { facts, accountId: account?.id ?? null, labelPrinter: printer, parcels }
}

/** The shipment's Sendcloud account id (office reads; the column is internal). */
export async function shipmentAccountId(db: CommandTx, shipmentId: string): Promise<string | null> {
  const row = await db.shipment.findUnique({ where: { id: shipmentId }, select: { integrationAccountId: true } })
  return row?.integrationAccountId ?? null
}

// ---- the label files and print state of the parcels ---------------------------------------------------------------

/** A label file of a parcel (its current label's: made when the label was recorded). */
export interface LabelFileView {
  readonly fileId: string
  readonly format: 'PDF' | 'ZPL'
  readonly name: string
}

/** The current label files of the parcels: their StoredFiles (recordType Parcel) made at or after their labelledAt. */
export async function labelFilesOf(db: CommandTx, parcels: readonly { readonly id: string; readonly labelledAt: Date | null }[]): Promise<Map<string, LabelFileView[]>> {
  const labelled = parcels.filter((parcel) => parcel.labelledAt !== null)
  const byParcel = new Map<string, LabelFileView[]>()
  if (labelled.length === 0) return byParcel
  const files = await db.storedFile.findMany({
    where: { recordType: 'Parcel', recordId: { in: labelled.map((parcel) => parcel.id) }, status: 'AVAILABLE' },
    select: { id: true, recordId: true, contentType: true, originalName: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const parcel of labelled) {
    byParcel.set(
      parcel.id,
      files
        .filter((file) => file.recordId === parcel.id && file.createdAt.getTime() >= parcel.labelledAt!.getTime())
        .map((file) => ({ fileId: file.id, format: file.contentType === 'application/pdf' ? ('PDF' as const) : ('ZPL' as const), name: file.originalName })),
    )
  }
  return byParcel
}

/** The latest print job of each parcel. */
async function printsOf(db: CommandTx, parcelIds: readonly string[]) {
  if (parcelIds.length === 0) return new Map<string, { jobId: string; status: string; createdAt: string }>()
  const jobs = await db.printJob.findMany({ where: { recordType: 'Parcel', recordId: { in: [...parcelIds] } }, select: { id: true, recordId: true, status: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const latest = new Map<string, { jobId: string; status: string; createdAt: string }>()
  for (const job of jobs) if (!latest.has(job.recordId)) latest.set(job.recordId, { jobId: job.id, status: job.status, createdAt: toUtcIso(job.createdAt) })
  return latest
}

/**
 * What the packers and the office see of a shipment's labels (SCR-067, SCR-098): each parcel, its label (tracking
 * number, files), its latest print job, how many still need a label, and the site's cut-off today.
 */
export async function labelsView(db: CommandTx, shipment: ShipmentHeader, now: Date) {
  const rows = await readLabelParcels(db, shipment.id)
  const files = await labelFilesOf(db, rows)
  const prints = await printsOf(db, rows.map((row) => row.id))
  const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { cutOffTime: true, labelPrinterId: true } })
  const cutOff = cutOffOf(settings?.cutOffTime ?? null, now)
  const parcels = rows.map(labelParcelOf)
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, version: shipment.version, transportBy: shipment.transportBy, carrierCode: shipment.carrierCode, carrierName: shipment.carrierName, serviceCode: shipment.serviceCode },
    labelPrinterId: settings?.labelPrinterId ?? null,
    cutOff: cutOff ? { time: cutOff.time, at: toUtcIso(cutOff.at), passed: cutOff.passed } : null,
    toLabel: parcels.filter((parcel) => !isLabelled(parcel)).length,
    parcels: parcels.map((parcel) => ({
      parcelId: parcel.id,
      seq: parcel.seq,
      version: parcel.version,
      grossWeightKg: parcel.grossWeightKg,
      trackingNumber: parcel.trackingNumber,
      labelledAt: parcel.labelledAt ? toUtcIso(parcel.labelledAt) : null,
      files: files.get(parcel.id) ?? [],
      print: prints.get(parcel.id) ?? null,
    })),
  }
}

export type LabelsView = Awaited<ReturnType<typeof labelsView>>

// ---- tracking ---------------------------------------------------------------------------------------------------------

export const TRACKING_SELECT = {
  id: true,
  parcelId: true,
  status: true,
  carrierStatusCode: true,
  description: true,
  location: true,
  occurredAt: true,
  recordedAt: true,
  source: true,
  externalEventId: true,
} as const satisfies Prisma.TrackingEventSelect

export type TrackingRow = Prisma.TrackingEventGetPayload<{ select: typeof TRACKING_SELECT }>

export const readTracking = (db: CommandTx, shipmentId: string) => db.trackingEvent.findMany({ where: { shipmentId }, select: TRACKING_SELECT, orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }] })

/** The latest status of each parcel. */
export const latestStatuses = (events: readonly TrackingRow[]): Map<string, TrackingRow> => latestByParcel(events)

export const statusMap = (latest: ReadonlyMap<string, TrackingRow>): Map<string, TrackingStatus> => new Map([...latest].map(([parcelId, event]) => [parcelId, event.status]))
