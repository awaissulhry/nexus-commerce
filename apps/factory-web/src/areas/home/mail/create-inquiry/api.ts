import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * B-TH-224 (threads plan TH-1b): whether a mail of Mail to sort became a request already — GET /sales/inquiries/from-mail/:id
 * (sales.inquiries.manage and email.triage over the mail) names the request made of it (one per mail), so the review offers
 * "Open in Incoming" instead of "Make incoming request". A customer's mail joins the request's thread (its thread says so); a
 * prospect's mail keeps waiting here until the request is matched to a customer, so only this read knows.
 */
const answer = z.object({ inquiry: z.object({ id: z.string(), number: z.string() }).nullable() })

export async function requestMadeOf(api: ApiClient, inboundEmailId: string, signal?: AbortSignal): Promise<{ id: string; number: string } | null> {
  return (await api.get(`/sales/inquiries/from-mail/${encodeURIComponent(inboundEmailId)}`, { schema: answer, signal })).inquiry
}
