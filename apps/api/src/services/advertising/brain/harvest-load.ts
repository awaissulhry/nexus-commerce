/**
 * ONE BRAIN AB-11 — the harvest module's facts for one market (design 2026-10-08-ads-one-brain/DESIGN.md §2.8, §2.9, §5).
 * Reads only. The term ledger's facts and decisions come from brain/terms-shadow.ts as they are (loadTermsMarket,
 * decideMarket: the same one decision per term the daily ledger stores); this adds what a harvest needs, in a fixed
 * number of reads per market whatever the number of products:
 *
 *   due        an enrolled product, not excluded, whose harvest lever resolves to OBSERVE, PROPOSE or AUTO (product level).
 *   groups     the product's own ad groups (campaigns that advertise it alone, brain/ownership.ts) with their role (name
 *              first, then their keywords: harvest-destination.service.ts roleOf), their size, whether they serve now
 *              (campaign and ad group enabled, the campaign's bids not suppressed) and the campaign's bid bounds.
 *   settings   the Owner's settings per campaign (brain/settings.ts: the campaign's overrides over the product's): the
 *              exclusion, the harvest and negatives levers, their term and ad-group locks — AB-9 reads the product level
 *              only, so the harvest skips what the Owner keeps per campaign here.
 *   slots      the product's playbook slots in the market (AdsPlaybookLink kind slot).
 *   stored     the Owner's harvest destinations (AdsHarvestDestination, EXACT and PRODUCT) with negateAtSource, the first
 *              grain that covers the term's main source (adGroup → campaign → portfolio → line → market → account).
 *   limits     the ads strategy's lowest and highest bid per own ad group and for the market (a new campaign).
 *   records    the product's harvests (AdsBrainHarvest) and what was used today and this week (the caps).
 *   new        what a new campaign is built from: the SKUs its own campaigns advertise, the first budget (a share of the
 *              day's envelope the money shadow last planned, AB-7; else Amazon's minimum), the names taken in the market.
 *   ceiling    NEXUS_ADS_BRAIN_HARVEST_MODE=live (and the brain's own ceiling NEXUS_BID_BRAIN_MODE=live) lets PROPOSE ask
 *              and AUTO write; anything else and every level only logs (production as AB-11 ships).
 */
import prisma from '../../../db.js'
import { strategyMarket, bidLimitsFor, strategyBidReader } from '../ads-strategy/bids.js'
import { HV_DEST_GRAINS, roleOf } from '../harvest-destination.service.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { decideMarket, loadTermsMarket, type DueProduct, type MarketFacts } from './terms-shadow.js'
import { isAsin } from '../ads-negation-policy.js'
import {
  AMAZON_MIN_BUDGET_CENTS, ENDED_STATUSES, GRADUATION_COOLDOWN_DAYS, isHarvestStatus, MARKET_NEW_CAMPAIGNS_PER_WEEK,
  type GroupRole, type HarvestCampaignSettings, type HarvestCandidateFacts, type HarvestGroup, type HarvestProductFacts, type HarvestRecordLite,
  type HarvestStatus, type SlotFact, type StoredDestinationFact,
} from './harvest.js'
import type { LeverEffective, TermDecision } from './terms.js'

const ACTS: readonly string[] = ['OBSERVE', 'PROPOSE', 'AUTO']
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The env ceiling of the harvest's writes and requests (both switches live). */
export function harvestCeiling(env: NodeJS.ProcessEnv = process.env): { live: boolean; why: string } {
  if (!brainLiveCeiling(env.NEXUS_BID_BRAIN_MODE)) return { live: false, why: 'the brain\'s env ceiling NEXUS_BID_BRAIN_MODE is not live' }
  if ((env.NEXUS_ADS_BRAIN_HARVEST_MODE ?? '').trim().toLowerCase() !== 'live') return { live: false, why: 'the harvest\'s env ceiling NEXUS_ADS_BRAIN_HARVEST_MODE is shadow' }
  return { live: true, why: 'the harvest\'s env ceiling is live' }
}

export interface HarvestDue { due: boolean; why: string; products: DueProduct[] }

