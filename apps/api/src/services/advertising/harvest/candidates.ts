/**
 * HARVEST ENGINE — GET /api/advertising/harvest/candidates (and Claude's harvest-candidates, idsOnly too): every search
 * term that sells, one row per term × product × market, over every source of the product where it ran. Read only.
 *
 *   bar        ONE bar (B3): the ads strategy's harvest group for the product (market / category / product) where set, else
 *              the brain's sized test — the term ledger's own test (brain/terms.ts harvestTest). The page's old saved
 *              policy (AdsHarvestPolicy) is not read. Named in `criteria` per market and on each row (`bar`).
 *   dedupe     per product and market only (B4): a term already a keyword of THIS product is AT_HOME; another product's or
 *              another market's keyword never hides it (products may share keywords).
 *   state      READY (it can go now, to the suggested place) · NEEDS_DESTINATION (the place cannot take it now: say which)
 *              · NEEDS_CAMPAIGN (the product has no ad group of that match: a new campaign is suggested) · HELD (no bid, a
 *              paused source) · WAITING (a request waits for a person) · IN_FLIGHT (being written or built) · HARVESTED ·
 *              AT_HOME · OWNED_BY_SIBLING · BELOW_BAR · SKIPPED. The last four only when asked (`state`).
 *   owner      who decides the term automatically: the brain (the product enrolled, its harvest lever on), a harvest rule
 *              (its scope reaches the main source), a person (a harvest of theirs stands), or nobody.
 */
import prisma from '../../../db.js'
import { adsReadMarkets } from '../ads-markets.service.js'
import { mergeIds, type ScopeIdLists } from '../ads-scope-lists.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { AMAZON_MIN_BUDGET_CENTS } from '../brain/harvest.js'
import type { TermDecision } from '../brain/terms.js'
import { ALL_STATES, DEFAULT_STATES, IN_FLIGHT, PLACED, actorName, verdictOf, type CandidateState, type Verdict } from './constants.js'
import { landingLookup, leverActs, loadMarketFacts, recordKey, skippedNow, type EngineProduct, type LandingLookup, type MarketFacts, type RecordRow } from './facts.js'
import { adGroupRef, campaignRef, candidateIdOf, portfolioRef, productRef, type Ref } from './ids.js'
import { harvestCampaignName, planItem, sourceBlocks, type Hold, type PlanProduct, type PlanTerm } from './plan.js'
import { harvestRuleReach, rulesAt, type HarvestReach } from './rule-reach.js'
import { openHarvestRequests, type Waiting, type WaitingBlock } from './waiting.js'
import { undoAnswers, type UndoAnswer } from './history.js'
import { sinceHarvestMany, type SinceHarvest } from './judge.js'
import type { BlockState, HarvestMatch } from './write.js'

export const MAX_PAGE_SIZE = 500
export const MAX_IDS = 5000
const DAY = 86_400_000

/**
 * The scope: market, product (its family), portfolio, campaign, ad group — each also a list (the scope filter, 2026-10-12:
 * `productIds` … merged with the singular; OR inside a list, AND across lists).
 */
export interface CandidatesQuery extends ScopeIdLists {
  market: string
  productId?: string | null
  portfolioId?: string | null
  campaignId?: string | null
  adGroupId?: string | null
  state?: readonly string[] | null
  owner?: string | null
  kind?: 'keyword' | 'asin' | null
  q?: string | null
  page?: number
  pageSize?: number
  sort?: string | null
}

type Role = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT' | 'PRODUCT' | null
export interface SourceRow { portfolio: Ref | null; campaign: Ref; adGroup: Ref; role: Role; clicks: number; action: BlockState['action']; why: string }

