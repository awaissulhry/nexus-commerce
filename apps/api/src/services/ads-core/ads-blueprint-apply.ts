/**
 * AX2.5 — applying a blueprint to a new product (planning + the safety gate).
 *
 * This is the half that decides WHETHER a replication may run and exactly what
 * it would create. The orchestration that actually calls Amazon lives in
 * services/advertising/ads-blueprint-apply.service.ts and refuses to run
 * unless a plan produced here says `allowed`.
 *
 * THE GATE. A blueprint's `sharedTargets` — its positive CATEGORY and
 * COMPETITOR keywords — are not about any one product, so each is checked
 * against what the market already buys. Owner rule (2026-10-06): isolation is
 * PER PRODUCT. A term one of the SAME product's campaigns already buys (one
 * whose ad group advertises one of the target's ASINs — its older campaigns
 * outside this structure) would make the product bid against itself, so that
 * clash is BLOCKING and the operator resolves each one explicitly — skip it, or
 * accept it on the record. A term ANOTHER product's campaigns buy is allowed:
 * the business has several products in one category that must be advertised on
 * the same keywords. It is listed (`sharedWithOtherProducts`, one warning) and
 * never blocks, never skips, never negates across products.
 *
 * Pure: no I/O, no Prisma. Unit-tested.
 */

import { PRODUCT_TOKEN, type AutoClause, type BlueprintDoc } from './ads-blueprint.js'

/** A product to replicate the structure onto. */
export interface ApplyTarget {
  /** Replaces {{product}} in names and brand keywords, e.g. "GALE". */
  productToken: string
  /** ASINs to advertise. Empty is allowed but yields campaigns with no ads. */
  asins: string[]
}

/** A keyword already being targeted by something we already run. */
export interface ExistingTarget {
  expression: string
  campaignName: string
  campaignId: string
  /**
   * The ASINs its ad group advertises. One shared with the target makes the
   * clash the SAME product's (a conflict); none shared, or unknown, makes it
   * another product's (listed, allowed).
   */
  asins?: readonly string[]
}

export interface PlannedTarget {
  /** AX3.4 — stable address for an edit: `c0.g1.t7`. Deterministic from the source. */
  id: string
  expression: string
  expressionType: string
  kind: string
  bidCents: number | null
  isNegative: boolean
  negativeLevel: string | null
  /** Set when this target collides with something we already run. */
  conflictsWith?: Array<{ campaignName: string; campaignId: string }>
  /** AX3.0 — the SP auto clause to re-create, for kind === 'AUTO'. */
  autoClause?: AutoClause | null
  /**
   * AX3.4 — this target is subject to the self-competition gate: a positive,
   * non-product term that is not specific to the target product. Computed once
   * during the build so the gate can be re-run over an EDITED plan without
   * re-deriving classification from the doc.
   */
  gated?: boolean
  /** AX3.4 — added by the operator in step 2 rather than copied from the source. */
  added?: boolean
  /**
   * AX3.7 — the operator rewrote this target's expression in the review step.
   *
   * Load-bearing for the gate: `gated` was derived from the SOURCE expression, so
   * once the text changes that classification describes a keyword that no longer
   * exists. Anything carrying this flag is re-classified against the target
   * product in `evaluatePlan`, exactly like an added one — otherwise renaming a
   * product-specific keyword into a category term would walk straight past the
   * self-competition check.
   */
  edited?: boolean
}
export interface PlannedAdGroup {
  /** AX3.4 — stable address for an edit: `c0.g1`. */
  id: string
  name: string
  defaultBidCents: number | null
  targets: PlannedTarget[]
  asins: string[]
}
export interface PlannedCampaign {
  /** AX3.4 — stable address for an edit: `c0`. */
  id: string
  role: string
  name: string
  dailyBudget: number | null
  biddingStrategy: string | null
  adGroups: PlannedAdGroup[]
  /** AX3.0 — carried through so an Auto campaign is created as Auto. */
  targetingType: 'AUTO' | 'MANUAL'
  /** AX3.0 — captured by the blueprint and, until now, silently discarded. */
  placementBidding: Array<{ placement: string; percentage: number }>
}

/**
 * AX3.4 — what the operator changed in the review step.
 *
 * THE CONTRACT. The client never sends a plan; it sends the EDITS it made to
 * one. The server re-plans from the source, applies these, and re-runs the whole
 * gate over the result. So an edit can narrow a replication, rename it, or
 * re-price it — and an added keyword is classified and gated exactly like a
 * copied one — but nothing can be smuggled past the self-competition check by
 * editing a JSON payload.
 *
 * Every edit addresses a node by its plan id. An id that no longer exists means
 * the plan moved under the operator (they went back and changed the source or
 * the copy scope), which is reported rather than silently ignored — applying a
 * stale edit set is how you create something nobody approved.
 */
export interface PlanEdits {
  removedCampaigns?: string[]
  removedAdGroups?: string[]
  removedTargets?: string[]
  renamedCampaigns?: Array<{ id: string; name: string }>
  renamedAdGroups?: Array<{ id: string; name: string }>
  campaignBudgets?: Array<{ id: string; dailyBudget: number }>
  adGroupBids?: Array<{ id: string; defaultBidCents: number }>
  targetBids?: Array<{ id: string; bidCents: number }>
  /** Keyed by ad-group id, because a target has to live in one. */
  addedTargets?: Array<{
    adGroupId: string
    expression: string
    expressionType: string
    kind?: string
    isNegative?: boolean
    bidCents?: number | null
  }>

  // ── AX3.7 — the rest of what `applyBlueprint` actually sends to Amazon ────
  //
  // Everything below was already read by the create path and had no way of being
  // changed before it got there. A replication that can only adjust bids, budgets
  // and names is not a review step; it is a preview with three sliders.

