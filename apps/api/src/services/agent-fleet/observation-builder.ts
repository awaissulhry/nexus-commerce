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

export interface ObservationBuilder {
  key: string
  ttlMinutes: number
  build(scope: ObservationScope): Promise<{ payload: unknown; dataVintage: Date }>
  /**
   * NAF.SB.AS — narrow an already-computed payload, in memory, for one
   * assignment. Lives beside `build` so knowledge of the payload's shape
   * never leaks into the executor.
   *
   * A builder WITHOUT this cannot be narrowed, and that is a fact the
   * Assignments page reads directly: a worker whose evidence has no
   * `narrow` is not offered a target. The house rule — a control that is
   * not enforced must not be rendered — is enforced by this being optional
   * rather than by anyone remembering it.
   */
  narrow?(payload: unknown, narrow: ObservationNarrow): unknown
}

/** Which observation keys can honestly be narrowed to a campaign. The
 *  Assignments create route refuses any (worker, target) pair whose
 *  evidence is not fully covered here. */
export function canNarrowToCampaign(key: string): boolean {
  return typeof BUILDERS[key]?.narrow === 'function'
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
      payload: applyNarrow(builder, existing.payload, narrow),
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
    payload: applyNarrow(builder, payload, narrow),
    dataVintage,
    computedAt: row.computedAt,
    cached: false,
  }
}

function applyNarrow(
  builder: ObservationBuilder,
  payload: unknown,
  narrow: ObservationNarrow | undefined,
): unknown {
  if (!hasNarrowing(narrow) || !builder.narrow) return payload
  return builder.narrow(payload, narrow!)
}
