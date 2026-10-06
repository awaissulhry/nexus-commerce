/**
 * ADS PLAYBOOK PB-4 — a DRY RUN of building one product's playbook in one market: the campaigns compile.ts makes from
 * it, judged by the blueprint engine's own gate (`evaluatePlan`) against what this business already runs there. Nothing
 * is created, saved or sent to Amazon; a build is a later step, and it will only run what a person approved.
 *
 *   what is built   every slot the product does not hold yet (a slot linked to a live campaign stays as it is), at
 *                   the slots' budgets and start bids (the ladder clamped to the strategy's bid band at this product)
 *   what it ads     the product's children listed on Amazon in this market with an ASIN (a parent's own ASIN is not
 *                   advertised), and which seller SKU the template's fulfilment choice points at
 *   shared terms    Owner rule 3 (isolation is per product): a category or competitor keyword one of THIS product's
 *                   own campaigns outside the playbook already buys in the market is skipped (template `skip`: it
 *                   stays where it is) or built too, on the record (`accept`, the default) — each named. A keyword
 *                   another product's campaigns buy is kept and only listed (`sharedWithOtherProducts`): different
 *                   products may share a keyword, never blocked, never skipped
 *   money           at full spend, the slots' daily budgets over the month against every monthly cap of the strategy
 *                   in force here (each cap binds)
 *   the gate        names already used in the market, a market that cannot receive writes, empty campaigns, Amazon's
 *                   limits on negatives — as a replication is held to them
 *   portfolio       the product's portfolio name (else the template's pattern): one that exists is reused, else created
 */
import { PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'
import { evaluatePlan, type PlannedCampaign } from '../../ads-core/ads-blueprint-apply.js'
import { loadExistingCampaignNames, loadExistingTargets, marketContext, priorRunFor } from '../ads-blueprint-apply.service.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { findLiveProduct, loadCatalog, productFamily } from '../ads-strategy/load.js'
import prisma from '../../../db.js'
import { blueprintOf, compilePlaybook } from './compile.js'
import { campaignNames, loadPlaybookIndex, playbookLinks } from './load.js'
import { isEnrolled, resolveProduct } from './resolve.js'
import type { ProductTerms } from './doc.js'

export const BUILD_PREVIEW_NOTE =
  'A dry run: nothing is created, saved or sent to Amazon. Building is a later step; it will create these campaigns at '
  + "Amazon's 2¢ floor (each planned bid kept to restore when spending starts), and only after a person approves it."

const norm = (s: string) => s.trim().toLowerCase()

/** The product's children (or the product itself) listed on Amazon in this market with an ASIN, and their seller SKUs. */
async function productAdsOf(productId: string, market: string, fulfilment: 'FBA' | 'FBM' | 'both') {
  const family = await productFamily(productId)
  const products = await prisma.product.findMany({
    where: { id: { in: family }, deletedAt: null, amazonAsin: { not: null } },
    select: { id: true, sku: true, amazonAsin: true, isParent: true, fulfillmentMethod: true, parentId: true },
    orderBy: { sku: 'asc' },
  })
  const listed = new Set((await prisma.channelListing.findMany({
    where: { productId: { in: products.map((p) => p.id) }, channel: 'AMAZON', marketplace: market, listingStatus: { not: 'ENDED' } },
    select: { productId: true },
  })).map((l) => l.productId))
  const hasChildren = products.some((p) => p.parentId)
  const ads = products.filter((p) => listed.has(p.id) && !(hasChildren && p.isParent))
  const byAsin = new Map<string, Array<{ sku: string; fulfillment: string | null }>>()
  for (const p of ads) byAsin.set(p.amazonAsin!, [...(byAsin.get(p.amazonAsin!) ?? []), { sku: p.sku, fulfillment: p.fulfillmentMethod ? String(p.fulfillmentMethod) : null }])
  const out = [...byAsin.entries()].map(([asin, offers]) => {
    const pick = fulfilment === 'both' ? offers : offers.filter((o) => o.fulfillment === fulfilment)
    return { asin, skus: (pick.length ? pick : offers).map((o) => o.sku), ...(pick.length ? {} : { note: `no ${fulfilment} offer: the ${offers[0].fulfillment ?? 'only'} one` }) }
  })
  return { ads: out, unlisted: products.filter((p) => !listed.has(p.id) && !(hasChildren && p.isParent)).length }
}

export async function previewBuild(args: { market: string; productId?: string; sku?: string; channel?: string }): Promise<{ data: Record<string, unknown> } | { status: 400 | 404; error: string }> {
  const channel = (args.channel ?? 'AMAZON').toUpperCase()
  const market = args.market.trim().toUpperCase()
  const product = await findLiveProduct({ productId: args.productId, sku: args.sku })
  if (!product) return { status: 404, error: PRODUCT_NOT_FOUND }
  const [{ index }, { catalog }] = await Promise.all([loadPlaybookIndex(market, channel), loadCatalog([product.id])])
  const resolved = resolveProduct(index, catalog.products.get(product.id) ?? product, catalog)
  const head = {
    channel, view: 'compile', market, product: { productId: product.id, sku: product.sku },
    enrolled: isEnrolled(resolved), note: BUILD_PREVIEW_NOTE,
  }
  if (!resolved.doc) return { data: { ...head, compiles: false, problems: resolved.problems, warnings: resolved.warnings } }
  const doc = resolved.doc
  const value = <T>(field: keyof NonNullable<typeof resolved.product>) => (resolved.product?.[field].value ?? null) as T | null

  // The slots this product already holds (linked campaigns) stay as they are: no clash, no name clash.
  const ownRows = [index.products.get(product.id), product.parentId ? index.products.get(product.parentId) : undefined].filter((r): r is NonNullable<typeof r> => !!r)
  const links = (await playbookLinks(ownRows.map((r) => r.id))).filter((l) => l.kind === 'slot')
  const linkedCampaigns = new Set(links.map((l) => l.refId))
  const linkOf = new Map(links.map((l) => [l.key, l.refId]))
  const linkedNames = await campaignNames([...linkedCampaigns])

  const strategy = (await openStrategy(market, channel).then((view) => view.forProducts([product.id]))).values
  const { ads, unlisted } = await productAdsOf(product.id, market, doc.structure.productAds.fulfilment)
  const nameToken = value<string>('nameToken')
  const compiled = compilePlaybook({
    market, doc,
    product: { nameToken, dailyBudgetCents: value<number>('dailyBudgetCents'), baseBidCents: value<number>('baseBidCents'), terms: value<ProductTerms>('terms') },
    asins: ads.map((a) => a.asin),
    band: { minBidCents: strategy.minBidCents, maxBidCents: strategy.maxBidCents },
    linkedSlots: new Set(links.map((l) => l.key)),
  })
  if (compiled.problems.length) return { data: { ...head, compiles: false, problems: compiled.problems, warnings: [...resolved.warnings, ...compiled.warnings] } }

  // The gate, against what this business already runs in the market (the product's own linked campaigns left out).
  const [existingAll, namesAll, market_, priorRun] = await Promise.all([
    loadExistingTargets(market), loadExistingCampaignNames(market), marketContext(market), priorRunFor(nameToken!, market),
  ])
  const existing = existingAll.filter((e) => !linkedCampaigns.has(e.campaignId))
  const linkedNameKeys = new Set([...linkedNames.values()].map((c) => norm(c.name)))
  const existingCampaignNames = namesAll.filter((n) => !linkedNameKeys.has(norm(n)))
  const target = { productToken: nameToken!, asins: ads.map((a) => a.asin) }
  const excluded = { keywords: 0, negatives: 0, productTargets: 0, autoClauses: 0 }
  const opts = { market: market_, existingCampaignNames, priorRun }
  const clone = (cs: readonly PlannedCampaign[]): PlannedCampaign[] => JSON.parse(JSON.stringify(cs))
  let campaigns = clone(compiled.campaigns)
  let plan = evaluatePlan(campaigns, excluded, blueprintOf(campaigns, nameToken!, doc), target, existing, opts)
  // The gate's conflicts are this product's own campaigns only (rule 3); other products' are in sharedWithOtherProducts.
  const shared = plan.conflicts.map((c) => c.expression)
  let skippedShared: Array<{ term: string; existing: Array<{ campaignName: string; campaignId: string }> }> = []
  if (shared.length) {
    const sharedKeys = new Set(shared.map(norm))
    skippedShared = plan.conflicts.map((c) => ({ term: c.expression, existing: c.existing.slice(0, 5) }))
    if (doc.structure.sharedTerms === 'skip') {
      // Rule 2 — a term the product already buys stays where it is: not built a second time.
      campaigns = clone(compiled.campaigns).map((c) => ({ ...c, adGroups: c.adGroups.map((g) => ({ ...g, targets: g.targets.filter((t) => t.isNegative || !t.gated || !sharedKeys.has(norm(t.expression))) })) }))
      plan = evaluatePlan(campaigns, excluded, blueprintOf(campaigns, nameToken!, doc), target, existing, opts)
    } else {
      plan = evaluatePlan(clone(compiled.campaigns), excluded, blueprintOf(compiled.campaigns, nameToken!, doc), target, existing, { ...opts, acceptSharedTargets: shared })
    }
  }

  // Money: at full spend, over this month, against every monthly cap in force here (each binds; 0 = no cap).
  const now = new Date()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const dailyBudgetCents = plan.campaigns.reduce((n, c) => n + Math.round(Number(c.dailyBudget ?? 0) * 100), 0)
  const caps = strategy.monthlyCaps.filter((c) => c.monthlySpendCapCents > 0).map((c) => ({
    monthlySpendCapCents: c.monthlySpendCapCents, source: { level: c.source.level, label: c.source.label },
    over: dailyBudgetCents * daysInMonth > c.monthlySpendCapCents,
  }))
  const blockers = [
    ...plan.blockers,
    ...caps.filter((c) => c.over).map((c) => `At full spend these daily budgets over ${daysInMonth} days add up to more than the monthly cap of ${c.source.label}: lower the product's daily budget, or raise the cap.`),
  ]

  // Portfolio: the product's own name, else the template's pattern; reused when it exists.
  const mode = doc.structure.portfolio.mode
  const portfolioName = mode === 'none' ? null
    : (value<string>('portfolioName') ?? doc.structure.portfolio.pattern.split('{product}').join(nameToken!).split('{market}').join(market).trim())
  const existingPortfolio = portfolioName
    ? await prisma.amazonAdsPortfolio.findFirst({ where: { name: { equals: portfolioName, mode: 'insensitive' } }, select: { externalPortfolioId: true, name: true } })
    : null

  return {
    data: {
      ...head,
      compiles: true,
      allowed: blockers.length === 0,
      blockers,
      warnings: [...resolved.warnings, ...compiled.warnings, ...plan.warnings, ...(unlisted ? [`${unlisted} product(s) of the family have an ASIN but no Amazon listing in ${market} in Nexus: not advertised`] : [])],
      slots: compiled.slots.map((s) => (s.linked ? { ...s, campaign: linkedNames.get(linkOf.get(s.key) ?? '') ?? null } : s)),
      campaigns: plan.campaigns,
      totals: {
        campaigns: plan.totals.campaigns, adGroups: plan.totals.adGroups, positives: plan.totals.positives, negatives: plan.totals.negatives,
        productAds: plan.totals.productAds, dailyBudgetCents,
      },
      skippedShared: doc.structure.sharedTerms === 'skip' ? skippedShared : [],
      acceptedShared: doc.structure.sharedTerms === 'accept' ? skippedShared : [],
      sharedWithOtherProducts: plan.sharedWithOtherProducts.map((c) => ({ term: c.expression, existing: c.existing.slice(0, 5) })),
      productAds: ads,
      portfolio: portfolioName ? { name: portfolioName, does: existingPortfolio ? 'reuse' : 'create', ...(existingPortfolio ? { portfolioId: existingPortfolio.externalPortfolioId } : {}) } : { does: 'none' },
      strategy: { minBidCents: strategy.minBidCents, maxBidCents: strategy.maxBidCents, caps, daysInMonth },
      reach: { writable: market_.writable, everWritten: market_.everWritten },
    },
  }
}
