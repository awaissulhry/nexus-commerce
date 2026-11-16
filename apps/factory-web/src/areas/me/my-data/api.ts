import { z } from 'zod'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES } from '@nexus/factory-domain/privacy/retention/requests'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Download my data (B-W2b-414 on B-W2b-405's API; PLT-202; GDPR arts. 15, 20; design shell.profile h.more "Download my data"):
 * any office person asks for their own package (the session proves who asks), the worker collects it, and the first download
 * hands it over. The company is the screen's (`x-factory-company`, sent by the office client).
 */

const mine = z.object({
  id: z.string(),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  kind: z.enum(DATA_REQUEST_KINDS),
  status: z.enum(DATA_REQUEST_STATUSES),
  receivedAt: z.string(),
  dueAt: z.string(),
  // B-W2b-GF1 (G274): `deleteAfter`, when the copy is deleted (30 days after it was made).
  package: z.object({ fileId: z.string(), name: z.string(), sizeBytes: z.number(), madeAt: z.string().nullable(), deleteAfter: z.string().nullable().optional() }).nullable(),
  collect: z.object({ state: z.enum(['NONE', 'RUNNING', 'READY', 'FAILED']), at: z.string().nullable() }).nullable(),
})
export type MyRequest = z.infer<typeof mine>

const answer = z.object({ requests: z.array(mine), mayAsk: z.boolean(), companyId: z.string().nullable() })
export type MyData = z.infer<typeof answer>

/** My requests (newest first, at most 20), whether I may ask now, the company the request would be kept by. */
export const myData = (api: ApiClient, signal?: AbortSignal): Promise<MyData> => api.get('/privacy/my-data', { schema: answer, signal })

/** Ask for my package (202; one open at a time: 409). */
export const askMyData = (api: ApiClient, idempotencyKey?: string): Promise<MyData & { requestId: string }> =>
  api.post('/privacy/my-data', { body: {}, schema: answer.extend({ requestId: z.string() }), idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

/** A link to my package for 60 seconds; the first download closes the request (handed over). */
export const myPackageLink = (api: ApiClient, requestId: string): Promise<string> =>
  api.get(`/privacy/my-data/${encodeURIComponent(requestId)}/package`, { schema: z.object({ download: z.object({ url: z.string() }) }) }).then((reply) => reply.download.url)
