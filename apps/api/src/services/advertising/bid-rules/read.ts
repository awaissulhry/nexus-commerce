/**
 * Bid page (2026-10-10) — the bid-rules reads behind routes/advertising-bid-rules.routes.ts:
 *
 *   listBidRules     every bid rule (and the bid brain as a pseudo-row `id: 'brain'`) with its honest mode, what it
 *                    applies to, what it changed in 7 days, its 7-day numbers, its runs and its effect
 *   bidRuleHistory   one rule's (or the brain's) changes: keyword, ad group, campaign, from → to, who, when, delivery and
 *                    the undo handle of the existing undo route (POST /advertising/changes/:actionLogId/undo)
 *
 * Read only. Every fact comes from the code that decides it: the scope from the evaluator's own matcher
 * (campaignsReachedBy), the ceiling from ads-graduation.ts, Auto's gate from adsRuleLevelRefusal (the level dial's own
 * check), the posture from ads-automation-state.service.ts, the brain's ownership from bid-brain/live.ts and its numbers
 * from its diff view (brain/read-view.ts), the changes from the change feed (ads-changes.service.ts listChanges).
 *
 * Money (bids, spend, sales, ACoS) sits in money keys (BID_RULES_MONEY), hidden by the route without
 * financials.adspend.view. Another business's rule id reads as not found (the workspace-scoped client).
 */
import prisma from '../../../db.js'
import { FIELDS } from '@nexus/shared/permissions'
import { settledLagDays } from '@nexus/shared/data-vintage'
import { microsToCents } from '../../ads-core/metrics-math.js'
import { normalizeMarketplaceCode } from '../../../utils/marketplace-code.js'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import { notCapRefusal } from '../../automation-cap-predicate.js'
import { resolveAutonomy, type AutonomyLevel } from '../ads-autonomy.js'
import { graduationCeiling } from '../ads-graduation.js'
import { producedActionTypes } from '../ads-rule-adapter.service.js'
import { campaignsReachedBy, type ReachRule } from '../ads-rule-reach.service.js'
import { ruleStoredSchedule } from '../ads-rule-schedule.js'
import { settledLag } from '../ads-settled-window.js'
import { BRAIN_ACTOR, brainOwnedCampaignIds } from '../bid-brain/live.js'
import { bidBrainMode } from '../bid-brain/shadow.js'
import { writeStats } from '../bid-brain/read.js'
import { withoutUndonePairs } from '../bid-owner.js'
import {
  ARCHIVED_ADS_DOMAIN, autoGateHold, brainNextFullRun, brainScheduleWords, dayKey, EFFECT_LOOKBACK_DAYS, effectOf, effectWindows, isBidRule,
  brainMode, modeActs, nextQuarter, ruleMode, ruleRunTimes, ruleSentence, scheduleWords, utcDay,
  type AccountPosture, type BidRuleMode, type CampaignSplit, type Effect, type Hold, type PerfDay,
} from './pure.js'

/** Ad-spend money of the bid-rules answers: hidden whole from a person without financials.adspend.view. */
export const BID_RULES_MONEY: Readonly<Record<string, string>> = Object.fromEntries(
  ['fromCents', 'toCents', 'spendCents', 'salesCents', 'acosPct', 'bidCents'].map((key) => [key, FIELDS.financialsAdspendView]),
)

export const BRAIN_ROW_ID = 'brain'
const DAY = 86_400_000
/** The 7-day window every count on a row reads. */
const WEEK_DAYS = 7
/** Refs listed per kind; the counts say how many there are in all. */
const MAX_REFS = 100
/** Op states of a write that did not land (ads-changes.service.ts UNSENT_OP_STATES). */
const UNSENT = new Set(['FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED'])

export interface Ref { id: string; name: string; href?: string }
export interface RefSet { portfolios: Ref[]; campaigns: Ref[]; adGroups: Ref[] }
/**
 * How many there are in all, per kind. The lists above stop at MAX_REFS (100) each; these never do — a chip says
 * `counts.campaigns` ("153 campaigns"), never the length of the list (audit M5).
 */
export interface RefCounts { portfolios: number; campaigns: number; adGroups: number }

export interface BidRuleRow {
  id: string
  kind: 'rule' | 'brain'
  name: string
  sentence: string
  /** The rule's own market; null = every market. */
  market: string | null
  mode: BidRuleMode
  /**
   * What it applies to: its campaigns (by the evaluator's matcher), their portfolios; ad groups only when it names some.
   * `counts` are the true totals (the lists stop at 100): `scope.counts.campaigns` is the number for the chip.
   */
  scope: RefSet & { all: boolean; product: Ref | null; counts: RefCounts }
  /** What it changed in the last 7 days (writes that landed or are in flight), how many bid changes, and the true totals. */
  changed7d: RefSet & { bids: number; keywords: number; counts: RefCounts }
  last7d: { runs: number; asks: number; applied: number; written: number; brainInputs: number; refused: number }
  /** Its asks waiting for a person now. */
  waiting: number
  lastRunAt: string | null
  /** The true next run (the evaluator's own schedule gate); null when it does not run (Off, archived, held to Off). */
  nextRunAt: string | null
  /** Set only when the next run is its first ever (never run: the next tick, whatever its schedule) — equals nextRunAt. */
  firstRunAt: string | null
  /** With firstRunAt and a timed schedule: the run after the first, by the same gate. */
  thenRunAt: string | null
  /** Its schedule in words, as the evaluator runs it: "Daily · 06:00 · Rome", "Hourly", "Every 15 min" (the brain: "Every 6 h"). */
  schedule: string
  /** Before vs after its changes; null when there is nothing to compare or nothing changed (same ACoS, spend and orders). */
  effect: Effect | null
  archived: boolean
}

export interface BidRulesTotals {
  rules: number
  on: number
  waiting: number
  bidsChanged7d: number
  clashes: number
  archived: number
  otherMarkets: number
}

