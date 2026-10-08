/**
 * ONE BRAIN AB-15 — auto-undo's pass over the brain's own levers (design 2026-10-08-ads-one-brain/DESIGN.md §2.14, §8 row
 * AB-15). Run by auto-undo's daily run (ads-auto-undo.service.ts runAutoUndo) after its own pass over the automatic bid,
 * budget and placement changes — the bid brain's keyword bids among them, judged exactly as before (BB-10). The rules,
 * the verdicts and what auto-undo does are brain/undo-levers.ts; this module reads the facts, records and acts.
 *
 *   which writes  AdvertisingActionLog rows of the last BRAIN_UNDO_LOOKBACK_DAYS that reached Amazon and were not undone,
 *                 written by the product brain's actors (the money writer's budgets and caps, the state brain's pauses and
 *                 resumes, the negatives run's adds) and the bid brain's campaign writes (a strategy switch outside a stop).
 *                 A harvest pair is AB-11's record (AdsBrainHarvest): its WORSE judgements reach here through brain/harvest-undo.ts.
 *   superseded    a later write of the same field on the entity, or a value that moved since (a negative no longer
 *                 standing): never undone, the judgement closed.
 *   facts         a fixed number of reads per run: the campaigns, their family roots (brain/ownership.ts), the daily
 *                 campaign figures (AmazonAdsDailyPerformance, the window's days), their newest day per market, the state
 *                 brain's newest decision on each paused campaign, the negated terms' search-term rows on the other
 *                 products' campaigns of the market, the portfolios, the kill switches, and each product's ACoS band
 *                 (hours-proposal.ts goalOf, once per product × market).
 *   levels        auto-undo's own (OBSERVE records, PROPOSE asks, AUTO acts) and the same daily cap per market as its bid
 *                 path (one count, `today`); AUTO acts alone only within the lever's ceiling and never on a lever the Owner's
 *                 kill switch stopped — then it asks (decideBrainAction).
 *   asking        through the normal approval gate as "Nexus auto-undo", one request per judgement, with the lever's own
 *                 tool — set-campaign-budget, set-portfolio, enable-ads / pause-ads, retire-negatives,
 *                 set-campaign-settings — so the person approves exactly the write and it runs as that person through the
 *                 tool's own checks. Each later run follows the request: once it ran and the value is back the judgement
 *                 is `undone` (the hold starts); declined or expired, it is closed `held`.
 *   acting        at AUTO, as auto-undo (a safety owner at the write gate): a budget through the Undo's own path
 *                 (reverseJudgedWrite: compare-and-set, the 5-minute window), a re-pause through the campaign status path
 *                 (the gate asked first), a revive through the retire path; the change's own row is marked undone.
 *   the hold      the judgement itself (origin `brain`, action `undone`, actionAt): brain/lever-holds.ts reads it, and each
 *                 lever's run leaves that campaign, portfolio or term for the rule's hold days.
 *   record        one AdsAutoUndoJudgement per change (origin `brain`, lever = the brain lever, direction = the change's kind),
 *                 so A19's reads — automation-detail, automation-activity, the daily report — list them beside the bids.
 *   nothing       no product enrolled (production today): null, after one remembered query — the run's answer and its line
 *                 are exactly what they were before AB-15.
 * In the business the call runs in (row-level security). `dryRun` computes the same and writes nothing.
 */
import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import type { AutomationLevel } from '../../automation/automation-levels.js'
import { normaliseTerm } from '../ads-negation-policy.js'
import { autoUndoThresholds } from '../ads-auto-undo-thresholds.js'
import { AUTO_UNDO_ACTOR, settledThroughOf } from '../ads-auto-undo.service.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { campaignKills, killWords, type BrainKill } from './kill-switch.js'
import type { BrainLever } from './levers.js'
import { anyBrainEnrolled } from './lever-owners.js'
import { resolveCampaignOwnership } from './ownership.js'
import {
  BRAIN_UNDO_LOOKBACK_DAYS, brainChangeOf, brainUndoActorWhere, decideBrainAction, isoDay, judgeBudgetRaise, judgeNegative, judgePause, judgePortfolioRaise,
  judgeResume, judgeStrategySwitch, periodOf, plusDays, ruleOf, sumDays, windowsAround,
  type Band, type BrainAction, type BrainChange, type BrainChangeKind, type BrainJudged, type BrainUndoLever, type BrainVerdict, type Sums,
} from './undo-levers.js'

const DAY_MS = 86_400_000
/** The newest brain writes read in one run. */
export const MAX_BRAIN_CANDIDATES = 2_000
/** The judgements a run's answer lists (the counts cover every one). */
export const BRAIN_SHOWN = 50
/** The approvals' agent run key of auto-undo's requests for a brain lever (its entityId the judgement: asked once). */
export const BRAIN_UNDO_AGENT_KEY = 'ads-auto-undo-brain'
const REQUESTER = 'Nexus auto-undo'
const WAITING = new Set(['pending', 'scheduled', 'approved', 'executing'])

export const LEVER_LABEL: Record<BrainUndoLever, string> = {
  budgets: 'Brain budgets', portfolioCap: 'Brain budgets (portfolio cap)', state: 'Brain pauses', negatives: 'Brain negatives',
  harvest: 'Brain harvest', biddingStrategy: 'Brain bidding strategy',
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const cents = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : null)
const minDay = (a: string, b: string) => (a < b ? a : b)

// ── The harvest's judgements (AB-11) ────────────────────────────────────────────────────────────────────────────────

/** One harvest pair the brain made that AB-11 judged, as auto-undo reads it. */
export interface HarvestUndoFact {
  /** AB-11's record of the pair. */
  id: string
  productId: string
  market: string
  /** The destination campaign (the kill switch and the label read it). */
  campaignId: string | null
  term: string
  landedAt: Date
  /** AB-11's verdict (WORSE is what auto-undo acts on) and its words. */
  verdict: 'WORSE' | 'KEPT' | 'WAITING'
  why: string
}

/** AB-11's side of a harvest undo: its judgements, its own undo of the pair, its request, and whether a pair was put back. */
export interface HarvestUndoProvider {
  judged(since: Date): Promise<HarvestUndoFact[]>
  undo(id: string, run: { actor: string; reason: string }): Promise<{ ok: true; actionLogId: string | null } | { ok: false; reason: string }>
  propose(id: string, why: string): Promise<{ approvalId: string } | { error: string }>
  isUndone(id: string): Promise<boolean>
}