export interface HarvestCandidateRow {
  id: string
  term: string
  kind: 'keyword' | 'asin'
  market: string
  /** B18 — the market's currency: every amount of the row is in it (minor units); markets are never summed together. */
  currency: string | null
  product: Ref
  source: Omit<SourceRow, 'clicks' | 'action' | 'why'> | null
  sources: SourceRow[]
  metrics: { windowDays: number; impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acosPct: number | null; cpcCents: number | null }
  bar: { by: 'strategy' | 'brain'; label: string; passes: boolean }
  state: CandidateState
  owner: { kind: 'BRAIN' | 'RULE' | 'PERSON' | 'NONE'; id: string | null; name: string }
  heldBy: Hold | null
  destination: null
    | { kind: 'existing'; how: string; portfolio: Ref | null; campaign: Ref; adGroup: Ref; match: HarvestMatch; status: 'will-create' | 'already-there' | 're-enable' }
    | { kind: 'new'; how: 'new'; match: HarvestMatch; plan: { name: string; adGroupName: string; portfolio: Ref | null; dailyBudgetCents: number } }
  funnel: Array<{ campaign: Ref; adGroup: Ref; match: HarvestMatch }>
  startBidCents: number | null
  bidWhy: string | null
  skipped: null | { until: string | null; by: string | null; at: string | null }
  /** M4 — the request that waits: an approval request, or a harvest rule's ask (its id in `approvalId`, kind 'rule-ask'). */
  waiting: null | { approvalId: string; kind: 'request' | 'rule-ask'; tool: string; by: { kind: string; id: string | null; name: string }; at: string; expiresAt: string | null; terms: number; stale: { why: string } | null }
  /** M3 — the undo's own answer, the keyword's state now, the judgement's words. */
  lastHarvest: null | {
    harvestId: string; at: string; by: { kind: string; id: string | null }; status: string; verdict: Verdict | null
    undo: UndoAnswer; keyword: { id: string | null; state: 'ENABLED' | 'PAUSED' | 'ARCHIVED' | null }; judge: { why: string | null }
  }
  /** S7 — the keyword's own numbers since it landed (HARVESTED rows; null otherwise). */
  sinceHarvest: SinceHarvest | null
}

export interface CandidateTotals {
  candidates: number; ready: number; needDestination: number; needCampaign: number; held: number; waiting: number; waitingRequests: number; waitingStale: number; inFlight: number
  harvested30d: number; worse: number; waitingToJudge: number; skipped: number; ownedBySibling: number; belowBar: number; atHome: number
}

export interface CandidatesAnswer {
  markets: string[]
  rows: HarvestCandidateRow[]
  total: number
  page: number
  pageSize: number
  totals: CandidateTotals
  criteria: { label: string; markets: Array<{ market: string; by: 'strategy' | 'brain'; source: string | null; minOrders: number | null; minClicks: number | null; maxAcosPct: number | null; windowDays: number }> }
  freshness: { dataDay: string | null; windowDays: number | null }
  /** Products left out (no campaign of their own in the market), named. */
  skipped: Array<{ market: string; productId: string; why: string }>
}

/** The markets a `market` parameter names: one code, a comma list, or `all` (the markets Nexus reads). */
export async function marketsOf(raw: string): Promise<string[] | { error: string }> {
  const v = String(raw ?? '').trim()
  if (!v) return { error: 'market: name a market (a code, a comma list, or all)' }
  const read = (await adsReadMarkets()).map((m) => strategyMarket(m)).filter((m): m is string => !!m)
  if (v.toLowerCase() === 'all') return read.length ? read : { error: 'no Amazon Ads market is read in this business' }
  const codes = [...new Set(v.split(',').map((c) => strategyMarket(c.trim())).filter((c): c is string => !!c))]
  if (!codes.length) return { error: `market: ${v} is not a market code` }
  // L3 — a market Nexus does not read in this business is said, never answered with an empty list.
  const unread = codes.filter((c) => !read.includes(c))
  return unread.length ? { error: `market: Nexus reads no Amazon Ads account for ${unread.join(', ')} in this business (it reads ${read.join(', ') || 'none'})` } : codes
}

const acosOf = (spend: number, sales: number) => (sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null)

export function planProductOf(p: EngineProduct, facts: Pick<MarketFacts, 'pauses'>): PlanProduct {
  return {
    productId: p.productId, market: p.market, label: p.sku || p.name, facts: p.facts, portfolioId: p.portfolioId, storedFor: p.storedFor,
    paused: new Set(facts.pauses.keys()), brainRuns: p.enrolled && leverActs(p.lever),
  }
}

export function planTermOf(p: EngineProduct, term: string, d: TermDecision | null): PlanTerm {
  return { term, isAsin: d?.isAsin ?? /^b0[a-z0-9]{8}$/i.test(term), decision: d, sources: p.sourcesOf(term) }
}

/** The bar a decision was judged on, in short words (no figure of money or ACoS). */
function barOf(d: TermDecision | null): HarvestCandidateRow['bar'] {
  if (!d) return { by: 'brain', label: 'No evidence', passes: false }
  const h = d.tests.harvest
  const plural = (n: number, one: string) => `${n}+ ${one}${n === 1 ? '' : 's'}`
  if (h.by === 'owner') return { by: 'strategy', label: [plural(h.ordersNeeded, 'order'), h.clicksNeeded ? plural(h.clicksNeeded, 'click') : null, 'ACoS cap'].filter(Boolean).join(' · '), passes: h.pass }
  return { by: 'brain', label: `${plural(h.ordersNeeded, 'order')} · ACoS under band`, passes: h.pass }
}

