/**
 * ONE BRAIN AB-11 — the `ads-brain` tool's view `harvest` (design 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9; §10: the
 * Owner builds every screen, so this is the read API his page and Claude share). Read only: it changes nothing, in Nexus
 * or at Amazon, and stores nothing.
 *
 *   product × market  the product's harvests (AdsBrainHarvest): each term with its status (shadow, held, asked, written,
 *                     half done, judged, put back), the level it was decided at, where it goes and how that was chosen,
 *                     every source and what became of its negative, the request a person decides, the judgement after the
 *                     attribution window + 72 h; the counts per status; the caps used today and this week; the gaps (half
 *                     done pairs, judgements waiting, worse harvests, a new campaign waiting to go live). A product with
 *                     nothing stored (not enrolled, or its harvest lever OFF) is decided NOW instead — a dry run, never
 *                     stored — so the Owner can read what the harvest would do before he enrolls it.
 *   market            the products with harvests there and their counts per status.
 *
 * Money: the start bid, the candidate's spend, sales, order value and CPC, a new campaign's first budget and the judged
 * ACoS sit under `money` keys, which the tool hides from a person without the ad-spend permission; the words name none.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { productFamily } from './ownership.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { harvestCeiling, inCooldown, loadHarvestMarket } from './harvest-load.js'
import { recordEvidence } from './harvest-run.js'
import { decideHarvests, HARVEST_STATUSES, isHarvestStatus, MARKET_NEW_CAMPAIGNS_PER_WEEK, type HarvestDecision } from './harvest.js'
import { sourcesOf } from './harvest-write.js'

export const DEFAULT_HARVEST_LIMIT = 100
export const MAX_HARVEST_LIMIT = 500
const PRODUCT_NOT_FOUND = 'Product not found'
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The order the view lists harvests in: what waits for someone first, then what stands, then the shadow and the ended. */
const STATUS_ORDER: readonly string[] = ['UNDO_PROPOSED', 'HALF_DONE', 'PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'SHADOW', 'HELD', 'DECLINED', 'REFUSED', 'FAILED', 'UNDONE']

type Json = Record<string, any>
interface Row {
  term: string; isAsin: boolean; status: string; level: string; destinationKind: string; destHow: string | null; destCampaignId: string | null; destAdGroupId: string | null
  bidCents: number | null; keywordTargetId: string | null; landedAt: Date | null; sources: unknown; approvalId: string | null; undoApprovalId: string | null
  attempts: number; lastError: string | null; heldBy: string | null; why: string; evidence: unknown; judgeAfter: Date | null; judgedAt: Date | null; verdict: string | null
  judgement: unknown; decidedAt: Date | null; changedAt: Date | null
}

/** One harvest as the view shows it, money under `money`. Pure. */
export function harvestView(r: Row) {
  const e = (r.evidence ?? {}) as Json
  const dest = (e.destination ?? {}) as Json
  const j = (r.judgement ?? null) as Json | null
  const { money: _destMoney, ...destination } = dest
  const numbers = j?.numbers ? (({ money: _m, ...rest }: Json) => rest)(j.numbers) : null
  return {
    term: r.term, ...(r.isAsin ? { asin: true } : {}), status: r.status, level: r.level,
    decidedAt: r.decidedAt?.toISOString() ?? null, since: r.changedAt?.toISOString() ?? null,
    destination: { ...destination, kind: r.destinationKind, how: r.destHow, campaignId: r.destCampaignId, adGroupId: r.destAdGroupId },
    sources: sourcesOf(r.sources).map((s) => ({ adGroupId: s.adGroupId, campaignId: s.campaignId, clicks: s.clicks, role: s.role, action: s.action, why: s.why, ...(s.result ? { result: s.result } : {}), ...(s.negativeTargetId ? { negativeTargetId: s.negativeTargetId } : {}), ...(s.error ? { error: s.error } : {}) })),
    keywordTargetId: r.keywordTargetId, landedAt: r.landedAt?.toISOString() ?? null,
    request: r.approvalId, ...(r.undoApprovalId ? { undoRequest: r.undoApprovalId } : {}), attempts: r.attempts,
    heldBy: r.heldBy, why: r.why, ...(r.lastError ? { lastError: r.lastError } : {}),
    evidence: { clicks: e.clicks ?? null, orders: e.orders ?? null, impressions: e.impressions ?? null, windowDays: e.windowDays ?? null, cr: e.cr ?? null, harvest: e.harvest ?? null },
    bidWhy: e.bidWhy ?? null,
    ...(e.campaignPlan ? { campaignPlan: { name: e.campaignPlan.name, skus: e.campaignPlan.skus, keywords: e.campaignPlan.keywords, productTargets: e.campaignPlan.productTargets } } : {}),
    judge: { judgeAfter: r.judgeAfter?.toISOString() ?? null, judgedAt: r.judgedAt?.toISOString() ?? null, verdict: r.verdict, ...(j ? { why: j.why ?? null, final: !!j.final, ...(j.wouldUndo ? { wouldUndo: true } : {}), ...(j.undoDeclined ? { undoDeclined: true } : {}), numbers } : {}) },
    money: {
      bidCents: r.bidCents, candidate: e.money ?? null,
      ...(dest.money ? { newCampaign: dest.money } : {}),
      ...(j?.numbers?.money ? { judgement: j.numbers.money } : {}),
    },
  }
}

/** A decision decided now (the dry run) as a row the view shows. Pure. */
function dryRow(d: HarvestDecision): Row {
  const dest = d.destination
  return {
    term: d.term, isAsin: d.isAsin, status: d.act === 'none' ? 'HELD' : 'SHADOW', level: d.level ?? 'OBSERVE', destinationKind: dest.kind,
    destHow: dest.kind === 'NONE' ? null : dest.how, destCampaignId: dest.kind === 'EXISTING' ? dest.campaignId : null, destAdGroupId: dest.kind === 'EXISTING' ? dest.adGroupId : null,
    bidCents: d.bid?.cents ?? null, keywordTargetId: null, landedAt: null, sources: d.sources, approvalId: null, undoApprovalId: null, attempts: 0, lastError: null,
    heldBy: d.heldBy, why: d.why, evidence: recordEvidence(d), judgeAfter: null, judgedAt: null, verdict: null, judgement: null, decidedAt: null, changedAt: null,
  }
}

const sortRows = <T extends { status: string; term: string }>(rows: T[]) =>
  rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.term.localeCompare(b.term))

