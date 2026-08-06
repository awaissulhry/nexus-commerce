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
): Promise<ObservationResult> {
  const builder = BUILDERS[key]
  if (!builder) throw new Error(`unknown observation builder: ${key}`)

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
      payload: existing.payload,
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
    payload,
    dataVintage,
    computedAt: row.computedAt,
    cached: false,
  }
}
