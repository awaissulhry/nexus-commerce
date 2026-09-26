import type { FastifyInstance, FastifyReply } from 'fastify'
import { adoptEbayQuarantine, listOwnEbayQuarantine, EbayAdmissionError } from '../services/cx/ingress/ebay-admission.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function failure(reply: FastifyReply, error: unknown) {
  const code = error instanceof EbayAdmissionError ? error.reason : 'storage_unavailable'
  const status = code === 'adoption_forbidden' ? 403 : code === 'identity_conflict' || code === 'owner_unavailable' ? 409 : 503
  return reply.code(status).send({ code, error: status === 403
    ? 'This action requires an owner of this account’s business profile.'
    : status === 409 ? 'The notice or account ownership changed. Refresh before assigning it.'
      : 'Quarantined notices are temporarily unavailable. Refresh to confirm the current assignment.' })
}

/** The permission manifest covers /cx/connections; each service also requires a current owner. */
export default async function cxQuarantineRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store') })
  app.get<{ Params: { id: string }; Querystring: { after?: string; take?: string } }>('/cx/connections/:id/ebay-quarantine', async (request, reply) => {
    const { after, take: rawTake } = request.query
    const take = rawTake === undefined ? 50 : Number(rawTake)
    if ((after !== undefined && (typeof after !== 'string' || !UUID.test(after)))
      || !Number.isSafeInteger(take) || take < 1 || (rawTake !== undefined && (typeof rawTake !== 'string' || !/^[0-9]+$/.test(rawTake)))) {
      return reply.code(400).send({ error: 'Use a receipt cursor and a positive whole-number page size.' })
    }
    try { return reply.send(await listOwnEbayQuarantine(request.params.id, { after, take })) }
    catch (error) { return failure(reply, error) }
  })

  app.post<{ Params: { id: string; noticeId: string } }>('/cx/connections/:id/ebay-quarantine/:noticeId/adopt', async (request, reply) => {
    if (!UUID.test(request.params.noticeId)) return reply.code(400).send({ error: 'A valid retained-notice identifier is required.' })
    try {
      const result = await adoptEbayQuarantine(request.params.noticeId, request.params.id)
      // Assignment is durable routing, not a promise that a handler has completed.
      return reply.send({ assigned: true, receiptId: result.receiptId })
    } catch (error) { return failure(reply, error) }
  })
}