interface Context {
  facts: MarketFacts
  reach: HarvestReach
  waiting: Map<string, Waiting>
  landing: LandingLookup
  brainWaiting: Map<string, string>
  /** M3 / S7 — per record: the undo's answer, the keyword's state; the keyword's numbers since it landed. */
  undo: Map<string, UndoAnswer>
  keywordState: Map<string, string>
  since: Map<string, SinceHarvest | null>
  now: Date
}

/** One candidate row (any state). */
export function candidateRow(c: Context, p: EngineProduct, term: string): HarvestCandidateRow | null {
  const { facts, now } = c
  const d = p.decisions.get(term) ?? null
  const record: RecordRow | null = facts.records.get(recordKey(p.productId, term)) ?? null
  const id = candidateIdOf(p.market, p.productId, term)
  const pp = planProductOf(p, facts)
  const t = planTermOf(p, term, d)
  const match: HarvestMatch = 'EXACT'
  const groups = p.facts.groups
  const campaignInfo = (cid: string) => facts.campaigns.get(cid)
  const portfolio = (cid: string) => { const pid = campaignInfo(cid)?.portfolioId; return pid ? portfolioRef(pid, facts.portfolios.get(pid)) : null }
  const groupRef = (gid: string) => { const g = groups.get(gid) ?? facts.groupNames.get(gid); return adGroupRef(gid, g?.name, g?.campaignId) }
  const campaignOfGroup = (gid: string) => groups.get(gid)?.campaignId ?? facts.groupNames.get(gid)?.campaignId ?? null

  // Waiting / in flight / placed / skipped come from the record and the open requests.
  const open = c.waiting.get(id) ?? null
  const brainOpen = record ? c.brainWaiting.get(record.id) ?? null : null
  const waiting: HarvestCandidateRow['waiting'] = open ? { approvalId: open.approvalId, kind: open.kind, tool: open.tool, by: open.by, at: open.at, expiresAt: open.expiresAt, terms: open.terms, stale: open.stale }
    : brainOpen && record ? { approvalId: brainOpen, kind: 'request', tool: record.status === 'CAMPAIGN_PROPOSED' ? 'create-ad-campaign' : 'apply-brain-harvest', by: { kind: 'BRAIN', id: null, name: 'Brain' }, at: record.changedAt.toISOString(), expiresAt: null, terms: 1, stale: null } : null
  let state: CandidateState
  let hold: Hold | null = null
  let planned: ReturnType<typeof planItem> | null = null
  if (waiting) state = 'WAITING'
  else if (record && IN_FLIGHT.includes(record.status) && record.status !== 'HALF_DONE') state = 'IN_FLIGHT'
  else if (record && PLACED.includes(record.status)) {
    state = 'HARVESTED'
    // HALF_DONE: a paused keyword switched on (or a block that failed): its source blocks are owed. Harvest it again once
    // Amazon confirmed the switch-on, and they follow (the plan completes it in the same place).
    if (record.status === 'HALF_DONE') hold = { kind: 'record', label: 'Blocks owed', reason: 'Its keyword stands, but some source blocks are not written yet (a switch-on Amazon has not confirmed, or a block that failed): harvest it again to send them.' }
  }
  else if (skippedNow(record, now)) state = 'SKIPPED'
  else if (!d) return null
  else if (d.state === 'TARGETED') state = 'AT_HOME'
  else if (d.state === 'OWNED_BY_SIBLING') state = 'OWNED_BY_SIBLING'
  else if (d.state !== 'HARVEST_CANDIDATE') {
    if (d.evidence.orders <= 0) return null
    state = 'BELOW_BAR'
  } else {
    planned = planItem({
      req: { candidateId: id }, actor: 'PERSON', product: pp, term: t, record: record ? { status: record.status, actorKind: record.actorKind, destAdGroupId: record.destAdGroupId } : null, waiting: false, newCampaign: null,
      landing: (gid) => c.landing(gid, term, match, t.isAsin),
    })
    hold = planned.hold
    if (!planned.refusal) state = 'READY'
    else if (hold?.label === 'Needs a campaign') state = 'NEEDS_CAMPAIGN'
    else if (hold?.kind === 'destination') state = 'NEEDS_DESTINATION'
    else if (hold?.kind === 'home') state = 'AT_HOME'
    else state = 'HELD'
    if (state === 'READY' && t.sources.length && t.sources.every((s) => facts.pauses.has(s.adGroupId))) {
      state = 'HELD'
      hold = { kind: 'source', label: 'Source paused', reason: 'Harvesting from its source is paused (Sources view).' }
    }
  }

  // The sources: the plan's (what the harvest would do), else as they stand.
  const blocks = planned?.sources?.length ? planned.sources : sourceBlocks(pp, t, match, null, { storedKeeps: false, actor: 'PERSON' })
  let sources: SourceRow[] = blocks.map((s) => ({ portfolio: portfolio(s.campaignId), campaign: campaignRef(s.campaignId, campaignInfo(s.campaignId)?.name), adGroup: groupRef(s.adGroupId), role: s.role, clicks: s.clicks ?? 0, action: s.action, why: s.why }))
  // M5 — a WAITING row shows the REQUEST's blocks, exactly as it writes them (its own plan), not today's suggestion.
  const askedPlan = state === 'WAITING' ? open?.plan ?? null : null
  if (askedPlan) sources = askedPlan.sources.map((b) => waitingSource(b, blocks, facts))
  const main = sources[0] ?? null

  // The destination: the plan's, the suggested new campaign, or the record's.
  let destination: HarvestCandidateRow['destination'] = null
  const dest = planned?.destination
  if (dest && dest.kind === 'existing') {
    destination = { kind: 'existing', how: dest.how, portfolio: portfolio(dest.campaignId), campaign: campaignRef(dest.campaignId, campaignInfo(dest.campaignId)?.name), adGroup: groupRef(dest.adGroupId), match, status: dest.status }
  } else if (state === 'NEEDS_CAMPAIGN') {
    const nc = p.facts.newCampaign
    const naming = harvestCampaignName(pp.label, match, nc?.takenNames ?? new Set())
    destination = { kind: 'new', how: 'new', match, plan: { ...naming, portfolio: p.portfolioId ? portfolioRef(p.portfolioId, facts.portfolios.get(p.portfolioId)) : null, dailyBudgetCents: nc?.dailyBudgetCents ?? AMAZON_MIN_BUDGET_CENTS } }
  } else if (record?.destAdGroupId && record.destCampaignId && (state === 'HARVESTED' || state === 'IN_FLIGHT' || state === 'WAITING')) {
    destination = { kind: 'existing', how: 'chosen', portfolio: portfolio(record.destCampaignId), campaign: campaignRef(record.destCampaignId, campaignInfo(record.destCampaignId)?.name), adGroup: groupRef(record.destAdGroupId), match: (record.match === 'PHRASE' ? 'PHRASE' : 'EXACT'), status: 'already-there' }
  }

  // A request that waits says where it would land (its own preview): the row shows that, not nothing (lane HPAGE).
  const asked = state === 'WAITING' ? askedPlan?.destination ?? null : null
  if (state === 'WAITING' && asked) {
    destination = asked.kind === 'existing'
      ? { kind: 'existing', how: asked.how, portfolio: asked.portfolio, campaign: asked.campaign, adGroup: asked.adGroup, match: asked.match, status: asked.status }
      : { kind: 'new', how: 'new', match: asked.match, plan: { name: asked.name, adGroupName: asked.adGroupName, portfolio: asked.portfolio, dailyBudgetCents: asked.dailyBudgetCents } }
  }

  // Owner: the brain, a rule that reaches the main source, a person whose harvest stands, or nobody.
  const mainCampaign = main ? campaignOfGroup(main.adGroup.id) : null
  const rules = main ? rulesAt(c.reach, mainCampaign, main.adGroup.id) : []
  const owner: HarvestCandidateRow['owner'] = p.enrolled && leverActs(p.lever) ? { kind: 'BRAIN', id: 'brain', name: 'Brain' }
    : record && (record.actorKind === 'PERSON' || record.actorKind === 'CLAUDE') && PLACED.includes(record.status) ? { kind: 'PERSON', id: record.actorId, name: actorName(record.actorKind, record.actorId) }
      : rules.length ? { kind: 'RULE', id: rules[0].id, name: rules[0].name }
        : { kind: 'NONE', id: null, name: 'Nobody' }

  const e = d?.evidence ?? { impressions: 0, clicks: 0, orders: 0, spendCents: 0, salesCents: 0 }
  return {
    id, term, kind: t.isAsin ? 'asin' : 'keyword', market: p.market,
    currency: (main ? facts.campaigns.get(main.campaign.id)?.currency : null) ?? [...facts.campaigns.values()].find((c) => c.currency)?.currency ?? null,
    product: productRef(p.productId, p.name),
    source: main ? { portfolio: main.portfolio, campaign: main.campaign, adGroup: main.adGroup, role: main.role } : null,
    sources,
    metrics: { windowDays: facts.windowDays, impressions: e.impressions, clicks: e.clicks, orders: e.orders, spendCents: e.spendCents, salesCents: e.salesCents, acosPct: acosOf(e.spendCents, e.salesCents), cpcCents: e.clicks > 0 ? Math.round(e.spendCents / e.clicks) : null },
    bar: barOf(d),
    state, owner, heldBy: state === 'READY' ? null : hold,
    destination,
    funnel: askedPlan
      ? askedPlan.funnel.filter((f) => f.action === 'negate').map((f) => ({ campaign: f.campaign ?? campaignRef(campaignOfGroup(f.adGroup.id) ?? '', null), adGroup: f.adGroup, match: f.negMatch }))
      : (planned?.funnel ?? []).filter((f) => f.action === 'negate').map((f) => ({ campaign: campaignRef(f.campaignId, campaignInfo(f.campaignId)?.name), adGroup: groupRef(f.adGroupId), match: f.negMatch ?? 'EXACT' })),
    startBidCents: askedPlan ? askedPlan.bidCents : planned?.bid?.cents ?? null,
    bidWhy: askedPlan ? askedPlan.bidWhy ?? (askedPlan.bidCents != null ? 'The bid the waiting request names.' : null) : planned?.bid?.why ?? null,
    skipped: skippedNow(record, now) ? { until: record!.skippedForGood ? null : record!.skippedUntil?.toISOString() ?? null, by: record!.skippedBy, at: record!.skippedAt?.toISOString() ?? null } : null,
    waiting,
    lastHarvest: record && !['SHADOW', 'HELD'].includes(record.status)
      ? {
        harvestId: record.id, at: (record.landedAt ?? record.changedAt).toISOString(), by: { kind: record.actorKind, id: record.actorId }, status: record.status, verdict: verdictOf(record.verdict),
        undo: c.undo.get(record.id) ?? { available: false, why: 'Nothing of it is left to put back.' },
        keyword: { id: record.keywordTargetId, state: keywordStateOf(record.keywordTargetId ? c.keywordState.get(record.keywordTargetId) : undefined) },
        judge: { why: judgeWhy(record.judgement) },
      }
      : null,
    sinceHarvest: state === 'HARVESTED' && record ? c.since.get(record.id) ?? null : null,
  }
}

