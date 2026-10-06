/**
 * ADS AUTONOMY W1-2 — the field registry of the Amazon Ads strategy (AdsStrategy): every field the Owner can set per
 * market, category or product, in ONE list that drives the resolver, the read tool, the screen labels and the honest
 * "read by" lists. Pure: no database, no clock.
 *
 *   columns      the AdsStrategy columns a field holds. A GROUP (target, harvest, negate, stop) resolves WHOLE: it is
 *                set on a row only when its `required` columns are all set, and then every column comes from that row
 *   levels       where it may be set (most actions per run: the market only; protect: a category or a product)
 *   resolve      `inherit` — the most specific row that sets it wins (product → category → market);
 *                `everyScope` — the monthly cap: each scope's cap binds on that scope's own spend, so every cap of a
 *                scope the subject belongs to is in force at once (nothing is inherited)
 *   safer        how one value is chosen when several products (an ad group, a campaign) or several categories of one
 *                product each give one: the one that spends less (the Owner's rule for shared ad groups)
 *   raise        what counts as loosening, for the writer (W1-3): a raise needs the Owner's authenticator code
 *   money        ad-spend money: hidden from a person without financials.adspend.view
 *   readBy       the engines and doors that ACT on it. Each W1 engine PR adds itself here, so a screen never claims a
 *                reader that does not exist. W1-5 (bids): the target, the lowest and highest bid and the largest bid
 *                change. Every other field is stored and shown only (`notReadYet`).
 *
 * 🔴 Units. `*Pct` is an INTEGER PERCENT (25 = 25 %), never a fraction — the AdsAutomationState.defaultTargetAcosPct
 * convention. The engines take fractions (Campaign.dynamicBidding.targetAcos = 0.25). The two meet ONLY through
 * `pctToFraction` / `fractionToPct` below; a stored 0.3 is not read as 30 % (nor 30 as 3,000 %).
 */
import { FIELDS } from '@nexus/shared/permissions'
import type { ClaudeTrust } from '../../agents/tool-types.js'
import { MAX_ACCOUNT_DEFAULT_PCT } from '../ads-target-acos-resolver.js'

export const STRATEGY_CHANNELS = ['AMAZON'] as const
export type StrategyChannel = (typeof STRATEGY_CHANNELS)[number]

/** Most specific last. Every row belongs to ONE market (Owner decision 2026-10-06). */
export const STRATEGY_LEVELS = ['MARKET', 'CATEGORY', 'PRODUCT'] as const
export type StrategyLevel = (typeof STRATEGY_LEVELS)[number]
/** The market row's scope id: Postgres treats NULLs as distinct in a unique index, so the market row is '*'. */
export const MARKET_SCOPE = '*'

/** Descriptive in W1: Claude reads it; no engine derives a number from it (lifecycle goals are W5). */
export const STRATEGY_GOALS = ['LAUNCH', 'GROW', 'PROFIT', 'CLEAR_STOCK', 'DEFEND'] as const
/** Engines steer by ACoS only: a TACOS target is stored and shown, and engines fall through to the next ACoS target. */
export const TARGET_KINDS = ['ACOS', 'TACOS'] as const
/** A temporary stop. W1 engines stop with low bids only; PAUSE waits for W2/W3. */
export const STOP_METHODS = ['LOW_BIDS', 'PAUSE'] as const

/**
 * What Claude may do alone, per kind of ad action: the strategy NARROWS the business's trust level for these tools,
 * never widens it (W1-8). Brakes are never narrowed (stop-automation, turn-down-automation, a tightening guardrail).
 */
export const CLAUDE_ACTION_TOOLS = {
  bid: ['set-target-bid', 'bulk-ad-bid-change'],
  negative: ['create-negative-keyword'],
  harvest: ['graduate-keyword'],
  placement: ['set-placement-multipliers'],
  budget: ['set-campaign-budget'],
  target: ['set-campaign-target-acos'],
  suggestion: ['decide-automation-suggestions'],
  stop: ['suppress-campaign'],
  restore: ['restore-campaign'],
  create: ['create-ad-campaign'],
  rule: ['save-ad-rule'],
  undo: ['undo-ad-change'],
} as const satisfies Record<string, readonly string[]>
export type ClaudeActionType = keyof typeof CLAUDE_ACTION_TOOLS
export const CLAUDE_ACTION_TYPES = Object.keys(CLAUDE_ACTION_TOOLS) as ClaudeActionType[]
/** Lowest first; the lower of two levels is the safer one. */
export const CLAUDE_LEVELS: readonly ClaudeTrust[] = ['off', 'ask', 'confirm', 'auto']

