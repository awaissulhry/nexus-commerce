/**
 * HARVEST ENGINE — the preview of a change set (POST /api/advertising/harvest/preview, and the `apply-harvest` request's
 * own preview): what the request would do, step by step, with every refusal, before anything is written. Writes nothing.
 *
 *   items        built from the request's own items (B5): each candidate id is read again, whatever filter the page
 *                showed it under; every item comes back — harvestable, or refused with why — never dropped.
 *   stages       new portfolio → new campaign (the product's funnel campaign for the match: one ad group, its products,
 *                in its portfolio, the SP Super Wizard's naming) → keywords → source negatives → funnel negatives. A step
 *                names what it waits for (`after`).
 *   gate         every half is asked of the write gate as the writer that runs it (a person's approval: `manual`): any
 *                refusal blocks its item whole (both halves or neither), named.
 *   planHash     the fingerprint of what would be written: apply refuses a change set whose plan moved since the preview.
 */
import { z } from 'zod'
import { checkAdsWriteGate } from '../ads-write-gate.js'
import { AMAZON_MIN_BUDGET_CENTS } from '../brain/harvest.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { fingerprint } from '../../agents/tools/ads-targeting-kit.js'
import { planProductOf, planTermOf } from './candidates.js'
import { landingLookup, loadMarketFacts, recordKey, type LandingLookup, type MarketFacts } from './facts.js'
import { adGroupRef, campaignRef, candidateIdOf, parseCandidateId, portfolioRef, type Ref } from './ids.js'
import { harvestCampaignName, planItem, type ActorKind, type NewCampaignSpec, type PlannedItem } from './plan.js'
import { openHarvestRequests } from './waiting.js'
import { preflightHarvest, type HarvestMatch, type OwnLimitWarning, type Who } from './write.js'
import { needsCode } from '../../agents/tools/ads-code-rule.js'
import { STEP_UP_NEEDS, type StepUp } from '../../agents/step-up-approval.js'
import prisma from '../../../db.js'

export const MAX_ITEMS = 200
const MATCH = z.enum(['EXACT', 'PHRASE'])
const KEY = z.string().trim().min(1).max(40)

export const ITEM_INPUT = z.object({
  candidateId: z.string().trim().min(5).max(300).describe('the candidate (market|productId|term, from harvest-candidates)'),
  to: z.union([z.object({ adGroupId: z.string().trim().min(1).max(64) }), z.object({ newCampaign: KEY })]).optional()
    .describe('where it goes: an ad group of the product\'s own campaigns, or a new campaign of this change set (newCampaigns[].key); absent = the suggested place'),
  match: MATCH.optional().describe('EXACT (default) or PHRASE'),
  bidCents: z.coerce.number().int().min(2).max(10_000).optional().describe('the start bid in minor units of the market\'s currency (default: the bid brain\'s goal bid)'),
  negateSource: z.boolean().optional().describe('false leaves the sources running; true blocks them even where the saved harvest place says not to (default: block, unless the saved place says not to)'),
  funnel: z.boolean().optional().describe('false leaves the funnel blocks out (default: exact → negative exact in the product\'s phrase / broad / auto ad groups; phrase → negative phrase in broad / auto)'),
})
export const NEW_CAMPAIGN_INPUT = z.object({
  key: KEY.describe('this new campaign\'s key inside the change set (items name it: to: { newCampaign: key })'),
  productId: z.string().trim().min(1).max(64).describe('the product it is for (the family root of its items\' candidateIds)'),
  match: MATCH.optional().describe('EXACT (default) or PHRASE: the match of its keywords'),
  name: z.string().trim().min(1).max(128).optional().describe('its name (default: the SP Super Wizard\'s naming, new in the market)'),
  dailyBudgetCents: z.coerce.number().int().min(AMAZON_MIN_BUDGET_CENTS).max(10_000_000).optional().describe('its daily budget in minor units of the market\'s currency (default: the product\'s usual)'),
  portfolio: z.union([z.object({ id: z.string().trim().min(1).max(64) }), z.object({ newPortfolio: KEY }), z.null()]).optional()
    .describe('the portfolio it is born in: { id } (an Amazon portfolio id), { newPortfolio: key } (newPortfolios), or null for none (default: the product\'s portfolio)'),
  market: z.string().trim().min(2).max(10).optional()
    .describe('the market it is built in (default: the market of the items that name it — they must all be of one market; a campaign belongs to one market)'),
})
export const NEW_PORTFOLIO_INPUT = z.object({
  key: KEY.describe('this new portfolio\'s key inside the change set (a new campaign names it: portfolio: { newPortfolio: key })'),
  name: z.string().trim().min(1).max(100).describe('its name'),
  capMonthlyCents: z.coerce.number().int().min(100).max(100_000_000).optional().describe('its monthly spend cap in minor units of the market\'s currency (default: none)'),
})
export const PREVIEW_INPUT = z.object({
  items: z.array(ITEM_INPUT).min(1).max(MAX_ITEMS),
  newCampaigns: z.array(NEW_CAMPAIGN_INPUT).max(20).optional(),
  newPortfolios: z.array(NEW_PORTFOLIO_INPUT).max(10).optional(),
})
export type PreviewBody = z.infer<typeof PREVIEW_INPUT>

