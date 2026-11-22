import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * F-OS-303 (order SHIPMENTS tab, 10-design §5 / §6 "Send a claim link…") — the customer's claim link (`POST /sales/claim-links`,
 * sales.returns.manage; the API's own walls: a shipment that left, or an order not cancelled, of this person's customers): a link for
 * the customer to ask for a return or report a quality problem, with photos, mailed to one of the customer's contacts or to an address
 * typed. The answer says whether the mail went and until when the link works (its address is never shown when it was mailed).
 */

export interface ClaimLinkBody {
  recordType: 'Shipment' | 'SalesOrder'
  recordId: string
  contactId?: string
  email?: string
  send: true
}

const sentSchema = z.object({
  link: z.object({ id: z.string(), expiresAt: z.string(), email: z.string().nullable() }),
  delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
})
export type ClaimLinkSent = z.infer<typeof sentSchema>

export function sendClaimLink(api: ApiClient, body: ClaimLinkBody, idempotencyKey: string): Promise<ClaimLinkSent> {
  return api.post('/sales/claim-links', { body, schema: sentSchema, idempotencyKey })
}
