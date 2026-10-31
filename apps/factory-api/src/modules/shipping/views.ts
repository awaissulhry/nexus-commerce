import { z } from 'zod'
import { id, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { TRANSPORT_EVIDENCE_STATUSES } from '@nexus/factory-domain/shipping/evidence/evidence'
import { SHIPMENT_STATUSES, TRANSPORT_BY } from '@nexus/factory-domain/shipping/shipments'
import { FREIGHT_BASES } from '@nexus/factory-domain/shipping/shipments/freight'
import { TRANSPORT_MODES } from '@nexus/factory-domain/shipping/shipments/transport'

/**
 * The answers' shapes the office and packing routes share. No money in what packers see; the office's shipment carries
 * one price since B-W2a-48 (the freight charged, money.price: dropped for a reader without the price grain) and one cost
 * since B-W2b-19 (the carrier's freight cost, money.cost).
 */

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

/** The freight of a shipment (B-W2a-48): the charge, whether the office typed it, and what the site's rule gives now. */
export const freightSchema = output({
  /** null: not decided yet (the rule's is set when the goods leave). */
  charge: money.price(z.number().int().nullable()),
  currency: z.string(),
  byHand: z.boolean(),
  byRule: output({ charge: money.price(z.number().int().nullable()), basis: z.enum(FREIGHT_BASES), words: z.string() }),
  /** B-W2b-19: what the carrier charged us (its invoice; money.cost, dropped without the grain), null until recorded. */
  cost: notMoney(output({ amount: money.cost(z.number().int().nullable()), currency: z.string().nullable() })),
})

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
  /** B-W2a-48 (LOG-105): the freight charged to the customer, in the order's currency (minor units). */
  freight: freightSchema,
  /** B-W2a-48 (LOG-090): the intra-EU transport evidence's state (GET …/evidence has the papers). */
  transportEvidence: output({ status: z.enum(TRANSPORT_EVIDENCE_STATUSES), completedAt: instant().nullable() }),
  /** B-W2b-19 (Intrastat): the mode of transport the office recorded; null: not recorded. */
  transportMode: z.enum(TRANSPORT_MODES).nullable(),
})

export const oneShipment = output({ shipment: shipmentSchema })
