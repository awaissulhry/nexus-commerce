/**
 * Google Ads programme 2, G12 (2026-10-16) — Merchant Center through the Merchant API v1 (merchantapi.googleapis.com):
 * the ONE account a read or a change of THIS business goes to, and the calls themselves, through the channel gateway
 * (`googleCall`, channel GOOGLE: the Google connection's token and state, the Merchant rate bucket, one ledger row per call).
 *
 *   account   the Merchant Center account this business chose in Nexus (its GoogleAccountLink, product MERCHANT, read
 *             through the workspace-scoped client: only this business's row). Never an id a caller names: a named id
 *             that is not the chosen one is refused in a plain sentence (ids never cross businesses).
 *   reads     GET (and the reports `…:search` POST): the gateway lets them through for the chosen account only.
 *   send      ONE Merchant change (google-merchant-calls.ts lists the paths and bodies the gateway lets through). The
 *             Merchant API has no validate_only: nothing checks it first, and a failure on Google's side, or no answer,
 *             is an UNKNOWN outcome Nexus never sends again by itself.
 *
 * Errors are Google's standard envelope ({ error: { code, message, status } }, developers.google.com/merchant/api/guides
 * — every sub-API answers it). Never logs a token, a request body or a row.
 */
import prisma from '../../../db.js'
import { googleCall, type GoogleCallRequest } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'

export const MERCHANT_API_BASE = 'https://merchantapi.googleapis.com'

export interface MerchantAccount {
  /** The Google connection (channel-connections) the calls go through. */
  accountId: string
  merchantCenterId: string
  /** The name a person chose it by (GoogleAccountLink.label). */
  name: string | null
}

export const NO_MERCHANT = 'This business has no Merchant Center account chosen in Nexus. A person chooses one in Settings › Channels › Google › Choose accounts.'

/**
 * The business's Merchant Center account, or why there is none. `accountId` (a connectionId) and `merchantCenterId` only
 * NARROW: a value that is not the chosen account's is refused, never followed.
 */
export async function merchantAccount(wanted: { accountId?: string | null; merchantCenterId?: string | null } = {}): Promise<MerchantAccount | { refusal: string }> {
  const rows = await prisma.googleAccountLink.findMany({ where: { product: 'MERCHANT' }, select: { connectionId: true, externalId: true, label: true } })
  const links = rows.filter((r) => /^\d{1,20}$/.test(r.externalId.trim()))
  if (!links.length) return { refusal: NO_MERCHANT }
  const connection = wanted.accountId?.trim()
  const id = wanted.merchantCenterId?.trim()
  const matches = links.filter((r) => (!connection || r.connectionId === connection) && (!id || r.externalId.trim() === id))
  if (!matches.length) {
    if (id && !links.some((r) => r.externalId.trim() === id)) {
      return { refusal: `Merchant Center ${id} is not the Merchant Center account this business chose in Nexus: Nexus reads and changes only that one, so ids never cross businesses. Nothing was read or changed.` }
    }
    return { refusal: `The Google account ${connection} is not the one this business chose its Merchant Center account through (channel-connections lists it).` }
  }
  if (matches.length > 1) return { refusal: `This business has ${matches.length} Merchant Center accounts: name one with merchantCenterId.` }
  const link = matches[0]
  return { accountId: link.connectionId, merchantCenterId: link.externalId.trim(), name: link.label || null }
}

// ── failures ───────────────────────────────────────────────────────────────────────────────────────────────────

export type MerchantOutcome = 'refused' | 'unknown' | 'not_sent'

/** A Merchant call that did not succeed: `outcome` says whether anything can have changed (a write). */
export class MerchantError extends Error {
  constructor(message: string, readonly operation: string, readonly outcome: MerchantOutcome, readonly httpStatus = 0, readonly status: string | null = null) {
    super(message)
    this.name = 'MerchantError'
  }
  get notFound(): boolean { return this.httpStatus === 404 }
}

export const UNKNOWN_MERCHANT_OUTCOME = 'Merchant Center did not answer (or failed on its side), so Nexus does not know whether the change was made. '
  + 'Nexus does not send it again by itself: read the account (google-merchant-live) and ask again only if it is not there.'

const MAX_MESSAGE = 300

/** One sentence for a person from Google's answer. Never a token or a request body. */
export function merchantFailureSentence(httpStatus: number, body: string): { sentence: string; status: string | null } {
  let error: { message?: unknown; status?: unknown } = {}
  try { error = (JSON.parse(body) as { error?: typeof error }).error ?? {} } catch { /* not JSON: the status says it */ }
  const status = typeof error.status === 'string' ? error.status : null
  const message = typeof error.message === 'string' ? error.message.slice(0, MAX_MESSAGE) : ''
  const google = `${status ?? `HTTP ${httpStatus}`}${message ? `: ${message}` : ''}`
  if (httpStatus === 401 && /not registered/i.test(message)) {
    return { status, sentence: 'Merchant Center has not registered the Nexus Google Cloud project yet, so Google does not let Nexus use it. Registration is a one-time step an admin of the Merchant Center account takes; Nexus does not do it in this version.' }
  }
  if (httpStatus === 401) return { status, sentence: `Google refused the sign-in (${google}): a person reconnects Google in Settings › Channels.` }
  if (httpStatus === 403) return { status, sentence: `Merchant Center refused it (${google}). The Google login Nexus uses may not have access to this Merchant Center account, or not as an administrator (Merchant Center › Settings › People and access).` }
  if (httpStatus === 429) return { status, sentence: `Merchant Center asks Nexus to slow down (${google}). Nothing was changed; try again in a minute.` }
  if (httpStatus >= 500) return { status, sentence: `Merchant Center failed on its side (${google}).` }
  return { status, sentence: `Merchant Center refused it (${google}).` }
}

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