// ── refs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const portfolioHref = (externalId: string) => `/marketing/ads/portfolios/${encodeURIComponent(externalId)}`
export const campaignHref = (id: string) => `/marketing/ads/campaigns/${encodeURIComponent(id)}`
export const adGroupHref = (campaignId: string, adGroupId: string) => `${campaignHref(campaignId)}/ad-groups/${encodeURIComponent(adGroupId)}`

interface CampaignFacts { id: string; name: string; marketplace: string | null; portfolioId: string | null; status: string; liveBidWritesEnabled: boolean; pinBids: boolean }
interface AdGroupFacts { id: string; name: string; campaignId: string }
interface TargetFacts { id: string; text: string; adGroupId: string; bidCents: number }

/** Names for campaigns, ad groups, targets and portfolios, loaded once per answer. */
export class RefBook {
  campaigns = new Map<string, CampaignFacts>()
  adGroups = new Map<string, AdGroupFacts>()
  targets = new Map<string, TargetFacts>()
  portfolios = new Map<string, string>()

  async load(ids: { campaigns?: Iterable<string>; adGroups?: Iterable<string>; targets?: Iterable<string>; portfolios?: Iterable<string> }): Promise<void> {
    const want = (list: Iterable<string> | undefined, have: Map<string, unknown>) => [...new Set(list ?? [])].filter((id) => id && !have.has(id))
    const targetIds = want(ids.targets, this.targets)
    if (targetIds.length) {
      const rows = await prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, kind: true, expressionType: true, expressionValue: true, adGroupId: true, bidCents: true } })
      for (const t of rows) {
        const text = (t.expressionValue ?? '').trim() || (t.expressionType ? String(t.expressionType) : `${String(t.kind ?? 'target')}`)
        this.targets.set(t.id, { id: t.id, text, adGroupId: t.adGroupId, bidCents: t.bidCents })
      }
    }
    const groupIds = want([...(ids.adGroups ?? []), ...[...this.targets.values()].map((t) => t.adGroupId)], this.adGroups)
    if (groupIds.length) {
      const rows = await prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true, campaignId: true } })
      for (const g of rows) this.adGroups.set(g.id, { id: g.id, name: g.name, campaignId: g.campaignId })
    }
    const campaignIds = want([...(ids.campaigns ?? []), ...[...this.adGroups.values()].map((g) => g.campaignId)], this.campaigns)
    if (campaignIds.length) {
      const rows = await prisma.campaign.findMany({
        where: { id: { in: campaignIds } },
        select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, liveBidWritesEnabled: true, pinBids: true },
      })
      for (const c of rows) this.campaigns.set(c.id, { ...c, status: String(c.status), marketplace: c.marketplace ?? null, portfolioId: c.portfolioId ?? null })
    }
    const portfolioIds = want([...(ids.portfolios ?? []), ...[...this.campaigns.values()].map((c) => c.portfolioId ?? '')], this.portfolios)
    if (portfolioIds.length) {
      const rows = await prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: portfolioIds } }, select: { externalPortfolioId: true, name: true, updatedAt: true }, orderBy: { updatedAt: 'asc' } })
      for (const p of rows) this.portfolios.set(p.externalPortfolioId, p.name)
    }
  }

  campaignRef(id: string): Ref { return { id, name: this.campaigns.get(id)?.name ?? id, href: campaignHref(id) } }
  portfolioRef(externalId: string): Ref { return { id: externalId, name: this.portfolios.get(externalId) ?? externalId, href: portfolioHref(externalId) } }
  adGroupRef(id: string): Ref | null {
    const g = this.adGroups.get(id)
    return g ? { id, name: g.name, href: adGroupHref(g.campaignId, id) } : null
  }
  targetRef(id: string): Ref {
    const t = this.targets.get(id)
    const g = t ? this.adGroups.get(t.adGroupId) : undefined
    return { id, name: t?.text ?? id, ...(g ? { href: adGroupHref(g.campaignId, g.id) } : {}) }
  }
  /** The campaign a target or ad group belongs to. */
  campaignOfTarget(id: string): string | null { const t = this.targets.get(id); return t ? this.adGroups.get(t.adGroupId)?.campaignId ?? null : null }
  campaignOfAdGroup(id: string): string | null { return this.adGroups.get(id)?.campaignId ?? null }

  /** Refs of campaigns (sorted by name), their portfolios and these ad groups: up to MAX_REFS each, with the true totals. */
  refSet(campaignIds: Iterable<string>, adGroupIds: Iterable<string> = []): RefSet & { counts: RefCounts } {
    const camps = [...new Set(campaignIds)].map((id) => this.campaignRef(id)).sort((a, b) => a.name.localeCompare(b.name))
    const portfolioIds = [...new Set([...new Set(campaignIds)].map((id) => this.campaigns.get(id)?.portfolioId).filter((p): p is string => !!p))]
    const portfolios = portfolioIds.map((p) => this.portfolioRef(p)).sort((a, b) => a.name.localeCompare(b.name))
    const groups = [...new Set(adGroupIds)].map((id) => this.adGroupRef(id)).filter((r): r is Ref => !!r).sort((a, b) => a.name.localeCompare(b.name))
    return {
      portfolios: portfolios.slice(0, MAX_REFS), campaigns: camps.slice(0, MAX_REFS), adGroups: groups.slice(0, MAX_REFS),
      counts: { portfolios: portfolios.length, campaigns: camps.length, adGroups: groups.length },
    }
  }
}

// ── the writes of a writer ──────────────────────────────────────────────────────────────────────────────────────────

/** The actor strings one rule's writes carry: `automation:<id>`, and the doubled prefix older writes kept (ads-actor.ts R2). */
export const ruleActors = (ruleId: string) => [`automation:${ruleId}`, `automation:automation:${ruleId}`]

interface WriteRow { id: string; userId: string | null; entityType: string; entityId: string; actionType: string; amazonResponseStatus: string | null; createdAt: Date }

const landed = (w: WriteRow) => !UNSENT.has(String(w.amazonResponseStatus ?? ''))

