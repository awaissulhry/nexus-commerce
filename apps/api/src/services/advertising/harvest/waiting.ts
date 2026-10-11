/**
 * HARVEST ENGINE — the harvest requests that wait for a person (or are about to run), per candidate: the engine's own
 * change sets (apply-harvest: every item it names), the same change sets asked through an older name (harvest-search-term,
 * graduate-keyword: the items of the engine preview they stored), the brain's pairs (apply-brain-harvest: its record's
 * term), the brain's new harvest campaigns (create-ad-campaign: the record that asked) and — polish M4 — the harvest
 * rules' asks (a pending rule suggestion of promote_to_exact / harvest_and_negate: its id is the `approvalId` here, kind
 * 'rule-ask'). Each with the PLAN the request writes (M5): where the keyword lands, its bid, every source and funnel
 * block — read from the request itself (its stored preview, the brain's record, the rule's card), never re-planned.
 * Read only.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { resolveCampaignOwnership } from '../brain/ownership.js'
import { blocksOf } from './write.js'
import { adGroupRef, campaignRef, candidateIdOf, normTerm, parseCandidateId, portfolioRef } from './ids.js'
import type { Ref } from './ids.js'
import { BRAIN_HARVEST_TOOL, ENGINE_TOOL, HARVEST_ALIAS_TOOLS, OPEN_APPROVAL } from './constants.js'

/** Where a waiting request would put the keyword (its stored preview's item), or null when it does not say. */
export type WaitingDestination =
  | { kind: 'existing'; how: string; status: 'will-create' | 'already-there' | 're-enable'; portfolio: Ref | null; campaign: Ref; adGroup: Ref; match: 'EXACT' | 'PHRASE'; bidCents: number | null }
  | { kind: 'new'; name: string; adGroupName: string; portfolio: Ref | null; dailyBudgetCents: number; match: 'EXACT' | 'PHRASE'; bidCents: number | null }

/** One block a waiting request writes (or leaves), as the request says. */
export interface WaitingBlock { adGroup: Ref; campaign: Ref | null; action: string; negMatch: 'EXACT' | 'PHRASE' }
/** M5 — what the request writes: the place, the bid, every source block and the funnel blocks. */
export interface WaitingPlan { destination: WaitingDestination | null; bidCents: number | null; bidWhy: string | null; sources: WaitingBlock[]; funnel: WaitingBlock[] }

export interface Waiting {
  approvalId: string
  /** 'request' — an approval request (AgentApproval); 'rule-ask' — a harvest rule's pending card (AdsRuleSuggestion). */
  kind: 'request' | 'rule-ask'
  tool: string
  status: string
  by: { kind: 'BRAIN' | 'PERSON' | 'CLAUDE' | 'RULE'; id: string | null; name: string }
  at: string
  expiresAt: string | null
  op: 'harvest' | 'undo'
  /** How many terms this one request covers. */
  terms: number
  /** A rule ask its approval would refuse now (its rule was edited after it proposed, is Off, archived or gone): why. */
  stale: { why: string } | null
  destination: WaitingDestination | null
  plan: WaitingPlan | null
  /** The product and term of the candidate (also for a request whose term has no candidate row today). */
  market: string
  productId: string
  term: string
}

type StoredBlock = { adGroup?: Ref; campaign?: Ref; action?: unknown; negMatch?: unknown }
type StoredItem = { candidateId?: unknown; ok?: unknown; match?: unknown; bidCents?: unknown; bidWhy?: unknown; sources?: StoredBlock[]; funnel?: StoredBlock[]; destination?: { kind?: unknown; how?: unknown; status?: unknown; adGroup?: Ref; campaign?: Ref; portfolio?: Ref | null; key?: unknown; name?: unknown } | null }
type StoredStep = { kind?: unknown; campaign?: Ref | null; adGroup?: Ref | null; portfolio?: Ref | null; dailyBudgetCents?: unknown }

