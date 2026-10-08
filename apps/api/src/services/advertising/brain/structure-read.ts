/**
 * ONE BRAIN AB-16 — the `ads-brain` tool's view `structure` (design 2026-10-08-ads-one-brain/DESIGN.md §2.9, §2.6 N2, §10
 * D1 = B and D2 = A; §10: the Owner builds every screen, so this is the read API his page and Claude share). Read only: it
 * changes nothing, in Nexus or at Amazon, and stores nothing.
 *
 *   product × market  the product's structure proposals decided NOW (a dry run of the weekly decision, never stored — a
 *                     product not enrolled is decided as if at the default level) beside the proposals the brain stored:
 *                     each single-keyword campaign (its reasons: orders share, its own hour curve, the playbook's winners
 *                     view), each split of a shared campaign with its migration plan, the move into the product's portfolio
 *                     — with its status (shadow, held, asked, built, its go-live asked, live, done, declined, failed), the
 *                     builder and its request, who owns each lever of the new campaign, the requests a person decides
 *                     and their state, and for a built campaign whether its go-live is inside the caps (a normal approval,
 *                     D1 = B) or not (the approver's code); the caps used and left; the terms measured for their own hours.
 *   market            the products with structure proposals there, their counts per kind and status.
 *
 * Money: first budgets, planned bids, spend and sales sit under `money` keys, which the tool hides from a person without the
 * ad-spend permission; the words name none.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { productFamily } from './ownership.js'
import { loadStructureFacts, structureCeiling } from './structure-load.js'
import { structureGoLive } from './structure-golive.js'
import { decideStructure, MARKET_NEW_CAMPAIGNS_PER_WEEK, STRUCTURE_STATUSES, type StructureDecision, type StructureRequest } from './structure.js'
import { weeklyDue } from './structure-run.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'

export const DEFAULT_STRUCTURE_LIMIT = 50
export const MAX_STRUCTURE_LIMIT = 200
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
/** What waits for someone first, then what stands, then the shadow and the ended. */
const STATUS_ORDER: readonly string[] = ['PROPOSED', 'LIVE_PROPOSED', 'BUILT', 'LIVE', 'DONE', 'SHADOW', 'HELD', 'DECLINED', 'FAILED']
type Json = Record<string, any>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

/** The money fields of a builder's request arguments, moved under `money` (the words keep none). Pure. */
export function requestView(request: StructureRequest | null | undefined): Json | null {
  if (!request) return null
  const strip = (args: Json) => {
    const { dailyBudgetCents, defaultBidCents, keywords, budgetPolicy, bidPolicy, ...rest } = args
    const money: Json = {}
    if (dailyBudgetCents != null) money.dailyBudgetCents = dailyBudgetCents
    if (defaultBidCents != null) money.defaultBidCents = defaultBidCents
    if (budgetPolicy) money.budgetPolicy = budgetPolicy
    if (bidPolicy) money.bidPolicy = bidPolicy
    const kw = Array.isArray(keywords) ? keywords.map((k: Json) => ({ text: k.text, matchType: k.matchType })) : undefined
    if (Array.isArray(keywords) && keywords.some((k: Json) => k.bidCents != null)) money.keywordBids = keywords.map((k: Json) => ({ text: k.text, bidCents: k.bidCents ?? null }))
    return { ...rest, ...(kw ? { keywords: kw } : {}), ...(Object.keys(money).length ? { money } : {}) }
  }
  return 'plan' in request
    ? { plan: { title: request.plan.title, steps: request.plan.steps.map((s) => ({ tool: s.tool, args: strip(s.args) })) } }
    : { tool: request.tool, args: strip(request.args) }
}

/** One decision (decided now) as the view shows it. Pure. */
export function decisionView(d: StructureDecision) {
  const { money, ...evidence } = d.evidence as Json
  return {
    kind: d.kind, key: d.key, ...(d.term ? { term: d.term } : {}), ...(d.campaignId ? { campaignId: d.campaignId } : {}), reasons: d.reasons,
    does: d.act === 'propose' ? 'asks a person' : d.act === 'log' ? 'logs it in shadow' : 'held', level: d.level, builder: d.builder,
    request: requestView(d.request), owners: d.owners, migration: d.migration, heldBy: d.heldBy, why: d.why,
    evidence,
    ...(money ? { money } : {}),
  }
}

