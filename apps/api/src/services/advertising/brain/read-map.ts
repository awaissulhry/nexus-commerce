/**
 * ONE BRAIN AB-3 — the brain's map (design 2026-10-08-ads-one-brain/DESIGN.md §3, §6, §8 row AB-3). Read only: it
 * changes nothing, in Nexus or at Amazon. The backend of the `ads-brain` MCP tool and of the Owner's own page (§10: he
 * builds every screen himself; nothing here is UI).
 *
 *   map      per product × market (or one campaign): every lever of every campaign with its owner TODAY — the brain
 *            (live or watching in shadow), a named engine, a rule by name, the Owner (a lock, pinned bids), or nobody —
 *            from what is configured and from who actually wrote in the last N days; the brain's resolved settings with
 *            their source; excluded and shared campaigns; drift between BidBrainEnrollment and the product's level.
 *   clashes  every campaign × lever where two automatic writers can act (configured to act, or wrote in N days), and
 *            the known gaps: a term both targeted and negated in one place (harvest vs negate), a harvest rule with no
 *            stored destination (it never negates its source), sibling products bidding on the same keyword, and
 *            Amazon's own rules on brain campaigns (AB-4, brain/native-rules.ts): each one that acts is a clash; the
 *            kinds Nexus cannot read, and the campaigns whose read failed, are said as "could not read".
 *   setup    the tools that are not set up or are held off, with what starts them — the Control Room's own reading
 *            (getEngineLevers, the data ads-overview's engineGroups shows) — plus the brain's own setup.
 *
 * Who counts as an automatic writer: the bid brain when it owns the campaign, an engine at Auto, a rule at Auto, and
 * (AB-4) an Amazon rule read on the campaign — a budget rule, or a bidding strategy Amazon runs. A rule
 * or engine at Propose asks (a person approves), one at Observe watches; a person's change is the Owner's. The safety
 * owners (retail guard, budget enforcement, auto-undo, the write reconcile, resync — the write gate's own list) always
 * pass and are never a clash. Batched: a fixed number of queries per view, whatever the number of campaigns.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { classifyActor, engineLabel, NON_CHANGE_ACTION_TYPES, type EngineKey } from '../ads-engine-actors.js'
import { BRAIN_SAFETY_ACTOR_PREFIXES } from '../ads-write-gate.js'
import { BRAIN_LEVERS, LEVER_LEVELS_NOW, type BrainLever } from './levers.js'
import { productCampaigns, resolveCampaignOwnership, type CampaignOwnership } from './ownership.js'
import { brainView, bidBrainRowsByProduct } from './enrollment.js'
import { resolveBrainSettings, type BrainSettings, type OverrideRow } from './settings.js'
import {
  actingRules, campaignNativeView, DAILY_READ_AT, loadNativeRules, NATIVE_RULE_CAPABILITY, nativeReadStatus, nativeRuleWriters, notReadableKinds,
  type CampaignNativeRules,
} from './native-rules.js'

/**
 * AB-7 — `money` is brain/budget-read.ts: the product's money plan in shadow (the tool routes it). AB-9 — `terms` is
 * brain/terms-read.ts: the product's term ledger and the market arbiter's leads, in shadow (the tool routes it). AB-10 —
 * `negatives` is brain/negatives-read.ts: the product's day of negatives, every entity against the limit, its log.
 */
export const BRAIN_MAP_VIEWS = ['map', 'clashes', 'setup', 'money', 'terms', 'negatives'] as const
export type BrainMapView = (typeof BRAIN_MAP_VIEWS)[number]

/** The days of action-log evidence a view reads by default, and at most. */
export const DEFAULT_EVIDENCE_DAYS = 14
export const MAX_EVIDENCE_DAYS = 60

// ── Writers (pure) ───────────────────────────────────────────────────────────────────────────────────────────────

/** amazon (AB-4): one of Amazon's own rules on the campaign (brain/native-rules.ts). */
export type WriterKind = 'brain' | 'engine' | 'rule' | 'owner' | 'person' | 'safety' | 'unknown' | 'amazon'
/** acts: changes Amazon by itself · asks: a person approves each change · watches: decides, writes nothing · off · holds: the Owner's own value */
export type WriterState = 'acts' | 'asks' | 'watches' | 'off' | 'holds'

export interface Writer {
  who: string
  kind: WriterKind
  state: WriterState
  /** configured: set up to act on this campaign now · wrote: changed it in the evidence window */
  basis: 'configured' | 'wrote'
  why: string
  changes?: number
  last?: string
}

/** The lever an action-log row changed, or null when it is not a change of a lever (a note, a rule edit…). */
export function leverOfAction(actionType: string, entityType: string): BrainLever | null {
  switch (actionType) {
    case 'AD_BID_UPDATE': case 'bid_set_by_engine': case 'bid_down': case 'bid_up':
      return entityType === 'AD_GROUP' ? 'adGroupBids' : entityType === 'AD_TARGET' ? 'bids' : null
    case 'AD_BUDGET_UPDATE': case 'set_campaign_budget_bounds': return 'budgets'
    case 'update_placement_bidding': return 'placements'
    case 'AD_ENTITY_STATE_UPDATE': return 'state'
    case 'create_negative_keyword': case 'retire_negative': return 'negatives'
    case 'create_keyword': return 'harvest'
    case 'create_campaign': case 'create_ad_group': return 'structure'
    case 'AD_CAMPAIGN_PORTFOLIO_UPDATE': case 'AD_PORTFOLIO_UPDATE': case 'AD_PORTFOLIO_CREATE': return 'portfolioCap'
    default: return null
  }
}

