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
}