/** The products whose harvest lever is OBSERVE or higher (product level). Nothing enrolled: one read. */
export async function harvestDue(): Promise<HarvestDue> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }] })
  if (!enrollments.length) return { due: false, why: 'no product is enrolled in the brain: no harvest to decide', products: [] }
  const overrides = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, scope: 'PRODUCT', productId: { in: [...new Set(enrollments.map((e) => e.productId))] } },
    select: OVERRIDE_SELECT,
  }) as OverrideRow[]
  const products = enrollments.flatMap((e) => {
    const settings = resolveBrainSettings({ productId: e.productId, market: e.marketplace, campaignId: null, enrolled: true, overrides })
    return ACTS.includes(settings.levers.harvest.effective) ? [{ productId: e.productId, market: e.marketplace, settings }] : []
  })
  return products.length
    ? { due: true, why: `${products.length} product${products.length === 1 ? '' : 's'} with the harvest lever at OBSERVE or higher`, products }
    : { due: false, why: `${enrollments.length} product${enrollments.length === 1 ? ' is' : 's are'} enrolled, none with the harvest lever at OBSERVE or higher: no harvest to decide`, products: [] }
}

const termLocks = (locks: ReadonlyArray<{ ref: string }>, kind: 'term' | 'adGroup') =>
  new Set(locks.filter((l) => l.ref.startsWith(`${kind}:`)).map((l) => l.ref.slice(kind.length + 1)))

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

/** Records that took a slot of the day's keywords or the week's campaigns (proposed, built, written; a refusal did not). */
const TOOK: readonly HarvestStatus[] = ['PROPOSED', 'CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED', 'DECLINED', 'UNDONE']
const CAMPAIGN_STANDING: readonly HarvestStatus[] = ['CAMPAIGN_PROPOSED', 'CAMPAIGN_BUILT', 'WRITING', 'DONE', 'HALF_DONE', 'UNDO_PROPOSED']

export interface HarvestMarket {
  market: string
  terms: MarketFacts
  /** Per due product with campaigns of its own in the market: its facts and its candidates. */
  products: Map<string, { facts: HarvestProductFacts; candidates: HarvestCandidateFacts[]; decisions: TermDecision[] }>
  /** Due products with no campaign of their own in the market (a shared campaign is no product's, D2). */
  skipped: Array<{ productId: string; why: string }>
}

