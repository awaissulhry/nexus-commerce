/**
 * ADS PLAYBOOK PB-2 — the playbook's shapes, ONE zod schema each, pure (design report 9 §3, §4.2):
 *
 *   TEMPLATE_DOC     AdsPlaybookTemplate.doc — HOW a product's ads are built and run, product-agnostic: the slots (one
 *                    campaign with one ad group each), names, portfolio, budget split, start-bid ladder, placements,
 *                    harvest edges, isolation switches, rank roles and the phase table. Eight sections (SECTIONS); a
 *                    playbook row's `overrides` replaces a section WHOLE.
 *   OVERRIDES        AdsPlaybook.overrides — { <section>: <whole section> }, plus `skipSlots` on a PRODUCT row (the
 *                    optional slots this product leaves out: "keep, or drop the brand campaigns").
 *   PRODUCT_TERMS    AdsPlaybook.terms — the product's own lists: brand, category (exact-at-start marks), competitor,
 *                    competitor ASINs, negatives. Real terms live in the database only (public repo).
 *   PHASE_RECIPES    AdsPlaybook.phaseRecipes — each phase's numbers made absolute for one product (PB-3), in the ads
 *                    strategy's own field names and units; written into AdsStrategy only by an approved phase switch.
 *
 * Units, the W1 rules: money in minor units of the market's currency (`…Cents`), percent as an integer percent. A budget
 * weight is a share (only the ratio counts), a bid ladder entry a factor of the product's base bid: neither is money.
 *
 * Phase = the strategy's goal (Owner decision D-PB3): the phase table is keyed by STRATEGY_GOALS. Nothing here reads a
 * database or calls Amazon; no engine ever reads a playbook (it is compiled by an approved apply, PB-4/PB-5).
 */
import { z } from 'zod'
import { FIELDS } from '@nexus/shared/permissions'
import { BIDDING_STRATEGIES, MAX_PLACEMENT_PCT } from '../../ads-core/ads-blueprint-apply.js'
import { CLAUDE_ACTION_TYPES, CLAUDE_LEVELS, MAX_TARGET_PCT, STRATEGY_GOALS, STRATEGY_MONEY } from '../ads-strategy/fields.js'

// ── Vocabulary ────────────────────────────────────────────────────────────────────────────────────

export const SECTIONS = ['structure', 'budget', 'bids', 'placements', 'harvest', 'isolation', 'rank', 'phases'] as const
export type SectionKey = (typeof SECTIONS)[number]

export const SLOT_TARGETING = ['AUTO', 'KEYWORD', 'PRODUCT'] as const
export const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'] as const
export const INTENTS = ['BRAND', 'CATEGORY', 'COMPETITOR', 'ANY'] as const
export const RANK_ROLES = ['performance', 'research'] as const
export type RankRole = (typeof RANK_ROLES)[number]
/** Which of the product's term lists seed a slot at build (`categoryExactAtStart`: only the category terms marked so). */
export const FEEDS = ['brand', 'category', 'categoryExactAtStart', 'competitor', 'competitorAsins'] as const
/** Amazon's four auto-targeting groups (ads-core/ads-blueprint.ts AutoClause). */
export const AUTO_GROUPS = ['CLOSE_MATCH', 'LOOSE_MATCH', 'SUBSTITUTES', 'COMPLEMENTS'] as const
export const PHASES = STRATEGY_GOALS
export type Phase = (typeof PHASES)[number]
export const PLAYBOOK_STATES = ['DRAFT', 'BUILDING', 'BUILT', 'RUNNING', 'STOPPED'] as const
export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const
/** The harvest wire's start-bid modes (the bid a graduated keyword or ASIN starts at). */
export const HARVEST_BID_MODES = ['cpc', 'cpcPlusPct', 'destDefault', 'fixedCents'] as const

/** A slot key: 'exact-brand', 'auto', 'pat'. Lower case, digits and dashes. */
export const SLOT_KEY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a slot key is lower case letters, digits and dashes (at most 40)')
const PCT = z.number().int().min(0).max(MAX_PLACEMENT_PCT)
const FACTOR = z.number().positive().max(100)
const TEXT = (max: number) => z.string().trim().min(1).max(max)
/** The look-backs the ads strategy keeps for its harvest and negate groups (fields.ts COLUMN_CHECKS). */
const WINDOW_DAYS = z.union([z.literal(30), z.literal(60), z.literal(90)])

