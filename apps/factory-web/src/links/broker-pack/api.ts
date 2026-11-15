import { z } from 'zod'
import { DECLARATION_STATUSES } from '@nexus/factory-domain/shipping/customs/rules'
import type { ApiClient } from '../../lib/api/client'

/**
 * The broker's page by link (B-W2b-409; apps/factory-api modules/shipping/broker-pack/link.ts; SCR-580): the export
 * declaration's papers (the commercial invoice, the packing list, the papers of origin, the declarations of conformity) to
 * download one by one (a presigned address of 60 seconds each), and the MRN typed back once filed. The token stays in the
 * client's `x-factory-link` header.
 */

export const brokerPackPageSchema = z.object({
  companyName: z.string(),
  shipment: z.object({ number: z.string(), country: z.string().nullable() }),
  declaration: z.object({ status: z.enum(DECLARATION_STATUSES), mrn: z.string().nullable() }),
  papers: z.array(z.object({ fileId: z.string(), name: z.string(), sizeBytes: z.number(), available: z.boolean() })),
  link: z.object({ expiresAt: z.string() }),
})
export type BrokerPackPage = z.infer<typeof brokerPackPageSchema>

const downloadSchema = z.object({ fileId: z.string(), name: z.string(), download: z.object({ url: z.string() }) })

export const readBrokerPack = (api: ApiClient): Promise<BrokerPackPage> => api.get('/link/broker-pack', { schema: brokerPackPageSchema })

/** One paper: its address (60 s). */
export const downloadPaper = (api: ApiClient, fileId: string, idempotencyKey: string): Promise<string> =>
  api.post(`/link/broker-pack/files/${encodeURIComponent(fileId)}/download`, { body: {}, schema: downloadSchema, idempotencyKey }).then((answer) => answer.download.url)

/** The MRN typed back (once): the page as it is after. */
export const sendMrn = (api: ApiClient, mrn: string, idempotencyKey: string): Promise<BrokerPackPage> => api.post('/link/broker-pack/mrn', { body: { mrn }, schema: brokerPackPageSchema, idempotencyKey })