/** One market's harvest facts for these due products (a fixed number of reads). */
export async function loadHarvestMarket(market: string, due: readonly DueProduct[], now: Date): Promise<HarvestMarket> {
  const terms = await loadTermsMarket(market, due, now)
  const decided = decideMarket(terms, due)
  const present = due.filter((d) => terms.products.has(d.productId))
  const skipped = due.filter((d) => !terms.products.has(d.productId)).map((d) => ({ productId: d.productId, why: 'no Sponsored Products campaign of its own in this market (a shared campaign is no product\'s, D2): no harvest to decide' }))
  const out: HarvestMarket = { market, terms, products: new Map(), skipped }
  if (!present.length) return out

  const roots = present.map((d) => d.productId)
  const groupIds = [...new Set(present.flatMap((d) => [...terms.products.get(d.productId)!.adGroups]))]
  const campaignIds = [...new Set(present.flatMap((d) => [...terms.products.get(d.productId)!.campaigns]))]
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  const [groups, positives, overrides, playbooks, stored, records, marketCampaigns, productAds, budgets, names, marketLimits, strategyLimits] = await Promise.all([
    groupIds.length ? prisma.adGroup.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, name: true, status: true, campaignId: true, campaign: { select: { id: true, name: true, status: true, targetingType: true, bidsSuppressedAt: true, minBidCents: true, maxBidCents: true, portfolioId: true } } },
    }) : Promise.resolve([]),
    groupIds.length ? prisma.adTarget.findMany({
      where: { adGroupId: { in: groupIds }, isNegative: false, kind: { in: ['KEYWORD', 'PRODUCT'] }, status: { not: 'ARCHIVED' }, retiredAt: null },
      select: { adGroupId: true, kind: true, expressionType: true },
    }) : Promise.resolve([]),
    prisma.adsBrainOverride.findMany({
      where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: { in: roots }, marketplace: market }, ...(campaignIds.length ? [{ scope: 'CAMPAIGN', campaignId: { in: campaignIds } }] : [])] },
      select: OVERRIDE_SELECT,
    }) as Promise<OverrideRow[]>,
    prisma.adsPlaybook.findMany({ where: { channel: 'AMAZON', market, level: 'PRODUCT', scopeId: { in: roots } }, select: { id: true, scopeId: true } }),
    prisma.adsHarvestDestination.findMany({ where: { matchType: { in: ['EXACT', 'PRODUCT'] } }, select: { scopeGrain: true, scopeId: true, matchType: true, adGroupId: true, negateAtSource: true } }),
    prisma.adsBrainHarvest.findMany({ where: { marketplace: market, productId: { in: roots } }, select: { productId: true, term: true, status: true, destinationKind: true, decidedAt: true, changedAt: true, landedAt: true } }),
    prisma.adsBrainHarvest.count({ where: { marketplace: market, destinationKind: 'NEW_CAMPAIGN', decidedAt: { gte: weekAgo }, status: { in: [...TOOK] } } }),
    groupIds.length ? prisma.adProductAd.findMany({ where: { adGroupId: { in: groupIds }, productId: { not: null } }, select: { adGroupId: true, productId: true, sku: true } }) : Promise.resolve([]),
    prisma.adsBrainBudgetDecision.findMany({ where: { marketplace: market, productId: { in: roots }, envelopeCents: { not: null } }, orderBy: { createdAt: 'desc' }, select: { productId: true, envelopeCents: true, month: true, createdAt: true }, take: 50 }),
    prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS' }, select: { name: true, marketplace: true } }),
    bidLimitsFor({ marketplace: market }),
    groupIds.length ? strategyBidReader().forAdGroups(groupIds.map((id) => ({ adGroupId: id, marketplace: market }))) : Promise.resolve(new Map()),
  ])
  const links = playbooks.length
    ? await prisma.adsPlaybookLink.findMany({ where: { playbookId: { in: playbooks.map((p) => p.id) }, kind: 'slot' }, select: { playbookId: true, key: true, refId: true, adGroupId: true } })
    : []
  const productIds = [...new Set(productAds.map((a) => a.productId!).filter(Boolean))]
  const products = productIds.length ? await prisma.product.findMany({ where: { id: { in: [...productIds, ...roots] }, deletedAt: null }, select: { id: true, sku: true, name: true, parentId: true } }) : []
  const productById = new Map(products.map((p) => [p.id, p]))
  const rootNames = roots.length ? await prisma.product.findMany({ where: { id: { in: roots } }, select: { id: true, sku: true, name: true } }) : []

  const positivesIn = new Map<string, Array<{ kind: string; expressionType: string }>>()
  for (const t of positives) positivesIn.set(t.adGroupId, [...(positivesIn.get(t.adGroupId) ?? []), t])
  const groupFacts = new Map<string, HarvestGroup & { portfolioId: string | null }>()
  for (const g of groups) {
    const list = positivesIn.get(g.id) ?? []
    const keywords = list.filter((t) => t.kind === 'KEYWORD')
    const named = roleOf(g.name, []) // the name alone
    const role = roleOf(g.name, keywords.map((t) => ({ expressionType: t.expressionType, isNegative: false }))) as GroupRole
    const manual = String(g.campaign?.targetingType ?? 'MANUAL').toUpperCase() !== 'AUTO'
    const notServing = String(g.campaign?.status) !== 'ENABLED' ? `its campaign is ${String(g.campaign?.status ?? 'unknown').toLowerCase()}`
      : String(g.status) !== 'ENABLED' ? `the ad group is ${String(g.status).toLowerCase()}`
        : g.campaign?.bidsSuppressedAt ? 'its campaign\'s bids are suppressed (a stop, or born at the floor and not started)' : null
    groupFacts.set(g.id, {
      id: g.id, name: g.name, campaignId: g.campaignId, campaignName: g.campaign?.name ?? g.campaignId, role, roleFromName: named != null && named === role,
      manual, keywords: keywords.length, productTargets: list.filter((t) => t.kind === 'PRODUCT').length,
      serving: notServing == null, notServing, campaignMinCents: g.campaign?.minBidCents ?? null, campaignMaxCents: g.campaign?.maxBidCents ?? null,
      portfolioId: g.campaign?.portfolioId ?? null,
    })
  }

  for (const d of present) {
    const root = d.productId
    const p = terms.products.get(root)!
    const ctx = terms.contexts.get(root)!
    const own = new Map([...p.adGroups].map((id) => [id, groupFacts.get(id)]).filter((e): e is [string, HarvestGroup & { portfolioId: string | null }] => !!e[1]))
    // The Owner's settings per campaign of the product (the campaign's overrides over the product's).
    const campaigns = new Map<string, HarvestCampaignSettings>()
    for (const campaignId of p.campaigns) {
      const s = resolveBrainSettings({ productId: root, market, campaignId, enrolled: true, overrides })
      const name = [...own.values()].find((g) => g.campaignId === campaignId)?.campaignName ?? campaignId
      campaigns.set(campaignId, {
        name, excluded: s.excluded.value,
        harvest: s.levers.harvest.effective as LeverEffective, negatives: s.levers.negatives.effective as LeverEffective,
        harvestWhy: s.levers.harvest.why, negativesWhy: s.levers.negatives.why,
        harvestTermLocks: termLocks(s.levers.harvest.locks, 'term'), negativesTermLocks: termLocks(s.levers.negatives.locks, 'term'),
        negativesAdGroupLocks: termLocks(s.levers.negatives.locks, 'adGroup'),
      })
    }
    const playbookIds = new Set(playbooks.filter((pb) => pb.scopeId === root).map((pb) => pb.id))
    const slots: SlotFact[] = links.filter((l) => playbookIds.has(l.playbookId) && p.campaigns.has(l.refId)).map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId && own.has(l.adGroupId) ? l.adGroupId : null }))
    const familyIds = new Set([root, ...products.filter((x) => x.parentId === root).map((x) => x.id)])
    // The Owner's stored destination that covers a source (the first grain in HV_DEST_GRAINS order).
    const storedFor = (sourceGroupId: string | null, asin: boolean): StoredDestinationFact | null => {
      const g = sourceGroupId ? own.get(sourceGroupId) : undefined
      const covers = (r: { scopeGrain: string; scopeId: string }) => (r.scopeGrain === 'adGroup' && !!g && r.scopeId === g.id)
        || (r.scopeGrain === 'campaign' && !!g && r.scopeId === g.campaignId)
        || (r.scopeGrain === 'portfolio' && !!g?.portfolioId && r.scopeId === g.portfolioId)
        || (r.scopeGrain === 'line' && familyIds.has(r.scopeId))
        || (r.scopeGrain === 'market' && strategyMarket(r.scopeId) === market)
        || r.scopeGrain === 'account'
      const hit = stored.filter((r) => r.matchType === (asin ? 'PRODUCT' : 'EXACT') && covers(r))
        .sort((a, b) => (HV_DEST_GRAINS as readonly string[]).indexOf(a.scopeGrain) - (HV_DEST_GRAINS as readonly string[]).indexOf(b.scopeGrain))[0]
      return hit ? { adGroupId: hit.adGroupId, negateAtSource: hit.negateAtSource, grain: hit.scopeGrain, own: own.has(hit.adGroupId) } : null
    }
    const mine = records.filter((r) => r.productId === root)
    const recordMap = new Map<string, HarvestRecordLite>()
    for (const r of mine) if (isHarvestStatus(r.status)) recordMap.set(r.term, { term: r.term, status: r.status, changedAt: r.changedAt, landedAt: r.landedAt })
    const today = startOfUtcDay(now)
    const used = {
      keywordsToday: mine.filter((r) => r.decidedAt >= today && (TOOK as readonly string[]).includes(r.status)).length,
      campaignsThisWeek: mine.filter((r) => r.destinationKind === 'NEW_CAMPAIGN' && r.decidedAt >= weekAgo && (TOOK as readonly string[]).includes(r.status)).length,
      marketCampaignsThisWeek: marketCampaigns,
      skcs: mine.filter((r) => r.destinationKind === 'NEW_CAMPAIGN' && (CAMPAIGN_STANDING as readonly string[]).includes(r.status)).length,
    }
    const decisions = decided.byProduct.get(root) ?? []
    const candidates: HarvestCandidateFacts[] = decisions.filter((x) => x.state === 'HARVEST_CANDIDATE').map((decision) => {
      const sources = [...(p.terms.get(decision.term)?.sources ?? new Map<string, number>())].filter(([id]) => own.has(id)).map(([adGroupId, clicks]) => ({ adGroupId, clicks }))
      const top = [...sources].sort((a, b) => b.clicks - a.clicks || a.adGroupId.localeCompare(b.adGroupId))[0]?.adGroupId ?? null
      return { decision, sources, stored: storedFor(top, isAsin(decision.term)) }
    })
    // A new campaign: the SKUs its own campaigns advertise, the first budget, the names taken.
    const skus = [...new Set(productAds.filter((a) => own.has(a.adGroupId)).map((a) => a.sku ?? productById.get(a.productId!)?.sku ?? null).filter((s): s is string => !!s))].sort().slice(0, 250)
    const pct = Number(d.settings.values.firstBudgetPctOfEnvelope.value ?? 10)
    const env = budgets.find((b) => b.productId === root)
    const days = (() => { const [y, m] = (env?.month ?? '').split('-').map(Number); return y && m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 30 })()
    const share = env?.envelopeCents ? Math.floor((env.envelopeCents / days) * (pct / 100)) : null
    const dailyBudgetCents = Math.max(AMAZON_MIN_BUDGET_CENTS, share ?? AMAZON_MIN_BUDGET_CENTS)
    const budgetWhy = share != null
      ? `${pct} % of the day's share of the product's monthly envelope (the money shadow's plan, AB-7)${share < AMAZON_MIN_BUDGET_CENTS ? ', raised to Amazon\'s lowest daily budget' : ''}`
      : 'Amazon\'s lowest daily budget: the money shadow (AB-7) planned no envelope for this product'
    const rootRow = rootNames.find((r) => r.id === root)
    const takenNames = new Set(names.filter((c) => strategyMarket(c.marketplace) === market).map((c) => c.name.toLowerCase()))
    const facts: HarvestProductFacts = {
      productId: root, market, ctx,
      groups: own, campaigns, slots,
      strategyLimits: new Map([...own.keys()].map((id) => {
        const l = (strategyLimits as Map<string, { limits: { minBidCents: { value: number } | null; maxBidCents: { value: number } | null } }>).get(id)?.limits
        return [id, { minBidCents: l?.minBidCents?.value ?? null, maxBidCents: l?.maxBidCents?.value ?? null }]
      })),
      marketLimits: { minBidCents: marketLimits.minBidCents?.value ?? null, maxBidCents: marketLimits.maxBidCents?.value ?? null },
      structure: d.settings.levers.structure.effective as LeverEffective, structureWhy: d.settings.levers.structure.why,
      records: recordMap, used,
      caps: {
        harvestPerDay: Number(d.settings.values.harvestPerDay.value ?? 10),
        newCampaignsPerWeek: Number(d.settings.values.newCampaignsPerWeek.value ?? 2),
        skcMax: Number(d.settings.values.skcMax.value ?? 20),
        marketCampaignsPerWeek: MARKET_NEW_CAMPAIGNS_PER_WEEK,
      },
      ceiling: harvestCeiling(),
      newCampaign: skus.length ? { skus, dailyBudgetCents, budgetWhy, productLabel: rootRow?.name ?? rootRow?.sku ?? root, takenNames } : null,
      newCampaignRefusal: skus.length ? null : 'its own campaigns advertise no SKU Nexus knows',
    }
    out.products.set(root, { facts, candidates, decisions })
  }
  return out
}

/** Ended harvests still inside the cooldown (the decision skips them): for the read view. */
export const inCooldown = (r: { status: string; changedAt: Date }, now: Date) =>
  (ENDED_STATUSES as readonly string[]).includes(r.status) && now.getTime() - r.changedAt.getTime() < GRADUATION_COOLDOWN_DAYS * 86_400_000