// ── Sections ──────────────────────────────────────────────────────────────────────────────────────

export const SLOT = z.object({
  key: SLOT_KEY,
  targeting: z.enum(SLOT_TARGETING),
  /** KEYWORD slots only. */
  match: z.enum(MATCH_TYPES).optional(),
  intent: z.enum(INTENTS),
  rankRole: z.enum([...RANK_ROLES, 'none']).default('none'),
  feeds: z.array(z.enum(FEEDS)).max(FEEDS.length).default([]),
  /** AUTO slots only: each group on or off, and its bid as a factor of the slot's start bid. */
  autoGroups: z.partialRecord(z.enum(AUTO_GROUPS), z.object({ on: z.boolean(), factor: FACTOR.default(1) })).optional(),
  /** The words of the campaign name this slot adds ({parts} of the naming pattern): ['Exact', 'Brand']. */
  nameParts: z.array(TEXT(40)).min(1).max(6),
  biddingStrategy: z.enum(BIDDING_STRATEGIES).default('LEGACY_FOR_SALES'),
  /** May be left out per product (a PRODUCT row's `skipSlots`). */
  optional: z.boolean().default(false),
}).strict()
export type Slot = z.infer<typeof SLOT>

export const STRUCTURE = z.object({
  /** "{product} | {market} | {parts}": {product} is the product's name token, {parts} the slot's nameParts. */
  naming: z.object({ pattern: TEXT(120), partSeparator: z.string().min(1).max(5).default(' | ') }).strict(),
  /** "{business} {product} {market}": reused when it exists, else created at build (mode none: no portfolio). */
  portfolio: z.object({ pattern: TEXT(120), mode: z.enum(['reuse-or-create', 'none']) }).strict(),
  /** Which seller SKU advertises a child that has both: the FBA one, the FBM one, or both. */
  productAds: z.object({ fulfilment: z.enum(['FBA', 'FBM', 'both']) }).strict(),
  /** A category or competitor term another enrolled product already runs in the market (D-PB5: one owner per term). */
  sharedTerms: z.enum(['skip', 'accept']).default('skip'),
  slots: z.array(SLOT).min(1).max(30),
}).strict()

export const BUDGET = z.object({
  /** Share of the product's daily budget per slot (only the ratio counts). */
  weights: z.record(SLOT_KEY, z.number().min(0).max(1000)),
  /** The least daily budget a slot gets (minor units; Amazon's own minimum is 1.00). */
  minPerSlotCents: z.number().int().min(100).max(10_000_000).default(100),
}).strict()

export const BIDS = z.object({
  /** Each slot's start bid as a factor of the product's base bid. */
  ladder: z.record(SLOT_KEY, FACTOR),
  /** The new campaigns are born at Amazon's 2¢ floor; Start puts their planned bids back (D-W3-C). */
  launch: z.literal('floor').default('floor'),
}).strict()

export const PLACEMENT = z.object({ top: PCT, productPage: PCT, restOfSearch: PCT }).strict()
export const PLACEMENTS_SECTION = z.record(SLOT_KEY, PLACEMENT)

/** Where a harvested term goes: one slot, or the intent router (brand / competitor / category by the term's words). */
const HARVEST_TO = z.union([
  SLOT_KEY,
  z.object({ router: z.literal('intent'), brand: SLOT_KEY, competitor: SLOT_KEY, category: SLOT_KEY }).strict(),
])
export const HARVEST_EDGE = z.object({
  from: z.array(SLOT_KEY).min(1).max(30),
  to: HARVEST_TO,
  what: z.enum(['KEYWORD_EXACT', 'KEYWORD_PHRASE', 'ASIN_PRODUCT']),
  startBid: z.object({ mode: z.enum(HARVEST_BID_MODES), value: z.number().int().min(0).max(100_000).optional() }).strict()
    .default({ mode: 'cpc' }),
  /** Negate the term (or ASIN) in the source once it graduated (negative exact / negative product target). */
  negateSource: z.boolean().default(true),
}).strict()
/** The thresholds are NOT here: they are the strategy's harvest group, which decides per ad group (W1-7). */
export const HARVEST = z.object({ edges: z.array(HARVEST_EDGE).max(40) }).strict()

