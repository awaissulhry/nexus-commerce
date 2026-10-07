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
 *   readBy       the engines and doors that ACT on it, each saying where it acts. Each W1 reader adds itself here, so a
 *                screen never claims a reader that does not exist (W1-5: the bid engines on the target, the lowest and
 *                highest bid and the largest bid change; W1-6: the monthly market cap, the stop bid and the actions per
 *                run; W1-6b: category and product caps too; W1-7: the search-term thresholds and protection; W1-8:
 *                Claude's door, what Claude may do alone; AA-W2-2b: Claude's door, what may run by rule in a market a
 *                day); a field with no reader is stored and shown only (`notReadYet`).
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
 * never widens it (W1-8, ads-strategy/claude.ts). Brakes are never narrowed (stop-automation, turn-down-automation, a
 * tightening guardrail): none is listed here. AA-W2-12 — a real pause and an enable are kinds of their own: a temporary
 * stop stays `stop` (low bids). AA-W2-13 — and an archive (Owner D-W2-5: one kind; Amazon's delete is the same archive).
 */
export const CLAUDE_ACTION_TOOLS = {
  bid: ['set-target-bid', 'bulk-ad-bid-change'],
  negative: ['create-negative-keyword'],
  harvest: ['graduate-keyword'],
  placement: ['set-placement-multipliers'],
  budget: ['set-campaign-budget'],
  target: ['set-campaign-target-acos'],
  suggestion: ['decide-automation-suggestions'],
  // ADS AUTONOMY W3-3 — a stock brake is a temporary stop with low bids too (an ad group short of stock), and giving
  // its bids back a restore.
  stop: ['suppress-campaign', 'lower-ad-bids-for-stock'],
  restore: ['restore-campaign', 'restore-ad-bids-after-stock'],
  // PB-5a — a playbook build creates campaigns (apply-ads-playbook op build; its other ops map in OP_ACTIONS, claude.ts).
  // B-1 — so does a copy of a running structure (replicate-ad-structure, Replicate Structure's own run).
  // B-2 — so does an AI goal (create-ai-goal-campaigns).
  // B-3 — and a one-off SP Super Wizard set.
  create: ['create-ad-campaign', 'apply-ads-playbook', 'create-ai-goal-campaigns', 'replicate-ad-structure', 'build-sp-wizard-campaigns'],
  rule: ['save-ad-rule'],
  undo: ['undo-ad-change'],
  // AA-W2-9 (D-W2-6 = A) — a new campaign goes live in three kinds: create, allowlist (Claude's own), restore.
  allowlist: ['set-campaign-live-writes'],
  // AA-W2-11 — an Amazon ads automation moved up or tuned, where it acts (automation-scope.ts): its products, else its
  // market. Turning one down stays a brake (never narrowed).
  automation: ['turn-up-automation', 'tune-ad-engine'],
  pause: ['pause-ads'],
  enable: ['enable-ads'],
  archive: ['archive-ads'],
  // PB-9 — a product's playbook phase switch (apply-ads-playbook op phase, OP_ACTIONS in claude.ts): its own kind, so the
  // Owner decides per market, category or product whether a phase move may run alone. Listed after `create`: the tool's
  // own kind stays create (claude.ts reads the first kind a tool is listed under).
  phase: ['apply-ads-playbook'],
  // W4-3 — a campaign's settings (its name, portfolio, end date, bidding strategy), and a portfolio made, renamed, capped
  // or archived (set-portfolio op archive is the archive kind too: OP_ACTIONS, claude.ts).
  settings: ['set-campaign-settings'],
  portfolio: ['set-portfolio'],
  // W4-1 — the hourly bid plans of the Hourly Bids page (create, paint, members, rename, switch, delete, per-campaign
  // values): their own kind, so the Owner decides per market, category or product whether a plan change may run alone.
  hourly: ['set-hourly-bid-plan'],
} as const satisfies Record<string, readonly string[]>
export type ClaudeActionType = keyof typeof CLAUDE_ACTION_TOOLS
export const CLAUDE_ACTION_TYPES = Object.keys(CLAUDE_ACTION_TOOLS) as ClaudeActionType[]
/** Lowest first; the lower of two levels is the safer one. AA-W2-4 — watch sits below auto: the strategy may hold a kind at watch. */
export const CLAUDE_LEVELS: readonly ClaudeTrust[] = ['off', 'ask', 'confirm', 'watch', 'auto']
/** The reader of `claudeAutonomy` (W1-8): every ad change Claude asks for is held to the lower level. */
export const CLAUDE_DOOR = "Claude's door (every ad change Claude asks for)"

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

// ── Search-term groups ────────────────────────────────────────────────────────────────────────────

/** When a search term is harvested (graduated to its own keyword or product target), in the engines' shape. */
export interface HarvestThresholds { minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number }
/** When a search term is negated, in the engines' shape. */
export interface NegateThresholds { minClicks: number; minSpendCents: number; maxOrders: number; windowDays: number }

/**
 * W1-7 — the ONE order "stricter" follows for two harvest groups, wherever two meet: across the products of an ad
 * group (the resolver), and the strategy against a stored harvest policy (the read tool, the Keyword Harvest page).
 * More orders, then more clicks, then a lower ACoS ceiling (a ceiling beats none). True when `a` asks for MORE
 * evidence than `b`; two equal groups are not stricter than each other. The window has no direction (a longer one
 * sees more orders and more spend) and decides nothing here.
 */
export function harvestStricter(a: Omit<HarvestThresholds, 'windowDays'>, b: Omit<HarvestThresholds, 'windowDays'>): boolean {
  if (a.minOrders !== b.minOrders) return a.minOrders > b.minOrders
  if (a.minClicks !== b.minClicks) return a.minClicks > b.minClicks
  return (a.maxAcosPct ?? Number.POSITIVE_INFINITY) < (b.maxAcosPct ?? Number.POSITIVE_INFINITY)
}

/** The same for two negate groups: more clicks, then more spend, then fewer orders allowed. */
export function negateStricter(a: Omit<NegateThresholds, 'windowDays'>, b: Omit<NegateThresholds, 'windowDays'>): boolean {
  if (a.minClicks !== b.minClicks) return a.minClicks > b.minClicks
  if (a.minSpendCents !== b.minSpendCents) return a.minSpendCents > b.minSpendCents
  return a.maxOrders < b.maxOrders
}

// ── The registry ──────────────────────────────────────────────────────────────────────────────────

/** The AdsStrategy columns that hold the Owner's settings (scope, version and audit columns are not settings). */
export type StrategyColumn =
  | 'goal' | 'goalNote' | 'targetKind' | 'targetPct' | 'monthlySpendCapCents' | 'minBidCents' | 'maxBidCents'
  | 'maxChangePct' | 'maxActionsPerRun' | 'protect' | 'harvestMinOrders' | 'harvestMinClicks' | 'harvestMaxAcosPct'
  | 'harvestWindowDays' | 'negateMinClicks' | 'negateMinSpendCents' | 'negateMaxOrders' | 'negateWindowDays'
  | 'stopMethod' | 'stopBidCents' | 'claudeAutonomy' | 'reviewEveryDays'
  | 'claudeMaxChangesPerDay' | 'claudeMaxRaisesPerDay' | 'claudeMaxBudgetIncreasePerDayCents'

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
  // AA-W2-2b — at most the business's own cap of runs by rule can ever allow (claude-trust.service.ts MAX_DAILY_AUTO_CAP).
  claudeMaxChangesPerDay: { kind: 'int', min: 0, max: 10_000 },
  claudeMaxRaisesPerDay: { kind: 'int', min: 0, max: 10_000 },
  claudeMaxBudgetIncreasePerDayCents: { kind: 'int', min: 0 },
}