/**
 * The writers' changes since `since`. R4 — an approved ask that was undone (bid-rules/ask-undo.ts) is no change of the rule:
 * its write and the undo the rule wrote (`evidence.undoOf`) fold away (withoutUndonePairs), as on the bids.
 */
async function writesBy(actors: string[], since: Date): Promise<WriteRow[]> {
  if (!actors.length) return []
  const where = { userId: { in: actors }, createdAt: { gte: since } }
  const [rows, undos] = await Promise.all([
    prisma.advertisingActionLog.findMany({
      where,
      select: { id: true, userId: true, entityType: true, entityId: true, actionType: true, amazonResponseStatus: true, createdAt: true },
    }),
    prisma.advertisingActionLog.findMany({ where: { ...where, evidence: { path: ['undoOf'], string_starts_with: '' } }, select: { id: true, evidence: true } }),
  ])
  if (!undos.length) return rows
  const undoOf = new Map(undos.map((u) => [u.id, String((u.evidence as { undoOf?: unknown } | null)?.undoOf ?? '') || null]))
  return withoutUndonePairs(rows.map((r) => ({ ...r, undoOf: undoOf.get(r.id) ?? null }))).map(({ undoOf: _undoOf, ...r }) => r)
}

/** What a writer changed in the window, in the market asked: campaigns, ad groups, bid changes and keywords. */
function changedOf(writes: readonly WriteRow[], book: RefBook, market: string | null, since: Date): RefSet & { bids: number; keywords: number; counts: RefCounts } {
  const campaigns = new Set<string>()
  const groups = new Set<string>()
  const keywords = new Set<string>()
  let bids = 0
  for (const w of writes) {
    if (w.createdAt < since || !landed(w)) continue
    const campaignId = w.entityType === 'AD_TARGET' ? book.campaignOfTarget(w.entityId)
      : w.entityType === 'AD_GROUP' ? book.campaignOfAdGroup(w.entityId)
        : w.entityType === 'CAMPAIGN' ? w.entityId : null
    if (!campaignId) continue
    if (market && book.campaigns.get(campaignId)?.marketplace !== market) continue
    campaigns.add(campaignId)
    if (w.entityType === 'AD_TARGET') {
      const g = book.targets.get(w.entityId)?.adGroupId
      if (g) groups.add(g)
      keywords.add(w.entityId)
      if (w.actionType === 'AD_BID_UPDATE') bids++
    } else if (w.entityType === 'AD_GROUP') groups.add(w.entityId)
  }
  const refs = book.refSet(campaigns, groups)
  return { portfolios: refs.portfolios, campaigns: refs.campaigns, adGroups: refs.adGroups, bids, keywords: keywords.size, counts: refs.counts }
}

/** Each target's first landed change in the effect lookback, in the market asked. */
function firstChanges(writes: readonly WriteRow[], book: RefBook, market: string | null): Map<string, Date> {
  const out = new Map<string, Date>()
  for (const w of writes) {
    if (w.entityType !== 'AD_TARGET' || !landed(w)) continue
    const campaignId = book.campaignOfTarget(w.entityId)
    if (market && (!campaignId || book.campaigns.get(campaignId)?.marketplace !== market)) continue
    const at = out.get(w.entityId)
    if (!at || w.createdAt < at) out.set(w.entityId, w.createdAt)
  }
  return out
}

/** The daily performance of these targets between two days (inclusive), one row per target and day. */
async function perfDays(targetIds: string[], from: Date, to: Date): Promise<PerfDay[]> {
  if (!targetIds.length) return []
  const rows = await prisma.amazonAdsDailyPerformance.findMany({
    where: { entityType: 'AD_TARGET', localEntityId: { in: targetIds }, date: { gte: from, lte: to } },
    select: { localEntityId: true, date: true, clicks: true, orders7d: true, costMicros: true, sales7dCents: true, currencyCode: true },
  })
  return rows.map((r) => ({
    targetId: r.localEntityId as string, date: r.date, clicks: r.clicks ?? 0, orders: r.orders7d ?? 0,
    spendCents: microsToCents(r.costMicros), salesCents: r.sales7dCents ?? 0, currency: r.currencyCode,
  }))
}

/** The newest settled data day for Sponsored Products (the effect's after-window end). */
const settledThrough = (now: Date) => new Date(utcDay(now).getTime() - settledLagDays('SPONSORED_PRODUCTS', settledLag()) * DAY)

// ── the account ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function accountPosture(): Promise<AccountPosture> {
  const { getAutomationState } = await import('../ads-automation-state.service.js')
  const s = await getAutomationState()
  return { autonomy: s.autonomy, halted: s.halted, killed: process.env.NEXUS_ADS_AUTOMATION_KILL === '1', degraded: s.degraded }
}

