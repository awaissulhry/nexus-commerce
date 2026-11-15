import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BROKER_PACK_REFUSALS, ORIGIN_FILES_MAX, PACK_PART_STATES, PACK_PARTS } from '@nexus/factory-domain/shipping/broker-pack/rules'
import { DECLARATION_STATUSES } from '@nexus/factory-domain/shipping/customs/rules'

/**
 * The document pack for the broker (B-W2b-409; LOG-097, LOG-088; the broker's page by link). Codes and words; no amount.
 */

const shipmentParams = input({ shipmentId: id() })
/** The papers of origin to add: files of the shipment, comma-separated ids. */
const originQuery = input({ originFileIds: z.string().max(400).optional() })

const fileView = output({ fileId: id(), name: z.string(), sizeBytes: z.number().int() })

export const packContract = defineContract({
  params: shipmentParams,
  querystring: originQuery,
  response: {
    200: output({
      shipment: output({ id: id(), number: z.string() }),
      parts: z.array(output({ part: z.enum(PACK_PARTS), state: z.enum(PACK_PART_STATES), words: z.string().nullable(), files: z.array(fileView) })),
      originCandidates: z.array(fileView.extend({ createdAt: instant() })),
      downloadHeld: z.enum(BROKER_PACK_REFUSALS).nullable(),
      linkHeld: z.enum(BROKER_PACK_REFUSALS).nullable(),
      linkWords: z.string().nullable(),
      brokerPackOn: z.boolean(),
    }),
  },
})

export const packPdfContract = defineContract({ params: shipmentParams, querystring: originQuery, response: {} })

export const packLinkContract = defineContract({
  params: shipmentParams,
  body: input({
    originFileIds: z.array(id()).max(ORIGIN_FILES_MAX).optional(),
    /** Mail it to the broker's contacts (default) or one link to pass on (false). */
    send: z.boolean().optional(),
    contactIds: z.array(id()).min(1).max(20).optional(),
  }),
  /** `url`: the link to pass on, in this answer only. */
  response: { 201: output({ url: z.string().nullable(), linkId: id() }) },
})

const pageSchema = output({
  companyName: z.string(),
  shipment: output({ number: z.string(), country: z.string().nullable() }),
  declaration: output({ status: z.enum(DECLARATION_STATUSES), mrn: z.string().nullable() }),
  papers: z.array(fileView.extend({ available: z.boolean() })),
  link: output({ expiresAt: instant() }),
})

export const brokerPageContract = defineContract({ response: { 200: pageSchema } })

export const brokerDownloadContract = defineContract({
  params: input({ fileId: id() }),
  body: input({}).optional(),
  response: { 200: output({ fileId: id(), name: z.string(), download: output({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }) }) },
})

export const brokerMrnContract = defineContract({ body: input({ mrn: z.string().trim().min(1).max(40) }), response: { 200: pageSchema } })
