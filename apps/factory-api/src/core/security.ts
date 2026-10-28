import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Redis } from 'ioredis'
import { ApiError, sendError } from './errors'
import { REQUEST_ID_HEADER } from './ids'

/**
 * The web security baseline (feature PLT-244, GDPR art. 32; plan A1 §3.10 "rate limits on every public route"):
 *
 *   headers      every answer, errors and 404s included: no sniffing, no framing, no referrer, a CSP that allows
 *                nothing (the API serves JSON only), HSTS, same-origin isolation, `Cache-Control: no-store`.
 *                Fastify sends no `x-powered-by` or `server` header, and the hook removes one if a plugin adds it.
 *   CORS         only the configured web origin (FACTORY_WEB_ORIGIN), with credentials. A preflight from any other
 *                origin is refused, and so is any state-changing request that carries another Origin (a browser
 *                always sends Origin on those): a cross-site form or script cannot write, whatever its cookies.
 *   rate limit   per client address, on every route; in Redis when the app has one (shared by every replica),
 *                in memory otherwise. Routes can set a stricter `config.rateLimit` (sign-in, links).
 *   body size    1 MiB (files go to R2 by presigned URL, never through the API).
 */

export const BODY_LIMIT_BYTES = 1_048_576

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-permitted-cross-domain-policies': 'none',
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE'
/** Request headers the web may send cross-origin. */
const ALLOWED_HEADERS = ['content-type', REQUEST_ID_HEADER, 'x-csrf-token', 'x-factory-company', 'idempotency-key', 'x-factory-link'].join(', ')
const PREFLIGHT_MAX_AGE_SECONDS = '600'

export interface SecurityOptions {
  /** The factory web's origin (scheme, host and port), or undefined: then no cross-origin caller is allowed. */
  readonly webOrigin?: string | undefined
  readonly rateLimit: {
    /** Requests per client address per window. */
    readonly max: number
    readonly timeWindowMs: number
    /** Shared counters across replicas; without it, counters live in this process. */
    readonly redis?: Redis | undefined
    /** Key prefix in Redis (one per environment). */
    readonly namespace: string
  }
}

function applyCors(request: FastifyRequest, reply: FastifyReply, webOrigin: string | undefined): FastifyReply | undefined {
  const origin = request.headers.origin
  if (origin === undefined) return undefined
  const allowed = webOrigin !== undefined && origin === webOrigin
  void reply.header('vary', 'Origin')
  const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined
  if (!allowed) {
    if (preflight || UNSAFE_METHODS.has(request.method)) return sendError(reply, 'origin_not_allowed')
    return undefined
  }
  void reply.header('access-control-allow-origin', origin).header('access-control-allow-credentials', 'true')
  if (preflight) {
    return reply
      .header('access-control-allow-methods', ALLOWED_METHODS)
      .header('access-control-allow-headers', ALLOWED_HEADERS)
      .header('access-control-max-age', PREFLIGHT_MAX_AGE_SECONDS)
      .code(204)
      .send()
  }
  void reply.header('access-control-expose-headers', REQUEST_ID_HEADER)
  return undefined
}

/** Registers the baseline on the root instance. Call before any route. */
export async function registerSecurity(app: FastifyInstance, options: SecurityOptions): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, String(request.id))
    const answered = applyCors(request, reply, options.webOrigin)
    if (answered) return answered
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value)
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store')
    void reply.removeHeader('x-powered-by').removeHeader('server')
    return payload
  })

  await app.register(rateLimit, {
    global: true,
    max: options.rateLimit.max,
    timeWindow: options.rateLimit.timeWindowMs,
    ...(options.rateLimit.redis ? { redis: options.rateLimit.redis } : {}),
    nameSpace: options.rateLimit.namespace,
    // When Redis is down the API keeps answering (unlimited) and /ready reports Redis as failed.
    skipOnError: true,
    errorResponseBuilder: () => new ApiError('rate_limited'),
  })
}