const adsLive = () => (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

/** A market code as campaigns store it ('IT'), from any shape a rule or a query carries; null for none or 'all'. */
const normMarket = (m: string | null | undefined) => {
  const raw = (m ?? '').trim()
  if (!raw || raw.toLowerCase() === 'all') return null
  return normalizeMarketplaceCode(raw, raw.toUpperCase())
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────────────────────────

const RULE_SELECT = {
  id: true, name: true, domain: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true, conditions: true, actions: true,
  maxExecutionsPerDay: true, maxWritesPerDay: true, maxValueCentsEur: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
  evaluationCount: true, matchCount: true, lastEvaluatedAt: true, createdAt: true,
} as const

type RuleRecord = {
  id: string; name: string; domain: string; trigger: string; enabled: boolean; dryRun: boolean; autonomyLevel: string | null; conditions: unknown; actions: unknown
  maxExecutionsPerDay: number | null; maxWritesPerDay: number | null; maxValueCentsEur: number | null; scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null
  evaluationCount: number; matchCount: number; lastEvaluatedAt: Date | null; createdAt: Date
}

/** Per rule: 7-day runs (distinct 15-minute ticks with a run row) and the runs whose bid action became a brain input. */
async function runStats(ruleIds: string[], since: Date): Promise<Map<string, { runs: number; brainInputs: number }>> {
  const out = new Map<string, { runs: number; brainInputs: number }>()
  if (!ruleIds.length) return out
  const rows = await prisma.automationRuleExecution.findMany({
    where: { ruleId: { in: ruleIds }, startedAt: { gte: since }, ...notCapRefusal() },
    select: { ruleId: true, startedAt: true, actionResults: true },
  })
  const ticks = new Map<string, Set<number>>()
  for (const r of rows) {
    const s = ticks.get(r.ruleId) ?? new Set<number>()
    s.add(Math.floor(r.startedAt.getTime() / (15 * 60_000)))
    ticks.set(r.ruleId, s)
    const cur = out.get(r.ruleId) ?? { runs: 0, brainInputs: 0 }
    // BB-9 — an action result carrying a `bidBrain` object asked the brain (stored, or would ask in a dry run).
    const results = Array.isArray(r.actionResults) ? r.actionResults as Array<{ output?: { bidBrain?: unknown } }> : []
    if (results.some((a) => a?.output?.bidBrain != null && typeof a.output.bidBrain === 'object')) cur.brainInputs++
    out.set(r.ruleId, cur)
  }
  for (const [id, s] of ticks) out.get(id)!.runs = s.size
  return out
}

/** Today's (UTC) use of each rule's two daily caps. */
async function capsToday(rules: readonly RuleRecord[], now: Date): Promise<Map<string, { matches: boolean; writes: boolean }>> {
  const dayStart = utcDay(now)
  const withMatches = rules.filter((r) => r.maxExecutionsPerDay != null).map((r) => r.id)
  const withWrites = rules.filter((r) => r.maxWritesPerDay != null)
  const [execs, writes] = await Promise.all([
    withMatches.length ? prisma.automationRuleExecution.groupBy({ by: ['ruleId'], where: { ruleId: { in: withMatches }, startedAt: { gte: dayStart }, ...notCapRefusal() }, _count: { _all: true } }) : Promise.resolve([]),
    withWrites.length ? prisma.advertisingActionLog.groupBy({ by: ['userId'], where: { userId: { in: withWrites.map((r) => `automation:${r.id}`) }, createdAt: { gte: dayStart } }, _count: { _all: true } }) : Promise.resolve([]),
  ])
  const execBy = new Map(execs.map((e) => [e.ruleId, e._count._all]))
  const writeBy = new Map(writes.map((w) => [String(w.userId), w._count._all]))
  return new Map(rules.map((r) => [r.id, {
    matches: r.maxExecutionsPerDay != null && (execBy.get(r.id) ?? 0) >= r.maxExecutionsPerDay,
    writes: r.maxWritesPerDay != null && (writeBy.get(`automation:${r.id}`) ?? 0) >= r.maxWritesPerDay,
  }]))
}

/**
 * Why Auto cannot be picked, for the rules not on Auto: the level dial's own answer (adsRuleLevelRefusal), as a hold. Its
 * evidence checks are read from the rows already loaded first, in the dial's order — the ceiling of what the rule does,
 * then the graduation gate (GRADUATION_GATE: on, 14 days, 10 runs, 1 match) — so a rule they refuse costs no
 * query; only a rule they pass asks the dial itself (the connection, the live mode, the hourly plans' lanes).
 */
async function autoGates(rules: readonly RuleRecord[], now: Date): Promise<Map<string, Hold | null>> {
  const out = new Map<string, Hold | null>()
  if (!rules.length) return out
  const { adsRuleLevelRefusal, GRADUATION_GATE } = await import('../ads-rule-crud.service.js')
  const { isRefused } = await import('../../automation/service-outcome.js')
  const protections = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
  await Promise.all(rules.map(async (r) => {
    const ageDays = Math.floor((now.getTime() - r.createdAt.getTime()) / DAY)
    const ceiling = graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: protections > 0 })
    const local = ceiling.maxLevel !== 'AUTO' ? { error: 'above_ceiling', blockedBy: ceiling.blockedBy }
      : !r.enabled ? { error: 'gate_not_open', failures: ['RULE_ENABLED'] }
        : ageDays < GRADUATION_GATE.observationDays ? { error: 'gate_not_open', failures: ['OBSERVATION_WINDOW'] }
          : r.evaluationCount < GRADUATION_GATE.evaluations ? { error: 'gate_not_open', failures: ['HAS_EVALUATIONS'] }
            : r.matchCount < GRADUATION_GATE.matches ? { error: 'gate_not_open', failures: ['HAS_MATCHES'] }
              : null
    let refusal: { error?: unknown; failures?: unknown; blockedBy?: unknown } | null = local
    if (!refusal) {
      const asked = await adsRuleLevelRefusal(r.id, 'AUTO')
      refusal = isRefused(asked) ? asked.body as { error?: unknown; failures?: unknown; blockedBy?: unknown } : null
    }
    out.set(r.id, autoGateHold(refusal, r.createdAt, { observationDays: GRADUATION_GATE.observationDays, evaluations: { have: r.evaluationCount, need: GRADUATION_GATE.evaluations } }))
  }))
  return out
}

/** What the write gate does with an automatic bid write on this campaign (ads-write-gate.ts, bid-brain/live.ts). */
export type CampaignGate = 'open' | 'locked' | 'market' | 'brain' | 'brainStopped'

export interface GateFacts {
  /** Campaigns the bid brain owns now. */
  owned: ReadonlySet<string>
  /** Of those, the ones whose bids the Owner's kill switch stops (brain/kill-switch.ts). */
  killed: ReadonlySet<string>
  /** Markets whose Amazon Ads connection takes writes. */
  liveMarkets: ReadonlySet<string>
}

