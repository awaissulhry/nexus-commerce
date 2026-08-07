/**
 * NAF.A — charter resolution: code truth ⊕ DB policy.
 *
 * Structurally the tool-policy merge (tool-policy.service.ts) with the
 * floor deliberately INVERTED: tool-policy defaults a missing row to
 * enabled=true because copilot tools are operator-invoked; a fleet agent
 * is machine-invoked, so a missing or unreadable policy row resolves to
 * disabled + OFF. The fleet stops when its policy is unreadable.
 *
 * The DB may LOWER budgets and caps below the code charter but never raise
 * them, and its autonomy level is clamped to the code autonomyCap.
 */
import prisma from '../../db.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import {
  AUTONOMY_LEVELS,
  isAutonomyLevel,
  type AutonomyLevel,
} from '../advertising/ads-autonomy.js'
import type { CharterDefinition, EffectiveCharter } from './charter-types.js'
import { getActiveRevisions, type RevisionPolicy } from './charter-revisions.service.js'
import { amazonAdsDirectorCharter } from './charters/amazon-ads-director.charter.js'
import { amazonBidTunerCharter } from './charters/amazon-bid-tuner.charter.js'
import { amazonKeywordHarvesterCharter } from './charters/amazon-keyword-harvester.charter.js'
import { amazonNegativeMinerCharter } from './charters/amazon-negative-miner.charter.js'
import { fleetAuditorCharter } from './charters/fleet-auditor.charter.js'
import { fleetSelftestCharter } from './charters/fleet-selftest.charter.js'
import { planCriticCharter } from './charters/plan-critic.charter.js'

/** Code truth — a charter absent here does not exist, whatever the DB says. */
export const FLEET_CHARTERS: Readonly<Record<string, CharterDefinition>> =
  Object.freeze({
    [fleetSelftestCharter.key]: fleetSelftestCharter,
    [amazonNegativeMinerCharter.key]: amazonNegativeMinerCharter,
    [amazonKeywordHarvesterCharter.key]: amazonKeywordHarvesterCharter,
    [amazonBidTunerCharter.key]: amazonBidTunerCharter,
    [amazonAdsDirectorCharter.key]: amazonAdsDirectorCharter,
    [planCriticCharter.key]: planCriticCharter,
    [fleetAuditorCharter.key]: fleetAuditorCharter,
  })

interface DbCharterPolicy {
  version: number
  enabled: boolean
  autonomyLevel: string
  scopeMarketplaces: string[]
  scopePortfolioIds: string[]
  scopeCampaignIds: string[]
  maxFindingsPerRun: number
  maxToolCallsPerRun: number
  maxTokensPerRun: number
  dailyBudgetUSD: unknown
  maxProposedValueCents: number | null
  toolNames: string[]
  // NAF.AC additions
  modelProviderOverride: string | null
  modelNameOverride: string | null
  pausedUntil: Date | null
  pausedReason: string | null
  /** AC.1 — the active revision, already merged by loadDbPolicies. */
  revision?: {
    id: string
    revision: number
    systemPrompt: string
    policy: RevisionPolicy | null
  }
}

const cache = new TtlCache<Map<string, DbCharterPolicy>>({
  ttlMs: 60_000,
  maxEntries: 1,
})

/** null = the DB could not be read (degraded), distinct from "no rows". */
async function loadDbPolicies(): Promise<Map<string, DbCharterPolicy> | null> {
  const hit = cache.get('all')
  if (hit) return hit
  try {
    const [rows, revisions] = await Promise.all([
      prisma.agentCharter.findMany({
        where: { key: { in: Object.keys(FLEET_CHARTERS) } },
      }),
      // AC.1 — the active revision per charter, read on the same hot path
      // so the merge costs one extra query per cache miss, not per run.
      getActiveRevisions(),
    ])
    const map = new Map<string, DbCharterPolicy>()
    for (const r of rows) {
      // Match the code charter's version exactly — a row for another
      // version is another charter's policy, not this one's.
      if (FLEET_CHARTERS[r.key]?.version !== r.version) continue
      const rev = revisions.get(r.key)
      map.set(r.key, {
        version: r.version,
        enabled: r.enabled,
        autonomyLevel: r.autonomyLevel,
        scopeMarketplaces: r.scopeMarketplaces,
        scopePortfolioIds: r.scopePortfolioIds,
        scopeCampaignIds: r.scopeCampaignIds,
        maxFindingsPerRun: r.maxFindingsPerRun,
        maxToolCallsPerRun: r.maxToolCallsPerRun,
        maxTokensPerRun: r.maxTokensPerRun,
        dailyBudgetUSD: r.dailyBudgetUSD,
        maxProposedValueCents: r.maxProposedValueCents,
        toolNames: r.toolNames,
        modelProviderOverride: r.modelProviderOverride,
        modelNameOverride: r.modelNameOverride,
        pausedUntil: r.pausedUntil,
        pausedReason: r.pausedReason,
        revision: rev
          ? {
              id: rev.id,
              revision: rev.revision,
              systemPrompt: rev.systemPrompt,
              policy: rev.policy,
            }
          : undefined,
      })
    }
    cache.set('all', map)
    return map
  } catch {
    return null
  }
}

export function bustCharterCache(): void {
  cache.clear()
}

function levelIndex(l: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(l)
}

/** min(db, cap) on the OFF<OBSERVE<PROPOSE<AUTO ladder; garbage ⇒ OFF. */
function clampAutonomy(dbLevel: string | undefined, cap: AutonomyLevel): AutonomyLevel {
  const db: AutonomyLevel = isAutonomyLevel(dbLevel) ? dbLevel : 'OFF'
  return levelIndex(db) <= levelIndex(cap) ? db : cap
}