/** The approval's state in words: waiting, approved, ran, rejected, expired. */
async function approvalStates(ids: readonly string[], now: Date): Promise<Map<string, Json>> {
  if (!ids.length) return new Map()
  const rows = await prisma.agentApproval.findMany({ where: { id: { in: [...ids] } }, select: { id: true, toolName: true, status: true, expiresAt: true, decidedBy: true, decidedAt: true } })
  return new Map(rows.map((a) => [a.id, { approvalId: a.id, tool: a.toolName, status: a.status === 'pending' && a.expiresAt && a.expiresAt < now ? 'expired' : a.status, decidedBy: a.decidedBy ?? null, decidedAt: a.decidedAt?.toISOString() ?? null }]))
}

/** The `structure` view. */
export async function brainStructure(a: { market?: string; productId?: string; status?: string; limit?: number }, now: Date = new Date()): Promise<{ data: Record<string, unknown> } | { error: string }> {
  if (!a.market) return { error: 'view structure names a market (and optionally productId): the brain decides structure per product and market.' }
  const market = strategyMarket(a.market) ?? a.market
  const limit = Math.max(1, Math.min(MAX_STRUCTURE_LIMIT, a.limit ?? DEFAULT_STRUCTURE_LIMIT))
  const status = a.status && (STRUCTURE_STATUSES as readonly string[]).includes(a.status) ? a.status : undefined
  if (!a.productId) {
    const rows = await prisma.adsBrainStructure.findMany({ where: { marketplace: market, ...(status ? { status } : {}) }, select: { productId: true, kind: true, status: true, changedAt: true }, orderBy: { changedAt: 'desc' }, take: 2000 })
    const byProduct = new Map<string, { counts: Record<string, number>; newest: string }>()
    for (const r of rows) {
      const p = byProduct.get(r.productId) ?? { counts: {}, newest: r.changedAt.toISOString() }
      const k = `${r.kind}:${r.status}`
      p.counts[k] = (p.counts[k] ?? 0) + 1
      byProduct.set(r.productId, p)
    }
    const names = byProduct.size ? new Map((await prisma.product.findMany({ where: { id: { in: [...byProduct.keys()] } }, select: { id: true, name: true, sku: true } })).map((p) => [p.id, p.name?.trim() || p.sku])) : new Map<string, string>()
    return {
      data: {
        view: 'structure', market, products: [...byProduct].map(([productId, p]) => ({ productId, name: names.get(productId) ?? null, counts: p.counts, newest: p.newest })),
        note: 'Name productId for one product\'s proposals: each single-keyword campaign, split and portfolio move, decided now beside what the brain stored.',
      },
    }
  }
  const family = await productFamily(a.productId)
  if (!family) return { error: `Product ${a.productId} was not found in this business (or Nexus cannot tell whose product it is).` }
  const root = family.root
  const [enrollment, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: root, marketplace: market }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
  ])
  const settings = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: !!enrollment, overrides })
  // Decided now: the weekly decision as the brain would take it (a product not enrolled at the default level).
  const asEnrolled = enrollment ? settings : resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: true, overrides })
  const facts = await loadStructureFacts({ productId: root, market, settings: asEnrolled }, now)
  const decided = 'skipped' in facts ? null : decideStructure(facts, now)
  const keys = 'skipped' in facts ? [] : [...facts.shared.map((c) => `split:${c.campaignId}`)]
  const rows = await prisma.adsBrainStructure.findMany({
    where: { marketplace: market, OR: [{ productId: root }, ...(keys.length ? [{ key: { in: keys } }] : [])], ...(status ? { status } : {}) },
    orderBy: { changedAt: 'desc' }, take: limit,
  })
  rows.sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || y.changedAt.getTime() - x.changedAt.getTime())
  const approvals = await approvalStates(rows.flatMap((r) => [r.approvalId, r.liveApprovalId, r.retireApprovalId]).filter((x): x is string => !!x), now)
  const stored = await Promise.all(rows.map(async (r) => {
    const plan = obj(r.plan)
    const { money, ...evidence } = obj(r.evidence)
    const goLive = r.builtCampaignIds.length && (r.status === 'BUILT' || r.status === 'LIVE_PROPOSED') ? await structureGoLive(r.builtCampaignIds) : null
    return {
      kind: r.kind, key: r.key, ...(r.term ? { term: r.term } : {}), ...(r.campaignId ? { campaignId: r.campaignId } : {}),
      status: r.status, level: r.level, builder: r.builder, reasons: plan.reasons ?? [], request: requestView(plan.request), owners: plan.owners ?? null, migration: plan.migration ?? null,
      requests: {
        build: r.approvalId ? approvals.get(r.approvalId) ?? { approvalId: r.approvalId, status: 'gone' } : null,
        goLive: r.liveApprovalId ? approvals.get(r.liveApprovalId) ?? { approvalId: r.liveApprovalId, status: 'gone' } : null,
        ...(r.retireApprovalId ? { sharedLowBids: approvals.get(r.retireApprovalId) ?? { approvalId: r.retireApprovalId, status: 'gone' } } : {}),
      },
      builtCampaignIds: r.builtCampaignIds,
      ...(goLive ? { goLive: { inside: goLive.inside, why: goLive.why } } : {}),
      heldBy: r.heldBy, why: r.why, evidence, ...(money ? { money } : {}),
      decidedAt: r.decidedAt.toISOString(), since: r.changedAt.toISOString(), checkedAt: r.checkedAt.toISOString(),
    }
  }))
  const f = 'skipped' in facts ? null : facts
  return {
    data: {
      view: 'structure', productId: root, market,
      structureLever: { level: settings.levers.structure.effective, why: settings.levers.structure.why, levels: 'OFF, OBSERVE (shadow) or PROPOSE — never AUTO: every build, go-live and move asks a person' },
      ceiling: structureCeiling(),
      weeklyDay: { today: weeklyDue(now, market), note: 'New proposals are decided on Monday in the market\'s time zone; what earlier requests became is followed every day.' },
      ...(f ? {
        caps: {
          newCampaignsThisWeek: { used: f.used.campaignsThisWeek, of: f.settings.newCampaignsPerWeek },
          marketCampaignsThisWeek: { used: f.used.marketCampaignsThisWeek, of: MARKET_NEW_CAMPAIGNS_PER_WEEK },
          singleKeywordCampaigns: { used: f.used.skcs, of: f.settings.skcMax },
          skcOrderSharePct: f.settings.skcOrderSharePct, skcHourCurvePct: f.settings.skcHourCurvePct, ownPortfolio: f.settings.ownPortfolio,
        },
        productOrders: f.productOrders, windowDays: f.windowDays,
        hourCurves: f.terms.filter((t) => t.hours.measured).map((t) => ({ term: t.term, ...t.hours })),
        playbook: f.playbook,
      } : { skipped: (facts as { skipped: string }).skipped }),
      decidedNow: decided ? decided.map(decisionView) : [],
      decidedNowNote: 'decidedNow is the weekly decision as the brain would take it now — stored nowhere, nothing asked. The brain stores and asks only for an enrolled product whose structure lever is OBSERVE (shadow) or PROPOSE (under NEXUS_ADS_BRAIN_STRUCTURE_MODE=live).',
      stored,
      goLiveRule: 'D1 = B: a campaign the brain built for an enrolled product goes live with a normal approval while it is inside the caps (its first budget at most firstBudgetPctOfEnvelope of the day\'s envelope, the product below skcMax live single-keyword campaigns, no money brake holding raises); outside them the approver\'s authenticator code, as for any new structure going live.',
    },
  }
}
