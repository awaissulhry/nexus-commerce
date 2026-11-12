import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Finance › Receivables › Credit limits (SCR-151 sec:credit; B-W2b-304's API, apps/factory-api modules/sales/credit): every
 * call with the answer's shape checked (zod; unknown fields dropped). Every amount is a price: the API drops it for a
 * person without money.price, so each money field is optional (absent, never zero) and the section draws no figure then.
 * The enum lists mirror factory-domain sales/credit (credit.vitest.test.ts holds them equal).
 */

export const CREDIT_FINDINGS = ['OVER_LIMIT', 'OVERDUE', 'ON_HOLD'] as const
export type CreditFinding = (typeof CREDIT_FINDINGS)[number]
export const LIMIT_VIEWS = ['ALL', 'OVER', 'HELD'] as const
export type LimitView = (typeof LIMIT_VIEWS)[number]

const amount = z.number().int().nullable().optional()

const limitRowSchema = z.object({
  termsId: z.string(),
  version: z.number().int(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  company: z.object({ id: z.string(), code: z.string() }),
  currency: z.string(),
  limit: amount,
  used: amount,
  openOrders: amount,
  openInvoices: amount,
  overdue: amount,
  available: amount,
  overLimitBy: amount,
  usedPct: z.number().int().nullable(),
  onHold: z.boolean(),
  findings: z.array(z.enum(CREDIT_FINDINGS)),
  held: z.object({ orders: z.number().int(), releases: z.number().int(), shipments: z.number().int(), firstOrders: z.array(z.object({ id: z.string(), number: z.string() })) }),
  changedAt: z.string(),
  mayChange: z.boolean(),
})
export type LimitRow = z.infer<typeof limitRowSchema>

const limitsSchema = z.object({
  readAt: z.string(),
  tiles: z.object({ customers: z.number().int(), over: z.number().int(), held: z.number().int(), heldOrders: z.number().int() }),
  rows: z.array(limitRowSchema),
  count: z.number().int(),
  next: z.number().int().nullable(),
})
export type CreditLimits = z.infer<typeof limitsSchema>

export interface LimitsQuery {
  readonly companyId: string | null
  readonly view: LimitView
  readonly q: string | null
  readonly cursor?: number | null
}

/** GET /sales/credit/limits: the customers with a limit with the company, their use and what waits for credit. */
export async function getCreditLimits(api: ApiClient, query: LimitsQuery): Promise<CreditLimits> {
  return api.get('/sales/credit/limits', {
    query: {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      view: query.view,
      ...(query.q ? { q: query.q } : {}),
      ...(query.cursor ? { cursor: String(query.cursor) } : {}),
      limit: '100',
    },
    schema: limitsSchema,
  })
}

export interface LimitInput {
  /** The terms row's version when the customer has terms with the company (absent: they are made). */
  readonly version?: number
  /** Minor units; null clears the limit. */
  readonly amount: number | null
  readonly currency: string | null
  readonly reason: string
}

/** PUT /sales/credit/limits/:partyId/:companyId: the limit set, changed or cleared (logged); the held orders checked again. */
export async function setCreditLimit(api: ApiClient, partyId: string, companyId: string, input: LimitInput): Promise<{ row: LimitRow | null; rechecked: number }> {
  return api.request('PUT', `/sales/credit/limits/${encodeURIComponent(partyId)}/${encodeURIComponent(companyId)}`, {
    body: { ...(input.version !== undefined ? { version: input.version } : {}), amount: input.amount, currency: input.currency, reason: input.reason },
    schema: z.object({ row: limitRowSchema.nullable(), rechecked: z.number().int() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

const customerSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), currency: z.string(), companyId: z.string().nullable() })
export type CustomerOption = z.infer<typeof customerSchema>

/** GET /parties?role=CUSTOMER: the customers a limit may be set for (the first 200; the picker filters them as you type). */
export async function getCustomers(api: ApiClient, companyId: string | null): Promise<CustomerOption[]> {
  return (await api.get('/parties', { query: { role: 'CUSTOMER', limit: '200', ...(companyId ? { companyId } : {}) }, schema: z.object({ parties: z.array(customerSchema) }) })).parties
}
