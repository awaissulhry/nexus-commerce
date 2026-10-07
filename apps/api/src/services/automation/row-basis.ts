/**
 * The basis of a change to a row an engine also writes: a fingerprint of what the change DEPENDS ON, never of the row's
 * bookkeeping.
 *
 * An approval is re-checked before it runs: its tool's dry run again, compared on the preview's `basis`. That basis was
 * the row's `updatedAt`, and Prisma moves `updatedAt` on EVERY write — also the ones an engine makes on its own tick. The
 * ads rule evaluator (every 15 minutes) writes each rule's `evaluationCount` and `lastEvaluatedAt`, so every approval of
 * a rule change that waited past a quarter hour was skipped as "the facts moved since you approved it" although nobody
 * had touched the rule (measured on production, 2026-10-07: 5 of 7 turn-ups of one plan).
 *
 * So a basis names the row's own settings (`basisOf` of the fields a person or a tool sets) and leaves out what the
 * engines write: counters, last-run stamps, what they applied. A person's edit of any setting still moves it.
 */
import { createHash } from 'node:crypto'

/** The JSON of a value with keys sorted at every depth (jsonb re-orders keys); a Date as its ISO string. */
function canonical(value: unknown): string {
  const plain = JSON.stringify(value ?? null)
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(plain)))
}

/** A short stable fingerprint of a value (the same value, whatever the order of its keys, gives the same text). Pure. */
export function basisOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
}

/** The fields of a row, picked (an absent field reads null, so a column added later does not move old bases). */
export function pickFields<K extends string>(row: Record<string, unknown>, fields: readonly K[]): Record<K, unknown> {
  return Object.fromEntries(fields.map((f) => [f, row[f] ?? null])) as Record<K, unknown>
}

/**
 * An AutomationRule's own settings: what a level move, a save or a stop depends on. NOT the evaluator's bookkeeping
 * (`evaluationCount`, `matchCount`, `executionCount`, `lastEvaluatedAt`, `lastMatchedAt`, `lastExecutedAt`) nor
 * `updatedAt`, which every one of those writes moves.
 */
export const RULE_SETTING_FIELDS = [
  'name', 'domain', 'trigger', 'conditions', 'actions', 'enabled', 'dryRun', 'autonomyLevel', 'priority',
  'maxExecutionsPerDay', 'maxWritesPerDay', 'maxValueCentsEur', 'maxDailyAdSpendCentsEur',
  'scopeMarketplace', 'scopePortfolioId', 'scopeCampaignId', 'scopeProductId',
] as const

/** The basis of an AutomationRule (any domain): its settings' fingerprint. Pure. */
export function ruleBasis(rule: Record<string, unknown>): string {
  return `rule:${basisOf(pickFields(rule, RULE_SETTING_FIELDS))}`
}

/**
 * A RepricingRule's own settings. NOT the repricing engine's snapshot of its last run (`lastEvaluatedAt`,
 * `lastDecisionPrice`, `lastDecisionReason`) nor `updatedAt`, which that write moves on every evaluation.
 */
export const REPRICING_RULE_SETTING_FIELDS = [
  'productId', 'channel', 'marketplace', 'enabled', 'minPrice', 'maxPrice', 'strategy', 'beatPct', 'beatAmount',
  'activeFromHour', 'activeToHour', 'activeDays', 'notes',
] as const

/** The basis of a RepricingRule: its settings' fingerprint (a Decimal as its text). Pure. */
export function repricingRuleBasis(rule: Record<string, unknown>): string {
  return `repricing-rule:${basisOf(pickFields(rule, REPRICING_RULE_SETTING_FIELDS))}`
}

/**
 * The settings of the other rows an engine writes on its own tick, by kind — each kind's own fields a person or a tool
 * sets, never what the engine stamps on it (in brackets: what each engine writes, which moves `updatedAt`):
 *   adsAutomationState   the ads dial, the halt, the breaker's limits, the default target ACOS (the anomaly guard's
 *                        `lastCheckedAt`, every 10 minutes)
 *   autopilotPlan        (the autopilot's `lastEvaluatedAt`, `linkedRuleIds`, `lastDecisionAt`, every 15 minutes)
 *   adSchedule           a dayparting / hourly schedule (the engines' `lastApplied`, `lastEvaluatedAt`, `originalBids`)
 *   budgetSchedule       (the budget scheduler's `lastApplied`, `lastEvaluatedAt`, every 15 minutes; `chartPrefs` is
 *                        how the screen draws it)
 *   budgetPool           (the rebalancer's `lastRebalancedAt`, every 15 minutes)
 *   rankTarget           (the rank-targets read re-seeds the built-ins on every screen load)
 *   ebayAdsRule          (the eBay ads automation's `lastEvaluatedAt`, `cooldownUntil`, daily)
 *   keywordCoverageSet   no engine stamp today: listed so its switch reads like the others
 */
export const ROW_SETTING_FIELDS = {
  adsAutomationState: ['autonomy', 'halted', 'haltedAt', 'haltReason', 'haltedBy', 'maxHourlySpendCentsEur', 'maxActionsPerHour', 'defaultTargetAcosPct'],
  autopilotPlan: ['name', 'marketplace', 'productGroupName', 'campaignIds', 'goal', 'autonomy', 'guardrails', 'modules', 'graph', 'stage', 'enabled'],
  adSchedule: ['campaignId', 'name', 'windows', 'timezone', 'enabled', 'defaultTargetKey', 'targetOverrides', 'groupId'],
  budgetSchedule: ['name', 'kind', 'type', 'campaigns', 'windows', 'timezone', 'startDate', 'endDate', 'neverExpire', 'excludeDates', 'autoRefill', 'enabled'],
  budgetPool: ['name', 'description', 'currency', 'totalDailyBudgetCents', 'strategy', 'coolDownMinutes', 'maxShiftPerRebalancePct', 'enabled', 'dryRun'],
  rankTarget: [
    'key', 'name', 'placement', 'targetISPct', 'acosCapPct', 'maxCpcCents', 'biasPct', 'jumpStartPct', 'stepUpPct', 'stepDownPct', 'maxBiasPct',
    'keepClimbing', 'pause', 'floorBidCents', 'allOut', 'lanes', 'bidMode', 'bidValueCents', 'bidDeltaPct', 'color', 'builtIn', 'sortOrder',
    'scopeProductId', 'scopeCampaignId',
  ],
  ebayAdsRule: ['name', 'enabled', 'mode', 'marketplace', 'scope', 'trigger', 'action', 'guardrails', 'version', 'cooldownHours'],
  keywordCoverageSet: ['portfolioId', 'marketplace', 'name', 'enabled', 'dailySpendCapCents', 'acosCapPct'],
} as const satisfies Record<string, readonly string[]>

export type SettingsKind = keyof typeof ROW_SETTING_FIELDS

/** The basis of a row of one of those kinds: its settings' fingerprint; null for no row. Pure. */
export function settingsBasis(kind: SettingsKind, row: Record<string, unknown> | null | undefined): string | null {
  return row ? `${kind}:${basisOf(pickFields(row, ROW_SETTING_FIELDS[kind]))}` : null
}