export function campaignGate(id: string, book: RefBook, g: GateFacts): CampaignGate {
  if (g.owned.has(id)) return g.killed.has(id) ? 'brainStopped' : 'brain'
  const c = book.campaigns.get(id)
  // 6b — Amazon's own limits: a market without a checked row (UK, SE, PL, NL, …) is refused before anything else.
  if (!c?.marketplace || !marketLimitsOf(c.marketplace)) return 'market'
  if (!c.liveBidWritesEnabled || c.pinBids || !g.liveMarkets.has(c.marketplace)) return 'locked'
  return 'open'
}

/** The campaigns split by what the gate does with a rule's write, with each held part's names for the holds' reasons. */
export function splitCampaigns(ids: readonly string[], book: RefBook, g: GateFacts): CampaignSplit {
  const split: CampaignSplit = { total: ids.length, open: 0, locked: 0, market: 0, brain: 0, brainStopped: 0 }
  const names: Required<NonNullable<CampaignSplit['names']>> = { locked: [], market: [], brain: [], brainStopped: [] }
  for (const id of ids) {
    const part = campaignGate(id, book, g)
    split[part]++
    if (part !== 'open') names[part].push(book.campaigns.get(id)?.name ?? id)
  }
  for (const list of Object.values(names)) list.sort((a, b) => a.localeCompare(b))
  split.names = names
  return split
}

/** The facts campaignGate reads, for these campaigns (loaded into the book). */
export async function gateFacts(book: RefBook, owned?: ReadonlySet<string>): Promise<GateFacts> {
  const ownedNow = owned ?? await brainOwnedCampaignIds([...book.campaigns.keys()])
  const ownedHere = [...ownedNow].filter((id) => book.campaigns.has(id))
  const [liveMarkets, kills] = await Promise.all([
    writableMarkets([...book.campaigns.values()].map((c) => c.marketplace)),
    ownedHere.length ? (await import('../brain/kill-switch.js')).campaignKills(ownedHere, ['bids']) : Promise.resolve(new Map()),
  ])
  return { owned: ownedNow, killed: new Set([...kills.keys()]), liveMarkets }
}

/** The markets whose Amazon Ads connection takes writes (production, writes on), by the write gate's own resolver. */
export async function writableMarkets(markets: Iterable<string | null>): Promise<Set<string>> {
  const list = [...new Set([...markets].filter((m): m is string => !!m))]
  if (!list.length) return new Set()
  const { adsProfilesForMarkets } = await import('../ads-profile-resolver.js')
  const profiles = await adsProfilesForMarkets(list)
  return new Set(list.filter((m) => { const p = profiles.get(m); return !!p && p.mode === 'production' && p.writesEnabledAt != null }))
}

/** The campaigns a builder rule's picker names (actions[0].campaigns / campaignIds), when it names some. */
function pickedCampaigns(actions: unknown): string[] {
  const a0 = Array.isArray(actions) ? actions[0] as Record<string, unknown> | undefined : undefined
  if (!a0) return []
  if (Array.isArray(a0.campaigns)) return (a0.campaigns as Array<{ id?: unknown }>).map((c) => String(c?.id ?? '')).filter(Boolean)
  if (Array.isArray(a0.campaignIds)) return (a0.campaignIds as unknown[]).map((c) => String(c ?? '')).filter(Boolean)
  return []
}

export interface ListBidRulesQuery { market?: string | null }