/** DB may lower a numeric cap, never raise it. */
function clampDown(code: number, db: number | undefined | null): number {
  if (db == null || !Number.isFinite(db)) return code
  return Math.min(code, db)
}

function toEffective(
  def: CharterDefinition,
  db: DbCharterPolicy | undefined,
  degraded: boolean,
): EffectiveCharter {
  if (degraded || !db) {
    return {
      ...def,
      enabled: false,
      autonomyLevel: 'OFF',
      scopeMarketplaces: [],
      scopePortfolioIds: [],
      scopeCampaignIds: [],
      pausedUntil: null,
      pausedReason: null,
      degraded,
      // SB.W.1 — a degraded read cannot tell "no row" from "no database", so
      // it reports unknown rather than guessing false. Undegraded and rowless
      // is the honest, checkable "never seeded".
      provisioned: degraded ? null : false,
    }
  }
  // AC.6 — a live pause resolves as not-enabled without touching the dial,
  // so resuming restores exactly what the operator had set.
  const paused = db.pausedUntil != null && new Date(db.pausedUntil).getTime() > Date.now()
  const rp = db.revision?.policy ?? null
  return {
    ...def,
    // AC.1 — code default ⊕ active revision. An absent revision means the
    // code prompt runs; that is the fallback, and it cannot fail.
    systemPrompt: db.revision?.systemPrompt ?? def.systemPrompt,
    activeRevisionId: db.revision?.id,
    activeRevisionNumber: db.revision?.revision,
    enabled: db.enabled && !paused,
    pausedUntil: db.pausedUntil ?? null,
    pausedReason: db.pausedReason ?? null,
    autonomyLevel: clampAutonomy(db.autonomyLevel, def.autonomyCap),
    scopeMarketplaces: db.scopeMarketplaces,
    scopePortfolioIds: db.scopePortfolioIds,
    scopeCampaignIds: db.scopeCampaignIds,
    // AC.5 — the DB may narrow the tool list, never widen it beyond code.
    toolNames: db.toolNames?.length
      ? def.toolNames.filter((t) => db.toolNames.includes(t))
      : def.toolNames,
    // Caps: the DB (and a revision's policy) may TIGHTEN, never loosen —
    // the code value stays the ceiling, like autonomyCap.
    maxFindingsPerRun: clampDown(
      clampDown(def.maxFindingsPerRun, db.maxFindingsPerRun),
      rp?.maxFindingsPerRun,
    ),
    maxToolCallsPerRun: clampDown(def.maxToolCallsPerRun, db.maxToolCallsPerRun),
    maxTokensPerRun: clampDown(
      clampDown(def.maxTokensPerRun, db.maxTokensPerRun),
      rp?.maxTokensPerRun,
    ),
    maxEvidenceAgeHours: clampDown(
      def.maxEvidenceAgeHours ?? Number.POSITIVE_INFINITY,
      rp?.maxEvidenceAgeHours,
    ),
    dailyBudgetUSD: clampDown(
      clampDown(def.dailyBudgetUSD, Number(db.dailyBudgetUSD)),
      rp?.dailyBudgetUSD,
    ),
    modelProvider: db.modelProviderOverride ?? undefined,
    modelName: db.modelNameOverride ?? undefined,
    maxProposedValueCents:
      def.maxProposedValueCents == null
        ? undefined
        : clampDown(def.maxProposedValueCents, db.maxProposedValueCents),
    degraded: false,
    provisioned: true,
  }
}

export async function resolveCharter(
  key: string,
): Promise<EffectiveCharter | null> {
  const def = FLEET_CHARTERS[key]
  if (!def) return null
  const policies = await loadDbPolicies()
  return toEffective(def, policies?.get(key), policies === null)
}

export async function listCharters(): Promise<EffectiveCharter[]> {
  const policies = await loadDbPolicies()
  return Object.values(FLEET_CHARTERS).map((def) =>
    toEffective(def, policies?.get(def.key), policies === null),
  )
}

/** Create-if-absent on (key, version) — never clobbers operator edits. */
export async function seedCharters(): Promise<{ created: number }> {
  let created = 0
  for (const def of Object.values(FLEET_CHARTERS)) {
    const existing = await prisma.agentCharter.findUnique({
      where: { key_version: { key: def.key, version: def.version } },
    })
    if (existing) continue
    await prisma.agentCharter.create({
      data: {
        key: def.key,
        version: def.version,
        tier: def.tier,
        domain: def.domain,
        name: def.name,
        description: def.description ?? null,
        systemPrompt: def.systemPrompt,
        outputSchemaKey: def.outputSchemaKey,
        toolNames: def.toolNames,
        observationKeys: def.observationKeys,
        modelFeature: def.modelFeature,
        fallbackFeature: def.fallbackFeature ?? null,
        autonomyLevel: 'OFF',
        autonomyCap: def.autonomyCap,
        cadence: def.cadence ?? null,
        maxFindingsPerRun: def.maxFindingsPerRun,
        maxToolCallsPerRun: def.maxToolCallsPerRun,
        maxTokensPerRun: def.maxTokensPerRun,
        dailyBudgetUSD: def.dailyBudgetUSD,
        maxProposedValueCents: def.maxProposedValueCents ?? null,
        enabled: false,
      },
    })
    created++
  }
  bustCharterCache()
  return { created }
}