  /** Rewrite a keyword or product target. Re-gated — see PlannedTarget.edited. */
  targetExpressions?: Array<{ id: string; expression: string }>
  /** EXACT / PHRASE / BROAD. Negatives are EXACT or PHRASE only, on Amazon's side. */
  targetMatchTypes?: Array<{ id: string; expressionType: string }>
  /** Top-of-search / product-page / rest-of-search bid multipliers, per campaign. */
  campaignPlacements?: Array<{ id: string; placementBidding: Array<{ placement: string; percentage: number }> }>
  /** LEGACY_FOR_SALES | AUTO_FOR_SALES | MANUAL. */
  campaignBidding?: Array<{ id: string; biddingStrategy: string }>
  /** Which of the selected products this ad group advertises. Empty ⇒ none. */
  adGroupAsins?: Array<{ id: string; asins: string[] }>
}

/** Amazon's three SP placements, and the range it accepts for a multiplier. */
export const PLACEMENTS = ['PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH'] as const
export const MAX_PLACEMENT_PCT = 900
export const BIDDING_STRATEGIES = ['LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL'] as const

/** Ids referenced by an edit set that no longer exist in the freshly-built plan. */
export interface StaleEditRef { kind: 'campaign' | 'adGroup' | 'target'; id: string }

export interface ApplyConflict {
  expression: string
  /** The target product's own campaigns that already target this expression. */
  existing: Array<{ campaignName: string; campaignId: string }>
  resolution: 'UNRESOLVED' | 'SKIPPED' | 'ACCEPTED'
}

/** A gated keyword other products' campaigns also buy: allowed, listed so it is known. */
export interface SharedWithOtherProducts {
  expression: string
  existing: Array<{ campaignName: string; campaignId: string }>
}

export interface ApplyPlan {
  productToken: string
  /** Non-blocking advisories — things worth knowing before you commit. */
  warnings: string[]
  campaigns: PlannedCampaign[]
  totals: {
    campaigns: number
    adGroups: number
    positives: number
    negatives: number
    productAds: number
    /** What this replication commits per day if every campaign runs. */
    dailyBudgetTotal: number
  }
  /** Clashes with the target product's OWN campaigns. Unresolved ones block. */
  conflicts: ApplyConflict[]
  /** Gated keywords other products' campaigns also buy: never a blocker, never a conflict. */
  sharedWithOtherProducts: SharedWithOtherProducts[]
  /** Reasons the plan may not be executed. Empty ⇒ allowed. */
  blockers: string[]
  allowed: boolean
  /**
   * AX3.3 — what the copy scope deliberately left behind. Reported so "we copied
   * the structure" never quietly means "we copied most of the structure".
   */
  excluded: { keywords: number; negatives: number; productTargets: number; autoClauses: number }
  /** W4-10 — present only for a copy given translations: each term from → to, and what is missing or unused. */
  translation?: TranslationReport
}

/**
 * W4-10 — a copy into another market's language: what one source keyword (or negative keyword) becomes. `from` is the
 * term as the source campaigns hold it; `to` is the term in the target market's language, or `keep` copies it as it is
 * (a brand or model name shoppers there search for unchanged). The product swap applies to both, exactly as to a term
 * copied as it is: a source product token left in `to` becomes the target product's.
 */
export interface TermTranslation { from: string; to?: string; keep?: boolean }
export interface TranslationRules {
  keywords: TermTranslation[]
  negatives: TermTranslation[]
}

/**
 * W4-10 — what the translations did. Every keyword and negative keyword the copy carries must be translated or kept:
 * one with neither is `missing` and blocks; a translation that names no term of the source is `unused` and blocks (a
 * typo would otherwise be ignored and its term copied in the source's language). A term of an ad group that became the
 * same keyword as an earlier one there is created once, at the earlier one's bid (`merged`: `keptFrom` is that one).
 */
export interface TranslationReport {
  terms: Array<{ from: string; to: string; negative: boolean; kept: boolean }>
  missing: Array<{ term: string; negative: boolean }>
  unused: Array<{ term: string; negative: boolean }>
  merged: Array<{ from: string; to: string; negative: boolean; keptFrom: string }>
}

/**
 * What we know about the destination marketplace's ability to receive writes.
 * Supplied by the caller because the pure planner has no DB access.
 */
export interface MarketContext {
  marketplace: string
  /** production connection AND writesEnabledAt set. */
  writable: boolean
  /** Has any write ever actually reached Amazon for this market? */
  everWritten: boolean
}

export interface ApplyOptions {
  /** Shared targets the operator has chosen NOT to create. */
  skipSharedTargets?: string[]
  /** Shared targets the operator has explicitly accepted, conflict and all. */
  acceptSharedTargets?: string[]
  /** Refuse if the replication would commit more than this per day. */
  dailyBudgetCapEur?: number
  /** Destination market. Omit only when the caller has already vetted it. */
  market?: MarketContext
  /**
   * AX3.0 — every non-archived campaign name already in the destination market.
   *
   * `materialise` only rewrites a name that CONTAINS the product token. Most of
   * this account's campaigns don't: `IT_Auto_Close`, `BMM_Misano`,
   * `Auto_Loose_Moss` all survive substitution unchanged, so replicating them
   * produced a second campaign with a byte-identical name and nothing objected.
   * Two campaigns with one name is unresolvable afterwards — every report, every
   * rule and every operator lookup becomes ambiguous — so it blocks.
   */
  existingCampaignNames?: string[]
  /** AX3.3 — bulk rename, applied after the product token is substituted in. */
  naming?: NamingRules
  /** AX3.3 — which parts of the structure come across. Omitted ⇒ everything. */
  include?: Partial<CopyScope>
  /** AX3.3 — what to do with the source's bids and budgets. */
  bidPolicy?: ValuePolicy
  budgetPolicy?: ValuePolicy
  /**
   * AX3.6 — a replication that already happened for this product in this market.
   *
   * Nothing stops you replicating the same structure twice, and the second run
   * looks exactly as healthy as the first: the names differ only if you rename
   * them, the gate has no opinion about your own new campaigns, and you end up
   * with two of everything bidding against each other. Warned, not blocked —
   * re-running is legitimate after a rollback, or to add a second market.
   */
  priorRun?: { when: string; status: string; campaigns: number }
  /**
   * W4-10 — a copy into another market's language (Claude's replicate-ad-structure): every keyword and negative keyword
   * translated or kept, by its text in the source. A translated keyword is classified again against the target product
   * (`edited`), as a keyword rewritten in the review step is. Absent: every term is copied as it is (the screen).
   */
  translations?: TranslationRules
}

