/**
 * ADS AUTONOMY W1-3 — the Amazon Ads strategy, written: ONE change of ONE row (a market, or a category or a product in
 * one market), planned and applied, each change kept as a version. Shared by Claude's `set-ads-strategy` and the
 * Control Room's Strategy tab (PUT/POST /api/advertising/automation/strategy…).
 *
 *   plan     the change as asked, checked: the level a field may sit on, whole groups, a bid floor not above the
 *            ceiling in force. Each field is judged RAISE / LOWER / SAME by its RaiseRule (fields.ts) on the EFFECTIVE
 *            value at the changed scope before and after (removing a row is judged by what it then falls back to). Also
 *            the market's protected search terms it adds or removes (AdKeywordProtection, the one store for terms), the
 *            campaigns whose own target ACoS it clears (`clearCampaignTargets`, market level) or puts back
 *            (`restoreCampaignTargets`, how an undo restores them), and the campaigns whose own target keeps winning.
 *   apply    ONE transaction: the row (its version + 1; a stale `expectVersion` or a row moved since → a conflict), one
 *            AdsStrategyVersion row (changes, direction, via, approvalId, actor, stepUpAt), the protected terms and the
 *            campaign targets, each with its ads audit row.
 *   who      a lowering is free for anyone who may set the strategy (ads.automation.manage, and the ad-spend money it
 *            holds). A RAISE needs settings.security.manage and a fresh authenticator code (Owner decision 2026-10-06):
 *            on the screen with the code (the route), from Claude approved in Nexus with the code or confirmed in Claude
 *            with it (set-ads-strategy). Never by rule.
 *
 * 🔴 Money stays keyed. `changes[].field` is a registry key or a column name, a group's values sit under their column
 * names, and labels carry no amount: the strategy reads strip ad-spend money by key (fields.ts STRATEGY_MONEY).
 *
 * Live effect: only a field something reads acts (the registry's readBy); every other field is stored and shown only. What
 * acts at once, the plan says, from the registry and the change: a field an engine or a door reads (W1-5: the bid engines
 * read the target, the bid band and the largest change; W1-6: the budget engine reads the market's monthly cap and the
 * stop bid; W1-7: the search-term engines; W1-8: Claude's door reads what Claude may do alone); a protected term binds
 * Nexus's write gate (no rule may negate it; removing one lets them again); a campaign's own target ACoS cleared or put
 * back changes what Nexus's bid optimiser aims at for that campaign today (without its own target: this strategy's,
 * else the account default, profit data, else 30 %).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@nexus/database'
import prisma from '../../../db.js'
import { patchDynamicBiddingIn } from '../dynamic-bidding-write.js'
import { normaliseTerm } from '../ads-negation-policy.js'
import { STEP_UP_NEEDS } from '../../agents/step-up-approval.js'
import type { RaiseWords } from '../../agents/claude-trust.service.js'
import { accountDefaultFraction, readOwnerTargets, targetFraction } from '../ads-target-acos-resolver.js'
import {
  CLAUDE_ACTION_TYPES,
  CLAUDE_DAILY_FIELDS,
  CLAUDE_DOOR,
  COLUMN_CHECKS,
  DEFAULT_STOP_BID_CENTS,
  MARKET_SCOPE,
  MAX_TARGET_PCT,
  STRATEGY_FIELDS,
  STRATEGY_GOALS,
  TARGET_KINDS,
  fractionToPct,
  notReadYet,
  requiredColumns,
  type ClaudeActionType,
  type RaiseRule,
  type StrategyColumn,
  type StrategyField,
  type StrategyFieldKey,
  type StrategyLevel,
} from './fields.js'
import { PRODUCT_NOT_FOUND } from './read.js'
import {
  findCategory,
  findLiveProduct,
  loadAncestry,
  loadCampaigns,
  loadCatalog,
  loadIndex,
  marketCampaignTargets,
  productFamily,
  productsUnderCategory,
  STRATEGY_ROW_SELECT,
  type CampaignFacts,
} from './load.js'
import {
  indexStrategy,
  resolveCategory,
  resolveMarket,
  resolveProduct,
  resolveProducts,
  type Catalog,
  type ResolvedStrategy,
  type StrategyIndex,
  type StrategyRow,
} from './resolve.js'

// ── The change, as asked ──────────────────────────────────────────────────────────────────────────

/** The fields a change sets (a registry key each; `targetAcosPct` is derived from `target`, never set). */
export const SETTABLE_FIELDS: readonly StrategyField[] = STRATEGY_FIELDS.filter((f) => !f.derivedFrom)
/**
 * A monthly cap of 0 is refused: the engines read a cap of 0 or less as "no cap" (the Budget Manager's convention), so
 * a 0 meant as "spend nothing" would quietly lift the cap instead.
 */
export const ZERO_CAP_REFUSAL = "monthlySpendCapCents: 0 would mean 'no cap' (as on the Budget Manager); leave it empty for no cap, or use a stop for an immediate stop."
/** Where a target, a bid or a cap stands when no target applies: Nexus's bid optimiser's last fallback. */
export const FALLBACK_TARGET_PCT = 30
/** The most campaigns one change clears or puts back (the tool contract bounds every list to 250). */
export const MAX_CAMPAIGN_TARGETS = 250
const MAX_LISTED = 50
const MATCH_TYPES = ['EXACT', 'PREFIX', 'CONTAINS'] as const

const int = (column: StrategyColumn) => {
  const check = COLUMN_CHECKS[column] as { kind: 'int'; min: number; max?: number }
  return z.number().int().min(check.min).max(check.max ?? 1_000_000_000)
}
const WINDOW = z.union([z.literal(30), z.literal(60), z.literal(90)])
const ID = z.string().trim().min(1).max(64)
const LEVEL_WORDS = 'market, category or product'