/** GET /advertising/bid-rules — every bid rule of this business (the brain first), in the market asked or every market. */
export async function listBidRules(q: ListBidRulesQuery, opts: { now?: Date } = {}): Promise<{ market: string | null; rules: BidRuleRow[]; totals: BidRulesTotals }> {
  const now = opts.now ?? new Date()
  const market = normMarket(q.market)
  const weekAgo = new Date(now.getTime() - WEEK_DAYS * DAY)
  const lookback = new Date(now.getTime() - EFFECT_LOOKBACK_DAYS * DAY)

  const all = (await prisma.automationRule.findMany({
    where: { domain: { in: ['advertising', ARCHIVED_ADS_DOMAIN] } },
    select: RULE_SELECT,
    orderBy: [{ name: 'asc' }],
  }) as RuleRecord[]).filter((r) => isBidRule(r.actions))
  const inMarket = (r: RuleRecord) => !market || !r.scopeMarketplace || normMarket(r.scopeMarketplace) === market
  const rules = all.filter(inMarket)
  const otherMarkets = all.filter((r) => !inMarket(r) && r.domain !== ARCHIVED_ADS_DOMAIN).length
  const live = rules.filter((r) => r.domain !== ARCHIVED_ADS_DOMAIN)
  const ids = rules.map((r) => r.id)

  const [posture, reached, owned, caps, runs, asks, applied, waiting, refusals, writes] = await Promise.all([
    accountPosture(),
    campaignsReachedBy(rules as unknown as ReachRule[]),
    brainOwnedCampaignIds(),
    capsToday(live, now),
    runStats(ids, weekAgo),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, createdAt: { gte: weekAgo } }, _count: { _all: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, status: 'applied', decidedAt: { gte: weekAgo } }, _count: { _all: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, status: 'pending' }, _count: { _all: true } }) : Promise.resolve([]),
    (await import('../../automation-refusals.service.js')).refusalCountsByActor(WEEK_DAYS),
    writesBy([...ids.flatMap(ruleActors), BRAIN_ACTOR], lookback),
  ])
  const count = (rows: Array<{ ruleId: string; _count: { _all: number } }>) => new Map(rows.map((r) => [r.ruleId, r._count._all]))
  const asksBy = count(asks as never)
  const appliedBy = count(applied as never)
  const waitingBy = count(waiting as never)

  // The campaigns each rule reaches (not archived; in the market asked), and everything the refs name.
  const reachOf = new Map<string, string[]>()
  for (const r of rules) {
    reachOf.set(r.id, (reached.byRule.get(r.id) ?? [])
      .filter((c) => c.status !== 'ARCHIVED' && (!market || c.marketplace === market))
      .map((c) => c.id))
  }
  const book = new RefBook()
  await book.load({
    campaigns: [...[...reachOf.values()].flat(), ...owned, ...writes.filter((w) => w.entityType === 'CAMPAIGN').map((w) => w.entityId)],
    adGroups: writes.filter((w) => w.entityType === 'AD_GROUP').map((w) => w.entityId),
    targets: writes.filter((w) => w.entityType === 'AD_TARGET').map((w) => w.entityId),
    portfolios: rules.map((r) => r.scopePortfolioId ?? ''),
  })

  const gate = await gateFacts(book, owned)
  const gates = await autoGates(live.filter((r) => resolveAutonomy(r) !== 'AUTO'), now)

  // The effect: every writer's first change per keyword, and the performance of all those keywords at once.
  const settled = settledThrough(now)
  const writesOf = new Map<string, WriteRow[]>()
  for (const w of writes) {
    const key = w.userId === BRAIN_ACTOR ? BRAIN_ROW_ID : String(w.userId).replace(/^(automation:)+/, '')
    const list = writesOf.get(key)
    if (list) list.push(w)
    else writesOf.set(key, [w])
  }
  const windowsOf = new Map<string, ReturnType<typeof effectWindows>>()
  for (const [key, list] of writesOf) windowsOf.set(key, effectWindows(firstChanges(list, book, market), settled))
  const effectTargets = [...new Set([...windowsOf.values()].flatMap((w) => w.windows.map((x) => x.targetId)))]
  const earliest = Math.min(...[...windowsOf.values()].flatMap((w) => w.windows.map((x) => x.beforeFrom.getTime())), now.getTime())
  const perf = await perfDays(effectTargets, new Date(earliest), settled)
  const effectFor = (key: string) => {
    const w = windowsOf.get(key)
    return w ? effectOf(w.windows, w.tooEarly, perf, settled) : null
  }

  const rows: BidRuleRow[] = rules.map((r) => {
    const archived = r.domain === ARCHIVED_ADS_DOMAIN
    const level = resolveAutonomy(r) as AutonomyLevel
    const reach = reachOf.get(r.id) ?? []
    const cap = caps.get(r.id) ?? { matches: false, writes: false }
    const ceiling = graduationCeiling({ actionTypes: producedActionTypes(r), hasKeywordProtections: false })
    const mode = ruleMode({
      level, archived, account: posture, adsLive: adsLive(),
      ceiling: ceiling.maxLevel, ceilingBlockedBy: ceiling.blockedBy,
      manualBelt: (Array.isArray(r.actions) ? (r.actions[0] as { control?: unknown } | undefined) : undefined)?.control === 'manual',
      matchesCapHit: cap.matches, writeCapHit: cap.writes, valueCapZero: r.maxValueCentsEur === 0,
      caps: { matchesPerDay: r.maxExecutionsPerDay, writesPerDay: r.maxWritesPerDay },
      campaigns: splitCampaigns(reach, book, gate),
      autoGate: gates.get(r.id) ?? null,
    })
    const picks = pickedCampaigns(r.actions)
    const narrow = !!(r.scopeCampaignId || r.scopePortfolioId || r.scopeProductId || picks.length)
    const scope = book.refSet(reach)
    // A rule bound to one portfolio names it even when none of its campaigns is in the market asked (and counts it).
    const boundPortfolio = r.scopePortfolioId && !scope.portfolios.some((p) => p.id === r.scopePortfolioId) ? book.portfolioRef(r.scopePortfolioId) : null
    const schedule = ruleStoredSchedule(r.actions)
    const runsAt = modeActs(mode) ? ruleRunTimes(schedule, r.lastEvaluatedAt, now) : { nextRunAt: null, firstRunAt: null, thenRunAt: null }
    const mine = writesOf.get(r.id) ?? []
    const week = mine.filter((w) => w.createdAt >= weekAgo)
    // Refused: its daily match cap and its value cap turning it away (the refusal record), and its writes the gate or Amazon
    // did not take. The write cap's demotion (it asks instead) and the levers it left to their holder are not refusals.
    const byReason = refusals.get(r.id)?.byReason ?? {}
    const refused = (byReason.DAILY_CAP_EXCEEDED ?? 0) + (byReason.VALUE_CAP_EXCEEDED ?? 0)
    return {
      id: r.id,
      kind: 'rule' as const,
      name: r.name,
      sentence: ruleSentence(r),
      market: normMarket(r.scopeMarketplace),
      mode,
      scope: {
        ...scope,
        portfolios: boundPortfolio ? [boundPortfolio, ...scope.portfolios] : scope.portfolios,
        counts: boundPortfolio ? { ...scope.counts, portfolios: scope.counts.portfolios + 1 } : scope.counts,
        all: !narrow,
        product: r.scopeProductId ? { id: r.scopeProductId, name: r.scopeProductId, href: `/products/${encodeURIComponent(r.scopeProductId)}` } : null,
      },
      changed7d: changedOf(mine, book, market, weekAgo),
      last7d: {
        runs: runs.get(r.id)?.runs ?? 0,
        asks: asksBy.get(r.id) ?? 0,
        applied: appliedBy.get(r.id) ?? 0,
        written: week.filter(landed).length,
        brainInputs: runs.get(r.id)?.brainInputs ?? 0,
        refused: refused + week.filter((w) => !landed(w)).length,
      },
      waiting: archived ? 0 : waitingBy.get(r.id) ?? 0,
      lastRunAt: r.lastEvaluatedAt?.toISOString() ?? null,
      nextRunAt: runsAt.nextRunAt?.toISOString() ?? null,
      firstRunAt: runsAt.firstRunAt?.toISOString() ?? null,
      thenRunAt: runsAt.thenRunAt?.toISOString() ?? null,
      schedule: scheduleWords(schedule),
      effect: effectFor(r.id),
      archived,
    }
  })

  // Product names for the product scopes (a rule's fourth grain).
  const productIds = [...new Set(rows.map((r) => r.scope.product?.id).filter((x): x is string => !!x))]
  if (productIds.length) {
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true } })
    const named = new Map(products.map((p) => [p.id, p.sku || p.name || p.id]))
    for (const row of rows) if (row.scope.product) row.scope.product.name = named.get(row.scope.product.id) ?? row.scope.product.id
  }

  const brain = await brainRow({ market, now, posture, owned, book, writes: writesOf.get(BRAIN_ROW_ID) ?? [], effect: effectFor(BRAIN_ROW_ID) })

  // Clashes: keywords two different automatic writers changed within 24 hours, per day (the brain's diff view's own count).
  const changedTargets = [...new Set(writes.filter((w) => w.entityType === 'AD_TARGET' && w.createdAt >= weekAgo && landed(w)).map((w) => w.entityId))]
    .filter((id) => { const c = book.campaignOfTarget(id); return !market || (!!c && book.campaigns.get(c)?.marketplace === market) })
  const bidWrites = changedTargets.length ? await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', entityId: { in: changedTargets }, createdAt: { gte: new Date(weekAgo.getTime() - DAY) } },
    select: { entityId: true, userId: true, createdAt: true },
  }) : []
  const weekKey = dayKey(weekAgo)
  const clashes = [...writeStats(bidWrites)].filter(([day]) => day >= weekKey).reduce((n, [, s]) => n + s.conflicts, 0)

  const active = rows.filter((r) => !r.archived)
  const totals: BidRulesTotals = {
    rules: active.length,
    on: active.filter((r) => r.mode.set !== 'OFF').length,
    waiting: active.reduce((n, r) => n + r.waiting, 0),
    bidsChanged7d: active.reduce((n, r) => n + r.changed7d.bids, 0) + brain.changed7d.bids,
    clashes,
    archived: rows.length - active.length,
    otherMarkets,
  }
  const order = (r: BidRuleRow) => (r.archived ? 2 : r.mode.set === 'OFF' ? 1 : 0)
  return { market, rules: [brain, ...rows.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))], totals }
}

