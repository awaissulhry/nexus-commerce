/**
 * NAF.A — deterministic evidence, cached (docs/AGENT_FLEET.md §3.2).
 *
 * An observation is NOT model output — it is precomputed truth from the
 * existing substrate, TTL'd into AgentObservation so N agents reading the
 * same evidence trigger one computation. Builders live in observations/
 * and register in the frozen map below (tool-registry idiom).
 *
 * The scope unique on AgentObservation treats NULLs as distinct in
 * Postgres, so the read is findFirst + update-by-id rather than a
 * compound-unique upsert; a lost race costs one duplicate cache row, which
 * the freshest-first read tolerates.
 */
import prisma from '../../db.js'
import { bidProposalsBuilder } from './observations/bid-proposals.observation.js'
import { cronHealthBuilder } from './observations/cron-health.observation.js'
import { fleetHealthBuilder } from './observations/fleet-health.observation.js'
import { harvestCandidatesBuilder } from './observations/harvest-candidates.observation.js'
import { negativeCandidatesBuilder } from './observations/negative-candidates.observation.js'
import { openFindingsBuilder } from './observations/open-findings.observation.js'
import { pendingPlanBuilder } from './observations/pending-plan.observation.js'

export interface ObservationScope {
  entityType?: string
  entityId?: string
  marketplace?: string
}

/**
 * NAF.SB.AS — narrowing that is applied AFTER the cache read and is
 * deliberately NOT part of the cache key.
 *
 * Why not just widen ObservationScope: the unique on AgentObservation is
 * (key, entityType, entityId, marketplace), so keying evidence per campaign
 * would give every campaign-scoped assignment its own cache row — and each
 * one re-runs the same account-wide `previewHarvest` scan. Twenty-five
 * bulk-created assignments would mean twenty-five full scans of sixty days
 * of search terms.
 *
 * So the expensive scan is computed once, account-wide, and shared; the
 * narrowing is a pure in-memory filter over the cached payload. It also
 * keeps `evidenceRefs` pointing at one observation row that every
 * assignment can legitimately cite, which the executor's evidence-id
 * validation requires.
 */
export interface ObservationNarrow {
  /** Amazon EXTERNAL campaign ids. `undefined` = no campaign narrowing at
   *  all; an EMPTY array means narrowed to nothing and yields nothing. */
  campaignExternalIds?: string[]
  /** Frozen labels, for the caveat sentence the analyst reads. */
  campaignLabels?: string[]
}

export function hasNarrowing(n: ObservationNarrow | undefined): boolean {
  return !!n && n.campaignExternalIds !== undefined
}

export interface ObservationResult {
  /** AgentObservation row id — what findings cite in evidenceRefs. */
  id: string
  key: string
  payload: unknown
  dataVintage: Date
  computedAt: Date
  cached: boolean
}

/** NAF.SB.AS — the assignment target kinds evidence can be narrowed by. */
export type NarrowKind = 'CAMPAIGN' | 'MARKETPLACE'

export interface ObservationBuilder {
  key: string
  ttlMinutes: number
  /**
   * NAF.SB.AS.2 — which target kinds this evidence can ACTUALLY honour.
   * Absent or empty = this worker cannot be narrowed at all, and the
   * Assignments picker says so in words rather than greying a row.
   *
   * `CAMPAIGN` cannot lie: the assertion below throws at import time if a
   * builder declares it without a `narrow()`. `MARKETPLACE` is backed by a
   * behavioural vitest, because it binds inside `build(scope)` where a
   * declaration cannot be checked structurally.
   */
  narrowKinds?: readonly NarrowKind[]
  /**
   * NAF.SB.AS.3 — what this evidence IS, in the operator's words. Lives with
   * the builder for the same reason `narrow()` does: the page must never hold
   * its own copy of what a feed contains, or the two drift and the pre-flight
   * describes evidence the worker no longer reads.
   */
  label?: string
  /**
   * NAF.SB.AS.3 — plain sentences describing what a NARROWER scope does to
   * this evidence: what survives, what is withheld, what stays account-wide.
   * Returned by the pre-flight WITHOUT running anything.
   */
  describeNarrowing?(kind: NarrowKind): string[]
  /**
   * NAF.SB.AS.3 — how many things this payload actually holds, so the
   * pre-flight can say "it will look at 4 things" without the page learning
   * every payload's shape. One line per builder, explicit rather than
   * guessed from array fields.
   */
  itemCount?(payload: unknown): number
  build(scope: ObservationScope): Promise<{ payload: unknown; dataVintage: Date }>
  /**
   * NAF.SB.AS — narrow an already-computed payload for one assignment.
   * Lives beside `build` so knowledge of the payload's shape never leaks
   * into the executor.
   *
   * May be async: the bid tuner's proposals carry a targetId but no campaign,
   * so narrowing them needs one join. That is still far cheaper than keying
   * the cache per campaign and re-running the account-wide engine N times.
   */
  narrow?(
    payload: unknown,
    narrow: ObservationNarrow,
  ): unknown | Promise<unknown>
}