const keywordStateOf = (s: string | undefined): 'ENABLED' | 'PAUSED' | 'ARCHIVED' | null => (s === 'ENABLED' || s === 'PAUSED' || s === 'ARCHIVED' ? s : null)
const judgeWhy = (j: unknown): string | null => { const w = (j as { why?: unknown } | null)?.why; return typeof w === 'string' && w.trim() ? w : null }

/** A waiting request's block as a source row (its clicks from today's sources when the ad group is one of them). */
function waitingSource(b: WaitingBlock, today: ReadonlyArray<{ adGroupId: string; role: SourceRow['role']; clicks?: number | null }>, facts: MarketFacts): SourceRow {
  const now = today.find((s) => s.adGroupId === b.adGroup.id)
  const campaignId = b.campaign?.id ?? facts.groupNames.get(b.adGroup.id)?.campaignId ?? null
  const pid = campaignId ? facts.campaigns.get(campaignId)?.portfolioId : null
  return {
    portfolio: pid ? portfolioRef(pid, facts.portfolios.get(pid)) : null, campaign: b.campaign ?? campaignRef(campaignId ?? '', null), adGroup: b.adGroup,
    role: now?.role ?? null, clicks: now?.clicks ?? 0, action: b.action as SourceRow['action'], why: b.action === 'negate' ? 'the request blocks it' : 'the request leaves it',
  }
}

