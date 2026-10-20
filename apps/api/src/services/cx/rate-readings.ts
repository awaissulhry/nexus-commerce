/**
 * How each channel reports its rate headroom, as plain functions with no other imports. The connector
 * specs use them (`rateLimit.parse`) and so does the channel gateway (services/gateway/channels.ts),
 * which must not depend on the specs having been loaded first.
 */
import type { RateLimitReading } from './catalog.js'

/** Amazon SP-API: `x-amzn-RateLimit-Limit` is the operation's sustained rate (requests per second). */
export function amazonSpRateReading(headers: Headers, status: number): RateLimitReading | null {
  const rate = headers.get('x-amzn-ratelimit-limit')
  if (status === 429) return { model: 'token_bucket', retryAfterSec: rate ? Math.ceil(1 / Number(rate)) : undefined }
  return rate ? { model: 'token_bucket', limit: Number(rate) } : null
}

/** eBay: daily quotas; only a 429 / Retry-After says anything per call. */
export function ebayRateReading(headers: Headers, status: number): RateLimitReading | null {
  const retryAfter = headers.get('retry-after')
  if (status === 429 || retryAfter) {
    return { model: 'daily_quota', retryAfterSec: retryAfter ? Number(retryAfter) : undefined }
  }
  return null
}

/** Shopify REST: `x-shopify-shop-api-call-limit: used/max`. GraphQL reports its cost in the body instead. */
export function shopifyRateReading(headers: Headers, status: number): RateLimitReading | null {
  const call = headers.get('x-shopify-shop-api-call-limit')
  if (call) {
    const [used, max] = call.split('/').map(Number)
    return { model: 'leaky_bucket', remaining: max - used, limit: max, retryAfterSec: status === 429 ? Number(headers.get('retry-after') ?? 1) : undefined }
  }
  return status === 429 ? { model: 'points', retryAfterSec: 1 } : null
}

/** Amazon Ads: only a 429 with its Retry-After. */
export function amazonAdsRateReading(headers: Headers, status: number): RateLimitReading | null {
  return status === 429 ? { model: 'token_bucket', retryAfterSec: Number(headers.get('retry-after') ?? 0) || undefined } : null
}

/** Etsy: a daily quota per app, reported on every answer. */
export function etsyRateReading(headers: Headers, status: number): RateLimitReading | null {
  const num = (name: string) => { const raw = headers.get(name); if (raw === null) return undefined; const v = Number(raw); return Number.isFinite(v) ? v : undefined }
  const remaining = num('x-remaining-today')
  const limit = num('x-limit-per-day')
  if (remaining !== undefined || limit !== undefined || status === 429) {
    return { model: 'daily_quota', remaining, limit, retryAfterSec: status === 429 ? num('retry-after') ?? 1 : undefined }
  }
  return null
}

/**
 * Google (Ads, Merchant Center, Analytics): no headroom on an ordinary answer. A 429 RESOURCE_EXHAUSTED may
 * carry a `Retry-After`; Google Ads otherwise names its wait inside the body (RetryInfo), which the gateway
 * does not read — its 429 wait then falls back to one second and the bucket stays held.
 */
export function googleRateReading(headers: Headers, status: number): RateLimitReading | null {
  return status === 429 ? { model: 'token_bucket', retryAfterSec: Number(headers.get('retry-after') ?? 0) || undefined } : null
}

/**
 * Meta (Graph and Marketing API, M1 2026-10-20): the usage headers Meta sends on ordinary answers (checked 2026-10-20:
 * developers.facebook.com/docs/graph-api/overview/rate-limiting and
 * /documentation/ads-commerce/marketing-api/overview/rate-limiting):
 *   X-Business-Use-Case-Usage (the Marketing API page calls it X-Business-Use-Case): { "<business id>": [{ type,
 *     call_count, total_cputime, total_time (percent), estimated_time_to_regain_access (minutes), ads_api_access_tier }] }
 *   X-Ad-Account-Usage: { acc_id_util_pct, reset_time_duration (seconds), ads_api_access_tier }
 *   X-FB-Ads-Insights-Throttle: { app_id_util_pct, acc_id_util_pct }
 *   X-App-Usage: { call_count, total_cputime, total_time } (platform calls; the Marketing API is not counted there)
 * The reading is the highest percent of any of them, as headroom out of 100 (`points`). Meta's own advice is to stop
 * once throttled, wait for `estimated_time_to_regain_access` or `reset_time_duration`, and avoid bursts; Nexus also
 * backs off BEFORE the block, at 75 % (research R3 §4): the account's bucket is held for the reset time Meta names, or a
 * minute when it names none. Meta answers a throttle with HTTP 400 and an error code (4, 17, 613, 80000–80014), not
 * 429, so this reading — not the status — is what holds the bucket.
 */
export const META_BACK_OFF_PCT = 75

