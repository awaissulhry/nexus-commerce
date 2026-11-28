import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * owb-of7 step 1 — the Design desk's reads and its two floor acts, with this web's own zod (a field the server adds later is ignored):
 *  - `GET /design-desk` (owb-of2 step 4, Shape FIXED): Asked · Waits for approval · Scan codes (`codes: null` until S3's placements) ·
 *    From the floor — each list only orders the reader may see (the designer: the orders he is on); no price, ever.
 *  - the floor's asks to the designer: "I take it" = today's `POST /production/calls/:callId/on-the-way` (S5's takeAsk) · "Done — tell
 *    the worker" = today's `POST /production/calls/:callId/solve` with `resolutionCode: 'ANSWERED'` and the words the worker reads
 *    (S5's answerAsk, owb-fl3 notes; production.calls.answer). Never a call written another way.
 */

const pictureSchema = z.object({ fileId: z.string(), contentType: z.string(), small: z.boolean() })

export const deskSchema = z.object({
  asked: z.array(
    z.object({
      kind: z.enum(['ORDER', 'REQUEST']),
      id: z.string(),
      number: z.string().nullable(),
      subject: z.string().nullable(),
      party: z.object({ code: z.string(), name: z.string() }),
      why: z.enum(['HELP_ASKED', 'GIVEN', 'ON_IT', 'CONFIRMED']).catch('ON_IT'),
      since: z.string(),
      picture: pictureSchema.nullable(),
    }),
  ),
  approvals: z.array(z.object({ approvalId: z.string(), orderId: z.string(), number: z.string(), subject: z.string().nullable(), kind: z.enum(['PROOF', 'ARTWORK']), sentAt: z.string(), state: z.string() })),
  codes: z.array(z.object({ orderId: z.string(), number: z.string(), subject: z.string().nullable(), placed: z.number(), pages: z.number() })).nullable(),
  floor: z.array(z.object({ callId: z.string(), orderNumber: z.string().nullable(), what: z.string(), since: z.string(), state: z.enum(['ASKED', 'TAKEN']) })),
})
export type DeskRead = z.infer<typeof deskSchema>

export const readDesk = (api: ApiClient, signal?: AbortSignal): Promise<DeskRead> => api.get('/design-desk', { schema: deskSchema, signal })

/** "I take it": the ask is on its way (the worker sees that the designer took it). */
export const takeAsk = (api: ApiClient, callId: string, idempotencyKey: string = newIdempotencyKey()): Promise<unknown> =>
  api.post(`/production/calls/${encodeURIComponent(callId)}/on-the-way`, { body: {}, idempotencyKey })

/** "Done — tell the worker": the ask is answered; the words are what the worker reads ("An answer for you"). */
export const answerAsk = (api: ApiClient, callId: string, words: string, idempotencyKey: string = newIdempotencyKey()): Promise<unknown> =>
  api.post(`/production/calls/${encodeURIComponent(callId)}/solve`, { body: { resolutionCode: 'ANSWERED', ...(words.trim() ? { resolutionNote: words.trim() } : {}) }, idempotencyKey })
