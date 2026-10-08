/**
 * ONE BRAIN AB-1 — the brain's levers, levels and settings with their defaults, and what the Owner may override (design
 * 2026-10-08-ads-one-brain/DESIGN.md §2, §3, §5, §6, §9, §10). Pure: no database, so the write gate, the engines and the
 * tools can import it without a cycle. brain/settings.ts resolves the Owner's overrides over these defaults.
 *
 *   levels    OFF      the brain leaves the lever to today's engines
 *             OBSERVE  shadow: the brain decides and logs, and writes nothing
 *             PROPOSE  the brain asks; each change waits for a person
 *             AUTO     the brain is the lever's one automatic writer, inside the caps
 *             The Owner's words: on = AUTO (PROPOSE where a lever asks first), shadow = OBSERVE, off = OFF. The brain
 *             OWNS a lever at PROPOSE or AUTO (design §3 point 3: the gate then refuses every other engine).
 *   default   every lever starts OBSERVE (design §0.13), per product and per campaign, until the Owner overrides it.
 *   now       a level is offered only once code runs it (LEVER_LEVELS_NOW). AB-1: the bids lever takes OBSERVE and AUTO
 *             (the live bid brain, BB-6); AB-13: the hours lever OFF, OBSERVE and PROPOSE (a painted plan always asks, D3);
 *             AB-11: the harvest lever every level; every other lever OFF or OBSERVE until its own PR. OBSERVE on a lever whose
 *             shadow is not built yet records the intent: it starts watching when its shadow lands; nothing is written.
 *             AB-12: the state lever takes every level (brain/state*.ts); it still starts OBSERVE like every lever.
 *   settings  the caps of §5 and the N1–N4 settings of §9 (Owner yes 10-08), each with the design's default and safety
 *             bounds (Amazon's own where it has one); the Owner may set any value inside them, per product, and per
 *             campaign where the setting means something for one campaign.
 *   locks     a lever held at the Owner's own value (§2.10; Owner 10-08): the whole lever of a campaign or a product, or
 *             one thing in it (an hour cell, a lane, a term, an ad group, a keyword). The brain never writes it.
 */

export const BRAIN_LEVERS = [
  'bids', 'adGroupBids', 'hours', 'placements', 'state', 'budgets', 'portfolioCap', 'negatives', 'harvest', 'structure', 'biddingStrategy', 'offAmazon',
] as const
export type BrainLever = (typeof BRAIN_LEVERS)[number]

export const BRAIN_LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
export type BrainLevel = (typeof BRAIN_LEVELS)[number]
export type BrainLevels = Record<BrainLever, BrainLevel>

export type BrainScope = 'PRODUCT' | 'CAMPAIGN'

export const isLever = (v: unknown): v is BrainLever => typeof v === 'string' && (BRAIN_LEVERS as readonly string[]).includes(v)
export const isLevel = (v: unknown): v is BrainLevel => typeof v === 'string' && (BRAIN_LEVELS as readonly string[]).includes(v)

/** The brain owns the lever: it is the lever's writer (it asks at PROPOSE, it acts at AUTO). */
export const ownsLever = (level: BrainLevel): boolean => level === 'PROPOSE' || level === 'AUTO'

/** The brain's default level of every lever, for a product and for a campaign (design §0.13: every lever starts in shadow). */
export const DEFAULT_LEVEL: BrainLevel = 'OBSERVE'

const OFF_OBSERVE: readonly BrainLevel[] = ['OFF', 'OBSERVE']

/**
 * The levels each lever takes today, and what the others wait for. Each lever's own PR widens its line (design §8).
 * bids: OFF is left out because the bid brain decides every allowlisted campaign in shadow whatever the product says
 * (OFF would claim a stop that does not happen), and PROPOSE because the bid brain has no proposal path.
 */
