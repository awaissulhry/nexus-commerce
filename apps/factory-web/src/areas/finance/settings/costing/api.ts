import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The costing method per company (B-W2a-80 on the API of B-W2a-21, modules/costing/method; design finance.settings
 * sec:costing and pop:method-lock): the method in force (the company's own, the tenant-wide one, or the default:
 * UNDECIDED), whether it is locked (the first cost entry posted under it locks it; c.c. art. 2426), since when entries
 * exist, and the accountant's choice (costing.method.manage and a fresh step-up). The API's English words are not drawn.
 */

export const COSTING_METHODS = ['UNDECIDED', 'STANDARD', 'MOVING_AVERAGE', 'FIFO'] as const
export type CostingMethod = (typeof COSTING_METHODS)[number]
export const DECIDED_METHODS = ['STANDARD', 'MOVING_AVERAGE', 'FIFO'] as const satisfies readonly CostingMethod[]
export type DecidedMethod = (typeof DECIDED_METHODS)[number]

export const methodSchema = z.object({
  companyId: z.string().nullable(),
  settingsId: z.string().nullable(),
  from: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  method: z.enum(COSTING_METHODS),
  provisional: z.boolean(),
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  firstEntryAt: z.string().nullable(),
  entries: z.number(),
  open: z.boolean().optional(),
  version: z.number().nullable(),
})
export type MethodState = z.infer<typeof methodSchema>

const one = z.object({ method: methodSchema })

/** The method in force for a company (costing.view). */
export async function readMethod(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<MethodState> {
  return (await api.get('/costing/method', { query: { companyId }, schema: one, signal })).method
}

/**
 * The accountant's method for a company (costing.method.manage + a fresh step-up): its own settings row is made when it has
 * none (no version sent), else the row's version guards it. Refused once locked.
 */
export async function chooseMethod(api: ApiClient, body: { companyId: string; method: DecidedMethod; version: number | null; reason: string | null }, idempotencyKey: string): Promise<MethodState> {
  const { version, reason, ...rest } = body
  return (await api.request('PUT', '/costing/method', { body: { ...rest, ...(version !== null ? { version } : {}), ...(reason ? { reason } : {}) }, schema: one, idempotencyKey })).method
}
