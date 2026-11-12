import { z } from 'zod'
import { ARRIVAL_STATES, FEE_DROPS, POLICY_CHANNELS } from '@nexus/factory-domain/sales/returns-depth/rules'
import { FINISH_REASONS, REMAKE_CHANNELS } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { FREIGHT_PAYERS, GOODS_OUTCOMES, RETURN_DISPOSITIONS, RETURN_STATUSES } from '@nexus/factory-domain/sales/returns/rules'
import type { ApiClient } from '../../../../lib/api/client'
import type { ReturnDisposition } from '../api'

/**
 * Every call of the W2b parts of a return (B-W2b-352 on the merged API of B-W2b-341 `modules/sales/returns-depth` and
 * B-W2b-346 `modules/sales/returns-outcomes`): the return in depth (its policy, the deadline and the arrival, the scan
 * code and the papers, each line's garment, window, value, credit without the goods and fee), "Arrived after the
 * deadline", the policy check of a new return and the binding, the fee preview of a decision, a credit without the goods
 * (preview, then the ask: done, or waiting for a yes), the papers PDF, the outcomes (split, size exchange, the remake
 * asked, the finish reasons), split and finish. Each answer checked with a
 * zod shape that mirrors the API's contract (the web never imports the API source): unknown fields are dropped. Values,
 * credits and fees are the price grain (absent for a reader without it). The API's English `held` / `words` are read but
 * never shown: the screens say their own words from the facts (model.ts).
 */

export type FinishReason = (typeof FINISH_REASONS)[number]

const seg = (value: string) => encodeURIComponent(value)
const issue = z.object({ path: z.string(), message: z.string() })
type Versioned = { readonly id: string; readonly version: number }

// ---- the return in depth (GET /sales/returns/:id/depth) ---------------------------------------------------------------

const policySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  channel: z.enum(POLICY_CHANNELS),
  name: z.string(),
  windowDays: z.number(),
  goodsDueDays: z.number().nullable(),
  freightPaidBy: z.enum(FREIGHT_PAYERS),
  conditions: z.string().nullable(),
  withdrawalWords: z.string().nullable(),
  effectiveFrom: z.string(),
  live: z.boolean(),
  version: z.number(),
})
export type ReturnPolicy = z.infer<typeof policySchema>

const windowSchema = z.object({ deliveredOn: z.string().nullable(), lastDay: z.string().nullable(), inWindow: z.boolean(), daysOver: z.number() })

const checkSchema = z.object({
  channel: z.enum(POLICY_CHANNELS),
  channelFrom: z.enum(['CUSTOMER', 'NAMED']),
  policy: policySchema.nullable(),
  fallback: z.object({ windowDays: z.number().nullable(), goodsDueDays: z.number().nullable() }).nullable(),
  lines: z.array(z.object({ index: z.number(), seq: z.number().nullable(), window: windowSchema, madeToMeasure: z.boolean(), personalised: z.boolean() })),
  outsideWindow: z.boolean(),
  withdrawal: z.object({ asked: z.boolean(), applies: z.boolean() }),
  goodsDueBy: z.string().nullable(),
  warnings: z.array(issue),
  problems: z.array(issue),
  ok: z.boolean().optional(),
})
export type PolicyCheck = z.infer<typeof checkSchema>

const feeSchema = z.object({ ruleId: z.string(), ruleName: z.string(), amount: z.number().nullable().optional(), dropped: z.enum(FEE_DROPS).nullable() })

const depthLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  size: z.string().nullable(),
  quantity: z.number(),
  receivedQuantity: z.number(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  garmentSerial: z.string().nullable(),
  garmentBatch: z.string().nullable(),
  parentLineId: z.string().nullable(),
  exchangeSize: z.string().nullable(),
  window: windowSchema.nullable(),
  currency: z.string().nullable(),
  /** Price grain: absent without it. */
  value: z.number().nullable().optional(),
  creditAmount: z.number().nullable().optional(),
  creditWithoutReturn: z.object({
    credited: z.boolean(),
    waiting: z.object({ taskId: z.string(), requestedAt: z.string(), approverRoleId: z.string().nullable(), approverUserId: z.string().nullable(), dueAt: z.string().nullable() }).nullable(),
    allowed: z.boolean(),
  }),
  fee: feeSchema.nullable(),
})
export type DepthLine = z.infer<typeof depthLineSchema>

const depthSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(RETURN_STATUSES),
  companyId: z.string(),
  partyId: z.string(),
  channel: z.enum(POLICY_CHANNELS),
  policy: z.object({ named: policySchema.nullable(), live: policySchema.nullable(), current: z.boolean(), withdrawal: z.boolean(), followsSalesSettings: z.boolean(), check: checkSchema }),
  deadline: z.object({ goodsDueBy: z.string().nullable(), receivedOn: z.string().nullable(), arrival: z.object({ state: z.enum(ARRIVAL_STATES), daysLate: z.number() }) }),
  scanCode: z.string().nullable(),
  papers: z.object({ printable: z.boolean() }),
  feesApply: z.boolean(),
  lines: z.array(depthLineSchema),
  version: z.number(),
})
export type ReturnDepth = z.infer<typeof depthSchema>

const oneDepth = z.object({ return: depthSchema })

export const getDepth = (api: ApiClient, returnId: string, signal?: AbortSignal): Promise<ReturnDepth> => api.get(`/sales/returns/${seg(returnId)}/depth`, { schema: oneDepth, signal }).then((answer) => answer.return)

// ---- Arrived after the deadline (the tile and its view) -----------------------------------------------------------------

const lateSchema = z.object({
  rows: z.array(z.object({ id: z.string(), number: z.string(), status: z.enum(RETURN_STATUSES), goodsDueBy: z.string().nullable(), receivedOn: z.string().nullable(), daysLate: z.number() })),
  count: z.number(),
  truncated: z.boolean(),
  asOf: z.string(),
})
export type ArrivedLate = z.infer<typeof lateSchema>

export const listArrivedLate = (api: ApiClient, view: 'open' | 'all' = 'open', signal?: AbortSignal): Promise<ArrivedLate> => api.get('/sales/returns/arrived-late', { query: { view }, schema: lateSchema, signal })

// ---- the policy of a new return (check while typing) and its binding --------------------------------------------------------

export interface PolicyCheckBody {
  companyId: string
  partyId: string
  withdrawal?: boolean
  lines: { invoiceLineId?: string | null; salesOrderLineId?: string | null; size?: string | null }[]
}

export const checkPolicy = (api: ApiClient, body: PolicyCheckBody, signal?: AbortSignal): Promise<PolicyCheck> =>
  api.post('/sales/returns/policy-check', { body, schema: z.object({ check: checkSchema }), signal }).then((answer) => answer.check)

export interface ApplyPolicyBody {
  withdrawal?: boolean
  goodsDueBy?: string | null
  reason?: string | null
}

export const applyPolicy = (api: ApiClient, rma: Versioned, body: ApplyPolicyBody, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/policy`, { body: { version: rma.version, ...body }, schema: z.object({ goodsDueBy: z.string().nullable(), return: depthSchema }), idempotencyKey })

// ---- the fee of a decision (preview) -----------------------------------------------------------------------------------

const feePreviewSchema = z.object({
  policyNamed: z.boolean(),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), currency: z.string().nullable(), creditBefore: z.number().optional(), fee: feeSchema.nullable(), creditAfter: z.number().optional() })),
})
export type FeePreview = z.infer<typeof feePreviewSchema>

export const previewFees = (api: ApiClient, returnId: string, lines: { lineId: string; disposition: ReturnDisposition; creditAmount?: number | null }[], signal?: AbortSignal): Promise<FeePreview> =>
  api.post(`/sales/returns/${seg(returnId)}/fees/preview`, { body: { lines }, schema: feePreviewSchema, signal })

// ---- credit without the goods ---------------------------------------------------------------------------------------------

const creditPreviewSchema = z.object({
  ok: z.boolean(),
  problems: z.array(issue),
  lineId: z.string(),
  seq: z.number(),
  pieces: z.number(),
  currency: z.string().nullable(),
  value: z.number().nullable().optional(),
  creditAmount: z.number().nullable().optional(),
  approval: z.object({ needed: z.boolean(), approverRoleId: z.string().nullable(), approverUserId: z.string().nullable(), nobodyElse: z.boolean() }),
  waiting: z.object({ taskId: z.string(), requestedAt: z.string() }).nullable(),
})
export type CreditPreview = z.infer<typeof creditPreviewSchema>

export const previewCredit = (api: ApiClient, returnId: string, lineId: string, creditAmount: number | null, signal?: AbortSignal): Promise<CreditPreview> =>
  api.post(`/sales/returns/${seg(returnId)}/lines/${seg(lineId)}/credit-without-return/preview`, { body: creditAmount === null ? {} : { creditAmount }, schema: creditPreviewSchema, signal })

const creditAnswerSchema = z.object({
  credited: z.boolean(),
  waiting: z.object({ taskId: z.string(), approverRoleId: z.string().nullable(), approverUserId: z.string().nullable(), dueAt: z.string().nullable() }).nullable(),
  return: depthSchema,
})
export type CreditAnswer = z.infer<typeof creditAnswerSchema>

export const creditWithoutReturn = (api: ApiClient, rma: Versioned, lineId: string, body: { creditAmount?: number | null; note?: string | null }, idempotencyKey: string): Promise<CreditAnswer> =>
  api.post(`/sales/returns/${seg(rma.id)}/lines/${seg(lineId)}/credit-without-return`, { body: { version: rma.version, ...body }, schema: creditAnswerSchema, idempotencyKey })

// ---- the scan code and the papers (RMA sheet + box label) ----------------------------------------------------------------

export const setScanCode = (api: ApiClient, rma: Versioned, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/scan-code`, { body: { version: rma.version }, schema: z.object({ scanCode: z.string(), created: z.boolean(), return: depthSchema }), idempotencyKey })

