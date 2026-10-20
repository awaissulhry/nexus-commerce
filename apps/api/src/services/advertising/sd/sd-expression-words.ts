/**
 * SD-AUD (2026-10-20) — one Sponsored Display targeting expression in plain words, the one place that says it.
 *
 * Every shape of Amazon's SD v3 grammar (`TargetingExpression` in the SD 3.0 openapi: `TargetingPredicate`,
 * `TargetingPredicateLegacy`, `ContentTargetingPredicate`, `TargetingPredicateNested` with `TargetingPredicateBase`, and
 * `NegativeTargetingExpression`):
 *
 *   [{ type: 'asinSameAs', value: 'B0FX…' }]                                     → product B0FX…
 *   [{ type: 'similarProduct' }]                                                → products similar to the advertised products
 *   [{ type: 'asinCategorySameAs', value: '123' }, { type: 'asinBrandSameAs', value: '9' },
 *    { type: 'asinReviewRatingGreaterThan', value: '4' }]                       → products in category 123, brand 9, rating above 4 stars
 *   [{ type: 'views', value: [{ type: 'exactProduct' }, { type: 'lookback', value: '30' }] }]
 *                                                                               → people who viewed the advertised products in the last 30 days
 *   [{ type: 'purchases', value: [{ type: 'asinCategorySameAs', value: '123' }, { type: 'lookback', value: '90' }] }]
 *                                                                               → people who bought products in category 123 in the last 90 days
 *   [{ type: 'audience', value: [{ type: 'audienceSameAs', value: '365…' }] }]   → Amazon audience 365…
 *   [{ type: 'contentCategorySameAs', value: 'amzn1.iab-content.325' }]         → entertainment content category amzn1.iab-content.325
 *
 * With Amazon's `resolvedExpression` beside it (the same clause with names in place of ids), an id is named:
 * `category "Helmets" (123)`, `brand "Acme" (9)`, `Amazon audience "IM - Helmets" (365…)`. A type this file does not
 * know is shown as Amazon names it (`type value`), never dropped, so nothing reads as "no target".
 */

type Predicate = { type?: unknown; value?: unknown; eventType?: unknown }

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v).trim() || null)

/** An id with Amazon's name for it, when the resolved expression names it differently. */
const named = (id: string | null, name: string | null): string => {
  if (!id) return name ? `"${name}"` : '(no value)'
  return name && name !== id ? `"${name}" (${id})` : id
}

/** "10-20" (Amazon's between form) as "10 to 20". */
const between = (v: string | null): string => (v ? v.replace(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/, '$1 to $2') : '(no value)')

/** A refinement of a category (brand, price, rating, Prime, age range, genre), or null when it is not one. */
function refinementWords(type: string, value: string | null, name: string | null): string | null {
  switch (type) {
    case 'asinBrandSameAs': return `brand ${named(value, name)}`
    case 'asinPriceBetween': return `price ${between(value)}`
    case 'asinPriceGreaterThan': return `price above ${value ?? '(no value)'}`
    case 'asinPriceLessThan': return `price below ${value ?? '(no value)'}`
    case 'asinReviewRatingBetween': return `rating ${between(value)} stars`
    case 'asinReviewRatingGreaterThan': return `rating above ${value ?? '(no value)'} stars`
    case 'asinReviewRatingLessThan': return `rating below ${value ?? '(no value)'} stars`
    case 'asinIsPrimeShippingEligible': return value === 'false' ? 'not Prime shipping eligible' : 'Prime shipping eligible'
    case 'asinAgeRangeSameAs': return `age range ${named(value, name)}`
    case 'asinGenreSameAs': return `genre ${named(value, name)}`
    default: return null
  }
}

