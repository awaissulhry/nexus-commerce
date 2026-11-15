import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { COLLECTION_LIMITS, COLLECTION_PARTS, COLLECTION_REFUSALS } from '@nexus/factory-domain/shipping/collection/rules'
import { presignedView } from '../../../platform/files/contract'
import { statusSchema, transportBySchema } from '../views'

/**
 * The customer's own carrier collects (B-W2b-395; LOG-053; design warehouse.shipments Carrier & label "customer collects ex
 * works"). A version is the SHIPMENT's version as read (COL-078). The driver's name is the customer's carrier's person, inside
 * this one shipment. No money.
 */

const allowance = output({ allowed: z.boolean(), refusal: output({ code: z.enum(COLLECTION_REFUSALS), message: z.string() }).nullable() })

const collectionView = output({
  shipment: output({ id: id(), number: z.string(), status: statusSchema, version: z.number().int(), transportBy: transportBySchema, shippedAt: instant().nullable(), deliveredAt: instant().nullable() }),
  /** The customer's own carrier collects (transportBy RECIPIENT). */
  applies: z.boolean(),
  /** The order's Incoterms rule (else the customer's), whether it fits a collection (EXW, FCA) and the warning when not. */
  incoterm: output({
    code: z.string().nullable(),
    place: z.string().nullable(),
    from: z.enum(['ORDER', 'CUSTOMER']).nullable(),
    fits: z.boolean(),
    warning: z.string().nullable(),
  }),
  collectedByName: z.string().nullable(),
  vehiclePlate: z.string().nullable(),
  /** The DDT signed by the driver (a file of the shipment). */
  signature: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int() }).nullable(),
  /** What the goods still need before they leave. */
  missing: z.array(z.enum(COLLECTION_PARTS)),
  ddt: output({ id: id(), number: z.string() }).nullable(),
  may: output({ record: allowance, leave: allowance }),
})

export const getCollectionContract = defineContract({ params: input({ shipmentId: id() }), response: { 200: collectionView } })

export const recordCollectionContract = defineContract({
  params: input({ shipmentId: id() }),
  /** A field left out stays as it is; null clears it. */
  body: input({
    version: z.number().int().min(1).optional(),
    collectedByName: z.string().max(COLLECTION_LIMITS.name * 2).nullish(),
    vehiclePlate: z.string().max(COLLECTION_LIMITS.plate * 2).nullish(),
    signatureFileId: id().nullish(),
  }),
  response: { 200: collectionView },
})

export const downloadSignatureContract = defineContract({
  params: input({ shipmentId: id() }),
  response: { 200: output({ fileId: id(), name: z.string(), download: presignedView }) },
})
