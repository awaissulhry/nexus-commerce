/**
 * HARVEST ENGINE — GET /api/advertising/harvest/history: every harvest of every actor (the brain, a person, Claude, a rule),
 * newest first, each with where it went, what became of its keyword and its blocks, its judgement after the attribution
 * window + 72 hours (Better / Worse / Too early), and whether it can be put back now. Read only.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { BRAIN_HARVEST_TOOL, ENGINE_TOOL, OPEN_APPROVAL, PLACED, verdictOf, type Verdict } from './constants.js'
import { adGroupRef, campaignRef, candidateIdOf, portfolioRef, productRef, type Ref } from './ids.js'
import { previewUndo } from './undo.js'
import { blocksOf } from './write.js'

/** The records that are harvests (asked, written, put back), not the brain's shadow or held decisions. */
export const HISTORY_STATUSES = ['WRITING', 'CAMPAIGN_BUILT', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED', 'UNDONE', 'REFUSED', 'FAILED'] as const
const DAY = 86_400_000

export interface HistoryRow {
  harvestId: string
  candidateId: string
  term: string
  market: string
  product: Ref
  at: string
  by: { kind: string; id: string | null; name: string }
  changeSetId: string | null
  match: string
  status: string
  destination: { portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null } | null
  keyword: Ref | null
  /** A block whose negative no longer stands (archived or retired) reads `result: 'lifted'`. */
  sources: Array<{ adGroup: Ref; result: string | null; action: string }>
  funnel: Array<{ adGroup: Ref; match: string; result: string | null; action: string }>
  /** Re-audit — its source and funnel blocks that STILL stand (the "N blocked" count). */
  blocks: number
  judge: { verdict: Verdict | null; judgeAfter: string | null; judgedAt: string | null; why: string | null }
  undo: { available: boolean; why: string | null }
}

export interface HistoryQuery { market: string | string[]; productId?: string | null; days?: number; actor?: string | null; verdict?: string | null; ids?: string[] | null; limit?: number }

export interface UndoAnswer { available: boolean; why: string | null }

/**
 * Whether each harvest can be put back now, in words — the one answer the history, the candidates' `lastHarvest.undo` and
 * the undo itself give: an undo of it that waits, a status with nothing standing, else the undo's OWN preview (one batched
 * read) — never "available" and then refused.
 */
export async function undoAnswers(records: ReadonlyArray<{ id: string; status: string }>): Promise<Map<string, UndoAnswer>> {
  const out = new Map<string, UndoAnswer>()
  if (!records.length) return out
  const openUndo = await prisma.agentApproval.findMany({ where: { toolName: { in: [ENGINE_TOOL, BRAIN_HARVEST_TOOL] }, status: { in: [...OPEN_APPROVAL] } }, select: { id: true, args: true } })
  const undoWaiting = new Set<string>()
  for (const a of openUndo) {
    const args = (a.args ?? {}) as { op?: unknown; harvestId?: unknown; harvestIds?: unknown }
    if (args.op !== 'undo') continue
    if (typeof args.harvestId === 'string') undoWaiting.add(args.harvestId)
    if (Array.isArray(args.harvestIds)) for (const id of args.harvestIds) undoWaiting.add(String(id))
  }
  const ask = records.filter((r) => !undoWaiting.has(r.id) && (PLACED.includes(r.status) || r.status === 'UNDO_PROPOSED')).map((r) => r.id)
  const preview = new Map((ask.length ? (await previewUndo(ask)).rows : []).map((u) => [u.harvestId, u]))
  for (const r of records) {
    const asked = preview.get(r.id)
    out.set(r.id, undoWaiting.has(r.id) ? { available: false, why: 'An undo of it waits for a person.' }
      : !PLACED.includes(r.status) && r.status !== 'UNDO_PROPOSED' ? { available: false, why: r.status === 'UNDONE' ? 'It is put back already.' : `It is ${r.status.toLowerCase().replace(/_/g, ' ')}: nothing of it stands.` }
        : !asked?.ok ? { available: false, why: asked?.refusal ?? 'Nothing of it is left to put back.' } : { available: true, why: null })
  }
  return out
}

export async function harvestHistory(q: HistoryQuery, opts: { now?: Date } = {}): Promise<{ data: { rows: HistoryRow[]; totals: { harvested: number; better: number; worse: number; tooEarly: number; undone: number } } } | { error: string; status: 400 }> {
  const now = opts.now ?? new Date()
  const markets = (Array.isArray(q.market) ? q.market : [q.market]).map((m) => strategyMarket(m)).filter((m): m is string => !!m)
  if (!markets.length && !q.ids?.length) return { error: 'market: name a market', status: 400 }
  const days = Math.max(1, Math.min(365, Math.round(q.days ?? 30)))
  const actor = q.actor ? q.actor.toUpperCase() : null
  if (actor && !['BRAIN', 'PERSON', 'CLAUDE', 'RULE'].includes(actor)) return { error: 'actor: one of BRAIN, PERSON, CLAUDE, RULE', status: 400 }
  const rows = await prisma.adsBrainHarvest.findMany({
    where: {
      ...(q.ids?.length ? { id: { in: q.ids } } : { marketplace: { in: markets }, changedAt: { gte: new Date(now.getTime() - days * DAY) } }),
      status: { in: [...HISTORY_STATUSES] },
      ...(q.productId ? { productId: q.productId } : {}),
      ...(actor ? { actorKind: actor } : {}),
    },
    orderBy: [{ changedAt: 'desc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(2000, q.limit ?? 1000)),
  })
  const verdictWanted = q.verdict ? q.verdict.toLowerCase() : null
  // Names: products, people, rules, campaigns, ad groups, portfolios, keywords — one read each.
  const groupIds = [...new Set(rows.flatMap((r) => [r.destAdGroupId, ...blocksOf(r.sources).map((s) => s.adGroupId), ...blocksOf(r.funnel).map((s) => s.adGroupId)]).filter((x): x is string => !!x))]
  const [products, people, rules, groups, keywords] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId))] } }, select: { id: true, name: true, sku: true } }),
    prisma.userProfile.findMany({ where: { id: { in: [...new Set(rows.filter((r) => r.actorKind === 'PERSON' || r.actorKind === 'CLAUDE').map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true, email: true } }),
    prisma.automationRule.findMany({ where: { id: { in: [...new Set(rows.filter((r) => r.actorKind === 'RULE').map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    groupIds.length ? prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true, campaignId: true, campaign: { select: { id: true, name: true, portfolioId: true } } } }) : Promise.resolve([]),
    prisma.adTarget.findMany({ where: { id: { in: rows.map((r) => r.keywordTargetId).filter((x): x is string => !!x) } }, select: { id: true, expressionValue: true, status: true, adGroupId: true } }),
  ])
  // Which of the blocks' negatives still stand (an undo or a retirement lifts them: archived, or retired).
  const negIds = [...new Set(rows.flatMap((r) => [...blocksOf(r.sources), ...blocksOf(r.funnel)].map((b) => b.negativeTargetId).filter((x): x is string => !!x)))]
  const standingNeg = new Set((negIds.length ? await prisma.adTarget.findMany({ where: { id: { in: negIds }, isNegative: true, status: { not: 'ARCHIVED' }, retiredAt: null }, select: { id: true } }) : []).map((t) => t.id))
  const resultOf = (b: { result?: string | null; negativeTargetId?: string | null }) => (b.result === 'landed' && b.negativeTargetId && !standingNeg.has(b.negativeTargetId) ? 'lifted' : b.result ?? null)
  const portfolios = new Map((await prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: [...new Set(groups.map((g) => g.campaign?.portfolioId).filter((x): x is string => !!x))] } }, select: { externalPortfolioId: true, name: true } })).map((p) => [p.externalPortfolioId, p.name]))
  const productOf = new Map(products.map((p) => [p.id, p]))
  const personOf = new Map(people.map((p) => [p.id, p.displayName || p.email || p.id]))
  const ruleOf = new Map(rules.map((r) => [r.id, r.name]))
  const groupOf = new Map(groups.map((g) => [g.id, g]))
  const keywordOf = new Map(keywords.map((k) => [k.id, k]))
  const undoOf = await undoAnswers(rows)
  const gRef = (id: string) => { const g = groupOf.get(id); return adGroupRef(id, g?.name, g?.campaignId) }
  const out: HistoryRow[] = []
  for (const r of rows) {
    const verdict = verdictOf(r.verdict)
    if (verdictWanted && (verdictWanted === 'none' ? verdict != null : verdict !== verdictWanted)) continue
    const g = r.destAdGroupId ? groupOf.get(r.destAdGroupId) : undefined
    const kw = r.keywordTargetId ? keywordOf.get(r.keywordTargetId) : undefined
    const undo = undoOf.get(r.id) ?? { available: false, why: 'Nothing of it is left to put back.' }
    const j = (r.judgement ?? null) as { why?: string } | null
    const name = r.actorKind === 'BRAIN' ? 'Brain' : r.actorKind === 'RULE' ? ruleOf.get(r.actorId ?? '') ?? 'Rule' : r.actorKind === 'CLAUDE' ? `Claude${r.actorId && personOf.get(r.actorId) ? ` (for ${personOf.get(r.actorId)})` : ''}` : personOf.get(r.actorId ?? '') ?? 'Person'
    const p = productOf.get(r.productId)
    out.push({
      harvestId: r.id, candidateId: candidateIdOf(r.marketplace, r.productId, r.term), term: r.term, market: r.marketplace,
      product: productRef(r.productId, p?.name ?? p?.sku), at: (r.landedAt ?? r.changedAt).toISOString(),
      by: { kind: r.actorKind, id: r.actorId, name }, changeSetId: r.changeSetId ?? r.approvalId, match: r.match, status: r.status,
      destination: r.destAdGroupId || r.destCampaignId ? {
        portfolio: g?.campaign?.portfolioId ? portfolioRef(g.campaign.portfolioId, portfolios.get(g.campaign.portfolioId)) : null,
        campaign: r.destCampaignId ? campaignRef(r.destCampaignId, g?.campaign?.name) : null,
        adGroup: r.destAdGroupId ? gRef(r.destAdGroupId) : null,
      } : null,
      keyword: kw ? { id: kw.id, name: kw.expressionValue ?? r.term, ...(g ? { href: adGroupRef(g.id, g.name, g.campaignId).href } : {}) } : null,
      sources: blocksOf(r.sources).map((s) => ({ adGroup: gRef(s.adGroupId), result: resultOf(s), action: s.action })),
      funnel: blocksOf(r.funnel).map((s) => ({ adGroup: gRef(s.adGroupId), match: s.negMatch ?? 'EXACT', result: resultOf(s), action: s.action })),
      blocks: [...blocksOf(r.sources), ...blocksOf(r.funnel)].filter((b) => b.result === 'landed' && !!b.negativeTargetId && standingNeg.has(b.negativeTargetId)).length,
      judge: { verdict, judgeAfter: r.judgeAfter?.toISOString() ?? null, judgedAt: r.judgedAt?.toISOString() ?? null, why: j?.why ?? null },
      undo,
    })
  }
  return {
    data: {
      rows: out,
      totals: {
        harvested: out.filter((r) => PLACED.includes(r.status)).length,
        better: out.filter((r) => r.judge.verdict === 'better').length,
        worse: out.filter((r) => r.judge.verdict === 'worse').length,
        tooEarly: out.filter((r) => PLACED.includes(r.status) && (r.judge.verdict == null || r.judge.verdict === 'too-early')).length,
        undone: out.filter((r) => r.status === 'UNDONE').length,
      },
    },
  }
}
