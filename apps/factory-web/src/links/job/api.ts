import { z } from 'zod'
import { DECLINE_REASONS, JOB_STATES, type DeclineReason } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'

/**
 * The workshop's job link (apps/factory-api modules/purchasing/portal-jobs/link.ts, B-W2b-176; JOB_ACCEPT on a
 * SubcontractOrder; PLN-163; design links.job, SCR-196): the job on one phone screen (`GET /link/job`: operations, pieces
 * per size, our kit, the day it is due back, our notes — never a price, the purpose holds no grain), and the ONE answer:
 * accept as asked, accept with another due-back day and why, or decline with a reason, each with the typed name. Reading
 * uses nothing; the answer uses the link's one use, so the page shows the end from the answer it gets back. The API's
 * sentences (`stateWords`, `acts.*`, the reasons' `words`, `done`) are read only as "held or not" or left out: the page
 * says everything in its own words (`portal-jobs` › `link.*`). The token travels only in `x-factory-link`.
 */

export { DECLINE_REASONS }
export type { DeclineReason }
export type JobState = (typeof JOB_STATES)[number]

const item = z.object({ code: z.string(), name: z.string() })
const held = z
  .string()
  .nullable()
  .transform((value) => value !== null)

export const linkJobSchema = z.object({
  job: z.object({
    id: z.string(),
    number: z.string(),
    state: z.enum(JOB_STATES),
    from: z.object({ companyName: z.string() }),
    workOrder: z.object({ number: z.string(), style: item }),
    orderDate: z.string(),
    expectedBackDate: z.string().nullable(),
    note: z.string().nullable(),
    answer: z.object({
      acceptedAt: z.string().nullable(),
      acceptedByName: z.string().nullable(),
      proposedDate: z.string().nullable(),
      proposedDateReason: z.string().nullable(),
      declinedAt: z.string().nullable(),
      declinedByName: z.string().nullable(),
      dateDecision: z.object({ decision: z.enum(['ACCEPTED', 'REFUSED']), at: z.string() }).nullable(),
    }),
    operations: z.array(
      z.object({
        id: z.string(),
        seq: z.number(),
        code: z.string(),
        name: z.string(),
        pieces: z.number(),
        sizes: z.array(z.object({ workOrderSizeId: z.string(), colourway: z.string(), size: z.string(), pieces: z.number() })),
        expectedBackDate: z.string().nullable(),
        note: z.string().nullable(),
      }),
    ),
    kit: z.object({
      sentOn: z.array(z.string()),
      lines: z.array(z.object({ seq: z.number(), item, colour: z.string().nullable(), quantity: z.string(), uom: z.string(), status: z.string(), ddt: z.object({ number: z.string(), date: z.string().nullable() }).nullable() })),
    }),
    acts: z.object({ accept: held, decline: held, moveDate: held }),
    version: z.number(),
  }),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number(), live: z.boolean() }),
  portalOn: z.boolean(),
  locale: z.enum(['it', 'en']),
})
export type LinkJobPage = z.infer<typeof linkJobSchema>
export type LinkJob = LinkJobPage['job']

/** `GET /link/job?language=` — the job in the reader's language (nothing is used). */
export const readLinkJob = (api: ApiClient, language: 'it' | 'en', signal?: AbortSignal): Promise<LinkJobPage> => api.get('/link/job', { query: { language }, schema: linkJobSchema, signal })

export type LinkAnswer =
  | { kind: 'accept'; typedName: string | null }
  | { kind: 'move'; typedName: string | null; proposedDate: string; reason: string }
  | { kind: 'decline'; typedName: string | null; reason: DeclineReason; note: string | null }

/** The ONE answer (`POST /link/job/accept | move-date | decline`): the page comes back as it is after the answer. */
export function answerLinkJob(api: ApiClient, version: number, answer: LinkAnswer, language: 'it' | 'en', idempotencyKey = newIdempotencyKey()): Promise<LinkJobPage> {
  const name = answer.typedName ? { typedName: answer.typedName } : {}
  if (answer.kind === 'accept') return api.post('/link/job/accept', { query: { language }, body: { version, ...name }, schema: linkJobSchema, idempotencyKey })
  if (answer.kind === 'move') return api.post('/link/job/move-date', { query: { language }, body: { version, ...name, proposedDate: answer.proposedDate, reason: answer.reason }, schema: linkJobSchema, idempotencyKey })
  return api.post('/link/job/decline', { query: { language }, body: { version, ...name, reason: answer.reason, ...(answer.note ? { note: answer.note } : {}) }, schema: linkJobSchema, idempotencyKey })
}