/** The levers a rule action moves (automation-action-handlers.ts). An action with no ad lever moves none. */
export function leversOfRuleAction(type: string): BrainLever[] {
  if (['bid_apply', 'bid_down', 'bid_up', 'bid_to_target_acos', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'scale_bids_for_price_change', 'set_campaign_target_acos'].includes(type)) return ['bids']
  if (['adjust_ad_budget', 'budget_apply', 'mkt_adjust_budget', 'mkt_set_budget', 'pace_budget', 'set_daily_budget', 'reroute_marketplace_budget'].includes(type)) return ['budgets']
  if (['placement_apply', 'set_placement_multiplier', 'defend_top_of_search'].includes(type)) return ['placements']
  if (['dayparting_apply', 'refresh_dayparting', 'pause_schedules_matching'].includes(type)) return ['hours']
  if (['enable_campaign', 'enable_target', 'pause_ad_group', 'pause_all_campaigns', 'pause_campaign', 'pause_target', 'resume_campaign', 'mkt_pause_campaign', 'mkt_resume_campaign', 'archive_keyword'].includes(type)) return ['state']
  if (['add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'isolate_product_terms'].includes(type)) return ['negatives']
  if (type === 'harvest_and_negate') return ['harvest', 'negatives']
  if (type === 'promote_to_exact') return ['harvest']
  return []
}

export const isHarvestRuleAction = (type: string): boolean => type === 'harvest_and_negate' || type === 'promote_to_exact'

/** The account dial over every engine and rule (ads-automation-state.service.ts): halted or OFF stops, SUGGEST asks. */
export interface Dial { stopped: boolean; suggest: boolean }

export function engineState(mode: string, dial: Dial): WriterState {
  if (dial.stopped || mode === 'OFF') return 'off'
  if (mode === 'AUTO') return dial.suggest ? 'asks' : 'acts'
  return mode === 'PROPOSE' ? 'asks' : 'watches'
}

export function ruleState(rule: { enabled: boolean; autonomyLevel: string; dryRun: boolean }, dial: Dial): WriterState {
  if (!rule.enabled || rule.autonomyLevel === 'OFF' || dial.stopped) return 'off'
  if (rule.autonomyLevel === 'AUTO' && !rule.dryRun) return dial.suggest ? 'asks' : 'acts'
  return rule.autonomyLevel === 'PROPOSE' ? 'asks' : 'watches'
}

/** An automatic writer that counts for a clash: it changes Amazon by itself (configured to act, or it wrote). */
const automatic = (w: Writer) => (w.kind === 'brain' || w.kind === 'engine' || w.kind === 'rule' || w.kind === 'unknown' || w.kind === 'amazon') && (w.basis === 'wrote' || w.state === 'acts')

/** Two automatic writers or more on one lever of one campaign: the writers, else null. */
export function clashOf(writers: readonly Writer[]): string[] | null {
  const who = [...new Set(writers.filter(automatic).map((w) => w.who))].sort()
  return who.length >= 2 ? who : null
}

/**
 * Who owns one lever of one campaign today, in one line. `brainNote`: what the brain does there when it only watches
 * (the bid brain's shadow, or a lever whose shadow is not built yet), null when it does not.
 */
export function leverOwner(writers: readonly Writer[], ctx: { excluded: boolean; brainNote: string | null }): string {
  const lock = writers.find((w) => w.kind === 'owner' && w.state === 'holds')
  if (lock) return `the Owner (${lock.why})`
  const acting = [...new Set(writers.filter((w) => w.basis === 'configured' && w.state === 'acts').map((w) => w.who))]
  const brain = writers.find((w) => w.kind === 'brain' && w.basis === 'configured' && w.state === 'acts')
  if (brain && acting.length === 1) return brain.who
  if (acting.length >= 2) return `two or more writers: ${acting.sort().join(', ')}`
  if (acting.length === 1) return acting[0]
  const asking = [...new Set(writers.filter((w) => w.basis === 'configured' && w.state === 'asks').map((w) => w.who))]
  if (asking.length) return `nobody acts alone — ${asking.sort().join(', ')} ${asking.length === 1 ? 'asks' : 'ask'} a person`
  return ctx.excluded ? 'nobody (excluded from the brain by the Owner)' : ctx.brainNote ? `nobody acts (${ctx.brainNote})` : 'nobody'
}

/** What the brain does on a lever where it only watches, in the owner line's words. */
export function brainNoteOf(writers: readonly Writer[]): string | null {
  const w = writers.find((x) => x.kind === 'brain' && x.state === 'watches')
  if (!w) return null
  return w.why.startsWith('OBSERVE:') ? `the brain is set to watch; ${w.why.slice('OBSERVE:'.length).trim()}` : 'the brain watches in shadow'
}

/** An engine's reason, short: its first sentence (the full one is in the setup view). */
const firstSentence = (s: string) => { const i = s.indexOf('. '); return (i > 0 ? s.slice(0, i + 1) : s).slice(0, 200) }

/** The server variables a reason names (NEXUS_…): what a server-held engine's fix is. */
export function serverVariables(why: string): string[] {
  return [...new Set(why.match(/\bNEXUS_[A-Z0-9_]+/g) ?? [])]
}

// ── Terms (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const contains = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `)

export interface KeywordRow { id: string; campaignId: string; adGroupId: string; text: string; match: string; negative: boolean; level: string | null }

/**
 * Terms that block themselves: a positive keyword and a negative in the same place — the negative exact (or a phrase
 * inside it) at its ad group, or at its campaign. The design's harvest-vs-negate conflict, read from what stands now.
 */
export function selfBlocking(rows: readonly KeywordRow[]): Array<{ campaignId: string; adGroupId: string; text: string; positiveId: string; negativeId: string; negative: string }> {
  const negatives = rows.filter((r) => r.negative && (r.match === 'NEGATIVE_EXACT' || r.match === 'NEGATIVE_PHRASE'))
  const out: Array<{ campaignId: string; adGroupId: string; text: string; positiveId: string; negativeId: string; negative: string }> = []
  for (const p of rows.filter((r) => !r.negative)) {
    const text = norm(p.text)
    const hit = negatives.find((n) => {
      const here = n.level === 'CAMPAIGN' ? n.campaignId === p.campaignId : n.adGroupId === p.adGroupId
      if (!here) return false
      const neg = norm(n.text)
      return n.match === 'NEGATIVE_EXACT' ? neg === text && p.match === 'EXACT' : contains(text, neg)
    })
    if (hit) out.push({ campaignId: p.campaignId, adGroupId: p.adGroupId, text, positiveId: p.id, negativeId: hit.id, negative: `${hit.match === 'NEGATIVE_EXACT' ? 'negative exact' : 'negative phrase'} "${norm(hit.text)}" at its ${hit.level === 'CAMPAIGN' ? 'campaign' : 'ad group'}` })
  }
  return out
}

/** Keywords that two product families or more bid on in one market (sibling ownership; the arbiter's job, AB-9). */
export function siblingTerms(rows: readonly KeywordRow[], ownerOf: ReadonlyMap<string, string | null>, limit = 50): Array<{ text: string; products: string[]; campaignIds: string[] }> {
  const byText = new Map<string, { products: Set<string>; campaigns: Set<string> }>()
  for (const r of rows) {
    if (r.negative) continue
    const product = ownerOf.get(r.campaignId)
    if (!product) continue
    const k = norm(r.text)
    const e = byText.get(k) ?? { products: new Set(), campaigns: new Set() }
    e.products.add(product)
    e.campaigns.add(r.campaignId)
    byText.set(k, e)
  }
  return [...byText].filter(([, e]) => e.products.size >= 2)
    .map(([text, e]) => ({ text, products: [...e.products].sort(), campaignIds: [...e.campaigns].sort() }))
    .sort((a, b) => b.products.length - a.products.length || b.campaignIds.length - a.campaignIds.length || a.text.localeCompare(b.text))
    .slice(0, limit)
}

// ── Facts (batched reads) ────────────────────────────────────────────────────────────────────────────────────────

interface CampaignRow { id: string; name: string; marketplace: string | null; status: string; adProduct: string | null; liveBidWritesEnabled: boolean; pinBids: boolean; pinnedBy: string | null; portfolioId: string | null }
const CAMPAIGN_SELECT = { id: true, name: true, marketplace: true, status: true, adProduct: true, liveBidWritesEnabled: true, pinBids: true, pinnedBy: true, portfolioId: true } as const

interface EngineFact { key: string; name: string; mode: string; group: string; why: string; start: string | null }

interface RuleRow { id: string; name: string; enabled: boolean; autonomyLevel: string; dryRun: boolean; actions: unknown; scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null }

const actionTypesOf = (actions: unknown): string[] => (Array.isArray(actions) ? actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)

/** The engines' state as the Control Room reads it (getEngineLevers), keyed by engine; null when it could not be read. */
async function engineFacts(): Promise<{ engines: Map<string, EngineFact>; levers: Array<EngineFact & { warning: string | null }> } | null> {
  try {
    const { getEngineLevers } = await import('../ads-control-room.service.js')
    const read = await getEngineLevers()
    const levers = read.levers.map((l) => ({ key: l.key, name: l.name, mode: l.mode, group: l.exposure.group, why: l.modeReason, start: l.exposure.start, warning: l.warning }))
    return { engines: new Map(levers.map((l) => [l.key, l])), levers }
  } catch {
    return null
  }
}

async function dialOf(): Promise<Dial> {
  const { getAutomationState } = await import('../ads-automation-state.service.js')
  const s = await getAutomationState()
  return { stopped: s.effectivelyStopped, suggest: s.autonomy === 'SUGGEST' }
}

/** Everything configured that can write to these campaigns, in a fixed number of reads. */
async function loadConfig(campaigns: readonly CampaignRow[], owners: ReadonlyMap<string, CampaignOwnership>) {
  const ids = campaigns.map((c) => c.id)
  const month = new Date().toISOString().slice(0, 7)
  const { brainOwnedCampaignIds, brainLiveCeiling } = await import('../bid-brain/live.js')
  const { rankOwnedCampaignIds } = await import('../rank-release.service.js')
  const { isGoalMode } = await import('../../../jobs/ad-rank-defend.job.js')
  const { RUNNING_AUTOPILOT_PLANS } = await import('../../../jobs/ad-autopilot.job.js')
  const { bidBrainMode } = await import('../bid-brain/shadow.js')
  const [brainRows, brainOwned, rankHeld, schedules, autopilots, rules, budgetSchedules, poolAllocations, budgetPlans, goals, playbookSlots, coverageSets, bidHolds, overrides, enrollments, engines, dial] = await Promise.all([
    prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: ids } }, select: { campaignId: true, mode: true, heldUntil: true } }),
    brainOwnedCampaignIds(ids),
    rankOwnedCampaignIds(),
    prisma.adSchedule.findMany({ where: { campaignId: { in: ids }, enabled: true }, select: { campaignId: true, name: true, windows: true, defaultTargetKey: true } }),
    prisma.autopilotPlan.findMany({ where: RUNNING_AUTOPILOT_PLANS, select: { name: true, campaignIds: true } }),
    prisma.automationRule.findMany({ select: { id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, actions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true } }) as Promise<RuleRow[]>,
    prisma.budgetSchedule.findMany({ where: { enabled: true, kind: 'BUDGET' }, select: { name: true, campaigns: true } }),
    prisma.budgetPoolAllocation.findMany({ where: { campaignId: { in: ids }, budgetPool: { enabled: true } }, select: { campaignId: true, budgetPool: { select: { name: true } } } }),
    prisma.adBudgetPlan.findMany({ where: { month }, select: { marketplace: true, tag: true, autoPacing: true, stopOverSpend: true } }),
    prisma.adProductGoal.findMany({ where: { status: 'ACTIVE' }, select: { name: true, campaignIds: true } }),
    prisma.adsPlaybookLink.findMany({ where: { kind: 'slot', refId: { in: ids } }, select: { refId: true, key: true } }),
    prisma.keywordCoverageSet.findMany({ where: { enabled: true }, select: { name: true, portfolioId: true } }),
    prisma.bidHold.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids }, endedAt: null, targetId: { not: null } }, _count: { _all: true } }),
    prisma.adsBrainOverride.findMany({
      where: { endedAt: null, OR: [{ scope: 'CAMPAIGN', campaignId: { in: ids } }, { scope: 'PRODUCT', productId: { in: [...new Set([...owners.values()].flatMap((o) => o.productIds))] } }] },
      select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true },
    }) as Promise<OverrideRow[]>,
    prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } }),
    engineFacts(),
    dialOf(),
  ])
  // Rules scoped to a product name its family root (a variation's parent), read in one query.
  const ruleProducts = [...new Set(rules.map((r) => r.scopeProductId).filter((v): v is string => !!v))]
  const rootOfRuleProduct = new Map((ruleProducts.length ? await prisma.product.findMany({ where: { id: { in: ruleProducts } }, select: { id: true, parentId: true } }) : []).map((p) => [p.id, p.parentId ?? p.id]))
  return {
    brainMode: new Map(brainRows.map((r) => [r.campaignId, r.mode])),
    brainOwned, ceilingLive: brainLiveCeiling(), ceiling: bidBrainMode(), rankHeld,
    schedules: new Map<string, Array<{ name: string; goal: boolean }>>(ids.map((id) => [id, schedules.filter((s) => s.campaignId === id).map((s) => ({ name: s.name, goal: isGoalMode(s.windows, s.defaultTargetKey) }))])),
    autopilotOf: (id: string) => autopilots.find((p) => Array.isArray(p.campaignIds) && (p.campaignIds as unknown[]).map(String).includes(id))?.name ?? null,
    rules, rootOfRuleProduct,
    budgetScheduleOf: (id: string) => budgetSchedules.filter((s) => (Array.isArray(s.campaigns) ? (s.campaigns as Array<{ id?: unknown }>) : []).some((c) => String(c?.id) === id)).map((s) => s.name),
    poolOf: new Map(poolAllocations.filter((a) => a.campaignId).map((a) => [a.campaignId!, a.budgetPool.name])),
    budgetPlanFor: (market: string | null) => budgetPlans.find((p) => !p.tag && strategyMarket(p.marketplace) === market && (p.autoPacing || p.stopOverSpend)) ?? null,
    goalOf: (id: string) => goals.find((g) => Array.isArray(g.campaignIds) && (g.campaignIds as unknown[]).some((c) => String(typeof c === 'object' && c ? (c as { id?: unknown }).id : c) === id))?.name ?? null,
    slotOf: new Map(playbookSlots.map((s) => [s.refId, s.key])),
    coverageOf: (portfolioId: string | null) => (portfolioId ? coverageSets.find((s) => s.portfolioId === portfolioId)?.name ?? null : null),
    heldKeywords: new Map(bidHolds.map((h) => [h.campaignId, h._count._all])),
    overrides,
    enrolled: new Set(enrollments.map((e) => `${e.productId}\u0000${e.marketplace}`)),
    engines: engines?.engines ?? null,
    dial,
  }
}