/** One value per field: a value sets it, null clears it (the row then inherits it), absent leaves it as it is. */
export const STRATEGY_VALUES_INPUT = z.object({
  goal: z.enum(STRATEGY_GOALS).nullable().optional().describe('LAUNCH, GROW, PROFIT, CLEAR_STOCK or DEFEND: what the ads should do here (descriptive: Claude reads it, no engine derives a number from it)'),
  goalNote: z.string().max(2000).nullable().optional().describe('the why, in the Owner\'s words (at most 2,000 characters)'),
  target: z.object({
    kind: z.enum(TARGET_KINDS).describe('ACOS or TACOS (engines steer by ACoS only; a TACoS target is stored and shown)'),
    pct: int('targetPct').describe(`a whole percent, 1–${MAX_TARGET_PCT} (25 = 25 %)`),
  }).strict().nullable().optional().describe('the target, as one group'),
  monthlySpendCapCents: int('monthlySpendCapCents').nullable().optional().describe("the most this scope's ads may spend in a calendar month, in cents of the market's currency (at least 1; null = no cap)"),
  minBidCents: int('minBidCents').nullable().optional().describe('the lowest bid, in cents'),
  maxBidCents: int('maxBidCents').nullable().optional().describe('the highest bid, in cents'),
  maxChangePct: int('maxChangePct').nullable().optional().describe('the largest bid change per action, a whole percent 1–100'),
  maxActionsPerRun: int('maxActionsPerRun').nullable().optional().describe('market only: the most changes an engine makes in one run'),
  protect: z.boolean().nullable().optional().describe('category or product only: true = never negated as an ASIN and never stopped by an optimiser; false = opt out of a broader row\'s protection'),
  harvest: z.object({
    minOrders: int('harvestMinOrders').describe('orders a search term needs before it is harvested'),
    minClicks: int('harvestMinClicks').describe('clicks it needs'),
    maxAcosPct: int('harvestMaxAcosPct').nullable().describe('its highest ACoS, a whole percent; null = no ceiling'),
    windowDays: WINDOW.describe('the days looked at: 30, 60 or 90'),
  }).strict().nullable().optional().describe('when a search term is harvested, as one group'),
  negate: z.object({
    minClicks: int('negateMinClicks').describe('clicks a search term needs before it is negated'),
    minSpendCents: int('negateMinSpendCents').describe('spend it needs, in cents'),
    maxOrders: int('negateMaxOrders').describe('the most orders it may have'),
    windowDays: WINDOW.describe('the days looked at: 30, 60 or 90'),
  }).strict().nullable().optional().describe('when a search term is negated, as one group'),
  stop: z.object({
    method: z.literal('LOW_BIDS').describe('LOW_BIDS: a temporary stop lowers bids (a pause is not offered yet)'),
    bidCents: int('stopBidCents').nullable().optional().describe('the low bid of a stop, in cents (2–100); null = the existing 2 cents'),
  }).strict().nullable().optional().describe('how a temporary stop works, as one group'),
  claudeAutonomy: z.object(Object.fromEntries(CLAUDE_ACTION_TYPES.map((action) => [action,
    z.enum(['off', 'ask', 'confirm', 'watch', 'auto']).optional().describe(`the most Claude may do alone for ${action} actions here`)])) as Record<ClaudeActionType, z.ZodOptional<z.ZodEnum<{ off: 'off'; ask: 'ask'; confirm: 'confirm'; watch: 'watch'; auto: 'auto' }>>>)
    .strict().nullable().optional().describe("what Claude may do alone here, per kind of ad action: off, ask, confirm, watch (checked as auto and recorded; a person decides) or auto. It only ever NARROWS the business's own level"),
  reviewEveryDays: int('reviewEveryDays').nullable().optional().describe('how often Claude reviews this scope, in days (1–90)'),
  // AA-W2-2b — what Claude's ad changes may add in this market in 24 hours when they run by the business's rule.
  claudeMaxChangesPerDay: int('claudeMaxChangesPerDay').nullable().optional()
    .describe("market only: the most ad changes Claude may run by the business's rule here in 24 hours (each entity changed counts one); empty or 0 = none runs by rule"),
  claudeMaxRaisesPerDay: int('claudeMaxRaisesPerDay').nullable().optional()
    .describe('market only: the most of those that add spend (a higher bid, budget, placement or target, a restart, a new keyword); empty or 0 = no raise runs by rule'),
  claudeMaxBudgetIncreasePerDayCents: int('claudeMaxBudgetIncreasePerDayCents').nullable().optional()
    .describe("market only: the most daily budget those may add in 24 hours, in cents of the market's currency; empty or 0 = no budget increase runs by rule"),
}).strict()

export type StrategyValuesInput = z.infer<typeof STRATEGY_VALUES_INPUT>

/**
 * The one change, as Claude's tool and the screen ask for it. Unknown top-level names are refused at Claude's door with
 * the name meant (tool-arguments.ts); inside `values` and the lists, an unknown key is refused here (strict).
 */
export const STRATEGY_CHANGE_INPUT = z.object({
  channel: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(['AMAZON']))
    .describe('AMAZON: the strategy covers Amazon Sponsored Products in this release'),
  market: z.string().trim().toUpperCase().min(2).max(20).describe('ONE Amazon market code (IT, DE, FR, ES, UK; business-overview lists them): every row belongs to one market'),
  level: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['market', 'category', 'product']))
    .describe('market (the whole market), category (with categoryId) or product (with productId or sku; a parent covers its variations)'),
  categoryId: ID.optional().describe('level category: the category, its Nexus id (catalog-structure)'),
  productId: ID.optional().describe('level product: the product (a parent or a variation), its Nexus id'),
  sku: z.string().trim().min(1).max(100).optional().describe("level product, instead of productId: the product's SKU in this business"),
  op: z.enum(['set', 'remove']).default('set').describe('set (create or change the row) or remove (delete the row: its scope inherits everything again)'),
  values: STRATEGY_VALUES_INPUT.optional().describe('the fields to set: a value sets it, null clears it (inherit), absent leaves it'),
  protectedTerms: z.object({
    add: z.array(z.object({
      term: z.string().trim().min(1).max(200).describe('the search term'),
      matchType: z.enum(MATCH_TYPES).optional().describe('EXACT (default), PREFIX or CONTAINS'),
    }).strict()).max(50).optional().describe('terms to protect in this market: no rule may negate them'),
    remove: z.array(z.string().trim().min(1).max(200).describe('a protected term')).max(50).optional().describe('terms to stop protecting in this market (a raise)'),
  }).strict().optional().describe("level market: the market's protected search terms (the one list Nexus's write gate checks)"),
  clearCampaignTargets: z.boolean().default(false)
    .describe("level market: also clear the own target ACoS of every campaign of the market that has one, so the strategy is not shadowed (their old values are kept for undo)"),
  restoreCampaignTargets: z.array(z.object({
    campaignId: ID.describe('the campaign, its Nexus id'),
    targetAcosPct: z.number().min(0).max(500).nullable().describe('its own target ACoS in percent, or null for none'),
  }).strict()).max(MAX_CAMPAIGN_TARGETS).optional()
    .describe("campaigns of this market whose own target ACoS to put back as it was (how an undo restores targets a change cleared)"),
  expectVersion: z.number().int().min(0).optional().describe('the version you read (0 when the row does not exist yet): refused when the row moved since'),
  reason: z.string().trim().max(500).optional().describe('why, in a sentence: kept with the version'),
})

export type StrategyChangeInput = z.input<typeof STRATEGY_CHANGE_INPUT>
type ChangeArgs = z.output<typeof STRATEGY_CHANGE_INPUT>

// ── Judging a change ──────────────────────────────────────────────────────────────────────────────

export type Direction = 'raise' | 'lower' | 'same'
type Group = Readonly<Record<string, unknown>>

/** One text per value whatever the order of its keys. */
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value ?? null))))
}

const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback)
const RANK: Record<string, number> = { off: 0, ask: 1, confirm: 2, watch: 3, auto: 4 }

/**
 * Raise, lower or same, for one field, from its value in force before and after (design §3.3). Null = nothing in force
 * at this scope. `fallbackTargetPct`: the ACoS the bid optimiser aims at without any target (the account default, else
 * 30 %), against which a target that appears or goes is judged.
 */
