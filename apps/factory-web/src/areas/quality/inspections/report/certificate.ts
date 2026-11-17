import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'

/**
 * B-TH-232 (threads plan TH-2, the office side of the wall in words; B-TH-032, WALL-G07, W16): a work order that also makes another
 * customer's garments cannot send its inspection report to one customer, so the report page offers what that customer may have —
 * its own shipment's certificate of conformity (QHS-059): a version kept (POST /quality/shipments/:id/certificates; the same
 * contents give the newest back) and shared on the shipment's documents link (POST …/certificates/share). Office only; every write
 * takes an idempotency key; refusals come as `held/<CODE>`.
 */

const version = z.object({ version: z.number(), language: z.string() }).passthrough()
const shared = z.object({ shared: z.object({ shipmentNumber: z.string(), version: z.number(), withdrawn: z.number() }).passthrough() }).passthrough()

export function keepCertificate(api: ApiClient, shipmentId: string, language: 'it' | 'en', key: string): Promise<{ certificate: { version: number }; made: boolean }> {
  return api.post(`/quality/shipments/${encodeURIComponent(shipmentId)}/certificates`, { body: { language }, schema: z.object({ certificate: version, made: z.boolean() }), idempotencyKey: key })
}

export function shareCertificate(api: ApiClient, shipmentId: string, body: { version: number }, key: string): Promise<{ shared: { shipmentNumber: string; version: number; withdrawn: number } }> {
  return api.post(`/quality/shipments/${encodeURIComponent(shipmentId)}/certificates/share`, { body, schema: shared, idempotencyKey: key })
}

/** The certificate's refusals the page says in its words (`certificate.held.<CODE>`); another: the kind's words, the API's lines kept. */
export const CERTIFICATE_REFUSALS = ['NOT_CERTIFIABLE', 'NO_VERSION', 'NO_SUCH_VERSION', 'NO_SHIPMENT'] as const

export function certificateRefusal(error: unknown): { key: string; lines: string[] } {
  if (!isApiError(error)) return { key: 'certificate.refused', lines: [] }
  const path = String(error.issues[0]?.path ?? '')
  const code = path.startsWith('held/') ? path.slice('held/'.length) : null
  const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
  if (code && (CERTIFICATE_REFUSALS as readonly string[]).includes(code)) return { key: `certificate.held.${code}`, lines }
  if (error.kind === 'forbidden') return { key: 'certificate.held.noRight', lines: [] }
  return { key: 'certificate.refused', lines }
}
