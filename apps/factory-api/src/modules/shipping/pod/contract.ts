import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DELIVERED_VIAS, POD_LIMITS } from '@nexus/factory-domain/shipping/pod/rules'

/**
 * The proof of delivery on the shipment (B-W2b-398; LOG-065; design warehouse.shipments Tracking & delivery › Proof of
 * delivery). The signer is the customer's person, inside this one record. No money.
 */

const podSchema = output({
  shipment: output({ id: id(), number: z.string(), status: z.string(), shippedAt: instant().nullable(), version: z.number().int() }),
  deliveredAt: instant().nullable(),
  deliveredVia: z.enum(DELIVERED_VIAS).nullable(),
  pod: output({
    signedBy: z.string().nullable(),
    signedAt: instant().nullable(),
    file: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int() }).nullable(),
  }).nullable(),
  carrierAsked: z.boolean(),
  recordHeld: z.enum(['NOT_DELIVERED', 'KEPT', 'NO_RIGHT']).nullable(),
  signerMax: z.number().int(),
})

export const getPodContract = defineContract({
  params: input({ shipmentId: id() }),
  response: { 200: podSchema },
})

export const recordPodContract = defineContract({
  params: input({ shipmentId: id() }),
  /** Each part is set once; a part already kept may be sent again unchanged. The image: a file of the shipment, uploaded first. */
  body: input({
    version: z.number().int().min(1).optional(),
    signedBy: z.string().max(POD_LIMITS.signer + 50).nullable().optional(),
    signedAt: instant().nullable().optional(),
    fileId: id().nullable().optional(),
  }),
  response: { 200: podSchema },
})

export const downloadPodContract = defineContract({
  params: input({ shipmentId: id() }),
  response: {
    200: output({
      fileId: id(),
      name: z.string(),
      download: output({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})