export const LEVER_LEVELS_NOW: Record<BrainLever, { levels: readonly BrainLevel[]; others: string }> = {
  bids: { levels: ['OBSERVE', 'AUTO'], others: 'the bid brain decides every allowlisted campaign in shadow (no OFF) and has no proposal path (no PROPOSE)' },
  adGroupBids: { levels: OFF_OBSERVE, others: 'ad group default bids have no writer of the brain yet: the product cycle (AB-14) runs each lever that has one in order, and this one waits for its own step (design §2.2)' },
  // AB-13 (D3 = B+) — the brain researches the market's hours, paints the plan and asks: a plan change is PROPOSE always.
  hours: { levels: ['OFF', 'OBSERVE', 'PROPOSE'], others: 'the brain researches the market\'s hours weekly and paints the hourly plan; OBSERVE keeps the painting in shadow, PROPOSE asks a person to approve each painted plan, and no plan changes alone (D3: never AUTO; ads-brain view hours)' },
  placements: { levels: OFF_OBSERVE, others: 'placement % per hour come with the painted hourly plan\'s targets (the hours lever, AB-13), which keeps every lane the Owner locked; a placements writer of its own waits for its own step in the product cycle (AB-14 runs the levers that have one)' },
  // AB-12 — every level: OBSERVE logs, PROPOSE asks a person, AUTO pauses and resumes alone (D4 = A, brain/state*.ts).
  state: { levels: BRAIN_LEVELS, others: 'each pause, resume and archive proposal it would make is logged in shadow (ads-brain view state); PROPOSE asks a person, AUTO pauses and resumes alone inside the caps — an archive is only ever a proposal (AB-12)' },
  // AB-8 — the money writer: OBSERVE plans and logs (AB-7), PROPOSE asks a person for each change, AUTO writes inside the pace.
  budgets: { levels: BRAIN_LEVELS, others: 'campaign budgets: OBSERVE plans and logs them (ads-brain view money), PROPOSE asks a person for the day\'s moves, AUTO writes them and the intraday ladder (AB-8, under a live NEXUS_BID_BRAIN_MODE)' },
  portfolioCap: { levels: BRAIN_LEVELS, others: 'the Amazon portfolio cap: OBSERVE plans it, PROPOSE asks a person, AUTO writes it — monthly, never below this month\'s spend, never a cap removed, never above the portfolio cap limit (portfolioCapLimitCents, else NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS) (AB-8, under a live NEXUS_BID_BRAIN_MODE)' },
  // AB-10 — the negatives module: OBSERVE logs the day's negatives, PROPOSE asks a person once a day, AUTO writes them as the
  // brain (inside the caps, after the shadow days of negativesShadowDays, under the live server switch).
  negatives: { levels: BRAIN_LEVELS, others: 'the negatives module (AB-10, ads-brain view negatives) takes every level' },
  // AB-11 — the harvest module: OBSERVE logs each harvest, PROPOSE asks a person for the pair, AUTO writes it.
  harvest: { levels: BRAIN_LEVELS, others: 'AB-11: OBSERVE logs each harvest in shadow, PROPOSE asks a person for the keyword and its source negatives as one change set, AUTO writes it (under NEXUS_ADS_BRAIN_HARVEST_MODE=live); a new campaign is always a request a person approves (ads-brain view harvest)' },
  structure: { levels: OFF_OBSERVE, others: 'new campaigns wait for AB-16' },
  biddingStrategy: { levels: OFF_OBSERVE, others: 'the bidding-strategy lever waits for AB-17' },
  offAmazon: { levels: OFF_OBSERVE, others: 'the off-Amazon lane waits for AB-18' },
}

/** Why a lever cannot be set to this level today; null when it can. */
export function levelRefusal(lever: BrainLever, level: BrainLevel): string | null {
  const now = LEVER_LEVELS_NOW[lever]
  if (now.levels.includes(level)) return null
  return `the ${lever} lever takes ${now.levels.join(' or ')} today, not ${level}: ${now.others}`
}

// ── Settings (design §5 caps, §2.6 money, §9 N1–N4) ──────────────────────────────────────────────────────────────

const PRODUCT: readonly BrainScope[] = ['PRODUCT']
const BOTH: readonly BrainScope[] = ['PRODUCT', 'CAMPAIGN']

type SettingSpec =
  | { type: 'int'; default: number; min: number; max: number; scopes: readonly BrainScope[]; what: string }
  | { type: 'intOrNull'; default: null; min: number; max: number; scopes: readonly BrainScope[]; what: string }
  | { type: 'boolean'; default: boolean; scopes: readonly BrainScope[]; what: string }
  | { type: 'enum'; default: string; values: readonly string[]; scopes: readonly BrainScope[]; what: string }
  /** AB-12 — a calendar day (YYYY-MM-DD, UTC) or empty. */
  | { type: 'dayOrNull'; default: null; scopes: readonly BrainScope[]; what: string }

/**
 * Every setting with its default. Money limits (the envelope, bid limits, the largest step) stay in AdsStrategy; the
 * account's caps (300 bids a run, 3 pauses a day per market) stay with the engines.
 */
