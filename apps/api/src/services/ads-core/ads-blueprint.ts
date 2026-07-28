/**
 * AX2.4 — Structure Blueprints (read side).
 *
 * A blueprint is a named, product-agnostic description of a working campaign
 * structure: the campaign roles, the ad-group split, the match-type ladder, the
 * negatives, the bids and the placement modifiers — with everything specific to
 * one product parameterised out.
 *
 * Modelled on the real IT-AIREON-SP-* structure: 11 campaigns in one portfolio
 * (Auto · Brand/Competitor/Category × Broad/Phrase/Exact · PAT), one ad group
 * each, 40 product ads, and a keyword set that is part brand-specific
 * ("aireon jacket") and part category-generic ("giacca moto").
 *
 * THE POINT OF THE CLASSIFICATION. Copying a structure onto a sibling product
 * is only safe for the parts that are *about that product*. Category keywords
 * are shared by every jacket you sell — replicate them verbatim and your own
 * products bid against each other in Amazon's auction, raising your own
 * clearing price and splitting one pool of demand. So extraction labels every
 * target, and reports the shared surface explicitly: `sharedCategoryTargets` is
 * the exact list a replication gate has to arbitrate.
 *
 * Pure: no I/O, no Prisma. Everything here is unit-tested.
 */

export type TargetClass = 'BRAND' | 'CATEGORY' | 'COMPETITOR' | 'ASIN' | 'UNKNOWN'

export const PRODUCT_TOKEN = '{{product}}'

export interface SourceTarget {
  kind: string
  expressionType: string
  expressionValue: string
  bidCents: number | null
  isNegative: boolean
  negativeLevel: string | null
}
export interface SourceAdGroup {
  name: string
  defaultBidCents: number | null
  targets: SourceTarget[]
  asins: string[]
}
export interface SourceCampaign {
  name: string
  dailyBudget: number | null
  biddingStrategy: string | null
  placementBidding: Array<{ placement: string; percentage: number }>
  adGroups: SourceAdGroup[]
}

export interface BlueprintTarget {
  kind: string
  expressionType: string
  /** Product token replaced with {{product}} where it appeared. */
  expression: string
  bidCents: number | null
  isNegative: boolean
  negativeLevel: string | null
  targetClass: TargetClass
}
export interface BlueprintAdGroup {
  namePattern: string
  defaultBidCents: number | null
  targets: BlueprintTarget[]
  /** How many product ads the source had — the ASINs themselves are per-product. */
  productAdCount: number
}
export interface BlueprintCampaign {
  /** The part of the name that identifies this campaign's job, e.g. "Brand-Broad". */
  role: string
  namePattern: string
  dailyBudget: number | null
  biddingStrategy: string | null
  placementBidding: Array<{ placement: string; percentage: number }>
  adGroups: BlueprintAdGroup[]
}
export interface BlueprintDoc {
  version: 1
  productToken: string
  campaigns: BlueprintCampaign[]
  stats: {
    campaigns: number
    adGroups: number
    positives: number
    negatives: number
    productAds: number
    byClass: Record<TargetClass, number>
  }
  /**
   * Positive targets that are NOT specific to the source product — i.e. every
   * CATEGORY and COMPETITOR keyword. Applying these to a sibling product makes
   * your two products bid against each other in the same auction, so the
   * replication gate must arbitrate them rather than copy them blindly.
   *
   * COMPETITOR is included deliberately: two of your jackets both bidding on a
   * rival's brand term compete with each other exactly as they would on a
   * category term. Only BRAND (which re-parameterises per product) and ASIN
   * targets are genuinely product-specific.
   */
  sharedTargets: Array<{ expression: string; targetClass: TargetClass }>
}