/** What a list of predicates targets: the products of a flat clause, or the products inside a views/purchases audience. */
function productsWords(parts: Array<{ type: string; value: string | null; name: string | null }>): string {
  const head: string[] = []
  const refinements: string[] = []
  for (const p of parts) {
    if (p.type === 'lookback') continue
    const r = refinementWords(p.type, p.value, p.name)
    if (r) { refinements.push(r); continue }
    switch (p.type) {
      case 'asinSameAs': head.push(`product ${named(p.value, p.name)}`); break
      case 'asinCategorySameAs': head.push(`products in category ${named(p.value, p.name)}`); break
      case 'exactProduct': head.push('the advertised products'); break
      case 'similarProduct': head.push('products similar to the advertised products'); break
      case 'relatedProduct': head.push('products related to the advertised products'); break
      case 'negative': head.push('(excluded)'); break
      case 'audiencesLikelyInterestedInAd': head.push('audiences likely interested in the ad'); break
      default: head.push(p.value ? `${p.type} ${p.value}` : p.type)
    }
  }
  // A brand (or other refinement) with no category is a negative brand target, or a theme: say the refinement alone.
  return [head.join(', '), ...refinements].filter(Boolean).join(', ') || '(no target)'
}

const flatParts = (list: Predicate[], resolved: Predicate[] | null) =>
  list.map((p, i) => {
    const type = text(p?.type) ?? '(no type)'
    const value = text(p?.value)
    const r = resolved?.[i]
    const name = r && text(r.type) === type ? text(r.value) : null
    return { type, value, name }
  })

/** One item of an expression (a flat predicate or a nested event). */
function nestedWords(item: Predicate, resolved: Predicate | null): string {
  const event = text(item.type) ?? ''
  const inner = Array.isArray(item.value) ? (item.value as Predicate[]) : []
  const innerResolved = resolved && Array.isArray(resolved.value) ? (resolved.value as Predicate[]) : null
  const parts = flatParts(inner, innerResolved)
  const lookback = parts.find((p) => p.type === 'lookback')?.value
  const window = lookback ? ` in the last ${lookback} days` : ''
  if (event === 'audience') {
    const aud = parts.find((p) => p.type === 'audienceSameAs')
    return aud ? `Amazon audience ${named(aud.value, aud.name)}` : `Amazon audience ${productsWords(parts)}`
  }
  if (event === 'views') return `people who viewed ${productsWords(parts)}${window}`
  if (event === 'purchases') return `people who bought ${productsWords(parts)}${window}`
  return `${event} ${productsWords(parts)}${window}`.trim()
}

/**
 * The whole expression in words. `resolvedExpression` (Amazon's, optional) names ids. Null when there is no expression
 * at all (a target Nexus has not read from Amazon yet), so a caller can say so rather than print an empty line.
 */
export function sdExpressionInWords(expression: unknown, resolvedExpression?: unknown): string | null {
  if (!Array.isArray(expression) || expression.length === 0) return null
  const list = expression as Predicate[]
  const resolved = Array.isArray(resolvedExpression) && resolvedExpression.length === list.length ? (resolvedExpression as Predicate[]) : null
  // Nested events (views, purchases, audience) each read as their own clause.
  if (list.some((p) => Array.isArray(p?.value))) {
    return list.map((p, i) => (Array.isArray(p?.value) ? nestedWords(p, resolved?.[i] ?? null) : productsWords(flatParts([p], resolved ? [resolved[i]] : null)))).join('; ')
  }
  const parts = flatParts(list, resolved)
  if (parts.length === 1 && parts[0].type === 'contentCategorySameAs') return `entertainment content category ${named(parts[0].value, parts[0].name)}`
  // The legacy form: similarProduct / exactProduct with eventType views (Amazon's old remarketing, no lookback).
  const legacyViews = list.some((p) => text(p?.eventType) === 'views')
  return legacyViews ? `people who viewed ${productsWords(parts)}` : productsWords(parts)
}

/** SD tactic in words: T00020 contextual targeting; T00030 audiences (which since 2024-08 also holds contextual targets). */
export function sdTacticInWords(tactic: string | null | undefined): string | null {
  if (tactic === 'T00020') return 'contextual targeting (products and categories)'
  if (tactic === 'T00030') return 'audiences (views, purchases, Amazon audiences; also products and categories)'
  return tactic ?? null
}