export function judgeChange(rule: RaiseRule, key: StrategyFieldKey, before: unknown, after: unknown, opts: { fallbackTargetPct: number }): Direction {
  if (canonical(before) === canonical(after)) return 'same'
  const b = before as Group | number | boolean | string | null
  const a = after as Group | number | boolean | string | null
  switch (rule) {
    case 'never':
      return 'same'
    case 'any':
      return 'raise'
    case 'up':
      // A limit cleared to "none" loosens; a new limit tightens.
      if (a == null) return 'raise'
      if (b == null) return 'lower'
      return (a as number) > (b as number) ? 'raise' : 'lower'
    case 'floor':
      // A floor that appears or rises forces spend; one that goes or falls does not.
      if (a == null) return 'lower'
      if (b == null) return 'raise'
      return (a as number) > (b as number) ? 'raise' : 'lower'
    case 'unprotect':
      if (b === true && a !== true) return 'raise'
      if (a === true && b !== true) return 'lower'
      return 'same'
    case 'target': {
      const kind = (t: unknown) => ((t as Group | null)?.targetKind as string | undefined) ?? 'ACOS'
      const pct = (t: unknown) => numberOr((t as Group | null)?.targetPct, opts.fallbackTargetPct)
      if (kind(b) !== kind(a)) return 'raise'
      return pct(a) > pct(b) ? 'raise' : pct(a) < pct(b) ? 'lower' : 'same'
    }
    case 'loosen': {
      // A group that goes loosens (the engines fall back); a new group only binds tighter (the stricter one wins).
      if (a == null) return 'raise'
      if (b == null) return 'lower'
      const g = (side: Group, column: string, fallback: number) => numberOr(side[column], fallback)
      const bg = b as Group
      const ag = a as Group
      if (key === 'harvest') {
        if (g(ag, 'harvestWindowDays', 0) !== g(bg, 'harvestWindowDays', 0)) return 'raise'
        if (g(ag, 'harvestMinOrders', 0) < g(bg, 'harvestMinOrders', 0) || g(ag, 'harvestMinClicks', 0) < g(bg, 'harvestMinClicks', 0)) return 'raise'
        if (g(ag, 'harvestMaxAcosPct', Infinity) > g(bg, 'harvestMaxAcosPct', Infinity)) return 'raise'
        return 'lower'
      }
      if (g(ag, 'negateWindowDays', 0) !== g(bg, 'negateWindowDays', 0)) return 'raise'
      if (g(ag, 'negateMinClicks', 0) < g(bg, 'negateMinClicks', 0) || g(ag, 'negateMinSpendCents', 0) < g(bg, 'negateMinSpendCents', 0)) return 'raise'
      if (g(ag, 'negateMaxOrders', 0) > g(bg, 'negateMaxOrders', 0)) return 'raise'
      return 'lower'
    }
    case 'pause': {
      // No stop group = low bids at the existing 2¢: a pause, or a higher stop bid, loosens.
      const method = (s: unknown) => ((s as Group | null)?.stopMethod as string | undefined) ?? 'LOW_BIDS'
      const bid = (s: unknown) => numberOr((s as Group | null)?.stopBidCents, DEFAULT_STOP_BID_CENTS)
      if (method(b) !== method(a)) return method(a) === 'PAUSE' ? 'raise' : 'lower'
      return bid(a) > bid(b) ? 'raise' : bid(a) < bid(b) ? 'lower' : 'same'
    }
    case 'count': {
      // AA-W2-2b — empty is 0 (nothing runs by rule): up loosens, down or cleared tightens; empty ↔ 0 is the same.
      const from = numberOr(b, 0)
      const to = numberOr(a, 0)
      return to > from ? 'raise' : to < from ? 'lower' : 'same'
    }
    case 'autonomy': {
      // No level for an action = the strategy does not narrow it: as high as the business allows.
      let up = false
      let down = false
      for (const action of CLAUDE_ACTION_TYPES) {
        const from = RANK[String((b as Group | null)?.[action] ?? 'auto')] ?? RANK.auto
        const to = RANK[String((a as Group | null)?.[action] ?? 'auto')] ?? RANK.auto
        if (to > from) up = true
        if (to < from) down = true
      }
      return up ? 'raise' : down ? 'lower' : 'same'
    }
  }
}

/** Several things that move one campaign's target (each candidate it may aim at): raise when any after beats any before. */
export function judgeTargets(before: readonly number[], after: readonly number[]): Direction {
  if (!before.length || !after.length) return 'same'
  if (Math.max(...after) > Math.min(...before)) return 'raise'
  if (Math.min(...after) < Math.max(...before)) return 'lower'
  return 'same'
}

/** The overall direction: raise when anything raises, else lower when anything lowers. */
export function overall(directions: readonly Direction[]): Direction {
  return directions.includes('raise') ? 'raise' : directions.includes('lower') ? 'lower' : 'same'
}

// ── Values ↔ columns ──────────────────────────────────────────────────────────────────────────────

type Columns = Partial<Record<StrategyColumn, unknown>>
const SETTING_COLUMNS = [...new Set(SETTABLE_FIELDS.flatMap((f) => f.columns))] as StrategyColumn[]

/** A field's input value as its columns (null clears every column of it). */
function columnsOfInput(field: StrategyField, value: unknown): Columns {
  if (value == null) return Object.fromEntries(field.columns.map((c) => [c, null]))
  const v = value as Record<string, unknown>
  switch (field.key) {
    case 'target':
      return { targetKind: v.kind, targetPct: v.pct }
    case 'harvest':
      return { harvestMinOrders: v.minOrders, harvestMinClicks: v.minClicks, harvestMaxAcosPct: v.maxAcosPct ?? null, harvestWindowDays: v.windowDays }
    case 'negate':
      return { negateMinClicks: v.minClicks, negateMinSpendCents: v.minSpendCents, negateMaxOrders: v.maxOrders, negateWindowDays: v.windowDays }
    case 'stop':
      return { stopMethod: v.method, stopBidCents: v.bidCents ?? null }
    case 'claudeAutonomy': {
      const set = Object.fromEntries(Object.entries(v).filter(([, level]) => level != null))
      return { claudeAutonomy: Object.keys(set).length ? set : null }
    }
    default:
      return { [field.columns[0]]: value }
  }
}

/** A field as the input takes it, from a row's columns (null when the row does not set it). */
function inputOfColumns(field: StrategyField, row: Columns): unknown {
  if (!requiredColumns(field).every((c) => row[c] != null)) return null
  switch (field.key) {
    case 'target':
      return { kind: row.targetKind, pct: row.targetPct }
    case 'harvest':
      return { minOrders: row.harvestMinOrders, minClicks: row.harvestMinClicks, maxAcosPct: row.harvestMaxAcosPct ?? null, windowDays: row.harvestWindowDays }
    case 'negate':
      return { minClicks: row.negateMinClicks, minSpendCents: row.negateMinSpendCents, maxOrders: row.negateMaxOrders, windowDays: row.negateWindowDays }
    case 'stop':
      return { method: row.stopMethod, bidCents: row.stopBidCents ?? null }
    default:
      return row[field.columns[0]] ?? null
  }
}

/** A field's own value on a row, as the resolver holds it (a group by its column names; null when not set whole). */
function ownValue(field: StrategyField, row: Columns | null): unknown {
  if (!row || !requiredColumns(field).every((c) => row[c] != null)) return null
  if (field.columns.length === 1) return row[field.columns[0]] ?? null
  return Object.fromEntries(field.columns.map((c) => [c, row[c] ?? null]))
}

