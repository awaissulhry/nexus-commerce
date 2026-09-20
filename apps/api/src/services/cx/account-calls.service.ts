/**
 * P3.3 (docs/channel-connections/FINAL-PLAN.md section 6, row P3.3) — what ONE account
 * has been doing on its channel: the call ledger, the rate headroom, and the last error.
 *
 * Done when: *both screens read the same numbers.* That is why this is a service and not
 * a query inside a route. The Channels page Diagnostics and the studio's "Errors & Sync"
 * console are built by two different programmes; if each writes its own aggregate they
 * will disagree within a month, and "two names for one fact is the shape of every drift
 * defect here" is the lesson this programme keeps re-learning. One function, one answer.
 *
 * ## What was measured first (2026-09-20)
 *
 * - `OutboundApiCallLog` holds 469,469 calls. The route that reads it,
 *   `GET /sync-logs/api-calls`, filters by channel, operation, success, errorType,
 *   requestId, productId, listingId and orderId — **not by `connectionId`**. There was
 *   no way to ask the call ledger a question about an account.
 * - The Diagnostics tab reads the **connection** ledger (grants, refreshes, heartbeats)
 *   and the inbound events. It has never shown an outgoing call.
 * - Rate headroom is stored on **48 rows, all Shopify**. That is not a defect: see
 *   `headroomFor` below.
 *
 * ## And what the numbers are worth today
 *
 * Almost nothing yet, honestly. The gateway ledger is one day old, and of the 395 calls
 * recorded since it landed, **only the 48 Shopify ones are real traffic** — every eBay
 * row is a test artefact (a `conn-1` account, a sandbox host, no status code) and Amazon
 * has 2. Three channels send nothing at all until the switches in PROGRESS section 5 are
 * thrown. The screen is built and tested; it has not been read against a busy account.
 */

import type { PrismaClient } from '@prisma/client'
import prismaDefault from '../../db.js'
import type { GatewayChannel } from '../gateway/vocabulary.js'

/** How far back the account view looks, unless the caller says otherwise. */
export const DEFAULT_WINDOW_HOURS = 24

/** Never return more than this many rows, whatever the caller asks for. */
const MAX_ROWS = 100

export interface AccountCallRow {
  id: string
  operation: string
  method: string | null
  statusCode: number | null
  success: boolean | null
  latencyMs: number | null
  errorClass: string | null
  errorCode: string | null
  errorMessage: string | null
  marketplace: string | null
  triggeredBy: string | null
  listingId: string | null
  createdAt: Date
}

/**
 * Why we cannot show headroom, when we cannot.
 *
 * An empty number with no explanation reads as "zero left" or as a broken panel. Both
 * are wrong, and the second costs someone an hour. Every channel that does not report
 * headroom says so in its own words.
 */
export type HeadroomState = 'known' | 'not_reported_per_call' | 'no_calls_yet'

export interface RateHeadroom {
  state: HeadroomState
  /** Calls left in the window the channel is talking about. Null unless `known`. */
  remaining: number | null
  /** The ceiling the channel reported. Null unless `known`. */
  limit: number | null
  /** When that reading was taken. Null unless `known`. */
  asOf: Date | null
  /** One plain sentence for the operator. Always present. */
  note: string
}

export interface AccountCallsView {
  connectionId: string
  channel: string
  window: { since: Date; until: Date }
  summary: {
    total: number
    failed: number
    /** Null when there were no calls — a rate over zero calls is not 100%. */
    successRate: number | null
  }
  /** The most recent failed call, in the channel's own words. Null when there is none. */
  lastError: AccountCallRow | null
  rateHeadroom: RateHeadroom
  recent: AccountCallRow[]
}

const SELECT = {
  id: true, operation: true, method: true, statusCode: true, success: true, latencyMs: true,
  errorClass: true, errorCode: true, errorMessage: true, marketplace: true, triggeredBy: true,
  listingId: true, createdAt: true,
} as const

/**
 * What each channel can tell us about headroom on an ordinary call.
 *
 * Read from the connectors' own parsers rather than restated here, because a hardcoded
 * list of members goes stale: `services/cx/rate-readings.ts` is the authority, and this
 * is the operator-facing sentence for what each one returns.
 *
 *  - **Shopify** puts `x-shopify-shop-api-call-limit: used/max` on every REST answer and
 *    its GraphQL cost in the body. Real numbers, every call.
 *  - **Amazon SP** sends `x-amzn-RateLimit-Limit` — a RATE, not a remaining count. We
 *    can show the ceiling but never "how many left".
 *  - **eBay** sends nothing per call. Its quotas live behind a separate Analytics call
 *    (`getRateLimits`), which this installation has never made — see §6 of build/P3.3.md.
 *  - **Amazon Ads** and **Etsy** answer only on a 429.
 */
const NO_PER_CALL_HEADROOM: Partial<Record<string, string>> = {
  EBAY: 'eBay does not report its quota on a call. It publishes the remaining counts through a separate Analytics call, which Nexus does not make yet.',
  AMAZON: 'Amazon reports its rate limit but not how much is left, so a remaining count cannot be shown.',
  AMAZON_ADS: 'Amazon Ads reports its limit only when it refuses a call (429).',
  ETSY: 'Etsy reports its limit only when it refuses a call (429).',
}

