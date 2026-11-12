import { z } from 'zod'
import { ANSWER_VIAS, ESTIMATE_ACTIONS, ESTIMATE_ANSWERS, ESTIMATE_LINE_KINDS, ESTIMATE_STATUSES } from '@nexus/factory-domain/sales/repairs-depth/rules'
import { REPAIR_STAGES } from '@nexus/factory-domain/sales/repairs/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Every call of a repair's Estimate tab (B-W2b-352 on B-W2b-342's `modules/sales/repairs-depth`): the revisions of the
 * estimate, a new revision (a sent one replaced on purpose), its terms, its lines (each write at the estimate's version;
 * the API computes the amounts), send, the customer's answer as the office heard it, withdraw. Each answer is the whole
 * tab again, checked with a zod shape that mirrors the API's contract (unknown fields dropped). Prices are the price grain,
 * our costs the cost grain: absent for a reader without them. The API's English `held` words are read but never shown.
 */

export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number]
export type EstimateLineKind = (typeof ESTIMATE_LINE_KINDS)[number]
type EstimateAnswer = (typeof ESTIMATE_ANSWERS)[number]
export type EstimateAction = (typeof ESTIMATE_ACTIONS)[number]

const seg = (value: string) => encodeURIComponent(value)

const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(ESTIMATE_LINE_KINDS),
  item: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  description: z.string(),
  quantity: z.string(),
  minutes: z.number().nullable(),
  /** Price grain. */
  unitPrice: z.string().optional(),
  amount: z.number().optional(),
  /** Cost grain. */
  unitCost: z.string().nullable().optional(),
  costAmount: z.number().nullable().optional(),
  version: z.number(),
})
export type EstimateLine = z.infer<typeof lineSchema>

const estimateSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.enum(ESTIMATE_STATUSES),
  currency: z.string(),
  validUntil: z.string().nullable(),
  customerNote: z.string().nullable(),
  internalNote: z.string().nullable(),
  sentAt: z.string().nullable(),
  sentById: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredVia: z.enum(ANSWER_VIAS).nullable(),
  answeredByName: z.string().nullable(),
  recordedById: z.string().nullable(),
  declineReason: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawnById: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  lines: z.array(lineSchema),
  summary: z.object({
    amount: z.number().optional(),
    partsAmount: z.number().optional(),
    labourAmount: z.number().optional(),
    costAmount: z.number().nullable().optional(),
    labourMinutes: z.number(),
    lines: z.number(),
  }),
  actions: z.array(z.object({ action: z.enum(ESTIMATE_ACTIONS), allowed: z.boolean() })),
})
export type Estimate = z.infer<typeof estimateSchema>

const estimatesSchema = z.object({
  repair: z.object({ id: z.string(), number: z.string(), stage: z.enum(REPAIR_STAGES), version: z.number(), partyId: z.string() }),
  /** Every revision, newest first. */
  estimates: z.array(estimateSchema),
  liveId: z.string().nullable(),
  newEstimate: z.object({ allowed: z.boolean(), replaces: z.string().nullable() }),
  /** The stage moves the estimate holds (English words: read as "held or not"; the screen says its own). */
  workHeld: z.object({ approve: z.string().nullable(), startRepair: z.string().nullable() }),
  seesPrices: z.boolean(),
  seesCosts: z.boolean(),
  people: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type Estimates = z.infer<typeof estimatesSchema>

type Versioned = { readonly id: string; readonly version: number }

export const getEstimates = (api: ApiClient, repairId: string, signal?: AbortSignal): Promise<Estimates> => api.get(`/sales/repairs/${seg(repairId)}/estimates`, { schema: estimatesSchema, signal })

export interface NewEstimateBody {
  replaces?: string | null
  copyLines?: boolean
  validUntil?: string | null
  customerNote?: string | null
  internalNote?: string | null
}

export const newEstimate = (api: ApiClient, repairId: string, body: NewEstimateBody, idempotencyKey: string): Promise<Estimates> =>
  api.post(`/sales/repairs/${seg(repairId)}/estimates`, { body, schema: estimatesSchema, idempotencyKey })

export interface TermsBody {
  validUntil?: string | null
  customerNote?: string | null
  internalNote?: string | null
}

export const changeTerms = (api: ApiClient, estimate: Versioned, body: TermsBody, idempotencyKey: string): Promise<Estimates> =>
  api.request('PATCH', `/sales/repairs/estimates/${seg(estimate.id)}`, { body: { version: estimate.version, ...body }, schema: estimatesSchema, idempotencyKey })

export interface LineBody {
  kind?: EstimateLineKind
  description?: string
  quantity?: string
  minutes?: number | null
  unitPrice?: string
  unitCost?: string | null
}

export const addLine = (api: ApiClient, estimate: Versioned, body: LineBody, idempotencyKey: string): Promise<Estimates> =>
  api.post(`/sales/repairs/estimates/${seg(estimate.id)}/lines`, { body: { version: estimate.version, ...body }, schema: estimatesSchema, idempotencyKey })

export const changeLine = (api: ApiClient, estimate: Versioned, lineId: string, body: LineBody, idempotencyKey: string): Promise<Estimates> =>
  api.request('PATCH', `/sales/repairs/estimates/${seg(estimate.id)}/lines/${seg(lineId)}`, { body: { version: estimate.version, ...body }, schema: estimatesSchema, idempotencyKey })

export const removeLine = (api: ApiClient, estimate: Versioned, lineId: string, idempotencyKey: string): Promise<Estimates> =>
  api.request('DELETE', `/sales/repairs/estimates/${seg(estimate.id)}/lines/${seg(lineId)}`, { query: { version: String(estimate.version) }, schema: estimatesSchema, idempotencyKey })

export const sendEstimate = (api: ApiClient, estimate: Versioned, idempotencyKey: string): Promise<Estimates> =>
  api.post(`/sales/repairs/estimates/${seg(estimate.id)}/send`, { body: { version: estimate.version }, schema: estimatesSchema, idempotencyKey })

export interface AnswerBody {
  answer: EstimateAnswer
  how: string
  answeredByName?: string | null
  declineReason?: string | null
}

export const answerEstimate = (api: ApiClient, estimate: Versioned, body: AnswerBody, idempotencyKey: string): Promise<Estimates> =>
  api.post(`/sales/repairs/estimates/${seg(estimate.id)}/answer`, { body: { version: estimate.version, ...body }, schema: estimatesSchema, idempotencyKey })

export const withdrawEstimate = (api: ApiClient, estimate: Versioned, reason: string | null, idempotencyKey: string): Promise<Estimates> =>
  api.post(`/sales/repairs/estimates/${seg(estimate.id)}/withdraw`, { body: { version: estimate.version, reason }, schema: estimatesSchema, idempotencyKey })