export const BRAIN_SETTINGS = {
  // §5 caps
  negativesPerDay: { type: 'int', default: 20, min: 0, max: 200, scopes: PRODUCT, what: 'new negatives per product per day (§2.7)' },
  negativesPerEntityWarn: { type: 'int', default: 800, min: 100, max: 950, scopes: BOTH, what: 'negatives in one campaign or ad group before a warning (§2.7)' },
  negativesPerEntityMax: { type: 'int', default: 950, min: 100, max: 950, scopes: BOTH, what: 'negatives in one campaign or ad group, never more — Amazon allows 1,000 (§2.7)' },
  // AB-10 — §10: a lever runs in shadow before it acts (14 days for negatives); the Owner's own number wins (0: at once).
  negativesShadowDays: { type: 'int', default: 14, min: 0, max: 90, scopes: PRODUCT, what: 'days the negatives lever runs in shadow before PROPOSE or AUTO act (§10)' },
  harvestPerDay: { type: 'int', default: 10, min: 0, max: 100, scopes: PRODUCT, what: 'new keywords per product per day (§2.8)' },
  newCampaignsPerWeek: { type: 'int', default: 2, min: 0, max: 20, scopes: PRODUCT, what: 'new campaigns per product per week (§2.9)' },
  skcMax: { type: 'int', default: 20, min: 0, max: 200, scopes: PRODUCT, what: 'single-keyword campaigns per product (§2.9)' },
  firstBudgetPctOfEnvelope: { type: 'int', default: 10, min: 1, max: 100, scopes: PRODUCT, what: 'a new campaign\'s first budget, % of the envelope (§2.9)' },
  minBidEntriesPerDay: { type: 'int', default: 2, min: 0, max: 24, scopes: BOTH, what: 'Min-bid hour entries per campaign per day (§2.3)' },
  hourCellMovePct: { type: 'int', default: 30, min: 0, max: 100, scopes: PRODUCT, what: 'largest move of an hour cell per painted plan, % (§2.3)' },
  hourProposalsPerWeek: { type: 'int', default: 1, min: 0, max: 7, scopes: PRODUCT, what: 'painted hourly plan proposals per week (§2.3)' },
  // AB-13 — the research window, and the Owner's own painted plan as the limit of each hour (BRAIN-UPGRADES U4-D1).
  hourResearchWeeks: { type: 'int', default: 4, min: 2, max: 8, scopes: PRODUCT, what: 'weeks of hourly data the brain researches before it paints the hourly plan (§2.3)' },
  hourPlanAsLimits: { type: 'boolean', default: false, scopes: PRODUCT, what: 'the Owner\'s own painted hourly plan is the limit of each hour: the brain may lower an hour or keep it, never raise it above his target or placement %, and his Min-bid hours stay (§2.3, U4-D1)' },
  biddingStrategySwitchDays: { type: 'int', default: 14, min: 1, max: 365, scopes: BOTH, what: 'days between two bidding-strategy switches of a campaign (§2.11)' },
  budgetUsePct: { type: 'int', default: 70, min: 10, max: 100, scopes: BOTH, what: 'expected budget use a campaign budget is sized for, % (§2.5)' },
  intradayLadderMaxPct: { type: 'int', default: 100, min: 0, max: 100, scopes: BOTH, what: 'largest intraday budget raise, % of the base budget — Amazon spends at most 2× a day (§2.5)' },
  // §2.6 money and §9 N1–N4 (Owner yes 10-08)
  paceTargetPct: { type: 'int', default: 90, min: 10, max: 100, scopes: PRODUCT, what: 'the pacing limit: month-end spend the pace aims at, % of the envelope (§2.6)' },
  portfolioCapOn: { type: 'boolean', default: true, scopes: PRODUCT, what: 'N1: the Amazon portfolio cap is set as the hard backstop' },
  portfolioCapPct: { type: 'int', default: 115, min: 100, max: 300, scopes: PRODUCT, what: 'N1: the portfolio cap, % of the monthly budget (envelope)' },
  portfolioCapCents: { type: 'intOrNull', default: null, min: 100, max: 100_000_000, scopes: PRODUCT, what: 'N1: the portfolio cap as an amount in cents (it replaces the %); empty = portfolioCapPct × the monthly budget' },
  // Owner decision 2A (10-08 ~19:20 UTC) — a portfolio cap has a monthly limit of its own; the €500 per-write cap stays for every other write.
  portfolioCapLimitCents: { type: 'intOrNull', default: null, min: 100, max: 100_000_000, scopes: PRODUCT, what: 'the limit of this product\'s Amazon portfolio caps a month, in cents, for every writer (the brain, set-portfolio, the Portfolios page): it replaces the server\'s NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS (default 200,000 = €2,000) for a portfolio that holds only this product\'s campaigns; empty = the server\'s' },
  ownPortfolio: { type: 'boolean', default: true, scopes: PRODUCT, what: 'N2: the brain proposes one portfolio per product and market' },
  strategySwitchMode: { type: 'enum', default: 'PROPOSE_THEN_AUTO', values: ['PROPOSE_THEN_AUTO', 'ALWAYS_PROPOSE'], scopes: BOTH, what: 'N4: a bidding-strategy switch waits for approval for 30 days, then runs alone (PROPOSE_THEN_AUTO), or always waits (ALWAYS_PROPOSE)' },
  // AB-12 — the state lever (§2.4, D4 = A)
  pauseMinDays: { type: 'int', default: 3, min: 3, max: 60, scopes: BOTH, what: 'a stop expected to last at least this many days is a pause; a shorter one stays on low bids, never a pause (§2.4, D4)' },
  archiveDeadWeeks: { type: 'int', default: 4, min: 2, max: 52, scopes: BOTH, what: 'weeks without an impression before the brain proposes to archive a campaign — only ever a proposal (§2.4)' },
  longStopUntil: { type: 'dayOrNull', default: null, scopes: BOTH, what: 'the Owner\'s long stop: the brain pauses through this day (YYYY-MM-DD, UTC) and resumes after it; empty = none (§2.4)' },
} as const satisfies Record<string, SettingSpec>

