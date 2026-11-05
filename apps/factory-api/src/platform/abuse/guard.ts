import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Redis } from 'ioredis'
import { ABUSE_POLICIES, abuseVerdict, CHALLENGE_WORDS, challengeBits, waitWords, type AbusePolicyName } from '@nexus/factory-domain/abuse/policies'
import { issueChallenge, POW, verifyProof } from '@nexus/factory-domain/abuse/pow'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { serverClock, type Clock } from '../../core/time'
import { loadFactoryEnv } from '../../env'
import type { AuthSecrets } from '../auth/sessions/secrets'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { failoverStore, memoryAbuseStore, redisAbuseStore, type AbuseStore, type WindowCount } from './store'

/**
 * The abuse guard of the public routes (B-W2b-159; PLT-066; plan A1 §3.10 "rate limits on every public route"; the
 * policies: factory-domain abuse/policies.ts). A public route calls `check` first thing in its handler, with the policy it
 * names, the subject the request is about (a typed address with its tenant, a link token…) and the proof the body
 * carries:
 *
 *   1. one hit is counted for the network (the client address; IPv6 by its /64) and for the subject;
 *   2. above the subject's or the network's limit: 429 "Wait N minutes before asking again." with Retry-After and the
 *      seconds in the issue `retryAfter` (the page holds its button with a countdown);
 *   3. after suspicious traffic from the network: 429 with the issue `challenge` unless the body carries a solved
 *      proof-of-work challenge (GET /abuse/challenge) of this policy, for this network, hard enough, used once;
 *   4. otherwise the route goes on. A route reports a wrong answer (a wrong code, a dead link) with `failed`: wrong answers
 *      raise the suspicion of their network.
 * Counted in the abuse store (Redis, keys are HMACs). The route-level rate limit of @fastify/rate-limit stays on top
 * (core/security.ts), per address only.
 */

export interface ProofInput {
  readonly challenge: string
  readonly nonce: string
}

export interface ChallengeView {
  readonly challenge: string
  readonly policy: AbusePolicyName
  readonly bits: number
  readonly algorithm: typeof POW.algorithm
  readonly expiresAt: string
}

export interface AbuseGuard {
  /** Counts the request; throws the 429 to answer when it must wait or bring a solved challenge. */
  check(request: FastifyRequest, reply: FastifyReply, policy: AbusePolicyName, input?: { readonly subject?: string | null; readonly proof?: ProofInput | undefined }): Promise<void>
  /** A wrong answer from the request's network under this policy (it raises the network's suspicion). */
  failed(request: FastifyRequest, policy: AbusePolicyName): Promise<void>
  /** A challenge for the request's network, as hard as its traffic asks now. */
  challenge(request: FastifyRequest, policy: AbusePolicyName): Promise<ChallengeView>
  /** A counter of a route's own under its policy and a subject (the portal's tries for an address without a code). */
  hit(policy: AbusePolicyName, name: string, subject: string, windowMs: number): Promise<WindowCount>
  /** True the first time within `ttlMs` (a per-subject gap, such as one new sign-in code a minute). */
  claim(policy: AbusePolicyName, name: string, subject: string, ttlMs: number): Promise<boolean>
  /** Forgets a counter of a route's own. */
  forget(policy: AbusePolicyName, name: string, subject: string): Promise<void>
}

export interface AbuseGuardOptions {
  readonly store: AbuseStore
  /** The HMAC key of the counters' names and of the challenges (abuseKey). */
  readonly key: Uint8Array
  /** `<FACTORY_QUEUE_PREFIX>:<FACTORY_ENV>`: every key sits under `<prefix>:abuse:`. */
  readonly prefix: string
  readonly clock?: Clock
}

/** The network a request comes from: an IPv4 address whole, IPv6 by its /64 (one household or office). */
export function networkOf(ip: string | undefined | null): string {
  if (!ip) return 'unknown'
  const clean = ip.replace(/^::ffff:/i, '').toLowerCase()
  if (!clean.includes(':')) return clean
  const [head, tail] = clean.split('::')
  const front = head ? head.split(':') : []
  const back = tail !== undefined && tail !== '' ? tail.split(':') : []
  const full = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back]
  return `${full.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`
}

/** A key of its own for the guard, derived from the server's sign-in secrets (the cookie secret, through HKDF and HMAC). */
export function abuseKey(secrets: Pick<AuthSecrets, 'recoveryCodeHash'>, use: string): Buffer {
  // recoveryCodeHash is HMAC-SHA-256 with a key derived from the cookie secret; a label no recovery code can be (it has
  // spaces) makes it a key derivation of its own.
  return Buffer.from(secrets.recoveryCodeHash(`nexus-factory derived key | ${use} | v1`), 'hex')
}

