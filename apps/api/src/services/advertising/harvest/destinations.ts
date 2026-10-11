/**
 * HARVEST ENGINE — GET /api/advertising/harvest/destinations: where a product's harvest can go, as the picker shows it —
 * its portfolios → campaigns → ad groups (only the product's own campaigns, brain/ownership.ts, plus the Owner's stored
 * destinations), each option with `held` (why it cannot take the keyword now: an automatic ad group, paused, an archived
 * copy there, a negative there that blocks it) and `suggested` (the engine's own pick for this term and match), and the
 * new campaign the engine would build (the product's funnel campaign for the match, in its portfolio). Read only.
 */
import prisma from '../../../db.js'
import { AMAZON_MIN_BUDGET_CENTS, type HarvestGroup } from '../brain/harvest.js'
import { landingLookup, loadMarketFacts, type MarketFacts } from './facts.js'
import { adGroupRef, campaignRef, parseCandidateId, portfolioRef, productRef, type Ref } from './ids.js'
import { harvestCampaignName, placeRefusal, suggestDestination, type Hold } from './plan.js'
import { planProductOf, planTermOf } from './candidates.js'
import type { HarvestMatch } from './write.js'

export interface DestAdGroup extends Ref { role: string | null; keywords: number; productTargets: number; serving: boolean; held: null | Pick<Hold, 'label' | 'reason'>; suggested: boolean }
export interface DestCampaign extends Ref { status: string; serving: boolean; role: string | null; dailyBudgetCents: number | null; biddingStrategy: string | null; own: boolean; adGroups: DestAdGroup[] }
export interface DestinationsAnswer {
  market: string
  product: Ref
  match: HarvestMatch
  term: string | null
  suggested: { kind: 'existing'; adGroupId: string; campaignId: string; why: string } | { kind: 'new'; why: string } | { kind: 'held'; label: string; reason: string } | null
  portfolios: Array<Ref & { campaigns: DestCampaign[] }>
  unplaced: DestCampaign[]
  newCampaign: { name: string; adGroupName: string; portfolio: Ref | null; dailyBudgetCents: number; held: null | { label: string; reason: string } }
  stored: Array<{ grain: string; scopeId: string; match: string; adGroup: Ref | null; negateAtSource: boolean; own: boolean }>
}

const short = (reason: string): string => {
  if (/automatic/.test(reason)) return 'Auto group'
  if (/does not serve/.test(reason)) return 'Paused'
  if (/archived copy/.test(reason)) return 'Archived copy'
  if (/negative/.test(reason)) return 'Blocked by negative'
  if (/keyword ad group|product-target ad group/.test(reason)) return 'Wrong kind'
  return 'Not usable'
}