type Config = Awaited<ReturnType<typeof loadConfig>>

/** Who wrote each lever of these campaigns in the last `days` (the action log, one statement; rolled back and failed rows left out). */
async function loadEvidence(campaignIds: readonly string[], days: number, ruleNames: ReadonlyMap<string, string>) {
  const out = new Map<string, Map<BrainLever, Writer[]>>()
  if (!campaignIds.length) return out
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; userId: string | null; actionType: string; entityType: string; n: number; last: Date }>>(Prisma.sql`
    SELECT x."campaignId", x."userId", x."actionType", x."entityType", count(*)::int AS n, max(x."createdAt") AS last
      FROM (SELECT CASE WHEN l."entityType" = 'CAMPAIGN' THEN l."entityId" ELSE g."campaignId" END AS "campaignId",
                   l."userId", l."actionType", l."entityType", l."createdAt"
              FROM "AdvertisingActionLog" l
              LEFT JOIN "AdTarget" t ON l."entityType" = 'AD_TARGET' AND t.id = l."entityId"
              LEFT JOIN "AdGroup" g ON g.id = CASE WHEN l."entityType" = 'AD_GROUP' THEN l."entityId" ELSE t."adGroupId" END
             WHERE l."createdAt" >= ${since}
               AND l."rolledBackAt" IS NULL
               AND COALESCE(l."amazonResponseStatus", '') <> 'FAILED'
               AND l."actionType" <> ALL(${[...NON_CHANGE_ACTION_TYPES]}::text[])) x
     WHERE x."campaignId" = ANY(${[...campaignIds]}::text[])
     GROUP BY 1, 2, 3, 4`)
  for (const r of rows) {
    const lever = leverOfAction(r.actionType, r.entityType)
    if (!lever) continue
    const w = writerOfActor(r.userId, ruleNames)
    const levers = out.get(r.campaignId) ?? new Map<BrainLever, Writer[]>()
    const list = levers.get(lever) ?? []
    const same = list.find((x) => x.who === w.who)
    if (same) { same.changes = (same.changes ?? 0) + r.n; if (r.last.toISOString() > (same.last ?? '')) same.last = r.last.toISOString() }
    else list.push({ ...w, basis: 'wrote', changes: r.n, last: r.last.toISOString() })
    levers.set(lever, list)
    out.set(r.campaignId, levers)
  }
  return out
}