const settingsOf = (row: Columns | null): Columns | null => (row ? Object.fromEntries(SETTING_COLUMNS.map((c) => [c, row[c] ?? null])) : null)
/** A row's settings as Prisma writes them: a cleared Json column is the database's NULL. */
const writable = (row: Columns) => ({ ...row, claudeAutonomy: row.claudeAutonomy == null ? Prisma.DbNull : (row.claudeAutonomy as Prisma.InputJsonValue) })

// ── Plan ──────────────────────────────────────────────────────────────────────────────────────────

type Scope =
  | { level: 'MARKET'; scopeId: typeof MARKET_SCOPE; label: string }
  | { level: 'CATEGORY'; scopeId: string; label: string }
  | { level: 'PRODUCT'; scopeId: string; label: string; product: { id: string; sku: string; parentId: string | null } }

/** One recorded change: a field (registry key or column name), a protected term, or a campaign's own target. */
export interface StrategyChange {
  field: string
  label: string
  from: unknown
  to: unknown
  effectiveFrom?: unknown
  effectiveTo?: unknown
  direction: Direction
  term?: string
  matchType?: string | null
  campaignId?: string
  campaign?: string
}

/** What a change wrote and replaced: the change record (and its undo) compares these. */
export interface StrategyState {
  channel: string
  market: string
  level: StrategyLevel
  scopeId: string
  /** The row's version; 0 when there is no row. */
  version: number
  /** The row's own settings, column by column (null = not set); null when there is no row. */
  values: Columns | null
  /** The market's protected terms this change touched: term → its match type (null = the default), or false = not protected. */
  terms: Record<string, { matchType: string | null } | false>
  /** The campaigns whose own target ACoS this change cleared or set: id → the stored fraction, or null for none. */
  campaignTargets: Record<string, number | null>
}

export interface StrategyPlan {
  channel: string
  market: string
  scope: Scope
  op: 'set' | 'remove'
  /** The row as it is (null: none yet) and its settings after (null: removed). */
  row: { id: string; version: number } | null
  after: Columns | null
  changes: StrategyChange[]
  direction: Direction
  /** Labels of what raises, as a person reads them. */
  raises: string[]
  terms: { add: Array<{ term: string; matchType: string | null }>; remove: Array<{ id: string; term: string; matchType: string | null }> }
  campaignTargets: Array<{ campaignId: string; name: string; fromFraction: number | null; toFraction: number | null }>
  reason: string | null
  before: StrategyState
  preview: StrategyPreview
}

export interface StrategyPreview {
  action: 'set-ads-strategy'
  summary: string
  scope: { channel: string; market: string; level: StrategyLevel; scopeId: string; label: string }
  op: 'set' | 'remove'
  version: { from: number; to: number | null }
  changes: StrategyChange[]
  direction: Direction
  raises: string[]
  stepUp: { what: string; raises: string[]; needs: string; how: string } | null
  reachesAmazon: false
  reachNote: string
  liveEffect: string
  readBy: Record<string, readonly string[]>
  notReadYet: string[]
  shadowedBy: Array<{ campaignId: string; name: string; targetAcosPct: number }>
  shadowedCount: number
  affects: { campaigns: number; products?: number }
  warnings?: string[]
  basis: string
}

export type PlanOutcome = { ok: true; plan: StrategyPlan } | { ok: false; status: 400 | 404 | 409; error: string; code?: 'version_moved' }

const refuse = (status: 400 | 404 | 409, error: string, code?: 'version_moved'): PlanOutcome => ({ ok: false, status, error, ...(code ? { code } : {}) })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** The unit a field's number is in, for its label (labels carry no amount). */
const UNIT: Partial<Record<StrategyFieldKey, string>> = {
  monthlySpendCapCents: 'cents', minBidCents: 'cents', maxBidCents: 'cents', maxChangePct: '%', maxActionsPerRun: 'actions', reviewEveryDays: 'days',
  claudeMaxBudgetIncreasePerDayCents: 'cents',
}
const labelOf = (field: StrategyField) => `${field.label}${UNIT[field.key] ? ` (${UNIT[field.key]})` : ''}`
const levelWord = (level: StrategyLevel) => level.toLowerCase()
const pctOfFraction = (fraction: number | null) => (fraction == null ? null : fractionToPct(fraction))
const fractionOfPct = (pct: number | null) => (pct == null ? null : Math.round(pct * 100) / 10_000)

/** The scope a change names, checked to exist in this business (`product`: the one it names, already found). */
async function scopeOf(args: ChangeArgs, market: string, product: Extract<Scope, { level: 'PRODUCT' }>['product'] | null): Promise<Scope | PlanOutcome> {
  const ids = [args.categoryId ? 'categoryId' : null, args.productId ? 'productId' : null, args.sku ? 'sku' : null].filter(Boolean)
  if (args.level === 'market') {
    if (ids.length) return refuse(400, `A market row names no category or product (${ids.join(', ')} given): use level category or product.`)
    return { level: 'MARKET', scopeId: MARKET_SCOPE, label: `${market} market` }
  }
  if (args.level === 'category') {
    if (!args.categoryId || ids.length > 1) return refuse(400, 'A category row names its category: categoryId (from catalog-structure), nothing else.')
    const category = await findCategory(args.categoryId)
    return category ? { level: 'CATEGORY', scopeId: category.id, label: `${category.name} (${market})` } : refuse(404, 'Category not found (categoryId from catalog-structure).')
  }
  if (!product || args.categoryId) return refuse(400, 'A product row names its product: productId or sku, nothing else.')
  return { level: 'PRODUCT', scopeId: product.id, label: `${product.sku} (${market})`, product }
}

/** The strategy in force at the changed scope, for one index (before or after the change). */
type ScopeResolver = (index: StrategyIndex) => ResolvedStrategy

async function resolverFor(scope: Scope): Promise<ScopeResolver> {
  if (scope.level === 'MARKET') return (index) => resolveMarket(index)
  if (scope.level === 'CATEGORY') {
    const { ancestry } = await loadAncestry([scope.scopeId])
    return (index) => resolveCategory(index, scope.scopeId, { ancestry })
  }
  const { catalog } = await loadCatalog([scope.product.id])
  const product = catalog.products.get(scope.product.id) ?? scope.product
  return (index) => resolveProduct(index, product, catalog)
}

/** A field's value in force at the scope: the resolved value; a monthly cap is the row's own (each cap binds on its own spend). */
function effectiveOf(field: StrategyField, resolved: ResolvedStrategy, own: Columns | null): unknown {
  if (field.key === 'claudeAutonomy') {
    const map = Object.fromEntries([...resolved.autonomy].filter(([, r]) => typeof r.value === 'string').map(([action, r]) => [action, r.value]))
    return Object.keys(map).length ? map : null
  }
  if (field.resolve === 'everyScope') return ownValue(field, own)
  return resolved.fields.get(field.key)?.value ?? null
}

/** The campaigns whose own target ACoS wins over the strategy at this scope (a target Nexus cannot read shadows nothing). */
async function shadowsOf(market: string, scope: Scope) {
  const ids = scope.level === 'MARKET' ? undefined : scope.level === 'CATEGORY' ? await productsUnderCategory(scope.scopeId) : await productFamily(scope.scopeId)
  const campaigns = await marketCampaignTargets(market, ids)
  const shadows = campaigns
    .map((c) => ({ ...c, read: targetFraction(c.targetAcos) }))
    .filter((c): c is typeof c & { read: number } => typeof c.read === 'number')
  return { campaigns: campaigns.length, products: ids?.length, shadows }
}

