/**
 * ADS PLAYBOOK PB-6c — a hero (a term's own campaign, hero.ts) planned for the playbook's build: nothing is written.
 * The plan is a BuildPlan of ONE campaign, so PB-5a's build runs it exactly as it runs a slot (build.ts
 * `startPlaybookBuild` → the SP Super Wizard's launch, Owner rule 1): born ENABLED at the 2¢ floor with its planned bid
 * remembered, off the live-write allowlist, its placements kept for START, linked as the slot `hero:<term>`.
 *
 *   where it runs now  the term's entries in the winners view (winners.ts): its cost per click and daily spend there
 *                      give the hero's planned bid and budget; they are shown to the person who approves
 *   the gate           the blueprint engine's (`evaluatePlan`), as a build is judged: the name in the market, a market
 *                      that cannot receive writes; and every monthly cap of the strategy in force at the product WITH
 *                      the spend already in it: this month's spend of the cap's scope and its pace for the days left
 *                      (the market's: monthProjections; a category's or a product's: scopeCapsThisMonth), plus the
 *                      hero's daily budget at full spend for those days. The term is the point of a hero, so
 *                      this product's own other campaigns buying it are accepted on the record (`acceptedShared`);
 *                      another product's are only listed (rule 3: never a reason to refuse)
 *   the portfolio      the playbook's own (its portfolio link); none when it has none
 *
 * The term keeps running where it runs now (rule 2): this plan negates nothing and moves no bid anywhere else.
 */
import { budgetDayStart } from '@nexus/shared/ads-budget-day'
import { evaluatePlan } from '../../ads-core/ads-blueprint-apply.js'
import { loadExistingCampaignNames, loadExistingTargets, marketContext, priorRunFor } from '../ads-blueprint-apply.service.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { blueprintOf } from './compile.js'
import { isEnrolled } from './resolve.js'
import { loadProductPlaybook, productAdsOf, type BuildPlan, type NamedTerm } from './build-preview.js'
import { heroPlan, isHeroKey, type HeroPlan } from './hero.js'
import { playbookLinks } from './load.js'
import { winnerReview, type WinnerEntry } from './winners.js'
import type { ProductTerms } from './doc.js'

const norm = (s: string) => s.trim().toLowerCase()

/** One monthly cap the hero is held against, with the spend already in its scope. */
export interface HeroCap {
  monthlySpendCapCents: number
  source: { level: string; label: string }
  /** This month so far, and the month's forecast with the hero at full spend for the days left. */
  spendCents: number
  forecastSpendCents: number
  daysLeft: number
  over: boolean
}

/** A hero's build plan: the build's own shape, and what the hero is. */
export interface HeroBuildPlan extends BuildPlan {
  hero: {
    plan: HeroPlan
    /** Where the term runs now (the winners view's entries for it), the best first. */
    current: WinnerEntry[]
    caps: HeroCap[]
  }
}

/**
 * Every monthly cap in force at the product, with the spend already in it and the hero's daily budget at full spend for
 * the days left: the market's through the month projection (its spend so far, its pace with the margin, the budget
 * plan's cap where lower), a category's or a product's from this month's spend of its scope at its pace so far.
 */
async function capsWithSpend(view: Awaited<ReturnType<typeof openStrategy>>, market: string, caps: ReadonlyArray<{ monthlySpendCapCents: number; source: { level: string; label: string; strategyId: string } }>, heroDailyCents: number, now = new Date()): Promise<HeroCap[]> {
  const inForce = caps.filter((c) => c.monthlySpendCapCents > 0)
  if (!inForce.length) return []
  const day = budgetDayStart(now)
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))
  const daysInMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate()
  const daysLeft = daysInMonth - day.getUTCDate() + 1
  const elapsed = day.getUTCDate() - 1
  const { monthProjections } = await import('../ads-strategy/autonomy.js')
  const { scopeCapsThisMonth } = await import('../ads-strategy/spend.js')
  const [projection, scoped] = await Promise.all([
    inForce.some((c) => c.source.level === 'market') ? monthProjections([{ market, view, addedDailyCents: heroDailyCents }], now).then((m) => m.get(market) ?? null) : Promise.resolve(null),
    inForce.some((c) => c.source.level !== 'market') ? scopeCapsThisMonth(view, start, day) : Promise.resolve(null),
  ])
  return inForce.map((c) => {
    if (c.source.level === 'market') {
      const spendCents = projection?.spentCents ?? 0
      const forecastSpendCents = projection ? projection.afterCents : heroDailyCents * daysLeft
      return { monthlySpendCapCents: c.monthlySpendCapCents, source: { level: c.source.level, label: c.source.label }, spendCents, forecastSpendCents, daysLeft, over: forecastSpendCents > c.monthlySpendCapCents }
    }
    const spendCents = scoped?.caps.find((x) => x.strategyId === c.source.strategyId)?.spendCents ?? 0
    const pace = elapsed > 0 ? Math.round((spendCents / elapsed) * daysLeft) : 0
    const forecastSpendCents = spendCents + pace + heroDailyCents * daysLeft
    return { monthlySpendCapCents: c.monthlySpendCapCents, source: { level: c.source.level, label: c.source.label }, spendCents, forecastSpendCents, daysLeft, over: forecastSpendCents > c.monthlySpendCapCents }
  })
}

