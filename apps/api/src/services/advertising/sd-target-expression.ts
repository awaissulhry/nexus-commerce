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
 *
 * SD CREATE P2a (2026-10-20) — every shape checked again against the SD 3.0 document (`POST /sd/targets` description,
 * `TargetingPredicate`, `TargetingPredicateNested`, `TargetingPredicateBase`, `CreateTargetingExpression`) and Amazon's
 * audience guide ("Reference" table). Added: `similarProduct` (a flat clause with no value: "products similar to the
 * advertised ones"), and a category's refinements — brand, price, review rating, Prime — on a category target and on a
 * category-grain views / purchases audience (`asinCategorySameAs=12345 asinBrandSameAs=45678 asinPriceBetween=50-100`).
 * Fixed: `similarProduct` is a VIEWS scope only and `relatedProduct` a PURCHASES scope only — the document's tables list
 * `views(exactProduct|similarProduct …)` and `purchases(exactProduct|relatedProduct …)`, and say "A 'relatedProduct'
 * TargetingPredicateBase will target an audience that has PURCHASED a related product"; `purchases(similarProduct)` was
 * allowed here before and is in neither table.
 *
 * The value Nexus stores for a target (and reads back with `sdExpressionValue`) is one line of text that round-trips:
 *   product        `B0…` (an ASIN) or `similarProduct`
 *   category       `12345 brand=45678 price=50-100 rating>4 prime=true` (refinements optional, at most one of each)
 *   views/purchases `exactProduct lookback=30`, `12345 brand=45678 lookback=90` (a category scope takes refinements)
 *   audience       the audience id
 * Prices are in the market's currency; `price=a-b` is Amazon's "between" (not inclusive), `price>a` / `price<b` its
 * "greater / less than"; ratings likewise, 0 to 5. Prime's value is `true` (the predicate has no other).
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

/** The product-grain audience scopes Amazon lists inside `views` / `purchases` (the reference tables). */
export const SD_AUDIENCE_SCOPES: Record<'views' | 'purchases', readonly string[]> = {
  views: ['exactProduct', 'similarProduct'],
  purchases: ['exactProduct', 'relatedProduct'],
}

/** The flat clause "products similar to the advertised ones" (no value, no refinement). */
export const SD_SIMILAR_PRODUCT = 'similarProduct'

/** A category's refinements as Amazon names them, and as Nexus writes each in a target's value (`brand=…`, `price>…`). */
const REFINEMENTS: ReadonlyArray<{ type: string; token: 'brand' | 'price' | 'rating' | 'prime'; op: '=' | '>' | '<' }> = [
  { type: 'asinBrandSameAs', token: 'brand', op: '=' },
  { type: 'asinPriceBetween', token: 'price', op: '=' },
  { type: 'asinPriceGreaterThan', token: 'price', op: '>' },
  { type: 'asinPriceLessThan', token: 'price', op: '<' },
  { type: 'asinReviewRatingBetween', token: 'rating', op: '=' },
  { type: 'asinReviewRatingGreaterThan', token: 'rating', op: '>' },
  { type: 'asinReviewRatingLessThan', token: 'rating', op: '<' },
  { type: 'asinIsPrimeShippingEligible', token: 'prime', op: '=' },
]

const ASIN = /^[A-Z0-9]{10}$/i
const NUMERIC_ID = /^\d+$/
const AMOUNT = /^\d+(\.\d{1,2})?$/
const RATING = /^[0-5](\.\d)?$/
const LOOKBACK = /^lookback=(\d+)$/

export class SdTargetRefused extends Error {}

/** One refinement token (`price=50-100`) as Amazon's predicate; throws with a plain sentence for one Amazon refuses. */
function refinementOf(token: string): SdPredicate {
  const m = /^(brand|price|rating|prime)([=<>])(.+)$/.exec(token)
  const r = m ? REFINEMENTS.find((x) => x.token === m[1] && x.op === m[2]) : undefined
  if (!m || !r) throw new SdTargetRefused(`"${token}" is not a category refinement Nexus sends (brand=…, price=a-b, price>a, price<b, rating=a-b, rating>a, rating<b, prime=true).`)
  const value = m[3]
  const between = (re: RegExp, max: number | null, what: string) => {
    const [lo, hi] = value.split('-')
    if (!lo || !hi || !re.test(lo) || !re.test(hi) || Number(lo) >= Number(hi) || (max != null && Number(hi) > max)) {
      throw new SdTargetRefused(`A ${what} range is "low-high" with the low one smaller${max != null ? `, 0 to ${max}` : ''}: "${value}" is not.`)
    }
  }
  if (r.token === 'brand' && !NUMERIC_ID.test(value)) throw new SdTargetRefused(`"${value}" is not a brand id. A category refinement by brand needs Amazon's numeric brand id.`)
  if (r.token === 'price') {
    if (r.op === '=') between(AMOUNT, null, 'price')
    else if (!AMOUNT.test(value)) throw new SdTargetRefused(`"${value}" is not a price: a number in the market's currency, at most two decimals.`)
  }
  if (r.token === 'rating') {
    if (r.op === '=') between(RATING, 5, 'review rating')
    else if (!RATING.test(value) || Number(value) > 5) throw new SdTargetRefused(`"${value}" is not a review rating: Amazon's go from 0 to 5.`)
  }
  if (r.token === 'prime' && value !== 'true') throw new SdTargetRefused('Prime is a refinement of its own: prime=true (products that ship with Prime).')
  return { type: r.type, value }
}

/** A category id and its refinement tokens as Amazon's predicates: the category first, at most one of each refinement. */
function categoryPredicates(categoryId: string, tokens: readonly string[]): SdPredicate[] {
  if (!NUMERIC_ID.test(categoryId)) throw new SdTargetRefused(`"${categoryId}" is not a category id. A Sponsored Display category target needs Amazon's numeric category id.`)
  const refinements = tokens.map(refinementOf)
  const twice = (['brand', 'price', 'rating', 'prime'] as const).filter((token) => refinements.filter((p) => REFINEMENTS.find((r) => r.type === p.type)?.token === token).length > 1)
  if (twice.length) throw new SdTargetRefused(`A category target takes one ${twice.join(', one ')} refinement, not two (Amazon: "Only one brand may be specified per targeting expression").`)
  return [{ type: 'asinCategorySameAs', value: categoryId }, ...refinements]
}

/**
 * The SD-native expression for one target. Throws `SdTargetRefused` with a plain sentence for a target Amazon would
 * refuse anyway, so nothing is sent and nothing is stored.
 *
 * `value` is the line of text described above. For an audience it may carry its window (`exactProduct lookback=30`);
 * `lookbackDays` wins when both are given.
 */
export function sdTargetExpression(t: { kind: string; value: string; audienceType?: string | null; lookbackDays?: number | null }): SdExpression {
  const value = String(t.value ?? '').trim()
  if (t.kind === 'PRODUCT') {
    if (value === SD_SIMILAR_PRODUCT) return [{ type: SD_SIMILAR_PRODUCT }]
    if (!ASIN.test(value)) throw new SdTargetRefused(`"${value}" is not an ASIN. A Sponsored Display product target needs the product's 10-character ASIN.`)
    return [{ type: 'asinSameAs', value: value.toUpperCase() }]
  }
  if (t.kind === 'CATEGORY') {
    const [categoryId = '', ...tokens] = value.split(/\s+/)
    return categoryPredicates(categoryId, tokens)
  }
  if (t.kind === 'AUDIENCE') {
    const audienceType = t.audienceType ?? 'AUDIENCE'
    if (audienceType === 'AUDIENCE') {
      if (!value) throw new SdTargetRefused('An Amazon audience target needs the audience id.')
      return [{ type: 'audience', value: [{ type: 'audienceSameAs', value }] }]
    }
    const event = audienceType === 'VIEWS_REMARKETING' ? 'views' : audienceType === 'PURCHASES_REMARKETING' ? 'purchases' : null
    if (!event) throw new SdTargetRefused(`"${audienceType}" is not a Sponsored Display audience type.`)
    const tokens = value.split(/\s+/).filter(Boolean)
    const stored = tokens.map((x) => LOOKBACK.exec(x)?.[1]).find(Boolean)
    const [scope = '', ...refinements] = tokens.filter((x) => !LOOKBACK.test(x))
    const lookback = t.lookbackDays ?? (stored ? Number(stored) : SD_DEFAULT_LOOKBACK_DAYS)
    if (!SD_LOOKBACK_DAYS[event].includes(lookback)) {
      throw new SdTargetRefused(`Amazon accepts a ${event} window of ${SD_LOOKBACK_DAYS[event].join(', ')} days, not ${lookback}.`)
    }
    let scopePredicates: SdPredicate[]
    if (SD_AUDIENCE_SCOPES[event].includes(scope)) {
      if (refinements.length) throw new SdTargetRefused(`"${scope}" takes no refinement: brand, price, rating and Prime refine a category.`)
      scopePredicates = [{ type: scope }]
    } else if (NUMERIC_ID.test(scope)) scopePredicates = categoryPredicates(scope, refinements)
    else if (ASIN.test(scope)) {
      throw new SdTargetRefused(`Amazon cannot target the ${event} of one ASIN (${scope}). Use "exactProduct" for people who ${event === 'views' ? 'viewed' : 'bought'} the advertised products.`)
    } else {
      throw new SdTargetRefused(`"${scope}" is not a ${event} audience Amazon knows. Use ${SD_AUDIENCE_SCOPES[event].join(', ')} or a category id.`)
    }
    return [{ type: event, value: [...scopePredicates, { type: 'lookback', value: String(lookback) }] }]
  }
  throw new SdTargetRefused(`A Sponsored Display target is a product, a category or an audience, not "${t.kind}".`)
}

/** A refinement predicate as its token in a stored value (`price=50-100`); null for any other predicate. */
function refinementToken(p: SdPredicate): string | null {
  const r = REFINEMENTS.find((x) => x.type === p.type)
  return r && p.value != null && p.value !== '' ? `${r.token}${r.op}${p.value}` : null
}

/** The head (an ASIN, a category id, a scope, an audience id) and refinement tokens of a list of predicates, as one line. */
function predicatesText(parts: readonly SdPredicate[]): string {
  const head = parts.find((p) => p.type !== 'lookback' && !REFINEMENTS.some((r) => r.type === p.type))
  const headText = head ? (head.value != null && head.value !== '' ? String(head.value) : head.type) : ''
  const refinements = parts.map(refinementToken).filter((x): x is string => !!x)
  const lookback = parts.find((p) => p.type === 'lookback')?.value
  return [headText, ...refinements, lookback ? `lookback=${lookback}` : ''].filter(Boolean).join(' ')
}

/**
 * What one SD expression names, as one line of text: the ASIN, `similarProduct` or the category (with its refinements)
 * of a flat clause; the scope, refinements and window of a nested one (`exactProduct lookback=30`). Nexus stores this as
 * the target's value, and the launch receipt compares it with what Amazon reads back — so a nested audience is compared
 * as text, not as `[object Object]`.
 */
export function sdExpressionValue(expression: unknown): string | undefined {
  const items = (Array.isArray(expression) ? expression : [expression]).filter((p): p is SdExpressionItem => !!p && typeof p === 'object')
  const first = items[0]
  if (!first) return undefined
  if (Array.isArray(first.value)) return predicatesText(first.value.filter((p): p is SdPredicate => !!p && typeof p === 'object')) || undefined
  const flat = items.map((p) => ({ type: p.type, ...(typeof p.value === 'string' || typeof p.value === 'number' ? { value: String(p.value) } : {}) }))
  return predicatesText(flat) || undefined
}