/** Each ad group's ACoS target from the strategy (a whole percent), for the campaigns named; ad groups without one are left out. */
function strategyTargetsByCampaign(index: StrategyIndex, campaigns: ReadonlyMap<string, CampaignFacts>, catalog: Catalog): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const [id, campaign] of campaigns) {
    const targets: number[] = []
    for (const group of campaign.adGroups) {
      const known = group.productIds.map((p) => catalog.products.get(p)).filter((p): p is NonNullable<typeof p> => !!p)
      const pct = resolveProducts(index, known, catalog, group.unknownAds + (group.productIds.length - known.length)).fields.get('targetAcosPct')?.value
      if (typeof pct === 'number') targets.push(pct)
    }
    out.set(id, targets)
  }
  return out
}

/**
 * Plan ONE change of the strategy: checked, judged and previewed — nothing is written. The same plan the tool's dry run
 * shows, the screen shows before Save, and `applyStrategyPlan` writes.
 */
export async function planStrategyChange(raw: unknown): Promise<PlanOutcome> {
  const parsed = STRATEGY_CHANGE_INPUT.safeParse(raw ?? {})
  if (!parsed.success) return refuse(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  const args = parsed.data
  const channel = args.channel
  const market = args.market
  // A product named that is not here (or was deleted) is not found, whatever else the change says.
  if (args.productId && args.sku) return refuse(400, 'Name the product once: productId or sku, not both.')
  const product = args.productId || args.sku ? await findLiveProduct({ productId: args.productId, sku: args.sku }) : null
  if ((args.productId || args.sku) && !product) return refuse(404, PRODUCT_NOT_FOUND)
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(market)) return refuse(400, `market: one Amazon market code (IT, DE, FR, ES, UK; business-overview lists them), not "${market}".`)
  const scope = await scopeOf(args, market, product)
  if ('ok' in scope) return scope

  const op = args.op
  const values = args.values ?? {}
  if (values.monthlySpendCapCents === 0) return refuse(400, ZERO_CAP_REFUSAL)
  const given = SETTABLE_FIELDS.filter((f) => (values as Record<string, unknown>)[f.key] !== undefined)
  if (op === 'remove' && (given.length || args.clearCampaignTargets)) {
    return refuse(400, 'Removing a row takes no values and does not clear campaign targets: remove it alone (its scope then inherits everything).')
  }
  for (const field of given) {
    if ((values as Record<string, unknown>)[field.key] !== null && !field.levels.includes(scope.level)) {
      return refuse(400, `${field.key} cannot be set on a ${levelWord(scope.level)} row (only on a ${field.levels.map(levelWord).join(' or ')} row).`)
    }
  }
  if ((args.protectedTerms?.add?.length || args.protectedTerms?.remove?.length) && scope.level !== 'MARKET') {
    return refuse(400, "Protected search terms belong to a market (the one list Nexus's write gate checks): use level market.")
  }
  if (args.clearCampaignTargets && scope.level !== 'MARKET') {
    return refuse(400, "clearCampaignTargets clears the own targets of a whole market's campaigns: use it with level market.")
  }

  const { index, rows } = await loadIndex(market, channel)
  const current = rows.find((r) => r.level === scope.level && r.scopeId === scope.scopeId) ?? null
  const version = current?.version ?? 0
  if (args.expectVersion !== undefined && args.expectVersion !== version) {
    return refuse(409, `The ${levelWord(scope.level)} strategy for ${scope.label} moved since it was read: it is at version ${version}, not ${args.expectVersion}. Read it again and change it from there.`, 'version_moved')
  }
  if (op === 'remove' && !current) return refuse(404, `There is no ${levelWord(scope.level)} strategy for ${scope.label} to remove.`)

  const own = settingsOf(current as unknown as Columns | null)
  let after: Columns | null
  if (op === 'remove') after = null
  else {
    after = { ...(own ?? settingsOf({})!) }
    for (const field of given) Object.assign(after, columnsOfInput(field, (values as Record<string, unknown>)[field.key]))
  }
  if (after && typeof after.minBidCents === 'number' && typeof after.maxBidCents === 'number' && after.minBidCents > after.maxBidCents) {
    return refuse(400, `The lowest bid (minBidCents) is above the highest bid (maxBidCents) on this row: give a floor at or below the ceiling.`)
  }

  // The strategy before and after, resolved at the changed scope: every field judged on what is in force there.
  const live = {
    categories: new Set([...index.categories.keys(), ...(scope.level === 'CATEGORY' ? [scope.scopeId] : [])]),
    products: new Set([...index.products.keys(), ...(scope.level === 'PRODUCT' ? [scope.scopeId] : [])]),
  }
  const nextRow = after
    ? ({ ...(current ?? {}), id: current?.id ?? 'planned', channel, market, level: scope.level, scopeId: scope.scopeId, label: scope.label, version: version + 1, updatedAt: new Date(), updatedBy: 'planned', ...after } as unknown as StrategyRow)
    : null
  const rowsAfter = [...rows.filter((r) => r !== current), ...(nextRow ? [nextRow] : [])]
  const afterIndex = indexStrategy(market, rowsAfter, live, channel).index
  const resolve = await resolverFor(scope)
  const [resolvedBefore, resolvedAfter] = [resolve(index), resolve(afterIndex)]
  if (after) {
    const min = resolvedAfter.fields.get('minBidCents')?.value
    const max = resolvedAfter.fields.get('maxBidCents')?.value
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      return refuse(400, `After this change the lowest bid in force here would be above the highest bid in force (one of them is inherited): give a floor at or below the ceiling.`)
    }
  }

  const owner = await readOwnerTargets([])
  const account = accountDefaultFraction(owner.accountDefaultPct)
  const fallbackTargetPct = typeof account === 'number' ? fractionToPct(account) : FALLBACK_TARGET_PCT

  const changes: StrategyChange[] = []
  for (const field of SETTABLE_FIELDS) {
    const from = ownValue(field, own)
    const to = ownValue(field, after)
    if (canonical(from) === canonical(to)) continue
    const effectiveFrom = effectiveOf(field, resolvedBefore, own)
    const effectiveTo = effectiveOf(field, resolvedAfter, after)
    changes.push({ field: field.key, label: labelOf(field), from, to, effectiveFrom, effectiveTo, direction: judgeChange(field.raise, field.key, effectiveFrom, effectiveTo, { fallbackTargetPct }) })
  }

  // Protected search terms: the market's own list (AdKeywordProtection, marketplace = market, every campaign).
  const terms: StrategyPlan['terms'] = { add: [], remove: [] }
  const touched: StrategyState['terms'] = {}
  const named = [...(args.protectedTerms?.add ?? []).map((t) => normaliseTerm(t.term)), ...(args.protectedTerms?.remove ?? []).map((t) => normaliseTerm(t))]
  if (new Set(named).size !== named.length) return refuse(400, 'protectedTerms: name each term once (in add or in remove).')
  if (named.some((t) => !t)) return refuse(400, 'protectedTerms: a term needs at least one letter or digit.')
  const existing = named.length
    ? await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST', marketplace: market, campaignId: null, term: { in: named } }, select: { id: true, term: true, matchType: true, isPrefix: true } })
    : []
  const held = new Map(existing.map((row) => [row.term, row]))
  for (const t of args.protectedTerms?.add ?? []) {
    const term = normaliseTerm(t.term)
    if (held.has(term)) return refuse(400, `“${term}” is already protected in ${market}.`)
    terms.add.push({ term, matchType: t.matchType ?? null })
    touched[term] = false
    changes.push({ field: 'protectedTerms', label: 'Protected search term', term, matchType: t.matchType ?? null, from: false, to: true, direction: 'lower' })
  }
  for (const raw of args.protectedTerms?.remove ?? []) {
    const term = normaliseTerm(raw)
    const row = held.get(term)
    if (!row) return refuse(404, `“${term}” is not a protected term of ${market} (a term protected for one campaign only is changed in Nexus).`)
    const matchType = row.matchType ?? (row.isPrefix ? 'PREFIX' : null)
    terms.remove.push({ id: row.id, term, matchType })
    touched[term] = { matchType }
    changes.push({ field: 'protectedTerms', label: 'Protected search term', term, matchType, from: true, to: false, direction: 'raise' })
  }

  // Campaign targets cleared (the strategy then applies) or put back (an undo).
  const restore = new Map((args.restoreCampaignTargets ?? []).map((t) => [t.campaignId, t.targetAcosPct]))
  if (restore.size !== (args.restoreCampaignTargets ?? []).length) return refuse(400, 'restoreCampaignTargets: name each campaign once.')
  const shadow = await shadowsOf(market, scope)
  const clearing = args.clearCampaignTargets ? shadow.shadows.filter((c) => !restore.has(c.id)) : []
  if (clearing.length + restore.size > MAX_CAMPAIGN_TARGETS) {
    return refuse(400, `${market} has ${clearing.length + restore.size} campaign targets to change: at most ${MAX_CAMPAIGN_TARGETS} in one change.`)
  }
  const campaignIds = [...new Set([...clearing.map((c) => c.id), ...restore.keys()])]
  const campaigns = await loadCampaigns(campaignIds)
  const missing = campaignIds.filter((id) => !campaigns.get(id) || (campaigns.get(id)!.marketplace ?? '').toUpperCase() !== market)
  if (missing.length) return refuse(404, `Campaign not found in ${market}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`)
  const campaignTargets: StrategyPlan['campaignTargets'] = []
  const touchedCampaigns: StrategyState['campaignTargets'] = {}
  if (campaignIds.length) {
    const { catalog } = await loadCatalog([...campaigns.values()].flatMap((c) => c.adGroups.flatMap((g) => g.productIds)))
    const strategyBefore = strategyTargetsByCampaign(index, campaigns, catalog)
    const strategyAfter = strategyTargetsByCampaign(afterIndex, campaigns, catalog)
    for (const id of campaignIds) {
      const campaign = campaigns.get(id)!
      const stored = (campaign.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos
      const fromFraction = typeof stored === 'number' && Number.isFinite(stored) ? stored : null
      const toFraction = restore.has(id) ? fractionOfPct(restore.get(id) ?? null) : null
      if (canonical(fromFraction) === canonical(toFraction)) continue
      // What the campaign's ad groups may aim at before and after: its own target, else the strategy's (once an engine
      // reads it) or the bid optimiser's fallback (what it aims at today) — every one of them counts.
      const read = (fraction: number | null) => (typeof targetFraction(fraction) === 'number' ? fractionToPct(fraction as number) : null)
      const candidates = (ownPct: number | null, strategy: number[]) => (ownPct != null ? [ownPct] : [...strategy, fallbackTargetPct])
      const direction = judgeTargets(candidates(read(fromFraction), strategyBefore.get(id) ?? []), candidates(read(toFraction), strategyAfter.get(id) ?? []))
      campaignTargets.push({ campaignId: id, name: campaign.name, fromFraction, toFraction })
      touchedCampaigns[id] = fromFraction
      changes.push({ field: 'targetAcosPct', label: "Campaign's own target ACoS (%)", campaignId: id, campaign: campaign.name, from: pctOfFraction(fromFraction), to: pctOfFraction(toFraction), direction })
    }
  }

  if (!changes.length) {
    return refuse(400, op === 'set' && !current && !given.length
      ? 'Nothing to set: give at least one value, protected term or campaign target.'
      : `Nothing would change: the ${levelWord(scope.level)} strategy for ${scope.label} already holds these values.`)
  }

  const direction = overall(changes.map((c) => c.direction))
  const raises = [...new Set(changes.filter((c) => c.direction === 'raise').map((c) => (c.campaign ? `${c.label}: ${c.campaign}` : c.term ? `${c.label}: “${c.term}”` : c.label)))]
  const before: StrategyState = { channel, market, level: scope.level, scopeId: scope.scopeId, version, values: own, terms: touched, campaignTargets: touchedCampaigns }
  const preview = previewOf({ channel, market, scope, op, version, current: !!current, changes, direction, raises, shadow, terms, campaignTargets, given, before })
  return {
    ok: true,
    plan: {
      channel, market, scope, op, row: current ? { id: current.id, version } : null, after, changes, direction, raises, terms, campaignTargets,
      reason: args.reason?.trim() || null, before, preview,
    },
  }
}