/** A safety owner's actor (the write gate's own list): it always passes and is never a clash. */
const isSafetyActor = (actor: string) => BRAIN_SAFETY_ACTOR_PREFIXES.some((p) => actor === p || actor.startsWith(`${p}-`))

/** Who an action-log actor is, in the map's words. */
export function writerOfActor(userId: string | null, ruleNames: ReadonlyMap<string, string>): Omit<Writer, 'basis'> {
  if (userId && isSafetyActor(userId)) return { who: `safety: ${userId.replace(/^automation:/, '')}`, kind: 'safety', state: 'acts', why: 'a safety owner (always passes)' }
  const c = classifyActor(userId)
  if (c.kind === 'engine') return c.engine === 'bid-brain'
    ? { who: 'the brain', kind: 'brain', state: 'acts', why: 'the bid brain wrote' }
    : { who: engineLabel(c.engine), kind: 'engine', state: 'acts', why: `${engineLabel(c.engine)} wrote` }
  if (c.kind === 'rule-candidate') {
    const name = ruleNames.get(c.ruleId)
    return name ? { who: `rule "${name}"`, kind: 'rule', state: 'acts', why: 'the rule wrote' } : { who: `unknown automation (${userId})`, kind: 'unknown', state: 'acts', why: 'no engine or rule claims this actor' }
  }
  if (c.kind === 'person') return { who: 'a person', kind: 'person', state: 'acts', why: 'a person\'s change (or a Claude request a person approved)' }
  return { who: 'no known author', kind: 'unknown', state: 'acts', why: 'the change carries no actor' }
}