export function metaRateReading(headers: Headers, status: number): RateLimitReading | null {
  const json = (name: string): unknown => {
    const raw = headers.get(name)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  const num = (value: unknown): number | null => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    return Number.isFinite(n) ? n : null
  }
  const percents: number[] = []
  let regainMinutes = 0
  let resetSeconds = 0
  let tier: string | undefined
  const tierOf = (value: unknown) => { if (typeof value === 'string' && value && !tier) tier = value }
  const buc = json('x-business-use-case-usage') ?? json('x-business-use-case')
  if (buc && typeof buc === 'object') {
    for (const entries of Object.values(buc as Record<string, unknown>)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const e = entry as Record<string, unknown>
        for (const key of ['call_count', 'total_cputime', 'total_time']) { const v = num(e?.[key]); if (v !== null) percents.push(v) }
        regainMinutes = Math.max(regainMinutes, num(e?.estimated_time_to_regain_access) ?? 0)
        tierOf(e?.ads_api_access_tier)
      }
    }
  }
  const account = json('x-ad-account-usage') as Record<string, unknown> | null
  if (account && typeof account === 'object') {
    const v = num(account.acc_id_util_pct); if (v !== null) percents.push(v)
    resetSeconds = Math.max(resetSeconds, num(account.reset_time_duration) ?? 0)
    tierOf(account.ads_api_access_tier)
  }
  const insights = json('x-fb-ads-insights-throttle') as Record<string, unknown> | null
  if (insights && typeof insights === 'object') {
    for (const key of ['app_id_util_pct', 'acc_id_util_pct']) { const v = num(insights[key]); if (v !== null) percents.push(v) }
  }
  const app = json('x-app-usage') as Record<string, unknown> | null
  if (app && typeof app === 'object') {
    for (const key of ['call_count', 'total_cputime', 'total_time']) { const v = num(app[key]); if (v !== null) percents.push(v) }
  }
  if (percents.length === 0 && regainMinutes === 0 && status !== 429) return null
  const used = percents.length ? Math.min(100, Math.max(...percents)) : null
  let retryAfterSec: number | undefined
  if (regainMinutes > 0) retryAfterSec = Math.ceil(regainMinutes * 60)
  else if (used !== null && used >= META_BACK_OFF_PCT) retryAfterSec = resetSeconds > 0 ? Math.ceil(resetSeconds) : 60
  else if (status === 429) retryAfterSec = Number(headers.get('retry-after') ?? 0) || 60
  return {
    model: 'points',
    ...(used !== null ? { remaining: Math.max(0, Math.round(100 - used)), limit: 100 } : {}),
    ...(retryAfterSec ? { retryAfterSec } : {}),
    ...(tier ? { tier } : {}),
  }
}

/** Meta's usage headers of one answer, spelled out for a person (meta-connection view check). Pure; null parts = not sent. */
export interface MetaUsage {
  businessUseCase: Array<{ businessId: string; type: string | null; callCountPct: number | null; cpuTimePct: number | null; totalTimePct: number | null; regainAccessMinutes: number | null; tier: string | null }>
  adAccount: { usedPct: number | null; resetSeconds: number | null; tier: string | null } | null
  insights: { appPct: number | null; accountPct: number | null } | null
  app: { callCountPct: number | null; cpuTimePct: number | null; totalTimePct: number | null } | null
  /** Meta's Marketing API access tier as the headers name it (e.g. development_access / standard_access). */
  tier: string | null
  /** The X-Ad-Api-Version-Warning header, when Meta upgraded the call from an expired version. */
  versionWarning: string | null
}

export function metaUsageOf(headers: Headers): MetaUsage {
  const json = (name: string): Record<string, unknown> | null => {
    const raw = headers.get(name)
    if (!raw) return null
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v as Record<string, unknown> : null } catch { return null }
  }
  const num = (value: unknown): number | null => { const n = typeof value === 'number' ? value : Number(value); return value === undefined || value === null || !Number.isFinite(n) ? null : n }
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  const buc = json('x-business-use-case-usage') ?? json('x-business-use-case')
  const businessUseCase: MetaUsage['businessUseCase'] = []
  for (const [businessId, entries] of Object.entries(buc ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const e = entry as Record<string, unknown>
      businessUseCase.push({ businessId, type: str(e.type), callCountPct: num(e.call_count), cpuTimePct: num(e.total_cputime), totalTimePct: num(e.total_time), regainAccessMinutes: num(e.estimated_time_to_regain_access), tier: str(e.ads_api_access_tier) })
    }
  }
  const account = json('x-ad-account-usage')
  const insights = json('x-fb-ads-insights-throttle')
  const app = json('x-app-usage')
  const adAccount = account ? { usedPct: num(account.acc_id_util_pct), resetSeconds: num(account.reset_time_duration), tier: str(account.ads_api_access_tier) } : null
  return {
    businessUseCase,
    adAccount,
    insights: insights ? { appPct: num(insights.app_id_util_pct), accountPct: num(insights.acc_id_util_pct) } : null,
    app: app ? { callCountPct: num(app.call_count), cpuTimePct: num(app.total_cputime), totalTimePct: num(app.total_time) } : null,
    tier: adAccount?.tier ?? businessUseCase.find((b) => b.tier)?.tier ?? (insights ? str(insights.ads_api_access_tier) : null),
    versionWarning: headers.get('x-ad-api-version-warning'),
  }
}