/** One product's hero for one term in one market, planned and judged; nothing is written. */
export async function planHero(args: { market: string; productId?: string; sku?: string; term: string; channel?: string; frozen?: { bidCents: number; dailyBudgetCents: number } | null }): Promise<{ data: HeroBuildPlan } | { status: 400 | 404; error: string }> {
  const loaded = await loadProductPlaybook(args)
  if ('error' in loaded) return loaded
  const { channel, market, product, resolved, row, links, linkedNames } = loaded
  const term = args.term.trim()
  const doc = resolved.doc
  const value = <T>(field: keyof NonNullable<typeof resolved.product>) => (resolved.product?.[field].value ?? null) as T | null
  const nameToken = value<string>('nameToken')
  const terms: ProductTerms = value<ProductTerms>('terms') ?? { brand: [], category: [], competitor: [], competitorAsins: [], negatives: [] }

  // Where the term runs now, and the strategy's band at this product.
  const review = row ? await winnerReview({ market, productId: product.id, terms: [term] }) : null
  const current = review && 'data' in review
    ? [...review.data.entries].sort((a, b) => (b.current?.orders ?? 0) - (a.current?.orders ?? 0) || (b.current?.clicks ?? 0) - (a.current?.clicks ?? 0))
    : []
  const best = current.find((e) => e.current && e.current.clicks > 0)?.current ?? null
  const bestDays = current.find((e) => e.current && e.current.clicks > 0)?.bar.windowDays ?? null
  const view = await openStrategy(market, channel)
  const strategy = (await view.forProducts([product.id])).values
  const fulfilment = doc?.structure.productAds.fulfilment ?? 'FBA'
  const { ads, unlisted } = await productAdsOf(product.id, market, fulfilment)
  const heroKeys = new Set(links.filter((l) => isHeroKey(l.key)).map((l) => l.key))

  const plan = heroPlan({
    market, doc, nameToken: nameToken ?? '', term, terms, asins: ads.map((a) => a.asin),
    band: { minBidCents: strategy.minBidCents, maxBidCents: strategy.maxBidCents },
    baseBidCents: value<number>('baseBidCents'), dailyBudgetCents: value<number>('dailyBudgetCents'),
    cpcCents: best && best.clicks > 0 ? Math.round(best.spendCents / best.clicks) : null,
    dailySpendCents: best && bestDays ? best.spendCents / bestDays : null,
    heroKeys,
    frozen: args.frozen ?? null,
  })
  const problems = doc ? plan.problems : resolved.problems.length ? resolved.problems : ['the playbook does not compile']
  const base: HeroBuildPlan = {
    channel, market, product: { productId: product.id, sku: product.sku }, enrolled: isEnrolled(resolved), compiles: false,
    problems, warnings: [...resolved.warnings, ...plan.warnings], nameToken, doc, slots: [],
    linked: links.map((l) => ({ key: l.key, campaignId: l.refId })),
    playbook: row ? { id: row.id, version: row.version, state: row.state, compiledVersion: row.compiledVersion, label: row.label } : null,
    template: resolved.template.value ? { id: resolved.template.value.id, version: resolved.template.value.version } : null,
    campaigns: [], applyPlan: null, allowed: false, blockers: [],
    totals: { campaigns: 0, adGroups: 0, positives: 0, negatives: 0, productAds: 0, dailyBudgetCents: 0 }, dailyBudgetCents: 0,
    highestPlannedBidCents: 0, skippedShared: [], acceptedShared: [], sharedWithOtherProducts: [], productAds: ads,
    portfolio: { does: 'none' }, strategy: { minBidCents: strategy.minBidCents, maxBidCents: strategy.maxBidCents, caps: [], daysInMonth: 0 },
    reach: { writable: false, everWritten: false },
    hero: { plan, current, caps: [] },
  }
  if (!row || problems.length || !plan.campaign || !plan.slot || !doc) return { data: base }

  // The gate, against what this business runs in the market (the product's own linked campaigns left out, as a build).
  const linkedCampaigns = new Set(links.map((l) => l.refId))
  const [existingAll, namesAll, market_, priorRun] = await Promise.all([
    loadExistingTargets(market), loadExistingCampaignNames(market), marketContext(market), priorRunFor(nameToken!, market, { excludePlaybookId: row.id }),
  ])
  const existing = existingAll.filter((e) => !linkedCampaigns.has(e.campaignId))
  const linkedNameKeys = new Set([...linkedCampaigns].map((id) => norm(linkedNames.get(id)?.name ?? '')).filter(Boolean))
  const campaigns = [plan.campaign]
  const applyPlan = evaluatePlan(JSON.parse(JSON.stringify(campaigns)), { keywords: 0, negatives: 0, productTargets: 0, autoClauses: 0 }, blueprintOf(campaigns, nameToken!, doc),
    { productToken: nameToken!, asins: ads.map((a) => a.asin) }, existing,
    { market: market_, existingCampaignNames: namesAll.filter((n) => !linkedNameKeys.has(norm(n))), priorRun, acceptSharedTargets: [term] })
  const named = (list: ReadonlyArray<{ expression: string; existing: NamedTerm['existing'] }>): NamedTerm[] => list.map((c) => ({ term: c.expression, existing: c.existing.slice(0, 5) }))

  // Money: every monthly cap in force here, with the spend already in its scope and the hero at full spend.
  const now = new Date()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const dailyBudgetCents = plan.dailyBudgetCents
  const heroCaps = await capsWithSpend(view, market, strategy.monthlyCaps, dailyBudgetCents, now)
  const caps = heroCaps.map((c) => ({ monthlySpendCapCents: c.monthlySpendCapCents, source: c.source, over: c.over }))
  const blockers = [
    ...applyPlan.blockers,
    ...heroCaps.filter((c) => c.over).map((c) => `With what ${c.source.label} has spent this month and its pace, this daily budget at full spend for the ${c.daysLeft} days left goes past its monthly cap: lower it, or raise the cap.`),
  ]
  const bids = applyPlan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => [g.defaultBidCents ?? 0, ...g.targets.filter((t) => !t.isNegative).map((t) => t.bidCents ?? 0)]))

  // The portfolio: the playbook's own, else none.
  const portfolioLink = (await playbookLinks([row.id])).find((l) => l.kind === 'portfolio')
  const warnings = [
    ...base.warnings, ...applyPlan.warnings,
    ...(unlisted ? [`${unlisted} product(s) of the family have an ASIN but no Amazon listing in ${market} in Nexus: not advertised`] : []),
    ...(portfolioLink ? [] : ['The playbook names no portfolio: the hero is made outside any portfolio']),
    ...(current.length ? [] : [`"${term}" has no results in ${product.sku}'s playbook campaigns in ${market} yet: its bid comes from the playbook's ladder and its budget is the least per slot`]),
  ]
  return {
    data: {
      ...base,
      compiles: true,
      warnings: [...new Set(warnings)],
      slots: [plan.slot],
      campaigns: applyPlan.campaigns,
      applyPlan,
      allowed: blockers.length === 0,
      blockers,
      totals: { campaigns: applyPlan.totals.campaigns, adGroups: applyPlan.totals.adGroups, positives: applyPlan.totals.positives, negatives: applyPlan.totals.negatives, productAds: applyPlan.totals.productAds, dailyBudgetCents },
      dailyBudgetCents,
      highestPlannedBidCents: bids.length ? Math.max(...bids) : 0,
      acceptedShared: named(applyPlan.conflicts),
      sharedWithOtherProducts: named(applyPlan.sharedWithOtherProducts),
      portfolio: portfolioLink ? { does: 'reuse', portfolioId: portfolioLink.refId } : { does: 'none' },
      strategy: { minBidCents: strategy.minBidCents, maxBidCents: strategy.maxBidCents, caps, daysInMonth },
      hero: { plan, current, caps: heroCaps },
      reach: { writable: market_.writable, everWritten: market_.everWritten },
    },
  }
}