const url = (path: string, query?: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params.set(k, String(v))
  const q = params.toString()
  return `${MERCHANT_API_BASE}/${path}${q ? `?${q}` : ''}`
}

type Json = Record<string, any>

/**
 * ONE read (GET, or a reports search POST) of the account: the answer as JSON, null when Google answers 404 and
 * `notFound` is 'null'. Anything else that is not a success rejects with a MerchantError (never a default).
 */
export async function merchantRead(
  account: MerchantAccount,
  operation: string,
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown; notFound?: 'null' | 'error' } = {},
): Promise<Json | null> {
  const request: GoogleCallRequest = {
    connectionId: account.accountId, operation, method: options.body === undefined ? 'GET' : 'POST', url: url(path, options.query),
    ...(options.body === undefined ? {} : { body: options.body }), maxTransientRetries: 1, max429Retries: 1, timeoutMs: 60_000,
  }
  let response: Response
  try {
    response = await googleCall(request)
  } catch (err) {
    if (isRefusal(err)) throw new MerchantError(err.message, operation, 'not_sent')
    if (isNoAnswer(err)) throw new MerchantError('Merchant Center did not answer. Try again in a minute.', operation, 'not_sent')
    throw err
  }
  const text = await response.text()
  if (response.ok) {
    try { return text ? JSON.parse(text) as Json : {} } catch { throw new MerchantError('Merchant Center answered with something Nexus cannot read.', operation, 'refused', response.status) }
  }
  if (response.status === 404 && options.notFound === 'null') return null
  const failure = merchantFailureSentence(response.status, text)
  throw new MerchantError(failure.sentence, operation, 'refused', response.status, failure.status)
}

/** Every page of a list (up to `maxItems` items): the items under `key`, and whether more were left unread. */
export async function merchantList(
  account: MerchantAccount,
  operation: string,
  path: string,
  key: string,
  options: { pageSize: number; maxItems: number; query?: Record<string, string | number | undefined> },
): Promise<{ items: Json[]; more: boolean }> {
  const items: Json[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 50; page++) {
    const answer = await merchantRead(account, operation, path, { query: { ...options.query, pageSize: options.pageSize, pageToken } }) ?? {}
    const list = Array.isArray(answer[key]) ? answer[key] as Json[] : []
    items.push(...list)
    pageToken = typeof answer.nextPageToken === 'string' && answer.nextPageToken ? answer.nextPageToken : undefined
    if (!pageToken) return { items, more: false }
    if (items.length >= options.maxItems) return { items: items.slice(0, options.maxItems), more: true }
  }
  return { items, more: !!pageToken }
}

// ── the change ─────────────────────────────────────────────────────────────────────────────────────────────────

/** ONE Merchant change as a draft holds it (google-merchant-calls.ts says which the gateway lets through). */
export interface MerchantCallSpec {
  method: 'POST' | 'PATCH' | 'DELETE'
  /** Under the API base, without a leading slash: `products/v1/accounts/{a}/productInputs:insert`. */
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
}

/**
 * A time the change takes when it RUNS (ending a promotion now): the draft holds this marker, so the plan a person
 * approved does not depend on the minute it was previewed; `sendMerchantCall` puts the time in just before sending.
 */
export const RUN_TIME = '@RUN_TIME'
/** One minute before the run (a promotion that has not started yet starts and ends at once). */
export const RUN_TIME_MINUS_MINUTE = '@RUN_TIME-1M'

function withRunTime(body: Record<string, unknown> | undefined, now: Date): Record<string, unknown> | undefined {
  if (!body) return body
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const before = new Date(now.getTime() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return JSON.parse(JSON.stringify(body).split(`"${RUN_TIME_MINUS_MINUTE}"`).join(`"${before}"`).split(`"${RUN_TIME}"`).join(`"${at}"`))
}

/**
 * Send ONE Merchant change. Resolves with Google's answer (the resource it wrote, or {}); rejects with a MerchantError
 * whose `outcome` says whether anything can have changed: `not_sent` (the gateway refused it), `refused` (Google answered
 * no: nothing changed), `unknown` (no answer, or Google failed on its side).
 */
export async function sendMerchantCall(account: MerchantAccount, call: MerchantCallSpec, operation: string, now = new Date()): Promise<Json> {
  const body = withRunTime(call.body, now)
  let response: Response
  try {
    response = await googleCall({
      connectionId: account.accountId, operation, method: call.method, url: url(call.path, call.query),
      ...(body === undefined ? {} : { body }), maxTransientRetries: 0, max429Retries: 0, timeoutMs: 120_000,
    })
  } catch (err) {
    if (isRefusal(err)) throw new MerchantError(err.message, operation, 'not_sent')
    if (isNoAnswer(err)) throw new MerchantError(UNKNOWN_MERCHANT_OUTCOME, operation, 'unknown')
    throw err
  }
  const text = await response.text()
  if (response.ok) {
    try { return text ? JSON.parse(text) as Json : {} } catch { return {} }
  }
  const failure = merchantFailureSentence(response.status, text)
  if (response.status >= 500) throw new MerchantError(`${failure.sentence} ${UNKNOWN_MERCHANT_OUTCOME}`, operation, 'unknown', response.status, failure.status)
  throw new MerchantError(failure.sentence, operation, 'refused', response.status, failure.status)
}