export type SaferRule =
  | 'lower'            // the lower number spends less
  | 'anyProtected'     // one protected product protects the ad group
  | 'stricterHarvest'  // the group that needs more evidence (harvestStricter)
  | 'stricterNegate'   // the group that needs more evidence (negateStricter)
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
  | 'count'      // a limit where empty is 0 (Claude's daily limits): up loosens; down, or cleared, tightens
  | 'any'        // any change (no clear direction)
  | 'never'      // free to change

export type StrategyFieldKey =
  | 'goal' | 'goalNote' | 'target' | 'targetAcosPct' | 'monthlySpendCapCents' | 'minBidCents' | 'maxBidCents'
  | 'maxChangePct' | 'maxActionsPerRun' | 'protect' | 'harvest' | 'negate' | 'stop' | 'claudeAutonomy' | 'reviewEveryDays'
  | 'claudeMaxChangesPerDay' | 'claudeMaxRaisesPerDay' | 'claudeMaxBudgetIncreasePerDayCents'

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
  bidRules: 'bid rules (bid_apply: their target-ACoS ops and bid limits)',
  autopilot: 'autopilot plans (their bid apply, bid band and bid ramp)',
  gate: "the write gate (refuses an engine's or a rule's bid outside it; a person's own edit, or a Claude request he approves, is warned and goes when he confirms)",
  hourly: 'hourly bid plans (the base bid)',
  restores: 'restores after a stop (and base-bid give-backs)',
  stepClamp: "the step clamp on engine, rule and Claude bid changes (not a person's own edit)",
  claudePreview: "Claude's bid previews (the bid an approval writes)",
  // AA-W2-2b — the strategy-bound ad tools' common checks (agents/tools/ads-autonomy-kit.ts, C5) in Claude's door.
  claudeByRule: "Claude's door, for an ad change that may run by the business's rule in this market (an ad tool set to run by rule, where its code allows it)",
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
  // AA-W2-8 — and Claude's door: a campaign's own target, set by rule, stays at or below it (ads-target-acos.tools.ts).
  {
    key: 'targetAcosPct', label: 'Target ACoS the engines use', columns: ['targetKind', 'targetPct'], derivedFrom: 'target', levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'target', money: true,
    readBy: [...TARGET_READERS, `${READERS.claudeByRule}: a campaign's own target ACoS that Claude raises by rule stays at or below it, or a person decides`],
  },
  // W1-6: the budget engine stops a market at its MARKET row's cap; W1-6b: a category's or product's cap floors every ad
  // group holding a product under it (low bids until the 1st, both).
  {
    key: 'monthlySpendCapCents', label: 'Monthly spend cap', columns: ['monthlySpendCapCents'], levels: ALL_LEVELS, resolve: 'everyScope', safer: 'ownSpend', raise: 'up', money: true,
    readBy: [
      "the budget engine (every 30 minutes): when the market's spend this month reaches the market's cap, every campaign of the market drops to its stop bid until the 1st (a cap of 0 is no cap)",
      "the budget engine: when a category's or product's Sponsored Products spend this month reaches its cap, every ad group holding a product under it drops to its stop bid until the 1st, the products sharing that ad group included (a cap of 0 is no cap)",
    ],
  },
  { key: 'minBidCents', label: 'Lowest bid', columns: ['minBidCents'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'floor', money: true, readBy: BAND_READERS },
  { key: 'maxBidCents', label: 'Highest bid', columns: ['maxBidCents'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'up', money: true, readBy: BAND_READERS },
  { key: 'maxChangePct', label: 'Largest bid change per action', columns: ['maxChangePct'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'up', money: false, readBy: STEP_READERS },
  // W1-6: the engines whose guard (ads-engine-guard.ts) is told each campaign's market.
  {
    key: 'maxActionsPerRun', label: 'Most actions per run', columns: ['maxActionsPerRun'], levels: ['MARKET'], resolve: 'inherit', safer: 'lower', raise: 'up', money: false,
    readBy: [
      'the hourly bid plans (rank-defend): at most this many changes in the market per run; the rest wait for the next run',
      'the budget engine (pacing and stop-over-spend floors): at most this many changes in the market per run; give-backs are never held',
      'dayparting (windows and bid multipliers): at most this many changes in the market per run',
    ],
  },
  {
    key: 'protect', label: 'Protected', columns: ['protect'], levels: ['CATEGORY', 'PRODUCT'], resolve: 'inherit', safer: 'anyProtected', raise: 'unprotect', money: false,
    // W1-7 (ads-strategy/terms.ts). Safety stops (stock, Buy Box, spend caps, a halt) and the Owner's own painted plans
    // (dayparting, Hourly Bids) still apply to a protected product.
    readBy: [
      'every negative write (the write gate, the negative write service, the wire): no engine, rule or schedule negates a protected product\'s ASIN; a person\'s own add, or a Claude request he approved, is warned and may be sent anyway',
      'search-term candidates (harvest rules, recommendations, the harvest preview): a protected product\'s ASIN is never offered as a negative',
      'the bid optimiser (auto-bid, target-ACoS bid rules, autopilot plans, recommendations): no cut of a protected product\'s keyword or target without sales',
      'rules: no pause, archive or floor bid of a protected product\'s keyword or target',
    ],
  },
  {
    key: 'harvest', label: 'Harvest a search term when', columns: ['harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays'],
    // The ACoS ceiling may be empty inside a set group: no ceiling (as a stored harvest policy).
    required: ['harvestMinOrders', 'harvestMinClicks', 'harvestWindowDays'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'stricterHarvest', raise: 'loosen', money: true,
    // W1-7. A rule's or a person's own numbers win over it whole; per ad group (its products together).
    readBy: [
      'harvest rules that set no thresholds of their own (harvest_and_negate)',
      'recommendations (terms to graduate)',
      'the harvest preview and the fleet\'s harvest observations, when they name no thresholds',
      'the Keyword Harvest page, one market in view: the stricter of this and the saved harvest policy',
      // AA-W2-7 — graduate-keyword (ads-propose.tools.ts).
      'Claude\'s door: a new exact keyword runs by rule only for a term whose record over this window meets it where the term converted',
    ],
  },
  {
    key: 'negate', label: 'Negate a search term when', columns: ['negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays'],
    levels: ALL_LEVELS, resolve: 'inherit', safer: 'stricterNegate', raise: 'loosen', money: true,
    // W1-7. A rule's or a person's own numbers win over it whole; per ad group (its products together).
    readBy: [
      'harvest rules that set no thresholds of their own (harvest_and_negate)',
      'recommendations (wasteful terms to negate)',
      'the harvest preview and the fleet\'s negative observations, when they name no thresholds',
      // AA-W2-7 — create-negative-keyword (ads-propose.tools.ts).
      'Claude\'s door: a negative keyword runs by rule only for a term whose record over this window meets it in the ad group it lands in',
    ],
  },
  // The stop bid may be empty inside a set group: the existing 2¢ floor. W1-6: read as the stop BID only — every reader
  // stops with low bids whatever the method says (a pause waits for W2/W3).
  {
    key: 'stop', label: 'Temporary stop', columns: ['stopMethod', 'stopBidCents'], required: ['stopMethod'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'saferStop', raise: 'pause', money: true,
    readBy: [
      'the budget engine: a market over its monthly cap drops to this stop bid until the 1st (low bids, never a pause)',
      'the retail guard: a campaign whose products cannot be sold drops to this stop bid',
      "Claude's suppress-campaign: the bid it lowers a campaign to (the 2-cent floor when none is set)",
      "Claude's lower-ad-bids-for-stock: the bid it lowers an ad group out of stock to, and the floor a step down never passes (the 2-cent floor when none is set)",
    ],
  },
  { key: 'claudeAutonomy', label: 'What Claude may do alone', columns: ['claudeAutonomy'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lowerLevel', raise: 'autonomy', money: false, readBy: [CLAUDE_DOOR] },
  { key: 'reviewEveryDays', label: 'Review every (days)', columns: ['reviewEveryDays'], levels: ALL_LEVELS, resolve: 'inherit', safer: 'lower', raise: 'up', money: false, readBy: [] },
  // AA-W2-2b — what Claude's ad changes may add in one market in 24 hours when they run by rule (Owner decision
  // D-W2-3). The market row only; empty is 0, so a market without a number runs nothing that adds to it by rule.
  {
    key: 'claudeMaxChangesPerDay', label: 'Most changes Claude may run by rule a day', columns: ['claudeMaxChangesPerDay'], levels: ['MARKET'], resolve: 'inherit', safer: 'lower', raise: 'count', money: false,
    readBy: [`${READERS.claudeByRule}: the changes run by rule there in the last 24 hours plus this one must fit (each entity changed counts one), or a person decides; empty is 0 — no change runs by rule`],
  },
  {
    key: 'claudeMaxRaisesPerDay', label: 'Most raises Claude may run by rule a day', columns: ['claudeMaxRaisesPerDay'], levels: ['MARKET'], resolve: 'inherit', safer: 'lower', raise: 'count', money: false,
    readBy: [`${READERS.claudeByRule}: the changes that add spend (a higher bid, budget, placement or target, a restart, a new keyword) run by rule there in the last 24 hours plus this one's must fit, or a person decides; empty is 0 — no raise runs by rule`],
  },
  {
    key: 'claudeMaxBudgetIncreasePerDayCents', label: 'Most budget increase Claude may run by rule a day', columns: ['claudeMaxBudgetIncreasePerDayCents'], levels: ['MARKET'], resolve: 'inherit', safer: 'lower', raise: 'count', money: true,
    readBy: [`${READERS.claudeByRule}: the daily budget added by rule there in the last 24 hours plus this change's must fit, or a person decides; empty is 0 — no budget increase runs by rule`],
  },
]

/** AA-W2-2b — Claude's daily limits per market: empty is 0 (nothing that adds to one runs by rule). */
export const CLAUDE_DAILY_FIELDS = ['claudeMaxChangesPerDay', 'claudeMaxRaisesPerDay', 'claudeMaxBudgetIncreasePerDayCents'] as const satisfies readonly StrategyFieldKey[]
export type ClaudeDailyField = (typeof CLAUDE_DAILY_FIELDS)[number]

export const FIELD_BY_KEY: ReadonlyMap<StrategyFieldKey, StrategyField> = new Map(STRATEGY_FIELDS.map((f) => [f.key, f]))

/** The columns of a field that must be set on a row for that row to set the field. */
export const requiredColumns = (field: StrategyField): readonly StrategyColumn[] => field.required ?? field.columns

/** The fields no engine or door acts on yet: stored and shown only. Shrinks as the W1 readers ship. */
export function notReadYet(): StrategyFieldKey[] {
  return STRATEGY_FIELDS.filter((f) => f.readBy.length === 0).map((f) => f.key)
}

/**
 * The money keys of every strategy answer, each with the permission that reveals it. A money value always sits alone
 * under one of these keys (never under a generic `value`), so the money filter removes exactly the money and leaves
 * where it comes from: the read tool's `restrictedFields`, and the strategy GET routes.
 */
export const STRATEGY_MONEY: Readonly<Record<string, string>> = Object.fromEntries(
  ['targetPct', 'targetAcosPct', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'harvestMaxAcosPct', 'negateMinSpendCents', 'stopBidCents', 'monthlyBudgetCents',
    // W1-6 — this month against a cap: spend so far, the forecast and the cap where bids drop.
    'spendCents', 'forecastSpendCents', 'stopCapCents',
    // W1-6b — spend of ads Nexus cannot tie to a product (counted on no category or product cap).
    'unattributedCents',
    // AA-W2-2b — the most daily budget Claude's changes may add by rule in a day.
    'claudeMaxBudgetIncreasePerDayCents']
    .map((key) => [key, FIELDS.financialsAdspendView]),
)
