/**
 * HARVEST ENGINE — the facts of one market, for the page, Claude and the rules (reads only). Built on the brain's own
 * loaders, so every door sees the same term, the same sources, the same bar and the same start bid:
 *
 *   products   every product family that owns a Sponsored Products campaign in the market (brain/ownership.ts; a shared
 *              campaign is no product's, D2), read as if enrolled at its levels — the brain's dry run (brain/harvest-read.ts)
 *              — so a product the brain does not run still gets its candidates (a person harvests them).
 *   terms      the term ledger (brain/terms-shadow.ts loadTermsMarket + decideMarket): one decision per term of a product,
 *              its evidence over the settled window, its sources (the product's ad groups where it ran, with clicks), its
 *              positives and negatives, the bar (the ads strategy's harvest group where set, else the brain's sized test).
 *   harvest    the harvest module's facts (brain/harvest-load.ts loadHarvestMarket): the product's own ad groups with their
 *              role, size and whether they serve, the Owner's campaign settings, the playbook slots, the strategy's bid
 *              limits, the stored destinations (EXACT and PRODUCT), what a new campaign is built from.
 *   extra      every campaign of the market (name, status, portfolio, budget, bidding), the portfolio names, the product
 *              names, the harvest records (every actor), the source pauses, the stored PHRASE destinations.
 */
import prisma from '../../../db.js'
import { mergeIds } from '../ads-scope-lists.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { HV_DEST_GRAINS } from '../harvest-destination.service.js'
import { resolveCampaignOwnership, productFamily } from '../brain/ownership.js'
import { resolveBrainSettings, type OverrideRow } from '../brain/settings.js'
import { loadHarvestMarket } from '../brain/harvest-load.js'
import type { HarvestProductFacts, StoredDestinationFact } from '../brain/harvest.js'
import type { DueProduct } from '../brain/terms-shadow.js'
import type { LeverEffective, TermDecision } from '../brain/terms.js'
import type { HarvestMatch } from './write.js'
import { landingDecisionsMany, landingPairKey, type LandingDecision } from '../harvest-landing-guard.js'

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
const ACTS: readonly string[] = ['OBSERVE', 'PROPOSE', 'AUTO']

export interface CampaignInfo {
  id: string
  name: string
  status: string
  marketplace: string | null
  portfolioId: string | null
  dailyBudgetCents: number | null
  currency: string | null
  biddingStrategy: string | null
  targetingType: string | null
  externalCampaignId: string | null
}

export interface RecordRow {
  id: string
  productId: string
  term: string
  isAsin: boolean
  status: string
  actorKind: string
  actorId: string | null
  match: string
  approvalId: string | null
  undoApprovalId: string | null
  changeSetId: string | null
  destCampaignId: string | null
  destAdGroupId: string | null
  keywordTargetId: string | null
  landedAt: Date | null
  verdict: string | null
  judgeAfter: Date | null
  decidedAt: Date
  changedAt: Date
  skippedUntil: Date | null
  skippedForGood: boolean
  skippedBy: string | null
  skippedAt: Date | null
  judgement: unknown
}

export interface EngineProduct {
  productId: string
  market: string
  name: string
  sku: string | null
  /** Enrolled in the brain in this market, and its harvest lever as the brain resolves it (the real one). */
  enrolled: boolean
  lever: LeverEffective
  /** The brain's harvest facts for the product (as if enrolled at its levels). */
  facts: HarvestProductFacts
  /** Every term decision of the product (the ledger's), by term. */
  decisions: Map<string, TermDecision>
  /** The product's ad groups where the term ran, with clicks (the ledger's), most clicks first. */
  sourcesOf: (term: string) => Array<{ adGroupId: string; clicks: number }>
  /** The Owner's stored destination that covers the term's main source for this match (the first grain). */
  storedFor: (term: string, match: HarvestMatch | 'PRODUCT') => StoredDestinationFact | null
  /** The product's portfolio: the one most of its own campaigns sit in (Amazon's id); null when none. */
  portfolioId: string | null
}

export interface MarketFacts {
  market: string
  now: Date
  windowDays: number
  dataDay: Date
  products: Map<string, EngineProduct>
  campaigns: Map<string, CampaignInfo>
  portfolios: Map<string, string>
  groupNames: Map<string, { id: string; name: string; campaignId: string }>
  records: Map<string, RecordRow>
  pauses: Map<string, { by: string; at: Date }>
  /** Products skipped because they own no campaign in the market (named, never silent). */
  skipped: Array<{ productId: string; why: string }>
}

export const recordKey = (productId: string, term: string) => `${productId}|${term}`

const RECORD_SELECT = {
  id: true, productId: true, term: true, isAsin: true, status: true, actorKind: true, actorId: true, match: true, approvalId: true, undoApprovalId: true,
  changeSetId: true, destCampaignId: true, destAdGroupId: true, keywordTargetId: true, landedAt: true, verdict: true, judgeAfter: true, decidedAt: true,
  changedAt: true, skippedUntil: true, skippedForGood: true, skippedBy: true, skippedAt: true, judgement: true,
} as const