function headroomFrom(
  channel: string,
  row: { rateLimitRemaining: number | null; rateLimitLimit: number | null; createdAt: Date } | null,
  anyCalls: boolean,
): RateHeadroom {
  if (row && row.rateLimitRemaining != null) {
    return {
      state: 'known',
      remaining: row.rateLimitRemaining,
      limit: row.rateLimitLimit,
      asOf: row.createdAt,
      note: row.rateLimitLimit != null
        ? `${row.rateLimitRemaining} of ${row.rateLimitLimit} left when ${channel} last answered.`
        : `${row.rateLimitRemaining} left when ${channel} last answered.`,
    }
  }
  const reason = NO_PER_CALL_HEADROOM[channel.toUpperCase()]
  if (reason) return { state: 'not_reported_per_call', remaining: null, limit: null, asOf: null, note: reason }
  return {
    state: anyCalls ? 'not_reported_per_call' : 'no_calls_yet',
    remaining: null, limit: null, asOf: null,
    note: anyCalls
      ? `${channel} has not reported any headroom on the calls in this window.`
      : 'No calls to this account in this window, so there is nothing to read a limit from.',
  }
}

export interface AccountCallsArgs {
  connectionId: string
  channel: string
  /** Defaults to DEFAULT_WINDOW_HOURS back from now. */
  since?: Date
  until?: Date
  take?: number
  prisma?: PrismaClient
}

/**
 * The one answer both screens read.
 *
 * Everything is scoped to `connectionId`: a write never falls back to "the only
 * connected account" (the MAP.3 ratchet refused a push for exactly that), and a panel
 * that quietly showed another account's errors would be worse than showing none.
 */
export async function accountCallsView(args: AccountCallsArgs): Promise<AccountCallsView> {
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  const until = args.until ?? new Date()
  const since = args.since ?? new Date(until.getTime() - DEFAULT_WINDOW_HOURS * 3_600_000)
  const take = Math.min(Math.max(1, args.take ?? 25), MAX_ROWS)
  const where = { connectionId: args.connectionId, createdAt: { gte: since, lte: until } }

  const [total, failed, recent, lastError, lastReading] = await Promise.all([
    prisma.outboundApiCallLog.count({ where }),
    prisma.outboundApiCallLog.count({ where: { ...where, success: false } }),
    prisma.outboundApiCallLog.findMany({ where, orderBy: { createdAt: 'desc' }, take, select: SELECT }),
    prisma.outboundApiCallLog.findFirst({
      where: { ...where, success: false }, orderBy: { createdAt: 'desc' }, select: SELECT,
    }),
    // The most recent call that carried a reading — NOT the most recent call. A channel
    // that reports headroom on some operations and not others would otherwise show
    // "unknown" the moment a quiet endpoint answered last.
    prisma.outboundApiCallLog.findFirst({
      where: { ...where, rateLimitRemaining: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { rateLimitRemaining: true, rateLimitLimit: true, createdAt: true },
    }),
  ])

  return {
    connectionId: args.connectionId,
    channel: args.channel,
    window: { since, until },
    summary: {
      total,
      failed,
      // A success rate over zero calls is not 100%. Null, and the screen says "no calls".
      successRate: total === 0 ? null : Math.round(((total - failed) / total) * 1000) / 10,
    },
    lastError: (lastError as AccountCallRow | null) ?? null,
    rateHeadroom: headroomFrom(args.channel, lastReading as never, total > 0),
    recent: recent as AccountCallRow[],
  }
}

/**
 * The same view, found by connection id alone — the shape a route needs.
 *
 * The lookup lives HERE, not in the handler. `scripts/check-route-prisma-ratchet` is
 * right that a query in an HTTP handler cannot be extracted later, because the handler
 * IS the coupling; it caught this route's `channelConnection.findUnique` on the way in.
 *
 * Returns null when there is no such connection, so the route can answer 404 without
 * knowing anything about the table.
 */
export async function accountCallsById(
  connectionId: string,
  opts: { hours?: unknown; take?: number; prisma?: PrismaClient } = {},
): Promise<AccountCallsView | null> {
  const prisma = opts.prisma ?? (prismaDefault as unknown as PrismaClient)
  const row = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, channelType: true },
  })
  if (!row) return null
  const until = new Date()
  return accountCallsView({
    connectionId: row.id,
    channel: row.channelType,
    since: new Date(until.getTime() - windowHours(opts.hours) * 3_600_000),
    until,
    take: opts.take,
    prisma,
  })
}

/** The longest window the account view will look back over. */
export const MAX_WINDOW_HOURS = 24 * 30

/**
 * The window a caller asked for, in hours.
 *
 * A bad or missing value falls back to the DEFAULT, never to zero. A zero-hour window
 * answers "no calls, no errors, nothing to see" for an account that is failing every
 * minute — a lie with a clean face, and the kind this programme keeps finding. `?hours=`
 * with nothing after it, `?hours=abc` and `?hours=-3` all mean "the caller did not say".
 */
export function windowHours(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS
  return Math.min(n, MAX_WINDOW_HOURS)
}

/** The channels whose headroom is readable from an ordinary call. Derived, not listed. */
export function reportsHeadroomPerCall(channel: GatewayChannel | string): boolean {
  return !NO_PER_CALL_HEADROOM[String(channel).toUpperCase()]
}
