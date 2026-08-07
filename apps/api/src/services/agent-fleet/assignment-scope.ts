/**
 * NAF.SB.AS — the intersection law.
 *
 * An assignment NARROWS a worker. It must never WIDEN one.
 *
 * The dangerous direction is widening, and it is easy to ship by accident:
 * `agent-executor.ts` passes the CHARTER's scope into the evidence layer, so
 * a naive "assignment target overrides charter scope" would let an
 * assignment point a DE-scoped worker at IT and read IT evidence — an
 * assignment quietly undoing a limit set on the Workers page. That is the
 * `scopeCampaignIds` defect class at a higher blast radius.
 *
 * So:
 *
 *     effective = charter.scope ∩ assignment.target      (never a union)
 *
 * and an empty intersection is a REFUSAL, never a fall-through. The
 * fall-through is what makes this worth a module of its own: `undefined`
 * means "everything" to `getObservation`, so a scope that resolves to
 * nothing and then returns `undefined` would run the worker over all 220
 * campaigns while the assignment row still said one. Fail closed, loudly.
 */
import prisma from '../../db.js'
import type { EffectiveCharter } from './charter-types.js'
import type { NarrowKind, ObservationNarrow } from './observation-builder.js'
import { canNarrowBy } from './observation-builder.js'

export type TargetKind = 'CAMPAIGN' | 'MARKETPLACE' | 'PORTFOLIO'

/**
 * NAF.SB.AS.2 — a PORTFOLIO target is enforced AS a campaign scope: the
 * portfolio is resolved to its member campaigns at run time and the campaign
 * filter does the binding. So a worker can be pointed at a portfolio exactly
 * when it can be pointed at a campaign, and there is no second enforcement
 * path to keep honest.
 */
export function narrowKindFor(kind: TargetKind): NarrowKind {
  return kind === 'MARKETPLACE' ? 'MARKETPLACE' : 'CAMPAIGN'
}

export interface AssignmentTarget {
  kind: TargetKind
  /** EXTERNAL campaign ids · marketplace codes · EXTERNAL portfolio ids. */
  ids: string[]
  labels?: string[]
}

export interface ResolvedScope {
  /** Passed into the observation SCOPE (and so into the cache key). */
  marketplace?: string
  /** Applied AFTER the cache read — never part of the cache key. */
  narrow?: ObservationNarrow
  /** Set when the target cannot honestly be honoured. The run halts. */
  error?: string
}

/**
 * Resolve what a run may actually look at. Called by the executor inside the
 * gate ladder, so a refusal costs $0 — it halts before the provider.
 */
export async function resolveAssignmentScope(
  charter: Pick<EffectiveCharter, 'scopeMarketplaces' | 'observationKeys'>,
  target: AssignmentTarget,
): Promise<ResolvedScope> {
  const charterMarkets = charter.scopeMarketplaces ?? []

  // Every observation this worker reads must support the kind, or the run
  // would read some evidence account-wide while claiming to be scoped.
  const need = narrowKindFor(target.kind)
  const unnarrowable = charter.observationKeys.filter((k) => !canNarrowBy(k, need))
  if (unnarrowable.length) {
    return {
      error: `target_unsupported: this worker reads ${unnarrowable.join(', ')}, which cannot be narrowed to a ${target.kind.toLowerCase()}`,
    }
  }

  if (target.kind === 'MARKETPLACE') {
    const asked = [...new Set(target.ids)]
    if (asked.length !== 1) {
      return { error: `target_unresolvable: a marketplace target must name exactly one marketplace` }
    }
    if (charterMarkets.length && !charterMarkets.includes(asked[0])) {
      return {
        error: `target_outside_worker_scope: this worker is limited to ${charterMarkets.join(', ')}, so it cannot be pointed at ${asked[0]}`,
      }
    }
    return { marketplace: asked[0] }
  }

  let ids = [...new Set(target.ids)].filter(Boolean)
  if (ids.length === 0) {
    // Never fall through to account-wide. An empty target is a bug upstream,
    // and running everything is the worst possible interpretation of it.
    return { error: `target_unresolvable: the assignment names no ${target.kind.toLowerCase()}` }
  }

  // PORTFOLIO resolves to its member campaigns and is then enforced exactly
  // as a campaign scope — one binding path, not two.
  if (target.kind === 'PORTFOLIO') {
    const members = await prisma.campaign.findMany({
      where: { portfolioId: { in: ids } },
      select: { externalCampaignId: true },
    })
    const memberIds = members
      .map((c) => c.externalCampaignId)
      .filter((v): v is string => !!v)
    if (memberIds.length === 0) {
      // A portfolio that is empty (or gone) narrows to nothing. Refusing is
      // the only safe reading: running the whole account because a portfolio
      // emptied would be the exact fail-open this design exists to prevent.
      return {
        error: `target_gone: ${ids.length === 1 ? 'that portfolio has' : 'those portfolios have'} no campaigns, so there is nothing to look at`,
      }
    }
    ids = memberIds
  }

  // The campaigns must still exist — a campaign archived or deleted between
  // create and start must stop the run, not silently widen it.
  const asked = new Set(ids)
  const rows = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: ids } },
    select: { externalCampaignId: true, marketplace: true, name: true },
  })
  // Re-assert the ask in code rather than trusting the WHERE clause to be the
  // only thing that bounds it. A resolver whose correctness depends on a query
  // filter it does not re-check is one refactor away from returning a campaign
  // nobody named — which is worse than widening, because the row would still
  // display the campaign the operator chose.
  const found = rows.filter(
    (c) => !!c.externalCampaignId && asked.has(c.externalCampaignId),
  )
  const foundIds = new Set(
    found.map((c) => c.externalCampaignId).filter((v): v is string => !!v),
  )
  const missing = ids.filter((id) => !foundIds.has(id))
  if (missing.length === ids.length) {
    return {
      error: `target_gone: the campaign${ids.length === 1 ? '' : 's'} this assignment names no longer exist${ids.length === 1 ? 's' : ''}`,
    }
  }

  // Intersect with the worker's own marketplace scope, if it has one.
  let allowed = found
  if (charterMarkets.length) {
    allowed = found.filter((c) => charterMarkets.includes(c.marketplace))
    if (allowed.length === 0) {
      return {
        error: `target_outside_worker_scope: this worker is limited to ${charterMarkets.join(', ')}, and none of the named campaigns are in ${charterMarkets.length === 1 ? 'it' : 'those'}`,
      }
    }
  }

  const allowedIds = allowed
    .map((c) => c.externalCampaignId)
    .filter((v): v is string => !!v)

  return {
    narrow: {
      campaignExternalIds: allowedIds,
      campaignLabels: allowed.map((c) => c.name),
    },
    // A campaign target implies its marketplace only when unambiguous; the
    // campaign filter is what actually binds, so this stays undefined rather
    // than adding a second, weaker constraint that would fragment the cache.
  }
}
