import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { IntakeBody } from '../../../lib/safety-reports/intake'
import type { PhotoDoor } from '../../../lib/safety-reports/photos'
import { wantsChallenge } from '../model'
import { solveChallenge } from '../pow'

/**
 * links.doc › Report a problem (B-W2b-357 on B-W2b-351's public door; SAL-414): anyone who scanned the garment's QR, no
 * session, no token.
 *   GET  /public/safety-reports/status              whether the door is open (OFF until the privacy notice: GATE-PRIVACY)
 *   POST /public/safety-reports                     the page's `code` (+ `n` when the page is one of several), the report;
 *                                                   an Idempotency-Key per body; a 429 `challenge` solved once as the lookup's
 *   POST /public/safety-reports/photos (+ /:fileId/complete)   photos after the send, with the signed ticket it gave
 */

const status = z.object({ open: z.boolean(), words: z.string().nullable() })
const sent = z.object({ sent: z.object({ number: z.string(), words: z.string() }), photos: z.object({ ticket: z.string(), until: z.string(), max: z.number().int() }) })
const challenge = z.object({ challenge: z.string(), bits: z.number().int() })

export type PublicSent = z.infer<typeof sent>

/** Whether the public door is open (the API's switch; a company without its privacy notice in force still refuses the send). */
export async function readPublicStatus(api: ApiClient, signal?: AbortSignal): Promise<boolean> {
  return (await api.get('/public/safety-reports/status', { schema: status, signal })).open
}

/** The report from the page: the page's code (and `n`), the body; `onChecking` says a device check is being solved. */
export async function sendPublicReport(api: ApiClient, page: { code: string; n: number }, body: IntakeBody, idempotencyKey: string, options: { onChecking?: () => void } = {}): Promise<PublicSent> {
  const send = (proof?: { challenge: string; nonce: string }) =>
    api.post('/public/safety-reports', { body: { code: page.code, ...(page.n > 0 ? { n: page.n } : {}), ...(proof ? { proof } : {}), ...body }, schema: sent, idempotencyKey })
  try {
    return await send()
  } catch (error) {
    if (!isApiError(error) || !wantsChallenge(error)) throw error
    options.onChecking?.()
    const asked = await api.get('/abuse/challenge', { query: { policy: 'public.lookup' }, schema: challenge })
    const nonce = await solveChallenge(asked.challenge, asked.bits)
    if (nonce === null) throw error
    return send({ challenge: asked.challenge, nonce })
  }
}

/** Where a photo of the report just sent goes: the public photo door with its ticket. */
export const publicPhotoDoor = (ticket: string): PhotoDoor => ({
  announce: '/public/safety-reports/photos',
  complete: (fileId) => `/public/safety-reports/photos/${encodeURIComponent(fileId)}/complete`,
  extra: { ticket },
})