/** The destination of one item of a stored engine preview (a new campaign read from its campaign step). */
export function destinationOf(item: StoredItem | undefined, steps: readonly StoredStep[]): WaitingDestination | null {
  const d = item?.destination
  if (!item || !d) return null
  const match = item.match === 'PHRASE' ? 'PHRASE' : 'EXACT'
  const bidCents = typeof item.bidCents === 'number' ? item.bidCents : null
  if (d.kind === 'existing' && d.adGroup && d.campaign) {
    const status = d.status === 'already-there' || d.status === 're-enable' ? d.status : 'will-create'
    return { kind: 'existing', how: String(d.how ?? 'chosen'), status, portfolio: d.portfolio ?? null, campaign: d.campaign, adGroup: d.adGroup, match, bidCents }
  }
  if (d.kind === 'new') {
    // A new campaign is read from its own step of the same preview (its ad group, portfolio and budget); none, none said.
    const step = steps.find((s) => s.kind === 'campaign' && s.campaign?.id === `new:${String(d.key ?? '')}`)
    if (!step || typeof step.dailyBudgetCents !== 'number') return null
    return { kind: 'new', name: String(d.name ?? step.campaign?.name ?? ''), adGroupName: step.adGroup?.name ?? '', portfolio: step.portfolio ?? null, dailyBudgetCents: step.dailyBudgetCents, match, bidCents }
  }
  return null
}

const kindOf = (agentKey: string | null | undefined): 'BRAIN' | 'PERSON' | 'CLAUDE' => {
  const k = String(agentKey ?? '')
  return k.startsWith('ads-brain') ? 'BRAIN' : k === 'manual-action' ? 'PERSON' : 'CLAUDE'
}
const negMatchOf = (v: unknown): 'EXACT' | 'PHRASE' => (v === 'PHRASE' ? 'PHRASE' : 'EXACT')

/** The plan of one item of a stored engine preview (apply-harvest, or an older name's): as it will write. Pure. */
export function planOfItem(item: StoredItem | undefined, steps: readonly StoredStep[]): WaitingPlan | null {
  if (!item) return null
  const blocks = (list: StoredBlock[] | undefined): WaitingBlock[] => (Array.isArray(list) ? list : []).filter((b) => b?.adGroup?.id)
    .map((b) => ({ adGroup: b.adGroup!, campaign: b.campaign ?? null, action: String(b.action ?? 'negate'), negMatch: negMatchOf(b.negMatch) }))
  return {
    destination: destinationOf(item, steps), bidCents: typeof item.bidCents === 'number' ? item.bidCents : null,
    bidWhy: typeof item.bidWhy === 'string' ? item.bidWhy : null, sources: blocks(item.sources), funnel: blocks(item.funnel),
  }
}

/** Names of the ad groups, campaigns and portfolios a plan read from ids points at (one read each). */
async function groupBook(ids: readonly string[]) {
  const list = [...new Set(ids.filter(Boolean))]
  const groups = list.length ? await prisma.adGroup.findMany({ where: { id: { in: list } }, select: { id: true, name: true, campaignId: true, campaign: { select: { id: true, name: true, portfolioId: true, marketplace: true } } } }) : []
  const pfIds = [...new Set(groups.map((g) => g.campaign?.portfolioId).filter((x): x is string => !!x))]
  const portfolios = new Map((pfIds.length ? await prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: pfIds } }, select: { externalPortfolioId: true, name: true } }) : []).map((p) => [p.externalPortfolioId, p.name]))
  const byId = new Map(groups.map((g) => [g.id, g]))
  return {
    group: (id: string) => byId.get(id) ?? null,
    block: (id: string, action: string, negMatch: 'EXACT' | 'PHRASE'): WaitingBlock => {
      const g = byId.get(id)
      return { adGroup: adGroupRef(id, g?.name, g?.campaignId), campaign: g?.campaign ? campaignRef(g.campaign.id, g.campaign.name) : null, action, negMatch }
    },
    place: (id: string, match: 'EXACT' | 'PHRASE', bidCents: number | null, how: string): WaitingDestination | null => {
      const g = byId.get(id)
      if (!g?.campaign) return null
      return { kind: 'existing', how, status: 'will-create', portfolio: g.campaign.portfolioId ? portfolioRef(g.campaign.portfolioId, portfolios.get(g.campaign.portfolioId)) : null, campaign: campaignRef(g.campaign.id, g.campaign.name), adGroup: adGroupRef(g.id, g.name, g.campaignId), match, bidCents }
    },
  }
}

