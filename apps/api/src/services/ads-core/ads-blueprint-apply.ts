/**
 * AX2.5 — applying a blueprint to a new product (planning + the safety gate).
 *
 * This is the half that decides WHETHER a replication may run and exactly what
 * it would create. The orchestration that actually calls Amazon lives in
 * services/advertising/ads-blueprint-apply.service.ts and refuses to run
 * unless a plan produced here says `allowed`.
 *
 * THE GATE. Replicating a structure is only safe for the parts that are about
 * the target product. A blueprint's `sharedTargets` — its positive CATEGORY and
 * COMPETITOR keywords — are by definition not about any one product. Create
 * them for a second jacket and the two jackets enter the same Amazon auction:
 * you bid against yourself, raise your own clearing price, and split one pool
 * of demand between two of your own ASINs. That is the failure this phase
 * exists to prevent, so a conflict is BLOCKING and the operator must resolve
 * each one explicitly — skip it, or accept it on the record.
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
}

/** Ids referenced by an edit set that no longer exist in the freshly-built plan. */
export interface StaleEditRef { kind: 'campaign' | 'adGroup' | 'target'; id: string }

export interface ApplyConflict {
  expression: string
  /** Campaigns we already run that target this expression. */
  existing: Array<{ campaignName: string; campaignId: string }>
  resolution: 'UNRESOLVED' | 'SKIPPED' | 'ACCEPTED'
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
  conflicts: ApplyConflict[]
  /** Reasons the plan may not be executed. Empty ⇒ allowed. */
  blockers: string[]
  allowed: boolean
  /**
   * AX3.3 — what the copy scope deliberately left behind. Reported so "we copied
   * the structure" never quietly means "we copied most of the structure".
   */
  excluded: { keywords: number; negatives: number; productTargets: number; autoClauses: number }
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
): { campaigns: PlannedCampaign[]; excluded: ApplyPlan['excluded'] } {
  const skip = new Set((opts.skipSharedTargets ?? []).map(norm))
  const shared = new Set(doc.sharedTargets.map((t) => norm(t.expression)))
  const scope: CopyScope = { ...FULL_COPY, ...(opts.include ?? {}) }
  const excluded = { keywords: 0, negatives: 0, productTargets: 0, autoClauses: 0 }

  const campaigns: PlannedCampaign[] = doc.campaigns.map((c, ci) => {
    const dailyBudget = scope.budgets
      ? applyValuePolicy(c.dailyBudget, opts.budgetPolicy, 1)
      : (opts.budgetPolicy?.mode === 'fixed' ? Math.max(1, opts.budgetPolicy.value ?? 0) : c.dailyBudget)
    const groups: PlannedAdGroup[] = c.adGroups.map((g, gi) => {
      const defaultBidCents = scope.bids ? applyValuePolicy(g.defaultBidCents, opts.bidPolicy, FLOOR_CENTS) : g.defaultBidCents
      const targets: PlannedTarget[] = []
      g.targets.forEach((t, ti) => {
        // Copy scope. Counted, so step 3 can say what was left behind.
        const kind = (t.kind ?? '').toUpperCase()
        if (t.isNegative) {
          if (!scope.negatives) { excluded.negatives++; return }
        } else if (kind === 'AUTO') {
          if (!scope.autoClauses) { excluded.autoClauses++; return }
        } else if (kind === 'PRODUCT' || kind === 'CATEGORY') {
          if (!scope.productTargets) { excluded.productTargets++; return }
        } else if (!scope.keywords) { excluded.keywords++; return }

        const expression = materialise(t.expression, target.productToken)
        // A target's own bid follows the bid policy; with bids off it falls back
        // to the ad group default rather than to zero.
        const bidCents = scope.bids ? applyValuePolicy(t.bidCents, opts.bidPolicy, FLOOR_CENTS) : null

        // Only POSITIVE shared targets are gated. A negative is not a bid and
        // cannot compete; skipping one would silently widen the new campaign.
        const gated = !t.isNegative && shared.has(norm(t.expression))
        if (gated && (skip.has(norm(t.expression)) || skip.has(norm(expression)))) return // operator removed it

        targets.push({
          id: `c${ci}.g${gi}.t${ti}`,
          expression, expressionType: t.expressionType, kind: t.kind,
          bidCents, isNegative: t.isNegative, negativeLevel: t.negativeLevel,
          ...(gated ? { gated: true } : {}),
          ...(kind === 'AUTO' ? { autoClause: t.autoClause ?? null } : {}),
        })
      })
      return {
        id: `c${ci}.g${gi}`,
        name: applyNaming(materialise(g.namePattern, target.productToken), opts.naming),
        defaultBidCents,
        targets,
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
  return { campaigns, excluded }
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
export function applyEdits(
  campaigns: PlannedCampaign[],
  edits: PlanEdits | undefined,
  target: ApplyTarget,
): { campaigns: PlannedCampaign[]; stale: StaleEditRef[] } {
  if (!edits) return { campaigns, stale: [] }
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
  if (stale.length) return { campaigns, stale }

  const rmC = new Set(edits.removedCampaigns ?? [])
  const rmG = new Set(edits.removedAdGroups ?? [])
  const rmT = new Set(edits.removedTargets ?? [])
  const renC = new Map((edits.renamedCampaigns ?? []).map((e) => [e.id, e.name]))
  const renG = new Map((edits.renamedAdGroups ?? []).map((e) => [e.id, e.name]))
  const budC = new Map((edits.campaignBudgets ?? []).map((e) => [e.id, e.dailyBudget]))
  const bidG = new Map((edits.adGroupBids ?? []).map((e) => [e.id, e.defaultBidCents]))
  const bidT = new Map((edits.targetBids ?? []).map((e) => [e.id, e.bidCents]))
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
          const kept = g.targets.filter((t) => !rmT.has(t.id)).map((t) => (
            bidT.has(t.id) ? { ...t, bidCents: Math.max(FLOOR_CENTS, bidT.get(t.id)!) } : t
          ))
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
          return {
            ...g,
            name: renG.get(g.id) ?? g.name,
            defaultBidCents: bidG.has(g.id) ? Math.max(FLOOR_CENTS, bidG.get(g.id)!) : g.defaultBidCents,
            targets: [...kept, ...added],
          }
        })
        // An ad group with nothing in it would be created empty on Amazon.
        .filter((g) => g.targets.length > 0)
      return {
        ...c,
        name: renC.get(c.id) ?? c.name,
        dailyBudget: budC.has(c.id) ? budC.get(c.id)! : c.dailyBudget,
        adGroups,
      }
    })
    .filter((c) => c.adGroups.length > 0)

  return { campaigns: out, stale }
}

/**
 * Build the plan for applying `doc` to one product, and decide whether it may
 * run. `existing` is every positive keyword we already target in this
 * marketplace — the self-competition surface to check against.
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
  return evaluatePlan(edited.campaigns, built.excluded, doc, target, existing, opts, edited.stale)
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
): ApplyPlan {
  const accept = new Set((opts.acceptSharedTargets ?? []).map(norm))

  // Index what we already run, by keyword.
  const existingBy = new Map<string, Array<{ campaignName: string; campaignId: string }>>()
  for (const e of existing) {
    const k = norm(e.expression)
    const list = existingBy.get(k) ?? []
    list.push({ campaignName: e.campaignName, campaignId: e.campaignId })
    existingBy.set(k, list)
  }

  const conflicts = new Map<string, ApplyConflict>()
  let adGroups = 0, positives = 0, negatives = 0, productAds = 0, dailyBudgetTotal = 0

  for (const c of campaigns) {
    dailyBudgetTotal += Number(c.dailyBudget ?? 0)
    for (const g of c.adGroups) {
      adGroups++
      productAds += g.asins.length
      for (const t of g.targets) {
        if (t.isNegative) negatives++; else positives++
        if (t.isNegative) continue
        // An operator-ADDED keyword has no classification from the doc, so it is
        // classified here against the TARGET product: its own brand term is
        // safe, anything else is treated as shared and gated like a copied one.
        // Without this, "add a keyword" would be a hole straight through the gate.
        const gated = t.gated ?? (t.added ? !hasProductToken(t.expression, target.productToken) && (t.kind ?? 'KEYWORD').toUpperCase() === 'KEYWORD' : false)
        if (!gated) continue
        const key = norm(t.expression)
        const clash = existingBy.get(key)
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

  const blockers: string[] = []
  const warnings: string[] = []

  // AX3.4 — edits made against a plan that has since changed shape.
  if (stale.length) {
    blockers.push(
      `${stale.length} of your edits point at campaigns, ad groups or keywords that are no longer in this plan `
      + '— the source or the copy settings changed after you made them. Review step 2 again.',
    )
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

  if (unresolved.length) {
    blockers.push(
      `${unresolved.length} keyword(s) would make ${target.productToken} bid against campaigns you already run `
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
    blockers,
    allowed: blockers.length === 0,
    excluded,
  }
}