/** M4 — a WAITING row for a request whose term has no candidate row today (the request's plan, no numbers). */
function requestRow(c: Context, w: Waiting, productName: string): HarvestCandidateRow {
  const { facts } = c
  const id = candidateIdOf(w.market, w.productId, w.term)
  const sources = (w.plan?.sources ?? []).map((b) => waitingSource(b, [], facts))
  const main = sources[0] ?? null
  const d = w.plan?.destination ?? null
  return {
    id, term: w.term, kind: /^b0[a-z0-9]{8}$/i.test(w.term) ? 'asin' : 'keyword', market: w.market,
    currency: [...facts.campaigns.values()].find((x) => x.currency)?.currency ?? null,
    product: productRef(w.productId, productName),
    source: main ? { portfolio: main.portfolio, campaign: main.campaign, adGroup: main.adGroup, role: main.role } : null,
    sources,
    metrics: { windowDays: facts.windowDays, impressions: 0, clicks: 0, orders: 0, spendCents: 0, salesCents: 0, acosPct: null, cpcCents: null },
    bar: { by: 'brain', label: 'No evidence', passes: false },
    state: 'WAITING',
    owner: w.by.kind === 'RULE' ? { kind: 'RULE', id: w.by.id, name: w.by.name } : w.by.kind === 'BRAIN' ? { kind: 'BRAIN', id: 'brain', name: 'Brain' } : { kind: 'PERSON', id: w.by.id, name: w.by.name },
    heldBy: null,
    destination: !d ? null : d.kind === 'existing'
      ? { kind: 'existing', how: d.how, portfolio: d.portfolio, campaign: d.campaign, adGroup: d.adGroup, match: d.match, status: d.status }
      : { kind: 'new', how: 'new', match: d.match, plan: { name: d.name, adGroupName: d.adGroupName, portfolio: d.portfolio, dailyBudgetCents: d.dailyBudgetCents } },
    funnel: (w.plan?.funnel ?? []).filter((f) => f.action === 'negate').map((f) => ({ campaign: f.campaign ?? campaignRef('', null), adGroup: f.adGroup, match: f.negMatch })),
    startBidCents: w.plan?.bidCents ?? null, bidWhy: w.plan?.bidWhy ?? (w.plan?.bidCents != null ? 'The bid the waiting request names.' : null),
    skipped: null,
    waiting: { approvalId: w.approvalId, kind: w.kind, tool: w.tool, by: w.by, at: w.at, expiresAt: w.expiresAt, terms: w.terms, stale: w.stale },
    lastHarvest: null, sinceHarvest: null,
  }
}