/**
 * AX3.3 — the bulk rename. Runs on the MATERIALISED name (after {{product}} has
 * become the target token), because that is the name Amazon will hold and the
 * name the collision gate has to check.
 *
 * `replacements` is Google Ads Editor's find-and-replace: the operator's own
 * source names are the input, so a literal, ordered, case-insensitive replace is
 * what they expect — not a regex they have to escape.
 */
export interface NamingRules {
  prefix?: string
  suffix?: string
  replacements?: Array<{ from: string; to: string }>
}

/** AX3.3 — Amazon's copy dialog lets you choose what comes across. So does this. */
export interface CopyScope {
  keywords: boolean
  negatives: boolean
  productTargets: boolean
  autoClauses: boolean
  /** Off ⇒ every bid falls back to the ad group's default. */
  bids: boolean
  /** Off ⇒ every campaign gets `budgetPolicy.value` (or 0) instead of the source's. */
  budgets: boolean
  placementBidding: boolean
}
export const FULL_COPY: CopyScope = {
  keywords: true, negatives: true, productTargets: true, autoClauses: true,
  bids: true, budgets: true, placementBidding: true,
}

/**
 * How a copied number is carried over. A bid that matured on a product with
 * months of history is not automatically the right opening bid for a product
 * with none, so "copy it verbatim" must be a choice rather than the only option.
 */
export interface ValuePolicy {
  mode: 'copy' | 'scale' | 'fixed'
  /** scale ⇒ percentage of the source (100 = unchanged). fixed ⇒ the value itself. */
  value?: number
}

const FLOOR_CENTS = 2 // Amazon's minimum bid, and our no-pause suppression floor.

function applyValuePolicy(source: number | null, policy: ValuePolicy | undefined, floor: number): number | null {
  if (!policy || policy.mode === 'copy') return source
  if (policy.mode === 'fixed') return Math.max(floor, policy.value ?? 0)
  const pct = policy.value ?? 100
  return source == null ? null : Math.max(floor, Math.round(source * (pct / 100)))
}

/**
 * A negative keyword's match type as Amazon takes it (EXACT or PHRASE), from every spelling Nexus stores: the v1 sync's
 * EXACT / PHRASE, Amazon's v3 NEGATIVE_EXACT / NEGATIVE_PHRASE (what Nexus writes itself, and the campaign-level sync)
 * and the blueprint's _EXACT / _PHRASE. Anything else comes back as it is (Amazon refuses it for a negative).
 */
export function negativeMatchOf(expressionType: string | null | undefined): string {
  return (expressionType ?? 'EXACT').toUpperCase().replace(/^(NEGATIVE)?_/, '')
}

/** Apply the bulk rename to one already-materialised name. */
export function applyNaming(name: string, rules: NamingRules | undefined): string {
  if (!rules) return name
  let out = name
  for (const r of rules.replacements ?? []) {
    if (!r.from) continue
    // Literal, case-insensitive, all occurrences — the operator typed a name, not a pattern.
    out = out.replace(new RegExp(r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), r.to ?? '')
  }
  return `${rules.prefix ?? ''}${out}${rules.suffix ?? ''}`
}

const norm = (s: string): string => s.trim().toLowerCase()
const normAsin = (s: string): string => s.trim().toUpperCase()

/** Word-boundary token match, so "aireonaut" is not the AIREON brand. */
function hasProductToken(haystack: string, token: string): boolean {
  if (!token) return false
  const esc = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(haystack)
}

/** Substitute the target product into a parameterised string. */
export function materialise(pattern: string, productToken: string): string {
  return pattern.split(PRODUCT_TOKEN).join(productToken)
}

/** W4-10 — a term's spacing as Amazon keeps it: trimmed, one space between words. */
const spaced = (s: string): string => s.trim().replace(/\s+/g, ' ')
/** W4-10 — a term's key for matching: its spacing and case aside ("Moto  Jacket" is "moto jacket"). */
const termKey = (s: string): string => spaced(s).toLowerCase()

/**
 * W4-10 — the product's name swapped in a term Claude wrote: the source product's name only as a WORD of its own, in any
 * case (letters and digits of any script bound it), so a name inside another word ("aria" in "variante") is left alone.
 */
