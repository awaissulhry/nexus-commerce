import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { postalAddressOf } from '@nexus/factory-domain/shipping/ddt'
import { LEG_WORDS, legRefusalPath, warehouseShipTo, type LabelFileFacts, type LegRefusalCode } from '@nexus/factory-domain/shipping/warehouse-leg/rules'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * Our warehouse first (owb- order workflow, S3 ss1; rules factory-domain shipping/warehouse-leg): the reads of a shipment's leg
 * (factory-db ShipmentWarehouseLeg, one per shipment) and the in-command write that plans it with its DRAFT. Every read names its
 * columns; a reader takes a command's transaction or a scoped client (row-level security decides what it finds).
 */

type Reader = FactoryClient | CommandTx

export const LEG_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  shipmentId: true,
  warehouseSiteId: true,
  arrivedAt: true,
  forwardedAt: true,
  forwardedWithoutLabel: true,
  customerLabelFileId: true,
  customerLabelAt: true,
  version: true,
} as const satisfies Prisma.ShipmentWarehouseLegSelect

export type LegRow = Prisma.ShipmentWarehouseLegGetPayload<{ select: typeof LEG_SELECT }>

/** The shipment's leg through our warehouse, or null (none: it goes straight to the customer). */
export async function legOf(db: Reader, shipmentId: string): Promise<LegRow | null> {
  if (!isUuid(shipmentId)) return null
  return db.shipmentWarehouseLeg.findFirst({ where: { shipmentId }, select: LEG_SELECT })
}

/** The legs of these shipments, by shipment. */
export async function legsOf(db: Reader, shipmentIds: readonly string[]): Promise<Map<string, LegRow>> {
  const ids = shipmentIds.filter(isUuid)
  if (ids.length === 0) return new Map()
  const rows = await db.shipmentWarehouseLeg.findMany({ where: { shipmentId: { in: ids } }, select: LEG_SELECT })
  return new Map(rows.map((row) => [row.shipmentId, row]))
}

/** A refusal of the leg: 409 `refusal/<CODE>` in the words of `locale` (the office answers in English). */
export function refusedLeg(code: LegRefusalCode, locale: 'en' | 'it' = 'en'): never {
  const message = LEG_WORDS[code][locale]
  throw new DomainError('conflict', message, [{ path: legRefusalPath(code), message }])
}

/** The first refusal of a list, if any. */
export function refuseFirst(codes: readonly LegRefusalCode[], locale: 'en' | 'it' = 'en'): void {
  if (codes.length > 0) refusedLeg(codes[0]!, locale)
}

/** A refusal of a field of the plan (400 at the field, in words). */
const fieldRefusal = (code: LegRefusalCode, path: string): ValidationError => new ValidationError(LEG_WORDS[code].en, [{ path, message: LEG_WORDS[code].en }])

/**
 * The warehouse a new shipment goes to first (POST /shipping/shipments, destination OUR_WAREHOUSE): an ACTIVE WAREHOUSE site of the
 * order's company with a complete address, not the site the goods leave from; and the order's customer has a complete delivery
 * address to send the goods on to. The answer: the ship-to snapshot of the warehouse (SalesOrder.shipTo's shape).
 */
export async function warehouseDestinationOf(
  db: Reader,
  input: { readonly warehouseSiteId: string; readonly companyId: string; readonly fromSiteId: string; readonly customerShipTo: unknown; readonly shipToAddressId?: string | undefined },
): Promise<{ readonly warehouseSiteId: string; readonly shipTo: Record<string, string> }> {
  if (input.shipToAddressId !== undefined) throw fieldRefusal('ADDRESS_WITH_WAREHOUSE', 'body/shipToAddressId')
  const site = isUuid(input.warehouseSiteId) ? await db.site.findUnique({ where: { id: input.warehouseSiteId }, select: { id: true, companyId: true, kind: true, status: true, name: true, address: true } }) : null
  if (!site || site.companyId !== input.companyId || site.kind !== 'WAREHOUSE' || site.status !== 'ACTIVE') throw fieldRefusal('NOT_OUR_WAREHOUSE', 'body/destination/siteId')
  if (site.id === input.fromSiteId) throw fieldRefusal('SAME_SITE', 'body/destination/siteId')
  const shipTo = warehouseShipTo(site)
  if (!shipTo) throw fieldRefusal('WAREHOUSE_NO_ADDRESS', 'body/destination/siteId')
  if (postalAddressOf(input.customerShipTo) === null) refusedLeg('NO_CUSTOMER_ADDRESS')
  return { warehouseSiteId: site.id, shipTo }
}

/** Inside the command that makes the DRAFT (or a split's child that keeps the parent's warehouse): its leg, not arrived, at version 1. */
export async function planLegInCommand(tools: Pick<CommandTools, 'tx' | 'context'>, shipment: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly partyId: string }, warehouseSiteId: string): Promise<string> {
  const id = newId()
  await tools.tx.shipmentWarehouseLeg.create({
    data: {
      id,
      companyId: shipment.companyId,
      siteId: shipment.siteId,
      partyId: shipment.partyId,
      shipmentId: shipment.id,
      warehouseSiteId,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: { id: true },
  })
  return id
}

/** The file named as the customer's label, as the rules read it (null: not found in the reader's scope). */
export async function labelFileOf(db: Reader, fileId: string): Promise<(LabelFileFacts & { readonly id: string }) | null> {
  if (!isUuid(fileId)) return null
  const row = await db.storedFile.findUnique({ where: { id: fileId }, select: { id: true, recordType: true, recordId: true, status: true, kind: true, contentType: true, category: true, partyId: true, createdById: true } })
  if (!row) return null
  return { id: row.id, recordType: row.recordType, recordId: row.recordId, status: row.status, kind: row.kind, contentType: row.contentType, category: row.category ?? null, partyId: row.partyId, byOffice: row.createdById !== null }
}

/** Whether each label was sent by the customer (its file uploaded through the portal: no office person made it). */
export async function labelsByCustomer(db: Reader, fileIds: readonly string[]): Promise<Map<string, boolean>> {
  const ids = fileIds.filter(isUuid)
  if (ids.length === 0) return new Map()
  const rows = await db.storedFile.findMany({ where: { id: { in: ids } }, select: { id: true, createdById: true } })
  return new Map(rows.map((row) => [row.id, row.createdById === null]))
}

/** A not-found of the order in the caller's scope (the same words as an unknown id). */
export const orderNotFound = (): NotFoundError => new NotFoundError('Sales order not found.')
