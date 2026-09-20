/**
 * P3.5 (docs/channel-connections/FINAL-PLAN.md section 6, row P3.5) — the deprecation
 * watch: *the gateway reads `Deprecation` and `Sunset` headers, and Shopify's
 * deprecation header, and raises an alert.*
 *
 * Done when: *a fixture with the header raises one alert.*
 *
 * ## What was measured first (2026-09-20)
 *
 * **Nothing in `apps/api/src` reads any of these headers** — 0 occurrences of
 * `Deprecation`, `Sunset` or `x-shopify-api-deprecated-reason` outside P3.4's own alert
 * wording, with `x-shopify-shop-api-call-limit` as the positive control proving the
 * search works. The plan row is accurate.
 *
 * And `OutboundApiCallLog` stores no response headers at all, so there is **no stored
 * evidence of a real deprecation notice** to build a fixture from. Every shape below
 * comes from a specification or a vendor's documentation, and is labelled:
 *
 * | Header | Source | Confidence |
 * |---|---|---|
 * | `Sunset` | RFC 8594 | 🔶 SHAPE — standard, unobserved here |
 * | `Deprecation` | RFC 9745 (was the `draft-dalal-deprecation-header` draft) | 🔶 SHAPE |
 * | `X-Shopify-API-Deprecated-Reason` | Shopify's own documentation | 🔶 SHAPE, vendor-documented |
 *
 * ## Why the two standard headers are read as a PAIR
 *
 * They answer different questions and either can arrive alone:
 *
 *  - `Deprecation` says **it is deprecated**. It may carry a date — the date it *became*
 *    deprecated, which is in the past — or just `true`.
 *  - `Sunset` says **when it stops working**. That is the date an operator needs.
 *
 * Reading `Deprecation`'s date as the shutdown date would tell someone their integration
 * dies on a day that has already passed. The two are kept apart on purpose.
 *
 * A `Sunset` with no `Deprecation` is still a deprecation notice — RFC 8594 allows it —
 * so it counts. A `Deprecation` with no `Sunset` is real too, and means "we have not
 * said when": the alert says that rather than inventing a date.
 */

/** What a channel told us about an endpoint's future, if anything. */
export interface DeprecationNotice {
  /** The channel says this endpoint is deprecated. */
  deprecated: true
  /**
   * When it stops working, as the channel wrote it — an ISO date when we could parse
   * one, otherwise the raw header value, so the operator sees what the channel said
   * rather than nothing. Null when the channel gave no shutdown date.
   */
  sunsetAt: string | null
  /** The channel's own explanation, when it gave one (Shopify does). */
  reason: string | null
  /** Which header carried it — for the record, and so a surprise is visible. */
  via: 'sunset' | 'deprecation' | 'shopify' | 'sunset+deprecation'
}

/**
 * RFC 9745's `Deprecation` is a structured-field Date: `@1688169599`, seconds since the
 * epoch. Earlier drafts and some implementations send an IMF-fixdate instead, and some
 * send the bare string `true`.
 */
function parseDeprecationValue(raw: string): { deprecated: boolean; at: string | null } {
  const value = raw.trim()
  if (!value) return { deprecated: false, at: null }
  // `true` / `?1` — deprecated, with no date.
  if (/^(true|\?1)$/i.test(value)) return { deprecated: true, at: null }
  // `false` / `?0` — explicitly NOT deprecated. Reading this as a notice would raise an
  // alarm about an endpoint the channel just told us is fine.
  if (/^(false|\?0)$/i.test(value)) return { deprecated: false, at: null }
  const epoch = /^@(-?\d+)$/.exec(value)
  if (epoch) {
    const ms = Number(epoch[1]) * 1000
    return { deprecated: true, at: Number.isFinite(ms) ? isoOrNull(new Date(ms)) : null }
  }
  return { deprecated: true, at: isoOrNull(new Date(value)) }
}

/** An ISO date, or null when the value is not a date we can read. */
function isoOrNull(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Read a channel's answer for a deprecation notice.
 *
 * Returns null when there is none — which is the overwhelmingly common case, so this
 * runs on every gateway answer and must stay three header lookups and no allocation
 * when they are absent.
 */
export function deprecationOf(headers: Headers): DeprecationNotice | null {
  const rawDeprecation = headers.get('deprecation')
  const rawSunset = headers.get('sunset')
  const shopifyReason = headers.get('x-shopify-api-deprecated-reason')
  if (!rawDeprecation && !rawSunset && !shopifyReason) return null

  const deprecation = rawDeprecation ? parseDeprecationValue(rawDeprecation) : { deprecated: false, at: null }

  // `Deprecation: false` with nothing else is the channel saying the opposite of a
  // notice. Believe it.
  if (rawDeprecation && !deprecation.deprecated && !rawSunset && !shopifyReason) return null

  // The shutdown date comes from `Sunset` ONLY. `Deprecation`'s date is when it BECAME
  // deprecated — usually in the past — and showing that as the shutdown date would tell
  // an operator their integration dies on a day that has already gone.
  const sunsetAt = rawSunset ? (isoOrNull(new Date(rawSunset)) ?? rawSunset.trim()) : null

  const via: DeprecationNotice['via'] =
    rawSunset && deprecation.deprecated ? 'sunset+deprecation'
    : rawSunset ? 'sunset'
    : deprecation.deprecated ? 'deprecation'
    : 'shopify'

  return {
    deprecated: true,
    sunsetAt,
    reason: shopifyReason ? shopifyReason.trim() : null,
    via,
  }
}
