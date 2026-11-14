import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Reminder stops and trusted levels on screen (B-W2b-425 on B-W2b-402's API; design finance.receivables sec:reminders "Held
 * (W2b stop rules): 'payment being processed', 'dispute open', 'promise to pay', 'credit note pending'" and "Trusted levels
 * can be automatic per customer"). No money here. The lists mirror factory-domain receivables/stops and notices (the tests
 * hold them equal); the API's English words are never drawn.
 */

export const STOP_REASONS = ['PAYMENT_PROCESSING', 'DISPUTE', 'PROMISE_TO_PAY', 'CREDIT_PENDING'] as const
export type StopReason = (typeof STOP_REASONS)[number]
export const STOP_STATES = ['holding', 'lifted', 'over', 'all'] as const
export type StopState = (typeof STOP_STATES)[number]
export const STOP_REFUSALS = ['NOT_AN_INVOICE', 'LIFTED', 'OVER', 'SAME_STOP'] as const
export const MAX_STOP_TEXT = { note: 2000, liftReason: 500 } as const
export const MAX_TRUSTED_LEVEL = 10

const person = z.object({ id: z.string(), name: z.string().nullable() })

export const stopSchema = z.object({
  id: z.string(),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  invoice: z.object({ id: z.string(), number: z.string().nullable() }),
  reason: z.enum(STOP_REASONS),
  until: z.string().nullable(),
  note: z.string().nullable(),
  state: z.enum(['holding', 'lifted', 'over']),
  holdsReminders: z.array(z.string()),
  createdAt: z.string(),
  createdBy: person.nullable(),
  liftedAt: z.string().nullable(),
  liftedBy: person.nullable(),
  liftReason: z.string().nullable(),
  can: z.object({ change: z.boolean(), lift: z.boolean() }),
  version: z.number(),
})
export type ReminderStop = z.infer<typeof stopSchema>
const oneStop = z.object({ stop: stopSchema })

export const trustSchema = z.object({
  customer: z.object({ id: z.string(), code: z.string(), name: z.string(), version: z.number() }),
  level: z.number().nullable(),
  companies: z.array(z.object({ id: z.string(), code: z.string(), remindersEnabled: z.boolean(), steps: z.array(z.object({ level: z.number(), offsetDays: z.number(), action: z.string() })) })),
  mayChange: z.boolean(),
})
export type CustomerTrust = z.infer<typeof trustSchema>

const enc = encodeURIComponent

/** GET /receivables/stops (receivables.view): in force by default; a customer's, an invoice's, or the company's. */
export async function listStops(api: ApiClient, query: { companyId?: string; partyId?: string; invoiceId?: string; state?: StopState; limit?: number }, signal?: AbortSignal): Promise<ReminderStop[]> {
  return (await api.get('/receivables/stops', { query: { ...query, state: query.state ?? 'holding', limit: query.limit ?? 100 }, schema: z.object({ stops: z.array(stopSchema) }), signal })).stops
}

/** POST /receivables/stops (receivables.reminders.manage): reminders of an invoice stop, for a reason (a promise names its day). */
export async function addStop(api: ApiClient, body: { invoiceId: string; reason: StopReason; until?: string | null; note?: string | null }, idempotencyKey: string): Promise<ReminderStop> {
  return (await api.post('/receivables/stops', { body, schema: oneStop, idempotencyKey })).stop
}

/** PATCH /receivables/stops/:id (receivables.reminders.manage): its last day or its note. */
export async function changeStop(api: ApiClient, stop: Pick<ReminderStop, 'id' | 'version'>, body: { until?: string | null; note?: string | null }, idempotencyKey: string): Promise<ReminderStop> {
  return (await api.request('PATCH', `/receivables/stops/${enc(stop.id)}`, { body: { version: stop.version, ...body }, schema: oneStop, idempotencyKey })).stop
}

/** POST /receivables/stops/:id/lift (receivables.reminders.manage): reminders may go again (why, optional). */
export async function liftStop(api: ApiClient, stop: Pick<ReminderStop, 'id' | 'version'>, reason: string | null, idempotencyKey: string): Promise<ReminderStop> {
  return (await api.post(`/receivables/stops/${enc(stop.id)}/lift`, { body: { version: stop.version, ...(reason ? { reason } : {}) }, schema: oneStop, idempotencyKey })).stop
}

/** GET /receivables/customers/:id/trust (receivables.view): the customer's trusted level and what goes by itself per company. */
export function customerTrust(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CustomerTrust> {
  return api.get(`/receivables/customers/${enc(partyId)}/trust`, { schema: trustSchema, signal })
}

/** PUT /receivables/customers/:id/trust (receivables.reminders.trust; a fresh code to set a level): the level or none. */
export function setTrust(api: ApiClient, trust: Pick<CustomerTrust, 'customer'>, level: number | null, idempotencyKey: string): Promise<CustomerTrust> {
  return api.request('PUT', `/receivables/customers/${enc(trust.customer.id)}/trust`, { body: { version: trust.customer.version, level }, schema: trustSchema, idempotencyKey })
}