/** Open harvest requests by candidate id (in these markets; all markets when null), each with the plan it writes. */
export async function openHarvestRequests(markets: readonly string[] | null, exceptApprovalId: string | null = null): Promise<Map<string, Waiting>> {
  const out = new Map<string, Waiting>()
  const rows = await prisma.agentApproval.findMany({
    // H1 — the request that is running (executing) is not waiting for itself.
    where: { toolName: { in: [ENGINE_TOOL, BRAIN_HARVEST_TOOL, ...HARVEST_ALIAS_TOOLS] }, status: { in: [...OPEN_APPROVAL] }, ...(exceptApprovalId ? { id: { not: exceptApprovalId } } : {}) },
    select: { id: true, toolName: true, args: true, preview: true, status: true, requestedAt: true, expiresAt: true, agentRun: { select: { agentKey: true, userId: true } } },
    orderBy: { requestedAt: 'asc' },
  })
  const brainIds = rows.filter((r) => r.toolName === BRAIN_HARVEST_TOOL).map((r) => String((r.args as { harvestId?: unknown } | null)?.harvestId ?? '')).filter(Boolean)
  // The engine's undo names records; the brain's request names one record.
  const engineUndoIds = rows.filter((r) => r.toolName === ENGINE_TOOL && (r.args as { op?: unknown } | null)?.op === 'undo')
    .flatMap((r) => (Array.isArray((r.args as { harvestIds?: unknown }).harvestIds) ? (r.args as { harvestIds: unknown[] }).harvestIds.map(String) : []))
  const recIds = [...new Set([...brainIds, ...engineUndoIds])]
  const records = new Map((recIds.length ? await prisma.adsBrainHarvest.findMany({
    where: { id: { in: recIds } },
    select: { id: true, productId: true, marketplace: true, term: true, match: true, destAdGroupId: true, bidCents: true, sources: true, funnel: true },
  }) : []).map((r) => [r.id, r]))
  const personIds = [...new Set(rows.map((r) => r.agentRun?.userId).filter((x): x is string => !!x))]
  const people = new Map<string, string>()
  if (personIds.length) for (const p of await prisma.userProfile.findMany({ where: { id: { in: personIds } }, select: { id: true, displayName: true, email: true } })) people.set(p.id, p.displayName || p.email || p.id)
  const book = await groupBook([...records.values()].flatMap((r) => [r.destAdGroupId ?? '', ...blocksOf(r.sources).map((b) => b.adGroupId), ...blocksOf(r.funnel).map((b) => b.adGroupId)]))
  const keep = (market: string) => !markets || markets.includes(market)
  const put = (id: string, w: Waiting) => { if (!out.has(id)) out.set(id, w) }
  for (const r of rows) {
    const args = (r.args ?? {}) as { op?: unknown; items?: unknown; harvestId?: unknown; harvestIds?: unknown }
    const preview = (r.preview ?? {}) as { op?: unknown; engine?: unknown; items?: unknown; steps?: unknown }
    const stored = (Array.isArray(preview.items) ? preview.items : []) as StoredItem[]
    const steps = (Array.isArray(preview.steps) ? preview.steps : []) as StoredStep[]
    const itemOf = (cid: string) => stored.find((i) => String(i?.candidateId ?? '') === cid)
    const alias = HARVEST_ALIAS_TOOLS.includes(r.toolName)
    const op = alias ? (preview.op === 'undo' ? 'undo' : 'harvest') : args.op === 'undo' ? 'undo' : 'harvest'
    const kind = kindOf(r.agentRun?.agentKey)
    const by = { kind, id: r.agentRun?.userId ?? null, name: kind === 'BRAIN' ? 'Brain' : kind === 'CLAUDE' ? 'Claude' : people.get(r.agentRun?.userId ?? '') ?? 'Person' }
    const w = (c: { market: string; productId: string; term: string }, terms: number, plan: WaitingPlan | null): Waiting => ({
      approvalId: r.id, kind: 'request', tool: r.toolName, status: r.status, by, at: r.requestedAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null,
      op, terms, stale: null, destination: plan?.destination ?? null, plan, ...c,
    })
    if (alias || (r.toolName === ENGINE_TOOL && op === 'harvest')) {
      // An older name's request: the engine's change set it stored (an older request from before the engine names none).
      if (alias && (preview.engine !== ENGINE_TOOL || op !== 'harvest')) continue
      const named = alias
        ? stored.filter((i) => i?.ok !== false).map((i) => String(i?.candidateId ?? ''))
        : (Array.isArray(args.items) ? args.items : []).map((i) => String((i as { candidateId?: unknown } | null)?.candidateId ?? ''))
      const parsed = named.map((raw) => ({ raw, c: parseCandidateId(raw) })).filter((x): x is { raw: string; c: NonNullable<ReturnType<typeof parseCandidateId>> } => !!x.c)
      for (const { raw, c } of parsed) {
        if (!keep(c.market)) continue
        const cid = candidateIdOf(c.market, c.productId, c.term)
        put(cid, w({ market: c.market, productId: c.productId, term: c.term }, parsed.length, planOfItem(itemOf(cid) ?? itemOf(raw), steps)))
      }
      continue
    }
    const ids = r.toolName === BRAIN_HARVEST_TOOL ? [String(args.harvestId ?? '')] : Array.isArray(args.harvestIds) ? args.harvestIds.map(String) : []
    for (const id of ids) {
      const rec = records.get(id)
      if (!rec || !keep(rec.marketplace)) continue
      const match = negMatchOf(rec.match)
      // The brain's pair writes what its record holds: the place, the bid, every block.
      const plan: WaitingPlan | null = op === 'harvest' ? {
        destination: rec.destAdGroupId ? book.place(rec.destAdGroupId, match, rec.bidCents ?? null, 'brain') : null,
        bidCents: rec.bidCents ?? null, bidWhy: null,
        sources: blocksOf(rec.sources).map((b) => book.block(b.adGroupId, b.action, negMatchOf(b.negMatch))),
        funnel: blocksOf(rec.funnel).map((b) => book.block(b.adGroupId, b.action, negMatchOf(b.negMatch))),
      } : null
      put(candidateIdOf(rec.marketplace, rec.productId, rec.term), w({ market: rec.marketplace, productId: rec.productId, term: rec.term }, ids.length, plan))
    }
  }
  for (const [cid, ask] of await openRuleAsks(markets)) put(cid, ask)
  return out
}