export const ISOLATION = z.object({
  /** Every live positive exact keyword of the product → negative exact in its Auto, Broad and Phrase slots. */
  exactIntoResearch: z.boolean(),
  /** The brand terms → negative phrase in the category and competitor slots (brand searches go to brand slots). */
  brandPhraseIntoCategoryAndCompetitor: z.boolean(),
  /** Phrase keywords → negative phrase in the Broad and Auto slots. */
  phraseIntoBroadAndAuto: z.boolean(),
}).strict()

/** One hourly window, the AdSchedule.windows shape: days 0–6 (Sunday 0), hours 0–23 (endHour inclusive), a RankTarget key. */
export const RANK_WINDOW = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  targetKey: TEXT(80),
}).strict()
export type RankWindow = z.infer<typeof RANK_WINDOW>
const RANK_PLAN = z.object({
  windows: z.array(RANK_WINDOW).max(200),
  /** The RankTarget key held outside every window; null = nothing outside the windows. */
  baseline: TEXT(80).nullable(),
}).strict()
export const RANK_ROLE = RANK_PLAN.extend({
  /** The market's timezone when empty. */
  timezone: TEXT(60).optional(),
  /** A lighter plan a phase may switch the role to (`light`). */
  light: RANK_PLAN.optional(),
  /** Per slot: the RankTarget overrides its campaign keeps (AdSchedule.targetOverrides: { targetKey: { … } }). */
  slotOverrides: z.record(SLOT_KEY, z.record(TEXT(80), z.record(z.string(), z.number()))).optional(),
}).strict()
export const RANK = z.object({ roles: z.partialRecord(z.enum(RANK_ROLES), RANK_ROLE) }).strict()

/** A phase's numbers as factors, made absolute per product at enrollment (PB-3) from its costs and the market target. */
export const RECIPE_FACTORS = z.object({
  /**
   * Target ACoS = factor × the product's break-even ACoS (`breakEven`; without costs, fallbackFactor × the market's
   * target), or factor × the market's target (`marketTarget`).
   */
  targetAcos: z.object({ from: z.enum(['breakEven', 'marketTarget']), factor: FACTOR, fallbackFactor: FACTOR.optional() }).strict().optional(),
  /** Lowest and highest bid as factors of the product's base bid. */
  bidBand: z.object({ minFactor: FACTOR.optional(), maxFactor: FACTOR.optional() }).strict().optional(),
  maxChangePct: z.number().int().min(1).max(100).optional(),
  harvest: z.object({
    minOrders: z.number().int().min(1).max(100),
    minClicks: z.number().int().min(0).max(10_000),
    /** The harvest's ACoS ceiling as a factor of the phase's target; absent = none. */
    maxAcosFactor: FACTOR.optional(),
    windowDays: WINDOW_DAYS,
  }).strict().optional(),
  negate: z.object({
    minClicks: z.number().int().min(1).max(10_000),
    /** The least spend before a term is negated, as a factor of the product's base bid. */
    minSpendFactor: FACTOR.optional(),
    maxOrders: z.number().int().min(0).max(100),
    windowDays: WINDOW_DAYS,
  }).strict().optional(),
}).strict()

/**
 * When Nexus proposes leaving a phase: a rule whose conditions all hold (numbers computed by Nexus, PB-9). Several rules
 * may lead to the same phase ("21 days and 10 orders, or 35 days"). Kept flat on purpose: the money filter reads a
 * fixed depth, and a deeper rule would be cut from a person's answer.
 */
export const EXIT_CONDITION = z.object({
  metric: z.enum(['daysInPhase', 'adOrders', 'acosToTargetPct', 'ordersChangePct', 'sellableUnits']),
  op: z.enum(['gte', 'lte']),
  value: z.number().min(-100).max(100_000),
  /** The look-back for a measured metric (adOrders, acosToTargetPct, ordersChangePct). */
  windowDays: z.number().int().min(1).max(365).optional(),
}).strict()
export const EXIT_RULE = z.object({
  to: z.union([z.enum(PHASES), z.literal('ASK_OWNER')]),
  when: z.array(EXIT_CONDITION).min(1).max(6),
}).strict()