export type StepKind = 'portfolio' | 'portfolioCap' | 'campaign' | 'keyword' | 'enable' | 'sourceNegative' | 'funnelNegative'
export interface Step {
  i: number
  kind: StepKind
  candidateId?: string
  term?: string
  portfolio?: Ref | null
  campaign?: Ref | null
  adGroup?: Ref | null
  match?: HarvestMatch
  bidCents?: number
  dailyBudgetCents?: number
  capMonthlyCents?: number
  from: string
  to: string
  after: number[]
  refusal: string | null
  /** M3 — approving this step needs the approver's authenticator code (code rule A: a new campaign going live). */
  needsCode?: boolean
  /** M2 — the person's own limits this step goes past (3A): warned on the card, approving it sends it anyway. */
  pastOwnLimits?: Array<{ limit: string; reason: string }>
}

export interface PreviewItem {
  candidateId: string
  term: string
  productId: string
  market: string
  ok: boolean
  refusal: string | null
  hold: PlannedItem['hold']
  match: HarvestMatch
  destination: null | { kind: 'existing'; how: string; adGroup: Ref; campaign: Ref; portfolio: Ref | null; status: string } | { kind: 'new'; key: string; name: string }
  bidCents: number | null
  bidWhy: string | null
  sources: Array<{ adGroup: Ref; campaign: Ref; action: string; negMatch: HarvestMatch; why: string }>
  funnel: Array<{ adGroup: Ref; campaign: Ref; action: string; negMatch: HarvestMatch; why: string }>
  /** M2 — the person's own limits its writes go past (each half's), warned, never hidden. */
  warnings: OwnLimitWarning[]
}

export interface ResolvedPortfolio { key: string; name: string; market: string; capMonthlyCents: number | null }

/** Everything execute needs, beside what the person reads. */
export interface ChangeSetPlan {
  markets: string[]
  items: PlannedItem[]
  newCampaigns: Array<NewCampaignSpec & { market: string; skus: string[]; defaultBidCents: number; currency: string | null }>
  newPortfolios: ResolvedPortfolio[]
}

