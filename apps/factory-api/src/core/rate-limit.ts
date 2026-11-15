import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { failoverStore, memoryAbuseStore, redisAbuseStore, type AbuseStore, type WindowCount } from '../platform/abuse/store'
import { clientAddressOf } from './client-address'
import type { RequestContext } from './context'
import { ApiError } from './errors'
import { sessionSeenOf } from './manifest'

/**
 * The API's request limits (B-W2b-GF6, the Owner's decision of 11-15 on B-W2b-F57; PLT-244, A1 §3.10 "rate limits on every
 * public route"). Before, every request counted on its client address alone (core/client-address.ts), so an office and its
 * floor tablets behind one public address (NAT) shared one 300 a minute. Now:
 *
 *   budget     300 a minute per signed-in PERSON, from whatever address: the person of the session the access check read
 *              (an office user, the operator signed in on a floor device, a portal person, the holder of a one-off link),
 *              key `person:<audience>:<id>`. A request without a session (a public route: health, sign-in, public links;
 *              a session that opens nothing; a route that does not exist) spends the budget of its client address,
 *              key `anonymous:<address>`. Counted AFTER the access check (core/manifest.ts), so the person is the one the
 *              session proved: a forged cookie names nobody, and nobody can spend another person's budget.
 *   ceiling    3000 a minute per client ADDRESS over every request, signed in or not, counted as the request arrives,
 *              before any session is read (a flood costs no database work): many people behind one address, real
 *              sessions or forged ones, never pass it. Key `address:<address>`.
 *   own limit  a route with its own `config.rateLimit` (sign-in, password reset, codes, links, floor devices; counted by
 *              @fastify/rate-limit, core/security.ts, by address or by its own key) keeps it INSTEAD of the budget, as
 *              before; the ceiling counts it too.
 *
 * `budgetKeyOf` is the one place that decides whose budget a request spends. The counters are fixed windows from the
 * first hit (platform/abuse/store.ts): in Redis under the rate-limit namespace (core/app.ts rateLimitNamespace: shared by
 * every replica), in this process's memory while Redis does not answer (each replica then counts on its own, which still
 * limits) and in an app without Redis (tests). Over a limit: 429 `rate_limited` in words, with Retry-After.
 */

export interface RequestLimits {
  /** Requests per signed-in person per window; the same per client address for the requests without a session. */
  readonly max: number
  /** Requests per client address per window over every request (signed in or not): the ceiling. */
  readonly perAddressMax: number
  readonly timeWindowMs: number
}

/** The Owner's numbers (11-15): 300 a minute per person, 3000 a minute per address. */
export const DEFAULT_REQUEST_LIMITS: RequestLimits = Object.freeze({ max: 300, perAddressMax: 3000, timeWindowMs: 60_000 })

/** The ceiling of a budget given without one (a test's): ten budgets, as the Owner's 300 → 3000. */
export const CEILING_IN_BUDGETS = 10

/** The limits of an app: the Owner's numbers, or a test's budget with its own ceiling (else ten budgets). */
export function requestLimitsOf(given?: { readonly max: number; readonly timeWindowMs: number; readonly perAddressMax?: number }): RequestLimits {
  if (!given) return DEFAULT_REQUEST_LIMITS
  return { max: given.max, timeWindowMs: given.timeWindowMs, perAddressMax: given.perAddressMax ?? given.max * CEILING_IN_BUDGETS }
}

/** Whose budget: the session's person, else the client address (pure: the key rule itself). */
export function budgetKey(session: RequestContext | null, address: string): string {
  if (!session) return `anonymous:${address}`
  return session.audience === 'link' ? `person:link:${session.linkId}` : `person:${session.audience}:${session.actorId}`
}

/** THE budget a request spends: the person of the session the access check read, else its client address. */
export function budgetKeyOf(request: FastifyRequest): string {
  return budgetKey(sessionSeenOf(request), clientAddressOf(request))
}

/** The ceiling a request counts against: its client address, whoever is signed in. */
export function ceilingKeyOf(request: FastifyRequest): string {
  return `address:${clientAddressOf(request)}`
}

export const LIMIT_WORDS = Object.freeze({
  person: 'You sent too many requests in a minute. Try again shortly.',
  anonymous: 'Too many requests from this address in a minute. Try again shortly.',
  ceiling: 'Too many requests from this network address in a minute (everyone behind it together). Try again shortly.',
})

export interface RequestLimiter {
  readonly limits: RequestLimits
  /** onRequest (core/security.ts): the address ceiling over every request, before any session is read. */
  ceiling(request: FastifyRequest, reply: FastifyReply): Promise<void>
  /**
   * After the access check (core/manifest.ts, also when it refused): the budget of the request's person, or of its
   * address without a session. A route with its own limit keeps that instead.
   */
  budget(request: FastifyRequest, reply: FastifyReply): Promise<void>
}

export interface RequestLimiterOptions {
  readonly limits: RequestLimits
  /** The Redis key prefix (core/app.ts rateLimitNamespace). */
  readonly namespace: string
  /** Shared counters; without it, this process's memory. */
  readonly redis?: Redis | undefined
  /** Where the switch to memory and back is logged (once each). */
  readonly log?: { warn(object: object, message: string): void; info(message: string): void }
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000))

function tell(reply: FastifyReply, max: number, window: WindowCount): void {
  void reply
    .header('x-ratelimit-limit', max)
    .header('x-ratelimit-remaining', Math.max(0, max - window.count))
    .header('x-ratelimit-reset', seconds(window.resetInMs))
}

function refuse(reply: FastifyReply, max: number, window: WindowCount, words: string): never {
  tell(reply, max, window)
  void reply.header('retry-after', seconds(window.resetInMs))
  throw new ApiError('rate_limited', words)
}

export function requestLimiter(options: RequestLimiterOptions): RequestLimiter {
  const { limits, namespace } = options
  const store: AbuseStore = options.redis
    ? failoverStore(redisAbuseStore(options.redis), memoryAbuseStore(), options.log, 'the rate-limit counters')
    : memoryAbuseStore()
  const count = (key: string) => store.hit(`${namespace}${key}`, limits.timeWindowMs)
  return {
    limits,
    async ceiling(request, reply) {
      const window = await count(ceilingKeyOf(request))
      if (window.count > limits.perAddressMax) refuse(reply, limits.perAddressMax, window, LIMIT_WORDS.ceiling)
    },
    async budget(request, reply) {
      if (request.routeOptions.config?.rateLimit !== undefined) return
      const key = budgetKeyOf(request)
      const window = await count(key)
      if (window.count > limits.max) refuse(reply, limits.max, window, key.startsWith('person:') ? LIMIT_WORDS.person : LIMIT_WORDS.anonymous)
      tell(reply, limits.max, window)
    },
  }
}