// ── Units ─────────────────────────────────────────────────────────────────────────────────────────

/** The highest target ACoS (or TACoS) a strategy holds: the same 500 % the account default and the screens accept. */
export const MAX_TARGET_PCT = MAX_ACCOUNT_DEFAULT_PCT
/**
 * The 2¢ floor a stop lowers bids to when the strategy names no stop bid: SUPPRESSION_FLOOR_CENTS
 * (ads-bid-suppression.service.ts, whose module graph a registry should not load; fields.vitest.test.ts pins the two).
 */
export const DEFAULT_STOP_BID_CENTS = 2

/** An integer percent as the fraction the engines take: 25 → 0.25. Null for anything that is not a whole percent 1–500. */
export function pctToFraction(pct: unknown): number | null {
  if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 1 || pct > MAX_TARGET_PCT) return null
  return pct / 100
}

/** A fraction as an integer-percent reading, to 2 decimals: 0.25 → 25 (0.3 → 30, never 30.000000000000004). */
export function fractionToPct(fraction: number): number {
  return Math.round(fraction * 10_000) / 100
}

// ── The registry ──────────────────────────────────────────────────────────────────────────────────

/** The AdsStrategy columns that hold the Owner's settings (scope, version and audit columns are not settings). */
export type StrategyColumn =
  | 'goal' | 'goalNote' | 'targetKind' | 'targetPct' | 'monthlySpendCapCents' | 'minBidCents' | 'maxBidCents'
  | 'maxChangePct' | 'maxActionsPerRun' | 'protect' | 'harvestMinOrders' | 'harvestMinClicks' | 'harvestMaxAcosPct'
  | 'harvestWindowDays' | 'negateMinClicks' | 'negateMinSpendCents' | 'negateMaxOrders' | 'negateWindowDays'
  | 'stopMethod' | 'stopBidCents' | 'claudeAutonomy' | 'reviewEveryDays'

/** How one stored value is checked when it is read: anything else is ignored and named in a warning. */
export type ColumnCheck =
  | { kind: 'int'; min: number; max?: number; allowed?: readonly number[] }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text'; maxLength: number }
  | { kind: 'boolean' }
  | { kind: 'autonomy' }

export const COLUMN_CHECKS: Readonly<Record<StrategyColumn, ColumnCheck>> = {
  goal: { kind: 'enum', values: STRATEGY_GOALS },
  goalNote: { kind: 'text', maxLength: 2000 },
  targetKind: { kind: 'enum', values: TARGET_KINDS },
  targetPct: { kind: 'int', min: 1, max: MAX_TARGET_PCT },
  monthlySpendCapCents: { kind: 'int', min: 0 },
  minBidCents: { kind: 'int', min: 0 },
  maxBidCents: { kind: 'int', min: 0 },
  maxChangePct: { kind: 'int', min: 1, max: 100 },
  maxActionsPerRun: { kind: 'int', min: 0 },
  protect: { kind: 'boolean' },
  // The harvest bounds are the stored harvest policy's own (harvest-policy.service.ts validateCriteria).
  harvestMinOrders: { kind: 'int', min: 1, max: 100 },
  harvestMinClicks: { kind: 'int', min: 0, max: 10_000 },
  harvestMaxAcosPct: { kind: 'int', min: 1, max: 1000 },
  harvestWindowDays: { kind: 'int', min: 30, max: 90, allowed: [30, 60, 90] },
  negateMinClicks: { kind: 'int', min: 0, max: 10_000 },
  negateMinSpendCents: { kind: 'int', min: 0 },
  negateMaxOrders: { kind: 'int', min: 0, max: 100 },
  negateWindowDays: { kind: 'int', min: 30, max: 90, allowed: [30, 60, 90] },
  stopMethod: { kind: 'enum', values: STOP_METHODS },
  stopBidCents: { kind: 'int', min: DEFAULT_STOP_BID_CENTS, max: 100 },
  claudeAutonomy: { kind: 'autonomy' },
  reviewEveryDays: { kind: 'int', min: 1, max: 90 },
}