export interface PreviewAnswer {
  steps: Step[]
  items: PreviewItem[]
  approvals: { count: number; codes: number }
  /** M3 — set when approving it needs the approver's authenticator code (code rule A): the request carries it. */
  stepUp: StepUp | null
  /** M2 — every own limit the change set goes past, once each. */
  pastOwnLimits: Array<{ limit: string; reason: string }>
  blocked: Array<{ candidateId: string; term: string; reason: string }>
  /** R9 — each new campaign asked: its market and its holds, each with its level ('market' = the market cannot build one). */
  newCampaigns: Array<{ key: string; market: string | null; holds: Array<{ level: 'market' | 'product' | 'choice'; reason: string }> }>
  totals: { items: number; ok: number; keywords: number; enables: number; sourceNegatives: number; funnelNegatives: number; campaigns: number; portfolios: number }
  planHash: string
  raises: string[]
  effect: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The plan of a request (the facts read now), and the answer a person reads. Writes nothing. */
export async function previewChangeSet(body: PreviewBody, opts: { actor: ActorKind; who: Who; now?: Date; facts?: Map<string, MarketFacts>; /** H1 — the request that runs this plan: never "waiting" for itself. */ exceptApprovalId?: string | null }): Promise<{ data: PreviewAnswer; plan: ChangeSetPlan } | { error: string; status: 400 | 404 }> {
  const now = opts.now ?? new Date()
  const parsed = body.items.map((it) => ({ it, id: parseCandidateId(it.candidateId) }))
  const badId = parsed.find((x) => !x.id)
  if (badId) return { error: `items: ${badId.it.candidateId} is not a candidate id (market|productId|term)`, status: 400 }
  const byMarket = new Map<string, Set<string>>()
  for (const { id } of parsed) byMarket.set(id!.market, (byMarket.get(id!.market) ?? new Set()).add(id!.productId))
  const facts = new Map<string, MarketFacts>(opts.facts ?? [])
  for (const [market, products] of byMarket) {
    if (facts.has(market)) continue
    const f = await loadMarketFacts(market, { productId: products.size === 1 ? [...products][0] : null, now })
    if ('error' in f) return f
    facts.set(market, f)
  }
  const waiting = await openHarvestRequests([...byMarket.keys()], opts.exceptApprovalId ?? null)

  // New portfolios and new campaigns, resolved and checked.
  const portfolios = new Map<string, ResolvedPortfolio>()
  for (const np of body.newPortfolios ?? []) {
    if (portfolios.has(np.key)) return { error: `newPortfolios: the key ${np.key} is listed twice`, status: 400 }
    portfolios.set(np.key, { key: np.key, name: np.name.trim(), market: '', capMonthlyCents: np.capMonthlyCents ?? null })
  }
  // R9 (release review) — each new campaign's holds, with their level: 'market' (nothing a person types here changes it:
  // the market has no daily spend ceiling), 'product' (the product cannot have one: no SKU, no campaign of its own there),
  // 'choice' (what was asked: its budget, name, portfolio, market). The window holds "New campaign" up front only for a
  // market-level one; a 'choice' one is said where it is typed.
  const campaignHolds = new Map<string, Array<{ level: 'market' | 'product' | 'choice'; reason: string }>>()
  const refuseCampaign = (key: string, level: 'market' | 'product' | 'choice', reason: string) => campaignHolds.set(key, [...(campaignHolds.get(key) ?? []), { level, reason }])
  const campaignRefusal = new Map<string, string>()
  const campaigns = new Map<string, ChangeSetPlan['newCampaigns'][number]>()
  const takenNew = new Set<string>()
  for (const nc of body.newCampaigns ?? []) {
    if (campaigns.has(nc.key)) return { error: `newCampaigns: the key ${nc.key} is listed twice`, status: 400 }
    // R1 (release review) — its ONE market: the one named, else the market of the items that name it (all of one market);
    // an item of another market is refused at its plan. Never "the first item of the product" (any market).
    const naming = parsed.filter((x) => x.it.to && 'newCampaign' in x.it.to && x.it.to.newCampaign === nc.key && x.id!.productId === nc.productId)
    const itemMarkets = [...new Set(naming.map((x) => x.id!.market))]
    const asked = nc.market ? strategyMarket(nc.market) : null
    if (nc.market && !asked) { refuseCampaign(nc.key, 'choice', `${nc.market} is not a market code`); continue }
    if (!asked && itemMarkets.length > 1) { refuseCampaign(nc.key, 'choice', `its items are in ${itemMarkets.join(' and ')}: a campaign belongs to one market — give each market its own new campaign`); continue }
    const market = asked ?? itemMarkets[0] ?? parsed.find((x) => x.id!.productId === nc.productId)?.id!.market ?? null
    if (market && !facts.has(market)) { refuseCampaign(nc.key, 'choice', `no item of this change set is in ${market}`); continue }
    const f = market ? facts.get(market) : undefined
    const p = f?.products.get(nc.productId)
    const match: HarvestMatch = nc.match ?? 'EXACT'
    if (!f || !p) {
      refuseCampaign(nc.key, 'product', 'no item of this change set harvests this product into it, or the product owns no campaign in that market')
      continue
    }
    const taken = new Set([...(p.facts.newCampaign?.takenNames ?? []), ...takenNew])
    const named = nc.name ? { name: nc.name.trim(), adGroupName: `${nc.name.trim()} Ad Group`.slice(0, 128) } : harvestCampaignName(p.sku || p.name, match, taken)
    takenNew.add(named.name.toLowerCase())
    let portfolio: NewCampaignSpec['portfolio'] = nc.portfolio === undefined ? (p.portfolioId ? { id: p.portfolioId } : null) : nc.portfolio
    if (portfolio && 'newPortfolio' in portfolio) {
      const np = portfolios.get(portfolio.newPortfolio)
      if (!np) refuseCampaign(nc.key, 'choice', `its new portfolio "${portfolio.newPortfolio}" is not described in newPortfolios`)
      else if (np.market && np.market !== f.market) refuseCampaign(nc.key, 'choice', 'its new portfolio is for another market: a portfolio belongs to one market')
      else np.market = f.market
    } else if (portfolio && 'id' in portfolio) {
      if (!f.portfolios.has(portfolio.id)) refuseCampaign(nc.key, 'choice', `the portfolio ${portfolio.id} is not one of this business's portfolios`)
      else if (portfolio.id.startsWith('local-pf-')) refuseCampaign(nc.key, 'choice', 'that portfolio lives in Nexus only (Amazon never took it): pick another, or a new one')
      else {
        // L2 — a portfolio belongs to one market: one that holds another market's campaigns is refused.
        const other = await prisma.campaign.findFirst({ where: { portfolioId: portfolio.id, NOT: { marketplace: { in: [f.market, ...[...f.campaigns.values()].map((c) => c.marketplace).filter((m): m is string => !!m)] } } }, select: { marketplace: true } })
        if (other) refuseCampaign(nc.key, 'choice', `the portfolio holds campaigns of ${other.marketplace}: a portfolio belongs to one market`)
      }
    }
    // M3 — inside caps: the market's spend ceiling (a daily cap) must exist, and the new budget alone must fit under it.
    const ceiling = await prisma.adSpendCeiling.findFirst({ where: { grain: 'MARKET', scopeId: f.market, enabled: true, dailyCapCents: { not: null } }, select: { label: true, dailyCapCents: true } })
    const wantBudget = nc.dailyBudgetCents ?? p.facts.newCampaign?.dailyBudgetCents ?? AMAZON_MIN_BUDGET_CENTS
    if (!ceiling) refuseCampaign(nc.key, 'market', `${f.market} has no daily spend ceiling: set one first (a new campaign is built only inside the market's spend ceiling)`)
    else if (wantBudget > (ceiling.dailyCapCents as number)) refuseCampaign(nc.key, 'choice', `its daily budget is above ${ceiling.label}'s spend ceiling a day`)
    if (taken.has(named.name.toLowerCase())) refuseCampaign(nc.key, 'choice', `${f.market} already has a campaign named "${named.name}": give it another name`)
    const skus = p.facts.newCampaign?.skus ?? []
    if (!skus.length) refuseCampaign(nc.key, 'product', `the product's own campaigns advertise no SKU Nexus knows (${p.facts.newCampaignRefusal ?? 'none'}): a new campaign has nothing to advertise`)
    const budget = nc.dailyBudgetCents ?? p.facts.newCampaign?.dailyBudgetCents ?? AMAZON_MIN_BUDGET_CENTS
    campaigns.set(nc.key, { key: nc.key, productId: p.productId, match, ...named, dailyBudgetCents: budget, portfolio, market: f.market, skus, defaultBidCents: 0, currency: [...f.campaigns.values()].find((c) => c.currency)?.currency ?? null })
  }

  // The reason an item names: a market-level hold first (it is the one no field fixes), else the first.
  for (const [key, holds] of campaignHolds) campaignRefusal.set(key, (holds.find((h) => h.level === 'market') ?? holds[0]).reason)

  // The landing facts of every place an item may go (B1 / B10): one read per market.
  const landings = new Map<string, LandingLookup>()
  for (const [market, f] of facts) {
    const pairs = parsed.filter((x) => x.id!.market === market).flatMap(({ it, id }) => {
      const p = f.products.get(id!.productId)
      const asin = /^b0[a-z0-9]{8}$/i.test(id!.term)
      return p ? [...p.facts.groups.keys()].map((adGroupId) => ({ adGroupId, term: id!.term, match: (it.match ?? 'EXACT') as HarvestMatch, isAsin: asin })) : []
    })
    landings.set(market, await landingLookup(pairs))
  }

  // Each item, planned on its own (never dropped).
  const seen = new Set<string>()
  const planned: PlannedItem[] = []
  for (const { it, id } of parsed) {
    const cid = candidateIdOf(id!.market, id!.productId, id!.term)
    const f = facts.get(id!.market)!
    const p = f.products.get(id!.productId)
    const blank = (reason: string, label: string): PlannedItem => ({ candidateId: cid, productId: id!.productId, market: id!.market, term: id!.term, isAsin: /^b0[a-z0-9]{8}$/i.test(id!.term), match: it.match ?? 'EXACT', refusal: reason, hold: { kind: 'record', label, reason }, destination: null, bid: null, sources: [], funnel: [], storedKeepsSources: false, harvestedOn: null })
    if (seen.has(cid)) { planned.push(blank('It is listed twice in this change set.', 'Listed twice')); continue }
    seen.add(cid)
    if (!p) { planned.push(blank(`The product owns no Sponsored Products campaign in ${id!.market} (a shared campaign is no product's): there is no place of its own to harvest into.`, 'No campaign')); continue }
    const nc = it.to && 'newCampaign' in it.to ? campaigns.get(it.to.newCampaign) ?? null : null
    if (it.to && 'newCampaign' in it.to && campaignRefusal.has(it.to.newCampaign)) {
      planned.push(blank(`The new campaign cannot be built: ${campaignRefusal.get(it.to.newCampaign)}.`, 'Campaign not buildable'))
      continue
    }
    const record = f.records.get(recordKey(p.productId, id!.term)) ?? null
    const landing = landings.get(id!.market)!
    const t = planTermOf(p, id!.term, p.decisions.get(id!.term) ?? null)
    const item = planItem({
      req: { ...it, candidateId: cid }, actor: opts.actor, product: planProductOf(p, f), term: t,
      record: record ? { status: record.status, actorKind: record.actorKind, destAdGroupId: record.destAdGroupId } : null, waiting: waiting.has(cid), newCampaign: nc,
      landing: (gid) => landing(gid, id!.term, it.match ?? 'EXACT', t.isAsin),
    })
    planned.push(item)
  }

  // The write gate, as the writer that runs each half: a refusal blocks the item whole; the person's own limits each
  // half goes past are warned (M2: asked with his confirmation, so `pastOwnLimits` comes back instead of a refusal).
  const warningsOf = new Map<string, OwnLimitWarning[]>()
  const campaignWarnings = new Map<string, Array<{ limit: string; reason: string }>>()
  const portfolioWarnings = new Map<string, Array<{ limit: string; reason: string }>>()
  for (const item of planned) {
    if (item.refusal || !item.destination || !item.bid) continue
    if (item.destination.kind === 'existing') {
      const pre = await preflightHarvest({
        term: item.term, isAsin: item.isAsin, destAdGroupId: item.destination.adGroupId, bidCents: item.bid.cents,
        keyword: item.destination.status === 'already-there' ? 'stands' : item.destination.status === 're-enable' ? 'enable' : 'create',
        blocks: [...item.sources, ...item.funnel].filter((s) => s.action === 'negate'),
      }, opts.who)
      if (!('ok' in pre)) {
        item.refusal = `Amazon's write gate refuses the ${pre.half === 'keyword' ? 'keyword' : 'negative'} in ad group ${pre.adGroupId} (${pre.refusal}): nothing of it is written.`
        item.hold = { kind: 'destination', label: 'Gate refuses', reason: item.refusal }
      } else warningsOf.set(item.candidateId, pre.warnings)
    }
  }
  // A new campaign is asked of the gate as its create (the market, its first budget), once.
  for (const nc of campaigns.values()) {
    if (!planned.some((i) => !i.refusal && i.destination?.kind === 'new' && i.destination.key === nc.key)) continue
    const gate = await checkAdsWriteGate({ marketplace: nc.market, payloadValueCents: nc.dailyBudgetCents, dimension: 'structure', field: 'dailyBudget', intendedValueCents: nc.dailyBudgetCents, actor: opts.who.actor, ...(opts.who.manual ? { manual: true, confirmOwnLimits: true } : {}) } as never)
    // M2 — a budget past the person's own limits (the per-write value cap, his spend ceilings): warned on the card.
    if (gate.allowed !== false) campaignWarnings.set(nc.key, ((gate as { pastOwnLimits?: Array<{ limit: string; reason: string }> }).pastOwnLimits ?? []).map((l) => ({ limit: String(l.limit), reason: l.reason })))
    if (gate.allowed === false) {
      for (const i of planned) if (!i.refusal && i.destination?.kind === 'new' && i.destination.key === nc.key) {
        i.refusal = `Amazon's write gate refuses the new campaign "${nc.name}" (${gate.reason}): nothing of it is written.`
        i.hold = { kind: 'destination', label: 'Gate refuses', reason: i.refusal }
      }
    }
    // Its default bid: the highest start bid of its keywords (Amazon refuses an ad group default above the budget).
    nc.defaultBidCents = Math.max(2, ...planned.filter((i) => !i.refusal && i.destination?.kind === 'new' && i.destination.key === nc.key).map((i) => i.bid?.cents ?? 2))
    if (nc.defaultBidCents > nc.dailyBudgetCents) {
      for (const i of planned) if (!i.refusal && i.destination?.kind === 'new' && i.destination.key === nc.key) {
        i.refusal = `A start bid is above the new campaign's daily budget: raise the budget or lower the bid.`
        i.hold = { kind: 'bid', label: 'Bid above budget', reason: i.refusal }
      }
    }
  }

  // M3 / L2 — a new portfolio's monthly cap inside the portfolio cap limit (the gate's own limit), its currency the market's.
  for (const np of portfolios.values()) {
    if (!np.capMonthlyCents || !np.market) continue
    const capGate = await checkAdsWriteGate({ marketplace: np.market, payloadValueCents: np.capMonthlyCents, dimension: 'portfolio', actor: opts.who.actor, ...(opts.who.manual ? { manual: true, confirmOwnLimits: true } : {}) } as never)
    const past = ((capGate as { pastOwnLimits?: Array<{ limit: string; reason: string }> }).pastOwnLimits ?? []).map((l) => ({ limit: String(l.limit), reason: l.reason }))
    const over = capGate.allowed === false && (capGate as { deniedAt?: string }).deniedAt === 'portfolio_cap_limit' ? (capGate as { reason: string }).reason : past.find((l) => l.limit === 'portfolio_cap_limit')?.reason ?? null
    if (over) {
      for (const nc of campaigns.values()) if (nc.portfolio && 'newPortfolio' in nc.portfolio && nc.portfolio.newPortfolio === np.key) {
        for (const i of planned) if (!i.refusal && i.destination?.kind === 'new' && i.destination.key === nc.key) {
          i.refusal = `The new portfolio's monthly cap is above the portfolio cap limit (${over}): lower it, or raise the limit first.`
          i.hold = { kind: 'cap', label: 'Cap above limit', reason: i.refusal }
        }
      }
    } else if (past.length) portfolioWarnings.set(np.key, past)
  }

  // The steps, in order: portfolios → campaigns → keywords → negatives.
  const ok = planned.filter((i) => !i.refusal)
  const usedCampaigns = [...campaigns.values()].filter((nc) => ok.some((i) => i.destination?.kind === 'new' && i.destination.key === nc.key))
  const usedPortfolios = [...portfolios.values()].filter((np) => usedCampaigns.some((nc) => nc.portfolio && 'newPortfolio' in nc.portfolio && nc.portfolio.newPortfolio === np.key))
  const steps: Step[] = []
  const add = (s: Omit<Step, 'i'>) => { const step = { ...s, i: steps.length }; steps.push(step); return step.i }
  // M3 (code rule A, Owner 10-07) — a NEW campaign that goes live at once (born serving, on the live-write allowlist, with
  // its product ads) is a big door: the approver's authenticator code, for the page and Claude alike. Only the brain's own
  // harvest campaigns go live with a normal approval (10-08 D1 = B: harvest-golive.ts), and they never come through here.
  const coded = usedCampaigns.length > 0 && opts.actor !== 'BRAIN' && needsCode('set-campaign-live-writes: on')
  const pfStep = new Map<string, number>()
  for (const np of usedPortfolios) {
    pfStep.set(np.key, add({ kind: 'portfolio', portfolio: { id: `new:${np.key}`, name: np.name }, from: 'none', to: 'new portfolio', after: [], refusal: null, needsCode: coded }))
    if (np.capMonthlyCents) add({ kind: 'portfolioCap', portfolio: { id: `new:${np.key}`, name: np.name }, capMonthlyCents: np.capMonthlyCents, from: 'no cap', to: 'monthly cap', after: [pfStep.get(np.key)!], refusal: null, ...(portfolioWarnings.get(np.key)?.length ? { pastOwnLimits: portfolioWarnings.get(np.key) } : {}) })
  }
  const cStep = new Map<string, number>()
  for (const nc of usedCampaigns) {
    const f = facts.get(nc.market)!
    const pf = nc.portfolio && 'id' in nc.portfolio ? portfolioRef(nc.portfolio.id, f.portfolios.get(nc.portfolio.id)) : nc.portfolio && 'newPortfolio' in nc.portfolio ? { id: `new:${nc.portfolio.newPortfolio}`, name: portfolios.get(nc.portfolio.newPortfolio)?.name ?? nc.portfolio.newPortfolio } : null
    cStep.set(nc.key, add({
      kind: 'campaign', portfolio: pf, campaign: { id: `new:${nc.key}`, name: nc.name }, adGroup: { id: `new:${nc.key}:group`, name: nc.adGroupName }, match: nc.match,
      dailyBudgetCents: nc.dailyBudgetCents, from: 'none', to: `${nc.match === 'EXACT' ? 'Exact' : 'Phrase'} campaign, one ad group, ${plural(nc.skus.length, 'product')}, live at once`, needsCode: coded,
      ...(campaignWarnings.get(nc.key)?.length ? { pastOwnLimits: campaignWarnings.get(nc.key) } : {}),
      after: nc.portfolio && 'newPortfolio' in nc.portfolio && pfStep.has(nc.portfolio.newPortfolio) ? [pfStep.get(nc.portfolio.newPortfolio)!] : [], refusal: null,
    }))
  }
  const items: PreviewItem[] = []
  for (const item of planned) {
    const f = facts.get(item.market)!
    const p = f.products.get(item.productId)
    const gName = (gid: string) => p?.facts.groups.get(gid)?.name ?? f.groupNames.get(gid)?.name ?? gid
    const cName = (cid: string) => f.campaigns.get(cid)?.name ?? cid
    const pRef = (cid: string) => { const pid = f.campaigns.get(cid)?.portfolioId; return pid ? portfolioRef(pid, f.portfolios.get(pid)) : null }
    const d = item.destination
    const nc = d?.kind === 'new' ? campaigns.get(d.key) : undefined
    items.push({
      candidateId: item.candidateId, term: item.term, productId: item.productId, market: item.market, ok: !item.refusal, refusal: item.refusal, hold: item.hold, match: item.match,
      destination: !d ? null : d.kind === 'existing'
        ? { kind: 'existing', how: d.how, adGroup: adGroupRef(d.adGroupId, gName(d.adGroupId), d.campaignId), campaign: campaignRef(d.campaignId, cName(d.campaignId)), portfolio: pRef(d.campaignId), status: d.status }
        : { kind: 'new', key: d.key, name: nc?.name ?? d.key },
      bidCents: item.bid?.cents ?? null, bidWhy: item.bid?.why ?? null,
      sources: item.sources.map((s) => ({ adGroup: adGroupRef(s.adGroupId, gName(s.adGroupId), s.campaignId), campaign: campaignRef(s.campaignId, cName(s.campaignId)), action: s.action, negMatch: s.negMatch ?? 'EXACT', why: s.why })),
      funnel: item.funnel.map((s) => ({ adGroup: adGroupRef(s.adGroupId, gName(s.adGroupId), s.campaignId), campaign: campaignRef(s.campaignId, cName(s.campaignId)), action: s.action, negMatch: s.negMatch ?? 'EXACT', why: s.why })),
      warnings: item.refusal ? [] : warningsOf.get(item.candidateId) ?? [],
    })
    if (item.refusal || !d || !item.bid) continue
    const after = d.kind === 'new' && cStep.has(d.key) ? [cStep.get(d.key)!] : []
    const destGroup = d.kind === 'existing' ? adGroupRef(d.adGroupId, gName(d.adGroupId), d.campaignId) : { id: `new:${d.key}:group`, name: nc?.adGroupName ?? d.key }
    const destCampaign = d.kind === 'existing' ? campaignRef(d.campaignId, cName(d.campaignId)) : { id: `new:${d.key}`, name: nc?.name ?? d.key }
    const what = item.isAsin ? 'product target' : `${item.match.toLowerCase()} keyword`
    const warned = warningsOf.get(item.candidateId) ?? []
    const past = (half: 'keyword' | 'negative', adGroupId: string | null) => {
      const list = warned.filter((w) => w.half === half && (half === 'keyword' || w.adGroupId === adGroupId)).map((w) => ({ limit: w.limit, reason: w.reason }))
      return list.length ? { pastOwnLimits: list } : {}
    }
    const reenable = d.kind === 'existing' && d.status === 're-enable'
    const k = d.kind === 'existing' && d.status === 'already-there' ? null
      : add({ kind: reenable ? 'enable' : 'keyword', candidateId: item.candidateId, term: item.term, campaign: destCampaign, adGroup: destGroup, match: item.match, bidCents: item.bid.cents, from: reenable ? 'paused' : 'none', to: reenable ? 'enabled at the start bid' : what, after, refusal: null, ...past('keyword', null) })
    // H2 — after a switch-on the blocks wait for Amazon's confirmation: they are written by a later harvest of the term.
    const blockTo = (s: { negMatch?: HarvestMatch }) => `negative ${(s.negMatch ?? 'EXACT').toLowerCase()}${reenable ? ', once Amazon confirms the switch-on' : ''}`
    for (const s of item.sources.filter((x) => x.action === 'negate')) add({ kind: 'sourceNegative', candidateId: item.candidateId, term: item.term, campaign: campaignRef(s.campaignId, cName(s.campaignId)), adGroup: adGroupRef(s.adGroupId, gName(s.adGroupId), s.campaignId), match: s.negMatch ?? 'EXACT', from: 'none', to: blockTo(s), after: k == null ? after : [k], refusal: null, ...past('negative', s.adGroupId) })
    for (const s of item.funnel.filter((x) => x.action === 'negate')) add({ kind: 'funnelNegative', candidateId: item.candidateId, term: item.term, campaign: campaignRef(s.campaignId, cName(s.campaignId)), adGroup: adGroupRef(s.adGroupId, gName(s.adGroupId), s.campaignId), match: s.negMatch ?? 'EXACT', from: 'none', to: blockTo(s), after: k == null ? after : [k], refusal: null, ...past('negative', s.adGroupId) })
  }

  const count = (kind: StepKind) => steps.filter((s) => s.kind === kind).length
  const totals = { items: planned.length, ok: ok.length, keywords: count('keyword'), enables: count('enable'), sourceNegatives: count('sourceNegative'), funnelNegatives: count('funnelNegative'), campaigns: count('campaign'), portfolios: count('portfolio') }
  const raises = [
    ...(totals.keywords ? [`${plural(totals.keywords, 'new keyword')} add spend`] : []),
    ...(totals.enables ? [`${plural(totals.enables, 'paused keyword')} enabled`] : []),
    ...usedCampaigns.map((nc) => `a new campaign "${nc.name}" with its own daily budget`),
  ]
  const plan: ChangeSetPlan = { markets: [...facts.keys()].sort(), items: planned, newCampaigns: usedCampaigns, newPortfolios: usedPortfolios }
  const planHash = fingerprint({
    items: ok.map((i) => ({ c: i.candidateId, m: i.match, d: i.destination, b: i.bid?.cents, s: i.sources.map((x) => [x.adGroupId, x.action, x.negMatch]), f: i.funnel.map((x) => [x.adGroupId, x.action, x.negMatch]) })),
    campaigns: usedCampaigns.map((nc) => ({ k: nc.key, n: nc.name, b: nc.dailyBudgetCents, p: nc.portfolio, s: nc.skus, d: nc.defaultBidCents })),
    portfolios: usedPortfolios.map((np) => ({ k: np.key, n: np.name, c: np.capMonthlyCents })),
  })
  const effect = ok.length
    ? `Harvests ${plural(ok.length, 'search term')}: ${plural(totals.keywords + totals.enables, 'keyword')}${totals.campaigns ? `, ${plural(totals.campaigns, 'new campaign')}` : ''}${totals.portfolios ? `, ${plural(totals.portfolios, 'new portfolio')}` : ''}, ${plural(totals.sourceNegatives, 'source block')} and ${plural(totals.funnelNegatives, 'funnel block')} — one change set, one approval. The negatives are written only once each keyword stands.`
    : 'Nothing can be harvested: every item is refused (see blocked).'
  return {
    data: {
      steps, items, approvals: { count: ok.length ? 1 : 0, codes: coded ? 1 : 0 },
      stepUp: coded ? { what: `builds ${plural(usedCampaigns.length, 'new campaign')} that go${usedCampaigns.length === 1 ? 'es' : ''} live at once (born serving, on the live-write allowlist, with ${usedCampaigns.length === 1 ? 'its' : 'their'} product ads)`, raises: ['New campaign', 'Spend', 'Live writes'], needs: STEP_UP_NEEDS, how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs.' } : null,
      pastOwnLimits: [...new Map(steps.flatMap((x) => x.pastOwnLimits ?? []).map((l) => [l.reason, l])).values()],
      blocked: planned.filter((i) => i.refusal).map((i) => ({ candidateId: i.candidateId, term: i.term, reason: i.refusal! })),
      // R9 — every new campaign asked, its market and its holds by level (market: no field fixes it; product; choice).
      newCampaigns: (body.newCampaigns ?? []).map((nc) => ({ key: nc.key, market: campaigns.get(nc.key)?.market ?? null, holds: campaignHolds.get(nc.key) ?? [] })),
      totals, planHash, raises, effect,
    },
    plan,
  }
}