export const PHASE = z.object({
  recipe: RECIPE_FACTORS,
  /** Per slot: active, or at the floor (low bids; never a pause). A slot not named stays active. */
  slots: z.record(SLOT_KEY, z.enum(['active', 'floor'])).default({}),
  /** This phase's own budget weights; absent = the budget section's. */
  weights: z.record(SLOT_KEY, z.number().min(0).max(1000)).optional(),
  rank: z.partialRecord(z.enum(RANK_ROLES), z.enum(['off', 'on', 'light'])).default({}),
  harvestCadence: z.enum(['daily', 'weekly', 'off']),
  /** What Claude may do alone in this phase, per kind of ad action (narrows the business's levels, never widens). */
  claude: z.partialRecord(z.enum(CLAUDE_ACTION_TYPES as [string, ...string[]]), z.enum(CLAUDE_LEVELS as [string, ...string[]])).default({}),
  exit: z.array(EXIT_RULE).max(6).default([]),
}).strict()
export const PHASES_SECTION = z.partialRecord(z.enum(PHASES), PHASE)

export const SECTION_SCHEMAS = {
  structure: STRUCTURE,
  budget: BUDGET,
  bids: BIDS,
  placements: PLACEMENTS_SECTION,
  harvest: HARVEST,
  isolation: ISOLATION,
  rank: RANK,
  phases: PHASES_SECTION,
} as const satisfies Record<SectionKey, z.ZodType>

export const TEMPLATE_DOC = z.object(SECTION_SCHEMAS).strict()
export type TemplateDoc = z.infer<typeof TEMPLATE_DOC>
export type SectionValue<K extends SectionKey> = TemplateDoc[K]

/** A playbook row's overrides: any whole section, and (PRODUCT rows) the optional slots the product leaves out. */
export const OVERRIDES = z.object({
  ...Object.fromEntries(SECTIONS.map((k) => [k, SECTION_SCHEMAS[k].optional()])) as { [K in SectionKey]: z.ZodOptional<(typeof SECTION_SCHEMAS)[K]> },
  skipSlots: z.array(SLOT_KEY).max(30).optional(),
}).strict()
export type Overrides = z.infer<typeof OVERRIDES>

export const PRODUCT_TERMS = z.object({
  brand: z.array(TEXT(80)).max(250).default([]),
  category: z.array(z.object({ text: TEXT(80), exactAtStart: z.boolean().default(false) }).strict()).max(250).default([]),
  competitor: z.array(TEXT(80)).max(250).default([]),
  competitorAsins: z.array(z.string().trim().regex(/^B0[A-Z0-9]{8}$/i, 'an ASIN is B0 and 8 letters or digits')).max(250).default([]),
  /** Written into every slot at build (negatives first). Amazon: a negative phrase has at most 4 words. */
  negatives: z.array(z.object({ text: TEXT(80), match: z.enum(['EXACT', 'PHRASE']) }).strict()).max(250).default([]),
}).strict()
export type ProductTerms = z.infer<typeof PRODUCT_TERMS>

/** One phase's numbers for one product, in the strategy's own field names and units (integer percent, minor units). */
export const PHASE_RECIPE = z.object({
  targetAcosPct: z.number().int().min(1).max(MAX_TARGET_PCT).optional(),
  minBidCents: z.number().int().min(2).max(100_000).optional(),
  maxBidCents: z.number().int().min(2).max(100_000).optional(),
  maxChangePct: z.number().int().min(1).max(100).optional(),
  harvestMinOrders: z.number().int().min(1).max(100).optional(),
  harvestMinClicks: z.number().int().min(0).max(10_000).optional(),
  harvestMaxAcosPct: z.number().int().min(1).max(1000).optional(),
  harvestWindowDays: WINDOW_DAYS.optional(),
  negateMinClicks: z.number().int().min(1).max(10_000).optional(),
  negateMinSpendCents: z.number().int().min(0).max(10_000_000).optional(),
  negateMaxOrders: z.number().int().min(0).max(100).optional(),
  negateWindowDays: WINDOW_DAYS.optional(),
}).strict()
export const PHASE_RECIPES = z.partialRecord(z.enum(PHASES), PHASE_RECIPE)
export type PhaseRecipes = z.infer<typeof PHASE_RECIPES>

/**
 * The playbook's ad-spend money keys: the strategy's (recipes use its field names) and the product row's budget and
 * bids. Every amount sits ONLY under one of these keys, alone, so the money filter removes exactly the money.
 */
