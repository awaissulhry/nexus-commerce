/**
 * CC-12 — the Sponsored Display targeting dialect, in one pure place.
 *
 * Source: Amazon's Sponsored Display 3.0 document (`sponsored-display/3-0/openapi.yaml` on the Amazon Ads docs CDN, read
 * 2026-10-05) — `POST /sd/targets`, `CreateTargetingClause`, `TargetingPredicate`, `TargetingPredicateNested`,
 * `TargetingPredicateBase`. SD is NOT the Sponsored Products v3 dialect:
 *
 * | | Sponsored Products v3 (`/sp/targets`) | Sponsored Display (`/sd/targets`) |
 * |---|---|---|
 * | predicate type | `ASIN_SAME_AS`, `ASIN_CATEGORY_SAME_AS` | `asinSameAs`, `asinCategorySameAs` |
 * | body | `{ targetingClauses: [...] }` | a bare array |
 * | ids | strings | numbers |
 * | state | `ENABLED` | `enabled` |
 * | expressionType | `MANUAL` | `manual` (required) |
 *
 * Audiences (tactic T00030) are NESTED: `views` / `purchases` carry an array of predicates, and a `lookback` is required.
 * At product grain only `exactProduct` (the advertised products), `similarProduct` and `relatedProduct` may appear in
 * that array — never one named ASIN. "People who viewed the advertised products in the last 30 days" is
 * `[{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }]`.
 *
 * No live Amazon answer for these shapes exists in the repo (the builder never created an SD target that worked), so the
 * first real create needs one live confirmation.
 */

export type SdPredicate = { type: string; value?: string }
export type SdExpressionItem = { type: string; value?: string | SdPredicate[] }
export type SdExpression = SdExpressionItem[]

export type SdTargetKind = 'PRODUCT' | 'CATEGORY' | 'AUDIENCE'
export type SdAudienceType = 'VIEWS_REMARKETING' | 'PURCHASES_REMARKETING' | 'AUDIENCE'

/** The lookback windows Amazon lists per event (`POST /sd/targets` description table). */
export const SD_LOOKBACK_DAYS: Record<'views' | 'purchases', readonly number[]> = {
  views: [7, 14, 30, 60, 90],
  purchases: [7, 14, 30, 60, 90, 180, 365],
}
export const SD_DEFAULT_LOOKBACK_DAYS = 30

/** The product-grain audience scopes Amazon allows inside `views` / `purchases`. */
const SCOPES: Record<'views' | 'purchases', readonly string[]> = {
  views: ['exactProduct', 'similarProduct'],
  purchases: ['exactProduct', 'similarProduct', 'relatedProduct'],
}

const ASIN = /^[A-Z0-9]{10}$/i
const NUMERIC_ID = /^\d+$/

export class SdTargetRefused extends Error {}

/**
 * The SD-native expression for one target. Throws `SdTargetRefused` with a plain sentence for a target Amazon would
 * refuse anyway, so nothing is sent and nothing is stored.
 *
 * For an audience, `value` is the scope (`exactProduct`, `similarProduct`, `relatedProduct` or a category id), and may
 * carry its window as stored by Nexus (`exactProduct lookback=30`); `lookbackDays` wins when both are given.
 */
export function sdTargetExpression(t: { kind: string; value: string; audienceType?: string | null; lookbackDays?: number | null }): SdExpression {
  const value = String(t.value ?? '').trim()
  if (t.kind === 'PRODUCT') {
    if (!ASIN.test(value)) throw new SdTargetRefused(`"${value}" is not an ASIN. A Sponsored Display product target needs the product's 10-character ASIN.`)
    return [{ type: 'asinSameAs', value: value.toUpperCase() }]
  }
  if (t.kind === 'CATEGORY') {
    if (!NUMERIC_ID.test(value)) throw new SdTargetRefused(`"${value}" is not a category id. A Sponsored Display category target needs Amazon's numeric category id.`)
    return [{ type: 'asinCategorySameAs', value }]
  }
  if (t.kind === 'AUDIENCE') {
    const audienceType = t.audienceType ?? 'AUDIENCE'
    if (audienceType === 'AUDIENCE') {
      if (!value) throw new SdTargetRefused('An Amazon audience target needs the audience id.')
      return [{ type: 'audience', value: [{ type: 'audienceSameAs', value }] }]
    }
    const event = audienceType === 'VIEWS_REMARKETING' ? 'views' : audienceType === 'PURCHASES_REMARKETING' ? 'purchases' : null
    if (!event) throw new SdTargetRefused(`"${audienceType}" is not a Sponsored Display audience type.`)
    const m = /^(\S+)(?:\s+lookback=(\d+))?$/.exec(value)
    const scope = m?.[1] ?? ''
    const lookback = t.lookbackDays ?? (m?.[2] ? Number(m[2]) : SD_DEFAULT_LOOKBACK_DAYS)
    if (!SD_LOOKBACK_DAYS[event].includes(lookback)) {
      throw new SdTargetRefused(`Amazon accepts a ${event} window of ${SD_LOOKBACK_DAYS[event].join(', ')} days, not ${lookback}.`)
    }
    let scopePredicate: SdPredicate
    if (SCOPES[event].includes(scope)) scopePredicate = { type: scope }
    else if (NUMERIC_ID.test(scope)) scopePredicate = { type: 'asinCategorySameAs', value: scope }
    else if (ASIN.test(scope)) {
      throw new SdTargetRefused(`Amazon cannot target the ${event} of one ASIN (${scope}). Use "exactProduct" for people who ${event === 'views' ? 'viewed' : 'bought'} the advertised products.`)
    } else {
      throw new SdTargetRefused(`"${scope}" is not a ${event} audience Amazon knows. Use ${SCOPES[event].join(', ')} or a category id.`)
    }
    return [{ type: event, value: [scopePredicate, { type: 'lookback', value: String(lookback) }] }]
  }
  throw new SdTargetRefused(`A Sponsored Display target is a product, a category or an audience, not "${t.kind}".`)
}

/**
 * What one SD expression names, as one line of text: the ASIN or category id of a flat clause; the scope and window of
 * a nested one (`exactProduct lookback=30`). Nexus stores this as the target's value, and the launch receipt compares
 * it with what Amazon reads back — so a nested audience is compared as text, not as `[object Object]`.
 */
export function sdExpressionValue(expression: unknown): string | undefined {
  const first = Array.isArray(expression) ? expression[0] : expression
  if (!first || typeof first !== 'object') return undefined
  const v = (first as { value?: unknown }).value
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (!Array.isArray(v)) return undefined
  const parts = v.filter((p): p is SdPredicate => !!p && typeof p === 'object')
  const scope = parts.find((p) => p.type !== 'lookback')
  const lookback = parts.find((p) => p.type === 'lookback')?.value
  const head = scope ? (scope.value != null && scope.value !== '' ? String(scope.value) : scope.type) : ''
  return [head, lookback ? `lookback=${lookback}` : ''].filter(Boolean).join(' ') || undefined
}