const ROW_SELECT = {
  term: true, isAsin: true, status: true, level: true, destinationKind: true, destHow: true, destCampaignId: true, destAdGroupId: true, bidCents: true, keywordTargetId: true,
  landedAt: true, sources: true, approvalId: true, undoApprovalId: true, attempts: true, lastError: true, heldBy: true, why: true, evidence: true, judgeAfter: true,
  judgedAt: true, verdict: true, judgement: true, decidedAt: true, changedAt: true,
} as const

/** View harvest. With productId and market: the product's harvests (stored, else decided now). With market alone: the market's. */
export async function brainHarvest(args: { productId?: string; market?: string; status?: string; limit?: number; now?: Date }): Promise<{ data: unknown } | { error: string }> {
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && !market) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view harvest reads one market' }
  if (args.status && !isHarvestStatus(args.status)) return { error: `status is one of ${HARVEST_STATUSES.join(', ')}, not ${args.status}` }
  const limit = Math.max(1, Math.min(MAX_HARVEST_LIMIT, Math.round(args.limit ?? DEFAULT_HARVEST_LIMIT)))
  const now = args.now ?? new Date()
  const ceiling = harvestCeiling()
  const note = ceiling.live
    ? 'LIVE ceiling: at PROPOSE the harvest asks a person (apply-brain-harvest), at AUTO it writes the keyword and its source negatives as one change set; a new campaign is always a request a person approves (D1 = B)'
    : `SHADOW: ${ceiling.why} — every level only logs what it would do; nothing is written to Amazon and nothing is asked`
  if (!args.productId) {
    const [counts, latest] = await Promise.all([
      prisma.adsBrainHarvest.groupBy({ by: ['productId', 'status'], where: { marketplace: market }, _count: { _all: true } }),
      prisma.adsBrainHarvest.groupBy({ by: ['productId'], where: { marketplace: market }, _max: { checkedAt: true, changedAt: true } }),
    ])
    const ids = latest.map((l) => l.productId)
    const names = new Map((ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true, deletedAt: true } }) : []).map((p) => [p.id, p]))
    return {
      data: {
        view: 'harvest', scope: { market }, note, ceiling,
        products: latest.filter((l) => !names.get(l.productId)?.deletedAt).map((l) => ({
          productId: l.productId, name: names.get(l.productId)?.name ?? null, sku: names.get(l.productId)?.sku ?? null,
          checkedAt: l._max.checkedAt?.toISOString() ?? null, changedAt: l._max.changedAt?.toISOString() ?? null,
          counts: Object.fromEntries(HARVEST_STATUSES.map((s) => [s, counts.find((c) => c.productId === l.productId && c.status === s)?._count._all ?? 0])),
        })).sort((a, b) => a.productId.localeCompare(b.productId)),
        next: 'Read one product with productId and market: each harvest with its destination, its sources, its request and its judgement. A product with nothing stored is decided now (a dry run).',
      },
    }
  }
  if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: PRODUCT_NOT_FOUND }
  const family = await productFamily(args.productId)
  if (!family) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
  const root = family.root
  const [enrollment, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: root, marketplace: market }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
  ])
  const settings = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: !!enrollment, overrides })
  const product = {
    productId: root, market, enrolled: !!enrollment,
    levers: Object.fromEntries((['harvest', 'structure', 'negatives'] as const).map((l) => [l, { effective: settings.levers[l].effective, why: settings.levers[l].why }])),
    caps: { harvestPerDay: settings.values.harvestPerDay.value, newCampaignsPerWeek: settings.values.newCampaignsPerWeek.value, skcMax: settings.values.skcMax.value, marketCampaignsPerWeek: MARKET_NEW_CAMPAIGNS_PER_WEEK },
  }
  const where = { productId: root, marketplace: market }
  const stored = await prisma.adsBrainHarvest.count({ where })
  let rows: Row[]
  let source: Record<string, unknown>
  if (stored) {
    rows = await prisma.adsBrainHarvest.findMany({ where: { ...where, ...(args.status ? { status: args.status } : {}) }, select: ROW_SELECT, take: 2000 }) as Row[]
    const checked = await prisma.adsBrainHarvest.aggregate({ where, _max: { checkedAt: true } })
    source = { kind: 'stored', checkedAt: checked._max.checkedAt?.toISOString() ?? null }
  } else {
    const due = { productId: root, market, settings }
    const m = await loadHarvestMarket(market, [due], now)
    const p = m.products.get(root)
    if (!p) return { data: { view: 'harvest', scope: { productId: root, market }, note, ceiling, product, source: { kind: 'dryRun' }, counts: {}, harvests: [], why: m.skipped[0]?.why ?? 'no harvest to decide' } }
    // A dry run never asks or writes: every decision shows as SHADOW (or HELD), whatever its level.
    rows = decideHarvests(p.candidates, { ...p.facts, ceiling: { live: false, why: 'a dry run' } }, now, m.terms.windowDays).map(dryRow)
    if (args.status) rows = rows.filter((r) => r.status === args.status)
    source = { kind: 'dryRun', decidedAt: now.toISOString(), note: 'decided now from what Nexus holds — not stored, nothing asked or written; the daily run stores a harvest only for an enrolled product whose harvest lever is OBSERVE or higher' }
  }
  const all = sortRows(rows)
  const counts = Object.fromEntries(HARVEST_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length]))
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  const tookKeyword = ['PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED', 'DECLINED', 'UNDONE']
  const keywordsToday = all.filter((r) => r.decidedAt && r.decidedAt >= today && tookKeyword.includes(r.status)).length
  const campaignsThisWeek = all.filter((r) => r.destinationKind === 'NEW_CAMPAIGN' && r.decidedAt && r.decidedAt >= weekAgo && tookKeyword.includes(r.status)).length
  return {
    data: {
      view: 'harvest', scope: { productId: root, market }, note, ceiling, product, source, counts,
      ...(args.status ? { status: args.status } : {}),
      caps: {
        keywordsToday: { used: keywordsToday, of: product.caps.harvestPerDay },
        campaignsThisWeek: { used: campaignsThisWeek, of: product.caps.newCampaignsPerWeek },
      },
      shown: Math.min(limit, all.length), of: all.length,
      harvests: all.slice(0, limit).map(harvestView),
      gaps: {
        halfDone: all.filter((r) => r.status === 'HALF_DONE').map((r) => ({ term: r.term, owed: sourcesOf(r.sources).filter((s) => s.action === 'negate' && s.result !== 'landed').map((s) => ({ adGroupId: s.adGroupId, result: s.result ?? null, error: s.error ?? null })) })),
        waitingToJudge: all.filter((r) => (r.status === 'DONE' || r.status === 'HALF_DONE') && (r.verdict == null || r.verdict === 'WAITING')).map((r) => ({ term: r.term, judgeAfter: r.judgeAfter?.toISOString() ?? null })),
        worse: all.filter((r) => r.verdict === 'WORSE').map((r) => ({ term: r.term, status: r.status, undoRequest: r.undoApprovalId })),
        waitingToGoLive: all.filter((r) => r.status === 'CAMPAIGN_BUILT').map((r) => ({ term: r.term, campaignId: r.destCampaignId, heldBy: r.heldBy })),
        inCooldown: all.filter((r) => r.changedAt && inCooldown({ status: r.status, changedAt: r.changedAt }, now)).map((r) => ({ term: r.term, status: r.status })),
      },
      next: all.length > limit ? `${all.length - limit} more: ask with status (one of ${HARVEST_STATUSES.join(', ')}) or a higher limit (at most ${MAX_HARVEST_LIMIT})` : null,
    },
  }
}