/**
 * Which target kinds an observation can honestly be narrowed by. The
 * Assignments create route refuses any (worker, target) pair not fully
 * covered here — every observation the worker reads must support the kind,
 * or the run would read some evidence account-wide while claiming to be
 * scoped.
 */
export function narrowKindsFor(key: string): readonly NarrowKind[] {
  return BUILDERS[key]?.narrowKinds ?? []
}

export function canNarrowBy(key: string, kind: NarrowKind): boolean {
  return narrowKindsFor(key).includes(kind)
}

const BUILDERS: Readonly<Record<string, ObservationBuilder>> = Object.freeze({
  [cronHealthBuilder.key]: cronHealthBuilder,
  [negativeCandidatesBuilder.key]: negativeCandidatesBuilder,
  [harvestCandidatesBuilder.key]: harvestCandidatesBuilder,
  [bidProposalsBuilder.key]: bidProposalsBuilder,
  [openFindingsBuilder.key]: openFindingsBuilder,
  [pendingPlanBuilder.key]: pendingPlanBuilder,
  [fleetHealthBuilder.key]: fleetHealthBuilder,
})

/**
 * NAF.SB.AS.2 — a declaration that cannot lie about CAMPAIGN.
 *
 * Declaring a kind you cannot honour is precisely the defect this series
 * keeps finding (`scopeCampaignIds` was stored, accepted and rendered while
 * binding nothing). So for the half that CAN be checked structurally, it is
 * checked — at import time, so a mistake is a boot failure rather than a
 * worker silently reading the whole account under a scoped assignment.
 */
for (const b of Object.values(BUILDERS)) {
  if (b.narrowKinds?.includes('CAMPAIGN') && typeof b.narrow !== 'function') {
    throw new Error(
      `observation "${b.key}" declares CAMPAIGN narrowing without a narrow() — ` +
        'it would read the whole account while claiming to be scoped',
    )
  }
}

/** NAF.SB.AS.3 — the operator's word for a feed. Falls back to the key so a
 *  new builder is legible before anyone writes it a label. */
export function observationLabel(key: string): string {
  return BUILDERS[key]?.label ?? key
}

/** NAF.SB.AS.3 — what narrowing does to this feed, WITHOUT running it. */
export function observationNarrowNotes(key: string, kind: NarrowKind): string[] {
  return BUILDERS[key]?.describeNarrowing?.(kind) ?? []
}

/** NAF.SB.AS.3 — how many things a built payload holds. Unknown shape → 0,
 *  which reads as "nothing to show" rather than inventing a number. */
export function observationItemCount(key: string, payload: unknown): number {
  try {
    return BUILDERS[key]?.itemCount?.(payload) ?? 0
  } catch {
    return 0
  }
}

export function listObservationKeys(): string[] {
  return Object.keys(BUILDERS)
}

export async function getObservation(
  key: string,
  scope: ObservationScope = {},
  narrow?: ObservationNarrow,
): Promise<ObservationResult> {
  const builder = BUILDERS[key]
  if (!builder) throw new Error(`unknown observation builder: ${key}`)

  // NAF.SB.AS — refuse rather than ignore. A caller asking to narrow a
  // builder that cannot narrow would otherwise get account-wide evidence
  // while believing it was scoped; that is the exact defect this series
  // wrote its house rule about.
  if (hasNarrowing(narrow) && !builder.narrow) {
    throw new Error(
      `observation "${key}" cannot be narrowed to a campaign — it has no narrow()`,
    )
  }

  const where = {
    key,
    entityType: scope.entityType ?? null,
    entityId: scope.entityId ?? null,
    marketplace: scope.marketplace ?? null,
  }
  const existing = await prisma.agentObservation.findFirst({
    where,
    orderBy: { computedAt: 'desc' },
  })
  if (existing && existing.expiresAt > new Date()) {
    return {
      id: existing.id,
      key,
      payload: await applyNarrow(builder, existing.payload, narrow),
      dataVintage: existing.dataVintage,
      computedAt: existing.computedAt,
      cached: true,
    }
  }

  const { payload, dataVintage } = await builder.build(scope)
  const expiresAt = new Date(Date.now() + builder.ttlMinutes * 60_000)
  const data = {
    payload: payload as object,
    dataVintage,
    computedAt: new Date(),
    expiresAt,
  }
  const row = existing
    ? await prisma.agentObservation.update({ where: { id: existing.id }, data })
    : await prisma.agentObservation.create({ data: { ...where, ...data } })
  return {
    id: row.id,
    key,
    // The row stored above is the ACCOUNT-wide payload — shared, and cited
    // by evidenceRefs. What the caller reads is the narrowed view of it.
    payload: await applyNarrow(builder, payload, narrow),
    dataVintage,
    computedAt: row.computedAt,
    cached: false,
  }
}

async function applyNarrow(
  builder: ObservationBuilder,
  payload: unknown,
  narrow: ObservationNarrow | undefined,
): Promise<unknown> {
  if (!hasNarrowing(narrow) || !builder.narrow) return payload
  return await builder.narrow(payload, narrow!)
}
