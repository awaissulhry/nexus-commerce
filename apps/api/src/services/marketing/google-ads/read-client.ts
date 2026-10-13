/**
 * Google Ads step 1a — the read client: GoogleAdsService.Search and customers:listAccessibleCustomers, through the
 * channel gateway (`googleCall`, channel GOOGLE: the account's token, its state, the rate bucket, one ledger row per
 * call). It only reads; the gateway refuses anything else.
 *
 *   POST {GOOGLE_ADS_API_BASE}/customers/{customerId}/googleAds:search   body { query, pageToken? }
 *   GET  {GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers
 *
 * `login-customer-id` goes only with a manager account; a page size is never sent. Each query costs ONE operation
 * (its first page; Google does not count the later ones); a retried first page costs one more. The gateway's own
 * retries are off: this client retries itself —
 *   transient (TRANSIENT_ERROR, INTERNAL_ERROR, 5xx, no answer)   up to 3 times, after 5 s, 10 s, 20 s (+ jitter)
 *   slow down (RESOURCE_TEMPORARILY_EXHAUSTED, 429)               once, after at least 30 s
 *   day's allowance used up (RESOURCE_EXHAUSTED)                  never; every reservation stops for an hour
 *   page token expired                                            the query starts again from page 1, once
 * Anything else (a refused query, no access, a lost sign-in) fails at once with a GoogleAdsReadError whose message
 * is a plain sentence. Never logs a token, a request body or a row.
 */
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import {
  failureFromGatewayRefusal, failureFromNoAnswer, GoogleAdsReadError, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure,
} from './errors.js'
import { customerIdDigits } from './mappers.js'
import { markQuotaExhausted } from './ops-budget.js'
import type { GoogleAdsAccessibleCustomersJson, GoogleAdsSearchPage, GoogleAdsTarget } from './types.js'

export const TRANSIENT_RETRIES = 3
export const TRANSIENT_BACKOFF_MS = [5_000, 10_000, 20_000] as const
export const SLOW_DOWN_RETRIES = 1
const MAX_JITTER_MS = 1_000
const SEARCH_TIMEOUT_MS = 120_000
const DEFAULT_MAX_PAGES = 500

export interface GoogleAdsReadOptions {
  /** The ledger's operation name (default 'ads.search' / 'ads.listAccessibleCustomers'). */
  operation?: string
  /** Waits between retries; tests use fake timers instead. */
  sleep?: (ms: number) => Promise<void>
  /** 0 … 1, for the retry jitter. */
  random?: () => number
}

export interface SearchAllOptions extends GoogleAdsReadOptions {
  /** Called before the query starts again from page 1 (Google's page token expired): drop what the pages gave so far. */
  onRestart?: () => void | Promise<void>
  /** Stop with an error past this many pages (a runaway answer). Default 500 (Google's pages hold up to 10,000 rows). */
  maxPages?: number
  timeoutMs?: number
}

export interface SearchAllResult {
  /** Pages and rows of the pass that completed (after a restart, the second pass only). */
  pages: number
  rows: number
  /** Operations spent, every attempt at a first page counted. */
  ops: number
  restarted: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'

interface Attempt {
  connectionId: string
  operation: string
  method: 'GET' | 'POST'
  url: string
  body?: unknown
  loginCustomerId?: string | null
  timeoutMs: number
  /** True for a query's first page: each attempt that reaches Google costs one operation. */
  costsOp: boolean
}

/** One call with this client's retry rules. Returns Google's JSON answer. `spent.ops` counts operations as they go. */
async function call<T>(attempt: Attempt, options: GoogleAdsReadOptions, spent: { ops: number }): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  let transient = 0
  let slowDown = 0
  for (;;) {
    let failure: GoogleAdsFailure
    try {
      const response = await googleCall({
        connectionId: attempt.connectionId,
        operation: attempt.operation,
        method: attempt.method,
        url: attempt.url,
        body: attempt.body,
        loginCustomerId: attempt.loginCustomerId ?? null,
        maxTransientRetries: 0,
        max429Retries: 0,
        timeoutMs: attempt.timeoutMs,
      })
      if (attempt.costsOp) spent.ops += 1
      const text = await response.text()
      if (response.ok) {
        try {
          return (text ? JSON.parse(text) : {}) as T
        } catch {
          throw new GoogleAdsReadError(localFailure('Google Ads answered with something Nexus cannot read.', 'UNREADABLE_ANSWER'), attempt.operation, spent.ops)
        }
      }
      failure = parseGoogleAdsFailure(response.status, text, response.headers)
    } catch (err) {
      if (err instanceof GoogleAdsReadError) throw err
      if (isRefusal(err)) failure = failureFromGatewayRefusal(err)
      else if (isNoAnswer(err)) {
        // No answer: the request may have reached Google, so it is counted.
        if (attempt.costsOp) spent.ops += 1
        failure = failureFromNoAnswer(err)
      } else throw err
    }
    if (failure.quotaExhausted) await markQuotaExhausted()
    if (failure.retryKind === 'transient' && transient < TRANSIENT_RETRIES) {
      await sleep(TRANSIENT_BACKOFF_MS[transient] + Math.floor(random() * MAX_JITTER_MS))
      transient += 1
      continue
    }
    if (failure.retryKind === 'slow_down' && slowDown < SLOW_DOWN_RETRIES) {
      await sleep((failure.retryAfterMs ?? 30_000) + Math.floor(random() * MAX_JITTER_MS))
      slowDown += 1
      continue
    }
    throw new GoogleAdsReadError(failure, attempt.operation, spent.ops)
  }
}