/** The writers configured on one campaign, per lever (the brain, the engines, the rules, the Owner). Pure over the config. */
export function configuredWriters(c: CampaignRow & { market: string | null; productIds: string[]; brainCanOwn: boolean }, cfg: Pick<Config, 'brainMode' | 'brainOwned' | 'ceilingLive' | 'ceiling' | 'rankHeld' | 'schedules' | 'autopilotOf' | 'rules' | 'rootOfRuleProduct' | 'budgetScheduleOf' | 'poolOf' | 'budgetPlanFor' | 'goalOf' | 'slotOf' | 'coverageOf' | 'heldKeywords' | 'engines' | 'dial'>, settings: Pick<BrainSettings, 'excluded' | 'levers'> | null): Record<BrainLever, Writer[]> {
  const out = Object.fromEntries(BRAIN_LEVERS.map((l) => [l, [] as Writer[]])) as Record<BrainLever, Writer[]>
  const add = (lever: BrainLever, w: Omit<Writer, 'basis'>) => out[lever].push({ ...w, basis: 'configured' })
  // An engine named as its evidence names it (engineLabel), so what is set up and what wrote meet on one name.
  const engine = (key: EngineKey, why: string, levers: BrainLever[]) => {
    const fact = cfg.engines?.get(key)
    const state = fact ? engineState(fact.mode, cfg.dial) : 'acts'
    for (const l of levers) add(l, { who: engineLabel(key), kind: 'engine', state, why: fact ? `${why}; the engine is ${fact.mode} (${firstSentence(fact.why)})` : `${why}; could not measure the engine's mode` })
  }
  const sp = c.adProduct === 'SPONSORED_PRODUCTS'
  const brainMode = cfg.brainMode.get(c.id) ?? null
  const brainOwns = cfg.brainOwned.has(c.id)
  // The brain: bids (and the hourly plan's placements and Min-bid hours) when it owns the campaign; else it watches.
  if (brainOwns) {
    const held = brainMode === 'HELD'
    add('bids', { who: 'the brain', kind: 'brain', state: 'acts', why: held ? 'the bid brain owns it, HELD: it raises nothing' : 'the bid brain owns it (LIVE)' })
    if (cfg.rankHeld.has(c.id)) for (const l of ['hours', 'placements'] as const) add(l, { who: 'the brain', kind: 'brain', state: 'acts', why: 'the bid brain runs its hourly plan (BB-7)' })
  } else if (sp && c.liveBidWritesEnabled && cfg.ceiling !== 'off') {
    add('bids', { who: 'the brain', kind: 'brain', state: 'watches', why: brainMode === 'LIVE' || brainMode === 'HELD' ? `enrolled ${brainMode}, but NEXUS_BID_BRAIN_MODE is ${cfg.ceiling}: the brain decides in shadow` : 'the bid brain decides it in shadow (allowlisted), writes nothing' })
  }
  // Other levers: the brain's resolved level (no writer for them yet: OBSERVE records the intent). Never on a shared campaign.
  if (settings && c.brainCanOwn) {
    for (const lever of BRAIN_LEVERS) {
      if (lever === 'bids') continue
      const l = settings.levers[lever]
      if (l.effective === 'OBSERVE') add(lever, { who: 'the brain', kind: 'brain', state: 'watches', why: `OBSERVE: ${LEVER_LEVELS_NOW[lever].others}` })
    }
  }
  // The Owner: a lock (the brain's override), pinned bids, holds on keywords.
  if (settings) {
    for (const lever of BRAIN_LEVERS) {
      const lock = settings.levers[lever].lock
      if (lock) add(lever, { who: 'the Owner', kind: 'owner', state: 'holds', why: `locked at his own value by the ${lock.source} override${lock.by ? ` (${lock.by})` : ''}` })
    }
  }
  if (c.pinBids) add('bids', { who: 'the Owner', kind: 'owner', state: 'holds', why: `bids pinned by hand${c.pinnedBy ? ` by ${c.pinnedBy}` : ''}` })
  const held = cfg.heldKeywords.get(c.id)
  if (held) add('bids', { who: 'the Owner', kind: 'owner', state: 'watches', why: `${held} keyword${held === 1 ? '' : 's'} held (a person's bid, a pin or an undo): every writer leaves ${held === 1 ? 'it' : 'them'}` })
  // Engines, each by the read its own screen or job uses.
  if (!brainOwns) {
    const schedules = cfg.schedules.get(c.id) ?? []
    if (cfg.rankHeld.has(c.id)) engine('rank-defend', 'an hourly bid plan holds it', ['bids', 'adGroupBids', 'hours', 'placements'])
    for (const s of schedules.filter((x) => !x.goal)) engine('dayparting', `the classic dayparting schedule "${s.name}"`, ['bids', 'hours'])
    const autopilot = cfg.autopilotOf(c.id)
    if (autopilot) engine('autopilot', `the autopilot plan "${autopilot}"`, ['bids', 'placements'])
    const coverage = cfg.coverageOf(c.portfolioId)
    if (coverage && c.status === 'ENABLED') engine('coverage-engine', `the coverage set "${coverage}" (its portfolio)`, ['bids'])
    // auto-bid leaves a campaign another writer holds (autoBidHolders): pinned, any enabled schedule, a plan, the brain.
    if (sp && c.liveBidWritesEnabled && !c.pinBids && !cfg.rankHeld.has(c.id) && !schedules.length && !autopilot) engine('auto-bid', 'auto-bid moves the keywords of an allowlisted campaign nobody else holds', ['bids'])
    if (sp && c.liveBidWritesEnabled) engine('tos-defense', 'top-of-search defense acts on allowlisted campaigns with top-of-search data', ['placements'])
  }
  for (const name of cfg.budgetScheduleOf(c.id)) engine('budget-schedules', `the budget schedule "${name}"`, ['budgets'])
  const pool = cfg.poolOf.get(c.id)
  if (pool) engine('budget-pools', `the budget pool "${pool}"`, ['budgets'])
  const goal = cfg.goalOf(c.id)
  if (goal) add('structure', { who: `AI goal "${goal}"`, kind: 'engine', state: 'asks', why: 'an AI goal built it and keeps it' })
  const slot = cfg.slotOf.get(c.id)
  if (slot) add('structure', { who: 'the playbook', kind: 'engine', state: 'asks', why: `the playbook slot "${slot}" (builds and syncs ask a person)` })
  const plan = cfg.budgetPlanFor(c.market)
  if (plan) add('budgets', { who: 'Budget enforcement', kind: 'safety', state: 'acts', why: `this month's ${c.market} budget plan (${[plan.autoPacing ? 'pacing' : '', plan.stopOverSpend ? 'stops over-spend' : ''].filter(Boolean).join(', ')}): a safety owner` })
  // Rules that reach the campaign, by their scope.
  for (const r of cfg.rules) {
    if (!r.enabled) continue
    if (r.scopeCampaignId && r.scopeCampaignId !== c.id) continue
    if (r.scopeMarketplace && strategyMarket(r.scopeMarketplace) !== c.market) continue
    if (r.scopePortfolioId && r.scopePortfolioId !== c.portfolioId) continue
    if (r.scopeProductId && !c.productIds.includes(cfg.rootOfRuleProduct.get(r.scopeProductId) ?? r.scopeProductId)) continue
    const levers = [...new Set(actionTypesOf(r.actions).flatMap(leversOfRuleAction))]
    for (const l of levers) add(l, { who: `rule "${r.name}"`, kind: 'rule', state: ruleState(r, cfg.dial), why: `${r.autonomyLevel}${r.dryRun ? ', dry run' : ''}; ${r.scopeCampaignId ? 'this campaign' : r.scopeProductId ? 'its product' : r.scopePortfolioId ? 'its portfolio' : r.scopeMarketplace ? `every ${c.market} campaign` : 'every campaign'}` })
  }
  return out
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MapArgs { productId?: string; campaignId?: string; market?: string; days?: number }

/** MCP.12 — the words every tool uses for a product that is deleted (Product.deletedAt) or not in this business. */
export const PRODUCT_NOT_FOUND = 'Product not found'

/** Null when the product exists here and is not deleted; else the refusal. */
async function productRefusal(productId: string): Promise<string | null> {
  return (await prisma.product.count({ where: { id: productId, deletedAt: null } })) > 0 ? null : PRODUCT_NOT_FOUND
}

const daysOf = (d?: number) => Math.max(1, Math.min(MAX_EVIDENCE_DAYS, Math.round(d ?? DEFAULT_EVIDENCE_DAYS)))
const campaignsById = async (ids: readonly string[]) => (ids.length ? (await prisma.campaign.findMany({ where: { id: { in: [...ids] } }, select: CAMPAIGN_SELECT })).map((c) => ({ ...c, status: String(c.status) })) as CampaignRow[] : [])

/** Per campaign: who owns each lever today, with every writer (configured and in the evidence window). */
async function campaignLevers(campaigns: readonly CampaignRow[], owners: ReadonlyMap<string, CampaignOwnership>, days: number) {
  const [cfg, native] = await Promise.all([loadConfig(campaigns, owners), loadNativeRules(campaigns.map((c) => c.id))])
  const ruleNames = new Map(cfg.rules.map((r) => [r.id, r.name]))
  const evidence = await loadEvidence(campaigns.map((c) => c.id), days, ruleNames)
  return {
    cfg,
    native,
    rows: campaigns.map((c) => {
      const o = owners.get(c.id)
      const market = strategyMarket(c.marketplace)
      // The product whose brain speaks for this campaign: its own product; a shared one is read under its first product.
      const productId = o?.owner.kind === 'product' ? o.owner.productId : o?.productIds[0] ?? null
      const enrolled = !!productId && !!market && cfg.enrolled.has(`${productId}\u0000${market}`)
      const settings = productId && market ? resolveBrainSettings({ productId, market, campaignId: c.id, enrolled, overrides: cfg.overrides }) : null
      const configured = configuredWriters({ ...c, market, productIds: o?.productIds ?? [], brainCanOwn: o?.owner.kind === 'product' }, cfg, settings)
      // AB-4 — Amazon's own rules that act on the campaign write its levers too (a second brain inside Amazon).
      const amazon = nativeRuleWriters(native.get(c.id))
      const levers = Object.fromEntries(BRAIN_LEVERS.map((lever) => {
        const writers = [
          ...configured[lever],
          ...amazon.filter((a) => a.lever === lever).map((a): Writer => ({ who: a.who, kind: 'amazon', state: 'acts', basis: 'configured', why: a.why })),
          ...(evidence.get(c.id)?.get(lever) ?? []),
        ]
        return [lever, {
          // Nexus does not model the off-Amazon lane (its setting and its report): nobody can say who runs it.
          owner: lever === 'offAmazon' ? 'could not measure: Nexus does not model the off-Amazon lane yet (AB-18)' : leverOwner(writers, { excluded: !!settings?.excluded.value, brainNote: brainNoteOf(writers) }),
          // A shared campaign is no product's brain's (D2: split it); its exclusions and locks still hold (in the writers).
          ...(o?.owner.kind === 'shared' ? { brain: 'SHARED', brainWhy: 'a shared campaign: no product\'s brain owns its levers (the brain proposes a split, D2)' }
            : settings ? { brain: settings.levers[lever].effective, brainWhy: settings.levers[lever].why } : {}),
          clash: clashOf(writers),
          writers,
        }]
      })) as Record<BrainLever, { owner: string; brain?: string; brainWhy?: string; clash: string[] | null; writers: Writer[] }>
      return {
        campaignId: c.id, name: c.name, market, status: c.status, adProduct: c.adProduct,
        ownedBy: !o ? 'could not measure' : o.owner.kind === 'product' ? 'one product' : o.owner.kind === 'shared' ? 'shared' : 'no product',
        productIds: o?.productIds ?? [], ...(o?.unresolved.length ? { unresolvedAds: o.unresolved } : {}),
        bidBrain: cfg.brainMode.get(c.id) ?? 'none',
        // AB-4 — a brain campaign: the bid brain runs it LIVE or HELD, or its product is enrolled.
        brainCampaign: ['LIVE', 'HELD'].includes(cfg.brainMode.get(c.id) ?? '') || (!!market && (o?.productIds ?? []).some((p) => cfg.enrolled.has(`${p}\u0000${market}`))),
        excluded: settings?.excluded.value ? { by: settings.excluded.by, at: settings.excluded.at, source: settings.excluded.source, reason: settings.excluded.reason } : null,
        levers,
        amazonRules: campaignNativeView(native.get(c.id)),
      }
    }),
  }
}

/**
 * View map. With productId + market: the product's brain (resolved settings with their source, drift, campaigns it
 * does not reach) and every lever of each of its campaigns, owned and shared. With campaignId: that campaign alone.
 * With market only: the products the brain knows there (enrolled, or LIVE per campaign) — pick one.
 */
export async function brainMap(args: MapArgs): Promise<{ data: unknown } | { error: string }> {
  const days = daysOf(args.days)
  if (args.campaignId) {
    const [c] = await campaignsById([args.campaignId])
    if (!c) return { error: `campaign ${args.campaignId} not found` }
    const owners = await resolveCampaignOwnership([c.id])
    const { rows } = await campaignLevers([c], owners, days)
    return { data: { view: 'map', scope: { campaignId: c.id }, evidenceDays: days, campaigns: rows, amazonRulesNotRead: notReadableKinds(), ceiling: (await import('../bid-brain/shadow.js')).bidBrainMode() } }
  }
  // MCP.12 — a product named by id is checked first: a deleted or unknown one is not found, before anything else is asked.
  if (args.productId) {
    const refusal = await productRefusal(args.productId)
    if (refusal) return { error: refusal }
  }
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && !market) return { error: `${args.market} is not a market code` }
  if (!args.productId) {
    // The products the brain knows (enrolled, or LIVE one campaign at a time): in one market, or in every market. A
    // deleted product never shows: the resolver ties no ad to it, and an enrollment of one is left out.
    const [rows, enrollments] = await Promise.all([
      bidBrainRowsByProduct(market ?? undefined),
      prisma.adsBrainEnrollment.findMany({ where: market ? { marketplace: market } : {}, select: { productId: true, marketplace: true } }),
    ])
    const keys = new Map<string, { productId: string; market: string }>()
    for (const p of rows.products) keys.set(`${p.productId}\u0000${p.market}`, { productId: p.productId, market: p.market })
    for (const e of enrollments) keys.set(`${e.productId}\u0000${e.marketplace}`, { productId: e.productId, market: e.marketplace })
    const ids = [...new Set([...keys.values()].map((k) => k.productId))]
    const live = new Map((ids.length ? await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true, sku: true } }) : []).map((p) => [p.id, p]))
    return {
      data: {
        view: 'map', scope: market ? { market } : { market: 'every market' },
        products: [...keys.values()].filter((k) => live.has(k.productId)).sort((a, b) => a.market.localeCompare(b.market) || a.productId.localeCompare(b.productId)).map((k) => ({
          productId: k.productId, market: k.market, name: live.get(k.productId)!.name, sku: live.get(k.productId)!.sku,
          enrolled: enrollments.some((e) => e.productId === k.productId && e.marketplace === k.market),
          liveCampaigns: rows.products.find((p) => p.productId === k.productId && p.market === k.market)?.campaignIds ?? [],
        })),
        sharedLive: rows.shared, unownedLive: rows.none,
        next: 'Read one product with productId and its market: every lever of its campaigns, who owns each, and the brain\'s settings.',
      },
    }
  }
  if (!market) return { error: 'name the market for this product (market), or read one campaign (campaignId)' }
  const view = await brainView(args.productId, market)
  if (!view) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
  const ids = view.campaigns.map((c) => c.campaignId)
  const [campaigns, owners] = await Promise.all([campaignsById(ids), resolveCampaignOwnership(ids)])
  const { rows } = await campaignLevers(campaigns, owners, days)
  const settings = view.settings
  return {
    data: {
      view: 'map', scope: { productId: view.productId, market }, evidenceDays: days,
      product: {
        productId: view.productId, market, enrolled: view.enrolled, version: view.version, enrolledBy: view.enrolledBy,
        excluded: settings.excluded.value ? { source: settings.excluded.source, by: settings.excluded.by, at: settings.excluded.at, reason: settings.excluded.reason } : null,
        levers: Object.fromEntries(BRAIN_LEVERS.map((l) => [l, { level: settings.levers[l].level.value, effective: settings.levers[l].effective, source: settings.levers[l].level.source, by: settings.levers[l].level.by, at: settings.levers[l].level.at, why: settings.levers[l].why }])),
        settings: Object.fromEntries(Object.entries(settings.values).map(([k, v]) => [k, { [k]: v.value, source: v.source, by: v.by, at: v.at }])),
        ...(settings.ignored.length ? { ignoredOverrides: settings.ignored } : {}),
      },
      bidsAsCampaigns: view.bidsAsCampaigns,
      notReached: view.notReached,
      drift: view.drift,
      campaigns: rows,
      amazonRulesNotRead: notReadableKinds(),
    },
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * AB-4 — Amazon's own rules in the clashes view. Each one that acts on a brain campaign is a clash (two brains on its
 * levers, whoever else writes them); one on a campaign no brain runs is listed apart (no brain there, so no clash). What
 * could not be read is said: the kinds Nexus cannot read anywhere, and each brain campaign whose read failed or is missing.
 */
