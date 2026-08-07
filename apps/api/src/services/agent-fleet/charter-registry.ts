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
  /** SB.W.8 — this row's own key. For a code charter it equals the template's;
   *  for an instance it is the operator's new key, and it is what the resolved
   *  charter must carry so runs, findings and audit rows attribute correctly. */
  key: string
  /** SB.W.8 — set when this row is an INSTANCE of a code charter. */
  templateKey?: string | null
  /** SB.W.8 — retired instances are kept as history and MUST NOT run. */
  retired?: boolean
  promptOverlay?: string | null
  /** The instance's own identity, which the template must not overwrite. */
  name?: string
  description?: string | null
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
      // SB.W.8 — no longer filtered to code keys. An INSTANCE has a key of its
      // own that FLEET_CHARTERS has never heard of; filtering here is what
      // would make it invisible. Rows are still validated below: a row whose
      // templateKey names nothing in code is skipped, so a stale or hand-made
      // row cannot conjure a worker.
      prisma.agentCharter.findMany(),
      // AC.1 — the active revision per charter, read on the same hot path
      // so the merge costs one extra query per cache miss, not per run.
      getActiveRevisions(),
    ])
    const map = new Map<string, DbCharterPolicy>()
    for (const r of rows) {
      if (r.templateKey) {
        // An instance: it must name a template that exists in code, and it
        // inherits that template's version. Anything else is skipped.
        if (!FLEET_CHARTERS[r.templateKey]) continue
      } else if (FLEET_CHARTERS[r.key]?.version !== r.version) {
        // A code charter: match the version exactly — a row for another
        // version is another charter's policy, not this one's.
        continue
      }
      const rev = revisions.get(r.key)
      map.set(r.key, {
        key: r.key,
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
        templateKey: r.templateKey,
        retired: r.supersededBy === 'retired',
        promptOverlay: r.promptOverlay,
        name: r.name,
        description: r.description,
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

  /* SB.W.8 — an INSTANCE takes its identity from the row and everything that
     confers capability from the template. The base prompt is always the
     template's; the overlay is APPENDED, never substituted, so an instance can
     narrow or specialise what a worker attends to and can never redefine what
     it is allowed to do. */
  const isInstance = !!db.templateKey
  const basePrompt = db.revision?.systemPrompt ?? def.systemPrompt
  const systemPrompt = isInstance && db.promptOverlay?.trim()
    ? `${basePrompt}\n\n--- Additional instructions for this worker ---\n${db.promptOverlay.trim()}`
    : basePrompt

  return {
    ...def,
    // Identity is the instance's own; capability is never.
    ...(isInstance
      ? {
          key: db.key,
          name: db.name ?? def.name,
          description: db.description ?? def.description,
          templateKey: db.templateKey ?? undefined,
          promptOverlay: db.promptOverlay ?? undefined,
          retired: db.retired ?? false,
        }
      : {}),
    // AC.1 — code default ⊕ active revision. An absent revision means the
    // code prompt runs; that is the fallback, and it cannot fail.
    systemPrompt,
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

/**
 * SB.W.8 — the single resolver, and the meeting point the Workflows stream's
 * stored graph validates against (session-locks §4). A key is either a code
 * charter or an instance naming one; anything else does not exist.
 */
export async function resolveCharter(
  key: string,
): Promise<EffectiveCharter | null> {
  const policies = await loadDbPolicies()
  const row = policies?.get(key)

  // An instance resolves through its template's definition — unless it has
  // been retired, in which case it does not resolve at all. Retirement is a
  // state rather than a delete (its runs and findings are history), so this is
  // the line that makes "retired" mean "cannot run" rather than "hidden".
  if (row?.templateKey) {
    if (row.retired) return null
    const def = FLEET_CHARTERS[row.templateKey]
    if (!def) return null
    return toEffective(def, row, false)
  }

  const def = FLEET_CHARTERS[key]
  if (!def) return null
  return toEffective(def, row, policies === null)
}

/**
 * Code charters ⊕ instances. `resolveCharter` alone is NOT sufficient — this
 * is what the Workers roster, the Controls page and /agent/fleet/graph read,
 * and an instance missing from here would execute correctly while being
 * invisible everywhere. Recorded in the locks doc review for exactly that
 * reason.
 */
export async function listCharters(): Promise<EffectiveCharter[]> {
  const policies = await loadDbPolicies()
  const code = Object.values(FLEET_CHARTERS).map((def) =>
    toEffective(def, policies?.get(def.key), policies === null),
  )
  if (!policies) return code
  const instances: EffectiveCharter[] = []
  for (const row of policies.values()) {
    if (!row.templateKey) continue
    const def = FLEET_CHARTERS[row.templateKey]
    if (!def) continue
    instances.push(toEffective(def, row, false))
  }
  return [...code, ...instances]
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