/** The decide service's long sentence as one short plain line for the page (re-audit). Pure. */
export function staleWords(sentence: string | null): string | null {
  if (!sentence) return null
  if (/ is archived/.test(sentence)) return 'The rule is archived.'
  if (/ was deleted/.test(sentence)) return 'The rule was deleted.'
  if (/ is Off/.test(sentence)) return 'The rule is Off.'
  if (/ was edited/.test(sentence)) return 'The rule changed after it asked.'
  return 'The rule cannot apply it now.'
}

/** The harvest action types a rule's card can carry. */
const RULE_ASK_TYPES = ['promote_to_exact', 'harvest_and_negate'] as const

type RuleSource = { adGroupId?: unknown; negateSource?: unknown; destinations?: Record<string, unknown> }

/**
 * M4 — the harvest rules' asks that wait (pending rule suggestions), per candidate, each with the plan its card writes:
 * promote_to_exact — the term, its source, the place(s) and bid its card names, the source negated only when the rule says
 * negateInSource; harvest_and_negate — each graduation of the card, its place from the rule's own source row (a card
 * names no bid: the rule's start bid is taken when it is applied).
 */
export async function openRuleAsks(markets: readonly string[] | null): Promise<Map<string, Waiting>> {
  const out = new Map<string, Waiting>()
  const asks = await prisma.adsRuleSuggestion.findMany({
    where: { status: 'pending', OR: RULE_ASK_TYPES.map((t) => ({ proposedAction: { path: ['type'], equals: t } })) },
    select: { id: true, ruleId: true, ruleName: true, marketplace: true, proposedAction: true, createdAt: true, lastSeenAt: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!asks.length) return out
  type Term = { askId: string; query: string; sourceId: string | null; sourceExt: string | null; dest: Array<{ adGroupId: string; match: 'EXACT' | 'PHRASE'; bidCents: number | null }>; negateSource: boolean }
  const rules = new Map((await prisma.automationRule.findMany({ where: { id: { in: [...new Set(asks.map((a) => a.ruleId))] } }, select: { id: true, name: true, actions: true } })).map((r) => [r.id, r]))
  const terms: Term[] = []
  for (const a of asks) {
    const p = (a.proposedAction ?? {}) as Record<string, unknown>
    if (p.type === 'promote_to_exact') {
      const outcomes = (Array.isArray(p.outcomes) ? p.outcomes : []) as Array<{ adGroupId?: unknown; matchType?: unknown; bidEur?: unknown }>
      terms.push({
        askId: a.id, query: String(p.query ?? ''), sourceId: typeof p.sourceAdGroupId === 'string' ? p.sourceAdGroupId : null, sourceExt: null, negateSource: p.negateInSource === true,
        dest: outcomes.filter((o) => typeof o.adGroupId === 'string').map((o) => ({ adGroupId: String(o.adGroupId), match: negMatchOf(o.matchType), bidCents: typeof o.bidEur === 'number' ? Math.round(o.bidEur * 100) : null })),
      })
    } else {
      const items = (Array.isArray(p.items) ? p.items : []) as Array<{ kind?: unknown; query?: unknown; externalAdGroupId?: unknown }>
      for (const it of items.filter((i) => i.kind === 'graduation' || i.kind === 'productGraduation')) {
        terms.push({ askId: a.id, query: String(it.query ?? ''), sourceId: null, sourceExt: typeof it.externalAdGroupId === 'string' ? it.externalAdGroupId : null, negateSource: false, dest: [] })
      }
    }
  }
  // Sources named by their Amazon id (a harvest_and_negate card): the Nexus ad group, then the rule's own source row.
  const exts = [...new Set(terms.map((t) => t.sourceExt).filter((x): x is string => !!x))]
  const byExt = new Map((exts.length ? await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: exts } }, select: { id: true, externalAdGroupId: true } }) : []).map((g) => [g.externalAdGroupId!, g.id]))
  for (const t of terms) {
    if (t.sourceId || !t.sourceExt) continue
    t.sourceId = byExt.get(t.sourceExt) ?? null
    const ask = asks.find((a) => a.id === t.askId)!
    const a0 = (Array.isArray(rules.get(ask.ruleId)?.actions) ? (rules.get(ask.ruleId)!.actions as unknown[])[0] : null) as { sources?: RuleSource[] } | null
    const row = (a0?.sources ?? []).find((s) => String(s.adGroupId ?? '') === t.sourceId)
    if (row) {
      t.negateSource = row.negateSource === true
      for (const [m, g] of Object.entries(row.destinations ?? {})) if (typeof g === 'string' && (m === 'EXACT' || m === 'PHRASE')) t.dest.push({ adGroupId: g, match: m, bidCents: null })
    }
  }
  const book = await groupBook(terms.flatMap((t) => [t.sourceId ?? '', ...t.dest.map((d) => d.adGroupId)]))
  const campaigns = [...new Set(terms.map((t) => (t.sourceId ? book.group(t.sourceId)?.campaignId : null)).filter((x): x is string => !!x))]
  const owners = campaigns.length ? await resolveCampaignOwnership(campaigns) : new Map()
  const perAsk = new Map<string, number>()
  for (const t of terms) perAsk.set(t.askId, (perAsk.get(t.askId) ?? 0) + 1)
  // The decide service's own check (ads-suggestion-decide.service.ts staleRuleSentence): an ask its approval would refuse
  // is said up front, so the page holds Approve with the reason and offers Reject only.
  const { staleRuleSentence } = await import('../ads-suggestion-decide.service.js')
  const staleOf = new Map<string, string | null>()
  for (const a of asks) if (perAsk.has(a.id)) staleOf.set(a.id, staleWords(await staleRuleSentence({ ruleId: a.ruleId, ruleName: a.ruleName, lastSeenAt: a.lastSeenAt })))
  for (const t of terms) {
    const ask = asks.find((a) => a.id === t.askId)!
    const g = t.sourceId ? book.group(t.sourceId) : null
    const owner = g ? owners.get(g.campaignId)?.owner : null
    // A term is a candidate of the product that owns its source campaign (a shared campaign is no product's).
    if (!g || owner?.kind !== 'product') continue
    const market = strategyMarket(ask.marketplace ?? g.campaign?.marketplace ?? '')
    const term = normTerm(t.query)
    if (!market || !term || (markets && !markets.includes(market))) continue
    const first = t.dest[0] ?? null
    const plan: WaitingPlan = {
      destination: first ? book.place(first.adGroupId, first.match, first.bidCents, 'rule') : null,
      bidCents: first?.bidCents ?? null, bidWhy: first?.bidCents != null ? 'The bid the rule\'s card names.' : null,
      sources: [book.block(t.sourceId!, t.negateSource ? 'negate' : 'kept', 'EXACT')],
      funnel: [],
    }
    const cid = candidateIdOf(market, owner.productId, term)
    if (out.has(cid)) continue
    out.set(cid, {
      approvalId: ask.id, kind: 'rule-ask', tool: `rule:${ask.ruleId}`, status: 'pending',
      by: { kind: 'RULE', id: ask.ruleId, name: rules.get(ask.ruleId)?.name ?? ask.ruleName ?? 'Rule' },
      at: ask.createdAt.toISOString(), expiresAt: null, op: 'harvest', terms: perAsk.get(ask.id) ?? 1,
      stale: staleOf.get(ask.id) ? { why: staleOf.get(ask.id)! } : null,
      destination: plan.destination, plan, market, productId: owner.productId, term,
    })
  }
  return out
}
