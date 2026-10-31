import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { getAgeing, type Ageing } from '../../../finance/receivables/api'

/**
 * The calls behind the customer's Overdue and Returns numbers (B-W2a-81; design sales.customers "Overdue (price, W2a)"
 * on the list, "Overdue" and "Returns this year" key numbers and "Open returns and claims" on the record): what the
 * customers owe late (receivables' ageing, B-W2a-55), the customer's returns (B-W2a-43) and open complaints (B-W2a-65).
 * The shapes keep what the screens draw (zod drops the rest); the enum lists mirror factory-domain (the test holds them).
 */

export const RETURN_STATUSES = ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED', 'REJECTED', 'CANCELLED'] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED']
export const COMPLAINT_STATUSES = ['NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED', 'CLOSED'] as const
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number]

export const customerReturnSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  status: z.enum(RETURN_STATUSES),
  units: z.number(),
  requestedAt: z.string(),
  late: z.boolean(),
})
export type CustomerReturn = z.infer<typeof customerReturnSchema>

export const customerComplaintSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  status: z.enum(COMPLAINT_STATUSES),
  receivedAt: z.string(),
  answerDueOn: z.string().nullable(),
  summary: z.string(),
})
export type CustomerComplaint = z.infer<typeof customerComplaintSchema>

/** GET /receivables/ageing?bucket=OVERDUE: every customer of the company with money late (one read for the list's column). */
export function getOverdueCustomers(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<Ageing> {
  return getAgeing(api, { companyId, bucket: 'OVERDUE', limit: 500 }, signal)
}

/** GET /receivables/ageing?partyId=: what one customer owes in the company (one row per currency). */
export function getCustomerAgeing(api: ApiClient, partyId: string, companyId: string | null, signal?: AbortSignal): Promise<Ageing> {
  return getAgeing(api, { companyId, partyId, limit: 20 }, signal)
}

/** GET /sales/returns?partyId=: the customer's returns (every state; the API caps the list and says so). */
export async function listCustomerReturns(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<{ returns: CustomerReturn[]; truncated: boolean }> {
  return api.get('/sales/returns', { query: { partyId }, schema: z.object({ returns: z.array(customerReturnSchema), truncated: z.boolean() }), signal })
}

/** GET /quality/complaints?partyId=&view=open: the customer's open complaints. */
export async function listCustomerComplaints(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CustomerComplaint[]> {
  return (await api.get('/quality/complaints', { query: { partyId, view: 'open', limit: 50 }, schema: z.object({ complaints: z.array(customerComplaintSchema) }), signal })).complaints
}
