import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_JOB_KINDS, REPRINT_MAX_JOBS, REPRINT_REFUSALS } from '@nexus/factory-domain/shipping/reprint/rules'

/** Reprint a label with a reason (B-W2b-391; LOG-027). No money, no address, no party. */

const refusal = output({ code: z.enum(REPRINT_REFUSALS), message: z.string() })

/** Who asked for a print: an office user by name; on the floor the device, and the worker only where the site's gate lets the office read names. */
const requester = output({
  by: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
  name: z.string().nullable(),
  device: z.string().nullable(),
  /** A worker asked and the site's gate keeps the name back (the office read), or the reader is a floor device. */
  hidden: z.boolean(),
})

const labelJob = output({
  jobId: id(),
  kind: z.enum(LABEL_JOB_KINDS),
  scanId: z.string().nullable(),
  status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']),
  printer: output({ id: id(), code: z.string(), name: z.string() }),
  copies: z.number().int(),
  createdAt: instant(),
  /** The job it prints again, and why (a reprint). */
  reprintOfId: id().nullable(),
  reason: z.string().nullable(),
  requestedBy: requester,
  /** It may be printed again now; else why not. */
  reprintable: z.boolean(),
  refusal: refusal.nullable(),
})

export const labelJobsContract = defineContract({
  params: input({ shipmentId: id() }),
  response: {
    200: output({
      shipmentId: id(),
      number: z.string(),
      status: z.string(),
      /** Each parcel's label jobs, oldest first (its carrier label and its carton's marks, and their reprints). */
      parcels: z.array(output({ parcelId: id(), seq: z.number().int(), trackingNumber: z.string().nullable(), jobs: z.array(labelJob) })),
    }),
  },
})

export const reprintContract = defineContract({
  params: input({ shipmentId: id() }),
  body: input({
    /** The label jobs to print again (of this shipment's parcels). */
    jobIds: z.array(id()).min(1).max(REPRINT_MAX_JOBS),
    /** Why, in a person's words (3 to 200 characters on one line). */
    reason: z.string().max(400),
    /** A label printer of the shipment's site; default each job's own printer, else the site's label printer. */
    printerId: id().optional(),
    /** Default each job's own copies. */
    copies: z.number().int().min(1).max(50).optional(),
  }),
  response: {
    201: output({
      shipmentId: id(),
      number: z.string(),
      reason: z.string(),
      jobs: z.array(output({ jobId: id(), reprintOfId: id(), parcelId: id(), seq: z.number().int(), kind: z.enum(LABEL_JOB_KINDS), printerId: id(), status: z.literal('QUEUED') })),
    }),
  },
})