export function amazonRulesGap(rows: ReadonlyArray<{ campaignId: string; name: string; brainCampaign: boolean }>, native: ReadonlyMap<string, CampaignNativeRules>) {
  const clashes: Array<Record<string, unknown>> = []
  const elsewhere: Array<Record<string, unknown>> = []
  const failed: Array<Record<string, unknown>> = []
  for (const r of rows) {
    const c = native.get(r.campaignId)
    for (const rule of actingRules(c)) {
      const entry = { campaignId: r.campaignId, name: r.name, kind: rule.kind, rule: rule.name, levers: rule.levers, detail: rule.detail, seenAt: rule.seenAt, ...(rule.stale ? { lastSeenOnly: true } : {}) }
      if (!r.brainCampaign) { elsewhere.push(entry); continue }
      const what = rule.levers.join(' and ')
      clashes.push({
        ...entry,
        meaning: `${NATIVE_RULE_CAPABILITY[rule.kind].label} "${rule.name}" acts on this brain campaign's ${what}: a second brain inside Amazon. While it is attached, the product's brain refuses to take ${rule.levers.length === 1 ? 'that lever' : 'those levers'} to AUTO; detach it in Amazon's Campaign Manager (Nexus never edits Amazon's rules)`,
      })
    }
    if (r.brainCampaign) for (const k of campaignNativeView(c).couldNotRead) failed.push({ campaignId: r.campaignId, name: r.name, kind: k.kind, why: k.why, ...(k.at ? { at: k.at } : {}) })
  }
  return {
    clashes,
    ...(elsewhere.length ? { notBrainCampaigns: elsewhere } : {}),
    couldNotRead: [...notReadableKinds().map((k) => ({ kind: k.kind, levers: k.levers, why: k.why })), ...failed],
    read: { budgetRules: NATIVE_RULE_CAPABILITY.budgetRules.how, ruleBasedBidding: NATIVE_RULE_CAPABILITY.ruleBasedBidding.how },
  }
}