/** The product family roots that own a Sponsored Products campaign in the market. */
export async function marketProductRoots(market: string): Promise<string[]> {
  const all = await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } }, select: { id: true, marketplace: true } })
  const ids = all.filter((c) => strategyMarket(c.marketplace) === market).map((c) => c.id)
  if (!ids.length) return []
  const owners = await resolveCampaignOwnership(ids)
  const roots = new Set<string>()
  for (const o of owners.values()) if (o.owner.kind === 'product') roots.add(o.owner.productId)
  return [...roots].sort()
}

/**
 * One market's facts, for every product that owns a campaign there (or the products asked: their family roots). Reads
 * only. `productId` narrows the load (a family member resolves to its root); `productIds` (the scope filter, 2026-10-12)
 * narrows it to several, merged with `productId` — the first that is not this business's (or has no single family) is
 * the 404, named.
 */
export async function loadMarketFacts(market: string, opts: { productId?: string | null; productIds?: readonly string[] | null; now?: Date } = {}): Promise<MarketFacts | { error: string; status: 400 | 404 }> {
  const code = strategyMarket(market)
  if (!code) return { error: `${market} is not a market code`, status: 400 }
  const now = opts.now ?? new Date()
  const asked = mergeIds(opts.productId, opts.productIds)
  let roots: string[]
  if (asked) {
    const families = await Promise.all(asked.map((id) => productFamily(id)))
    const gone = asked.find((_, i) => !families[i])
    if (gone) return { error: `Product ${gone} was not found in this business, or it has no single family.`, status: 404 }
    roots = [...new Set(families.map((f) => f!.root))]
  } else roots = await marketProductRoots(code)

  const [enrollments, overrides] = roots.length ? await Promise.all([
    prisma.adsBrainEnrollment.findMany({ where: { marketplace: code, productId: { in: roots } }, select: { productId: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: { in: roots }, marketplace: code }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
  ]) : [[], [] as OverrideRow[]]
  const enrolled = new Set(enrollments.map((e) => e.productId))
  // As if enrolled at its levels (the brain's dry run): the decisions and the facts; the real lever is kept beside.
  const due: DueProduct[] = roots.map((productId) => ({ productId, market: code, settings: resolveBrainSettings({ productId, market: code, campaignId: null, enrolled: true, overrides }) }))
  const real = new Map(roots.map((productId) => [productId, resolveBrainSettings({ productId, market: code, campaignId: null, enrolled: enrolled.has(productId), overrides })]))
  const hm = due.length ? await loadHarvestMarket(code, due, now) : null

  const campaignRows = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS' },
    select: { id: true, name: true, status: true, marketplace: true, portfolioId: true, dailyBudget: true, dailyBudgetCurrency: true, biddingStrategy: true, targetingType: true, externalCampaignId: true },
  })
  const campaigns = new Map<string, CampaignInfo>()
  for (const c of campaignRows) {
    if (strategyMarket(c.marketplace) !== code) continue
    campaigns.set(c.id, {
      id: c.id, name: c.name, status: String(c.status), marketplace: c.marketplace ?? null, portfolioId: c.portfolioId ?? null,
      dailyBudgetCents: c.dailyBudget == null ? null : Math.round(Number(c.dailyBudget) * 100), currency: c.dailyBudgetCurrency ?? null,
      biddingStrategy: c.biddingStrategy == null ? null : String(c.biddingStrategy), targetingType: c.targetingType ?? null, externalCampaignId: c.externalCampaignId ?? null,
    })
  }
  const campaignIds = [...campaigns.keys()]
  const [groups, portfolioRows, productRows, recordRows, pauseRows, storedRows] = await Promise.all([
    campaignIds.length ? prisma.adGroup.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true, name: true, campaignId: true } }) : Promise.resolve([]),
    prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true, updatedAt: true }, orderBy: { updatedAt: 'asc' } }),
    roots.length ? prisma.product.findMany({ where: { id: { in: roots } }, select: { id: true, name: true, sku: true } }) : Promise.resolve([]),
    prisma.adsBrainHarvest.findMany({ where: { marketplace: code, ...(asked ? { productId: { in: roots } } : {}) }, select: RECORD_SELECT }),
    prisma.adsHarvestSourcePause.findMany({ select: { adGroupId: true, pausedBy: true, createdAt: true } }),
    prisma.adsHarvestDestination.findMany({ select: { scopeGrain: true, scopeId: true, matchType: true, adGroupId: true, negateAtSource: true } }),
  ])
  const portfolios = new Map<string, string>()
  for (const p of portfolioRows) portfolios.set(p.externalPortfolioId, p.name)
  const groupNames = new Map(groups.map((g) => [g.id, g]))
  const records = new Map<string, RecordRow>()
  for (const r of recordRows) records.set(recordKey(r.productId, r.term), r as RecordRow)
  const pauses = new Map(pauseRows.map((p) => [p.adGroupId, { by: p.pausedBy, at: p.createdAt }]))
  const names = new Map(productRows.map((p) => [p.id, p]))

  const products = new Map<string, EngineProduct>()
  if (hm) {
    for (const [root, loaded] of hm.products) {
      const terms = hm.terms.products.get(root)
      const own = loaded.facts.groups
      const sourcesOf = (term: string) => [...(terms?.terms.get(term)?.sources ?? new Map<string, number>())]
        .filter(([id]) => own.has(id)).map(([adGroupId, clicks]) => ({ adGroupId, clicks }))
        .sort((a, b) => b.clicks - a.clicks || a.adGroupId.localeCompare(b.adGroupId))
      const familyOwn = new Set([...own.values()].map((g) => g.campaignId))
      // The stored destination that covers the term's main source (the brain's grains, harvest-load.ts storedFor).
      const storedFor = (term: string, match: HarvestMatch | 'PRODUCT'): StoredDestinationFact | null => {
        const top = sourcesOf(term)[0]?.adGroupId ?? null
        const g = top ? own.get(top) : undefined
        const portfolioOf = g ? campaigns.get(g.campaignId)?.portfolioId ?? null : null
        const covers = (r: { scopeGrain: string; scopeId: string }) => (r.scopeGrain === 'adGroup' && !!g && r.scopeId === g.id)
          || (r.scopeGrain === 'campaign' && !!g && r.scopeId === g.campaignId)
          || (r.scopeGrain === 'portfolio' && !!portfolioOf && r.scopeId === portfolioOf)
          || (r.scopeGrain === 'line' && r.scopeId === root)
          || (r.scopeGrain === 'market' && strategyMarket(r.scopeId) === code)
          || r.scopeGrain === 'account'
        const hit = storedRows.filter((r) => r.matchType === match && covers(r))
          .sort((a, b) => (HV_DEST_GRAINS as readonly string[]).indexOf(a.scopeGrain) - (HV_DEST_GRAINS as readonly string[]).indexOf(b.scopeGrain))[0]
        return hit ? { adGroupId: hit.adGroupId, negateAtSource: hit.negateAtSource, grain: hit.scopeGrain, own: own.has(hit.adGroupId) } : null
      }
      // The product's portfolio: the one most of its own campaigns sit in.
      const tally = new Map<string, number>()
      for (const id of familyOwn) { const p = campaigns.get(id)?.portfolioId; if (p) tally.set(p, (tally.get(p) ?? 0) + 1) }
      const portfolioId = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
      const n = names.get(root)
      const settings = real.get(root)
      products.set(root, {
        productId: root, market: code, name: n?.name ?? n?.sku ?? root, sku: n?.sku ?? null,
        enrolled: enrolled.has(root), lever: (settings?.levers.harvest.effective ?? 'NOT_ENROLLED') as LeverEffective,
        facts: loaded.facts, decisions: new Map(loaded.decisions.map((d) => [d.term, d])), sourcesOf, storedFor, portfolioId,
      })
    }
  }
  return {
    market: code, now, windowDays: hm?.terms.windowDays ?? 60, dataDay: hm?.terms.dataDay ?? now,
    products, campaigns, portfolios, groupNames, records, pauses, skipped: hm?.skipped ?? [],
  }
}