export async function harvestDestinations(q: { market: string; productId?: string | null; candidateId?: string | null; match?: HarvestMatch | null }, opts: { now?: Date; facts?: MarketFacts } = {}): Promise<{ data: DestinationsAnswer } | { error: string; status: 400 | 404 }> {
  const cand = q.candidateId ? parseCandidateId(q.candidateId) : null
  if (q.candidateId && !cand) return { error: `candidateId: ${q.candidateId} is not a candidate id (market|productId|term)`, status: 400 }
  const productId = cand?.productId ?? q.productId ?? null
  if (!productId) return { error: 'productId (or candidateId): name the product', status: 400 }
  const facts = opts.facts ?? await loadMarketFacts(cand?.market ?? q.market, { productId, now: opts.now })
  if ('error' in facts) return facts
  const p = [...facts.products.values()][0]
  if (!p) return { error: `This product has no Sponsored Products campaign of its own in ${facts.market}: there is no place to harvest into yet (a new campaign needs a campaign of the product to copy its products from).`, status: 404 }
  const term = cand?.term ?? null
  const pp = planProductOf(p, facts)
  const t = term ? planTermOf(p, term, p.decisions.get(term) ?? null) : null
  const match: HarvestMatch = t?.isAsin ? 'EXACT' : (q.match ?? 'EXACT')

  // The stored destinations that cover this product, and their ad groups (they may sit outside its own campaigns).
  const storedRows = await prisma.adsHarvestDestination.findMany({ select: { scopeGrain: true, scopeId: true, matchType: true, adGroupId: true, negateAtSource: true } })
  const ownCampaigns = new Set([...p.facts.groups.values()].map((g) => g.campaignId))
  const ownGroups = new Set(p.facts.groups.keys())
  const covers = (r: { scopeGrain: string; scopeId: string }) => (r.scopeGrain === 'adGroup' && ownGroups.has(r.scopeId)) || (r.scopeGrain === 'campaign' && ownCampaigns.has(r.scopeId))
    || (r.scopeGrain === 'portfolio' && [...ownCampaigns].some((c) => facts.campaigns.get(c)?.portfolioId === r.scopeId))
    || (r.scopeGrain === 'line' && r.scopeId === p.productId) || (r.scopeGrain === 'market' && r.scopeId.toUpperCase() === facts.market) || r.scopeGrain === 'account'
  const stored = storedRows.filter(covers)

  const landing = term ? await landingLookup([...p.facts.groups.keys()].map((adGroupId) => ({ adGroupId, term, match, isAsin: !!t?.isAsin }))) : null
  const landFor = (gid: string) => (landing && term ? landing(gid, term, match, !!t?.isAsin) : null)
  const suggestion = t ? suggestDestination(pp, t, match, landFor) : null
  const suggestedId = suggestion?.kind === 'existing' ? suggestion.group.id : null

  const groupsByCampaign = new Map<string, HarvestGroup[]>()
  for (const g of p.facts.groups.values()) groupsByCampaign.set(g.campaignId, [...(groupsByCampaign.get(g.campaignId) ?? []), g])
  const campaigns: DestCampaign[] = []
  for (const [cid, groups] of groupsByCampaign) {
    const c = facts.campaigns.get(cid)
    const adGroups = groups.sort((a, b) => a.name.localeCompare(b.name)).map((g): DestAdGroup => {
      const no = placeRefusal(g, !!t?.isAsin, landFor(g.id))
      return { ...adGroupRef(g.id, g.name, cid), role: g.role, keywords: g.keywords, productTargets: g.productTargets, serving: g.serving, held: no ? { label: short(no), reason: `${no[0].toUpperCase()}${no.slice(1)}.` } : null, suggested: g.id === suggestedId }
    })
    campaigns.push({
      ...campaignRef(cid, c?.name ?? groups[0]?.campaignName), status: c?.status ?? 'UNKNOWN', serving: groups.some((g) => g.serving), role: groups.length === 1 ? groups[0].role : null,
      dailyBudgetCents: c?.dailyBudgetCents ?? null, biddingStrategy: c?.biddingStrategy ?? null, own: true, adGroups,
    })
  }
  campaigns.sort((a, b) => a.name.localeCompare(b.name))
  const portfolios = new Map<string, Ref & { campaigns: DestCampaign[] }>()
  const unplaced: DestCampaign[] = []
  for (const c of campaigns) {
    const pid = facts.campaigns.get(c.id)?.portfolioId
    if (!pid) { unplaced.push(c); continue }
    const entry = portfolios.get(pid) ?? { ...portfolioRef(pid, facts.portfolios.get(pid)), campaigns: [] }
    entry.campaigns.push(c)
    portfolios.set(pid, entry)
  }
  const storedGroups = new Map((stored.length ? await prisma.adGroup.findMany({ where: { id: { in: stored.map((s) => s.adGroupId) } }, select: { id: true, name: true, campaignId: true } }) : []).map((g) => [g.id, g]))
  const nc = p.facts.newCampaign
  const naming = harvestCampaignName(pp.label, match, nc?.takenNames ?? new Set())
  return {
    data: {
      market: facts.market, product: productRef(p.productId, p.name), match, term,
      suggested: !suggestion ? null : suggestion.kind === 'existing' ? { kind: 'existing', adGroupId: suggestion.group.id, campaignId: suggestion.group.campaignId, why: suggestion.why }
        : suggestion.kind === 'new' ? { kind: 'new', why: suggestion.why } : { kind: 'held', label: suggestion.hold.label, reason: suggestion.hold.reason },
      portfolios: [...portfolios.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unplaced,
      newCampaign: {
        ...naming,
        portfolio: p.portfolioId ? portfolioRef(p.portfolioId, facts.portfolios.get(p.portfolioId)) : null,
        dailyBudgetCents: nc?.dailyBudgetCents ?? AMAZON_MIN_BUDGET_CENTS,
        held: nc ? null : { label: 'No product ad', reason: `A new campaign advertises the product's SKUs, and ${p.facts.newCampaignRefusal ?? 'none is known'}.` },
      },
      stored: stored.map((s) => {
        const g = storedGroups.get(s.adGroupId)
        return { grain: s.scopeGrain, scopeId: s.scopeId, match: s.matchType, adGroup: g ? adGroupRef(g.id, g.name, g.campaignId) : null, negateAtSource: s.negateAtSource, own: ownGroups.has(s.adGroupId) }
      }),
    },
  }
}
