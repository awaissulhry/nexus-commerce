/**
 * Sponsored Display extras (P3c) — one door for the calls of the SD optimization rules, budget rules, budget
 * recommendations and usage, forecasts and the brand-safety deny list (sd-rules.client.ts, sd-forecasts.client.ts,
 * sd-brand-safety.client.ts), and Amazon's answer in words.
 *
 *   the call    liveCall (ads-api-client.ts): through the channel gateway (account state, rate bucket, call ledger), with
 *               its quota and 429 / 423 / 5xx retries. A GET, a POST …/list and the read-only POSTs (gateway/ads.ts
 *               ADS_READ_POSTS) are reads; everything else is an action.
 *   sandbox     nothing is asked and nothing is made up: Nexus keeps no copy of these, so there is no sandbox answer.
 *   a refusal   Amazon's own `code` and `description` (or `details`) with the HTTP status, never a generic message.
 *   207 items   each item says SUCCESS (or a 2xx status as text: the optimization rules' `code` is "the HTTP status code
 *               of the response"); any other code is Amazon's refusal in its own words. An item with no code counts as
 *               done only when it carries the id it was asked for (`idKey`).
 */
import { adsMode, liveCall } from '../ads-api-client.js'

type SdCallOptions = Parameters<typeof liveCall>[0]

/** Why nothing was asked: the server runs Amazon Ads in sandbox mode. */
export const SD_SANDBOX = 'Amazon Ads runs in sandbox mode on this server (NEXUS_AMAZON_ADS_MODE): nothing was asked of Amazon, and nothing is made up.'

/** A call that did not give an answer Nexus can use, said as the person reads it. */
export class SdAmazonError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'SdAmazonError'
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)

/** Amazon's words in an error body: its code and description (or details, or message). Null when it says none. */
function amazonWords(body: unknown): string | null {
  let parsed = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch {
      return text(body)?.slice(0, 300) ?? null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const code = text(o.code)
  const said = text(o.description) ?? text(o.details) ?? text(o.message)
  const words = [code, said].filter(Boolean).join(' — ')
  return words ? words.slice(0, 300) : null
}

/** A failed call in one sentence: Amazon's status and words, the quota, or no answer. */
function sdErrorWords(error: unknown): string {
  if (error instanceof SdAmazonError) return error.message
  const e = error as { name?: unknown; statusCode?: unknown; body?: unknown; message?: unknown } | null
  if (e?.name === 'AmazonAdsQuotaError') return `Nexus did not ask Amazon: ${String(e.message)}.`
  if (typeof e?.statusCode === 'number') {
    const words = amazonWords(e.body)
    return `Amazon answered ${e.statusCode}${words ? `: ${words}` : ' with no reason'}.`
  }
  return `Amazon did not answer (${String(e?.message ?? error).replace(/https?:\/\/\S+/g, '(a link)').slice(0, 200)}).`
}

/** One call; a failure is thrown as SdAmazonError in words. In sandbox mode nothing is sent. */
export async function sdCall<T>(opts: SdCallOptions): Promise<T> {
  if (adsMode() === 'sandbox') throw new SdAmazonError(SD_SANDBOX)
  try {
    return await liveCall<T>(opts)
  } catch (error) {
    const status = (error as { statusCode?: unknown } | null)?.statusCode
    throw new SdAmazonError(sdErrorWords(error), typeof status === 'number' ? status : null)
  }
}

/** Is this item's code a success: SUCCESS, or a 2xx status written as text. */
function isSuccessCode(code: unknown): boolean {
  const c = text(code)?.toUpperCase()
  return c === 'SUCCESS' || (!!c && /^2\d\d$/.test(c))
}

/** One item of a 207 answer: done (ok), with the id Amazon gave; or Amazon's refusal in its own words (error). */
export interface SdItemOutcome { ok: boolean; id: string | null; error: string | null }

/** The answer Nexus could not read: never counted as done. */
export const SD_ANSWER_NOT_UNDERSTOOD = "Amazon's answer was not understood (it carries no result for this change), so Nexus does not count it as made."

/** One item of a 207 answer, read: `idKey` names the id it carries (ruleId, optimizationRuleId, …). */
export function sdItemOutcome(item: unknown, idKey: string): SdItemOutcome {
  if (!item || typeof item !== 'object') return { ok: false, id: null, error: SD_ANSWER_NOT_UNDERSTOOD }
  const o = item as Record<string, unknown>
  const id = text(o[idKey])
  const code = text(o.code)
  if (isSuccessCode(code) || (!code && id)) return { ok: true, id, error: null }
  if (!code) return { ok: false, id, error: SD_ANSWER_NOT_UNDERSTOOD }
  const said = text(o.description) ?? text(o.details)
  return { ok: false, id, error: `Amazon refused it: ${[code, said].filter(Boolean).join(' — ')}.` }
}

/** Amazon's ids are digits (campaigns, ad groups) or text (rules): a path segment, encoded. */
export const seg = (id: string): string => encodeURIComponent(String(id).trim())
