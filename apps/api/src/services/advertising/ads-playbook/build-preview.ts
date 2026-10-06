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
 *                   stays where it is, the default) or built too, on the record (`accept`) — each named. A keyword
 *                   another product's campaigns buy is kept and only listed (`sharedWithOtherProducts`): different
 *                   products may share a keyword, never blocked, never skipped
 *   money           at full spend, the slots' daily budgets over the month against every monthly cap of the strategy
 *                   in force here (each cap binds)
 *   the gate        names already used in the market, a market that cannot receive writes, empty campaigns, Amazon's
 *                   limits on negatives — as a replication is held to them
 *   portfolio       the product's portfolio name (else the template's pattern): one that exists at Amazon in this
 *                   market's ads profile is reused, else created (a Nexus-only `local-pf-` one is never reused)
 *
 * PB-5a — `planBuild` is the plan itself, shared by this dry run and the build (build.ts: apply-ads-playbook op build
 * re-plans it on approval and runs exactly it). A slot linked to an ARCHIVED campaign counts as missing again (an undo
 * archives what a build made, and the slot can then be built again); a run of this same playbook is not "a second set".
 */
import { PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'
import { evaluatePlan, type ApplyPlan, type PlannedCampaign } from '../../ads-core/ads-blueprint-apply.js'
import { loadExistingCampaignNames, loadExistingTargets, marketContext, priorRunFor } from '../ads-blueprint-apply.service.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { findLiveProduct, loadCatalog, productFamily } from '../ads-strategy/load.js'
import prisma from '../../../db.js'
import { blueprintOf, compilePlaybook, type CompiledSlot } from './compile.js'
import { campaignNames, loadPlaybookIndex, playbookLinks } from './load.js'
import { isEnrolled, resolveProduct, type PlaybookIndex, type PlaybookRow, type ResolvedPlaybook } from './resolve.js'
import type { ProductTerms, TemplateDoc } from './doc.js'

export const BUILD_PREVIEW_NOTE =
  'A dry run: nothing is created, saved or sent to Amazon. Building is a later step; it will create these campaigns at '
  + "Amazon's 2¢ floor (each planned bid kept to restore when spending starts), and only after a person approves it."

const norm = (s: string) => s.trim().toLowerCase()

/** The product's children (or the product itself) listed on Amazon in this market with an ASIN, and their seller SKUs. */
export async function productAdsOf(productId: string, market: string, fulfilment: 'FBA' | 'FBM' | 'both') {
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
  const byAsin = new Map<string, Array<{ sku: string; productId: string; fulfillment: string | null }>>()
  for (const p of ads) byAsin.set(p.amazonAsin!, [...(byAsin.get(p.amazonAsin!) ?? []), { sku: p.sku, productId: p.id, fulfillment: p.fulfillmentMethod ? String(p.fulfillmentMethod) : null }])
  const out = [...byAsin.entries()].map(([asin, offers]) => {
    const pick = fulfilment === 'both' ? offers : offers.filter((o) => o.fulfillment === fulfilment)
    const chosen = pick.length ? pick : offers
    // productIds: the product behind each SKU, in the same order — the product ad names it (stock-aware bids and a
    // product's or category's monthly cap tie an ad to its product by it).
    return { asin, skus: chosen.map((o) => o.sku), productIds: chosen.map((o) => o.productId), ...(pick.length ? {} : { note: `no ${fulfilment} offer: the ${offers[0].fulfillment ?? 'only'} one` }) }
  })
  return { ads: out, unlisted: products.filter((p) => !listed.has(p.id) && !(hasChildren && p.isParent)).length }
}

// ── The product's playbook, as a build or an adopt reads it ───────────────────────────────────────

export interface ProductPlaybook {
  channel: string
  market: string
  product: { id: string; sku: string; parentId: string | null }
  resolved: ResolvedPlaybook
  /** The PRODUCT row that holds the playbook (the product's own, else its parent's); null when none does. */
  row: PlaybookRow | null
  /** The product's own row and its parent's: what their links hold. */
  ownRows: PlaybookRow[]
  /** Slot links of those rows whose campaign is not archived (a slot whose campaign was archived is missing again). */
  links: Array<{ playbookId: string; key: string; refId: string; adGroupId: string | null; origin: string }>
  linkedNames: Map<string, { name: string; status: string; marketplace: string | null }>
}

/** The product's resolved playbook in one market, with the row that holds it and the live slot links. */
export async function loadProductPlaybook(args: { market: string; productId?: string; sku?: string; channel?: string }, pre: { index?: PlaybookIndex } = {}): Promise<ProductPlaybook | { status: 404; error: string }> {
  const channel = (args.channel ?? 'AMAZON').toUpperCase()
  const market = args.market.trim().toUpperCase()
  const product = await findLiveProduct({ productId: args.productId, sku: args.sku })
  if (!product) return { status: 404, error: PRODUCT_NOT_FOUND }
  // PB-10 — the market's rows read once by a caller that reads many products (the drift list).
  const [{ index }, { catalog }] = await Promise.all([pre.index ? { index: pre.index } : loadPlaybookIndex(market, channel), loadCatalog([product.id])])
  const resolved = resolveProduct(index, catalog.products.get(product.id) ?? product, catalog)
  const ownRows = [index.products.get(product.id), product.parentId ? index.products.get(product.parentId) : undefined].filter((r): r is NonNullable<typeof r> => !!r)
  const holder = resolved.product?.enrolled.source?.id
  const row = ownRows.find((r) => r.id === holder) ?? ownRows[0] ?? null
  const slotLinks = (await playbookLinks(ownRows.map((r) => r.id))).filter((l) => l.kind === 'slot')
  const linkedNames = await campaignNames(slotLinks.map((l) => l.refId))
  const links = slotLinks.filter((l) => linkedNames.has(l.refId) && linkedNames.get(l.refId)!.status !== 'ARCHIVED')
    .map((l) => ({ playbookId: l.playbookId, key: l.key, refId: l.refId, adGroupId: l.adGroupId ?? null, origin: l.origin }))
  return { channel, market, product, resolved, row, ownRows, links, linkedNames }
}

/** A term the gate named, with at most five of the campaigns that buy it. */
export interface NamedTerm { term: string; existing: Array<{ campaignName: string; campaignId: string }> }

export interface BuildPlan {
  channel: string
  market: string
  product: { productId: string; sku: string }
  enrolled: boolean
  compiles: boolean
  /** Why it cannot compile; empty when it does. */
  problems: string[]
  warnings: string[]
  /** The PRODUCT row that holds the playbook, as read now: what a build records against. */
  playbook: { id: string; version: number; state: string | null; compiledVersion: number | null; label: string } | null
  template: { id: string; version: number } | null
  nameToken: string | null
  doc: TemplateDoc | null
  /** Every slot: built (the plan's campaign), linked (a live campaign holds it) or left out of this build. */
  slots: Array<CompiledSlot & { campaign?: { name: string; status: string; marketplace: string | null } | null; leftOut?: true }>
  /** The live slot links (slot → campaign). */
  linked: Array<{ key: string; campaignId: string }>
  /** What the build creates, after the gate (one campaign per slot it builds). */
  campaigns: PlannedCampaign[]
  /** The gate's verdict over exactly those campaigns. Null when it does not compile. */
  applyPlan: ApplyPlan | null
  allowed: boolean
  blockers: string[]
  totals: { campaigns: number; adGroups: number; positives: number; negatives: number; productAds: number; dailyBudgetCents: number }
  dailyBudgetCents: number
  /** The highest bid the plan holds (an ad group default, a keyword, a target or an Auto group): what START puts back. */
  highestPlannedBidCents: number
  skippedShared: NamedTerm[]
  acceptedShared: NamedTerm[]
  sharedWithOtherProducts: NamedTerm[]
  /** Per ASIN: its seller SKUs and, in the same order, the product behind each (the product ad names it). */
  productAds: Array<{ asin: string; skus: string[]; productIds?: string[]; note?: string }>
  portfolio: { name?: string; does: 'reuse' | 'create' | 'none'; portfolioId?: string }
  strategy: { minBidCents: number | null; maxBidCents: number | null; caps: Array<{ monthlySpendCapCents: number; source: { level: string; label: string }; over: boolean }>; daysInMonth: number }
  reach: { writable: boolean; everWritten: boolean }
}

/**
 * The build of one product's playbook in one market, planned: nothing is written. `only`: build just these slots (the
 * others are left out, whatever they hold); absent, every slot the product does not hold yet.
 */
export async function planBuild(args: { market: string; productId?: string; sku?: string; channel?: string; only?: readonly string[] }): Promise<{ data: BuildPlan } | { status: 400 | 404; error: string }> {
  const loaded = await loadProductPlaybook(args)
  if ('error' in loaded) return loaded
  const { channel, market, product, resolved, row, links, linkedNames } = loaded
  const base: BuildPlan = {
    channel, market, product: { productId: product.id, sku: product.sku }, enrolled: isEnrolled(resolved), compiles: false,
    problems: [], warnings: [], nameToken: null, doc: null, slots: [], linked: links.map((l) => ({ key: l.key, campaignId: l.refId })),
    playbook: row ? { id: row.id, version: row.version, state: row.state, compiledVersion: row.compiledVersion, label: row.label } : null,
    template: resolved.template.value ? { id: resolved.template.value.id, version: resolved.template.value.version } : null,
    campaigns: [], applyPlan: null, allowed: false, blockers: [],
    totals: { campaigns: 0, adGroups: 0, positives: 0, negatives: 0, productAds: 0, dailyBudgetCents: 0 }, dailyBudgetCents: 0,
    highestPlannedBidCents: 0, skippedShared: [], acceptedShared: [], sharedWithOtherProducts: [], productAds: [],
    portfolio: { does: 'none' }, strategy: { minBidCents: null, maxBidCents: null, caps: [], daysInMonth: 0 }, reach: { writable: false, everWritten: false },
  }
  if (!resolved.doc) return { data: { ...base, problems: resolved.problems, warnings: resolved.warnings } }
  const doc = resolved.doc
  const value = <T>(field: keyof NonNullable<typeof resolved.product>) => (resolved.product?.[field].value ?? null) as T | null

  // The slots this product already holds (linked campaigns) stay as they are: no clash, no name clash.
  const linkedCampaigns = new Set(links.map((l) => l.refId))
  const linkOf = new Map(links.map((l) => [l.key, l.refId]))

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
  if (compiled.problems.length) return { data: { ...base, nameToken, doc, problems: compiled.problems, warnings: [...resolved.warnings, ...compiled.warnings] } }
  // `only` — the slots asked for; the rest are left out of this build (budgets and bids stay shares of the whole).
  const only = args.only?.length ? new Set(args.only) : null
  const unknownSlots = only ? [...only].filter((k) => !compiled.slots.some((s) => s.key === k)) : []
  if (unknownSlots.length) return { status: 400, error: `The playbook has no slot ${unknownSlots.map((k) => `"${k}"`).join(', ')} (its slots: ${compiled.slots.map((s) => s.key).join(', ')}).` }
  const builtCampaigns = only ? compiled.campaigns.filter((c) => only.has(c.role)) : compiled.campaigns

  // The gate, against what this business already runs in the market (the product's own linked campaigns left out).
  const [existingAll, namesAll, market_, priorRun] = await Promise.all([
    loadExistingTargets(market), loadExistingCampaignNames(market), marketContext(market), priorRunFor(nameToken!, market, { excludePlaybookId: row?.id }),
  ])
  const existing = existingAll.filter((e) => !linkedCampaigns.has(e.campaignId))
  const linkedNameKeys = new Set([...linkedCampaigns].map((id) => norm(linkedNames.get(id)?.name ?? '')).filter(Boolean))
  const existingCampaignNames = namesAll.filter((n) => !linkedNameKeys.has(norm(n)))
  const target = { productToken: nameToken!, asins: ads.map((a) => a.asin) }
  const excluded = { keywords: 0, negatives: 0, productTargets: 0, autoClauses: 0 }
  const opts = { market: market_, existingCampaignNames, priorRun }
  const clone = (cs: readonly PlannedCampaign[]): PlannedCampaign[] => JSON.parse(JSON.stringify(cs))
  let campaigns = clone(builtCampaigns)
  let plan = evaluatePlan(campaigns, excluded, blueprintOf(campaigns, nameToken!, doc), target, existing, opts)
  // The gate's conflicts are this product's own campaigns only (rule 3); other products' are in sharedWithOtherProducts.
  const shared = plan.conflicts.map((c) => c.expression)
  let skippedShared: NamedTerm[] = []
  if (shared.length) {
    const sharedKeys = new Set(shared.map(norm))
    skippedShared = plan.conflicts.map((c) => ({ term: c.expression, existing: c.existing.slice(0, 5) }))
    if (doc.structure.sharedTerms === 'skip') {
      // Rule 2 — a term the product already buys stays where it is: not built a second time.
      campaigns = clone(builtCampaigns).map((c) => ({ ...c, adGroups: c.adGroups.map((g) => ({ ...g, targets: g.targets.filter((t) => t.isNegative || !t.gated || !sharedKeys.has(norm(t.expression))) })) }))
      plan = evaluatePlan(campaigns, excluded, blueprintOf(campaigns, nameToken!, doc), target, existing, opts)
    } else {
      plan = evaluatePlan(clone(builtCampaigns), excluded, blueprintOf(builtCampaigns, nameToken!, doc), target, existing, { ...opts, acceptSharedTargets: shared })
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
  const bids = plan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => [g.defaultBidCents ?? 0, ...g.targets.filter((t) => !t.isNegative).map((t) => t.bidCents ?? 0)]))
  const highestPlannedBidCents = bids.length ? Math.max(...bids) : 0

  // Portfolio: the product's own name, else the template's pattern; reused when it exists at Amazon in this market's
  // ads profile (CC-5: a portfolio belongs to one profile; a Nexus-only local-pf- one is unknown to Amazon).
  const mode = doc.structure.portfolio.mode
  const portfolioName = mode === 'none' ? null
    : (value<string>('portfolioName') ?? doc.structure.portfolio.pattern.split('{product}').join(nameToken!).split('{market}').join(market).trim())
  const { adsClientContextFor } = await import('../ads-profile-resolver.js')
  const profile = portfolioName ? await adsClientContextFor(market) : null
  const existingPortfolio = portfolioName && profile
    ? await prisma.amazonAdsPortfolio.findFirst({
      where: { name: { equals: portfolioName, mode: 'insensitive' }, profileId: profile.profileId, NOT: { externalPortfolioId: { startsWith: 'local-pf-' } } },
      select: { externalPortfolioId: true, name: true },
    })
    : null
  const built = new Set(plan.campaigns.map((c) => c.role))

  return {
    data: {
      ...base,
      compiles: true,
      nameToken,
      doc,
      allowed: blockers.length === 0,
      blockers,
      warnings: [...resolved.warnings, ...compiled.warnings, ...plan.warnings, ...(unlisted ? [`${unlisted} product(s) of the family have an ASIN but no Amazon listing in ${market} in Nexus: not advertised`] : [])],
      slots: compiled.slots.map((s) => (s.linked ? { ...s, campaign: linkedNames.get(linkOf.get(s.key) ?? '') ?? null } : only && !built.has(s.key) ? { ...s, leftOut: true as const } : s)),
      campaigns: plan.campaigns,
      applyPlan: plan,
      totals: {
        campaigns: plan.totals.campaigns, adGroups: plan.totals.adGroups, positives: plan.totals.positives, negatives: plan.totals.negatives,
        productAds: plan.totals.productAds, dailyBudgetCents,
      },
      dailyBudgetCents,
      highestPlannedBidCents,
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

/** The dry run (ads-playbook view compile): the plan, as the read shows it. */
export async function previewBuild(args: { market: string; productId?: string; sku?: string; channel?: string }): Promise<{ data: Record<string, unknown> } | { status: 400 | 404; error: string }> {
  const out = await planBuild(args)
  if ('error' in out) return out
  const p = out.data
  const head = { channel: p.channel, view: 'compile', market: p.market, product: p.product, enrolled: p.enrolled, note: BUILD_PREVIEW_NOTE }
  if (!p.compiles) return { data: { ...head, compiles: false, problems: p.problems, warnings: p.warnings } }
  return {
    data: {
      ...head,
      compiles: true,
      allowed: p.allowed,
      blockers: p.blockers,
      warnings: p.warnings,
      slots: p.slots,
      campaigns: p.campaigns,
      totals: p.totals,
      skippedShared: p.skippedShared,
      acceptedShared: p.acceptedShared,
      sharedWithOtherProducts: p.sharedWithOtherProducts,
      productAds: p.productAds,
      portfolio: p.portfolio,
      strategy: p.strategy,
      reach: p.reach,
    },
  }
}