function digitsOrThrow(value: string | null | undefined, what: string, operation: string): string {
  const digits = customerIdDigits(value)
  if (!digits) throw new GoogleAdsReadError(localFailure(`The ${what} is not a Google Ads customer id. Nothing was sent.`, 'INVALID_CUSTOMER_ID'), operation)
  return digits
}

/**
 * Run one GAQL query against one account and hand every page's rows to `onPage` (1-based page number), in order.
 * Resolves when the last page was handed over; rejects with a GoogleAdsReadError (its `opsSpent` says what it cost).
 */
export async function searchAll<Row>(
  target: GoogleAdsTarget,
  query: string,
  onPage: (rows: Row[], page: number) => void | Promise<void>,
  options: SearchAllOptions = {},
): Promise<SearchAllResult> {
  const operation = options.operation ?? 'ads.search'
  const customerId = digitsOrThrow(target.customerId, 'account', operation)
  const loginCustomerId = target.loginCustomerId ? digitsOrThrow(target.loginCustomerId, 'manager account', operation) : null
  const url = `${GOOGLE_ADS_API_BASE}/customers/${customerId}/googleAds:search`
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const spent = { ops: 0 }
  let restarted = false
  let pages = 0
  let rows = 0
  let pageToken: string | null = null
  const seen = new Set<string>()
  for (;;) {
    let answer: GoogleAdsSearchPage<Row>
    try {
      answer = await call<GoogleAdsSearchPage<Row>>({
        connectionId: target.connectionId,
        operation,
        method: 'POST',
        url,
        body: pageToken ? { query, pageToken } : { query },
        loginCustomerId,
        timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
        costsOp: pageToken === null,
      }, options, spent)
    } catch (err) {
      if (err instanceof GoogleAdsReadError && err.failure.pageTokenExpired && pageToken !== null && !restarted) {
        restarted = true
        pageToken = null
        pages = 0
        rows = 0
        seen.clear()
        await options.onRestart?.()
        continue
      }
      if (err instanceof GoogleAdsReadError) throw new GoogleAdsReadError(err.failure, err.operation, spent.ops)
      throw err
    }
    const results = Array.isArray(answer.results) ? answer.results : []
    pages += 1
    rows += results.length
    await onPage(results, pages)
    const next = typeof answer.nextPageToken === 'string' && answer.nextPageToken ? answer.nextPageToken : null
    if (!next) return { pages, rows, ops: spent.ops, restarted }
    if (seen.has(next) || pages >= maxPages) {
      throw new GoogleAdsReadError(localFailure(`Google Ads kept sending pages (${pages}); Nexus stopped reading this query.`, 'TOO_MANY_PAGES'), operation, spent.ops)
    }
    seen.add(next)
    pageToken = next
  }
}

/** Every row of a query, collected (for small answers: the account row, a manager's clients). */
export async function searchRows<Row>(target: GoogleAdsTarget, query: string, options: SearchAllOptions = {}): Promise<{ rows: Row[]; ops: number }> {
  let collected: Row[] = []
  const result = await searchAll<Row>(target, query, (page) => { collected = collected.concat(page) }, {
    ...options,
    onRestart: async () => { collected = []; await options.onRestart?.() },
  })
  return { rows: collected, ops: result.ops }
}

/**
 * The Google Ads accounts the connection's login reaches directly (customer ids, digits only). Costs one operation;
 * sent without login-customer-id.
 */
export async function listAccessibleCustomers(connectionId: string, options: GoogleAdsReadOptions = {}): Promise<string[]> {
  const answer = await call<GoogleAdsAccessibleCustomersJson>({
    connectionId,
    operation: options.operation ?? 'ads.listAccessibleCustomers',
    method: 'GET',
    url: `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`,
    timeoutMs: 30_000,
    costsOp: true,
  }, options, { ops: 0 })
  const ids = (Array.isArray(answer.resourceNames) ? answer.resourceNames : [])
    .map((name) => (typeof name === 'string' ? customerIdDigits(name.split('/').pop()) : null))
    .filter((id): id is string => !!id)
  return [...new Set(ids)]
}