export function swapProductWord(text: string, from: string, to: string): string {
  if (!from.trim()) return text
  const word = from.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${word}(?=[^\\p{L}\\p{N}]|$)`, 'giu'), (_m, before: string) => `${before}${to}`)
}

/**
 * W4-10 — the translations as the build reads them: each keyword and negative keyword looked up by its text in the
 * source (case and spacing aside), and the report of what was translated, kept, missing, unused or merged.
 */
function translatorOf(rules: TranslationRules, sourceToken: string) {
  const byText = (list: TermTranslation[]) => new Map(list.map((t) => [termKey(t.from), t] as const))
  const lists = { keywords: byText(rules.keywords), negatives: byText(rules.negatives) }
  const used = { keywords: new Set<string>(), negatives: new Set<string>() }
  const side = (negative: boolean): 'negatives' | 'keywords' => (negative ? 'negatives' : 'keywords')
  const terms = new Map<string, TranslationReport['terms'][number]>()
  const missing = new Map<string, TranslationReport['missing'][number]>()
  const merged: TranslationReport['merged'] = []
  const sourceOf = new Map<string, string>()
  return {
    /** The term as the source holds it, and the translation given for it (null: none). */
    lookup(pattern: string, negative: boolean) {
      const source = materialise(pattern, sourceToken)
      const entry = lists[side(negative)].get(termKey(source)) ?? null
      if (entry) used[side(negative)].add(termKey(source))
      return { source, entry }
    },
    /** A term the copy carries: what it became, or that it has neither a translation nor a keep. */
    record(id: string, said: { source: string; entry: TermTranslation | null }, expression: string, negative: boolean) {
      const key = `${side(negative)}|${termKey(said.source)}`
      // Claude's own spelling of the source term where it gave one (the source's case; the doc keeps only a pattern).
      const from = said.entry ? spaced(said.entry.from) : said.source
      sourceOf.set(id, from)
      if (!said.entry) missing.set(key, { term: said.source, negative })
      else if (!terms.has(key)) terms.set(key, { from, to: expression, negative, kept: said.entry.keep === true })
    },
    /**
     * One keyword per text, match type and side in an ad group: a term that became the same as an earlier one is dropped,
     * and the earlier one (its bid) is created.
     */
    once(targets: PlannedTarget[]): PlannedTarget[] {
      const first = new Map<string, PlannedTarget>()
      return targets.filter((x) => {
        if ((x.kind ?? '').toUpperCase() !== 'KEYWORD') return true
        const match = x.isNegative ? negativeMatchOf(x.expressionType) : (x.expressionType ?? '').toUpperCase().replace(/^_/, '')
        const key = `${x.isNegative}|${match}|${termKey(x.expression)}`
        const earlier = first.get(key)
        if (!earlier) { first.set(key, x); return true }
        merged.push({ from: sourceOf.get(x.id) ?? x.expression, to: x.expression, negative: x.isNegative, keptFrom: sourceOf.get(earlier.id) ?? earlier.expression })
        return false
      })
    },
    report(): TranslationReport {
      const unused = (negative: boolean) => [...lists[side(negative)].entries()]
        .filter(([k]) => !used[side(negative)].has(k)).map(([, t]) => ({ term: t.from, negative }))
      const order = <T extends { negative: boolean }>(xs: T[], text: (x: T) => string) =>
        xs.sort((a, b) => Number(a.negative) - Number(b.negative) || text(a).localeCompare(text(b)))
      return {
        terms: order([...terms.values()], (t) => t.from),
        missing: order([...missing.values()], (t) => t.term),
        unused: order([...unused(false), ...unused(true)], (t) => t.term),
        merged,
      }
    },
  }
}

/**
 * AX3.4 — stage one: turn the doc into the campaigns it describes.
 *
 * Pure shaping only — the product token, the copy scope, the naming rules and
 * the value policies. It decides nothing about whether the plan may RUN; that is
 * `evaluatePlan`, and keeping the two apart is what lets an edit sit between
 * them without the gate being computed against a plan nobody is going to create.
 */
export function buildPlanCampaigns(
  doc: BlueprintDoc,
  target: ApplyTarget,
  opts: ApplyOptions = {},
): { campaigns: PlannedCampaign[]; excluded: ApplyPlan['excluded']; translation?: TranslationReport } {
  const skip = new Set((opts.skipSharedTargets ?? []).map(norm))
  const shared = new Set(doc.sharedTargets.map((t) => norm(t.expression)))
  const scope: CopyScope = { ...FULL_COPY, ...(opts.include ?? {}) }
  const excluded = { keywords: 0, negatives: 0, productTargets: 0, autoClauses: 0 }
  // W4-10 — a copy into another market's language: every keyword and negative keyword by its text in the source.
  const tr = opts.translations ? translatorOf(opts.translations, doc.productToken) : null
  const skipKeys = new Set((opts.skipSharedTargets ?? []).map(termKey))

  const campaigns: PlannedCampaign[] = doc.campaigns.map((c, ci) => {
    const dailyBudget = scope.budgets
      ? applyValuePolicy(c.dailyBudget, opts.budgetPolicy, 1)
      : (opts.budgetPolicy?.mode === 'fixed' ? Math.max(1, opts.budgetPolicy.value ?? 0) : c.dailyBudget)
    const groups: PlannedAdGroup[] = c.adGroups.map((g, gi) => {
      const defaultBidCents = scope.bids ? applyValuePolicy(g.defaultBidCents, opts.bidPolicy, FLOOR_CENTS) : g.defaultBidCents
      const targets: PlannedTarget[] = []
      g.targets.forEach((t, ti) => {
        const kind = (t.kind ?? '').toUpperCase()
        // W4-10 — looked up before the copy scope: the translation of a term the scope leaves out is not "unused".
        const said = tr && kind === 'KEYWORD' ? tr.lookup(t.expression, t.isNegative) : null
        // Copy scope. Counted, so step 3 can say what was left behind.
        if (t.isNegative) {
          if (!scope.negatives) { excluded.negatives++; return }
        } else if (kind === 'AUTO') {
          if (!scope.autoClauses) { excluded.autoClauses++; return }
        } else if (kind === 'PRODUCT' || kind === 'CATEGORY') {
          if (!scope.productTargets) { excluded.productTargets++; return }
        } else if (!scope.keywords) { excluded.keywords++; return }

        const copied = materialise(t.expression, target.productToken)
        // W4-10 — a translation (or the term kept, as Claude spelled it), spaced as Amazon keeps it, the source product's
        // name swapped for the target's only where it is a word of its own.
        const own = said?.entry ? (said.entry.keep ? said.entry.from : said.entry.to ?? said.entry.from) : null
        const expression = own != null ? materialise(swapProductWord(spaced(own), doc.productToken, target.productToken), target.productToken) : copied
        const edited = norm(expression) !== norm(copied)
        // A target's own bid follows the bid policy; with bids off it falls back
        // to the ad group default rather than to zero.
        const bidCents = scope.bids ? applyValuePolicy(t.bidCents, opts.bidPolicy, FLOOR_CENTS) : null

        // Only POSITIVE shared targets are gated. A negative is not a bid and
        // cannot compete; skipping one would silently widen the new campaign.
        const gated = !t.isNegative && shared.has(norm(t.expression))
        if (said && !t.isNegative) {
          // W4-10 — in a translated copy every keyword is gated in the target market (evaluatePlan): skipping one by its
          // new text or its source text is the same choice.
          if (skipKeys.has(termKey(expression)) || skipKeys.has(termKey(said.source))) return
        } else if (gated && (skip.has(norm(t.expression)) || skip.has(norm(expression)))) return // operator removed it
        const id = `c${ci}.g${gi}.t${ti}`
        if (said) tr!.record(id, said, expression, t.isNegative)

        targets.push({
          id,
          expression, expressionType: t.expressionType, kind: t.kind,
          bidCents, isNegative: t.isNegative, negativeLevel: t.negativeLevel,
          ...(gated && !edited ? { gated: true } : {}),
          ...(edited ? { edited: true } : {}),
          ...(kind === 'AUTO' ? { autoClause: t.autoClause ?? null } : {}),
        })
      })
      return {
        id: `c${ci}.g${gi}`,
        name: applyNaming(materialise(g.namePattern, target.productToken), opts.naming),
        defaultBidCents,
        // W4-10 — two terms translated into one keyword are created once (Amazon takes one per text and match type).
        targets: tr ? tr.once(targets) : targets,
        asins: target.asins,
      }
    })
    return {
      id: `c${ci}`,
      role: c.role,
      name: applyNaming(materialise(c.namePattern, target.productToken), opts.naming),
      dailyBudget,
      biddingStrategy: c.biddingStrategy,
      adGroups: groups,
      targetingType: c.targetingType ?? 'MANUAL',
      placementBidding: scope.placementBidding ? (c.placementBidding ?? []) : [],
    }
  })
  return { campaigns, excluded, ...(tr ? { translation: tr.report() } : {}) }
}

/**
 * AX3.4 — stage two: apply the operator's review-step edits.
 *
 * Returns the edited campaigns plus any ids the edit set referenced that no
 * longer exist. A stale reference is REPORTED, never skipped: it means the plan
 * moved after the edits were made, and quietly applying the rest would create
 * something the operator never approved.
 *
 * A campaign left with no ad groups, or an ad group left with no targets and no
 * auto targeting, is dropped — an empty shell on Amazon is worse than nothing.
 */
/**
 * Drop anything that would land on Amazon as an empty shell.
 *
 * AX3.7 — this used to run only when there were edits, so the SAME replication
 * reported eleven campaigns before you touched anything and ten after, and the
 * eleventh was a campaign the plan's own warning said could never run. What gets
 * created must not depend on whether you happened to edit something unrelated.
 */
function pruneEmpty(campaigns: PlannedCampaign[]): PlannedCampaign[] {
  return campaigns
    .map((c) => ({ ...c, adGroups: c.adGroups.filter((g) => g.targets.length > 0) }))
    .filter((c) => c.adGroups.length > 0)
}

export function applyEdits(
  campaigns: PlannedCampaign[],
  edits: PlanEdits | undefined,
  target: ApplyTarget,
): { campaigns: PlannedCampaign[]; stale: StaleEditRef[] } {
  if (!edits) return { campaigns: pruneEmpty(campaigns), stale: [] }
  const stale: StaleEditRef[] = []

  const campById = new Map(campaigns.map((c) => [c.id, c]))
  const agById = new Map(campaigns.flatMap((c) => c.adGroups.map((g) => [g.id, g] as const)))
  const tgtById = new Map(campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.map((t) => [t.id, t] as const))))
  const check = (kind: StaleEditRef['kind'], id: string, has: boolean) => { if (!has) stale.push({ kind, id }) }

  for (const id of edits.removedCampaigns ?? []) check('campaign', id, campById.has(id))
  for (const id of edits.removedAdGroups ?? []) check('adGroup', id, agById.has(id))
  for (const id of edits.removedTargets ?? []) check('target', id, tgtById.has(id))
  for (const e of edits.renamedCampaigns ?? []) check('campaign', e.id, campById.has(e.id))
  for (const e of edits.renamedAdGroups ?? []) check('adGroup', e.id, agById.has(e.id))
  for (const e of edits.campaignBudgets ?? []) check('campaign', e.id, campById.has(e.id))
  for (const e of edits.adGroupBids ?? []) check('adGroup', e.id, agById.has(e.id))
  for (const e of edits.targetBids ?? []) check('target', e.id, tgtById.has(e.id))
  for (const a of edits.addedTargets ?? []) check('adGroup', a.adGroupId, agById.has(a.adGroupId))
  for (const e of edits.targetExpressions ?? []) check('target', e.id, tgtById.has(e.id))
  for (const e of edits.targetMatchTypes ?? []) check('target', e.id, tgtById.has(e.id))
  for (const e of edits.campaignPlacements ?? []) check('campaign', e.id, campById.has(e.id))
  for (const e of edits.campaignBidding ?? []) check('campaign', e.id, campById.has(e.id))
  for (const e of edits.adGroupAsins ?? []) check('adGroup', e.id, agById.has(e.id))
  if (stale.length) return { campaigns, stale }

  const rmC = new Set(edits.removedCampaigns ?? [])
  const rmG = new Set(edits.removedAdGroups ?? [])
  const rmT = new Set(edits.removedTargets ?? [])
  const renC = new Map((edits.renamedCampaigns ?? []).map((e) => [e.id, e.name]))
  const renG = new Map((edits.renamedAdGroups ?? []).map((e) => [e.id, e.name]))
  const budC = new Map((edits.campaignBudgets ?? []).map((e) => [e.id, e.dailyBudget]))
  const bidG = new Map((edits.adGroupBids ?? []).map((e) => [e.id, e.defaultBidCents]))
  const bidT = new Map((edits.targetBids ?? []).map((e) => [e.id, e.bidCents]))
  const exprT = new Map((edits.targetExpressions ?? []).map((e) => [e.id, e.expression]))
  const mtT = new Map((edits.targetMatchTypes ?? []).map((e) => [e.id, e.expressionType]))
  const placeC = new Map((edits.campaignPlacements ?? []).map((e) => [e.id, e.placementBidding]))
  const bidStratC = new Map((edits.campaignBidding ?? []).map((e) => [e.id, e.biddingStrategy]))
  const asinsG = new Map((edits.adGroupAsins ?? []).map((e) => [e.id, e.asins]))
  const addByAg = new Map<string, PlanEdits['addedTargets']>()
  for (const a of edits.addedTargets ?? []) {
    const list = addByAg.get(a.adGroupId) ?? []
    list.push(a)
    addByAg.set(a.adGroupId, list as never)
  }

  const out = campaigns
    .filter((c) => !rmC.has(c.id))
    .map((c) => {
      const adGroups = c.adGroups
        .filter((g) => !rmG.has(g.id))
        .map((g) => {
          const kept = g.targets.filter((t) => !rmT.has(t.id)).map((t) => {
            const expression = exprT.has(t.id) ? materialise(exprT.get(t.id)!.trim(), target.productToken) : t.expression
            const expressionType = mtT.get(t.id) ?? t.expressionType
            if (expression === t.expression && expressionType === t.expressionType && !bidT.has(t.id)) return t
            return {
              ...t,
              expression,
              expressionType,
              ...(bidT.has(t.id) ? { bidCents: Math.max(FLOOR_CENTS, bidT.get(t.id)!) } : {}),
              // Only a text change invalidates the doc's classification. A match
              // type does not change WHICH auction the keyword enters, so it is
              // not grounds for re-gating.
              ...(expression === t.expression ? {} : { edited: true }),
            }
          })
          const added: PlannedTarget[] = (addByAg.get(g.id) ?? []).map((a, i) => ({
            id: `${g.id}.a${i}`,
            expression: materialise(a.expression, target.productToken),
            expressionType: a.expressionType,
            kind: a.kind ?? 'KEYWORD',
            bidCents: a.bidCents == null ? null : Math.max(FLOOR_CENTS, a.bidCents),
            isNegative: !!a.isNegative,
            negativeLevel: a.isNegative ? 'AD_GROUP' : null,
            added: true,
            // Gating for an ADDED positive is decided in evaluatePlan, which
            // knows the target product — an operator-typed keyword has no
            // classification from the doc to inherit.
          }))
          // An ad group may advertise a SUBSET of the selected products. Anything
          // outside that selection is dropped rather than trusted: the picker is
          // where products are chosen, and an id arriving only in an edit would
          // advertise something nobody picked.
          const allowed = new Set(target.asins)
          const asins = asinsG.has(g.id) ? asinsG.get(g.id)!.filter((a) => allowed.has(a)) : g.asins
          return {
            ...g,
            name: renG.get(g.id) ?? g.name,
            defaultBidCents: bidG.has(g.id) ? Math.max(FLOOR_CENTS, bidG.get(g.id)!) : g.defaultBidCents,
            targets: [...kept, ...added],
            asins,
          }
        })
        // An ad group with nothing in it would be created empty on Amazon.
        .filter((g) => g.targets.length > 0)
      const placements = placeC.has(c.id)
        ? placeC.get(c.id)!
          .filter((p) => (PLACEMENTS as readonly string[]).includes(p.placement))
          .map((p) => ({ placement: p.placement, percentage: Math.max(0, Math.min(MAX_PLACEMENT_PCT, Math.round(p.percentage))) }))
          .filter((p) => p.percentage > 0)
        : c.placementBidding
      const strategy = bidStratC.get(c.id)
      return {
        ...c,
        name: renC.get(c.id) ?? c.name,
        dailyBudget: budC.has(c.id) ? budC.get(c.id)! : c.dailyBudget,
        biddingStrategy: strategy && (BIDDING_STRATEGIES as readonly string[]).includes(strategy) ? strategy : c.biddingStrategy,
        placementBidding: placements,
        adGroups,
      }
    })
    .filter((c) => c.adGroups.length > 0)

  return { campaigns: out, stale }
}

/**
 * Build the plan for applying `doc` to one product, and decide whether it may
 * run. `existing` is every positive keyword we already target in this
 * marketplace, with the ASINs each one's ad group advertises — the
 * self-competition surface to check against.
 */
export function planApplication(
  doc: BlueprintDoc,
  target: ApplyTarget,
  existing: ExistingTarget[],
  opts: ApplyOptions = {},
  edits?: PlanEdits,
): ApplyPlan {
  const built = buildPlanCampaigns(doc, target, opts)
  const edited = applyEdits(built.campaigns, edits, target)
  return evaluatePlan(edited.campaigns, built.excluded, doc, target, existing, opts, edited.stale, built.translation)
}

/**
 * AX3.4 — stage three: decide whether these campaigns may be created.
 *
 * Runs over the FINAL campaign set, whatever produced it. That is the whole
 * point: the self-competition gate, the budget cap and the name-collision check
 * see exactly what will be created, including anything the operator added or
 * removed in the review step.
 */
export function evaluatePlan(
  campaigns: PlannedCampaign[],
  excluded: ApplyPlan['excluded'],
  doc: BlueprintDoc,
  target: ApplyTarget,
  existing: ExistingTarget[],
  opts: ApplyOptions = {},
  stale: StaleEditRef[] = [],
  /** W4-10 — what the translations did (buildPlanCampaigns), for a copy given them. */
  translation?: TranslationReport,
): ApplyPlan {
  const accept = new Set((opts.acceptSharedTargets ?? []).map(norm))
  const ownAsins = new Set(target.asins.map(normAsin))

  // Index what we already run, by keyword: the target product's own campaigns
  // apart from other products' (rule 3 — isolation is per product).
  type Ref = { campaignName: string; campaignId: string }
  const ownBy = new Map<string, Ref[]>()
  const othersBy = new Map<string, Ref[]>()
  for (const e of existing) {
    const k = norm(e.expression)
    const into = (e.asins ?? []).some((a) => ownAsins.has(normAsin(a))) ? ownBy : othersBy
    const list = into.get(k) ?? []
    list.push({ campaignName: e.campaignName, campaignId: e.campaignId })
    into.set(k, list)
  }

  const conflicts = new Map<string, ApplyConflict>()
  const sharedWithOthers = new Map<string, SharedWithOtherProducts>()
  let adGroups = 0, positives = 0, negatives = 0, productAds = 0, dailyBudgetTotal = 0

  for (const c of campaigns) {
    dailyBudgetTotal += Number(c.dailyBudget ?? 0)
    for (const g of c.adGroups) {
      adGroups++
      productAds += g.asins.length
      for (const t of g.targets) {
        if (t.isNegative) negatives++; else positives++
        if (t.isNegative) continue
        // An operator-ADDED or operator-REWRITTEN keyword has no usable
        // classification from the doc, so it is classified here against the
        // TARGET product: its own brand term is safe, anything else is treated as
        // shared and gated like a copied one. Without this, "add a keyword" — or
        // "rename this one" — would be a hole straight through the gate.
        // W4-10 — a copy into another market's language gates EVERY keyword, translated or kept, its brand terms too: the
        // product may already run in that market, and its own campaigns there may already buy the very same term.
        const keyword = (t.kind ?? 'KEYWORD').toUpperCase() === 'KEYWORD'
        const gated = translation ? keyword
          : (t.added || t.edited) ? !hasProductToken(t.expression, target.productToken) && keyword
          : (t.gated ?? false)
        if (!gated) continue
        const key = norm(t.expression)
        const others = othersBy.get(key)
        // Another product's campaigns buy it too: allowed, only listed (once per campaign).
        if (others?.length && !sharedWithOthers.has(key)) {
          const byCampaign = new Map(others.map((r) => [r.campaignId, r]))
          sharedWithOthers.set(key, { expression: t.expression, existing: [...byCampaign.values()] })
        }
        const clash = ownBy.get(key)
        if (!clash?.length) continue
        const accepted = accept.has(key)
        const prev = conflicts.get(key)
        conflicts.set(key, {
          expression: t.expression,
          existing: clash,
          resolution: accepted ? 'ACCEPTED' : (prev?.resolution === 'ACCEPTED' ? 'ACCEPTED' : 'UNRESOLVED'),
        })
        t.conflictsWith = clash
      }
    }
  }

  const conflictList = [...conflicts.values()].sort((a, b) => a.expression.localeCompare(b.expression))
  const unresolved = conflictList.filter((c) => c.resolution === 'UNRESOLVED')
  const sharedList = [...sharedWithOthers.values()].sort((a, b) => a.expression.localeCompare(b.expression))

  const blockers: string[] = []
  const warnings: string[] = []

  // AX3.6 — you have already done this. Loud, because a duplicate replication is
  // invisible afterwards: two healthy-looking structures quietly splitting one
  // product's demand between them.
  if (opts.priorRun && opts.priorRun.status !== 'ROLLED_BACK') {
    warnings.push(
      `${target.productToken} was already replicated in this marketplace on ${opts.priorRun.when} `
      + `(${opts.priorRun.status.toLowerCase()}, ${opts.priorRun.campaigns} campaign(s)). Running again creates a `
      + 'SECOND set that will bid against the first — check the earlier run before launching.',
    )
  }

  // AX3.4 — edits made against a plan that has since changed shape.
  if (stale.length) {
    blockers.push(
      `${stale.length} of your edits point at campaigns, ad groups or keywords that are no longer in this plan `
      + '— the source or the copy settings changed after you made them. Review step 2 again.',
    )
  }

  // W4-10 — a copy into another market's language: a term with neither a translation nor a keep would be created in the
  // source's language, and a translation that names no term of the source is a typo whose term would be.
  if (translation) {
    const list = (xs: Array<{ term: string }>) => `${xs.slice(0, 10).map((x) => `"${x.term}"`).join(', ')}${xs.length > 10 ? `, and ${xs.length - 10} more` : ''}`
    const sides = (xs: Array<{ term: string; negative: boolean }>) => [
      ...(xs.some((x) => !x.negative) ? [`keyword(s) ${list(xs.filter((x) => !x.negative))}`] : []),
      ...(xs.some((x) => x.negative) ? [`negative keyword(s) ${list(xs.filter((x) => x.negative))}`] : []),
    ].join('; ')
    if (translation.missing.length) {
      blockers.push(`${translation.missing.length} term(s) of the source have no translation: ${sides(translation.missing)}. Translate each, or keep it as it is (a brand term).`)
    }
    if (translation.unused.length) {
      blockers.push(`${translation.unused.length} translation(s) name a term the source does not have: ${sides(translation.unused)}. Check each against the source's own text.`)
    }
    if (translation.merged.length) {
      const m = translation.merged
      warnings.push(`${m.length} term(s) became the same keyword as an earlier one of their ad group, which is created once: `
        + `${m.slice(0, 3).map((x) => `"${x.from}" became "${x.to}", as "${x.keptFrom}" did: created once, at the bid of "${x.keptFrom}"`).join('; ')}${m.length > 3 ? '; …' : ''}.`)
    }
  }

  // AX2.7 — a replication into a market that cannot receive writes would create
  // the whole structure LOCALLY, with null Amazon ids, and only report PARTIAL
  // afterwards. Refuse before anything is created.
  if (opts.market && !opts.market.writable) {
    blockers.push(
      `${opts.market.marketplace} has no writable production Amazon Ads connection, so all `
      + `${doc.campaigns.length} campaigns would be created locally and never reach Amazon`,
    )
  } else if (opts.market && !opts.market.everWritten) {
    warnings.push(
      `no write has ever reached Amazon for ${opts.market.marketplace} — this replication would be the first, `
      + 'so verify one campaign in Seller Central before trusting the rest',
    )
  }

  if (sharedList.length) {
    warnings.push(
      `${sharedList.length} keyword(s) are also bought by your other products' campaigns `
      + `(${sharedList.slice(0, 3).map((c) => `"${c.expression}"`).join(', ')}${sharedList.length > 3 ? ', …' : ''}): `
      + 'allowed — different products may share a keyword, and Nexus never negates one product\'s terms in another\'s campaigns.',
    )
  }
  if (unresolved.length) {
    blockers.push(
      `${unresolved.length} keyword(s) would make ${target.productToken} bid against campaigns you already run for it `
      + `(${unresolved.slice(0, 3).map((c) => `"${c.expression}"`).join(', ')}${unresolved.length > 3 ? ', …' : ''}). `
      + 'Skip them or accept them explicitly.',
    )
  }
  if (opts.dailyBudgetCapEur != null && dailyBudgetTotal > opts.dailyBudgetCapEur) {
    blockers.push(`this replication commits €${dailyBudgetTotal.toFixed(2)}/day, over the €${opts.dailyBudgetCapEur.toFixed(2)} cap`)
  }
  if (!target.productToken.trim()) blockers.push('productToken is required — it is what {{product}} becomes')
  if (!target.asins.length) blockers.push('no ASINs supplied — the campaigns would have nothing to advertise')

  // AX3.0 — name collisions, against the destination market AND within the plan
  // itself (two source campaigns whose names differ only by the product token
  // collapse onto one name once it is substituted).
  const live = new Set((opts.existingCampaignNames ?? []).map(norm))
  const collideLive = campaigns.filter((c) => live.has(norm(c.name))).map((c) => c.name)
  if (collideLive.length) {
    blockers.push(
      `${collideLive.length} campaign name(s) already exist in this marketplace and would be duplicated `
      + `(${collideLive.slice(0, 3).map((n) => `"${n}"`).join(', ')}${collideLive.length > 3 ? ', …' : ''}). `
      + 'Rename them, or replicate from a source whose names carry the product token.',
    )
  }
  const planCounts = new Map<string, number>()
  for (const c of campaigns) planCounts.set(norm(c.name), (planCounts.get(norm(c.name)) ?? 0) + 1)
  const collideSelf = [...planCounts.entries()].filter(([, n]) => n > 1).map(([n]) => n)
  if (collideSelf.length) {
    blockers.push(`this plan would create ${collideSelf.length} duplicate campaign name(s) of its own: ${collideSelf.slice(0, 3).map((n) => `"${n}"`).join(', ')}`)
  }

  // Auto clauses we could not identify would be dropped at create time. Say so
  // here rather than letting the campaign land with less targeting than planned.
  const unknownAuto = campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.filter((t) => t.kind?.toUpperCase() === 'AUTO' && !t.autoClause)))
  if (unknownAuto.length) {
    warnings.push(
      `${unknownAuto.length} auto-targeting clause(s) are not Amazon SP clauses we can re-create `
      + '(Sponsored Brands / Display targeting is not modelled) — they will not be created',
    )
  }

  // AX3.3 — the copy scope is the operator's own choice, so it warns rather than
  // blocks; it must still be said out loud.
  const droppedTotal = excluded.keywords + excluded.negatives + excluded.productTargets + excluded.autoClauses
  if (droppedTotal) {
    const parts = [
      excluded.keywords && `${excluded.keywords} keyword(s)`,
      excluded.negatives && `${excluded.negatives} negative(s)`,
      excluded.productTargets && `${excluded.productTargets} product target(s)`,
      excluded.autoClauses && `${excluded.autoClauses} auto clause(s)`,
    ].filter(Boolean)
    warnings.push(`${parts.join(', ')} in the source will NOT be copied — you excluded them under "what to copy"`)
  }
  // AX3.7 — Amazon takes negatives as EXACT or PHRASE only. The create path
  // filters anything else out, so without this the operator is told N negatives
  // will be created and a smaller number arrives, with nothing said about it.
  const badNeg = campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.filter((t) => {
    if (!t.isNegative || (t.kind ?? '').toUpperCase() !== 'KEYWORD') return false
    const mt = negativeMatchOf(t.expressionType)
    return mt !== 'EXACT' && mt !== 'PHRASE'
  })))
  if (badNeg.length) {
    warnings.push(
      `${badNeg.length} negative keyword(s) are set to a match type Amazon does not accept for negatives `
      + '(only exact and phrase) — they will not be created. Change them to exact or phrase in step 2.',
    )
  }
  // AX3.8 — Amazon's word limits on NEGATIVE keywords: 4 words for phrase, 10
  // for exact. Over the limit it rejects the item and the run reports a smaller
  // number than it promised with nothing said about which ones. Measured on the
  // AIREON→AIRMESH run: 6 negatives were 5-6 words and vanished. Warned rather
  // than auto-shortened — shortening a negative WIDENS what the campaign buys,
  // which is not a decision to make on someone's behalf.
  const longNeg = campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.filter((t) => {
    if (!t.isNegative || (t.kind ?? '').toUpperCase() !== 'KEYWORD') return false
    const words = t.expression.trim().split(/\s+/).length
    const mt = negativeMatchOf(t.expressionType)
    return mt === 'PHRASE' ? words > 4 : words > 10
  })))
  if (longNeg.length) {
    warnings.push(
      `${longNeg.length} negative keyword(s) are over Amazon's word limit (4 for phrase, 10 for exact) `
      + `and will NOT be created (${longNeg.slice(0, 3).map((t) => `"${t.expression}"`).join(', ')}${longNeg.length > 3 ? ', …' : ''}). `
      + 'Shorten them or switch them to exact in step 2.',
    )
  }

  // AX3.7 — an ad group whose product list the operator emptied. It would be
  // created, carry its targeting, and have nothing to advertise.
  const noAds = campaigns.flatMap((c) => c.adGroups.filter((g) => g.asins.length === 0).map((g) => g.name))
  if (noAds.length) {
    warnings.push(
      `${noAds.length} ad group(s) have no products and would be created with nothing to advertise `
      + `(${noAds.slice(0, 3).map((n) => `"${n}"`).join(', ')}${noAds.length > 3 ? ', …' : ''})`,
    )
  }
  // A campaign with no positive targeting cannot spend. Auto campaigns self-target.
  const inert = campaigns.filter((c) => c.targetingType !== 'AUTO'
    && c.adGroups.every((g) => g.targets.every((t) => t.isNegative)))
  if (inert.length) {
    warnings.push(
      `${inert.length} campaign(s) would be created with no positive targeting and could never run `
      + `(${inert.slice(0, 3).map((c) => `"${c.name}"`).join(', ')}${inert.length > 3 ? ', …' : ''})`,
    )
  }

  return {
    productToken: target.productToken,
    warnings,
    campaigns,
    totals: { campaigns: campaigns.length, adGroups, positives, negatives, productAds, dailyBudgetTotal },
    conflicts: conflictList,
    sharedWithOtherProducts: sharedList,
    blockers,
    allowed: blockers.length === 0,
    excluded,
    ...(translation ? { translation } : {}),
  }
}
