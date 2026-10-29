import { z } from 'zod'
import { id, instant, output } from '@nexus/factory-domain/core/contracts'
import { SHIPMENT_STATUSES, TRANSPORT_BY } from '@nexus/factory-domain/shipping/shipments'

/** The answers' shapes the office and packing routes share (no money anywhere: a shipment carries none). */

export const lineSchema = output({
  id: id(),
  version: z.number().int(),
  parcelId: id().nullable(),
  workOrderId: id(),
  workOrderNumber: z.string(),
  batchNumber: z.string().nullable(),
  workOrderSizeId: id(),
  salesOrderLineId: id(),
  styleId: id(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayId: id(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number().int(),
  /** The style traces each garment by serial (Q31 (b)): packed serials are listed. */
  serialTracked: z.boolean(),
  serials: z.array(output({ id: id(), serial: z.string() })),
})

export const parcelSchema = output({
  id: id(),
  version: z.number().int(),
  seq: z.number().int(),
  grossWeightKg: z.string().nullable(),
  lengthCm: z.string().nullable(),
  widthCm: z.string().nullable(),
  heightCm: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelledAt: instant().nullable(),
  garments: z.number().int(),
})

/** What every packer sees: the lines, the parcels, the garments and what packing still needs (PLT-097). */
export const contentsSchema = {
  lines: z.array(lineSchema),
  parcels: z.array(parcelSchema),
  garments: z.number().int(),
  packingProblems: z.array(z.string()),
}

export const statusSchema = z.enum(SHIPMENT_STATUSES)
export const transportBySchema = z.enum(TRANSPORT_BY)

/** The office's shipment: header, order and party, and its contents. */
export const shipmentSchema = output({
  id: id(),
  number: z.string(),
  status: statusSchema,
  version: z.number().int(),
  companyId: id(),
  siteId: id(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  salesOrderId: id(),
  salesOrder: output({ number: z.string(), customerRef: z.string().nullable(), status: z.string() }),
  shipToAddressId: id().nullable(),
  shipTo: z.record(z.string(), z.unknown()),
  transportBy: transportBySchema,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  serviceCode: z.string().nullable(),
  carrierShipmentId: z.string().nullable(),
  ddtRequired: z.boolean(),
  packedAt: instant().nullable(),
  shippedAt: instant().nullable(),
  deliveredAt: instant().nullable(),
  returnedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  internalNote: z.string().nullable(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
  ...contentsSchema,
})

export const oneShipment = output({ shipment: shipmentSchema })
