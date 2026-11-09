import { z } from 'zod'
import { publicDocPage, type PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { wantsChallenge } from './model'
import { solveChallenge } from './pow'

/**
 * The public DoC (apps/factory-api modules/compliance/public-doc, B-W2b-166): anyone, no session, no token. The page's
 * code goes in the body of `POST /public/doc/lookup` (a public call under the abuse guard, policy `public.lookup`: a 429
 * `challenge` after suspicious traffic from the reader's network is solved here once, then the call is sent again). The
 * PDFs are the API's own permanent addresses, `/public/doc/<code>/files/<file id>` (inline; `?download=1` saves it): the
 * page reads them into its viewer, and "Open in a new tab" opens the same address.
 */

export type { PublicDocPage }

const pageAnswer = z.object({ page: publicDocPage })
const challenge = z.object({ challenge: z.string(), bits: z.number().int() })

/** The page of a code (`n` picks one of several records sharing it); `onChecking` says a challenge is being solved. */
export async function lookupPublicDoc(api: ApiClient, code: string, options: { readonly n?: number; readonly onChecking?: () => void; readonly signal?: AbortSignal } = {}): Promise<PublicDocPage> {
  const send = (proof?: { challenge: string; nonce: string }) =>
    api.post('/public/doc/lookup', { body: { code, ...(options.n ? { n: options.n } : {}), ...(proof ? { proof } : {}) }, schema: pageAnswer, signal: options.signal }).then((answer) => answer.page)
  try {
    return await send()
  } catch (error) {
    if (!isApiError(error) || !wantsChallenge(error)) throw error
    options.onChecking?.()
    const asked = await api.get('/abuse/challenge', { query: { policy: 'public.lookup' }, schema: challenge, signal: options.signal })
    const nonce = await solveChallenge(asked.challenge, asked.bits, { signal: options.signal })
    if (nonce === null) throw error
    return send({ challenge: asked.challenge, nonce })
  }
}

/** The PDF's bytes for the page's viewer. */
export function publicDocFileBytes(api: ApiClient, code: string, fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`/public/doc/${encodeURIComponent(code)}/files/${encodeURIComponent(fileId)}`, { signal })
}
