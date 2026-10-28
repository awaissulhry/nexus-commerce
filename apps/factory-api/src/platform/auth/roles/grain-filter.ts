import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { filterForGrains, unheldMoneyInput } from '@nexus/factory-domain/money/filter'
import { actorOf } from '../../../core/context'

/**
 * The API wall of the money grains (plan A1 §3.2 step 5, §3.11; features PLT-034, PLT-035), on every route of the
 * app (core/app.ts installs it):
 *   - an answer is shaped by its response contract for the caller's grains: a field marked `money.<grain>()` is
 *     dropped unless the caller holds the grain, and a `grainedJson()` field (an audit row's before/after) loses its
 *     unheld `markMoney` values (factory-domain money/filter);
 *   - a request body that sends a marked field whose grain the caller lacks is refused (403, the paths named): nobody
 *     sets a cost they may not see.
 * The grains come from the session's grants (`money.<grain>`), capped by audience (factory-domain auth/grains: floor
 * at most wages, partner and link at most price). No session (a public route) holds none.
 */

const grainsOf = (request: FastifyRequest) => heldGrains(request.factoryContext ? actorOf(request.factoryContext) : null)

type Schemas = { readonly body?: unknown; readonly response?: Readonly<Record<string, unknown>> }

const schemasOf = (request: FastifyRequest): Schemas | undefined => request.routeOptions.schema as Schemas | undefined

/** The response schema of a status: exact, then `2xx`-style, then `default`. */
function responseSchema(request: FastifyRequest, status: number): z.ZodType | undefined {
  const responses = schemasOf(request)?.response
  if (!responses) return undefined
  return (responses[status] ?? responses[`${String(status)[0]}xx`] ?? responses.default) as z.ZodType | undefined
}

export function installGrainFilter(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    const body = schemasOf(request)?.body as z.ZodType | undefined
    if (!body || request.body === undefined || request.body === null) return
    const issues = unheldMoneyInput(body, request.body, grainsOf(request))
    if (issues.length > 0) throw new DomainError('forbidden', 'This request sends money fields you may not see.', issues)
  })
  app.addHook('preSerialization', async (request, reply, payload) => {
    const schema = responseSchema(request, reply.statusCode)
    return schema ? filterForGrains(schema, payload, grainsOf(request)) : payload
  })
}
