import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import type { IntakeBody } from '../../../../lib/safety-reports/intake'
import type { PhotoDoor } from '../../../../lib/safety-reports/photos'

/**
 * The portal's Report a safety incident (B-W2b-357 on B-W2b-351's portal door; design portal.customer.returns pop:safety-report;
 * SAL-414, SAL-415), the customer's person with the PORTAL session:
 *   GET  /portal/safety-reports/status           whether the door is open for this company and what the person may do
 *   POST /portal/safety-reports                  the report for the person's own customer (one Idempotency-Key per body)
 *   POST /portal/safety-reports/:id/photos (+ /:fileId/complete)  photos after the send, the person's own report, in its window
 */

const status = z.object({ open: z.boolean(), words: z.string().nullable(), mayRequest: z.boolean(), mayUpload: z.boolean() })
const sent = z.object({
  report: z.object({ id: z.string(), number: z.string() }),
  sent: z.object({ number: z.string(), words: z.string() }),
  photos: z.object({ until: z.string(), max: z.number().int(), mayUpload: z.boolean() }),
})

export type PortalSafetyStatus = z.infer<typeof status>
export type PortalSafetySent = z.infer<typeof sent>

export function readPortalSafetyStatus(api: ApiClient, signal?: AbortSignal): Promise<PortalSafetyStatus> {
  return api.get('/portal/safety-reports/status', { schema: status, signal })
}

export function sendPortalSafetyReport(api: ApiClient, body: IntakeBody, idempotencyKey: string): Promise<PortalSafetySent> {
  const { reporter: _reporter, ...rest } = body
  return api.post('/portal/safety-reports', { body: rest, schema: sent, idempotencyKey })
}

export const portalPhotoDoor = (reportId: string): PhotoDoor => ({
  announce: `/portal/safety-reports/${encodeURIComponent(reportId)}/photos`,
  complete: (fileId) => `/portal/safety-reports/${encodeURIComponent(reportId)}/photos/${encodeURIComponent(fileId)}/complete`,
})