/** Case/whitespace-insensitive token match on word boundaries. */
function hasToken(haystack: string, token: string): boolean {
  if (!token) return false
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(token.toLowerCase())}([^a-z0-9]|$)`, 'i')
  return re.test(haystack)
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Replace every occurrence of the product token with {{product}}. */
export function parameterise(value: string, productToken: string): string {
  if (!productToken) return value
  return value.replace(new RegExp(escapeRe(productToken), 'gi'), PRODUCT_TOKEN)
}

/**
 * Classify a target relative to the product the structure was built for.
 *
 * `competitorTokens` is optional and operator-supplied: a competitor keyword is
 * only knowable from the outside. Without it, a non-brand keyword is CATEGORY —
 * the conservative answer, because CATEGORY is the class the replication gate
 * treats as dangerous.
 */
export function classifyTarget(
  t: Pick<SourceTarget, 'kind' | 'expressionValue'>,
  productToken: string,
  competitorTokens: string[] = [],
  /**
   * The role of the campaign the target sits in, when known. A well-named
   * structure already encodes intent: a keyword inside "Competitor-Exact" is a
   * competitor term by construction, and that is far more reliable than
   * guessing rival brand names from the outside. The product token still wins,
   * so our own brand inside a competitor campaign stays BRAND.
   */
  role?: string,
): TargetClass {
  const v = (t.expressionValue ?? '').trim()
  if (!v) return 'UNKNOWN'
  if (t.kind && t.kind.toUpperCase() !== 'KEYWORD') {
    // PRODUCT / CATEGORY / AUDIENCE targeting — ASIN-shaped values are product targets.
    if (/^b0[a-z0-9]{8}$/i.test(v)) return 'ASIN'
    return t.kind.toUpperCase() === 'PRODUCT' ? 'ASIN' : 'CATEGORY'
  }
  if (hasToken(v, productToken)) return 'BRAND'
  for (const c of competitorTokens) if (c && hasToken(v, c)) return 'COMPETITOR'
  if (role && /^competitor\b/i.test(role)) return 'COMPETITOR'
  if (role && /^brand\b/i.test(role)) return 'BRAND'
  return 'CATEGORY'
}

/**
 * Derive a campaign's role from its name given the product token.
 * "IT-AIREON-SP-Brand-Broad" → "Brand-Broad".
 */
export function deriveRole(name: string, productToken: string): string {
  const pattern = parameterise(name, productToken)
  // Tokenise rather than chain regexes: once the product token is removed the
  // separators collapse unpredictably, and an ad-product marker can end up at
  // the start of the string where an "inner" pattern will not match it.
  const parts = pattern
    .replace(new RegExp(escapeRe(PRODUCT_TOKEN), 'g'), ' ')
    .split(/[-_\s]+/)
    .filter(Boolean)

  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    // A leading 2-letter token is the marketplace prefix (IT-, DE-, …).
    if (out.length === 0 && i < 2 && /^[a-z]{2}$/i.test(p)) continue
    // Standalone sp/sb/sd is the ad-product marker by naming convention.
    if (/^(sp|sb|sd)$/i.test(p)) continue
    out.push(p)
  }
  return out.join('-') || pattern
}

export interface ExtractOptions {
  /** The product/brand token to parameterise out, e.g. "AIREON". */
  productToken: string
  competitorTokens?: string[]
}

export function extractBlueprint(campaigns: SourceCampaign[], opts: ExtractOptions): BlueprintDoc {
  const { productToken, competitorTokens = [] } = opts
  const byClass: Record<TargetClass, number> = { BRAND: 0, CATEGORY: 0, COMPETITOR: 0, ASIN: 0, UNKNOWN: 0 }
  const shared = new Map<string, TargetClass>()
  let positives = 0, negatives = 0, adGroups = 0, productAds = 0

  const outCampaigns: BlueprintCampaign[] = campaigns.map((c) => {
    const role = deriveRole(c.name, productToken)
    const groups: BlueprintAdGroup[] = c.adGroups.map((g) => {
      adGroups++
      productAds += g.asins.length
      const targets: BlueprintTarget[] = g.targets.map((t) => {
        const targetClass = classifyTarget(t, productToken, competitorTokens, role)
        byClass[targetClass]++
        if (t.isNegative) negatives++; else positives++
        // Only POSITIVE non-product targets create self-competition. A shared
        // negative is harmless — it excludes the same traffic for both products.
        if (!t.isNegative && (targetClass === 'CATEGORY' || targetClass === 'COMPETITOR')) {
          shared.set(t.expressionValue.trim().toLowerCase(), targetClass)
        }
        return {
          kind: t.kind,
          expressionType: t.expressionType,
          expression: parameterise(t.expressionValue, productToken),
          bidCents: t.bidCents,
          isNegative: t.isNegative,
          negativeLevel: t.negativeLevel,
          targetClass,
        }
      })
      return {
        namePattern: parameterise(g.name, productToken),
        defaultBidCents: g.defaultBidCents,
        targets,
        productAdCount: g.asins.length,
      }
    })
    return {
      role,
      namePattern: parameterise(c.name, productToken),
      dailyBudget: c.dailyBudget,
      biddingStrategy: c.biddingStrategy,
      placementBidding: c.placementBidding,
      adGroups: groups,
    }
  })

  return {
    version: 1,
    productToken,
    campaigns: outCampaigns,
    stats: { campaigns: campaigns.length, adGroups, positives, negatives, productAds, byClass },
    sharedTargets: [...shared.entries()]
      .map(([expression, targetClass]) => ({ expression, targetClass }))
      .sort((a, b) => a.expression.localeCompare(b.expression)),
  }
}

// ── Diff ────────────────────────────────────────────────────────────────────

export interface BlueprintDiffEntry {
  role: string
  kind: 'MISSING_CAMPAIGN' | 'EXTRA_CAMPAIGN' | 'BUDGET' | 'BIDDING_STRATEGY' | 'MISSING_TARGET' | 'EXTRA_TARGET' | 'BID'
  detail: string
}
export interface BlueprintDiff {
  matched: number
  entries: BlueprintDiffEntry[]
  /** True when the live set matches the blueprint on every checked dimension. */
  conforms: boolean
}

/**
 * Compare a blueprint against a live campaign set, both reduced to the same
 * product-agnostic form. Answers "has this product's structure drifted from the
 * template?" — the audit use that makes blueprints worth having before any
 * write path exists.
 */
export function diffBlueprint(doc: BlueprintDoc, live: SourceCampaign[], liveProductToken: string): BlueprintDiff {
  const liveDoc = extractBlueprint(live, { productToken: liveProductToken })
  const entries: BlueprintDiffEntry[] = []

  const byRole = new Map(liveDoc.campaigns.map((c) => [c.role, c]))
  const seen = new Set<string>()
  let matched = 0

  for (const want of doc.campaigns) {
    const got = byRole.get(want.role)
    if (!got) { entries.push({ role: want.role, kind: 'MISSING_CAMPAIGN', detail: `no live campaign plays the "${want.role}" role` }); continue }
    seen.add(want.role)
    matched++

    if (want.dailyBudget != null && got.dailyBudget != null && Number(want.dailyBudget) !== Number(got.dailyBudget)) {
      entries.push({ role: want.role, kind: 'BUDGET', detail: `budget ${got.dailyBudget} ≠ blueprint ${want.dailyBudget}` })
    }
    if (want.biddingStrategy && got.biddingStrategy && want.biddingStrategy !== got.biddingStrategy) {
      entries.push({ role: want.role, kind: 'BIDDING_STRATEGY', detail: `${got.biddingStrategy} ≠ blueprint ${want.biddingStrategy}` })
    }

    const key = (t: BlueprintTarget) => `${t.expressionType}|${t.isNegative ? 'neg' : 'pos'}|${t.expression.toLowerCase()}`
    const wantT = new Map(want.adGroups.flatMap((g) => g.targets).map((t) => [key(t), t]))
    const gotT = new Map(got.adGroups.flatMap((g) => g.targets).map((t) => [key(t), t]))

    for (const [k, t] of wantT) {
      const g = gotT.get(k)
      if (!g) { entries.push({ role: want.role, kind: 'MISSING_TARGET', detail: `${t.isNegative ? 'negative ' : ''}${t.expressionType} "${t.expression}"` }); continue }
      if (t.bidCents != null && g.bidCents != null && t.bidCents !== g.bidCents) {
        entries.push({ role: want.role, kind: 'BID', detail: `"${t.expression}" bid ${g.bidCents}c ≠ blueprint ${t.bidCents}c` })
      }
    }
    for (const [k, t] of gotT) {
      if (!wantT.has(k)) entries.push({ role: want.role, kind: 'EXTRA_TARGET', detail: `${t.isNegative ? 'negative ' : ''}${t.expressionType} "${t.expression}" is not in the blueprint` })
    }
  }

  for (const c of liveDoc.campaigns) {
    if (!seen.has(c.role)) entries.push({ role: c.role, kind: 'EXTRA_CAMPAIGN', detail: `live campaign "${c.namePattern}" has no blueprint counterpart` })
  }

  return { matched, entries, conforms: entries.length === 0 }
}
