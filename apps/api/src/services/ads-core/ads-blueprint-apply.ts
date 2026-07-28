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

import { PRODUCT_TOKEN, type BlueprintDoc } from './ads-blueprint.js'

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
  expression: string
  expressionType: string
  kind: string
  bidCents: number | null
  isNegative: boolean
  negativeLevel: string | null
  /** Set when this target collides with something we already run. */
  conflictsWith?: Array<{ campaignName: string; campaignId: string }>
}
export interface PlannedAdGroup {
  name: string
  defaultBidCents: number | null
  targets: PlannedTarget[]
  asins: string[]
}
export interface PlannedCampaign {
  role: string
  name: string
  dailyBudget: number | null
  biddingStrategy: string | null
  adGroups: PlannedAdGroup[]
}

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
}

const norm = (s: string): string => s.trim().toLowerCase()

/** Substitute the target product into a parameterised string. */
export function materialise(pattern: string, productToken: string): string {
  return pattern.split(PRODUCT_TOKEN).join(productToken)
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
): ApplyPlan {
  const skip = new Set((opts.skipSharedTargets ?? []).map(norm))
  const accept = new Set((opts.acceptSharedTargets ?? []).map(norm))
  const shared = new Set(doc.sharedTargets.map((t) => norm(t.expression)))

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

  const campaigns: PlannedCampaign[] = doc.campaigns.map((c) => {
    dailyBudgetTotal += Number(c.dailyBudget ?? 0)
    const groups: PlannedAdGroup[] = c.adGroups.map((g) => {
      adGroups++
      const targets: PlannedTarget[] = []
      for (const t of g.targets) {
        const expression = materialise(t.expression, target.productToken)
        const key = norm(expression)

        // Only POSITIVE shared targets are gated. A negative is not a bid and
        // cannot compete; skipping one would silently widen the new campaign.
        if (!t.isNegative && shared.has(norm(t.expression))) {
          if (skip.has(norm(t.expression)) || skip.has(key)) continue // operator removed it
          const clash = existingBy.get(key)
          if (clash?.length) {
            const accepted = accept.has(norm(t.expression)) || accept.has(key)
            const prev = conflicts.get(key)
            conflicts.set(key, {
              expression,
              existing: clash,
              resolution: accepted ? 'ACCEPTED' : (prev?.resolution === 'ACCEPTED' ? 'ACCEPTED' : 'UNRESOLVED'),
            })
            targets.push({
              expression, expressionType: t.expressionType, kind: t.kind,
              bidCents: t.bidCents, isNegative: t.isNegative, negativeLevel: t.negativeLevel,
              conflictsWith: clash,
            })
            if (t.isNegative) negatives++; else positives++
            continue
          }
        }

        targets.push({
          expression, expressionType: t.expressionType, kind: t.kind,
          bidCents: t.bidCents, isNegative: t.isNegative, negativeLevel: t.negativeLevel,
        })
        if (t.isNegative) negatives++; else positives++
      }
      productAds += target.asins.length
      return {
        name: materialise(g.namePattern, target.productToken),
        defaultBidCents: g.defaultBidCents,
        targets,
        asins: target.asins,
      }
    })
    return {
      role: c.role,
      name: materialise(c.namePattern, target.productToken),
      dailyBudget: c.dailyBudget,
      biddingStrategy: c.biddingStrategy,
      adGroups: groups,
    }
  })

  const conflictList = [...conflicts.values()].sort((a, b) => a.expression.localeCompare(b.expression))
  const unresolved = conflictList.filter((c) => c.resolution === 'UNRESOLVED')

  const blockers: string[] = []
  const warnings: string[] = []

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

  return {
    productToken: target.productToken,
    warnings,
    campaigns,
    totals: { campaigns: campaigns.length, adGroups, positives, negatives, productAds, dailyBudgetTotal },
    conflicts: conflictList,
    blockers,
    allowed: blockers.length === 0,
  }
}
