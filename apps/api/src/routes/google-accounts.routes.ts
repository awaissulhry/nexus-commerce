/**
 * Google Ads step 1a — which Google accounts this business reads (PLAN.md contract C1–C3). The logic lives in
 * services/google/google-accounts.service.ts; this file parses, calls it and maps its errors. Nothing here changes
 * anything at Google: C2 reads what the sign-in can see, C3 saves the choice in Nexus and queues the first read.
 *
 *   GET /api/google-ads/connections                       C1  { items: GoogleAccount[] }
 *   GET /api/google-ads/connections/:id/choices[?refresh=1]  C2  what the sign-in can see (Google asked at most once per
 *                                                         5 minutes; refresh=1 asks again now)
 *   PUT /api/google-ads/connections/:id/selection         C3  { account } | 409 { code: 'not_offered' | 'customer_taken', error }
 *                                                         | 409 { code: 'taken_by_other_business', product, error }
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { logger } from '../utils/logger.js'
import {
  choicesAnswer, getChoices, GoogleConnectionNotFound, GoogleSelectionError, listGoogleAccounts, saveSelection,
} from '../services/google/google-accounts.service.js'

const actorOf = (request: unknown) => ({ userId: (request as { authUser?: { id?: string } }).authUser?.id ?? null })

function fail(reply: FastifyReply, err: unknown, what: string) {
  if (err instanceof GoogleSelectionError) {
    return reply.code(err.statusCode).send({ code: err.code, ...(err.product ? { product: err.product } : {}), error: err.message })
  }
  if (err instanceof GoogleConnectionNotFound) return reply.code(404).send({ code: 'not_found', error: 'This Google sign-in is not connected to this business.' })
  const status = (err as { statusCode?: unknown })?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return reply.code(status).send({ error: err instanceof Error ? err.message : `Nexus could not ${what}.` })
  }
  logger.error(`[google-accounts] ${what} failed`, { error: err instanceof Error ? err.message : String(err) })
  return reply.code(500).send({ error: `Nexus could not ${what}. Try again in a minute.` })
}

export default async function googleAccountsRoutes(app: FastifyInstance) {
  app.get('/google-ads/connections', async (_request, reply) => {
    try {
      return reply.send({ items: await listGoogleAccounts() })
    } catch (err) {
      return fail(reply, err, 'load the Google sign-ins')
    }
  })

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/google-ads/connections/:id/choices', async (request, reply) => {
    try {
      const force = request.query?.refresh === '1' || request.query?.refresh === 'true'
      return reply.send(choicesAnswer(await getChoices(request.params.id, { force })))
    } catch (err) {
      return fail(reply, err, 'list what this Google sign-in can see')
    }
  })

  app.put<{ Params: { id: string } }>('/google-ads/connections/:id/selection', async (request, reply) => {
    try {
      return reply.send(await saveSelection(request.params.id, request.body, actorOf(request)))
    } catch (err) {
      return fail(reply, err, 'save the Google accounts')
    }
  })
}