export const returnPapers = (api: ApiClient, returnId: string, language: 'it' | 'en'): Promise<Uint8Array> => api.bytes(`/sales/returns/${seg(returnId)}/papers`, { query: { language } })

// ---- the outcomes (B-W2b-346) ---------------------------------------------------------------------------------------------

const outcomeLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  description: z.string(),
  size: z.string().nullable(),
  quantity: z.number(),
  receivedQuantity: z.number(),
  expected: z.number(),
  graded: z.boolean(),
  disposition: z.enum(RETURN_DISPOSITIONS).nullable(),
  goodsOutcome: z.enum(GOODS_OUTCOMES).nullable(),
  exchangeSize: z.string().nullable(),
  replacementLineId: z.string().nullable(),
  creditWithoutReturn: z.boolean(),
  parentLineId: z.string().nullable(),
  splitLineIds: z.array(z.string()),
  split: z.object({ allowed: z.boolean(), rest: z.number() }),
  exchange: z.object({ sizes: z.array(z.string()) }),
  remake: z.boolean(),
  photos: z.number(),
  version: z.number(),
})
export type OutcomeLine = z.infer<typeof outcomeLineSchema>

const outcomesSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(RETURN_STATUSES),
  channel: z.string(),
  remake: z.object({
    asked: z.boolean(),
    at: z.string().nullable(),
    via: z.enum(REMAKE_CHANNELS).nullable(),
    lineIds: z.array(z.string()),
    fit: z.string().nullable(),
    photos: z.array(z.object({ lineId: z.string(), count: z.number(), needed: z.number() })),
  }),
  lines: z.array(outcomeLineSchema),
  finish: z.object({
    reasons: z.array(z.object({ reason: z.enum(FINISH_REASONS), allowed: z.boolean() })),
    suggested: z.enum(FINISH_REASONS).nullable(),
    missingPieces: z.number(),
    finishReason: z.enum(FINISH_REASONS).nullable(),
    closedAt: z.string().nullable(),
  }),
  version: z.number(),
})
export type ReturnOutcomes = z.infer<typeof outcomesSchema>

const oneOutcomes = z.object({ return: outcomesSchema })

export const getOutcomes = (api: ApiClient, returnId: string, signal?: AbortSignal): Promise<ReturnOutcomes> => api.get(`/sales/returns/${seg(returnId)}/outcomes`, { schema: oneOutcomes, signal }).then((answer) => answer.return)

/** Split the rest (the line keeps what arrived; what did not becomes its own line, still expected). */
export const splitLine = (api: ApiClient, rma: Versioned, lineId: string, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/lines/${seg(lineId)}/split`, {
    body: { version: rma.version },
    schema: z.object({ line: z.object({ id: z.string(), seq: z.number(), quantity: z.number() }), newLine: z.object({ id: z.string(), seq: z.number(), quantity: z.number() }) }),
    idempotencyKey,
  })

export const finishReturn = (api: ApiClient, rma: Versioned, body: { finishReason: FinishReason; reason?: string | null }, idempotencyKey: string) =>
  api.post(`/sales/returns/${seg(rma.id)}/finish`, { body: { version: rma.version, ...body }, schema: z.object({ return: outcomesSchema, warnings: z.array(issue) }), idempotencyKey })
