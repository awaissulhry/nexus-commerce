import { POW } from './pow'

/**
 * Bot and brute-force protection on the public routes (B-W2b-159; PLT-066; design portal.signin email-step "After 3
 * requests in 10 minutes the button is held: 'Wait 4 minutes before asking again'", links.frame "Rate-limited per address
 * and token; CAPTCHA only after suspicious traffic"). Pure: the API's abuse guard (platform/abuse) counts and asks here.
 *
 * Each public route names ONE policy. In a fixed window from the first request:
 *   perSubject       requests about one subject (a typed e-mail address with its tenant, a link token, an order reference):
 *                    above it the route answers 429 "Wait N minutes", counted the same for a known and an unknown subject;
 *   perNetwork       requests from one network (the client address; IPv6 by its /64): above it, 429 the same way;
 *   challengeAfter   suspicious traffic from one network — more requests than `hits`, or more wrong answers (codes, links,
 *                    lookups that found nothing) than `failures` — and every further request of the window must carry a
 *                    solved proof-of-work challenge (abuse/pow.ts), each challenge used once. Never by default.
 * The difficulty grows with the traffic: `bits` at the threshold, one more bit per doubling above it, up to POW.maxBits.
 * Every counter lives in the API's abuse store (Redis, keyed by HMACs: no address or e-mail is stored in clear).
 *
 * The policies of steps to come are declared here so their routes only name them: `links.renew` (B-W2b-163, ask for a new
 * link) and `public.lookup` (B-W2b-166 the public DoC by code, B-W2b-170 the tracking search by order reference and
 * postcode).
 */

export interface AbusePolicy {
  readonly windowMs: number
  readonly perSubject: number
  readonly perNetwork: number
  readonly challengeAfter: { readonly hits: number; readonly failures: number }
  /** The difficulty at the threshold. */
  readonly bits: number
}

const MINUTE = 60_000

export const ABUSE_POLICIES = Object.freeze({
  /** POST /portal/signin/start: a sign-in e-mail (design: 3 per address in 10 minutes). */
  'portal.signin.start': { windowMs: 10 * MINUTE, perSubject: 3, perNetwork: 30, challengeAfter: { hits: 6, failures: 1_000 }, bits: 15 },
  /** POST /portal/signin/code: a typed 6-digit code (5 tries per code; a few codes per window). */
  'portal.signin.code': { windowMs: 15 * MINUTE, perSubject: 12, perNetwork: 60, challengeAfter: { hits: 20, failures: 6 }, bits: 15 },
  /** POST /portal/signin/link[/preview]: the e-mailed link (a 256-bit token: no guessing, only noise to slow down). */
  'portal.signin.link': { windowMs: 15 * MINUTE, perSubject: 10, perNetwork: 60, challengeAfter: { hits: 20, failures: 6 }, bits: 15 },
  /** POST /portal/step-up/start: a step-up code e-mailed to the signed-in person. */
  'portal.stepup.start': { windowMs: 10 * MINUTE, perSubject: 3, perNetwork: 30, challengeAfter: { hits: 10, failures: 1_000 }, bits: 15 },
  /** POST /portal/step-up: the step-up code typed. */
  'portal.stepup.code': { windowMs: 15 * MINUTE, perSubject: 12, perNetwork: 60, challengeAfter: { hits: 20, failures: 6 }, bits: 15 },
  /** B-W2b-163: ask for a new link (one answer whatever the token; a new link only to the address on file). */
  'links.renew': { windowMs: 10 * MINUTE, perSubject: 3, perNetwork: 20, challengeAfter: { hits: 5, failures: 5 }, bits: 15 },
  /** B-W2b-166 / B-W2b-170: public lookups by a code or an order reference (one answer for a miss). */
  'public.lookup': { windowMs: 10 * MINUTE, perSubject: 20, perNetwork: 60, challengeAfter: { hits: 20, failures: 10 }, bits: 15 },
} satisfies Record<string, AbusePolicy>)

export type AbusePolicyName = keyof typeof ABUSE_POLICIES

export const ABUSE_POLICY_NAMES = Object.freeze(Object.keys(ABUSE_POLICIES) as AbusePolicyName[])

export const isAbusePolicy = (value: unknown): value is AbusePolicyName => typeof value === 'string' && Object.hasOwn(ABUSE_POLICIES, value)

/** What the counts of one window say about one request. */
export type AbuseVerdict =
  | { readonly kind: 'allow' }
  /** Too many: wait until the window ends. */
  | { readonly kind: 'wait'; readonly retryAfterMs: number; readonly by: 'subject' | 'network' }
  /** Suspicious: a solved challenge of at least `bits` must come with the request. */
  | { readonly kind: 'challenge'; readonly bits: number }

export interface AbuseCounts {
  /** This request included. */
  readonly subjectHits: number | null
  readonly subjectResetInMs: number | null
  readonly networkHits: number
  readonly networkResetInMs: number
  readonly networkFailures: number
}

/** The difficulty for a network with this much traffic: `bits` at the threshold, +1 per doubling above it. */
export function challengeBits(policy: AbusePolicy, counts: Pick<AbuseCounts, 'networkHits' | 'networkFailures'>): number {
  const over = Math.max(counts.networkHits / Math.max(1, policy.challengeAfter.hits), counts.networkFailures / Math.max(1, policy.challengeAfter.failures))
  const extra = over > 1 ? Math.floor(Math.log2(over)) : 0
  return Math.min(POW.maxBits, policy.bits + extra)
}

/** The verdict for one request: the hard limits first (subject, then network), then suspicion. */
export function abuseVerdict(policy: AbusePolicy, counts: AbuseCounts): AbuseVerdict {
  if (counts.subjectHits !== null && counts.subjectHits > policy.perSubject) {
    return { kind: 'wait', retryAfterMs: Math.max(1_000, counts.subjectResetInMs ?? policy.windowMs), by: 'subject' }
  }
  if (counts.networkHits > policy.perNetwork) return { kind: 'wait', retryAfterMs: Math.max(1_000, counts.networkResetInMs), by: 'network' }
  if (counts.networkHits > policy.challengeAfter.hits || counts.networkFailures >= policy.challengeAfter.failures) {
    return { kind: 'challenge', bits: challengeBits(policy, counts) }
  }
  return { kind: 'allow' }
}

/** "Wait 4 minutes before asking again" (whole minutes, rounded up; under a minute in seconds). */
export function waitWords(retryAfterMs: number): string {
  if (retryAfterMs < 60_000) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
    return `Wait ${seconds} second${seconds === 1 ? '' : 's'} before asking again.`
  }
  const minutes = Math.ceil(retryAfterMs / 60_000)
  return `Wait ${minutes} minute${minutes === 1 ? '' : 's'} before asking again.`
}

/** The answer when a challenge is needed and none (or a wrong one) came. */
export const CHALLENGE_WORDS = 'There were many requests from your network. The page solves a short check on your device, then sends again.'
