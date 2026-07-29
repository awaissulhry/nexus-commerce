/**
 * AX3.3 — shapes shared between the replication builder's panels, and the small
 * amount of pure logic that runs client-side.
 *
 * Everything that decides what gets CREATED lives on the server (the pure
 * planner). What lives here is what the operator needs answered instantly while
 * typing — the product-token guess and the rename preview.
 */

export interface CopyScope {
  keywords: boolean
  negatives: boolean
  productTargets: boolean
  autoClauses: boolean
  bids: boolean
  budgets: boolean
  placementBidding: boolean
}
export const fullCopyScope = (): CopyScope => ({
  keywords: true, negatives: true, productTargets: true, autoClauses: true,
  bids: true, budgets: true, placementBidding: true,
})

export const COPY_ITEMS: Array<{ key: keyof CopyScope; label: string; hint: string }> = [
  { key: 'keywords', label: 'Keywords', hint: 'The positive keyword targeting, at its source match types.' },
  { key: 'negatives', label: 'Negative keywords & products', hint: 'The exclusions. Dropping these makes the new campaigns WIDER than the source.' },
  { key: 'productTargets', label: 'Product & category targets', hint: 'ASIN and category targeting — what a PAT campaign is made of.' },
  { key: 'autoClauses', label: 'Auto-targeting groups', hint: 'Close match, loose match, substitutes, complements. Without these an Auto campaign has nothing to target.' },
  { key: 'bids', label: 'Bids', hint: 'Per-keyword and ad-group default bids. Off: everything falls back to the ad group default.' },
  { key: 'budgets', label: 'Daily budgets', hint: 'Each campaign’s daily budget.' },
  { key: 'placementBidding', label: 'Placement modifiers', hint: 'Top-of-search and product-page bid adjustments — often a large part of why a structure performs.' },
]

export interface NamingRules {
  prefix: string
  suffix: string
  replacements: Array<{ from: string; to: string }>
}
export const emptyNaming = (): NamingRules => ({ prefix: '', suffix: '', replacements: [] })

export type PolicyMode = 'copy' | 'scale' | 'fixed'
export interface ValuePolicy { mode: PolicyMode; value: string }
export const copyPolicy = (): ValuePolicy => ({ mode: 'copy', value: '' })

/** Server response from POST /advertising/blueprints/plan-preview. */
export interface PlanConflict {
  expression: string
  existing: Array<{ campaignName: string; campaignId: string }>
  resolution: 'UNRESOLVED' | 'SKIPPED' | 'ACCEPTED'
}
export interface PlanTotals {
  campaigns: number; adGroups: number; positives: number; negatives: number
  productAds: number; dailyBudgetTotal: number
}
export interface Plan {
  productToken: string
  allowed: boolean
  blockers: string[]
  warnings: string[]
  conflicts: PlanConflict[]
  totals: PlanTotals
  excluded: { keywords: number; negatives: number; productTargets: number; autoClauses: number }
  campaigns: Array<{
    role: string; name: string; dailyBudget: number | null; targetingType: 'AUTO' | 'MANUAL'
    placementBidding: Array<{ placement: string; percentage: number }>
    adGroups: Array<{
      name: string; defaultBidCents: number | null; asins: string[]
      targets: Array<{
        expression: string; expressionType: string; kind: string; bidCents: number | null
        isNegative: boolean; negativeLevel: string | null; autoClause?: string | null
        conflictsWith?: Array<{ campaignName: string; campaignId: string }>
      }>
    }>
  }>
}
export interface PlanPreviewResponse {
  plan: Plan
  source: { campaigns: number; adGroups: number; positives: number; negatives: number; productAds: number; orphanedInSource: number }
  sharedTargets: Array<{ expression: string; targetClass: string }>
  renames: Array<{ from: string; to: string }>
}

// ── product-token guessing ────────────────────────────────────────────────

/** Words that describe a campaign's JOB, never the product it advertises. */
const STRUCTURAL = new Set([
  'IT', 'DE', 'FR', 'ES', 'UK', 'GB', 'NL', 'SE', 'PL', 'BE', 'IE', 'TR', 'US',
  'SP', 'SB', 'SD', 'AUTO', 'MANUAL', 'BROAD', 'PHRASE', 'EXACT', 'BMM', 'PAT', 'DEF',
  'CLOSE', 'LOOSE', 'SUBSTITUTE', 'SUBSTITUTES', 'COMPLEMENT', 'COMPLEMENTS',
  'BRAND', 'CATEGORY', 'COMPETITOR', 'PRODUCT', 'TARGETING', 'TARGETS', 'ADS', 'AD', 'GROUP',
  'CAMPAIGN', 'KEYWORD', 'KEYWORDS', 'KEY', 'SV', 'V1', 'V2', 'ALL', 'ASIN', 'ASINS',
])

/**
 * Guess which token in these campaign names is the product.
 *
 * The whole replication turns on getting this right — it is what gets swapped
 * out for the new product — and making the operator work it out from a set of
 * names they may not have written is a poor opening move. Scores the word that
 * appears in the MOST of the selected names, ignoring anything structural, and
 * prefers longer words on a tie. Always overridable.
 */
export function guessProductToken(names: string[]): string {
  if (!names.length) return ''
  const seenIn = new Map<string, Set<number>>()
  names.forEach((name, i) => {
    for (const raw of name.split(/[-_|\s"]+/)) {
      const t = raw.trim().replace(/[^A-Za-z0-9]/g, '')
      if (t.length < 3 || /^\d+$/.test(t)) continue
      const up = t.toUpperCase()
      if (STRUCTURAL.has(up)) continue
      const s = seenIn.get(up) ?? new Set<number>()
      s.add(i)
      seenIn.set(up, s)
    }
  })
  let best = '', bestCount = 0
  for (const [tok, idxs] of seenIn) {
    if (idxs.size > bestCount || (idxs.size === bestCount && tok.length > best.length)) { best = tok; bestCount = idxs.size }
  }
  // A token appearing in only one of many names is a coincidence, not the product.
  return bestCount >= Math.max(1, Math.ceil(names.length / 2)) ? best : ''
}

/** The client-side twin of the server's applyNaming — used only for the preview. */
export function applyNamingLocal(name: string, r: NamingRules): string {
  let out = name
  for (const rep of r.replacements) {
    if (!rep.from) continue
    out = out.replace(new RegExp(rep.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep.to ?? '')
  }
  return `${r.prefix}${out}${r.suffix}`
}

/** Substitute the new product token into a source name, as materialise() does. */
export function retoken(name: string, from: string, to: string): string {
  if (!from) return name
  return name.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to || from)
}