/** AB-4 — the setup view's line on Amazon's own rules: what the daily read holds, and what Nexus cannot read. */
async function amazonRulesSetup(market: string | null): Promise<{ item: string; state: string; fix: string }> {
  const s = await nativeReadStatus(market)
  const notRead = notReadableKinds().map((k) => `${k.label.replace(/^Amazon /, '')}s`).join(' and ')
  const budget = s.campaigns
    ? `budget rules: the daily read covers ${plural(s.campaigns, 'brain campaign')}, last at ${s.lastAt}${s.couldNotRead ? `; ${s.couldNotRead} could not be read (the clashes view says why)` : ''}; ${s.acting ? `${plural(s.acting, 'rule acts', 'rules act')} on a brain campaign (the clashes view lists them)` : 'none acts on a brain campaign'}`
    : `budget rules not read yet: the daily read (${DAILY_READ_AT}) asks Amazon for them on every brain campaign while the bid brain is live or a product is enrolled`
  return {
    item: 'Amazon\'s own rules',
    state: `${budget}; the bidding strategy comes from the settings sync (a strategy Amazon runs counts as a rule); could not read: ${notRead} — Amazon's API has no read of them that Nexus could verify`,
    fix: s.acting
      ? 'detach each rule on a brain campaign in Amazon\'s Campaign Manager (Nexus never edits Amazon\'s rules): until then an enrolled product\'s brain refuses to take the levers it moves to AUTO; check optimization and schedule bid rules there by hand'
      : 'check optimization and schedule bid rules in Amazon\'s Campaign Manager by hand: Nexus cannot read them',
  }
}