export type SaferRule =
  | 'lower'            // the lower number spends less
  | 'anyProtected'     // one protected product protects the ad group
  | 'stricterHarvest'  // the group that needs more evidence: higher min orders, then higher min clicks
  | 'stricterNegate'   // the group that needs more evidence: higher min clicks, then higher min spend
  | 'saferStop'        // low bids over a pause, then the lower stop bid
  | 'lowerLevel'       // Claude autonomy: the lower level per action type
  | 'mixed'            // descriptive (goal, why, the target as written): shown per product when they differ
  | 'ownSpend'         // the monthly cap: not merged — each scope's cap binds on its own spend

export type RaiseRule =
  | 'up'         // going up, or cleared to "none", loosens
  | 'floor'      // going up, or a floor appearing, forces spend
  | 'unprotect'  // true → false, or cleared
  | 'loosen'     // less evidence needed, a higher ceiling, or any window change
  | 'target'     // up, a kind switch, or cleared to a higher inherited value
  | 'pause'      // LOW_BIDS → PAUSE
  | 'autonomy'   // any action type's level up, or a key removed
  | 'any'        // any change (no clear direction)
  | 'never'      // free to change

export type StrategyFieldKey =
  | 'goal' | 'goalNote' | 'target' | 'targetAcosPct' | 'monthlySpendCapCents' | 'minBidCents' | 'maxBidCents'
  | 'maxChangePct' | 'maxActionsPerRun' | 'protect' | 'harvest' | 'negate' | 'stop' | 'claudeAutonomy' | 'reviewEveryDays'

export interface StrategyField {
  key: StrategyFieldKey
  /** What a screen calls it. */
  label: string
  columns: readonly StrategyColumn[]
  /** A group is set on a row when these columns are all set (default: every column). */
  required?: readonly StrategyColumn[]
  /** Derived from another field rather than stored (the ACoS target engines steer by, from `target`). */
  derivedFrom?: StrategyFieldKey
  levels: readonly StrategyLevel[]
  resolve: 'inherit' | 'everyScope'
  safer: SaferRule
  raise: RaiseRule
  money: boolean
  readBy: readonly string[]
}

const ALL_LEVELS = STRATEGY_LEVELS

/** The readers, named once, so every field one of them reads says it the same way (W1-5: the bid engines). */
export const READERS = {
  optimiser: 'the bid optimiser (auto-bid, bid recommendations, target-ACoS bid rules)',
  bidRules: 'bid rules (bid_apply)',
  autopilot: 'autopilot plans',
  gate: "the write gate (refuses an engine's or a rule's bid outside it; a person's own edit, or a Claude request he approves, is warned and goes when he confirms)",
  hourly: 'hourly bid plans (the base bid)',
  restores: 'restores after a stop',
  stepClamp: "the step clamp on engine, rule and Claude bid changes (not a person's own edit)",
  claudePreview: "Claude's bid previews",
} as const
const TARGET_READERS = [READERS.optimiser, READERS.bidRules, READERS.autopilot]
const BAND_READERS = [READERS.gate, READERS.optimiser, READERS.bidRules, READERS.hourly, READERS.restores, READERS.autopilot]
const STEP_READERS = [READERS.stepClamp, READERS.optimiser, READERS.claudePreview, READERS.autopilot]