let harvestOverride: HarvestUndoProvider | null = null
/** Tests: stand another side of the harvest in (null: AB-11's own, brain/harvest-undo.ts). */
export function registerHarvestUndo(p: HarvestUndoProvider | null): void { harvestOverride = p }
const harvestSide = async (): Promise<HarvestUndoProvider> => harvestOverride ?? (await import('./harvest-undo.js')).harvestUndo

// ── The run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BrainUndoItem {
  judgementId: string | null
  actionLogId: string
  at: string
  lever: BrainUndoLever
  kind: BrainChangeKind
  by: string
  entity: { type: string; id: string; label: string; market: string | null }
  productId: string | null
  /** Cents for a budget or a cap; null for the others (`from` / `to` say them). Ad money. */
  fromValue: number | null
  toValue: number | null
  from: string | null
  to: string | null
  verdict: BrainVerdict | 'superseded'
  action: BrainAction
  reason: string
  why: string
  undoApprovalId: string | null
  undoActionLogId: string | null
}

type LeverCounts = { judged: number; worse: number; wouldUndo: number; proposed: number; undone: number; held: number }
export interface BrainUndoRun {
  counts: { read: number; skipped: number; superseded: number; waiting: number; judged: number; notEnoughData: number; notWorse: number; worse: number; wouldUndo: number; proposed: number; undone: number; held: number; followed: number }
  byLever: Partial<Record<BrainUndoLever, LeverCounts>>
  /** Why writes of the brain were not judged here, counted (a ladder rung, a cut, a stop's switch …). */
  skipped: Record<string, number>
  items: BrainUndoItem[]
  notes: string[]
}

interface Row {
  id: string; entityType: string; entityId: string; actionType: string; userId: string | null
  payloadBefore: unknown; payloadAfter: unknown; evidence: unknown; createdAt: Date
}

/** What one candidate needs from the facts. */
interface Fact {
  row: Row
  change: BrainChange
  market: string | null
  productId: string | null
  campaignId: string | null
  label: string
  term: string | null
  externalPortfolioId: string | null
  from: string | null
  to: string | null
  fromValue: number | null
  toValue: number | null
  /** Superseded: why (a later write, a value moved); null: it stands. */
  superseded: string | null
  kill: BrainKill | null
}

const emptyRun = (): BrainUndoRun => ({ counts: { read: 0, skipped: 0, superseded: 0, waiting: 0, judged: 0, notEnoughData: 0, notWorse: 0, worse: 0, wouldUndo: 0, proposed: 0, undone: 0, held: 0, followed: 0 }, byLever: {}, skipped: {}, items: [], notes: [] })

/**
 * One pass over the brain's levers in this business (see the header). Null when no product is enrolled: nothing of the
 * brain to judge, and the caller's answer stays as it was. `today` is the bid path's count of today's undos per market (the
 * one daily cap), raised here as this pass acts.
 */
export async function runBrainLeverUndo(opts: { now: Date; dryRun: boolean; level: AutomationLevel; today: Map<string, number> }): Promise<BrainUndoRun | null> {
  if (!(await anyBrainEnrolled())) return null
  const { now, dryRun, level, today } = opts
  const run = emptyRun()
  const since = new Date(now.getTime() - BRAIN_UNDO_LOOKBACK_DAYS * DAY_MS)
  if (!dryRun) run.counts.followed = await followRequests(now)

  const rows: Row[] = await prisma.advertisingActionLog.findMany({
    where: {
      createdAt: { gte: since, lte: now }, amazonResponseStatus: 'SUCCESS', rolledBackAt: null, actionType: { not: 'update_placement_bidding' },
      ...brainUndoActorWhere(),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_BRAIN_CANDIDATES + 1,
    select: { id: true, entityType: true, entityId: true, actionType: true, userId: true, payloadBefore: true, payloadAfter: true, evidence: true, createdAt: true },
  })
  if (rows.length > MAX_BRAIN_CANDIDATES) run.notes.push(`Only the newest ${MAX_BRAIN_CANDIDATES} writes of the brain were read.`)
  const read = rows.slice(0, MAX_BRAIN_CANDIDATES)
  run.counts.read = read.length
  const stored = read.length ? await prisma.adsAutoUndoJudgement.findMany({ where: { actionLogId: { in: read.map((r) => r.id) } } }) : []
  const storedOf = new Map(stored.map((s) => [s.actionLogId, s]))
  const due: Array<{ row: Row; change: BrainChange }> = []
  for (const row of read) {
    const prior = storedOf.get(row.id)
    // A request asked stands (followRequests follows it); a judgement closed is never judged again.
    if (prior?.final || prior?.action === 'proposed') continue
    const change = brainChangeOf(row)
    if ('skip' in change) { run.counts.skipped++; run.skipped[change.skip] = (run.skipped[change.skip] ?? 0) + 1; continue }
    if (row.createdAt.getTime() < now.getTime() - ruleOf(change.lever, change.kind).lookbackDays * DAY_MS) continue
    due.push({ row, change })
  }

  const L = await loadFacts(due, now)
  const items: BrainUndoItem[] = []
  for (const f of [...L.facts].sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime())) {
    const item = await judgeAndAct(f, L, { now, dryRun, level, today, prior: storedOf.get(f.row.id) ?? null }, run)
    if (item) items.push(item)
  }
  for (const item of await harvestPass({ now, dryRun, level, today }, run)) items.push(item)
  if (run.counts.superseded) run.notes.push(`${run.counts.superseded} brain ${run.counts.superseded === 1 ? 'change was' : 'changes were'} superseded by a later change (or its value moved since): never undone.`)
  const order: Record<BrainAction, number> = { undone: 0, proposed: 1, would_undo: 2, held: 3, none: 4 }
  items.sort((a, b) => order[a.action] - order[b.action] || (a.verdict === 'worse' ? 0 : 1) - (b.verdict === 'worse' ? 0 : 1) || b.at.localeCompare(a.at))
  if (items.length > BRAIN_SHOWN) run.notes.push(`The first ${BRAIN_SHOWN} of ${items.length} brain judgements are listed; the counts cover all of them.`)
  run.items = items.slice(0, BRAIN_SHOWN)
  return run
}