/** View clashes: every campaign × lever with two automatic writers, and the known gaps, in one market (or one product's campaigns). */
export async function brainClashes(args: { market?: string; productId?: string; days?: number }): Promise<{ data: unknown } | { error: string }> {
  const days = daysOf(args.days)
  const market = args.market ? strategyMarket(args.market) : null
  if (args.productId) {
    const refusal = await productRefusal(args.productId)
    if (refusal) return { error: refusal }
  }
  if (!market) return { error: 'name a market (and optionally a productId)' }
  let ids: string[]
  if (args.productId) {
    const found = await productCampaigns(args.productId, market)
    if (!found) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
    ids = [...found.owned, ...found.shared].map((c) => c.campaignId)
  } else {
    ids = (await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } }, select: { id: true, marketplace: true } }))
      .filter((c) => strategyMarket(c.marketplace) === market).map((c) => c.id)
  }
  const [campaigns, owners] = await Promise.all([campaignsById(ids), resolveCampaignOwnership(ids)])
  const { rows, cfg, native } = await campaignLevers(campaigns, owners, days)
  const clashes = rows.flatMap((r) => BRAIN_LEVERS.flatMap((lever) => {
    const l = r.levers[lever]
    return l.clash ? [{ campaignId: r.campaignId, name: r.name, lever, writers: l.writers.filter(automatic).map((w) => ({ who: w.who, basis: w.basis, state: w.state, why: w.why, ...(w.changes ? { changes: w.changes, last: w.last } : {}) })) }] : []
  }))
  // The known gaps, from what stands now.
  const keywords = ids.length ? await prisma.$queryRaw<Array<{ id: string; campaignId: string; adGroupId: string; text: string; match: string; negative: boolean; level: string | null }>>(Prisma.sql`
    SELECT t.id, g."campaignId", t."adGroupId", t."expressionValue" AS text, t."expressionType" AS match, t."isNegative" AS negative, t."negativeLevel" AS level
      FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId"
     WHERE g."campaignId" = ANY(${ids}::text[]) AND t.kind = 'KEYWORD' AND t."retiredAt" IS NULL AND t.status <> 'ARCHIVED' AND g.status <> 'ARCHIVED'`) : []
  const blocking = selfBlocking(keywords)
  const ownerOf = new Map([...owners.values()].map((o) => [o.campaignId, o.owner.kind === 'product' ? o.owner.productId : null]))
  const siblings = siblingTerms(keywords, ownerOf)
  // A harvest rule reaching a campaign with no stored destination: the keyword goes back into its source ad group and the
  // source is never negated (harvest-destination.service.ts). Line-grain rows are not resolved here: named as a caveat.
  const destinations = await prisma.adsHarvestDestination.findMany({ select: { scopeGrain: true, scopeId: true } })
  const groupsOf = new Map<string, string[]>()
  for (const k of keywords) groupsOf.set(k.campaignId, [...new Set([...(groupsOf.get(k.campaignId) ?? []), k.adGroupId])])
  const covered = (c: CampaignRow) => destinations.some((d) => d.scopeGrain === 'account'
    || (d.scopeGrain === 'market' && strategyMarket(d.scopeId) === market)
    || (d.scopeGrain === 'portfolio' && d.scopeId === c.portfolioId)
    || (d.scopeGrain === 'campaign' && d.scopeId === c.id)
    || (d.scopeGrain === 'adGroup' && (groupsOf.get(c.id) ?? []).includes(d.scopeId)))
  const harvestRules = cfg.rules.filter((r) => r.enabled && r.autonomyLevel !== 'OFF' && actionTypesOf(r.actions).some(isHarvestRuleAction))
  const noDestination = harvestRules.flatMap((r) => {
    const reached = rows.filter((row) => row.levers.harvest.writers.some((w) => w.who === `rule "${r.name}"` && w.basis === 'configured'))
    const open = reached.filter((row) => !covered(campaigns.find((c) => c.id === row.campaignId)!))
    return open.length ? [{ rule: r.name, level: r.autonomyLevel, campaigns: open.map((o) => ({ campaignId: o.campaignId, name: o.name })) }] : []
  })
  return {
    data: {
      view: 'clashes', scope: { market, ...(args.productId ? { productId: args.productId } : {}) }, evidenceDays: days, campaignsRead: rows.length,
      clashes,
      gaps: {
        harvestVersusNegate: blocking.map((b) => ({ ...b, meaning: `the keyword "${b.text}" is targeted and blocked in the same place (${b.negative}): it never serves there` })),
        harvestWithoutDestination: noDestination.map((n) => ({ ...n, meaning: `rule "${n.rule}" can harvest in ${n.campaigns.length} campaign${n.campaigns.length === 1 ? '' : 's'} with no stored destination: the keyword goes back into the ad group that found it and that source is never negated (set-harvest-destination fixes it)` })),
        ...(destinations.some((d) => d.scopeGrain === 'line') ? { caveat: 'product-line destinations exist and are not resolved here: a campaign named under harvestWithoutDestination may be covered by one' } : {}),
        siblingKeywords: siblings.map((s) => ({ ...s, meaning: `${s.products.length} products bid on "${s.text}" in ${market}: the market arbiter (AB-9, view terms) names a lead in shadow; until AB-10/AB-11 write, they compete` })),
        amazonRules: amazonRulesGap(rows, native),
      },
      ...(cfg.engines ? {} : { notMeasured: ['the engines\' modes could not be read: every engine counts as configured to act'] }),
    },
  }
}

/** View setup: what is not set up or is held off, with the fix — the Control Room's reading, plus the brain's own setup. */
export async function brainSetup(args: { market?: string }): Promise<{ data: unknown } | { error: string }> {
  const market = args.market ? strategyMarket(args.market) : null
  const [engines, { bidBrainMode }] = await Promise.all([engineFacts(), import('../bid-brain/shadow.js')])
  const GROUP_WORDS: Record<string, string> = {
    ready: 'allowed, but nothing of its own is set up', 'server-off': 'a server switch holds it off', held: 'this business\'s switch, the account dial or a halt holds it back', unknown: 'its settings could not be read',
  }
  const tools = engines
    ? engines.levers.filter((l) => l.group in GROUP_WORDS).map((l) => {
      const vars = serverVariables(l.why)
      const fix = l.start
        ?? (l.group === 'server-off' ? (vars.length ? `server variables ${vars.join(', ')} (Railway) — the Owner's call` : 'a server setting (Railway) — the Owner\'s call')
          : l.group === 'held' ? 'this business\'s switch (turn-up-automation) or the account dial (resume-automation after a halt)'
            : 'set up what it governs first')
      return { tool: l.name, mode: l.mode, state: GROUP_WORDS[l.group], why: l.why, fix, ...(l.warning ? { warning: l.warning } : {}) }
    })
    : null
  const ceiling = bidBrainMode()
  const rows = await bidBrainRowsByProduct(market ?? undefined)
  const brain: Array<{ item: string; state: string; fix: string }> = []
  if (ceiling !== 'live') brain.push({ item: 'bid brain server switch', state: `NEXUS_BID_BRAIN_MODE is ${ceiling}: the brain owns no campaign`, fix: 'a server setting (Railway variable) — ask the Owner' })
  for (const p of rows.products.filter((x) => !x.enrolled)) {
    brain.push({ item: `product ${p.productId} (${p.market})`, state: `${p.campaignIds.length} campaign${p.campaignIds.length === 1 ? ' is' : 's are'} LIVE under the bid brain one by one, but the product is not enrolled: no product-level setting, exclusion or lock applies`, fix: 'enroll the product in the brain (it adopts the LIVE campaigns as they are)' })
  }
  if (rows.shared.length) brain.push({ item: 'shared campaigns LIVE', state: `${rows.shared.length} shared campaign${rows.shared.length === 1 ? ' is' : 's are'} LIVE by a per-campaign enrollment: no product's lever moves ${rows.shared.length === 1 ? 'it' : 'them'}`, fix: 'split each into one campaign per product (D2), or take it back to shadow' })
  brain.push({ item: 'levers with no writer yet', state: BRAIN_LEVERS.filter((l) => !LEVER_LEVELS_NOW[l].levels.includes('AUTO')).map((l) => `${l}: ${LEVER_LEVELS_NOW[l].others}`).join('; '), fix: 'nothing to set: each lever\'s own PR brings its writer (design §8)' })
  brain.push(await amazonRulesSetup(market))
  return { data: { view: 'setup', scope: market ? { market } : {}, tools: tools ?? 'could not measure: the engines\' settings could not be read', brain } }
}