export type BrainSetting = keyof typeof BRAIN_SETTINGS
export type SettingValue = number | boolean | string | null
export const BRAIN_SETTING_KEYS = Object.keys(BRAIN_SETTINGS) as BrainSetting[]
export const isSetting = (k: unknown): k is BrainSetting => typeof k === 'string' && Object.prototype.hasOwnProperty.call(BRAIN_SETTINGS, k)

/** Why this value cannot be set for this setting at this scope; null when it can. */
export function settingRefusal(key: string, value: unknown, scope: BrainScope): string | null {
  if (!isSetting(key)) return `${key} is not a setting of the brain (settings: ${BRAIN_SETTING_KEYS.join(', ')})`
  const spec: SettingSpec = BRAIN_SETTINGS[key]
  if (!spec.scopes.includes(scope)) return `${key} (${spec.what}) is set per product, not per campaign`
  switch (spec.type) {
    case 'int':
    case 'intOrNull':
      if (value === null && spec.type === 'intOrNull') return null
      return Number.isInteger(value) && (value as number) >= spec.min && (value as number) <= spec.max ? null : `${key} (${spec.what}) takes a whole number from ${spec.min} to ${spec.max}${spec.type === 'intOrNull' ? ' or empty' : ''}, not ${JSON.stringify(value)}`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${key} (${spec.what}) takes true or false, not ${JSON.stringify(value)}`
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? null : `${key} (${spec.what}) takes ${spec.values.join(' or ')}, not ${JSON.stringify(value)}`
    case 'dayOrNull':
      return value === null || isCalendarDay(value) ? null : `${key} (${spec.what}) takes a day as YYYY-MM-DD (2020 to 2099) or empty, not ${JSON.stringify(value)}`
  }
}

/** AB-12 — a real calendar day written YYYY-MM-DD (2020–2099): 2026-02-30 is none. */
export function isCalendarDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^20[2-9]\d-\d{2}-\d{2}$/.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v
}

/** Every setting's default. */
export function settingDefaults(): Record<BrainSetting, SettingValue> {
  return Object.fromEntries(BRAIN_SETTING_KEYS.map((k) => [k, BRAIN_SETTINGS[k].default])) as Record<BrainSetting, SettingValue>
}

// ── Locks (design §2.10; Owner 10-08) ────────────────────────────────────────────────────────────────────────────

/** What one thing inside a lever a lock may hold (ref "<kind>:<what>"); "" holds the whole lever. */
export const LOCK_REFS: Record<BrainLever, readonly string[]> = {
  bids: ['adGroup', 'target'],
  adGroupBids: ['adGroup'],
  hours: ['hourCell'],
  placements: ['lane'],
  state: ['adGroup', 'target'],
  budgets: [],
  portfolioCap: [],
  negatives: ['adGroup', 'term'],
  harvest: ['term'],
  structure: [],
  biddingStrategy: [],
  offAmazon: [],
}

export const LANES = ['TOP_OF_SEARCH', 'PRODUCT_PAGE', 'REST_OF_SEARCH'] as const
export const BIDDING_STRATEGIES = ['MANUAL', 'LEGACY_FOR_SALES', 'AUTO_FOR_SALES'] as const
/** An hour of the week in the market's time zone: d<weekday 0-6, 0 = Sunday, as the hourly plans>h<hour 0-23>. */
const HOUR_CELL = /^d[0-6]h([0-9]|1[0-9]|2[0-3])$/

/** A lock's ref as stored ("" or "<kind>:<what>", a term trimmed, lower case, single-spaced), or why not. */
export function lockRef(lever: BrainLever, ref: unknown): { ref: string } | { refusal: string } {
  const raw = typeof ref === 'string' ? ref.trim() : ''
  if (!raw) return { ref: '' }
  const at = raw.indexOf(':')
  const kind = at > 0 ? raw.slice(0, at) : ''
  let what = at > 0 ? raw.slice(at + 1).trim() : ''
  if (!LOCK_REFS[lever].includes(kind)) {
    return { refusal: LOCK_REFS[lever].length ? `a lock on the ${lever} lever holds the whole lever or one ${LOCK_REFS[lever].join(' / ')} ("<kind>:<what>"), not ${raw}` : `a lock on the ${lever} lever holds the whole lever only, not ${raw}` }
  }
  if (kind === 'term') what = what.toLowerCase().replace(/\s+/g, ' ')
  if (!what || what.length > 200) return { refusal: 'a lock names what it holds (1 to 200 characters after the kind)' }
  if (kind === 'hourCell' && !HOUR_CELL.test(what)) return { refusal: `an hour cell is d<weekday 0-6, 0 = Sunday>h<hour 0-23> in the market's time zone (d1h14 = Monday 14:00), not ${what}` }
  if (kind === 'lane' && !(LANES as readonly string[]).includes(what)) return { refusal: `a lane is ${LANES.join(', ')}, not ${what}` }
  return { ref: `${kind}:${what}` }
}

/**
 * Why this is not the Owner's own value for a whole-lever lock (null: it is). Empty (null) always is: "as it is now".
 * A lock of one thing inside a lever takes no value.
 */
export function lockValueRefusal(lever: BrainLever, ref: string, value: unknown, scope: BrainScope): string | null {
  if (lever === 'portfolioCap' && scope !== 'PRODUCT') return 'the portfolio cap is locked per product, not per campaign'
  if (value === null || value === undefined) return null
  if (ref) return `a lock of one ${ref.split(':')[0]} holds it as it is: it takes no value`
  const obj = value as Record<string, unknown>
  const cents = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
  switch (lever) {
    case 'budgets':
      return typeof value === 'object' && cents(obj.dailyBudgetCents, 100, 100_000_000) && Object.keys(obj).length === 1 ? null : 'a budget lock takes { dailyBudgetCents } (100 to 100,000,000) or empty (the budget as it is)'
    case 'portfolioCap':
      return typeof value === 'object' && cents(obj.amountCents, 100, 100_000_000) && Object.keys(obj).length === 1 ? null : 'a portfolio cap lock takes { amountCents } (100 to 100,000,000) or empty (the cap as it is)'
    case 'placements':
      return typeof value === 'object' && Object.keys(obj).length > 0 && Object.entries(obj).every(([k, v]) => (LANES as readonly string[]).includes(k) && cents(v, 0, 900))
        ? null : `a placements lock takes { ${LANES.join(', ')} } as percents from 0 to 900, or empty (the placements as they are)`
    case 'biddingStrategy':
      return typeof value === 'string' && (BIDDING_STRATEGIES as readonly string[]).includes(value) ? null : `a bidding-strategy lock takes ${BIDDING_STRATEGIES.join(', ')} or empty (the strategy as it is)`
    case 'state':
      return value === 'ENABLED' || value === 'PAUSED' ? null : 'a state lock takes ENABLED or PAUSED, or empty (the state as it is)'
    case 'offAmazon':
      return value === 'LIMIT' || value === 'INCREASE_REACH' ? null : 'an off-Amazon lock takes LIMIT or INCREASE_REACH, or empty (the setting as it is)'
    default:
      return `a lock of the ${lever} lever holds it as it is: it takes no value`
  }
}

// ── Snapshots (design §3: per lever, when it goes live) ─────────────────────────────────────────────────────────

/** What a lever held when it last went live; `data` is the lever's own (the bids lever: BidsLeverSnapshot). */
export interface LeverSnapshot { takenAt: string; by: string; data: unknown }

/** The stored snapshots that are well formed, per lever. */
export function readSnapshots(raw: unknown): Partial<Record<BrainLever, LeverSnapshot>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Partial<Record<BrainLever, LeverSnapshot>> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = v as Partial<LeverSnapshot> | null
    if (isLever(k) && s && typeof s.takenAt === 'string' && typeof s.by === 'string') out[k] = { takenAt: s.takenAt, by: s.by, data: s.data ?? null }
  }
  return out
}