// ── the brain's pseudo-row ──────────────────────────────────────────────────────────────────────────────────────────

async function brainRow(a: { market: string | null; now: Date; posture: AccountPosture; owned: ReadonlySet<string>; book: RefBook; writes: WriteRow[]; effect: Effect | null }): Promise<BidRuleRow> {
  const weekAgo = new Date(a.now.getTime() - WEEK_DAYS * DAY)
  // The brain's own read: its diff view over 7 days (brain/read-view.ts), the same answer as Claude's bid-brain tool.
  const { readBidBrainView } = await import('../brain/read-view.js')
  const diff = await readBidBrainView({ view: 'diff', days: WEEK_DAYS, ...(a.market ? { market: a.market } : {}) })
  // `owned`: the campaigns it owns now, archived ones left out (BB-6, A2b) — what it applies to while it is live.
  const ownedNow = 'data' in diff ? ((diff.data as { owned?: string[] }).owned ?? []) : [...a.owned]
  const marketWhere = a.market ? { marketplace: a.market } : {}
  const [enrolled, decided, runs, latest, inputs] = await Promise.all([
    prisma.bidBrainEnrollment.findMany({ where: { mode: { in: ['LIVE', 'HELD'] }, ...marketWhere }, select: { campaignId: true } }),
    prisma.bidBrainDecision.groupBy({ by: ['campaignId'], where: { createdAt: { gte: weekAgo }, ...marketWhere } }),
    prisma.bidBrainDecision.groupBy({ by: ['runId'], where: { createdAt: { gte: weekAgo }, ...marketWhere } }),
    prisma.bidBrainDecision.findFirst({ where: marketWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.bidDirective.findMany({ where: { source: { startsWith: 'rule:' }, OR: [{ until: null }, { until: { gte: a.now } }] }, select: { campaignId: true } }),
  ])
  await a.book.load({ campaigns: [...ownedNow, ...enrolled.map((e) => e.campaignId), ...decided.map((d) => d.campaignId), ...inputs.map((d) => d.campaignId)] })
  const inMarket = (id: string) => { const c = a.book.campaigns.get(id); return !!c && c.status !== 'ARCHIVED' && (!a.market || c.marketplace === a.market) }
  const ownedHere = ownedNow.filter(inMarket)
  const enrolledLive = enrolled.map((e) => e.campaignId).filter(inMarket)
  const serverMode = bidBrainMode()
  // The Owner's kill switch on the bids lever of the campaigns it runs live here.
  const killed = enrolledLive.length ? (await (await import('../brain/kill-switch.js')).campaignKills(enrolledLive, ['bids'])).size : 0
  const mode = brainMode({ serverMode, enrolledLive: enrolledLive.length, account: a.posture, adsLive: adsLive(), killed })
  // What it applies to: the campaigns it owns; in shadow, the campaigns it decided for this week.
  const scopeIds = ownedHere.length ? ownedHere : decided.map((d) => d.campaignId).filter(inMarket)
  const scope = a.book.refSet(scopeIds)
  const week = a.writes.filter((w) => w.createdAt >= weekAgo)
  const everyTick = serverMode === 'live' && ownedHere.length > 0
  const nextRunAt = mode.acts === 'OFF' && serverMode === 'off' ? null : (everyTick ? nextQuarter(a.now) : brainNextFullRun(a.now)).toISOString()
  return {
    id: BRAIN_ROW_ID,
    kind: 'brain',
    name: 'Brain',
    sentence: 'Bids to the ACoS goal',
    market: a.market,
    mode,
    scope: { ...scope, all: false, product: null },
    changed7d: changedOf(a.writes, a.book, a.market, weekAgo),
    last7d: {
      runs: runs.length,
      asks: 0,
      applied: 0,
      written: week.filter(landed).length,
      // The rules' inputs it holds now (BidDirective, each lasting 7 days from the rule's newest ask), in the market asked.
      brainInputs: inputs.filter((d) => inMarket(d.campaignId)).length,
      refused: week.filter((w) => !landed(w)).length,
    },
    waiting: 0,
    lastRunAt: latest?.createdAt.toISOString() ?? null,
    nextRunAt,
    firstRunAt: null,
    thenRunAt: null,
    schedule: brainScheduleWords(everyTick),
    effect: a.effect,
    archived: false,
  }
}

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BidRuleChange {
  id: string
  at: string
  target: Ref | null
  adGroup: Ref | null
  campaign: Ref | null
  portfolio: Ref | null
  field: string
  /** A bid change in cents (money keys); a state change in `from` / `to`. */
  fromCents?: number | null
  toCents?: number | null
  from?: string | null
  to?: string | null
  who: { kind: 'rule' | 'brain' | 'person'; id: string | null; name: string }
  delivery: string | null
  /** The id POST /advertising/changes/:id/undo takes; null when it cannot be undone (`undoBlocked` says why). */
  changeId: string | null
  undoBlocked: string | null
}

export type HistoryAnswer = { data: { id: string; name: string; days: number; changes: BidRuleChange[] } } | { error: string; status: 404 | 400 }

/** The person's id in a decision's `decidedBy` (`user:<id>`); null for the page's anonymous 'operator' or anything else. */
const personIdOf = (decidedBy: string | null | undefined): string | null => {
  const m = /^user:(.+)$/.exec(String(decidedBy ?? '').trim())
  return m && m[1] !== 'console' && m[1] !== 'anonymous' ? m[1] : null
}

/** GET /advertising/bid-rules/:id/history — a rule's (or the brain's) changes over `days`, newest first. */
export async function bidRuleHistory(id: string, q: { days?: number; market?: string | null; limit?: number }, opts: { now?: Date } = {}): Promise<HistoryAnswer> {
  const now = opts.now ?? new Date()
  const days = Math.min(90, Math.max(1, Math.round(q.days ?? WEEK_DAYS)))
  const limit = Math.min(500, Math.max(1, Math.round(q.limit ?? 200)))
  const market = normMarket(q.market)
  const since = new Date(now.getTime() - days * DAY)
  let name = 'Brain'
  let actors = [BRAIN_ACTOR]
  if (id !== BRAIN_ROW_ID) {
    const rule = await prisma.automationRule.findUnique({ where: { id }, select: { id: true, name: true, domain: true, actions: true } })
    if (!rule || (rule.domain !== 'advertising' && rule.domain !== ARCHIVED_ADS_DOMAIN) || !isBidRule(rule.actions)) return { error: `No bid rule ${id} in this business.`, status: 404 }
    name = rule.name
    actors = ruleActors(id)
  }
  // Its own changes only, filtered in the change feed's query (its actor), never the newest of every writer then filtered.
  const { listChanges } = await import('../ads-changes.service.js')
  const feed = await listChanges({ from: since, to: now, actors, limit: 500 })
  const mine = new Set(actors)
  const items = feed.items.filter((r) => r.actor != null && mine.has(r.actor))

  const book = new RefBook()
  await book.load({
    targets: items.filter((r) => r.entity.type === 'AD_TARGET').map((r) => r.entity.id),
    adGroups: items.filter((r) => r.entity.type === 'AD_GROUP').map((r) => r.entity.id),
    campaigns: items.map((r) => r.campaign?.id ?? (r.entity.type === 'CAMPAIGN' ? r.entity.id : '')).filter(Boolean),
  })

  // A change a person approved (an applied ask of this rule) carries the rule's actor: the person is who decided it.
  const approved = id === BRAIN_ROW_ID ? [] : await prisma.adsRuleSuggestion.findMany({
    where: { ruleId: id, status: 'applied', decidedAt: { gte: new Date(since.getTime() - DAY) } },
    select: { entityId: true, decidedAt: true, decidedBy: true },
  })
  const personOf = (entityId: string, at: Date) => approved.find((s) => s.entityId === entityId && s.decidedAt && Math.abs(s.decidedAt.getTime() - at.getTime()) <= 15 * 60_000)

  const changes: BidRuleChange[] = []
  for (const r of items) {
    const targetId = r.entity.type === 'AD_TARGET' ? r.entity.id : null
    const adGroupId = targetId ? book.targets.get(targetId)?.adGroupId ?? null : r.entity.type === 'AD_GROUP' ? r.entity.id : null
    const campaignId = r.campaign?.id ?? (adGroupId ? book.campaignOfAdGroup(adGroupId) : r.entity.type === 'CAMPAIGN' ? r.entity.id : null)
    const campaign = campaignId ? book.campaigns.get(campaignId) : undefined
    if (market && campaign?.marketplace !== market) continue
    const bid = r.field === 'bid' || r.field === 'defaultBid' || r.field === 'defaultBidCents'
    const num = (v: string | null) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)))
    const person = id === BRAIN_ROW_ID ? undefined : personOf(r.entity.id, r.at)
    changes.push({
      id: r.id,
      at: r.at.toISOString(),
      target: targetId ? book.targetRef(targetId) : null,
      adGroup: adGroupId ? book.adGroupRef(adGroupId) : null,
      campaign: campaignId ? book.campaignRef(campaignId) : null,
      portfolio: campaign?.portfolioId ? book.portfolioRef(campaign.portfolioId) : null,
      field: r.field,
      ...(bid ? { fromCents: num(r.oldValue), toCents: num(r.newValue) } : { from: r.oldValue, to: r.newValue }),
      // R10 — a person is "You", as the bids side names him (bid-owner.ts), never "operator", "console" or a raw id.
      who: person
        ? { kind: 'person', id: personIdOf(person.decidedBy), name: 'You' }
        : id === BRAIN_ROW_ID ? { kind: 'brain', id: BRAIN_ROW_ID, name: 'Brain' } : { kind: 'rule', id, name },
      delivery: r.delivery?.state ?? null,
      changeId: r.undoable ? r.undoActionLogId : null,
      undoBlocked: r.undoable ? null : r.undoBlockedReason ?? null,
    })
    if (changes.length >= limit) break
  }
  return { data: { id, name, days, changes } }
}

