/**
 * NAF.A — charter shapes (docs/AGENT_FLEET.md Parts 3-4).
 *
 * A CharterDefinition is the code truth for WHAT an agent is: prompt,
 * output contract, evidence keys, model routing, caps. The AgentCharter DB
 * row is the operator truth for WHETHER/HOW it runs (enabled, autonomy,
 * scope, lowered budgets). The merge lives in charter-registry.ts.
 *
 * Autonomy vocabulary is imported from ads-autonomy.ts (plan D8) — the
 * fleet adds no fourth dial.
 */
import type { OutputSchemaKey } from '@nexus/shared/agent-fleet'
import type { AutonomyLevel } from '../advertising/ads-autonomy.js'

export type CharterTier =
  | 'analyst'
  | 'director'
  | 'strategist'
  | 'critic'
  | 'auditor'

export interface CharterDefinition {
  /** Stable kebab-case id; doubles as AgentRun.agentKey for fleet runs. */
  key: string
  version: number
  tier: CharterTier
  domain: string
  name: string
  description?: string
  systemPrompt: string
  outputSchemaKey: OutputSchemaKey
  toolNames: string[]
  observationKeys: string[]
  /** AI-2 feature key → model-resolver. */
  modelFeature: string
  fallbackFeature?: string
  /** Ceiling the operator cannot exceed; DB may only clamp downward. */
  autonomyCap: AutonomyLevel
  /**
   * NAF.SB.W.1 — this worker's findings are about the FLEET, not about the
   * operator's account, so the registry badges it and leaves it out of the
   * headline totals. `fleet-selftest` alone holds 47 of 64 open findings and
   * 38 of 47 runs; counted in, every figure on the Workers page is mostly
   * about a self-test.
   *
   * An explicit flag rather than a heuristic on `domain`. Two reasons, both
   * concrete: `fleet-auditor` is `domain: 'fleet'` and would be missed, and
   * `domain: 'ops'` is where docs/AGENT_FLEET.md Part 6 puts `ops-schema-drift`,
   * `ops-sync-health` and `ops-tech-debt-triage` — real business analysts a
   * domain rule would wrongly exclude the day they are written.
   */
  diagnostic?: boolean
  /** Cron expr; undefined = orchestrated only. */
  cadence?: string
  /** NAF.B — regex source every finding's dedupeKey must match. Enforced
   *  by the executor's validation stage (retry-once path). Absent = not
   *  enforced (Phase A charters unchanged). Grammar: `<kind>:<entityId>`. */
  dedupeKeyPattern?: string
  /** NAF.B — max age of any gathered observation's dataVintage, in hours.
   *  Enforced BEFORE the model call (a denied run costs $0). Absent = not
   *  enforced. */
  maxEvidenceAgeHours?: number
  maxFindingsPerRun: number
  maxToolCallsPerRun: number
  maxTokensPerRun: number
  dailyBudgetUSD: number
  maxProposedValueCents?: number
}

export interface EffectiveCharter extends CharterDefinition {
  /** AC.1 — set when an operator revision is in force; absent = code charter. */
  activeRevisionId?: string
  activeRevisionNumber?: number
  /** AC.4 — per-worker model pin; absent = inherit the tier preference. */
  modelProvider?: string
  modelName?: string
  /** AC.6 — a temporary stop with an expiry. */
  pausedUntil?: Date | null
  pausedReason?: string | null
  enabled: boolean
  /** min(DB level, autonomyCap); DB row absent or unreadable ⇒ 'OFF'. */
  autonomyLevel: AutonomyLevel
  scopeMarketplaces: string[]
  scopePortfolioIds: string[]
  scopeCampaignIds: string[]
  /** True when the DB policy could not be read — the values alongside are
   *  the fail-safe posture, not an operator's choice. */
  degraded: boolean
  /**
   * NAF.SB.W.1 — does an `AgentCharter` row actually exist for this key?
   *
   * A charter with no row resolves to `enabled: false, autonomyLevel: 'OFF',
   * degraded: false` — identical, field for field, to one an operator
   * deliberately switched off. Without this flag no client can tell "I turned
   * this off" from "this was never seeded", and `fleet-auditor` has been in
   * exactly that state since it was written.
   *
   * `null` means *unknown*, not *no*: when `degraded` is true the policy read
   * failed outright, so absence of a row cannot be distinguished from absence
   * of a database. Callers must branch on `degraded` first.
   */
  provisioned: boolean | null
}