// ── The facts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The daily campaign figures and the newest day per market. */
async function campaignFigures(ids: readonly string[], from: string, to: string): Promise<{ days: Map<string, Map<string, Sums>>; asOf: Map<string, string> }> {
  const days = new Map<string, Map<string, Sums>>()
  const asOf = new Map<string, string>()
  if (!ids.length) return { days, asOf }
  const date = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }
  const [rows, fresh] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId', 'date'], where: { entityType: 'CAMPAIGN', localEntityId: { in: [...ids] }, date, ...EXCLUDE_AMS_DAILY }, _sum: { costMicros: true, sales7dCents: true, clicks: true, orders7d: true } }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['marketplace'], where: { entityType: 'CAMPAIGN', date: { gte: date.gte }, ...EXCLUDE_AMS_DAILY }, _max: { date: true } }),
  ])
  for (const r of rows) {
    if (!r.localEntityId) continue
    const m = days.get(r.localEntityId) ?? new Map<string, Sums>()
    m.set(isoDay(r.date), { spendCents: Math.round(Number(r._sum.costMicros ?? 0) / 10_000), salesCents: r._sum.sales7dCents ?? 0, clicks: r._sum.clicks ?? 0, orders: r._sum.orders7d ?? 0 })
    days.set(r.localEntityId, m)
  }
  for (const f of fresh) {
    const market = strategyMarket(f.marketplace)
    if (market && f._max.date) asOf.set(market, isoDay(f._max.date) > (asOf.get(market) ?? '') ? isoDay(f._max.date) : asOf.get(market)!)
  }
  return { days, asOf }
}

/** Sum several campaigns' daily figures into one map (a portfolio). */
function pooled(ids: readonly string[], days: Map<string, Map<string, Sums>>): Map<string, Sums> {
  const out = new Map<string, Sums>()
  for (const id of ids) {
    for (const [d, s] of days.get(id) ?? []) {
      const into = out.get(d) ?? { spendCents: 0, salesCents: 0, clicks: 0, orders: 0 }
      out.set(d, { spendCents: into.spendCents + s.spendCents, salesCents: into.salesCents + s.salesCents, clicks: into.clicks + s.clicks, orders: into.orders + s.orders })
    }
  }
  return out
}

interface Loaded {
  facts: Fact[]
  days: Map<string, Map<string, Sums>>
  asOf: Map<string, string>
  bands: Map<string, Band | null>
  stateNow: Map<string, { action: string; cause: string; why: string; createdAt: Date }>
  elsewhere: Map<string, Map<string, Sums>>
  portfolioCampaigns: Map<string, string[]>
}

const NOTHING_LOADED = (): Loaded => ({ facts: [], days: new Map(), asOf: new Map(), bands: new Map(), stateNow: new Map(), elsewhere: new Map(), portfolioCampaigns: new Map() })

