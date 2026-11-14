import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The capture address's calls (apps/factory-api platform/email-in/capture, B-W2b-394; COL-021; design home.mail band "Copy
 * capture address", admin.connections sec:mail-domain "Capture address (W2b): forward or BCC any mail to it"), through the ONE
 * client. Home › Mail reads it (email.send over the company); Admin › Connections also makes, replaces, points and turns it
 * off (email.inboxes.manage), each write with the address's version as read and its own Idempotency-Key.
 */

const captureSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  address: z.string().nullable(),
  defaultTeamInbox: z.object({ id: z.string(), name: z.string(), active: z.boolean() }).nullable(),
  createdAt: z.string(),
  version: z.number().int(),
})
export type Capture = z.infer<typeof captureSchema>
const readSchema = z.object({ capture: captureSchema.nullable(), receivingDomain: z.string().nullable(), mayManage: z.boolean() })
export type CaptureRead = z.infer<typeof readSchema>
const oneCapture = z.object({ capture: captureSchema })

/** GET /email/capture?companyId: the live address (null: none yet), the domain it is made at, whether the reader may manage it. */
export async function readCapture(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<CaptureRead> {
  return api.get('/email/capture', { query: { companyId }, schema: readSchema, signal })
}

/** POST /email/capture: a new address; while one is live it replaces it (turned off in the same step). */
export async function makeCapture(api: ApiClient, companyId: string, replacing: Pick<Capture, 'id' | 'version'> | null): Promise<Capture> {
  const answer = await api.post('/email/capture', { body: { companyId, ...(replacing ? { replacing: { id: replacing.id, version: replacing.version } } : {}) }, schema: oneCapture, idempotencyKey: newIdempotencyKey() })
  return answer.capture
}

/** PUT /email/capture/:id: where mail it cannot place lands (a team inbox, or null: Mail to sort). */
export async function pointCapture(api: ApiClient, capture: Pick<Capture, 'id' | 'version'>, defaultTeamInboxId: string | null): Promise<Capture> {
  const answer = await api.request('PUT', `/email/capture/${encodeURIComponent(capture.id)}`, { body: { version: capture.version, defaultTeamInboxId }, schema: oneCapture, idempotencyKey: newIdempotencyKey() })
  return answer.capture
}

/** POST /email/capture/:id/turn-off: no mail is matched through it any more. */
export async function turnOffCapture(api: ApiClient, capture: Pick<Capture, 'id' | 'version'>): Promise<Capture> {
  const answer = await api.post(`/email/capture/${encodeURIComponent(capture.id)}/turn-off`, { body: { version: capture.version }, schema: oneCapture, idempotencyKey: newIdempotencyKey() })
  return answer.capture
}

/** GET /email/team-inboxes?companyId: the switched-on inboxes (names only here) for the default inbox's choice. */
export async function captureInboxes(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<{ id: string; name: string; active: boolean }[]> {
  const answer = await api.get('/email/team-inboxes', { query: { companyId }, schema: z.object({ inboxes: z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean() })) }), signal })
  return answer.inboxes.filter((inbox) => inbox.active)
}