/** Every row of one market (all states), with what the totals need; `productId` / `productIds` narrow it to their families. */
export async function marketRows(market: string, opts: { productId?: string | null; productIds?: readonly string[] | null; now?: Date } = {}): Promise<{ facts: MarketFacts; rows: HarvestCandidateRow[] } | { error: string; status: 400 | 404 }> {
  const now = opts.now ?? new Date()
  const products = mergeIds(opts.productId, opts.productIds)
  const facts = await loadMarketFacts(market, { productIds: products, now })
  if ('error' in facts) return facts
  const [reach, waiting] = await Promise.all([harvestRuleReach(facts.market), openHarvestRequests([facts.market])])
  // The brain's own open requests per record (a pair it asked, a new campaign it asked).
  const brainRecords = [...facts.records.values()].filter((r) => ['PROPOSED', 'CAMPAIGN_PROPOSED', 'UNDO_PROPOSED'].includes(r.status))
  const approvalIds = brainRecords.flatMap((r) => [r.approvalId, r.undoApprovalId]).filter((x): x is string => !!x)
  const open = new Set((approvalIds.length ? await prisma.agentApproval.findMany({ where: { id: { in: approvalIds }, status: { in: ['pending', 'scheduled', 'approved', 'executing'] } }, select: { id: true } }) : []).map((a) => a.id))
  const brainWaiting = new Map<string, string>()
  for (const r of brainRecords) {
    const a = r.status === 'UNDO_PROPOSED' ? r.undoApprovalId : r.approvalId
    if (a && open.has(a)) brainWaiting.set(r.id, a)
  }
  // The landing facts of every own ad group for the candidates (B1, B10): one read for the market.
  const landing = await landingLookup([...facts.products.values()].flatMap((p) => [...p.decisions.values()].filter((d) => d.state === 'HARVEST_CANDIDATE')
    .flatMap((d) => [...p.facts.groups.keys()].map((adGroupId) => ({ adGroupId, term: d.term, match: 'EXACT' as const, isAsin: d.isAsin })))))
  // M3 / S7 — per record: the undo's own answer, the keyword's state, its numbers since it landed (one read each).
  const shown = [...facts.records.values()].filter((r) => !['SHADOW', 'HELD'].includes(r.status))
  const keywordIds = shown.map((r) => r.keywordTargetId).filter((x): x is string => !!x)
  const [undo, keywords, since] = await Promise.all([
    undoAnswers(shown),
    keywordIds.length ? prisma.adTarget.findMany({ where: { id: { in: keywordIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
    sinceHarvestMany(shown.filter((r) => PLACED.includes(r.status)), now),
  ])
  const ctx: Context = { facts, reach, waiting, landing, brainWaiting, undo, keywordState: new Map(keywords.map((k) => [k.id, String(k.status)])), since, now }
  const rows: HarvestCandidateRow[] = []
  for (const p of facts.products.values()) {
    const terms = new Set<string>([...p.decisions.keys()])
    for (const r of facts.records.values()) if (r.productId === p.productId) terms.add(r.term)
    for (const term of terms) {
      const row = candidateRow(ctx, p, term)
      if (row) rows.push(row)
    }
  }
  // M4 — every request that waits is a WAITING row, also when its term has no candidate row today.
  const listed = new Set(rows.map((r) => r.id))
  const missing = [...waiting.entries()].filter(([cid, w]) => !listed.has(cid) && w.market === facts.market && w.op === 'harvest' && (!products || facts.products.has(w.productId) || products.includes(w.productId)))
  if (missing.length) {
    const names = new Map((await prisma.product.findMany({ where: { id: { in: [...new Set(missing.map(([, w]) => w.productId))] } }, select: { id: true, name: true, sku: true } })).map((p) => [p.id, p.sku || p.name || p.id]))
    for (const [, w] of missing) rows.push(requestRow(ctx, w, facts.products.get(w.productId)?.name ?? names.get(w.productId) ?? w.productId))
  }
  return { facts, rows }
}

const SORTS: Record<string, (r: HarvestCandidateRow) => number | string> = {
  orders: (r) => r.metrics.orders, acos: (r) => r.metrics.acosPct ?? Number.POSITIVE_INFINITY, spend: (r) => r.metrics.spendCents, clicks: (r) => r.metrics.clicks,
  cpc: (r) => r.metrics.cpcCents ?? 0, term: (r) => r.term, state: (r) => ALL_STATES.indexOf(r.state), product: (r) => r.product.name.toLowerCase(),
}

/**
 * The rows the scope keeps (market, product, portfolio, campaign, ad group, kind, words) — the tiles count these. A
 * portfolio or campaign: any source, or the existing destination, is one of them; an ad group: any source is one of them
 * (each dimension a list since the scope filter, 2026-10-12: OR inside, AND across).
 */
function inScope(q: CandidatesQuery): (r: HarvestCandidateRow) => boolean {
  const portfolios = mergeIds(q.portfolioId, q.portfolioIds)
  const campaigns = mergeIds(q.campaignId, q.campaignIds)
  const adGroups = mergeIds(q.adGroupId, q.adGroupIds)
  const text = q.q?.trim().toLowerCase()
  return (r) => {
    if (q.kind && r.kind !== q.kind) return false
    if (text && !r.term.includes(text)) return false
    const dest = r.destination?.kind === 'existing' ? r.destination : null
    if (portfolios && !r.sources.some((s) => !!s.portfolio && portfolios.includes(s.portfolio.id)) && !(dest?.portfolio && portfolios.includes(dest.portfolio.id))) return false
    if (campaigns && !r.sources.some((s) => campaigns.includes(s.campaign.id)) && !(dest && campaigns.includes(dest.campaign.id))) return false
    if (adGroups && !r.sources.some((s) => adGroups.includes(s.adGroup.id))) return false
    return true
  }
}

export function totalsOf(rows: readonly HarvestCandidateRow[], now: Date): CandidateTotals {
  const n = (s: CandidateState) => rows.filter((r) => r.state === s).length
  const monthAgo = now.getTime() - 30 * DAY
  return {
    candidates: rows.filter((r) => ['READY', 'NEEDS_DESTINATION', 'NEEDS_CAMPAIGN', 'HELD'].includes(r.state)).length,
    ready: n('READY'), needDestination: n('NEEDS_DESTINATION'), needCampaign: n('NEEDS_CAMPAIGN'), held: n('HELD'), waiting: n('WAITING'), inFlight: n('IN_FLIGHT'),
    // M4 — the requests behind the WAITING rows (one request may cover several terms).
    waitingRequests: new Set(rows.filter((r) => r.state === 'WAITING' && r.waiting && !r.waiting.stale).map((r) => r.waiting!.approvalId)).size,
    // Re-audit — the requests that wait but cannot be approved now (out of date: Reject only).
    waitingStale: new Set(rows.filter((r) => r.state === 'WAITING' && r.waiting?.stale).map((r) => r.waiting!.approvalId)).size,
    harvested30d: rows.filter((r) => r.state === 'HARVESTED' && r.lastHarvest && Date.parse(r.lastHarvest.at) >= monthAgo).length,
    worse: rows.filter((r) => r.lastHarvest?.verdict === 'worse' && r.state === 'HARVESTED').length,
    waitingToJudge: rows.filter((r) => r.state === 'HARVESTED' && (r.lastHarvest?.verdict == null || r.lastHarvest.verdict === 'too-early')).length,
    skipped: n('SKIPPED'), ownedBySibling: n('OWNED_BY_SIBLING'), belowBar: n('BELOW_BAR'), atHome: n('AT_HOME'),
  }
}

/** Read the candidates of the markets asked: every row in scope, filtered by state and owner, sorted, one page. */
export async function harvestCandidates(q: CandidatesQuery, opts: { now?: Date; all?: boolean } = {}): Promise<{ data: CandidatesAnswer } | { error: string; status: 400 | 404 }> {
  const now = opts.now ?? new Date()
  const markets = await marketsOf(q.market)
  if ('error' in markets) return { error: markets.error, status: 400 }
  const wanted = q.state?.length ? (q.state.includes('all') ? [...ALL_STATES] : q.state.map((s) => s.toUpperCase())) : [...DEFAULT_STATES]
  const bad = wanted.filter((s) => !(ALL_STATES as readonly string[]).includes(s))
  if (bad.length) return { error: `state: ${bad.join(', ')} is not a state (${ALL_STATES.join(', ')})`, status: 400 }
  if (q.owner && !['BRAIN', 'RULE', 'PERSON', 'NONE'].includes(q.owner.toUpperCase())) return { error: 'owner: one of BRAIN, RULE, PERSON, NONE', status: 400 }
  const all: HarvestCandidateRow[] = []
  const criteria: CandidatesAnswer['criteria']['markets'] = []
  const skipped: CandidatesAnswer['skipped'] = []
  let dataDay: string | null = null
  let windowDays: number | null = null
  const products = mergeIds(q.productId, q.productIds)
  for (const market of markets) {
    const got = await marketRows(market, { productIds: products, now })
    if ('error' in got) {
      if (products && got.status === 404) return got
      continue
    }
    all.push(...got.rows)
    dataDay = got.facts.dataDay.toISOString().slice(0, 10)
    windowDays = got.facts.windowDays
    for (const s of got.facts.skipped) skipped.push({ market: got.facts.market, ...s })
    // The bar in force for the market: the strategy's group where its products carry one, else the brain's test.
    const groups = [...got.facts.products.values()].map((p) => p.facts.ctx.harvestGroup).filter((g): g is NonNullable<typeof g> => !!g)
    const g = groups[0] ?? null
    criteria.push(g
      ? { market: got.facts.market, by: 'strategy', source: g.source, minOrders: g.minOrders, minClicks: g.minClicks, maxAcosPct: g.maxAcosPct, windowDays: g.windowDays }
      : { market: got.facts.market, by: 'brain', source: null, minOrders: null, minClicks: null, maxAcosPct: null, windowDays: got.facts.windowDays })
  }
  const scoped = all.filter(inScope(q))
  const owner = q.owner?.toUpperCase() ?? null
  const filtered = scoped.filter((r) => wanted.includes(r.state) && (!owner || r.owner.kind === owner))
  const sortRaw = (q.sort ?? '-orders').trim()
  const desc = sortRaw.startsWith('-')
  const key = SORTS[sortRaw.replace(/^-/, '')] ?? SORTS.orders
  filtered.sort((a, b) => {
    const x = key(a), y = key(b)
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return (desc ? -c : c) || a.id.localeCompare(b.id)
  })
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.round(q.pageSize ?? 50)))
  const page = Math.max(1, Math.round(q.page ?? 1))
  const rows = opts.all ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize)
  const label = criteria.length === 1 ? (criteria[0].by === 'strategy' ? 'Ads strategy' : 'Brain test') : criteria.every((c) => c.by === 'strategy') ? 'Ads strategy' : criteria.some((c) => c.by === 'strategy') ? 'Ads strategy · Brain test' : 'Brain test'
  return {
    data: {
      markets, rows, total: filtered.length, page, pageSize, totals: totalsOf(scoped, now),
      criteria: { label, markets: criteria }, freshness: { dataDay, windowDays }, skipped,
    },
  }
}

/** Every id that matches, at most MAX_IDS (Claude's harvest-candidates idsOnly: a harvest or a skip of all of them). */
export async function harvestCandidateIds(q: CandidatesQuery, opts: { now?: Date } = {}): Promise<{ data: { ids: string[]; total: number } } | { error: string; status: 400 | 404 }> {
  const got = await harvestCandidates({ ...q, page: 1, pageSize: MAX_PAGE_SIZE }, { ...opts, all: true })
  if ('error' in got) return got
  return { data: { ids: got.data.rows.slice(0, MAX_IDS).map((r) => r.id), total: got.data.total } }
}