function previewOf(p: {
  channel: string; market: string; scope: Scope; op: 'set' | 'remove'; version: number; current: boolean; changes: StrategyChange[]
  direction: Direction; raises: string[]; shadow: Awaited<ReturnType<typeof shadowsOf>>; terms: StrategyPlan['terms']
  campaignTargets: StrategyPlan['campaignTargets']; given: readonly StrategyField[]; before: StrategyState
}): StrategyPreview {
  const where = p.scope.level === 'MARKET' ? `Amazon ${p.market}` : `${p.scope.label} on Amazon`
  const settings = p.changes.filter((c) => !c.term && !c.campaignId)
  const verb = p.direction === 'raise' ? 'Raises' : p.direction === 'lower' ? 'Lowers' : 'Changes'
  const parts = [
    settings.length ? plural(settings.length, 'setting') : null,
    p.terms.add.length + p.terms.remove.length ? plural(p.terms.add.length + p.terms.remove.length, 'protected term') : null,
    p.campaignTargets.length ? plural(p.campaignTargets.length, "campaign's own target") : null,
  ].filter(Boolean)
  const summary = p.op === 'remove'
    ? `Removes the ${levelWord(p.scope.level)} strategy for ${where}: it then inherits everything${p.direction === 'raise' ? ' (this raises: ' + p.raises.join(', ') + ')' : ''}.`
    : `${verb} the ${levelWord(p.scope.level)} strategy for ${where}: ${parts.join(', ')}${p.raises.length ? `; it raises ${p.raises.join(', ')}` : ''}.`
  const clears = p.campaignTargets.filter((c) => c.toFraction == null).length
  const restores = p.campaignTargets.length - clears
  const readNow = SETTABLE_FIELDS.filter((f) => f.readBy.length && p.changes.some((c) => c.field === f.key))
  const storedOnly = SETTABLE_FIELDS.filter((f) => !f.readBy.length && p.changes.some((c) => c.field === f.key))
  const liveEffect = [
    storedOnly.length
      ? `${storedOnly.map((f) => f.label).join(', ')}: stored, versioned and shown only — no engine or rule reads ${storedOnly.length === 1 ? 'it' : 'them'} yet (notReadYet lists every such field).`
      : null,
    ...readNow.map((f) => `${f.label} binds at once: read by ${f.readBy.join(', ')}.`),
    p.terms.add.length ? `${plural(p.terms.add.length, 'protected term')} ${p.terms.add.length === 1 ? 'binds' : 'bind'} at once: Nexus's write gate refuses to negate ${p.terms.add.length === 1 ? 'it' : 'them'} in ${p.market}.` : null,
    p.terms.remove.length ? `${plural(p.terms.remove.length, 'term')} ${p.terms.remove.length === 1 ? 'is' : 'are'} no longer protected at once: rules may negate ${p.terms.remove.length === 1 ? 'it' : 'them'} in ${p.market} again.` : null,
    clears ? `Clearing ${plural(clears, "campaign's own target ACoS")} changes what Nexus's bid optimiser aims at for ${clears === 1 ? 'it' : 'them'} today: this strategy's target ACoS where it sets one, else the account default, profit data or ${FALLBACK_TARGET_PCT} %.` : null,
    restores ? `${plural(restores, "campaign's own target ACoS")} ${restores === 1 ? 'is' : 'are'} put back: Nexus's bid optimiser aims at ${restores === 1 ? 'it' : 'them'} again.` : null,
  ].filter(Boolean).join(' ')
  const warnings = [
    p.changes.some((c) => c.field === 'target' && (c.to as Group | null)?.targetKind === 'TACOS')
      ? 'A TACoS target is stored and shown, and Claude steers by it; Nexus\'s engines steer by ACoS only and use the next ACoS target down the chain.'
      : null,
    p.shadow.shadows.length && p.given.some((f) => f.key === 'target') && !p.campaignTargets.some((c) => c.toFraction == null)
      ? `${plural(p.shadow.shadows.length, 'campaign')} ${p.shadow.shadows.length === 1 ? 'has its' : 'have their'} own target ACoS, which keeps winning over the strategy${p.scope.level === 'MARKET' ? ' (clearCampaignTargets clears them in this change)' : ''}.`
      : null,
    // AA-W2-2b — Claude's daily limits fail closed: empty (or 0) is nothing that adds to it runs by rule.
    ...p.changes
      .filter((c) => (CLAUDE_DAILY_FIELDS as readonly string[]).includes(c.field) && !c.to)
      .map((c) => `${c.label}: empty or 0 means nothing that adds to it runs by rule in ${p.market}; a person decides each one.`),
  ].filter((w): w is string => !!w)
  // What it starts from (the row's version and values, the terms and campaign targets it touches) and every change with
  // the values in force: anything that moves between the approval and the run makes it a different decision.
  const basis = createHash('sha256').update(canonical({ before: p.before, changes: p.changes })).digest('base64url').slice(0, 32)
  return {
    action: 'set-ads-strategy',
    summary,
    scope: { channel: p.channel, market: p.market, level: p.scope.level, scopeId: p.scope.scopeId, label: p.scope.label },
    op: p.op,
    version: { from: p.version, to: p.op === 'remove' ? null : p.version + 1 },
    changes: p.changes,
    direction: p.direction,
    raises: p.raises,
    stepUp: p.direction === 'raise'
      ? {
          what: 'raises the ads strategy',
          raises: p.raises,
          needs: STEP_UP_NEEDS,
          how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs when the business set set-ads-strategy to confirm in Claude. It never runs by rule.',
        }
      : null,
    reachesAmazon: false,
    reachNote: 'Nexus only: nothing is sent to Amazon by this change.',
    liveEffect,
    readBy: Object.fromEntries(SETTABLE_FIELDS.filter((f) => p.changes.some((c) => c.field === f.key)).map((f) => [f.key, f.readBy])),
    notReadYet: notReadYet(),
    shadowedBy: p.shadow.shadows.slice(0, MAX_LISTED).map((c) => ({ campaignId: c.id, name: c.name, targetAcosPct: fractionToPct(c.read) })),
    shadowedCount: p.shadow.shadows.length,
    affects: { campaigns: p.shadow.campaigns, ...(p.shadow.products != null ? { products: p.shadow.products } : {}) },
    ...(warnings.length ? { warnings } : {}),
    basis,
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────────────────────────

/** Who writes a change, for the row, its version and the audit. */
export interface StrategyWriter {
  /** screen | claude | assistant | fleet | system — the door the change came through. */
  via: string
  /** The name shown. */
  actor: string
  actorUserId: string | null
  /** The AgentApproval the change carries out (Claude's request, or a plan's). */
  approvalId?: string | null
  /** When a raise was confirmed with a fresh authenticator code; null for a change that does not raise. */
  stepUpAt?: Date | null
  /** On the row: 'user:<id>' or 'claude:<approvalId>'. */
  updatedBy: string
}

export type ApplyOutcome =
  | { ok: true; strategyId: string; version: number; direction: Direction; changes: StrategyChange[]; before: StrategyState; after: StrategyState }
  | { ok: false; status: 409; error: string; code: 'version_moved' }

class Moved extends Error {}

const MOVED = 'The strategy (or a protected term or campaign target it changes) moved since this change was planned: nothing was saved. Read it again and change it from there.'

/** Write a planned change in ONE transaction, with its version row; a row, term or campaign that moved since → a conflict. */
export async function applyStrategyPlan(plan: StrategyPlan, writer: StrategyWriter): Promise<ApplyOutcome> {
  if (plan.direction === 'raise' && !writer.stepUpAt) throw new Error('a raise of the ads strategy is written only with the time its authenticator code was confirmed')
  const { scope } = plan
  let strategyId = plan.row?.id ?? ''
  const version = plan.row ? plan.row.version + 1 : 1
  try {
    await prisma.$transaction(async (tx) => {
      if (plan.op === 'remove') {
        const gone = await tx.adsStrategy.deleteMany({ where: { id: plan.row!.id, version: plan.row!.version } })
        if (gone.count !== 1) throw new Moved()
      } else if (plan.row) {
        const moved = await tx.adsStrategy.updateMany({
          where: { id: plan.row.id, version: plan.row.version },
          data: { ...writable(plan.after!), label: scope.label, version, updatedBy: writer.updatedBy } as Prisma.AdsStrategyUpdateManyMutationInput,
        })
        if (moved.count !== 1) throw new Moved()
      } else {
        const taken = await tx.adsStrategy.findFirst({ where: { channel: plan.channel, market: plan.market, level: scope.level, scopeId: scope.scopeId }, select: { id: true } })
        if (taken) throw new Moved()
        const created = await tx.adsStrategy.create({
          data: { ...writable(plan.after!), channel: plan.channel, market: plan.market, level: scope.level, scopeId: scope.scopeId, label: scope.label, version: 1, updatedBy: writer.updatedBy } as Prisma.AdsStrategyUncheckedCreateInput,
          select: { id: true },
        })
        strategyId = created.id
      }
      await tx.adsStrategyVersion.create({
        data: {
          strategyId, channel: plan.channel, market: plan.market, level: scope.level, scopeId: scope.scopeId, version,
          op: plan.op, values: (plan.after ?? undefined) as Prisma.InputJsonValue | undefined, changes: plan.changes as unknown as Prisma.InputJsonValue,
          direction: plan.direction, via: writer.via, approvalId: writer.approvalId ?? null, actor: writer.actor,
          actorUserId: writer.actorUserId, stepUpAt: plan.direction === 'raise' ? writer.stepUpAt! : null, reason: plan.reason,
        },
      })
      const note = `Ads strategy ${scope.label}, version ${version}${plan.reason ? `: ${plan.reason}` : ''}`
      for (const t of plan.terms.add) {
        if (await tx.adKeywordProtection.findFirst({ where: { mode: 'WHITELIST', term: t.term, marketplace: plan.market, campaignId: null }, select: { id: true } })) throw new Moved()
        const row = await tx.adKeywordProtection.create({
          data: { mode: 'WHITELIST', term: t.term, isPrefix: t.matchType === 'PREFIX', matchType: t.matchType, marketplace: plan.market, campaignId: null, reason: note, createdBy: writer.updatedBy },
        })
        await tx.advertisingActionLog.create({
          data: { userId: writer.updatedBy, actionType: 'add_keyword_protection', entityType: 'KEYWORD_PROTECTION', entityId: row.id, payloadBefore: {}, payloadAfter: { mode: row.mode, term: row.term, matchType: row.matchType, marketplace: row.marketplace }, amazonResponseStatus: 'SUCCESS', evidence: { metric: 'operator_guardrail', note } },
        })
      }
      for (const t of plan.terms.remove) {
        const gone = await tx.adKeywordProtection.deleteMany({ where: { id: t.id } })
        if (gone.count !== 1) throw new Moved()
        await tx.advertisingActionLog.create({
          data: { userId: writer.updatedBy, actionType: 'remove_keyword_protection', entityType: 'KEYWORD_PROTECTION', entityId: t.id, payloadBefore: { mode: 'WHITELIST', term: t.term, matchType: t.matchType, marketplace: plan.market }, payloadAfter: {}, amazonResponseStatus: 'SUCCESS', evidence: { metric: 'operator_guardrail', note } },
        })
      }
      for (const c of plan.campaignTargets) {
        const now = await tx.campaign.findUnique({ where: { id: c.campaignId }, select: { dynamicBidding: true } })
        const stored = (now?.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos
        if (!now || canonical(typeof stored === 'number' ? stored : null) !== canonical(c.fromFraction)) throw new Moved()
        await patchDynamicBiddingIn(tx, c.campaignId, c.toFraction == null ? { remove: ['targetAcos'] } : { set: { targetAcos: c.toFraction } })
        await tx.advertisingActionLog.create({
          data: {
            userId: writer.updatedBy, actionType: 'set_campaign_goal', entityType: 'CAMPAIGN', entityId: c.campaignId,
            payloadBefore: { targetAcos: c.fromFraction },
            payloadAfter: { targetAcos: c.toFraction, note: c.toFraction == null ? 'own target ACoS cleared: the ads strategy is not shadowed' : 'own target ACoS put back' },
            evidence: { metric: 'operator_goal', note: `${note} — Nexus only: never sent to Amazon.` },
          },
        })
      }
    })
  } catch (error) {
    if (error instanceof Moved || (error as { code?: string } | null)?.code === 'P2002') return { ok: false, status: 409, error: MOVED, code: 'version_moved' }
    throw error
  }
  const after = await strategyStateNow(plan.before)
  return { ok: true, strategyId, version, direction: plan.direction, changes: plan.changes, before: plan.before, after }
}

// ── State and undo ────────────────────────────────────────────────────────────────────────────────

/** What is stored now for the scope, terms and campaigns a change recorded (`state`): what its undo compares. */
export async function strategyStateNow(state: StrategyState): Promise<StrategyState> {
  const termNames = Object.keys(state.terms ?? {})
  const campaignIds = Object.keys(state.campaignTargets ?? {})
  const [row, terms, campaigns] = await Promise.all([
    prisma.adsStrategy.findFirst({
      where: { channel: state.channel, market: state.market, level: state.level, scopeId: state.scopeId },
      select: STRATEGY_ROW_SELECT,
    }),
    termNames.length
      ? prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST', marketplace: state.market, campaignId: null, term: { in: termNames } }, select: { term: true, matchType: true, isPrefix: true } })
      : Promise.resolve([]),
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dynamicBidding: true } }) : Promise.resolve([]),
  ])
  const heldTerms = new Map(terms.map((t) => [t.term, t]))
  const byCampaign = new Map(campaigns.map((c) => [c.id, (c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos]))
  return {
    channel: state.channel,
    market: state.market,
    level: state.level,
    scopeId: state.scopeId,
    version: row?.version ?? 0,
    values: settingsOf(row as unknown as Columns | null),
    terms: Object.fromEntries(termNames.sort().map((term) => {
      const held = heldTerms.get(term)
      return [term, held ? { matchType: held.matchType ?? (held.isPrefix ? 'PREFIX' : null) } : false]
    })),
    campaignTargets: Object.fromEntries(campaignIds.sort().map((id) => {
      const stored = byCampaign.get(id)
      return [id, typeof stored === 'number' && Number.isFinite(stored) ? stored : null]
    })),
  }
}

/** The arguments of set-ads-strategy that put `before` back over `after` (an undo): the row, the terms, the campaign targets. */
export function undoArgsOf(before: StrategyState, after: StrategyState): Record<string, unknown> {
  const level = before.level
  const scopeArg = level === 'CATEGORY' ? { categoryId: before.scopeId } : level === 'PRODUCT' ? { productId: before.scopeId } : {}
  const add: Array<{ term: string; matchType?: string }> = []
  const remove: string[] = []
  for (const [term, was] of Object.entries(before.terms ?? {})) {
    const now = after.terms?.[term] ?? false
    if (was && !now) add.push({ term, ...(was.matchType ? { matchType: was.matchType } : {}) })
    if (!was && now) remove.push(term)
  }
  const campaigns = Object.entries(before.campaignTargets ?? {})
  const values = before.values
    ? Object.fromEntries(SETTABLE_FIELDS.filter((f) => f.levels.includes(level)).map((f) => [f.key, inputOfColumns(f, before.values!)]))
    : null
  return {
    channel: before.channel,
    market: before.market,
    level: level.toLowerCase(),
    ...scopeArg,
    op: values ? 'set' : 'remove',
    ...(values ? { values } : {}),
    ...(add.length || remove.length ? { protectedTerms: { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) } } : {}),
    ...(campaigns.length ? { restoreCampaignTargets: campaigns.map(([campaignId, fraction]) => ({ campaignId, targetAcosPct: pctOfFraction(fraction) })) } : {}),
    expectVersion: after.version,
    reason: 'undo of an earlier ads strategy change',
  }
}

/** The words of a raise's refusals on the Strategy tab (claude-trust.service.ts mayRaise). */
export const STRATEGY_RAISE: RaiseWords = {
  act: 'Raising the ads strategy',
  before: 'you raise the ads strategy',
  free: 'Lowering it does not.',
}