export const PLAYBOOK_MONEY: Readonly<Record<string, string>> = {
  ...STRATEGY_MONEY,
  ...Object.fromEntries(['dailyBudgetCents', 'baseBidCents', 'minPerSlotCents', 'startBidCents'].map((key) => [key, FIELDS.financialsAdspendView])),
}

// ── Checks across sections ────────────────────────────────────────────────────────────────────────

const issuesOf = (error: z.ZodError, prefix: string) =>
  error.issues.map((i) => `${[prefix, ...i.path.map(String)].filter(Boolean).join('.')}: ${i.message}`)

/** One section, read with its own schema: its value, or why it cannot be read. */
export function readSection<K extends SectionKey>(key: K, value: unknown): { value: SectionValue<K> } | { problems: string[] } {
  const parsed = SECTION_SCHEMAS[key].safeParse(value)
  return parsed.success ? { value: parsed.data as SectionValue<K> } : { problems: issuesOf(parsed.error, key) }
}

/**
 * What a whole doc (a template, or one resolved for a product) says that no section can check alone: a slot named
 * twice, a reference to a slot that does not exist, a keyword slot without a match type, a phase's light rank plan the
 * role does not have. Empty = the doc compiles as far as its own shape goes.
 */
export function crossCheck(doc: TemplateDoc): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const slot of doc.structure.slots) {
    if (keys.has(slot.key)) problems.push(`structure.slots: the slot key "${slot.key}" is used twice`)
    keys.add(slot.key)
    if (slot.targeting === 'KEYWORD' && !slot.match) problems.push(`structure.slots.${slot.key}: a keyword slot needs a match type`)
    if (slot.targeting !== 'KEYWORD' && slot.match) problems.push(`structure.slots.${slot.key}: only a keyword slot has a match type`)
    if (slot.targeting !== 'AUTO' && slot.autoGroups) problems.push(`structure.slots.${slot.key}: only an auto slot has auto groups`)
  }
  if (!doc.structure.naming.pattern.includes('{parts}')) problems.push('structure.naming.pattern: it needs {parts}, or every slot would get the same name')
  const known = (where: string, key: string) => { if (!keys.has(key)) problems.push(`${where}: no slot "${key}"`) }
  for (const key of Object.keys(doc.budget.weights)) known('budget.weights', key)
  for (const key of Object.keys(doc.bids.ladder)) known('bids.ladder', key)
  for (const key of Object.keys(doc.placements)) known('placements', key)
  for (const slot of doc.structure.slots) if (!(slot.key in doc.bids.ladder)) problems.push(`bids.ladder: the slot "${slot.key}" has no start bid factor`)
  doc.harvest.edges.forEach((edge, i) => {
    for (const from of edge.from) known(`harvest.edges.${i}.from`, from)
    for (const to of typeof edge.to === 'string' ? [edge.to] : [edge.to.brand, edge.to.competitor, edge.to.category]) known(`harvest.edges.${i}.to`, to)
  })
  for (const key of Object.keys(doc.rank.roles.performance?.slotOverrides ?? {})) known('rank.roles.performance.slotOverrides', key)
  for (const key of Object.keys(doc.rank.roles.research?.slotOverrides ?? {})) known('rank.roles.research.slotOverrides', key)
  for (const slot of doc.structure.slots) {
    if (slot.rankRole !== 'none' && !doc.rank.roles[slot.rankRole]) problems.push(`structure.slots.${slot.key}: the rank role "${slot.rankRole}" has no plan in the rank section`)
  }
  for (const [phase, entry] of Object.entries(doc.phases)) {
    if (!entry) continue
    for (const key of Object.keys(entry.slots)) known(`phases.${phase}.slots`, key)
    for (const key of Object.keys(entry.weights ?? {})) known(`phases.${phase}.weights`, key)
    for (const [role, state] of Object.entries(entry.rank)) {
      if (state === 'light' && !doc.rank.roles[role as RankRole]?.light) problems.push(`phases.${phase}.rank.${role}: "light" needs the role's light plan`)
    }
  }
  return problems
}

/** A whole template doc: its value when every section reads and the cross-checks pass, else every problem. */
export function checkTemplateDoc(value: unknown): { doc: TemplateDoc } | { problems: string[] } {
  const parsed = TEMPLATE_DOC.safeParse(value)
  if (!parsed.success) return { problems: issuesOf(parsed.error, '') }
  const problems = crossCheck(parsed.data)
  return problems.length ? { problems } : { doc: parsed.data }
}