export const STRATEGY_FIELDS: readonly StrategyField[] = [
  { key: 'goal', label: 'Goal', columns: ['goal'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'mixed', raise: 'any', money: false, readBy: [] },
  { key: 'goalNote', label: 'Why', columns: ['goalNote'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'mixed', raise: 'never', money: false, readBy: [] },
  // Read as an ACoS target only: a TACoS target is stored and shown, and the engines take the next ACoS target down.
  { key: 'target', label: 'Target', columns: ['targetKind', 'targetPct'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'mixed', raise: 'target', money: true, readBy: TARGET_READERS },
  // The number Nexus's bid engines steer by: the first ACoS target down the chain (a TACoS target is skipped), after a
  // rule's or plan's own number and the campaign's own target, before the account default.
  { key: 'targetAcosPct', label: 'Target ACoS the engines use', columns: ['targetKind', 'targetPct'], derivedFrom: 'target', levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'target', money: true, readBy: TARGET_READERS },
  { key: 'monthlySpendCapCents', label: 'Monthly spend cap', columns: ['monthlySpendCapCents'], levels: ALL_LEVELS, resolve: 'everyScope', safer: 'ownSpend', raise: 'up', money: true, readBy: [] },
  { key: 'minBidCents', label: 'Lowest bid', columns: ['minBidCents'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'floor', money: true, readBy: BAND_READERS },
  { key: 'maxBidCents', label: 'Highest bid', columns: ['maxBidCents'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'up', money: true, readBy: BAND_READERS },
  { key: 'maxChangePct', label: 'Largest bid change per action', columns: ['maxChangePct'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'up', money: false, readBy: STEP_READERS },
  { key: 'maxActionsPerRun', label: 'Most actions per run', columns: ['maxActionsPerRun'], levels: ['MARKET'], resolve: 'inherit', safer: 'lower', raise: 'up', money: false, readBy: [] },
  { key: 'protect', label: 'Protected', columns: ['protect'], levels: ['CATEGORY', 'PRODUCT'], resolve: 'inherit', safer: 'anyProtected', raise: 'unprotect', money: false, readBy: [] },
  {
    key: 'harvest', label: 'Harvest a search term when', columns: ['harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays'],
    // The ACoS ceiling may be empty inside a set group: no ceiling (as a stored harvest policy).
    required: ['harvestMinOrders', 'harvestMinClicks', 'harvestWindowDays'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'stricterHarvest', raise: 'loosen', money: true, readBy: [],
  },
  {
    key: 'negate', label: 'Negate a search term when', columns: ['negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays'],
    levels: ALL_LEVELS, resolve: 'inherit', safer: 'stricterNegate', raise: 'loosen', money: true, readBy: [],
  },
  // The stop bid may be empty inside a set group: the existing 2¢ floor.
  { key: 'stop', label: 'Temporary stop', columns: ['stopMethod', 'stopBidCents'], required: ['stopMethod'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'saferStop', raise: 'pause', money: true, readBy: [] },
  { key: 'claudeAutonomy', label: 'What Claude may do alone', columns: ['claudeAutonomy'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lowerLevel', raise: 'autonomy', money: false, readBy: [] },
  { key: 'reviewEveryDays', label: 'Review every (days)', columns: ['reviewEveryDays'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'up', money: false, readBy: [] },
]

export const FIELD_BY_KEY: ReadonlyMap<StrategyFieldKey, StrategyField> = new Map(STRATEGY_FIELDS.map((f) => [f.key, f]))

/** The columns of a field that must be set on a row for that row to set the field. */
export const requiredColumns = (field: StrategyField): readonly StrategyColumn[] => field.required ?? field.columns

/** The fields no engine or door acts on yet. Shrinks as the W1 engine PRs ship (W1-5 took the bid fields). */
export function notReadYet(): StrategyFieldKey[] {
  return STRATEGY_FIELDS.filter((f) => f.readBy.length === 0).map((f) => f.key)
}

/**
 * The money keys of every strategy answer, each with the permission that reveals it. A money value always sits alone
 * under one of these keys (never under a generic `value`), so the money filter removes exactly the money and leaves
 * where it comes from: the read tool's `restrictedFields`, and the strategy GET routes.
 */
export const STRATEGY_MONEY: Readonly<Record<string, string>> = Object.fromEntries(
  ['targetPct', 'targetAcosPct', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'harvestMaxAcosPct', 'negateMinSpendCents', 'stopBidCents', 'monthlyBudgetCents']
    .map((key) => [key, FIELDS.financialsAdspendView]),
)
