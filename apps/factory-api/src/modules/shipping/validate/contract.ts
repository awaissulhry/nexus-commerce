import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CHECK_CODES } from '@nexus/factory-domain/shipping/validate/rules'
import { statusSchema, transportBySchema } from '../views'

/**
 * The check before printing (B-W2b-390; LOG-045): every parcel without a label against its carrier's rules, each problem with
 * its code (the screens word it; `words` says it in English) and parameters. No money, no person.
 */

export const checkProblemSchema = output({
  code: z.enum(CHECK_CODES),
  /** The parcel's place in the shipment; null: the shipment (addresses, phone, service). */
  parcelSeq: z.number().int().nullable(),
  path: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  words: z.string(),
})

export const checkLabelsContract = defineContract({
  params: input({ shipmentId: id() }),
  response: {
    200: output({
      shipment: output({
        id: id(),
        number: z.string(),
        status: statusSchema,
        transportBy: transportBySchema,
        carrierCode: z.string().nullable(),
        carrierName: z.string().nullable(),
        serviceCode: z.string().nullable(),
      }),
      /** The site is in test mode: a test carrier makes TEST labels and sends nothing (B-W2b-390, LOG-035). */
      testMode: z.boolean(),
      /** A carrier label applies: false for our own van, the customer's collection and a carrier booked by hand. */
      applies: z.boolean(),
      notApplying: z.enum(['OWN_VAN', 'CUSTOMER_COLLECTS', 'MANUAL_CARRIER']).nullable(),
      /** The carrier's limits as kept (starting values, `verified` false; `ruleKept` false: none kept for it). */
      carrier: output({
        code: z.string().nullable(),
        name: z.string(),
        ruleKept: z.boolean(),
        verified: z.literal(false),
        limits: output({
          maxWeightKg: z.string().nullable(),
          maxLengthCm: z.number().nullable(),
          maxLengthPlusGirthCm: z.number().nullable(),
          maxBoxCm: z.array(z.number()).nullable(),
          phone: z.enum(['ALWAYS', 'OUTSIDE_EU']),
        }),
      }),
      /** A label may be bought now: parcels without one and no problem. */
      printable: z.boolean(),
      problems: z.array(checkProblemSchema),
      parcels: z.array(output({ parcelId: id(), seq: z.number().int(), labelled: z.boolean(), ok: z.boolean(), problems: z.array(checkProblemSchema) })),
    }),
  },
})
