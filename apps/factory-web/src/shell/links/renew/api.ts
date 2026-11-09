import { z } from 'zod'
import { solveChallenge } from '../../../lib/abuse/pow'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { wantsChallenge } from './model'

const answerSchema = z.object({ status: z.literal('requested'), message: z.string() })
const challengeSchema = z.object({ challenge: z.string(), bits: z.number().int() })

/**
 * `POST /link/renew` with the dead link's token in `x-factory-link` (the landing's client): always 202 with ONE answer
 * whatever the token (the page shows its own words, never the API's English). When the API asks for a solved challenge
 * (429 `challenge`, only after suspicious traffic), the page gets one (`GET /abuse/challenge?policy=links.renew`),
 * solves it (`onChecking` tells the screen) and sends again with the proof — once.
 */
export async function askForNewLink(api: ApiClient, onChecking?: () => void): Promise<void> {
  const send = (proof?: { challenge: string; nonce: string }) => api.post('/link/renew', { body: proof ? { proof } : {}, schema: answerSchema, idempotencyKey: newIdempotencyKey() })
  try {
    await send()
  } catch (error) {
    if (!wantsChallenge(error)) throw error
    onChecking?.()
    const asked = await api.get('/abuse/challenge', { query: { policy: 'links.renew' }, schema: challengeSchema })
    const nonce = await solveChallenge(asked.challenge, asked.bits)
    if (nonce === null) throw error
    await send({ challenge: asked.challenge, nonce })
  }
}