export function createAbuseGuard(options: AbuseGuardOptions): AbuseGuard {
  const clock = options.clock ?? serverClock
  const name = (policy: string, kind: string, value: string) =>
    `${options.prefix}:abuse:${policy}:${kind}:${createHmac('sha256', options.key).update(`${policy}|${kind}|${value}`, 'utf8').digest('base64url').slice(0, 32)}`
  const networkSubject = (request: FastifyRequest) => createHmac('sha256', options.key).update(`network|${networkOf(request.ip)}`).digest('base64url')

  async function counts(request: FastifyRequest, policy: AbusePolicyName) {
    const network = networkOf(request.ip)
    const [hits, failures] = await Promise.all([options.store.peek(name(policy, 'n', network)), options.store.peek(name(policy, 'f', network))])
    return { networkHits: hits.count, networkFailures: failures.count }
  }

  return {
    async check(request, reply, policy, input = {}) {
      const rules = ABUSE_POLICIES[policy]
      const network = networkOf(request.ip)
      const subject = input.subject ? input.subject.trim().toLowerCase() : null
      const [networkHits, subjectHits, failures] = await Promise.all([
        options.store.hit(name(policy, 'n', network), rules.windowMs),
        subject ? options.store.hit(name(policy, 's', subject), rules.windowMs) : Promise.resolve(null),
        options.store.peek(name(policy, 'f', network)),
      ])
      const verdict = abuseVerdict(rules, {
        subjectHits: subjectHits?.count ?? null,
        subjectResetInMs: subjectHits?.resetInMs ?? null,
        networkHits: networkHits.count,
        networkResetInMs: networkHits.resetInMs,
        networkFailures: failures.count,
      })
      if (verdict.kind === 'allow') return
      if (verdict.kind === 'wait') {
        const seconds = Math.ceil(verdict.retryAfterMs / 1000)
        void reply.header('retry-after', String(seconds))
        request.log.info({ policy, by: verdict.by }, 'public route held: too many requests')
        throw new DomainError('rate_limited', waitWords(verdict.retryAfterMs), [{ path: 'retryAfter', message: String(seconds) }])
      }
      const proof = input.proof
      if (proof) {
        const outcome = verifyProof(options.key, proof, { policy, subject: networkSubject(request), minBits: verdict.bits, now: clock.now() })
        if (outcome.ok && (await options.store.claimOnce(name(policy, 'p', outcome.salt), POW.ttlMs + 60_000))) return
      }
      request.log.info({ policy, bits: verdict.bits, proof: proof ? 'refused' : 'none' }, 'public route held: a challenge is needed')
      throw new DomainError('rate_limited', CHALLENGE_WORDS, [{ path: 'challenge', message: 'Required.' }])
    },

    async failed(request, policy) {
      await options.store.hit(name(policy, 'f', networkOf(request.ip)), ABUSE_POLICIES[policy].windowMs)
    },

    async challenge(request, policy) {
      const bits = challengeBits(ABUSE_POLICIES[policy], await counts(request, policy))
      const issued = issueChallenge(options.key, { policy, bits, subject: networkSubject(request), now: clock.now() })
      return { challenge: issued.value, policy, bits: issued.bits, algorithm: POW.algorithm, expiresAt: toUtcIso(issued.expiresAt) }
    },

    hit: (policy, kind, subject, windowMs) => options.store.hit(name(policy, `x.${kind}`, subject.trim().toLowerCase()), windowMs),
    claim: (policy, kind, subject, ttlMs) => options.store.claimOnce(name(policy, `x.${kind}`, subject.trim().toLowerCase()), ttlMs),
    forget: (policy, kind, subject) => options.store.forget(name(policy, `x.${kind}`, subject.trim().toLowerCase())),
  }
}

// --- the process's guard -------------------------------------------------------------------------------------------------

let configured: AbuseGuard | undefined
let processStore: { readonly store: AbuseStore; readonly prefix: string } | undefined
const byAuth = new WeakMap<object, AbuseGuard>()

/** Tests (and a process that brings its own): the guard every route uses; undefined goes back to the default. */
export function useAbuseGuard(guard: AbuseGuard | undefined): void {
  configured = guard
}

/**
 * The process's store: Redis from apps/factory-api's env (the gateway's settings: a command waits for the connection
 * that is being made, then fails after one retry), this process's memory while it is down.
 */
function defaultStore(): { readonly store: AbuseStore; readonly prefix: string } {
  if (!processStore) {
    const env = loadFactoryEnv()
    const redis = new Redis(env.FACTORY_REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2_000 })
    redis.on('error', () => {})
    processStore = { store: failoverStore(redisAbuseStore(redis), memoryAbuseStore()), prefix: `${env.FACTORY_QUEUE_PREFIX}:${env.FACTORY_ENV}` }
  }
  return processStore
}

/** The guard of an app: the configured one, else one per office sign-in object (its secrets and clock), on the process's store. */
export function abuseGuardOf(app: FastifyInstance): AbuseGuard {
  if (configured) return configured
  const auth = officeAuthOf(app)
  let guard = byAuth.get(auth)
  if (!guard) {
    const { store, prefix } = defaultStore()
    guard = createAbuseGuard({ store, prefix, key: abuseKey(auth.secrets, 'abuse-guard'), clock: auth.clock })
    byAuth.set(auth, guard)
  }
  return guard
}