/** True when a lever value acts (OBSERVE, PROPOSE or AUTO). */
export const leverActs = (l: string | null | undefined) => ACTS.includes(String(l ?? ''))

/** A record's skip is in force now (until a later date, or for good). */
export const skippedNow = (r: Pick<RecordRow, 'skippedForGood' | 'skippedUntil'> | null | undefined, now: Date) =>
  !!r && (r.skippedForGood || (r.skippedUntil != null && r.skippedUntil.getTime() > now.getTime()))

/** What a destination holds of a keyword now, by the ONE landing check (harvest-landing-guard.ts decideLanding). */
export type LandingLookup = (adGroupId: string, term: string, match: HarvestMatch, isAsin: boolean) => LandingDecision | null

/**
 * The landing guard's decisions for these (ad group, term, match) at once (B1 + B10: an enabled keyword with Amazon's id and
 * a confirmed switch is already there, a paused one is switched on, an archived one or a negative that blocks it holds the
 * place, a destination that does not serve never lands). A fixed number of reads. A pair not asked answers null.
 */
export async function landingLookup(pairs: ReadonlyArray<{ adGroupId: string; term: string; match: HarvestMatch; isAsin: boolean }>): Promise<LandingLookup> {
  const asked = pairs.map((p) => ({ adGroupId: p.adGroupId, term: p.term, match: (p.isAsin ? 'PRODUCT' : p.match) as 'EXACT' | 'PHRASE' | 'PRODUCT' }))
  const seen = new Set<string>()
  const unique = asked.filter((p) => { const k = landingPairKey(p.adGroupId, p.term, p.match); if (seen.has(k)) return false; seen.add(k); return true })
  const decided = await landingDecisionsMany(unique)
  return (adGroupId, term, match, isAsin) => decided.get(landingPairKey(adGroupId, term, isAsin ? 'PRODUCT' : match)) ?? null
}
