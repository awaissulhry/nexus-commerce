import { z } from 'zod'
import { APPROVAL_KINDS, APPROVAL_STATUSES, type ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * F-PR-09 — Decide for the customer and Reverse its answer (apps/factory-api platform/approvals-out override.ts, B-PR-30a/30b;
 * production plan §3 "Decide for a brand, undo — production.brand.override, step-up; a second person when the brand's switch is
 * on"): every call of the office's customer-override part, each answer checked with zod (unknown fields dropped).
 *
 *   GET  /approvals-out/:requestId                    one request as the office reads it: who decided it for the customer and why,
 *                                                     its reversal, an override waiting for a second person, what the reader `may`
 *   GET  /approvals-out?recordType&recordId           the requests of one record, newest first (a gate's sample round)
 *   POST /approvals-out/:requestId/decide-for-party   {version, decision, answer?, typedName, reason} → DONE or SECOND_PERSON
 *   POST /approvals-out/:requestId/reverse            {version, reason} → what it did to the record, a new date's link ONCE
 *
 * Another customer's request answers 404 like an unknown id (the brand wall); the screens say it in neutral words. The API's
 * English (a refusal's message) is never shown: the part says its own words from the refusal's code (`refusal/<CODE>`).
 */

const words = z.object({ it: z.string(), en: z.string() })
const enc = encodeURIComponent

export const overrideRequestSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  record: z.object({ type: z.string(), id: z.string(), words }),
  party: z.object({ id: z.string(), name: z.string() }),
  question: z.string(),
  dueAt: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  answer: z
    .object({
      at: z.string(),
      typedName: z.string(),
      words: z.string().nullable(),
      /** OFFICE: decided by us for the customer (B-PR-30a). */
      via: z.enum(['LINK', 'PORTAL', 'OFFICE']),
      personName: z.string().nullable(),
    })
    .nullable(),
  /** Decided by us for the customer: who of us (office only) and why (the customer reads it). */
  decidedForParty: z.object({ byName: z.string().nullable(), reason: z.string() }).nullable(),
  /** The customer's answer reversed: when, who of us, why (the customer reads it). */
  reversed: z.object({ at: z.string(), byName: z.string().nullable(), reason: z.string() }).nullable(),
  /** An override that waits for a second person: its task in Home › Approvals. */
  override: z.object({ taskId: z.string(), act: z.enum(['DECIDE_FOR', 'REVERSE']) }).nullable(),
  askedBy: z.string().nullable(),
  /** What the reader may do (production.brand.override over the request's company and customer; never the person who asked). */
  may: z.object({ withdraw: z.boolean(), decideForParty: z.boolean(), reverse: z.boolean() }),
  version: z.number(),
})
export type OverrideRequest = z.infer<typeof overrideRequestSchema>

/** One request as the office reads it. */
export function readOverrideRequest(api: ApiClient, requestId: string, signal?: AbortSignal): Promise<OverrideRequest> {
  return api.get(`/approvals-out/${enc(requestId)}`, { schema: z.object({ request: overrideRequestSchema }), signal }).then((answer) => answer.request)
}

/** The requests of one record, newest first (only that record's: the API reads them in the reader's scope). */
export function readRecordRequests(api: ApiClient, record: { readonly type: string; readonly id: string }, signal?: AbortSignal): Promise<OverrideRequest[]> {
  return api.get('/approvals-out', { query: { recordType: record.type, recordId: record.id }, schema: z.object({ requests: z.array(overrideRequestSchema) }), signal }).then((answer) => answer.requests)
}

/** Done at once, or waiting for a second person (the customer's switch on its limits card): its task. */
const outcomeSchema = z.object({ outcome: z.enum(['DONE', 'SECOND_PERSON']), taskId: z.string().nullable(), words: words.nullable() })

export const decideForAnswerSchema = z.object({ request: overrideRequestSchema, override: outcomeSchema })
export type DecideForAnswer = z.infer<typeof decideForAnswerSchema>

export interface DecideForBody {
  readonly version: number
  readonly decision: ApprovalDecision
  /** What should change, or why it is refused (the customer reads it); left out for a plain approval. */
  readonly answer?: string
  /** The office person's typed name (the customer reads our company's name, never who of us). */
  readonly typedName: string
  /** Why we decide for the customer ("Decided by us for you: …"). */
  readonly reason: string
}

export function decideForParty(api: ApiClient, requestId: string, body: DecideForBody, idempotencyKey: string = newIdempotencyKey()): Promise<DecideForAnswer> {
  return api.post(`/approvals-out/${enc(requestId)}/decide-for-party`, { body, schema: decideForAnswerSchema, idempotencyKey })
}

export const reverseAnswerSchema = z.object({
  request: overrideRequestSchema,
  override: outcomeSchema,
  /** What it did to the record (codes; none while a second person grants it). Read as text: a new effect never breaks the page. */
  effects: z.array(z.string()),
  /** A new date asked again: the new request, its link ONCE for a customer without a portal. */
  asked: z.object({ requestId: z.string(), url: z.string().nullable() }).nullable(),
})
export type ReverseAnswer = z.infer<typeof reverseAnswerSchema>

export function reverseAnswer(api: ApiClient, requestId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string = newIdempotencyKey()): Promise<ReverseAnswer> {
  return api.post(`/approvals-out/${enc(requestId)}/reverse`, { body, schema: reverseAnswerSchema, idempotencyKey })
}

/** The fresh authenticator code both acts ask for (5 minutes on this session). */
export function stepUpWith(api: ApiClient, code: string): Promise<unknown> {
  return api.post('/auth/office/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })
}
