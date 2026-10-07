/**
 * Step 4 Send to FBA (Owner 2026-10-07) — the Matrix "Send to FBA…" dialog and the FBA plans drawer.
 * All under `/api/fba/inbound` → permission `inbound.manage` (permissions-manifest.ts). Zero database calls here
 * (check-route-prisma-ratchet): the route parses, calls the services through `services/fba-inbound/contract.ts`, and maps
 * a thrown `FbaSendError` to its status with `{ ok: false, code, error, problems }`.
 *
 *   GET  /fba/inbound/send-draft?productIds=a,b&from=IT-MAIN&market=IT   → 200 FbaSendDraft
 *   POST /fba/inbound/plans                     (Idempotency-Key)        → 202 { planId }
 *   GET  /fba/inbound/plans?productId=<id>&open=1                        → 200 { plans: FbaPlanView[] }
 *   GET  /fba/inbound/plans/:id                                          → 200 FbaPlanView | 404
 *   POST /fba/inbound/plans/:id/choice          (Idempotency-Key)        → 200 FbaPlanView
 *   POST /fba/inbound/plans/:id/cancel          (Idempotency-Key)        → 200 FbaPlanView
 *   POST /fba/inbound/plans/:id/retry           (Idempotency-Key)        → 200 FbaPlanView
 *   GET  /fba/inbound/shipments/:id/labels                               → 200 { downloadUrl }
 *   POST /fba/inbound/shipments/:id/shipped     (Idempotency-Key)        → 200 FbaPlanView
 *
 * Every POST is in COMMAND_SCOPES (lib/command-idempotency.ts): a double-click with one key runs once. The choice is the
 * only door to Amazon's final confirms, and it needs a signed-in person (`confirmedBy` = their user id).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { FbaChoiceRequest, FbaCreateRequest, FbaShippedRequest } from '@nexus/shared/fba-send'
import {
  cancelPlan, confirmChoice, createSendPlan, FbaSendError, labelsFor, markShipped, readPlan, readPlans, readSendDraft, retryPlan,
  type FbaActor,
} from '../services/fba-inbound/contract.js'

/** Who acts: the signed-in person's e-mail (or id), as the Matrix doors name the actor. */
function actorOf(request: FastifyRequest): FbaActor {
  const user = request.authUser
  return { actor: user?.email ?? user?.id ?? 'matrix-fba-send', userId: user?.id ?? null }
}

/** `a,b` or `productIds=a&productIds=b` → ['a', 'b']. */
function idsOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(raw.flatMap((item) => String(item).split(',')).map((id) => id.trim()).filter(Boolean))]
}

/** A thrown FbaSendError answers its status; anything else is a 500 with the message. */
async function answer<T>(reply: FastifyReply, work: () => Promise<T>, okStatus = 200) {
  try {
    const result = await work()
    return reply.code(okStatus).send(result)
  } catch (error) {
    if (error instanceof FbaSendError) {
      return reply.code(error.httpStatus).send({ ok: false, code: error.code, error: error.message, problems: error.problems })
    }
    logFailure(reply, error)
    return reply.code(500).send({ ok: false, code: 'FAILED', error: error instanceof Error ? error.message : String(error), problems: [] })
  }
}

/** Never log a request body (credentials rule): only the route and the message. */
function logFailure(reply: FastifyReply, error: unknown) {
  reply.request.log.error({ route: reply.request.routeOptions.url, message: error instanceof Error ? error.message : String(error) }, '[fba-send] failed')
}

export default async function fbaSendRoutes(app: FastifyInstance) {
  app.get('/fba/inbound/send-draft', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    const productIds = idsOf(q.productIds)
    if (productIds.length === 0) return reply.code(400).send({ ok: false, code: 'REFUSED', error: 'Name the SKUs: productIds=a,b', problems: [] })
    return answer(reply, () => readSendDraft({
      productIds,
      from: typeof q.from === 'string' && q.from.trim() ? q.from.trim() : null,
      market: typeof q.market === 'string' && q.market.trim() ? q.market.trim() : null,
    }))
  })

  app.post('/fba/inbound/plans', async (request, reply) => {
    const body = (request.body ?? {}) as FbaCreateRequest
    return answer(reply, () => createSendPlan(body, actorOf(request), 'matrix'), 202)
  })

  app.get('/fba/inbound/plans', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    const productId = typeof q.productId === 'string' && q.productId.trim() ? q.productId.trim() : null
    const open = q.open === '1' || q.open === 'true'
    return answer(reply, async () => ({ plans: await readPlans({ productId, open }) }))
  })

  app.get('/fba/inbound/plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return answer(reply, async () => {
      const plan = await readPlan(id)
      if (!plan) throw new FbaSendError('NOT_FOUND', 'FBA plan not found')
      return plan
    })
  })

  app.post('/fba/inbound/plans/:id/choice', async (request, reply) => {
    const { id } = request.params as { id: string }
    const who = actorOf(request)
    return answer(reply, () => {
      if (!who.userId) throw new FbaSendError('NEEDS_PERSON', 'Confirming with Amazon is final: a person confirms it in Nexus.')
      return confirmChoice(id, (request.body ?? {}) as FbaChoiceRequest, { actor: who.actor, userId: who.userId })
    })
  })

  app.post('/fba/inbound/plans/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string }
    return answer(reply, () => cancelPlan(id, actorOf(request)))
  })

  app.post('/fba/inbound/plans/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string }
    return answer(reply, () => retryPlan(id, actorOf(request)))
  })

  app.get('/fba/inbound/shipments/:id/labels', async (request, reply) => {
    const { id } = request.params as { id: string }
    return answer(reply, () => labelsFor(id))
  })

  app.post('/fba/inbound/shipments/:id/shipped', async (request, reply) => {
    const { id } = request.params as { id: string }
    return answer(reply, () => markShipped(id, (request.body ?? {}) as FbaShippedRequest, actorOf(request)))
  })
}
