import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError } from '@nexus/factory-domain/core/errors'
import type { RequestContext } from '../../../core/context'
import { forgetOrigin, originOf, rememberOrigin } from './origin'
import { insertSecurityEvent, type EventInput } from './record'

/**
 * The security events' hooks (B-W2b-399; PLT-075), installed on the root by core/app.ts:
 *   onRequest          remembers the request's address hash (origin.ts) for the events its commands write (ledgers.ts)
 *   onError            PERMISSION_DENIED: a signed-in session asked for something its permissions or scope do not give (a 403
 *                      that is not "confirm with a fresh code first"), with the route and the permission the manifest names;
 *                      the same person, route and refusal at most once a minute per process (a screen that retries would
 *                      otherwise fill the log). Written in the caller's own scope; a failure is logged, never answered.
 *   onResponse, onRequestAbort   forget the address.
 */

const REPEAT_MS = 60_000
const MAX_REMEMBERED = 5_000
const recent = new Map<string, number>()

/** True the first time in a minute for this tenant, person and route. */
function firstInAWhile(key: string, now: number): boolean {
  const last = recent.get(key)
  if (last !== undefined && now - last < REPEAT_MS) return false
  if (recent.size >= MAX_REMEMBERED) {
    for (const [old, at] of recent) if (now - at >= REPEAT_MS) recent.delete(old)
    if (recent.size >= MAX_REMEMBERED) recent.clear()
  }
  recent.set(key, now)
  return true
}

/** Who and where a refused session is, as a security event names it. */
function deniedOf(context: RequestContext): Pick<EventInput, 'surface' | 'actorId' | 'siteId' | 'partyId'> | null {
  switch (context.audience) {
    case 'office':
      return { surface: 'OFFICE', actorId: context.actorId, siteId: null, partyId: null }
    case 'floor':
      return { surface: 'FLOOR', actorId: context.actorId, siteId: context.siteId, partyId: null }
    case 'partner':
      return { surface: 'PORTAL', actorId: context.actorId, siteId: null, partyId: context.partyId }
    case 'link':
      return { surface: 'LINK', actorId: context.linkId, siteId: null, partyId: context.partyId }
    default:
      return null
  }
}

const isStepUp = (error: DomainError): boolean => (error.issues ?? []).some((issue) => issue.path === 'stepUp' || issue.path.startsWith('stepUp/'))

/** Records the refusal of a signed-in request. */
async function recordDenied(request: FastifyRequest, error: unknown): Promise<boolean> {
  if (!(error instanceof DomainError) || error.code !== 'forbidden' || isStepUp(error)) return false
  const context = request.factoryContext
  if (!context || context.audience === 'platform' || context.audience === 'system') return false
  const who = deniedOf(context)
  if (!who) return false
  const route = `${request.method} ${request.routeOptions.url ?? ''}`
  const now = request.server.officeAuth?.clock.now() ?? new Date()
  if (!firstInAWhile(`${context.tenantId}|${who.actorId}|${route}`, now.getTime())) return false
  const entry = request.routeOptions.config.manifest
  const permission = entry && typeof entry.permission === 'string' && entry.permission.includes('.') ? entry.permission : undefined
  await request.withClient((client) => insertSecurityEvent(client, { kind: 'PERMISSION_DENIED', ...who, ipHash: originOf(String(request.id)), details: { route, permission } }))
  return true
}

export function installSecurityEvents(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    rememberOrigin(String(request.id), request.server.officeAuth?.secrets.ipHash(request.ip) ?? null)
  })
  app.addHook('onError', async (request, _reply, error) => {
    try {
      await recordDenied(request, error)
    } catch (failure) {
      request.log.error({ err: failure }, 'a refused request could not be recorded as a security event')
    }
  })
  app.addHook('onResponse', async (request) => forgetOrigin(String(request.id)))
  app.addHook('onRequestAbort', async (request) => forgetOrigin(String(request.id)))
}
