import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'
import { MANUAL_EVENT_STATUSES, OWN_TRANSPORT_LIMITS, OWN_TRANSPORT_MODES, OWN_TRANSPORT_REFUSALS, TRANSPORT_ARRANGEMENTS } from '@nexus/factory-domain/shipping/own-transport/rules'
import { statusSchema, transportBySchema } from '../views'

/**
 * A manual carrier or our own van (B-W2b-390; LOG-122). A version is the SHIPMENT's version as read (COL-078). No money.
 * `typedById` is the office person who typed a status, inside this one shipment.
 */

const version = z.number().int().min(1).optional()
const shipmentParams = input({ shipmentId: id() })
const allowance = output({ allowed: z.boolean(), refusal: output({ code: z.enum(OWN_TRANSPORT_REFUSALS), message: z.string() }).nullable() })

const transportView = output({
  shipment: output({
    id: id(),
    number: z.string(),
    status: statusSchema,
    version: z.number().int(),
    transportBy: transportBySchema,
    carrierCode: z.string().nullable(),
    carrierName: z.string().nullable(),
    serviceCode: z.string().nullable(),
    /** The tracking number typed for a carrier booked by hand; null: none. */
    manualTrackingNumber: z.string().nullable(),
    ddtRequired: z.boolean(),
    shippedAt: instant().nullable(),
    deliveredAt: instant().nullable(),
    returnedAt: instant().nullable(),
  }),
  /** CARRIER (labels through Sendcloud, or booked by hand without a number yet), MANUAL_CARRIER, OWN_VAN, CUSTOMER_COLLECTS. */
  arrangement: z.enum(TRANSPORT_ARRANGEMENTS),
  /** The live DDT (W1: it works for our own van and a manual carrier); null: none issued. */
  ddt: output({ id: id(), number: z.string() }).nullable(),
  /** Parcels with a carrier label, and with a TEST label (test mode). */
  labels: output({ carrier: z.number().int(), test: z.number().int() }),
  /** What may change now; each refusal in words. */
  may: output({ arrange: allowance, track: allowance, status: allowance }),
  /** The statuses typed so far (newest first). */
  events: z.array(
    output({
      id: id(),
      status: z.enum(TRACKING_STATUSES),
      description: z.string().nullable(),
      location: z.string().nullable(),
      occurredAt: instant(),
      recordedAt: instant(),
      typedById: id().nullable(),
    }),
  ),
})

const text = (max: number) => z.string().max(max)

export const getOwnTransportContract = defineContract({ params: shipmentParams, response: { 200: transportView } })

export const arrangeTransportContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    mode: z.enum(OWN_TRANSPORT_MODES),
    carrierName: text(OWN_TRANSPORT_LIMITS.carrierName * 2).nullish(),
    carrierCode: text(64).nullish(),
    trackingNumber: text(OWN_TRANSPORT_LIMITS.trackingNumber * 2).nullish(),
  }),
  response: { 200: transportView },
})

export const typeTrackingNumberContract = defineContract({
  params: shipmentParams,
  body: input({ version, trackingNumber: text(OWN_TRANSPORT_LIMITS.trackingNumber * 2).nullable() }),
  response: { 200: transportView },
})

export const typeStatusContract = defineContract({
  params: shipmentParams,
  body: input({
    version,
    status: z.enum(MANUAL_EVENT_STATUSES),
    /** When it happened (default now): not in the future, not before the goods left. */
    occurredAt: instant().optional(),
    description: text(OWN_TRANSPORT_LIMITS.description).nullish(),
    location: text(OWN_TRANSPORT_LIMITS.location).nullish(),
  }),
  response: { 201: output({ ...transportView.shape, recorded: output({ eventId: id(), moved: z.enum(['DELIVERED', 'RETURNED']).nullable() }) }) },
})