async function loadFacts(due: ReadonlyArray<{ row: Row; change: BrainChange }>, now: Date): Promise<Loaded> {
  if (!due.length) return NOTHING_LOADED()
  const campaignOf = (c: BrainChange): string | null => ('campaignId' in c ? c.campaignId : null)
  const negativeIds = due.flatMap((d) => (d.change.lever === 'negatives' ? [d.change.negativeId] : []))
  const portfolioRowIds = due.flatMap((d) => (d.change.lever === 'portfolioCap' ? [d.change.portfolioRowId] : []))
  const [negatives, portfolios] = await Promise.all([
    negativeIds.length ? prisma.adTarget.findMany({ where: { id: { in: negativeIds } }, select: { id: true, status: true, expressionValue: true, isNegative: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
    portfolioRowIds.length ? prisma.amazonAdsPortfolio.findMany({ where: { id: { in: portfolioRowIds } }, select: { id: true, externalPortfolioId: true, name: true, budgetAmount: true } }) : Promise.resolve([]),
  ])
  const negOf = new Map(negatives.map((n) => [n.id, n]))
  const portOf = new Map(portfolios.map((p) => [p.id, p]))
  const portfolioCampaigns = new Map<string, string[]>()
  if (portfolios.length) {
    const rows = await prisma.campaign.findMany({ where: { portfolioId: { in: portfolios.map((p) => p.externalPortfolioId) }, status: { not: 'ARCHIVED' } }, select: { id: true, portfolioId: true } })
    for (const r of rows) if (r.portfolioId) portfolioCampaigns.set(r.portfolioId, [...(portfolioCampaigns.get(r.portfolioId) ?? []), r.id])
  }
  const changeCampaigns = due.map((d) => campaignOf(d.change) ?? (d.change.lever === 'negatives' ? negOf.get(d.change.negativeId)?.adGroup?.campaignId ?? null : null)).filter((x): x is string => !!x)
  const allCampaigns = [...new Set([...changeCampaigns, ...[...portfolioCampaigns.values()].flat()])]
  const [campaigns, owners] = await Promise.all([
    allCampaigns.length ? prisma.campaign.findMany({ where: { id: { in: allCampaigns } }, select: { id: true, name: true, marketplace: true, status: true, dailyBudget: true, biddingStrategy: true } }) : Promise.resolve([]),
    resolveCampaignOwnership(allCampaigns),
  ])
  const campOf = new Map(campaigns.map((c) => [c.id, c]))
  const productOf = (campaignId: string | null): string | null => {
    const o = campaignId ? owners.get(campaignId) : null
    return o?.owner.kind === 'product' ? o.owner.productId : null
  }

  // Later writes of the same field (superseded), one query.
  const minAt = new Date(Math.min(...due.map((d) => d.row.createdAt.getTime())))
  const later = await prisma.advertisingActionLog.findMany({
    where: {
      createdAt: { gt: minAt }, OR: [{ amazonResponseStatus: null }, { amazonResponseStatus: { not: 'FAILED' } }],
      AND: [{ OR: [{ entityType: 'CAMPAIGN', entityId: { in: [...new Set(due.flatMap((d) => (d.row.entityType === 'CAMPAIGN' ? [d.row.entityId] : [])))] } }, { entityType: 'PORTFOLIO', entityId: { in: portfolioRowIds } }] }],
    },
    select: { id: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true },
  })
  const fieldMoved = (r: { payloadBefore: unknown; payloadAfter: unknown }, field: string) => String(obj(r.payloadBefore)[field] ?? '') !== String(obj(r.payloadAfter)[field] ?? '')
  const laterWrite = (row: Row, field: string) => later.some((l) => l.id !== row.id && l.entityType === row.entityType && l.entityId === row.entityId && l.createdAt > row.createdAt && fieldMoved(l, field))

  const kills = await campaignKills(allCampaigns, ['budgets', 'portfolioCap', 'state', 'negatives', 'biddingStrategy'] as BrainLever[])
  const facts: Fact[] = []
  for (const { row, change } of due) {
    let campaignId = campaignOf(change)
    let term: string | null = null
    let externalPortfolioId: string | null = null
    let superseded: string | null = null
    let from: string | null = null
    let to: string | null = null
    let fromValue: number | null = null
    let toValue: number | null = null
    let label = row.entityId
    let kill: BrainKill | null = null
    if (change.lever === 'budgets') {
      const c = campOf.get(change.campaignId)
      fromValue = change.fromCents; toValue = change.toCents
      if (!c || Math.abs((cents(c.dailyBudget) ?? -1) - change.toCents) > 0) superseded = 'its daily budget moved since'
      if (laterWrite(row, 'dailyBudget')) superseded = 'a later change of its daily budget superseded it'
      kill = kills.get(change.campaignId)?.budgets ?? null
    } else if (change.lever === 'portfolioCap') {
      const p = portOf.get(change.portfolioRowId)
      externalPortfolioId = p?.externalPortfolioId ?? change.externalPortfolioId
      fromValue = change.fromCents; toValue = change.toCents
      label = p ? `portfolio "${p.name}"` : `portfolio ${change.portfolioRowId}`
      if (!p || cents(p.budgetAmount) !== change.toCents) superseded = 'its cap moved since'
      if (laterWrite(row, 'budgetAmount')) superseded = 'a later change of its cap superseded it'
      const members = externalPortfolioId ? portfolioCampaigns.get(externalPortfolioId) ?? [] : []
      campaignId = members[0] ?? null
      kill = members.map((id) => kills.get(id)?.portfolioCap).find((k): k is BrainKill => !!k) ?? null
    } else if (change.lever === 'state') {
      const c = campOf.get(change.campaignId)
      from = change.from; to = change.to
      if (!c || c.status !== change.to) superseded = `its status moved since (${c?.status ?? 'not found'})`
      if (laterWrite(row, 'status')) superseded = 'a later change of its status superseded it'
      kill = kills.get(change.campaignId)?.state ?? null
    } else if (change.lever === 'negatives') {
      const n = negOf.get(change.negativeId)
      campaignId = n?.adGroup?.campaignId ?? null
      term = n?.expressionValue ? normaliseTerm(n.expressionValue) : change.text ? normaliseTerm(change.text) : null
      label = term ? `negative "${term}"` : `negative ${change.negativeId}`
      if (!n || !n.isNegative || n.status === 'ARCHIVED') superseded = 'the negative no longer stands (retired since)'
      kill = campaignId ? kills.get(campaignId)?.negatives ?? null : null
    } else {
      const c = campOf.get(change.campaignId)
      from = change.from; to = change.to
      if (!c || String(c.biddingStrategy ?? '') !== change.to) superseded = 'its bidding strategy moved since'
      if (laterWrite(row, 'biddingStrategy')) superseded = 'a later change of its bidding strategy superseded it'
      kill = kills.get(change.campaignId)?.biddingStrategy ?? null
    }
    const c = campaignId ? campOf.get(campaignId) : null
    if (change.lever !== 'portfolioCap' && change.lever !== 'negatives') label = c ? `campaign "${c.name}"` : `campaign ${campaignId}`
    else if (change.lever === 'negatives' && c) label = `${label} in "${c.name}"`
    facts.push({ row, change, market: strategyMarket(c?.marketplace ?? null), productId: productOf(campaignId), campaignId, label, term, externalPortfolioId, from, to, fromValue, toValue, superseded, kill })
  }

  // The figures: the widest span any candidate needs.
  const standing = facts.filter((f) => !f.superseded)
  const firstDay = standing.length ? plusDays(isoDay(new Date(Math.min(...standing.map((f) => f.row.createdAt.getTime())))), -31) : isoDay(now)
  const { days, asOf } = await campaignFigures(allCampaigns, firstDay, isoDay(now))

  // Each product's ACoS band (once per product × market).
  const bands = new Map<string, Band | null>()
  const { goalOf } = await import('./hours-proposal.js')
  for (const f of standing) {
    if (!f.productId || !f.market) continue
    const key = `${f.productId}|${f.market}`
    if (bands.has(key)) continue
    try {
      const g = await goalOf(f.productId, f.market)
      bands.set(key, g ? { aim: g.aim, lo: g.lo, hi: g.hi } : null)
    } catch (err) {
      bands.set(key, null)
      logger.warn('[ads-auto-undo] could not read a product\'s ACoS band — judged without it', { productId: f.productId, error: String(err).slice(0, 200) })
    }
  }

  // The state brain's newest decision on each paused campaign since its pause.
  const pauses = standing.filter((f) => f.change.lever === 'state' && f.change.kind === 'pause')
  const stateNow = new Map<string, { action: string; cause: string; why: string; createdAt: Date }>()
  if (pauses.length) {
    const rows = await prisma.adsBrainStateDecision.findMany({
      where: { campaignId: { in: pauses.map((f) => f.campaignId!).filter(Boolean) }, createdAt: { gte: new Date(Math.min(...pauses.map((f) => f.row.createdAt.getTime()))) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { campaignId: true, action: true, cause: true, why: true, createdAt: true },
    })
    for (const r of rows) if (!stateNow.has(r.campaignId)) stateNow.set(r.campaignId, r)
  }

  // The negated terms on the other products' campaigns of each market (search terms, by query and day).
  const elsewhere = new Map<string, Map<string, Sums>>()
  const negs = standing.filter((f) => f.change.lever === 'negatives' && f.term && f.market && f.productId)
  for (const market of [...new Set(negs.map((f) => f.market!))]) {
    const inMarket = negs.filter((f) => f.market === market)
    const campaignsOfMarket = (await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: { not: null } }, select: { id: true, marketplace: true, externalCampaignId: true } }))
      .filter((c) => strategyMarket(c.marketplace) === market)
    const marketOwners = await resolveCampaignOwnership(campaignsOfMarket.map((c) => c.id))
    const terms = [...new Set(inMarket.map((f) => f.term!))]
    const span = { gte: new Date(`${isoDay(new Date(Math.min(...inMarket.map((f) => f.row.createdAt.getTime()))))}T00:00:00Z`), lte: new Date(`${isoDay(now)}T00:00:00Z`) }
    const rows = campaignsOfMarket.length ? await prisma.amazonAdsSearchTerm.groupBy({
      by: ['campaignId', 'query', 'date'],
      where: { campaignId: { in: campaignsOfMarket.map((c) => c.externalCampaignId!) }, date: span, OR: terms.map((q) => ({ query: { equals: q, mode: 'insensitive' as const } })) },
      _sum: { costMicros: true, sales7dCents: true, clicks: true, orders7d: true },
    }) : []
    const productsOfExt = new Map(campaignsOfMarket.map((c) => [c.externalCampaignId!, marketOwners.get(c.id)?.productIds ?? []]))
    for (const f of inMarket) {
      const m = new Map<string, Sums>()
      for (const r of rows) {
        if (normaliseTerm(r.query) !== f.term || (productsOfExt.get(r.campaignId) ?? []).includes(f.productId!)) continue
        const d = isoDay(r.date)
        const into = m.get(d) ?? { spendCents: 0, salesCents: 0, clicks: 0, orders: 0 }
        m.set(d, { spendCents: into.spendCents + Math.round(Number(r._sum.costMicros ?? 0) / 10_000), salesCents: into.salesCents + (r._sum.sales7dCents ?? 0), clicks: into.clicks + (r._sum.clicks ?? 0), orders: into.orders + (r._sum.orders7d ?? 0) })
      }
      elsewhere.set(f.row.id, m)
    }
  }
  return { facts, days, asOf, bands, stateNow, elsewhere, portfolioCampaigns }
}

// ── Judging and acting ──────────────────────────────────────────────────────────────────────────────────────────────

interface PassCtx { now: Date; dryRun: boolean; level: AutomationLevel; today: Map<string, number> }
type Prior = Awaited<ReturnType<typeof prisma.adsAutoUndoJudgement.findMany>>[number] | null

function count(run: BrainUndoRun, lever: BrainUndoLever, key: keyof LeverCounts) {
  const c = (run.byLever[lever] ??= { judged: 0, worse: 0, wouldUndo: 0, proposed: 0, undone: 0, held: 0 })
  c[key]++
}

/** The verdict on one standing change, or null while it waits for its days. */
function verdictOf(f: Fact, L: Loaded, now: Date): { judged: BrainJudged; window: Obj; final: boolean } | null {
  const t = autoUndoThresholds(f.market)
  const rule = ruleOf(f.change.lever, f.change.kind)
  const settled = minDay(settledThroughOf(now, t.settleHours), f.market ? L.asOf.get(f.market) ?? '0000-00-00' : '0000-00-00')
  const d = isoDay(f.row.createdAt)
  const band = f.productId && f.market ? L.bands.get(`${f.productId}|${f.market}`) ?? null : null
  const pastLookback = now.getTime() - f.row.createdAt.getTime() >= rule.lookbackDays * DAY_MS
  const own = f.campaignId ? L.days.get(f.campaignId) : undefined
  if (f.change.lever === 'state' && f.change.kind === 'pause') {
    if (now.getTime() - f.row.createdAt.getTime() < rule.minDays * DAY_MS) return null
    const s = f.campaignId ? L.stateNow.get(f.campaignId) : undefined
    const after = s && s.createdAt > f.row.createdAt ? s : undefined
    const causeEnded = after ? after.action === 'resume' || after.cause === 'none' : null
    const before = periodOf(sumDays(own, plusDays(d, -7), plusDays(d, -1)), 7)
    return { judged: judgePause({ causeEnded, causeWhy: after?.why ?? null, before }), window: { before: { from: plusDays(d, -7), to: plusDays(d, -1) }, stateDecision: after ? { action: after.action, cause: after.cause, at: after.createdAt.toISOString() } : null, beforeFigures: before }, final: pastLookback }
  }
  const w = windowsAround(d, settled, rule)
  if (!w) return pastLookback ? { judged: { verdict: 'not_enough_data', why: `no ${rule.minDays} settled days of figures after it within ${rule.lookbackDays} days` }, window: {}, final: true } : null
  const done = w.days >= rule.maxDays || pastLookback
  const p = (days: Map<string, Sums> | undefined, r: { from: string; to: string }) => periodOf(sumDays(days, r.from, r.to), w.days)
  if (f.change.lever === 'budgets') {
    const before = p(own, w.before); const after = p(own, w.after)
    return { judged: judgeBudgetRaise({ before, after, band, t }), window: { ...w, beforeFigures: before, afterFigures: after }, final: done }
  }
  if (f.change.lever === 'state') {
    const after = p(own, w.after)
    return { judged: judgeResume({ after, band, t }), window: { ...w, afterFigures: after }, final: done }
  }
  if (f.change.lever === 'biddingStrategy') {
    const before = p(own, w.before); const after = p(own, w.after)
    return { judged: judgeStrategySwitch({ before, after, to: f.to ?? '', t }), window: { ...w, beforeFigures: before, afterFigures: after }, final: done }
  }
  if (f.change.lever === 'negatives') {
    const e = p(L.elsewhere.get(f.row.id), w.after)
    return { judged: judgeNegative({ elsewhere: e, band }), window: { ...w, elsewhere: e }, final: done }
  }
  if (f.change.lever === 'portfolioCap') {
    const members = f.externalPortfolioId ? L.portfolioCampaigns.get(f.externalPortfolioId) ?? [] : []
    const all = pooled(members, L.days)
    const monthStart = `${settled.slice(0, 7)}-01`
    const month = sumDays(all, monthStart, settled)
    const sinceRaise = p(all, w.after)
    return { judged: judgePortfolioRaise({ monthSpendCents: month.spendCents, oldCapCents: f.fromValue ?? 0, since: sinceRaise, band, t }), window: { ...w, monthSpendCents: month.spendCents, sinceFigures: sinceRaise }, final: done }
  }
  return null
}

async function judgeAndAct(f: Fact, L: Loaded, ctx: PassCtx & { prior: Prior }, run: BrainUndoRun): Promise<BrainUndoItem | null> {
  const lever = f.change.lever
  const base = {
    actionLogId: f.row.id, at: f.row.createdAt.toISOString(), lever, kind: f.change.kind, by: LEVER_LABEL[lever],
    entity: { type: f.row.entityType, id: f.row.entityId, label: f.label, market: f.market }, productId: f.productId,
    fromValue: f.fromValue, toValue: f.toValue, from: f.from, to: f.to,
  }
  if (f.superseded) {
    run.counts.superseded++
    if (ctx.prior && !ctx.dryRun) await prisma.adsAutoUndoJudgement.update({ where: { id: ctx.prior.id }, data: { verdict: 'superseded', final: true, checkedAt: ctx.now, actionReason: f.superseded } }).catch(() => {})
    return null
  }
  const v = verdictOf(f, L, ctx.now)
  if (!v) { run.counts.waiting++; return null }
  run.counts.judged++
  count(run, lever, 'judged')
  if (v.judged.verdict === 'not_enough_data') run.counts.notEnoughData++
  else if (v.judged.verdict === 'not_worse') run.counts.notWorse++
  else { run.counts.worse++; count(run, lever, 'worse') }

  const rule = ruleOf(lever, f.change.kind)
  const t = autoUndoThresholds(f.market)
  const capKey = f.market ?? '?'
  const used = ctx.today.get(capKey) ?? 0
  const prior = ctx.prior
  const counted = prior?.action === 'would_undo' && ctx.level === 'OBSERVE'
  const decided = decideBrainAction({ verdict: v.judged.verdict, level: ctx.level, rule, kill: f.kill ? killWords(f.kill) : null, capLeft: counted ? 1 : t.maxUndosPerDay - used, cap: t.maxUndosPerDay, market: f.market })
  let action: BrainAction = decided.action
  let reason = decided.reason
  if (!counted && (action === 'would_undo' || action === 'proposed' || action === 'undone')) ctx.today.set(capKey, used + 1)

  const evidence = {
    v: 1, pass: 'brain', lever, kind: f.change.kind, productId: f.productId, campaignId: f.campaignId, term: f.term, externalPortfolioId: f.externalPortfolioId,
    from: f.from, to: f.to, window: v.window, band: f.productId && f.market ? L.bands.get(`${f.productId}|${f.market}`) ?? null : null,
    why: v.judged.why, kill: f.kill ? killWords(f.kill) : null,
    rule: { metric: rule.metric, worse: rule.worse, undo: rule.undo, hold: rule.hold, holdDays: rule.holdDays, ceiling: rule.ceiling },
    thresholds: { minClicks: t.minClicks, minSpendCents: t.minSpendCents, acosPointsUp: t.acosPointsUp, spendUpPct: t.spendUpPct, settleHours: t.settleHours, maxUndosPerDay: t.maxUndosPerDay },
  }
  let judgementId = prior?.id ?? null
  let undoApprovalId: string | null = prior?.undoApprovalId ?? null
  let undoActionLogId: string | null = prior?.undoActionLogId ?? null
  const final = action === 'undone' || v.final
  if (!ctx.dryRun) {
    const data = {
      actor: f.row.userId ?? 'unknown', origin: 'brain', originLabel: LEVER_LABEL[lever], approvalId: null,
      entityType: f.row.entityType, entityId: f.row.entityId, entityLabel: f.label, marketplace: f.market,
      lever, direction: f.change.kind, fromValue: f.fromValue, toValue: f.toValue, changedAt: f.row.createdAt,
      verdict: v.judged.verdict, outcome: null, evidence: evidence as unknown as Prisma.InputJsonValue, level: ctx.level, checkedAt: ctx.now,
      action, actionReason: reason, ...(action !== (prior?.action ?? 'none') ? { actionAt: ctx.now } : {}), final: action === 'proposed' ? false : final,
    }
    const row = prior
      ? await prisma.adsAutoUndoJudgement.update({ where: { id: prior.id }, data, select: { id: true } })
      : await prisma.adsAutoUndoJudgement.upsert({ where: { workspace_actionLogId: workspaceKey({ actionLogId: f.row.id }) }, create: { actionLogId: f.row.id, ...data }, update: data, select: { id: true } })
    judgementId = row.id
    if (action === 'proposed') {
      const asked = await askOnce(row.id, requestOf(f, `Auto-undo ${row.id}: ${v.judged.why}`))
      if ('approvalId' in asked) undoApprovalId = asked.approvalId
      else { action = 'held'; reason = `the request to undo it could not be queued: ${asked.error}` }
    } else if (action === 'undone') {
      const done = await undoNow(f, `Auto-undo ${row.id}: ${v.judged.why}`)
      if ('reason' in done) { action = 'held'; reason = done.reason }
      else undoActionLogId = done.actionLogId
    }
    if (action !== data.action || undoApprovalId !== (prior?.undoApprovalId ?? null) || undoActionLogId !== (prior?.undoActionLogId ?? null)) {
      await prisma.adsAutoUndoJudgement.update({ where: { id: row.id }, data: { action, actionReason: reason, undoApprovalId, undoActionLogId, actionAt: ctx.now, final: action === 'proposed' ? false : action === 'held' ? v.final : final } })
    }
  }
  if (action === 'would_undo') { run.counts.wouldUndo++; count(run, lever, 'wouldUndo') }
  else if (action === 'proposed') { run.counts.proposed++; count(run, lever, 'proposed') }
  else if (action === 'undone') { run.counts.undone++; count(run, lever, 'undone') }
  else if (action === 'held') { run.counts.held++; count(run, lever, 'held') }
  return { ...base, judgementId, verdict: v.judged.verdict, action, reason, why: v.judged.why, undoApprovalId, undoActionLogId }
}

const STRATEGY_WORD: Record<string, string> = { LEGACY_FOR_SALES: 'legacyForSales', AUTO_FOR_SALES: 'autoForSales', MANUAL: 'manual' }
const shortWhy = (text: string) => (text.length <= 300 ? text : `${text.slice(0, 297)}...`)

/** The lever's own tool and its args that put the change back (what a person approves). */
export function requestOf(f: Pick<Fact, 'change' | 'externalPortfolioId' | 'from'>, why: string): { tool: string; args: Record<string, unknown> } {
  const w = shortWhy(why)
  const c = f.change
  if (c.lever === 'budgets') return { tool: 'set-campaign-budget', args: { campaigns: [{ campaignId: c.campaignId, dailyBudgetCents: c.fromCents }], why: w } }
  if (c.lever === 'portfolioCap') return { tool: 'set-portfolio', args: { op: 'update', portfolioId: f.externalPortfolioId ?? c.portfolioRowId, cap: { amountCents: c.fromCents, policy: 'monthly' }, why: w } }
  if (c.lever === 'state') return c.kind === 'pause'
    ? { tool: 'enable-ads', args: { campaignIds: [c.campaignId], includePeoplesPauses: true, why: w } }
    : { tool: 'pause-ads', args: { campaignIds: [c.campaignId], why: w } }
  if (c.lever === 'negatives') return { tool: 'retire-negatives', args: { negativeIds: [c.negativeId], why: w } }
  return { tool: 'set-campaign-settings', args: { campaignIds: [c.campaignId], biddingStrategy: STRATEGY_WORD[c.from] ?? c.from, why: w } }
}

/** One request per judgement, through the normal approval gate (forceAsk): an earlier one for it is the answer. */
async function askOnce(judgementId: string, req: { tool: string; args: Record<string, unknown> }): Promise<{ approvalId: string } | { error: string }> {
  const earlier = await prisma.agentApproval.findFirst({ where: { agentRun: { agentKey: BRAIN_UNDO_AGENT_KEY, entityId: judgementId } }, orderBy: { requestedAt: 'desc' }, select: { id: true } })
  if (earlier) return { approvalId: earlier.id }
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const run = await prisma.agentRun.create({ data: { agentKey: BRAIN_UNDO_AGENT_KEY, entityId: judgementId, trigger: 'schedule', status: 'running', input: req as unknown as Prisma.InputJsonValue } })
  const asked = await runOrQueueTool(req.tool, req.args, systemPrincipal(REQUESTER), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: (asked.error ?? 'not queued').slice(0, 500) },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

/** AUTO: put the change back as auto-undo through the lever's own write path; the change's row marked undone. */
async function undoNow(f: Fact, reason: string): Promise<{ actionLogId: string | null } | { reason: string }> {
  const c = f.change
  const markUndone = () => prisma.advertisingActionLog.update({ where: { id: f.row.id }, data: { rolledBackAt: new Date(), rollbackReason: reason.slice(0, 500) } }).catch(() => {})
  try {
    if (c.lever === 'budgets') {
      const { reverseJudgedWrite } = await import('../rollback.service.js')
      const out = await reverseJudgedWrite({ actionLogId: f.row.id, actor: AUTO_UNDO_ACTOR, reason })
      return 'reason' in out ? { reason: out.reason } : { actionLogId: out.actionLogId }
    }
    if (c.lever === 'state' && c.kind === 'resume') {
      const { updateCampaignWithSync } = await import('../ads-mutation.service.js')
      const out = await updateCampaignWithSync({ campaignId: c.campaignId, patch: { status: 'PAUSED' }, actor: AUTO_UNDO_ACTOR, reason: reason.slice(0, 480), askGate: true })
      if (!out.ok || out.error === 'no_changes') return { reason: out.ok ? 'it is paused already' : `the pause was refused: ${out.error ?? 'refused'}` }
      await markUndone()
      return { actionLogId: (out as { actionLogId?: string | null }).actionLogId ?? null }
    }
    if (c.lever === 'negatives') {
      const { retireNegatives } = await import('../negatives-retire.service.js')
      const out = await retireNegatives({ adTargetIds: [c.negativeId], actor: AUTO_UNDO_ACTOR, retireReason: reason.slice(0, 480) })
      const o = out.outcomes[0]
      if (!o || (o.kind !== 'retired' && o.kind !== 'removed_local')) return { reason: `the revive was not done: ${o ? `${o.kind}${o.reason ? ` — ${o.reason}` : ''}` : 'no outcome'}` }
      await markUndone()
      return { actionLogId: o.actionLogId }
    }
    return { reason: 'this undo always goes to a person' }
  } catch (err) {
    logger.warn('[ads-auto-undo] a brain undo failed', { actionLogId: f.row.id, lever: c.lever, error: String(err).slice(0, 200) })
    return { reason: `the undo failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` }
  }
}

/** Is the value the change replaced back now (a person's approved request ran)? */
async function valueIsBack(j: { lever: string; entityId: string; fromValue: number | null; evidence: unknown }): Promise<boolean> {
  const e = obj(j.evidence)
  if (j.lever === 'budgets') { const c = await prisma.campaign.findUnique({ where: { id: j.entityId }, select: { dailyBudget: true } }); return !!c && cents(c.dailyBudget) === j.fromValue }
  if (j.lever === 'portfolioCap') { const p = await prisma.amazonAdsPortfolio.findUnique({ where: { id: j.entityId }, select: { budgetAmount: true } }); return !!p && cents(p.budgetAmount) === j.fromValue }
  if (j.lever === 'state') { const c = await prisma.campaign.findUnique({ where: { id: j.entityId }, select: { status: true } }); return !!c && c.status === str(e.from) }
  if (j.lever === 'biddingStrategy') { const c = await prisma.campaign.findUnique({ where: { id: j.entityId }, select: { biddingStrategy: true } }); return !!c && String(c.biddingStrategy ?? '') === str(e.from) }
  if (j.lever === 'negatives') { const n = await prisma.adTarget.findUnique({ where: { id: j.entityId }, select: { status: true } }); return !n || n.status === 'ARCHIVED' }
  if (j.lever === 'harvest') return (await harvestSide()).isUndone(j.entityId)
  return false
}

/**
 * Follow the requests auto-undo asked for a brain lever: one that ran with the value back is `undone` (its hold starts
 * now); one that ran without it, or that a person declined or let expire, is closed `held`. How many it closed.
 */
async function followRequests(now: Date): Promise<number> {
  const open = await prisma.adsAutoUndoJudgement.findMany({ where: { origin: 'brain', action: 'proposed', final: false }, select: { id: true, lever: true, entityId: true, fromValue: true, evidence: true, undoApprovalId: true } })
  if (!open.length) return 0
  const ids = open.map((j) => j.undoApprovalId).filter((x): x is string => !!x)
  const approvals = new Map((ids.length ? await prisma.agentApproval.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }) : []).map((a) => [a.id, a.status]))
  let closed = 0
  for (const j of open) {
    const status = j.undoApprovalId ? approvals.get(j.undoApprovalId) ?? null : null
    if (status && WAITING.has(status)) continue
    let data: Prisma.AdsAutoUndoJudgementUpdateInput
    if (status === 'executed' && await valueIsBack(j)) data = { action: 'undone', actionAt: now, actionReason: `a person approved request ${j.undoApprovalId}: put back`, final: true, checkedAt: now }
    else if (status === 'executed') data = { action: 'held', actionAt: now, actionReason: `request ${j.undoApprovalId} ran, but the value is not back (it moved, or the write was refused)`, final: true, checkedAt: now }
    else data = { action: 'held', actionAt: now, actionReason: status ? `a person ${status === 'rejected' ? 'declined' : `let it ${status === 'expired' ? 'expire' : status}:`} request ${j.undoApprovalId}` : 'its request is no longer in Nexus', final: true, checkedAt: now }
    await prisma.adsAutoUndoJudgement.update({ where: { id: j.id }, data })
    closed++
  }
  return closed
}

/** The harvest's judgements (AB-11) through its provider: the same levels, cap and record. */
async function harvestPass(ctx: PassCtx, run: BrainUndoRun): Promise<BrainUndoItem[]> {
  const p = await harvestSide()
  const items: BrainUndoItem[] = []
  const facts = await p.judged(new Date(ctx.now.getTime() - ruleOf('harvest', 'harvest').lookbackDays * DAY_MS))
  const keys = facts.map((h) => `harvest:${h.id}`)
  const stored = new Map((keys.length ? await prisma.adsAutoUndoJudgement.findMany({ where: { actionLogId: { in: keys } } }) : []).map((s) => [s.actionLogId, s]))
  const kills = await campaignKills(facts.map((h) => h.campaignId).filter((x): x is string => !!x), ['harvest'])
  for (const h of facts) {
    const key = `harvest:${h.id}`
    const prior = stored.get(key) ?? null
    if (prior?.final || prior?.action === 'proposed' || h.verdict === 'WAITING') { if (h.verdict === 'WAITING') run.counts.waiting++; continue }
    run.counts.judged++
    count(run, 'harvest', 'judged')
    const verdict: BrainVerdict = h.verdict === 'WORSE' ? 'worse' : 'not_worse'
    if (verdict === 'worse') { run.counts.worse++; count(run, 'harvest', 'worse') } else run.counts.notWorse++
    const t = autoUndoThresholds(h.market)
    const used = ctx.today.get(h.market) ?? 0
    const kill = h.campaignId ? kills.get(h.campaignId)?.harvest ?? null : null
    const decided = decideBrainAction({ verdict, level: ctx.level, rule: ruleOf('harvest', 'harvest'), kill: kill ? killWords(kill) : null, capLeft: t.maxUndosPerDay - used, cap: t.maxUndosPerDay, market: h.market })
    let action = decided.action
    let reason = decided.reason
    if (action === 'would_undo' || action === 'proposed' || action === 'undone') ctx.today.set(h.market, used + 1)
    let undoApprovalId: string | null = null
    let undoActionLogId: string | null = null
    let judgementId: string | null = prior?.id ?? null
    if (!ctx.dryRun) {
      const data = {
        actor: 'automation:ads-brain-harvest', origin: 'brain', originLabel: LEVER_LABEL.harvest, approvalId: null, entityType: 'HARVEST', entityId: h.id,
        entityLabel: `harvest of "${h.term}"`, marketplace: h.market, lever: 'harvest', direction: 'harvest', fromValue: null, toValue: null, changedAt: h.landedAt,
        verdict, outcome: null, evidence: { v: 1, pass: 'brain', lever: 'harvest', kind: 'harvest', productId: h.productId, campaignId: h.campaignId, term: h.term, why: h.why, kill: kill ? killWords(kill) : null } as Prisma.InputJsonValue,
        level: ctx.level, checkedAt: ctx.now, action, actionReason: reason, actionAt: ctx.now, final: action !== 'proposed' && (action === 'undone' || h.verdict === 'KEPT'),
      }
      const row = await prisma.adsAutoUndoJudgement.upsert({ where: { workspace_actionLogId: workspaceKey({ actionLogId: key }) }, create: { actionLogId: key, ...data }, update: data, select: { id: true } })
      judgementId = row.id
      if (action === 'proposed') {
        const asked = await p.propose(h.id, `Auto-undo ${row.id}: ${h.why}`)
        if ('approvalId' in asked) undoApprovalId = asked.approvalId
        else { action = 'held'; reason = `the request to undo it could not be queued: ${asked.error}` }
      } else if (action === 'undone') {
        const done = await p.undo(h.id, { actor: AUTO_UNDO_ACTOR, reason: `Auto-undo ${row.id}: ${h.why}` })
        if ('reason' in done) { action = 'held'; reason = done.reason }
        else undoActionLogId = done.actionLogId
      }
      await prisma.adsAutoUndoJudgement.update({ where: { id: row.id }, data: { action, actionReason: reason, undoApprovalId, undoActionLogId, final: action !== 'proposed' && (action === 'undone' || action === 'held' || h.verdict === 'KEPT') } })
    }
    if (action === 'would_undo') { run.counts.wouldUndo++; count(run, 'harvest', 'wouldUndo') }
    else if (action === 'proposed') { run.counts.proposed++; count(run, 'harvest', 'proposed') }
    else if (action === 'undone') { run.counts.undone++; count(run, 'harvest', 'undone') }
    else if (action === 'held') { run.counts.held++; count(run, 'harvest', 'held') }
    items.push({
      judgementId, actionLogId: key, at: h.landedAt.toISOString(), lever: 'harvest', kind: 'harvest', by: LEVER_LABEL.harvest,
      entity: { type: 'HARVEST', id: h.id, label: `harvest of "${h.term}"`, market: h.market }, productId: h.productId, fromValue: null, toValue: null, from: null, to: null,
      verdict, action, reason, why: h.why, undoApprovalId, undoActionLogId,
    })
  }
  return items
}

